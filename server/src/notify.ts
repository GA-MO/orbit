import { randomBytes, timingSafeEqual } from 'node:crypto'

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
  /** Which session raised it, when the sender knew — see `ORBIT_SESSION_ID`. */
  sessionId?: string | null
  /** Sent while nothing was connected — the phone shows it after the fact. */
  missed?: boolean
  /** A push already put this on the phone's screen; a banner would be the second. */
  pushed?: boolean
  /** When it was raised; only carried on missed notices, which are read late. */
  at?: string
}

/**
 * "Go and look at this yourself" — the frame the phone should open, chosen by
 * the agent rather than by the person tapping through the Preview tab.
 *
 * It carries a whole URL because the path is the point: a published preview
 * always lands on `/`, and the route the agent just changed is the one worth
 * showing. Typing it on a phone keyboard is the problem the port chips were
 * invented to remove, so the path travels with the message instead.
 *
 * Unlike a notice this one is worthless late — a frame opened onto work that
 * has moved on is a confusing picture, not a stale one — so nothing here is
 * ever held for a phone that turns up afterwards. The route falls back to a
 * notice instead, which reads perfectly well an hour later.
 */
export interface PreviewOpen {
  type: 'preview'
  id: string
  /** Full https URL including the path, e.g. https://mb.tailnet.ts.net:8443/settings */
  url: string
  /** The dev server's port on the Mac, for labelling. */
  port: number
  source: string | null
  sessionId?: string | null
}

/**
 * A session's badge changed while nobody was looking at it.
 *
 * Deliberately not a notice: it carries no words and raises no toast, because
 * what it reports is a session going quiet — something that happens at the end
 * of every turn of every agent, and a toast for each one would make the app
 * unusable with three sessions open. The phone takes it as a cue to ask the
 * server what the list looks like now, which is the same thing a notice does
 * after showing its message.
 */
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

type Send = (msg: Notice | Ask | PreviewOpen | AttentionRaised) => void

/** One connected phone, and which session it currently has on screen. */
interface Client {
  send: Send
  viewing: string | null
}

export interface ClientHandle {
  drop(): void
  /** The session this phone is looking at right now, or null when it is away. */
  setViewing(sessionId: string | null): void
}

const clients = new Set<Client>()
const missed: Notice[] = []
const pending = new Map<
  string,
  {
    ask: Ask
    resolve: (answer: string | null) => void
    timer: NodeJS.Timeout
    /** One-shot capability to answer this one question — see {@link answerWith}. */
    answerToken: string
  }
>()

let seq = 0
const nextId = () => `n${++seq}-${Date.now().toString(36)}`

export function addClient(send: Send): ClientHandle {
  const client: Client = { send, viewing: null }
  clients.add(client)
  // A phone that connects mid-question still gets asked.
  for (const { ask } of pending.values()) send(ask)
  /* And it is told what it slept through. A locked phone has no socket, so
     those notices went nowhere at all — without this they are simply lost. */
  const now = Date.now()
  const fresh = missed.filter((n) => now - new Date(n.at!).getTime() < MISSED_MAX_AGE_MS)
  missed.length = 0
  for (const notice of fresh) send(notice)
  return {
    drop: () => clients.delete(client),
    setViewing: (sessionId) => (client.viewing = sessionId),
  }
}

export const clientCount = () => clients.size

/**
 * Whether a phone has this session on screen right now — not merely connected.
 *
 * The two used to be the same question, and answering it with "is anything
 * connected" is what made a second session's "Claude is waiting" disappear
 * while you were reading the first one.
 */
export const isViewing = (sessionId: string): boolean =>
  [...clients].some((c) => c.viewing === sessionId)

const broadcast = (msg: Notice | Ask | PreviewOpen | AttentionRaised) => {
  for (const { send } of clients) {
    try {
      send(msg)
    } catch {
      // a socket that died between checks is not this layer's problem
    }
  }
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
  missed.push({ ...notice, missed: true, at: new Date().toISOString() })
  if (missed.length > MISSED_KEPT) missed.shift()
  return { delivered: 0, id: notice.id }
}

/**
 * Put a preview in front of whoever is holding the phone.
 *
 * Returns how many phones took it so the caller can decide what silence
 * means. It cannot decide that here: sending nowhere is not a failure worth
 * throwing over, and the honest consolation prize — a notice saying which
 * port and path the agent wanted shown — belongs to the layer that knows
 * about push and the missed queue.
 */
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

/** Tell every phone that this session's standing state has changed. */
export function attentionRaised(sessionId: string): number {
  broadcast({ type: 'attention', id: nextId(), sessionId })
  return clients.size
}

/* A notice nobody was there for goes out over push *and* waits here to be read
   when the app comes back — two deliveries of one event, and on a phone still
   locked when it reconnects, the second one raises its own banner beside the
   first. Say which ones the phone has already seen; it can still catch up on
   them in the app without being told twice. */
export function markPushed(id: string): void {
  const notice = missed.find((n) => n.id === id)
  if (notice) notice.pushed = true
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
  sessionId?: string | null
  timeoutMs?: number
  /**
   * Called once the question is registered and before it is broadcast, with
   * what a notification needs to carry an answer back. It runs at that exact
   * moment because a push announcing a question has to be able to name it, and
   * nothing can name it until it exists.
   */
  announce?: (open: { id: string; answerToken: string; options: string[] }) => void
}): Promise<AskResult> {
  const id = nextId()
  const message: Ask = {
    type: 'ask',
    id,
    question: opts.question,
    detail: opts.detail ?? null,
    options: opts.options?.length ? opts.options.slice(0, 4) : ['Allow', 'Deny'],
    source: opts.source ?? null,
    sessionId: opts.sessionId ?? null,
  }

  const answerToken = randomBytes(24).toString('base64url')

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
      answerToken,
      resolve: (answer) => resolve({ answer, timedOut: false }),
    })
    opts.announce?.({ id, answerToken, options: message.options })
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

/**
 * Answer a question from a notification, where there is no logged-in app to
 * carry the access token.
 *
 * A push wakes the service worker with the app closed — that is the whole
 * reason it exists — and the worker has no token: it never sees the login
 * screen, and putting one where it could would give a background script the
 * standing right to do anything the phone can do. So the push carries a
 * capability instead of a credential, and this is the door it opens: one
 * question, by name, answered with one of the options that question itself
 * declared, once. It cannot be replayed (the entry is gone), it cannot outlive
 * the question (it times out with it), and it cannot say anything the modal in
 * the app could not have said.
 *
 * Returns false for anything else, which the route turns into the same slow
 * 401 a wrong token gets — a wrong nonce is a guess, and guesses are paced.
 */
export function answerWith(id: string, token: string, choice: string): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  const given = Buffer.from(String(token))
  const real = Buffer.from(entry.answerToken)
  if (given.length !== real.length || !timingSafeEqual(given, real)) return false
  if (!entry.ask.options.includes(choice)) return false
  answer(id, choice)
  return true
}

/** Questions still on screen, so a reconnecting client can be caught up. */
export const outstanding = (): Ask[] => [...pending.values()].map((p) => p.ask)
