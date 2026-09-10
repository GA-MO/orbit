import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const FIRST_PORT = 8443
const MAX_PREVIEWS = 12
const LAST_PORT = FIRST_PORT + MAX_PREVIEWS
const PORT_MAX = 65_535
const FRONT_DOOR_PORT = 443
const CLI_TIMEOUT_MS = 15_000
const RETRY_AFTER_FAILURE_MS = 30_000
const LISTEN_PROBE_TIMEOUT_MS = 400

const NOT_INSTALLED = 'tailscale is not installed'
const NOT_LOGGED_IN = 'tailscale is not logged in'

const HAS_URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const BACKSLASHES = /\\/g
const LEADING_SLASHES = /^\/+/
const TRAILING_DOT = /\.$/
const LOOPBACK_PROXY_PORT = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?/

const INSTALLED_CLI_CANDIDATES = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

const CLI_CANDIDATES = process.env.ORBIT_TAILSCALE ? [process.env.ORBIT_TAILSCALE] : INSTALLED_CLI_CANDIDATES

export interface Preview {
  port: number
  publicPort: number
  url: string
  listening: boolean
}

export interface PreviewState {
  available: boolean
  reason: string | null
  host: string | null
  previews: Preview[]
}

let cli: string | undefined
let host: string | undefined
let cliFailedAt = 0
let hostFailedAt = 0

const failedWithinRetryWindow = (at: number) => Date.now() - at < RETRY_AFTER_FAILURE_MS

async function findCli(): Promise<string | null> {
  if (cli !== undefined) return cli
  if (failedWithinRetryWindow(cliFailedAt)) return null
  for (const candidate of CLI_CANDIDATES) {
    try {
      await execFileAsync(candidate, ['version'], { timeout: CLI_TIMEOUT_MS })
      return (cli = candidate)
    } catch {}
  }
  cliFailedAt = Date.now()
  return null
}

const firstStderrLine = (err: Error & { stderr?: string }): string | undefined =>
  (err.stderr ?? err.message ?? '').trim().split('\n').filter(Boolean)[0]

const run = async (args: string[]): Promise<string> => {
  const bin = await findCli()
  if (!bin) throw new Error(NOT_INSTALLED)
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: CLI_TIMEOUT_MS })
    return stdout
  } catch (err) {
    const detail = firstStderrLine(err as Error & { stderr?: string })
    throw new Error(detail || `tailscale ${args[0]} failed`)
  }
}

async function tailnetHost(): Promise<string | null> {
  if (host !== undefined) return host
  if (failedWithinRetryWindow(hostFailedAt)) return null
  try {
    const status = JSON.parse(await run(['status', '--json']))
    const dns: string = status?.Self?.DNSName ?? ''
    const name = dns.replace(TRAILING_DOT, '')
    if (name) return (host = name)
  } catch {}
  hostFailedAt = Date.now()
  return null
}

export async function publishFrontDoor(orbitPort: number): Promise<string> {
  await run(['serve', '--bg', String(orbitPort)])
  const name = await tailnetHost()
  if (!name) throw new Error(NOT_LOGGED_IN)
  return `https://${name}`
}

export async function unpublishFrontDoor(): Promise<void> {
  await run(['serve', `--https=${FRONT_DOOR_PORT}`, 'off'])
}

export const isListening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(LISTEN_PROBE_TIMEOUT_MS)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })

const asSingleRootedPath = (wanted: string): string =>
  `/${wanted.replace(BACKSLASHES, '/').replace(LEADING_SLASHES, '')}`

export const previewUrl = (base: string, raw?: string): string => {
  const wanted = (raw ?? '').trim()
  if (!wanted) return base
  if (HAS_URL_SCHEME.test(wanted)) throw new Error('path must be a path, not a full URL')
  const origin = new URL(base)
  const resolved = new URL(asSingleRootedPath(wanted), origin)
  if (resolved.origin !== origin.origin) throw new Error('path must stay on the preview host')
  return resolved.href
}

interface Mapping {
  publicPort: number
  port: number
}

interface ServeWebEntry {
  Handlers?: Record<string, { Proxy?: string }>
}

const isPlainRootProxy = (entry: ServeWebEntry | undefined): entry is ServeWebEntry =>
  !!entry?.Handlers?.['/']?.Proxy && Object.keys(entry.Handlers ?? {}).length === 1

const loopbackPortOf = (proxy: string): number => Number(proxy.match(LOOPBACK_PROXY_PORT)?.[1])

async function mappings(): Promise<Mapping[]> {
  const status = JSON.parse((await run(['serve', 'status', '--json'])) || '{}')
  const web: Record<string, ServeWebEntry> = status?.Web ?? {}
  const found: Mapping[] = []
  for (const [hostPort, entry] of Object.entries(web)) {
    const publicPort = Number(hostPort.split(':').pop())
    if (!publicPort || !isPlainRootProxy(entry)) continue
    const port = loopbackPortOf(entry.Handlers!['/'].Proxy!)
    if (port) found.push({ publicPort, port })
  }
  return found.sort((a, b) => a.publicPort - b.publicPort)
}

const isFrontDoor = (m: Mapping, orbitPort: number) =>
  m.port === orbitPort || m.publicPort === FRONT_DOOR_PORT

const unavailable = (reason: string, name: string | null = null): PreviewState => ({
  available: false,
  reason,
  host: name,
  previews: [],
})

const describePreview = async (name: string, port: number, publicPort: number): Promise<Preview> => ({
  port,
  publicPort,
  url: `https://${name}:${publicPort}/`,
  listening: await isListening(port),
})

export async function frontDoorTargetPort(): Promise<number | null> {
  if (!(await findCli())) return null
  try {
    return (await mappings()).find((m) => m.publicPort === FRONT_DOOR_PORT)?.port ?? null
  } catch {
    return null
  }
}

export async function state(orbitPort: number): Promise<PreviewState> {
  if (!(await findCli())) return unavailable(NOT_INSTALLED)
  const name = await tailnetHost()
  if (!name) return unavailable(NOT_LOGGED_IN)
  let found: Mapping[]
  try {
    found = await mappings()
  } catch (err) {
    return unavailable((err as Error).message, name)
  }
  const ours = found.filter((m) => !isFrontDoor(m, orbitPort))
  const previews = await Promise.all(ours.map((m) => describePreview(name, m.port, m.publicPort)))
  return { available: true, reason: null, host: name, previews }
}

let publishQueue: Promise<unknown> = Promise.resolve()

export function start(port: number, orbitPort: number): Promise<Preview> {
  const next = publishQueue.then(() => publish(port, orbitPort))
  publishQueue = next.catch(() => {})
  return next
}

const isValidPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= PORT_MAX

const firstFreePublicPort = (existing: Mapping[]): number => {
  const taken = new Set(existing.map((m) => m.publicPort))
  let publicPort = FIRST_PORT
  while (publicPort < LAST_PORT && taken.has(publicPort)) publicPort++
  if (publicPort >= LAST_PORT) throw new Error(`no free port below ${LAST_PORT}`)
  return publicPort
}

async function publish(port: number, orbitPort: number): Promise<Preview> {
  if (!isValidPort(port)) throw new Error('port must be 1–65535')
  if (port === orbitPort) throw new Error('that is Orbit itself, which is already published')

  const name = await tailnetHost()
  if (!name) throw new Error(NOT_LOGGED_IN)

  const existing = await mappings()
  const already = existing.find((m) => m.port === port && !isFrontDoor(m, orbitPort))
  if (already) return describePreview(name, port, already.publicPort)

  const publicPort = firstFreePublicPort(existing)
  await run(['serve', '--bg', `--https=${publicPort}`, String(port)])
  return describePreview(name, port, publicPort)
}

export async function liveness(ports: number[]): Promise<Record<number, boolean>> {
  const unique = [...new Set(ports)].filter(isValidPort)
  const results = await Promise.all(unique.map(isListening))
  return Object.fromEntries(unique.map((port, i) => [port, results[i]]))
}

export async function stop(publicPort: number, orbitPort: number): Promise<void> {
  const found = await mappings()
  const mapping = found.find((m) => m.publicPort === publicPort)
  if (!mapping) throw new Error(`nothing is published on ${publicPort}`)
  if (isFrontDoor(mapping, orbitPort)) throw new Error('that is how you are reaching Orbit')
  await run(['serve', `--https=${publicPort}`, 'off'])
}

export async function stopAll(orbitPort: number): Promise<void> {
  if (!(await findCli())) return
  let found: Mapping[]
  try {
    found = await mappings()
  } catch {
    return
  }
  await Promise.all(
    found
      .filter((m) => !isFrontDoor(m, orbitPort))
      .map((m) => run(['serve', `--https=${m.publicPort}`, 'off']).catch(() => {})),
  )
}
