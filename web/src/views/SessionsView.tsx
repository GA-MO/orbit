import { useEffect, useState } from 'react'
import {
  fetchSessions,
  killSession,
  renameSession,
  type Attention,
  type SessionInfo,
} from '../api'
import NoticeOptIn from '../components/NoticeOptIn'
import {
  Button,
  EmptyState,
  IconButton,
  IconEdit,
  IconPlus,
  IconTrash,
  PROVIDER_GLYPH,
  basename,
  sessionLabel,
  timeAgo,
} from '../components/ui'

interface Props {
  active: boolean
  currentId: string | null
  /** What each session is still waiting to say — owned by the app shell, which
      needs the same answer for the tab badge. */
  attention: Record<string, Attention>
  onSelect: (id: string) => void
  onNew: () => void
  onToast: (message: string) => void
}

export default function SessionsView({
  active,
  currentId,
  attention,
  onSelect,
  onNew,
  onToast,
}: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

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

  const commitRename = async (id: string) => {
    setRenamingId(null)
    await renameSession(id, renameValue.trim())
    refresh()
  }

  const alive = sessions.filter((s) => s.alive)
  const ended = sessions.filter((s) => !s.alive)
  const waiting = sessions.filter((s) => attention[s.id]?.kind === 'waiting').length

  const row = (s: SessionInfo) => {
    const isCurrent = s.id === currentId
    const label = sessionLabel(s)
    /* A borrowed first command reads as terminal output, not as a title. */
    const isCommand = !s.name && !!s.firstCommand
    const note = attention[s.id]
    return (
      <div
        key={s.id}
        className={`group flex cursor-pointer items-center gap-3 rounded-(--radius-card) border px-3.5 py-3 transition-colors ${
          isCurrent
            ? 'border-accent/60 bg-accent/8'
            : note?.kind === 'waiting'
              ? 'border-accent/40 bg-accent/4'
              : 'border-line-subtle bg-surface hover:border-line'
        }`}
        onClick={() => renamingId !== s.id && onSelect(s.id)}
      >
        <span className="relative shrink-0">
          <span
            className={`flex size-10 items-center justify-center rounded-full border font-mono text-base ${
              s.alive ? 'border-line text-accent' : 'border-line-subtle text-faint'
            }`}
          >
            {PROVIDER_GLYPH[s.providerId] ?? '❯'}
          </span>
          {s.alive && (
            <span className="pulse-live absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-live ring-2 ring-surface" />
          )}
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
                session to understand, which defeats the point of saying it. */}
            {note && (
              <span
                className={`mt-1 flex items-start gap-1.5 text-xs ${
                  note.kind === 'waiting' ? 'text-accent' : 'text-mut'
                }`}
              >
                {note.kind === 'waiting' && (
                  <span className="pulse-live mt-1 size-1.5 shrink-0 rounded-full bg-accent-strong" />
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
            !s.external && (
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
            )
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
        {alive.length === 0 && ended.length === 0 && (
          <EmptyState
            title="No sessions yet"
            hint="Start an agent in one of your projects — it keeps running even when your phone disconnects."
          />
        )}
        {alive.map(row)}
        {ended.length > 0 && (
          <div className="pt-3 pb-1 text-xs font-semibold tracking-widest text-faint uppercase">
            Ended
          </div>
        )}
        {ended.map(row)}
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
    </div>
  )
}
