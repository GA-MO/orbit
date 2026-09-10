import type { Session } from './pty-manager.js'

const QUIET_MS = 10_000
const MIN_OUTPUT_SINCE_KEYSTROKE = 200
const TAIL_CHARS = 8_000
const TAIL_LINES = 12
const MAX_MESSAGE = 120
const MIN_STATEMENT_LENGTH = 8

const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
const ESCAPE_SEQUENCE = /\x1b(\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O[A-Za-z]|.)?/g
const CONTROL_CHAR = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g
const CARRIAGE_RETURN = /\r/g
const CURSOR_TO_ROW = /\x1b\[(\d*)(?:;\d*)?H/g
const FRAME_EDGE = /^[\s─-╿|>❯›▶●•*]+|[\s─-╿|]+$/g
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

const AGENT_CHROME = [
  /^\? for shortcuts/i,
  /^esc to interrupt/i,
  /to interrupt\)?$/i,
  /^⏵{1,2}\s/,
  /^bypassing permissions/i,
  /^\d+ lines? (selected|hidden)/i,
  /^ctrl\+/i,
  /^ask codex to do anything/i,
  /^\S+ \S+ · /,
]

const isChrome = (line: string): boolean => AGENT_CHROME.some((re) => re.test(line))

const hasWords = (line: string): boolean =>
  line.length > 1 && HAS_LETTER_OR_DIGIT.test(line) && !isChrome(line)

const isQuestion = (line: string): boolean => line.endsWith('?')

const isStatement = (line: string): boolean => line.length >= MIN_STATEMENT_LENGTH

const breakWhereTheCursorChangesRow = (raw: string): string => {
  let out = ''
  let copiedTo = 0
  let row: string | null = null
  for (const move of raw.matchAll(CURSOR_TO_ROW)) {
    const movedToRow = move[1] || '1'
    out += raw.slice(copiedTo, move.index)
    if (row !== null && movedToRow !== row) out += '\n'
    row = movedToRow
    copiedTo = move.index + move[0].length
  }
  return out + raw.slice(copiedTo)
}

const plainText = (raw: string): string =>
  breakWhereTheCursorChangesRow(raw)
    .replace(OSC_SEQUENCE, '')
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CARRIAGE_RETURN, '\n')
    .replace(CONTROL_CHAR, '')

const stripFrame = (line: string): string => line.replace(FRAME_EDGE, '').trim()

const lastLineWhere = (lines: string[], test: (line: string) => boolean): string | undefined =>
  [...lines].reverse().find(test)

export function lastWord(raw: string): string | null {
  const lines = plainText(raw).split('\n').map(stripFrame).filter(hasWords).slice(-TAIL_LINES)
  const picked = lastLineWhere(lines, isQuestion) ?? lastLineWhere(lines, isStatement)
  return picked ? picked.slice(0, MAX_MESSAGE) : null
}

export function watch(
  session: Session,
  onQuiet: (message: string | null) => void,
  quietMs: number = QUIET_MS,
): void {
  let silenceTimer: NodeJS.Timeout | null = null
  let outputSinceKeystroke = 0
  let reportOwedThisTurn = true
  let screenTail = ''

  const cancelSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  const settle = () => {
    silenceTimer = null
    if (!reportOwedThisTurn || outputSinceKeystroke < MIN_OUTPUT_SINCE_KEYSTROKE) return
    reportOwedThisTurn = false
    onQuiet(lastWord(screenTail))
  }

  session.onData((data) => {
    screenTail = (screenTail + data).slice(-TAIL_CHARS)
    outputSinceKeystroke += data.length
    cancelSilenceTimer()
    silenceTimer = setTimeout(settle, quietMs)
    silenceTimer.unref?.()
  })

  const startNewTurn = () => {
    outputSinceKeystroke = 0
    reportOwedThisTurn = true
    screenTail = ''
    cancelSilenceTimer()
  }

  session.onInput(startNewTurn)
  session.onExit(cancelSilenceTimer)
}
