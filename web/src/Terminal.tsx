import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import TerminalKeys, { type ModState } from './components/TerminalKeys'
import TerminalScrollPads from './components/TerminalScrollPads'
import PageViewer from './components/PageViewer'
import { Button, IconButton, IconClose, Sheet } from './components/ui'
import { writeToClipboard } from './clipboard'
import { canFrame, openExternal } from './local-url'
import { linkAt, registerLinkProvider } from './terminal-links'
import {
  expandToLines,
  gripPoints,
  isBlankRow,
  isWholeLines,
  orderRange,
  rangeRects,
  rangeText,
  snapToContent,
  wordAt,
  type CellRange,
  type Metrics,
  type Rect,
} from './terminal-selection'
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
}

const RECONNECT_DELAY_MS = 1500
/** Press-and-hold before the terminal starts selecting instead of scrolling. */
const LONG_PRESS_MS = 420
/** Finger travel that turns a press into a scroll. */
const TOUCH_SLOP_PX = 8
/** How long a returning phone waits for the server to answer before giving up on the socket. */
const PROBE_TIMEOUT_MS = 3000
/** Quiet spell that marks the end of a burst of layout changes. */
const RESIZE_SETTLE_MS = 180

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
  onNotice: (message: string, alreadyPushed?: boolean) => void
  onAsk: (request: AskRequest) => void
  /** Hand a file on the Mac to the prompt — a capture taken from a framed page. */
  onInsertPath?: (path: string) => void
  onToast?: (message: string) => void
  handleRef?: MutableRefObject<TerminalHandle | null>
}

/**
 * A grip at one end of the selection. Its listeners are attached by hand rather
 * than through React: React registers touch handlers passively, and a passive
 * handler cannot stop the terminal scrolling away under the finger.
 */
function SelectionGrip({
  edge,
  point,
  offsetY,
  onMove,
}: {
  edge: 'start' | 'end'
  point: { x: number; y: number }
  /** Where the cell is relative to the grip: the grips sit on the outer edges. */
  offsetY: number
  onMove: (x: number, y: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const moveRef = useRef(onMove)
  moveRef.current = onMove
  const offsetRef = useRef(offsetY)
  offsetRef.current = offsetY

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const track = (e: TouchEvent) => {
      const touch = e.touches[0] ?? e.changedTouches[0]
      if (!touch) return
      e.preventDefault()
      e.stopPropagation()
      moveRef.current(touch.clientX, touch.clientY + offsetRef.current)
    }
    const swallow = (e: TouchEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    node.addEventListener('touchstart', swallow, { passive: false })
    node.addEventListener('touchmove', track, { passive: false })
    node.addEventListener('touchend', swallow, { passive: false })
    return () => {
      node.removeEventListener('touchstart', swallow)
      node.removeEventListener('touchmove', track)
      node.removeEventListener('touchend', swallow)
    }
  }, [])

  return (
    <div
      ref={ref}
      data-grip={edge}
      className="absolute z-10 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center"
      style={{ left: point.x, top: point.y }}
      aria-hidden
    >
      <span className="size-3.5 rounded-full border-2 border-ink bg-accent shadow-md" />
    </div>
  )
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
  onInsertPath,
  onToast,
  handleRef,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const sendRef = useRef<(msg: object) => void>(() => {})
  const refitRef = useRef<(scrollToBottom?: boolean) => void>(() => {})
  const redrawRef = useRef<() => void>(() => {})
  const mobileRef = useRef(isTouchDevice())
  const [showKeys] = useState(() => isTouchDevice())
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  // Ended sessions replay history with no PTY behind them — input controls are hidden.
  const [readOnly, setReadOnly] = useState(false)
  const [ctrl, setCtrl] = useState<ModState>('off')
  const ctrlRef = useRef<ModState>('off')
  /* Text held for copying. The terminal draws its own text, so the phone's
     selection handles never appear over it — this is the only route out. */
  const [selection, setSelection] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [visual, setVisual] = useState<{
    rects: Rect[]
    grips: { start: { x: number; y: number }; end: { x: number; y: number } }
    cellHeight: number
    wholeLines: boolean
  } | null>(null)
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
  /** Cells held by a long press, or null when the selection is xterm's own. */
  const heldRef = useRef<CellRange | null>(null)
  const clearRef = useRef<() => void>(() => {})
  const applyRangeRef = useRef<(range: CellRange | null) => void>(() => {})
  const cellAtRef = useRef<(x: number, y: number, clamp?: boolean) => { row: number; col: number } | null>(
    () => null,
  )

  const clearSelection = () => {
    applyRangeRef.current(null)
    termRef.current?.clearSelection()
  }
  clearRef.current = clearSelection

  /** Dragging a grip moves that edge of the selection, cell by cell. */
  const moveGrip = (edge: 'start' | 'end', x: number, y: number) => {
    const term = termRef.current
    const held = heldRef.current
    const point = cellAtRef.current(x, y, true)
    if (!term || !held || !point) return
    // Dragging a grip into the blank space below the output stops at its end.
    const cell = snapToContent(term, point, 0)
    if (!cell) return
    applyRangeRef.current(
      orderRange(
        edge === 'start'
          ? { ...held, startRow: cell.row, startCol: cell.col }
          : { ...held, endRow: cell.row, endCol: cell.col },
      ),
    )
  }

  const expandSelection = () => {
    const term = termRef.current
    const held = heldRef.current
    if (term && held) applyRangeRef.current(expandToLines(term, held))
  }

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
      if (heldRef.current) return // a held selection owns the bar
      const text = term.getSelection()
      setSelection(text || null)
      if (!text) setCopied(false)
    })
    /* New output, or the user scrolling away, leaves the highlight pointing at
       rows that have moved. Let it go rather than draw it in the wrong place. */
    const scrollSub = term.onScroll(() => {
      if (heldRef.current) clearRef.current()
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
               before the key bar and the keyboard have had their say. Ask once
               more when the layout has stopped moving. */
            if (!readOnly) scheduleRedraw()
            break
          case 'output':
            term.write(decomposeSaraAm(msg.data))
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
            callbacksRef.current.onNotice(msg.message, !!msg.pushed)
            break
          case 'ask':
            callbacksRef.current.onAsk({
              id: msg.id,
              question: msg.question,
              detail: msg.detail ?? null,
              options: msg.options ?? [],
              source: msg.source ?? null,
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
    redrawRef.current = () => scheduleRedraw()

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
    const resizeSub = term.onResize((size) => {
      pendingSize = size
      if (sizeTimer) clearTimeout(sizeTimer)
      sizeTimer = setTimeout(() => {
        sizeTimer = null
        if (!pendingSize) return
        const next = `${pendingSize.cols}x${pendingSize.rows}`
        // Toggling the bar twice ends where it began: nothing to tell the agent.
        if (next === sentSize) return
        sentSize = next
        send({ type: 'resize', ...pendingSize })
        /* A size the agent has not heard before already earns a full redraw —
           asking for a second one would only make the screen flash twice. */
        if (repaintTimer) clearTimeout(repaintTimer)
        repaintTimer = null
      }, RESIZE_SETTLE_MS)
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
    let touchTarget: HTMLElement | null = null
    let pressTimer: ReturnType<typeof setTimeout> | null = null
    let selecting = false
    /** The word the press landed on; dragging grows the selection from it. */
    let anchor: CellRange | null = null

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

    /** Cell size and where the grid sits inside the box the overlay draws into. */
    const measure = (): Metrics | null => {
      const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen) return null
      const grid = screen.getBoundingClientRect()
      const box = container.getBoundingClientRect()
      if (!grid.width || !grid.height) return null
      return {
        cellWidth: grid.width / term.cols,
        cellHeight: grid.height / term.rows,
        top: grid.top - box.top,
        left: grid.left - box.left,
        viewportY: term.buffer.active.viewportY,
      }
    }

    /* The one place a held selection changes: keeps the range, the text and the
       shapes drawn over the rows in step. */
    const applyRange = (range: CellRange | null) => {
      heldRef.current = range
      if (!range) {
        setVisual(null)
        setSelection(null)
        setCopied(false)
        return
      }
      const text = rangeText(term, range)
      // Blank rows can be pointed at but not selected: a highlight with nothing
      // in it is a selection you cannot copy and cannot explain.
      if (!text.trim()) {
        heldRef.current = null
        setVisual(null)
        setSelection(null)
        setCopied(false)
        return
      }
      const metrics = measure()
      if (!metrics) return
      setVisual({
        rects: rangeRects(term, range, metrics),
        grips: gripPoints(term, range, metrics),
        cellHeight: metrics.cellHeight,
        wholeLines: isWholeLines(term, range),
      })
      setSelection(text)
      setCopied(false)
    }
    applyRangeRef.current = applyRange
    cellAtRef.current = cellAt

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
      selecting = false
      cancelPress()
      if (!mobileRef.current) return
      const cell = cellAt(touch.clientX, touch.clientY)
      if (!cell) return
      pressTimer = setTimeout(() => {
        pressTimer = null
        if (touchMoved) return
        // Nothing under the finger, nothing to hold on to.
        if (isBlankRow(term, cell.row)) return
        selecting = true
        // The word, not the line: a path, a hash or a flag is usually the point.
        anchor = wordAt(term, cell.row, cell.col)
        applyRange(anchor)
        navigator.vibrate?.(8)
      }, LONG_PRESS_MS)
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
      if (selecting && anchor) {
        const raw = cellAt(touch.clientX, touch.clientY, true)
        const cell = raw && snapToContent(term, raw, anchor.startRow)
        if (cell) {
          // Grow from whichever end of the first word the finger left behind.
          const before =
            cell.row < anchor.startRow ||
            (cell.row === anchor.startRow && cell.col < anchor.startCol)
          applyRange(
            orderRange(
              before
                ? { ...anchor, startRow: cell.row, startCol: cell.col }
                : { ...anchor, endRow: cell.row, endCol: cell.col },
            ),
          )
        }
        // Held down means selecting; the viewport must not scroll out from under it.
        e.preventDefault()
        return
      }
      if (touchMoved) cancelPress()
    }

    const onTouchEnd = (e: Event) => {
      cancelPress()
      if (selecting) {
        // Leave the selection up — the grips and the copy bar are what follow.
        e.preventDefault()
        selecting = false
        anchor = null
        return
      }
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
      if (heldRef.current || term.hasSelection()) {
        clearRef.current()
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
      redrawRef.current = () => {}
      if (handleRef) handleRef.current = null
      cancelAnimationFrame(openFrame)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearProbe()
      if (sizeTimer) clearTimeout(sizeTimer)
      if (repaintTimer) clearTimeout(repaintTimer)
      document.removeEventListener('visibilitychange', resync)
      window.removeEventListener('pageshow', resync)
      observer.disconnect()
      window.visualViewport?.removeEventListener('resize', onBoxResize)
      term.textarea?.removeEventListener('focus', onTextareaFocus)
      term.textarea?.removeEventListener('blur', onTextareaBlur)
      touchTarget?.removeEventListener('touchstart', onTouchStart)
      touchTarget?.removeEventListener('touchmove', onTouchMove)
      touchTarget?.removeEventListener('touchend', onTouchEnd)
      touchTarget?.removeEventListener('touchcancel', onTouchEnd)
      cancelPress()
      inputSub.dispose()
      resizeSub.dispose()
      linkSub.dispose()
      selectionSub.dispose()
      scrollSub.dispose()
      ws?.close()
      term.dispose()
    }
  }, [sessionId])

  /* Refit and jump to the bottom when the terminal tab becomes visible again —
     and ask for a redraw too. A hidden tab measures 0×0, so nothing was fitted
     while it was away and the size that comes back is usually the size that
     left: no resize, no SIGWINCH, and the agent goes on patching a frame it
     drew before. Same tear as coming back from the home screen, one tab over. */
  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => refitRef.current(true))
    redrawRef.current()
  }, [active])

  const sendKey = (data: string) => sendRef.current({ type: 'input', data })

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
    !selection || visual?.wholeLines || selectedLines > 1
      ? `${selectedLines} line${selectedLines === 1 ? '' : 's'}`
      : `${selection.length} char${selection.length === 1 ? '' : 's'}`

  const pageScroll = (direction: -1 | 1) => {
    const term = termRef.current
    if (!term) return
    term.clearSelection()
    window.getSelection()?.removeAllRanges()
    // A TUI that repaints in place owns the screen: xterm's buffer holds only
    // the current frame, so scrolling it locally moves the wrong thing. Alt
    // screen or mouse tracking marks such an app — hand it PageUp/PageDown and
    // let it scroll its own pane (Claude Code moves just the message area and
    // leaves the composer where it is).
    if (term.buffer.active.type === 'alternate' || term.modes.mouseTrackingMode !== 'none') {
      sendKey(direction < 0 ? '\x1b[5~' : '\x1b[6~')
      return
    }
    // iOS Safari ignores scrollTop writes on the momentum-scrolling viewport
    // (-webkit-overflow-scrolling: touch), so the pads did nothing there.
    // xterm's own API moves the buffer and repaints on every platform.
    term.scrollLines(direction * Math.max(1, Math.round(term.rows * 0.85)))
  }

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
          className="h-full w-full overflow-clip [-webkit-touch-callout:none] [-webkit-user-select:none] [&_.xterm]:h-full [&_.xterm-viewport]:!overflow-y-auto [&_.xterm-viewport]:!bg-transparent [&_.xterm-viewport]:[-webkit-overflow-scrolling:touch]"
        />
        {showKeys && (
          <TerminalScrollPads
            onPageUp={() => pageScroll(-1)}
            onPageDown={() => pageScroll(1)}
          />
        )}
        {visual && (
          <>
            {visual.rects.map((rect, i) => (
              <div
                key={i}
                className="pointer-events-none absolute bg-accent-strong/25 ring-1 ring-accent/40"
                style={rect}
              />
            ))}
            <SelectionGrip
              edge="start"
              point={visual.grips.start}
              offsetY={visual.cellHeight / 2}
              onMove={(x, y) => moveGrip('start', x, y)}
            />
            <SelectionGrip
              edge="end"
              point={visual.grips.end}
              offsetY={-visual.cellHeight / 2}
              onMove={(x, y) => moveGrip('end', x, y)}
            />
          </>
        )}
        {/* Selection has nowhere to go on a phone: no menu, no handles, no
            keyboard shortcut. This is the way out of the terminal. */}
        {selection && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
            <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-line bg-overlay/95 py-1 pr-1 pl-3 shadow-xl backdrop-blur">
              <span className="text-xs tabular-nums text-mut">{selectionLabel}</span>
              {visual && !visual.wholeLines && (
                <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={expandSelection}>
                  Line
                </Button>
              )}
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
