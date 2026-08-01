import { useEffect, useRef, useState } from 'react'
import { Button, Sheet } from '../components/ui'

interface Props {
  onInsert: (text: string) => void
  onSend: (text: string) => void
  onClose: () => void
}

/**
 * The way in when the clipboard cannot be read for us: plain http on the LAN is
 * not a secure context, so `navigator.clipboard` is not there at all, and every
 * browser refuses a scripted paste besides. A real field the phone recognises
 * as editable is the one surface iOS will still offer its own Paste menu over —
 * the terminal is drawn text, and its own textarea is a pixel wide and readonly
 * until focused, which is why long-pressing the prompt offers nothing.
 */
export default function PasteSheet({ onInsert, onSend, onClose }: Props) {
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)

  // Focused, so the caret is already where the long press has to land.
  useEffect(() => {
    field.current?.focus()
  }, [])

  const ready = text.length > 0

  const finish = (submit: (text: string) => void) => {
    submit(text)
    onClose()
  }

  return (
    <Sheet title="Paste" onClose={onClose}>
      <div className="flex flex-col gap-3 px-5 pt-1 pb-4">
        <textarea
          ref={field}
          className="min-h-24 resize-none rounded-(--radius-field) border border-line bg-ink px-3.5 py-2.5 font-mono text-[14px] text-fore outline-none placeholder:text-faint focus:border-accent"
          placeholder="Press and hold here, then tap Paste"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="text-xs text-faint">
          Goes into the terminal as one paste — line breaks stay line breaks instead of sending
          the message early.
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
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
