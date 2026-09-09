import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { PtyManager } from './pty-manager.js'
import { PROVIDERS, getProvider, detectAvailability } from './providers.js'
import {
  expiredSessionCookie,
  getToken,
  hasSessionCookie,
  isSecureRequest,
  matches,
  sessionCookie,
} from './auth.js'
import { screen } from './approval.js'
import * as screenshot from './screenshot.js'
import * as preview from './preview.js'
import * as ports from './ports.js'
import * as git from './git.js'
import * as uploads from './uploads.js'
import * as store from './store.js'
import * as notify from './notify.js'
import * as attention from './attention.js'
import * as push from './push.js'
import { banner, plainBanner } from './banner.js'

const PORT = Number(process.env.ORBIT_PORT ?? 3001)
const HOME = os.homedir()
const WEB_DIST = new URL('../../web/dist', import.meta.url).pathname

const TOKEN = getToken()
const manager = new PtyManager()

type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }
  | { type: 'approve'; id: string }
  | { type: 'deny'; id: string }
  | { type: 'answer'; id: string; choice: string }
  | { type: 'viewing'; sessionId: string | null }

type ServerMessage =
  | { type: 'ready'; sessionId: string; replay: string; readOnly?: boolean }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'pong' }
  | { type: 'approval'; id: string; label: string; command: string }
  | { type: 'gone'; sessionId: string }
  | notify.Notice
  | notify.Ask
  | notify.PreviewOpen
  | notify.AttentionRaised

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/* Every JSON route reads its body through here, so the cap belongs here too.
   Without one a request that never ends is a string that grows until the
   process does — and the upload route, the only one that was ever expected to
   carry weight, has always had a limit of its own. A megabyte is far more than
   anything on this API sends: the largest is a commit message. */
const BODY_LIMIT = 1024 * 1024

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > BODY_LIMIT) {
        reject(new HttpError(413, `body exceeds ${BODY_LIMIT / 1024}KB limit`))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })

const readJson = async <T>(req: http.IncomingMessage): Promise<T> => {
  const raw = await readBody(req)
  try {
    return JSON.parse(raw || '{}') as T
  } catch {
    throw bad('invalid JSON')
  }
}

/**
 * Which session a message from the Mac is about.
 *
 * The sender is a descendant of the PTY, so it usually knows: `ORBIT_SESSION_ID`
 * is in its environment. The folder is the fallback for anything that predates
 * it, and only where the answer is not a guess — two agents in one folder make
 * it one, and filing the message against the wrong session is worse than
 * filing it against none.
 */
const resolveSession = (sessionId?: string | null, source?: string | null): string | null => {
  if (sessionId && (manager.get(sessionId) || manager.isDead(sessionId))) return sessionId
  if (!source) return null
  const cwd = path.resolve(source)
  const live = manager.list().filter((s) => s.alive && s.cwd === cwd)
  return live.length === 1 ? live[0].id : null
}

/** Restrict filesystem/session paths to the user's home directory. */
const safePath = (p: string): string | null => {
  const resolved = path.resolve(p)
  return resolved === HOME || resolved.startsWith(HOME + path.sep) ? resolved : null
}

/* Two credentials, deliberately unequal in what they can do.
 *
 * The token, as a Bearer header, is the real one: anything at all. The session
 * cookie stands in only where a header cannot be set — the WebSocket handshake
 * and an <img src> — so it authorises reads and the socket, never a write.
 * SameSite=Strict is what makes that safe: no other origin can cause the
 * browser to send it in the first place. */
/* Compared the way the cookie is, and for the same reason: `===` on a string
   stops at the first byte that differs, and the time it took to stop is a
   reading of how much of the guess was right. */
const bearer = (req: http.IncomingMessage): boolean =>
  matches(req.headers.authorization ?? '', `Bearer ${TOKEN}`)

const authorized = (req: http.IncomingMessage): boolean => {
  if (bearer(req)) return true
  return req.method === 'GET' && hasSessionCookie(req, TOKEN)
}

/* ---- Slowing down a guess -------------------------------------------------
 *
 * A tailnet is not the open internet, but the token is the only thing between
 * anyone already on it and every file under the home directory — and nothing
 * stopped a client from trying tokens as fast as the loop could answer.
 *
 * This holds a rejection back rather than refusing to answer at all. A block
 * would be a way to lock the owner out, since `tailscale serve` proxies every
 * remote client from 127.0.0.1 and they all count as one address. A delay
 * costs a guesser everything and the owner nothing: a phone that is logged in
 * never fails, so it never waits.
 */
const FREE_ATTEMPTS = 10
const FAILURE_FORGOTTEN_MS = 60_000
const MAX_DELAY_MS = 2000

const failures = new Map<string, { count: number; last: number }>()

const rejectSlowly = (req: http.IncomingMessage): Promise<void> => {
  const key = req.socket.remoteAddress ?? 'unknown'
  const now = Date.now()
  const seen = failures.get(key)
  const count = seen && now - seen.last < FAILURE_FORGOTTEN_MS ? seen.count + 1 : 1
  failures.set(key, { count, last: now })
  if (failures.size > 64) {
    for (const [k, v] of failures) if (now - v.last > FAILURE_FORGOTTEN_MS) failures.delete(k)
  }
  const over = count - FREE_ATTEMPTS
  if (over <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, Math.min(over * 250, MAX_DELAY_MS)))
}

const forgetFailures = (req: http.IncomingMessage) =>
  failures.delete(req.socket.remoteAddress ?? 'unknown')

// ---- Static serving of the built web app (production: single port) ----

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
}

async function serveStatic(url: URL, res: http.ServerResponse) {
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = path.join(WEB_DIST, rel)
  if (!file.startsWith(WEB_DIST)) return json(res, 404, { error: 'not found' })

  let stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) {
    /* The app is one screen with no client-side routes, so the only address it
       answers to is `/`. Anything else that misses is a mistyped or truncated
       URL, and handing those the app makes a wrong address look like the app
       bouncing back — which is exactly how a link split across two terminal
       rows presents itself. */
    if (rel !== '/' && rel !== '/index.html') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`Orbit: no such path — ${rel}`)
      return
    }
    file = path.join(WEB_DIST, 'index.html')
    stat = await fsp.stat(file).catch(() => null)
  }
  if (!stat?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Orbit: web build not found. Run `npm run build`, or use the Vite dev server.')
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': stat.size,
  })
  fs.createReadStream(file).pipe(res)
}

// ---- API ----

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true })

  if (url.pathname.startsWith('/api/')) {
    /* One exception, and it is not a hole: a notification tapped on a locked
       phone is handled by the service worker, which has no token and must not
       be given one. It carries a capability for a single open question
       instead, and the route below checks it. */
    const byCapability = req.method === 'POST' && url.pathname === '/api/ask/answer'
    if (!byCapability) {
      if (!authorized(req)) {
        await rejectSlowly(req)
        return json(res, 401, { error: 'unauthorized' })
      }
      forgetFailures(req)
    }
    return handleAuthedApi(req, res, url)
  }

  // Anything else is the web app itself (public shell; all data sits behind the API).
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url, res)
  json(res, 404, { error: 'not found' })
}
/* ---- Router -----------------------------------------------------------
 *
 * One table, not a chain of ifs. The chain worked, but its correctness lived
 * in the order the branches happened to be written in: every literal path had
 * to be tested before the pattern that could also match it, and a route added
 * at the wrong line answered with the wrong handler — silently, since both
 * branches are valid code.
 *
 * Here a pattern matches only a path with the same number of segments, so
 * `/api/sessions` and `/api/sessions/:id` cannot collide however they are
 * ordered. Registration order still decides between two patterns that could
 * both match (`/api/previews/live` before `/api/previews/:port`), and those
 * are written next to each other.
 */

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const bad = (message: string) => new HttpError(400, message)
const notFound = () => new HttpError(404, 'not found')

interface Ctx {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  params: Record<string, string>
  /** The request body as JSON. A malformed one is a 400 before the handler runs. */
  body<T = Record<string, any>>(): Promise<T>
}

type Handler = (c: Ctx) => Promise<unknown> | unknown

const routes: { method: string; segments: string[]; handler: Handler }[] = []

const on = (spec: string, handler: Handler) => {
  const [method, pathname] = spec.split(' ')
  routes.push({ method, segments: pathname.split('/'), handler })
}

const match = (method: string, pathname: string) => {
  const parts = pathname.split('/')
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < parts.length; i++) {
      const seg = r.segments[i]
      if (!seg.startsWith(':')) {
        if (seg !== parts[i]) {
          ok = false
          break
        }
        continue
      }
      if (!parts[i]) {
        ok = false
        break
      }
      params[seg.slice(1)] = decodeURIComponent(parts[i])
    }
    if (ok) return { handler: r.handler, params }
  }
  return null
}

async function handleAuthedApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const hit = match(req.method ?? 'GET', url.pathname)
  if (!hit) return json(res, 404, { error: 'not found' })
  try {
    await hit.handler({
      req,
      res,
      url,
      params: hit.params,
      body: () => readJson(req),
    })
  } catch (err) {
    if (err instanceof HttpError) return json(res, err.status, { error: err.message })
    throw err
  }
}

// ---- Routes ----

/* The token check is also where a browser picks up its session cookie, so
   every successful pairing — and every reload — renews it in one round trip. */
on('GET /api/auth/check', ({ req, res }) => {
  if (bearer(req)) res.setHeader('Set-Cookie', sessionCookie(TOKEN, isSecureRequest(req)))
  return json(res, 200, { ok: true })
})

/* Unpairing this phone, which is more than forgetting the token it typed.
   Two things outlive `localStorage` and both are handed back here: the session
   cookie, which no script can delete (see `expiredSessionCookie`), and the push
   subscription, which is registered against the *browser* and would otherwise
   keep waking a phone that can no longer open the app to see why. The endpoint
   comes from the client because that is the only side that knows which of the
   registered devices is this one — the server sees a list of opaque URLs with
   nothing on them that says "the phone asking".

   A Bearer token is required, like every other write: the cookie alone must not
   be able to unpair, or a request the browser was tricked into sending could
   log the owner out. */
on('POST /api/auth/unpair', async ({ req, res, body }) => {
  const b = await body<{ endpoint?: string }>()
  if (typeof b.endpoint === 'string' && b.endpoint) push.unsubscribe(b.endpoint)
  res.setHeader('Set-Cookie', expiredSessionCookie(isSecureRequest(req)))
  return json(res, 200, { ok: true, devices: push.count() })
})

on('GET /api/providers', async ({ res }) => {
  const available = await detectAvailability()
  return json(
    res,
    200,
    PROVIDERS.map((p) => ({ id: p.id, name: p.name, available: available[p.id] ?? false })),
  )
})

on('GET /api/sessions', async ({ res }) => {
  /* Conversations run from a terminal on the Mac are found by looking, not by
     being told — so the list is where the looking happens. A scan that fails
     costs those rows, never the sessions Orbit does own. */
  await manager.discover().catch((err) => console.error('[orbit] transcript scan failed:', err))
  const list = manager.list()
  // A forgotten session cannot still be waiting for anything.
  attention.keepOnly(list.map((s) => s.id))
  return json(
    res,
    200,
    list.map((s) => ({ ...s, attention: attention.get(s.id) })),
  )
})

on('POST /api/sessions', async ({ res, body }) => {
  const b = await body<{ provider?: string; cwd?: string; name?: string }>()

  const provider = getProvider(b.provider ?? 'shell')
  if (!provider) throw bad(`unknown provider: ${b.provider}`)

  let cwd = HOME
  if (b.cwd) {
    const safe = safePath(b.cwd)
    if (!safe) throw bad('cwd must be inside the home directory')
    const stat = await fsp.stat(safe).catch(() => null)
    if (!stat?.isDirectory()) throw bad('cwd is not a directory')
    cwd = safe
  }

  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 60) : ''
  const session = manager.create({ provider, cwd, name: name || undefined })
  const info = manager.list().find((s) => s.id === session.id)
  return json(res, 201, info)
})

on('DELETE /api/sessions/:id', ({ res, params }) => {
  const session = manager.get(params.id)
  if (session) {
    session.kill() // moves to the ended list, history kept
    return json(res, 200, { ok: true })
  }
  /* Its transcript belongs to Claude Code on the Mac. Orbit reads that file and
     writes nothing to it — deleting one from a phone is not a tap to offer. */
  if (manager.isExternal(params.id)) {
    throw bad('this conversation belongs to the Mac — Orbit only reads it')
  }
  if (manager.forget(params.id)) return json(res, 200, { ok: true }) // ended: remove + history
  throw notFound()
})

/* Hiding, which is what the ✕ on a conversation from the Mac would have been
   if Orbit were allowed to delete one. It is not: that transcript is Claude
   Code's file, and the DELETE above says so. So the phone keeps its own list of
   rows it does not want to see, in `~/.orbit/hidden.json`, and the file stays
   exactly where it was — a hidden conversation is still resumable at the desk,
   and still comes back if it is un-hidden.

   Both of these are literal paths that could be read as `/api/sessions/:id`,
   which is why neither is a DELETE: the router picks between two patterns of
   the same shape by registration order, and a rule that lives in the order
   lines happen to be written is the exact thing the table replaced. A GET and
   a POST collide with nothing. */
on('GET /api/sessions/hidden', ({ res }) => json(res, 200, { hidden: manager.hiddenCount() }))

on('POST /api/sessions/unhide', ({ res }) => json(res, 200, { unhidden: manager.unhideAll() }))

on('POST /api/sessions/:id/hide', ({ res, params }) => {
  if (manager.hide(params.id)) return json(res, 200, { ok: true })
  /* Either it is not a row the phone was just shown, or it is one of Orbit's
     own — which has a real ✕ and a real delete, and must not quietly acquire a
     second, weaker one that leaves the history on disk. */
  throw notFound()
})

on('PATCH /api/sessions/:id', async ({ res, params, body }) => {
  const session = manager.get(params.id)
  if (!session) throw notFound()
  const b = await body<{ name?: string }>()
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 60) : ''
  session.name = name || null
  manager.persistNow()
  return json(res, 200, { ok: true, name: session.name })
})

/* Reading is what marks it read. The phone says so when the session is
   actually on screen, which is the only moment that means anything. */
on('DELETE /api/sessions/:id/attention', ({ res, params }) =>
  json(res, 200, { cleared: attention.clear(params.id) }),
)

on('POST /api/sessions/:id/restart', async ({ res, params, body }) => {
  const b = await body<{ resume?: boolean }>()
  const session = manager.restart(params.id, !!b.resume)
  if (!session) {
    throw new HttpError(
      404,
      b.resume ? 'this agent cannot resume a conversation' : 'not found or not restartable',
    )
  }
  const info = manager.list().find((s) => s.id === session.id)
  return json(res, 201, info)
})

on('POST /api/upload', async ({ req, res, url }) => {
  const rawName = url.searchParams.get('name') ?? 'image.png'
  const chunks: Buffer[] = []
  let size = 0
  try {
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > uploads.LIMIT) {
          reject(new Error('too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', resolve)
      req.on('error', reject)
    })
  } catch {
    return json(res, 413, { error: `upload exceeds ${uploads.LIMIT / 1024 / 1024}MB limit` })
  }
  if (size === 0) throw bad('empty upload')
  const file = await uploads.save(rawName, Buffer.concat(chunks))
  return json(res, 201, { path: file })
})

on('POST /api/screenshot', async ({ res, body }) => {
  const b = await body<{
    source?: string
    url?: string
    preset?: string
    width?: number
    height?: number
    fullPage?: boolean
    display?: number
    label?: string
  }>()

  if (b.source === 'screen') {
    try {
      return json(res, 201, await screenshot.captureScreen({ display: b.display }))
    } catch (err) {
      throw new HttpError(502, (err as Error).message)
    }
  }

  if (!b.url || !/^https?:\/\//.test(b.url)) throw bad('url must start with http(s)://')
  if (b.preset !== undefined && !screenshot.isPreset(b.preset)) {
    throw bad(`unknown preset: ${b.preset}`)
  }
  try {
    return json(res, 201, await screenshot.capture(b.url, { ...b, preset: b.preset }))
  } catch (err) {
    throw new HttpError(502, `capture failed: ${(err as Error).message}`)
  }
})

on('GET /api/presets', ({ res }) => json(res, 200, screenshot.PRESETS))

/* Force-cold the warm Playwright Chrome used for captures. Does not touch
   GUI browsers an agent opened in a PTY — those are not Orbit's process.

   No longer offered on the phone: the button was faint text in the middle of a
   settings row, was read as closing the frame or the agent's own tabs, and
   saved a process that `screenshot.ts` already closes itself after a minute
   idle. Kept as a route because a wedged Chrome is worth one curl, and nothing
   reaches this by accident. */
on('POST /api/resources/chrome/close', async ({ res }) => {
  await screenshot.shutdown()
  return json(res, 200, { ok: true })
})

/* What is serving a page on this Mac right now, so the phone can offer it
   instead of asking someone to type a port on a touch keyboard. Costs one
   `lsof` and a short-lived socket per candidate, so it is asked on arrival
   and on waking — never polled. */
on('GET /api/ports', async ({ res }) => json(res, 200, await ports.devServers(PORT)))

// ---- Previews: a dev server, over https, on the tailnet ----

on('GET /api/previews', async ({ res }) => json(res, 200, await preview.state(PORT)))

/* The half worth polling. `ports` is a list because the phone already knows
   which ones it is showing, and asking about those costs a TCP connect each —
   no `tailscale` process, so a tab left open is not a process every few
   seconds. Capped so one request cannot ask for a port scan.

   Registered above `/api/previews/:port`, the only other route it could match. */
on('GET /api/previews/live', async ({ res, url }) => {
  const wanted = (url.searchParams.get('ports') ?? '')
    .split(',')
    .map(Number)
    .filter(Boolean)
    .slice(0, 32)
  return json(res, 200, await preview.liveness(wanted))
})

on('POST /api/previews', async ({ res, body }) => {
  const b = await body<{ port?: number }>()
  try {
    return json(res, 201, await preview.start(Number(b.port), PORT))
  } catch (err) {
    throw bad((err as Error).message)
  }
})

on('DELETE /api/previews/:port', async ({ res, params }) => {
  try {
    await preview.stop(Number(params.port), PORT)
    return json(res, 200, { ok: true })
  } catch (err) {
    throw bad((err as Error).message)
  }
})

/**
 * The agent saying "go and look at this yourself".
 *
 * `orbit_capture` lets it look at the picture and `orbit_notify` lets it say
 * done; this is the third thing, which neither could do — hand the running app
 * to the person holding the phone, already on the route in question, without
 * them tapping through the Preview tab and then typing a path.
 */
on('POST /api/preview', async ({ res, body }) => {
  const b = await body<{ port?: number; path?: string; source?: string; sessionId?: string }>()
  const port = Number(b.port)
  /* Ahead of the probe below, not because `preview.start` does not check the
     same thing a moment later, but because a socket opened on `NaN` — which is
     what an agent that forgot the argument sends — fails with the wrong words
     entirely. */
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw bad('port must be 1–65535')

  /* The one place a port reaches the tailnet without anybody looking at it.
     From the phone, publishing is a deliberate tap on a chip the Mac already
     filtered down to things that answer HTTP; here the agent names the number
     itself, and `orbit_preview(5432)` would put Postgres on the tailnet — read
     only by the tailnet, and only until Orbit exits, but published by a
     mistake rather than by a decision. So ask the port the same question the
     chip list asks, before `tailscale serve` is touched at all: a refusal that
     published nothing is one the agent can simply act on.

     This is where the agent's path deliberately parts company with the
     phone's. `preview.start` publishes a port with nothing on it yet, because
     a person tapping a chip is often a second ahead of the dev server and the
     row says so — the human reads "nothing there yet" and waits. The agent has
     no such row: it hands the URL straight to a frame on someone's phone, and
     a blank frame is indistinguishable from a broken app. It is also the one
     that can fix it, having just been told which port it forgot to start. */
  if (!(await ports.speaksHttp(port))) {
    throw bad(
      `nothing is answering HTTP on ${port} — start the dev server first, or, if that ` +
        'port is a database or some other service, it is not something the phone can open',
    )
  }

  let published: preview.Preview
  try {
    published = await preview.start(port, PORT)
  } catch (err) {
    // Same treatment as POST /api/previews: tailscale's own words, verbatim.
    throw bad((err as Error).message)
  }
  let url: string
  try {
    url = preview.previewUrl(published.url, b.path)
  } catch (err) {
    // A plain Error from preview.ts; the 400 is this route's to give.
    throw bad((err as Error).message)
  }
  const sessionId = resolveSession(b.sessionId, b.source)
  const { delivered } = notify.openPreview({
    url,
    port: published.port,
    source: b.source ?? null,
    sessionId,
  })
  /* Nobody was there. A frame cannot be opened retroactively — and would show
     the wrong thing if it could, an hour of work later — so what is kept is a
     notice saying which port and path were meant, through the same missed
     queue and push that carry a notice nobody was there for. The user opens it
     themselves, on the route the agent named. */
  let pushed = 0
  if (delivered === 0) {
    const { pathname, search } = new URL(url)
    const message = `Wanted to show you port ${published.port} at ${pathname}${search} — open it from the Preview tab.`
    const notice = notify.notify({ message, source: b.source ?? null, sessionId })
    pushed = await push.send('Orbit', message, sessionId, push.NOTICE)
    if (pushed > 0) notify.markPushed(notice.id)
  }
  return json(res, 200, { url, port: published.port, delivered, pushed, sessionId })
})

/* ---- What the agent changed ----
 *
 * Everything here is addressed by folder rather than by session: the phone
 * takes the folder from whichever session it is showing, and two sessions in
 * one repository are looking at the same working tree anyway. Same home
 * restriction as the folder browser — this reads and writes real files.
 */
type RepoCtx = Ctx & { cwd: string; input: Record<string, any> }

const inRepo =
  (handler: (c: RepoCtx) => Promise<unknown> | unknown): Handler =>
  async (c) => {
    const input = c.req.method === 'GET' ? {} : await c.body()
    const asked =
      c.req.method === 'GET'
        ? (c.url.searchParams.get('cwd') ?? '')
        : typeof input.cwd === 'string'
          ? input.cwd
          : ''
    const cwd = safePath(asked)
    if (!cwd) throw bad('cwd must be inside the home directory')
    const stat = await fsp.stat(cwd).catch(() => null)
    if (!stat?.isDirectory()) throw bad('cwd is not a directory')
    try {
      return await handler({ ...c, cwd, input })
    } catch (err) {
      if (err instanceof HttpError) throw err
      // git's own words: "nothing is staged", "failed to push some refs", …
      throw bad((err as Error).message)
    }
  }

on(
  'GET /api/git/status',
  inRepo(async ({ res, cwd }) => json(res, 200, await git.status(cwd))),
)

on(
  'GET /api/git/diff',
  inRepo(async ({ res, url, cwd }) => {
    const file = url.searchParams.get('file') ?? ''
    if (!file) throw bad('file is required')
    return json(res, 200, await git.diff(cwd, file, url.searchParams.get('staged') === '1'))
  }),
)

on(
  'POST /api/git/stage',
  inRepo(async ({ res, cwd, input }) => {
    const files = Array.isArray(input.files)
      ? input.files.filter((f: unknown) => typeof f === 'string')
      : []
    await git.stage(cwd, files, input.add !== false)
    return json(res, 200, await git.status(cwd))
  }),
)

/* One hunk rather than the whole file. The body of the hunk comes from the
   phone; the header naming the file is written on this side from a path that
   has already been checked, so a patch cannot reach a file the sheet was not
   showing. */
on(
  'POST /api/git/hunk',
  inRepo(async ({ res, cwd, input }) => {
    const file = typeof input.file === 'string' ? input.file : ''
    const hunk = typeof input.hunk === 'string' ? input.hunk : ''
    if (!file) throw bad('file is required')
    if (!hunk) throw bad('hunk is required')
    await git.applyHunk(cwd, file, hunk, input.staged === true)
    return json(res, 200, await git.status(cwd))
  }),
)

on(
  'POST /api/git/commit',
  inRepo(async ({ res, cwd, input }) => {
    const made = await git.commit(cwd, String(input.message ?? ''))
    return json(res, 201, { ...made, status: await git.status(cwd) })
  }),
)

on(
  'POST /api/git/push',
  inRepo(async ({ res, cwd }) => {
    const said = await git.push(cwd)
    return json(res, 200, { message: said, status: await git.status(cwd) })
  }),
)

// ---- Mac → phone: an agent (via MCP) or a hook reaching the person holding it ----

/** What to call a session in a banner, in the order the phone itself does. */
const labelOf = (sessionId: string): string => {
  const s = manager.list().find((entry) => entry.id === sessionId)
  if (!s) return 'A session'
  return s.name ?? s.firstCommand ?? path.basename(s.cwd) ?? s.providerName
}

/* The other half of the channel: a session that stopped without saying so.
 *
 * `idle.ts` works out that it happened; everything here is about who, if
 * anyone, should be interrupted for it. Three answers, in order of how much
 * they cost the user: someone already has it on screen (nothing at all — the
 * screen it was scraped from is the thing they are looking at), the agent has
 * already spoken for itself (`raiseIdle` declines, and its words stand), or a
 * phone is connected and gets a silent badge. Only when there is no phone at
 * all is this worth a notification, and that is the case it was built for. */
manager.onQuiet = (sessionId, message) => {
  if (notify.isViewing(sessionId)) return
  if (!attention.raiseIdle(sessionId, message)) return
  if (notify.attentionRaised(sessionId) > 0) return
  void push.send(
    `${labelOf(sessionId)} is waiting`,
    message ?? 'It stopped and has not said why.',
    sessionId,
    push.WAITING,
  )
}

on('POST /api/notify', async ({ res, body }) => {
  const b = await body<{
    message?: string
    source?: string
    sessionId?: string
    kind?: string
    quiet?: boolean
  }>()
  const message = (b.message ?? '').trim().slice(0, 300)
  if (!message) throw bad('message is required')

  const sessionId = resolveSession(b.sessionId, b.source)
  /* `quiet` is for things the user can already see, and what they can see is
     one session — not "Orbit is open somewhere". Judging it by whether any
     phone was connected is what made the other session's "Claude is waiting"
     vanish while you were reading this one. */
  const seen = sessionId ? notify.isViewing(sessionId) : notify.clientCount() > 0
  if (b.quiet && seen) {
    return json(res, 200, { delivered: 0, pushed: 0, dropped: true, sessionId })
  }
  // Held against the session until someone reads it — a toast is three seconds.
  if (sessionId && !seen) {
    attention.raise(sessionId, b.kind === 'waiting' ? 'waiting' : 'done', message)
  }
  const { delivered, id } = notify.notify({ message, source: b.source ?? null, sessionId })
  // Nothing was listening: wake the phone instead, and it will also see the
  // notice itself when it next connects.
  const pushed = delivered === 0 ? await push.send('Orbit', message, sessionId, push.NOTICE) : 0
  if (pushed > 0) notify.markPushed(id)
  return json(res, 200, { delivered, pushed, sessionId })
})

/* The one route the access token does not guard — see `notify.answerWith`,
   which is where the reasoning lives. Everything it can do is bounded by a
   capability that came out of this server minutes ago and dies with the
   question it names. */
on('POST /api/ask/answer', async ({ req, res, body }) => {
  const b = await body<{ id?: string; token?: string; choice?: string }>()
  const ok =
    typeof b.id === 'string' &&
    typeof b.token === 'string' &&
    typeof b.choice === 'string' &&
    notify.answerWith(b.id, b.token, b.choice)
  if (!ok) {
    /* Stale rather than wrong, most of the time: the question was answered in
       the app, or timed out, while its banner sat on the lock screen. The
       delay is paced the same way a bad token is regardless — the two are
       indistinguishable from here, and only one of them is a person. */
    await rejectSlowly(req)
    return json(res, 404, { error: 'that question is no longer open' })
  }
  forgetFailures(req)
  return json(res, 200, { ok: true })
})

on('GET /api/push/key', ({ res }) => json(res, 200, { publicKey: push.publicKey() }))

on('POST /api/push/subscribe', async ({ res, body }) => {
  const b = await body<push.Subscription>()
  try {
    push.subscribe(b)
  } catch (err) {
    throw bad((err as Error).message)
  }
  return json(res, 201, { devices: push.count() })
})

on('POST /api/push/unsubscribe', async ({ res, body }) => {
  const b = await body<{ endpoint?: string }>()
  if (b.endpoint) push.unsubscribe(b.endpoint)
  return json(res, 200, { devices: push.count() })
})

on('POST /api/ask', async ({ res, body }) => {
  const b = await body<{
    question?: string
    detail?: string
    options?: unknown
    source?: string
    sessionId?: string
    timeoutSeconds?: number
  }>()
  const question = (b.question ?? '').trim().slice(0, 300)
  if (!question) throw bad('question is required')
  const options = Array.isArray(b.options)
    ? b.options
        .filter((o): o is string => typeof o === 'string' && !!o.trim())
        .map((o) => o.trim().slice(0, 40))
    : undefined
  const timeoutSeconds = Math.min(Math.max(b.timeoutSeconds ?? 120, 5), 600)
  const sessionId = resolveSession(b.sessionId, b.source)
  /* Marked as waiting for the whole time it is open. A question that nobody
     answers times out over there and leaves nothing behind otherwise — and
     "an agent gave up waiting for me" is worth finding out late. */
  if (sessionId) attention.raise(sessionId, 'waiting', question)
  const result = await notify.ask({
    question,
    detail: b.detail?.slice(0, 2000) ?? null,
    options,
    source: b.source ?? null,
    sessionId,
    timeoutMs: timeoutSeconds * 1000,
    /* A question is worth waking someone for — and unlike a notice it is still
       waiting when they arrive, so the push is a nudge rather than the content.
       It carries the question's name and a one-shot capability to answer it, so
       the two obvious answers can be buttons on the banner itself: the phone
       that was woken for this is, by definition, in a pocket with the app shut,
       and "unlock, open Orbit, wait for the socket, tap Allow" is four steps to
       say a word the notification was already showing.

       Sent from inside `ask` rather than before it because a capability cannot
       name a question that does not exist yet, and not awaited because the
       thing being waited for is the answer. */
    announce: ({ id, answerToken, options: choices }) => {
      if (notify.clientCount() > 0) return
      void push.send(
        'Orbit is asking',
        question,
        sessionId,
        push.question(timeoutSeconds),
        { ask: { id, token: answerToken, options: choices } },
      )
    },
  })
  if (sessionId && !result.timedOut) attention.clear(sessionId)
  return json(res, 200, { ...result, phonesConnected: notify.clientCount(), sessionId })
})

on('GET /api/screenshots', async ({ res }) => json(res, 200, await screenshot.list()))

on('GET /api/screenshots/:name', async ({ res, params }) => {
  const filePath = screenshot.filePathFor(params.name)
  if (!filePath) throw notFound()
  const stat = await fsp.stat(filePath).catch(() => null)
  if (!stat?.isFile()) throw notFound()
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': stat.size })
  fs.createReadStream(filePath).pipe(res)
})

on('DELETE /api/screenshots/:name', async ({ res, params }) => {
  if (!screenshot.filePathFor(params.name)) throw notFound()
  await screenshot.remove(params.name)
  return json(res, 200, { ok: true })
})

on('GET /api/dirs', async ({ res, url }) => {
  const requested = url.searchParams.get('path') ?? path.join(HOME, 'Development')
  let dir = requested === '~' ? HOME : (safePath(requested) ?? HOME)
  const stat = await fsp.stat(dir).catch(() => null)
  if (!stat?.isDirectory()) dir = HOME

  const isGit = (p: string) =>
    fsp.access(path.join(p, '.git')).then(
      () => true,
      () => false,
    )

  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  const names = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
  const dirs = await Promise.all(
    names.map(async (name) => ({ name, git: await isGit(path.join(dir, name)) })),
  )
  return json(res, 200, {
    path: dir,
    parent: dir === HOME ? null : path.dirname(dir),
    isRepo: await isGit(dir),
    dirs,
  })
})

const server = http.createServer((req, res) => {
  handleApi(req, res).catch((err) => {
    console.error('[orbit] api error:', err)
    if (!res.headersSent) json(res, 500, { error: 'internal error' })
  })
})

/* `maxPayload` because a frame is a keystroke or a paste, and the default is
   100MB of memory anyone who can open a socket may ask for. `perMessageDeflate`
   because the first thing every reconnect carries is the scrollback replay —
   up to 200KB of text, on a phone, every time the screen comes back on.
   `threshold` keeps single keystrokes out of the compressor, where the frame
   header would cost more than the byte saved. */
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 1024 * 1024,
  perMessageDeflate: {
    threshold: 1024,
    zlibDeflateOptions: { level: 3 },
    concurrencyLimit: 4,
  },
})

wss.on('connection', async (ws: WebSocket, req) => {
  const url = new URL(req.url ?? '/ws', 'http://localhost')
  // A browser cannot set a header here, so the cookie carries it; other clients
  // (the MCP server, scripts) send the token the normal way.
  if (!bearer(req) && !hasSessionCookie(req, TOKEN)) {
    await rejectSlowly(req)
    ws.close(4001, 'unauthorized')
    return
  }
  forgetFailures(req)

  const requestedId = url.searchParams.get('session')
  const cols = Number(url.searchParams.get('cols')) || 80
  const rows = Number(url.searchParams.get('rows')) || 24

  const send = (msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  /* Notices and questions are about the phone, not about one session — every
     open socket carries them, including the one showing an ended session. */
  const client = notify.addClient(send)
  /* Assume the session it attached to is the one on screen, which is true the
     moment the app opens on the terminal. The phone corrects it as soon as it
     mounts, and whenever it leaves for another tab or the screen goes dark. */
  client.setViewing(requestedId)
  ws.on('close', client.drop)
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg?.type === 'answer' && typeof msg.id === 'string') {
        notify.answer(msg.id, typeof msg.choice === 'string' ? msg.choice : '')
      }
      if (msg?.type === 'viewing') {
        client.setViewing(typeof msg.sessionId === 'string' ? msg.sessionId : null)
      }
    } catch {
      // malformed frames are ignored here and by the session handler below
    }
  })

  // Ended session: replay its history read-only, no PTY behind it.
  if (requestedId && !manager.get(requestedId) && manager.isDead(requestedId)) {
    const history = await manager.deadScrollback(requestedId)
    /* One of these ran on the Mac and was never Orbit's to end. Saying it
       "ended" would claim something about a conversation the user may simply
       have walked away from. */
    const footer = manager.isExternal(requestedId)
      ? 'end of transcript — read-only'
      : 'session ended — read-only'
    send({
      type: 'ready',
      sessionId: requestedId,
      readOnly: true,
      // Just the fact — the client owns the affordance (New lives in the header).
      replay: history + `\r\n\x1b[90m[${footer}]\x1b[0m\r\n`,
    })
    return
  }

  /* A session id the server has never heard of is a stale one on the phone —
     from a cleared ~/.orbit, or a pruned entry. Silently opening a shell in the
     home directory instead looked like the session had simply moved. */
  const existing = requestedId ? manager.get(requestedId) : undefined
  if (requestedId && !existing) {
    send({ type: 'gone', sessionId: requestedId })
    ws.close()
    return
  }

  // No id at all (a bare /ws connection) still gets a shell to talk to.
  const session = existing ?? manager.create({ cols, rows })

  send({ type: 'ready', sessionId: session.id, readOnly: false, replay: session.scrollback() })

  const offData = session.onData((data) => send({ type: 'output', data }))
  const offExit = session.onExit((code) => {
    send({ type: 'exit', code })
    ws.close()
  })

  /* Replay only reproduces frames the agent drew for the size it had then, so a
     phone that reattaches at a different size — or onto a screen the agent was
     halfway through — sees a mangled composer. Ask for the whole screen again
     in those two cases, now that the stream above is carrying it; the redraw
     lands after the replay. A session created just now is already drawing at
     this size, and one sitting still at it has already sent its whole screen. */
  if (existing) session.repaintOnAttach(cols, rows)

  // Dangerous chunks (paste/voice/automation) are held until the user approves.
  const pendingApprovals = new Map<string, string>()
  let approvalSeq = 0

  ws.on('message', (raw) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    switch (msg.type) {
      case 'input': {
        const danger = screen(msg.data)
        if (danger) {
          const id = `a${++approvalSeq}`
          pendingApprovals.set(id, msg.data)
          send({ type: 'approval', id, label: danger.label, command: danger.line })
          break
        }
        session.write(msg.data)
        break
      }
      case 'approve': {
        const data = pendingApprovals.get(msg.id)
        if (data !== undefined) {
          pendingApprovals.delete(msg.id)
          session.write(data)
        }
        break
      }
      case 'deny':
        pendingApprovals.delete(msg.id)
        break
      case 'resize':
        /* Through `repaint`, so the agent's last word on the subject is a whole
           frame drawn for the size it now has. Resizing plainly leaves it free
           to patch the screen incrementally from a frame that no longer matches,
           which is what tears the composer. The phone only sends this once the
           layout has settled, so the extra draw costs nothing. */
        session.repaint(msg.cols, msg.rows)
        break
      case 'ping':
        send({ type: 'pong' })
        break
    }
  })

  // Detaching a client leaves the PTY running; the phone can reconnect later.
  ws.on('close', () => {
    offData()
    offExit()
  })
})

server.listen(PORT, async () => {
  /* The banner's first line is the phone's address, and only `tailscale` knows
     it. That answer costs a process and, on a machine whose network is still
     coming up, can take the CLI's full timeout to arrive — so it is raced, and
     a lookup that has not answered within a moment is simply not waited for.
     The banner then leads with the local URL instead, which is the honest
     answer when nothing can confirm the other one. Startup is not blocked
     either way: the server is already listening by the time this runs.

     Piped into a log file or handed to a service manager the whole block is
     noise, and `plainBanner` keeps the `[orbit] access token:` line the docs
     point at. */
  const tailnetUrl = await Promise.race([
    preview
      .state(PORT)
      .then((s) => (s.host ? `https://${s.host}` : null))
      .catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500).unref()),
  ])
  const facts = { port: PORT, token: TOKEN, tailnetUrl }
  console.log(process.stdout.isTTY ? banner(facts) : plainBanner(facts))

  const known = new Set(manager.list().map((s) => s.id))
  Promise.all([
    store.sweepOrphanScrollback(known),
    uploads.prune(),
    screenshot.pruneStale(),
  ])
    .then(([orphans]) => {
      if (orphans > 0) console.log(`[orbit] removed ${orphans} orphan scrollback file(s)`)
    })
    .catch((err) => console.error('[orbit] startup maintenance failed:', err))
})

const shutdown = () => {
  manager.killAll()
  // Warm Chrome and published preview serves (8443+) would otherwise outlive
  // the process. Front-door Tailscale (443) is left for `make stop` / phone-off.
  Promise.all([screenshot.shutdown(), preview.stopAll(PORT)]).finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
