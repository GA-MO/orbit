import fs from 'node:fs'

import { orbitDir } from './home.js'
import { qrBlock } from './qr.js'

const PORT = Number(process.env.ORBIT_PORT ?? 3001)
const QR_INDENT = '    '
const say = (line = '') => console.log(line ? `  ${line}` : '')

const storedToken = (): string | null => {
  try {
    return JSON.parse(fs.readFileSync(orbitDir('config.json'), 'utf8')).token
  } catch {
    return null
  }
}

const requestPairCode = (token: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${PORT}/api/auth/pair-code`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

const sayPairingSteps = (url: string, token: string) => {
  say()
  say('Pair a phone')
  say(url)
  say()
  console.log(qrBlock(url, QR_INDENT))
  say()
  say("1. Point the phone's camera at it — Orbit opens, already paired.")
  say('2. Share → Add to Home Screen.')
  say('3. Open that app, tap Scan QR code, point it at this same code.')
  say()
  say('Good for 10 minutes. The token, for typing instead:')
  say(token)
  say()
}

export async function runPair(): Promise<number> {
  const token = storedToken()
  if (token === null) {
    say(`No token in ${orbitDir('config.json')} — start Orbit once first.`)
    return 1
  }
  let res: Response
  try {
    res = await requestPairCode(token)
  } catch {
    say(`Orbit is not running on :${PORT} — \`orbit\` or \`orbit phone\` first.`)
    return 1
  }
  if (!res.ok) {
    say(`Orbit on :${PORT} refused (${res.status}) — is that a different install's token?`)
    return 1
  }
  const { url } = (await res.json()) as { url: string }
  sayPairingSteps(url, token)
  return 0
}
