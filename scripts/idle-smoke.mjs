#!/usr/bin/env node
import * as idle from '../server/dist/idle.js'

const SECTION_WIDTH = 58
const QUIET_MS = 120
const REDRAW_EVERY_MS = QUIET_MS / 3
const HALF_QUIET_MS = QUIET_MS / 2
const WELL_PAST_QUIET_MS = QUIET_MS * 3
const PLENTY = 'x'.repeat(300)
const MESSAGE_LIMIT = 120

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, SECTION_WIDTH - title.length))}`)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fakeSession = () => {
  const dataListeners = new Set()
  const inputListeners = new Set()
  const exitListeners = new Set()
  return {
    onData: (cb) => (dataListeners.add(cb), () => dataListeners.delete(cb)),
    onInput: (cb) => (inputListeners.add(cb), () => inputListeners.delete(cb)),
    onExit: (cb) => (exitListeners.add(cb), () => exitListeners.delete(cb)),
    say: (text) => dataListeners.forEach((cb) => cb(text)),
    type: (text) => inputListeners.forEach((cb) => cb(text)),
    end: () => exitListeners.forEach((cb) => cb(0)),
  }
}

const lastWordIs = (label, screen, expected) =>
  check(label, idle.lastWord(screen) === expected, JSON.stringify(idle.lastWord(screen)))

section('the line it picks')

check(
  'escape sequences are not part of the message',
  idle.lastWord('\x1b[2J\x1b[1;1H\x1b[32mAll done\x1b[0m\r\n') === 'All done',
  JSON.stringify(idle.lastWord('\x1b[32mAll done\x1b[0m')),
)

lastWordIs('a window title is not the message', '\x1b]0;claude — orbit\x07Ready when you are\n', 'Ready when you are')

lastWordIs('the frame around a box is not part of it', '╭──────────╮\n│ Continue? │\n╰──────────╯\n', 'Continue?')

const codexPainted = (answer) =>
  `\x1b[13;1H• ${answer}\x1b[19;1H› Ask Codex to do anything\x1b[20;3Hgpt-5.6-terra default · /Users/x/project`

lastWordIs(
  'a screen painted row by row is read as rows, not as one long line',
  codexPainted('The migration finished and all 43 rows moved across.'),
  'The migration finished and all 43 rows moved across.',
)

lastWordIs(
  '…so a question drawn that way still ends in its question mark',
  codexPainted('Which database should I point it at?'),
  'Which database should I point it at?',
)

const stoppedOnQuestion = [
  'I can rename the file or leave it. Which do you want?',
  '',
  '╭─────────────────────────────────────╮',
  '│ >                                   │',
  '╰─────────────────────────────────────╯',
  '  ? for shortcuts',
].join('\n')
lastWordIs(
  'a question wins over the composer drawn under it',
  stoppedOnQuestion,
  'I can rename the file or leave it. Which do you want?',
)

lastWordIs('with no question, the last real line', 'Wrote 3 files\nRan the tests\n  ? for shortcuts\n', 'Ran the tests')

lastWordIs(
  'a cell repainted in place is not the bottom of the screen',
  '1 MCP server needs authentication\n\x1b[H\x1b[63C\x1b[23B\x1b[32m/rc\x1b[39m',
  '1 MCP server needs authentication',
)

check('a fragment with nothing behind it says nothing', idle.lastWord('\x1b[32m/rc\x1b[39m') === null)

lastWordIs('a short question still counts — that is the whole point', 'Working\nRetry?\n', 'Retry?')

check('nothing but frame says nothing', idle.lastWord('╭────╮\n│    │\n╰────╯') === null)
check('an empty screen says nothing', idle.lastWord('   \n\n \r\n') === null)

check(
  'a long line is cut, not sent whole',
  (idle.lastWord('A'.repeat(400)) ?? '').length === MESSAGE_LIMIT,
)

section('when it reports')

const reports = []
const watched = (label) => {
  const session = fakeSession()
  idle.watch(session, (message) => reports.push({ label, message }), QUIET_MS)
  return session
}
const reportsFor = (label) => reports.filter((report) => report.label === label)

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

busy.say(PLENTY)
const keepDrawing = setInterval(() => busy.say('.'), REDRAW_EVERY_MS)

answered.say(PLENTY)
await wait(HALF_QUIET_MS)
answered.type('yes\r')

echoed.say(PLENTY)
await wait(HALF_QUIET_MS)
echoed.type('yes\r')
echoed.say('yes\r\n')

await wait(WELL_PAST_QUIET_MS)
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

quiet.say(`${PLENTY}\nStill here.\n`)
await wait(WELL_PAST_QUIET_MS)
check('it does not repeat itself while nothing is answered', reportsFor('quiet').length === 1)

quiet.type('go\r')
quiet.say(`${PLENTY}\nDone again.\n`)
await wait(WELL_PAST_QUIET_MS)
check(
  'answering it arms the next one',
  reportsFor('quiet').length === 2 && reportsFor('quiet')[1]?.message === 'Done again.',
  JSON.stringify(reportsFor('quiet')[1]?.message),
)

console.log('')
console.log(failures === 0 ? '  idle: all good.' : `  idle: ${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
