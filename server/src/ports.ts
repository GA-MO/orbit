import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const EPHEMERAL_FROM = 32_768
const RESERVED_BELOW = 1024
const LSOF_TIMEOUT_MS = 4000
const HTTP_PROBE_TIMEOUT_MS = 600
const HEAD_REQUEST = 'HEAD / HTTP/1.0\r\n\r\n'
const HTTP_STATUS_PREFIX = 'HTTP/'
const LISTEN_ADDRESS = /^(.*):(\d+)$/

const MACOS_SERVICE_BY_LSOF_NAME_PREFIX: Record<string, string> = {
  ControlCe: 'AirPlay receiver, on 5000 and 7000',
  rapportd: 'Continuity',
  sharingd: 'AirDrop and Handoff',
  IPNExten: 'Tailscale',
  Tailscal: 'Tailscale',
  remoted: 'remoted',
  launchd: 'launchd',
}
const NOT_A_DEV_SERVER = Object.keys(MACOS_SERVICE_BY_LSOF_NAME_PREFIX)

const LOOPBACK_REACHABLE = new Set(['*', '127.0.0.1', '0.0.0.0', '[::1]', 'localhost'])

export interface DevPort {
  port: number
  command: string
  project?: string
}

interface Listener {
  host: string
  port: number
  command: string
  pid: number
}

const runLsofKeepingPartialOutput = async (args: string[]): Promise<string> => {
  try {
    const { stdout } = await execFileAsync('lsof', args, { timeout: LSOF_TIMEOUT_MS })
    return stdout
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? ''
  }
}

const fieldTag = (line: string): string => line[0]
const fieldValue = (line: string): string => line.slice(1)

async function listeners(): Promise<Listener[]> {
  const stdout = await runLsofKeepingPartialOutput(['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])
  const found: Listener[] = []
  let command = ''
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (fieldTag(line) === 'p') pid = Number(fieldValue(line))
    else if (fieldTag(line) === 'c') command = fieldValue(line)
    else if (fieldTag(line) === 'n') {
      const match = fieldValue(line).match(LISTEN_ADDRESS)
      if (match) found.push({ host: match[1], port: Number(match[2]), command, pid })
    }
  }
  return found
}

export const speaksHttp = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let seen = ''
    const done = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    const isHttpReply = () => seen.startsWith(HTTP_STATUS_PREFIX)
    socket.setTimeout(HTTP_PROBE_TIMEOUT_MS)
    socket.once('connect', () => socket.write(HEAD_REQUEST))
    socket.on('data', (chunk) => {
      seen += chunk.toString('latin1')
      if (seen.length >= HTTP_STATUS_PREFIX.length) done(isHttpReply())
    })
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.once('end', () => done(isHttpReply()))
  })

const isHomeOrAboveHome = (cwd: string, home: string): boolean =>
  !path.isAbsolute(cwd) || home.startsWith(cwd)

const workingDirectoriesOf = async (pids: number[]): Promise<[number, string][]> => {
  const stdout = await runLsofKeepingPartialOutput(['-a', '-d', 'cwd', '-F', 'pn', '-p', pids.join(',')])
  const home = os.homedir()
  const found: [number, string][] = []
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (fieldTag(line) === 'p') pid = Number(fieldValue(line))
    else if (fieldTag(line) === 'n') {
      const cwd = fieldValue(line)
      if (isHomeOrAboveHome(cwd, home)) continue
      found.push([pid, cwd])
    }
  }
  return found
}

async function projectNamesByPid(pids: number[]): Promise<Map<number, string>> {
  const named = new Map<number, string>()
  if (pids.length === 0) return named
  const home = os.homedir()
  const found = await workingDirectoriesOf(pids)
  const names = await Promise.all(found.map(([, cwd]) => nearestRepositoryName(cwd, home)))
  found.forEach(([pid], i) => {
    const name = names[i]
    if (name) named.set(pid, name)
  })
  return named
}

const isRepository = (dir: string): Promise<boolean> =>
  fsp
    .access(path.join(dir, '.git'))
    .then(() => true)
    .catch(() => false)

async function nearestRepositoryName(cwd: string, home: string): Promise<string> {
  let dir = cwd
  while (dir.startsWith(home) && dir !== home) {
    if (await isRepository(dir)) return path.basename(dir)
    dir = path.dirname(dir)
  }
  return path.basename(cwd)
}

const isKnownMacosService = (command: string): boolean =>
  NOT_A_DEV_SERVER.some((name) => command.startsWith(name))

const couldBeDevServerPort = (port: number, orbitPort: number): boolean =>
  port !== orbitPort && port >= RESERVED_BELOW && port < EPHEMERAL_FROM

export async function devServers(orbitPort: number): Promise<DevPort[]> {
  const candidates = new Map<number, { command: string; pid: number }>()
  for (const { host, port, command, pid } of await listeners()) {
    if (!LOOPBACK_REACHABLE.has(host)) continue
    if (!couldBeDevServerPort(port, orbitPort)) continue
    if (isKnownMacosService(command)) continue
    if (!candidates.has(port)) candidates.set(port, { command, pid })
  }

  const ports = [...candidates.keys()].sort((a, b) => a - b)
  const http = await Promise.all(ports.map(speaksHttp))
  const survivors = ports.filter((_, i) => http[i])

  const named = await projectNamesByPid([...new Set(survivors.map((port) => candidates.get(port)!.pid))])
  return survivors.map((port) => {
    const { command, pid } = candidates.get(port)!
    const project = named.get(pid)
    return project ? { port, command, project } : { port, command }
  })
}
