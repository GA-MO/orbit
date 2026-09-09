#!/usr/bin/env node
/**
 * Answering a question from the notification itself.
 *
 * A push wakes the service worker with the app shut and the phone locked, and
 * that worker holds no access token — deliberately, since a background script
 * with standing rights to the whole API is a worse thing to own than four taps.
 * What it gets instead is a capability: this one question, by name, answered
 * with one of the options that question declared, once.
 *
 * All of that lives in `notify.ts` and none of it needs a socket or a server,
 * so it is tested here rather than through HTTP — where the token would have to
 * be recovered from an encrypted push payload to test anything at all.
 *
 *   bun scripts/ask-smoke.mjs
 */
import * as notify from '../server/dist/notify.js'
import * as push from '../server/dist/push.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)

/** Open a question and hand back what a notification would be given about it. */
const open = (opts = {}) => {
  let capability
  const result = notify.ask({
    question: 'Deploy?',
    options: ['Yes', 'No'],
    timeoutMs: 5000,
    ...opts,
    announce: (info) => (capability = info),
  })
  return { capability, result }
}

section('the capability a notification carries')

const first = open()
check('a question is announced before it goes out', !!first.capability?.id)
check(
  '…with the options it will be answered with',
  JSON.stringify(first.capability?.options) === '["Yes","No"]',
  JSON.stringify(first.capability?.options),
)
check(
  '…and a token long enough not to be guessed',
  (first.capability?.answerToken ?? '').length >= 32,
  `${(first.capability?.answerToken ?? '').length} chars`,
)

const defaults = open({ options: undefined })
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

/* The other end of the same rule: a question that timed out has stopped
   waiting, and its notification may be sitting on a lock screen for another
   half hour. */
const brief = open({ timeoutMs: 50 })
await new Promise((r) => setTimeout(r, 150))
check(
  'a question that timed out cannot be answered late',
  notify.answerWith(brief.capability.id, brief.capability.answerToken, 'Yes') === false,
)
check('…and it timed out for the agent too', (await brief.result).timedOut === true)

section('the topic a push service will accept')

/* Proven against Apple's own endpoint on 9 Sep 2026: `orbit-notice` (12) and
   `orbit-wait` (10) came back 201, `orbit-waiting` (13), `orbitwaitings` (13)
   and `orbit-ask` (9) came back 400 BadWebPushTopic. The characters were never
   the rule — the length is, because the header is decoded as base64url. */
check('a length base64 could produce is fine', push.topicIsValid('orbit-notice'))
check('…and a dash in it changes nothing', push.topicIsValid('orbit-wait'))
check(
  'a length base64 could not produce is rejected',
  !push.topicIsValid('orbit-waiting') && !push.topicIsValid('orbitwaitings'),
)
check('nothing over 32 characters', !push.topicIsValid('o'.repeat(33)))
check('nothing outside the alphabet', !push.topicIsValid('orbit notice'))
check('and no empty topic', !push.topicIsValid(''))

/* The shelves the app actually ships. This is the assertion that would have
   caught it: both of these were wrong for five weeks. */
for (const [name, shelf] of [
  ['NOTICE', push.NOTICE],
  ['WAITING', push.WAITING],
  ['question()', push.question(60)],
]) {
  check(`${name} ships a topic that will be accepted`, push.topicIsValid(shelf.topic), shelf.topic)
}

notify.answerWith(defaults.capability.id, defaults.capability.answerToken, 'Deny')
await defaults.result

console.log('')
console.log(failures === 0 ? '  ask: all good.' : `  ask: ${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
