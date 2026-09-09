import { useEffect, useRef } from 'react'
import { Button, IconButton, IconImage, Sheet } from '../components/ui'

interface Props {
  /** The draft lives in the parent, so closing this is not the same as losing it. */
  value: string
  onChange: (text: string) => void
  /** Into the prompt, left for the user to add to before it goes. */
  onInsert: (text: string) => void
  /** Into the prompt, followed by the return that commits it. */
  onSend: (text: string) => void
  /** Opens the picker; the uploaded path arrives back through `value`. */
  onImage: () => void
  onClose: () => void
}

/**
 * A place to write before anything reaches the agent.
 *
 * Typing straight into the terminal is the honest thing on a keyboard and the
 * wrong thing on a phone: every keystroke crosses the wire and comes back as a
 * repaint, there is no autocorrect over drawn text, and a paragraph composed
 * that way cannot be re-read before it is sent. The prompt the agent draws is
 * still the prompt — this is not a second one, and single keys (y/n, Esc, the
 * arrows) still belong to the key bar, which is why that bar stays.
 *
 * A sheet rather than a docked bar: the terminal is the thing being read, and a
 * permanent field would take a stripe of it away for the whole session to serve
 * the minute or two of it that is spent writing. It is also the shape voice
 * already has — same panel, same three buttons, same place on the screen — so
 * the two ways of dictating a message do not have to be learned separately.
 *
 * It earns its place twice over on iOS: a field the phone recognises as
 * editable is the only surface it will offer its own Paste menu over, which is
 * what the paste button in the header used to stand in for, and badly.
 */
export default function ComposeSheet({
  value,
  onChange,
  onInsert,
  onSend,
  onImage,
  onClose,
}: Props) {
  const field = useRef<HTMLTextAreaElement>(null)

  /* Focused on open, with the caret past whatever is already there — a draft
     that survived the last close is being returned to, not restarted. */
  useEffect(() => {
    const el = field.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const ready = value.trim().length > 0

  const finish = (submit: (text: string) => void) => {
    submit(value.trim())
    onChange('')
    onClose()
  }

  return (
    <Sheet title="Message" onClose={onClose}>
      <div className="flex flex-col gap-3 px-5 pt-1 pb-4">
        <textarea
          ref={field}
          className="min-h-32 resize-none rounded-(--radius-field) border border-line bg-ink px-3.5 py-2.5 text-[15px] text-fore outline-none placeholder:text-faint focus:border-accent"
          placeholder="Write here — press and hold to paste"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="flex items-center gap-2">
          {/* The other way to fill the same draft, and the one that belongs
              next to it rather than out in the bar: an uploaded path is nearly
              always the middle of a sentence rather than the whole of one.
              The mic is in the key bar — opening it from inside this sheet put
              one sheet on top of another, with this one's keyboard still up
              behind it eating the first tap that landed on the other. */}
          <IconButton label="Upload an image and add its path" size="lg" onClick={onImage}>
            <IconImage size={19} />
          </IconButton>
          <Button
            variant="outline"
            className="flex-1"
            disabled={!ready}
            onClick={() => finish(onInsert)}
          >
            Insert
          </Button>
          <Button className="flex-1" disabled={!ready} onClick={() => finish(onSend)}>
            Send ⏎
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
