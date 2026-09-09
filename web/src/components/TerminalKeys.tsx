import { useRef, useState, type TouchEvent } from 'react'
import { IconButton, IconEdit, IconMic } from './ui'

export type ModState = 'off' | 'once' | 'lock'

export const cycleMod = (m: ModState): ModState =>
  m === 'off' ? 'once' : m === 'once' ? 'lock' : 'off'

interface Props {
  keyboardOpen: boolean
  onCompose: () => void
  onVoice: () => void
  voiceAvailable: boolean
  draftPending: boolean
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
  glyph?: boolean
}

const ESC = '\x1b'
const TAB = '\t'
const SHIFT_TAB = '\x1b[Z'
const CTRL_C = '\x03'
const CARRIAGE_RETURN = '\r'
const BACKSPACE = '\x7f'
const DELETE_WORD = '\x17'

const ROW_UPPER: KeyDef[] = [
  { label: 'Esc', data: ESC },
  { label: 'Tab', data: TAB, shiftData: SHIFT_TAB },
  { label: '^C', data: CTRL_C },
]

const ROW_LOWER: KeyDef[] = [
  { label: '⏎', data: CARRIAGE_RETURN, glyph: true },
  { label: '⌫', data: BACKSPACE, ctrlData: DELETE_WORD, repeat: true, glyph: true },
]

const SLASH: KeyDef = { label: '/', data: '/', shiftData: '?', glyph: true }

const arrow = (label: string, csiFinal: string): KeyDef => ({
  label,
  data: `\x1b[${csiFinal}`,
  shiftData: `\x1b[1;2${csiFinal}`,
  ctrlData: `\x1b[1;5${csiFinal}`,
  repeat: true,
  glyph: true,
})

const ARROWS = {
  up: arrow('↑', 'A'),
  left: arrow('←', 'D'),
  down: arrow('↓', 'B'),
  right: arrow('→', 'C'),
}

const ARROW_W = 'w-10'
const FLEX_KEY = 'min-w-10 flex-1'
const GLYPH_TEXT = 'text-[15px]'

const TAP_SLOP_PX = 10
const HOLD_BEFORE_REPEAT_MS = 400
const REPEAT_EVERY_MS = 80

const MOD_STYLE: Record<ModState, string> = {
  off: 'border-line bg-raised text-fore',
  once: 'border-accent/50 bg-accent/15 text-accent',
  lock: 'border-accent bg-accent-strong text-white',
}

function useTapOrHold(onPress: () => void, repeat: boolean) {
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

  const pressUnlessMoved = () => {
    if (!moved.current) onPress()
  }

  const beginRepeatAfterHold = () => {
    holdTimer.current = setTimeout(() => {
      repeatStarted.current = true
      pressUnlessMoved()
      repeatTimer.current = setInterval(pressUnlessMoved, REPEAT_EVERY_MS)
    }, HOLD_BEFORE_REPEAT_MS)
  }

  const down = (x: number, y: number) => {
    start.current = { x, y }
    moved.current = false
    repeatStarted.current = false
    cancelTimers()
    if (repeat) beginRepeatAfterHold()
  }

  const move = (x: number, y: number) => {
    const slipped =
      Math.abs(x - start.current.x) > TAP_SLOP_PX || Math.abs(y - start.current.y) > TAP_SLOP_PX
    if (slipped) {
      moved.current = true
      cancelTimers()
    }
  }

  const up = () => {
    cancelTimers()
    if (!repeatStarted.current) pressUnlessMoved()
  }

  const cancel = () => {
    moved.current = true
    cancelTimers()
  }

  return { down, move, up, cancel, cancelTimers }
}

function Key({
  label,
  mod,
  onPress,
  repeat = false,
  className = '',
  text = 'text-[13px]',
}: {
  label: string
  mod?: ModState
  onPress: () => void
  repeat?: boolean
  className?: string
  text?: string
}) {
  const gesture = useTapOrHold(onPress, repeat)

  return (
    <button
      type="button"
      aria-pressed={mod === undefined ? undefined : mod !== 'off'}
      aria-label={mod === 'lock' ? `${label} (locked)` : label}
      onTouchStart={(e) => {
        const touch = e.changedTouches[0]
        if (touch) gesture.down(touch.clientX, touch.clientY)
      }}
      onTouchMove={(e) => {
        const touch = e.changedTouches[0]
        if (touch) gesture.move(touch.clientX, touch.clientY)
      }}
      onTouchEnd={(e) => {
        e.preventDefault()
        gesture.up()
      }}
      onPointerDown={(e) => {
        if (e.pointerType === 'touch') return
        gesture.down(e.clientX, e.clientY)
      }}
      onPointerMove={(e) => {
        if (e.pointerType === 'touch') return
        gesture.move(e.clientX, e.clientY)
      }}
      onPointerUp={(e) => {
        if (e.pointerType === 'touch') return
        e.preventDefault()
        gesture.up()
      }}
      onPointerCancel={gesture.cancel}
      onPointerLeave={gesture.cancelTimers}
      onContextMenu={(e) => e.preventDefault()}
      className={`h-11 rounded-lg border font-mono ${text} transition-colors active:bg-overlay ${MOD_STYLE[mod ?? 'off']} ${className}`}
    >
      {label}
    </button>
  )
}

export default function TerminalKeys({
  keyboardOpen,
  onCompose,
  onVoice,
  voiceAvailable,
  draftPending,
  ctrl,
  onCtrlChange,
  onSend,
  onFocus,
  onBlur,
}: Props) {
  const [shift, setShift] = useState<ModState>('off')

  const pressCtrl = () => {
    const next = cycleMod(ctrl)
    onCtrlChange(next)
    const ctrlNeedsALetterFromTheSoftKeyboard = next !== 'off' && !keyboardOpen
    if (ctrlNeedsALetterFromTheSoftKeyboard) onFocus()
  }

  const releaseOnceModifiers = () => {
    if (shift === 'once') setShift('off')
  }

  const sendKey = (key: KeyDef) => {
    if (ctrl !== 'off' && key.ctrlData) {
      onSend(key.ctrlData)
      if (ctrl === 'once') onCtrlChange('off')
      releaseOnceModifiers()
      return
    }
    onSend(shift !== 'off' && key.shiftData ? key.shiftData : key.data)
    releaseOnceModifiers()
  }

  const keyOf = (key: KeyDef, className = FLEX_KEY) => (
    <Key
      key={key.label}
      label={key.label}
      repeat={key.repeat}
      className={className}
      text={key.glyph ? GLYPH_TEXT : undefined}
      onPress={() => sendKey(key)}
    />
  )

  const arrowOf = (key: KeyDef) => keyOf(key, ARROW_W)

  const toggleKeyboard = () => {
    if (keyboardOpen) onBlur()
    else onFocus()
  }

  const writeButton = (
    <IconButton
      label={draftPending ? 'Message (unsent draft)' : 'Write a message'}
      className={draftPending ? 'text-accent' : ''}
      onClick={onCompose}
    >
      <IconEdit size={19} />
    </IconButton>
  )

  const voiceButton = voiceAvailable && (
    <IconButton label="Dictate a message" onClick={onVoice}>
      <IconMic size={19} />
    </IconButton>
  )

  const toggleKeyboardOnTouchBeforeBlur = (e: TouchEvent) => {
    e.preventDefault()
    toggleKeyboard()
  }

  const keyboardButton = (
    <IconButton
      label={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'}
      className={keyboardOpen ? 'bg-accent/15 text-accent' : ''}
      onTouchEnd={toggleKeyboardOnTouchBeforeBlur}
      onClick={toggleKeyboard}
    >
      <KeyboardIcon size={20} />
    </IconButton>
  )

  return (
    <div className="relative z-10 shrink-0 touch-manipulation">
      <div className="flex flex-col gap-1 border-t border-line-subtle bg-surface px-1.5 py-1">
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-1">
            <Key
              label="⇧"
              mod={shift}
              className={FLEX_KEY}
              text={GLYPH_TEXT}
              onPress={() => setShift(cycleMod)}
            />
            <Key label="Ctrl" mod={ctrl} className={FLEX_KEY} onPress={pressCtrl} />
            {ROW_UPPER.map((key) => keyOf(key))}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className={ARROW_W} aria-hidden />
            {arrowOf(ARROWS.up)}
            {keyOf(SLASH, ARROW_W)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-1">
            {writeButton}
            {voiceButton}
            {keyboardButton}
            {ROW_LOWER.map((key) => keyOf(key))}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {arrowOf(ARROWS.left)}
            {arrowOf(ARROWS.down)}
            {arrowOf(ARROWS.right)}
          </div>
        </div>
      </div>
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
