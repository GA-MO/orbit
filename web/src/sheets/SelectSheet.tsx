import { useEffect, useRef, useState } from 'react'
import { writeToClipboard } from '../clipboard'
import { Button, IconInsert, Sheet } from '../components/ui'
import { charIndex, wordRange, type Snapshot } from '../terminal-snapshot'

interface Props {
  shot: Snapshot
  onInsertPath?: (path: string) => void
  onClose: () => void
}

const PRESSED_WORD_VIEW_FRACTION_FROM_TOP = 1 / 3
const PRESSED_WORD_VIEW_FRACTION_FROM_LEFT = 1 / 4

const clampOffset = (offset: number, length: number) => Math.max(0, Math.min(offset, length))

function lineBoundsAround(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const nextBreak = text.indexOf('\n', end)
  return [from, nextBreak < 0 ? text.length : nextBreak]
}

function coversWholeLines(text: string, range: Range) {
  const startsAtLineStart = range.startOffset === 0 || text[range.startOffset - 1] === '\n'
  const endsAtLineEnd = range.endOffset === text.length || text[range.endOffset] === '\n'
  return startsAtLineStart && endsAtLineEnd
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function scrollRangeIntoView(box: HTMLElement, range: Range) {
  const rect = range.getBoundingClientRect()
  const view = box.getBoundingClientRect()
  box.scrollTop += rect.top - view.top - view.height * PRESSED_WORD_VIEW_FRACTION_FROM_TOP
  if (rect.left < view.left || rect.right > view.right)
    box.scrollLeft += rect.left - view.left - view.width * PRESSED_WORD_VIEW_FRACTION_FROM_LEFT
}

export default function SelectSheet({ shot, onInsertPath, onClose }: Props) {
  const preRef = useRef<HTMLPreElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [picked, setPicked] = useState('')
  const [copiedText, setCopiedText] = useState<string | null>(null)
  const text = shot.lines.join('\n')

  const textNode = () => preRef.current?.firstChild ?? null

  const selectionInsidePre = () => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    const own = textNode()
    if (!own || range.startContainer !== own || range.endContainer !== own) return null
    return range
  }

  const select = (from: number, to: number) => {
    const own = textNode()
    if (!own) return
    const range = document.createRange()
    range.setStart(own, clampOffset(from, text.length))
    range.setEnd(own, clampOffset(to, text.length))
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    setPicked(range.toString())
    return range
  }

  useEffect(() => {
    const { hit, lines } = shot
    if (!hit) return
    const lineStart = charIndex(lines, hit.line, 0)
    const [from, to] = wordRange(lines[hit.line] ?? '', hit.offset)
    const range = select(lineStart + from, lineStart + to)
    const box = scrollRef.current
    if (!range || !box) return
    scrollRangeIntoView(box, range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const mirrorSelection = () => {
      const range = selectionInsidePre()
      setPicked(range ? range.toString() : '')
    }
    document.addEventListener('selectionchange', mirrorSelection)
    return () => document.removeEventListener('selectionchange', mirrorSelection)
  }, [])

  const expandToLines = () => {
    const range = selectionInsidePre()
    if (!range) return
    const [from, to] = lineBoundsAround(text, range.startOffset, range.endOffset)
    select(from, to)
  }

  const wholeLines =
    !!picked &&
    (() => {
      const range = selectionInsidePre()
      return range ? coversWholeLines(text, range) : false
    })()

  const lineCount = picked ? picked.split('\n').length : 0
  const countLabel =
    wholeLines || lineCount > 1 ? plural(lineCount, 'line') : plural(picked.length, 'char')

  const copied = !!picked && picked === copiedText

  const copy = async () => {
    if (!picked) return
    await writeToClipboard(picked)
    setCopiedText(picked)
  }

  const insertPicked = () => {
    onInsertPath?.(picked)
    onClose()
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
        <pre
          ref={preRef}
          className="w-max font-mono text-[13px] leading-[1.5] whitespace-pre text-fore [-webkit-touch-callout:default] [-webkit-user-select:text] [user-select:text]"
        >
          {text}
        </pre>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line-subtle px-4 py-2.5">
        <span className="min-w-16 text-xs tabular-nums text-mut">
          {picked ? countLabel : 'Nothing picked'}
        </span>
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
              onClick={insertPicked}
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
