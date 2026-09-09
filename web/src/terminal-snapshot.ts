import type { Terminal as XTerm } from '@xterm/xterm'

const MAX_ROWS = 3000
const WHITESPACE = /\s/
const TRAILING_WHITESPACE = /\s+$/

export interface Snapshot {
  lines: string[]
  hit: { line: number; offset: number } | null
  clipped: boolean
}

export interface CellPosition {
  row: number
  col: number
}

export function logicalSpan(term: XTerm, row: number): [number, number] {
  const buf = term.buffer.active
  let first = row
  while (first > 0 && buf.getLine(first)?.isWrapped) first--
  let last = row
  while (buf.getLine(last + 1)?.isWrapped) last++
  return [first, last]
}

export function logicalCells(term: XTerm, row: number): { text: string; at: CellPosition[] } {
  const [first, last] = logicalSpan(term, row)
  const buf = term.buffer.active
  let text = ''
  const at: CellPosition[] = []
  for (let r = first; r <= last; r++) {
    const line = buf.getLine(r)
    if (!line) continue
    for (let c = 0; c < term.cols; c++) {
      const cell = line.getCell(c)
      if (!cell) continue
      const isTrailingHalfOfWideGlyph = cell.getWidth() === 0
      if (isTrailingHalfOfWideGlyph) continue
      for (const ch of cell.getChars() || ' ') {
        text += ch
        at.push({ row: r, col: c })
      }
    }
  }
  return { text, at }
}

export function isBlankRow(term: XTerm, row: number): boolean {
  return !(term.buffer.active.getLine(row)?.translateToString(true) ?? '').trim()
}

export function wordRange(text: string, offset: number): [number, number] {
  if (offset < 0 || offset >= text.length) return [offset, offset]
  let index = offset
  if (WHITESPACE.test(text[index])) {
    const wordBefore = lastNonSpaceBefore(text, index)
    if (wordBefore < 0) return [index, index]
    index = wordBefore
  }
  let from = index
  while (from > 0 && !WHITESPACE.test(text[from - 1])) from--
  let to = index
  while (to < text.length - 1 && !WHITESPACE.test(text[to + 1])) to++
  return [from, to + 1]
}

function lastNonSpaceBefore(text: string, index: number): number {
  let back = index
  while (back > 0 && WHITESPACE.test(text[back])) back--
  return WHITESPACE.test(text[back]) ? -1 : back
}

export function charIndex(lines: string[], line: number, offset: number): number {
  let index = 0
  for (let i = 0; i < line && i < lines.length; i++) index += lines[i].length + 1
  return index + offset
}

export function snapshot(term: XTerm, press?: CellPosition | null): Snapshot {
  const buf = term.buffer.active
  const end = buf.baseY + term.rows - 1
  const [floor] = logicalSpan(term, Math.max(0, end - MAX_ROWS + 1))
  const lines: string[] = []
  let hit: Snapshot['hit'] = null

  for (let row = floor; row <= end; ) {
    const [first, last] = logicalSpan(term, row)
    const pressed = !!press && press.row >= first && press.row <= last
    let text = ''
    if (pressed) {
      const cells = logicalCells(term, first)
      text = cells.text
      const index = cells.at.findIndex((p) => p.row === press.row && p.col === press.col)
      const trimmedLength = text.replace(TRAILING_WHITESPACE, '').length
      if (index >= 0) {
        hit = { line: lines.length, offset: Math.min(index, Math.max(0, trimmedLength - 1)) }
      }
    } else {
      for (let r = first; r <= last; r++) text += buf.getLine(r)?.translateToString(false) ?? ''
    }
    lines.push(text.replace(TRAILING_WHITESPACE, ''))
    row = last + 1
  }

  dropTrailingBlankLines(lines, hit ? hit.line + 1 : 0)

  return { lines, hit, clipped: floor > 0 }
}

function dropTrailingBlankLines(lines: string[], keepAtLeast: number) {
  while (lines.length > keepAtLeast && !lines[lines.length - 1]) lines.pop()
}
