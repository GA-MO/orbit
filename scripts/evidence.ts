import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..')
const OUT = path.join(REPO, 'evidence')
const HEALTH_POLLS = 100
const HEALTH_POLL_INTERVAL_MS = 200
const PORT_SEARCH_FIRST = 3160
const PORT_SEARCH_LAST = 3179

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const portIsFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })

async function pickPort(): Promise<number> {
  for (let candidate = PORT_SEARCH_FIRST; candidate <= PORT_SEARCH_LAST; candidate++) {
    if (await portIsFree(candidate)) return candidate
  }
  throw new Error(`no free port in ${PORT_SEARCH_FIRST}-${PORT_SEARCH_LAST}`)
}

const tokenIn = (home: string): string =>
  JSON.parse(fs.readFileSync(path.join(home, '.orbit', 'config.json'), 'utf8')).token

const runOrbit = (args: string[], home: string): string => {
  const ran = spawnSync(process.execPath, [path.join(REPO, 'server/dist/main.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ORBIT_HOME: home },
  })
  return `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim()
}

const describeMachine = (): string =>
  [
    `platform      ${process.platform} ${process.arch}`,
    `os            ${os.type()} ${os.release()}`,
    `bun           ${process.versions.bun ?? 'not bun'}`,
    `orbit         ${runOrbit(['version'], os.tmpdir())}`,
    `hostname      ${os.hostname()}`,
    `taken at      ${new Date().toISOString()}`,
  ].join('\n')

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-evidence-'))
const port = await pickPort()
const base = `http://127.0.0.1:${port}`
const log = fs.createWriteStream(path.join(OUT, 'server.log'), { flags: 'a' })

const server: ChildProcess = spawn(process.execPath, [path.join(REPO, 'server/dist/index.js')], {
  env: {
    ...process.env,
    HOME: home,
    ORBIT_HOME: home,
    ORBIT_PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout?.pipe(log)
server.stderr?.pipe(log)

const shot = async (body: unknown, saveAs: string): Promise<string> => {
  const res = await fetch(`${base}/api/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenIn(home)}` },
    body: JSON.stringify(body),
  })
  const shape: any = await res.json()
  if (res.status !== 201) throw new Error(shape.error ?? `HTTP ${res.status}`)
  fs.copyFileSync(shape.path, path.join(OUT, saveAs))
  return `${shape.width}x${shape.height}`
}

try {
  let up = false
  for (let poll = 0; poll < HEALTH_POLLS && !up; poll++) {
    up = await fetch(`${base}/healthz`).then((r) => r.ok, () => false)
    if (!up) await wait(HEALTH_POLL_INTERVAL_MS)
  }
  if (!up) throw new Error('the server never answered /healthz')

  const appShell = await fetch(base, { headers: { 'Tailscale-User-Login': 'evidence@example.com' } })
  const phone = await shot({ url: base, preset: 'phone' }, 'orbit-app-on-a-phone.png')
  const desktop = await shot({ url: base, preset: 'desktop' }, 'orbit-app-on-a-desktop.png')
  const screen = await shot({ source: 'screen' }, 'the-whole-screen.png')

  const report = [
    '# Orbit, running',
    '',
    '```',
    describeMachine(),
    '```',
    '',
    `The server answered \`/healthz\`, served its app shell with HTTP ${appShell.status} `,
    `(${appShell.headers.get('content-type')}), then took three pictures of itself:`,
    '',
    `- \`orbit-app-on-a-phone.png\` — ${phone}, headless Chrome`,
    `- \`orbit-app-on-a-desktop.png\` — ${desktop}, headless Chrome`,
    `- \`the-whole-screen.png\` — ${screen}, the machine's own screen`,
    '',
    '## What `orbit doctor` says here',
    '',
    '```',
    runOrbit(['doctor'], home),
    '```',
    '',
  ].join('\n')

  fs.writeFileSync(path.join(OUT, 'README.md'), report)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report)
  console.log(report)
} finally {
  server.kill()
  await wait(500)
  fs.rmSync(home, { recursive: true, force: true })
}
