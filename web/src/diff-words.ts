/**
 * Which *words* changed, not just which lines did.
 *
 * A diff that colours whole lines answers "this line is different" and leaves
 * the actual question — different how? — to be solved by eye, comparing two
 * near-identical lines a few rows apart. On a 390px screen, where the two are
 * rarely both visible and long lines run off the side, that reading is the
 * thing people give up on and go back to the Mac for.
 *
 * So a removed line and the added line that replaced it are matched up and the
 * common run between them is found; what is left over is what actually changed.
 * The pairing is deliberately timid — see `pair` — because a highlight in the
 * wrong place is worse than none: it is a confident answer that is not true.
 */

export interface Span {
  text: string
  changed: boolean
}

/** Words, whitespace and punctuation, each as its own token. */
const TOKENS = /[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g

/* Two lines with almost nothing in common are not an edit of one another —
   they are one line deleted and a different one written. Highlighting every
   token of both says "all of this changed", which is true and useless. */
const MIN_SIMILARITY = 0.3
/* The comparison below is O(n × m). Lines this long are minified or generated,
   and nobody is reading them word by word anyway. */
const MAX_TOKENS = 400

const tokenize = (line: string): string[] => line.match(TOKENS) ?? []

/** Longest common subsequence of two token lists, as a pair of keep-masks. */
function common(a: string[], b: string[]): { keptA: boolean[]; keptB: boolean[]; shared: number } {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const keptA = new Array(a.length).fill(false)
  const keptB = new Array(b.length).fill(false)
  let shared = 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      keptA[i] = true
      keptB[j] = true
      shared += a[i].length
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return { keptA, keptB, shared }
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

/**
 * One removed line against the one that replaced it. `null` when they are too
 * different to be called an edit, or too long to compare.
 */
export function compareLines(before: string, after: string): { before: Span[]; after: Span[] } | null {
  const a = tokenize(before)
  const b = tokenize(after)
  if (a.length === 0 || b.length === 0) return null
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null

  const { keptA, keptB, shared } = common(a, b)
  const longest = Math.max(before.length, after.length)
  if (longest === 0 || shared / longest < MIN_SIMILARITY) return null
  // Nothing to point at: identical but for whitespace git already tracks.
  if (keptA.every(Boolean) && keptB.every(Boolean)) return null

  return { before: spansOf(a, keptA), after: spansOf(b, keptB) }
}

/**
 * A run of removed lines followed by a run of added ones.
 *
 * Only an equal-length run is paired, line for line. Anything else — three
 * lines becoming one, one becoming five — has no line-to-line answer, and
 * guessing at one puts the highlight on whichever line happened to line up.
 */
export function pair(
  removed: string[],
  added: string[],
): { removed: (Span[] | null)[]; added: (Span[] | null)[] } | null {
  if (removed.length === 0 || added.length === 0) return null
  if (removed.length !== added.length) return null

  const out = { removed: [] as (Span[] | null)[], added: [] as (Span[] | null)[] }
  let any = false
  for (let i = 0; i < removed.length; i++) {
    const compared = compareLines(removed[i], added[i])
    out.removed.push(compared?.before ?? null)
    out.added.push(compared?.after ?? null)
    if (compared) any = true
  }
  return any ? out : null
}

/**
 * The whole body of one hunk at once: for every line that replaced another (or
 * was replaced), the spans that differ — keyed by its index in `lines`.
 *
 * Lines with no answer are simply absent, and the view falls back to colouring
 * the line as a whole, which is what it did before any of this existed.
 */
export function markHunk(lines: string[]): Map<number, Span[]> {
  const marks = new Map<number, Span[]>()
  let i = 0
  while (i < lines.length) {
    if (!lines[i].startsWith('-')) {
      i++
      continue
    }
    let dels = i
    while (dels < lines.length && lines[dels].startsWith('-')) dels++
    let adds = dels
    while (adds < lines.length && lines[adds].startsWith('+')) adds++

    const paired = pair(
      lines.slice(i, dels).map((l) => l.slice(1)),
      lines.slice(dels, adds).map((l) => l.slice(1)),
    )
    if (paired) {
      for (let k = i; k < dels; k++) {
        const spans = paired.removed[k - i]
        if (spans) marks.set(k, spans)
      }
      for (let k = dels; k < adds; k++) {
        const spans = paired.added[k - dels]
        if (spans) marks.set(k, spans)
      }
    }
    i = adds > i ? adds : i + 1
  }
  return marks
}
