import fs from 'node:fs'
import { qrBlock } from './qr.js'

const ACCENT = '\x1b[36m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const WIDE = 64
const DEFAULT_COLUMNS = 80
const LABEL_GAP = 3
const INDENT = '  '
const FOOTNOTE_SEPARATOR = '  ·  '
const STOP_HINT = 'Ctrl-C to stop'
const UNKNOWN_VERSION = '?'

const PACKAGE_JSON_CANDIDATES = [new URL('../package.json', import.meta.url), '/$bunfs/root/package.json']

export interface BannerFacts {
  port: number
  token: string
  tailnetUrl?: string | null
  pairUrl?: string | null
  version?: string
  columns?: number
  color?: boolean
}

export function packageVersion(): string {
  for (const candidate of PACKAGE_JSON_CANDIDATES) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8')).version ?? UNKNOWN_VERSION
    } catch {}
  }
  return UNKNOWN_VERSION
}

const ANSI = /\x1b\[[0-9;]*m/g
const visibleWidth = (line: string) => line.replace(ANSI, '').length

export function plainBanner(facts: BannerFacts): string {
  const version = facts.version ?? packageVersion()
  const lines = [
    `[orbit] v${version} listening on http://localhost:${facts.port} (ws: /ws)`,
    `[orbit] access token: ${facts.token}`,
  ]
  if (facts.tailnetUrl) lines.push(`[orbit] tailnet: ${facts.tailnetUrl}`)
  return lines.join('\n')
}

type Row = [label: string, value: string]

const addressRows = (facts: BannerFacts, localUrl: string): Row[] =>
  facts.tailnetUrl
    ? [
        ['Phone', facts.tailnetUrl],
        ['Token', facts.token],
      ]
    : [
        ['Browser', `${localUrl}/`],
        ['Token', facts.token],
      ]

const pairingInstructions = (hasPairUrl: boolean): string[] =>
  hasPairUrl
    ? [
        "1. Point the phone's camera at it — Orbit opens, already paired.",
        '2. Share → Add to Home Screen.',
        '3. Open that app, tap Scan QR code, point it at this same code.',
        'Good for 10 minutes; `orbit pair` prints a fresh one.',
      ]
    : ["Scan it from Orbit's login screen, or type the token."]

const footnoteLine = (facts: BannerFacts, localUrl: string, columns: number): string => {
  const footnotes = facts.tailnetUrl ? [`on this Mac ${localUrl}`, 'ws /ws'] : ['ws /ws']
  footnotes.push(STOP_HINT)
  const footer = footnotes.join(FOOTNOTE_SEPARATOR)
  const fits = footer.length + INDENT.length <= columns
  return fits ? footer : STOP_HINT
}

export function banner(facts: BannerFacts): string {
  const version = facts.version ?? packageVersion()
  const columns = facts.columns ?? process.stdout.columns ?? DEFAULT_COLUMNS
  const color = facts.color ?? !process.env.NO_COLOR

  const paint = (code: string, text: string) => (color ? `${code}${text}${RESET}` : text)
  const dim = (text: string) => paint(DIM, text)
  const dimLine = (text: string) => `${INDENT}${dim(text)}`

  const localUrl = `http://localhost:${facts.port}`
  const out: string[] = ['', `${INDENT}${paint(BOLD, 'Orbit')} ${dim(version)}`, '']

  const rows = addressRows(facts, localUrl)
  const labelWidth = Math.max(...rows.map(([label]) => label.length))
  const stacked = columns < WIDE
  for (const [label, value] of rows) {
    const painted = paint(ACCENT, value)
    if (stacked) {
      out.push(dimLine(label), `${INDENT}${painted}`, '')
    } else {
      out.push(`${INDENT}${dim(label.padEnd(labelWidth + LABEL_GAP))}${painted}`)
    }
  }
  if (!stacked) out.push('')

  const qr = qrBlock(facts.pairUrl ?? facts.token, INDENT + INDENT)
  const qrWidth = Math.max(...qr.split('\n').map(visibleWidth))
  if (qrWidth <= columns) {
    out.push(qr, '')
    out.push(...pairingInstructions(Boolean(facts.pairUrl)).map(dimLine))
  } else {
    out.push(dimLine('Widen this window to show the pairing code.'))
  }

  out.push(dimLine(footnoteLine(facts, localUrl, columns)))
  out.push('')

  return out.join('\n')
}
