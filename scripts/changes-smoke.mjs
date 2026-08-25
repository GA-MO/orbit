#!/usr/bin/env node
/**
 * The Changes tab, driven the way a thumb drives it.
 *
 * What the API proves is that a hunk can be staged. What only the browser can
 * prove is that the button to do it is on screen, attached to the right hunk,
 * and that the words it changed are marked where they actually changed.
 *
 * Runs against a throwaway Orbit — never the one you are using:
 *
 *   scripts/test.sh changes
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const PORT = process.env.ORBIT_PORT ?? '3099'
const BASE = process.env.ORBIT_URL ?? `http://127.0.0.1:${PORT}`
const HOME = process.env.ORBIT_HOME ?? os.homedir()

if (BASE.includes(':3001')) {
  console.error('refusing to run against port 3001 — that is the real server')
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

// ---- a repository with two changes far enough apart to be two hunks --------

const REPO = path.join(HOME, 'changes-smoke')
fs.rmSync(REPO, { recursive: true, force: true })
fs.mkdirSync(REPO, { recursive: true })
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim()
execFileSync('git', ['init', '-b', 'main', REPO])
git('config', 'user.email', 'smoke@example.com')
git('config', 'user.name', 'Smoke')

const original = Array.from({ length: 24 }, (_, i) => `const value${i} = ${i}`)
fs.writeFileSync(path.join(REPO, 'app.ts'), original.join('\n') + '\n')
git('add', '.')
git('commit', '-m', 'first')

const edited = [...original]
// A renamed identifier at the top: one word of a long line, which is the whole
// case for marking words rather than lines.
edited[2] = 'const renamedValue2 = 2'
edited[21] = 'const value21 = 999'
fs.writeFileSync(path.join(REPO, 'app.ts'), edited.join('\n') + '\n')

const api = async (route, body, method = 'POST') => {
  const res = await fetch(BASE + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const session = (await api('/api/sessions', { provider: 'shell', cwd: REPO, name: 'changes' })).body

// ---- the phone ------------------------------------------------------------

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

console.log(`\n── changes · ${BASE} ${'─'.repeat(30)}`)

await page.goto(`${BASE}/?session=${session.id}`)
await page.waitForTimeout(600)
await page.fill('input', token)
await page.keyboard.press('Enter')
await page.waitForSelector('.xterm-screen', { timeout: 15000 })
await page.waitForTimeout(1200)
/* The 401 that put the login screen up is the app working, not the app
   failing. Everything from here on is a real error. */
errors.length = 0

await page.getByRole('button', { name: /changes/i }).first().click()
await page.waitForTimeout(1500)

check('the tab finds the repository the session is in', await page.getByText('main').first().isVisible())
const row = page.getByText('app.ts').first()
check('the changed file is listed', await row.isVisible())

await row.click()
await page.waitForTimeout(1200)

const hunkHeaders = await page.locator('text=/^@@ /').count()
check('two changes far apart are shown as two hunks', hunkHeaders === 2, `${hunkHeaders}`)

/* Scoped to the sheet and exact: "Stage all" sits in the list behind it, and a
   substring match would find that instead and click straight through. */
const sheet = page.locator('.app-fill.z-40')
const stageButtons = sheet.getByRole('button', { name: 'Stage', exact: true })
check('each hunk carries its own Stage button', (await stageButtons.count()) === 2, `${await stageButtons.count()}`)

/* The point of the whole thing: on the renamed line, only the identifier is
   marked — not the `const`, not the `= 2` that never moved. */
const marked = await page.evaluate(() =>
  [...document.querySelectorAll('span')]
    .filter((el) => /bg-(ok|danger)\/30/.test(el.className))
    .map((el) => el.textContent),
)
check('the words that changed are the words that are marked', marked.length > 0, JSON.stringify(marked))
check(
  '…and the rest of the line is not',
  marked.every((t) => !t.includes('const ')),
  JSON.stringify(marked),
)

await stageButtons.first().click()
await page.waitForTimeout(1500)

check(
  'staging one hunk stages one hunk',
  git('diff', '--cached', '--', 'app.ts').includes('renamedValue2') &&
    !git('diff', '--cached', '--', 'app.ts').includes('999'),
)
check('…and leaves the other where it was', git('diff', '--', 'app.ts').includes('999'))
/* Staging half a file is nearly always followed by staging another half of it,
   so the sheet stays where it is rather than sending you back to the list. */
check('the sheet stays open on what is left', await page.locator('text=/^@@ /').first().isVisible())
/* One hunk left is the whole file again, and the row already has a button for
   that — a per-hunk button beside it would be two ways to do one thing. */
const leftToStage = await sheet.getByRole('button', { name: 'Stage', exact: true }).count()
check('a lone remaining hunk is the whole file again, and says so by not asking', leftToStage === 0, `${leftToStage}`)

await sheet.locator('[aria-label="Close"]').first().click()
await page.waitForTimeout(800)
check('the file is now in both lists at once', await page.getByText('Staged').first().isVisible())

check('no console errors', errors.length === 0, errors.join(' | '))

await api(`/api/sessions/${session.id}`, null, 'DELETE')
await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${failed.length ? `${failed.length} check(s) FAILED.` : 'All checks passed.'}`)
process.exit(failed.length ? 1 : 0)
