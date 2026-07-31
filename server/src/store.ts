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
  /** null while the session is running; set when it ends (or the server died). */
  endedAt: string | null
  exitCode: number | null
}

export function load(): PersistedSession[] {
  try {
    const list = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))
    return Array.isArray(list) ? list : []
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
