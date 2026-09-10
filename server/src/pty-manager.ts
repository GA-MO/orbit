import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { spawn } from 'bun-pty'

interface PtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number; signal?: number | string }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}
const spawnPty: (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyProcess = spawn
import type { Provider } from './providers.js'
import { getProvider } from './providers.js'
import { platform } from './platform/index.js'
import * as idle from './idle.js'
import * as store from './store.js'
import * as transcripts from './transcripts.js'
import type { PersistedSession } from './store.js'

const SCROLLBACK_LIMIT = 200_000
const SCROLLBACK_FLUSH_MS = 2000
const DEAD_SESSIONS_KEPT = 20
const FIRST_COMMAND_MAX = 80
const TYPED_LINE_MAX = FIRST_COMMAND_MAX * 2
const SIGKILL_AFTER_MS = 3000

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const TERM = 'xterm-256color'
const BACKSPACE = '\x7f'

const ESCAPE_SEQUENCE = /\x1b(\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O[A-Za-z]|.)?/g
const CONTROL_CHAR = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g
const PLAIN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SHELL_PROVIDER: Provider = { id: 'shell', name: 'Shell', command: null, resumeCommand: null }

const printableOnly = (data: string): string => data.replace(ESCAPE_SEQUENCE, '').replace(CONTROL_CHAR, '')

const isLineBreak = (char: string): boolean => char === '\r' || char === '\n'

const byEndedAtNewestFirst = (a: PersistedSession, b: PersistedSession) =>
  (b.endedAt ?? '').localeCompare(a.endedAt ?? '')

const ptyEnv = (sessionId: string): Record<string, string> => {
  const env = { ...process.env } as Record<string, string>
  delete env.NO_COLOR
  delete env.NODE_DISABLE_COLORS
  env.TERM = TERM
  env.COLORTERM = 'truecolor'
  env.FORCE_COLOR = '1'
  env.CLICOLOR_FORCE = '1'
  env.ORBIT_SESSION = '1'
  env.ORBIT_SESSION_ID = sessionId
  return env
}

const launchSpec = (command: string | null | undefined): [file: string, args: string[]] => {
  const spec = command ? platform.runsCommandInLoginShell(command) : platform.opensInteractiveShell()
  return [spec.file, spec.args]
}

function keepTailEndingOnLineBoundary(buffer: string, limit: number): string {
  if (buffer.length <= limit) return buffer
  const cut = buffer.length - limit
  const nextLineBreak = buffer.indexOf('\n', cut)
  return buffer.slice(nextLineBreak === -1 ? cut : nextLineBreak + 1)
}

export interface SessionInfo extends PersistedSession {
  alive: boolean
  resumable: boolean
  external: boolean
}

export interface Session {
  id: string
  name: string | null
  firstCommand: string | null
  cwd: string
  provider: Provider
  conversationId: string | null
  createdAt: Date
  alive: boolean
  exitCode: number | null
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): () => void
  onInput(cb: (data: string) => void): () => void
  onExit(cb: (code: number) => void): () => void
  scrollback(): string
}

class PtySession implements Session {
  id = randomUUID()
  name: string | null = null
  firstCommand: string | null = null
  createdAt = new Date()
  alive = true
  exitCode: number | null = null

  onLabel: (() => void) | null = null

  private proc: PtyProcess
  private cols: number
  private rows: number
  private buffer = ''
  private lineBeingTyped = ''
  private dataSubs = new Set<(data: string) => void>()
  private inputSubs = new Set<(data: string) => void>()
  private exitSubs = new Set<(code: number) => void>()

  constructor(
    public cwd: string,
    public provider: Provider,
    cols: number,
    rows: number,
    command?: string | null,
    public conversationId: string | null = null,
  ) {
    const [file, args] = launchSpec(command ?? provider.command)

    this.cols = cols
    this.rows = rows
    this.proc = spawnPty(file, args, {
      name: TERM,
      cols,
      rows,
      cwd,
      env: ptyEnv(this.id),
    })

    this.proc.onData((data) => {
      this.buffer = keepTailEndingOnLineBoundary(this.buffer + data, SCROLLBACK_LIMIT)
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
    for (const cb of this.inputSubs) cb(data)
  }

  private captureFirstCommand(data: string) {
    for (const char of printableOnly(data)) {
      if (isLineBreak(char)) {
        const line = this.lineBeingTyped.trim()
        this.lineBeingTyped = ''
        if (!line) continue
        this.firstCommand = line.slice(0, FIRST_COMMAND_MAX)
        this.onLabel?.()
        return
      }
      if (char === BACKSPACE) this.lineBeingTyped = this.lineBeingTyped.slice(0, -1)
      else if (this.lineBeingTyped.length < TYPED_LINE_MAX) this.lineBeingTyped += char
    }
  }

  resize(cols: number, rows: number) {
    if (!this.alive || cols <= 0 || rows <= 0) return
    const alreadyThisSize = cols === this.cols && rows === this.rows
    if (alreadyThisSize) return
    this.cols = cols
    this.rows = rows
    this.proc.resize(cols, rows)
  }

  kill() {
    if (!this.alive) return
    this.proc.kill()
    const forceKillIfStillAlive = setTimeout(() => {
      if (this.alive) {
        try {
          this.proc.kill('SIGKILL')
        } catch {}
      }
    }, SIGKILL_AFTER_MS)
    forceKillIfStillAlive.unref?.()
  }

  onData(cb: (data: string) => void) {
    this.dataSubs.add(cb)
    return () => this.dataSubs.delete(cb)
  }

  onInput(cb: (data: string) => void) {
    this.inputSubs.add(cb)
    return () => this.inputSubs.delete(cb)
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
  conversationId: s.conversationId,
})

const conversationClaim = (s: PersistedSession) =>
  s.conversationId ? `c\0${s.conversationId}` : `${s.providerId}\0${s.cwd}`

const agentCanReopen = (m: PersistedSession): boolean => {
  const provider = getProvider(m.providerId)
  return m.conversationId ? !!provider?.conversation : !!provider?.resumeCommand
}

const flushScrollbackWhileRunning = (session: PtySession): { flushNow(): void } => {
  let flushTimer: NodeJS.Timeout | null = null
  session.onData(() => {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      store.saveScrollback(session.id, session.scrollback())
    }, SCROLLBACK_FLUSH_MS)
  })
  return {
    flushNow() {
      if (flushTimer) clearTimeout(flushTimer)
      store.saveScrollback(session.id, session.scrollback())
    },
  }
}

export class PtyManager {
  onQuiet: ((sessionId: string, message: string | null) => void) | null = null

  private active = new Map<string, PtySession>()
  private dead = new Map<string, PersistedSession>()
  private external = new Map<string, PersistedSession>()
  private hidden = new Set(store.loadHidden())
  private hiddenInScan = 0

  constructor() {
    const endedWithLastServer = new Date().toISOString()
    for (const meta of store.load()) {
      this.dead.set(meta.id, meta.endedAt ? meta : { ...meta, endedAt: endedWithLastServer })
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
      conversationId?: string | null
    } = {},
  ): Session {
    const provider = opts.provider ?? SHELL_PROVIDER
    const namesConversations = provider.conversation
    const conversationId = opts.conversationId ?? (namesConversations ? randomUUID() : null)
    const command =
      opts.command ?? (conversationId && namesConversations ? namesConversations.start(conversationId) : undefined)

    const session = new PtySession(
      opts.cwd ?? os.homedir(),
      provider,
      opts.cols ?? DEFAULT_COLS,
      opts.rows ?? DEFAULT_ROWS,
      command,
      conversationId,
    )
    if (opts.name) session.name = opts.name
    session.onLabel = () => this.persist()
    this.active.set(session.id, session)

    const runsAnAgent = !!provider.command
    if (runsAnAgent) {
      idle.watch(session, (message) => this.onQuiet?.(session.id, message))
    }

    const scrollbackFlush = flushScrollbackWhileRunning(session)

    session.onExit(() => {
      scrollbackFlush.flushNow()
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
    return this.dead.has(id) || this.external.has(id)
  }

  isExternal(id: string): boolean {
    return this.external.has(id)
  }

  private idsClaimedByOrbit(): Set<string> {
    const claimed = new Set<string>()
    for (const s of [...this.active.values(), ...this.dead.values()]) {
      claimed.add(s.id)
      if (s.conversationId) claimed.add(s.conversationId)
    }
    return claimed
  }

  async discover(): Promise<void> {
    const claimed = this.idsClaimedByOrbit()
    const hiddenStillExternal = new Set([...this.hidden].filter((id) => !claimed.has(id)))
    const scan = await transcripts.discover(hiddenStillExternal)
    this.external = new Map(scan.rows.filter((r) => !claimed.has(r.id)).map((r) => [r.id, r]))
    this.hiddenInScan = scan.hidden
    if (scan.present) this.sweepHidden(scan.present)
  }

  hide(id: string): boolean {
    if (!this.external.has(id) || this.hidden.has(id)) return false
    this.hidden.add(id)
    this.external.delete(id)
    this.hiddenInScan++
    store.saveHidden([...this.hidden])
    return true
  }

  unhide(id: string): boolean {
    if (!this.hidden.delete(id)) return false
    store.saveHidden([...this.hidden])
    return true
  }

  unhideAll(): number {
    const count = this.hidden.size
    if (count === 0) return 0
    this.hidden.clear()
    store.saveHidden([])
    return count
  }

  hiddenCount(): number {
    return this.hiddenInScan
  }

  private sweepHidden(stillOnDisk: Set<string>) {
    if (stillOnDisk.size === this.hidden.size) return
    this.hidden = stillOnDisk
    store.saveHidden([...this.hidden])
  }

  deadScrollback(id: string): Promise<string> {
    if (this.external.has(id)) return transcripts.render(id)
    return store.readScrollback(id)
  }

  private isResumable(id: string): boolean {
    return !!this.list().find((s) => s.id === id)?.resumable
  }

  restart(id: string, resume = false): Session | null {
    const meta = this.dead.get(id) ?? this.external.get(id)
    if (!meta) return null
    const provider = getProvider(meta.providerId)
    if (!provider) return null
    if (resume && !this.isResumable(id)) return null

    const pinnedConversation =
      resume && meta.conversationId && provider.conversation && PLAIN_UUID.test(meta.conversationId)
        ? meta.conversationId
        : null
    const resumeCommand = pinnedConversation
      ? provider.conversation!.resume(pinnedConversation)
      : provider.resumeCommand
    const session = this.create({
      provider,
      cwd: meta.cwd,
      name: meta.name ?? undefined,
      command: resume ? resumeCommand : undefined,
      conversationId: pinnedConversation ?? undefined,
    })
    const replacesOldRow = resume
    if (replacesOldRow) this.forget(id)
    return session
  }

  forget(id: string): boolean {
    if (!this.dead.delete(id)) return false
    store.deleteScrollback(id)
    this.persist()
    return true
  }

  persistNow() {
    this.persist()
  }

  list(): SessionInfo[] {
    const active = [...this.active.values()].map((s) => ({ ...metaOf(s), alive: true }))
    const ended = [...this.dead.values(), ...this.external.values()].sort(byEndedAtNewestFirst)

    const claimedByNewer = new Set(active.map(conversationClaim))

    return [
      ...active.map((s) => ({ ...s, resumable: false, external: false })),
      ...ended.map((m) => {
        const claim = conversationClaim(m)
        const resumable = agentCanReopen(m) && !claimedByNewer.has(claim)
        claimedByNewer.add(claim)
        return { ...m, alive: false, resumable, external: this.external.has(m.id) }
      }),
    ]
  }

  killAll() {
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
    const excess = [...this.dead.values()].sort(byEndedAtNewestFirst).slice(DEAD_SESSIONS_KEPT)
    for (const meta of excess) {
      this.dead.delete(meta.id)
      store.deleteScrollback(meta.id)
    }
  }

  private persist() {
    store.saveAll([...[...this.active.values()].map(metaOf), ...this.dead.values()])
  }
}
