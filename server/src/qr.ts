// A default import, not a named one: qrcode-terminal assigns a whole object to
// `module.exports`, which Node's ESM loader cannot pick apart into named exports.
import qrcode from 'qrcode-terminal'

/* --------------------------------- Token QR ---------------------------------
 *
 * The code carries the bare token and nothing else — not a URL. Orbit is now
 * reached through `tailscale serve`, and a token in a query string is a token
 * written into every proxy log, referrer and history entry that address passes
 * through; auth.ts pays for a session cookie rather than let that happen, and a
 * QR encoding `https://host/?token=…` would have undone the whole arrangement
 * for the sake of one fewer tap. The scanner lives inside Orbit's own login
 * screen: it reads the token out of the camera and drops it in the field, so
 * the token never becomes part of an address at all.
 *
 * What that costs is that pointing the iOS Camera app at this does nothing —
 * there is no link for it to offer. That is the intended shape rather than a
 * gap to close later. A QR that opened Safari would in any case have signed in
 * the wrong Orbit: on iOS a home-screen app keeps storage separate from
 * Safari's, and the token is only worth anything in the one doing the asking.
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

/** The token as a QR block, drawn with half-blocks so one text row is two QR rows. */
export function tokenQr(token: string, indent = '  '): string {
  let art = ''
  // The callback runs synchronously; it is qrcode-terminal's only way to
  // return the string instead of printing it itself.
  qrcode.generate(token, { small: true }, (out) => {
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
