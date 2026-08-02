#!/usr/bin/env node
/**
 * End-to-end smoke test for everything the phone cannot be asked to prove:
 * capture, the Mac→phone channel, the MCP server, and the approval hook.
 *
 * Runs against a *throwaway* Orbit server, because it creates and kills
 * sessions and writes captures. Start one on a spare port with its own data
 * directory, so the real ~/.orbit is never touched:
 *
 *   npm run build
 *   HOME=/tmp/orbit-smoke ORBIT_PORT=3099 node server/dist/index.js &
 *   HOME=/tmp/orbit-smoke ORBIT_PORT=3099 node scripts/smoke.mjs
 *
 * Every line prints what happened; read them, do not just look for a zero exit.
 */
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

const PORT = Number(process.env.ORBIT_PORT ?? 3099)
const BASE = `http://127.0.0.1:${PORT}`
const HOME = os.homedir()

if (PORT === 3001 && !process.env.SMOKE_FORCE) {
  console.error('Refusing to run against port 3001 — that is the real server, and this kills')
  console.error('sessions. Start a throwaway one (see the header) or set SMOKE_FORCE=1.')
  process.exit(1)
}

const TOKEN = JSON.parse(fs.readFileSync(path.join(HOME, '.orbit', 'config.json'), 'utf8')).token
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

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

/**
 * A stand-in for the phone: one socket, answering whatever it is asked.
 * `viewing` is the session it claims to have on screen — which the server uses
 * to decide whether a `quiet` message would be telling someone what they can
 * already see.
 */
const phone = (answerWith, viewing) => {
  const seen = []
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    seen.push(msg)
    if (msg.type === 'ask' && answerWith) {
      ws.send(JSON.stringify({ type: 'answer', id: msg.id, choice: answerWith(msg) }))
    }
  })
  const open = new Promise((r) => ws.on('open', r)).then(() => {
    if (viewing !== undefined) ws.send(JSON.stringify({ type: 'viewing', sessionId: viewing }))
  })
  return { ws, seen, open }
}

// ---------------------------------------------------------------- captures

section('captures')
for (const [preset, expected] of [['phone', 780], ['tablet', 1668], ['desktop', 1440]]) {
  const r = await api('/api/screenshot', { url: BASE, preset })
  check(`${preset} preset`, r.body.width === expected, `${r.body.width}×${r.body.height}`)
}
const labelled = await api('/api/screenshot', { url: `${BASE}/healthz` })
check('capture carries a label', labelled.body.label?.includes('healthz'), labelled.body.file)

/* A published dev server is rendered through its tailnet address, so the URL
   says `…ts.net:8443` while the picture is of `localhost:3000`. */
const relabelled = await api('/api/screenshot', { url: BASE, label: 'localhost:3000' })
check(
  'a capture can be filed under something other than where it was fetched',
  relabelled.body.label === 'localhost:3000',
  relabelled.body.file,
)
const nasty = await api('/api/screenshot', { url: BASE, label: '../../etc/passwd' })
check('…and that label cannot leave the directory', !nasty.body.file?.includes('/'), nasty.body.file)

const deadPort = await api('/api/screenshot', { url: 'http://127.0.0.1:4321' })
check('a dead dev server is an error, not a picture of one', deadPort.status === 502, deadPort.body.error)
check(
  'an unknown preset is refused',
  (await api('/api/screenshot', { url: BASE, preset: 'watch' })).status === 400,
)

const screen = await api('/api/screenshot', { source: 'screen' })
check('mac screen capture', screen.status === 201, screen.body.error ?? `${screen.body.width}px`)
console.log(
  '       (a capture with no app windows in it means Screen Recording is not granted —',
)
console.log('        macOS reports no error for that, so no test can catch it)')

// ------------------------------------------------------------- dev servers

section('dev servers on this Mac')
{
  /* Something that answers HTTP, and something that answers with anything but
     — the second is the whole reason the probe exists rather than a bare TCP
     connect, since a database on a round-numbered port is the noise it removes. */
  const web = http.createServer((_, res) => res.end('ok'))
  await new Promise((r) => web.listen(3097, '127.0.0.1', r))
  const mute = net.createServer((s) => s.on('data', () => {}))
  await new Promise((r) => mute.listen(3096, '127.0.0.1', r))

  const found = await api('/api/ports', undefined, 'GET')
  const at = (p) => found.body.find?.((d) => d.port === p)
  check('a listening web server is offered', !!at(3097), JSON.stringify(found.body))
  check('…named after the program holding it', typeof at(3097)?.command === 'string')
  check('something that does not speak HTTP is not', !at(3096))
  check('Orbit itself is not offered — it is already on screen', !at(PORT))

  await new Promise((r) => web.close(r))
  await new Promise((r) => mute.close(r))
  check(
    'a dev server that stopped drops off the list',
    !(await api('/api/ports', undefined, 'GET')).body.find?.((d) => d.port === 3097),
  )
}

// ---------------------------------------------------------------- previews

section('previews')
const previewState = await api('/api/previews', undefined, 'GET')
if (!previewState.body.available) {
  console.log(`       skipped — ${previewState.body.reason}`)
} else {
  /* A port that is really listening, so the `listening` flag has something to
     be right about. Anything that accepts a connection will do. */
  const stub = net.createServer((s) => s.end())
  await new Promise((r) => stub.listen(3098, '127.0.0.1', r))

  const front = previewState.body.previews.find((p) => p.publicPort === 443)
  check('the way in is never listed as a preview', front === undefined)
  check(
    'refusing to unpublish the way in',
    (await api('/api/previews/443', undefined, 'DELETE')).status === 400,
  )
  check(
    "refusing to publish Orbit's own port",
    (await api('/api/previews', { port: PORT })).status === 400,
  )
  check('a nonsense port is refused', (await api('/api/previews', { port: 0 })).status === 400)

  const made = await api('/api/previews', { port: 3098 })
  check(
    'a local port is published over https',
    made.status === 201 && made.body.url?.startsWith('https://') && made.body.publicPort >= 8443,
    made.body.error ?? made.body.url,
  )
  check('…and knows the dev server is up', made.body.listening === true)

  const again = await api('/api/previews', { port: 3098 })
  check(
    'publishing twice returns the same address',
    again.body.publicPort === made.body.publicPort,
    `${made.body.publicPort} → ${again.body.publicPort}`,
  )

  const listed = await api('/api/previews', undefined, 'GET')
  check(
    'it shows up in the list',
    listed.body.previews.some((p) => p.publicPort === made.body.publicPort && p.port === 3098),
  )

  /* The half the phone polls: no `tailscale` process, so a tab left open does
     not spawn one every few seconds. */
  const live = await api('/api/previews/live?ports=3098,4321', undefined, 'GET')
  check('liveness answers per port', live.body['3098'] === true && live.body['4321'] === false,
    JSON.stringify(live.body))
  const scan = await api(`/api/previews/live?ports=${Array.from({ length: 60 }, (_, i) => 9000 + i)}`,
    undefined, 'GET')
  check('…and will not be turned into a port scan', Object.keys(scan.body).length <= 32,
    `${Object.keys(scan.body).length} ports`)

  /* Down goes the dev server, but not the mapping — the phone must be told the
     difference between an empty frame and a wrong address. */
  await new Promise((r) => stub.close(r))
  const orphaned = await api('/api/previews', undefined, 'GET')
  check(
    'a published port outlives its dev server, and says so',
    orphaned.body.previews.find((p) => p.publicPort === made.body.publicPort)?.listening === false,
  )
  check(
    '…and the cheap poll agrees',
    (await api('/api/previews/live?ports=3098', undefined, 'GET')).body['3098'] === false,
  )

  check(
    'unpublishing',
    (await api(`/api/previews/${made.body.publicPort}`, undefined, 'DELETE')).status === 200,
  )
  const after = await api('/api/previews', undefined, 'GET')
  check(
    '…leaves nothing behind',
    !after.body.previews.some((p) => p.publicPort === made.body.publicPort),
  )
  check(
    'unpublishing what was never published is an error',
    (await api(`/api/previews/${made.body.publicPort}`, undefined, 'DELETE')).status === 400,
  )
}

// ------------------------------------------------------------ mac → phone

section('mac → phone')
const p1 = phone((ask) => ask.options[0])
await p1.open
await wait(200)
check('notify reaches a connected phone', (await api('/api/notify', { message: 'smoke' })).body.delivered === 1)
const answered = await api('/api/ask', { question: 'Deploy?', options: ['Yes', 'No'], timeoutSeconds: 10 })
check('ask blocks until the phone answers', answered.body.answer === 'Yes', JSON.stringify(answered.body))
p1.ws.close()
await wait(300)

const lonely = await api('/api/ask', { question: 'Anyone?', timeoutSeconds: 5 })
check('ask with no phone times out rather than hanging', lonely.body.timedOut === true)

const pending = api('/api/ask', { question: 'Still there?', timeoutSeconds: 15 })
await wait(300)
const p2 = phone(() => 'Allow')
check('a phone joining mid-question is caught up', (await pending).body.answer === 'Allow')
p2.ws.close()

// ------------------------------------------------------------------- push

section('push (the phone is asleep)')
// The socket closed just above takes a moment to leave the server's set.
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

const late = phone()
await late.open
await wait(400)
const replayed = late.seen.filter((m) => m.type === 'notice')
check(
  'the missed notice is replayed to the phone that turns up',
  replayed.some((n) => n.message === 'while you were away' && n.missed),
  `${replayed.length} replayed`,
)
const liveNotice = await api('/api/notify', { message: 'delivered live' })
await wait(300)
check('a live notice needs no push', liveNotice.body.delivered === 1 && liveNotice.body.pushed === 0)
late.ws.close()
await wait(500)
const second = phone()
await second.open
await wait(400)
check(
  'nothing is replayed twice',
  second.seen.filter((m) => m.type === 'notice').length === 0,
)
second.ws.close()
await wait(400)

// --------------------------------------------------------------- sessions

section('sessions')
const stale = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=not-a-real-id`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
})
const staleMsgs = []
stale.on('message', (m) => staleMsgs.push(JSON.parse(m.toString())))
const countBefore = (await api('/api/sessions', null, 'GET')).body.length
await new Promise((r) => stale.on('close', r))
await wait(400)
const countAfter = (await api('/api/sessions', null, 'GET')).body.length
check('a stale session id is reported gone', staleMsgs[0]?.type === 'gone')
check('…and conjures no replacement shell', countBefore === countAfter, `${countBefore} → ${countAfter}`)

const shell = (await api('/api/sessions', { provider: 'shell', cwd: HOME })).body
check('a shell is not resumable', shell.resumable === false)
await api(`/api/sessions/${shell.id}`, null, 'DELETE')
await wait(400)
check(
  'resuming one is refused',
  (await api(`/api/sessions/${shell.id}/restart`, { resume: true })).status === 404,
)

const agent = (await api('/api/sessions', { provider: 'claude', cwd: HOME, name: 'smoke' })).body
if (agent.resumable) {
  await api(`/api/sessions/${agent.id}`, null, 'DELETE')
  await wait(400)
  const resumed = await api(`/api/sessions/${agent.id}/restart`, { resume: true })
  check('an agent session resumes', resumed.status === 201, resumed.body.error ?? resumed.body.id)
  if (resumed.body.id) {
    await api(`/api/sessions/${resumed.body.id}`, null, 'DELETE')
    await wait(300)
    await api(`/api/sessions/${resumed.body.id}`, null, 'DELETE')
  }
} else {
  console.log('  skip  agent resume — Claude Code is not installed on this machine')
}
for (const id of [shell.id, agent.id]) await api(`/api/sessions/${id}`, null, 'DELETE')

// ------------------------------------------------------------- attention

section('attention (what a session is still waiting to tell you)')
const attentionOf = async (id) =>
  (await api('/api/sessions', null, 'GET')).body.find((s) => s.id === id)?.attention ?? null

/* Its own folder, because a bare `/ws` connection opens a shell in the home
   directory and several of those are still around by now — the folder fallback
   below is about whether *this* folder names one session, not the busiest one
   on the machine. */
const FOLDER = path.join(HOME, 'attention-smoke')
fs.mkdirSync(FOLDER, { recursive: true })
const one = (await api('/api/sessions', { provider: 'shell', cwd: FOLDER, name: 'one' })).body
const two = (await api('/api/sessions', { provider: 'shell', cwd: FOLDER, name: 'two' })).body

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

/* The rule this whole feature turns on: `quiet` means "they can see this", and
   what they can see is one session — not "Orbit is open somewhere". */
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

const guessed = await api('/api/notify', { message: 'from a folder', source: FOLDER })
check(
  'two sessions in one folder make the folder no answer at all',
  guessed.body.sessionId === null,
  JSON.stringify(guessed.body),
)
await api(`/api/sessions/${two.id}`, null, 'DELETE')
await wait(400)
const lone = await api('/api/notify', { message: 'from the only one left', source: FOLDER })
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

await api(`/api/sessions/${one.id}`, null, 'DELETE')
await wait(400)
await api(`/api/sessions/${one.id}`, null, 'DELETE') // forget it entirely
check('a forgotten session takes its record with it', (await attentionOf(one.id)) === null)

// -------------------------------------------------------------------- git

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

const unstagedDiff = (await gitApi(`diff?cwd=${encodeURIComponent(REPO_DIR)}&file=kept.txt`, null, 'GET')).body
check('its diff shows both sides of the change', unstagedDiff.patch.includes('-two') && unstagedDiff.patch.includes('+TWO'))
const newDiff = (await gitApi(`diff?cwd=${encodeURIComponent(REPO_DIR)}&file=fresh.txt`, null, 'GET')).body
check('an untracked file still has a diff to read', newDiff.patch.includes('+brand new'), newDiff.patch.slice(0, 60))
check(
  'a path climbing out of the repository is refused',
  (await gitApi(`diff?cwd=${encodeURIComponent(REPO_DIR)}&file=..%2F..%2F.orbit%2Fconfig.json`, null, 'GET')).status === 400,
)

st = (await gitApi('stage', { cwd: REPO_DIR, files: ['kept.txt'], add: true })).body
check('staging moves it to the index', st.files.find((f) => f.path === 'kept.txt')?.staged === 'M')
const stagedDiff = (await gitApi(`diff?cwd=${encodeURIComponent(REPO_DIR)}&file=kept.txt&staged=1`, null, 'GET')).body
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

// ------------------------------------------------------------------- auth

section('auth')
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
  (await fetch(`${BASE}/api/sessions`, { headers: { cookie: `orbit_session=${'a'.repeat(64)}` } })).status === 401,
)
const shot = (await api('/api/screenshots', null, 'GET')).body[0]
check('images need the cookie', (await fetch(`${BASE}/api/screenshots/${shot.file}`)).status === 401)
check('…and load with it', (await fetch(`${BASE}/api/screenshots/${shot.file}`, withCookie())).status === 200)
check(
  'query-string auth is gone',
  (await fetch(`${BASE}/api/screenshots/${shot.file}?token=${TOKEN}`)).status === 401,
)

const socket = (url, opts, label) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, opts)
    let closed = null
    let ready = false
    ws.on('message', (m) => (ready ||= JSON.parse(m.toString()).type === 'ready'))
    ws.on('close', (code) => (closed = code))
    ws.on('error', () => {})
    setTimeout(() => {
      ws.close()
      resolve({ label, closed, ready })
    }, 1200)
  })

const wsUrl = `ws://127.0.0.1:${PORT}/ws`
const withCookieWs = await socket(wsUrl, { headers: { cookie } })
check('the socket accepts the cookie', withCookieWs.ready && !withCookieWs.closed)
const bare = await socket(wsUrl, {})
check('…and refuses no credential', bare.closed === 4001, `close ${bare.closed}`)
const queryWs = await socket(`${wsUrl}?token=${TOKEN}`, {})
check('…and refuses a query token', queryWs.closed === 4001, `close ${queryWs.closed}`)

// -------------------------------------------------------------------- mcp

section('mcp server')
const mcp = spawn('node', [path.join(REPO, 'server/dist/mcp.js')], { env: process.env })
let out = ''
mcp.stdout.on('data', (d) => (out += d))
const rpc = (msg) => mcp.stdin.write(`${JSON.stringify(msg)}\n`)
rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
await wait(500)
rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'orbit_capture', arguments: { url: BASE } } })
await wait(8000)
rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'orbit_capture', arguments: { url: 'http://127.0.0.1:4321' } } })
await wait(3000)
mcp.kill()

const replies = new Map(out.trim().split('\n').filter(Boolean).map((l) => {
  const m = JSON.parse(l)
  return [m.id, m]
}))
check('initialize', !!replies.get(1)?.result?.serverInfo)
check('four tools', replies.get(2)?.result?.tools?.length === 4,
  replies.get(2)?.result?.tools?.map((t) => t.name).join(', '))
const image = replies.get(3)?.result?.content?.find((c) => c.type === 'image')
check('a capture comes back as an image, not a path', !!image?.data, `${image?.data?.length ?? 0} base64 chars`)
check('a failed capture is an error the agent can read', replies.get(4)?.result?.isError === true)

// ------------------------------------------------------------------- hook

section('approval hook')
const runHook = (input, env = {}) =>
  new Promise((resolve) => {
    const h = spawn('node', [path.join(REPO, 'scripts/orbit-approve.mjs')], {
      env: { ...process.env, ...env },
    })
    let stdout = ''
    h.stdout.on('data', (d) => (stdout += d))
    h.on('close', () => resolve(stdout))
    h.stdin.end(JSON.stringify(input))
  })

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: HOME })
check('a safe command passes silently', (await runHook(bash('ls -la'))) === '')
check(
  'orbit being down does not block the agent',
  (await runHook(bash('rm -rf /tmp/x'), { ORBIT_PORT: '3999' })) === '',
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

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
