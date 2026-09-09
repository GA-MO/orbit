// A default import, not a named one: qrcode-terminal assigns a whole object to
// `module.exports`, which Node's ESM loader cannot pick apart into named exports.
import qrcode from 'qrcode-terminal'

/* -------------------------------- Pairing QR --------------------------------
 *
 * The code carries an address with a short-lived pairing code in its
 * fragment (see pairing.ts) — never the token. A token in a URL is a token
 * written into every proxy log, referrer and history entry that address
 * passes through, which auth.ts goes to some length to avoid; a code that is
 * spent or expired by the time it could be read back from history costs
 * nothing. The phone's own camera app opens it, and Orbit's login screen can
 * scan the same picture for the app added to the home screen, which on iOS
 * keeps storage of its own.
 */

/* qrcode-terminal's small mode paints light modules with the terminal's
   foreground colour and leaves dark modules as whatever the background happens
   to be. On this user's dark theme that lands the right way round by luck; on a
   light theme every module inverts, and a fair number of phone cameras simply
   refuse an inverted code. Pinning bright white on black costs two escape
   sequences per row and makes the result independent of the theme. */
const INK = '\x1b[97;40m'
const RESET = '\x1b[0m'

/* The spec asks for four modules of clear space around a code. A QR set flush
   against surrounding terminal text reads as part of the pattern and decodes
   unreliably at arm's length, which is exactly the distance this is scanned
   from. Each text row is two modules tall, so two blank rows buy four. */
const QUIET = 4

const LIGHT = '█'

/** Text as a QR block, drawn with half-blocks so one text row is two QR rows. */
export function qrBlock(text: string, indent = '  '): string {
  let art = ''
  // The callback runs synchronously; it is qrcode-terminal's only way to
  // return the string instead of printing it itself.
  qrcode.generate(text, { small: true }, (out) => {
    art = out
  })

  /* Its own border is a single module drawn half-and-half across one text row,
     which is both too thin to serve as a quiet zone and a stray dark stripe
     along the top edge. Content rows always begin and end with a full block, so
     dropping the rows without one drops exactly the border. */
  const rows = art.split('\n').filter((row) => row.includes(LIGHT))
  if (rows.length === 0) return ''

  const pad = LIGHT.repeat(QUIET - 1) // each row already carries one module of its own
  const blank = LIGHT.repeat(rows[0].length + 2 * pad.length)

  return [blank, blank, ...rows.map((row) => pad + row + pad), blank, blank]
    .map((row) => `${indent}${INK}${row}${RESET}`)
    .join('\n')
}
