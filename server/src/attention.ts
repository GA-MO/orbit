export type AttentionKind = 'waiting' | 'done'

export interface Attention {
  kind: AttentionKind
  message: string
  at: string
  idle?: boolean
}

const WENT_QUIET_MESSAGE = 'Went quiet — it may be waiting for you.'

const pending = new Map<string, Attention>()

const agentItselfSaidWaiting = (current: Attention | undefined): boolean =>
  current?.kind === 'waiting' && !current.idle

export function raise(sessionId: string, kind: AttentionKind, message: string): void {
  if (kind === 'done' && agentItselfSaidWaiting(pending.get(sessionId))) return
  pending.set(sessionId, { kind, message, at: new Date().toISOString() })
}

export function raiseIdle(sessionId: string, message: string | null): boolean {
  const agentAlreadySpoke = pending.has(sessionId)
  if (agentAlreadySpoke) return false
  pending.set(sessionId, {
    kind: 'waiting',
    message: message ?? WENT_QUIET_MESSAGE,
    at: new Date().toISOString(),
    idle: true,
  })
  return true
}

export const get = (sessionId: string): Attention | null => pending.get(sessionId) ?? null

export const clear = (sessionId: string): boolean => pending.delete(sessionId)

export function keepOnly(sessionIds: Iterable<string>): void {
  const alive = new Set(sessionIds)
  for (const id of [...pending.keys()]) if (!alive.has(id)) pending.delete(id)
}
