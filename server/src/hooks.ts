import fs from 'node:fs'

import { PORT } from './port.js'
import { screenCommand } from './approval.js'
import { orbitDir } from './home.js'

const APPROVE_TIMEOUT_SECONDS = 180
const APPROVE_STDIN_LIMIT_MS = 5000
const NOTIFY_STDIN_LIMIT_MS = 3000
const DETAIL_MAX_CHARS = 2000
const ONE_LINE_MAX = 140
const QUESTION_MAX = 90
const SUMMARY_MAX = 120
const WHITESPACE = /\s+/g

const APPROVE_OPTIONS = ['Block', 'Run it']
const RUN_IT = 'Run it'

const WAITING_NOTIFICATIONS: Record<string, string> = {
  permission_prompt: 'Claude needs permission to continue',
  idle_prompt: 'Claude is waiting for you',
  agent_needs_input: 'Claude needs your input',
  elicitation_dialog: 'A tool is asking you something',
}

const CODEX_TURN_COMPLETE = 'agent-turn-complete'
const THREAD_TITLE_KEY = 'title'

type HookInput = Record<string, any>

const readStdin = (limitMs: number): Promise<string> =>
  new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    setTimeout(() => resolve(data), limitMs).unref()
  })

const readInput = async (limitMs: number): Promise<HookInput | null> => {
  try {
    return JSON.parse(await readStdin(limitMs))
  } catch {
    return null
  }
}

const objectOrNull = (text: string | undefined): HookInput | null => {
  try {
    const parsed = JSON.parse(String(text))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const lastArgument = (): HookInput | null => objectOrNull(process.argv[process.argv.length - 1])

const token = (): string | null => {
  try {
    return JSON.parse(fs.readFileSync(orbitDir('config.json'), 'utf8')).token ?? null
  } catch {
    return null
  }
}

const oneLine = (text: unknown, max = ONE_LINE_MAX) => {
  const flat = String(text ?? '')
    .replace(WHITESPACE, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const postJson = (route: string, accessToken: string, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${PORT}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  })

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

interface AskResponse {
  answer?: string | null
  timedOut?: boolean
  phonesConnected?: number
}

const askPhone = async (
  accessToken: string,
  label: string,
  command: string,
  cwd: string | null,
): Promise<AskResponse | null> => {
  try {
    const res = await postJson('/api/ask', accessToken, {
      question: `Claude wants to run a ${label}`,
      detail: command.slice(0, DETAIL_MAX_CHARS),
      options: APPROVE_OPTIONS,
      source: cwd,
      timeoutSeconds: APPROVE_TIMEOUT_SECONDS,
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

const timedOutReason = (label: string, phonesConnected: number | undefined): string =>
  phonesConnected === 0
    ? `Blocked: this ${label} needs approval on the Orbit phone, and no phone is connected. Ask the user directly.`
    : `Blocked: nobody approved this ${label} on the phone within ${APPROVE_TIMEOUT_SECONDS}s.`

export async function runApproveHook(): Promise<number> {
  const input = await readInput(APPROVE_STDIN_LIMIT_MS)
  if (!input) return 0
  const command = input.tool_input?.command
  if (input.tool_name !== 'Bash' || typeof command !== 'string') return 0

  const danger = screenCommand(command)
  if (!danger) return 0
  const accessToken = token()
  if (!accessToken) return 0

  const result = await askPhone(accessToken, danger.label, command, input.cwd ?? null)
  if (!result) return 0

  if (result.answer === RUN_IT) return 0
  if (result.timedOut) {
    deny(timedOutReason(danger.label, result.phonesConnected))
    return 0
  }
  deny(`The user blocked this ${danger.label} from their phone.`)
  return 0
}

export interface NoticeText {
  message: string
  kind: string
  quiet: boolean
}

const describeQuestion = (input: HookInput): NoticeText | null => {
  const questions: any[] = input.tool_input?.questions ?? []
  const first = questions[0]
  if (!first) return null
  const options: string[] = (first.options ?? []).map((o: any) => o?.label).filter(Boolean)
  const optionsText = options.length ? ` — ${options.join(' / ')}` : ''
  const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : ''
  return {
    message: `Claude is asking: ${oneLine(first.question, QUESTION_MAX)}${optionsText}${more}`,
    kind: 'waiting',
    quiet: true,
  }
}

const describeNotification = (input: HookInput): NoticeText | null => {
  const waiting = WAITING_NOTIFICATIONS[input.notification_type]
  if (!waiting) return null
  return { message: oneLine(input.message) || waiting, kind: 'waiting', quiet: true }
}

const describeStop = (input: HookInput): NoticeText | null => {
  if (process.env.ORBIT_SESSION !== '1') return null
  const summary = oneLine(input.last_assistant_message, SUMMARY_MAX)
  return { message: summary ? `Finished: ${summary}` : 'Claude finished', kind: 'done', quiet: true }
}

const isTheTitleCodexGivesTheThread = (input: HookInput): boolean => {
  const answer = objectOrNull(input['last-assistant-message'])
  return !!answer && Object.keys(answer).length === 1 && typeof answer[THREAD_TITLE_KEY] === 'string'
}

const describeCodexTurn = (input: HookInput): NoticeText | null => {
  if (process.env.ORBIT_SESSION !== '1') return null
  if (isTheTitleCodexGivesTheThread(input)) return null
  const summary = oneLine(input['last-assistant-message'], SUMMARY_MAX)
  return { message: summary ? `Finished: ${summary}` : 'Codex finished', kind: 'done', quiet: true }
}

const describeCodex = (input: HookInput): NoticeText | null =>
  input.type === CODEX_TURN_COMPLETE ? describeCodexTurn(input) : null

const describeClaude = (input: HookInput): NoticeText | null => {
  switch (input.hook_event_name) {
    case 'PreToolUse':
      return describeQuestion(input)
    case 'Notification':
      return describeNotification(input)
    case 'Stop':
      return describeStop(input)
    default:
      return null
  }
}

export const describe = (input: HookInput): NoticeText | null =>
  input.hook_event_name ? describeClaude(input) : describeCodex(input)

export async function runNotifyHook(): Promise<number> {
  const input = lastArgument() ?? (await readInput(NOTIFY_STDIN_LIMIT_MS))
  if (!input) return 0
  const notice = describe(input)
  if (!notice) return 0
  const accessToken = token()
  if (!accessToken) return 0

  try {
    await postJson('/api/notify', accessToken, {
      ...notice,
      source: input.cwd ?? null,
      sessionId: process.env.ORBIT_SESSION_ID ?? null,
    })
  } catch {}
  return 0
}
