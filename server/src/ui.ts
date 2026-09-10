import { packageVersion } from './version.js'

export interface Rgb {
  r: number
  g: number
  b: number
}

const ESC = '\x1b['
const RESET = `${ESC}0m`
const BOLD = `${ESC}1m`
const DIM = `${ESC}2m`
const HIDE_CURSOR = `${ESC}?25l`
const SHOW_CURSOR = `${ESC}?25h`
const CLEAR_BELOW = `${ESC}0J`

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

export const HORIZON: Rgb = { r: 56, g: 214, b: 238 }
export const NEBULA: Rgb = { r: 178, g: 132, b: 252 }
export const SIGNAL: Rgb = { r: 74, g: 222, b: 128 }
export const ALERT: Rgb = { r: 248, g: 113, b: 113 }
export const EMBER: Rgb = { r: 251, g: 191, b: 36 }

const BASIC_ANCHORS: Array<[Rgb, string]> = [
  [HORIZON, `${ESC}36m`],
  [NEBULA, `${ESC}35m`],
  [SIGNAL, `${ESC}32m`],
  [ALERT, `${ESC}31m`],
  [EMBER, `${ESC}33m`],
]

const TRUECOLOR_TERMS = /truecolor|24bit/i

const forced = process.env.FORCE_COLOR
const wantsNoColor = Boolean(process.env.NO_COLOR)

export const interactive = (): boolean => Boolean(process.stdout.isTTY) && !process.env.CI
export const coloured = (): boolean => (forced ? forced !== '0' : interactive() && !wantsNoColor)
const trueColoured = (): boolean => coloured() && (TRUECOLOR_TERMS.test(process.env.COLORTERM ?? '') || forced === '3')

const DEFAULT_COLUMNS = 80
const INDENT = '  '
const WIDEST_RULE = 62
const NARROW = 40

export const columns = (): number => process.stdout.columns ?? DEFAULT_COLUMNS
export const visibleWidth = (text: string): number => text.replace(ANSI, '').length

const ruleWidth = (): number => Math.max(NARROW - INDENT.length, Math.min(columns() - INDENT.length * 2, WIDEST_RULE))

const distance = (a: Rgb, b: Rgb): number => (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2

const nearestBasic = (rgb: Rgb): string =>
  BASIC_ANCHORS.reduce((best, anchor) => (distance(anchor[0], rgb) < distance(best[0], rgb) ? anchor : best))[1]

export const ink = (rgb: Rgb, text: string): string => {
  if (!coloured()) return text
  const open = trueColoured() ? `${ESC}38;2;${rgb.r};${rgb.g};${rgb.b}m` : nearestBasic(rgb)
  return `${open}${text}${RESET}`
}

export const dim = (text: string): string => (coloured() ? `${DIM}${text}${RESET}` : text)
export const bold = (text: string): string => (coloured() ? `${BOLD}${text}${RESET}` : text)

const blend = (from: Rgb, to: Rgb, ratio: number): Rgb => ({
  r: Math.round(from.r + (to.r - from.r) * ratio),
  g: Math.round(from.g + (to.g - from.g) * ratio),
  b: Math.round(from.b + (to.b - from.b) * ratio),
})

export const gradient = (text: string, from: Rgb = HORIZON, to: Rgb = NEBULA): string => {
  if (!coloured()) return text
  if (!trueColoured()) return ink(from, text)
  const glyphs = [...text]
  const last = Math.max(glyphs.length - 1, 1)
  return glyphs.map((glyph, at) => ink(blend(from, to, at / last), glyph)).join('')
}

export const fit = (text: string, width: number): string => {
  if (width <= 0) return ''
  const plain = text.replace(ANSI, '')
  if (plain.length <= width) return text
  return `${plain.slice(0, Math.max(width - 1, 0))}…`
}

export const bytes = (count: number): string => {
  const mb = count / 1024 / 1024
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(Math.round(count / 1024), 1)} KB`
}

const BAR_FULL = '█'
const BAR_EMPTY = '░'
const BAR_WIDTH = 18

export const bar = (fraction: number, width = BAR_WIDTH): string => {
  const clamped = Math.min(Math.max(fraction, 0), 1)
  const filled = Math.round(clamped * width)
  const track = BAR_FULL.repeat(filled)
  return `${gradient(track)}${dim(BAR_EMPTY.repeat(width - filled))}`
}

export const say = (line = ''): void => console.log(line ? `${INDENT}${line}` : '')

export const ruleLine = (): string => `${INDENT}${gradient('═'.repeat(ruleWidth()))}`

export const rule = (): void => console.log(ruleLine())

export const ORB = '◍'
const POINTER = '▸'

const wordmark = (): string => gradient([...'ORBIT'].join(' '))

export const LETTERFORMS: string[][] = [
  ['1111', '1001', '1001', '1001', '1111'],
  ['1110', '1001', '1110', '1010', '1001'],
  ['1110', '1001', '1110', '1001', '1110'],
  ['111', '010', '010', '010', '111'],
  ['111', '010', '010', '010', '010'],
]

const LETTER_GAP = 1
const LIT = '1'
const HALF_ROWS = 3

export const stitchLetters = (): string[] => {
  const rows: string[] = []
  for (let row = 0; row < LETTERFORMS[0].length; row += 1) {
    rows.push(LETTERFORMS.map((letter) => letter[row]).join('0'.repeat(LETTER_GAP)))
  }
  return rows
}

const halfBlock = (top: boolean, bottom: boolean): string =>
  top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '

export const BLOCK_WORDMARK_WIDTH = stitchLetters()[0].length * 2

export const blockWordmark = (): string[] => {
  const pixels = stitchLetters()
  const width = pixels[0].length
  const painted: string[] = []
  for (let band = 0; band < HALF_ROWS; band += 1) {
    const top = pixels[band * 2] ?? ''
    const bottom = pixels[band * 2 + 1] ?? ''
    let line = ''
    for (let column = 0; column < width; column += 1) {
      const glyph = halfBlock(top[column] === LIT, bottom[column] === LIT)
      line += ink(blend(HORIZON, NEBULA, column / (width - 1)), glyph.repeat(2))
    }
    painted.push(line)
  }
  return painted
}

export const headingLines = (command: string, version = packageVersion()): string[] => {
  const title = `${gradient(ORB)}  ${bold(wordmark())}   ${ink(NEBULA, `${POINTER} ${command}`)}`
  const stamp = dim(version)
  const gap = ruleWidth() - visibleWidth(title) - visibleWidth(stamp)
  return ['', gap > 1 ? `${INDENT}${title}${' '.repeat(gap)}${stamp}` : `${INDENT}${title}`, ruleLine(), '']
}

export const heading = (command: string, version = packageVersion()): void => {
  for (const line of headingLines(command, version)) console.log(line)
}

export const closing = (line: string, hints: string[] = []): void => {
  console.log('')
  rule()
  say(`${gradient(ORB)} ${line}`)
  for (const extra of hints) say(dim(`  ${extra}`))
  console.log('')
}

export const hint = (line: string): void => say(dim(line))

export const alarm = (line: string): void => say(`${ink(ALERT, '✘')} ${line}`)

export type ChannelState = 'waiting' | 'running' | 'passed' | 'failed' | 'skipped'

export interface Channel {
  key: string
  label: string
  detail?: string
  fix?: string
  state: ChannelState
}

interface ChannelSeed {
  key: string
  label: string
  detail?: string
}

const SPINNER = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏']
const SPINNER_MS = 80
const COUNTER_GAP = 2
const LABEL_GAP = 2
const FIX_ARROW = '└→'

const glyphFor = (state: ChannelState, frame: number): string => {
  switch (state) {
    case 'passed':
      return ink(SIGNAL, '✔')
    case 'failed':
      return ink(ALERT, '✘')
    case 'skipped':
      return dim('–')
    case 'running':
      return interactive() ? ink(HORIZON, SPINNER[frame % SPINNER.length]) : dim('·')
    default:
      return dim('·')
  }
}

const plainGlyphFor = (state: ChannelState): string =>
  state === 'passed' ? '✔' : state === 'failed' ? '✘' : state === 'skipped' ? '–' : '·'

export class Board {
  private readonly channels: Channel[]
  private readonly labelWidth: number
  private readonly counterWidth: number
  private frame = 0
  private painted = 0
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(seeds: ChannelSeed[]) {
    this.channels = seeds.map((seed) => ({ ...seed, state: 'waiting' as ChannelState }))
    this.labelWidth = Math.max(...this.channels.map((channel) => channel.label.length))
    this.counterWidth = `${this.channels.length}`.length
  }

  private find(key: string): Channel {
    const channel = this.channels.find((candidate) => candidate.key === key)
    if (!channel) throw new Error(`no channel named ${key}`)
    return channel
  }

  private counter(index: number): string {
    const at = `${index + 1}`.padStart(this.counterWidth)
    return dim(`[${at}/${this.channels.length}]`)
  }

  private line(channel: Channel, index: number): string {
    const label = channel.state === 'waiting' ? dim(channel.label.padEnd(this.labelWidth)) : channel.label.padEnd(this.labelWidth)
    const detail = channel.state === 'failed' ? ink(ALERT, channel.detail ?? '') : dim(channel.detail ?? '')
    const head = `${INDENT}${this.counter(index)}${' '.repeat(COUNTER_GAP)}${glyphFor(channel.state, this.frame)}${' '.repeat(LABEL_GAP)}${label}`
    if (!channel.detail) return head
    return fit(`${head}${' '.repeat(LABEL_GAP)}${detail}`, columns() - 1)
  }

  private fixLine(channel: Channel): string {
    const lead = ' '.repeat(INDENT.length + this.counterWidth * 2 + 3 + COUNTER_GAP)
    return fit(`${lead}${dim(`${FIX_ARROW} ${channel.fix}`)}`, columns() - 1)
  }

  private block(): string[] {
    const rendered: string[] = []
    this.channels.forEach((channel, index) => {
      rendered.push(this.line(channel, index))
      if (channel.fix) rendered.push(this.fixLine(channel))
    })
    return rendered
  }

  private repaint(): void {
    const lines = this.block()
    const rewind = this.painted ? `${ESC}${this.painted}A\r${CLEAR_BELOW}` : ''
    process.stdout.write(`${rewind}${lines.join('\n')}\n`)
    this.painted = lines.length
  }

  private announce(channel: Channel, index: number): void {
    const detail = channel.detail ? `  ${channel.detail}` : ''
    const at = `${index + 1}`.padStart(this.counterWidth)
    console.log(`${INDENT}[${at}/${this.channels.length}]  ${plainGlyphFor(channel.state)}  ${channel.label.padEnd(this.labelWidth)}${detail}`)
    if (channel.fix) console.log(`${INDENT}${' '.repeat(this.counterWidth * 2 + 3 + COUNTER_GAP)}${FIX_ARROW} ${channel.fix}`)
  }

  private touched(): void {
    if (interactive()) this.repaint()
  }

  open(): this {
    if (!interactive()) return this
    process.stdout.write(HIDE_CURSOR)
    process.once('exit', this.restoreCursor)
    this.repaint()
    this.ticker = setInterval(() => {
      this.frame += 1
      if (this.channels.some((channel) => channel.state === 'running')) this.repaint()
    }, SPINNER_MS)
    this.ticker.unref()
    return this
  }

  begin(key: string, detail?: string): this {
    const channel = this.find(key)
    channel.state = 'running'
    if (detail !== undefined) channel.detail = detail
    this.touched()
    return this
  }

  progress(key: string, fraction: number, detail = ''): this {
    const channel = this.find(key)
    if (!interactive()) return this
    channel.state = 'running'
    channel.detail = detail ? `${bar(fraction)}  ${detail}` : bar(fraction)
    this.repaint()
    return this
  }

  pass(key: string, detail?: string): this {
    return this.settle(key, 'passed', detail)
  }

  fail(key: string, detail?: string, fix?: string): this {
    return this.settle(key, 'failed', detail, fix)
  }

  skip(key: string, detail?: string, fix?: string): this {
    return this.settle(key, 'skipped', detail, fix)
  }

  private settle(key: string, state: ChannelState, detail?: string, fix?: string): this {
    const channel = this.find(key)
    channel.state = state
    if (detail !== undefined) channel.detail = detail
    if (fix !== undefined) channel.fix = fix
    this.touched()
    return this
  }

  private readonly restoreCursor = (): void => {
    if (interactive()) process.stdout.write(SHOW_CURSOR)
  }

  close(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    if (!interactive()) {
      this.channels.forEach((channel, index) => this.announce(channel, index))
      return
    }
    this.repaint()
    process.off('exit', this.restoreCursor)
    this.restoreCursor()
  }
}

export const board = (seeds: ChannelSeed[]): Board => new Board(seeds).open()
