#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(REPO, 'package.json'))
const WebSocket = require('ws')

const LIVE_ORBIT_PORTS = [7788, 3001]
const PORT = Number(process.env.ORBIT_PORT ?? 3099)
const BASE = `http://127.0.0.1:${PORT}`
const WS_URL = `ws://127.0.0.1:${PORT}/ws`
const HOME = os.homedir()

if (LIVE_ORBIT_PORTS.includes(PORT) && !process.env.SMOKE_FORCE) {
  console.error(`Refusing to run against port ${PORT} — a real server answers there, and this kills`)
  console.error('sessions. Start a throwaway one (see the header) or set SMOKE_FORCE=1.')
  process.exit(1)
}

const TOKEN = JSON.parse(fs.readFileSync(path.join(HOME, '.orbit', 'config.json'), 'utf8')).token
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const BEARER = { headers: { Authorization: `Bearer ${TOKEN}` } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const LOOPBACK = '127.0.0.1'
const PORT_NOBODY_LISTENS_ON = 4321
const WEB_STUB_PORT = 3097
const TCP_ONLY_STUB_PORT = 3096
const PREVIEW_STUB_PORT = 3098
const HANGUP_STUB_PORT = 3095

const listen = (server, port) => new Promise((r) => server.listen(port, LOOPBACK, r))
const closeServer = (server) => new Promise((r) => server.close(r))

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)

const api = async (route, body, method = 'POST') => {
  const res = await fetch(BASE + route, { method, headers: H, body: body && JSON.stringify(body) })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) }
  } catch {
    return { status: res.status, body: text.slice(0, 200) }
  }
}

const listSessions = async () => (await api('/api/sessions', null, 'GET')).body
const endSession = (id) => api(`/api/sessions/${id}`, null, 'DELETE')
const endThenForget = async (id, settleMs) => {
  await endSession(id)
  await wait(settleMs)
  await endSession(id)
}
const listPreviews = async () => (await api('/api/previews', undefined, 'GET')).body
const livePorts = async (ports) => (await api(`/api/previews/live?ports=${ports}`, undefined, 'GET')).body

const phone = (chooseAnswer, viewingSessionId) => {
  const seen = []
  const ws = new WebSocket(WS_URL, BEARER)
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    seen.push(msg)
    if (msg.type === 'ask' && chooseAnswer) {
      ws.send(JSON.stringify({ type: 'answer', id: msg.id, choice: chooseAnswer(msg) }))
    }
  })
  const open = new Promise((r) => ws.on('open', r)).then(() => {
    if (viewingSessionId !== undefined) ws.send(JSON.stringify({ type: 'viewing', sessionId: viewingSessionId }))
  })
  return { ws, seen, open }
}

section('the port everything has to agree on')

const { resolvePort, DEFAULT_PORT } = await import(path.join(REPO, 'server/dist/port.js'))
check('an unset ORBIT_PORT is the default', resolvePort(undefined) === DEFAULT_PORT, String(DEFAULT_PORT))
check('an empty ORBIT_PORT is the default, not 0', resolvePort('') === DEFAULT_PORT, String(resolvePort('')))
check('…and so is one that is only spaces', resolvePort('   ') === DEFAULT_PORT)
check('a real port is itself', resolvePort('3099') === 3099)
const refuses = (raw) => {
  try {
    resolvePort(raw)
    return false
  } catch {
    return true
  }
}
check('anything that is not a port is refused out loud', ['0', '-1', '70000', 'abc', '80.5'].every(refuses))

const runOrbit = (args, env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'server/dist/main.js'), ...args], {
      env: { ...process.env, ...env },
    })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.on('close', (code) => resolve({ code, output: output.trim() }))
  })

const unusable = await runOrbit(['doctor'], { ORBIT_PORT: 'abc' })
check('an unusable ORBIT_PORT exits 2', unusable.code === 2, String(unusable.code))
check(
  '…saying so in one sentence, with no stack trace',
  unusable.output.split('\n').length === 1 && unusable.output.startsWith('orbit: ORBIT_PORT must be'),
  unusable.output.split('\n')[0],
)
check('the server is on the port this suite was told', (await api('/api/sessions', null, 'GET')).status === 200, String(PORT))

const namesThePort = {
  'Makefile': /^PORT := (\d+)$/m,
  'scripts/test.sh': /^LIVE_PORTS="(\d+)/m,
  'scripts/shots.sh': /^LIVE_PORTS="(\d+)/m,
  'web/vite.config.ts': /target: 'http:\/\/localhost:(\d+)'/,
  'package.json': /serve --bg (\d+)/,
}
const disagree = Object.entries(namesThePort)
  .map(([file, pattern]) => [file, fs.readFileSync(path.join(REPO, file), 'utf8').match(pattern)?.[1]])
  .filter(([, found]) => Number(found) !== DEFAULT_PORT)
check(
  'every file that names the default port names the same one',
  disagree.length === 0,
  disagree.map(([file, found]) => `${file}: ${found ?? 'not found'}`).join(', '),
)

section('captures')
const PRESET_WIDTHS = [['phone', 780], ['tablet', 1668], ['desktop', 1440]]
for (const [preset, expectedWidth] of PRESET_WIDTHS) {
  const r = await api('/api/screenshot', { url: BASE, preset })
  check(`${preset} preset`, r.body.width === expectedWidth, `${r.body.width}×${r.body.height}`)
}
const labelled = await api('/api/screenshot', { url: `${BASE}/healthz` })
check('capture carries a label', labelled.body.label?.includes('healthz'), labelled.body.file)

const relabelled = await api('/api/screenshot', { url: BASE, label: 'localhost:3000' })
check(
  'a capture can be filed under something other than where it was fetched',
  relabelled.body.label === 'localhost:3000',
  relabelled.body.file,
)
const traversingLabel = await api('/api/screenshot', { url: BASE, label: '../../etc/passwd' })
check('…and that label cannot leave the directory', !traversingLabel.body.file?.includes('/'), traversingLabel.body.file)

const deadPort = await api('/api/screenshot', { url: `http://127.0.0.1:${PORT_NOBODY_LISTENS_ON}` })
check('a dead dev server is an error, not a picture of one', deadPort.status === 502, deadPort.body.error)
check(
  'an unknown preset is refused',
  (await api('/api/screenshot', { url: BASE, preset: 'watch' })).status === 400,
)

const NO_SCREEN_RECORDING_PERMISSION = /could not create image from display/i
const screen = await api('/api/screenshot', { source: 'screen' })
if (NO_SCREEN_RECORDING_PERMISSION.test(screen.body.error ?? '')) {
  console.log('  skip  mac screen capture — this process has no Screen Recording permission')
  console.log('        (grant it to the app that launched the server to cover this one)')
} else {
  check('mac screen capture', screen.status === 201, screen.body.error ?? `${screen.body.width}px`)
  console.log(
    '       (a capture with no app windows in it means Screen Recording is not granted —',
  )
  console.log('        macOS reports no error for that, so no test can catch it)')
}

section('dev servers on this Mac')
{
  const webStub = http.createServer((_, res) => res.end('ok'))
  await listen(webStub, WEB_STUB_PORT)
  const tcpOnlyStub = net.createServer((s) => s.on('data', () => {}))
  await listen(tcpOnlyStub, TCP_ONLY_STUB_PORT)

  const found = await api('/api/ports', undefined, 'GET')
  const offeredOn = (port) => found.body.find?.((d) => d.port === port)
  check('a listening web server is offered', !!offeredOn(WEB_STUB_PORT), JSON.stringify(found.body))
  check('…named after the program holding it', typeof offeredOn(WEB_STUB_PORT)?.command === 'string')
  check('something that does not speak HTTP is not', !offeredOn(TCP_ONLY_STUB_PORT))
  check('Orbit itself is not offered — it is already on screen', !offeredOn(PORT))

  await closeServer(webStub)
  await closeServer(tcpOnlyStub)
  check(
    'a dev server that stopped drops off the list',
    !(await api('/api/ports', undefined, 'GET')).body.find?.((d) => d.port === WEB_STUB_PORT),
  )
}

section('previews')
const FRONT_DOOR_PUBLIC_PORT = 443
const LOWEST_PREVIEW_PUBLIC_PORT = 8443
const LIVE_POLL_CAP = 32
const PORT_SCAN_SIZE = 60
const PORT_SCAN_FROM = 9000
const previewState = await listPreviews()
if (!previewState.available) {
  console.log(`       skipped — ${previewState.reason}`)
} else {
  const devServerStub = net.createServer((s) => s.end())
  await listen(devServerStub, PREVIEW_STUB_PORT)

  const frontDoor = previewState.previews.find((p) => p.publicPort === FRONT_DOOR_PUBLIC_PORT)
  check('the way in is never listed as a preview', frontDoor === undefined)
  check(
    'refusing to unpublish the way in',
    (await api(`/api/previews/${FRONT_DOOR_PUBLIC_PORT}`, undefined, 'DELETE')).status === 400,
  )
  check(
    "refusing to publish Orbit's own port",
    (await api('/api/previews', { port: PORT })).status === 400,
  )
  check('a nonsense port is refused', (await api('/api/previews', { port: 0 })).status === 400)

  const made = await api('/api/previews', { port: PREVIEW_STUB_PORT })
  check(
    'a local port is published over https',
    made.status === 201 && made.body.url?.startsWith('https://') && made.body.publicPort >= LOWEST_PREVIEW_PUBLIC_PORT,
    made.body.error ?? made.body.url,
  )
  check('…and knows the dev server is up', made.body.listening === true)

  const again = await api('/api/previews', { port: PREVIEW_STUB_PORT })
  check(
    'publishing twice returns the same address',
    again.body.publicPort === made.body.publicPort,
    `${made.body.publicPort} → ${again.body.publicPort}`,
  )

  const listed = await listPreviews()
  check(
    'it shows up in the list',
    listed.previews.some((p) => p.publicPort === made.body.publicPort && p.port === PREVIEW_STUB_PORT),
  )

  const live = await livePorts(`${PREVIEW_STUB_PORT},${PORT_NOBODY_LISTENS_ON}`)
  check('liveness answers per port', live[PREVIEW_STUB_PORT] === true && live[PORT_NOBODY_LISTENS_ON] === false,
    JSON.stringify(live))
  const scanPorts = Array.from({ length: PORT_SCAN_SIZE }, (_, i) => PORT_SCAN_FROM + i)
  const scan = await livePorts(scanPorts)
  check('…and will not be turned into a port scan', Object.keys(scan).length <= LIVE_POLL_CAP,
    `${Object.keys(scan).length} ports`)

  await closeServer(devServerStub)
  const orphaned = await listPreviews()
  check(
    'a published port outlives its dev server, and says so',
    orphaned.previews.find((p) => p.publicPort === made.body.publicPort)?.listening === false,
  )
  check(
    '…and the cheap poll agrees',
    (await livePorts(PREVIEW_STUB_PORT))[PREVIEW_STUB_PORT] === false,
  )

  check(
    'unpublishing',
    (await api(`/api/previews/${made.body.publicPort}`, undefined, 'DELETE')).status === 200,
  )
  const after = await listPreviews()
  check(
    '…leaves nothing behind',
    !after.previews.some((p) => p.publicPort === made.body.publicPort),
  )
  check(
    'unpublishing what was never published is an error',
    (await api(`/api/previews/${made.body.publicPort}`, undefined, 'DELETE')).status === 400,
  )
}

section('agent → preview')
if (!(await listPreviews()).available) {
  console.log('       skipped — no usable tailscale')
} else {
  const app = http.createServer((_req, res) => res.end('hi'))
  await listen(app, WEB_STUB_PORT)

  const watcher = phone()
  await watcher.open
  await wait(200)

  const shown = await api('/api/preview', { port: WEB_STUB_PORT, path: '/settings?tab=1' })
  check(
    'the agent publishes a port and names the route',
    shown.status === 200 && shown.body.url?.endsWith('/settings?tab=1'),
    shown.body.error ?? shown.body.url,
  )
  check('…and a connected phone is handed the frame', shown.body.delivered === 1)
  await wait(300)
  const frame = watcher.seen.find((m) => m.type === 'preview')
  check(
    '…as a preview message carrying the whole URL',
    frame?.url === shown.body.url && frame?.port === WEB_STUB_PORT,
    JSON.stringify(frame ?? null),
  )

  const escaped = await api('/api/preview', { port: WEB_STUB_PORT, path: '//evil.com/x' })
  check(
    'a path that reads as a host stays on the preview host',
    escaped.status === 200 && new URL(escaped.body.url).host === new URL(shown.body.url).host,
    escaped.body.url,
  )
  check(
    'a whole URL is refused rather than mangled into a path',
    (await api('/api/preview', { port: WEB_STUB_PORT, path: 'http://evil.com' })).status === 400,
  )

  const closedByNow = TCP_ONLY_STUB_PORT
  check(
    'a port with nothing behind it is refused, not published',
    (await api('/api/preview', { port: closedByNow })).status === 400,
  )
  const hangupStub = net.createServer((c) => c.destroy())
  await listen(hangupStub, HANGUP_STUB_PORT)
  check(
    '…and so is one that answers but not in HTTP',
    (await api('/api/preview', { port: HANGUP_STUB_PORT })).status === 400,
  )
  hangupStub.close()

  watcher.ws.close()
  await wait(500)
  const alone = await api('/api/preview', { port: WEB_STUB_PORT, path: '/orders' })
  check('with no phone connected, nothing is delivered', alone.body.delivered === 0)
  const latecomer = phone()
  await latecomer.open
  await wait(400)
  check(
    '…and a notice says which port and path were meant',
    latecomer.seen.some(
      (m) => m.type === 'notice' && m.message.includes(String(WEB_STUB_PORT)) && m.message.includes('/orders'),
    ),
    JSON.stringify(latecomer.seen.filter((m) => m.type === 'notice').map((n) => n.message)),
  )
  latecomer.ws.close()
  await wait(400)

  const publishedFor = (await listPreviews()).previews.find((p) => p.port === WEB_STUB_PORT)?.publicPort
  await api(`/api/previews/${publishedFor}`, null, 'DELETE')
  await closeServer(app)
}

section('mac → phone')
const answeringPhone = phone((ask) => ask.options[0])
await answeringPhone.open
await wait(200)
check('notify reaches a connected phone', (await api('/api/notify', { message: 'smoke' })).body.delivered === 1)
const answered = await api('/api/ask', { question: 'Deploy?', options: ['Yes', 'No'], timeoutSeconds: 10 })
check('ask blocks until the phone answers', answered.body.answer === 'Yes', JSON.stringify(answered.body))
answeringPhone.ws.close()
await wait(300)

const lonely = await api('/api/ask', { question: 'Anyone?', timeoutSeconds: 5 })
check('ask with no phone times out rather than hanging', lonely.body.timedOut === true)

const pending = api('/api/ask', { question: 'Still there?', timeoutSeconds: 15 })
await wait(300)
const joinedMidQuestion = phone(() => 'Allow')
check('a phone joining mid-question is caught up', (await pending).body.answer === 'Allow')
joinedMidQuestion.ws.close()

const noCredential = await fetch(`${BASE}/api/ask/answer`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'n999-nope', token: 'not-a-token', choice: 'Allow' }),
})
check(
  'answering from a notification needs no token, and gets nowhere without a capability',
  noCredential.status === 404,
  `HTTP ${noCredential.status}`,
)
check(
  'every other route still refuses an unauthenticated caller',
  (await fetch(`${BASE}/api/sessions`)).status === 401,
)

section('push (the phone is asleep)')
await wait(500)
const missedNotice = await api('/api/notify', { message: 'while you were away' })
check(
  'a notice with nobody connected is not delivered',
  missedNotice.body.delivered === 0,
  JSON.stringify(missedNotice.body),
)
check(
  'push is attempted only then',
  typeof missedNotice.body.pushed === 'number',
  `pushed: ${missedNotice.body.pushed} (0 unless a device is registered)`,
)
const keyRes = await api('/api/push/key', null, 'GET')
check('a VAPID key is served', typeof keyRes.body.publicKey === 'string' && keyRes.body.publicKey.length > 80)
check('a malformed subscription is refused', (await api('/api/push/subscribe', { endpoint: 'x' })).status === 400)

const wokenPhone = phone()
await wokenPhone.open
await wait(400)
const replayed = wokenPhone.seen.filter((m) => m.type === 'notice')
check(
  'the missed notice is replayed to the phone that turns up',
  replayed.some((n) => n.message === 'while you were away' && n.missed),
  `${replayed.length} replayed`,
)
const liveNotice = await api('/api/notify', { message: 'delivered live' })
await wait(300)
check('a live notice needs no push', liveNotice.body.delivered === 1 && liveNotice.body.pushed === 0)
wokenPhone.ws.close()
await wait(500)
const nextPhone = phone()
await nextPhone.open
await wait(400)
check(
  'nothing is replayed twice',
  nextPhone.seen.filter((m) => m.type === 'notice').length === 0,
)
nextPhone.ws.close()
await wait(400)

section('sessions')
const stale = new WebSocket(`${WS_URL}?session=not-a-real-id`, BEARER)
const staleMsgs = []
stale.on('message', (m) => staleMsgs.push(JSON.parse(m.toString())))
const staleClosed = new Promise((r) => stale.on('close', r))
const countBefore = (await listSessions()).length
await staleClosed
await wait(400)
const countAfter = (await listSessions()).length
check('a stale session id is reported gone', staleMsgs[0]?.type === 'gone')
check('…and conjures no replacement shell', countBefore === countAfter, `${countBefore} → ${countAfter}`)

const shell = (await api('/api/sessions', { provider: 'shell', cwd: HOME })).body
check('a shell is not resumable', shell.resumable === false)
await endSession(shell.id)
await wait(400)
check(
  'resuming one is refused',
  (await api(`/api/sessions/${shell.id}/restart`, { resume: true })).status === 404,
)

const started = [shell.id]
const providers = (await api('/api/providers', null, 'GET')).body
const claudeThere = providers.find?.((p) => p.id === 'claude')?.available === true
if (!claudeThere) {
  console.log('  skip  agent resume — Claude Code is not on this server\'s PATH')
} else {
  const agent = (await api('/api/sessions', { provider: 'claude', cwd: HOME, name: 'smoke' })).body
  started.push(agent.id)
  check('an agent session is launched holding a conversation of its own', !!agent.conversationId, agent.conversationId)
  await endSession(agent.id)
  await wait(400)
  const ended = (await listSessions()).find((s) => s.id === agent.id)
  check('…and once it ends, that conversation is on offer', ended?.resumable === true, JSON.stringify(ended?.conversationId))
  const resumed = await api(`/api/sessions/${agent.id}/restart`, { resume: true })
  check('an agent session resumes', resumed.status === 201, resumed.body.error ?? resumed.body.id)
  check(
    '…as the same conversation, not a new one',
    resumed.body.conversationId === agent.conversationId,
    `${agent.conversationId} → ${resumed.body.conversationId}`,
  )
  if (resumed.body.id) await endThenForget(resumed.body.id, 300)
}

const codexThere = providers.find?.((p) => p.id === 'codex')?.available === true
if (!codexThere) {
  console.log('  skip  folder resume — Codex CLI is not on this server\'s PATH')
} else {
  const CODEX_FOLDER = path.join(HOME, 'codex-smoke')
  fs.mkdirSync(CODEX_FOLDER, { recursive: true })
  const older = (await api('/api/sessions', { provider: 'codex', cwd: CODEX_FOLDER, name: 'older' })).body
  check('a Codex session holds no conversation of its own', !older.conversationId, older.conversationId ?? 'none')
  await endSession(older.id)
  await wait(400)
  check(
    'the folder\'s only ended Codex session is on offer',
    (await listSessions()).find((s) => s.id === older.id)?.resumable === true,
  )

  const newer = (await api('/api/sessions', { provider: 'codex', cwd: CODEX_FOLDER, name: 'newer' })).body
  await wait(400)
  check(
    '…and a live one in the same folder takes the offer away',
    (await listSessions()).find((s) => s.id === older.id)?.resumable === false,
  )
  await endSession(newer.id)
  await wait(400)
  const rows = await listSessions()
  check(
    '…which the newest of the two ended sessions then holds alone',
    rows.find((s) => s.id === newer.id)?.resumable === true &&
      rows.find((s) => s.id === older.id)?.resumable === false,
  )

  const reopened = await api(`/api/sessions/${newer.id}/restart`, { resume: true })
  check('a Codex session resumes the folder', reopened.status === 201, reopened.body.error ?? reopened.body.id)
  check(
    '…in that folder, still without a conversation of its own',
    reopened.body.cwd === CODEX_FOLDER && !reopened.body.conversationId,
    reopened.body.cwd,
  )
  check('…and the row it reopened is gone', !(await listSessions()).some((s) => s.id === newer.id))
  if (reopened.body.id) await endThenForget(reopened.body.id, 300)
  await endThenForget(older.id, 300)
}

const CONV_HOME = path.join(HOME, 'conversation-smoke')
fs.mkdirSync(CONV_HOME, { recursive: true })
const CONVERSATION_BOOKKEEPING_SCRIPT = `
      const { PtyManager } = await import(${JSON.stringify(path.join(REPO, 'server/dist/pty-manager.js'))})
      const { getProvider } = await import(${JSON.stringify(path.join(REPO, 'server/dist/providers.js'))})
      const claude = getProvider('claude')
      const m = new PtyManager()
      const folder = process.env.HOME
      const end = (s) => { s.kill(); return new Promise((r) => setTimeout(r, 250)) }
      const info = (id) => m.list().find((s) => s.id === id)

      const first = m.create({ provider: claude, cwd: folder, name: 'first' })
      await end(first)
      const second = m.create({ provider: claude, cwd: folder, name: 'second' })
      await end(second)

      const out = {
        named: !!info(first.id)?.conversationId,
        distinct: info(first.id)?.conversationId !== info(second.id)?.conversationId,
        olderResumable: info(first.id)?.resumable === true,
        newerResumable: info(second.id)?.resumable === true,
      }

      const conversation = info(first.id)?.conversationId
      const rowsFor = (c) => m.list().filter((s) => s.conversationId === c)

      const again = m.restart(first.id, true)
      out.reopened = !!again
      out.sameConversation = info(again?.id)?.conversationId === conversation
      out.oldRowGone = info(first.id) === undefined
      out.oneRow = rowsFor(conversation).length === 1
      out.notWhileLive = rowsFor(conversation).every((s) => s.resumable === false)
      await end(again)
      out.freeAgain = info(again.id)?.resumable === true
      out.offeredOnce = rowsFor(conversation).filter((s) => s.resumable).length === 1

      const fresh = m.restart(second.id, false)
      await end(fresh)
      out.plusKeepsOld = !!info(second.id)
      out.plusIsNew = !!fresh && info(fresh.id)?.conversationId !== info(second.id)?.conversationId

      const shell = m.create({ cwd: folder })
      await end(shell)
      out.shellUnnamed = info(shell.id)?.conversationId === null
      m.killAll()
      console.log(JSON.stringify(out))
      process.exit(0)
      `
const runInOwnDataDir = (script, home) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()))
      } catch {
        resolve({ error: out.slice(0, 200) })
      }
    })
  })
const conv = await runInOwnDataDir(CONVERSATION_BOOKKEEPING_SCRIPT, CONV_HOME)

check('an agent session is launched holding a conversation it named', conv.named, conv.error)
check('…a different one each time', conv.distinct)
check('an older ended session is reachable, not just the folder-newest', conv.olderResumable)
check('…and so is the newest', conv.newerResumable)
check('resuming one reopens it', conv.reopened)
check('…as the same conversation, so it can be reopened again', conv.sameConversation)
check('…and nobody else may open it while that is running', conv.notWhileLive)
check('…until it ends, when the row that held it last offers it again', conv.freeAgain)
check('resuming replaces the row it came from rather than adding one', conv.oldRowGone)
check('…so one conversation is one row, however often it is picked back up', conv.oneRow)
check('one conversation is offered once', conv.offeredOnce)
check('＋ leaves the session it was opened from where it was', conv.plusKeepsOld)
check('…and starts a conversation of its own', conv.plusIsNew)
check('a shell has no conversation to name', conv.shellUnnamed)

section('attaching quietly (a size the PTY already has is not news)')
const REPLAY_SIZE = { cols: 90, rows: 30 }
const ANOTHER_SIZE = { cols: 100, rows: 34 }
const ANOTHER_SIZE_TALLER = { cols: 100, rows: 36 }
const WINCH_MARKER = 'WINCH-HIT'
const ARM_WINCH_TRAP = `trap 'echo W""INCH-HIT' WINCH\r`

const winch = (await api('/api/sessions', { provider: 'shell', cwd: HOME, name: 'winch' })).body
started.push(winch.id)

const attachAt = ({ cols, rows }) => {
  const ws = new WebSocket(`${WS_URL}?session=${winch.id}&cols=${cols}&rows=${rows}`, BEARER)
  const ready = new Promise((r) =>
    ws.on('message', function untilReady(m) {
      if (JSON.parse(m.toString()).type === 'ready') {
        ws.off('message', untilReady)
        r()
      }
    }),
  )
  const attached = { text: '', ws, ready }
  ws.on('message', (m) => {
    const msg = JSON.parse(m.toString())
    if (msg.type === 'output') attached.text += msg.data
  })
  ws.on('error', () => {})
  return attached
}

const held = attachAt(REPLAY_SIZE)
await held.ready
held.ws.send(JSON.stringify({ type: 'input', data: ARM_WINCH_TRAP }))
await wait(600)
const heard = () => held.text.includes(WINCH_MARKER)
check('the shell is armed to say when it is resized', !heard(), held.text.slice(-40))

const sameSize = attachAt(REPLAY_SIZE)
await sameSize.ready
await wait(600)
check('attaching at the size the replay was drawn for disturbs nothing', !heard())
sameSize.ws.close()

const otherSize = attachAt(ANOTHER_SIZE)
await otherSize.ready
await wait(600)
check('…while attaching at a different size does tell the process', heard(), held.text.slice(-40))
otherSize.ws.close()

held.text = ''
held.ws.send(JSON.stringify({ type: 'resize', ...ANOTHER_SIZE }))
await wait(600)
check('a resize to the size it is already at is dropped', !heard())
held.ws.send(JSON.stringify({ type: 'resize', ...ANOTHER_SIZE_TALLER }))
await wait(600)
check('…and one that moves goes through', heard(), held.text.slice(-40))
held.ws.close()
await wait(200)

for (const id of started) await endSession(id)

section('conversations from the Mac')

const MAC_FOLDER = path.join(HOME, 'mac-smoke')
const CLAUDE_PROJECT_DIR = path.join(HOME, '.claude', 'projects', '-mac-smoke')
const EXTERNAL_ROW_CAP = 10
const MORE_THAN_THE_CAP = 12
fs.mkdirSync(MAC_FOLDER, { recursive: true })

const writeTranscript = (id, entries) => {
  fs.mkdirSync(CLAUDE_PROJECT_DIR, { recursive: true })
  const file = path.join(CLAUDE_PROJECT_DIR, `${id}.jsonl`)
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return file
}
const minutesPastNoon = (min) => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString()
const userTurn = (cwd, text, min) => ({
  type: 'user',
  cwd,
  timestamp: minutesPastNoon(min),
  message: { role: 'user', content: text },
})

const MAC_ID = '11111111-1111-4111-8111-111111111111'
const NOTHING_SAID_ID = '22222222-2222-4222-8222-222222222222'
const OUTSIDE_HOME_ID = '33333333-3333-4333-8333-333333333333'
const FOLDER_GONE_ID = '44444444-4444-4444-8444-444444444444'

const macFile = writeTranscript(MAC_ID, [
  { type: 'mode', mode: 'normal' },
  userTurn(MAC_FOLDER, 'fix the header on mobile', 0),
  {
    type: 'assistant',
    timestamp: minutesPastNoon(1),
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        { type: 'text', text: 'The header is fixed.' },
      ],
    },
  },
])

writeTranscript(NOTHING_SAID_ID, [
  { type: 'mode', mode: 'normal' },
  { ...userTurn(MAC_FOLDER, '<command-name>/clear</command-name>', 0) },
  { ...userTurn(MAC_FOLDER, 'a subagent said this', 0), isSidechain: true },
])
writeTranscript(OUTSIDE_HOME_ID, [userTurn('/etc', 'poke around', 0)])
writeTranscript(FOLDER_GONE_ID, [
  userTurn(path.join(HOME, 'gone-for-good'), 'in a folder that no longer exists', 0),
])

const listed = await listSessions()
const mac = listed.find((s) => s.id === MAC_ID)
check('a conversation from the Mac shows up on the phone', !!mac, mac?.cwd)
check('…labelled with what was actually asked', mac?.firstCommand === 'fix the header on mobile', mac?.firstCommand)
check('…as an ended Claude Code session in its own folder', mac?.alive === false && mac?.providerId === 'claude' && mac?.cwd === MAC_FOLDER)
check('…marked as one Orbit does not own', mac?.external === true)
check('…and reachable, because the transcript is named after the conversation', mac?.resumable === true && mac?.conversationId === MAC_ID)

const seen = (id) => listed.some((s) => s.id === id)
check('a transcript with nothing the user said is not a row', !seen(NOTHING_SAID_ID))
check('…nor is one from outside the home directory', !seen(OUTSIDE_HOME_ID))
check('…nor one whose folder is gone', !seen(FOLDER_GONE_ID))

const readyMessageFor = (sessionId) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`${WS_URL}?session=${sessionId}`, BEARER)
    ws.on('message', (m) => {
      const msg = JSON.parse(m.toString())
      if (msg.type === 'ready') {
        ws.close()
        resolve(msg)
      }
    })
    ws.on('error', () => resolve(null))
    setTimeout(() => resolve(null), 3000)
  })
const macHistory = await readyMessageFor(MAC_ID)
check('opening one replays the conversation, read-only', macHistory?.readOnly === true)
check('…rebuilt from the transcript, since nothing drew it on Orbit\'s screen', macHistory?.replay?.includes('fix the header on mobile'))
check('…with what the agent said back', macHistory?.replay?.includes('The header is fixed.'))
check('…and one line for each tool it ran', macHistory?.replay?.includes('⚙ Bash · npm test'))

const deleted = await endSession(MAC_ID)
check('the phone may not delete a transcript that belongs to the Mac', deleted.status === 400, deleted.body.error)
check('…and the file is still there', fs.existsSync(macFile))

for (let i = 0; i < MORE_THAN_THE_CAP; i++) {
  writeTranscript(`${String(i).padStart(2, '0')}555555-5555-4555-8555-555555555555`, [userTurn(MAC_FOLDER, `one of many ${i}`, i)])
}
const capped = (await listSessions()).filter((s) => s.external)
check('the list stays about a thumb-flick long however many are on disk', capped.length === EXTERNAL_ROW_CAP, `${capped.length} rows`)

section('attention (what a session is still waiting to tell you)')
const attentionOf = async (id) => (await listSessions()).find((s) => s.id === id)?.attention ?? null

const ATTENTION_FOLDER = path.join(HOME, 'attention-smoke')
fs.mkdirSync(ATTENTION_FOLDER, { recursive: true })
const one = (await api('/api/sessions', { provider: 'shell', cwd: ATTENTION_FOLDER, name: 'one' })).body
const two = (await api('/api/sessions', { provider: 'shell', cwd: ATTENTION_FOLDER, name: 'two' })).body

const filed = await api('/api/notify', { message: 'Claude is waiting', sessionId: one.id, kind: 'waiting' })
check('a notice is filed against the session that sent it', filed.body.sessionId === one.id)
check('…and outlives the toast', (await attentionOf(one.id))?.message === 'Claude is waiting')
check('…leaving the other session alone', (await attentionOf(two.id)) === null)

await api('/api/notify', { message: 'Finished: something', sessionId: one.id, kind: 'done' })
check(
  'a finished turn does not bury an unanswered question',
  (await attentionOf(one.id))?.kind === 'waiting',
)

check('reading it clears it', (await api(`/api/sessions/${one.id}/attention`, null, 'DELETE')).body.cleared)
check('…and it stays cleared', (await attentionOf(one.id)) === null)

const watcher = phone(null, one.id)
await watcher.open
await wait(200)
const atWatched = await api('/api/notify', { message: 'you are looking at this', sessionId: one.id, quiet: true })
check('a quiet notice about the session on screen is dropped', atWatched.body.dropped === true)
check('…and leaves nothing to read later', (await attentionOf(one.id)) === null)

const atOther = await api('/api/notify', { message: 'the other one wants you', sessionId: two.id, quiet: true })
check('a quiet notice about another session still gets through', atOther.body.delivered === 1)
check('…and is held against that session', (await attentionOf(two.id))?.message === 'the other one wants you')
check(
  'the notice tells the phone which session it came from',
  watcher.seen.some((m) => m.type === 'notice' && m.sessionId === two.id),
)
watcher.ws.close()
await wait(300)

const guessed = await api('/api/notify', { message: 'from a folder', source: ATTENTION_FOLDER })
check(
  'two sessions in one folder make the folder no answer at all',
  guessed.body.sessionId === null,
  JSON.stringify(guessed.body),
)
await endSession(two.id)
await wait(400)
const lone = await api('/api/notify', { message: 'from the only one left', source: ATTENTION_FOLDER })
check('…but one of them is', lone.body.sessionId === one.id, JSON.stringify(lone.body))

check(
  'a session id nobody has heard of is filed against nothing',
  (await api('/api/notify', { message: 'orphan', sessionId: 'not-a-real-id' })).body.sessionId === null,
)

await api(`/api/sessions/${one.id}/attention`, null, 'DELETE')
const answerer = phone(() => 'Yes', null)
await answerer.open
await wait(200)
const asked = await api('/api/ask', { question: 'Ship it?', sessionId: one.id, timeoutSeconds: 10 })
check('an answered question leaves nothing waiting', asked.body.answer === 'Yes' && (await attentionOf(one.id)) === null)
answerer.ws.close()
await wait(500)
const ignored = await api('/api/ask', { question: 'Ship it anyway?', sessionId: one.id, timeoutSeconds: 5 })
check('one nobody answered does', ignored.body.timedOut && (await attentionOf(one.id))?.kind === 'waiting')

await endThenForget(one.id, 400)
check('a forgotten session takes its record with it', (await attentionOf(one.id)) === null)

section('changes (what the agent wrote)')
const REPO_DIR = path.join(HOME, 'git-smoke')
const BARE = path.join(HOME, 'git-smoke-origin.git')
fs.rmSync(REPO_DIR, { recursive: true, force: true })
fs.rmSync(BARE, { recursive: true, force: true })
fs.mkdirSync(REPO_DIR, { recursive: true })
const git = (args, cwd = REPO_DIR) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

execFileSync('git', ['init', '--bare', '-b', 'main', BARE])
execFileSync('git', ['init', '-b', 'main', REPO_DIR])
git(['config', 'user.email', 'smoke@example.com'])
git(['config', 'user.name', 'Smoke'])
fs.writeFileSync(path.join(REPO_DIR, 'kept.txt'), 'one\ntwo\nthree\n')
git(['add', '.'])
git(['commit', '-m', 'first'])
git(['remote', 'add', 'origin', BARE])

const gitApi = (route, body, method = 'POST') => api(`/api/git/${route}`, body, method)
const statusOf = async () =>
  (await gitApi(`status?cwd=${encodeURIComponent(REPO_DIR)}`, null, 'GET')).body
const readDiff = (file, { staged = false } = {}) =>
  gitApi(`diff?cwd=${encodeURIComponent(REPO_DIR)}&file=${file}${staged ? '&staged=1' : ''}`, null, 'GET')

const FILE_HEADER_LINE = /^(diff --git |index |--- |\+\+\+ )/
const splitHunks = (patch) =>
  patch.split('\n').reduce((hunks, line) => {
    if (line.startsWith('@@')) hunks.push([line])
    else if (hunks.length && !FILE_HEADER_LINE.test(line) && line !== '') hunks[hunks.length - 1].push(line)
    return hunks
  }, [])

check('a folder with no history says so, rather than erroring', (await gitApi(`status?cwd=${encodeURIComponent(HOME)}`, null, 'GET')).body.repo === false)
check('a folder outside home is refused', (await gitApi('status?cwd=%2Fetc', null, 'GET')).status === 400)

let st = await statusOf()
check('a clean repository is reported clean', st.repo && st.files.length === 0, JSON.stringify(st.files))
check('…on the branch and commit it is actually on', st.branch === 'main' && st.head?.subject === 'first')
check('…knowing whether there is anywhere to push to', st.hasRemote === true)

fs.writeFileSync(path.join(REPO_DIR, 'kept.txt'), 'one\nTWO\nthree\nfour\n')
fs.writeFileSync(path.join(REPO_DIR, 'fresh.txt'), 'brand new\n')
st = await statusOf()
const kept = st.files.find((f) => f.path === 'kept.txt')
const fresh = st.files.find((f) => f.path === 'fresh.txt')
check('a modified file is listed with its line counts', kept?.worktree === 'M' && kept.added === 2 && kept.removed === 1, JSON.stringify(kept))
check('an untracked file is listed as one', fresh?.worktree === '?' && fresh.added === 1, JSON.stringify(fresh))

const unstagedDiff = (await readDiff('kept.txt')).body
check('its diff shows both sides of the change', unstagedDiff.patch.includes('-two') && unstagedDiff.patch.includes('+TWO'))
const newDiff = (await readDiff('fresh.txt')).body
check('an untracked file still has a diff to read', newDiff.patch.includes('+brand new'), newDiff.patch.slice(0, 60))
check(
  'a path climbing out of the repository is refused',
  (await readDiff('..%2F..%2F.orbit%2Fconfig.json')).status === 400,
)

const SPLIT = 'split.txt'
const twentyLines = () => Array.from({ length: 20 }, (_, i) => `line ${i}`)
fs.writeFileSync(path.join(REPO_DIR, SPLIT), twentyLines().join('\n') + '\n')
git(['add', SPLIT])
git(['commit', '-m', 'twenty lines'])
const twoChanges = twentyLines()
twoChanges[1] = 'TOP CHANGE'
twoChanges[18] = 'BOTTOM CHANGE'
fs.writeFileSync(path.join(REPO_DIR, SPLIT), twoChanges.join('\n') + '\n')

const hunks = splitHunks((await readDiff(SPLIT)).body.patch)
check('two changes far apart are two hunks', hunks.length === 2, `${hunks.length}`)

const afterFirst = (await gitApi('hunk', { cwd: REPO_DIR, file: SPLIT, hunk: hunks[0].join('\n') })).body
const splitRow = afterFirst.files?.find((f) => f.path === SPLIT)
check('staging one hunk stages one hunk', splitRow?.staged === 'M' && splitRow?.worktree === 'M', JSON.stringify(splitRow))
check(
  '…the one that was asked for',
  git(['diff', '--cached', '--', SPLIT]).includes('TOP CHANGE') &&
    !git(['diff', '--cached', '--', SPLIT]).includes('BOTTOM CHANGE'),
)
check('…and leaves the other in the working tree', git(['diff', '--', SPLIT]).includes('BOTTOM CHANGE'))
check('…without touching the file on disk', fs.readFileSync(path.join(REPO_DIR, SPLIT), 'utf8').includes('BOTTOM CHANGE'))

const stagedHunks = splitHunks((await readDiff(SPLIT, { staged: true })).body.patch)
await gitApi('hunk', { cwd: REPO_DIR, file: SPLIT, hunk: stagedHunks[0].join('\n'), staged: true })
check('taking it back out empties the index again', !git(['diff', '--cached', '--', SPLIT]))
check('…and the change is still in the working tree', git(['diff', '--', SPLIT]).includes('TOP CHANGE'))

const stageHunkStatus = async (hunk) => (await gitApi('hunk', { cwd: REPO_DIR, file: SPLIT, hunk })).status
check(
  'a hunk that no longer fits is refused, not forced',
  (await stageHunkStatus('@@ -1,3 +1,3 @@\n-nothing like this\n+at all\n context')) === 400,
)
check(
  'a patch cannot smuggle in a second file',
  (await stageHunkStatus('@@ -1,1 +1,1 @@\ndiff --git a/kept.txt b/kept.txt\n-one\n+two')) === 400,
)
check('and something that is not a hunk at all is refused', (await stageHunkStatus('rm -rf /')) === 400)
check(
  '…nor a file header dressed as a removal',
  (await stageHunkStatus('@@ -1,1 +1,1 @@\n-one\n+two\n--- a/kept.txt\n+++ b/kept.txt\n@@ -1,1 +1,1 @@\n-x\n+y')) === 400,
)

git(['checkout', '--', SPLIT])

st = (await gitApi('stage', { cwd: REPO_DIR, files: ['kept.txt'], add: true })).body
check('staging moves it to the index', st.files.find((f) => f.path === 'kept.txt')?.staged === 'M')
const stagedDiff = (await readDiff('kept.txt', { staged: true })).body
check('…and the staged diff is the one that would be committed', stagedDiff.patch.includes('+TWO'))
st = (await gitApi('stage', { cwd: REPO_DIR, files: ['kept.txt'], add: false })).body
check('unstaging puts it back', st.files.find((f) => f.path === 'kept.txt')?.staged === ' ')

check('committing nothing is refused, in words', (await gitApi('commit', { cwd: REPO_DIR, message: 'nope' })).body.error === 'nothing is staged')
await gitApi('stage', { cwd: REPO_DIR, files: ['kept.txt', 'fresh.txt'], add: true })
check('a commit needs a message', (await gitApi('commit', { cwd: REPO_DIR, message: '   ' })).status === 400)
const made = await gitApi('commit', { cwd: REPO_DIR, message: 'from the phone' })
check('the commit lands', made.status === 201 && made.body.subject === 'from the phone', JSON.stringify(made.body).slice(0, 120))
check(
  '…counted in something a toast can hold',
  made.body.files === 2 && made.body.added === 3 && made.body.removed === 1,
  JSON.stringify({ files: made.body.files, added: made.body.added, removed: made.body.removed }),
)
check('…and the list is clean afterwards', made.body.status.files.length === 0)
check('…with the new commit at the head', made.body.status.head?.subject === 'from the phone')

check('a branch with no upstream is ahead of nothing yet', made.body.status.upstream === null)
const pushed = await gitApi('push', { cwd: REPO_DIR })
check('pushing sets the upstream it did not have', pushed.status === 200 && pushed.body.status.upstream === 'origin/main', JSON.stringify(pushed.body).slice(0, 140))
check('…and leaves nothing ahead', pushed.body.status.ahead === 0)
check('the bare repository actually received it', git(['log', '-1', '--format=%s'], BARE) === 'from the phone')

fs.rmSync(REPO_DIR, { recursive: true, force: true })
fs.rmSync(BARE, { recursive: true, force: true })

section('auth')
const SESSION_COOKIE = 'orbit_session'
const WS_CLOSE_UNAUTHORISED = 4001
const checkRes = await fetch(`${BASE}/api/auth/check`, { headers: H })
const setCookie = checkRes.headers.get('set-cookie') ?? ''
const cookie = setCookie.split(';')[0]
check('the token check mints a session cookie', !!cookie, setCookie)
check('the cookie is not the token', !cookie.includes(TOKEN))
check('HttpOnly', setCookie.includes('HttpOnly'))
check('SameSite=Strict', setCookie.includes('SameSite=Strict'))
const secure = await fetch(`${BASE}/api/auth/check`, { headers: { ...H, 'x-forwarded-proto': 'https' } })
check('Secure behind TLS', (secure.headers.get('set-cookie') ?? '').includes('Secure'))

const withCookie = (init = {}) => ({ ...init, headers: { ...(init.headers ?? {}), cookie } })
check('cookie reads', (await fetch(`${BASE}/api/sessions`, withCookie())).status === 200)
check(
  'cookie cannot write',
  (await fetch(`${BASE}/api/sessions`, withCookie({ method: 'POST', body: '{}' }))).status === 401,
)
check(
  'a forged cookie is rejected',
  (await fetch(`${BASE}/api/sessions`, { headers: { cookie: `${SESSION_COOKIE}=${'a'.repeat(64)}` } })).status === 401,
)
const shot = (await api('/api/screenshots', null, 'GET')).body[0]
check('images need the cookie', (await fetch(`${BASE}/api/screenshots/${shot.file}`)).status === 401)
check('…and load with it', (await fetch(`${BASE}/api/screenshots/${shot.file}`, withCookie())).status === 200)
check(
  'query-string auth is gone',
  (await fetch(`${BASE}/api/screenshots/${shot.file}?token=${TOKEN}`)).status === 401,
)

const minted = await api('/api/auth/pair-code', {})
check('the token holder can mint a pairing code', minted.status === 200 && !!minted.body.code, JSON.stringify(minted.body).slice(0, 80))
check('…as an address with the code in its fragment, not its query', /\/#pair=[A-Za-z0-9_-]+$/.test(minted.body.url ?? ''), minted.body.url)
check('…that nobody else can mint', (await fetch(`${BASE}/api/auth/pair-code`, { method: 'POST' })).status === 401)
const pair = (code) =>
  fetch(`${BASE}/api/auth/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
const paired = await pair(minted.body.code)
check('the code buys the token without any other credential', paired.status === 200 && (await paired.json()).token === TOKEN)
check('…and a session cookie with it', (paired.headers.get('set-cookie') ?? '').includes(`${SESSION_COOKIE}=`))
check('the same code works again — Safari and the home-screen app both need it', (await pair(minted.body.code)).status === 200)
check('a wrong code does not', (await pair('nope-not-a-code')).status === 401)
check('nor an empty one', (await pair('')).status === 401)

const SOCKET_VERDICT_MS = 1200
const socketVerdict = (url, opts) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, opts)
    let closed = null
    let ready = false
    ws.on('message', (m) => (ready ||= JSON.parse(m.toString()).type === 'ready'))
    ws.on('close', (code) => (closed = code))
    ws.on('error', () => {})
    setTimeout(() => {
      ws.close()
      resolve({ closed, ready })
    }, SOCKET_VERDICT_MS)
  })

const withCookieWs = await socketVerdict(WS_URL, { headers: { cookie } })
check('the socket accepts the cookie', withCookieWs.ready && !withCookieWs.closed)
const bare = await socketVerdict(WS_URL, {})
check('…and refuses no credential', bare.closed === WS_CLOSE_UNAUTHORISED, `close ${bare.closed}`)
const queryWs = await socketVerdict(`${WS_URL}?token=${TOKEN}`, {})
check('…and refuses a query token', queryWs.closed === WS_CLOSE_UNAUTHORISED, `close ${queryWs.closed}`)
const anotherPortOfThisHost = `http://127.0.0.1:${PORT + 1}`
const crossOrigin = await socketVerdict(WS_URL, { headers: { cookie, origin: anotherPortOfThisHost } })
check('…and refuses the cookie from another origin', crossOrigin.closed === WS_CLOSE_UNAUTHORISED, `close ${crossOrigin.closed}`)
const sameOriginWs = await socketVerdict(WS_URL, { headers: { cookie, origin: BASE } })
check('…but takes it from its own', sameOriginWs.ready && !sameOriginWs.closed)

const MALFORMED_FRAMES = ['null', 'garbage', '[]', '{"type":"resize"}', '{"type":"resize","cols":"x","rows":24}',
  '{"type":"resize","cols":0,"rows":-1}', '{"type":"input","data":123}', '{"type":"approve"}', '{"type":42}']
const survives = await new Promise((resolve) => {
  const ws = new WebSocket(WS_URL, BEARER)
  let pong = false
  ws.on('message', (m) => {
    const msg = JSON.parse(m.toString())
    if (msg.type === 'ready') {
      for (const frame of MALFORMED_FRAMES) ws.send(frame)
      ws.send(JSON.stringify({ type: 'ping' }))
    }
    if (msg.type === 'pong') pong = true
  })
  ws.on('error', () => {})
  setTimeout(() => {
    ws.close()
    resolve(pong)
  }, SOCKET_VERDICT_MS)
})
check('malformed frames are dropped and the server answers on', survives)
check('…and it is still serving', (await fetch(`${BASE}/healthz`)).status === 200)

const fakeEndpoint = `https://web.push.apple.com/smoke-${Date.now()}`
const subscribed = await api('/api/push/subscribe', {
  endpoint: fakeEndpoint,
  keys: { p256dh: 'x'.repeat(87), auth: 'y'.repeat(22) },
})
check('a phone can register for push', subscribed.status === 201, `${subscribed.body.devices} device(s)`)
check(
  'the cookie alone cannot unpair',
  (await fetch(`${BASE}/api/auth/unpair`, withCookie({ method: 'POST', body: '{}' }))).status === 401,
)
const unpaired = await fetch(`${BASE}/api/auth/unpair`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ endpoint: fakeEndpoint }),
})
const goodbye = unpaired.headers.get('set-cookie') ?? ''
check('unpairing expires the session cookie', goodbye.includes('Max-Age=0'), goodbye)
check('…the same cookie, or the browser would keep the live one', goodbye.startsWith(`${SESSION_COOKIE}=`) && goodbye.includes('Path=/'))
check(
  '…and what it replaces it with opens nothing',
  (await fetch(`${BASE}/api/sessions`, { headers: { cookie: `${SESSION_COOKIE}=` } })).status === 401,
)
check(
  '…and this phone stops being pushed to',
  (await unpaired.json()).devices === subscribed.body.devices - 1,
)
check('…while the token still works', (await fetch(`${BASE}/api/auth/check`, { headers: H })).status === 200)

section('mcp server')
const MCP_TOOLS = ['orbit_capture', 'orbit_screen', 'orbit_notify', 'orbit_preview', 'orbit_ask']
const mcpSession = (await api('/api/sessions', { provider: 'shell', name: 'mcp' })).body
const mcp = spawn(process.execPath, [path.join(REPO, 'server/dist/mcp.js')], {
  env: { ...process.env, ORBIT_SESSION_ID: mcpSession.id },
})
let mcpOut = ''
mcp.stdout.on('data', (d) => (mcpOut += d))
const rpc = (msg) => mcp.stdin.write(`${JSON.stringify(msg)}\n`)
const callTool = (id, name, args) =>
  rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
await wait(500)
callTool(3, 'orbit_capture', { url: BASE })
await wait(8000)
callTool(4, 'orbit_capture', { url: `http://127.0.0.1:${PORT_NOBODY_LISTENS_ON}` })
await wait(3000)
callTool(5, 'orbit_notify', { message: 'finished the migration' })
await wait(500)
const afterDone = await attentionOf(mcpSession.id)
callTool(6, 'orbit_notify', { message: 'which database?', kind: 'waiting' })
await wait(500)
const afterWaiting = await attentionOf(mcpSession.id)
mcp.kill()
await endSession(mcpSession.id)

const replies = new Map(mcpOut.trim().split('\n').filter(Boolean).map((l) => {
  const m = JSON.parse(l)
  return [m.id, m]
}))
check('initialize', !!replies.get(1)?.result?.serverInfo)
const toolNames = replies.get(2)?.result?.tools?.map((t) => t.name) ?? []
check('every tool the agent is told about', MCP_TOOLS.every((n) => toolNames.includes(n)), toolNames.join(', '))
const image = replies.get(3)?.result?.content?.find((c) => c.type === 'image')
check('a capture comes back as an image, not a path', !!image?.data, `${image?.data?.length ?? 0} base64 chars`)
check('a failed capture is an error the agent can read', replies.get(4)?.result?.isError === true)
const notifyTool = replies.get(2)?.result?.tools?.find((t) => t.name === 'orbit_notify')
check(
  'the agent can say which sort of message it is',
  notifyTool?.inputSchema?.properties?.kind?.enum?.join(',') === 'done,waiting',
)
check('a message with no kind is only worth knowing', afterDone?.kind === 'done', JSON.stringify(afterDone))
check('…and one it sends as waiting is filed as waiting', afterWaiting?.kind === 'waiting', JSON.stringify(afterWaiting))
check(
  '…which the tool says plainly, since nothing was connected to receive it',
  replies.get(6)?.result?.content?.[0]?.text?.includes('held against this session'),
  replies.get(6)?.result?.content?.[0]?.text,
)

section('approval hook')
const runHook = (input, env = {}) =>
  new Promise((resolve) => {
    const h = spawn(process.execPath, [path.join(REPO, 'server/dist/main.js'), 'hook', 'approve'], {
      env: { ...process.env, ...env },
    })
    let stdout = ''
    h.stdout.on('data', (d) => (stdout += d))
    h.on('close', () => resolve(stdout))
    h.stdin.end(JSON.stringify(input))
  })

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: HOME })
const PORT_WITH_NO_ORBIT = '3999'
const NOTIFY_STDIN_LIMIT_MS = 3000
check('a safe command passes silently', (await runHook(bash('ls -la'))) === '')
check(
  'orbit being down does not block the agent',
  (await runHook(bash('rm -rf /tmp/x'), { ORBIT_PORT: PORT_WITH_NO_ORBIT })) === '',
)
const blocker = phone(() => 'Block')
await blocker.open
const denied = await runHook(bash('sudo rm -rf ./build'))
check('a blocked command is denied with a reason', denied.includes('"permissionDecision":"deny"'), denied.slice(0, 90))
blocker.ws.close()

const allower = phone(() => 'Run it')
await allower.open
check('an approved command passes', (await runHook(bash('git push --force origin main'))) === '')
allower.ws.close()

section('notify hook')

const { describe } = await import(path.join(REPO, 'server/dist/hooks.js'))
const NOTIFY_FOLDER = path.join(HOME, 'notify-hook-smoke')
fs.mkdirSync(NOTIFY_FOLDER, { recursive: true })
const hookSession = (await api('/api/sessions', { provider: 'shell', cwd: NOTIFY_FOLDER, name: 'hooked' })).body
const IN_AN_ORBIT_SESSION = { ORBIT_SESSION: '1', ORBIT_SESSION_ID: hookSession.id }
const codexTurn = (lastAssistantMessage) => ({
  type: 'agent-turn-complete',
  'thread-id': '01a08a7e-769a-7732-9af0-374186ea3902',
  'turn-id': '01a08a7e-8bb8-78e2-8be3-f187293c5b6d',
  cwd: NOTIFY_FOLDER,
  client: 'codex-tui',
  'input-messages': ['say the word MANGO and nothing else'],
  'last-assistant-message': lastAssistantMessage,
})

const wasInASession = process.env.ORBIT_SESSION
process.env.ORBIT_SESSION = '1'
check(
  'a finished Codex turn is the agent speaking, not a guess off the screen',
  describe(codexTurn('MANGO'))?.message === 'Finished: MANGO',
  JSON.stringify(describe(codexTurn('MANGO'))),
)
check(
  'the title Codex writes for its own thread is not news',
  describe(codexTurn('{"title":"Say MANGO"}')) === null,
  JSON.stringify(describe(codexTurn('{"title":"Say MANGO"}'))),
)
check(
  '…while an answer that is merely JSON still is',
  describe(codexTurn('{"title":"Say MANGO","rows":3}'))?.kind === 'done',
)
check(
  'Codex asking for approval is a session waiting, not one finished',
  describe({ type: 'approval-requested', cwd: NOTIFY_FOLDER })?.kind === 'waiting',
)
check('a shape from neither agent says nothing', describe({ type: 'something-else' }) === null)
delete process.env.ORBIT_SESSION
check(
  'a Codex run at the desk is not pushed to the phone',
  describe(codexTurn('MANGO')) === null,
)
if (wasInASession === undefined) delete process.env.ORBIT_SESSION
else process.env.ORBIT_SESSION = wasInASession

const runNotify = (payload, env = {}) =>
  new Promise((resolve) => {
    const h = spawn(process.execPath, [path.join(REPO, 'server/dist/main.js'), 'hook', 'notify', JSON.stringify(payload)], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    h.on('close', resolve)
  })

const listener = phone()
await listener.open
const startedAt = Date.now()
await runNotify(codexTurn('MANGO'), IN_AN_ORBIT_SESSION)
await wait(400)
check(
  'Codex hands the hook its JSON as an argument, and it arrives',
  listener.seen.some((m) => m.type === 'notice' && m.message === 'Finished: MANGO'),
  JSON.stringify(listener.seen.filter((m) => m.type === 'notice').map((n) => n.message)),
)
check('…without waiting on a stdin that never closes', Date.now() - startedAt < NOTIFY_STDIN_LIMIT_MS)
check(
  '…filed against the session Codex was running in',
  listener.seen.some((m) => m.type === 'notice' && m.sessionId === hookSession.id),
)

const watchingIt = phone(undefined, hookSession.id)
await watchingIt.open
await runNotify(codexTurn('MANGO'), IN_AN_ORBIT_SESSION)
await wait(400)
check(
  'a turn that finished on the screen being watched is not pushed at it',
  watchingIt.seen.filter((m) => m.type === 'notice').length === 0,
)
watchingIt.ws.close()
listener.ws.close()
await endThenForget(hookSession.id, 300)

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
