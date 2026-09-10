import type { ReactNode } from 'react'
import type { ConnectionStatus } from '../Terminal'
import type { SessionInfo } from '../api'
import {
  Button,
  IconButton,
  IconPlus,
  IconRestart,
  OrbitMark,
  ProviderGlyph,
  basename,
  sessionLabel,
} from '../components/ui'

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Reconnecting…',
  ended: 'Ended',
}

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  connected: 'text-ok',
  connecting: 'text-live',
  disconnected: 'text-danger',
  ended: 'text-faint',
}


interface Props {
  session: SessionInfo | null
  status: ConnectionStatus
  onNewSession: () => void
  onResume: () => void
  starting: boolean
  children: ReactNode
}

function SessionTitle({ session }: { session: SessionInfo | null }) {
  const showsFirstCommand = !!session && !session.name && !!session.firstCommand
  return (
    <div className="flex items-center gap-2">
      {session && (
        <span className="flex text-accent">
          <ProviderGlyph providerId={session.providerId} size={15} />
        </span>
      )}
      <span
        className={`truncate text-sm ${
          showsFirstCommand ? 'font-mono text-[13px]' : 'font-display font-semibold tracking-wide'
        }`}
      >
        {session ? sessionLabel(session) : 'Orbit'}
      </span>
    </div>
  )
}

function SessionSubtitle({
  session,
  status,
}: {
  session: SessionInfo | null
  status: ConnectionStatus
}) {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-faint">
      {session && (
        <>
          <span className="truncate font-mono">{basename(session.cwd)}</span>
          <span className="shrink-0">·</span>
        </>
      )}
      <span className={`shrink-0 ${STATUS_COLOR[status]}`}>{STATUS_LABEL[status]}</span>
    </div>
  )
}

function EndedSessionActions({
  resumable,
  starting,
  onNewSession,
  onResume,
}: {
  resumable: boolean
  starting: boolean
  onNewSession: () => void
  onResume: () => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {resumable ? (
        <>
          <Button
            variant="outline"
            disabled={starting}
            onClick={onResume}
            className="shrink-0 gap-1.5 px-3 py-1.5 text-[13px]"
          >
            <IconRestart size={15} />
            {starting ? 'Starting…' : 'Resume'}
          </Button>
          <IconButton
            label="New session (same agent + folder, no history)"
            size="lg"
            disabled={starting}
            onClick={onNewSession}
            className="border border-line"
          >
            <IconPlus size={17} />
          </IconButton>
        </>
      ) : (
        <Button
          variant="outline"
          disabled={starting}
          onClick={onNewSession}
          className="shrink-0 gap-1.5 px-3 py-1.5 text-[13px]"
        >
          <IconPlus size={15} />
          {starting ? 'Starting…' : 'New'}
        </Button>
      )}
    </div>
  )
}

export default function TerminalView({
  session,
  status,
  onNewSession,
  onResume,
  starting,
  children,
}: Props) {
  const ended = !!session && !session.alive

  return (
    <div className="flex h-full flex-col">
      <header className="relative z-10 flex shrink-0 items-center gap-3 bg-ink px-4 py-2.5 shadow-[0_1px_0_var(--edge-lit)]">
        <OrbitMark size={26} idle={status !== 'connected'} />
        <div className="min-w-0 flex-1">
          <SessionTitle session={session} />
          <SessionSubtitle session={session} status={status} />
        </div>
        {ended ? (
          <EndedSessionActions
            resumable={!!session.resumable}
            starting={starting}
            onNewSession={onNewSession}
            onResume={onResume}
          />
        ) : null}
      </header>
      <div className="min-h-0 flex-1 p-1.5">{children}</div>
    </div>
  )
}
