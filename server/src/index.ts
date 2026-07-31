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
import * as uploads from './uploads.js'
import * as store from './store.js'
import * as notify from './notify.js'

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
    file = path.join(WEB_DIST, 'index.html') // SPA fallback
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

  if (route === 'GET /api/sessions') return json(res, 200, manager.list())

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

  // ---- Mac → phone: an agent (via MCP) or a hook reaching the person holding it ----

  if (route === 'POST /api/notify') {
    let body: { message?: string; source?: string }
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return json(res, 400, { error: 'invalid JSON' })
    }
    const message = (body.message ?? '').trim().slice(0, 300)
    if (!message) return json(res, 400, { error: 'message is required' })
    const delivered = notify.notify(message, body.source ?? null)
    return json(res, 200, { delivered })
  }

  if (route === 'POST /api/ask') {
    let body: {
      question?: string
      detail?: string
      options?: unknown
      source?: string
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
    const result = await notify.ask({
      question,
      detail: body.detail?.slice(0, 2000) ?? null,
      options,
      source: body.source ?? null,
      timeoutMs: timeoutSeconds * 1000,
    })
    return json(res, 200, { ...result, phonesConnected: notify.clientCount() })
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
  const dropClient = notify.addClient(send)
  ws.on('close', dropClient)
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg?.type === 'answer' && typeof msg.id === 'string') {
        notify.answer(msg.id, typeof msg.choice === 'string' ? msg.choice : '')
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
        session.resize(msg.cols, msg.rows)
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
