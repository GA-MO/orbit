#!/usr/bin/env node
/**
 * The pictures in docs/ — taken by a script, from the app as it is now.
 *
 * These were hand-taken on a phone, which is why they aged: a UI change is a
 * commit, and re-photographing ten screens by thumb is an afternoon, so the
 * guide kept shipping a version of Orbit that no longer existed. This walks the
 * real app on a real Orbit and writes docs/images/*.png.
 *
 *   make shots                # everything
 *   make shots -- 08-approval # one scene, by name
 *
 * Run through scripts/shots.sh, which supplies the server. Two things about
 * that server matter here: `ORBIT_HOME` is scratch (so no session, capture or
 * token of yours is touched) while `HOME` is real (so a session it starts is
 * your shell, with your agent's credentials — the reason a picture of Claude
 * Code answering can be taken at all).
 *
 * Nothing points at your own directories. The project these shots are taken in
 * is built here, under the scratch directory, so the folder names that end up
 * in a published page are ones this file wrote.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const PORT = process.env.ORBIT_PORT ?? '3099'
const BASE = `http://127.0.0.1:${PORT}`
const SCRATCH = process.env.ORBIT_HOME
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(REPO, 'docs/images')
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))

if (BASE.includes(':3001')) {
  console.error('refusing to run against port 3001 — that is the real server')
  process.exit(1)
}
if (!SCRATCH || SCRATCH === os.homedir()) {
  console.error('ORBIT_HOME must be a scratch directory — run this through scripts/shots.sh')
  process.exit(1)
}

const token = JSON.parse(fs.readFileSync(path.join(SCRATCH, '.orbit/config.json'), 'utf8')).token

const api = async (route, body, method = 'POST') => {
  const res = await fetch(BASE + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  })
  return res.json().catch(() => null)
}

// ── a project to be photographed in ─────────────────────────────────────────
/* Everything visible in these shots comes from here: the folder name in the
   session header, the repository the Changes tab reads, and the page the
   Preview tab captures.

   Under the real home rather than the scratch directory, because Orbit refuses
   to start a session outside it — a rule worth more than the tidiness of
   keeping every generated thing in one place. Hidden, and removed again by
   scripts/shots.sh however the run ends. */
const PROJECTS = path.join(os.homedir(), '.orbit-shots', 'Projects')
const APP = path.join(PROJECTS, 'storefront')
const DEV_PORT = 5199

const git = (...args) => execFileSync('git', ['-C', APP, ...args], { stdio: 'pipe' })

fs.rmSync(path.join(os.homedir(), '.orbit-shots'), { recursive: true, force: true })
fs.mkdirSync(APP, { recursive: true })
for (const sibling of ['api-gateway', 'design-system']) {
  fs.mkdirSync(path.join(PROJECTS, sibling), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', path.join(PROJECTS, sibling)])
}

fs.writeFileSync(
  path.join(APP, 'server.mjs'),
  `import http from 'node:http'
import fs from 'node:fs'

const page = fs.readFileSync(new URL('./index.html', import.meta.url))

http
  .createServer((req, res) => {
    console.log(\`\\x1b[2m\${new Date().toLocaleTimeString()}\\x1b[0m  \\x1b[32m200\\x1b[0m  GET \${req.url}\`)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page)
  })
  .listen(${DEV_PORT}, () => {
    console.log('')
    console.log('  \\x1b[1mstorefront\\x1b[0m  dev server')
    console.log('  \\x1b[2m➜\\x1b[0m  Local:   \\x1b[36mhttp://localhost:${DEV_PORT}/\\x1b[0m')
    console.log('  \\x1b[2m➜\\x1b[0m  ready in 214 ms')
    console.log('')
  })
`,
)
fs.writeFileSync(
  path.join(APP, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Storefront</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin:0; font:16px/1.5 -apple-system, system-ui, sans-serif; background:#faf9f7; color:#1a1815 }
  header { padding:20px 24px; border-bottom:1px solid #e7e3dd; display:flex; justify-content:space-between; align-items:center }
  h1 { font-size:17px; margin:0; letter-spacing:.02em }
  .cart { font-size:13px; color:#6b6459 }
  main { padding:24px; display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)) }
  .card { border:1px solid #e7e3dd; border-radius:14px; background:#fff; overflow:hidden }
  .thumb { aspect-ratio:4/3; background:linear-gradient(140deg,#ded8cf,#f2efe9) }
  .body { padding:12px 14px }
  .name { font-size:14px; font-weight:600 }
  .price { font-size:13px; color:#6b6459; margin-top:2px }
</style>
<header><h1>Storefront</h1><span class="cart">Cart · 2 items</span></header>
<main>
  <div class="card"><div class="thumb"></div><div class="body"><div class="name">Field Notebook</div><div class="price">฿ 320</div></div></div>
  <div class="card"><div class="thumb"></div><div class="body"><div class="name">Enamel Mug</div><div class="price">฿ 450</div></div></div>
  <div class="card"><div class="thumb"></div><div class="body"><div class="name">Canvas Tote</div><div class="price">฿ 690</div></div></div>
  <div class="card"><div class="thumb"></div><div class="body"><div class="name">Linen Apron</div><div class="price">฿ 880</div></div></div>
</main>
`,
)
const CART = `export function total(items) {
  return items.reduce((sum, item) => sum + item.price, 0)
}

export function label(count) {
  return count === 1 ? '1 item' : count + ' items'
}
`
fs.writeFileSync(path.join(APP, 'cart.js'), CART)

execFileSync('git', ['init', '-q', '-b', 'main', APP])
git('config', 'user.email', 'shots@example.com')
git('config', 'user.name', 'Orbit')
git('add', '.')
git('commit', '-q', '-m', 'Storefront: product grid and a cart total')

/* Uncommitted work, so the Changes tab has something true to draw — a
   modification, a second modification, and a file git has never seen. */
fs.writeFileSync(
  path.join(APP, 'cart.test.js'),
  `import { total, label } from './cart.js'

console.assert(total([{ price: 320, qty: 2 }]) === 640, 'quantity counts')
console.assert(label(1) === '1 item', 'one is singular')
`,
)
fs.writeFileSync(
  path.join(APP, 'index.html'),
  fs
    .readFileSync(path.join(APP, 'index.html'), 'utf8')
    .replace('<span class="cart">Cart · 2 items</span>', '<button class="cart">Cart · 2 items</button>'),
)
/* Uncommitted work, so the Changes tab has something true to draw. */
fs.writeFileSync(
  path.join(APP, 'cart.js'),
  CART.replace(
    'return items.reduce((sum, item) => sum + item.price, 0)',
    'return items.reduce((sum, item) => sum + item.price * item.qty, 0)',
  ).replace("count + ' items'", "count.toLocaleString() + ' items'"),
)

// ── the phone ───────────────────────────────────────────────────────────────

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})

/* Chrome's recogniser needs a microphone and a network round trip, neither of
   which a headless run has — and the sheet under test is Orbit's, not Chrome's.
   So the recogniser is stubbed and everything drawn around it is the real
   component, in the state a real dictation puts it in. */
await context.addInitScript(() => {
  /* Skip the getUserMedia priming step: there is no microphone here, and the
     sheet would sit on "Waiting for microphone…" forever. */
  try {
    localStorage.setItem('orbit.micGranted', '1')
    localStorage.setItem('orbit.speechLang', 'th-TH')
  } catch {
    /* nothing to do — the stub below still runs */
  }
  class FakeRecognition {
    continuous = false
    interimResults = true
    lang = 'th-TH'
    onresult = null
    onend = null
    onerror = null
    start() {
      setTimeout(() => {
        const results = [[{ transcript: 'เพิ่มปุ่มลบสินค้าออกจากตะกร้า แล้วรันเทสต์ให้ด้วย' }]]
        this.onresult?.({ results })
      }, 300)
    }
    stop() {
      this.onend?.()
    }
    abort() {}
  }
  Object.assign(window, { webkitSpeechRecognition: FakeRecognition, SpeechRecognition: FakeRecognition })
})

/* Two views draw what is on the machine that took the picture: the folder
   picker lists the home directory, and the Preview tab lists every dev server
   running on it. On a working Mac that is a page of client names, and it would
   be published in the guide. So both are answered here with the project this
   script built — the same components, drawing a machine that only has the demo
   on it. Nothing else is intercepted. */
await context.route('**/api/ports', async (route) => {
  const found = await (await route.fetch()).json()
  await route.fulfill({
    json: (Array.isArray(found) ? found : []).filter((p) => p.port === DEV_PORT),
  })
})
await context.route('**/api/dirs*', async (route) => {
  await route.fulfill({
    json: {
      path: `${os.homedir()}/Projects`,
      parent: os.homedir(),
      isRepo: false,
      dirs: [
        { name: 'api-gateway', git: true },
        { name: 'design-system', git: true },
        { name: 'docs-site', git: true },
        { name: 'mobile-app', git: false },
        { name: 'storefront', git: true },
      ],
    },
  })
})

const page = await context.newPage()

const wait = (ms) => page.waitForTimeout(ms)
const taken = []
const shoot = async (name) => {
  await wait(250)
  /* JPEG, not PNG. These are 2x screenshots of a dark UI with a film grain on
     it, which is the worst case PNG has: the ten of them came to 7MB, and
     every re-run would add another 7MB to the repository's history for good.
     At q88 the same set is under a megabyte and the difference is invisible
     at the size anything displays them. */
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 88 })
  taken.push(name)
  console.log(`  shot  ${name}`)
}
const wanted = (name) => only.length === 0 || only.includes(name)
/* The pen relabels itself once there is a draft behind it. */
const composeButton = page.locator('[aria-label^="Message"], [aria-label="Write a message"]').first()

console.log(`\n── shots · ${BASE} ${'─'.repeat(28)}`)

// ── 01 · the way in ─────────────────────────────────────────────────────────
await page.goto(BASE)
await wait(700)
if (wanted('01-login')) await shoot('01-login')

await page.fill('input', token)
await page.keyboard.press('Enter')
await wait(1200)

// ── the sessions these shots are taken in ───────────────────────────────────
const make = (name, opts) =>
  api('/api/sessions', { provider: 'shell', cwd: APP, name, ...opts })

const dev = await make('storefront dev server')
if (!dev?.id) { console.error('  could not create a session:', JSON.stringify(dev)); process.exit(1) }
const scratch = await make('notes')

/* The session scene 10 photographs after it has ended. Given something to
   have done first: a transcript nobody wrote in is a blank screen, which says
   nothing about what reopening one is for. */
const plainPrompt = "clear; export PS1='storefront $ '; exec zsh -f"
await page.goto(`${BASE}/?session=${scratch.id}`)
await page.waitForSelector('.xterm-screen', { timeout: 15000 })
await wait(900)
await page.locator('.xterm-screen').click()
await wait(300)
/* --no-pager, or `less` takes the screen and the scrollback is a column of
   tildes. */
for (const line of [plainPrompt, 'git --no-pager log --oneline -3', 'git status -sb', 'ls']) {
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
  await wait(900)
}

await page.goto(`${BASE}/?session=${dev.id}`)
try {
  await page.waitForSelector('.xterm-screen', { timeout: 15000 })
} catch (err) {
  await page.screenshot({ path: '/tmp/shot-fail.png' })
  console.error('  no terminal — see /tmp/shot-fail.png; page said:', (await page.textContent('body')).slice(0, 300))
  throw err
}
await wait(800)
/* xterm only takes keystrokes once something in it has been touched. */
await page.locator('.xterm-screen').click()
await wait(300)
/* A prompt of our own. The one this machine draws is a themed prompt carrying
   a username, a hostname and the path to the scratch project — three facts
   about whoever ran `make shots`, in a picture that ends up in a published
   page. `zsh -f` inherits an exported PS1 and loads no theme, so what the
   screenshot shows is a shell, not a person. */
await page.keyboard.type(plainPrompt)
await page.keyboard.press('Enter')
await wait(1500)
await page.keyboard.type('node server.mjs')
await page.keyboard.press('Enter')
await wait(2500)
/* A few requests, so the log below the banner is a log and not one line. */
for (const route of ['/', '/cart', '/products/enamel-mug', '/favicon.ico']) {
  await fetch(`http://127.0.0.1:${DEV_PORT}${route}`).catch(() => {})
  await wait(250)
}
await wait(700)

if (wanted('02-terminal')) await shoot('02-terminal')

// ── 12 · the message sheet, and the key bar under it ────────────────────────
if (wanted('12-message')) {
  await composeButton.click()
  await wait(500)
  await page.getByPlaceholder('Write here').fill('ทำให้ปุ่ม Add to cart กดแล้วมีเสียงตอบสนองด้วย')
  await shoot('12-message')
  await page.locator('[aria-label="Close"]').first().click()
  await wait(400)
}

// ── 07 · dictation ──────────────────────────────────────────────────────────
if (wanted('07-voice')) {
  await page.locator('[aria-label="Dictate a message"]').click()
  await wait(1200)
  await shoot('07-voice')
  await page.locator('[aria-label="Close"]').first().click()
  await wait(600)
  /* Inserting is what the sheet does on the way out, and it opens the message
     sheet on the way. Clear it, or the next scene starts mid-sentence. */
  if (await page.getByPlaceholder('Write here').isVisible().catch(() => false)) {
    await page.getByPlaceholder('Write here').fill('')
    await page.locator('[aria-label="Close"]').first().click()
    await wait(400)
  }
}

// ── 08 · a command Orbit will not pass on unasked ───────────────────────────
if (wanted('08-approval')) {
  await composeButton.click()
  await wait(400)
  /* Harmless if it ever ran — there is no remote here — and matched by the
     screening patterns, which is the point. */
  await page.getByPlaceholder('Write here').fill('git push --force origin main')
  await page.getByRole('button', { name: 'Send' }).click()
  await wait(1200)
  await shoot('08-approval')
  await page.getByRole('button', { name: /deny/i }).click()
  await wait(600)
}

// ── 11 · what the agent wrote ───────────────────────────────────────────────
if (wanted('11-changes')) {
  await page.getByRole('button', { name: /changes/i }).first().click()
  await wait(2200)
  await shoot('11-changes')
}

// ── 03 / 04 · the running app, seen from the phone ──────────────────────────
if (wanted('03-captures') || wanted('04-capture-viewer')) {
  await api('/api/screenshot', { url: `http://127.0.0.1:${DEV_PORT}/cart`, preset: 'desktop', label: `localhost:${DEV_PORT}/cart` })
  await api('/api/screenshot', { url: `http://127.0.0.1:${DEV_PORT}/`, preset: 'phone', label: `localhost:${DEV_PORT}` })
  await page.getByRole('button', { name: /preview/i }).first().click()
  await wait(2500)
  if (wanted('03-captures')) await shoot('03-captures')
  if (wanted('04-capture-viewer')) {
    /* The newest capture is the first tile, and that is the phone-shaped one:
       a desktop capture zoomed to a phone screen is a stripe. */
    await page.locator('figure img').first().click()
    await wait(1200)
    await shoot('04-capture-viewer')
    /* The zoom is dismissed by tapping the scrim, not by a close button. */
    await page.locator('.scrim').first().click({ position: { x: 20, y: 20 } })
    await wait(500)
  }
}

// ── 09 · the sessions list, with one asking for you ─────────────────────────
if (wanted('09-sessions') || wanted('10-ended-readonly')) {
  await api(`/api/sessions/${scratch.id}`, null, 'DELETE')
  await wait(600)
}

if (wanted('09-sessions')) {
  await api('/api/notify', {
    message: 'Claude is asking: keep the existing cart schema, or rewrite it?',
    sessionId: scratch.id,
    kind: 'waiting',
  })
  await page.getByRole('button', { name: /sessions/i }).first().click()
  await wait(1200)
  await shoot('09-sessions')
}

// ── 05 · starting one ───────────────────────────────────────────────────────
if (wanted('05-new-session')) {
  await page.getByRole('button', { name: /sessions/i }).first().click()
  await wait(800)
  await page.getByRole('button', { name: /new session/i }).first().click()
  await wait(1000)
  await shoot('05-new-session')
  await page.locator('[aria-label="Close"]').first().click()
  await wait(400)
}

// ── 10 · a session that has ended ───────────────────────────────────────────
if (wanted('10-ended-readonly')) {
  await page.getByRole('button', { name: /sessions/i }).first().click()
  await wait(800)
  await page.getByText('notes').first().click()
  await wait(1500)
  await shoot('10-ended-readonly')
}

// ── 06 · the agent, answering ───────────────────────────────────────────────
if (wanted('06-claude-code')) {
  const agent = await api('/api/sessions', { provider: 'claude', cwd: APP, name: 'storefront' })
  if (agent?.id) {
    await page.goto(`${BASE}/?session=${agent.id}`)
    await page.waitForSelector('.xterm-screen', { timeout: 15000 })
    await wait(6000)
    await page.locator('.xterm-screen').click()
    /* A folder Claude Code has not been in before opens on its trust prompt,
       and everything after it waits on that answer. */
    if ((await page.textContent('body'))?.includes('trust this folder')) {
      await page.keyboard.press('ArrowDown')
      await wait(400)
      await page.keyboard.press('Enter')
      await wait(6000)
    }
    await page.keyboard.type('อ่าน cart.js แล้วบอกสั้น ๆ ว่า total() คิดยอดยังไง')
    await wait(400)
    await page.keyboard.press('Enter')
    await wait(35000)
    await shoot('06-claude-code')
  } else {
    console.log('  skip  06-claude-code — no claude session could be started')
  }
}

/* The PTYs are children of a server that is about to be killed, and a dev
   server left holding :5199 would meet the next run as a busy port. */
for (const s of (await api('/api/sessions', null, 'GET'))?.sessions ?? []) {
  await api(`/api/sessions/${s.id}`, null, 'DELETE')
}

await browser.close()

console.log('')
console.log(`  ${taken.length} shot(s) written to docs/images`)
