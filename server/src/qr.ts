import qrcode from 'qrcode-terminal'

const INK = '\x1b[97;40m'
const RESET = '\x1b[0m'

const QUIET = 4
const LIGHT = '█'
const OWN_MARGIN_MODULES = 1

const renderSmall = (text: string): string => {
  let art = ''
  qrcode.generate(text, { small: true }, (out) => {
    art = out
  })
  return art
}

const contentRows = (art: string): string[] => art.split('\n').filter((row) => row.includes(LIGHT))

export function qrBlock(text: string, indent = '  '): string {
  const rows = contentRows(renderSmall(text))
  if (rows.length === 0) return ''

  const pad = LIGHT.repeat(QUIET - OWN_MARGIN_MODULES)
  const blank = LIGHT.repeat(rows[0].length + 2 * pad.length)

  return [blank, blank, ...rows.map((row) => pad + row + pad), blank, blank]
    .map((row) => `${indent}${INK}${row}${RESET}`)
    .join('\n')
}
