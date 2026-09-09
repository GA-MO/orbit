import { useEffect, useRef } from 'react'
import { Button, IconButton, IconImage, Sheet } from '../components/ui'

interface Props {
  value: string
  onChange: (text: string) => void
  onInsert: (text: string) => void
  onSend: (text: string) => void
  onImage: () => void
  onClose: () => void
}

function useFocusWithCaretAtEnd() {
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = field.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  return field
}

export default function ComposeSheet({
  value,
  onChange,
  onInsert,
  onSend,
  onImage,
  onClose,
}: Props) {
  const field = useFocusWithCaretAtEnd()
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
