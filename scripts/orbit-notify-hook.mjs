#!/usr/bin/env node
/**
 * Claude Code hook — tells the phone when Claude wants something, or is done.
 *
 * Claude Code draws its own questions and permission prompts inside the
 * terminal. From a phone that is face-down on a desk, a question with four
 * choices looks exactly like a session that is still thinking, and it can wait
 * there all evening. This forwards those moments to Orbit, which shows a toast
 * if the app is open and pushes a notification if the phone is asleep.
 *
 * It never blocks: every path fires a request and exits, whatever the answer.
 * Install (in ~/.claude/settings.json):
 *
 *   "hooks": {
 *     "PreToolUse":   [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node <repo>/scripts/orbit-notify-hook.mjs" }] }],
 *     "Notification": [{ "hooks": [{ "type": "command", "command": "node <repo>/scripts/orbit-notify-hook.mjs" }] }],
 *     "Stop":         [{ "hooks": [{ "type": "command", "command": "node <repo>/scripts/orbit-notify-hook.mjs" }] }]
 *   }
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = Number(process.env.ORBIT_PORT ?? 3001)
const done = () => process.exit(0)

const readStdin = () =>
  new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (data += c))
    process.stdin.on('end', () => resolve(data))
    setTimeout(() => resolve(data), 3000).unref()
  })

const oneLine = (text, max = 140) => {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const input = await readStdin()
  .then(JSON.parse)
  .catch(() => null)
if (!input) done()

/* What to say, and whether it is worth saying at all. `quiet` messages are
   dropped by the server when Orbit is open — the user is already looking. */
const describe = () => {
  switch (input.hook_event_name) {
    case 'PreToolUse': {
      const questions = input.tool_input?.questions ?? []
      const first = questions[0]
      if (!first) return null
      const options = (first.options ?? []).map((o) => o.label).filter(Boolean)
      const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : ''
      return {
        message: `Claude is asking: ${oneLine(first.question, 90)}${
          options.length ? ` — ${options.join(' / ')}` : ''
        }${more}`,
        kind: 'waiting',
        quiet: true,
      }
    }
    case 'Notification': {
      // The type matters more than the text: only some of these are a wait.
      const waiting = {
        permission_prompt: 'Claude needs permission to continue',
        idle_prompt: 'Claude is waiting for you',
        agent_needs_input: 'Claude needs your input',
        elicitation_dialog: 'A tool is asking you something',
      }[input.notification_type]
      if (!waiting) return null
      return { message: oneLine(input.message) || waiting, kind: 'waiting', quiet: true }
    }
    case 'Stop': {
      /* Only for work started from the phone. At a desk the turn ending is
         visible on the screen the user is already facing. */
      if (process.env.ORBIT_SESSION !== '1') return null
      const summary = oneLine(input.last_assistant_message, 120)
      return {
        message: summary ? `Finished: ${summary}` : 'Claude finished',
        kind: 'done',
        quiet: true,
      }
    }
    default:
      return null
  }
}

const notice = describe()
if (!notice) done()

const token = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.ORBIT_HOME || os.homedir(), '.orbit', 'config.json'), 'utf8')).token
  } catch {
    return null
  }
})()
if (!token) done()

try {
  await fetch(`http://127.0.0.1:${PORT}/api/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    /* The session id is inherited from the PTY this agent was launched in, so
       the message is filed against the right one even when two sessions share a
       folder. Absent means Claude Code is being used at the desk, not through
       Orbit — the folder is then the only clue, and may well match nothing. */
    body: JSON.stringify({
      ...notice,
      source: input.cwd ?? null,
      sessionId: process.env.ORBIT_SESSION_ID ?? null,
    }),
  })
} catch {
  // Orbit is not running: this is a plain Claude Code session, and that is fine.
}
done()
