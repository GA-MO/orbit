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
import { isBlankRow, snapshot, type CellPosition, type Snapshot } from './terminal-snapshot'
import { isTouchDevice } from './touch'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'ended'

export interface TerminalHandle {
  write(data: string): void
  paste(text: string): void
  approve(id: string): void
  deny(id: string): void
  answer(id: string, choice: string): void
  focus(): void
  blur(): void
}

export interface ApprovalRequest {
  id: string
  label: string
  command: string
}

export interface AskRequest {
  id: string
  question: string
  detail: string | null
  options: string[]
  source: string | null
  sessionId: string | null
}

export interface PreviewRequest {
  id: string
  url: string
  port: number
  source: string | null
  sessionId: string | null
}

type Timer = ReturnType<typeof setTimeout>
type GridSize = { cols: number; rows: number }

const RECONNECT_DELAY_MS = 1500
const LONG_PRESS_MS = 420
const LONG_PRESS_HAPTIC_MS = 8
const TOUCH_SLOP_PX = 8
const PROBE_TIMEOUT_MS = 3000
const PAINT_TIMEOUT_MS = 700
const RESIZE_SETTLE_MS = 180
const LABEL_REFRESH_DELAY_MS = 200
const LINK_TAP_DEDUPE_MS = 800
const LINK_SHEET_ARM_DELAY_MS = 350
const COPIED_FLASH_MS = 900
const LINK_COPIED_FLASH_MS = 700
const AUTH_FAILED_CLOSE_CODE = 4001

const MAX_NOTCHES_PER_MOVE = 12
const MAX_VELOCITY_SAMPLES = 8
const FLING_SAMPLE_MS = 90
const FLING_MIN_VELOCITY = 0.35
const FLING_MAX_VELOCITY = 4
const FLING_FRICTION = 0.94
const FLING_STOP_VELOCITY = 0.04
const FLING_FRAME_MS = 16.7
const FLING_MAX_FRAME_DELTA_MS = 64

const SGR_WHEEL_UP = 64
const SGR_WHEEL_DOWN = 65

const CTRL_FIRST_CHAR_CODE = 64
const CTRL_LAST_CHAR_CODE = 95

const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 13,
  fontFamily: 'Menlo, Monaco, "SF Mono", monospace',
  scrollback: 5000,
  theme: {
    background: '#0a0c10',
    foreground: '#e9ecf2',
    cursor: '#93a5fd',
    selectionBackground: '#2c3654',
    selectionInactiveBackground: '#2c3654',
  },
}

const appOwnsScreen = (term: XTerm) =>
  term.buffer.active.type === 'alternate' || term.modes.mouseTrackingMode !== 'none'

const clampToGrid = (n: number, max: number) => Math.min(max, Math.max(1, n))

const wheelReport = (term: XTerm, up: boolean, clientX: number, clientY: number) => {
  const box = term.element?.getBoundingClientRect()
  const col = box ? Math.floor(((clientX - box.left) / box.width) * term.cols) + 1 : 1
  const row = box ? Math.floor(((clientY - box.top) / box.height) * term.rows) + 1 : 1
  const button = up ? SGR_WHEEL_UP : SGR_WHEEL_DOWN
  return `\x1b[<${button};${clampToGrid(col, term.cols)};${clampToGrid(row, term.rows)}M`
}

const lineHeightOf = (term: XTerm) => (term.element?.clientHeight ?? 0) / term.rows

const SARA_AM_DECOMPOSED: Record<string, string> = {
  'ำ': 'ํา',
  'ຳ': 'ໍາ',
}
const decomposeSaraAm = (data: string) =>
  data.replace(/[ำຳ]/g, (c) => SARA_AM_DECOMPOSED[c])

const controlCharacterFor = (data: string): string | null => {
  if (data.length !== 1) return null
  const code = data.toUpperCase().charCodeAt(0)
  if (code < CTRL_FIRST_CHAR_CODE || code > CTRL_LAST_CHAR_CODE) return null
  return String.fromCharCode(code - CTRL_FIRST_CHAR_CODE)
}

const openKeyboard = (term: XTerm) => {
  if (!term.textarea) return
  term.textarea.readOnly = false
  term.textarea.focus()
}

const lockKeyboardAgainstScroll = (term: XTerm) => {
  if (term.textarea) term.textarea.readOnly = true
}

const closeKeyboard = (term: XTerm, mobile: boolean) => {
  term.textarea?.blur()
  if (mobile) lockKeyboardAgainstScroll(term)
}

const touchOf = (e: Event) => {
  const touchEvent = e as TouchEvent
  return touchEvent.touches[0] ?? touchEvent.changedTouches[0]
}

const cellUnderPoint = (term: XTerm, clientX: number, clientY: number): CellPosition | null => {
  const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
  if (!screen) return null
  const rect = screen.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  const col = Math.floor(((clientX - rect.left) / rect.width) * term.cols)
  const viewRow = Math.floor(((clientY - rect.top) / rect.height) * term.rows)
  if (col < 0 || col >= term.cols || viewRow < 0 || viewRow >= term.rows) return null
  return { row: term.buffer.active.viewportY + viewRow, col }
}

type VelocitySample = { t: number; y: number }

const tailVelocity = (samples: VelocitySample[]) => {
  const end = samples[samples.length - 1]
  if (!end) return 0
  const from = samples.find((s) => end.t - s.t <= FLING_SAMPLE_MS) ?? samples[0]
  const dt = end.t - from.t
  return dt > 0 ? (end.y - from.y) / dt : 0
}

const clampFlingVelocity = (velocity: number) =>
  Math.sign(velocity) * Math.min(FLING_MAX_VELOCITY, Math.abs(velocity))

function createWheelScroller(term: XTerm, send: (msg: object) => void) {
  let anchorY = 0
  return {
    anchorAt(y: number) {
      anchorY = y
    },
    scrollTo(y: number, clientX: number) {
      const lineHeight = lineHeightOf(term)
      if (!lineHeight) return
      const notches = Math.trunc((y - anchorY) / lineHeight)
      if (!notches) return
      const count = Math.min(MAX_NOTCHES_PER_MOVE, Math.abs(notches))
      const up = notches > 0
      send({ type: 'input', data: wheelReport(term, up, clientX, y).repeat(count) })
      anchorY += (up ? count : -count) * lineHeight
    },
  }
}

function createFling(
  term: XTerm,
  scroller: ReturnType<typeof createWheelScroller>,
  frameRef: MutableRefObject<number | null>,
) {
  const stop = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
  }

  const start = (velocity: number, clientX: number, fromY: number) => {
    let currentVelocity = velocity
    let y = fromY
    let lastFrameAt = performance.now()
    const step = () => {
      const now = performance.now()
      const dt = Math.min(FLING_MAX_FRAME_DELTA_MS, now - lastFrameAt)
      lastFrameAt = now
      currentVelocity *= Math.pow(FLING_FRICTION, dt / FLING_FRAME_MS)
      if (Math.abs(currentVelocity) < FLING_STOP_VELOCITY || !appOwnsScreen(term)) {
        frameRef.current = null
        return
      }
      y += currentVelocity * dt
      scroller.scrollTo(y, clientX)
      frameRef.current = requestAnimationFrame(step)
    }
    frameRef.current = requestAnimationFrame(step)
  }

  return { start, stop }
}

interface TouchGestureDeps {
  term: XTerm
  mobile: boolean
  isReadOnly: () => boolean
  send: (msg: object) => void
  flingFrame: MutableRefObject<number | null>
  openSelectionPanel: (cell: CellPosition) => void
  presentLink: (uri: string) => void
  clearSelection: () => void
}

function createTouchGestures({
  term,
  mobile,
  isReadOnly,
  send,
  flingFrame,
  openSelectionPanel,
  presentLink,
  clearSelection,
}: TouchGestureDeps) {
  const scroller = createWheelScroller(term, send)
  const fling = createFling(term, scroller, flingFrame)

  let startX = 0
  let startY = 0
  let moved = false
  let samples: VelocitySample[] = []
  let pressTimer: Timer | null = null
  let armedCell: CellPosition | null = null

  const cancelPress = () => {
    if (pressTimer) clearTimeout(pressTimer)
    pressTimer = null
  }

  const armAfterLongPress = (cell: CellPosition) => {
    pressTimer = setTimeout(() => {
      pressTimer = null
      if (moved) return
      if (isBlankRow(term, cell.row)) return
      armedCell = cell
      navigator.vibrate?.(LONG_PRESS_HAPTIC_MS)
    }, LONG_PRESS_MS)
  }

  const recordSample = (y: number) => {
    samples.push({ t: performance.now(), y })
    if (samples.length > MAX_VELOCITY_SAMPLES) samples.shift()
  }

  const scrollHandedToApp = () => !isReadOnly() && appOwnsScreen(term)

  const onTouchStart = (e: Event) => {
    const touch = touchOf(e)
    if (!touch) return
    startX = touch.clientX
    startY = touch.clientY
    moved = false
    armedCell = null
    scroller.anchorAt(touch.clientY)
    samples = [{ t: performance.now(), y: touch.clientY }]
    fling.stop()
    cancelPress()
    if (!mobile) return
    const cell = cellUnderPoint(term, touch.clientX, touch.clientY)
    if (!cell) return
    armAfterLongPress(cell)
  }

  const onTouchMove = (e: Event) => {
    const touch = touchOf(e)
    if (!touch) return
    const leftSlop =
      Math.abs(touch.clientY - startY) > TOUCH_SLOP_PX ||
      Math.abs(touch.clientX - startX) > TOUCH_SLOP_PX
    if (leftSlop) moved = true
    recordSample(touch.clientY)
    if (moved) {
      cancelPress()
      armedCell = null
    }
    if (!moved || !scrollHandedToApp()) return
    e.preventDefault()
    scroller.scrollTo(touch.clientY, touch.clientX)
  }

  const throwIfFlicked = (e: Event) => {
    const velocity = tailVelocity(samples)
    const end = samples[samples.length - 1]
    if (Math.abs(velocity) < FLING_MIN_VELOCITY || !end) return
    fling.start(clampFlingVelocity(velocity), touchOf(e)?.clientX ?? 0, end.y)
  }

  const onTouchEnd = (e: Event) => {
    cancelPress()
    if (moved && scrollHandedToApp()) throwIfFlicked(e)
    if (e.type === 'touchcancel') {
      armedCell = null
      return
    }
    if (armedCell && !moved) {
      e.preventDefault()
      openSelectionPanel(armedCell)
      armedCell = null
      return
    }
    armedCell = null
    const touch = touchOf(e)
    if (!moved && touch) {
      const cell = cellUnderPoint(term, touch.clientX, touch.clientY)
      const link = cell && linkAt(term, cell.row, cell.col)
      if (link) {
        e.preventDefault()
        presentLink(link.uri)
        return
      }
    }
    if (term.hasSelection()) {
      clearSelection()
      return
    }
    if (!mobile || moved || isReadOnly() || !term.textarea) return
    openKeyboard(term)
  }

  const attach = (target: HTMLElement) => {
    target.addEventListener('touchstart', onTouchStart, { passive: true })
    target.addEventListener('touchmove', onTouchMove, { passive: false })
    target.addEventListener('touchend', onTouchEnd)
    target.addEventListener('touchcancel', onTouchEnd)
    return () => {
      target.removeEventListener('touchstart', onTouchStart)
      target.removeEventListener('touchmove', onTouchMove)
      target.removeEventListener('touchend', onTouchEnd)
      target.removeEventListener('touchcancel', onTouchEnd)
    }
  }

  const dispose = () => {
    fling.stop()
    cancelPress()
  }

  return { attach, dispose }
}

interface ResizeReporterDeps {
  initialSize: GridSize
  send: (msg: object) => void
  redraw: () => void
}

function createResizeReporter({ initialSize, send, redraw }: ResizeReporterDeps) {
  const sizeKey = (size: GridSize) => `${size.cols}x${size.rows}`
  let settleTimer: Timer | null = null
  let pendingSize: GridSize | null = null
  let sentSize = sizeKey(initialSize)

  const clearSettle = () => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = null
  }

  const reportSettledSize = () => {
    settleTimer = null
    if (!pendingSize) return
    const next = sizeKey(pendingSize)
    if (next === sentSize) return redraw()
    sentSize = next
    send({ type: 'resize', ...pendingSize })
  }

  return {
    markSent(size: GridSize) {
      clearSettle()
      pendingSize = null
      sentSize = sizeKey(size)
    },
    onResize(size: GridSize) {
      pendingSize = size
      clearSettle()
      settleTimer = setTimeout(reportSettledSize, RESIZE_SETTLE_MS)
    },
    dispose: clearSettle,
  }
}

type SessionCallbacks = Pick<
  Props,
  | 'onStatus'
  | 'onSession'
  | 'onGone'
  | 'onExit'
  | 'onSessionState'
  | 'onAuthFail'
  | 'onApproval'
  | 'onNotice'
  | 'onAsk'
  | 'onAttention'
  | 'onPreview'
>

interface SessionSocketDeps {
  sessionId: string
  term: XTerm
  callbacks: () => SessionCallbacks
  screen: {
    reportViewing: () => void
    markReadOnly: () => void
    markPainted: () => void
    redraw: () => void
  }
  beforeConnect: () => void
}

const socketUrl = (sessionId: string, term: XTerm) => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const params = new URLSearchParams({
    session: sessionId,
    cols: String(term.cols),
    rows: String(term.rows),
  })
  return `${proto}://${location.host}/ws?${params}`
}

const parseMessage = (raw: string): any => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function createSessionSocket({ sessionId, term, callbacks, screen, beforeConnect }: SessionSocketDeps) {
  let ws: WebSocket | null = null
  let disposed = false
  let stopReconnect = false
  let readOnly = false
  let reconnectTimer: Timer | null = null
  let probeTimer: Timer | null = null

  const send = (msg: object) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  const clearProbe = () => {
    if (probeTimer) clearTimeout(probeTimer)
    probeTimer = null
  }

  const clearReconnect = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const endSession = () => {
    stopReconnect = true
    readOnly = true
    screen.markReadOnly()
  }

  const handleReady = (msg: any) => {
    if (msg.sessionId !== sessionId) {
      callbacks().onSession(msg.sessionId)
      return
    }
    readOnly = !!msg.readOnly
    screen.reportViewing()
    term.reset()
    if (msg.replay) term.write(decomposeSaraAm(msg.replay))
    if (readOnly) {
      screen.markReadOnly()
      callbacks().onStatus('ended')
      callbacks().onSessionState?.()
    }
    requestAnimationFrame(screen.markPainted)
  }

  const handleMessage = (msg: any) => {
    switch (msg?.type) {
      case 'ready':
        handleReady(msg)
        break
      case 'output':
        term.write(decomposeSaraAm(msg.data))
        break
      case 'exit':
        endSession()
        term.write(`\r\n\x1b[90m[session exited with code ${msg.code}]\x1b[0m\r\n`)
        callbacks().onStatus('ended')
        callbacks().onExit(msg.code)
        callbacks().onSessionState?.()
        break
      case 'approval':
        callbacks().onApproval({ id: msg.id, label: msg.label, command: msg.command })
        break
      case 'gone':
        stopReconnect = true
        callbacks().onGone()
        break
      case 'notice':
        callbacks().onNotice(msg.message, {
          sessionId: msg.sessionId ?? null,
          alreadyPushed: !!msg.pushed,
        })
        break
      case 'ask':
        callbacks().onAsk({
          id: msg.id,
          question: msg.question,
          detail: msg.detail ?? null,
          options: msg.options ?? [],
          source: msg.source ?? null,
          sessionId: msg.sessionId ?? null,
        })
        break
      case 'attention':
        callbacks().onAttention()
        break
      case 'preview':
        callbacks().onPreview({
          id: msg.id,
          url: msg.url,
          port: msg.port,
          source: msg.source ?? null,
          sessionId: msg.sessionId ?? null,
        })
        break
    }
  }

  const handleClose = (event: CloseEvent) => {
    clearProbe()
    if (event.code === AUTH_FAILED_CLOSE_CODE) {
      callbacks().onAuthFail()
      return
    }
    if (stopReconnect || readOnly) {
      callbacks().onStatus(readOnly && stopReconnect ? 'ended' : 'disconnected')
      return
    }
    callbacks().onStatus('disconnected')
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
  }

  const connect = () => {
    if (disposed || stopReconnect) return
    callbacks().onStatus('connecting')
    beforeConnect()
    const socket = new WebSocket(socketUrl(sessionId, term))
    ws = socket

    socket.onopen = () => callbacks().onStatus('connected')
    socket.onmessage = (event) => {
      if (ws !== socket) return
      clearProbe()
      handleMessage(parseMessage(event.data))
    }
    socket.onclose = (event) => {
      if (disposed || ws !== socket) return
      handleClose(event)
    }
  }

  const probeOpenSocket = () => {
    if (probeTimer) return
    send({ type: 'ping' })
    screen.redraw()
    probeTimer = setTimeout(() => {
      probeTimer = null
      ws?.close()
    }, PROBE_TIMEOUT_MS)
  }

  const resync = () => {
    if (disposed || stopReconnect || readOnly) return
    if (document.visibilityState !== 'visible') return
    if (ws?.readyState === WebSocket.OPEN) return probeOpenSocket()
    if (ws?.readyState === WebSocket.CONNECTING) return
    clearReconnect()
    connect()
  }

  const dispose = () => {
    disposed = true
    clearReconnect()
    clearProbe()
    ws?.close()
  }

  return { send, connect, resync, dispose, isReadOnly: () => readOnly }
}

interface Props {
  sessionId: string
  active?: boolean
  onStatus: (status: ConnectionStatus) => void
  onSession: (id: string) => void
  onGone: () => void
  onExit: (code: number) => void
  onSessionState?: () => void
  onAuthFail: () => void
  onApproval: (request: ApprovalRequest) => void
  onNotice: (
    message: string,
    meta?: { sessionId?: string | null; alreadyPushed?: boolean },
  ) => void
  onAsk: (request: AskRequest) => void
  onCompose: () => void
  onVoice: () => void
  voiceAvailable: boolean
  draftPending: boolean
  onAttention: () => void
  onPreview: (request: PreviewRequest) => void
  onInsertPath?: (path: string) => void
  onToast?: (message: string) => void
  handleRef?: MutableRefObject<TerminalHandle | null>
}

function selectionSummary(selection: string | null) {
  const lineCount = selection ? selection.split('\n').length : 0
  if (lineCount > 1) return `${lineCount} line${lineCount === 1 ? '' : 's'}`
  const charCount = selection?.length ?? 0
  return `${charCount} char${charCount === 1 ? '' : 's'}`
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
  onVoice,
  voiceAvailable,
  draftPending,
  onPreview,
  onInsertPath,
  onToast,
  handleRef,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const flingFrame = useRef<number | null>(null)
  const sendRef = useRef<(msg: object) => void>(() => {})
  const refitRef = useRef<(scrollToBottom?: boolean) => void>(() => {})
  const gridRef = useRef<GridSize | null>(null)
  const refreshRef = useRef<() => void>(() => {})
  const activeRef = useRef(active)
  const reportViewingRef = useRef<() => void>(() => {})
  const mobileRef = useRef(isTouchDevice())
  const [showKeys] = useState(() => isTouchDevice())
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [ctrl, setCtrl] = useState<ModState>('off')
  const ctrlRef = useRef<ModState>('off')
  const [picking, setPicking] = useState<Snapshot | null>(null)
  const [selection, setSelection] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [linkPrompt, setLinkPrompt] = useState<string | null>(null)
  const [painted, setPainted] = useState(false)
  const [linkArmed, setLinkArmed] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const [viewer, setViewer] = useState<string | null>(null)

  useEffect(() => {
    if (!linkPrompt) return setLinkArmed(false)
    const timer = setTimeout(() => setLinkArmed(true), LINK_SHEET_ARM_DELAY_MS)
    return () => clearTimeout(timer)
  }, [linkPrompt])

  const setCtrlMod = (next: ModState) => {
    ctrlRef.current = next
    setCtrl(next)
  }

  const callbacks: SessionCallbacks = {
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
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    setPainted(false)
    const paintFallback = setTimeout(() => setPainted(true), PAINT_TIMEOUT_MS)

    const mobile = mobileRef.current
    const term = new XTerm({ ...(gridRef.current ?? {}), ...TERMINAL_OPTIONS })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)

    let disposed = false
    let opened = false

    let lastLink = { uri: '', at: 0 }
    const presentLink = (uri: string) => {
      const now = Date.now()
      const isRepeatOfSameTap = uri === lastLink.uri && now - lastLink.at < LINK_TAP_DEDUPE_MS
      if (isRepeatOfSameTap) return
      lastLink = { uri, at: now }
      if (mobile) setLinkPrompt(uri)
      else openExternal(uri)
    }
    const linkSub = registerLinkProvider(term, presentLink)

    const selectionSub = term.onSelectionChange(() => {
      const text = term.getSelection()
      setSelection(text || null)
      if (!text) setCopied(false)
    })

    const redrawLocally = () => {
      if (!disposed && opened) term.refresh(0, term.rows - 1)
    }

    const socket = createSessionSocket({
      sessionId,
      term,
      callbacks: () => callbacksRef.current,
      screen: {
        reportViewing: () => reportViewingRef.current(),
        markReadOnly: () => {
          setReadOnly(true)
          setCtrlMod('off')
        },
        markPainted: () => setPainted(true),
        redraw: redrawLocally,
      },
      beforeConnect: () => resizeReporter.markSent({ cols: term.cols, rows: term.rows }),
    })
    const { send } = socket
    sendRef.current = send

    const resizeReporter = createResizeReporter({
      initialSize: { cols: term.cols, rows: term.rows },
      send,
      redraw: redrawLocally,
    })
    const resizeSub = term.onResize((size) => {
      gridRef.current = size
      resizeReporter.onResize(size)
    })

    const reportViewing = () => {
      const watching = activeRef.current && document.visibilityState === 'visible'
      send({ type: 'viewing', sessionId: watching ? sessionId : null })
    }
    reportViewingRef.current = reportViewing
    document.addEventListener('visibilitychange', reportViewing)
    document.addEventListener('visibilitychange', socket.resync)
    window.addEventListener('pageshow', socket.resync)

    let labelPending = true
    const sendInput = (data: string) => {
      send({ type: 'input', data })
      const committedALine = /[\r\n]/.test(data)
      if (!labelPending || !committedALine) return
      labelPending = false
      setTimeout(() => callbacksRef.current.onSessionState?.(), LABEL_REFRESH_DELAY_MS)
    }

    if (handleRef) {
      handleRef.current = {
        write: (data) => sendInput(data),
        paste: (text) => term.paste(text),
        approve: (id) => send({ type: 'approve', id }),
        deny: (id) => send({ type: 'deny', id }),
        answer: (id, choice) => send({ type: 'answer', id, choice }),
        focus: () => openKeyboard(term),
        blur: () => closeKeyboard(term, mobile),
      }
    }

    const applyCtrl = (data: string) => {
      if (ctrlRef.current === 'off') return data
      const control = controlCharacterFor(data)
      if (control === null) return data
      if (ctrlRef.current === 'once') setCtrlMod('off')
      return control
    }
    const inputSub = term.onData((data) => sendInput(applyCtrl(data)))

    const refit = (scrollToBottom = false) => {
      if (disposed || !opened) return
      const containerIsHidden = container.clientWidth === 0 || container.clientHeight === 0
      if (containerIsHidden) return
      const buffer = term.buffer.active
      const atBottom = buffer.viewportY >= buffer.baseY
      try {
        fit.fit()
        if (scrollToBottom || atBottom) term.scrollToBottom()
      } catch {}
    }
    refitRef.current = refit
    refreshRef.current = redrawLocally

    const onBoxResize = () => refit()
    const observer = new ResizeObserver(onBoxResize)
    observer.observe(container)
    window.visualViewport?.addEventListener('resize', onBoxResize)

    const onTextareaFocus = () => setKeyboardOpen(true)
    const onTextareaBlur = () => {
      setKeyboardOpen(false)
      if (mobile) lockKeyboardAgainstScroll(term)
    }

    const gestures = createTouchGestures({
      term,
      mobile,
      isReadOnly: socket.isReadOnly,
      send,
      flingFrame,
      openSelectionPanel: (cell) => setPicking(snapshot(term, cell)),
      presentLink,
      clearSelection: () => {
        term.clearSelection()
        setSelection(null)
      },
    })
    let detachGestures: (() => void) | null = null

    const prepareMobileTextarea = () => {
      if (!term.textarea) return
      term.textarea.readOnly = true
      term.textarea.setAttribute('autocapitalize', 'off')
      term.textarea.setAttribute('autocorrect', 'off')
      term.textarea.setAttribute('spellcheck', 'false')
    }

    const openFrame = requestAnimationFrame(() => {
      if (disposed) return
      term.open(container)
      opened = true
      fit.fit()
      if (mobile) prepareMobileTextarea()
      term.textarea?.addEventListener('focus', onTextareaFocus)
      term.textarea?.addEventListener('blur', onTextareaBlur)
      detachGestures = gestures.attach(term.element ?? container)
      socket.connect()
    })

    return () => {
      disposed = true
      termRef.current = null
      refitRef.current = () => {}
      refreshRef.current = () => {}
      if (handleRef) handleRef.current = null
      cancelAnimationFrame(openFrame)
      clearTimeout(paintFallback)
      resizeReporter.dispose()
      document.removeEventListener('visibilitychange', socket.resync)
      document.removeEventListener('visibilitychange', reportViewing)
      window.removeEventListener('pageshow', socket.resync)
      observer.disconnect()
      window.visualViewport?.removeEventListener('resize', onBoxResize)
      term.textarea?.removeEventListener('focus', onTextareaFocus)
      term.textarea?.removeEventListener('blur', onTextareaBlur)
      detachGestures?.()
      gestures.dispose()
      inputSub.dispose()
      resizeSub.dispose()
      linkSub.dispose()
      selectionSub.dispose()
      socket.dispose()
      term.dispose()
    }
  }, [sessionId])

  useEffect(() => {
    activeRef.current = active
    reportViewingRef.current()
    if (!active) return
    requestAnimationFrame(() => {
      refitRef.current(true)
      refreshRef.current()
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
    setTimeout(clearSelection, COPIED_FLASH_MS)
  }

  const copyLink = async () => {
    if (!linkPrompt) return
    await writeToClipboard(linkPrompt)
    setLinkCopied(true)
    setTimeout(() => {
      setLinkCopied(false)
      setLinkPrompt(null)
    }, LINK_COPIED_FLASH_MS)
  }

  const viewLink = () => {
    if (!linkPrompt) return
    setViewer(linkPrompt)
    setLinkPrompt(null)
  }

  const focusFromKeyBar = () => {
    if (termRef.current) openKeyboard(termRef.current)
  }
  const blurFromKeyBar = () => {
    if (termRef.current) closeKeyboard(termRef.current, mobileRef.current)
  }

  const linkCanFrame = !!linkPrompt && canFrame(linkPrompt)
  const selectionLabel = selectionSummary(selection)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className={`h-full w-full overflow-clip ${painted ? '' : 'opacity-0'} [-webkit-touch-callout:none] [-webkit-user-select:none] [&_.xterm]:h-full [&_.xterm-viewport]:!overflow-y-auto [&_.xterm-viewport]:!bg-transparent [&_.xterm-viewport]:[-webkit-overflow-scrolling:touch] ${
            mobileRef.current ? '[&_.xterm-rows]:pointer-events-none' : ''
          }`}
        />
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
          onCompose={onCompose}
          onVoice={onVoice}
          voiceAvailable={voiceAvailable}
          draftPending={draftPending}
          ctrl={ctrl}
          onCtrlChange={setCtrlMod}
          onSend={sendKey}
          onFocus={focusFromKeyBar}
          onBlur={blurFromKeyBar}
        />
      )}
    </div>
  )
}
