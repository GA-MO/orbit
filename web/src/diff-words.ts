export interface Span {
  text: string
  changed: boolean
}

const WORD_SPACE_OR_PUNCTUATION = /[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g

const MIN_SIMILARITY = 0.3
const MAX_TOKENS_PER_LINE = 400

const tokenize = (line: string): string[] => line.match(WORD_SPACE_OR_PUNCTUATION) ?? []

interface CommonRun {
  keptA: boolean[]
  keptB: boolean[]
  sharedLength: number
}

function longestCommonSubsequence(a: string[], b: string[]): CommonRun {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const keptA = new Array(a.length).fill(false)
  const keptB = new Array(b.length).fill(false)
  let sharedLength = 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      keptA[i] = true
      keptB[j] = true
      sharedLength += a[i].length
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return { keptA, keptB, sharedLength }
}

const spansOf = (tokens: string[], kept: boolean[]): Span[] => {
  const spans: Span[] = []
  for (let i = 0; i < tokens.length; i++) {
    const changed = !kept[i]
    const last = spans[spans.length - 1]
    if (last && last.changed === changed) last.text += tokens[i]
    else spans.push({ text: tokens[i], changed })
  }
  return spans
}

export function compareLines(before: string, after: string): { before: Span[]; after: Span[] } | null {
  const a = tokenize(before)
  const b = tokenize(after)
  if (a.length === 0 || b.length === 0) return null
  if (a.length > MAX_TOKENS_PER_LINE || b.length > MAX_TOKENS_PER_LINE) return null

  const { keptA, keptB, sharedLength } = longestCommonSubsequence(a, b)
  const longest = Math.max(before.length, after.length)
  const tooDifferentToBeAnEdit = longest === 0 || sharedLength / longest < MIN_SIMILARITY
  if (tooDifferentToBeAnEdit) return null
  const nothingChanged = keptA.every(Boolean) && keptB.every(Boolean)
  if (nothingChanged) return null

  return { before: spansOf(a, keptA), after: spansOf(b, keptB) }
}

export function pair(
  removed: string[],
  added: string[],
): { removed: (Span[] | null)[]; added: (Span[] | null)[] } | null {
  if (removed.length === 0 || added.length === 0) return null
  if (removed.length !== added.length) return null

  const out = { removed: [] as (Span[] | null)[], added: [] as (Span[] | null)[] }
  let anyPaired = false
  for (let i = 0; i < removed.length; i++) {
    const compared = compareLines(removed[i], added[i])
    out.removed.push(compared?.before ?? null)
    out.added.push(compared?.after ?? null)
    if (compared) anyPaired = true
  }
  return anyPaired ? out : null
}

const runEndFrom = (lines: string[], start: number, prefix: string): number => {
  let end = start
  while (end < lines.length && lines[end].startsWith(prefix)) end++
  return end
}

export function markHunk(lines: string[]): Map<number, Span[]> {
  const marks = new Map<number, Span[]>()
  let i = 0
  while (i < lines.length) {
    if (!lines[i].startsWith('-')) {
      i++
      continue
    }
    const removedEnd = runEndFrom(lines, i, '-')
    const addedEnd = runEndFrom(lines, removedEnd, '+')

    const paired = pair(
      lines.slice(i, removedEnd).map((line) => line.slice(1)),
      lines.slice(removedEnd, addedEnd).map((line) => line.slice(1)),
    )
    if (paired) {
      for (let k = i; k < removedEnd; k++) {
        const spans = paired.removed[k - i]
        if (spans) marks.set(k, spans)
      }
      for (let k = removedEnd; k < addedEnd; k++) {
        const spans = paired.added[k - removedEnd]
        if (spans) marks.set(k, spans)
      }
    }
    i = addedEnd > i ? addedEnd : i + 1
  }
  return marks
}
