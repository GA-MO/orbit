#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const LIVE_PORTS = ['7788', '3001']
const PORT = process.env.ORBIT_PORT ?? '3099'
const BASE = process.env.ORBIT_URL ?? `http://127.0.0.1:${PORT}`
const HOME = process.env.ORBIT_HOME ?? os.homedir()

const PHONE = { width: 390, height: 844 }
const LOGIN_SETTLE_MS = 600
const TERMINAL_TIMEOUT_MS = 15000
const TERMINAL_SETTLE_MS = 1200
const TAB_SETTLE_MS = 1500
const SHEET_SETTLE_MS = 1200
const STAGE_SETTLE_MS = 1500
const CLOSE_SETTLE_MS = 800

const LINE_COUNT = 24
const RENAMED_LINE = 2
const RENUMBERED_LINE = 21

const live = LIVE_PORTS.find((port) => BASE.includes(`:${port}`))
if (live) {
  console.error(`refusing to run against port ${live} — a real server answers there`)
  process.exit(1)
}

const token =
  process.env.ORBIT_TOKEN ??
  JSON.parse(fs.readFileSync(path.join(HOME, '.orbit', 'config.json'), 'utf8')).token

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const REPO = path.join(HOME, 'changes-smoke')
const APP_FILE = path.join(REPO, 'app.ts')
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim()

const makeRepoWithTwoHunks = () => {
  fs.rmSync(REPO, { recursive: true, force: true })
  fs.mkdirSync(REPO, { recursive: true })
  execFileSync('git', ['init', '-b', 'main', REPO])
  git('config', 'user.email', 'smoke@example.com')
  git('config', 'user.name', 'Smoke')

  const original = Array.from({ length: LINE_COUNT }, (_, i) => `const value${i} = ${i}`)
  fs.writeFileSync(APP_FILE, original.join('\n') + '\n')
  git('add', '.')
  git('commit', '-m', 'first')

  const edited = [...original]
  edited[RENAMED_LINE] = `const renamedValue${RENAMED_LINE} = ${RENAMED_LINE}`
  edited[RENUMBERED_LINE] = `const value${RENUMBERED_LINE} = 999`
  fs.writeFileSync(APP_FILE, edited.join('\n') + '\n')
}

makeRepoWithTwoHunks()

const api = async (route, body, method = 'POST') => {
  const res = await fetch(BASE + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const session = (await api('/api/sessions', { provider: 'shell', cwd: REPO, name: 'changes' })).body

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({
  viewport: PHONE,
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const logIn = async () => {
  await page.goto(`${BASE}/?session=${session.id}`)
  await page.waitForTimeout(LOGIN_SETTLE_MS)
  await page.fill('input', token)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.xterm-screen', { timeout: TERMINAL_TIMEOUT_MS })
  await page.waitForTimeout(TERMINAL_SETTLE_MS)
  errors.length = 0
}

const hunkHeaders = () => page.locator('text=/^@@ /')

const markedWords = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('span')]
      .filter((el) => /bg-(ok|danger)\/30/.test(el.className))
      .map((el) => el.textContent),
  )

const stagedDiff = () => git('diff', '--cached', '--', 'app.ts')
const unstagedDiff = () => git('diff', '--', 'app.ts')

console.log(`\n── changes · ${BASE} ${'─'.repeat(30)}`)

await logIn()

await page.getByRole('button', { name: /changes/i }).first().click()
await page.waitForTimeout(TAB_SETTLE_MS)

check('the tab finds the repository the session is in', await page.getByText('main').first().isVisible())
const row = page.getByText('app.ts').first()
check('the changed file is listed', await row.isVisible())

await row.click()
await page.waitForTimeout(SHEET_SETTLE_MS)

const hunkCount = await hunkHeaders().count()
check('two changes far apart are shown as two hunks', hunkCount === 2, `${hunkCount}`)

const sheet = page.locator('.app-fill.z-40')
const stageButtons = sheet.getByRole('button', { name: 'Stage', exact: true })
check('each hunk carries its own Stage button', (await stageButtons.count()) === 2, `${await stageButtons.count()}`)

const marked = await markedWords()
check('the words that changed are the words that are marked', marked.length > 0, JSON.stringify(marked))
check(
  '…and the rest of the line is not',
  marked.every((t) => !t.includes('const ')),
  JSON.stringify(marked),
)

await stageButtons.first().click()
await page.waitForTimeout(STAGE_SETTLE_MS)

check(
  'staging one hunk stages one hunk',
  stagedDiff().includes('renamedValue2') && !stagedDiff().includes('999'),
)
check('…and leaves the other where it was', unstagedDiff().includes('999'))
check('the sheet stays open on what is left', await hunkHeaders().first().isVisible())
const leftToStage = await sheet.getByRole('button', { name: 'Stage', exact: true }).count()
check('a lone remaining hunk is the whole file again, and says so by not asking', leftToStage === 0, `${leftToStage}`)

await sheet.locator('[aria-label="Close"]').first().click()
await page.waitForTimeout(CLOSE_SETTLE_MS)
check('the file is now in both lists at once', await page.getByText('Staged').first().isVisible())

check('no console errors', errors.length === 0, errors.join(' | '))

await api(`/api/sessions/${session.id}`, null, 'DELETE')
await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${failed.length ? `${failed.length} check(s) FAILED.` : 'All checks passed.'}`)
process.exit(failed.length ? 1 : 0)
