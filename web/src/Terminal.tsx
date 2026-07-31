import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import TerminalKeys, { type ModState } from './components/TerminalKeys'
import TerminalScrollPads from './components/TerminalScrollPads'
import { isTouchDevice } from './touch'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'ended'

export interface TerminalHandle {
  /** Write raw input into the PTY (as if typed). */
  write(data: string): void
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
  /** An agent or hook on the Mac wants to say something to whoever holds the phone. */
  onNotice: (message: string) => void
  onAsk: (request: AskRequest) => void
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
  handleRef,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const sendRef = useRef<(msg: object) => void>(() => {})
  const refitRef = useRef<(scrollToBottom?: boolean) => void>(() => {})
  const mobileRef = useRef(isTouchDevice())
  const [showKeys] = useState(() => isTouchDevice())
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  // Ended sessions replay history with no PTY behind them — input controls are hidden.
  const [readOnly, setReadOnly] = useState(false)
  const [ctrl, setCtrl] = useState<ModState>('off')
  const ctrlRef = useRef<ModState>('off')

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
      },
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)

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

      ws = new WebSocket(`${proto}://${location.host}/ws?${params}`)

      ws.onopen = () => callbacksRef.current.onStatus('connected')

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        switch (msg.type) {
          case 'ready':
            // Server attached a different session — remount instead of painting stale replay.
            if (msg.sessionId !== sessionId) {
              callbacksRef.current.onSession(msg.sessionId)
              break
            }
            readOnly = !!msg.readOnly
            term.clear()
            if (msg.replay) term.write(decomposeSaraAm(msg.replay))
            if (readOnly) {
              setReadOnly(true)
              setCtrlMod('off')
              callbacksRef.current.onStatus('ended')
              callbacksRef.current.onSessionState?.()
            }
            // The PTY may have been created (or last used) at a different size.
            if (!readOnly) send({ type: 'resize', cols: term.cols, rows: term.rows })
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
            callbacksRef.current.onNotice(msg.message)
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

      ws.onclose = (event) => {
        if (disposed) return
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
    const resizeSub = term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))

    const refit = (scrollToBottom = false) => {
      if (disposed || !opened) return
      // Hidden (display:none) containers measure 0×0 — fitting then would
      // collapse the grid and garble the buffer via reflow.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      try {
        fit.fit()
        if (scrollToBottom) term.scrollToBottom()
      } catch {
        // fit() can race with dispose during unmount; safe to ignore
      }
    }
    refitRef.current = refit
    const observer = new ResizeObserver(() => refit())
    observer.observe(container)
    const onViewportResize = () => refit()
    window.visualViewport?.addEventListener('resize', onViewportResize)

    // Tap (no drag) opens the keyboard; read-only keeps iOS from popping it on scroll.
    const onTextareaFocus = () => setKeyboardOpen(true)
    const onTextareaBlur = () => {
      setKeyboardOpen(false)
      if (mobileRef.current && term.textarea) term.textarea.readOnly = true
    }

    let touchStartY = 0
    let touchMoved = false
    let touchTarget: HTMLElement | null = null

    const touchAt = (e: Event) => {
      const te = e as TouchEvent
      return te.touches[0] ?? te.changedTouches[0]
    }

    const onTouchStart = (e: Event) => {
      const touch = touchAt(e)
      if (!touch) return
      touchStartY = touch.clientY
      touchMoved = false
    }

    const onTouchMove = (e: Event) => {
      const touch = touchAt(e)
      if (!touch) return
      if (Math.abs(touch.clientY - touchStartY) > 8) touchMoved = true
    }

    const onTouchEnd = () => {
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
      touchTarget.addEventListener('touchmove', onTouchMove, { passive: true })
      touchTarget.addEventListener('touchend', onTouchEnd)
      connect()
    })

    return () => {
      disposed = true
      termRef.current = null
      refitRef.current = () => {}
      if (handleRef) handleRef.current = null
      cancelAnimationFrame(openFrame)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      observer.disconnect()
      window.visualViewport?.removeEventListener('resize', onViewportResize)
      term.textarea?.removeEventListener('focus', onTextareaFocus)
      term.textarea?.removeEventListener('blur', onTextareaBlur)
      touchTarget?.removeEventListener('touchstart', onTouchStart)
      touchTarget?.removeEventListener('touchmove', onTouchMove)
      touchTarget?.removeEventListener('touchend', onTouchEnd)
      inputSub.dispose()
      resizeSub.dispose()
      ws?.close()
      term.dispose()
    }
  }, [sessionId])

  // Refit and jump to the bottom when the terminal tab becomes visible again.
  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => refitRef.current(true))
  }, [active])

  const sendKey = (data: string) => sendRef.current({ type: 'input', data })

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
        <div
          ref={containerRef}
          className="h-full w-full [&_.xterm]:h-full [&_.xterm-viewport]:!overflow-y-auto [&_.xterm-viewport]:!bg-transparent [&_.xterm-viewport]:[-webkit-overflow-scrolling:touch]"
        />
        {showKeys && (
          <TerminalScrollPads
            onPageUp={() => pageScroll(-1)}
            onPageDown={() => pageScroll(1)}
          />
        )}
      </div>
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
