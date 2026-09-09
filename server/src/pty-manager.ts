import { randomUUID } from 'node:crypto'
import os from 'node:os'
import * as pty from 'node-pty'
import type { Provider } from './providers.js'
import { getProvider } from './providers.js'
import * as idle from './idle.js'
import * as store from './store.js'
import * as transcripts from './transcripts.js'
import type { PersistedSession } from './store.js'

const SCROLLBACK_LIMIT = 200_000 // chars kept for replay on reconnect
const SCROLLBACK_FLUSH_MS = 2000
/** How long a repaint holds the nudged size — see `repaint`. */
const REPAINT_HOLD_MS = 120
/** How recently the agent must have written for the screen a phone attaches to
    to count as one still being drawn — see `repaintOnAttach`. */
const DRAWING_WINDOW_MS = 500
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
const ptyEnv = (sessionId: string): Record<string, string> => {
  const env = { ...process.env } as Record<string, string>
  delete env.NO_COLOR
  delete env.NODE_DISABLE_COLORS
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.FORCE_COLOR = '1'
  env.CLICOLOR_FORCE = '1'
  /* Anything started in here inherits this, so a hook can tell "the user is
     driving me from their phone" from "the user is sitting right there". */
  env.ORBIT_SESSION = '1'
  /* And *which* of them, so a message from an agent can be filed against the
     session it came out of. The agent, its MCP servers and its hooks are all
     descendants of this PTY, so they inherit it without being told. Matching on
     the folder instead guesses wrong the moment two sessions share one. */
  env.ORBIT_SESSION_ID = sessionId
  return env
}

export interface SessionInfo extends PersistedSession {
  alive: boolean
  /** Whether this session's agent can pick its last conversation back up. */
  resumable: boolean
  /** A conversation from the Mac's own terminal — Orbit reads it, owns nothing. */
  external: boolean
}

export interface Session {
  id: string
  name: string | null
  /** First line typed here, kept as a fallback label. */
  firstCommand: string | null
  cwd: string
  provider: Provider
  /** The agent's name for the conversation held here, where it takes one. */
  conversationId: string | null
  createdAt: Date
  alive: boolean
  exitCode: number | null
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Set the size and make whatever owns the screen draw itself again. */
  repaint(cols: number, rows: number): void
  /** A repaint on attaching, asked for only where the replay is not the screen. */
  repaintOnAttach(cols: number, rows: number): void
  kill(): void
  /** Subscribe to output; returns unsubscribe. */
  onData(cb: (data: string) => void): () => void
  /** Subscribe to input reaching the PTY — what the user typed or sent. */
  onInput(cb: (data: string) => void): () => void
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
  private cols: number
  private rows: number
  private buffer = ''
  private typed = '' // keystrokes since the last Enter, until firstCommand is set
  /** Pending second half of a `repaint`. */
  private repaintTimer: ReturnType<typeof setTimeout> | null = null
  /** When the agent last wrote — how a half-drawn screen is told from a whole one. */
  private lastDataAt = 0
  private dataSubs = new Set<(data: string) => void>()
  private inputSubs = new Set<(data: string) => void>()
  private exitSubs = new Set<(code: number) => void>()

  constructor(
    public cwd: string,
    public provider: Provider,
    cols: number,
    rows: number,
    /** Overrides the provider's launch command — used to resume a conversation. */
    command?: string | null,
    /** The conversation this session holds, for agents that let Orbit name one. */
    public conversationId: string | null = null,
  ) {
    // Agent CLIs launch through an interactive login shell so the user's PATH
    // applies; `exec` replaces the shell so exiting the agent ends the session.
    const shell = process.env.SHELL ?? '/bin/zsh'
    const launch = command ?? provider.command
    const [file, args] = launch
      ? ['/bin/zsh', ['-l', '-i', '-c', `exec ${launch}`]]
      : [shell, ['-l']]

    this.cols = cols
    this.rows = rows
    this.proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: ptyEnv(this.id),
    })

    this.proc.onData((data) => {
      this.lastDataAt = Date.now()
      this.buffer += data
      if (this.buffer.length > SCROLLBACK_LIMIT) {
        /* Cutting at an exact offset lands in the middle of an escape sequence
           often enough to matter: replaying that leaves the terminal parsing a
           sequence that never started, and it eats the text that follows. Give
           up the extra characters and cut after the next line break instead. */
        const cut = this.buffer.length - SCROLLBACK_LIMIT
        const nl = this.buffer.indexOf('\n', cut)
        this.buffer = this.buffer.slice(nl === -1 ? cut : nl + 1)
      }
      for (const cb of this.dataSubs) cb(data)
    })

    this.proc.onExit(({ exitCode }) => {
      this.alive = false
      this.exitCode = exitCode
      if (this.repaintTimer) clearTimeout(this.repaintTimer)
      this.repaintTimer = null
      for (const cb of this.exitSubs) cb(exitCode)
    })
  }

  write(data: string) {
    if (!this.alive) return
    if (this.firstCommand === null) this.captureFirstCommand(data)
    this.proc.write(data)
    for (const cb of this.inputSubs) cb(data)
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
    if (this.alive && cols > 0 && rows > 0) {
      this.cols = cols
      this.rows = rows
      this.proc.resize(cols, rows)
    }
  }

  /* A phone that comes back is looking at the frame that was on screen when it
     left, and its terminal may be a different size now. If it is, saying so is
     enough. If it is not — the usual case, and the one this exists for — then
     nothing has changed for the kernel to signal, and a full-screen app has no
     reason to draw anything at all. So arrive at the size the client wants by
     way of one row less. The app draws twice; the second draw is the one that
     fits.

     Both sizes have to be *observed*, though, and that is why this waits in
     between. SIGWINCH is not queued: two of them raised in the same breath
     reach a busy process as one, and the handler then reads the size that is
     already back to what it was — no change, no redraw. Which is exactly the
     case this exists for, since the agent is usually mid-tool when the phone
     returns. Hold the shorter size long enough for the app to answer it. */
  repaint(cols: number, rows: number) {
    if (!this.alive || cols <= 0 || rows <= 0) return
    if (this.repaintTimer) clearTimeout(this.repaintTimer)
    /* A size it has not seen is its own signal: the kernel raises SIGWINCH,
       the app answers with one whole frame, and that frame already fits. The
       detour below would only make it draw a second one at a size nobody
       asked for — which is what every fold of the key bar and every keyboard
       sliding in was paying for, and what made those stutter. */
    if (cols !== this.cols || rows !== this.rows) {
      this.resize(cols, rows)
      return
    }
    this.resize(cols, Math.max(1, rows - 1))
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = null
      this.resize(cols, rows)
    }, REPAINT_HOLD_MS)
  }

  /* What a phone gets on attaching is the replay, and at the same size that is
     the very screen the agent drew — whole, and worth nothing to draw again.
     Walking the agent down a row and back for it is two more frames landing on
     top of the one already there, which is the flicker every switch between
     sessions used to open with.

     Two things spoil the replay, and both are asked here. A different size:
     the frames in it were laid out for the old one. And an agent that was
     writing as the phone arrived: the tail of the replay is then half a frame,
     and only the agent can finish it. */
  repaintOnAttach(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) {
      if (Date.now() - this.lastDataAt > DRAWING_WINDOW_MS) return
    }
    this.repaint(cols, rows)
  }

  kill() {
    if (this.alive) this.proc.kill()
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

export class PtyManager {
  /**
   * Called when a session finishes drawing and goes quiet — see `idle.ts`.
   *
   * A callback rather than a call into `attention` because who cares that a
   * session settled is a question about phones, pushes and what is on screen,
   * none of which belongs to the thing that owns the PTYs.
   */
  onQuiet: ((sessionId: string, message: string | null) => void) | null = null

  private active = new Map<string, PtySession>()
  private dead = new Map<string, PersistedSession>()
  /** Conversations run from a terminal on the Mac. Read-only, never persisted. */
  private external = new Map<string, PersistedSession>()
  /* The ✕ the user wants on a conversation from the Mac cannot be a delete: that
     file is Claude Code's record of an afternoon at the desk, and `forget` below
     refuses external rows for exactly that reason. Hiding is the honest version
     of the same tap. Orbit writes down that this phone does not want to see that
     id again and drops it on the way out of every scan; the transcript stays
     where it is, and `claude --resume` at the desk still finds it. Ids rather
     than files is the whole point — nothing here can lose a conversation.

     Only conversations from the Mac can be hidden. Orbit's own ended sessions
     already have a ✕ that means what it says, and a second, quieter way to make
     a row disappear would leave the user with two ways to lose a session and no
     way to tell which one they used. {@link hide} enforces that at the door, and
     {@link discover} enforces it again by sweeping any id Orbit has since
     claimed as a session of its own. */
  private hidden = new Set(store.loadHidden())
  /** How many rows the last scan held back — see {@link hiddenCount}. */
  private hiddenInScan = 0

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
      /** Carried over by {@link restart} when reopening a pinned conversation. */
      conversationId?: string | null
    } = {},
  ): Session {
    const provider =
      opts.provider ?? { id: 'shell', name: 'Shell', command: null, resumeCommand: null }

    /* A conversation nobody named can only be found again as "the newest one in
       this folder", which is a different thing that is usually the same thing —
       until the day it is not. Naming it at launch is what makes an ended
       session reachable as *itself*, however many have been opened since. */
    const conversationId =
      opts.conversationId ?? (provider.conversation ? randomUUID() : null)
    const command =
      opts.command ??
      (conversationId && provider.conversation
        ? provider.conversation.start(conversationId)
        : undefined)

    const session = new PtySession(
      opts.cwd ?? os.homedir(),
      provider,
      opts.cols ?? 80,
      opts.rows ?? 24,
      command,
      conversationId,
    )
    if (opts.name) session.name = opts.name
    session.onLabel = () => this.persist()
    this.active.set(session.id, session)

    /* Agents only. A shell sitting at its prompt is quiet by definition and
       has been waiting for input since the moment it started — reporting that
       would put a badge on every shell in the list and mean nothing by it. */
    if (provider.command) {
      idle.watch(session, (message) => this.onQuiet?.(session.id, message))
    }

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
    return this.dead.has(id) || this.external.has(id)
  }

  /** True for a conversation Orbit did not start and must not delete. */
  isExternal(id: string): boolean {
    return this.external.has(id)
  }

  /**
   * Pick up the conversations run from a terminal on the Mac.
   *
   * The ones Orbit started are dropped: their transcript is the same file, and
   * a conversation offered from two rows is one that can be opened twice.
   */
  async discover(): Promise<void> {
    const mine = new Set<string>()
    for (const s of [...this.active.values(), ...this.dead.values()]) {
      mine.add(s.id)
      if (s.conversationId) mine.add(s.conversationId)
    }
    /* A hidden id that Orbit has since claimed is no longer a conversation from
       the Mac, so it is not offered to the scan and is swept below. */
    const scan = await transcripts.discover(
      new Set([...this.hidden].filter((id) => !mine.has(id))),
    )
    this.external = new Map(scan.rows.filter((r) => !mine.has(r.id)).map((r) => [r.id, r]))
    this.hiddenInScan = scan.hidden
    if (scan.present) this.sweepHidden(scan.present)
  }

  /**
   * Ask for a conversation from the Mac to stop appearing in the list.
   *
   * External only, and deliberately checked against the rows the last scan
   * produced rather than against anything on the disk: what the phone can hide
   * is what the phone was just shown. Returns whether anything changed, so a
   * route can answer 404 for an id that is not one of these — an ended session
   * of Orbit's own included, which has a real {@link forget} instead.
   */
  hide(id: string): boolean {
    if (!this.external.has(id) || this.hidden.has(id)) return false
    this.hidden.add(id)
    this.external.delete(id)
    this.hiddenInScan++
    store.saveHidden([...this.hidden])
    return true
  }

  /**
   * Put one back. Not gated on the row existing, because a hidden row is by
   * definition not in the list — the id is all the caller has.
   */
  unhide(id: string): boolean {
    if (!this.hidden.delete(id)) return false
    store.saveHidden([...this.hidden])
    return true
  }

  /**
   * Put all of them back, which is the only undo the phone can offer.
   *
   * Hiding one row is a tap; finding that one row again afterwards is not,
   * because a hidden row is by definition not on screen and there is nothing
   * left to aim at. So the way back is all-or-nothing, hung off the count in
   * the group header — the alternative, a second list of hidden conversations
   * to un-hide one at a time, is a screen built entirely out of things the user
   * has already said they do not want to look at.
   */
  unhideAll(): number {
    const count = this.hidden.size
    if (count === 0) return 0
    this.hidden.clear()
    store.saveHidden([])
    /* The rows come back on the next scan, not now: they were dropped from
       `external` when they were hidden, and only `discover` reads the disk. */
    return count
  }

  /**
   * How many rows the list is not showing, for the collapsed group that says so.
   *
   * Counted from the scan rather than from the size of the hidden list, because
   * those are different questions: the list remembers ids for as long as their
   * transcripts exist, while this is how many of them the phone would be looking
   * at right now. One that has aged out of the scan window is not being held
   * back from anything, and counting it would put a number on a group that can
   * never be shown.
   */
  hiddenCount(): number {
    return this.hiddenInScan
  }

  /* An id whose transcript Claude Code has since pruned — it drops them at
     thirty days — can never come back, so remembering it is dead weight that
     only grows. It is swept here rather than on a timer because this is the one
     place that already knows what is on the disk: the scan stats every
     transcript anyway, so the answer is free, and a scan that read nothing at
     all declines to answer rather than guessing the disk is empty. */
  private sweepHidden(present: Set<string>) {
    if (present.size === this.hidden.size) return
    this.hidden = present
    store.saveHidden([...this.hidden])
  }

  deadScrollback(id: string): Promise<string> {
    /* Nothing drew this one on Orbit's screen, so there are no bytes to replay
       — the conversation is rebuilt from the transcript instead. */
    if (this.external.has(id)) return transcripts.render(id)
    return store.readScrollback(id)
  }

  /**
   * Start again from an ended session: new PTY, same provider, folder, and name.
   *
   * With `resume`, the agent picks a conversation back up instead of starting a
   * fresh one — *this* session's conversation where it was named at launch, and
   * otherwise the newest one in the folder, which is all the older agents can
   * be asked for. Either way only for an entry {@link list} marked resumable.
   *
   * Without `resume` a new conversation is minted, because ＋ means a new one,
   * and the session it came from stays where it was.
   *
   * A resume, though, takes the old row's place rather than standing beside it.
   * That is already what a conversation from the Mac's own terminal does, since
   * {@link discover} drops any transcript some session has claimed — resuming
   * one there has always meant the Orbit row replaces it. Leaving Orbit's own
   * sessions behind made the list say something else: five resumes left six
   * rows for one conversation, five of them dead ends holding a fragment of the
   * scrollback each, and all six spending the room {@link prune} keeps for
   * sessions worth going back to. The price is that terminal history: the
   * conversation itself is whole, because it lives with the agent and comes
   * back with it, but what was on Orbit's screen before now starts at the
   * resume. Carrying the old buffer into the new one was the alternative, and
   * a scrollback stitched from two runs of the agent reads worse than one that
   * plainly begins where the user picked it up.
   */
  restart(id: string, resume = false): Session | null {
    const meta = this.dead.get(id) ?? this.external.get(id)
    if (!meta) return null
    const provider = getProvider(meta.providerId)
    if (!provider) return null
    if (resume && !this.list().find((s) => s.id === id)?.resumable) return null

    const pinned = resume && meta.conversationId && provider.conversation ? meta.conversationId : null
    const session = this.create({
      provider,
      cwd: meta.cwd,
      name: meta.name ?? undefined,
      command: resume ? (pinned ? provider.conversation!.resume(pinned) : provider.resumeCommand) : undefined,
      // The reopened session *is* that conversation, so it can be reopened again.
      conversationId: pinned ?? undefined,
    })
    /* Only once there is something to replace it with — a launch that failed
       would otherwise cost the row and its history as well. `forget` refuses an
       external row by only ever deleting from `this.dead`, which is what should
       happen: that file is Claude Code's, and `discover` already drops the row
       now that this session claims the conversation. */
    if (resume) this.forget(id)
    return session
  }

  /**
   * Remove an ended session and its history. Active sessions must be killed
   * instead, and a conversation from the Mac is not Orbit's to delete.
   */
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

  /* Which ended sessions can be picked back up, and it turns on what the agent
     can be asked for.

     `claude --continue` and `codex resume --last` reopen the newest conversation
     *in a folder* — they know nothing about which Orbit session that was. So for
     those, Resume can only be offered where the two meanings coincide: the most
     recently ended session of its folder and agent, and only while nothing is
     still live there. Offering it on an older entry would promise a conversation
     it cannot reach; offering it beside a running one would put a second agent
     into the conversation that one is holding.

     A session launched with a conversation of its own is not bound by any of
     that: it asks for that conversation by name, so a folder's third-newest is
     as reachable as its newest. Its claim is the conversation rather than the
     folder — which still stops the same one being opened twice, and stops a
     resumed-then-ended session offering the same conversation from two rows. */
  list(): SessionInfo[] {
    const active = [...this.active.values()].map((s) => ({ ...metaOf(s), alive: true }))
    /* Ended is ended, wherever the session ran. Interleaving the two by when
       they were last touched is the order a reader is looking for. */
    const dead = [...this.dead.values(), ...this.external.values()].sort((a, b) =>
      (b.endedAt ?? '').localeCompare(a.endedAt ?? ''),
    )

    const claim = (s: PersistedSession) =>
      s.conversationId ? `c\0${s.conversationId}` : `${s.providerId}\0${s.cwd}`
    const taken = new Set(active.map(claim))

    return [
      ...active.map((s) => ({ ...s, resumable: false, external: false })),
      ...dead.map((m) => {
        const key = claim(m)
        const provider = getProvider(m.providerId)
        const reachable = m.conversationId ? !!provider?.conversation : !!provider?.resumeCommand
        const resumable = reachable && !taken.has(key)
        taken.add(key)
        return { ...m, alive: false, resumable, external: this.external.has(m.id) }
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
