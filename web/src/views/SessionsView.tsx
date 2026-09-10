import { useEffect, useState, type MouseEvent } from 'react'
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
  IconBell,
  IconPhone,
  IconPlus,
  IconTrash,
  ProviderGlyph,
  Sheet,
  basename,
  sessionLabel,
  timeAgo,
  useArrival,
} from '../components/ui'

const STOP_SETTLE_MS = 400

type Group = 'a' | 'e' | 'm'
const ENDED_HEADER_KEY = 'h:ended'
const MAC_HEADER_KEY = 'h:mac'
const rowKey = (group: Group, id: string) => `${group}:${id}`

type Arrive = ReturnType<typeof useArrival>

interface Props {
  active: boolean
  currentId: string | null
  attention: Record<string, Attention>
  onSelect: (id: string) => void
  onNew: () => void
  onUnpair: () => Promise<void>
  tokenIsTheKey: boolean
  onStopNotifications: () => Promise<void>
  onToast: (message: string) => void
}

const stopRow = (e: MouseEvent, then: () => void) => {
  e.stopPropagation()
  then()
}

function sessionAge(s: SessionInfo) {
  const endedAgo = s.endedAt ? timeAgo(s.endedAt) : '?'
  if (s.external) return `on the desktop · ${endedAgo}`
  if (s.alive) return timeAgo(s.createdAt)
  return `ended ${endedAgo}`
}

function rowBorder(isCurrent: boolean, note: Attention | undefined) {
  if (isCurrent) return 'border-accent/60 bg-accent/8'
  if (note?.kind === 'waiting') return 'border-accent/40 bg-accent/4'
  return 'border-line-subtle bg-surface hover:border-line'
}

function AttentionNote({ note }: { note: Attention }) {
  const waiting = note.kind === 'waiting'
  const loud = waiting && !note.idle
  return (
    <span className={`mt-1 flex items-start gap-1.5 text-xs ${loud ? 'text-accent' : 'text-mut'}`}>
      {waiting && (
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
  )
}

interface RenameState {
  id: string | null
  value: string
}

interface RowProps {
  session: SessionInfo
  group: Group
  arrive: Arrive
  isCurrent: boolean
  note: Attention | undefined
  rename: RenameState
  onSelect: (id: string) => void
  onStartRename: (s: SessionInfo) => void
  onRenameChange: (value: string) => void
  onCommitRename: (id: string) => void
  onCancelRename: () => void
  onKill: (s: SessionInfo) => void
  onForget: (s: SessionInfo) => void
  onHide: (s: SessionInfo) => void
}

function SessionRow({
  session: s,
  group,
  arrive,
  isCurrent,
  note,
  rename,
  onSelect,
  onStartRename,
  onRenameChange,
  onCommitRename,
  onCancelRename,
  onKill,
  onForget,
  onHide,
}: RowProps) {
  const enter = arrive(rowKey(group, s.id))
  const label = sessionLabel(s)
  const labelIsCommand = !s.name && !!s.firstCommand
  const renaming = rename.id === s.id

  return (
    <div
      style={enter.style}
      className={`press group relative ${enter.className} flex cursor-pointer items-center gap-3 rounded-(--radius-card) border px-3.5 py-3 transition-colors ${s.alive ? 'alive ' : ''}${rowBorder(isCurrent, note)}`}
      onClick={() => !renaming && onSelect(s.id)}
    >
      {s.alive && <span className="live-edge" aria-hidden />}
      <span className="relative shrink-0">
        <span
          className={`flex size-10 items-center justify-center rounded-full border ${
            s.alive ? 'border-line text-accent' : 'border-line-subtle text-faint'
          }`}
        >
          <ProviderGlyph providerId={s.providerId} size={18} />
        </span>
      </span>

      {renaming ? (
        <input
          className="min-w-0 flex-1 rounded-(--radius-field) border border-accent bg-ink px-2.5 py-1.5 text-sm outline-none"
          value={rename.value}
          placeholder={s.providerName}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={() => onCommitRename(s.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommitRename(s.id)
            if (e.key === 'Escape') onCancelRename()
          }}
        />
      ) : (
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-sm ${
              labelIsCommand ? 'font-mono text-[13px]' : 'font-medium'
            } ${s.alive ? '' : 'text-mut'}`}
          >
            {label}
          </span>
          <span className="block truncate text-xs text-faint">
            {label === s.providerName ? '' : `${s.providerName} · `}
            {basename(s.cwd)} · {sessionAge(s)}
          </span>
          {note && <AttentionNote note={note} />}
        </span>
      )}

      <span className="flex shrink-0 items-center">
        {s.alive ? (
          <>
            <IconButton label="Rename" onClick={(e) => stopRow(e, () => onStartRename(s))}>
              <IconEdit size={16} />
            </IconButton>
            <IconButton
              label="Stop session"
              className="hover:text-danger"
              onClick={(e) => stopRow(e, () => onKill(s))}
            >
              <IconTrash size={16} />
            </IconButton>
          </>
        ) : s.external ? (
          <IconButton label="Hide from this phone" onClick={(e) => stopRow(e, () => onHide(s))}>
            <IconClose size={16} />
          </IconButton>
        ) : (
          <IconButton
            label="Forget (delete history)"
            className="hover:text-danger"
            onClick={(e) => stopRow(e, () => onForget(s))}
          >
            <IconTrash size={16} />
          </IconButton>
        )}
      </span>
    </div>
  )
}

function GroupHeader({ arrive, id, children }: { arrive: Arrive; id: string; children: string }) {
  return (
    <div
      style={arrive(id).style}
      className={`${arrive(id).className} px-3.5 pt-3 pb-1 text-xs font-semibold tracking-widest text-faint uppercase`}
    >
      {children}
    </div>
  )
}

function MacGroupHeader({
  arrive,
  count,
  open,
  onToggle,
}: {
  arrive: Arrive
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      style={arrive(MAC_HEADER_KEY).style}
      className={`${arrive(MAC_HEADER_KEY).className} flex w-full items-center justify-between px-3.5 pt-3 pb-1 text-xs font-semibold tracking-widest text-faint uppercase`}
      onClick={onToggle}
    >
      <span>From the desktop ({count})</span>
      <span className={`transition-transform ${open ? '' : '-rotate-90'}`}>
        <IconChevronDown size={14} />
      </span>
    </button>
  )
}

const sheetName = (tokenIsTheKey: boolean) => (tokenIsTheKey ? 'This phone' : 'Notifications')

function UnpairSheet({
  tokenIsTheKey,
  unpairing,
  onUnpair,
  onStopNotifications,
  onClose,
}: {
  tokenIsTheKey: boolean
  unpairing: boolean
  onUnpair: () => void
  onStopNotifications: () => void
  onClose: () => void
}) {
  return (
    <Sheet title={sheetName(tokenIsTheKey)} onClose={() => !unpairing && onClose()}>
      <div className="flex flex-col gap-3.5 px-5 pt-2 pb-5">
        {tokenIsTheKey ? (
          <p className="text-[13px] leading-relaxed text-mut">
            Un-pairing stops this phone reaching your desktop and stops it notifying you. Your
            sessions keep running over there. To use Orbit here again you will need the access
            token from the server console, or its QR code.
          </p>
        ) : (
          <p className="text-[13px] leading-relaxed text-mut">
            Orbit notifies this phone when a session is waiting on you. Stopping that leaves
            everything else alone — you reach your desktop over your tailnet and it knows you by
            your Tailscale login, so there is nothing here to unpair. To close this phone out
            entirely, remove it from your tailnet.
          </p>
        )}
        <div className="flex flex-row-reverse gap-2">
          <Button className="flex-1" disabled={unpairing} onClick={onClose}>
            {tokenIsTheKey ? 'Stay paired' : 'Close'}
          </Button>
          {tokenIsTheKey ? (
            <Button variant="danger" className="flex-1" disabled={unpairing} onClick={onUnpair}>
              {unpairing ? 'Unpairing…' : 'Unpair'}
            </Button>
          ) : (
            <Button
              variant="outline"
              className="flex-1"
              disabled={unpairing}
              onClick={onStopNotifications}
            >
              {unpairing ? 'Stopping…' : 'Stop notifications'}
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  )
}

function useSessionList(active: boolean) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const refresh = () => fetchSessions().then(setSessions).catch(() => {})
  useEffect(() => {
    if (active) refresh()
  }, [active])
  return { sessions, refresh }
}

export default function SessionsView({
  active,
  currentId,
  attention,
  onSelect,
  onNew,
  onUnpair,
  tokenIsTheKey,
  onStopNotifications,
  onToast,
}: Props) {
  const { sessions, refresh } = useSessionList(active)
  const [rename, setRename] = useState<RenameState>({ id: null, value: '' })
  const [phoneOpen, setPhoneOpen] = useState(false)
  const [macOpen, setMacOpen] = useState(false)
  const [hiddenCount, setHiddenCount] = useState(0)
  const [unpairing, setUnpairing] = useState(false)

  const kill = async (s: SessionInfo) => {
    await killSession(s.id)
    await new Promise((r) => setTimeout(r, STOP_SETTLE_MS))
    refresh()
    onToast(`${sessionLabel(s)} stopped — history kept in Ended`)
  }

  const forget = async (s: SessionInfo) => {
    await killSession(s.id)
    refresh()
  }

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

  const toggleDesktop = () => {
    const next = !macOpen
    setMacOpen(next)
    if (next) refreshHidden()
  }

  const unpair = async () => {
    setUnpairing(true)
    try {
      await onUnpair()
    } catch {
      setUnpairing(false)
      setPhoneOpen(false)
      onToast('Could not reach your desktop — still paired')
    }
  }

  const stopNotifications = async () => {
    setUnpairing(true)
    try {
      await onStopNotifications()
      setPhoneOpen(false)
      onToast('This phone will stop notifying you')
    } catch {
      setPhoneOpen(false)
      onToast('Could not reach your desktop — notifications unchanged')
    } finally {
      setUnpairing(false)
    }
  }

  const startRename = (s: SessionInfo) => setRename({ id: s.id, value: s.name ?? '' })
  const cancelRename = () => setRename((r) => ({ ...r, id: null }))

  const commitRename = async (id: string) => {
    if (rename.id !== id) return
    setRename((r) => ({ ...r, id: null }))
    try {
      await renameSession(id, rename.value.trim())
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Could not rename')
    }
    refresh()
  }

  const alive = sessions.filter((s) => s.alive)
  const ended = sessions.filter((s) => !s.alive && !s.external)
  const fromDesktop = sessions.filter((s) => !s.alive && s.external)
  const waiting = sessions.filter((s) => attention[s.id]?.kind === 'waiting').length

  const arrive = useArrival([
    ...alive.map((s) => rowKey('a', s.id)),
    ...(ended.length > 0 ? [ENDED_HEADER_KEY] : []),
    ...ended.map((s) => rowKey('e', s.id)),
    ...(fromDesktop.length > 0 ? [MAC_HEADER_KEY] : []),
    ...(macOpen ? fromDesktop.map((s) => rowKey('m', s.id)) : []),
  ])

  const row = (s: SessionInfo, group: Group) => (
    <SessionRow
      key={s.id}
      session={s}
      group={group}
      arrive={arrive}
      isCurrent={s.id === currentId}
      note={attention[s.id]}
      rename={rename}
      onSelect={onSelect}
      onStartRename={startRename}
      onRenameChange={(value) => setRename((r) => ({ ...r, value }))}
      onCommitRename={commitRename}
      onCancelRename={cancelRename}
      onKill={kill}
      onForget={forget}
      onHide={hide}
    />
  )

  const nothingToShow = alive.length === 0 && ended.length === 0 && fromDesktop.length === 0

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 px-5 pt-4 pb-3">
        <h1 className="min-w-0 flex-1 font-display text-lg font-semibold tracking-wide">
          Sessions
        </h1>
        <span className="text-xs text-faint">
          {waiting > 0 && <span className="text-accent">{waiting} waiting · </span>}
          {alive.length} live{ended.length > 0 ? ` · ${ended.length} ended` : ''}
        </span>
        <IconButton label={sheetName(tokenIsTheKey)} onClick={() => setPhoneOpen(true)}>
          {tokenIsTheKey ? <IconPhone size={18} /> : <IconBell size={18} />}
        </IconButton>
      </header>

      <NoticeOptIn onToast={onToast} />

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4">
        {nothingToShow && (
          <EmptyState
            title="No sessions yet"
            hint="Start an agent in one of your projects — it keeps running even when your phone disconnects."
          />
        )}
        {alive.map((s) => row(s, 'a'))}
        {ended.length > 0 && (
          <GroupHeader arrive={arrive} id={ENDED_HEADER_KEY}>
            Ended
          </GroupHeader>
        )}
        {ended.map((s) => row(s, 'e'))}

        {fromDesktop.length > 0 && (
          <MacGroupHeader
            arrive={arrive}
            count={fromDesktop.length}
            open={macOpen}
            onToggle={toggleDesktop}
          />
        )}
        {macOpen && fromDesktop.map((s) => row(s, 'm'))}
        {macOpen && hiddenCount > 0 && (
          <button
            onClick={unhide}
            className="w-full px-3 py-2 text-left text-xs text-faint transition-colors hover:text-mut"
          >
            {hiddenCount} hidden · show {hiddenCount === 1 ? 'it' : 'them'} again
          </button>
        )}
      </div>

      <div className="shrink-0 border-t border-line-subtle bg-surface px-4 py-2.5">
        <Button onClick={onNew} className="h-11 w-full">
          <IconPlus size={18} />
          New session
        </Button>
      </div>

      {phoneOpen && (
        <UnpairSheet
          tokenIsTheKey={tokenIsTheKey}
          unpairing={unpairing}
          onUnpair={unpair}
          onStopNotifications={stopNotifications}
          onClose={() => setPhoneOpen(false)}
        />
      )}
    </div>
  )
}
