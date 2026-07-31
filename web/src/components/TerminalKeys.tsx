import { createContext, useContext, useRef, useState } from 'react'
import { IconButton } from './ui'

interface Props {
  keyboardOpen: boolean
  onSend: (data: string) => void
  onFocus: () => void
  onBlur: () => void
}

type KeyDef = { label: string; data: string; shiftData?: string; repeat?: boolean }

const KEYS: KeyDef[] = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t', shiftData: '\x1b[Z' },
  { label: '⌫', data: '\x7f', repeat: true },
  { label: '←', data: '\x1b[D', shiftData: '\x1b[1;2D', repeat: true },
  { label: '↑', data: '\x1b[A', shiftData: '\x1b[1;2A', repeat: true },
  { label: '↓', data: '\x1b[B', shiftData: '\x1b[1;2B', repeat: true },
  { label: '→', data: '\x1b[C', shiftData: '\x1b[1;2C', repeat: true },
  { label: '⏎', data: '\r' },
  { label: '^C', data: '\x03' },
]

const BarGestureContext = createContext<React.MutableRefObject<boolean> | null>(null)

const TAP_SLOP_PX = 10
const HOLD_MS = 400
const REPEAT_MS = 80

const keyClass = (active?: boolean) =>
  `shrink-0 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors active:bg-overlay ${
    active ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line bg-raised text-fore'
  }`

function Key({
  label,
  active,
  onPress,
  repeat = false,
}: {
  label: string
  active?: boolean
  onPress: () => void
  repeat?: boolean
}) {
  const barScrolling = useContext(BarGestureContext)
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

  const blocked = () => moved.current || !!barScrolling?.current

  const tap = () => {
    if (blocked()) return
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
        if (!blocked()) onPress()
        repeatTimer.current = setInterval(() => {
          if (!blocked()) onPress()
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
      className={keyClass(active)}
    >
      {label}
    </button>
  )
}

export default function TerminalKeys({ keyboardOpen, onSend, onFocus, onBlur }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [shift, setShift] = useState(false)
  const barScrolling = useRef(false)
  const scrollLeftAtTouch = useRef(0)

  const toggleKeyboard = () => {
    if (keyboardOpen) onBlur()
    else onFocus()
  }

  const sendKey = (key: KeyDef) => {
    onSend(shift && key.shiftData ? key.shiftData : key.data)
  }

  return (
    <div className="shrink-0 touch-manipulation">
      {expanded ? (
        <BarGestureContext.Provider value={barScrolling}>
          <div className="border-t border-line-subtle bg-surface">
            <div
              className="flex touch-pan-x items-center gap-1 overflow-x-auto px-1.5 py-1 [-webkit-overflow-scrolling:touch]"
              onTouchStart={(e) => {
                barScrolling.current = false
                scrollLeftAtTouch.current = e.currentTarget.scrollLeft
              }}
              onScroll={(e) => {
                if (Math.abs(e.currentTarget.scrollLeft - scrollLeftAtTouch.current) > 2) {
                  barScrolling.current = true
                }
              }}
              onTouchEnd={() => {
                requestAnimationFrame(() => {
                  barScrolling.current = false
                })
              }}
            >
              <button
                type="button"
                aria-label="Hide keys"
                onClick={() => setExpanded(false)}
                className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-faint active:text-fore"
              >
                ˅
              </button>
              <IconButton
                label={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'}
                size="sm"
                onTouchEnd={(e) => {
                  e.preventDefault()
                  toggleKeyboard()
                }}
                onClick={toggleKeyboard}
                className={keyboardOpen ? 'bg-accent/15 text-accent' : ''}
              >
                <KeyboardIcon size={16} />
              </IconButton>
              <Key label="⇧" active={shift} onPress={() => setShift((s) => !s)} />
              {KEYS.map((key) => (
                <Key
                  key={key.label}
                  label={key.label}
                  repeat={key.repeat}
                  onPress={() => sendKey(key)}
                />
              ))}
            </div>
          </div>
        </BarGestureContext.Provider>
      ) : (
        <div className="flex h-8 items-center gap-1 border-t border-line-subtle bg-surface px-1.5">
          <IconButton
            label={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'}
            size="sm"
            onTouchEnd={(e) => {
              e.preventDefault()
              toggleKeyboard()
            }}
            onClick={toggleKeyboard}
            className={keyboardOpen ? 'bg-accent/15 text-accent' : ''}
          >
            <KeyboardIcon size={16} />
          </IconButton>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="rounded-md border border-line bg-raised px-2.5 py-0.5 font-mono text-[11px] text-mut active:bg-overlay"
          >
            Keys
          </button>
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
