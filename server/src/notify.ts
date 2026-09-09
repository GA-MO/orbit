import { randomBytes, timingSafeEqual } from 'node:crypto'

const ASK_TIMEOUT_MS = 120_000
const MISSED_KEPT = 10
const MISSED_MAX_AGE_MS = 6 * 60 * 60 * 1000
const MAX_ASK_OPTIONS = 4
const DEFAULT_ASK_OPTIONS = ['Allow', 'Deny']
const ANSWER_TOKEN_BYTES = 24

export interface Notice {
  type: 'notice'
  id: string
  message: string
  source: string | null
  sessionId?: string | null
  missed?: boolean
  pushed?: boolean
  at?: string
}

export interface PreviewOpen {
  type: 'preview'
  id: string
  url: string
  port: number
  source: string | null
  sessionId?: string | null
}

export interface AttentionRaised {
  type: 'attention'
  id: string
  sessionId: string
}

export interface Ask {
  type: 'ask'
  id: string
  question: string
  detail: string | null
  options: string[]
  source: string | null
  sessionId?: string | null
}

type Outbound = Notice | Ask | PreviewOpen | AttentionRaised
type Send = (msg: Outbound) => void

interface Client {
  send: Send
  viewing: string | null
}

export interface ClientHandle {
  drop(): void
  setViewing(sessionId: string | null): void
}

interface PendingAsk {
  ask: Ask
  resolve: (answer: string | null) => void
  timer: NodeJS.Timeout
  answerToken: string
}

const clients = new Set<Client>()
const missed: Notice[] = []
const pending = new Map<string, PendingAsk>()

let seq = 0
const nextId = () => `n${++seq}-${Date.now().toString(36)}`

const isFreshMissedNotice = (notice: Notice, now: number): boolean =>
  now - new Date(notice.at!).getTime() < MISSED_MAX_AGE_MS

function drainMissedNotices(): Notice[] {
  const now = Date.now()
  const fresh = missed.filter((notice) => isFreshMissedNotice(notice, now))
  missed.length = 0
  return fresh
}

export function addClient(send: Send): ClientHandle {
  const client: Client = { send, viewing: null }
  clients.add(client)
  for (const { ask } of pending.values()) send(ask)
  for (const notice of drainMissedNotices()) send(notice)
  return {
    drop: () => clients.delete(client),
    setViewing: (sessionId) => (client.viewing = sessionId),
  }
}

export const clientCount = () => clients.size

export const isViewing = (sessionId: string): boolean =>
  [...clients].some((client) => client.viewing === sessionId)

const broadcast = (msg: Outbound) => {
  for (const { send } of clients) {
    try {
      send(msg)
    } catch {}
  }
}

function keepForLater(notice: Notice): void {
  missed.push({ ...notice, missed: true, at: new Date().toISOString() })
  if (missed.length > MISSED_KEPT) missed.shift()
}

export function notify(opts: {
  message: string
  source?: string | null
  sessionId?: string | null
}): { delivered: number; id: string } {
  const notice: Notice = {
    type: 'notice',
    id: nextId(),
    message: opts.message,
    source: opts.source ?? null,
    sessionId: opts.sessionId ?? null,
  }
  if (clients.size > 0) {
    broadcast(notice)
    return { delivered: clients.size, id: notice.id }
  }
  keepForLater(notice)
  return { delivered: 0, id: notice.id }
}

export function openPreview(opts: {
  url: string
  port: number
  source?: string | null
  sessionId?: string | null
}): { delivered: number; id: string } {
  const message: PreviewOpen = {
    type: 'preview',
    id: nextId(),
    url: opts.url,
    port: opts.port,
    source: opts.source ?? null,
    sessionId: opts.sessionId ?? null,
  }
  broadcast(message)
  return { delivered: clients.size, id: message.id }
}

export function attentionRaised(sessionId: string): number {
  broadcast({ type: 'attention', id: nextId(), sessionId })
  return clients.size
}

export function markPushed(id: string): void {
  const notice = missed.find((n) => n.id === id)
  if (notice) notice.pushed = true
}

export interface AskResult {
  answer: string | null
  timedOut: boolean
}

const askOptionsFrom = (options: string[] | undefined): string[] =>
  options?.length ? options.slice(0, MAX_ASK_OPTIONS) : DEFAULT_ASK_OPTIONS

export function ask(opts: {
  question: string
  detail?: string | null
  options?: string[]
  source?: string | null
  sessionId?: string | null
  timeoutMs?: number
  announce?: (open: { id: string; answerToken: string; options: string[] }) => void
}): Promise<AskResult> {
  const id = nextId()
  const message: Ask = {
    type: 'ask',
    id,
    question: opts.question,
    detail: opts.detail ?? null,
    options: askOptionsFrom(opts.options),
    source: opts.source ?? null,
    sessionId: opts.sessionId ?? null,
  }

  const answerToken = randomBytes(ANSWER_TOKEN_BYTES).toString('base64url')

  return new Promise<AskResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ answer: null, timedOut: true })
    }, opts.timeoutMs ?? ASK_TIMEOUT_MS)
    timer.unref?.()

    pending.set(id, {
      ask: message,
      timer,
      answerToken,
      resolve: (answer) => resolve({ answer, timedOut: false }),
    })
    opts.announce?.({ id, answerToken, options: message.options })
    broadcast(message)
  })
}

export function answer(id: string, choice: string): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  clearTimeout(entry.timer)
  entry.resolve(choice)
}

const tokensMatch = (given: string, real: string): boolean => {
  const givenBytes = Buffer.from(String(given))
  const realBytes = Buffer.from(real)
  return givenBytes.length === realBytes.length && timingSafeEqual(givenBytes, realBytes)
}

export function answerWith(id: string, token: string, choice: string): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  if (!tokensMatch(token, entry.answerToken)) return false
  if (!entry.ask.options.includes(choice)) return false
  answer(id, choice)
  return true
}

export const outstanding = (): Ask[] => [...pending.values()].map((p) => p.ask)
