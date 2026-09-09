import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { orbitDir } from './home.js'

const DATA_DIR = orbitDir()
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')
const SCROLLBACK_DIR = path.join(DATA_DIR, 'scrollback')
const HIDDEN_FILE = path.join(DATA_DIR, 'hidden.json')
const SCROLLBACK_EXT = '.txt'

fs.mkdirSync(SCROLLBACK_DIR, { recursive: true })

export interface PersistedSession {
  id: string
  name: string | null
  providerId: string
  providerName: string
  cwd: string
  createdAt: string
  firstCommand: string | null
  endedAt: string | null
  exitCode: number | null
  conversationId: string | null
}

const LEGACY_MOUSE_REPORT_RESIDUE = /^(?:<\d+;\d+;\d+[Mm])+/

const stripLegacyMouseReport = (firstCommand: string | null | undefined): string | null =>
  firstCommand?.replace(LEGACY_MOUSE_REPORT_RESIDUE, '').trim() || null

const fillFieldsOlderFormatsLack = (s: PersistedSession): PersistedSession => ({
  ...s,
  firstCommand: stripLegacyMouseReport(s.firstCommand),
  conversationId: s.conversationId ?? null,
})

function readJsonArrayOrNothing(file: string): unknown[] {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function load(): PersistedSession[] {
  return readJsonArrayOrNothing(SESSIONS_FILE).map((s) => fillFieldsOlderFormatsLack(s as PersistedSession))
}

export function saveAll(sessions: PersistedSession[]): void {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2))
  } catch (err) {
    console.error('[orbit] failed to persist sessions:', err)
  }
}

const scrollbackPath = (id: string) => path.join(SCROLLBACK_DIR, `${id}${SCROLLBACK_EXT}`)

export function saveScrollback(id: string, text: string): void {
  fsp.writeFile(scrollbackPath(id), text).catch((err) => {
    console.error('[orbit] failed to persist scrollback:', err)
  })
}

export function saveScrollbackSync(id: string, text: string): void {
  try {
    fs.writeFileSync(scrollbackPath(id), text)
  } catch {}
}

export function readScrollback(id: string): Promise<string> {
  return fsp.readFile(scrollbackPath(id), 'utf8').catch(() => '')
}

export function deleteScrollback(id: string): void {
  fsp.rm(scrollbackPath(id), { force: true }).catch(() => {})
}

export async function sweepOrphanScrollback(knownIds: Set<string>): Promise<number> {
  const names = await fsp.readdir(SCROLLBACK_DIR).catch(() => [] as string[])
  let removed = 0
  for (const name of names) {
    if (!name.endsWith(SCROLLBACK_EXT)) continue
    const id = name.slice(0, -SCROLLBACK_EXT.length)
    if (knownIds.has(id)) continue
    await fsp.rm(scrollbackPath(id), { force: true }).catch(() => {})
    removed++
  }
  return removed
}

export function loadHidden(): string[] {
  return readJsonArrayOrNothing(HIDDEN_FILE).filter((id): id is string => typeof id === 'string')
}

export function saveHidden(ids: string[]): void {
  try {
    fs.writeFileSync(HIDDEN_FILE, JSON.stringify(ids, null, 2))
  } catch (err) {
    console.error('[orbit] failed to persist hidden conversations:', err)
  }
}
