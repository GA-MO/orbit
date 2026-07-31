/**
 * Manual regression: natural finger scroll on Orbit terminal.
 * Run: node scripts/test-touch-scroll.mjs
 * Requires: server on :3001, playwright chromium installed.
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TOKEN = JSON.parse(readFileSync(join(homedir(), '.orbit/config.json'), 'utf8')).token
const URL = 'http://localhost:3001/'

const browser = await chromium.launch()
const context = await browser.newContext({
  hasTouch: true,
  viewport: { width: 390, height: 844 },
})
const page = await context.newPage()

const wsInputs = []
page.on('websocket', (ws) => {
  ws.on('framesent', (data) => {
    try {
      const msg = JSON.parse(data.payload.toString())
      if (msg.type === 'input') wsInputs.push(msg.data)
    } catch {}
  })
})

await page.goto(URL, { waitUntil: 'networkidle' })
await page.evaluate((t) => localStorage.setItem('orbit.token', t), TOKEN)
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('.xterm', { timeout: 15000 })
await page.waitForTimeout(2000)

// Fill scrollback
await page.keyboard.type('for i in $(seq 1 80); do echo line-$i; done')
await page.keyboard.press('Enter')
await page.waitForTimeout(1500)

const box = await page.locator('.xterm').boundingBox()
if (!box) throw new Error('no terminal box')

const cx = box.x + box.width / 2
const y1 = box.y + box.height * 0.7
const y2 = box.y + box.height * 0.25

const before = await page.evaluate(() => {
  const v = document.querySelector('.xterm-viewport')
  return v ? v.scrollTop : -1
})

// Real touch swipe (finger up = scroll up)
await page.touchscreen.tap(cx, y1)
await page.mouse.move(cx, y1)
await page.mouse.down()
await page.mouse.move(cx, y2, { steps: 15 })
await page.mouse.up()

// Playwright touchscreen API
await page.touchscreen.tap(cx, y1)
// Use CDP for proper touch sequence
const client = await page.context().newCDPSession(page)
await client.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x: cx, y: y1 }],
})
for (let y = y1; y >= y2; y -= 15) {
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: cx, y: y }],
  })
}
await client.send('Input.dispatchTouchEvent', {
  type: 'touchEnd',
  touchPoints: [],
})

await page.waitForTimeout(400)

const after = await page.evaluate(() => {
  const v = document.querySelector('.xterm-viewport')
  return v ? v.scrollTop : -1
})

const hasScrollPads = await page.getByLabel('Page up').count()
const arrowInputs = wsInputs.filter((d) => d === '\x1b[A' || d === '\x1b[B')
const pgInputs = wsInputs.filter((d) => d.includes('[5~') || d.includes('[6~'))

const results = {
  scrollBefore: before,
  scrollAfter: after,
  scrollDelta: after - before,
  normalScrollWorks: after < before,
  hasScrollPads,
  arrowKeyCount: arrowInputs.length,
  pageKeyCount: pgInputs.length,
  noPageKeysOnSwipe: pgInputs.length === 0,
}

console.log(JSON.stringify(results, null, 2))

const pass =
  results.normalScrollWorks &&
  results.hasScrollPads === 0 &&
  results.noPageKeysOnSwipe

await browser.close()
process.exit(pass ? 0 : 1)
