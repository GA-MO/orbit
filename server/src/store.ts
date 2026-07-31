import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = path.join(os.homedir(), '.orbit')
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')
const SCROLLBACK_DIR = path.join(DATA_DIR, 'scrollback')

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
