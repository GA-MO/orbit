/*
 * What is serving a web page on this Mac right now.
 *
 * Typing `http://localhost:5173` on a phone keyboard is the slowest part of
 * looking at a change, and the answer was already sitting in the kernel: the
 * Mac knows what is listening and which program owns it. So ask, and hand the
 * phone a row of ports to tap instead of a text field to fill.
 *
 * The list has to be short to be worth anything — a row of twelve chips is a
 * text field with extra steps — so three filters cut it down, in rising order
 * of cost:
 *
 *   1. the port number, which throws out the ephemeral range and the reserved
 *      one without asking anybody anything
 *   2. the program's name, for the handful of macOS services that sit on round
 *      numbers a dev server might otherwise look like
 *   3. whether it answers HTTP at all, which is the only thing that separates a
 *      dev server from a database and costs one short-lived socket to find out
 *
 * On the machine this was written on that turns thirteen listeners into one.
 */
import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Assigned by the OS, never chosen by a dev server. */
const EPHEMERAL_FROM = 32_768
/** Below this a process needs root, which no `npm run dev` has. */
const RESERVED_BELOW = 1024

/* macOS services that live in the same range a dev server does. Names are
   whatever `lsof` reports, which it truncates — matched as a prefix for that
   reason. Being wrong here only costs a chip that should not have been there. */
const NOT_A_DEV_SERVER = [
  'ControlCe', // AirPlay receiver, 5000 and 7000 — the two most claimed dev ports on a Mac
  'rapportd', // Continuity
  'sharingd', // AirDrop, Handoff
  'IPNExten', // Tailscale
  'Tailscal',
  'remoted',
  'launchd',
]

const LOOPBACK_REACHABLE = new Set(['*', '127.0.0.1', '0.0.0.0', '[::1]', 'localhost'])

export interface DevPort {
  port: number
  /** The program holding it, as the Mac names it — `node`, `Python`, `ruby`. */
  command: string
}

/**
 * Ask `lsof` what is listening, machine-readably.
 *
 * `-F` rather than the default table: a command name can contain spaces
 * (`Google Chrome H`), and splitting that table on whitespace puts the port in
 * the wrong column. The field format emits `p<pid>` and `c<command>` once per
 * process, then `n<host:port>` once per socket it holds.
 */
async function listeners(): Promise<{ host: string; port: number; command: string }[]> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], {
      timeout: 4000,
    }))
  } catch (err) {
    /* lsof exits non-zero when some sockets are unreadable, having printed the
       ones that were — so partial output is the normal case, not a failure. */
    const partial = (err as { stdout?: string }).stdout
    if (!partial) return []
    stdout = partial
  }

  const found: { host: string; port: number; command: string }[] = []
  let command = ''
  for (const line of stdout.split('\n')) {
    if (line[0] === 'c') command = line.slice(1)
    else if (line[0] === 'n') {
      const match = line.slice(1).match(/^(.*):(\d+)$/)
      if (match) found.push({ host: match[1], port: Number(match[2]), command })
    }
  }
  return found
}

/** Whether whatever is on this port replies to an HTTP request. */
const speaksHttp = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let seen = ''
    const done = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(600)
    socket.once('connect', () => socket.write('HEAD / HTTP/1.0\r\n\r\n'))
    socket.on('data', (chunk) => {
      seen += chunk.toString('latin1')
      /* Enough of the status line to tell. A database answers with its own
         protocol or with nothing at all, and either way never with this. */
      if (seen.length >= 5) done(seen.startsWith('HTTP/'))
    })
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.once('end', () => done(seen.startsWith('HTTP/')))
  })

/**
 * The dev servers running on this Mac, lowest port first.
 *
 * `orbitPort` is left out: Orbit is already on the screen asking the question.
 */
export async function devServers(orbitPort: number): Promise<DevPort[]> {
  const candidates = new Map<number, string>()
  for (const { host, port, command } of await listeners()) {
    if (!LOOPBACK_REACHABLE.has(host)) continue
    if (port === orbitPort || port < RESERVED_BELOW || port >= EPHEMERAL_FROM) continue
    if (NOT_A_DEV_SERVER.some((name) => command.startsWith(name))) continue
    // One process can hold the same port on IPv4 and IPv6; the port is the key.
    if (!candidates.has(port)) candidates.set(port, command)
  }

  const ports = [...candidates.keys()].sort((a, b) => a - b)
  const http = await Promise.all(ports.map(speaksHttp))
  return ports
    .filter((_, i) => http[i])
    .map((port) => ({ port, command: candidates.get(port) as string }))
}
