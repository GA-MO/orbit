import { useEffect, useRef } from 'react'
import { IconButton, IconImage, IconMic, IconSend } from './ui'

interface Props {
  /** The draft lives in the parent: voice and the image picker write into it too. */
  value: string
  onChange: (text: string) => void
  /** Hand the draft to the PTY as a paste, then return. */
  onSend: () => void
  onVoice: () => void
  onImage: () => void
  voiceAvailable: boolean
}

/** Six lines, then it scrolls — past that the field is eating the terminal it
    is meant to be talking to. */
const MAX_ROWS = 6

/**
 * A place to write before anything reaches the agent.
 *
 * Typing straight into the terminal is the honest thing on a keyboard and the
 * wrong thing on a phone: every keystroke crosses the wire and comes back as a
 * repaint, there is no autocorrect over drawn text, and a paragraph composed
 * that way cannot be re-read before it is sent. The prompt the agent draws is
 * still the prompt — this is not a second one, and single keys (y/n, Esc, the
 * arrows) still belong to the key bar below, which is why that bar stays.
 *
 * It earns its place twice over on iOS: a field the phone recognises as
 * editable is the only surface it will offer its own Paste menu over, which is
 * what the button in the header used to stand in for, and badly.
 */
export default function Composer({
  value,
  onChange,
  onSend,
  onVoice,
  onImage,
  voiceAvailable,
}: Props) {
  const field = useRef<HTMLTextAreaElement>(null)

  /* Grow with the text rather than scroll inside one line — on a phone the
     thing being written is usually longer than the box it starts in. Measured
     from `scrollHeight`, which needs the height released first or it only ever
     reports what it already is. */
  useEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_ROWS)}px`
  }, [value])

  const ready = value.trim().length > 0

  return (
    /* z-10 for the same reason the key bar has it: xterm's screen is a
       positioned element and paints over a static sibling. */
    <div className="relative z-10 shrink-0 touch-manipulation border-t border-line-subtle bg-surface px-1.5 py-1">
      <div className="flex items-end gap-1">
        {voiceAvailable && (
          <IconButton label="Voice input" size="lg" onClick={onVoice}>
            <IconMic size={19} />
          </IconButton>
        )}
        <IconButton label="Upload image" size="lg" onClick={onImage}>
          <IconImage size={19} />
        </IconButton>
        <textarea
          ref={field}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Message… (press and hold to paste)"
          /* Enter is a newline, not send. The send target is a button a thumb
             can find; a return key that fires the message makes every wrapped
             paragraph a gamble. */
          className="min-h-11 flex-1 resize-none rounded-(--radius-field) border border-line bg-ink px-3 py-2.5 text-[15px] leading-5 text-fore outline-none placeholder:text-faint focus:border-accent"
        />
        {/* Held rather than hidden: a control that appears under the thumb on
            the last character is a control that gets pressed by accident. */}
        <IconButton
          label="Send to the agent"
          size="lg"
          disabled={!ready}
          onClick={onSend}
          className={ready ? 'bg-accent/15 text-accent' : 'text-faint'}
        >
          <IconSend size={19} />
        </IconButton>
      </div>
    </div>
  )
}
