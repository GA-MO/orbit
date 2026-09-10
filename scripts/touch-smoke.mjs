#!/usr/bin/env node
import { chromium, webkit } from 'playwright-core'

const PORT = process.env.ORBIT_PORT ?? '3099'
const BASE = process.env.ORBIT_URL ?? `http://127.0.0.1:${PORT}`
const HOME = process.env.ORBIT_HOME ?? '/tmp/orbit-smoke'
const ENGINE = process.env.ENGINE === 'webkit' ? 'webkit' : 'chromium'

if (['7788', '3001'].some((p) => BASE.includes(`:${p}`))) {
  console.error('refusing to run against a live Orbit port (7788, 3001) — that is the real server')
  process.exit(1)
}

const fs = await import('node:fs')
const token = process.env.ORBIT_TOKEN ?? JSON.parse(fs.readFileSync(`${HOME}/.orbit/config.json`, 'utf8')).token

const PHONE_VIEWPORT = { width: 390, height: 844 }
const TERMINAL_APPEARS_MS = 15000
const HOLD_MS = 700
const WELL_PAST_THE_PRESS_MS = 600
const SCROLL_SWIPE = { steps: 6, stepPx: 40, pauseMs: 40 }
const GLYPH_SWIPE = { steps: 20, stepPx: 18, pauseMs: 40 }
const SHEET = '.app-fill.z-40'
const PANEL = '[role="dialog"][aria-label="Select"]'
const SELECTABLE_PATH = '~/Development/orbit/web/src/Terminal.tsx'
const URL_WRAPPED_BY_THE_PROGRAM = 'https://example.com/orbit/deep/page.html'
const ALT_SCREEN_APP_THAT_REPAINTS = `${HOME}/alt-app.mjs`
const SELF_INFLICTED_4XX = /40[14]/

const api = async (route, body, method = 'POST') => {
  const res = await fetch(BASE + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const session = (await api('/api/sessions', { provider: 'shell', cwd: HOME, name: 'touch' })).body

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser =
  ENGINE === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: 'chrome' })

const context = await browser.newContext({
  viewport: PHONE_VIEWPORT,
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
})
if (ENGINE === 'chromium') {
  await context
    .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
    .catch(() => {})
}

const page = await context.newPage()
const errors = []
const openedTabs = []
const collectConsoleErrors = (p) => p.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
collectConsoleErrors(page)
context.on('page', (p) => openedTabs.push(p.url()))

await page.addInitScript(() => {
  const makeTouch = (target, x, y) => {
    try {
      return new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y })
    } catch {
      return document.createTouch(window, target, 1, x, y, x, y)
    }
  }
  const dispatchTouch = (target, type, x, y) => {
    const touch = makeTouch(target, x, y)
    const live = type === 'touchend' ? [] : [touch]
    const touches = document.createTouchList ? document.createTouchList(...live) : live
    const changedTouches = document.createTouchList ? document.createTouchList(touch) : [touch]
    target.dispatchEvent(
      new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches }),
    )
  }
  const connectedOrDetached = (node) => (node.isConnected ? 'connected' : 'DETACHED')

  window.__held = null
  window.__touch = (type, x, y, selector) => {
    const keepStartNode = selector === 'hold'
    if (keepStartNode && type !== 'touchstart') {
      if (!window.__held) return 'no-target'
      const kept = window.__held
      const state = connectedOrDetached(kept)
      dispatchTouch(kept, type, x, y)
      return state
    }
    const target =
      (selector && !keepStartNode && document.querySelector(selector)) ||
      document.elementFromPoint(x, y) ||
      document.body
    if (keepStartNode) window.__held = target
    dispatchTouch(target, type, x, y)
    return connectedOrDetached(target)
  }
  window.__dispatch = dispatchTouch

  window.__clip = []
  const write = navigator.clipboard?.writeText?.bind(navigator.clipboard)
  if (write) {
    navigator.clipboard.writeText = (text) =>
      write(text).then(
        () => void window.__clip.push({ api: true, ok: true, length: text.length }),
        (err) => {
          window.__clip.push({ api: true, ok: false, error: err.name })
          throw err
        },
      )
  }
  const exec = document.execCommand.bind(document)
  document.execCommand = (command, ...rest) => {
    const ok = exec(command, ...rest)
    if (command === 'copy') window.__clip.push({ fallback: true, ok })
    return ok
  }
})

const touch = (type, x, y, selector) =>
  page.evaluate(([t, a, b, s]) => window.__touch(t, a, b, s), [type, x, y, selector ?? null])
const hold = async (x, y, ms = HOLD_MS) => {
  await touch('touchstart', x, y)
  await page.waitForTimeout(ms)
  await touch('touchend', x, y)
}
const selectionBar = () =>
  page
    .locator('text=/^\\d+ (chars?|lines?)$/')
    .first()
    .textContent()
    .catch(() => null)
const rows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.xterm-rows > div')]
      .map((row) => {
        const box = row.getBoundingClientRect()
        return { text: row.textContent.trim(), x: box.x + 30, y: box.y + box.height / 2 }
      })
      .filter((row) => row.text),
  )
const charAt = (needle) =>
  page.evaluate((needle) => {
    const all = [...document.querySelectorAll('.xterm-rows > div')]
    const longestRow = Math.max(...all.map((row) => (row.textContent ?? '').length))
    const grid = document.querySelector('.xterm-screen').getBoundingClientRect()
    const cell = grid.width / longestRow
    for (const row of all) {
      const index = (row.textContent ?? '').indexOf(needle)
      if (index < 0) continue
      const box = row.getBoundingClientRect()
      return { x: box.x + (index + needle.length / 2) * cell, y: box.y + box.height / 2, cell }
    }
    return null
  }, needle)

const spanAt = (needles) =>
  page.evaluate((needles) => {
    for (const row of document.querySelectorAll('.xterm-rows > div')) {
      for (const span of row.querySelectorAll('span')) {
        if (needles.some((n) => span.textContent?.includes(n))) {
          const box = span.getBoundingClientRect()
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        }
      }
    }
    return null
  }, needles)

const clipboardText = () => page.evaluate(() => navigator.clipboard.readText().catch(() => null))
const sheetVisible = () => page.locator(SHEET).isVisible().catch(() => false)
const openHereButton = () => page.getByRole('button', { name: 'Open here' })
const framedUrl = () => page.locator('iframe').getAttribute('src').catch(() => null)
const closeSheet = async (settleMs = 400) => {
  await page.locator('[aria-label="Close"]').first().click()
  await page.waitForTimeout(settleMs)
}
const tapThenWait = async (x, y, settleMs) => {
  await page.touchscreen.tap(x, y)
  await page.waitForTimeout(settleMs)
}

console.log(`\n── ${ENGINE} · ${BASE} ${'─'.repeat(30)}`)

await page.goto(`${BASE}/?session=${session.id}`)
await page.waitForTimeout(600)
await page.fill('input', token)
await page.keyboard.press('Enter')
await page.waitForSelector('.xterm-screen', { timeout: TERMINAL_APPEARS_MS })
await page.waitForTimeout(1500)

const screen = await page.locator('.xterm-screen').boundingBox()
const screenCentre = { x: screen.x + screen.width / 2, y: screen.y + screen.height / 2 }
const lowerTerminal = { x: screen.x + screen.width / 2, y: screen.y + screen.height * 0.7 }
const blankRowsBelowOutput = { x: screen.x + screen.width / 2, y: screen.y + screen.height * 0.92 }

const runInTerminal = async (command, { focusMs = 400, settleMs = 1200 } = {}) => {
  await tapThenWait(lowerTerminal.x, lowerTerminal.y, focusMs)
  await page.keyboard.type(`${command}\n`)
  await page.waitForTimeout(settleMs)
}
const tapWordThenWait = async (needles, settleMs = 800) => {
  const spot = await spanAt(needles)
  await tapThenWait(spot.x, spot.y, settleMs)
}

await tapThenWait(screenCentre.x, screenCentre.y, 400)
check(
  'a tap opens the keyboard',
  await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')),
)

await page.keyboard.type(
  'clear; echo "see https://example.com/a/b, dev at http://localhost:5173/x"; echo two; echo three; echo four\n',
)
await page.waitForTimeout(1400)

await tapWordThenWait(['example.com'])
const shown = await openHereButton().isVisible().catch(() => false)
check('tapping a URL asks before leaving', shown && openedTabs.length === 0, JSON.stringify(openedTabs))
check('the sheet survives the click the browser emulates after the tap', await page.locator(SHEET).isVisible())
check(
  'nothing in the sheet navigates the app away',
  !(await page.getByRole('button', { name: /browser/i }).isVisible().catch(() => false)),
)
await openHereButton().click()
await page.waitForTimeout(1200)
check(
  'an https link opens over the terminal, no tab',
  (await framedUrl()) === 'https://example.com/a/b' && openedTabs.length === 0,
  JSON.stringify(openedTabs),
)
await closeSheet()

await tapWordThenWait(['localhost', 'ocalhost', ':5173'])
check(
  'a wrapped localhost URL is offered whole, pointed at this host',
  await page.locator(`${SHEET} >> text=http://127.0.0.1:5173/x`).first().isVisible().catch(() => false),
)
await page.getByRole('button', { name: 'Copy' }).click()
await page.waitForTimeout(600)
check('copying the link keeps the app where it is', openedTabs.length === 0, JSON.stringify(openedTabs))
if (ENGINE === 'chromium') {
  const link = await clipboardText()
  check('the rewritten link is what got copied', link === 'http://127.0.0.1:5173/x', JSON.stringify(link))
}
await page.waitForTimeout(500)

await runInTerminal(`clear; printf 'docs: https://example.com/orbit/deep/page\\r\\033[2C\\033[1B.html\\n\\n'`)
await tapWordThenWait(['deep'])
check(
  'a URL the program wrapped itself is tapped whole',
  await page.locator(`${SHEET} >> text=${URL_WRAPPED_BY_THE_PROGRAM}`).first().isVisible().catch(() => false),
  URL_WRAPPED_BY_THE_PROGRAM,
)
await closeSheet()

await runInTerminal(`clear; printf 'see https://example.com/orbit\\r\\033[2C\\033[1Band more\\n\\n'`)
await tapWordThenWait(['orbit'])
const offered = await page.locator(`${SHEET} p`).first().textContent()
check(
  'a line of prose below a URL is not swallowed into it',
  offered.trim() === 'https://example.com/orbit',
  offered.trim(),
)
await closeSheet()

await runInTerminal(`clear; echo "open https://...:8443/ on the phone"`)
await tapWordThenWait([':8443', '8443'])
check('an address with the host elided is not offered as a link', !(await sheetVisible()))

await runInTerminal(`clear; echo ${BASE}/healthz`)
await tapWordThenWait(['healthz', '3099'])
check(
  'a link Orbit serves offers to open inside the app',
  await openHereButton().isVisible().catch(() => false),
)
await openHereButton().click()
await page.waitForTimeout(1200)
const framed = await framedUrl()
check('it opens in a frame, not a new tab', framed === `${BASE}/healthz` && openedTabs.length === 0, `${framed} · tabs ${openedTabs.length}`)
check(
  'the terminal is still connected behind it',
  await page.evaluate(() => !!document.querySelector('.xterm-screen')),
)
await closeSheet(500)
check('closing the frame comes back to the terminal', (await page.locator('iframe').count()) === 0)

await runInTerminal(`clear; echo "${SELECTABLE_PATH} alpha beta"; echo two; echo three; echo four`)

const panelOpen = async () => (await page.locator(PANEL).count()) > 0
const panelText = () =>
  page.evaluate(() => document.querySelector('[role="dialog"] pre')?.textContent ?? '')
const closePanel = async () => {
  await page.locator(`${PANEL} [aria-label="Close"]`).click()
  await page.waitForTimeout(400)
}

const pathSpot = await charAt('orbit/web')
await hold(pathSpot.x, pathSpot.y)
await page.waitForTimeout(400)
check('press and hold opens the panel', await panelOpen())
check(
  'with the word under the finger already picked',
  (await selectionBar()) === `${SELECTABLE_PATH.length} chars`,
  await selectionBar(),
)
check(
  'and the text is selectable by the platform',
  await page.evaluate(() => {
    const pre = document.querySelector('[role="dialog"] pre')
    const style = pre && getComputedStyle(pre)
    return !!style && (style.webkitUserSelect || style.userSelect) === 'text'
  }),
)

await page.getByRole('button', { name: 'Copy' }).click()
await page.waitForTimeout(400)
const clipLog = await page.evaluate(() => window.__clip)
check('the word leaves for the clipboard', clipLog.some((c) => c.ok), JSON.stringify(clipLog))
if (ENGINE === 'chromium') {
  const text = await clipboardText()
  check('a path is copied whole, not split on its slashes', text === SELECTABLE_PATH, JSON.stringify(text))
}

await page.getByRole('button', { name: 'Line' }).click()
await page.waitForTimeout(300)
check('Line takes the whole logical line', (await selectionBar()) === '1 line', await selectionBar())
await page.getByRole('button', { name: 'Copy' }).click()
await page.waitForTimeout(400)
if (ENGINE === 'chromium') {
  const text = await clipboardText()
  check(
    'the whole wrapped line comes back as one line',
    text === `${SELECTABLE_PATH} alpha beta`,
    JSON.stringify(text),
  )
}
check(
  'the panel carries the lines below it too',
  (await panelText()).includes('three'),
)
await closePanel()
check('closing the panel comes back to the terminal', !(await panelOpen()))

await hold(blankRowsBelowOutput.x, blankRowsBelowOutput.y)
await page.waitForTimeout(400)
check('holding on blank space opens nothing', !(await panelOpen()))

await runInTerminal('clear; seq 1 200', { focusMs: 300, settleMs: 1600 })
let lines = await rows()
const anchorRow = lines.find((r) => r.text.trim())
await hold(anchorRow.x, anchorRow.y)
await page.waitForTimeout(400)
const carried = (await panelText()).split('\n')
check(
  'the panel holds the scrollback, not just the screen',
  carried.length > lines.length && carried.includes('1'),
  `${carried.length} lines vs ${lines.length} on screen`,
)
await closePanel()

const viewportTop = () =>
  page.evaluate(() => document.querySelector('.xterm-viewport')?.scrollTop ?? -1)
lines = await rows()
const restSpot = lines.find((r) => r.text.trim()) ?? { x: screen.x + 30, y: screen.y + screen.height * 0.5 }
const before = await viewportTop()
await touch('touchstart', restSpot.x, restSpot.y)
await page.waitForTimeout(WELL_PAST_THE_PRESS_MS)
for (let step = 1; step <= SCROLL_SWIPE.steps; step++) {
  await touch('touchmove', restSpot.x, restSpot.y + step * SCROLL_SWIPE.stepPx)
  await page.waitForTimeout(SCROLL_SWIPE.pauseMs)
}
await touch('touchend', restSpot.x, restSpot.y + SCROLL_SWIPE.steps * SCROLL_SWIPE.stepPx)
await page.waitForTimeout(400)
check('a press that becomes a swipe opens no panel', !(await panelOpen()))
check('and scrolls instead', (await viewportTop()) < before, `${before} → ${await viewportTop()}`)

await runInTerminal('echo still-typing-fine', { focusMs: 300, settleMs: 1000 })
lines = await rows()
check(
  'the terminal still takes input after all of it',
  lines.some((r) => r.text === 'still-typing-fine'),
)

fs.writeFileSync(
  ALT_SCREEN_APP_THAT_REPAINTS,
  [
    'process.stdout.write("\\u001b[?1049h\\u001b[?1000h\\u001b[?1002h\\u001b[?1006h")',
    'let up = 0',
    'const draw = () => process.stdout.write(',
    '  "\\u001b[H\\u001b[2Kframe-line-one\\r\\n\\u001b[2Kframe-line-two\\r\\n\\u001b[2KUP=" + up)',
    'setInterval(draw, 120)',
    'draw()',
    'process.stdin.setRawMode(true)',
    'process.stdin.on("data", (b) => {',
    '  if (b[0] === 3) { process.stdout.write("\\u001b[?1049l"); process.exit(0) }',
    '  for (const m of b.toString("binary").matchAll(/\\u001b\\[<64;\\d+;\\d+M/g)) { void m; up++ }',
    '  draw()',
    '})',
  ].join('\n'),
)
await runInTerminal(`node ${ALT_SCREEN_APP_THAT_REPAINTS}`, { focusMs: 300, settleMs: 1500 })
check(
  'the app really did take the screen',
  await page.evaluate(() => !!document.querySelector('.xterm-screen')),
)
const frameRow = (await rows()).find((r) => r.text.includes('frame-line-one'))
check('and its frame is on screen', !!frameRow, JSON.stringify((await rows()).map((r) => r.text)))
if (frameRow) {
  await hold(frameRow.x, frameRow.y)
  await page.waitForTimeout(400)
  check('a press on an app that owns the screen still opens the panel', await panelOpen())
  check(
    'and the panel holds the frame it was showing',
    (await panelText()).includes('frame-line-two'),
  )
  await closePanel()
}

const scrollNotchesTheAppReceived = async () => {
  const text = await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '')
  return Number(text.match(/UP=(\d+)/)?.[1] ?? -1)
}
const swipeHoldingTheStartNode = async (spot) => {
  const before = await scrollNotchesTheAppReceived()
  await touch('touchstart', spot.x, spot.y, 'hold')
  const states = []
  for (let i = 1; i <= GLYPH_SWIPE.steps; i++) {
    states.push(await touch('touchmove', spot.x, spot.y + i * GLYPH_SWIPE.stepPx, 'hold'))
    await page.waitForTimeout(GLYPH_SWIPE.pauseMs)
  }
  await touch('touchend', spot.x, spot.y + GLYPH_SWIPE.steps * GLYPH_SWIPE.stepPx, 'hold')
  await page.waitForTimeout(300)
  return {
    notches: (await scrollNotchesTheAppReceived()) - before,
    detached: states.filter((s) => s === 'DETACHED').length,
  }
}
const glyphRow = (await rows()).find((r) => r.text.includes('frame-line-two'))
if (glyphRow) {
  const swipe = await swipeHoldingTheStartNode(glyphRow)
  check(
    'a swipe that starts on a glyph is not dropped when the row repaints',
    swipe.detached === 0,
    `${swipe.detached}/${GLYPH_SWIPE.steps} moves went to a detached node`,
  )
  check(
    'and it scrolls the whole way, not a notch or two',
    swipe.notches >= 10,
    `${swipe.notches} notches`,
  )
}
await page.keyboard.press('Control+c')
await page.waitForTimeout(800)

const phoneWithNothingStored = async () => {
  const fresh = await browser.newContext({ viewport: PHONE_VIEWPORT, hasTouch: true, isMobile: true })
  const p = await fresh.newPage()
  collectConsoleErrors(p)
  return { context: fresh, page: p }
}

{
  const minted = (await api('/api/auth/pair-code', {})).body
  const fresh = await phoneWithNothingStored()
  await fresh.page.goto(`${BASE}/#pair=${minted.code}`)
  const paired = await fresh.page
    .waitForFunction((t) => localStorage.getItem('orbit.token') === t, token, { timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  check('an address with a pairing code pairs the phone by itself', paired)
  check('…and the code is gone from the address bar', (await fresh.page.evaluate(() => location.hash)) === '')
  await fresh.page.waitForTimeout(600)
  check('…with no login screen in the way', (await fresh.page.getByPlaceholder('Access token').count()) === 0)
  await fresh.page.close()

  await fresh.context.close()

  const blank = await phoneWithNothingStored()
  await blank.page.goto(`${BASE}/#pair=nope-not-a-code`)
  const explained = await blank.page
    .getByText('pairing code has expired')
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  check('a stale code lands on the login screen and says so', explained)
  await blank.context.close()
}

const unexpected = errors.filter((e) => !SELF_INFLICTED_4XX.test(e))
check('no console errors', unexpected.length === 0, unexpected.join('; '))

await browser.close()
await api(`/api/sessions/${session.id}`, null, 'DELETE')

const failed = results.filter((r) => !r.pass)
console.log(failed.length ? `\n${failed.length} failed` : '\nAll checks passed.')
process.exit(failed.length ? 1 : 0)
