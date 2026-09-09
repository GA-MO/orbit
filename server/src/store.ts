import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { orbitDir } from './home.js'

const DATA_DIR = orbitDir()
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')
const SCROLLBACK_DIR = path.join(DATA_DIR, 'scrollback')
const HIDDEN_FILE = path.join(DATA_DIR, 'hidden.json')

fs.mkdirSync(SCROLLBACK_DIR, { recursive: true })

export interface PersistedSession {
  id: string
  name: string | null
  providerId: string
  providerName: string
  cwd: string
  createdAt: string
  /** First line typed into the session — stands in for a name nobody gave it. */
  firstCommand: string | null
  /** null while the session is running; set when it ends (or the server died). */
  endedAt: string | null
  exitCode: number | null
  /**
   * The agent's own name for the conversation held here, for providers that let
   * Orbit choose one. Null for the rest, and for sessions persisted before this
   * existed — those can still only reach their folder's newest conversation.
   */
  conversationId: string | null
}

/* Labels captured before the CSI fix kept the body of SGR mouse reports: the
   ESC [ prefix was stripped, the <35;28;28M it introduced was not. */
const MOUSE_REPORT_RESIDUE = /^(?:<\d+;\d+;\d+[Mm])+/

export function load(): PersistedSession[] {
  try {
    const list = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))
    if (!Array.isArray(list)) return []
    // Sessions persisted before firstCommand existed simply have none.
    return list.map((s: PersistedSession) => ({
      ...s,
      firstCommand: s.firstCommand?.replace(MOUSE_REPORT_RESIDUE, '').trim() || null,
      conversationId: s.conversationId ?? null,
    }))
  } catch {
    return []
  }
}

export function saveAll(sessions: PersistedSession[]): void {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2))
  } catch (err) {
    console.error('[orbit] failed to persist sessions:', err)
  }
}

const scrollbackPath = (id: string) => path.join(SCROLLBACK_DIR, `${id}.txt`)

export function saveScrollback(id: string, text: string): void {
  fsp.writeFile(scrollbackPath(id), text).catch((err) => {
    console.error('[orbit] failed to persist scrollback:', err)
  })
}

/** Synchronous variant for the shutdown path, where async writes would be lost. */
export function saveScrollbackSync(id: string, text: string): void {
  try {
    fs.writeFileSync(scrollbackPath(id), text)
  } catch {
    // best effort on shutdown
  }
}

export function readScrollback(id: string): Promise<string> {
  return fsp.readFile(scrollbackPath(id), 'utf8').catch(() => '')
}

export function deleteScrollback(id: string): void {
  fsp.rm(scrollbackPath(id), { force: true }).catch(() => {})
}

/** Remove scrollback files with no matching session id. */
export async function sweepOrphanScrollback(knownIds: Set<string>): Promise<number> {
  const names = await fsp.readdir(SCROLLBACK_DIR).catch(() => [] as string[])
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.txt')) continue
    const id = name.slice(0, -4)
    if (knownIds.has(id)) continue
    await fsp.rm(scrollbackPath(id), { force: true }).catch(() => {})
    removed++
  }
  return removed
}

/**
 * Transcripts the phone has asked not to see again.
 *
 * These are ids, never files. A conversation held at the Mac's own desk is
 * Claude Code's record of it, so the only thing Orbit is allowed to remember is
 * that this phone does not want the row — the transcript stays exactly where it
 * was. Kept in its own file rather than folded into `sessions.json` because
 * that file is rewritten from the live session maps on every change, and an id
 * with no session behind it has nowhere to live in there.
 *
 * Read with the same tolerance as the sessions: a file that was never written
 * and a file that got truncated both mean nothing is hidden, which is a state
 * the user can put right by hiding the row again — a crash on startup is not.
 */
export function loadHidden(): string[] {
  try {
    const list = JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf8'))
    if (!Array.isArray(list)) return []
    return list.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

export function saveHidden(ids: string[]): void {
  try {
    fs.writeFileSync(HIDDEN_FILE, JSON.stringify(ids, null, 2))
  } catch (err) {
    console.error('[orbit] failed to persist hidden conversations:', err)
  }
}
