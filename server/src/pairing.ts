/**
 * Pairing a phone in one scan.
 *
 * The token must not travel in a URL: a query string is written into every
 * proxy log, referrer and history entry the address passes through, which is
 * why auth.ts pays for a session cookie rather than let that happen. But a
 * QR that only carries the token cannot be read by the phone's camera app —
 * there is no address in it to open — so pairing was "type the tailnet
 * address, then open the login screen, then scan". Three steps for one fact.
 *
 * So the QR carries an address with a *pairing code* in its fragment. The
 * fragment never leaves the browser (proxies and servers do not see it), and
 * the code is not the token: it is exchanged for one here, expires in minutes,
 * and is good for a handful of uses — because on iOS the page opened by the
 * camera and the app added to the home screen keep separate storage, and the
 * second of those has to pair too, with the same code still on the Mac's
 * screen. What survives in Safari's history is a code that has stopped
 * working by the time anyone could read it there.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import os from 'node:os'

const TTL_MS = 10 * 60 * 1000
const USES = 10

interface Code {
  code: string
  expiresAt: number
  usesLeft: number
}

const codes = new Map<string, Code>()

const sweep = (now: number) => {
  for (const [key, c] of codes) if (c.expiresAt <= now || c.usesLeft <= 0) codes.delete(key)
}

/** A fresh code, alongside any that are still good. */
export function mint(): { code: string; expiresAt: number } {
  const now = Date.now()
  sweep(now)
  const code = randomBytes(9).toString('base64url')
  const entry = { code, expiresAt: now + TTL_MS, usesLeft: USES }
  codes.set(code, entry)
  return { code, expiresAt: entry.expiresAt }
}

/** Whether this code is good right now; a yes costs it one use. */
export function redeem(candidate: string): boolean {
  const now = Date.now()
  sweep(now)
  const want = Buffer.from(candidate)
  for (const c of codes.values()) {
    const have = Buffer.from(c.code)
    if (have.length !== want.length || !timingSafeEqual(have, want)) continue
    c.usesLeft--
    return true
  }
  return false
}

/** The address the QR carries: the app, with the code where only the browser reads it. */
export const pairUrl = (base: string, code: string) => `${base.replace(/\/$/, '')}/#pair=${code}`

/* The Mac's address on the local network, for a QR when nothing is published
   on the tailnet. `localhost` is right on the Mac and wrong everywhere else. */
export function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) return nic.address
    }
  }
  return null
}
