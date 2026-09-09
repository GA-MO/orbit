import fs from 'node:fs'
import { qrBlock } from './qr.js'

/* ------------------------------ Startup banner ------------------------------
 *
 * What the server prints once, at the moment it comes up. Three facts carry the
 * whole thing: where to open Orbit from a phone, the token that pairs it, and
 * how to stop. Everything else — the local URL, the WebSocket path, the version
 * — is worth having on screen only as a dim footnote, so it is drawn as one.
 *
 * Every fact arrives as an argument. The tailnet address in particular is a
 * `tailscale` process away and only `index.ts` knows whether it has already
 * paid for that lookup; a banner that went and asked for itself would spawn a
 * process on every start, block the listen callback while it ran, and be
 * untestable without Tailscale on the machine. Taking it as a string makes this
 * a pure function of its arguments, which is the whole reason it is a module.
 *
 * There is no box. A frame has to be drawn to a width, and the width here is
 * whatever window the user happens to have — a box laid out for 80 columns and
 * wrapped at 60 is worse than no box at all, and the alternative of measuring
 * and redrawing the frame buys a decoration nobody reads. Alignment and blank
 * lines do the same work and degrade by themselves.
 */

/* One accent, and cyan because it is the only basic colour that stays legible
   both ways round: yellow and green vanish on a light terminal, blue disappears
   on a dark one. This is the same trap qr.ts documents — a terminal's palette
   is not knowable from inside it, so anything printed has to work on both. Bold
   and dim are safe in a way colour is not, since they change weight rather than
   hue, and they carry the hierarchy whenever colour is off. */
const ACCENT = '\x1b[36m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

/** Width the aligned two-column layout needs before it starts looking cramped. */
const WIDE = 64

const INDENT = '  '

export interface BannerFacts {
  /** The port the server is listening on. */
  port: number
  /** The access token a phone pairs with. */
  token: string
  /** The https address Orbit answers on across the tailnet, when it is published. */
  tailnetUrl?: string | null
  /** The address with a pairing code in it — what the QR shows. Without one, the QR shows the token. */
  pairUrl?: string | null
  /** Defaults to the version in `server/package.json`. */
  version?: string
  /** Defaults to `process.stdout.columns`, or 80 when that is unknown. */
  columns?: number
  /** Defaults to off under `NO_COLOR`, on otherwise. */
  color?: boolean
}

/* Read rather than imported: a JSON import would need `resolveJsonModule` and
   would then be copied into dist as a second, staler copy of the version. The
   path resolves the same from `src` under tsx and from `dist` under node, since
   both sit one directory below the package. */
export function packageVersion(): string {
  /* Two places: beside the package in a checkout, and where
     `scripts/dist.sh` embeds it in a compiled binary (`--asset=server/package.json`
     keeps only the file's own name). */
  for (const candidate of [new URL('../package.json', import.meta.url), '/$bunfs/root/package.json']) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8')).version ?? '?'
    } catch {
      // try the next
    }
  }
  return '?'
}

const ANSI = /\x1b\[[0-9;]*m/g
const visibleWidth = (line: string) => line.replace(ANSI, '').length

/**
 * The one line the docs point at, and the only output worth having when stdout
 * is a log file or a service manager's pipe rather than a person.
 *
 * The token line keeps its exact historical wording because it is what a user
 * copies and what `grep` in the troubleshooting docs looks for; changing it to
 * match the pretty banner would break both for the sake of consistency nobody
 * asked for.
 */
export function plainBanner(facts: BannerFacts): string {
  const version = facts.version ?? packageVersion()
  const lines = [
    `[orbit] v${version} listening on http://localhost:${facts.port} (ws: /ws)`,
    `[orbit] access token: ${facts.token}`,
  ]
  if (facts.tailnetUrl) lines.push(`[orbit] tailnet: ${facts.tailnetUrl}`)
  return lines.join('\n')
}

/**
 * The banner as one string, ready to print when someone is actually watching.
 *
 * The caller decides — `process.stdout.isTTY` gates this against
 * {@link plainBanner} — because only the caller knows where its output is
 * going, and a function that sniffed the terminal itself could not be rendered
 * at three widths in a test.
 */
export function banner(facts: BannerFacts): string {
  const version = facts.version ?? packageVersion()
  const columns = facts.columns ?? process.stdout.columns ?? 80
  const color = facts.color ?? !process.env.NO_COLOR

  const paint = (code: string, text: string) => (color ? `${code}${text}${RESET}` : text)
  const dim = (text: string) => paint(DIM, text)

  const localUrl = `http://localhost:${facts.port}`
  const out: string[] = ['', `${INDENT}${paint(BOLD, 'Orbit')} ${dim(version)}`, '']

  /* The address you act on gets a label that says what to do with it, not what
     it technically is: someone reading this is holding a phone, and "Tailnet"
     names the transport rather than the task. Without a published address the
     local URL is promoted into that slot, because then it is the only way in
     and burying it in the footnote would hide the one thing on screen. */
  const rows: Array<[string, string]> = facts.tailnetUrl
    ? [
        ['Phone', facts.tailnetUrl],
        ['Token', facts.token],
      ]
    : [
        ['Browser', `${localUrl}/`],
        ['Token', facts.token],
      ]

  const labelWidth = Math.max(...rows.map(([label]) => label.length))
  const stacked = columns < WIDE
  for (const [label, value] of rows) {
    const painted = paint(ACCENT, value)
    if (stacked) {
      /* Narrow, the two columns would push the values into a wrap, and a
         wrapped URL is a URL that cannot be double-clicked. Stacking spends a
         line per fact to keep every value whole and starting at a fixed
         column. */
      out.push(`${INDENT}${dim(label)}`, `${INDENT}${painted}`, '')
    } else {
      out.push(`${INDENT}${dim(label.padEnd(labelWidth + 3))}${painted}`)
    }
  }
  if (!stacked) out.push('')

  /* The code is a shortcut past typing sixteen characters, never the only copy
     of them, so a window too narrow to hold it loses the shortcut and nothing
     else. Printing it anyway would wrap it, and a wrapped QR is not a QR — the
     rows land in the wrong places and no camera will read it. */
  const qr = qrBlock(facts.pairUrl ?? facts.token, INDENT + INDENT)
  const qrWidth = Math.max(...qr.split('\n').map(visibleWidth))
  if (qrWidth <= columns) {
    /* The code keeps its own pinned white-on-black under NO_COLOR, which looks
       like an oversight and is not: qr.ts pins those because a fair number of
       phone cameras refuse an inverted code, so honouring NO_COLOR there would
       trade a scannable code for a preference about text. NO_COLOR asks for
       plain text; this is a picture. */
    out.push(qr, '')
    out.push(
      `${INDENT}${dim(
        facts.pairUrl
          ? "Point the phone's camera at it — good for 10 minutes; `orbit pair` prints a fresh one."
          : "Scan it from Orbit's login screen, or type the token.",
      )}`,
    )
  } else {
    out.push(`${INDENT}${dim('Widen this window to show the pairing code.')}`)
  }

  /* Everything a person needs once and then never again. It is one line so it
     reads as a margin note rather than as more instructions, and it is the
     first thing to go when the window cannot hold it — the pieces here are all
     recoverable from the docs, unlike the token. */
  const footnotes = facts.tailnetUrl ? [`on this Mac ${localUrl}`, 'ws /ws'] : ['ws /ws']
  footnotes.push('Ctrl-C to stop')
  const footer = footnotes.join('  ·  ')
  const fits = footer.length + INDENT.length <= columns
  out.push(`${INDENT}${dim(fits ? footer : 'Ctrl-C to stop')}`)
  out.push('')

  return out.join('\n')
}
