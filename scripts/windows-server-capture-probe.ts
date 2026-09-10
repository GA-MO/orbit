import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..')
const HEALTH_POLLS = 100
const HEALTH_POLL_INTERVAL_MS = 200
const CAPTURE_TIMEOUT_MS = 40_000

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type StdioShape = 'inherit' | 'pipe' | 'ignore'

const tokenIn = (home: string): string => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.orbit', 'config.json'), 'utf8')).token ?? ''
  } catch {
    return ''
  }
}

async function probe(shape: StdioShape, port: number): Promise<string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `orbit-probe-${shape}-`))
  const server: ChildProcess = spawn(process.execPath, [path.join(REPO, 'server/dist/index.js')], {
    env: {
      ...(process.env as Record<string, string>),
      HOME: home,
      USERPROFILE: home,
      ORBIT_PORT: String(port),
      ORBIT_HOME: home,
    },
    stdio: shape === 'inherit' ? 'inherit' : ['ignore', shape, shape],
  })
  if (shape === 'pipe') {
    server.stdout?.resume()
    server.stderr?.resume()
  }

  try {
    let up = false
    for (let poll = 0; poll < HEALTH_POLLS && !up; poll++) {
      up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)
      if (!up) await wait(HEALTH_POLL_INTERVAL_MS)
    }
    if (!up) throw new Error('server never answered /healthz')

    const res = await fetch(`http://127.0.0.1:${port}/api/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenIn(home)}` },
      body: JSON.stringify({ url: `http://127.0.0.1:${port}/healthz` }),
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    })
    const body: any = await res.json()
    if (res.status !== 201) throw new Error(body.error ?? `HTTP ${res.status}`)
    return `${body.width}×${body.height}`
  } finally {
    server.kill()
    await wait(500)
    fs.rmSync(home, { recursive: true, force: true })
  }
}

async function launchInProcess(from: string, env: Record<string, string> = {}): Promise<string> {
  const restore: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    restore[key] = process.env[key]
    process.env[key] = value
  }
  try {
    const { launch } = await import(from)
    const browser = await launch()
    try {
      const page = await browser.newPage({ width: 400, height: 300, deviceScaleFactor: 1 })
      const shot = await page.screenshot({ fullPage: false })
      await page.close()
      return `captured ${shot.length} bytes`
    } finally {
      await browser.close()
    }
  } finally {
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const inProcess = async (what: string, from: string, env?: Record<string, string>) => {
  try {
    console.log(`  ok    ${what} — ${await launchInProcess(from, env)}`)
    return true
  } catch (err) {
    console.log(`  FAIL  ${what} — ${(err as Error).message}`)
    return false
  }
}

const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-probe-home-'))

await inProcess('launch() from the TypeScript source', '../server/src/chrome.js')
await inProcess('launch() from the compiled dist', '../server/dist/chrome.js')
await inProcess('launch() with HOME and USERPROFILE moved', '../server/src/chrome.js', {
  HOME: scratchHome,
  USERPROFILE: scratchHome,
})

const SHAPES: StdioShape[] = ['inherit', 'pipe', 'ignore']
let firstPort = 3110
let anyWorked = false

for (const shape of SHAPES) {
  try {
    const size = await probe(shape, firstPort++)
    console.log(`  ok    server spawned with stdio ${shape} — captured ${size}`)
    anyWorked = true
  } catch (err) {
    console.log(`  FAIL  server spawned with stdio ${shape} — ${(err as Error).message}`)
  }
}

console.log()
console.log(anyWorked ? '  the parent stdio shape is what decides it.' : '  the server cannot drive Chrome on Windows however it is spawned.')
console.log()
