import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { PtyManager } from './pty-manager.js'
import { PROVIDERS, getProvider, detectAvailability } from './providers.js'
import { getToken, hasSessionCookie, isSecureRequest, sessionCookie } from './auth.js'
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

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })

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
const bearer = (req: http.IncomingMessage): boolean =>
  req.headers.authorization === `Bearer ${TOKEN}`

const authorized = (req: http.IncomingMessage): boolean => {
  if (bearer(req)) return true
  return req.method === 'GET' && hasSessionCookie(req, TOKEN)
}

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
  const route = `${req.method} ${url.pathname}`

  if (route === 'GET /healthz') return json(res, 200, { ok: true })

  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' })
    return handleAuthedApi(req, res, url, route)
  }

  // Anything else is the web app itself (public shell; all data sits behind the API).
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url, res)
  json(res, 404, { error: 'not found' })
}

async function handleAuthedApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  route: string,
) {
  /* The token check is also where a browser picks up its session cookie, so
     every successful pairing — and every reload — renews it in one round trip. */
  if (route === 'GET /api/auth/check') {
    if (bearer(req)) res.setHeader('Set-Cookie', sessionCookie(TOKEN, isSecureRequest(req)))
    return json(res, 200, { ok: true })
  }

  if (route === 'GET /api/providers') {
    const available = await detectAvailability()
    return json(
      res,
      200,
      PROVIDERS.map((p) => ({ id: p.id, name: p.name, available: available[p.id] ?? false })),
    )
  }

  if (route === 'GET /api/sessions') {
    const list = manager.list()
    // A forgotten session cannot still be waiting for anything.
    attention.keepOnly(list.map((s) => s.id))
    return json(
      res,
      200,
      list.map((s) => ({ ...s, attention: attention.get(s.id) })),
    )
  }

  if (route === 'POST /api/sessions') {
    let body: { provider?: string; cwd?: string; name?: string }
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return json(res, 400, { error: 'invalid JSON' })
    }

    const provider = getProvider(body.provider ?? 'shell')
    if (!provider) return json(res, 400, { error: `unknown provider: ${body.provider}` })

    let cwd = HOME
    if (body.cwd) {
      const safe = safePath(body.cwd)
      if (!safe) return json(res, 400, { error: 'cwd must be inside the home directory' })
      const stat = await fsp.stat(safe).catch(() => null)
      if (!stat?.isDirectory()) return json(res, 400, { error: 'cwd is not a directory' })
      cwd = safe
    }

    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : ''
    const session = manager.create({ provider, cwd, name: name || undefined })
    const info = manager.list().find((s) => s.id === session.id)
    return json(res, 201, info)
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)$/)
  if (req.method === 'DELETE' && sessionMatch) {
    const id = sessionMatch[1]
    const session = manager.get(id)
    if (session) {
      session.kill() // moves to the ended list, history kept
      return json(res, 200, { ok: true })
    }
    if (manager.forget(id)) return json(res, 200, { ok: true }) // ended: remove + history
    return json(res, 404, { error: 'not found' })
  }

  if (req.method === 'PATCH' && sessionMatch) {
    const session = manager.get(sessionMatch[1])
    if (!session) return json(res, 404, { error: 'not found' })
    let body: { name?: string }
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return json(res, 400, { error: 'invalid JSON' })
    }
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : ''
    session.name = name || null
    manager.persistNow()
    return json(res, 200, { ok: true, name: session.name })
  }

  /* Reading is what marks it read. The phone says so when the session is
     actually on screen, which is the only moment that means anything. */
  const attentionMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/attention$/)
  if (req.method === 'DELETE' && attentionMatch) {
    return json(res, 200, { cleared: attention.clear(attentionMatch[1]) })
  }

  const restartMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/restart$/)
  if (req.method === 'POST' && restartMatch) {
    let body: { resume?: boolean } = {}
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return json(res, 400, { error: 'invalid JSON' })
    }
    const session = manager.restart(restartMatch[1], !!body.resume)
    if (!session) {
      return json(res, 404, {
        error: body.resume
          ? 'this agent cannot resume a conversation'
          : 'not found or not restartable',
      })
    }
    const info = manager.list().find((s) => s.id === session.id)
    return json(res, 201, info)
  }

  if (route === 'POST /api/upload') {
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
    if (size === 0) return json(res, 400, { error: 'empty upload' })
    const file = await uploads.save(rawName, Buffer.concat(chunks))
    return json(res, 201, { path: file })
  }

  if (route === 'POST /api/screenshot') {
    let body: {
      source?: string
      url?: string
      preset?: string
      width?: number
      height?: number
      fullPage?: boolean
      display?: number
      label?: string
    }
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return json(res, 400, { error: 'invalid JSON' })
    }

    if (body.source === 'screen') {
      try {
        return json(res, 201, await screenshot.captureScreen({ display: body.display }))
      } catch (err) {
        return json(res, 502, { error: (err as Error).message })
      }
    }

    if (!body.url || !/^https?:\/\//.test(body.url)) {
      return json(res, 400, { error: 'url must start with http(s)://' })
    }
    if (body.preset !== undefined && !screenshot.isPreset(body.preset)) {
      return json(res, 400, { error: `unknown preset: ${body.preset}` })
    }
    try {
      const shot = await screenshot.capture(body.url, { ...body, preset: body.preset })
      return json(res, 201, shot)
    } catch (err) {
      return json(res, 502, { error: `capture failed: ${(err as Error).message}` })
    }
  }

  if (route === 'GET /api/presets') return json(res, 200, screenshot.PRESETS)

  /* What is serving a page on this Mac right now, so the phone can offer it
     instead of asking someone to type a port on a touch keyboard. Costs one
     `lsof` and a short-lived socket per candidate, so it is asked on arrival
     and on waking — never polled. */
  if (route === 'GET /api/ports') return json(res, 200, await ports.devServers(PORT))

  // ---- Previews: a dev server, over https, on the tailnet ----

  if (route === 'GET /api/previews') return json(res, 200, await preview.state(PORT))

  /* The half worth polling. `ports` is a list because the phone already knows
     which ones it is showing, and asking about those costs a TCP connect each —
     no `tailscale` process, so a tab left open is not a process every few
     seconds. Capped so one request cannot ask for a port scan. */
  if (route === 'GET /api/previews/live') {
    const ports = (url.searchParams.get('ports') ?? '')
      .split(',')
      .map(Number)
      .filter(Boolean)
      .slice(0, 32)
    return json(res, 200, await preview.liveness(ports))
  }

  if (route === 'POST /api/previews') {
    let body: { port?: number }
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return json(res, 400, { error: 'invalid JSON' })
    }
    try {
      return json(res, 201, await preview.start(Number(body.port), PORT))
    } catch (err) {
      return json(res, 400, { error: (err as Error).message })
    }
  }

  const previewMatch = url.pathname.match(/^\/api\/previews\/(\d+)$/)
  if (req.method === 'DELETE' && previewMatch) {
    try {
      await preview.stop(Number(previewMatch[1]), PORT)
      return json(res, 200, { ok: true })
    } catch (err) {
      return json(res, 400, { error: (err as Error).message })
    }
  }

  /* ---- What the agent changed ----
   *
   * Everything here is addressed by folder rather than by session: the phone
   * takes the folder from whichever session it is showing, and two sessions in
   * one repository are looking at the same working tree anyway. Same home
   * restriction as the folder browser — this reads and writes real files.
   */
  if (url.pathname.startsWith('/api/git/')) {
    let cwd: string | null = null
    let body: Record<string, any> = {}
    if (req.method === 'GET') {
      cwd = safePath(url.searchParams.get('cwd') ?? '')
    } else {
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return json(res, 400, { error: 'invalid JSON' })
      }
      cwd = safePath(typeof body.cwd === 'string' ? body.cwd : '')
    }
    if (!cwd) return json(res, 400, { error: 'cwd must be inside the home directory' })
    const stat = await fsp.stat(cwd).catch(() => null)
    if (!stat?.isDirectory()) return json(res, 400, { error: 'cwd is not a directory' })

    try {
      if (route === 'GET /api/git/status') return json(res, 200, await git.status(cwd))

      if (route === 'GET /api/git/diff') {
        const file = url.searchParams.get('file') ?? ''
        if (!file) return json(res, 400, { error: 'file is required' })
        return json(res, 200, await git.diff(cwd, file, url.searchParams.get('staged') === '1'))
      }

      if (route === 'POST /api/git/stage') {
        const files = Array.isArray(body.files) ? body.files.filter((f: unknown) => typeof f === 'string') : []
        await git.stage(cwd, files, body.add !== false)
        return json(res, 200, await git.status(cwd))
      }

      if (route === 'POST /api/git/commit') {
        const made = await git.commit(cwd, String(body.message ?? ''))
        return json(res, 201, { ...made, status: await git.status(cwd) })
      }

      if (route === 'POST /api/git/push') {
        const said = await git.push(cwd)
        return json(res, 200, { message: said, status: await git.status(cwd) })
      }
    } catch (err) {
      // git's own words: "nothing is staged", "failed to push some refs", …
      return json(res, 400, { error: (err as Error).message })
    }
    return json(res, 404, { error: 'not found' })
  }

  // ---- Mac → phone: an agent (via MCP) or a hook reaching the person holding it ----

  if (route === 'POST /api/notify') {
    let body: {
      message?: string
      source?: string
      sessionId?: string
      kind?: string
      quiet?: boolean
    }
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return json(res, 400, { error: 'invalid JSON' })
    }
    const message = (body.message ?? '').trim().slice(0, 300)
    if (!message) return json(res, 400, { error: 'message is required' })

    const sessionId = resolveSession(body.sessionId, body.source)
    /* `quiet` is for things the user can already see, and what they can see is
       one session — not "Orbit is open somewhere". Judging it by whether any
       phone was connected is what made the other session's "Claude is waiting"
       vanish while you were reading this one. */
    const seen = sessionId ? notify.isViewing(sessionId) : notify.clientCount() > 0
    if (body.quiet && seen) {
      return json(res, 200, { delivered: 0, pushed: 0, dropped: true, sessionId })
    }
    // Held against the session until someone reads it — a toast is three seconds.
    if (sessionId && !seen) {
      attention.raise(sessionId, body.kind === 'waiting' ? 'waiting' : 'done', message)
    }
    const { delivered, id } = notify.notify({ message, source: body.source ?? null, sessionId })
    // Nothing was listening: wake the phone instead, and it will also see the
    // notice itself when it next connects.
    const pushed = delivered === 0 ? await push.send('Orbit', message, sessionId) : 0
    if (pushed > 0) notify.markPushed(id)
    return json(res, 200, { delivered, pushed, sessionId })
  }

  if (route === 'GET /api/push/key') return json(res, 200, { publicKey: push.publicKey() })

  if (route === 'POST /api/push/subscribe') {
    let body: push.Subscription
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return json(res, 400, { error: 'invalid JSON' })
    }
    try {
      push.subscribe(body)
    } catch (err) {
      return json(res, 400, { error: (err as Error).message })
    }
    return json(res, 201, { devices: push.count() })
  }

  if (route === 'POST /api/push/unsubscribe') {
    let body: { endpoint?: string }
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return json(res, 400, { error: 'invalid JSON' })
    }
    if (body.endpoint) push.unsubscribe(body.endpoint)
    return json(res, 200, { devices: push.count() })
  }

  if (route === 'POST /api/ask') {
    let body: {
      question?: string
      detail?: string
      options?: unknown
      source?: string
      sessionId?: string
      timeoutSeconds?: number
    }
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return json(res, 400, { error: 'invalid JSON' })
    }
    const question = (body.question ?? '').trim().slice(0, 300)
    if (!question) return json(res, 400, { error: 'question is required' })
    const options = Array.isArray(body.options)
      ? body.options.filter((o): o is string => typeof o === 'string' && !!o.trim()).map((o) => o.trim().slice(0, 40))
      : undefined
    const timeoutSeconds = Math.min(Math.max(body.timeoutSeconds ?? 120, 5), 600)
    const sessionId = resolveSession(body.sessionId, body.source)
    /* A question is worth waking someone for — and unlike a notice it is still
       waiting when they arrive, so the push is a nudge rather than the content. */
    if (notify.clientCount() === 0) await push.send('Orbit is asking', question, sessionId)
    /* Marked as waiting for the whole time it is open. A question that nobody
       answers times out over there and leaves nothing behind otherwise — and
       "an agent gave up waiting for me" is worth finding out late. */
    if (sessionId) attention.raise(sessionId, 'waiting', question)
    const result = await notify.ask({
      question,
      detail: body.detail?.slice(0, 2000) ?? null,
      options,
      source: body.source ?? null,
      sessionId,
      timeoutMs: timeoutSeconds * 1000,
    })
    if (sessionId && !result.timedOut) attention.clear(sessionId)
    return json(res, 200, { ...result, phonesConnected: notify.clientCount(), sessionId })
  }

  if (route === 'GET /api/screenshots') return json(res, 200, await screenshot.list())

  const shotMatch = url.pathname.match(/^\/api\/screenshots\/([\w.:-]+)$/)
  if (shotMatch) {
    const filePath = screenshot.filePathFor(shotMatch[1])
    if (!filePath) return json(res, 404, { error: 'not found' })
    if (req.method === 'DELETE') {
      await screenshot.remove(shotMatch[1])
      return json(res, 200, { ok: true })
    }
    const stat = await fsp.stat(filePath).catch(() => null)
    if (!stat?.isFile()) return json(res, 404, { error: 'not found' })
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': stat.size })
    fs.createReadStream(filePath).pipe(res)
    return
  }

  if (route === 'GET /api/dirs') {
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
  }

  json(res, 404, { error: 'not found' })
}

const server = http.createServer((req, res) => {
  handleApi(req, res).catch((err) => {
    console.error('[orbit] api error:', err)
    if (!res.headersSent) json(res, 500, { error: 'internal error' })
  })
})

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', async (ws: WebSocket, req) => {
  const url = new URL(req.url ?? '/ws', 'http://localhost')
  // A browser cannot set a header here, so the cookie carries it; other clients
  // (the MCP server, scripts) send the token the normal way.
  if (!bearer(req) && !hasSessionCookie(req, TOKEN)) {
    ws.close(4001, 'unauthorized')
    return
  }

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
    send({
      type: 'ready',
      sessionId: requestedId,
      readOnly: true,
      // Just the fact — the client owns the affordance (New lives in the header).
      replay: history + '\r\n\x1b[90m[session ended — read-only]\x1b[0m\r\n',
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
     phone that reattaches at a different size — or after the frame on screen
     went stale — sees a mangled composer. Ask for the whole screen again now
     that the stream above is carrying it; the redraw lands after the replay.
     A session created just now is already drawing at this size. */
  if (existing) session.repaint(cols, rows)

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

server.listen(PORT, () => {
  console.log(`[orbit] server listening on http://localhost:${PORT} (ws: /ws)`)
  console.log(`[orbit] access token: ${TOKEN}`)

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
  // The warm Chrome would otherwise outlive the server that launched it.
  screenshot.shutdown().finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
