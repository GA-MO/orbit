/**
 * `orbit pair` — a fresh pairing QR for the server that is already running.
 *
 * The code the server printed at start is good for ten minutes; this asks it
 * for another, with the same token that everything on this Mac already
 * holds, and draws it where the last one was.
 */
import fs from 'node:fs'

import { orbitDir } from './home.js'
import { qrBlock } from './qr.js'

const PORT = Number(process.env.ORBIT_PORT ?? 3001)
const say = (line = '') => console.log(line ? `  ${line}` : '')

export async function runPair(): Promise<number> {
  let token: string
  try {
    token = JSON.parse(fs.readFileSync(orbitDir('config.json'), 'utf8')).token
  } catch {
    say(`No token in ${orbitDir('config.json')} — start Orbit once first.`)
    return 1
  }
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/api/auth/pair-code`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    say(`Orbit is not running on :${PORT} — \`orbit\` or \`orbit phone\` first.`)
    return 1
  }
  if (!res.ok) {
    say(`Orbit on :${PORT} refused (${res.status}) — is that a different install's token?`)
    return 1
  }
  const { url } = (await res.json()) as { url: string }
  say()
  say('Pair a phone')
  say(url)
  say()
  console.log(qrBlock(url, '    '))
  say()
  say("Point the phone's camera at it — good for 10 minutes. The token, for typing:")
  say(token)
  say()
  return 0
}
