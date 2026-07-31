import { useCallback, useEffect, useRef, useState } from 'react'
import Terminal, {
  type ApprovalRequest,
  type ConnectionStatus,
  type TerminalHandle,
} from './Terminal'
import Drawer from './Drawer'
import Login from './Login'
import VoiceInput, { speechSupported } from './VoiceInput'
import ScreenshotPanel from './ScreenshotPanel'
import { AuthError, checkAuth, createSession, fetchSessions, uploadImage, type SessionInfo } from './api'

const SESSION_KEY = 'orbit.sessionId'

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
}

export default function App() {
  const [locked, setLocked] = useState<boolean | null>(null) // null = checking
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [current, setCurrent] = useState<SessionInfo | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [shotsOpen, setShotsOpen] = useState(false)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const termHandle = useRef<TerminalHandle | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const selectSession = useCallback((id: string) => {
    localStorage.setItem(SESSION_KEY, id)
    setCurrentId(id)
  }, [])

  const showToast = useCallback((message: string) => {
    setToast(message)
    setTimeout(() => setToast(null), 3000)
  }, [])

  // Boot: verify auth, then reattach to the stored session or start a shell.
  useEffect(() => {
    if (locked !== false && locked !== null) return
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const boot = async () => {
      try {
        if (!(await checkAuth())) {
          if (!cancelled) setLocked(true)
          return
        }
        if (!cancelled) setLocked(false)
        const stored = localStorage.getItem(SESSION_KEY)
        const sessions = await fetchSessions()
        // Reattach even if the session ended — its history opens read-only.
        const found = sessions.find((s) => s.id === stored)
        if (cancelled) return
        if (found) {
          setCurrentId(found.id)
        } else {
          const fresh = await createSession('shell')
          if (cancelled) return
          selectSession(fresh.id)
        }
      } catch (e) {
        if (cancelled) return
        if (e instanceof AuthError) setLocked(true)
        else retryTimer = setTimeout(boot, 2000)
      }
    }
    boot()

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [locked, selectSession])

  // Keep the header title in sync with the active session (name/rename happen in the drawer).
  useEffect(() => {
    if (!currentId || drawerOpen || locked !== false) return
    fetchSessions()
      .then((all) => setCurrent(all.find((s) => s.id === currentId) ?? null))
      .catch(() => {})
  }, [currentId, drawerOpen, locked])

  const handleExit = useCallback(() => {
    // Leave the final output on screen; the drawer starts the next session.
    localStorage.removeItem(SESSION_KEY)
  }, [])

  const handleAuthFail = useCallback(() => setLocked(true), [])

  const pickImage = async (file: File | null) => {
    if (!file) return
    try {
      const { path } = await uploadImage(file)
      termHandle.current?.write(`${path} `)
      showToast('Image uploaded — path inserted into the terminal')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Upload failed')
    }
  }

  if (locked === true) {
    return <Login onSuccess={() => setLocked(false)} />
  }

  return (
    <div className="app">
      <header className="header">
        <button className="menu-button" onClick={() => setDrawerOpen(true)} title="Sessions">
          ☰
        </button>
        <span className="logo">
          ⌁ {current ? (current.name ?? `${current.providerName} · ${current.cwd.split('/').pop()}`) : 'Orbit'}
        </span>
        <span className="header-actions">
          {speechSupported() && (
            <button className="icon-button" title="Voice input" onClick={() => setVoiceOpen(true)}>
              🎤
            </button>
          )}
          <button
            className="icon-button"
            title="Upload image — its path is inserted into the terminal"
            onClick={() => fileInput.current?.click()}
          >
            🖼️
          </button>
          <button
            className="icon-button"
            title="Screenshot validation — capture your running app"
            onClick={() => setShotsOpen(true)}
          >
            📸
          </button>
          <span className={`status status--${status}`} title={STATUS_LABEL[status]}>
            <span className="status-dot" />
            <span className="status-label">{STATUS_LABEL[status]}</span>
          </span>
        </span>
      </header>
      <main className="main">
        {currentId && locked === false ? (
          <Terminal
            key={currentId}
            sessionId={currentId}
            onStatus={setStatus}
            onSession={selectSession}
            onExit={handleExit}
            onAuthFail={handleAuthFail}
            onApproval={setApproval}
            handleRef={termHandle}
          />
        ) : (
          <div className="boot-message">Connecting to Orbit server…</div>
        )}
      </main>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          pickImage(e.target.files?.[0] ?? null)
          e.target.value = ''
        }}
      />
      {voiceOpen && (
        <VoiceInput
          onInsert={(text) => termHandle.current?.write(text)}
          onSend={(text) => termHandle.current?.write(`${text}\r`)}
          onClose={() => setVoiceOpen(false)}
        />
      )}
      {shotsOpen && (
        <ScreenshotPanel
          onInsertPath={(path) => {
            termHandle.current?.write(`${path} `)
            showToast('Screenshot path inserted into the terminal')
          }}
          onClose={() => setShotsOpen(false)}
        />
      )}
      {approval && (
        <div className="approval-overlay">
          <div className="approval-card">
            <div className="approval-title">⚠️ Dangerous command blocked</div>
            <div className="approval-label">{approval.label}</div>
            <code className="approval-command">{approval.command}</code>
            <div className="voice-actions">
              <button
                className="voice-button"
                onClick={() => {
                  termHandle.current?.deny(approval.id)
                  setApproval(null)
                  showToast('Command denied')
                }}
              >
                Deny
              </button>
              <button
                className="voice-button voice-button--danger"
                onClick={() => {
                  termHandle.current?.approve(approval.id)
                  setApproval(null)
                }}
              >
                Run anyway
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
      <Drawer
        open={drawerOpen}
        currentId={currentId}
        onClose={() => setDrawerOpen(false)}
        onSelect={selectSession}
      />
    </div>
  )
}
