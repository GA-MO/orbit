#!/usr/bin/env node
/**
 * Touch behaviour the phone cannot be asked to prove twice: tapping a link,
 * holding to select, dragging to extend, and copying out of the terminal.
 *
 * Runs against a throwaway Orbit — never the one you are using. `make
 * test-touch` sets one up and takes it down again; by hand:
 *
 *   rm -rf /tmp/orbit-smoke && mkdir -p /tmp/orbit-smoke
 *   HOME=/tmp/orbit-smoke ORBIT_PORT=3099 node server/dist/index.js &
*   bun scripts/touch-smoke.mjs                 # Chrome
 *   ENGINE=webkit bun scripts/touch-smoke.mjs   # WebKit — the engine iOS runs
 *
 * WebKit needs its browser once: `bunx playwright-core install webkit`.
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

/* Opening the app no longer starts a shell for you — a tab with nothing to
   reattach to stays empty and asks. So make the session this run needs, and
   arrive on it the way a notification does. */
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
  window.__held = null
  window.__touch = (type, x, y, selector) => {
    /* A real finger keeps sending its moves to the element the touch started
       on; dispatching by hand has to be told that, or a drag off the grip
       lands on the terminal underneath it.

       `hold` is that same truth taken all the way: the node is kept even after
       the document lets go of it, which is what the browser does and what this
       harness spent a bug not doing. Resolving the target afresh on every move
       quietly repaired a gesture that a real finger cannot repair. */
    if (selector === 'hold' && type !== 'touchstart') {
      if (!window.__held) return 'no-target'
      const kept = window.__held
      const state = kept.isConnected ? 'connected' : 'DETACHED'
      window.__dispatch(kept, type, x, y)
      return state
    }
    const target =
      (selector && selector !== 'hold' && document.querySelector(selector)) ||
      document.elementFromPoint(x, y) ||
      document.body
    if (selector === 'hold') window.__held = target
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
    return target.isConnected ? 'connected' : 'DETACHED'
  }
  window.__dispatch = (target, type, x, y) => {
    let t
    try {
      t = new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y })
    } catch {
      t = document.createTouch(window, target, 1, x, y, x, y)
    }
    const live = type === 'touchend' ? [] : [t]
    const list = document.createTouchList ? document.createTouchList(...live) : live
    const changed = document.createTouchList ? document.createTouchList(t) : [t]
    target.dispatchEvent(
      new TouchEvent(type, { bubbles: true, cancelable: true, touches: list, targetTouches: list, changedTouches: changed }),
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

await page.goto(`${BASE}/?session=${session.id}`)
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

// An address with the host left out — our own docs print this, and so does any
// program eliding a hostname. It used to be offered as a link, and following it
// could only ever open a frame with nothing in it.
await page.touchscreen.tap(screen.x + screen.width / 2, screen.y + screen.height * 0.7)
await page.waitForTimeout(400)
await page.keyboard.type(`clear; echo "open https://...:8443/ on the phone"\n`)
await page.waitForTimeout(1200)
const elided = await spanAt([':8443', '8443'])
await page.touchscreen.tap(elided.x, elided.y)
await page.waitForTimeout(800)
check(
  'an address with the host elided is not offered as a link',
  !(await page.locator('.app-fill.z-40').isVisible().catch(() => false)),
)

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

/* ── selecting ──────────────────────────────────────────────────────────────
   The selection does not happen on the terminal any more. A press and hold
   opens a panel holding a frozen copy of the buffer, where the platform's own
   selection — handles, loupe, double-tap, the callout menu — does the work.
   What is left to test is the two ends: that the press hands the panel the
   right word, and that a press which turns into a swipe hands it nothing. */
const PANEL = '[role="dialog"][aria-label="Select"]'
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
  (await bar()) === `${PATH.length} chars`,
  await bar(),
)
// The one thing that would silently make the whole panel useless: the app turns
// selection off over the terminal, and the panel has to turn it back on.
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
let clipLog = await page.evaluate(() => window.__clip)
check('the word leaves for the clipboard', clipLog.some((c) => c.ok), JSON.stringify(clipLog))
if (ENGINE === 'chromium') {
  const text = await page.evaluate(() => navigator.clipboard.readText().catch(() => null))
  check('a path is copied whole, not split on its slashes', text === PATH, JSON.stringify(text))
}

// A wrapped row is one line to a reader, and Line has to agree.
await page.getByRole('button', { name: 'Line' }).click()
await page.waitForTimeout(300)
check('Line takes the whole logical line', (await bar()) === '1 line', await bar())
await page.getByRole('button', { name: 'Copy' }).click()
await page.waitForTimeout(400)
if (ENGINE === 'chromium') {
  const text = await page.evaluate(() => navigator.clipboard.readText().catch(() => null))
  check(
    'the whole wrapped line comes back as one line',
    text === `${PATH} alpha beta`,
    JSON.stringify(text),
  )
}
check(
  'the panel carries the lines below it too',
  (await panelText()).includes('three'),
)
await closePanel()
check('closing the panel comes back to the terminal', !(await panelOpen()))

// Blank space is not text: below the output is a field of empty rows, and a
// panel opened onto one of them would be a panel opened onto nothing.
await hold(screen.x + screen.width / 2, screen.y + screen.height * 0.92)
await page.waitForTimeout(400)
check('holding on blank space opens nothing', !(await panelOpen()))

// The panel reaches past the screen, which is the other half of why it exists.
await page.touchscreen.tap(screen.x + screen.width / 2, screen.y + screen.height * 0.7)
await page.waitForTimeout(300)
await page.keyboard.type('clear; seq 1 200\n')
await page.waitForTimeout(1600)
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

/* The gesture this whole panel exists for. A finger that rests on text long
   enough to arm the press and then swipes is someone who meant to scroll — and
   because nothing is committed until the lift, they get the scroll and no
   panel. The in-place selection could only guess at this. */
const viewportTop = () =>
  page.evaluate(() => document.querySelector('.xterm-viewport')?.scrollTop ?? -1)
lines = await rows()
const restSpot = lines.find((r) => r.text.trim()) ?? { x: screen.x + 30, y: screen.y + screen.height * 0.5 }
const before = await viewportTop()
await touch('touchstart', restSpot.x, restSpot.y)
await page.waitForTimeout(600) // well past the press
for (let step = 1; step <= 6; step++) {
  await touch('touchmove', restSpot.x, restSpot.y + step * 40)
  await page.waitForTimeout(40)
}
await touch('touchend', restSpot.x, restSpot.y + 240)
await page.waitForTimeout(400)
check('a press that becomes a swipe opens no panel', !(await panelOpen()))
check('and scrolls instead', (await viewportTop()) < before, `${before} → ${await viewportTop()}`)

await page.touchscreen.tap(screen.x + screen.width / 2, screen.y + screen.height * 0.7)
await page.waitForTimeout(300)
await page.keyboard.type('echo still-typing-fine\n')
await page.waitForTimeout(1000)
lines = await rows()
check(
  'the terminal still takes input after all of it',
  lines.some((r) => r.text === 'still-typing-fine'),
)

/* ── the case the panel was built for ──────────────────────────────────────
   Claude Code runs on the alternate screen with mouse tracking on, and that is
   where selecting used to be impossible: xterm hands the touch to the app
   instead of scrolling, the buffer holds only the current frame, and every
   repaint moved whatever had been highlighted. The panel does not care — it
   takes a copy and stops. Written to a file rather than squeezed through
   `node -e`: the quoting breaks silently through a pty and costs an hour. */
const ALT_APP = `${HOME}/alt-app.mjs`
;(await import('node:fs')).writeFileSync(
  ALT_APP,
  [
    'process.stdout.write("\\u001b[?1049h\\u001b[?1000h\\u001b[?1002h\\u001b[?1006h")',
    /* Repaints, because that is the half that matters: xterm's DOM renderer
       builds a row's spans again every time the row changes, and a finger that
       landed on one of them is holding a node the document has dropped. An app
       that draws once cannot show that, and this test drew once for a while. */
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
await page.touchscreen.tap(screen.x + screen.width / 2, screen.y + screen.height * 0.7)
await page.waitForTimeout(300)
await page.keyboard.type(`node ${ALT_APP}\n`)
await page.waitForTimeout(1500)
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

/* ── the swipe that died on a glyph ────────────────────────────────────────
   A touch belongs for its whole life to the node it started on, and when a
   repaint takes that node out of the document the events keep going to it —
   detached, where no listener up the tree will ever see them. Landing on a
   glyph meant holding a span that xterm rebuilds on the next frame, so the
   scroll stopped after a notch or two while the same swipe from a blank row
   ran the whole way. Measured before the fix: 2 notches against 28. */
const notchesSent = async () => {
  const text = await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '')
  return Number(text.match(/UP=(\d+)/)?.[1] ?? -1)
}
const swipeFrom = async (spot) => {
  const before = await notchesSent()
  await touch('touchstart', spot.x, spot.y, 'hold')
  const states = []
  for (let i = 1; i <= 20; i++) {
    states.push(await touch('touchmove', spot.x, spot.y + i * 18, 'hold'))
    await page.waitForTimeout(40)
  }
  await touch('touchend', spot.x, spot.y + 360, 'hold')
  await page.waitForTimeout(300)
  return { notches: (await notchesSent()) - before, detached: states.filter((s) => s === 'DETACHED').length }
}
const glyphRow = (await rows()).find((r) => r.text.includes('frame-line-two'))
if (glyphRow) {
  const run = await swipeFrom(glyphRow)
  check(
    'a swipe that starts on a glyph is not dropped when the row repaints',
    run.detached === 0,
    `${run.detached}/20 moves went to a detached node`,
  )
  check(
    'and it scrolls the whole way, not a notch or two',
    run.notches >= 10,
    `${run.notches} notches`,
  )
}
await page.keyboard.press('Control+c')
await page.waitForTimeout(800)

/* The login screen probes /api before it has a token, and the run frames
   example.com, which has no page behind /a/b. Both of those 4xx are the test's
   own doing. */
const unexpected = errors.filter((e) => !/40[14]/.test(e))
check('no console errors', unexpected.length === 0, unexpected.join('; '))

await browser.close()
await api(`/api/sessions/${session.id}`, null, 'DELETE')

const failed = results.filter((r) => !r.pass)
console.log(failed.length ? `\n${failed.length} failed` : '\nAll checks passed.')
process.exit(failed.length ? 1 : 0)
