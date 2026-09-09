import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import TerminalKeys, { type ModState } from './components/TerminalKeys'
import SelectSheet from './sheets/SelectSheet'
import PageViewer from './components/PageViewer'
import { Button, IconButton, IconClose, Sheet } from './components/ui'
import { writeToClipboard } from './clipboard'
import { canFrame, openExternal } from './local-url'
import { linkAt, registerLinkProvider } from './terminal-links'
import { isBlankRow, snapshot, type Snapshot } from './terminal-snapshot'
import { isTouchDevice } from './touch'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'ended'

export interface TerminalHandle {
  /** Write raw input into the PTY (as if typed). */
  write(data: string): void
  /** Deliver text the way a paste arrives — see the handle below for why. */
  paste(text: string): void
  approve(id: string): void
  deny(id: string): void
  /** Answer a question raised from the Mac side. */
  answer(id: string, choice: string): void
  focus(): void
  blur(): void
}

export interface ApprovalRequest {
  id: string
  label: string
  command: string
}

/** A question an agent (or a hook) is holding open until the phone answers. */
export interface AskRequest {
  id: string
  question: string
  detail: string | null
  options: string[]
  source: string | null
  /** The session it came out of, when the Mac side knew which one that was. */
  sessionId: string | null
}

/**
 * A page the agent on the Mac has published over the tailnet and wants looked
 * at. The Mac has already done the work of turning a port into a URL the phone
 * can reach; all that arrives here is where to point.
 */
export interface PreviewRequest {
  id: string
  /** Full https URL, path and all. */
  url: string
  /** The dev server's port on the Mac — what the page is called on this side. */
  port: number
  source: string | null
  sessionId: string | null
}

const RECONNECT_DELAY_MS = 1500
/** Press-and-hold before the terminal offers its text for selecting.

    Nothing happens at the end of it but a tick of haptic: the panel opens when
    the finger *lifts*, and only if it never left the slop. That is what makes
    the ambiguity go away rather than get adjudicated. A press and a scroll
    begin identically, and every rule tried for telling them apart mid-gesture —
    distance, speed, direction, how long the finger had been still — either
    misread a real scroll or broke a real selection, because the two movements
    genuinely are the same movement until the finger stops. Waiting for the lift
    costs the selection nothing and hands the scroll every gesture that moves. */
const LONG_PRESS_MS = 420
/**
 * Whether the app on the other end owns the screen.
 *
 * On the alternate screen xterm's buffer holds only the current frame, so there
 * is no history for a local scroll to move; and with mouse tracking on, xterm
 * disables its own touch scrolling outright (`coreMouseService
 * .areMouseEventsActive` gates `handleTouchStart`/`handleTouchMove`) and
 * forwards the touch to the app as a mouse event instead — which iOS never
 * synthesises from a drag, so a swipe simply went nowhere.
 *
 * Claude Code sets both, and not at startup: the first frames are ordinary
 * output and the modes arrive once its UI takes over. Either one alone means
 * the scroll has to be handed to the app.
 */
const appOwnsScreen = (term: XTerm) =>
  term.buffer.active.type === 'alternate' || term.modes.mouseTrackingMode !== 'none'

/**
 * One notch of the wheel the app asked for, SGR-encoded.
 *
 * An app that owns the screen scrolls its own pane by the wheel, one line a
 * notch — which is what makes a swipe able to follow the finger at all.
 * PageUp/PageDown is the same idea a whole screen at a time, and reads as a
 * jump when a finger is what moved. Measured against `claude`: a wheel report
 * moves its transcript exactly one line, PageDown moves it a full page.
 *
 * The cell under the finger goes in the report because that is what a mouse
 * would say. Claude Code does not read it, but an app that puts a scrollable
 * pane beside something else would.
 */
const wheelReport = (term: XTerm, up: boolean, clientX: number, clientY: number) => {
  const box = term.element?.getBoundingClientRect()
  const col = box ? Math.floor(((clientX - box.left) / box.width) * term.cols) + 1 : 1
  const row = box ? Math.floor(((clientY - box.top) / box.height) * term.rows) + 1 : 1
  const clamp = (n: number, max: number) => Math.min(max, Math.max(1, n))
  return `\x1b[<${up ? 64 : 65};${clamp(col, term.cols)};${clamp(row, term.rows)}M`
}

/** Notches one touchmove may deliver. A flick that outruns this keeps the rest
    for the next event rather than firing a screenful in one frame. */
const MAX_NOTCHES_PER_MOVE = 12

/* ---- the fling ----

   Velocity is measured over the tail of the drag rather than the whole of it,
   so a swipe that slowed to a stop before the finger left does not throw. */
const FLING_SAMPLE_MS = 90
/** Below this the finger was placed, not thrown. px/ms. */
const FLING_MIN_VELOCITY = 0.35
/** And above this it was not a thumb. Two samples a millisecond apart can read
    as any speed at all; the glide is ~280x the velocity, so an outlier that got
    through would throw several screens. A fast flick is about this. */
const FLING_MAX_VELOCITY = 4
/** Per frame at 60fps. Lower stops sooner; this lands around two thirds of a
    second, which is about as long as a thrown list keeps moving. */
const FLING_FRICTION = 0.94
/** Where the glide is slow enough that another notch would be a twitch. */
const FLING_STOP_VELOCITY = 0.04

/** Finger travel that turns a press into a scroll. */
const TOUCH_SLOP_PX = 8
/** How long a returning phone waits for the server to answer before giving up on the socket. */
const PROBE_TIMEOUT_MS = 3000
/** Quiet spell that marks the end of a burst of layout changes. */
const RESIZE_SETTLE_MS = 180
/** How long after a deliberate, one-step layout change its resize still counts
    as that change, and skips the wait meant for bursts. Long enough to cover a
    frame or two of React and layout; short enough that the keyboard sliding in
    a moment later is not mistaken for it. */
const DELIBERATE_WINDOW_MS = 500
/** Quiet spell after a resize that says the agent has finished answering it. */
const POST_RESIZE_QUIET_MS = 150
/** How recently the agent must have written for a resize to count as landing
    on a busy one. Covers the message that ends the moment the bar is folded —
    the redraw it owes is just as missing as the one it never finished. */
const BUSY_WINDOW_MS = 500
/** How long a resize keeps waiting for that quiet before giving up on it —
    a spinner or a running build never stops writing. */
const POST_RESIZE_MAX_MS = 1500

// iOS Safari draws a lone ำ (U+0E33) as a dotted circle with a floating mark above
// it. xterm gives ำ a cell of its own — it is a spacing character — and the shaper
// then splits it into a combining nikhahit plus า, leaving the nikhahit with no base
// to sit on. Writing the canonical decomposition ourselves puts the nikhahit in the
// same cell as the consonant before it, where it shapes correctly. Column widths are
// untouched: the nikhahit is zero-width, so the trailing า still occupies the single
// cell the ำ did, and box-drawn output stays aligned.
const SARA_AM_DECOMPOSED: Record<string, string> = {
  'ำ': 'ํา', // Thai ำ → ํ + า
  'ຳ': 'ໍາ', // Lao  ຳ → ໍ + າ
}
const decomposeSaraAm = (data: string) =>
  data.replace(/[ำຳ]/g, (c) => SARA_AM_DECOMPOSED[c])

interface Props {
  /** Session to attach to. The parent remounts this component (via key) to switch. */
  sessionId: string
  /** False while another tab is visible — used to refit when returning. */
  active?: boolean
  onStatus: (status: ConnectionStatus) => void
  /** Server attached us to a different session (requested one was gone). */
  onSession: (id: string) => void
  /** The requested session does not exist on the Mac at all. */
  onGone: () => void
  onExit: (code: number) => void
  /** Session is ended or read-only — refresh the header from the server. */
  onSessionState?: () => void
  onAuthFail: () => void
  onApproval: (request: ApprovalRequest) => void
  /**
   * An agent or hook on the Mac wants to say something to whoever holds the
   * phone. `alreadyPushed` marks the ones that arrived as a notification while
   * the app was away — showing them again would be the second banner.
   */
  onNotice: (
    message: string,
    meta?: { sessionId?: string | null; alreadyPushed?: boolean },
  ) => void
  onAsk: (request: AskRequest) => void
  /* Writing a whole message, as against sending a key: the button lives in the
     key bar, which this component owns, but the draft and the sheet belong to
     the app above it. */
  onCompose: () => void
  draftPending: boolean
  /**
   * A session's standing state changed with nothing to say about it — one went
   * quiet and Orbit noticed by itself. No words and no toast: the badge in the
   * Sessions tab is the whole message, so this only asks for a refresh.
   */
  onAttention: () => void
  /**
   * The agent wants a page on the screen. Handed up rather than framed here:
   * the terminal is one tab of four, and "go and look at this" cannot only
   * work while the terminal happens to be the tab in front.
   */
  onPreview: (request: PreviewRequest) => void
  /** Hand a file on the Mac to the prompt — a capture taken from a framed page. */
  onInsertPath?: (path: string) => void
  onToast?: (message: string) => void
  handleRef?: MutableRefObject<TerminalHandle | null>
}

export default function Terminal({
  sessionId,
  active = true,
  onStatus,
  onSession,
  onGone,
  onExit,
  onSessionState,
  onAuthFail,
  onApproval,
  onNotice,
  onAsk,
  onAttention,
  onCompose,
  draftPending,
  onPreview,
  onInsertPath,
  onToast,
  handleRef,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  /** The glide's rAF handle, so a new touch — or leaving the tab — kills it. */
  const flingFrame = useRef<number | null>(null)
  const sendRef = useRef<(msg: object) => void>(() => {})
  const refitRef = useRef<(scrollToBottom?: boolean) => void>(() => {})
  /** Redraw what is already in the buffer — no PTY, no SIGWINCH, one frame. */
  const refreshRef = useRef<() => void>(() => {})
  /** Ask the agent to finish the screen, but only if it was drawing one. */
  const settleOnReturnRef = useRef<() => void>(() => {})
  /** Told by the key bar that the size about to change is changing once. */
  const layoutStepRef = useRef<() => void>(() => {})
  /* Whether this session is the one on screen — not merely the one connected.
     The terminal stays mounted behind the other two tabs, and a phone in a
     pocket holds its socket open until iOS gets round to freezing it. The
     server needs the difference to decide what is worth interrupting for. */
  const activeRef = useRef(active)
  const reportViewingRef = useRef<() => void>(() => {})
  const mobileRef = useRef(isTouchDevice())
  const [showKeys] = useState(() => isTouchDevice())
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  // Ended sessions replay history with no PTY behind them — input controls are hidden.
  const [readOnly, setReadOnly] = useState(false)
  const [ctrl, setCtrl] = useState<ModState>('off')
  const ctrlRef = useRef<ModState>('off')
  /* A frozen copy of the buffer, open in the panel. The terminal draws its own
     text and never stops redrawing it, so nothing selected on the terminal
     itself could survive; this is where selecting happens instead. */
  const [picking, setPicking] = useState<Snapshot | null>(null)
  /* A mouse drag on a desktop still selects in xterm itself, and xterm's
     selection has no menu, no handles and no keyboard shortcut behind it. The
     bar is the way out of that one — the phone does not use it. */
  const [selection, setSelection] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  /** A tapped link, waiting for the tap that says what to do with it. */
  const [linkPrompt, setLinkPrompt] = useState<string | null>(null)
  const [linkArmed, setLinkArmed] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  /** A page being read inside Orbit rather than in a browser of its own. */
  const [viewer, setViewer] = useState<string | null>(null)

  useEffect(() => {
    if (!linkPrompt) return setLinkArmed(false)
    const timer = setTimeout(() => setLinkArmed(true), 350)
    return () => clearTimeout(timer)
  }, [linkPrompt])
  const setCtrlMod = (next: ModState) => {
    ctrlRef.current = next
    setCtrl(next)
  }
  const callbacksRef = useRef({
    onStatus,
    onSession,
    onGone,
    onExit,
    onSessionState,
    onAuthFail,
    onApproval,
    onNotice,
    onAsk,
    onAttention,
    onPreview,
  })
  callbacksRef.current = {
    onStatus,
    onSession,
    onGone,
    onExit,
    onSessionState,
    onAuthFail,
    onApproval,
    onNotice,
    onAsk,
    onAttention,
    onPreview,
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "SF Mono", monospace',
      scrollback: 5000,
      theme: {
        background: '#0a0c10',
        foreground: '#e9ecf2',
        cursor: '#93a5fd',
        selectionBackground: '#2c3654',
        /* A selection made by holding a finger down never focuses the terminal,
           and xterm dims an unfocused selection to almost nothing — on a phone
           that reads as "the long press did nothing". Same colour, both states. */
        selectionInactiveBackground: '#2c3654',
      },
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)

    /* A tap runs our own hit test *and* the click Safari synthesises from it,
       and xterm activates the link on that click too — without this the phone
       would answer one tap twice. */
    let lastLink = { uri: '', at: 0 }
    const presentLink = (uri: string) => {
      const now = Date.now()
      if (uri === lastLink.uri && now - lastLink.at < 800) return
      lastLink = { uri, at: now }
      /* Nothing here ever navigates the app away. Leaving for the browser costs
         the session its screen — iOS drops a backgrounded page, and an
         installed web app has no second tab to send a same-origin URL to, so it
         walks the whole app over there. The page opens over the terminal
         instead, and anything that has to leave goes out as text on the
         clipboard. A mouse click, which costs nothing, opens a tab. */
      if (mobileRef.current) setLinkPrompt(uri)
      else openExternal(uri)
    }
    const linkSub = registerLinkProvider(term, presentLink)
    // A mouse drag on a desktop fills the same copy bar the long press does.
    const selectionSub = term.onSelectionChange(() => {
      const text = term.getSelection()
      setSelection(text || null)
      if (!text) setCopied(false)
    })

    let ws: WebSocket | null = null
    let disposed = false
    let opened = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let stopReconnect = false
    let readOnly = false

    const connect = () => {
      if (disposed || stopReconnect) return
      callbacksRef.current.onStatus('connecting')

      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      // No token here: the handshake carries the session cookie instead.
      const params = new URLSearchParams({
        session: sessionId,
        cols: String(term.cols),
        rows: String(term.rows),
      })

      // Held so a socket we have already replaced cannot reconnect on our behalf.
      const socket = new WebSocket(`${proto}://${location.host}/ws?${params}`)
      ws = socket

      socket.onopen = () => callbacksRef.current.onStatus('connected')

      socket.onmessage = (event) => {
        if (ws !== socket) return
        // Any frame at all proves the socket still carries traffic.
        clearProbe()
        const msg = JSON.parse(event.data)
        switch (msg.type) {
          case 'ready':
            // Server attached a different session — remount instead of painting stale replay.
            if (msg.sessionId !== sessionId) {
              callbacksRef.current.onSession(msg.sessionId)
              break
            }
            readOnly = !!msg.readOnly
            /* The server assumed this session was on screen when the socket
               opened, which is right on launch and wrong when the app was left
               on another tab. Say which it is. */
            reportViewingRef.current()
            /* Reset, not clear: a dropped connection can leave the terminal
               half-way through an escape sequence, or on the alternate screen
               with mouse tracking on. The replay below sets up whatever it
               needs again, so start it from a terminal with no history. */
            term.reset()
            if (msg.replay) term.write(decomposeSaraAm(msg.replay))
            if (readOnly) {
              setReadOnly(true)
              setCtrlMod('off')
              callbacksRef.current.onStatus('ended')
              callbacksRef.current.onSessionState?.()
            }
            /* The size went out with the handshake and the server has already
               asked for a redraw at it — but the handshake size is measured
               before the key bar and the keyboard have had their say. If that
               moves the size, `onResize` says so; if it does not, the only
               screen still worth finishing is one an agent is mid-draw on, so
               watch for that rather than making every switch draw twice. */
            if (!readOnly) armWatch()
            break
          case 'output':
            term.write(decomposeSaraAm(msg.data))
            noteOutput()
            break
          case 'exit':
            stopReconnect = true
            readOnly = true
            setReadOnly(true)
            setCtrlMod('off')
            term.write(`\r\n\x1b[90m[session exited with code ${msg.code}]\x1b[0m\r\n`)
            callbacksRef.current.onStatus('ended')
            callbacksRef.current.onExit(msg.code)
            callbacksRef.current.onSessionState?.()
            break
          case 'approval':
            callbacksRef.current.onApproval({ id: msg.id, label: msg.label, command: msg.command })
            break
          case 'gone':
            // Nothing to reconnect to; the parent picks another session.
            stopReconnect = true
            callbacksRef.current.onGone()
            break
          case 'notice':
            callbacksRef.current.onNotice(msg.message, {
              sessionId: msg.sessionId ?? null,
              alreadyPushed: !!msg.pushed,
            })
            break
          case 'ask':
            callbacksRef.current.onAsk({
              id: msg.id,
              question: msg.question,
              detail: msg.detail ?? null,
              options: msg.options ?? [],
              source: msg.source ?? null,
              sessionId: msg.sessionId ?? null,
            })
            break
          case 'attention':
            callbacksRef.current.onAttention()
            break
          case 'preview':
            callbacksRef.current.onPreview({
              id: msg.id,
              url: msg.url,
              port: msg.port,
              source: msg.source ?? null,
              sessionId: msg.sessionId ?? null,
            })
            break
        }
      }

      socket.onclose = (event) => {
        if (disposed || ws !== socket) return
        clearProbe()
        if (event.code === 4001) {
          callbacksRef.current.onAuthFail()
          return
        }
        if (stopReconnect || readOnly) {
          callbacksRef.current.onStatus(readOnly && stopReconnect ? 'ended' : 'disconnected')
          return
        }
        callbacksRef.current.onStatus('disconnected')
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
      }
    }

    const send = (msg: object) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }
    sendRef.current = send

    const reportViewing = () => {
      const watching = activeRef.current && document.visibilityState === 'visible'
      send({ type: 'viewing', sessionId: watching ? sessionId : null })
    }
    reportViewingRef.current = reportViewing
    document.addEventListener('visibilitychange', reportViewing)

    let probeTimer: ReturnType<typeof setTimeout> | null = null
    const clearProbe = () => {
      if (probeTimer) clearTimeout(probeTimer)
      probeTimer = null
    }

    /* What is on screen is whatever frame the agent last drew, and a full-screen
       app only draws again when its size changes. Reattaching asks for one
       redraw, but an agent busy running a tool can let that pass and leave the
       composer missing until something else moves — which is why toggling the
       key bar "fixed" it. So say the size again whenever the phone comes back,
       even when nothing about it changed: the server answers every `resize` by
       walking the agent through one row less and back, which is what makes it
       draw the whole screen. */
    let repaintTimer: ReturnType<typeof setTimeout> | null = null
    const askRedraw = () => {
      if (disposed || readOnly || ws?.readyState !== WebSocket.OPEN) return
      const { cols, rows } = term
      send({ type: 'resize', cols, rows })
      sentSize = `${cols}x${rows}`
    }
    /* Late enough that the layout has settled — the key bar unfolding and the
       keyboard sliding in both change the size after the socket opens. */
    const scheduleRedraw = (delay = 400) => {
      if (repaintTimer) clearTimeout(repaintTimer)
      repaintTimer = setTimeout(() => {
        repaintTimer = null
        askRedraw()
      }, delay)
    }
    /* A size change reaches an agent that is in the middle of writing, and one
       SIGWINCH buys exactly one redraw — which lands interleaved with the
       output still coming, so the frame that ends up on screen is half old
       height, half new. Nothing follows it, because as far as the agent is
       concerned the resize was handled. So when a size goes out while output is
       flowing, wait for the stream to fall quiet and ask once more; that second
       ask is the same message the tab-return path used to send for free, and
       here it is paid for only when something was actually being drawn over. */
    let settleUntil = 0
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    /** When the agent last wrote anything. A terminal nobody is drawing on has
        nothing to put right, and asking anyway is the second frame that
        stuttered — so every extra repaint below is spent only on a busy one. */
    let lastOutputAt = 0
    const wasBusy = () => performance.now() - lastOutputAt < BUSY_WINDOW_MS
    const clearSettle = () => {
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = null
      settleUntil = 0
    }
    /** Called with every size the agent is told; starts the watch for output. */
    const armSettle = () => {
      clearSettle()
      if (!wasBusy()) return
      settleUntil = performance.now() + POST_RESIZE_MAX_MS
      /* Armed straight away, not only once more output arrives: an agent that
         signs off the same instant the bar folds writes nothing after it, and
         the half-drawn screen it leaves is exactly the one to put right. Any
         output that does arrive pushes this later. */
      settleTimer = setTimeout(fireSettle, POST_RESIZE_QUIET_MS)
    }
    /** Watch without asking: a repaint only if the agent turns out to be
        drawing. Attaching is that case — the server already asked for one at
        the handshake size, so a session sitting still has a whole screen
        already and a second draw is only a flash across the switch. */
    const armWatch = () => {
      clearSettle()
      settleUntil = performance.now() + POST_RESIZE_MAX_MS
    }
    function fireSettle() {
      clearSettle()
      askRedraw()
    }
    /** Called for every chunk of output; the last one before the quiet wins. */
    const noteOutput = () => {
      lastOutputAt = performance.now()
      if (!settleUntil) return
      // Still writing after all this time — take the redraw now or never.
      if (performance.now() > settleUntil) return fireSettle()
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(fireSettle, POST_RESIZE_QUIET_MS)
    }
    /* Coming back to the tab is the same question asked from the other side:
       the buffer is current, so a local refresh is the whole fix — unless the
       agent is mid-draw, in which case what is in the buffer is half a screen
       and only it can finish the other half. */
    settleOnReturnRef.current = () => {
      if (wasBusy()) scheduleRedraw(POST_RESIZE_QUIET_MS)
    }

    /* iOS suspends a backgrounded tab, and the socket can die out on the network
       while it is asleep — the browser fires no onclose for that, so coming back
       we find a socket that looks open, carries nothing, and leaves the screen on
       whatever frame it last drew. Ask the server to say something; if it does
       not, close the socket ourselves and let the reconnect replay the session. */
    const resync = () => {
      if (disposed || stopReconnect || readOnly) return
      if (document.visibilityState !== 'visible') return
      if (ws?.readyState === WebSocket.OPEN) {
        if (probeTimer) return
        send({ type: 'ping' })
        scheduleRedraw()
        probeTimer = setTimeout(() => {
          probeTimer = null
          ws?.close()
        }, PROBE_TIMEOUT_MS)
        return
      }
      if (ws?.readyState === WebSocket.CONNECTING) return
      // Already closed while we were away — no reason to sit out the backoff.
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      connect()
    }
    document.addEventListener('visibilitychange', resync)
    window.addEventListener('pageshow', resync)

    /* An unnamed session is labelled with its first command, which the server
       only knows once that line is committed — refetch the metadata then. */
    let labelPending = true
    const sendInput = (data: string) => {
      send({ type: 'input', data })
      if (!labelPending || !/[\r\n]/.test(data)) return
      labelPending = false
      setTimeout(() => callbacksRef.current.onSessionState?.(), 200)
    }

    if (handleRef) {
      handleRef.current = {
        write: (data) => sendInput(data),
        /* Not write(): a composer reads a bare newline as "send", so a pasted
           block would fire off its first line and leave the rest behind. xterm
           wraps it in the paste brackets when the app has asked for them, folds
           CRLF to CR when it has not, and hands the result back through onData
           like anything else typed. */
        paste: (text) => term.paste(text),
        approve: (id) => send({ type: 'approve', id }),
        deny: (id) => send({ type: 'deny', id }),
        answer: (id, choice) => send({ type: 'answer', id, choice }),
        focus: () => {
          if (term.textarea) term.textarea.readOnly = false
          term.textarea?.focus()
        },
        blur: () => {
          term.textarea?.blur()
          if (mobileRef.current && term.textarea) term.textarea.readOnly = true
        },
      }
    }

    // Ctrl armed on the key bar rewrites the next character the soft keyboard
    // produces: @ A-Z [ \ ] ^ _ map onto control codes 0x00–0x1f.
    const applyCtrl = (data: string) => {
      if (ctrlRef.current === 'off' || data.length !== 1) return data
      const code = data.toUpperCase().charCodeAt(0)
      if (code < 64 || code > 95) return data
      if (ctrlRef.current === 'once') setCtrlMod('off')
      return String.fromCharCode(code - 64)
    }

    const inputSub = term.onData((data) => sendInput(applyCtrl(data)))
    let sizeTimer: ReturnType<typeof setTimeout> | null = null
    let pendingSize: { cols: number; rows: number } | null = null
    // The socket handshake carries the size it opened with, so start in step.
    let sentSize = `${term.cols}x${term.rows}`
    /* Set by a control that changes the layout in one step — the key bar
       folding. The wait below is there for sizes that are still moving, and a
       fold is not moving: it lands on its final height in one frame, and every
       millisecond spent waiting to say so is a millisecond of the agent's last
       frame sitting at the wrong height, which is what reads as lag. Kept as a
       deadline rather than a flag so that a fold which changed no rows at all
       cannot leave it armed for whatever moves next. */
    let deliberateUntil = 0
    layoutStepRef.current = () => {
      deliberateUntil = performance.now() + DELIBERATE_WINDOW_MS
    }
    const resizeSub = term.onResize((size) => {
      pendingSize = size
      if (sizeTimer) clearTimeout(sizeTimer)
      const deliberate = performance.now() < deliberateUntil
      deliberateUntil = 0
      sizeTimer = setTimeout(() => {
        sizeTimer = null
        if (!pendingSize) return
        const next = `${pendingSize.cols}x${pendingSize.rows}`
        /* Back where it began — the bar was folded and unfolded inside one
           settle window — so there is no new size to tell the agent. There is
           still a screen to put right, though, and that is what made toggling
           the keys repeatedly leave the prompt hidden behind the bar: xterm
           was resized down and up for real, and an app that owns the screen
           has no reflow to survive it, so its last frame is now laid out for a
           height the terminal no longer has. Nothing else will redraw it,
           because from the agent's side nothing happened. Asking for the
           repaint is exactly the same message; the server answers every
           `resize` by walking one row down and back. */
        if (next === sentSize) return askRedraw()
        sentSize = next
        send({ type: 'resize', ...pendingSize })
        armSettle()
        /* A size the agent has not heard before already earns a full redraw —
           asking for a second one would only make the screen flash twice. */
        if (repaintTimer) clearTimeout(repaintTimer)
        repaintTimer = null
      }, deliberate ? 0 : RESIZE_SETTLE_MS)
    })

    const refit = (scrollToBottom = false) => {
      if (disposed || !opened) return
      // Hidden (display:none) containers measure 0×0 — fitting then would
      // collapse the grid and garble the buffer via reflow.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      // Losing rows scrolls the buffer; follow it so the composer stays in view.
      const buffer = term.buffer.active
      const atBottom = buffer.viewportY >= buffer.baseY
      try {
        fit.fit()
        if (scrollToBottom || atBottom) term.scrollToBottom()
      } catch {
        // fit() can race with dispose during unmount; safe to ignore
      }
    }
    refitRef.current = refit
    refreshRef.current = () => {
      if (!disposed && opened) term.refresh(0, term.rows - 1)
    }

    /* The key bar folding open, the soft keyboard sliding in, a rotation — none
       of those are one layout change, they are a burst of them, and the observer
       fires for every frame.

       xterm follows every one of them. A local reflow is ~3ms and it is the only
       thing that keeps the screen the same size as the box it sits in; deferring
       it leaves the last row — the composer being typed into — hanging past the
       bottom edge for as long as the wait lasts, which on a keyboard opening is
       250px of it.

       What waits is the telling of the PTY. Every size the agent hears is a
       SIGWINCH it answers with a full redraw, and a dozen of those chasing a
       size that is still moving is how frames drawn for one height end up on a
       screen that is already another one, composer half-erased. So: fit now,
       say it once the size stops moving. */
    const onBoxResize = () => refit()
    const observer = new ResizeObserver(onBoxResize)
    observer.observe(container)
    window.visualViewport?.addEventListener('resize', onBoxResize)

    // Tap (no drag) opens the keyboard; read-only keeps iOS from popping it on scroll.
    const onTextareaFocus = () => setKeyboardOpen(true)
    const onTextareaBlur = () => {
      setKeyboardOpen(false)
      if (mobileRef.current && term.textarea) term.textarea.readOnly = true
    }

    let touchStartX = 0
    let touchStartY = 0
    let touchMoved = false
    /* Where the last notch was sent from. One line of travel is one notch, so
       the text keeps up with the finger rather than arriving a page at a time;
       whatever is left over stays here for the next move. */
    let wheelAnchorY = 0
    /** The tail of the drag: (time, y) pairs, for the throw at the end of it. */
    let samples: { t: number; y: number }[] = []
    let touchTarget: HTMLElement | null = null
    let pressTimer: ReturnType<typeof setTimeout> | null = null
    /** The cell a completed press is holding, waiting for the finger to lift. */
    let armed: { row: number; col: number } | null = null

    const touchAt = (e: Event) => {
      const te = e as TouchEvent
      return te.touches[0] ?? te.changedTouches[0]
    }

    /**
     * Which buffer cell a point is over. A tap wants the truth — outside the
     * grid is not a link — but a finger dragging a selection runs off the end
     * of the line constantly, and there the nearest cell is what was meant.
     */
    const cellAt = (clientX: number, clientY: number, clamp = false) => {
      const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen) return null
      const rect = screen.getBoundingClientRect()
      if (!rect.width || !rect.height) return null
      let col = Math.floor(((clientX - rect.left) / rect.width) * term.cols)
      let viewRow = Math.floor(((clientY - rect.top) / rect.height) * term.rows)
      if (clamp) {
        col = Math.min(term.cols - 1, Math.max(0, col))
        viewRow = Math.min(term.rows - 1, Math.max(0, viewRow))
      } else if (col < 0 || col >= term.cols || viewRow < 0 || viewRow >= term.rows) {
        return null
      }
      return { row: term.buffer.active.viewportY + viewRow, col }
    }

    const cancelPress = () => {
      if (pressTimer) clearTimeout(pressTimer)
      pressTimer = null
    }

    const onTouchStart = (e: Event) => {
      const touch = touchAt(e)
      if (!touch) return
      touchStartX = touch.clientX
      touchStartY = touch.clientY
      touchMoved = false
      armed = null
      wheelAnchorY = touch.clientY
      samples = [{ t: performance.now(), y: touch.clientY }]
      /* A finger back on the glass stops the glide under it — every list on
         every phone does this, and it is the only way to land on something. */
      stopFling()
      cancelPress()
      if (!mobileRef.current) return
      const cell = cellAt(touch.clientX, touch.clientY)
      if (!cell) return
      pressTimer = setTimeout(() => {
        pressTimer = null
        if (touchMoved) return
        // Nothing under the finger, nothing to hold on to.
        if (isBlankRow(term, cell.row)) return
        /* Armed, not opened. The tick is the whole feedback: it says the press
           was heard and the panel is one lift away, while leaving the finger
           free to change its mind into a scroll. */
        armed = cell
        navigator.vibrate?.(8)
      }, LONG_PRESS_MS)
    }

    /** How fast the finger is going right now, over the tail of the drag — the
        same measure the throw at the end uses, so "fast enough to take the
        gesture back" and "fast enough to glide" are the same scale. */
    const tailVelocity = () => {
      const end = samples[samples.length - 1]
      if (!end) return 0
      const from = samples.find((s) => end.t - s.t <= FLING_SAMPLE_MS) ?? samples[0]
      const dt = end.t - from.t
      return dt > 0 ? (end.y - from.y) / dt : 0
    }

    /** One place that turns travel into notches, so the finger and the glide
        that follows it move the pane at exactly the same rate. */
    const notchesFrom = (y: number, clientX: number) => {
      const lineHeight = (term.element?.clientHeight ?? 0) / term.rows
      if (!lineHeight) return
      const notches = Math.trunc((y - wheelAnchorY) / lineHeight)
      if (!notches) return
      const send = Math.min(MAX_NOTCHES_PER_MOVE, Math.abs(notches))
      const up = notches > 0
      sendRef.current({ type: 'input', data: wheelReport(term, up, clientX, y).repeat(send) })
      wheelAnchorY += (up ? send : -send) * lineHeight
    }

    /**
     * The glide after the finger leaves.
     *
     * There is no scrollbar to animate — the pane belongs to the program on the
     * other end — so the throw is carried by the same notches the drag sends,
     * emitted on a decaying velocity until they are too sparse to see. It runs
     * on rAF so it stops dead when the tab is backgrounded rather than firing a
     * screenful of scroll into a terminal nobody is looking at.
     */
    const stopFling = () => {
      if (flingFrame.current !== null) cancelAnimationFrame(flingFrame.current)
      flingFrame.current = null
    }

    const startFling = (velocity: number, clientX: number, fromY: number) => {
      let v = velocity
      let y = fromY
      let last = performance.now()
      const step = () => {
        const now = performance.now()
        // Clamped: a tab that was away for a second must not resume by firing
        // that second's worth of friction and travel in one frame.
        const dt = Math.min(64, now - last)
        last = now
        v *= Math.pow(FLING_FRICTION, dt / 16.7)
        if (Math.abs(v) < FLING_STOP_VELOCITY || !appOwnsScreen(term)) {
          flingFrame.current = null
          return
        }
        y += v * dt
        notchesFrom(y, clientX)
        flingFrame.current = requestAnimationFrame(step)
      }
      flingFrame.current = requestAnimationFrame(step)
    }
    const onTouchMove = (e: Event) => {
      const touch = touchAt(e)
      if (!touch) return
      if (
        Math.abs(touch.clientY - touchStartY) > TOUCH_SLOP_PX ||
        Math.abs(touch.clientX - touchStartX) > TOUCH_SLOP_PX
      ) {
        touchMoved = true
      }
      const now = performance.now()
      samples.push({ t: now, y: touch.clientY })
      if (samples.length > 8) samples.shift()
      if (touchMoved) {
        cancelPress()
        // A finger that moved was never holding anything.
        armed = null
      }
      /* An app that owns the screen gets the swipe as the wheel it is already
         listening for, a notch per line of travel — so the pane moves with the
         finger instead of jumping. Dragging down goes back through the history,
         the direction the paper would move. Left alone otherwise: xterm scrolls
         its own buffer with the finger perfectly well, and doing both would
         move it twice as far. */
      if (!touchMoved || !appOwnsScreen(term)) return
      e.preventDefault()
      notchesFrom(touch.clientY, touch.clientX)
    }

    const onTouchEnd = (e: Event) => {
      cancelPress()
      /* Measured over the tail of the drag: a finger that swept the screen and
         then stopped before lifting has thrown nothing. */
      if (touchMoved && appOwnsScreen(term)) {
        const v = tailVelocity()
        const end = samples[samples.length - 1]
        if (Math.abs(v) >= FLING_MIN_VELOCITY && end)
          startFling(
            Math.sign(v) * Math.min(FLING_MAX_VELOCITY, Math.abs(v)),
            touchAt(e)?.clientX ?? 0,
            end.y,
          )
      }
      /* iOS cancels the touch when it decides something else owns the gesture,
         and a panel opening out of that is a panel nobody asked for. */
      if (e.type === 'touchcancel') {
        armed = null
        return
      }
      if (armed && !touchMoved) {
        // Swallow the click the browser emulates from this touch: it would land
        // on the panel this is about to open.
        e.preventDefault()
        setPicking(snapshot(term, armed))
        armed = null
        return
      }
      armed = null
      const touch = touchAt(e)
      if (!touchMoved && touch) {
        const cell = cellAt(touch.clientX, touch.clientY)
        /* xterm resolves a click against whatever the mouse last moved over,
           and a finger never moves over anything — so match the tap ourselves. */
        const link = cell && linkAt(term, cell.row, cell.col)
        if (link) {
          // Swallow the click the browser would emulate from this touch: it
          // would land on the sheet this is about to open.
          e.preventDefault()
          presentLink(link.uri)
          return
        }
      }
      // A tap anywhere else puts the selection away rather than typing into it.
      if (term.hasSelection()) {
        term.clearSelection()
        setSelection(null)
        return
      }
      // No PTY behind a read-only session — popping the keyboard would go nowhere.
      if (!mobileRef.current || touchMoved || readOnly || !term.textarea) return
      term.textarea.readOnly = false
      term.textarea.focus()
    }

    // Defer opening one frame so React StrictMode's throwaway first mount never
    // starts xterm's internal timers (they fire after dispose and crash).
    const openFrame = requestAnimationFrame(() => {
      if (disposed) return
      term.open(container)
      opened = true
      fit.fit()
      if (mobileRef.current && term.textarea) {
        term.textarea.readOnly = true
        term.textarea.setAttribute('autocapitalize', 'off')
        term.textarea.setAttribute('autocorrect', 'off')
        term.textarea.setAttribute('spellcheck', 'false')
      }
      term.textarea?.addEventListener('focus', onTextareaFocus)
      term.textarea?.addEventListener('blur', onTextareaBlur)
      touchTarget = term.element ?? container
      touchTarget.addEventListener('touchstart', onTouchStart, { passive: true })
      // Not passive: extending a selection has to be able to hold off the scroll.
      touchTarget.addEventListener('touchmove', onTouchMove, { passive: false })
      touchTarget.addEventListener('touchend', onTouchEnd)
      touchTarget.addEventListener('touchcancel', onTouchEnd)
      connect()
    })

    return () => {
      disposed = true
      termRef.current = null
      refitRef.current = () => {}
      refreshRef.current = () => {}
      settleOnReturnRef.current = () => {}
      if (handleRef) handleRef.current = null
      cancelAnimationFrame(openFrame)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearProbe()
      if (sizeTimer) clearTimeout(sizeTimer)
      if (repaintTimer) clearTimeout(repaintTimer)
      clearSettle()
      document.removeEventListener('visibilitychange', resync)
      document.removeEventListener('visibilitychange', reportViewing)
      window.removeEventListener('pageshow', resync)
      observer.disconnect()
      window.visualViewport?.removeEventListener('resize', onBoxResize)
      term.textarea?.removeEventListener('focus', onTextareaFocus)
      term.textarea?.removeEventListener('blur', onTextareaBlur)
      stopFling()
      touchTarget?.removeEventListener('touchstart', onTouchStart)
      touchTarget?.removeEventListener('touchmove', onTouchMove)
      touchTarget?.removeEventListener('touchend', onTouchEnd)
      touchTarget?.removeEventListener('touchcancel', onTouchEnd)
      cancelPress()
      inputSub.dispose()
      resizeSub.dispose()
      linkSub.dispose()
      selectionSub.dispose()
      ws?.close()
      term.dispose()
    }
  }, [sessionId])

  /* Refit and jump to the bottom when the terminal tab becomes visible again.
     Unlike the home screen, another tab never puts the socket to sleep: output
     kept arriving and xterm kept writing it, so the buffer is already current
     and the only thing that may have gone stale is the picture of it — xterm
     stops rendering a box it cannot see. So redraw locally — asking the agent
     for every trip back cost the walk down one row and back that a size it has
     already heard needs, and that second frame is what stuttered. The agent is
     asked only when it was writing as we arrived, since then half of what the
     buffer holds is a screen it has not finished. If the layout did move while
     we were away, the fit below changes the size and `onResize` tells the agent
     as usual. */
  useEffect(() => {
    activeRef.current = active
    reportViewingRef.current()
    if (!active) return
    requestAnimationFrame(() => {
      refitRef.current(true)
      refreshRef.current()
      settleOnReturnRef.current()
    })
  }, [active])

  const sendKey = (data: string) => sendRef.current({ type: 'input', data })

  const clearSelection = () => {
    termRef.current?.clearSelection()
    setSelection(null)
    setCopied(false)
  }

  const copySelection = async () => {
    if (!selection) return
    await writeToClipboard(selection)
    setCopied(true)
    setTimeout(clearSelection, 900)
  }

  const copyLink = async () => {
    if (!linkPrompt) return
    await writeToClipboard(linkPrompt)
    setLinkCopied(true)
    setTimeout(() => {
      setLinkCopied(false)
      setLinkPrompt(null)
    }, 700)
  }

  /* A page of Orbit's own origin opens inside Orbit. Installed to the home
     screen there is no second tab to send it to: WebKit walks the app window
     over to it, and the only way back is a cold start of the whole app. */
  const viewLink = () => {
    if (!linkPrompt) return
    setViewer(linkPrompt)
    setLinkPrompt(null)
  }

  const linkCanFrame = !!linkPrompt && canFrame(linkPrompt)

  const selectedLines = selection ? selection.split('\n').length : 0
  /* Count what was actually picked: whole lines are lines, a piece of one is
     characters — which is the number that tells you whether you got the path. */
  const selectionLabel =
    selectedLines > 1
      ? `${selectedLines} line${selectedLines === 1 ? '' : 's'}`
      : `${selection?.length ?? 0} char${selection?.length === 1 ? '' : 's'}`

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        {/* xterm's screen is a positioned element, so whatever it draws past
            this box lands on top of the bar below and the tabs above rather
            than behind them. Clip, not hidden: `clip` keeps that from happening
            without turning this into something iOS can scroll out from under
            the focused textarea. */}
        <div
          ref={containerRef}
          /* `pointer-events: none` on the rows is what keeps a swipe alive.
             A touch is delivered for its whole life to the node it started on,
             and if that node leaves the document the events keep going to it —
             detached, so they never reach a listener up here and the gesture
             dies mid-drag. xterm's DOM renderer replaces a row's spans on every
             repaint, so a finger that landed on a glyph was holding a dead node
             within one frame of the app redrawing: measured at 2 wheel notches
             before it stopped, against 28 for the same swipe started on a blank
             row whose empty div was never rewritten. Taking the rows out of
             hit-testing lands the touch on `.xterm-screen`, which `open()`
             builds once and never replaces. Nothing is lost: every gesture here
             resolves its cell from coordinates, never from the target. Touch
             only — a mouse wants the rows for xterm's own hover and click. */
          className={`h-full w-full overflow-clip [-webkit-touch-callout:none] [-webkit-user-select:none] [&_.xterm]:h-full [&_.xterm-viewport]:!overflow-y-auto [&_.xterm-viewport]:!bg-transparent [&_.xterm-viewport]:[-webkit-overflow-scrolling:touch] ${
            mobileRef.current ? '[&_.xterm-rows]:pointer-events-none' : ''
          }`}
        />
        {/* xterm's own selection — a mouse drag on a desktop — has no menu and
            no shortcut behind it. A finger never gets here: it opens the panel
            instead, where the platform's own selection does all of this. */}
        {selection && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
            <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-line bg-overlay/95 py-1 pr-1 pl-3 shadow-xl backdrop-blur">
              <span className="text-xs tabular-nums text-mut">{selectionLabel}</span>
              <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={copySelection}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <IconButton size="sm" label="Clear selection" onClick={clearSelection}>
                <IconClose size={16} />
              </IconButton>
            </div>
          </div>
        )}
      </div>
      {picking && (
        <SelectSheet
          shot={picking}
          onInsertPath={onInsertPath}
          onClose={() => setPicking(null)}
        />
      )}
      {linkPrompt && (
        /* Armed late on purpose: the touch that opens this sheet is followed by
           an emulated click at the same point, which would otherwise land on the
           backdrop and dismiss it before anyone saw it. */
        <Sheet title="Link" onClose={() => linkArmed && setLinkPrompt(null)}>
          <div className="flex flex-col gap-3 px-5 pt-2 pb-5">
            <p className="rounded-(--radius-field) border border-line-subtle bg-ink px-3 py-2 font-mono text-[13px] break-all text-fore">
              {linkPrompt}
            </p>
            <p className="text-xs text-faint">
              {linkCanFrame
                ? 'Opens over the terminal without leaving Orbit — the session stays connected behind it.'
                : 'Plain http cannot load inside Orbit, which is served over https. Copy it and open it yourself — or publish the port over https from Preview, and it will open here.'}
            </p>
            <div className="flex gap-2">
              {linkCanFrame && (
                <Button className="flex-1" onClick={viewLink}>
                  Open here
                </Button>
              )}
              <Button
                variant={linkCanFrame ? 'outline' : 'primary'}
                className={linkCanFrame ? '' : 'flex-1'}
                onClick={copyLink}
              >
                {linkCopied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        </Sheet>
      )}
      {viewer && (
        <PageViewer
          uri={viewer}
          onClose={() => setViewer(null)}
          onInsertPath={onInsertPath}
          onToast={onToast}
        />
      )}
      {showKeys && !readOnly && (
        <TerminalKeys
          keyboardOpen={keyboardOpen}
          onLayoutStep={() => layoutStepRef.current()}
          onCompose={onCompose}
          draftPending={draftPending}
          ctrl={ctrl}
          onCtrlChange={setCtrlMod}
          onSend={sendKey}
          onFocus={() => {
            const term = termRef.current
            if (!term?.textarea) return
            term.textarea.readOnly = false
            term.textarea.focus()
          }}
          onBlur={() => {
            const term = termRef.current
            if (!term?.textarea) return
            term.textarea.blur()
            if (mobileRef.current) term.textarea.readOnly = true
          }}
        />
      )}
    </div>
  )
}
