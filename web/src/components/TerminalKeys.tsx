import { useRef, useState } from 'react'
import { IconButton, IconEdit } from './ui'

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
  /* Writing a whole message, as against sending a key. It sits in this bar
     rather than the header because everything else a thumb reaches for
     mid-conversation is already down here, and the header is across the screen
     from it. Dictation is not here: it fills the same draft, so it belongs
     inside the sheet that shows the draft. */
  onCompose: () => void
  /** Something written and not yet sent, so the pen can say so. */
  draftPending: boolean
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
  /** A drawn symbol rather than a word — it needs the extra points to read. */
  glyph?: boolean
}

/*
 * Two fixed rows rather than one scrolling strip: at a 44px touch target only
 * five keys fit across a phone, so a single row hides the rest behind a swipe.
 *
 * Both rows are always up. They used to fold behind a Keys toggle, and folding
 * them is a resize: the agent is told a new height, answers with one frame, and
 * if it was mid-draw when the fold came that frame is the half-written one that
 * stays on screen — the composer gone until something else moves. Three rounds
 * of chasing that from the client did not close it, and the bar is 50pt against
 * a screen that is otherwise all terminal. So the height never changes, and the
 * bug has nothing to stand on.
 *
 * The bottom row holds what the thumb reaches for; everything else lives in the
 * row above, except the arrows, which hold the inverted-T of a real keyboard on
 * the right: ↑ over ← ↓ →, because that shape is read by muscle memory rather
 * than by looking. The T only needs one bare corner to read, so the other one
 * pays for the / key — see SLASH.
 */
const ROW_UPPER: KeyDef[] = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t', shiftData: '\x1b[Z' },
  { label: '^C', data: '\x03' },
]

const ROW_LOWER: KeyDef[] = [
  { label: '⏎', data: '\r', glyph: true },
  { label: '⌫', data: '\x7f', ctrlData: '\x17', repeat: true, glyph: true }, // ctrl → delete word
]

/*
 * The one character worth a key of its own: every skill starts with it, and iOS
 * buries / a layer deep behind the 123 switch. Shift makes it ?, the way it does
 * on the keyboard it is standing in for.
 */
const SLASH: KeyDef = { label: '/', data: '/', shiftData: '?', glyph: true }

const arrow = (label: string, final: string): KeyDef => ({
  label,
  data: `\x1b[${final}`,
  shiftData: `\x1b[1;2${final}`,
  ctrlData: `\x1b[1;5${final}`,
  repeat: true,
  glyph: true,
})

const ARROWS = {
  up: arrow('↑', 'A'),
  left: arrow('←', 'D'),
  down: arrow('↓', 'B'),
  right: arrow('→', 'C'),
}

/* 40px, not 44: three arrows plus a five-key row have to clear 375px of phone,
   and the full height keeps each of them a comfortable target anyway. */
const ARROW_W = 'w-10'
const FLEX_KEY = 'min-w-10 flex-1'
const GLYPH_TEXT = 'text-[15px]'

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
  text = 'text-[13px]',
}: {
  label: string
  /** Present only on modifier keys — drives styling and the pressed state. */
  mod?: ModState
  onPress: () => void
  repeat?: boolean
  className?: string
  /** Kept a prop rather than a caller override: two font sizes on one element
      resolve by stylesheet order, which is not something to bet a glyph on. */
  text?: string
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
      /* Width comes from the caller: the rows share it out, the arrow cluster
         pins it. Height alone carries the 44px touch target. */
      className={`h-11 rounded-lg border font-mono ${text} transition-colors active:bg-overlay ${MOD_STYLE[mod ?? 'off']} ${className}`}
    >
      {label}
    </button>
  )
}

export default function TerminalKeys({
  keyboardOpen,
  onCompose,
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

  /* Two permanent slots, because they answer two different questions. The pen
     is how a whole message gets written; the keyboard is how the prompt gets
     typed at directly. Tapping the terminal raises the keyboard too, but that
     is an unmarked gesture, and it is no help at all in the other direction —
     nothing else on screen blurs the textarea. A toggle says both halves out
     loud in one slot, and the row has the width for it: the fixed keys in this
     row come to 44 + 44 + 40 + 40 with the arrow cluster at 128, which clears
     a 375pt screen with room over. */
  const toggleKeyboard = () => {
    if (keyboardOpen) onBlur()
    else onFocus()
  }

  const keyboardButton = (
    <IconButton
      label={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'}
      size="lg"
      className={keyboardOpen ? 'bg-accent/15 text-accent' : ''}
      /* Touch first, and swallowed: a tap that reaches the document as a click
         has already moved focus off the textarea, which closes the keyboard
         before the toggle can decide to open it. */
      onTouchEnd={(e) => {
        e.preventDefault()
        toggleKeyboard()
      }}
      onClick={toggleKeyboard}
    >
      <KeyboardIcon size={20} />
    </IconButton>
  )

  const writeButton = (
    <IconButton
      label={draftPending ? 'Message (unsent draft)' : 'Write a message'}
      size="lg"
      className={draftPending ? 'text-accent' : ''}
      onClick={onCompose}
    >
      <IconEdit size={19} />
    </IconButton>
  )

  return (
    // z-10: the terminal's screen is positioned, so it paints over a static bar.
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
            {/* Top of the inverted-T: ↑ centred over ↓, its left corner bare so the
                shape still reads; / takes the right corner, out at the edge where
                a thumb reaching for ↑ does not pass through it. */}
          <div className="flex shrink-0 items-center gap-1">
            <span className={ARROW_W} aria-hidden />
            {arrowOf(ARROWS.up)}
            {keyOf(SLASH, ARROW_W)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-1">
            {writeButton}
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
