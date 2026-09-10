import { useCallback, useEffect, useRef, useState } from 'react'
import Terminal, {
  type ApprovalRequest,
  type AskRequest,
  type ConnectionStatus,
  type PreviewRequest,
  type TerminalHandle,
} from './Terminal'
import Login from './Login'
import TerminalView from './views/TerminalView'
import SessionsView from './views/SessionsView'
import ChangesView from './views/ChangesView'
import CapturesView from './views/CapturesView'
import NewSessionSheet from './sheets/NewSessionSheet'
import VoiceSheet from './sheets/VoiceSheet'
import { speechSupported, startSpeech, type SpeechSession } from './speech'
import { dropPush, pushEndpoint, registerPush, systemNotice } from './notice'
import ApprovalModal from './components/ApprovalModal'
import AskModal from './components/AskModal'
import PageViewer from './components/PageViewer'
import ComposeSheet from './sheets/ComposeSheet'
import {
  Button,
  EmptyState,
  IconBranch,
  IconCapture,
  IconPlus,
  IconSessions,
  IconTerminal,
} from './components/ui'
import {
  AuthError,
  checkAuth,
  checkAuthWithoutToken,
  forgetToken,
  retirePushSubscription,
  pairCodeIn,
  pairWithCode,
  clearAttention,
  fetchSessions,
  restartSession,
  type Recognition,
  unpairPhone,
  uploadImage,
  SESSION_KEY,
  type Attention,
  type SessionInfo,
} from './api'

const OPEN_PARAM = 'session'
const SW_OPEN_SESSION_MESSAGE = 'orbit-open-session'
const TOAST_MS = 3000
const NOTICE_MS = 3000
const BOOT_RETRY_MS = 2000
const PAIR_CODE_EXPIRED =
  'That pairing code has expired — run `orbit pair` on the Mac for a fresh one, or type the token.'
const TRAILING_SPACE = /\s*$/

const previewRouteKey = (port: number | string) => `orbit.previewRoute.${port}`

type View = 'terminal' | 'changes' | 'sessions' | 'captures'

const takeSessionFromAddress = (): string | null => {
  const id = new URLSearchParams(location.search).get(OPEN_PARAM)
  if (id) history.replaceState(null, '', location.pathname)
  return id
}

const takePairCodeFromAddress = (): string | null => {
  const code = pairCodeIn(location.href)
  if (code) history.replaceState(null, '', location.pathname + location.search)
  return code
}

let openedWith = takeSessionFromAddress()
let pairCode = takePairCodeFromAddress()
let pairFailure: string | null = null

const omit = <T,>(map: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _read, ...rest } = map
  return rest
}

const attentionBySession = (sessions: SessionInfo[]): Record<string, Attention> =>
  Object.fromEntries(sessions.flatMap((s) => (s.attention ? [[s.id, s.attention]] : [])))

const appendWords = (text: string, words: string) =>
  text ? `${text.replace(TRAILING_SPACE, '')} ${words}` : words

const appendPath = (text: string, path: string) => `${appendWords(text, path)} `

const TABS: { id: View; label: string; Icon: typeof IconTerminal }[] = [
  { id: 'terminal', label: 'Terminal', Icon: IconTerminal },
  { id: 'changes', label: 'Changes', Icon: IconBranch },
  { id: 'sessions', label: 'Sessions', Icon: IconSessions },
  { id: 'captures', label: 'Preview', Icon: IconCapture },
]

const previewPath = (url: string): string => {
  try {
    const { pathname } = new URL(url)
    return pathname === '/' ? '' : pathname
  } catch {
    return ''
  }
}

const rememberPreviewRoute = (preview: PreviewRequest) => {
  try {
    const { pathname, search, hash } = new URL(preview.url)
    localStorage.setItem(previewRouteKey(preview.port), pathname + search + hash)
  } catch {
    return
  }
}

type Toast = { message: string; sessionId?: string | null }
type Notice = { message: string; sessionId: string | null }
type NoticeMeta = { sessionId?: string | null; alreadyPushed?: boolean }

function useNoticeQueue(
  setToast: (toast: Toast | null) => void,
  refreshCurrent: () => void,
) {
  const queue = useRef<Notice[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showNextOrStop = useCallback(() => {
    const notice = queue.current.shift()
    if (notice === undefined) {
      timer.current = null
      setToast(null)
      return
    }
    setToast(notice)
    timer.current = setTimeout(showNextOrStop, NOTICE_MS)
  }, [setToast])

  return useCallback(
    (message: string, meta: NoticeMeta = {}) => {
      const sessionId = meta.sessionId ?? null
      queue.current.push({ message, sessionId })
      if (document.hidden && !meta.alreadyPushed) systemNotice(message)
      if (sessionId) refreshCurrent()
      const alreadyShowing = timer.current !== null
      if (alreadyShowing) return
      showNextOrStop()
    },
    [refreshCurrent, showNextOrStop],
  )
}

function AttentionBadge({ unread }: { unread: Attention[] }) {
  const someoneIsWaiting = unread.some((a) => a.kind === 'waiting')
  return (
    <span
      aria-label={`${unread.length} session(s) waiting`}
      className={`absolute -top-1 -right-2.5 min-w-4 rounded-full px-1 text-[10px] leading-4 font-semibold ${
        someoneIsWaiting ? 'bg-accent-strong text-white' : 'border border-line bg-raised text-mut'
      }`}
    >
      {unread.length}
    </span>
  )
}

function TabBar({
  view,
  unread,
  onSelect,
}: {
  view: View
  unread: Attention[]
  onSelect: (view: View) => void
}) {
  return (
    <nav className="relative z-10 flex shrink-0 bg-surface pb-[env(safe-area-inset-bottom)] shadow-[inset_0_1px_0_var(--edge-lit)]">
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          onClick={() => onSelect(id)}
          aria-current={view === id ? 'page' : undefined}
          className={`press flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors ${
            view === id ? 'text-accent' : 'text-faint hover:text-mut'
          }`}
        >
          <span className="relative">
            <Icon size={21} />
            {id === 'sessions' && unread.length > 0 && <AttentionBadge unread={unread} />}
          </span>
          {label}
        </button>
      ))}
    </nav>
  )
}

function ToastPill({ message }: { message: string }) {
  return (
    <div className="lift fixed bottom-20 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-[22px] border border-line bg-overlay px-4 py-2.5 text-center text-[13px]">
      {message}
    </div>
  )
}

function ToastLink({ message, onOpen }: { message: string; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="lift fixed bottom-20 left-1/2 z-50 flex max-w-[90vw] min-h-11 -translate-x-1/2 items-center gap-2 rounded-full border border-accent/60 bg-overlay py-2 pr-3 pl-4 text-left text-[13px]"
    >
      <span className="line-clamp-2">{message}</span>
      <span className="shrink-0 rounded-full bg-accent-strong px-2.5 py-1 text-[11px] font-medium text-white">
        Open
      </span>
    </button>
  )
}

export default function App() {
  const [locked, setLocked] = useState<boolean | null>(null)
  const [walkedIn, setWalkedIn] = useState(false)
  const [bootNonce, setBootNonce] = useState(0)
  const [socketNonce, setSocketNonce] = useState(0)
  const [view, setView] = useState<View>('terminal')
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [current, setCurrent] = useState<SessionInfo | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [voiceSession, setVoiceSession] = useState<SpeechSession | null>(null)
  const [draft, setDraft] = useState('')
  const [composeOpen, setComposeOpen] = useState(false)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [asks, setAsks] = useState<AskRequest[]>([])
  const [preview, setPreview] = useState<PreviewRequest | null>(null)
  const [attention, setAttention] = useState<Record<string, Attention>>({})
  const [toast, setToast] = useState<Toast | null>(null)
  const [startingNew, setStartingNew] = useState(false)
  const [booted, setBooted] = useState(false)
  const termHandle = useRef<TerminalHandle | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const selectSession = useCallback((id: string) => {
    localStorage.setItem(SESSION_KEY, id)
    setCurrentId(id)
    setView('terminal')
  }, [])

  const refreshCurrent = useCallback(async (id?: string | null) => {
    const sessionId = id ?? currentId
    try {
      const all = await fetchSessions()
      setCurrent(sessionId ? (all.find((s) => s.id === sessionId) ?? null) : null)
      setAttention(attentionBySession(all))
    } catch {
      return
    }
  }, [currentId])

  const showToast = useCallback((message: string) => {
    setToast({ message })
    setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  const showNotice = useNoticeQueue(setToast, refreshCurrent)

  const addAsk = useCallback(
    (request: AskRequest) => {
      setAsks((cur) => (cur.some((a) => a.id === request.id) ? cur : [...cur, request]))
      if (document.hidden) systemNotice(request.question)
      if (request.sessionId) refreshCurrent()
    },
    [refreshCurrent],
  )

  const answerAsk = useCallback(
    (id: string, choice: string) => {
      const answered = asks.find((a) => a.id === id)
      termHandle.current?.answer(id, choice)
      setAsks((cur) => cur.filter((a) => a.id !== id))
      const answeredSession = answered?.sessionId
      if (answeredSession) setAttention((cur) => omit(cur, answeredSession))
    },
    [asks],
  )

  useEffect(() => {
    if (locked !== false && locked !== null) return
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    setBooted(false)

    const admit = (recognition: Recognition) => {
      setWalkedIn(recognition.walkedIn)
      if (recognition.walkedIn) forgetToken()
      setLocked(false)
    }

    const exchangePairCodeIfAny = async () => {
      if (!pairCode) return
      const code = pairCode
      pairCode = null
      if (!(await pairWithCode(code))) pairFailure = PAIR_CODE_EXPIRED
    }

    const reattachToStoredSession = async () => {
      const asked = openedWith
      const stored = asked ?? localStorage.getItem(SESSION_KEY)
      const sessions = await fetchSessions()
      const found = sessions.find((s) => s.id === stored)
      if (cancelled) return
      openedWith = null
      if (found) {
        if (asked) localStorage.setItem(SESSION_KEY, found.id)
        setCurrentId(found.id)
      } else {
        localStorage.removeItem(SESSION_KEY)
        setCurrentId(null)
      }
      setBooted(true)
    }

    const boot = async () => {
      try {
        await exchangePairCodeIfAny()
        const withoutToken = await checkAuthWithoutToken()
        if (withoutToken.admitted) {
          if (!cancelled) admit(withoutToken)
          registerPush()
          await reattachToStoredSession()
          return
        }
        const withToken = await checkAuth()
        if (!withToken.admitted) {
          if (!cancelled) setLocked(true)
          return
        }
        if (!cancelled) admit(withToken)
        registerPush()
        await reattachToStoredSession()
      } catch (e) {
        if (cancelled) return
        if (e instanceof AuthError) setLocked(true)
        else retryTimer = setTimeout(boot, BOOT_RETRY_MS)
      }
    }
    boot()

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [locked, bootNonce])

  useEffect(() => {
    if (!currentId || locked !== false) return
    refreshCurrent(currentId)
  }, [currentId, locked, view, refreshCurrent])

  useEffect(() => {
    const id = currentId
    const lookingAtSessionWithUnreadWord = view === 'terminal' && id && attention[id]
    if (!lookingAtSessionWithUnreadWord) return
    setAttention((cur) => omit(cur, id))
    clearAttention(id).catch(() => {})
  }, [view, currentId, attention])

  useEffect(() => {
    const onServiceWorkerMessage = (event: MessageEvent) => {
      const data = event.data
      if (data?.type === SW_OPEN_SESSION_MESSAGE && typeof data.sessionId === 'string') {
        selectSession(data.sessionId)
      }
    }
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage)
  }, [selectSession])

  const handleExit = useCallback(
    (_code: number) => {
      refreshCurrent()
    },
    [refreshCurrent],
  )

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

  const remountTerminalWithFreshCookie = () => setSocketNonce((n) => n + 1)

  const handleAuthFail = useCallback(async () => {
    try {
      if ((await checkAuth()).admitted) {
        remountTerminalWithFreshCookie()
        return
      }
    } catch {
      setLocked(true)
      return
    }
    setLocked(true)
  }, [])

  const bootAgain = () => setBootNonce((n) => n + 1)

  const handleGone = useCallback(() => {
    localStorage.removeItem(SESSION_KEY)
    setCurrentId(null)
    setCurrent(null)
    bootAgain()
    showToast('That session is no longer on your Mac')
  }, [showToast])

  const unpair = useCallback(async () => {
    await unpairPhone(await pushEndpoint())
    await dropPush()
    setCurrentId(null)
    setCurrent(null)
    setLocked(true)
  }, [])

  const stopNotifications = useCallback(async () => {
    await retirePushSubscription(await pushEndpoint())
    await dropPush()
  }, [])

  const pickImage = async (file: File | null) => {
    if (!file) return
    const sheetThatOpenedThePicker = voiceSession
    try {
      const { path } = await uploadImage(file)
      if (sheetThatOpenedThePicker) {
        sheetThatOpenedThePicker.setTranscript(appendPath(sheetThatOpenedThePicker.transcript, path))
      } else {
        setDraft((text) => appendPath(text, path))
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Upload failed')
    }
  }

  const putText = (text: string, commit: boolean) => {
    if (!text) return
    termHandle.current?.paste(text)
    if (commit) termHandle.current?.write('\r')
  }

  const insertPath = (path: string) => {
    termHandle.current?.write(`${path} `)
    setView('terminal')
  }

  const openPicker = () => fileInput.current?.click()

  const startVoiceInsideThisTap = () => setVoiceSession(startSpeech())

  const closeVoice = () => {
    voiceSession?.dispose()
    setVoiceSession(null)
  }

  const moveDictationIntoDraft = (text: string) => {
    setDraft((d) => appendWords(d, text))
    setComposeOpen(true)
  }

  const approve = () => {
    if (!approval) return
    termHandle.current?.approve(approval.id)
    setApproval(null)
  }

  const deny = () => {
    if (!approval) return
    termHandle.current?.deny(approval.id)
    setApproval(null)
    showToast('Command denied')
  }

  const closePreview = () => {
    if (preview) rememberPreviewRoute(preview)
    setPreview(null)
  }

  if (locked === true) return <Login onSuccess={() => setLocked(false)} notice={pairFailure} />

  const unread = Object.values(attention)
  const headerStatus: ConnectionStatus = currentId ? status : booted ? 'connected' : 'connecting'
  const blockedQuestionOnScreen = approval !== null || asks.length > 0
  const toastLeadsElsewhere =
    toast?.sessionId && !(view === 'terminal' && toast.sessionId === currentId)

  return (
    <div className="app-fill flex flex-col pt-[env(safe-area-inset-top)]">
      <main className="relative min-h-0 flex-1">
        <div className={`h-full ${view === 'terminal' ? '' : 'hidden'}`}>
          <TerminalView
            session={current}
            status={headerStatus}
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
                onAttention={() => refreshCurrent()}
                onPreview={setPreview}
                onInsertPath={insertPath}
                onToast={showToast}
                handleRef={termHandle}
                onCompose={() => setComposeOpen(true)}
                onVoice={startVoiceInsideThisTap}
                voiceAvailable={speechSupported()}
                draftPending={draft.trim().length > 0}
              />
            ) : booted ? (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  title="No session"
                  hint="Nothing is open here. Start an agent in one of your projects — or pick one up from the Sessions tab."
                >
                  <Button onClick={() => setNewSessionOpen(true)}>
                    <IconPlus size={16} />
                    New session
                  </Button>
                </EmptyState>
              </div>
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
            onUnpair={unpair}
            tokenIsTheKey={!walkedIn}
            onStopNotifications={stopNotifications}
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

      <TabBar view={view} unread={unread} onSelect={setView} />

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
      {composeOpen && (
        <ComposeSheet
          value={draft}
          onChange={setDraft}
          onInsert={(text) => putText(text, false)}
          onSend={(text) => putText(text, true)}
          onImage={openPicker}
          onClose={() => setComposeOpen(false)}
        />
      )}
      {voiceSession && (
        <VoiceSheet
          session={voiceSession}
          onImage={openPicker}
          onInsert={moveDictationIntoDraft}
          onSend={(text) => putText(text, true)}
          onClose={closeVoice}
        />
      )}
      {approval && <ApprovalModal request={approval} onApprove={approve} onDeny={deny} />}
      {!approval && asks.length > 0 && (
        <AskModal
          request={asks[0]}
          onAnswer={(choice) => answerAsk(asks[0].id, choice)}
        />
      )}
      {preview && !blockedQuestionOnScreen && (
        <PageViewer
          uri={preview.url}
          label={`localhost:${preview.port}${previewPath(preview.url)}`}
          onClose={closePreview}
          onInsertPath={insertPath}
          onToast={showToast}
        />
      )}
      {toast &&
        (toastLeadsElsewhere ? (
          <ToastLink
            message={toast.message}
            onOpen={() => {
              selectSession(toast.sessionId!)
              setToast(null)
            }}
          />
        ) : (
          <ToastPill message={toast.message} />
        ))}
    </div>
  )
}
