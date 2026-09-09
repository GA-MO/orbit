#!/usr/bin/env node
import * as notify from '../server/dist/notify.js'
import * as push from '../server/dist/push.js'

const SECTION_WIDTH = 58
const DEFAULT_TIMEOUT_MS = 5000
const BRIEF_TIMEOUT_MS = 50
const PAST_BRIEF_TIMEOUT_MS = 150
const MIN_TOKEN_LENGTH = 32
const MAX_TOPIC_LENGTH = 32

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, SECTION_WIDTH - title.length))}`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const openQuestion = (opts = {}) => {
  let capability
  const result = notify.ask({
    question: 'Deploy?',
    options: ['Yes', 'No'],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...opts,
    announce: (info) => (capability = info),
  })
  return { capability, result }
}

section('the capability a notification carries')

const first = openQuestion()
check('a question is announced before it goes out', !!first.capability?.id)
check(
  '…with the options it will be answered with',
  JSON.stringify(first.capability?.options) === '["Yes","No"]',
  JSON.stringify(first.capability?.options),
)
const tokenLength = (first.capability?.answerToken ?? '').length
check(
  '…and a token long enough not to be guessed',
  tokenLength >= MIN_TOKEN_LENGTH,
  `${tokenLength} chars`,
)

const defaults = openQuestion({ options: undefined })
check(
  'a question with no options offers Allow / Deny',
  JSON.stringify(defaults.capability?.options) === '["Allow","Deny"]',
  JSON.stringify(defaults.capability?.options),
)

section('what it refuses')

const { id, answerToken } = first.capability
check('a wrong token answers nothing', notify.answerWith(id, 'wrong', 'Yes') === false)
check(
  '…including one of the right length',
  notify.answerWith(id, 'A'.repeat(answerToken.length), 'Yes') === false,
)
check('an unknown question answers nothing', notify.answerWith('n0-nope', answerToken, 'Yes') === false)
check(
  'the right token cannot say something the question did not offer',
  notify.answerWith(id, answerToken, 'rm -rf /') === false,
)
check('…nor an option belonging to another question', notify.answerWith(id, answerToken, 'Allow') === false)

section('what it does')

check('the right token, the right option', notify.answerWith(id, answerToken, 'Yes') === true)
const answered = await first.result
check('…reaches the agent that was waiting', answered.answer === 'Yes' && !answered.timedOut,
  JSON.stringify(answered))
check(
  'and it is spent — the same tap twice answers once',
  notify.answerWith(id, answerToken, 'No') === false,
)

const brief = openQuestion({ timeoutMs: BRIEF_TIMEOUT_MS })
await sleep(PAST_BRIEF_TIMEOUT_MS)
check(
  'a question that timed out cannot be answered late',
  notify.answerWith(brief.capability.id, brief.capability.answerToken, 'Yes') === false,
)
check('…and it timed out for the agent too', (await brief.result).timedOut === true)

section('the topic a push service will accept')

check('a length base64 could produce is fine', push.topicIsValid('orbit-notice'))
check('…and a dash in it changes nothing', push.topicIsValid('orbit-wait'))
check(
  'a length base64 could not produce is rejected',
  !push.topicIsValid('orbit-waiting') && !push.topicIsValid('orbitwaitings'),
)
check('nothing over 32 characters', !push.topicIsValid('o'.repeat(MAX_TOPIC_LENGTH + 1)))
check('nothing outside the alphabet', !push.topicIsValid('orbit notice'))
check('and no empty topic', !push.topicIsValid(''))

const SHIPPED_SHELVES = [
  ['NOTICE', push.NOTICE],
  ['WAITING', push.WAITING],
  ['question()', push.question(60)],
]
for (const [name, shelf] of SHIPPED_SHELVES) {
  check(`${name} ships a topic that will be accepted`, push.topicIsValid(shelf.topic), shelf.topic)
}

notify.answerWith(defaults.capability.id, defaults.capability.answerToken, 'Deny')
await defaults.result

console.log('')
console.log(failures === 0 ? '  ask: all good.' : `  ask: ${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
