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
}

const pending = new Map<string, Attention>()

/* A finished turn is the weakest thing a session says, and it arrives *after*
   whatever made the session interesting — Claude asks a question, then the turn
   ends. Letting that overwrite the question would replace "answer me" with
   "done", which is both wrong and the exact case this exists for. */
export function raise(sessionId: string, kind: AttentionKind, message: string): void {
  const current = pending.get(sessionId)
  if (kind === 'done' && current?.kind === 'waiting') return
  pending.set(sessionId, { kind, message, at: new Date().toISOString() })
}

export const get = (sessionId: string): Attention | null => pending.get(sessionId) ?? null

export const clear = (sessionId: string): boolean => pending.delete(sessionId)

/** Drop records for sessions that no longer exist (ended and forgotten). */
export function keepOnly(sessionIds: Iterable<string>): void {
  const alive = new Set(sessionIds)
  for (const id of [...pending.keys()]) if (!alive.has(id)) pending.delete(id)
}
