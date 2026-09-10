import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..')

const LIVE_PORTS = [7788, 3001]
const PORT_SEARCH_FIRST = 3099
const PORT_SEARCH_LAST = 3148
const HEALTH_POLLS = 100
const HEALTH_POLL_INTERVAL_MS = 200
const SCRATCH_RM_TRIES = 5
const SCRATCH_RM_INTERVAL_MS = 300
const SCRATCH_PREFIX = 'orbit-smoke-'
const HEADING_WIDTH = 52

const SUITES: Record<string, string> = {
  smoke: 'smoke.mjs',
  touch: 'touch-smoke.mjs',
  changes: 'changes-smoke.mjs',
  'preview-url': 'preview-url-smoke.mjs',
  idle: 'idle-smoke.mjs',
  ask: 'ask-smoke.mjs',
  setup: 'setup-smoke.mjs',
  install: 'install-smoke.mjs',
}

const say = (line = '') => console.log(line ? `  ${line}` : '')
const complain = (line: string) => console.error(`  ${line}`)
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const die = (line: string): never => {
  complain(line)
  process.exit(1)
}

const isLivePort = (port: number) => LIVE_PORTS.includes(port)

const portIsFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })

async function pickPort(): Promise<number> {
  const asked = process.env.ORBIT_TEST_PORT
  if (asked) {
    const port = Number(asked)
    if (!(await portIsFree(port))) {
      die(`Port ${port} is already in use. Free it, or unset ORBIT_TEST_PORT to be given a spare.`)
    }
    return port
  }
  for (let candidate = PORT_SEARCH_FIRST; candidate <= PORT_SEARCH_LAST; candidate++) {
    if (await portIsFree(candidate)) return candidate
  }
  return die(`No free port in ${PORT_SEARCH_FIRST}-${PORT_SEARCH_LAST}. Is something looping? Try: make test-clean`)
}

const scratchParent = () => (process.platform === 'win32' ? os.tmpdir() : '/tmp')

const loginShellPath = (): string | null => {
  if (process.platform !== 'darwin') return null
  const shell = spawnSync('/bin/zsh', ['-lic', 'printf %s "$PATH"'], { encoding: 'utf8' })
  return shell.stdout?.trim() || null
}

const serverCommand = (): [file: string, args: string[]] => {
  const asked = process.env.ORBIT_BIN
  if (!asked) return [process.execPath, [path.join(REPO, 'server/dist/index.js')]]
  const bin = path.isAbsolute(asked) ? asked : path.join(REPO, asked)
  if (!fs.existsSync(bin)) die(`ORBIT_BIN is not an executable: ${bin}`)
  return [bin, []]
}

const healthy = async (port: number): Promise<boolean> => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok
  } catch {
    return false
  }
}

const printLog = (logFile: string, to: (line: string) => void) => {
  const text = fs.readFileSync(logFile, 'utf8')
  for (const line of text.split('\n')) to(`  ${line}`)
}

async function removeScratch(scratch: string): Promise<void> {
  for (let attempt = 0; attempt < SCRATCH_RM_TRIES; attempt++) {
    try {
      fs.rmSync(scratch, { recursive: true, force: true })
      return
    } catch {
      await wait(SCRATCH_RM_INTERVAL_MS)
    }
  }
}

const heading = (name: string) => {
  const rule = '─'.repeat(Math.max(0, HEADING_WIDTH - name.length))
  console.log('')
  console.log(`── ${name} ${rule}`)
}

const suite = process.argv[2] ?? 'all'
const wanted = suite === 'all' ? Object.keys(SUITES) : [suite]
for (const name of wanted) {
  if (!SUITES[name]) {
    die(`Unknown suite: ${name} (expected ${Object.keys(SUITES).join(', ')}, or all)`)
  }
}

const PORT = await pickPort()
const SCRATCH = process.env.ORBIT_TEST_HOME ?? path.join(scratchParent(), `${SCRATCH_PREFIX}${PORT}`)

if (isLivePort(PORT)) {
  die(`Refusing to test against :${PORT} — a real server answers there, and this kills sessions.`)
}

if (process.env.SKIP_BUILD !== '1') {
  say('Building …')
  const built = spawnSync(process.execPath, ['run', 'build'], { cwd: REPO, stdio: 'ignore' })
  if (built.status !== 0) die('Build failed.')
}

fs.rmSync(SCRATCH, { recursive: true, force: true })
fs.mkdirSync(SCRATCH, { recursive: true })
const LOG = path.join(SCRATCH, 'server.log')

const inheritedPath = loginShellPath()
const TAILSCALE = process.env.ORBIT_TAILSCALE ?? path.join(REPO, 'scripts/fake-tailscale.mjs')

const childEnv = (extra: Record<string, string>): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  ...(inheritedPath ? { PATH: inheritedPath } : {}),
  HOME: SCRATCH,
  ORBIT_HOME: SCRATCH,
  ORBIT_PORT: String(PORT),
  ORBIT_TAILSCALE: TAILSCALE,
  ...extra,
})

const [serverFile, serverArgs] = serverCommand()
const log = fs.createWriteStream(LOG, { flags: 'a' })
const server: ChildProcess = spawn(serverFile, serverArgs, {
  env: childEnv({}),
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout?.pipe(log)
server.stderr?.pipe(log)

let passed = false
let cleanedUp = false
const cleanup = () => {
  if (cleanedUp) return
  cleanedUp = true
  try {
    server.kill()
  } catch {}
  if (passed) void removeScratch(SCRATCH)
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(143)
})

say(`Starting Orbit on :${PORT} (HOME=${SCRATCH}) …`)

let serverExited = false
server.once('exit', () => (serverExited = true))

for (let poll = 0; poll < HEALTH_POLLS; poll++) {
  if (await healthy(PORT)) break
  if (serverExited) {
    say('Server exited during startup:')
    printLog(LOG, say)
    process.exit(1)
  }
  await wait(HEALTH_POLL_INTERVAL_MS)
}

if (!(await healthy(PORT))) {
  complain('Server never answered /healthz. Log:')
  printLog(LOG, complain)
  process.exit(1)
}

const suiteEnv = childEnv({})
const failed: string[] = []

for (const name of wanted) {
  heading(name)
  const ran = spawnSync(process.execPath, [path.join(REPO, 'scripts', SUITES[name])], {
    cwd: REPO,
    env: suiteEnv,
    stdio: 'inherit',
  })
  if (ran.status !== 0) failed.push(name)
}

console.log('')
if (failed.length === 0) {
  say('All suites passed.')
  passed = true
  process.exit(0)
}
say(`FAILED: ${failed.join(' ')}`)
say(`Server log: ${LOG}`)
process.exit(1)
