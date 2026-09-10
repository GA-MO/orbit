import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { PORT } from './port.js'
import { BIND_HOST, LAN_OPEN } from './network.js'
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
import * as pairing from './pairing.js'

const HOME = os.homedir()

const BUN_VIRTUAL_FS_URL = 'file:///$bunfs/'
const EMBEDDED_WEB_DIST = '/$bunfs/root/dist'
const RUNNING_FROM_COMPILED_BINARY = import.meta.url.startsWith(BUN_VIRTUAL_FS_URL)
const WEB_DIST = RUNNING_FROM_COMPILED_BINARY
  ? EMBEDDED_WEB_DIST
  : fileURLToPath(new URL('../../web/dist', import.meta.url))

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

const MAX_TERMINAL_DIMENSION = 1000

const isString = (v: unknown): v is string => typeof v === 'string'
const isTerminalDimension = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_TERMINAL_DIMENSION

const parseClientMessage = (raw: unknown): ClientMessage | null => {
  let msg: any
  try {
    msg = JSON.parse(String(raw))
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null
  switch (msg.type) {
    case 'input':
      return isString(msg.data) ? { type: 'input', data: msg.data } : null
    case 'resize':
      return isTerminalDimension(msg.cols) && isTerminalDimension(msg.rows)
        ? { type: 'resize', cols: msg.cols, rows: msg.rows }
        : null
    case 'ping':
      return { type: 'ping' }
    case 'approve':
    case 'deny':
      return isString(msg.id) ? { type: msg.type, id: msg.id } : null
    case 'answer':
      return isString(msg.id)
        ? { type: 'answer', id: msg.id, choice: isString(msg.choice) ? msg.choice : '' }
        : null
    case 'viewing':
      return { type: 'viewing', sessionId: isString(msg.sessionId) ? msg.sessionId : null }
    default:
      return null
  }
}

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

const BODY_LIMIT = 1024 * 1024

const stopReadingSoTheAnswerCanStillBeWritten = (req: http.IncomingMessage) => req.pause()

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > BODY_LIMIT) {
        stopReadingSoTheAnswerCanStillBeWritten(req)
        reject(new HttpError(413, `body exceeds ${BODY_LIMIT / 1024}KB limit`))
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

const isKnownSession = (sessionId: string) => !!manager.get(sessionId) || manager.isDead(sessionId)

const onlyLiveSessionIn = (folder: string): string | null => {
  const cwd = path.resolve(folder)
  const liveHere = manager.list().filter((s) => s.alive && s.cwd === cwd)
  return liveHere.length === 1 ? liveHere[0].id : null
}

const resolveSession = (claimedSessionId?: string | null, senderFolder?: string | null): string | null => {
  if (claimedSessionId && isKnownSession(claimedSessionId)) return claimedSessionId
  if (!senderFolder) return null
  return onlyLiveSessionIn(senderFolder)
}

const safePath = (p: string): string | null => {
  const resolved = path.resolve(p)
  const insideHome = resolved === HOME || resolved.startsWith(HOME + path.sep)
  return insideHome ? resolved : null
}

const hasBearerToken = (req: http.IncomingMessage): boolean =>
  matches(req.headers.authorization ?? '', `Bearer ${TOKEN}`)

const TAILSCALE_LOGIN_HEADER = 'tailscale-user-login'

const tailscaleLoginHeader = (req: http.IncomingMessage): string => {
  const given = req.headers[TAILSCALE_LOGIN_HEADER]
  return (Array.isArray(given) ? given[0] : (given ?? '')).trim()
}

const recognisedByTailscale = async (req: http.IncomingMessage): Promise<boolean> => {
  const headerCanBeForged = LAN_OPEN
  if (headerCanBeForged) return false
  const given = tailscaleLoginHeader(req)
  if (!given) return false
  if (!originIsThisHost(req)) return false
  const owner = await preview.tailnetOwnerLogin()
  return !!owner && matches(given, owner)
}

const authorized = async (req: http.IncomingMessage): Promise<boolean> => {
  if (hasBearerToken(req)) return true
  if (await recognisedByTailscale(req)) return true
  const cookieMayAuthorize = req.method === 'GET'
  return cookieMayAuthorize && hasSessionCookie(req, TOKEN)
}

const hostsThisRequestWasAddressedTo = (req: http.IncomingMessage): string[] => {
  const forwarded = req.headers['x-forwarded-host']
  const candidates = [req.headers.host, Array.isArray(forwarded) ? forwarded[0] : forwarded]
  return candidates.filter((h): h is string => !!h).map((h) => h.split(',')[0].trim())
}

const originIsThisHost = (req: http.IncomingMessage): boolean => {
  const origin = req.headers.origin
  const sentByABrowserPage = !!origin
  if (!sentByABrowserPage) return true
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }
  return hostsThisRequestWasAddressedTo(req).includes(originHost)
}

const FREE_ATTEMPTS = 10
const FAILURE_FORGOTTEN_MS = 60_000
const DELAY_PER_EXTRA_ATTEMPT_MS = 250
const MAX_DELAY_MS = 2000
const PRUNE_FAILURES_ABOVE = 64
const WARN_EVERY_N_ATTEMPTS = 10

const failures = new Map<string, { count: number; last: number }>()

const guesserKey = (req: http.IncomingMessage) => req.socket.remoteAddress ?? 'unknown'

const countFailure = (key: string, now: number): number => {
  const seen = failures.get(key)
  const count = seen && now - seen.last < FAILURE_FORGOTTEN_MS ? seen.count + 1 : 1
  failures.set(key, { count, last: now })
  return count
}

const forgetOldFailures = (now: number) => {
  if (failures.size <= PRUNE_FAILURES_ABOVE) return
  for (const [k, v] of failures) if (now - v.last > FAILURE_FORGOTTEN_MS) failures.delete(k)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const slowDownCredentialGuessing = (req: http.IncomingMessage): Promise<void> => {
  const key = guesserKey(req)
  const now = Date.now()
  const count = countFailure(key, now)
  forgetOldFailures(now)
  const attemptsPastFree = count - FREE_ATTEMPTS
  const worthALogLine = attemptsPastFree > 0 && attemptsPastFree % WARN_EVERY_N_ATTEMPTS === 1
  if (worthALogLine) console.warn(`[orbit] ${count} bad credentials from ${key}`)
  if (attemptsPastFree <= 0) return Promise.resolve()
  return sleep(Math.min(attemptsPastFree * DELAY_PER_EXTRA_ATTEMPT_MS, MAX_DELAY_MS))
}

const forgetFailures = (req: http.IncomingMessage) => failures.delete(guesserKey(req))

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

const LEADING_PARENT_SEGMENTS = /^(\.\.[/\\])+/

const isAppShellPath = (requestPath: string) => requestPath === '/' || requestPath === '/index.html'

const statFile = (file: string) => fsp.stat(file).catch(() => null)

async function serveStatic(url: URL, res: http.ServerResponse) {
  const requestPath = path.normalize(decodeURIComponent(url.pathname)).replace(LEADING_PARENT_SEGMENTS, '')
  let file = path.join(WEB_DIST, requestPath)
  if (!file.startsWith(WEB_DIST)) return json(res, 404, { error: 'not found' })

  let stat = await statFile(file)
  if (!stat?.isFile()) {
    if (!isAppShellPath(requestPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`Orbit: no such path — ${requestPath}`)
      return
    }
    file = path.join(WEB_DIST, 'index.html')
    stat = await statFile(file)
  }
  if (!stat?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Orbit: web build not found. Run `bun run build`, or use the Vite dev server.')
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': stat.size,
  })
  await sendFileBody(file, res)
}

const virtualFsCannotStream = RUNNING_FROM_COMPILED_BINARY

async function sendFileBody(file: string, res: http.ServerResponse) {
  if (virtualFsCannotStream) {
    res.end(await fsp.readFile(file))
    return
  }
  fs.createReadStream(file).pipe(res)
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true })

  if (url.pathname.startsWith('/api/')) {
    if (!carriesItsOwnCredential(req, url)) {
      if (!(await authorized(req))) {
        await slowDownCredentialGuessing(req)
        return json(res, 401, { error: 'unauthorized' })
      }
      forgetFailures(req)
    }
    return handleAuthedApi(req, res, url)
  }

  const wantsTheWebApp = req.method === 'GET' || req.method === 'HEAD'
  if (wantsTheWebApp) return serveStatic(url, res)
  json(res, 404, { error: 'not found' })
}

const ROUTES_WITH_THEIR_OWN_CREDENTIAL = ['/api/ask/answer', '/api/auth/pair']

const carriesItsOwnCredential = (req: http.IncomingMessage, url: URL) =>
  req.method === 'POST' && ROUTES_WITH_THEIR_OWN_CREDENTIAL.includes(url.pathname)

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

  body<T = Record<string, any>>(): Promise<T>
}

type Handler = (c: Ctx) => Promise<unknown> | unknown

const routes: { method: string; segments: string[]; handler: Handler }[] = []

const on = (spec: string, handler: Handler) => {
  const [method, pathname] = spec.split(' ')
  routes.push({ method, segments: pathname.split('/'), handler })
}

const isParam = (segment: string) => segment.startsWith(':')

const bindParams = (pattern: string[], parts: string[]): Record<string, string> | null => {
  const params: Record<string, string> = {}
  for (let i = 0; i < parts.length; i++) {
    const segment = pattern[i]
    if (!isParam(segment)) {
      if (segment !== parts[i]) return null
      continue
    }
    if (!parts[i]) return null
    params[segment.slice(1)] = decodeURIComponent(parts[i])
  }
  return params
}

const matchRoute = (method: string, pathname: string) => {
  const parts = pathname.split('/')
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== parts.length) continue
    const params = bindParams(route.segments, parts)
    if (params) return { handler: route.handler, params }
  }
  return null
}

const closeSocketOnceAnswered = (req: http.IncomingMessage, res: http.ServerResponse) => {
  res.setHeader('Connection', 'close')
  res.on('finish', () => req.destroy())
}

async function handleAuthedApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const hit = matchRoute(req.method ?? 'GET', url.pathname)
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
    if (err instanceof HttpError) {
      const bodyLeftUnreadOnTheWire = err.status === 413
      if (bodyLeftUnreadOnTheWire) closeSocketOnceAnswered(req, res)
      return json(res, err.status, { error: err.message })
    }
    throw err
  }
}

const renewSessionCookie = (req: http.IncomingMessage, res: http.ServerResponse) =>
  res.setHeader('Set-Cookie', sessionCookie(TOKEN, isSecureRequest(req)))

on('GET /api/auth/check', async ({ req, res }) => {
  if (hasBearerToken(req) || (await recognisedByTailscale(req))) renewSessionCookie(req, res)
  return json(res, 200, { ok: true })
})

on('POST /api/auth/pair', async ({ req, res, body }) => {
  const b = await body<{ code?: unknown }>()
  const code = typeof b.code === 'string' ? b.code : ''
  if (!code || !pairing.redeem(code)) {
    await slowDownCredentialGuessing(req)
    return json(res, 401, { error: 'that pairing code is not good any more' })
  }
  forgetFailures(req)
  renewSessionCookie(req, res)
  return json(res, 200, { token: TOKEN })
})

on('POST /api/auth/pair-code', async ({ res }) => {
  const { code, expiresAt } = pairing.mint()
  const base = await pairBase()
  return json(res, 200, { code, expiresAt, url: pairing.pairUrl(base, code) })
})

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

const discoverSessionsStartedFromTheMac = () =>
  manager.discover().catch((err) => console.error('[orbit] transcript scan failed:', err))

on('GET /api/sessions', async ({ res }) => {
  await discoverSessionsStartedFromTheMac()
  const list = manager.list()
  attention.keepOnly(list.map((s) => s.id))
  return json(
    res,
    200,
    list.map((s) => ({ ...s, attention: attention.get(s.id) })),
  )
})

const MAX_SESSION_NAME_LENGTH = 60

const sessionNameFrom = (raw: unknown): string =>
  typeof raw === 'string' ? raw.trim().slice(0, MAX_SESSION_NAME_LENGTH) : ''

const directoryInsideHome = async (requested: string): Promise<string> => {
  const safe = safePath(requested)
  if (!safe) throw bad('cwd must be inside the home directory')
  const stat = await statFile(safe)
  if (!stat?.isDirectory()) throw bad('cwd is not a directory')
  return safe
}

const infoFor = (sessionId: string) => manager.list().find((s) => s.id === sessionId)

on('POST /api/sessions', async ({ res, body }) => {
  const b = await body<{ provider?: string; cwd?: string; name?: string }>()

  const provider = getProvider(b.provider ?? 'shell')
  if (!provider) throw bad(`unknown provider: ${b.provider}`)

  const cwd = b.cwd ? await directoryInsideHome(b.cwd) : HOME
  const name = sessionNameFrom(b.name)
  const session = manager.create({ provider, cwd, name: name || undefined })
  return json(res, 201, infoFor(session.id))
})

on('DELETE /api/sessions/:id', ({ res, params }) => {
  const session = manager.get(params.id)
  if (session) {
    session.kill()
    return json(res, 200, { ok: true })
  }
  const transcriptBelongsToTheMac = manager.isExternal(params.id)
  if (transcriptBelongsToTheMac) {
    throw bad('this conversation belongs to the Mac — Orbit only reads it')
  }
  const endedAndForgotten = manager.forget(params.id)
  if (endedAndForgotten) return json(res, 200, { ok: true })
  throw notFound()
})

on('GET /api/sessions/hidden', ({ res }) => json(res, 200, { hidden: manager.hiddenCount() }))

on('POST /api/sessions/unhide', ({ res }) => json(res, 200, { unhidden: manager.unhideAll() }))

on('POST /api/sessions/:id/hide', ({ res, params }) => {
  const hideableRowFromTheMac = manager.hide(params.id)
  if (hideableRowFromTheMac) return json(res, 200, { ok: true })
  throw notFound()
})

on('PATCH /api/sessions/:id', async ({ res, params, body }) => {
  const session = manager.get(params.id)
  if (!session) throw notFound()
  const b = await body<{ name?: string }>()
  const name = sessionNameFrom(b.name)
  session.name = name || null
  manager.persistNow()
  return json(res, 200, { ok: true, name: session.name })
})

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
  return json(res, 201, infoFor(session.id))
})

const readUploadBody = (req: http.IncomingMessage) =>
  new Promise<Buffer[]>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > uploads.LIMIT) {
        stopReadingSoTheAnswerCanStillBeWritten(req)
        reject(new HttpError(413, `upload exceeds ${uploads.LIMIT / 1024 / 1024}MB limit`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(chunks))
    req.on('error', reject)
  })

on('POST /api/upload', async ({ req, res, url }) => {
  const rawName = url.searchParams.get('name') ?? 'image.png'
  let chunks: Buffer[]
  try {
    chunks = await readUploadBody(req)
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw bad('upload failed')
  }
  const content = Buffer.concat(chunks)
  if (content.length === 0) throw bad('empty upload')
  const file = await uploads.save(rawName, content)
  return json(res, 201, { path: file })
})

const HTTP_URL = /^https?:\/\//

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

  if (!b.url || !HTTP_URL.test(b.url)) throw bad('url must start with http(s)://')
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

on('POST /api/resources/chrome/close', async ({ res }) => {
  await screenshot.shutdown()
  return json(res, 200, { ok: true })
})

on('GET /api/ports', async ({ res }) => json(res, 200, await ports.devServers(PORT)))

on('GET /api/previews', async ({ res }) => json(res, 200, await preview.state(PORT)))

const MAX_PORTS_PER_LIVENESS_CHECK = 32

on('GET /api/previews/live', async ({ res, url }) => {
  const wanted = (url.searchParams.get('ports') ?? '')
    .split(',')
    .map(Number)
    .filter(Boolean)
    .slice(0, MAX_PORTS_PER_LIVENESS_CHECK)
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

const MAX_PORT = 65_535

const isPortNumber = (port: number) => Number.isInteger(port) && port >= 1 && port <= MAX_PORT

const rethrowAsBadRequest = <T>(work: () => T): T => {
  try {
    return work()
  } catch (err) {
    throw bad((err as Error).message)
  }
}

const publishOrBadRequest = async (port: number): Promise<preview.Preview> => {
  try {
    return await preview.start(port, PORT)
  } catch (err) {
    throw bad((err as Error).message)
  }
}

const leaveANoticeAboutTheMissedPreview = async (
  url: string,
  port: number,
  source: string | null,
  sessionId: string | null,
): Promise<number> => {
  const { pathname, search } = new URL(url)
  const message = `Wanted to show you port ${port} at ${pathname}${search} — open it from the Preview tab.`
  const notice = notify.notify({ message, source, sessionId })
  const pushed = await push.send('Orbit', message, sessionId, push.NOTICE)
  if (pushed > 0) notify.markPushed(notice.id)
  return pushed
}

on('POST /api/preview', async ({ res, body }) => {
  const b = await body<{ port?: number; path?: string; source?: string; sessionId?: string }>()
  const port = Number(b.port)
  if (!isPortNumber(port)) throw bad('port must be 1–65535')

  const somethingToShow = await ports.speaksHttp(port)
  if (!somethingToShow) {
    throw bad(
      `nothing is answering HTTP on ${port} — start the dev server first, or, if that ` +
        'port is a database or some other service, it is not something the phone can open',
    )
  }

  const published = await publishOrBadRequest(port)
  const url = rethrowAsBadRequest(() => preview.previewUrl(published.url, b.path))
  const source = b.source ?? null
  const sessionId = resolveSession(b.sessionId, b.source)
  const { delivered } = notify.openPreview({ url, port: published.port, source, sessionId })

  const nobodyWasThere = delivered === 0
  const pushed = nobodyWasThere
    ? await leaveANoticeAboutTheMissedPreview(url, published.port, source, sessionId)
    : 0
  return json(res, 200, { url, port: published.port, delivered, pushed, sessionId })
})

type RepoCtx = Ctx & { cwd: string; input: Record<string, any> }

const requestedRepoFolder = (c: Ctx, input: Record<string, any>): string => {
  if (c.req.method === 'GET') return c.url.searchParams.get('cwd') ?? ''
  return typeof input.cwd === 'string' ? input.cwd : ''
}

const inRepo =
  (handler: (c: RepoCtx) => Promise<unknown> | unknown): Handler =>
  async (c) => {
    const input = c.req.method === 'GET' ? {} : await c.body()
    const cwd = await directoryInsideHome(requestedRepoFolder(c, input))
    try {
      return await handler({ ...c, cwd, input })
    } catch (err) {
      if (err instanceof HttpError) throw err
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

const labelOf = (sessionId: string): string => {
  const s = manager.list().find((entry) => entry.id === sessionId)
  if (!s) return 'A session'
  return s.name ?? s.firstCommand ?? path.basename(s.cwd) ?? s.providerName
}

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

  const seen = sessionId ? notify.isViewing(sessionId) : notify.clientCount() > 0
  if (b.quiet && seen) {
    return json(res, 200, { delivered: 0, pushed: 0, dropped: true, sessionId })
  }

  if (sessionId && !seen) {
    attention.raise(sessionId, b.kind === 'waiting' ? 'waiting' : 'done', message)
  }
  const { delivered, id } = notify.notify({ message, source: b.source ?? null, sessionId })

  const pushed = delivered === 0 ? await push.send('Orbit', message, sessionId, push.NOTICE) : 0
  if (pushed > 0) notify.markPushed(id)
  return json(res, 200, { delivered, pushed, sessionId })
})

on('POST /api/ask/answer', async ({ req, res, body }) => {
  const b = await body<{ id?: string; token?: string; choice?: string }>()
  const ok =
    typeof b.id === 'string' &&
    typeof b.token === 'string' &&
    typeof b.choice === 'string' &&
    notify.answerWith(b.id, b.token, b.choice)
  if (!ok) {

    await slowDownCredentialGuessing(req)
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

  const unheard = notify.clientCount() === 0 && push.count() === 0
  const timeoutMs = unheard ? Math.min(timeoutSeconds, 5) * 1000 : timeoutSeconds * 1000

  if (sessionId) attention.raise(sessionId, 'waiting', question)
  const result = await notify.ask({
    question,
    detail: b.detail?.slice(0, 2000) ?? null,
    options,
    source: b.source ?? null,
    sessionId,
    timeoutMs,

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

  const mayOpenTheSocket =
    hasBearerToken(req) ||
    (await recognisedByTailscale(req)) ||
    (hasSessionCookie(req, TOKEN) && originIsThisHost(req))
  if (!mayOpenTheSocket) {
    await slowDownCredentialGuessing(req)
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

  const client = notify.addClient(send)

  client.setViewing(requestedId)
  ws.on('close', client.drop)
  ws.on('message', (raw) => {
    const msg = parseClientMessage(raw)
    if (msg?.type === 'answer') notify.answer(msg.id, msg.choice)
    if (msg?.type === 'viewing') client.setViewing(msg.sessionId)
  })

  if (requestedId && !manager.get(requestedId) && manager.isDead(requestedId)) {
    const history = await manager.deadScrollback(requestedId)

    const footer = manager.isExternal(requestedId)
      ? 'end of transcript — read-only'
      : 'session ended — read-only'
    send({
      type: 'ready',
      sessionId: requestedId,
      readOnly: true,

      replay: history + `\r\n\x1b[90m[${footer}]\x1b[0m\r\n`,
    })
    return
  }

  const existing = requestedId ? manager.get(requestedId) : undefined
  if (requestedId && !existing) {
    send({ type: 'gone', sessionId: requestedId })
    ws.close()
    return
  }

  let session: ReturnType<PtyManager['create']>
  try {
    session = existing ?? manager.create({ cols, rows })
  } catch (err) {

    console.error('[orbit] could not start a shell:', err)
    ws.close(1011, 'could not start a shell')
    return
  }

  send({ type: 'ready', sessionId: session.id, readOnly: false, replay: session.scrollback() })

  const MAX_BUFFERED = 4 * 1024 * 1024
  const offData = session.onData((data) => {
    if (ws.bufferedAmount > MAX_BUFFERED) return
    send({ type: 'output', data })
  })
  const offExit = session.onExit((code) => {
    send({ type: 'exit', code })
    ws.close()
  })

  if (existing) session.resize(cols, rows)

  const pendingApprovals = new Map<string, string>()
  let approvalSeq = 0

  ws.on('message', (raw) => {
    const msg = parseClientMessage(raw)
    if (!msg) return
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

  ws.on('close', () => {
    offData()
    offExit()
  })
})

server.listen(PORT, BIND_HOST, async () => {

  const tailnetUrl = await Promise.race([
    preview
      .state(PORT)
      .then((s) => (s.host ? `https://${s.host}` : null))
      .catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500).unref()),
  ])

  const pairUrl = process.stdout.isTTY ? pairing.pairUrl(await pairBase(tailnetUrl), pairing.mint().code) : null
  const facts = { port: PORT, token: TOKEN, tailnetUrl, pairUrl }
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

async function pairBase(tailnetUrl?: string | null): Promise<string> {
  const published =
    tailnetUrl === undefined
      ? await preview
          .state(PORT)
          .then((s) => (s.host ? `https://${s.host}` : null))
          .catch(() => null)
      : tailnetUrl
  if (published) return published
  const lan = LAN_OPEN ? pairing.lanAddress() : null
  return lan ? `http://${lan}:${PORT}` : `http://localhost:${PORT}`
}

const shutdown = () => {
  manager.killAll()

  Promise.all([screenshot.shutdown(), preview.stopAll(PORT)]).finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

process.on('unhandledRejection', (err) => {
  console.error('[orbit] unhandled rejection:', err)
})
process.on('uncaughtException', (err) => {
  console.error('[orbit] uncaught exception:', err)
})
