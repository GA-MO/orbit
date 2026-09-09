/*
 * Putting a dev server on the tailnet, over https.
 *
 * A dev server is plain http on a port only the Mac can see. The phone can
 * often reach it directly — but only if the server bound every interface, and
 * `vite`, `python -m http.server` and friends bind loopback unless told not to.
 * Even when it works the result is http, which Orbit (https) cannot show in a
 * frame: mixed content. So the link sheet can only offer Copy, and following it
 * walks the installed app off its own page — a cold start, and the session's
 * screen with it.
 *
 * `tailscale serve` fixes both at once: it connects from the Mac itself, so a
 * loopback-only server is fine, and it terminates TLS with the tailnet cert, so
 * what the phone gets is https and framable. This module is a thin wrapper over
 * that CLI — deliberately with no state of its own. `tailscale serve status`
 * already knows what is mapped; a JSON file beside it could only ever disagree.
 */
import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/* 8443 is the port `npm run preview:on` has always used, so the first preview
   opened from the phone lands where the docs already point. */
const FIRST_PORT = 8443
const MAX_PREVIEWS = 12
const CLI_TIMEOUT_MS = 15_000

/**
 * Where the Tailscale app hides its CLI when it was not installed via brew.
 *
 * `ORBIT_TAILSCALE` goes in front of both. It is how the tests get to exercise
 * publishing at all — every path through this module ends at that binary, so a
 * machine without Tailscale (or with it logged out, which is most of CI) could
 * only ever test the string handling around it. It doubles as the way out for
 * an install in neither of these places.
 */
const CLI_CANDIDATES = [
  process.env.ORBIT_TAILSCALE,
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
].filter((c): c is string => !!c)

export interface Preview {
  /** The dev server's port on the Mac. */
  port: number
  /** The https port it answers on across the tailnet. */
  publicPort: number
  url: string
  /** Whether anything is actually listening on {@link port} right now. */
  listening: boolean
}

export interface PreviewState {
  /** False when there is no usable `tailscale` — the UI then stays out of the way. */
  available: boolean
  reason: string | null
  /** The tailnet name previews are published under, e.g. `mb-xyz.tailnet.ts.net`. */
  host: string | null
  previews: Preview[]
}

/* Resolved once: which binary works, and what this machine is called. Neither
   changes while the server runs, and both cost a process launch to find out.

   A failure is not the same kind of answer. Tailscale is often still coming up,
   or still logged out, when Orbit starts after a reboot, and holding on to that
   would leave Preview permanently broken with a restart as the only cure — the
   one thing that costs a running session. So a failure is only remembered long
   enough that `state()` on every foreground, and the liveness poll behind it,
   cannot turn the retry into a stream of processes. */
const RETRY_AFTER_FAILURE_MS = 30_000
let cli: string | undefined
let host: string | undefined
let cliFailedAt = 0
let hostFailedAt = 0

const failedRecently = (at: number) => Date.now() - at < RETRY_AFTER_FAILURE_MS

async function findCli(): Promise<string | null> {
  if (cli !== undefined) return cli
  if (failedRecently(cliFailedAt)) return null
  for (const candidate of CLI_CANDIDATES) {
    try {
      await execFileAsync(candidate, ['version'], { timeout: CLI_TIMEOUT_MS })
      return (cli = candidate)
    } catch {
      // try the next one
    }
  }
  cliFailedAt = Date.now()
  return null
}

const run = async (args: string[]): Promise<string> => {
  const bin = await findCli()
  if (!bin) throw new Error('tailscale is not installed')
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: CLI_TIMEOUT_MS })
    return stdout
  } catch (err) {
    /* The CLI puts the useful part on stderr — "HTTPS must be enabled in the
       admin console", "not logged in". Passing it through verbatim beats any
       message written here, which would only guess at which one it was. */
    const e = err as Error & { stderr?: string }
    const detail = (e.stderr ?? e.message ?? '').trim().split('\n').filter(Boolean)[0]
    throw new Error(detail || `tailscale ${args[0]} failed`)
  }
}

async function tailnetHost(): Promise<string | null> {
  if (host !== undefined) return host
  if (failedRecently(hostFailedAt)) return null
  try {
    const status = JSON.parse(await run(['status', '--json']))
    const dns: string = status?.Self?.DNSName ?? ''
    const name = dns.replace(/\.$/, '')
    if (name) return (host = name)
  } catch {
    // logged out, or not up yet — either way, worth asking again later
  }
  hostFailedAt = Date.now()
  return null
}

/** Whether a dev server is up on this port, so the UI can say so before you tap. */
export const isListening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(400)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })

/**
 * Turn a path an agent asked for into a URL on a published preview host.
 *
 * Lives here rather than in the route because it is about the shape of a
 * preview URL and nothing about HTTP — and because being a plain function of
 * two strings is what makes it testable without tailscale on the machine.
 *
 * The published address is the only origin this may ever produce, so the
 * question is not what the agent meant but what the string can be made to do.
 * `//evil.com/x` reads as a path and resolves as a host, and `..` walks out of
 * a directory, so neither can be trusted to `new URL` alone: every leading
 * slash and backslash is stripped and exactly one put back, which leaves a
 * host nowhere to hide, and `..` is then clamped at the root the way a browser
 * clamps it. A query string survives all of that untouched, because a route
 * worth showing is often `/orders?status=open`.
 *
 * A full `http://…` is refused rather than mangled into a path. An agent that
 * passes one has misread the argument, and saying so teaches it more than
 * quietly opening `/http:/example.com` would. A refusal is a plain `Error`,
 * which the route turns into a 400 — the alternative, reaching back into
 * `index.ts` for its `bad()`, would make this module depend on the one thing
 * it was pulled out of.
 */
export const previewUrl = (base: string, raw?: string): string => {
  const wanted = (raw ?? '').trim()
  if (!wanted) return base
  if (/^[a-z][a-z0-9+.-]*:/i.test(wanted)) throw new Error('path must be a path, not a full URL')
  const origin = new URL(base)
  const resolved = new URL(`/${wanted.replace(/\\/g, '/').replace(/^\/+/, '')}`, origin)
  // Belt and braces: nothing above should be able to reach this, and if
  // something ever does, it leaves as an error rather than as a link.
  if (resolved.origin !== origin.origin) throw new Error('path must stay on the preview host')
  return resolved.href
}

interface Mapping {
  publicPort: number
  port: number
}

/* `serve status --json` reports every mapping on the machine, Orbit's own
   included. Only the ones that are a plain proxy to a loopback port are
   previews; a mount serving a directory, or a path other than `/`, is
   something the user set up by hand and is not ours to list or remove. */
async function mappings(): Promise<Mapping[]> {
  const status = JSON.parse((await run(['serve', 'status', '--json'])) || '{}')
  const web: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> = status?.Web ?? {}
  const found: Mapping[] = []
  for (const [hostPort, entry] of Object.entries(web)) {
    const publicPort = Number(hostPort.split(':').pop())
    const proxy = entry?.Handlers?.['/']?.Proxy
    if (!publicPort || !proxy || Object.keys(entry.Handlers ?? {}).length !== 1) continue
    const port = Number(proxy.match(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?/)?.[1])
    if (port) found.push({ publicPort, port })
  }
  return found.sort((a, b) => a.publicPort - b.publicPort)
}

/**
 * The way in. Taking this down would cut off the phone that asked — over the
 * very connection carrying the request — so it is filtered out of every list
 * and refused by {@link stop}.
 *
 * Two tests, because either alone has a hole: a second Orbit on a spare port
 * (the smoke test does exactly this) does not recognise `443 → 3001` as the
 * real one by target, and a front door someone moved off 443 is not caught by
 * port. Anything reaching either test is left alone.
 */
const isFrontDoor = (m: Mapping, orbitPort: number) => m.port === orbitPort || m.publicPort === 443

export async function state(orbitPort: number): Promise<PreviewState> {
  if (!(await findCli())) {
    return { available: false, reason: 'tailscale is not installed', host: null, previews: [] }
  }
  const name = await tailnetHost()
  if (!name) {
    return {
      available: false,
      reason: 'tailscale is not logged in',
      host: null,
      previews: [],
    }
  }
  let found: Mapping[]
  try {
    found = await mappings()
  } catch (err) {
    return { available: false, reason: (err as Error).message, host: name, previews: [] }
  }
  const ours = found.filter((m) => !isFrontDoor(m, orbitPort))
  const previews = await Promise.all(
    ours.map(async (m) => ({
      port: m.port,
      publicPort: m.publicPort,
      url: `https://${name}:${m.publicPort}/`,
      listening: await isListening(m.port),
    })),
  )
  return { available: true, reason: null, host: name, previews }
}

/**
 * Publish a local port. Idempotent: a port already published comes back with
 * the address it already has rather than being given a second one.
 *
 * A dev server that is not up yet is still published — the agent starting one
 * a moment later is the normal case, and refusing here would just mean tapping
 * the same button again. {@link Preview.listening} carries the fact instead.
 */
export async function start(port: number, orbitPort: number): Promise<Preview> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('port must be 1–65535')
  if (port === orbitPort) throw new Error('that is Orbit itself, which is already published')

  const name = await tailnetHost()
  if (!name) throw new Error('tailscale is not logged in')

  const existing = await mappings()
  const already = existing.find((m) => m.port === port && !isFrontDoor(m, orbitPort))
  if (already) {
    return {
      port,
      publicPort: already.publicPort,
      url: `https://${name}:${already.publicPort}/`,
      listening: await isListening(port),
    }
  }

  const taken = new Set(existing.map((m) => m.publicPort))
  const limit = FIRST_PORT + MAX_PREVIEWS
  let publicPort = FIRST_PORT
  while (publicPort < limit && taken.has(publicPort)) publicPort++
  if (publicPort >= limit) throw new Error(`no free port below ${limit}`)

  await run(['serve', '--bg', `--https=${publicPort}`, String(port)])
  return {
    port,
    publicPort,
    url: `https://${name}:${publicPort}/`,
    listening: await isListening(port),
  }
}

/**
 * Which of these ports have something behind them right now.
 *
 * Separate from {@link state} because the two age at completely different
 * rates. What is *published* changes only when someone publishes something —
 * and finding out costs two `tailscale` processes. Whether a dev server is *up*
 * changes every time an agent restarts one, and finding out is a TCP connect to
 * loopback. Polling the cheap half every few seconds is what makes a row's
 * "nothing there yet" mean anything; polling the expensive half at that rate
 * would spawn processes all day to watch something that rarely moves.
 */
export async function liveness(ports: number[]): Promise<Record<number, boolean>> {
  const unique = [...new Set(ports)].filter((p) => Number.isInteger(p) && p > 0 && p <= 65_535)
  const results = await Promise.all(unique.map(isListening))
  return Object.fromEntries(unique.map((port, i) => [port, results[i]]))
}

/** Take a published port down. Refuses the one Orbit is reached through. */
export async function stop(publicPort: number, orbitPort: number): Promise<void> {
  const found = await mappings()
  const mapping = found.find((m) => m.publicPort === publicPort)
  if (!mapping) throw new Error(`nothing is published on ${publicPort}`)
  if (isFrontDoor(mapping, orbitPort)) throw new Error('that is how you are reaching Orbit')
  await run(['serve', `--https=${publicPort}`, 'off'])
}

/**
 * Drop every published preview on the way out. Leaves the front door (443 /
 * Orbit's own port) alone — `make stop` / `make phone-off` owns that mapping,
 * so a Ctrl+C restart without Tailscale does not surprise, and a phone still
 * on the wire is not cut mid-request by the server that is answering it.
 *
 * Best-effort: missing CLI or a failed `off` must not block process exit.
 */
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
