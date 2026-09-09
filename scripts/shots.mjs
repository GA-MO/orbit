#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const LIVE_PORT = '3001'
const PORT = process.env.ORBIT_PORT ?? '3099'
const BASE = `http://127.0.0.1:${PORT}`
const SCRATCH = process.env.ORBIT_HOME
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(REPO, 'docs/images')
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))

const PHONE = { width: 390, height: 844 }
const JPEG_QUALITY = 88
const TERMINAL_TIMEOUT_MS = 15000
const FAIL_SHOT = '/tmp/shot-fail.png'

if (BASE.includes(`:${LIVE_PORT}`)) {
  console.error(`refusing to run against port ${LIVE_PORT} — that is the real server`)
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

const SHOTS_ROOT = path.join(os.homedir(), '.orbit-shots')
const PROJECTS = path.join(SHOTS_ROOT, 'Projects')
const APP = path.join(PROJECTS, 'storefront')
const SIBLING_PROJECTS = ['api-gateway', 'design-system']
const DEV_PORT = 5199

const git = (...args) => execFileSync('git', ['-C', APP, ...args], { stdio: 'pipe' })

const DEV_SERVER_SOURCE = `import http from 'node:http'
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
`

const INDEX_HTML = `<!doctype html><meta charset="utf-8"><title>Storefront</title>
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
`

const CART_SOURCE = `export function total(items) {
  return items.reduce((sum, item) => sum + item.price, 0)
}

export function label(count) {
  return count === 1 ? '1 item' : count + ' items'
}
`

const CART_TEST_SOURCE = `import { total, label } from './cart.js'

console.assert(total([{ price: 320, qty: 2 }]) === 640, 'quantity counts')
console.assert(label(1) === '1 item', 'one is singular')
`

const writeInApp = (file, contents) => fs.writeFileSync(path.join(APP, file), contents)
const readInApp = (file) => fs.readFileSync(path.join(APP, file), 'utf8')

const buildDemoProject = () => {
  fs.rmSync(SHOTS_ROOT, { recursive: true, force: true })
  fs.mkdirSync(APP, { recursive: true })
  for (const sibling of SIBLING_PROJECTS) {
    fs.mkdirSync(path.join(PROJECTS, sibling), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', path.join(PROJECTS, sibling)])
  }

  writeInApp('server.mjs', DEV_SERVER_SOURCE)
  writeInApp('index.html', INDEX_HTML)
  writeInApp('cart.js', CART_SOURCE)

  execFileSync('git', ['init', '-q', '-b', 'main', APP])
  git('config', 'user.email', 'shots@example.com')
  git('config', 'user.name', 'Orbit')
  git('add', '.')
  git('commit', '-q', '-m', 'Storefront: product grid and a cart total')
}

const leaveUncommittedWork = () => {
  writeInApp('cart.test.js', CART_TEST_SOURCE)
  writeInApp(
    'index.html',
    readInApp('index.html').replace('<span class="cart">Cart · 2 items</span>', '<button class="cart">Cart · 2 items</button>'),
  )
  writeInApp(
    'cart.js',
    CART_SOURCE.replace(
      'return items.reduce((sum, item) => sum + item.price, 0)',
      'return items.reduce((sum, item) => sum + item.price * item.qty, 0)',
    ).replace("count + ' items'", "count.toLocaleString() + ' items'"),
  )
}

buildDemoProject()
leaveUncommittedWork()

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({
  viewport: PHONE,
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})

await context.addInitScript(() => {
  try {
    localStorage.setItem('orbit.micGranted', '1')
    localStorage.setItem('orbit.speechLang', 'th-TH')
  } catch {}
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
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: JPEG_QUALITY })
  taken.push(name)
  console.log(`  shot  ${name}`)
}
const wanted = (name) => only.length === 0 || only.includes(name)
const composeButton = page.locator('[aria-label^="Message"], [aria-label="Write a message"]').first()
const closeButton = () => page.locator('[aria-label="Close"]').first()
const messageBox = () => page.getByPlaceholder('Write here')
const tabButton = (name) => page.getByRole('button', { name }).first()

const openSession = async (id) => {
  await page.goto(`${BASE}/?session=${id}`)
  await page.waitForSelector('.xterm-screen', { timeout: TERMINAL_TIMEOUT_MS })
}

const focusTerminal = async () => {
  await page.locator('.xterm-screen').click()
  await wait(300)
}

const typeLine = async (line) => {
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

const PLAIN_PROMPT = "clear; export PS1='storefront $ '; exec zsh -f"

console.log(`\n── shots · ${BASE} ${'─'.repeat(28)}`)

await page.goto(BASE)
await wait(700)
if (wanted('01-login')) await shoot('01-login')

await page.fill('input', token)
await page.keyboard.press('Enter')
await wait(1200)

const makeSession = (name, opts) =>
  api('/api/sessions', { provider: 'shell', cwd: APP, name, ...opts })

const dev = await makeSession('storefront dev server')
if (!dev?.id) { console.error('  could not create a session:', JSON.stringify(dev)); process.exit(1) }
const scratch = await makeSession('notes')

const giveNotesSessionAHistory = async () => {
  await openSession(scratch.id)
  await wait(900)
  await focusTerminal()
  for (const line of [PLAIN_PROMPT, 'git --no-pager log --oneline -3', 'git status -sb', 'ls']) {
    await typeLine(line)
    await wait(900)
  }
}

const startDevServerInTerminal = async () => {
  await page.goto(`${BASE}/?session=${dev.id}`)
  try {
    await page.waitForSelector('.xterm-screen', { timeout: TERMINAL_TIMEOUT_MS })
  } catch (err) {
    await page.screenshot({ path: FAIL_SHOT })
    console.error(`  no terminal — see ${FAIL_SHOT}; page said:`, (await page.textContent('body')).slice(0, 300))
    throw err
  }
  await wait(800)
  await focusTerminal()
  await typeLine(PLAIN_PROMPT)
  await wait(1500)
  await typeLine('node server.mjs')
  await wait(2500)
  for (const route of ['/', '/cart', '/products/enamel-mug', '/favicon.ico']) {
    await fetch(`http://127.0.0.1:${DEV_PORT}${route}`).catch(() => {})
    await wait(250)
  }
  await wait(700)
}

await giveNotesSessionAHistory()
await startDevServerInTerminal()

if (wanted('02-terminal')) await shoot('02-terminal')

const shootMessageSheet = async () => {
  await composeButton.click()
  await wait(500)
  await messageBox().fill('ทำให้ปุ่ม Add to cart กดแล้วมีเสียงตอบสนองด้วย')
  await shoot('12-message')
  await closeButton().click()
  await wait(400)
}

const shootDictation = async () => {
  await page.locator('[aria-label="Dictate a message"]').click()
  await wait(1200)
  await shoot('07-voice')
  await closeButton().click()
  await wait(600)
  if (await messageBox().isVisible().catch(() => false)) {
    await messageBox().fill('')
    await closeButton().click()
    await wait(400)
  }
}

const shootApproval = async () => {
  await composeButton.click()
  await wait(400)
  await messageBox().fill('git push --force origin main')
  await page.getByRole('button', { name: 'Send' }).click()
  await wait(1200)
  await shoot('08-approval')
  await page.getByRole('button', { name: /deny/i }).click()
  await wait(600)
}

const shootChanges = async () => {
  await tabButton(/changes/i).click()
  await wait(2200)
  await shoot('11-changes')
}

const shootCaptures = async () => {
  await api('/api/screenshot', { url: `http://127.0.0.1:${DEV_PORT}/cart`, preset: 'desktop', label: `localhost:${DEV_PORT}/cart` })
  await api('/api/screenshot', { url: `http://127.0.0.1:${DEV_PORT}/`, preset: 'phone', label: `localhost:${DEV_PORT}` })
  await tabButton(/preview/i).click()
  await wait(2500)
  if (wanted('03-captures')) await shoot('03-captures')
  if (wanted('04-capture-viewer')) {
    await page.locator('figure img').first().click()
    await wait(1200)
    await shoot('04-capture-viewer')
    await page.locator('.scrim').first().click({ position: { x: 20, y: 20 } })
    await wait(500)
  }
}

const endNotesSession = async () => {
  await api(`/api/sessions/${scratch.id}`, null, 'DELETE')
  await wait(600)
}

const shootSessions = async () => {
  await api('/api/notify', {
    message: 'Claude is asking: keep the existing cart schema, or rewrite it?',
    sessionId: scratch.id,
    kind: 'waiting',
  })
  await tabButton(/sessions/i).click()
  await wait(1200)
  await shoot('09-sessions')
}

const shootNewSession = async () => {
  await tabButton(/sessions/i).click()
  await wait(800)
  await tabButton(/new session/i).click()
  await wait(1000)
  await shoot('05-new-session')
  await closeButton().click()
  await wait(400)
}

const shootEndedSession = async () => {
  await tabButton(/sessions/i).click()
  await wait(800)
  await page.getByText('notes').first().click()
  await wait(1500)
  await shoot('10-ended-readonly')
}

const answerTrustPrompt = async () => {
  if (!(await page.textContent('body'))?.includes('trust this folder')) return
  await page.keyboard.press('ArrowDown')
  await wait(400)
  await page.keyboard.press('Enter')
  await wait(6000)
}

const shootClaudeCode = async () => {
  const agent = await api('/api/sessions', { provider: 'claude', cwd: APP, name: 'storefront' })
  if (!agent?.id) {
    console.log('  skip  06-claude-code — no claude session could be started')
    return
  }
  await openSession(agent.id)
  await wait(6000)
  await page.locator('.xterm-screen').click()
  await answerTrustPrompt()
  await page.keyboard.type('อ่าน cart.js แล้วบอกสั้น ๆ ว่า total() คิดยอดยังไง')
  await wait(400)
  await page.keyboard.press('Enter')
  await wait(35000)
  await shoot('06-claude-code')
}

const endEverySession = async () => {
  for (const s of (await api('/api/sessions', null, 'GET'))?.sessions ?? []) {
    await api(`/api/sessions/${s.id}`, null, 'DELETE')
  }
}

if (wanted('12-message')) await shootMessageSheet()
if (wanted('07-voice')) await shootDictation()
if (wanted('08-approval')) await shootApproval()
if (wanted('11-changes')) await shootChanges()
if (wanted('03-captures') || wanted('04-capture-viewer')) await shootCaptures()
if (wanted('09-sessions') || wanted('10-ended-readonly')) await endNotesSession()
if (wanted('09-sessions')) await shootSessions()
if (wanted('05-new-session')) await shootNewSession()
if (wanted('10-ended-readonly')) await shootEndedSession()
if (wanted('06-claude-code')) await shootClaudeCode()

await endEverySession()

await browser.close()

console.log('')
console.log(`  ${taken.length} shot(s) written to docs/images`)
