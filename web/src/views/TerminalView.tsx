import type { ReactNode } from 'react'
import type { ConnectionStatus } from '../Terminal'
import type { SessionInfo } from '../api'
import {
  Button,
  IconButton,
  IconPlus,
  IconRestart,
  OrbitMark,
  PROVIDER_GLYPH,
  basename,
  sessionLabel,
} from '../components/ui'

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Reconnecting…',
  ended: 'Ended',
}

interface Props {
  session: SessionInfo | null
  status: ConnectionStatus
  /** Start a fresh session with the same agent + folder as this ended one. */
  onNewSession: () => void
  /** Same, but asking the agent to carry on its last conversation there. */
  onResume: () => void
  starting: boolean
  /** The terminal element — owned by the parent so it survives tab switches. */
  children: ReactNode
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
  const statusColor = {
    connected: 'text-ok',
    connecting: 'text-live',
    disconnected: 'text-danger',
    ended: 'text-faint',
  }[status]

  return (
    <div className="flex h-full flex-col">
      {/* Which session am I in — and nothing else. What goes *into* the session
          belongs to the key bar at the bottom, where the thumb already is.

          Opaque and above the terminal: xterm's screen is a positioned element,
          so anything it draws past its box would otherwise land on top of this. */}
      <header className="relative z-10 flex shrink-0 items-center gap-3 bg-ink px-4 py-2.5 shadow-[0_1px_0_var(--edge-lit)]">
        <OrbitMark size={26} idle={status !== 'connected'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {session && (
              <span className="font-mono text-[13px] text-accent">
                {PROVIDER_GLYPH[session.providerId] ?? '❯'}
              </span>
            )}
            <span
              className={`truncate text-sm ${
                session && !session.name && session.firstCommand
                  ? 'font-mono text-[13px]'
                  : 'font-display font-semibold tracking-wide'
              }`}
            >
              {session ? sessionLabel(session) : 'Orbit'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-faint">
            {session && (
              <>
                <span className="truncate font-mono">{basename(session.cwd)}</span>
                <span>·</span>
              </>
            )}
            <span className={statusColor}>{STATUS_LABEL[status]}</span>
            {ended && (
              <>
                <span>·</span>
                <span>read-only</span>
              </>
            )}
          </div>
        </div>
        {/* An ended session has no PTY — voice and image would write into nothing. */}
        {ended ? (
          /* Resume carries the agent's own conversation over; New does not.
             Both spelled out would leave the session's own name no room, so
             when there are two, the fresh start keeps just its glyph. */
          <div className="flex shrink-0 items-center gap-1">
            {session.resumable ? (
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
        ) : null}
      </header>
      <div className="min-h-0 flex-1 p-1.5">{children}</div>
    </div>
  )
}
