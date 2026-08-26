/**
 * Conversations that happened on the Mac itself.
 *
 * Orbit only ever knew about the sessions it started, because those are the
 * ones it has a PTY and a scrollback file for. But `claude` run from a terminal
 * on the Mac leaves a transcript behind in `~/.claude/projects/<folder>/<id>.jsonl`,
 * and that id is exactly what `claude --resume` takes — so a conversation
 * started at the desk is reachable from the phone on the same terms as one
 * started from the phone.
 *
 * Everything here is read-only. These files belong to Claude Code, not to
 * Orbit: they are never written, never pruned, and never counted against
 * Orbit's own cap on ended sessions.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { createReadStream } from 'node:fs'
import type { PersistedSession } from './store.js'

const HOME = os.homedir()
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects')

/** Transcripts opened per scan, newest first — behind those lie years of them. */
const SCAN_LIMIT = 60
/** How many reach the phone. Orbit's own ended list is capped at 20 too. */
const KEEP = 20
/** Head read looking for the folder and the opening prompt; line 5, in practice. */
const HEAD_BYTES = 256 * 1024
const LABEL_MAX = 80
/** Rendered history, capped like a PTY's scrollback — the tail is what matters. */
const RENDER_LIMIT = 200_000

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

/* Every scan stats every transcript on the disk, which is cheap, and parses the
   head of the newest few, which is not — so the parse is what gets remembered.
   Keying it on the file's identity is safe because a transcript's opening is
   fixed: it only ever grows at the end. The scan itself is left to run each
   time, so a conversation that started on the Mac a second ago is in the list
   the first time the phone asks. */
/** Parsed heads, keyed on the file's identity — a transcript's head never changes. */
const heads = new Map<string, Head>()
/** Where each id's transcript lives, so {@link render} need not scan again. */
const files = new Map<string, string>()

/* A slash command, a system reminder and a resume caveat all arrive as user
   messages. None of them is something the user said, and any of them as the
   label would name every session after the same boilerplate. */
const isBoilerplate = (text: string) => text.startsWith('<') || text.startsWith('Caveat:')

/** The text of a message the user actually typed, or null for anything else. */
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
  return !trimmed || isBoilerplate(trimmed) ? null : trimmed
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX)

/* The folder and the opening prompt both sit within the first few entries, so
   the head is all that is read — some of these files are tens of megabytes. */
async function readHead(file: string, key: string): Promise<Head> {
  const cached = heads.get(key)
  if (cached) return cached

  let head: Head = { cwd: null, label: null, createdAt: null }
  const fh = await fsp.open(file, 'r').catch(() => null)
  if (fh) {
    try {
      const buf = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
      const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
      // The last line of a truncated read is half an entry.
      if (bytesRead === HEAD_BYTES) lines.pop()
      for (const line of lines) {
        if (!line) continue
        let entry: any
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        if (!head.cwd && typeof entry.cwd === 'string') head.cwd = entry.cwd
        if (!head.createdAt && typeof entry.timestamp === 'string') head.createdAt = entry.timestamp
        if (!head.label) {
          const text = humanText(entry)
          if (text) head.label = oneLine(text)
        }
        if (head.cwd && head.label && head.createdAt) break
      }
    } finally {
      await fh.close()
    }
  }

  heads.set(key, head)
  return head
}

/** Every transcript on the disk, newest write first. */
async function candidates(): Promise<Candidate[]> {
  const dirs = await fsp.readdir(PROJECTS_DIR).catch(() => [] as string[])
  const found: Candidate[] = []
  for (const dir of dirs) {
    const full = path.join(PROJECTS_DIR, dir)
    const names = await fsp.readdir(full).catch(() => [] as string[])
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(full, name)
      const stat = await fsp.stat(file).catch(() => null)
      if (!stat?.isFile() || stat.size === 0) continue
      found.push({ id: name.slice(0, -6), file, mtimeMs: stat.mtimeMs, size: stat.size })
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Conversations on the Mac, as ended sessions.
 *
 * The caller filters out the ones Orbit started itself — those already have a
 * row, and a conversation offered from two of them is one that can be opened
 * twice.
 */
export async function discover(): Promise<PersistedSession[]> {
  const found = await candidates()
  files.clear()
  for (const c of found) files.set(c.id, c.file)

  const rows: PersistedSession[] = []
  for (const c of found.slice(0, SCAN_LIMIT)) {
    if (rows.length >= KEEP) break
    const head = await readHead(c.file, `${c.file}:${c.mtimeMs}:${c.size}`)
    /* A transcript with nothing the user said is a session that was opened and
       closed. There is no history to read and nothing to call the row. */
    if (!head.cwd || !head.label) continue
    /* The rest of Orbit refuses to work outside the home directory, and a
       folder that has since been deleted cannot be resumed into. */
    const cwd = path.resolve(head.cwd)
    if (cwd !== HOME && !cwd.startsWith(HOME + path.sep)) continue
    const dir = await fsp.stat(cwd).catch(() => null)
    if (!dir?.isDirectory()) continue

    rows.push({
      id: c.id,
      name: null,
      firstCommand: head.label,
      providerId: 'claude',
      providerName: 'Claude Code',
      cwd,
      createdAt: head.createdAt ?? new Date(c.mtimeMs).toISOString(),
      /* Nothing records when a conversation was left; the last thing written to
         it is as close as the transcript gets. */
      endedAt: new Date(c.mtimeMs).toISOString(),
      exitCode: null,
      /* The file is named after the conversation, which is what `--resume`
         asks for — so these rows are reachable as themselves, like Orbit's own. */
      conversationId: c.id,
    })
  }

  return rows
}

const clock = (iso: string | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Terminal text for one block of transcript, or null for the ones not worth a line. */
function renderEntry(entry: any): string | null {
  if (entry?.isSidechain) return null
  const time = clock(entry?.timestamp)

  const said = humanText(entry)
  if (said) return `\r\n\x1b[1;36m▌ You\x1b[0m \x1b[90m${time}\x1b[0m\r\n${said.replace(/\n/g, '\r\n')}\r\n`

  if (entry?.type !== 'assistant') return null
  const content = entry.message?.content
  if (!Array.isArray(content)) return null

  const parts: string[] = []
  for (const block of content) {
    if (block?.type === 'text' && block.text?.trim()) {
      parts.push(`${block.text.trim().replace(/\n/g, '\r\n')}\r\n`)
    }
    /* What a tool did is the shape of the work, and the whole input is pages of
       it — one line naming the tool is what a reader is scrolling for. */
    if (block?.type === 'tool_use') {
      const detail = oneLine(
        String(
          block.input?.command ?? block.input?.file_path ?? block.input?.pattern ?? block.input?.description ?? '',
        ),
      )
      parts.push(`\x1b[90m  ⚙ ${block.name}${detail ? ` · ${detail}` : ''}\x1b[0m\r\n`)
    }
  }
  if (!parts.length) return null
  return `\r\n\x1b[1;35m▌ Claude\x1b[0m \x1b[90m${time}\x1b[0m\r\n${parts.join('')}`
}

/**
 * A transcript as something a terminal can replay.
 *
 * Orbit's own ended sessions replay the bytes the agent actually drew. There
 * are none of those here — this session was drawn on the Mac's screen — so the
 * conversation is rebuilt from what was said, which is the part worth reading
 * back anyway.
 */
export async function render(id: string): Promise<string> {
  const file = files.get(id)
  if (!file) return ''

  const blocks: string[] = []
  let length = 0
  const rl = readline.createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of rl) {
      if (!line) continue
      let entry: any
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const text = renderEntry(entry)
      if (!text) continue
      blocks.push(text)
      length += text.length
      // Keep the end of the conversation, the way a capped scrollback does.
      while (length > RENDER_LIMIT && blocks.length > 1) length -= blocks.shift()!.length
    }
  } catch {
    // A transcript being written while it is read simply ends where it ends.
  } finally {
    rl.close()
  }

  const header = `\x1b[90m[this conversation happened on the Mac — Orbit is reading its transcript]\x1b[0m\r\n`
  return header + blocks.join('')
}
