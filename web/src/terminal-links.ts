import type { IDisposable, ILink, Terminal as XTerm } from '@xterm/xterm'
import { resolveUri } from './local-url'
import { logicalCells, logicalSpan, type CellPosition } from './terminal-snapshot'

const URL_CHAR = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]"
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?'
const HOST = `(?:\\[[0-9A-Fa-f:]+\\]|${LABEL}(?:\\.${LABEL})*)`
const USERINFO = "(?:[A-Za-z0-9\\-._~%!$&'()*+,;=:]+@)?"
const AUTHORITY = `${USERINFO}${HOST}(?::\\d+)?`
const URL_RE = new RegExp(
  `(?:(?:https?://|www\\.)${AUTHORITY}(?:[/?#]${URL_CHAR}*)?` +
    `|(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):\\d+(?:/${URL_CHAR}*)?)`,
  'g',
)
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/
const TRAILING_WHITESPACE = /\s+$/

export interface TerminalLink {
  uri: string
  text: string
  start: CellPosition
  end: CellPosition
}

const MAX_CONTINUATION_INDENT = 4
const CONTINUATION_START = /^[./?&=#%\-_~+:@,;]/
const URL_TAIL = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]$/

const rowText = (term: XTerm, row: number) =>
  term.buffer.active.getLine(row)?.translateToString(true) ?? ''

function isSoftWrappedContinuation(term: XTerm, prevLast: number, next: number): boolean {
  const before = rowText(term, prevLast)
  if (!before || !URL_TAIL.test(before)) return false
  const after = term.buffer.active.getLine(next)?.translateToString(false) ?? ''
  if (!after.trim()) return false
  const indent = after.length - after.trimStart().length
  return indent <= MAX_CONTINUATION_INDENT && CONTINUATION_START.test(after.trimStart())
}

function firstRowOfSoftWrappedLine(term: XTerm, row: number): number {
  let first = logicalSpan(term, row)[0]
  while (first > 0 && isSoftWrappedContinuation(term, logicalSpan(term, first - 1)[1], first)) {
    first = logicalSpan(term, first - 1)[0]
  }
  return first
}

function joinSoftWrappedLine(term: XTerm, first: number): { text: string; at: CellPosition[] } {
  let text = ''
  const at: CellPosition[] = []
  for (let r = first; ; ) {
    const part = logicalCells(term, r)
    const last = logicalSpan(term, r)[1]
    const end = part.text.replace(TRAILING_WHITESPACE, '').length
    const from = r === first ? 0 : part.text.length - part.text.trimStart().length
    text += part.text.slice(from, end)
    at.push(...part.at.slice(from, end))
    if (!isSoftWrappedContinuation(term, last, last + 1)) break
    r = last + 1
  }
  return { text, at }
}

export function linksOnRow(term: XTerm, row: number): TerminalLink[] {
  const first = firstRowOfSoftWrappedLine(term, row)
  const { text, at } = joinSoftWrappedLine(term, first)

  const links: TerminalLink[] = []
  for (const match of text.matchAll(URL_RE)) {
    const index = match.index ?? 0
    const raw = match[0].replace(TRAILING_PUNCTUATION, '')
    if (!raw) continue
    const start = at[index]
    const end = at[index + raw.length - 1]
    if (!start || !end) continue
    links.push({ uri: resolveUri(raw), text: raw, start, end })
  }
  return links
}

export function linkAt(term: XTerm, row: number, col: number): TerminalLink | null {
  for (const link of linksOnRow(term, row)) {
    const afterStart = row > link.start.row || (row === link.start.row && col >= link.start.col)
    const beforeEnd = row < link.end.row || (row === link.end.row && col <= link.end.col)
    if (afterStart && beforeEnd) return link
  }
  return null
}

export function registerLinkProvider(term: XTerm, open: (uri: string) => void): IDisposable {
  return term.registerLinkProvider({
    provideLinks(viewportRow, callback) {
      const buf = term.buffer.active
      const row = buf.viewportY + viewportRow - 1
      const toViewport = (cell: CellPosition) => ({ x: cell.col + 1, y: cell.row - buf.viewportY + 1 })
      const links: ILink[] = []
      for (const link of linksOnRow(term, row)) {
        if (row < link.start.row || row > link.end.row) continue
        links.push({
          text: link.text,
          range: { start: toViewport(link.start), end: toViewport(link.end) },
          activate: () => open(link.uri),
        })
      }
      callback(links.length ? links : undefined)
    },
  })
}
