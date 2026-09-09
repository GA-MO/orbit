import type { Terminal as XTerm } from '@xterm/xterm'

/*
 * A frozen copy of what the terminal is holding, as text a browser can select.
 *
 * The selection used to be drawn over the live terminal — a range of cells, our
 * own highlight rectangles, two drag grips. It could not survive there. Every
 * repaint scrolls the buffer, `term.onScroll` had to drop the selection when it
 * did, and an app that owns the screen repaints continuously: selecting
 * anything while Claude Code was working was not hard, it was impossible. The
 * gestures could not be separated either. Holding still for 420ms and then
 * dragging is the same movement whether it means "extend the selection" or "I
 * was about to scroll", so one of the two had to lose, and scrolling did.
 *
 * A snapshot has neither problem. It does not move, so a selection on it lasts;
 * and it takes the selecting away from the terminal entirely, so a drag over
 * the terminal can mean scroll and nothing else. It also hands the whole job to
 * the platform — the loupe, the handles, double-tap, Look Up, Share — none of
 * which we were ever going to write.
 */

/** How far back the panel reaches. Rows, not lines: wrapping only shortens it. */
const MAX_ROWS = 3000

export interface Snapshot {
  /** Logical lines: a wrapped row is one line to a reader, and to a copy. */
  lines: string[]
  /** Where the press landed, once the line it landed on is found. */
  hit: { line: number; offset: number } | null
  /** True when the buffer held more than `MAX_ROWS` and the top was dropped. */
  clipped: boolean
}

/** The rows one logical line covers. */
export function logicalSpan(term: XTerm, row: number): [number, number] {
  const buf = term.buffer.active
  let first = row
  while (first > 0 && buf.getLine(first)?.isWrapped) first--
  let last = row
  while (buf.getLine(last + 1)?.isWrapped) last++
  return [first, last]
}

/**
 * Every character of the logical line `row` belongs to, with the cell each one
 * sits in. Cells rather than string offsets: one Thai cell can hold several
 * characters and a wide glyph spans two columns, so the two counts drift apart.
 *
 * Called for the line the finger landed on, and by the link scanner. Running
 * it over three thousand rows would be a `getCell` per column per row, which on
 * a phone is long enough to feel like the panel is refusing to open — so the
 * snapshot reads every other line the cheap way.
 */
export function logicalCells(
  term: XTerm,
  row: number,
): { text: string; at: { row: number; col: number }[] } {
  const [first, last] = logicalSpan(term, row)
  const buf = term.buffer.active
  let text = ''
  const at: { row: number; col: number }[] = []
  for (let r = first; r <= last; r++) {
    const line = buf.getLine(r)
    if (!line) continue
    for (let c = 0; c < term.cols; c++) {
      const cell = line.getCell(c)
      if (!cell) continue
      if (cell.getWidth() === 0) continue // trailing half of a wide character
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

/**
 * The word around `offset`, split on whitespace only. Not on punctuation the
 * way a prose editor would: what gets copied out of a terminal is paths, URLs,
 * hashes and flags, and those are ruined by a split on `/` or `-`. The range is
 * half-open, which is what a DOM Range wants.
 */
export function wordRange(text: string, offset: number): [number, number] {
  if (offset < 0 || offset >= text.length) return [offset, offset]
  let index = offset
  // Landing on a space takes the word before it rather than nothing.
  if (/\s/.test(text[index])) {
    let back = index
    while (back > 0 && /\s/.test(text[back])) back--
    if (/\s/.test(text[back])) return [index, index]
    index = back
  }
  let from = index
  while (from > 0 && !/\s/.test(text[from - 1])) from--
  let to = index
  while (to < text.length - 1 && !/\s/.test(text[to + 1])) to++
  return [from, to + 1]
}

/** Where a line and an offset within it land in the joined text. */
export function charIndex(lines: string[], line: number, offset: number): number {
  let index = 0
  for (let i = 0; i < line && i < lines.length; i++) index += lines[i].length + 1
  return index + offset
}

export function snapshot(term: XTerm, press?: { row: number; col: number } | null): Snapshot {
  const buf = term.buffer.active
  const end = buf.baseY + term.rows - 1
  /* Start a whole logical line back from the cut, or the first line in the
     panel is the tail of one whose beginning was thrown away. */
  const [floor] = logicalSpan(term, Math.max(0, end - MAX_ROWS + 1))
  const lines: string[] = []
  let hit: Snapshot['hit'] = null

  for (let row = floor; row <= end; ) {
    const [first, last] = logicalSpan(term, row)
    const pressed = !!press && press.row >= first && press.row <= last
    let text = ''
    if (pressed) {
      /* Same source for the text and the offsets, so an offset cannot point at
         a character the panel does not show. */
      const cells = logicalCells(term, first)
      text = cells.text
      const index = cells.at.findIndex((p) => p.row === press.row && p.col === press.col)
      const trimmed = text.replace(/\s+$/, '').length
      if (index >= 0) hit = { line: lines.length, offset: Math.min(index, Math.max(0, trimmed - 1)) }
    } else {
      for (let r = first; r <= last; r++) text += buf.getLine(r)?.translateToString(false) ?? ''
    }
    lines.push(text.replace(/\s+$/, ''))
    row = last + 1
  }

  /* The blank field below the output is not content, and dropping it is what
     puts the last line of the session at the bottom of the panel rather than
     twenty rows above it. Never past the line that was pressed. */
  while (lines.length > (hit ? hit.line + 1 : 0) && !lines[lines.length - 1]) lines.pop()

  return { lines, hit, clipped: floor > 0 }
}
