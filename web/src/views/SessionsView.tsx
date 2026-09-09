import { useEffect, useState } from 'react'
import {
  fetchHiddenCount,
  fetchSessions,
  hideSession,
  killSession,
  renameSession,
  unhideSessions,
  type Attention,
  type SessionInfo,
} from '../api'
import NoticeOptIn from '../components/NoticeOptIn'
import {
  Button,
  EmptyState,
  IconButton,
  IconChevronDown,
  IconClose,
  IconEdit,
  IconPlus,
  IconTrash,
  PROVIDER_GLYPH,
  basename,
  sessionLabel,
  timeAgo,
  useArrival,
} from '../components/ui'

interface Props {
  active: boolean
  currentId: string | null
  /** What each session is still waiting to say — owned by the app shell, which
      needs the same answer for the tab badge. */
  attention: Record<string, Attention>
  onSelect: (id: string) => void
  onNew: () => void
  /** Un-pair this phone from the Mac — owned by the app shell, which holds the
      socket and the login gate this tears down. */
  onUnpair: () => Promise<void>
  onToast: (message: string) => void
}

export default function SessionsView({
  active,
  currentId,
  attention,
  onSelect,
  onNew,
  onUnpair,
  onToast,
}: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmUnpair, setConfirmUnpair] = useState(false)
  /* Conversations from the Mac are collapsed by default. There are hundreds of
     transcripts on a machine that is used, and the tab exists to answer "which
     of my sessions wants me" — a question sixty borrowed rows drown. */
  const [macOpen, setMacOpen] = useState(false)
  const [hiddenCount, setHiddenCount] = useState(0)
  const [unpairing, setUnpairing] = useState(false)

  const refresh = () => fetchSessions().then(setSessions).catch(() => {})

  useEffect(() => {
    if (active) refresh()
  }, [active])

  const kill = async (s: SessionInfo) => {
    await killSession(s.id)
    await new Promise((r) => setTimeout(r, 400))
    refresh()
    onToast(`${sessionLabel(s)} stopped — history kept in Ended`)
  }

  const forget = async (s: SessionInfo) => {
    await killSession(s.id)
    refresh()
  }

  /* Asking the Mac how many are hidden costs a request, so it is asked only
     when the group is open — which is the only place the answer is shown, and
     the only moment anyone wants it back. */
  const refreshHidden = () =>
    fetchHiddenCount()
      .then((r) => setHiddenCount(r.hidden))
      .catch(() => {})

  const hide = async (s: SessionInfo) => {
    await hideSession(s.id)
    await refresh()
    refreshHidden()
  }

  const unhide = async () => {
    await unhideSessions()
    await refresh()
    refreshHidden()
  }

  const unpair = async () => {
    setUnpairing(true)
    try {
      await onUnpair()
    } catch {
      /* Left paired on purpose: nothing was cleared, so saying so is the whole
         recovery — the phone is exactly as it was and the tap can be repeated. */
      setUnpairing(false)
      setConfirmUnpair(false)
      onToast('Could not reach your Mac — still paired')
    }
  }

  const commitRename = async (id: string) => {
    setRenamingId(null)
    await renameSession(id, renameValue.trim())
    refresh()
  }

  const alive = sessions.filter((s) => s.alive)
  /* Two kinds of ended row, and they are not peers. One is a session this phone
     started and can delete; the other is a conversation that happened at the
     desk, which Orbit borrowed and may only read. Mixing them put the user's
     own single session in a wall of sixty borrowed ones. */
  const ended = sessions.filter((s) => !s.alive && !s.external)
  const fromMac = sessions.filter((s) => !s.alive && s.external)
  const waiting = sessions.filter((s) => attention[s.id]?.kind === 'waiting').length

  /* The screen's reading order, headers included, so a group's title arrives
     just ahead of the rows it introduces instead of sitting there waiting for
     them. `useArrival` gives a row its place in the sequence exactly once —
     the poll behind this list runs on every tab activation and every ten
     seconds, and none of those may replay an entrance. */
  const arrive = useArrival([
    ...alive.map((s) => `a:${s.id}`),
    ...(ended.length > 0 ? ['h:ended'] : []),
    ...ended.map((s) => `e:${s.id}`),
    ...(fromMac.length > 0 ? ['h:mac'] : []),
    ...(macOpen ? fromMac.map((s) => `m:${s.id}`) : []),
  ])

  const row = (s: SessionInfo, group: 'a' | 'e' | 'm' = 'a') => {
    const enter = arrive(`${group}:${s.id}`)
    const isCurrent = s.id === currentId
    const label = sessionLabel(s)
    /* A borrowed first command reads as terminal output, not as a title. */
    const isCommand = !s.name && !!s.firstCommand
    const note = attention[s.id]
    return (
      <div
        key={s.id}
        style={enter.style}
        className={`press group relative ${enter.className} flex cursor-pointer items-center gap-3 rounded-(--radius-card) border px-3.5 py-3 transition-colors ${s.alive ? 'alive ' : ''}${
          isCurrent
            ? 'border-accent/60 bg-accent/8'
            : note?.kind === 'waiting'
              ? 'border-accent/40 bg-accent/4'
              : 'border-line-subtle bg-surface hover:border-line'
        }`}
        onClick={() => renamingId !== s.id && onSelect(s.id)}
      >
        {/* A light running round the edge is what "this one is running" looks
            like now. It is its own element rather than a pseudo: the rotating
            plane has to sit *under* the row's text and the ring mask above it,
            and ::before/::after only bracket the content. */}
        {s.alive && <span className="live-edge" aria-hidden />}
        <span className="relative shrink-0">
          <span
            className={`flex size-10 items-center justify-center rounded-full border font-mono text-base ${
              s.alive ? 'border-line text-accent' : 'border-line-subtle text-faint'
            }`}
          >
            {PROVIDER_GLYPH[s.providerId] ?? '❯'}
          </span>
        </span>

        {renamingId === s.id ? (
          <input
            className="min-w-0 flex-1 rounded-(--radius-field) border border-accent bg-ink px-2.5 py-1.5 text-sm outline-none"
            value={renameValue}
            placeholder={s.providerName}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => commitRename(s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(s.id)
              if (e.key === 'Escape') setRenamingId(null)
            }}
          />
        ) : (
          <span className="min-w-0 flex-1">
            <span
              className={`block truncate text-sm ${
                isCommand ? 'font-mono text-[13px]' : 'font-medium'
              } ${s.alive ? '' : 'text-mut'}`}
            >
              {label}
            </span>
            <span className="block truncate text-xs text-faint">
              {label === s.providerName ? '' : `${s.providerName} · `}
              {basename(s.cwd)} ·{' '}
              {/* Nothing here ended a conversation that ran on the Mac — the
                  user may still have it open at the desk. All the transcript
                  knows is when it was last written to. */}
              {s.external
                ? `on the Mac · ${s.endedAt ? timeAgo(s.endedAt) : '?'}`
                : s.alive
                  ? timeAgo(s.createdAt)
                  : `ended ${s.endedAt ? timeAgo(s.endedAt) : '?'}`}
            </span>
            {/* The last thing it said, still unread. Two lines: a question
                truncated at 40 characters is a question you have to open the
                session to understand, which defeats the point of saying it.

                A line Orbit read off a screen that stopped moving is worth the
                same badge and not the same voice: it still means "this one
                wants you", but it is a guess at why, so it is shown in the
                quieter colour and its dot does not pulse. */}
            {note && (
              <span
                className={`mt-1 flex items-start gap-1.5 text-xs ${
                  note.kind === 'waiting' && !note.idle ? 'text-accent' : 'text-mut'
                }`}
              >
                {note.kind === 'waiting' && (
                  <span
                    className={`mt-1 size-1.5 shrink-0 rounded-full ${
                      note.idle ? 'bg-mut' : 'pulse-live bg-accent-strong'
                    }`}
                  />
                )}
                <span className="line-clamp-2">
                  {note.message}
                  <span className="text-faint"> · {timeAgo(note.at)}</span>
                </span>
              </span>
            )}
          </span>
        )}

        <span className="flex shrink-0 items-center">
          {s.alive ? (
            <>
              <IconButton
                label="Rename"
                onClick={(e) => {
                  e.stopPropagation()
                  setRenamingId(s.id)
                  setRenameValue(s.name ?? '')
                }}
              >
                <IconEdit size={16} />
              </IconButton>
              <IconButton
                label="Stop session"
                className="hover:text-danger"
                onClick={(e) => {
                  e.stopPropagation()
                  kill(s)
                }}
              >
                <IconTrash size={16} />
              </IconButton>
            </>
          ) : (
            /* Resume and New are not here, though they used to be. They live
               one tap away, in the header of the history this row opens — and
               that is the tap that should come first. Both of them start an
               agent, which costs tokens and takes a minute; putting them in a
               list you scroll with a thumb made the expensive thing the easy
               thing to hit by accident.

               Reading first is also the only way to tell two rows apart. Now
               that a session can be reopened as *itself* rather than as "the
               newest one in this folder", a folder can hold several ended rows
               that all offer Resume and all read `Claude Code · proj · ended
               now`. Nothing on the row says which conversation is which. The
               history does — it is the conversation. */
            /* No ✕ on a conversation from the Mac: the history behind it is
               Claude Code's own transcript, which Orbit reads and never
               writes. A delete here would throw away the record of a session
               the user ran at their desk, from a list they were scrolling. */
            (s.external ? (
              /* What the ✕ would have been, if it were Orbit's to offer. This
                 one takes the row off the phone and leaves the transcript
                 alone, so the conversation is still there at the desk and comes
                 back if the group's count is tapped. A cross rather than a
                 trash can, because nothing is being thrown away. */
              <IconButton
                label="Hide from this phone"
                onClick={(e) => {
                  e.stopPropagation()
                  hide(s)
                }}
              >
                <IconClose size={16} />
              </IconButton>
            ) : (
              <IconButton
                label="Forget (delete history)"
                className="hover:text-danger"
                onClick={(e) => {
                  e.stopPropagation()
                  forget(s)
                }}
              >
                <IconTrash size={16} />
              </IconButton>
            ))
          )}
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between px-5 pt-4 pb-3">
        <h1 className="font-display text-lg font-semibold tracking-wide">Sessions</h1>
        <span className="text-xs text-faint">
          {waiting > 0 && <span className="text-accent">{waiting} waiting · </span>}
          {alive.length} live{ended.length > 0 ? ` · ${ended.length} ended` : ''}
        </span>
      </header>

      <NoticeOptIn onToast={onToast} />

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4">
        {/* Counting the Mac's rows too, or the screen says "No sessions yet"
            directly above a group announcing ten of them. They are not this
            phone's sessions, but they are certainly something to look at, and
            an empty state that contradicts the list under it is worse than no
            empty state at all. */}
        {alive.length === 0 && ended.length === 0 && fromMac.length === 0 && (
          <EmptyState
            title="No sessions yet"
            hint="Start an agent in one of your projects — it keeps running even when your phone disconnects."
          />
        )}
        {alive.map((s) => row(s, 'a'))}
        {ended.length > 0 && (
          <div
            style={arrive('h:ended').style}
            className={`${arrive('h:ended').className} px-3.5 pt-3 pb-1 text-xs font-semibold tracking-widest text-faint uppercase`}
          >
            Ended
          </div>
        )}
        {ended.map((s) => row(s, 'e'))}

        {/* Collapsed, with its own count, because these rows belong to someone
            else's list. Opening it is a decision to go looking for a
            conversation from the desk; until then the tab is about this phone's
            own sessions. The count is on the header rather than inside,
            because the number is the reason to open it. */}
        {fromMac.length > 0 && (
          <button
            style={arrive('h:mac').style}
            /* The chevron sits at the far end, not in front of the label:
               leading it pushed this header 22px further right than "Ended"
               directly above it, so the two headings of one list did not share
               an edge — and neither lined up with the rows they introduce.
               Now all three start at the same x, and the affordance is where a
               disclosure is looked for. */
            className={`${arrive('h:mac').className} flex w-full items-center justify-between px-3.5 pt-3 pb-1 text-xs font-semibold tracking-widest text-faint uppercase`}
            onClick={() => {
              const next = !macOpen
              setMacOpen(next)
              if (next) refreshHidden()
            }}
          >
            <span>From the Mac ({fromMac.length})</span>
            <span className={`transition-transform ${macOpen ? '' : '-rotate-90'}`}>
              <IconChevronDown size={14} />
            </span>
          </button>
        )}
        {macOpen && fromMac.map((s) => row(s, 'm'))}
        {/* The only undo there is. A hidden row is not on screen, so there is
            nothing left to aim at one at a time — see `unhideAll` on the
            server. Shown only inside the open group, next to the rows it would
            put back. */}
        {macOpen && hiddenCount > 0 && (
          <button
            onClick={unhide}
            className="w-full px-3 py-2 text-left text-xs text-faint transition-colors hover:text-mut"
          >
            {hiddenCount} hidden · show {hiddenCount === 1 ? 'it' : 'them'} again
          </button>
        )}

        {/* Un-pairing lives at the far end of the list, in the smallest type on
            the screen, because it is the one action here that cannot be undone
            by tapping again: the way back is the access token or the QR code in
            the server console, and that is on the Mac. Scrolling past every
            session to reach it is the point — nothing a thumb does on the way
            to a row can land on it. */}
        <div className="flex justify-center pt-6 pb-1">
          {/* A real control, not a line of text. It was styled as bare faint
              type to keep it quiet, and quiet it was — so quiet that it read as
              a caption rather than something you could press. `outline` is the
              app's quietest actual button: a 5% face and the same rim as
              everything else, so it says "pressable" without competing with the
              docked New session below it. Its distance still does the work of
              keeping a thumb off it. */}
          <Button variant="outline" onClick={() => setConfirmUnpair(true)}>
            Unpair this phone
          </Button>
        </div>
      </div>

      {/* Docked, not floating: a circle hovering over the list landed on top of
          whichever row happened to be under it — next to that row's own ＋,
          which starts a session in that folder and means something else. This
          one says which of the two it is, and sits where no row ever is. */}
      <div className="shrink-0 border-t border-line-subtle bg-surface px-4 py-2.5">
        <Button onClick={onNew} className="h-11 w-full">
          <IconPlus size={18} />
          New session
        </Button>
      </div>

      {/* Built like AskModal rather than as a new kind of dialog, because it is
          the same event from the user's side: the app has stopped and is
          waiting on an answer. Two things differ, and both come from who is
          asking. AskModal has no dismiss because the Mac is blocked until it is
          tapped; nothing is blocked here, so refusing is one of the answers.
          And it wears the accent border that marks everything the Mac says,
          while this is the phone asking about itself, so it does not.

          Cancel takes the emphasis and the thumb position AskModal reserves for
          the first option, for the reason given there: the safe choice goes
          where the hand already is. Nothing on the Mac is touched — its
          sessions keep running and the token still works — so the copy says
          what actually changes, which is this phone. */}
      {confirmUnpair && (
        <div className="scrim app-fill z-50 flex items-center justify-center p-5">
          <div className="pop-in lift flex w-full max-w-md flex-col gap-3.5 rounded-(--radius-sheet) bg-surface p-5">
            <span className="font-display text-[15px] font-semibold">Unpair this phone?</span>
            <p className="text-[13px] leading-relaxed text-mut">
              It stops reaching your Mac and stops notifying you. Your sessions keep running
              over there. To use Orbit here again you will need the access token from the
              server console, or its QR code.
            </p>
            <div className="flex flex-row-reverse gap-2">
              <Button
                className="flex-1"
                disabled={unpairing}
                onClick={() => setConfirmUnpair(false)}
              >
                Stay paired
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                disabled={unpairing}
                onClick={unpair}
              >
                {unpairing ? 'Unpairing…' : 'Unpair'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
