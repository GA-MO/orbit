/**
 * What each session still wants from the person holding the phone.
 *
 * A notice used to be a toast and nothing else: three seconds on screen, then
 * gone for good. Miss it — pocket, another tab, a phone face-down — and there
 * was no trace anywhere that Claude had stopped and was waiting. The terminal
 * itself does not help, because the whole point of the phone is not watching it.
 *
 * So the last thing a session said is kept here until it is read. It is the
 * difference between an app you have to watch and one you pick up.
 *
 * In memory on purpose: every live session dies with the server, so a record
 * saying one of them is waiting would outlive the thing it describes.
 */

/** `waiting` is holding up work over there; `done` is only worth knowing. */
export type AttentionKind = 'waiting' | 'done'

export interface Attention {
  kind: AttentionKind
  message: string
  /** When it was raised, so the phone can say how long it has been sitting. */
  at: string
  /** Worked out from the stream rather than said by the agent — see `idle.ts`. */
  idle?: boolean
}

const pending = new Map<string, Attention>()

/* A finished turn is the weakest thing a session says, and it arrives *after*
   whatever made the session interesting — Claude asks a question, then the turn
   ends. Letting that overwrite the question would replace "answer me" with
   "done", which is both wrong and the exact case this exists for.

   A guess made from the stream is not a question, though, and does not get that
   protection: anything the session says for itself is better than a line
   scraped off the bottom of its screen, including "the turn ended". */
export function raise(sessionId: string, kind: AttentionKind, message: string): void {
  const current = pending.get(sessionId)
  if (kind === 'done' && current?.kind === 'waiting' && !current.idle) return
  pending.set(sessionId, { kind, message, at: new Date().toISOString() })
}

/**
 * The same record, but only where the session has said nothing for itself.
 *
 * This is how a session that went quiet without telling anyone gets a badge
 * (see `idle.ts`), and the deference is the whole point: an agent that called
 * `orbit_notify` said something specific, and a line scraped off the bottom of
 * its screen must never replace it. Returns whether it was taken, so the caller
 * can decide whether to spend a push on it.
 */
export function raiseIdle(sessionId: string, message: string | null): boolean {
  if (pending.has(sessionId)) return false
  pending.set(sessionId, {
    kind: 'waiting',
    message: message ?? 'Went quiet — it may be waiting for you.',
    at: new Date().toISOString(),
    idle: true,
  })
  return true
}

export const get = (sessionId: string): Attention | null => pending.get(sessionId) ?? null

export const clear = (sessionId: string): boolean => pending.delete(sessionId)

/** Drop records for sessions that no longer exist (ended and forgotten). */
export function keepOnly(sessionIds: Iterable<string>): void {
  const alive = new Set(sessionIds)
  for (const id of [...pending.keys()]) if (!alive.has(id)) pending.delete(id)
}
