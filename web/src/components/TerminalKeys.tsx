import { useEffect, useRef, useState } from 'react'
import { IconButton, IconChevronDown } from './ui'

/**
 * Modifier state. `once` fires for the next key then clears (the common case);
 * tapping again promotes it to `lock`, which stays until tapped off — the same
 * tap / tap-again cycle iOS uses for shift.
 */
export type ModState = 'off' | 'once' | 'lock'

export const cycleMod = (m: ModState): ModState =>
  m === 'off' ? 'once' : m === 'once' ? 'lock' : 'off'

interface Props {
  keyboardOpen: boolean
  /** Ctrl lives in the parent: it also rewrites what the soft keyboard types. */
  ctrl: ModState
  onCtrlChange: (next: ModState) => void
  onSend: (data: string) => void
  onFocus: () => void
  onBlur: () => void
}

type KeyDef = {
  label: string
  data: string
  shiftData?: string
  ctrlData?: string
  repeat?: boolean
}

/*
 * Two fixed rows rather than one scrolling strip: at a 44px touch target only
 * five keys fit across a phone, so a single row hides the rest behind a swipe
 * and splits ↑ from ↓. The top row carries the keys reached mid-thought (cancel,
 * submit) next to the modifiers; the bottom row keeps the arrow pairs together.
 */
const ROW_TOP: KeyDef[] = [
  { label: 'Esc', data: '\x1b' },
  { label: '⏎', data: '\r' },
]

const ROW_BOTTOM: KeyDef[] = [
  { label: '↑', data: '\x1b[A', shiftData: '\x1b[1;2A', ctrlData: '\x1b[1;5A', repeat: true },
  { label: '↓', data: '\x1b[B', shiftData: '\x1b[1;2B', ctrlData: '\x1b[1;5B', repeat: true },
  { label: 'Tab', data: '\t', shiftData: '\x1b[Z' },
  { label: '^C', data: '\x03' },
  { label: '⌫', data: '\x7f', ctrlData: '\x17', repeat: true }, // ctrl → delete word
  { label: '←', data: '\x1b[D', shiftData: '\x1b[1;2D', ctrlData: '\x1b[1;5D', repeat: true },
  { label: '→', data: '\x1b[C', shiftData: '\x1b[1;2C', ctrlData: '\x1b[1;5C', repeat: true },
]

const EXPANDED_KEY = 'orbit.keysExpanded'
const TAP_SLOP_PX = 10
const HOLD_MS = 400
const REPEAT_MS = 80

const MOD_STYLE: Record<ModState, string> = {
  off: 'border-line bg-raised text-fore',
  once: 'border-accent/50 bg-accent/15 text-accent',
  lock: 'border-accent bg-accent-strong text-white',
}

function Key({
  label,
  mod,
  onPress,
  repeat = false,
  className = '',
}: {
  label: string
  /** Present only on modifier keys — drives styling and the pressed state. */
  mod?: ModState
  onPress: () => void
  repeat?: boolean
  className?: string
}) {
  const start = useRef({ x: 0, y: 0 })
  const moved = useRef(false)
  const repeatStarted = useRef(false)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const cancelTimers = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current)
    if (repeatTimer.current) clearInterval(repeatTimer.current)
    holdTimer.current = null
    repeatTimer.current = null
  }

  const tap = () => {
    if (moved.current) return
    onPress()
  }

  const onDown = (x: number, y: number) => {
    start.current = { x, y }
    moved.current = false
    repeatStarted.current = false
    cancelTimers()
    if (repeat) {
      holdTimer.current = setTimeout(() => {
        repeatStarted.current = true
        if (!moved.current) onPress()
        repeatTimer.current = setInterval(() => {
          if (!moved.current) onPress()
        }, REPEAT_MS)
      }, HOLD_MS)
    }
  }

  const onMove = (x: number, y: number) => {
    if (
      Math.abs(x - start.current.x) > TAP_SLOP_PX ||
      Math.abs(y - start.current.y) > TAP_SLOP_PX
    ) {
      moved.current = true
      cancelTimers()
    }
  }

  const onUp = () => {
    cancelTimers()
    if (!repeatStarted.current) tap()
  }

  return (
    <button
      type="button"
      aria-pressed={mod === undefined ? undefined : mod !== 'off'}
      aria-label={mod === 'lock' ? `${label} (locked)` : label}
      onTouchStart={(e) => {
        const t = e.changedTouches[0]
        if (t) onDown(t.clientX, t.clientY)
      }}
      onTouchMove={(e) => {
        const t = e.changedTouches[0]
        if (t) onMove(t.clientX, t.clientY)
      }}
      onTouchEnd={(e) => {
        e.preventDefault()
        onUp()
      }}
      onPointerDown={(e) => {
        if (e.pointerType === 'touch') return
        onDown(e.clientX, e.clientY)
      }}
      onPointerMove={(e) => {
        if (e.pointerType === 'touch') return
        onMove(e.clientX, e.clientY)
      }}
      onPointerUp={(e) => {
        if (e.pointerType === 'touch') return
        e.preventDefault()
        onUp()
      }}
      onPointerCancel={() => {
        moved.current = true
        cancelTimers()
      }}
      onPointerLeave={() => cancelTimers()}
      onContextMenu={(e) => e.preventDefault()}
      className={`h-11 min-w-11 rounded-lg border font-mono text-[13px] transition-colors active:bg-overlay ${MOD_STYLE[mod ?? 'off']} ${className}`}
    >
      {label}
    </button>
  )
}

export default function TerminalKeys({
  keyboardOpen,
  ctrl,
  onCtrlChange,
  onSend,
  onFocus,
  onBlur,
}: Props) {
  const [expanded, setExpanded] = useState(() => localStorage.getItem(EXPANDED_KEY) === '1')
  const [shift, setShift] = useState<ModState>('off')

  useEffect(() => {
    localStorage.setItem(EXPANDED_KEY, expanded ? '1' : '0')
  }, [expanded])

  const toggleKeyboard = () => {
    if (keyboardOpen) onBlur()
    else onFocus()
  }

  const pressCtrl = () => {
    const next = cycleMod(ctrl)
    onCtrlChange(next)
    // Ctrl is aimed at a letter that has to come from the soft keyboard.
    if (next !== 'off' && !keyboardOpen) onFocus()
  }

  const sendKey = (key: KeyDef) => {
    if (ctrl !== 'off' && key.ctrlData) {
      onSend(key.ctrlData)
      if (ctrl === 'once') onCtrlChange('off')
      if (shift === 'once') setShift('off')
      return
    }
    onSend(shift !== 'off' && key.shiftData ? key.shiftData : key.data)
    if (shift === 'once') setShift('off')
  }

  const keyOf = (key: KeyDef) => (
    <Key
      key={key.label}
      label={key.label}
      repeat={key.repeat}
      className="flex-1"
      onPress={() => sendKey(key)}
    />
  )

  const keyboardButton = (
    <IconButton
      label={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'}
      size="lg"
      className={keyboardOpen ? 'bg-accent/15 text-accent' : ''}
      onTouchEnd={(e) => {
        e.preventDefault()
        toggleKeyboard()
      }}
      onClick={toggleKeyboard}
    >
      <KeyboardIcon size={20} />
    </IconButton>
  )

  return (
    <div className="shrink-0 touch-manipulation">
      {expanded ? (
        <div className="flex flex-col gap-1 border-t border-line-subtle bg-surface px-1.5 py-1">
          <div className="flex items-center gap-1">
            {keyboardButton}
            <Key label="⇧" mod={shift} className="flex-1" onPress={() => setShift(cycleMod)} />
            <Key label="Ctrl" mod={ctrl} className="flex-1" onPress={pressCtrl} />
            {ROW_TOP.map(keyOf)}
            <IconButton label="Hide keys" size="lg" onClick={() => setExpanded(false)}>
              <IconChevronDown size={20} />
            </IconButton>
          </div>
          <div className="flex items-center gap-1">{ROW_BOTTOM.map(keyOf)}</div>
        </div>
      ) : (
        <div className="flex items-center gap-1 border-t border-line-subtle bg-surface px-1.5 py-1">
          {keyboardButton}
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="h-11 rounded-lg border border-line bg-raised px-3.5 font-mono text-[13px] text-mut active:bg-overlay"
          >
            Keys
          </button>
          {ctrl !== 'off' && (
            <span className="rounded-md border border-accent/50 bg-accent/15 px-2 py-1 font-mono text-[11px] text-accent">
              Ctrl{ctrl === 'lock' ? ' ⇩' : ''}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function KeyboardIcon({ size = 19 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </svg>
  )
}
