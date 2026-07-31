/**
 * The channel that lets work on the Mac reach the phone.
 *
 * Everything else in Orbit is the phone driving the Mac. This is the other
 * direction: an agent (through the MCP server) or a Claude Code hook can put a
 * message or a question in front of whoever is holding the phone, and — for a
 * question — wait for the answer before continuing.
 */

const ASK_TIMEOUT_MS = 120_000
/** Notices that reached nobody, kept for whoever turns up next. */
const MISSED_KEPT = 10
const MISSED_MAX_AGE_MS = 6 * 60 * 60 * 1000

export interface Notice {
  type: 'notice'
  id: string
  message: string
  /** Where it came from, e.g. the session's folder. */
  source: string | null
  /** Sent while nothing was connected — the phone shows it after the fact. */
  missed?: boolean
  /** When it was raised; only carried on missed notices, which are read late. */
  at?: string
}

export interface Ask {
  type: 'ask'
  id: string
  question: string
  detail: string | null
  options: string[]
  source: string | null
}

type Send = (msg: Notice | Ask) => void

const clients = new Set<Send>()
const missed: Notice[] = []
const pending = new Map<
  string,
  { ask: Ask; resolve: (answer: string | null) => void; timer: NodeJS.Timeout }
>()

let seq = 0
const nextId = () => `n${++seq}-${Date.now().toString(36)}`

export function addClient(send: Send): () => void {
  clients.add(send)
  // A phone that connects mid-question still gets asked.
  for (const { ask } of pending.values()) send(ask)
  /* And it is told what it slept through. A locked phone has no socket, so
     those notices went nowhere at all — without this they are simply lost. */
  const now = Date.now()
  const fresh = missed.filter((n) => now - new Date(n.at!).getTime() < MISSED_MAX_AGE_MS)
  missed.length = 0
  for (const notice of fresh) send(notice)
  return () => clients.delete(send)
}

export const clientCount = () => clients.size

const broadcast = (msg: Notice | Ask) => {
  for (const send of clients) {
    try {
      send(msg)
    } catch {
      // a socket that died between checks is not this layer's problem
    }
  }
}

export function notify(message: string, source: string | null = null): number {
  const notice: Notice = { type: 'notice', id: nextId(), message, source }
  if (clients.size > 0) {
    broadcast(notice)
    return clients.size
  }
  missed.push({ ...notice, missed: true, at: new Date().toISOString() })
  if (missed.length > MISSED_KEPT) missed.shift()
  return 0
}

export interface AskResult {
  answer: string | null
  timedOut: boolean
}

export function ask(opts: {
  question: string
  detail?: string | null
  options?: string[]
  source?: string | null
  timeoutMs?: number
}): Promise<AskResult> {
  const id = nextId()
  const message: Ask = {
    type: 'ask',
    id,
    question: opts.question,
    detail: opts.detail ?? null,
    options: opts.options?.length ? opts.options.slice(0, 4) : ['Allow', 'Deny'],
    source: opts.source ?? null,
  }

  return new Promise<AskResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      // Nobody answered — the caller decides what silence means.
      resolve({ answer: null, timedOut: true })
    }, opts.timeoutMs ?? ASK_TIMEOUT_MS)
    timer.unref?.()

    pending.set(id, {
      ask: message,
      timer,
      resolve: (answer) => resolve({ answer, timedOut: false }),
    })
    broadcast(message)
  })
}

/** Called when the phone taps an option. Unknown ids are stale — ignore them. */
export function answer(id: string, choice: string): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  clearTimeout(entry.timer)
  entry.resolve(choice)
}

/** Questions still on screen, so a reconnecting client can be caught up. */
export const outstanding = (): Ask[] => [...pending.values()].map((p) => p.ask)
