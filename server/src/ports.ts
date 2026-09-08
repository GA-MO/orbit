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
 *
 * What survives then gets a name. A port number says nothing about which of a
 * dozen checkouts it belongs to, and `node` says less; the working directory
 * the process was started in says it exactly, because that is where `npm run
 * dev` was typed. That is a fourth trip to `lsof`, so it runs last, on the two
 * or three survivors, in one call — and it labels rather than filters, since a
 * port nobody can name is still a port worth tapping.
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
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
  /** The project it is serving, when the Mac can say — the basename of the
      process's working directory. Absent when it cannot be determined. */
  project?: string
}

/**
 * Ask `lsof` what is listening, machine-readably.
 *
 * `-F` rather than the default table: a command name can contain spaces
 * (`Google Chrome H`), and splitting that table on whitespace puts the port in
 * the wrong column. The field format emits `p<pid>` and `c<command>` once per
 * process, then `n<host:port>` once per socket it holds.
 */
async function listeners(): Promise<{ host: string; port: number; command: string; pid: number }[]> {
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

  const found: { host: string; port: number; command: string; pid: number }[] = []
  let command = ''
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'c') command = line.slice(1)
    else if (line[0] === 'n') {
      const match = line.slice(1).match(/^(.*):(\d+)$/)
      if (match) found.push({ host: match[1], port: Number(match[2]), command, pid })
    }
  }
  return found
}

/**
 * Whether whatever is on this port replies to an HTTP request.
 *
 * Exported because the same question is the guard on publishing a port to the
 * tailnet unattended: an agent naming a port has no more idea than this list
 * does whether it found a dev server or Postgres, and one short-lived socket
 * is the difference. Third filter here, only filter there — the port number
 * and the program's name are about keeping a list short, not about safety.
 */
export const speaksHttp = (port: number): Promise<boolean> =>
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
 * What each of these processes would call its project: the basename of the
 * directory it was started in.
 *
 * That is a guess, but it is the same guess the developer makes — `vite`,
 * `next dev` and `python -m http.server` are all run from the checkout they
 * serve, so the directory is the repository and its name is the one on the
 * owner's screen. Reading `package.json` for a declared name was the
 * alternative and it is worse twice over: it is a file read per process, and
 * the name in there is a published package name, which is often not what the
 * folder is called and sometimes is `web` for six different repositories.
 *
 * One `lsof` for every pid rather than one each — the process spawn dominates
 * the cost here, and the list is short by the time we get here anyway.
 *
 * A directory only earns a chip if its basename says something. A server
 * started from `/` has no basename at all, and one started from the home
 * directory is labelled with the owner's own username, which is noise dressed
 * as an answer; the same goes for anything above home, like `/Users`. Those
 * come back absent, so the view shows the port on its own rather than a
 * confident wrong label. Everything else is kept as-is, including a directory
 * that is not a repository, because the owner recognises their own folder
 * names and we do not have to be sure it is a checkout to be useful.
 */
async function projects(pids: number[]): Promise<Map<number, string>> {
  const named = new Map<number, string>()
  if (pids.length === 0) return named

  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      'lsof',
      ['-a', '-d', 'cwd', '-F', 'pn', '-p', pids.join(',')],
      { timeout: 4000 },
    ))
  } catch (err) {
    /* Same bargain as `listeners`, and one more reason to take it: a process
       whose directory has been deleted, or whose owner we are not, makes lsof
       complain about that one and print the rest. A missing name costs a chip
       its label; an exception here would cost the whole tab. */
    const partial = (err as { stdout?: string }).stdout
    if (!partial) return named
    stdout = partial
  }

  const home = os.homedir()
  const found: [number, string][] = []
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n') {
      const cwd = line.slice(1)
      /* `home.startsWith(cwd)` catches `/`, `/Users` and home itself in one
         test — every directory that contains the owner rather than a project. */
      if (!path.isAbsolute(cwd) || home.startsWith(cwd)) continue
      found.push([pid, cwd])
    }
  }
  const names = await Promise.all(found.map(([, cwd]) => projectName(cwd, home)))
  found.forEach(([id], i) => {
    const name = names[i]
    if (name) named.set(id, name)
  })
  return named
}

/**
 * What to call the project a directory belongs to.
 *
 * The working directory alone is not the answer, because the directory a dev
 * server runs in is often not the thing it is: Orbit's own `vite` runs in
 * `orbit/web`, so asking the process where it stands gives the label `web` —
 * which is no more use than the bare port, and is wrong in the way that is
 * hardest to notice, since every monorepo on the machine answers `web` too.
 *
 * The repository is the honest boundary, so walk up to the nearest `.git` and
 * take that name. A few `access` calls, no process, and it stops at the home
 * directory because nothing above it is a project. A directory under no
 * repository at all keeps its own name — plenty of things worth previewing
 * were never checked in.
 */
async function projectName(cwd: string, home: string): Promise<string> {
  let dir = cwd
  while (dir.startsWith(home) && dir !== home) {
    const isRepo = await fsp
      .access(path.join(dir, '.git'))
      .then(() => true)
      .catch(() => false)
    if (isRepo) return path.basename(dir)
    dir = path.dirname(dir)
  }
  return path.basename(cwd)
}

/**
 * The dev servers running on this Mac, lowest port first.
 *
 * `orbitPort` is left out: Orbit is already on the screen asking the question.
 */
export async function devServers(orbitPort: number): Promise<DevPort[]> {
  const candidates = new Map<number, { command: string; pid: number }>()
  for (const { host, port, command, pid } of await listeners()) {
    if (!LOOPBACK_REACHABLE.has(host)) continue
    if (port === orbitPort || port < RESERVED_BELOW || port >= EPHEMERAL_FROM) continue
    if (NOT_A_DEV_SERVER.some((name) => command.startsWith(name))) continue
    // One process can hold the same port on IPv4 and IPv6; the port is the key.
    if (!candidates.has(port)) candidates.set(port, { command, pid })
  }

  const ports = [...candidates.keys()].sort((a, b) => a - b)
  const http = await Promise.all(ports.map(speaksHttp))
  const survivors = ports.filter((_, i) => http[i])

  /* Naming happens here, on what is left, and never removes anything: an
     unnameable dev server is still a dev server the phone wants to open. */
  const named = await projects([...new Set(survivors.map((port) => candidates.get(port)!.pid))])
  return survivors.map((port) => {
    const { command, pid } = candidates.get(port)!
    const project = named.get(pid)
    return project ? { port, command, project } : { port, command }
  })
}
