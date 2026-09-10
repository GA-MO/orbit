import fs from 'node:fs'

import { PORT } from './port.js'
import { orbitDir } from './home.js'
import { qrBlock } from './qr.js'
import * as ui from './ui.js'

const QR_INDENT = '    '
const say = ui.say

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
  ui.heading('pair')
  say(ui.ink(ui.ACCENT, url))
  say()
  console.log(qrBlock(url, QR_INDENT))
  say()
  ui.hint("1. Point the phone's camera at it — Orbit opens, already paired.")
  ui.hint('2. Share → Add to Home Screen.')
  ui.hint('3. Open that app, tap Scan QR code, point it at this same code.')
  ui.closing(`Good for 10 minutes. The token, for typing instead:  ${token}`)
}

const refuse = (reason: string): number => {
  ui.heading('pair')
  ui.alarm(reason)
  say()
  return 1
}

export async function runPair(): Promise<number> {
  const token = storedToken()
  if (token === null) return refuse(`No token in ${orbitDir('config.json')} — start Orbit once first.`)
  let res: Response
  try {
    res = await requestPairCode(token)
  } catch {
    return refuse(`Orbit is not running on :${PORT} — \`orbit\` or \`orbit start\` first.`)
  }
  if (!res.ok) {
    return refuse(`Orbit on :${PORT} refused (${res.status}) — is that a different install's token?`)
  }
  const { url } = (await res.json()) as { url: string }
  sayPairingSteps(url, token)
  return 0
}
