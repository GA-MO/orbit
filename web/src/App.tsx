import { useCallback, useEffect, useRef, useState } from 'react'
import Terminal, {
  type ApprovalRequest,
  type AskRequest,
  type ConnectionStatus,
  type TerminalHandle,
} from './Terminal'
import Login from './Login'
import TerminalView from './views/TerminalView'
import SessionsView from './views/SessionsView'
import CapturesView from './views/CapturesView'
import NewSessionSheet from './sheets/NewSessionSheet'
import VoiceSheet from './sheets/VoiceSheet'
import { speechSupported, startSpeech, type SpeechSession } from './speech'
import { registerPush, systemNotice } from './notice'
import ApprovalModal from './components/ApprovalModal'
import AskModal from './components/AskModal'
import { IconCapture, IconSessions, IconTerminal } from './components/ui'
import {
  AuthError,
  checkAuth,
  createSession,
  fetchSessions,
  restartSession,
  uploadImage,
  type SessionInfo,
} from './api'

const SESSION_KEY = 'orbit.sessionId'

type View = 'terminal' | 'sessions' | 'captures'

const TABS: { id: View; label: string; Icon: typeof IconTerminal }[] = [
  { id: 'terminal', label: 'Terminal', Icon: IconTerminal },
  { id: 'sessions', label: 'Sessions', Icon: IconSessions },
  { id: 'captures', label: 'Captures', Icon: IconCapture },
]

export default function App() {
  const [locked, setLocked] = useState<boolean | null>(null) // null = checking
  const [bootNonce, setBootNonce] = useState(0)
  const [socketNonce, setSocketNonce] = useState(0)
  const [view, setView] = useState<View>('terminal')
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [current, setCurrent] = useState<SessionInfo | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [voiceSession, setVoiceSession] = useState<SpeechSession | null>(null)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  // Questions from the Mac queue up: each one is blocking something over there.
  const [asks, setAsks] = useState<AskRequest[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [startingNew, setStartingNew] = useState(false)
  const termHandle = useRef<TerminalHandle | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const selectSession = useCallback((id: string) => {
    localStorage.setItem(SESSION_KEY, id)
    setCurrentId(id)
    setView('terminal')
  }, [])

  const refreshCurrent = useCallback(async (id?: string | null) => {
    const sid = id ?? currentId
    if (!sid) return
    try {
      const all = await fetchSessions()
      setCurrent(all.find((s) => s.id === sid) ?? null)
    } catch {
      // ignore
    }
  }, [currentId])

  const showToast = useCallback((message: string) => {
    setToast(message)
    setTimeout(() => setToast(null), 3000)
  }, [])

  /* Notices can arrive in a batch — everything that happened while the phone
     was asleep lands at once on reconnect. Queue them so each is actually read
     instead of the last one winning. */
  const noticeQueue = useRef<string[]>([])
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showNotice = useCallback((message: string, alreadyPushed = false) => {
    noticeQueue.current.push(message)
    // One that woke the phone as a push is already on its screen; queueing the
    // toast still lets it be read in the app, but a banner would be the second.
    if (document.hidden && !alreadyPushed) systemNotice(message)
    if (noticeTimer.current) return

    const next = () => {
      const message = noticeQueue.current.shift()
      if (message === undefined) {
        noticeTimer.current = null
        setToast(null)
        return
      }
      setToast(message)
      noticeTimer.current = setTimeout(next, 3000)
    }
    next()
  }, [])

  const addAsk = useCallback((request: AskRequest) => {
    setAsks((cur) => (cur.some((a) => a.id === request.id) ? cur : [...cur, request]))
    if (document.hidden) systemNotice(request.question)
  }, [])

  const answerAsk = useCallback((id: string, choice: string) => {
    termHandle.current?.answer(id, choice)
    setAsks((cur) => cur.filter((a) => a.id !== id))
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
        // Push subscriptions expire and endpoints rotate; renew on every launch.
        registerPush()
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
          localStorage.setItem(SESSION_KEY, fresh.id)
          setCurrentId(fresh.id)
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
  }, [locked, bootNonce])

  // Keep the terminal header in sync with the active session.
  useEffect(() => {
    if (!currentId || locked !== false) return
    refreshCurrent(currentId)
  }, [currentId, locked, view, refreshCurrent])

  const handleExit = useCallback(
    (_code: number) => {
      refreshCurrent()
    },
    [refreshCurrent],
  )

  // Ended session in the terminal tab: same agent + folder, fresh or resumed.
  const startFreshSession = async (resume = false) => {
    if (!current || startingNew) return
    setStartingNew(true)
    try {
      const fresh = await restartSession(current.id, resume)
      selectSession(fresh.id)
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not start a new session')
    } finally {
      setStartingNew(false)
    }
  }

  /* The socket is refused when the session cookie is missing or stale — an
     expired cookie, or a browser that dropped it. The token in storage may well
     still be good, so ask for a fresh cookie before making anyone retype it. */
  const handleAuthFail = useCallback(async () => {
    try {
      if (await checkAuth()) {
        setSocketNonce((n) => n + 1) // remount the terminal; reconnect with the new cookie
        return
      }
    } catch {
      // unreachable server: treat as locked, the login screen says so
    }
    setLocked(true)
  }, [])

  /* The stored session is gone from the Mac (pruned, or ~/.orbit cleared).
     Forget it and let boot pick up whatever is actually there. */
  const handleGone = useCallback(() => {
    localStorage.removeItem(SESSION_KEY)
    setCurrentId(null)
    setCurrent(null)
    setBootNonce((n) => n + 1) // boot again: reattach to something real, or start a shell
    showToast('That session is no longer on your Mac')
  }, [showToast])

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

  const insertPath = (path: string) => {
    termHandle.current?.write(`${path} `)
    setView('terminal')
  }

  if (locked === true) return <Login onSuccess={() => setLocked(false)} />

  return (
    <div className="flex h-dvh flex-col pt-[env(safe-area-inset-top)]">
      <main className="relative min-h-0 flex-1">
        {/* Terminal stays mounted across tab switches — the PTY connection survives. */}
        <div className={`h-full ${view === 'terminal' ? '' : 'hidden'}`}>
          <TerminalView
            session={current}
            status={status}
            voiceAvailable={speechSupported()}
            /* Started here, inside the tap — iOS refuses a start one tick later. */
            onOpenVoice={() => setVoiceSession(startSpeech())}
            onPickImage={() => fileInput.current?.click()}
            onNewSession={() => startFreshSession(false)}
            onResume={() => startFreshSession(true)}
            starting={startingNew}
          >
            {currentId && locked === false ? (
              <Terminal
                key={`${currentId}:${socketNonce}`}
                sessionId={currentId}
                active={view === 'terminal'}
                onStatus={setStatus}
                onSession={selectSession}
                onGone={handleGone}
                onExit={handleExit}
                onSessionState={() => refreshCurrent()}
                onAuthFail={handleAuthFail}
                onApproval={setApproval}
                onNotice={showNotice}
                onAsk={addAsk}
                handleRef={termHandle}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-mut">
                Connecting to your Mac…
              </div>
            )}
          </TerminalView>
        </div>

        <div className={`h-full ${view === 'sessions' ? '' : 'hidden'}`}>
          <SessionsView
            active={view === 'sessions'}
            currentId={currentId}
            onSelect={selectSession}
            onNew={() => setNewSessionOpen(true)}
            onToast={showToast}
          />
        </div>

        <div className={`h-full ${view === 'captures' ? '' : 'hidden'}`}>
          <CapturesView
            active={view === 'captures'}
            onInsertPath={insertPath}
            onToast={showToast}
          />
        </div>
      </main>

      <nav className="relative z-10 flex shrink-0 border-t border-line-subtle bg-surface pb-[env(safe-area-inset-bottom)]">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setView(id)}
            aria-current={view === id ? 'page' : undefined}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors ${
              view === id ? 'text-accent' : 'text-faint hover:text-mut'
            }`}
          >
            <Icon size={21} />
            {label}
          </button>
        ))}
      </nav>

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

      {newSessionOpen && (
        <NewSessionSheet
          onCreated={(id) => {
            setNewSessionOpen(false)
            selectSession(id)
          }}
          onClose={() => setNewSessionOpen(false)}
        />
      )}
      {voiceSession && (
        <VoiceSheet
          session={voiceSession}
          onInsert={(text) => termHandle.current?.write(text)}
          onSend={(text) => termHandle.current?.write(`${text}\r`)}
          onClose={() => {
            voiceSession.dispose()
            setVoiceSession(null)
          }}
        />
      )}
      {approval && (
        <ApprovalModal
          request={approval}
          onApprove={() => {
            termHandle.current?.approve(approval.id)
            setApproval(null)
          }}
          onDeny={() => {
            termHandle.current?.deny(approval.id)
            setApproval(null)
            showToast('Command denied')
          }}
        />
      )}
      {/* Approval comes first: it is holding a keystroke the user just sent. */}
      {!approval && asks.length > 0 && (
        <AskModal
          request={asks[0]}
          onAnswer={(choice) => answerAsk(asks[0].id, choice)}
        />
      )}
      {toast && (
        <div className="fixed bottom-20 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-full border border-line bg-overlay px-4 py-2.5 text-center text-[13px]">
          {toast}
        </div>
      )}
    </div>
  )
}
