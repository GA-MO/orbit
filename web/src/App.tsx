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
import ChangesView from './views/ChangesView'
import CapturesView from './views/CapturesView'
import NewSessionSheet from './sheets/NewSessionSheet'
import PasteSheet from './sheets/PasteSheet'
import VoiceSheet from './sheets/VoiceSheet'
import { speechSupported, startSpeech, type SpeechSession } from './speech'
import { registerPush, systemNotice } from './notice'
import ApprovalModal from './components/ApprovalModal'
import AskModal from './components/AskModal'
import { IconBranch, IconCapture, IconSessions, IconTerminal } from './components/ui'
import {
  AuthError,
  checkAuth,
  clearAttention,
  createSession,
  fetchSessions,
  restartSession,
  uploadImage,
  type Attention,
  type SessionInfo,
} from './api'

const SESSION_KEY = 'orbit.sessionId'
/** How long a clipboard read gets before the manual sheet takes over. */
const CLIPBOARD_WAIT_MS = 6000
/** A notification, or a link, naming the session to open on arrival. */
const OPEN_PARAM = 'session'

type View = 'terminal' | 'changes' | 'sessions' | 'captures'

/* A notification names the session that raised it, and a phone woken by one is
   almost never on that session already. Read at module load and cleared from
   the address bar at once: the boot effect runs more than once, and a second
   pass finding the parameter already gone would fall back to the stored
   session — which is precisely the one the notification was not about. */
let openedWith = (() => {
  const id = new URLSearchParams(location.search).get(OPEN_PARAM)
  if (id) history.replaceState(null, '', location.pathname)
  return id
})()

/** A copy of `map` without `key` — how a session's word gets marked as read. */
const omit = <T,>(map: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _read, ...rest } = map
  return rest
}

const TABS: { id: View; label: string; Icon: typeof IconTerminal }[] = [
  { id: 'terminal', label: 'Terminal', Icon: IconTerminal },
  /* Next to the terminal because it is the other half of the same question:
     the terminal says what the agent is doing, this says what it wrote. */
  { id: 'changes', label: 'Changes', Icon: IconBranch },
  { id: 'sessions', label: 'Sessions', Icon: IconSessions },
  /* "Captures" named the gallery, back when the gallery was all there was.
     The tab now publishes a dev server over https and opens it live over the
     terminal too, and a screenshot is the thing you fall back to. */
  { id: 'captures', label: 'Preview', Icon: IconCapture },
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
  const [pasteOpen, setPasteOpen] = useState(false)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  // Questions from the Mac queue up: each one is blocking something over there.
  const [asks, setAsks] = useState<AskRequest[]>([])
  /* What each session is still waiting to tell someone. Held here rather than
     in the Sessions tab because the whole point is to be visible from the other
     two — a phone is picked up to find out whether anything wants you. */
  const [attention, setAttention] = useState<Record<string, Attention>>({})
  const [toast, setToast] = useState<{ message: string; sessionId?: string | null } | null>(null)
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
    try {
      const all = await fetchSessions()
      setCurrent(sid ? (all.find((s) => s.id === sid) ?? null) : null)
      // The server's copy is the one that survived the app being closed.
      setAttention(
        Object.fromEntries(all.flatMap((s) => (s.attention ? [[s.id, s.attention]] : []))),
      )
    } catch {
      // ignore
    }
  }, [currentId])

  const showToast = useCallback((message: string) => {
    setToast({ message })
    setTimeout(() => setToast(null), 3000)
  }, [])

  /* Notices can arrive in a batch — everything that happened while the phone
     was asleep lands at once on reconnect. Queue them so each is actually read
     instead of the last one winning. */
  const noticeQueue = useRef<{ message: string; sessionId: string | null }[]>([])
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showNotice = useCallback(
    (message: string, meta: { sessionId?: string | null; alreadyPushed?: boolean } = {}) => {
      const sessionId = meta.sessionId ?? null
      noticeQueue.current.push({ message, sessionId })
      // One that woke the phone as a push is already on its screen; queueing the
      // toast still lets it be read in the app, but a banner would be the second.
      if (document.hidden && !meta.alreadyPushed) systemNotice(message)
      /* The server has already filed this against its session — ask what the
         standing state is now rather than guessing at it from one message. */
      if (sessionId) refreshCurrent()
      if (noticeTimer.current) return

      const next = () => {
        const notice = noticeQueue.current.shift()
        if (notice === undefined) {
          noticeTimer.current = null
          setToast(null)
          return
        }
        setToast(notice)
        noticeTimer.current = setTimeout(next, 3000)
      }
      next()
    },
    [refreshCurrent],
  )

  const addAsk = useCallback(
    (request: AskRequest) => {
      setAsks((cur) => (cur.some((a) => a.id === request.id) ? cur : [...cur, request]))
      if (document.hidden) systemNotice(request.question)
      // A question outlives the toast that announced it — and the app being shut.
      if (request.sessionId) refreshCurrent()
    },
    [refreshCurrent],
  )

  const answerAsk = useCallback(
    (id: string, choice: string) => {
      const answered = asks.find((a) => a.id === id)
      termHandle.current?.answer(id, choice)
      setAsks((cur) => cur.filter((a) => a.id !== id))
      // The server drops its record on an answer; keep the badge in step.
      const from = answered?.sessionId
      if (from) setAttention((cur) => omit(cur, from))
    },
    [asks],
  )

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
        const asked = openedWith
        const stored = asked ?? localStorage.getItem(SESSION_KEY)
        const sessions = await fetchSessions()
        // Reattach even if the session ended — its history opens read-only.
        const found = sessions.find((s) => s.id === stored)
        if (cancelled) return
        /* Spent only by the run that gets to act on it. Clearing it when it was
           read instead would hand it to the boot that `setLocked` immediately
           cancels, and the one that follows would fall back to storage. */
        openedWith = null
        if (found) {
          // Arrived from a notification: staying here across a reload is the point.
          if (asked) localStorage.setItem(SESSION_KEY, found.id)
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

  /* Looking at the session is what reads its word — not opening the app, and
     not tapping the toast. Anything else leaves a badge that clears itself
     before it has been understood. */
  useEffect(() => {
    const id = currentId
    if (view !== 'terminal' || !id || !attention[id]) return
    setAttention((cur) => omit(cur, id))
    clearAttention(id).catch(() => {})
  }, [view, currentId, attention])

  /* The app was already open when the notification was tapped, so nothing
     navigated: the service worker hands the session id over instead. */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data
      if (data?.type === 'orbit-open-session' && typeof data.sessionId === 'string') {
        selectSession(data.sessionId)
      }
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [selectSession])

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

  /* Read it here rather than making the phone do it: iOS will hand a page the
     clipboard on a tap — behind its own Paste confirmation — but only over
     https, and only if it is text. Everything else falls back to the sheet,
     where the phone's own Paste menu does the part we are not allowed to.

     The wait is because the read can also do neither: a browser that will not
     answer leaves the promise pending forever, and a paste button that sits
     there doing nothing is the thing this is meant to fix. The generous window
     is for iOS, where the promise stays open while its Paste confirmation is on
     screen — long enough to read it, short enough not to look broken. */
  const pasteClipboard = async () => {
    if (!navigator.clipboard?.readText) return setPasteOpen(true)

    let handled = false
    const giveUp = setTimeout(() => {
      if (handled) return
      handled = true
      setPasteOpen(true)
    }, CLIPBOARD_WAIT_MS)

    let text: string | null = null
    try {
      text = await navigator.clipboard.readText()
    } catch {
      text = null // refused, or the confirmation was dismissed
    }
    clearTimeout(giveUp)
    if (handled) return // the sheet already took over; pasting now would double it
    handled = true

    if (text === null) return setPasteOpen(true)
    // Read, and genuinely empty: a sheet would only ask them to paste nothing.
    if (!text) return showToast('Nothing on the clipboard')
    termHandle.current?.paste(text)
  }

  const insertPath = (path: string) => {
    termHandle.current?.write(`${path} `)
    setView('terminal')
  }

  if (locked === true) return <Login onSuccess={() => setLocked(false)} />

  const unread = Object.values(attention)

  return (
    <div className="app-fill flex flex-col pt-[env(safe-area-inset-top)]">
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
            onPaste={pasteClipboard}
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
                onInsertPath={insertPath}
                onToast={showToast}
                handleRef={termHandle}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-mut">
                Connecting to your Mac…
              </div>
            )}
          </TerminalView>
        </div>

        <div className={`h-full ${view === 'changes' ? '' : 'hidden'}`}>
          <ChangesView active={view === 'changes'} session={current} onToast={showToast} />
        </div>

        <div className={`h-full ${view === 'sessions' ? '' : 'hidden'}`}>
          <SessionsView
            active={view === 'sessions'}
            currentId={currentId}
            attention={attention}
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
            <span className="relative">
              <Icon size={21} />
              {/* The one thing on screen that says a session wants you while you
                  are looking at something else. */}
              {id === 'sessions' && unread.length > 0 && (
                <span
                  aria-label={`${unread.length} session(s) waiting`}
                  className={`absolute -top-1 -right-2.5 min-w-4 rounded-full px-1 text-[10px] leading-4 font-semibold ${
                    unread.some((a) => a.kind === 'waiting')
                      ? 'bg-accent-strong text-white'
                      : 'border border-line bg-raised text-mut'
                  }`}
                >
                  {unread.length}
                </span>
              )}
            </span>
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
      {pasteOpen && (
        <PasteSheet
          onInsert={(text) => termHandle.current?.paste(text)}
          onSend={(text) => {
            termHandle.current?.paste(text)
            termHandle.current?.write('\r')
          }}
          onClose={() => setPasteOpen(false)}
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
      {/* A notice from a session you are not looking at is the one worth acting
          on, and reading it is not the action — so it is the way there. Plain
          toasts (upload failed, session stopped) stay a plain div: nothing to go
          to, and a button that does nothing reads as a broken one. */}
      {toast &&
        (toast.sessionId && !(view === 'terminal' && toast.sessionId === currentId) ? (
          <button
            onClick={() => {
              selectSession(toast.sessionId!)
              setToast(null)
            }}
            className="fixed bottom-20 left-1/2 z-50 flex max-w-[90vw] min-h-11 -translate-x-1/2 items-center gap-2 rounded-full border border-accent/60 bg-overlay py-2 pr-3 pl-4 text-left text-[13px]"
          >
            <span className="line-clamp-2">{toast.message}</span>
            <span className="shrink-0 rounded-full bg-accent-strong px-2.5 py-1 text-[11px] font-medium text-white">
              Open
            </span>
          </button>
        ) : (
          /* A pill while it fits on one line, a box once it does not: a
             four-line message inside `rounded-full` is a blob. */
          <div className="fixed bottom-20 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-[22px] border border-line bg-overlay px-4 py-2.5 text-center text-[13px]">
            {toast.message}
          </div>
        ))}
    </div>
  )
}
