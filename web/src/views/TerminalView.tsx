import type { ReactNode } from 'react'
import type { ConnectionStatus } from '../Terminal'
import type { SessionInfo } from '../api'
import {
  Button,
  IconButton,
  IconImage,
  IconMic,
  IconRestart,
  OrbitMark,
  PROVIDER_GLYPH,
  basename,
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
  voiceAvailable: boolean
  onOpenVoice: () => void
  onPickImage: () => void
  /** Start a fresh session with the same agent + folder as this ended one. */
  onRelaunch: () => void
  relaunching: boolean
  /** The terminal element — owned by the parent so it survives tab switches. */
  children: ReactNode
}

export default function TerminalView({
  session,
  status,
  voiceAvailable,
  onOpenVoice,
  onPickImage,
  onRelaunch,
  relaunching,
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
      <header className="flex shrink-0 items-center gap-3 border-b border-line-subtle px-4 py-2.5">
        <OrbitMark size={26} idle={status !== 'connected'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {session && (
              <span className="font-mono text-[13px] text-accent">
                {PROVIDER_GLYPH[session.providerId] ?? '❯'}
              </span>
            )}
            <span className="truncate font-display text-sm font-semibold tracking-wide">
              {session ? (session.name ?? session.providerName) : 'Orbit'}
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
          <Button
            variant="outline"
            disabled={relaunching}
            onClick={onRelaunch}
            className="shrink-0 gap-1.5 px-3 py-1.5 text-[13px]"
          >
            <IconRestart size={15} />
            {relaunching ? 'Relaunching…' : 'Relaunch'}
          </Button>
        ) : (
          <>
            {voiceAvailable && (
              <IconButton label="Voice input" onClick={onOpenVoice}>
                <IconMic size={19} />
              </IconButton>
            )}
            <IconButton label="Upload image into terminal" onClick={onPickImage}>
              <IconImage size={19} />
            </IconButton>
          </>
        )}
      </header>
      <div className="min-h-0 flex-1 p-1.5">{children}</div>
    </div>
  )
}
