/**
 * The two Claude Code hooks, as subcommands:
 *
 *   orbit hook approve   PreToolUse on Bash — routes the agent's own dangerous
 *                        commands to the phone for approval. Orbit already
 *                        screens what *you* type into a terminal, but a command
 *                        the agent runs through its Bash tool never crosses that
 *                        boundary. Fails open when Orbit is not running (Claude
 *                        Code stays usable on its own); fails closed when it is
 *                        running and nobody answers.
 *
 *   orbit hook notify    AskUserQuestion, Notification and Stop — tells the
 *                        phone when Claude wants something, or is done. Claude
 *                        Code draws its questions inside the terminal, which
 *                        from a phone face-down on a desk looks exactly like a
 *                        session still thinking. Never blocks: every path fires
 *                        one request and exits.
 *
 * Both are installed by `orbit setup`, and both read the hook's JSON from stdin
 * the way Claude Code hands it over.
 */
import fs from 'node:fs'

import { screenCommand } from './approval.js'
import { orbitDir } from './home.js'

const PORT = Number(process.env.ORBIT_PORT ?? 3001)
const APPROVE_TIMEOUT_SECONDS = 180

const readStdin = (limitMs: number): Promise<string> =>
  new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (data += c))
    process.stdin.on('end', () => resolve(data))
    setTimeout(() => resolve(data), limitMs).unref()
  })

const readInput = async (limitMs: number): Promise<Record<string, any> | null> => {
  try {
    return JSON.parse(await readStdin(limitMs))
  } catch {
    return null
  }
}

const token = (): string | null => {
  try {
    return JSON.parse(fs.readFileSync(orbitDir('config.json'), 'utf8')).token ?? null
  } catch {
    return null
  }
}

const oneLine = (text: unknown, max = 140) => {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// ── approve ────────────────────────────────────────────────────────────────

const deny = (reason: string) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
}

/** Exit 0 with nothing on stdout is "allow": Claude Code's own permission flow continues. */
export async function runApproveHook(): Promise<number> {
  const input = await readInput(5000)
  if (!input) return 0
  const command = input.tool_input?.command
  if (input.tool_name !== 'Bash' || typeof command !== 'string') return 0

  const danger = screenCommand(command)
  if (!danger) return 0
  const accessToken = token()
  if (!accessToken) return 0

  let result: { answer?: string | null; timedOut?: boolean; phonesConnected?: number }
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        question: `Claude wants to run a ${danger.label}`,
        detail: command.slice(0, 2000),
        // Safe choice first: the phone emphasises the first option.
        options: ['Block', 'Run it'],
        source: input.cwd ?? null,
        timeoutSeconds: APPROVE_TIMEOUT_SECONDS,
      }),
    })
    if (!res.ok) return 0 // Orbit is up but unhappy — do not hold the agent hostage
    result = await res.json()
  } catch {
    return 0 // Orbit is not running: this is a plain Claude Code session
  }

  if (result.answer === 'Run it') return 0
  if (result.timedOut) {
    deny(
      result.phonesConnected === 0
        ? `Blocked: this ${danger.label} needs approval on the Orbit phone, and no phone is connected. Ask the user directly.`
        : `Blocked: nobody approved this ${danger.label} on the phone within ${APPROVE_TIMEOUT_SECONDS}s.`,
    )
    return 0
  }
  deny(`The user blocked this ${danger.label} from their phone.`)
  return 0
}

// ── notify ─────────────────────────────────────────────────────────────────

/* What to say, and whether it is worth saying at all. `quiet` messages are
   dropped by the server when that session is on screen — the user is already
   looking. */
const describe = (input: Record<string, any>) => {
  switch (input.hook_event_name) {
    case 'PreToolUse': {
      const questions: any[] = input.tool_input?.questions ?? []
      const first = questions[0]
      if (!first) return null
      const options: string[] = (first.options ?? []).map((o: any) => o?.label).filter(Boolean)
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
      const waiting = (
        {
          permission_prompt: 'Claude needs permission to continue',
          idle_prompt: 'Claude is waiting for you',
          agent_needs_input: 'Claude needs your input',
          elicitation_dialog: 'A tool is asking you something',
        } as Record<string, string>
      )[input.notification_type]
      if (!waiting) return null
      return { message: oneLine(input.message) || waiting, kind: 'waiting', quiet: true }
    }
    case 'Stop': {
      /* Only for work started from the phone. At a desk the turn ending is
         visible on the screen the user is already facing. */
      if (process.env.ORBIT_SESSION !== '1') return null
      const summary = oneLine(input.last_assistant_message, 120)
      return { message: summary ? `Finished: ${summary}` : 'Claude finished', kind: 'done', quiet: true }
    }
    default:
      return null
  }
}

export async function runNotifyHook(): Promise<number> {
  const input = await readInput(3000)
  if (!input) return 0
  const notice = describe(input)
  if (!notice) return 0
  const accessToken = token()
  if (!accessToken) return 0

  try {
    await fetch(`http://127.0.0.1:${PORT}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      /* The session id is inherited from the PTY this agent was launched in, so
         the message is filed against the right one even when two sessions share
         a folder. Absent means Claude Code is being used at the desk, not
         through Orbit — the folder is then the only clue, and may match nothing. */
      body: JSON.stringify({
        ...notice,
        source: input.cwd ?? null,
        sessionId: process.env.ORBIT_SESSION_ID ?? null,
      }),
    })
  } catch {
    // Orbit is not running: this is a plain Claude Code session, and that is fine.
  }
  return 0
}
