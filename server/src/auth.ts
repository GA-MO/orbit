import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const CONFIG_FILE = path.join(os.homedir(), '.orbit', 'config.json')

/** Load the access token, generating and persisting one on first run. */
export function getToken(): string {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (typeof config.token === 'string' && config.token.length >= 8) return config.token
  } catch {
    // fall through to generate
  }
  const token = randomBytes(12).toString('base64url')
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ token }, null, 2))
  return token
}

/* ------------------------------ Browser session ------------------------------
 *
 * A WebSocket handshake and an <img src> cannot carry an Authorization header,
 * and putting the token in the query string instead writes it into every proxy
 * log, referrer and history entry the URL passes through. Those two requests
 * authenticate with a cookie instead.
 *
 * The cookie holds a hash of the token, not the token: it opens exactly these
 * two doors and is worthless as a bearer credential. Deriving it, rather than
 * minting a random id held in memory, means a phone survives a server restart —
 * which a personal server does often.
 */

export const SESSION_COOKIE = 'orbit_session'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

const sessionValue = (token: string) =>
  createHash('sha256').update(`orbit-session:${token}`).digest('hex')

export function sessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${sessionValue(token)}`,
    'Path=/',
    'HttpOnly',
    // Nothing cross-site should ever make the browser send this.
    'SameSite=Strict',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ]
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}

export function hasSessionCookie(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.cookie
  if (!header) return false
  const expected = Buffer.from(sessionValue(token))
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue
    const value = Buffer.from(part.slice(eq + 1).trim())
    return value.length === expected.length && timingSafeEqual(value, expected)
  }
  return false
}

/** Behind `tailscale serve` TLS terminates upstream, so its header is the signal. */
export const isSecureRequest = (req: http.IncomingMessage): boolean =>
  req.headers['x-forwarded-proto'] === 'https' ||
  !!(req.socket as { encrypted?: boolean }).encrypted
