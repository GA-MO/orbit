import { useEffect, useRef, type MutableRefObject } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getToken } from './api'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export interface TerminalHandle {
  /** Write raw input into the PTY (as if typed). */
  write(data: string): void
  approve(id: string): void
  deny(id: string): void
}

export interface ApprovalRequest {
  id: string
  label: string
  command: string
}

const RECONNECT_DELAY_MS = 1500

interface Props {
  /** Session to attach to. The parent remounts this component (via key) to switch. */
  sessionId: string
  onStatus: (status: ConnectionStatus) => void
  /** Server attached us to a different session (requested one was gone). */
  onSession: (id: string) => void
  onExit: (code: number) => void
  onAuthFail: () => void
  onApproval: (request: ApprovalRequest) => void
  handleRef?: MutableRefObject<TerminalHandle | null>
}

export default function Terminal({
  sessionId,
  onStatus,
  onSession,
  onExit,
  onAuthFail,
  onApproval,
  handleRef,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const callbacksRef = useRef({ onStatus, onSession, onExit, onAuthFail, onApproval })
  callbacksRef.current = { onStatus, onSession, onExit, onAuthFail, onApproval }

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
    const fit = new FitAddon()
    term.loadAddon(fit)

    let ws: WebSocket | null = null
    let disposed = false
    let opened = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (disposed) return
      callbacksRef.current.onStatus('connecting')

      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const params = new URLSearchParams({
        session: sessionId,
        cols: String(term.cols),
        rows: String(term.rows),
        token: getToken(),
      })

      ws = new WebSocket(`${proto}://${location.host}/ws?${params}`)

      ws.onopen = () => callbacksRef.current.onStatus('connected')

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        switch (msg.type) {
          case 'ready':
            term.clear()
            if (msg.replay) term.write(msg.replay)
            if (msg.sessionId !== sessionId) callbacksRef.current.onSession(msg.sessionId)
            // The PTY may have been created (or last used) at a different size.
            send({ type: 'resize', cols: term.cols, rows: term.rows })
            break
          case 'output':
            term.write(msg.data)
            break
          case 'exit':
            term.write(`\r\n\x1b[90m[session exited with code ${msg.code}]\x1b[0m\r\n`)
            callbacksRef.current.onExit(msg.code)
            break
          case 'approval':
            callbacksRef.current.onApproval({ id: msg.id, label: msg.label, command: msg.command })
            break
        }
      }

      ws.onclose = (event) => {
        if (disposed) return
        if (event.code === 4001) {
          callbacksRef.current.onAuthFail()
          return
        }
        callbacksRef.current.onStatus('disconnected')
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
      }
    }

    const send = (msg: object) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }

    if (handleRef) {
      handleRef.current = {
        write: (data) => send({ type: 'input', data }),
        approve: (id) => send({ type: 'approve', id }),
        deny: (id) => send({ type: 'deny', id }),
      }
    }

    const inputSub = term.onData((data) => send({ type: 'input', data }))
    const resizeSub = term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))

    const refit = () => {
      if (disposed || !opened) return
      // Hidden (display:none) containers measure 0×0 — fitting then would
      // collapse the grid and garble the buffer via reflow.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      try {
        fit.fit()
        term.scrollToBottom() // coming back from a hidden tab lands on the latest output
      } catch {
        // fit() can race with dispose during unmount; safe to ignore
      }
    }
    const observer = new ResizeObserver(refit)
    observer.observe(container)
    // On mobile, the on-screen keyboard shrinks the visual viewport, not the window.
    window.visualViewport?.addEventListener('resize', refit)

    // Defer opening one frame so React StrictMode's throwaway first mount never
    // starts xterm's internal timers (they fire after dispose and crash).
    const openFrame = requestAnimationFrame(() => {
      if (disposed) return
      term.open(container)
      opened = true
      fit.fit()
      connect()
    })

    return () => {
      disposed = true
      if (handleRef) handleRef.current = null
      cancelAnimationFrame(openFrame)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      observer.disconnect()
      window.visualViewport?.removeEventListener('resize', refit)
      inputSub.dispose()
      resizeSub.dispose()
      ws?.close()
      term.dispose()
    }
  }, [sessionId])

  return <div ref={containerRef} className="terminal-container" />
}
