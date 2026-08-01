#!/usr/bin/env node
/**
 * Touch behaviour the phone cannot be asked to prove twice: tapping a link,
 * holding to select, dragging to extend, and copying out of the terminal.
 *
 * Runs against a throwaway Orbit — never the one you are using:
 *
 *   rm -rf /tmp/orbit-smoke && mkdir -p /tmp/orbit-smoke
 *   HOME=/tmp/orbit-smoke ORBIT_PORT=3099 node server/dist/index.js &
 *   node scripts/touch-smoke.mjs                 # Chrome
 *   ENGINE=webkit node scripts/touch-smoke.mjs   # WebKit — the engine iOS runs
 *
 * WebKit needs its browser once: `npx playwright-core install webkit`.
 *
 * Taps go through Playwright's touchscreen, so they are real events that carry
 * the click the browser emulates after them — which is the whole reason the tap
 * handling is written the way it is. Press-and-hold has no such API, so those
 * are dispatched as touch events inside the page.
 */
import { chromium, webkit } from 'playwright-core'

const PORT = process.env.ORBIT_PORT ?? '3099'
const BASE = process.env.ORBIT_URL ?? `http://127.0.0.1:${PORT}`
const HOME = process.env.ORBIT_HOME ?? '/tmp/orbit-smoke'
const ENGINE = process.env.ENGINE === 'webkit' ? 'webkit' : 'chromium'

if (BASE.includes(':3001')) {
  console.error('refusing to run against port 3001 — that is the real server')
  process.exit(1)
}

const token =
  process.env.ORBIT_TOKEN ??
  JSON.parse((await import('node:fs')).readFileSync(`${HOME}/.orbit/config.json`, 'utf8')).token

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser =
  ENGINE === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: 'chrome' })

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
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
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
context.on('page', (p) => openedTabs.push(p.url()))

// Touch dispatch for press-and-hold, plus a record of how the copy actually left.
await page.addInitScript(() => {
  window.__touch = (type, x, y, selector) => {
    /* A real finger keeps sending its moves to the element the touch started
       on; dispatching by hand has to be told that, or a drag off the grip
       lands on the terminal underneath it. */
    const target =
      (selector && document.querySelector(selector)) || document.elementFromPoint(x, y) || document.body
    /* WebKit has a Touch interface but will not let you construct one; its
       createTouch() is the way in. Chromium is the other way around. */
    let touch
    try {
      touch = new Touch({
        identifier: 1,
        target,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
        screenX: x,
        screenY: y,
      })
    } catch {
      touch = document.createTouch(window, target, 1, x, y, x, y)
    }
    const live = type === 'touchend' ? [] : [touch]
    const list = document.createTouchList ? document.createTouchList(...live) : live
    const changed = document.createTouchList ? document.createTouchList(touch) : [touch]
    target.dispatchEvent(
      new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: list,
        targetTouches: list,
        changedTouches: changed,
      }),
    )
  }

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
const hold = async (x, y, ms = 700) => {
  await touch('touchstart', x, y)
  await page.waitForTimeout(ms)
  await touch('touchend', x, y)
}
const bar = () =>
  page
    .locator('text=/^\\d+ (chars?|lines?)$/')
    .first()
    .textContent()
    .catch(() => null)
const barCount = () => page.locator('text=/^\\d+ (chars?|lines?)$/').count()
const rows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.xterm-rows > div')]
      .map((row) => {
        const box = row.getBoundingClientRect()
        return { text: row.textContent.trim(), x: box.x + 30, y: box.y + box.height / 2 }
      })
      .filter((row) => row.text),
  )
/** The middle of a run of characters, found by column rather than by span:
    xterm draws a whole unstyled row as one span, whose centre is nowhere near
    the word you were aiming at. */
const charAt = (needle) =>
  page.evaluate((needle) => {
    const all = [...document.querySelectorAll('.xterm-rows > div')]
    // Short rows are not padded, so their own width says nothing about a cell.
    const cols = Math.max(...all.map((row) => (row.textContent ?? '').length))
    const grid = document.querySelector('.xterm-screen').getBoundingClientRect()
    const cell = grid.width / cols
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

console.log(`\n── ${ENGINE} · ${BASE} ${'─'.repeat(30)}`)

await page.goto(BASE)
await page.waitForTimeout(600)
await page.fill('input', token)
await page.keyboard.press('Enter')
await page.waitForSelector('.xterm-screen', { timeout: 15000 })
await page.waitForTimeout(1500)

const screen = await page.locator('.xterm-screen').boundingBox()
await page.touchscreen.tap(screen.x + screen.width / 2, screen.y + screen.height / 2)
await page.waitForTimeout(400)
check(
  'a tap opens the keyboard',
  await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')),
)

await page.keyboard.type(
  'clear; echo "see https://example.com/a/b, dev at http://localhost:5173/x"; echo two; echo three; echo four\n',
)
await page.waitForTimeout(1400)

const url = await spanAt(['example.com'])
await page.touchscreen.tap(url.x, url.y)
await page.waitForTimeout(800)
// A tap asks first: leaving for the browser costs the phone its session screen.
const shown = await page.getByRole('button', { name: 'Open here' }).isVisible().catch(() => false)
check('tapping a URL asks before leaving', shown && openedTabs.length === 0, JSON.stringify(openedTabs))
check(
  'the sheet survives the click the browser emulates after the tap',
  await page.locator('.app-fill.z-40').isVisible(),
)
check(
  'nothing in the sheet navigates the app away',
  !(await page.getByRole('button', { name: /browser/i }).isVisible().catch(() => false)),
)
await page.getByRole('button', { name: 'Open here' }).click()
await page.waitForTimeout(1200)
check(
  'an https link opens over the terminal, no tab',
  (await page.locator('iframe').getAttribute('src').catch(() => null)) === 'https://example.com/a/b' &&
    openedTabs.length === 0,
  JSON.stringify(openedTabs),
)
await page.locator('[aria-label="Close"]').first().click()
await page.waitForTimeout(400)

const local = await spanAt(['localhost', 'ocalhost', ':5173'])
await page.touchscreen.tap(local.x, local.y)
await page.waitForTimeout(800)
check(
  'a wrapped localhost URL is offered whole, pointed at this host',
  await page.locator('.app-fill.z-40 >> text=http://127.0.0.1:5173/x').first().isVisible().catch(() => false),
)
// Copy instead of open: the session never leaves the screen.
await page.getByRole('button', { name: 'Copy' }).click()
await page.waitForTimeout(600)
check('copying the link keeps the app where it is', openedTabs.length === 0, JSON.stringify(openedTabs))
if (ENGINE === 'chromium') {
  const link = await page.evaluate(() => navigator.clipboard.readText().catch(() => null))
  check('the rewritten link is what got copied', link === 'http://127.0.0.1:5173/x', JSON.stringify(link))
}
await page.waitForTimeout(500)

// A URL the program wrapped itself, exactly the way Claude Code writes it:
// carriage return, cursor right two columns, cursor down, then the rest. No
// isWrapped flag anywhere, and the continuation is indented.
await page.touchscreen.tap(screen.x + screen.width / 2, screen.y + screen.height * 0.7)
await page.waitForTimeout(400)
const HARD = 'https://example.com/orbit/deep/page.html'
await page.keyboard.type(
  `clear; printf 'docs: https://example.com/orbit/deep/page\\r\\033[2C\\033[1B.html\\n\\n'\n`,
)
await page.waitForTimeout(1200)
const half = await spanAt(['deep'])
await page.touchscreen.tap(half.x, half.y)
await page.waitForTimeout(800)
check(
  'a URL the program wrapped itself is tapped whole',
  await page.locator(`.app-fill.z-40 >> text=${HARD}`).first().isVisible().catch(() => false),
  HARD,
)
await page.locator('[aria-label="Close"]').first().click()
await page.waitForTimeout(400)

// The same shape, but the next line is prose: joining there would invent an
// address that resolves to the wrong page.
await page.touchscreen.tap(screen.x + screen.width / 2, screen.y + screen.height * 0.7)
await page.waitForTimeout(400)
await page.keyboard.type(
  `clear; printf 'see https://example.com/orbit\\r\\033[2C\\033[1Band more\\n\\n'\n`,
)
await page.waitForTimeout(1200)
const prose = await spanAt(['orbit'])
await page.touchscreen.tap(prose.x, prose.y)
await page.waitForTimeout(800)
const offered = await page.locator('.app-fill.z-40 p').first().textContent()
check(
  'a line of prose below a URL is not swallowed into it',
  offered.trim() === 'https://example.com/orbit',
  offered.trim(),
)
await page.locator('[aria-label="Close"]').first().click()
await page.waitForTimeout(400)

// A link Orbit serves itself opens inside Orbit: installed to the home screen,
// WebKit walks the app window over to a same-origin URL instead of opening a tab.
await page.touchscreen.tap(screen.x + screen.width / 2, screen.y + screen.height * 0.7)
await page.waitForTimeout(400)
await page.keyboard.type(`clear; echo ${BASE}/healthz\n`)
await page.waitForTimeout(1200)
const own = await spanAt(['healthz', '3099'])
await page.touchscreen.tap(own.x, own.y)
await page.waitForTimeout(800)
check(
  'a link Orbit serves offers to open inside the app',
  await page.getByRole('button', { name: 'Open here' }).isVisible().catch(() => false),
)
await page.getByRole('button', { name: 'Open here' }).click()
await page.waitForTimeout(1200)
const framed = await page.locator('iframe').getAttribute('src').catch(() => null)
check('it opens in a frame, not a new tab', framed === `${BASE}/healthz` && openedTabs.length === 0, `${framed} · tabs ${openedTabs.length}`)
check(
  'the terminal is still connected behind it',
  await page.evaluate(() => !!document.querySelector('.xterm-screen')),
)
await page.locator('[aria-label="Close"]').first().click()
await page.waitForTimeout(500)
check('closing the frame comes back to the terminal', (await page.locator('iframe').count()) === 0)

const PATH = '~/Development/orbit/web/src/Terminal.tsx'
// The sheet took the keyboard with it; a tap brings it back.
await page.touchscreen.tap(screen.x + screen.width / 2, screen.y + screen.height * 0.7)
await page.waitForTimeout(400)
await page.keyboard.type(`clear; echo "${PATH} alpha beta"; echo two; echo three; echo four\n`)
await page.waitForTimeout(1200)

// Press and hold takes the word under the finger — and a path is one word.
const pathSpot = await charAt('orbit/web')
await hold(pathSpot.x, pathSpot.y)
await page.waitForTimeout(300)
check('press and hold selects the word under the finger', (await bar()) === `${PATH.length} chars`, await bar())
check(
  'the selection is visible',
  await page.evaluate(() => !!document.querySelector('.bg-accent-strong\\/25')),
)
check('both grips are up', (await page.locator('[data-grip]').count()) === 2)

await page.getByRole('button', { name: 'Copy' }).click()
await page.waitForTimeout(400)
let clipLog = await page.evaluate(() => window.__clip)
check(
  'the word leaves for the clipboard',
  clipLog.some((c) => c.ok),
  JSON.stringify(clipLog),
)
if (ENGINE === 'chromium') {
  const text = await page.evaluate(() => navigator.clipboard.readText().catch(() => null))
  check('a path is copied whole, not split on its slashes', text === PATH, JSON.stringify(text))
}
await page.waitForTimeout(1000)
check('the bar goes away after copying', (await barCount()) === 0)

// Dragging the end grip walks the selection along the line, cell by cell.
const alpha = await charAt('alpha')
await hold(alpha.x, alpha.y)
await page.waitForTimeout(300)
check('a word in the middle of a line selects on its own', (await bar()) === '5 chars', await bar())
const GRIP = '[data-grip="end"]'
const grip = await page.locator(GRIP).boundingBox()
const beta = await charAt('beta')
await touch('touchstart', grip.x + grip.width / 2, grip.y + grip.height / 2, GRIP)
// Straight down off the end of the row: 'alpha' closes one row, 'beta' opens
// the next, and the drag runs past the right edge on the way — which used to
// land outside the grid and do nothing at all.
for (let step = 1; step <= 4; step++) {
  await touch('touchmove', grip.x + grip.width / 2, grip.y + ((beta.y - grip.y) * step) / 4, GRIP)
  await page.waitForTimeout(70)
}
await touch('touchend', grip.x + grip.width / 2, beta.y, GRIP)
await page.waitForTimeout(300)
check(
  'dragging a grip onto the next row extends the selection',
  (await bar()) === '10 chars',
  await bar(),
)

// And the bar can still take the whole line in one press.
await page.getByRole('button', { name: 'Line' }).click()
await page.waitForTimeout(300)
check('Line takes the whole logical line', (await bar()) === '1 line', await bar())
await page.getByRole('button', { name: 'Copy' }).click()
await page.waitForTimeout(400)
if (ENGINE === 'chromium') {
  const text = await page.evaluate(() => navigator.clipboard.readText().catch(() => null))
  check('the whole wrapped line comes back as one line', text === `${PATH} alpha beta`, JSON.stringify(text))
}
await page.waitForTimeout(900)

// Holding and dragging down still grows the selection by lines.
let lines = await rows()
const two = lines.find((r) => r.text === 'two')
const four = lines.find((r) => r.text === 'four')
await touch('touchstart', two.x, two.y)
await page.waitForTimeout(600)
for (let step = 1; step <= 4; step++) {
  await touch('touchmove', two.x, two.y + ((four.y - two.y) * step) / 4)
  await page.waitForTimeout(80)
}
await touch('touchend', two.x, four.y)
await page.waitForTimeout(300)
check('dragging down the screen grows it line by line', (await bar()) === '3 lines', await bar())

await page.getByRole('button', { name: 'Copy' }).click()
await page.waitForTimeout(400)
clipLog = await page.evaluate(() => window.__clip)
check(
  'the text leaves for the clipboard',
  clipLog.some((c) => c.ok),
  JSON.stringify(clipLog.slice(-1)),
)
if (ENGINE === 'chromium') {
  const text = await page.evaluate(() => navigator.clipboard.readText().catch(() => null))
  check('every dragged line is on the clipboard', text === 'two\nthree\nfour', JSON.stringify(text))
}
await page.waitForTimeout(1000)

lines = await rows()
await hold(lines[0].x, lines[0].y)
await page.waitForTimeout(250)
await page.touchscreen.tap(screen.x + screen.width / 2, screen.y + screen.height * 0.55)
await page.waitForTimeout(300)
check('a tap elsewhere dismisses the selection', (await barCount()) === 0)

await page.touchscreen.tap(screen.x + screen.width / 2, screen.y + screen.height / 2)
await page.waitForTimeout(200)
lines = await rows()
await hold(lines[0].x, lines[0].y)
await page.waitForTimeout(250)
await page.keyboard.type('seq 1 60\n')
await page.waitForTimeout(1300)
check('output scrolling drops a stale selection', (await barCount()) === 0)

await page.keyboard.type('echo still-typing-fine\n')
await page.waitForTimeout(1000)
lines = await rows()
check(
  'the terminal still takes input after all of it',
  lines.some((r) => r.text === 'still-typing-fine'),
)

// Blank space is not selectable: below the output is a field of empty rows, and
// a selection dragged into it comes back as a column of nothing.
await page.touchscreen.tap(screen.x + screen.width / 2, screen.y + screen.height * 0.7)
await page.waitForTimeout(300)
await page.keyboard.type('clear; echo top-line; echo bottom-line\n')
await page.waitForTimeout(1000)
await hold(screen.x + screen.width / 2, screen.y + screen.height * 0.75)
await page.waitForTimeout(400)
check('holding on blank space selects nothing', (await barCount()) === 0)
check(
  'and draws no highlight',
  await page.evaluate(() => !document.querySelector('.bg-accent-strong\\/25')),
)

lines = await rows()
const bottom = lines.find((r) => r.text === 'bottom-line')
await touch('touchstart', bottom.x, bottom.y)
await page.waitForTimeout(600)
for (let step = 1; step <= 4; step++) {
  await touch('touchmove', bottom.x, bottom.y + (screen.y + screen.height * 0.9 - bottom.y) * (step / 4))
  await page.waitForTimeout(70)
}
await touch('touchend', bottom.x, screen.y + screen.height * 0.9)
await page.waitForTimeout(300)
// The prompt below the output is text too, so the drag stops there — not in
// the blank rows under it, however far the finger goes.
const dragged = await bar()
check('dragging into the blank below stops at the last row with text', dragged === '2 lines', dragged)
await page.getByRole('button', { name: 'Copy' }).click()
await page.waitForTimeout(300)
if (ENGINE === 'chromium') {
  const text = await page.evaluate(() => navigator.clipboard.readText().catch(() => null))
  const picked = String(text).split('\n')
  check(
    'and brings back only lines that have something in them',
    picked.length === 2 && picked.every((line) => line.trim().length > 0),
    JSON.stringify(text),
  )
}
await page.waitForTimeout(900)


/* The login screen probes /api before it has a token, and the run frames
   example.com, which has no page behind /a/b. Both of those 4xx are the test's
   own doing. */
const unexpected = errors.filter((e) => !/40[14]/.test(e))
check('no console errors', unexpected.length === 0, unexpected.join('; '))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(failed.length ? `\n${failed.length} failed` : '\nAll checks passed.')
process.exit(failed.length ? 1 : 0)
