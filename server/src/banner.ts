import { execFileSync } from 'node:child_process'
import { qrBlock } from './qr.js'
import { LAN_OPEN } from './network.js'
import { packageVersion } from './version.js'
import * as ui from './ui.js'

const WIDE = 64
const DEFAULT_COLUMNS = 80
const LABEL_GAP = 3
const INDENT = '  '
const FOOTNOTE_SEPARATOR = '  ·  '
const STOP_HINT = 'Ctrl-C to stop'
const LAN_INTERFACES = ['en0', 'en1']

export interface BannerFacts {
  port: number
  token: string
  tailnetUrl?: string | null
  lanUrl?: string | null
  pairUrl?: string | null
  version?: string
  columns?: number
}

export function lanAddress(): string | null {
  for (const interfaceName of LAN_INTERFACES) {
    try {
      return execFileSync('ipconfig', ['getifaddr', interfaceName], { encoding: 'utf8', stdio: 'pipe' }).trim() || null
    } catch {}
  }
  return null
}

export function lanUrl(port: number): string | null {
  const address = lanAddress()
  return address ? `http://${address}:${port}` : null
}

const wifiUrlFor = (facts: BannerFacts): string | null => {
  if (facts.lanUrl !== undefined) return facts.lanUrl
  return LAN_OPEN ? lanUrl(facts.port) : null
}

export function plainBanner(facts: BannerFacts): string {
  const version = facts.version ?? packageVersion()
  const lines = [
    `[orbit] v${version} listening on http://localhost:${facts.port} (ws: /ws)`,
  ]
  if (aCredentialIsWanted(facts)) lines.push(`[orbit] access token: ${facts.token}`)
  if (facts.tailnetUrl) lines.push(`[orbit] tailnet: ${facts.tailnetUrl}`)
  const wifiUrl = wifiUrlFor(facts)
  if (wifiUrl) lines.push(`[orbit] same wi-fi: ${wifiUrl}`)
  return lines.join('\n')
}

type Row = [label: string, value: string]

const aCredentialIsWanted = (facts: BannerFacts): boolean => LAN_OPEN || !facts.tailnetUrl

const addressRows = (facts: BannerFacts, localUrl: string, wifiUrl: string | null): Row[] => {
  const rows: Row[] = [facts.tailnetUrl ? ['Phone', facts.tailnetUrl] : ['Browser', `${localUrl}/`]]
  if (wifiUrl) rows.push(['Same wi-fi', `${wifiUrl}/`])
  if (aCredentialIsWanted(facts)) rows.push(['Token', facts.token])
  return rows
}

const WALK_IN_INSTRUCTIONS = [
  "1. Point the phone's camera at it, with Tailscale on — it lets you straight in.",
  '2. Share → Add to Home Screen, and it stays one tap away.',
  'Nothing to type, nothing to pair, and nothing that expires.',
]

const codeToScan = (facts: BannerFacts): string | null =>
  aCredentialIsWanted(facts) ? (facts.pairUrl ?? facts.token) : (facts.tailnetUrl ?? null)

const instructionsFor = (facts: BannerFacts): string[] =>
  aCredentialIsWanted(facts) ? pairingInstructions(Boolean(facts.pairUrl)) : WALK_IN_INSTRUCTIONS

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

const wordmarkFits = (columns: number): boolean => ui.BLOCK_WORDMARK_WIDTH + INDENT.length * 2 <= columns

const blockHeadingLines = (where: string, version: string): string[] => {
  const strap = `${ui.gradient(ui.ORB)} ${ui.ink(ui.NEBULA, where)}`
  const stamp = ui.dim(version)
  const gap = ui.BLOCK_WORDMARK_WIDTH - ui.visibleWidth(strap) - ui.visibleWidth(stamp)
  return [
    '',
    ...ui.blockWordmark().map((line) => `${INDENT}${line}`),
    '',
    gap > 1 ? `${INDENT}${strap}${' '.repeat(gap)}${stamp}` : `${INDENT}${strap}`,
    ui.ruleLine(),
    '',
  ]
}

export function banner(facts: BannerFacts): string {
  const version = facts.version ?? packageVersion()
  const columns = facts.columns ?? process.stdout.columns ?? DEFAULT_COLUMNS

  const dimLine = (text: string) => `${INDENT}${ui.dim(text)}`

  const localUrl = `http://localhost:${facts.port}`
  const out: string[] = wordmarkFits(columns)
    ? blockHeadingLines(`live on :${facts.port}`, version)
    : [...ui.headingLines(`live on :${facts.port}`, version)]

  const rows = addressRows(facts, localUrl, wifiUrlFor(facts))
  const labelWidth = Math.max(...rows.map(([label]) => label.length))
  const stacked = columns < WIDE
  for (const [label, value] of rows) {
    const painted = ui.ink(ui.HORIZON, value)
    if (stacked) {
      out.push(dimLine(label), `${INDENT}${painted}`, '')
    } else {
      out.push(`${INDENT}${ui.dim(label.padEnd(labelWidth + LABEL_GAP))}${painted}`)
    }
  }
  if (!stacked) out.push('')

  const scannable = codeToScan(facts)
  const qr = scannable ? qrBlock(scannable, INDENT + INDENT) : null
  const qrFits = qr ? Math.max(...qr.split('\n').map(ui.visibleWidth)) <= columns : false
  if (qr && qrFits) out.push(qr, '')
  if (qr && !qrFits) out.push(dimLine('Widen this window to show the QR code.'))
  out.push(...instructionsFor(facts).map(dimLine))

  out.push('', ui.ruleLine(), `${INDENT}${ui.gradient(ui.ORB)} ${ui.dim(footnoteLine(facts, localUrl, columns))}`, '')

  return out.join('\n')
}
