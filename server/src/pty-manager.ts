import { randomUUID } from 'node:crypto'
import os from 'node:os'
import * as pty from 'node-pty'
import type { Provider } from './providers.js'
import { getProvider } from './providers.js'
import * as store from './store.js'
import type { PersistedSession } from './store.js'

const SCROLLBACK_LIMIT = 200_000 // chars kept for replay on reconnect
const SCROLLBACK_FLUSH_MS = 2000
const DEAD_SESSIONS_KEPT = 20
const FIRST_COMMAND_MAX = 80

/* Input arrives as raw keystrokes: cursor keys and the like are escape
   sequences, the phone's key bar sends control codes, and an app with mouse
   tracking on turns every touch into a report. None of it belongs in a label,
   so only printable characters survive.

   CSI is ESC [ params intermediates final, and the params may open with a
   private marker — which is exactly what a mouse report does (ESC [ <35;28;28M).
   Matching only digits there left the marker and its body behind as the label. */
const ESCAPE_SEQUENCE = /\x1b(\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O[A-Za-z]|.)?/g
const CONTROL_CHAR = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g

/** Orbit's server process often inherits NO_COLOR from the IDE — strip it for PTYs. */
const ptyEnv = (): Record<string, string> => {
  const env = { ...process.env } as Record<string, string>
  delete env.NO_COLOR
  delete env.NODE_DISABLE_COLORS
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.FORCE_COLOR = '1'
  env.CLICOLOR_FORCE = '1'
  return env
}

export interface SessionInfo extends PersistedSession {
  alive: boolean
  /** Whether this session's agent can pick its last conversation back up. */
  resumable: boolean
}

export interface Session {
  id: string
  name: string | null
  /** First line typed here, kept as a fallback label. */
  firstCommand: string | null
  cwd: string
  provider: Provider
  createdAt: Date
  alive: boolean
  exitCode: number | null
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  /** Subscribe to output; returns unsubscribe. */
  onData(cb: (data: string) => void): () => void
  onExit(cb: (code: number) => void): () => void
  /** Buffered output since session start (capped), for replay on reconnect. */
  scrollback(): string
}

class PtySession implements Session {
  id = randomUUID()
  name: string | null = null
  firstCommand: string | null = null
  createdAt = new Date()
  alive = true
  exitCode: number | null = null

  /** Called once firstCommand is known, so the manager can persist it. */
  onLabel: (() => void) | null = null

  private proc: pty.IPty
  private buffer = ''
  private typed = '' // keystrokes since the last Enter, until firstCommand is set
  private dataSubs = new Set<(data: string) => void>()
  private exitSubs = new Set<(code: number) => void>()

  constructor(
    public cwd: string,
    public provider: Provider,
    cols: number,
    rows: number,
    /** Overrides the provider's launch command — used to resume a conversation. */
    command?: string | null,
  ) {
    // Agent CLIs launch through an interactive login shell so the user's PATH
    // applies; `exec` replaces the shell so exiting the agent ends the session.
    const shell = process.env.SHELL ?? '/bin/zsh'
    const launch = command ?? provider.command
    const [file, args] = launch
      ? ['/bin/zsh', ['-l', '-i', '-c', `exec ${launch}`]]
      : [shell, ['-l']]

    this.proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: ptyEnv(),
    })

    this.proc.onData((data) => {
      this.buffer += data
      if (this.buffer.length > SCROLLBACK_LIMIT) {
        this.buffer = this.buffer.slice(-SCROLLBACK_LIMIT)
      }
      for (const cb of this.dataSubs) cb(data)
    })

    this.proc.onExit(({ exitCode }) => {
      this.alive = false
      this.exitCode = exitCode
      for (const cb of this.exitSubs) cb(exitCode)
    })
  }

  write(data: string) {
    if (!this.alive) return
    if (this.firstCommand === null) this.captureFirstCommand(data)
    this.proc.write(data)
  }

  /* The first line the user commits is what the session is about — for a shell
     it is a command, for an agent it is the opening prompt. Either way it says
     far more than "Shell" does. */
  private captureFirstCommand(data: string) {
    for (const char of data.replace(ESCAPE_SEQUENCE, '').replace(CONTROL_CHAR, '')) {
      if (char === '\r' || char === '\n') {
        const line = this.typed.trim()
        this.typed = ''
        if (!line) continue
        this.firstCommand = line.slice(0, FIRST_COMMAND_MAX)
        this.onLabel?.()
        return
      }
      // Backspace edits the line being typed, so the label matches what was sent.
      if (char === '\x7f') this.typed = this.typed.slice(0, -1)
      else if (this.typed.length < FIRST_COMMAND_MAX * 2) this.typed += char
    }
  }

  resize(cols: number, rows: number) {
    if (this.alive && cols > 0 && rows > 0) this.proc.resize(cols, rows)
  }

  kill() {
    if (this.alive) this.proc.kill()
  }

  onData(cb: (data: string) => void) {
    this.dataSubs.add(cb)
    return () => this.dataSubs.delete(cb)
  }

  onExit(cb: (code: number) => void) {
    this.exitSubs.add(cb)
    return () => this.exitSubs.delete(cb)
  }

  scrollback() {
    return this.buffer
  }
}

const metaOf = (s: PtySession): PersistedSession => ({
  id: s.id,
  name: s.name,
  firstCommand: s.firstCommand,
  providerId: s.provider.id,
  providerName: s.provider.name,
  cwd: s.cwd,
  createdAt: s.createdAt.toISOString(),
  endedAt: s.alive ? null : new Date().toISOString(),
  exitCode: s.exitCode,
})

export class PtyManager {
  private active = new Map<string, PtySession>()
  private dead = new Map<string, PersistedSession>()

  constructor() {
    // Sessions that were alive when the server last stopped ended with it.
    const stoppedAt = new Date().toISOString()
    for (const meta of store.load()) {
      this.dead.set(meta.id, meta.endedAt ? meta : { ...meta, endedAt: stoppedAt })
    }
    this.prune()
    this.persist()
  }

  create(
    opts: {
      cwd?: string
      provider?: Provider
      name?: string
      cols?: number
      rows?: number
      command?: string | null
    } = {},
  ): Session {
    const session = new PtySession(
      opts.cwd ?? os.homedir(),
      opts.provider ?? { id: 'shell', name: 'Shell', command: null, resumeCommand: null },
      opts.cols ?? 80,
      opts.rows ?? 24,
      opts.command,
    )
    if (opts.name) session.name = opts.name
    session.onLabel = () => this.persist()
    this.active.set(session.id, session)

    let flushTimer: NodeJS.Timeout | null = null
    session.onData(() => {
      if (flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        store.saveScrollback(session.id, session.scrollback())
      }, SCROLLBACK_FLUSH_MS)
    })

    session.onExit(() => {
      if (flushTimer) clearTimeout(flushTimer)
      store.saveScrollback(session.id, session.scrollback())
      this.active.delete(session.id)
      this.dead.set(session.id, metaOf(session))
      this.prune()
      this.persist()
    })

    this.persist()
    return session
  }

  get(id: string): Session | undefined {
    return this.active.get(id)
  }

  isDead(id: string): boolean {
    return this.dead.has(id)
  }

  deadScrollback(id: string): Promise<string> {
    return store.readScrollback(id)
  }

  /**
   * Start again from an ended session: new PTY, same provider, folder, and name.
   * With `resume`, the agent is asked to pick its last conversation in that
   * folder back up instead of starting a fresh one — which only makes sense for
   * the entry {@link list} marked resumable.
   */
  restart(id: string, resume = false): Session | null {
    const meta = this.dead.get(id)
    if (!meta) return null
    const provider = getProvider(meta.providerId)
    if (!provider) return null
    if (resume && !this.list().find((s) => s.id === id)?.resumable) return null
    return this.create({
      provider,
      cwd: meta.cwd,
      name: meta.name ?? undefined,
      command: resume ? provider.resumeCommand : undefined,
    })
  }

  /** Remove an ended session and its history. Active sessions must be killed instead. */
  forget(id: string): boolean {
    if (!this.dead.delete(id)) return false
    store.deleteScrollback(id)
    this.persist()
    return true
  }

  /** Re-persist metadata after an in-place change (e.g. rename). */
  persistNow() {
    this.persist()
  }

  /* `claude --continue` (and `codex resume --last`) reopen the newest
     conversation *in a folder* — they know nothing about which Orbit session
     that was. So Resume can only be offered where those two meanings coincide:
     on the most recently ended session of its folder and agent, and only while
     nothing is still live there. Offering it on an older entry would promise a
     conversation it cannot reach; offering it beside a running one would put a
     second agent into the conversation that one is holding. */
  list(): SessionInfo[] {
    const active = [...this.active.values()].map((s) => ({ ...metaOf(s), alive: true }))
    const dead = [...this.dead.values()].sort((a, b) =>
      (b.endedAt ?? '').localeCompare(a.endedAt ?? ''),
    )

    const conversation = (s: { cwd: string; providerId: string }) => `${s.providerId}\0${s.cwd}`
    const taken = new Set(active.map(conversation))

    return [
      ...active.map((s) => ({ ...s, resumable: false })),
      ...dead.map((m) => {
        const key = conversation(m)
        const resumable = !!getProvider(m.providerId)?.resumeCommand && !taken.has(key)
        // Whoever ended last owns the folder's conversation; the rest are history.
        taken.add(key)
        return { ...m, alive: false, resumable }
      }),
    ]
  }

  killAll() {
    // Shutdown path: flush history synchronously and mark everything ended.
    const stoppedAt = new Date().toISOString()
    for (const s of this.active.values()) {
      store.saveScrollbackSync(s.id, s.scrollback())
      this.dead.set(s.id, { ...metaOf(s), endedAt: stoppedAt })
      s.kill()
    }
    this.active.clear()
    this.persist()
  }

  private prune() {
    const excess = [...this.dead.values()]
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))
      .slice(DEAD_SESSIONS_KEPT)
    for (const meta of excess) {
      this.dead.delete(meta.id)
      store.deleteScrollback(meta.id)
    }
  }

  private persist() {
    store.saveAll([
      ...[...this.active.values()].map(metaOf),
      ...this.dead.values(),
    ])
  }
}
