import type { IDisposable, ILink, Terminal as XTerm } from '@xterm/xterm'
import { resolveUri } from './local-url'
import { logicalCells, logicalSpan } from './terminal-snapshot'

/*
 * A URL printed into a terminal is just text, and xterm paints it onto a canvas
 * — so on a phone there is nothing to tap and nothing to long-press, and no
 * address bar to type it into instead. This finds them in the buffer again.
 *
 * Cells, not string offsets: a line of Thai (or any wide glyph) makes column
 * numbers and character indices disagree, and a link underlined two columns off
 * from the text it belongs to is worse than no link at all.
 */

/* URLs are ASCII. Saying so, rather than "anything but a space", is what keeps
   a Thai word that ends up next to one out of the address. */
const URL_CHAR = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]"
/**
 * The host has to look like a host.
 *
 * `https://...:8443/` is a real thing to find in terminal output — a program
 * eliding a hostname it did not want to print, our own docs among them — and
 * while anything after `://` counted as one, that was offered as a link. It
 * resolves to nothing, so following it could only ever open a blank frame, and
 * a blank frame does not say whether the address or the server was the problem.
 *
 * Dot-separated labels that begin and end alphanumeric, or an IPv6 literal in
 * brackets. `..` has no label between the dots and so cannot match.
 */
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?'
const HOST = `(?:\\[[0-9A-Fa-f:]+\\]|${LABEL}(?:\\.${LABEL})*)`
/* `token@github.com` — rare to read, but a git remote prints it, and stopping
   the match at the `@` would hand back an address missing its host. */
const USERINFO = "(?:[A-Za-z0-9\\-._~%!$&'()*+,;=:]+@)?"
const AUTHORITY = `${USERINFO}${HOST}(?::\\d+)?`
/* Everything after the host is free-form again: a path, query and fragment can
   hold anything `URL_CHAR` allows. */
const URL_RE = new RegExp(
  `(?:(?:https?://|www\\.)${AUTHORITY}(?:[/?#]${URL_CHAR}*)?` +
    `|(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):\\d+(?:/${URL_CHAR}*)?)`,
  'g',
)
/** Sentence punctuation that a URL at the end of a line collects but never owns. */
const TRAILING = /[.,;:!?)\]]+$/

export interface TerminalLink {
  uri: string
  text: string
  /** Absolute buffer rows/columns — the coordinates xterm's selection API uses. */
  start: { row: number; col: number }
  end: { row: number; col: number }
}

/** Indent a wrapped continuation may carry — Claude Code writes two spaces. */
const MAX_INDENT = 4
/**
 * What a continuation is allowed to start with. Punctuation only, on purpose:
 * a URL broken across rows carries on with `.html`, `/path`, `?q=1`, while the
 * next line of a paragraph starts with a letter. Joining on letters too would
 * turn "see https://example.com\n  and more" into one wrong address, and a
 * wrong address that resolves is worse than a link that stopped short.
 */
const CONTINUATION = /^[./?&=#%\-_~+:@,;]/
/** The character a row has to end on for a continuation to be plausible. */
const URL_TAIL = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]$/

const rowText = (term: XTerm, row: number) =>
  term.buffer.active.getLine(row)?.translateToString(true) ?? ''

/**
 * Some programs wrap their own output instead of letting the terminal do it —
 * Claude Code among them, indenting the continuation by two columns. The buffer
 * then holds two lines with no `isWrapped` flag between them, and a URL that
 * crossed the margin is split in half. Tapping `https://host/site` when the
 * `.html` sits on the next row opens a real page that is the wrong one.
 */
function continues(term: XTerm, prevLast: number, next: number): boolean {
  const before = rowText(term, prevLast)
  if (!before || !URL_TAIL.test(before)) return false
  const after = term.buffer.active.getLine(next)?.translateToString(false) ?? ''
  if (!after.trim()) return false
  const indent = after.length - after.trimStart().length
  return indent <= MAX_INDENT && CONTINUATION.test(after.trimStart())
}

/** Every link on the line that `row` (absolute buffer row) belongs to. */
export function linksOnRow(term: XTerm, row: number): TerminalLink[] {
  /* Read cell by cell so wide glyphs earlier in the line cannot shift the
     columns, and across every row the text runs through. */
  let first = logicalSpan(term, row)[0]
  while (first > 0 && continues(term, logicalSpan(term, first - 1)[1], first)) {
    first = logicalSpan(term, first - 1)[0]
  }

  let text = ''
  const at: { row: number; col: number }[] = []
  for (let r = first; ; ) {
    const part = logicalCells(term, r)
    const last = logicalSpan(term, r)[1]
    /* A row is padded out to the full width with blanks. Carrying those into
       the join would put a space in the middle of the address and end the match
       right where the wrap was — the bug this whole path exists to fix. */
    const end = part.text.replace(/\s+$/, '').length
    // Drop the indent a continuation was written with, not the text after it.
    const from = r === first ? 0 : part.text.length - part.text.trimStart().length
    text += part.text.slice(from, end)
    at.push(...part.at.slice(from, end))
    if (!continues(term, last, last + 1)) break
    r = last + 1
  }

  const links: TerminalLink[] = []
  for (const match of text.matchAll(URL_RE)) {
    const index = match.index ?? 0
    const raw = match[0].replace(TRAILING, '')
    if (!raw) continue
    const start = at[index]
    const end = at[index + raw.length - 1]
    if (!start || !end) continue
    links.push({ uri: resolveUri(raw), text: raw, start, end })
  }
  return links
}

/** The link under a cell, if the cell is inside one. */
export function linkAt(term: XTerm, row: number, col: number): TerminalLink | null {
  for (const link of linksOnRow(term, row)) {
    const afterStart = row > link.start.row || (row === link.start.row && col >= link.start.col)
    const beforeEnd = row < link.end.row || (row === link.end.row && col <= link.end.col)
    if (afterStart && beforeEnd) return link
  }
  return null
}

/**
 * Underlines links and opens them on click. Taps are handled by the terminal
 * itself rather than here — xterm resolves a click against the link the *mouse*
 * last moved over, which on a touchscreen is a pointer that never moved.
 */
export function registerLinkProvider(term: XTerm, open: (uri: string) => void): IDisposable {
  return term.registerLinkProvider({
    provideLinks(viewportRow, callback) {
      const buf = term.buffer.active
      const row = buf.viewportY + viewportRow - 1
      const links: ILink[] = []
      for (const link of linksOnRow(term, row)) {
        // xterm asks one row at a time and wants viewport coordinates back.
        if (row < link.start.row || row > link.end.row) continue
        links.push({
          text: link.text,
          range: {
            start: { x: link.start.col + 1, y: link.start.row - buf.viewportY + 1 },
            end: { x: link.end.col + 1, y: link.end.row - buf.viewportY + 1 },
          },
          activate: () => open(link.uri),
        })
      }
      callback(links.length ? links : undefined)
    },
  })
}
