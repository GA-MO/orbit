import type { Terminal as XTerm } from '@xterm/xterm'

/*
 * Selecting inside the terminal with a fingertip.
 *
 * xterm's own selection cannot be driven by touch — the browser follows every
 * touch with an emulated mousedown, and xterm answers that by collapsing the
 * selection to the cell under the finger. So the held selection is ours: a
 * range of cells, the text read out of the buffer, and rectangles drawn over
 * the rows. Everything here works in absolute buffer coordinates, with both
 * ends inclusive.
 */

export interface CellRange {
  startRow: number
  startCol: number
  endRow: number
  endCol: number
}

export interface Rect {
  top: number
  left: number
  width: number
  height: number
}

export interface Metrics {
  /** Cell size and the terminal's offset inside the box we draw into. */
  cellWidth: number
  cellHeight: number
  top: number
  left: number
  viewportY: number
}

/** The rows one logical line covers — a wrapped line is one line to a reader. */
export function logicalSpan(term: XTerm, row: number): [number, number] {
  const buf = term.buffer.active
  let first = row
  while (first > 0 && buf.getLine(first)?.isWrapped) first--
  let last = row
  while (buf.getLine(last + 1)?.isWrapped) last++
  return [first, last]
}

/**
 * Every character of the logical line at `row`, with the cell each one sits in.
 * Cells rather than string offsets: one Thai cell can hold several characters
 * and a wide glyph spans two columns, so the two counts drift apart.
 */
export function logicalCells(term: XTerm, row: number): { text: string; at: { row: number; col: number }[] } {
  const buf = term.buffer.active
  const [first, last] = logicalSpan(term, row)
  let text = ''
  const at: { row: number; col: number }[] = []
  for (let r = first; r <= last; r++) {
    const line = buf.getLine(r)
    if (!line) continue
    for (let c = 0; c < term.cols; c++) {
      const cell = line.getCell(c)
      if (!cell) continue
      if (cell.getWidth() === 0) continue // trailing half of a wide character
      const chars = cell.getChars() || ' '
      for (const ch of chars) {
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

/** Last column of a row that holds anything; -1 on a blank row. */
function lastContentCol(term: XTerm, row: number): number {
  const text = term.buffer.active.getLine(row)?.translateToString(true) ?? ''
  const { at } = logicalCells(term, row)
  const trimmed = text.trimEnd().length
  const cell = at[trimmed - 1]
  return cell && cell.row === row ? cell.col : Math.max(0, trimmed - 1)
}

/**
 * Pulls a point back to where there is something to select. Below the last line
 * of output is a field of blank rows, and a selection dragged into it comes back
 * as a column of empty lines — visibly a selection, with nothing in it.
 */
export function snapToContent(
  term: XTerm,
  cell: { row: number; col: number },
  floor: number,
): { row: number; col: number } | null {
  if (!isBlankRow(term, cell.row)) return cell
  for (let row = cell.row - 1; row >= floor; row--) {
    if (!isBlankRow(term, row)) return { row, col: lastContentCol(term, row) }
  }
  return null
}

export function orderRange(range: CellRange): CellRange {
  const flipped =
    range.endRow < range.startRow ||
    (range.endRow === range.startRow && range.endCol < range.startCol)
  return flipped
    ? {
        startRow: range.endRow,
        startCol: range.endCol,
        endRow: range.startRow,
        endCol: range.startCol,
      }
    : range
}

/**
 * The word under a cell, split on whitespace only. Not on punctuation the way a
 * prose editor would: what gets copied out of a terminal is paths, URLs, hashes
 * and flags, and those are ruined by a split on `/` or `-`.
 */
export function wordAt(term: XTerm, row: number, col: number): CellRange {
  const { text, at } = logicalCells(term, row)
  let index = at.findIndex((p) => p.row === row && p.col === col)
  if (index < 0) return { startRow: row, startCol: col, endRow: row, endCol: col }

  // A tap landing on a space takes the word before it rather than nothing.
  if (/\s/.test(text[index])) {
    let back = index
    while (back > 0 && /\s/.test(text[back])) back--
    if (/\s/.test(text[back])) return { startRow: row, startCol: col, endRow: row, endCol: col }
    index = back
  }

  let from = index
  while (from > 0 && !/\s/.test(text[from - 1])) from--
  let to = index
  while (to < text.length - 1 && !/\s/.test(text[to + 1])) to++

  return {
    startRow: at[from].row,
    startCol: at[from].col,
    endRow: at[to].row,
    endCol: at[to].col,
  }
}

/** Grows a range out to whole logical lines. */
export function expandToLines(term: XTerm, range: CellRange): CellRange {
  const [first] = logicalSpan(term, range.startRow)
  const [, last] = logicalSpan(term, range.endRow)
  return { startRow: first, startCol: 0, endRow: last, endCol: term.cols - 1 }
}

export function isWholeLines(term: XTerm, range: CellRange): boolean {
  const whole = expandToLines(term, range)
  return (
    range.startRow === whole.startRow &&
    range.startCol === whole.startCol &&
    range.endRow === whole.endRow &&
    range.endCol === whole.endCol
  )
}

export function rangeText(term: XTerm, range: CellRange): string {
  const buf = term.buffer.active
  let out = ''
  for (let row = range.startRow; row <= range.endRow; row++) {
    const line = buf.getLine(row)
    if (!line) continue
    const from = row === range.startRow ? range.startCol : 0
    const to = row === range.endRow ? range.endCol + 1 : term.cols
    let piece = line.translateToString(false, from, to)
    // A row that runs into the next one keeps its padding; one that ends does not.
    const continues = row < range.endRow && !!buf.getLine(row + 1)?.isWrapped
    if (!continues) piece = piece.replace(/\s+$/, '')
    out += piece
    if (row < range.endRow && !continues) out += '\n'
  }
  return out
}

/** One rectangle per painted row band: first row, the block between, last row. */
export function rangeRects(term: XTerm, range: CellRange, m: Metrics): Rect[] {
  const rowTop = (row: number) => m.top + (row - m.viewportY) * m.cellHeight
  const rects: Rect[] = []

  if (range.startRow === range.endRow) {
    rects.push({
      top: rowTop(range.startRow),
      left: m.left + range.startCol * m.cellWidth,
      width: (range.endCol - range.startCol + 1) * m.cellWidth,
      height: m.cellHeight,
    })
    return rects
  }

  rects.push({
    top: rowTop(range.startRow),
    left: m.left + range.startCol * m.cellWidth,
    width: (term.cols - range.startCol) * m.cellWidth,
    height: m.cellHeight,
  })
  if (range.endRow - range.startRow > 1) {
    rects.push({
      top: rowTop(range.startRow + 1),
      left: m.left,
      width: term.cols * m.cellWidth,
      height: (range.endRow - range.startRow - 1) * m.cellHeight,
    })
  }
  rects.push({
    top: rowTop(range.endRow),
    left: m.left,
    width: (range.endCol + 1) * m.cellWidth,
    height: m.cellHeight,
  })
  return rects
}

/** Where the two drag grips sit: the outer corners of the selection. */
export function gripPoints(term: XTerm, range: CellRange, m: Metrics) {
  return {
    start: {
      x: m.left + range.startCol * m.cellWidth,
      y: m.top + (range.startRow - m.viewportY) * m.cellHeight,
    },
    end: {
      x: m.left + (range.endCol + 1) * m.cellWidth,
      y: m.top + (range.endRow - m.viewportY + 1) * m.cellHeight,
    },
  }
}
