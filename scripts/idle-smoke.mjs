#!/usr/bin/env node
/**
 * Noticing that a session went quiet — the part that needs no server.
 *
 * `idle.ts` is two things: a rule about silence, and a guess at what to say
 * about it. Both are exercised here against a stand-in for a session, because
 * the alternative — driving a real agent from the smoke suite and waiting for
 * it to stop talking — proves the same thing far more slowly and only on a
 * machine where that agent is installed.
 *
 *   bun scripts/idle-smoke.mjs
 */
import * as idle from '../server/dist/idle.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Just enough of a Session for `watch`: the three streams it subscribes to. */
const fakeSession = () => {
  const data = new Set()
  const input = new Set()
  const exit = new Set()
  return {
    onData: (cb) => (data.add(cb), () => data.delete(cb)),
    onInput: (cb) => (input.add(cb), () => input.delete(cb)),
    onExit: (cb) => (exit.add(cb), () => exit.delete(cb)),
    say: (text) => data.forEach((cb) => cb(text)),
    type: (text) => input.forEach((cb) => cb(text)),
    end: () => exit.forEach((cb) => cb(0)),
  }
}

const QUIET = 120
const PLENTY = 'x'.repeat(300)

// ------------------------------------------------------------ what it says

section('the line it picks')

check(
  'escape sequences are not part of the message',
  idle.lastWord('\x1b[2J\x1b[1;1H\x1b[32mAll done\x1b[0m\r\n') === 'All done',
  JSON.stringify(idle.lastWord('\x1b[32mAll done\x1b[0m')),
)

check(
  'a window title is not the message',
  idle.lastWord('\x1b]0;claude — orbit\x07Ready when you are\n') === 'Ready when you are',
  JSON.stringify(idle.lastWord('\x1b]0;claude — orbit\x07Ready when you are\n')),
)

check(
  'the frame around a box is not part of it',
  idle.lastWord('╭──────────╮\n│ Continue? │\n╰──────────╯\n') === 'Continue?',
  JSON.stringify(idle.lastWord('╭──────────╮\n│ Continue? │\n╰──────────╯\n')),
)

/* The one that matters: what an agent stops on is a question, and what it draws
   *under* the question is its composer and a keyboard hint. */
const stopped = [
  'I can rename the file or leave it. Which do you want?',
  '',
  '╭─────────────────────────────────────╮',
  '│ >                                   │',
  '╰─────────────────────────────────────╯',
  '  ? for shortcuts',
].join('\n')
check(
  'a question wins over the composer drawn under it',
  idle.lastWord(stopped) === 'I can rename the file or leave it. Which do you want?',
  JSON.stringify(idle.lastWord(stopped)),
)

check(
  'with no question, the last real line',
  idle.lastWord('Wrote 3 files\nRan the tests\n  ? for shortcuts\n') === 'Ran the tests',
  JSON.stringify(idle.lastWord('Wrote 3 files\nRan the tests\n  ? for shortcuts\n')),
)

/* The real screen this came from: claude's banner, and then a single cell in
   the status bar repainted in place as remote control connected. Cursor-
   addressed, so it arrives last and looks like the bottom of the screen. */
check(
  'a cell repainted in place is not the bottom of the screen',
  idle.lastWord('1 MCP server needs authentication\n\x1b[H\x1b[63C\x1b[23B\x1b[32m/rc\x1b[39m') ===
    '1 MCP server needs authentication',
  JSON.stringify(
    idle.lastWord('1 MCP server needs authentication\n\x1b[H\x1b[63C\x1b[23B\x1b[32m/rc\x1b[39m'),
  ),
)

check('a fragment with nothing behind it says nothing', idle.lastWord('\x1b[32m/rc\x1b[39m') === null)

check(
  'a short question still counts — that is the whole point',
  idle.lastWord('Working\nRetry?\n') === 'Retry?',
  JSON.stringify(idle.lastWord('Working\nRetry?\n')),
)

check('nothing but frame says nothing', idle.lastWord('╭────╮\n│    │\n╰────╯') === null)
check('an empty screen says nothing', idle.lastWord('   \n\n \r\n') === null)

check(
  'a long line is cut, not sent whole',
  (idle.lastWord('A'.repeat(400)) ?? '').length === 120,
)

// --------------------------------------------------------- when it reports

section('when it reports')

const settled = []
const watched = (label) => {
  const session = fakeSession()
  idle.watch(session, (message) => settled.push({ label, message }), QUIET)
  return session
}
const reportsFor = (label) => settled.filter((s) => s.label === label)

const busy = watched('busy')
const quiet = watched('quiet')
const answered = watched('answered')
const barely = watched('barely')
const gone = watched('gone')
const echoed = watched('echoed')

quiet.say(`${PLENTY}\nAll finished. Anything else?\n`)
barely.say('ok\n')
gone.say(PLENTY)
gone.end()

/* Still drawing: an agent mid-tool repaints a spinner several times a second,
   which is exactly what stops this firing. */
busy.say(PLENTY)
const keepDrawing = setInterval(() => busy.say('.'), QUIET / 3)

/* Typed into after it stopped — the screen it settled on is spent, and nothing
   has been drawn since. */
answered.say(PLENTY)
await wait(QUIET / 2)
answered.type('yes\r')

/* The same, except the terminal echoes what was typed. That echo is output,
   and it restarts the clock — so what stops this one reporting is the turn's
   output count going back to zero, not the timer being cancelled. */
echoed.say(PLENTY)
await wait(QUIET / 2)
echoed.type('yes\r')
echoed.say('yes\r\n')

await wait(QUIET * 3)
clearInterval(keepDrawing)

check(
  'a session that stopped talking reports itself',
  reportsFor('quiet').length === 1,
  `${reportsFor('quiet').length} reports`,
)
check(
  '…with the last thing it said',
  reportsFor('quiet')[0]?.message === 'All finished. Anything else?',
  JSON.stringify(reportsFor('quiet')[0]?.message),
)
check('one still drawing does not', reportsFor('busy').length === 0)
check('one that was answered does not', reportsFor('answered').length === 0)
check('an echoed keystroke is not a turn', reportsFor('barely').length === 0)
check('…nor is the echo of an answer to the last one', reportsFor('echoed').length === 0)
check('one that exited does not', reportsFor('gone').length === 0)

/* Once per turn. A session left alone overnight must not report itself every
   ten seconds — the one thing a notification channel may never do. */
quiet.say(`${PLENTY}\nStill here.\n`)
await wait(QUIET * 3)
check('it does not repeat itself while nothing is answered', reportsFor('quiet').length === 1)

quiet.type('go\r')
quiet.say(`${PLENTY}\nDone again.\n`)
await wait(QUIET * 3)
check(
  'answering it arms the next one',
  reportsFor('quiet').length === 2 && reportsFor('quiet')[1]?.message === 'Done again.',
  JSON.stringify(reportsFor('quiet')[1]?.message),
)

console.log('')
console.log(failures === 0 ? '  idle: all good.' : `  idle: ${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
