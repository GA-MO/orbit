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
}

export interface Session {
  id: string
  name: string | null
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
  createdAt = new Date()
  alive = true
  exitCode: number | null = null

  private proc: pty.IPty
  private buffer = ''
  private dataSubs = new Set<(data: string) => void>()
  private exitSubs = new Set<(code: number) => void>()

  constructor(
    public cwd: string,
    public provider: Provider,
    cols: number,
    rows: number,
  ) {
    // Agent CLIs launch through an interactive login shell so the user's PATH
    // applies; `exec` replaces the shell so exiting the agent ends the session.
    const shell = process.env.SHELL ?? '/bin/zsh'
    const [file, args] = provider.command
      ? ['/bin/zsh', ['-l', '-i', '-c', `exec ${provider.command}`]]
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
    if (this.alive) this.proc.write(data)
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
    opts: { cwd?: string; provider?: Provider; name?: string; cols?: number; rows?: number } = {},
  ): Session {
    const session = new PtySession(
      opts.cwd ?? os.homedir(),
      opts.provider ?? { id: 'shell', name: 'Shell', command: null },
      opts.cols ?? 80,
      opts.rows ?? 24,
    )
    if (opts.name) session.name = opts.name
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

  /** Relaunch an ended session: new PTY, same provider, folder, and name. */
  restart(id: string): Session | null {
    const meta = this.dead.get(id)
    if (!meta) return null
    const provider = getProvider(meta.providerId)
    if (!provider) return null
    return this.create({ provider, cwd: meta.cwd, name: meta.name ?? undefined })
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

  list(): SessionInfo[] {
    const active = [...this.active.values()].map((s) => ({ ...metaOf(s), alive: true }))
    const dead = [...this.dead.values()]
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))
      .map((m) => ({ ...m, alive: false }))
    return [...active, ...dead]
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
