import { useEffect, useRef } from 'react'

interface Props {
  onPageUp: () => void
  onPageDown: () => void
}

const HOLD_MS = 350
const REPEAT_MS = 90
const FAST_REPEAT_MS = 35
const FAST_AFTER_MS = 700

const clearSelection = () => {
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed) sel.removeAllRanges()
}

function ScrollButton({
  label,
  ariaLabel,
  onPress,
}: {
  label: string
  ariaLabel: string
  onPress: () => void
}) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const fastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatStarted = useRef(false)
  const onPressRef = useRef(onPress)
  onPressRef.current = onPress

  const cancel = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current)
    if (repeatTimer.current) clearInterval(repeatTimer.current)
    if (fastTimer.current) clearTimeout(fastTimer.current)
    holdTimer.current = null
    repeatTimer.current = null
    fastTimer.current = null
  }

  const fire = () => {
    clearSelection()
    onPressRef.current()
  }

  const startRepeat = () => {
    repeatStarted.current = true
    fire()
    repeatTimer.current = setInterval(fire, REPEAT_MS)
    fastTimer.current = setTimeout(() => {
      if (!repeatTimer.current) return
      clearInterval(repeatTimer.current)
      repeatTimer.current = setInterval(fire, FAST_REPEAT_MS)
    }, FAST_AFTER_MS)
  }

  const onDown = () => {
    clearSelection()
    repeatStarted.current = false
    cancel()
    holdTimer.current = setTimeout(startRepeat, HOLD_MS)
  }

  const onUp = () => {
    cancel()
    clearSelection()
    if (!repeatStarted.current) fire()
  }

  useEffect(() => {
    const el = btnRef.current
    if (!el) return

    const block = (e: Event) => e.preventDefault()

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault()
      onDown()
    }
    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault()
      onUp()
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', block, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: false })
    el.addEventListener('touchcancel', onUp)
    el.addEventListener('contextmenu', block)

    return () => {
      cancel()
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', block)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onUp)
      el.removeEventListener('contextmenu', block)
    }
  }, [])

  return (
    <button
      ref={btnRef}
      type="button"
      aria-label={ariaLabel}
      onPointerDown={(e) => {
        e.preventDefault()
        if (e.pointerType === 'touch') return
        onDown()
      }}
      onPointerUp={(e) => {
        if (e.pointerType === 'touch') return
        e.preventDefault()
        onUp()
      }}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      className="flex h-9 w-9 touch-manipulation select-none items-center justify-center rounded-lg border border-line/80 bg-surface/90 font-mono text-sm text-mut shadow-sm backdrop-blur-sm [-webkit-touch-callout:none] active:bg-overlay active:text-fore"
    >
      {label}
    </button>
  )
}

export default function TerminalScrollPads({ onPageUp, onPageDown }: Props) {
  return (
    <div className="pointer-events-none absolute inset-y-0 right-1.5 z-10 flex flex-col items-center justify-center gap-1.5 select-none">
      <div className="pointer-events-auto flex flex-col gap-1.5">
        <ScrollButton label="▲" ariaLabel="Page up" onPress={onPageUp} />
        <ScrollButton label="▼" ariaLabel="Page down" onPress={onPageDown} />
      </div>
    </div>
  )
}
