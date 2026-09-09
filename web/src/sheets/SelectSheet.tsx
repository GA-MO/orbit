import { useEffect, useRef, useState } from 'react'
import { writeToClipboard } from '../clipboard'
import { Button, IconInsert, Sheet } from '../components/ui'
import { charIndex, wordRange, type Snapshot } from '../terminal-snapshot'

interface Props {
  shot: Snapshot
  /** Hand what was picked to the prompt. Absent on a session with no PTY. */
  onInsertPath?: (path: string) => void
  onClose: () => void
}

/**
 * The terminal's text, standing still, so the phone can select it.
 *
 * Everything below the surface of this panel is the platform's. There are no
 * grips here, no highlight rectangles, no long-press timer and no hit-testing
 * against a cell grid — a `<pre>` of real text is all iOS needs to give the
 * loupe, the handles, double-tap for a word, Look Up and Share, and to keep the
 * selection alive across a scroll. What is left for us is the two things it
 * cannot know: which word was meant, and where that word is.
 *
 * `white-space: pre` with the text sideways-scrollable rather than wrapped,
 * matching the Changes tab. Re-wrapping to 390px would make a copied line
 * disagree with the line on the terminal, and it would fold every diff and
 * every aligned column into porridge — the two cases where the shape of the
 * line is the information.
 *
 * The whole snapshot is one text node on purpose. A DOM offset is then the same
 * number as a string offset, which is what lets the word be pre-selected and
 * the Line button expand a selection without a second index of where every span
 * begins.
 */
export default function SelectSheet({ shot, onInsertPath, onClose }: Props) {
  const preRef = useRef<HTMLPreElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [picked, setPicked] = useState('')
  /* What went to the clipboard, not whether something did. `Copied` then stands
     exactly as long as the thing it is talking about is still the selection,
     and it cannot be left standing over a different one by an event arriving in
     an order nobody predicted. */
  const [copiedText, setCopiedText] = useState<string | null>(null)
  const text = shot.lines.join('\n')

  /** The one text node everything here counts against. */
  const node = () => preRef.current?.firstChild ?? null

  /** The live selection, but only while it is inside this panel. */
  const rangeIn = () => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    const own = node()
    if (!own || range.startContainer !== own || range.endContainer !== own) return null
    return range
  }

  const select = (from: number, to: number) => {
    const own = node()
    if (!own) return
    const range = document.createRange()
    range.setStart(own, Math.max(0, Math.min(from, text.length)))
    range.setEnd(own, Math.max(0, Math.min(to, text.length)))
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    setPicked(range.toString())
    return range
  }

  /* Open with the pressed word already picked and the handles already up. The
     press said which word was wanted; making the panel appear scrolled to the
     top with nothing selected would throw that away and ask again. */
  useEffect(() => {
    const { hit, lines } = shot
    if (!hit) return
    const start = charIndex(lines, hit.line, 0)
    const [from, to] = wordRange(lines[hit.line] ?? '', hit.offset)
    const range = select(start + from, start + to)
    const box = scrollRef.current
    if (!range || !box) return
    /* A third of the way down rather than centred: what is usually wanted next
       is the lines *after* the one that was pressed. */
    const rect = range.getBoundingClientRect()
    const view = box.getBoundingClientRect()
    box.scrollTop += rect.top - view.top - view.height / 3
    if (rect.left < view.left || rect.right > view.right)
      box.scrollLeft += rect.left - view.left - view.width / 4
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* What the fingers did to the selection, mirrored into the bar. */
  useEffect(() => {
    const read = () => {
      const range = rangeIn()
      setPicked(range ? range.toString() : '')
    }
    document.addEventListener('selectionchange', read)
    return () => document.removeEventListener('selectionchange', read)
  }, [])

  /* Whole logical lines, from wherever the handles happen to sit. Dragging a
     handle to the end of a long line means scrolling sideways with the other
     hand; this is the one selection worth a button. */
  const expandToLines = () => {
    const range = rangeIn()
    if (!range) return
    const from = text.lastIndexOf('\n', Math.max(0, range.startOffset - 1)) + 1
    const nextBreak = text.indexOf('\n', range.endOffset)
    select(from, nextBreak < 0 ? text.length : nextBreak)
  }

  const wholeLines =
    !!picked &&
    (() => {
      const range = rangeIn()
      if (!range) return false
      const before = range.startOffset === 0 || text[range.startOffset - 1] === '\n'
      const after = range.endOffset === text.length || text[range.endOffset] === '\n'
      return before && after
    })()

  const lineCount = picked ? picked.split('\n').length : 0
  /* Count what was actually picked: whole lines are lines, a piece of one is
     characters — which is the number that tells you whether you got the path. */
  const label =
    wholeLines || lineCount > 1
      ? `${lineCount} line${lineCount === 1 ? '' : 's'}`
      : `${picked.length} char${picked.length === 1 ? '' : 's'}`

  const copied = !!picked && picked === copiedText

  const copy = async () => {
    if (!picked) return
    await writeToClipboard(picked)
    setCopiedText(picked)
  }

  return (
    <Sheet title="Select" side="full" onClose={onClose}>
      {shot.clipped && (
        <p className="shrink-0 px-5 pb-1 text-[11px] text-faint">
          The oldest lines are not here — the terminal keeps a limited history.
        </p>
      )}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto overscroll-contain px-5 py-2"
      >
        {/* `w-max` so the box scrolls sideways to the longest line instead of
            squeezing every line into the narrow one. */}
        <pre
          ref={preRef}
          className="w-max font-mono text-[13px] leading-[1.5] whitespace-pre text-fore [-webkit-touch-callout:default] [-webkit-user-select:text] [user-select:text]"
        >
          {text}
        </pre>
      </div>
      {/* The bar carries only what the system menu above it cannot: the count
          that says whether the whole path came, whole-line selection, and the
          one destination that is not the clipboard. Copy is here too, because
          the system menu is gone the moment a handle is nudged. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line-subtle px-4 py-2.5">
        <span className="min-w-16 text-xs tabular-nums text-mut">{picked ? label : 'Nothing picked'}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {picked && !wholeLines && (
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={expandToLines}>
              Line
            </Button>
          )}
          {picked && onInsertPath && (
            <Button
              variant="outline"
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
              onClick={() => {
                onInsertPath(picked)
                onClose()
              }}
            >
              <IconInsert size={14} />
              Insert
            </Button>
          )}
          <Button
            variant="primary"
            className="px-3 py-1.5 text-xs disabled:opacity-40"
            disabled={!picked}
            onClick={copy}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
