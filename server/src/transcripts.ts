import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { createReadStream } from 'node:fs'
import type { PersistedSession } from './store.js'
import { userHome } from './home.js'

const HOME = userHome()
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects')
const TRANSCRIPT_EXT = '.jsonl'

const SCAN_LIMIT = 25
const KEEP = 10
const HEAD_BYTES = 256 * 1024
const LABEL_MAX = 80
const RENDER_LIMIT = 200_000

const CLAUDE_PROVIDER_ID = 'claude'
const CLAUDE_PROVIDER_NAME = 'Claude Code'

const WHITESPACE_RUN = /\s+/g
const LINE_FEED = /\n/g

const RESET = '\x1b[0m'
const DIM = '\x1b[90m'
const BOLD_CYAN = '\x1b[1;36m'
const BOLD_MAGENTA = '\x1b[1;35m'
const READ_FROM_MAC_HEADER = `${DIM}[this conversation happened on the Mac — Orbit is reading its transcript]${RESET}\r\n`

interface Candidate {
  id: string
  file: string
  mtimeMs: number
  size: number
}

interface Head {
  cwd: string | null
  label: string | null
  createdAt: string | null
}

const headsByFileIdentity = new Map<string, Head>()
const fileOfConversation = new Map<string, string>()

const isBoilerplateUserMessage = (text: string) => text.startsWith('<') || text.startsWith('Caveat:')

function humanText(entry: any): string | null {
  if (entry?.type !== 'user' || entry.isSidechain || entry.isMeta) return null
  const content = entry.message?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.find((b: any) => b?.type === 'text')?.text
        : null
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  return !trimmed || isBoilerplateUserMessage(trimmed) ? null : trimmed
}

const oneLine = (text: string) => text.replace(WHITESPACE_RUN, ' ').trim().slice(0, LABEL_MAX)

const toCrlf = (text: string) => text.replace(LINE_FEED, '\r\n')

const fileIdentity = (c: { file: string; mtimeMs: number; size: number }) => `${c.file}:${c.mtimeMs}:${c.size}`

function parseJsonLine(line: string): any | undefined {
  if (!line) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

async function readHeadLines(file: string): Promise<string[]> {
  const fh = await fsp.open(file, 'r').catch(() => null)
  if (!fh) return []
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
    const lastLineCutMidEntry = bytesRead === HEAD_BYTES
    if (lastLineCutMidEntry) lines.pop()
    return lines
  } finally {
    await fh.close()
  }
}

function headFromLines(lines: string[]): Head {
  const head: Head = { cwd: null, label: null, createdAt: null }
  for (const line of lines) {
    const entry = parseJsonLine(line)
    if (entry === undefined) continue
    if (!head.cwd && typeof entry.cwd === 'string') head.cwd = entry.cwd
    if (!head.createdAt && typeof entry.timestamp === 'string') head.createdAt = entry.timestamp
    if (!head.label) {
      const text = humanText(entry)
      if (text) head.label = oneLine(text)
    }
    if (head.cwd && head.label && head.createdAt) break
  }
  return head
}

async function headOf(c: Candidate): Promise<Head> {
  const key = fileIdentity(c)
  const cached = headsByFileIdentity.get(key)
  if (cached) return cached
  const head = headFromLines(await readHeadLines(c.file))
  headsByFileIdentity.set(key, head)
  return head
}

function forgetHeadsOfChangedFiles(found: Candidate[]) {
  const current = new Set(found.map(fileIdentity))
  for (const key of headsByFileIdentity.keys()) if (!current.has(key)) headsByFileIdentity.delete(key)
}

async function allTranscriptsNewestFirst(): Promise<Candidate[]> {
  const dirs = await fsp.readdir(PROJECTS_DIR).catch(() => [] as string[])
  const found: Candidate[] = []
  for (const dir of dirs) {
    const full = path.join(PROJECTS_DIR, dir)
    const names = await fsp.readdir(full).catch(() => [] as string[])
    for (const name of names) {
      if (!name.endsWith(TRANSCRIPT_EXT)) continue
      const file = path.join(full, name)
      const stat = await fsp.stat(file).catch(() => null)
      if (!stat?.isFile() || stat.size === 0) continue
      found.push({ id: name.slice(0, -TRANSCRIPT_EXT.length), file, mtimeMs: stat.mtimeMs, size: stat.size })
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

const isInsideHome = (dir: string) => dir === HOME || dir.startsWith(HOME + path.sep)

const isExistingDirectory = async (dir: string) => (await fsp.stat(dir).catch(() => null))?.isDirectory() ?? false

async function resumableFolder(head: Head): Promise<string | null> {
  if (!head.cwd) return null
  const cwd = path.resolve(head.cwd)
  if (!isInsideHome(cwd)) return null
  if (!(await isExistingDirectory(cwd))) return null
  return cwd
}

const asEndedSession = (c: Candidate, head: Head, cwd: string): PersistedSession => ({
  id: c.id,
  name: null,
  firstCommand: head.label,
  providerId: CLAUDE_PROVIDER_ID,
  providerName: CLAUDE_PROVIDER_NAME,
  cwd,
  createdAt: head.createdAt ?? new Date(c.mtimeMs).toISOString(),
  endedAt: new Date(c.mtimeMs).toISOString(),
  exitCode: null,
  conversationId: c.id,
})

export interface Scan {
  rows: PersistedSession[]
  hidden: number
  present: Set<string> | null
}

export async function discover(hidden: ReadonlySet<string> = new Set()): Promise<Scan> {
  const found = await allTranscriptsNewestFirst()
  fileOfConversation.clear()
  for (const c of found) fileOfConversation.set(c.id, c.file)
  forgetHeadsOfChangedFiles(found)

  const diskWasReadable = found.length > 0
  const present = diskWasReadable ? new Set([...hidden].filter((id) => fileOfConversation.has(id))) : null

  const rows: PersistedSession[] = []
  let hiddenInWindow = 0
  for (const c of found.slice(0, SCAN_LIMIT)) {
    if (rows.length >= KEEP) break
    if (hidden.has(c.id)) {
      hiddenInWindow++
      continue
    }
    const head = await headOf(c)
    const nothingUserSaid = !head.label
    if (nothingUserSaid) continue
    const cwd = await resumableFolder(head)
    if (!cwd) continue
    rows.push(asEndedSession(c, head, cwd))
  }

  return { rows, hidden: hiddenInWindow, present }
}

const clock = (iso: string | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const speakerLine = (color: string, name: string, time: string) =>
  `\r\n${color}▌ ${name}${RESET} ${DIM}${time}${RESET}\r\n`

const toolDetail = (input: any): string =>
  oneLine(String(input?.command ?? input?.file_path ?? input?.pattern ?? input?.description ?? ''))

const toolLine = (block: any): string => {
  const detail = toolDetail(block.input)
  return `${DIM}  ⚙ ${block.name}${detail ? ` · ${detail}` : ''}${RESET}\r\n`
}

function assistantParts(content: any[]): string[] {
  const parts: string[] = []
  for (const block of content) {
    if (block?.type === 'text' && block.text?.trim()) parts.push(`${toCrlf(block.text.trim())}\r\n`)
    if (block?.type === 'tool_use') parts.push(toolLine(block))
  }
  return parts
}

function renderEntry(entry: any): string | null {
  if (entry?.isSidechain) return null
  const time = clock(entry?.timestamp)

  const said = humanText(entry)
  if (said) return `${speakerLine(BOLD_CYAN, 'You', time)}${toCrlf(said)}\r\n`

  if (entry?.type !== 'assistant') return null
  const content = entry.message?.content
  if (!Array.isArray(content)) return null

  const parts = assistantParts(content)
  if (!parts.length) return null
  return `${speakerLine(BOLD_MAGENTA, 'Claude', time)}${parts.join('')}`
}

function dropOldestBlocksOver(limit: number, blocks: string[], length: number): number {
  while (length > limit && blocks.length > 1) length -= blocks.shift()!.length
  return length
}

export async function render(id: string): Promise<string> {
  const file = fileOfConversation.get(id)
  if (!file) return ''

  const blocks: string[] = []
  let length = 0
  const rl = readline.createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of rl) {
      const entry = parseJsonLine(line)
      if (entry === undefined) continue
      const text = renderEntry(entry)
      if (!text) continue
      blocks.push(text)
      length += text.length
      length = dropOldestBlocksOver(RENDER_LIMIT, blocks, length)
    }
  } catch {
  } finally {
    rl.close()
  }

  return READ_FROM_MAC_HEADER + blocks.join('')
}
