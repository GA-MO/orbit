import { lanUrl } from './banner.js'
import { LAN_OPEN } from './network.js'
import { PORT } from './port.js'
import * as preview from './preview.js'
import { listeningPids } from './stop.js'
import * as ui from './ui.js'

const SERVER_OWNS_PROCESS = -1
const say = ui.say

const sayPublished = (url: string) => {
  say()
  say('Open on phone (Tailscale VPN on):')
  say(`  ${ui.ink(ui.HORIZON, url)}`)
  say()
  ui.hint('Works in the browser or the Home Screen app.')
  ui.hint('Stop it, and the front door:  orbit stop')
}

const sayWifiDoor = () => {
  const wifi = lanUrl(PORT)
  if (wifi) {
    ui.hint('Until then, on a phone on the same Wi-Fi:')
    say(`  ${ui.ink(ui.HORIZON, `${wifi}/`)}`)
    return
  }
  ui.hint(`This Mac has no Wi-Fi address to offer a phone — http://localhost:${PORT} works on the Mac itself.`)
}

const sayHowToOpenTheWifiDoor = () => {
  ui.hint('Orbit is listening on this Mac alone, so no phone can reach it yet.')
  ui.hint('Until then, to let a phone on the same Wi-Fi in:')
  ui.hint('  orbit start --lan')
}

const sayUnpublished = (reason: string) => {
  say()
  ui.hint('Voice input and Add to Home Screen need HTTPS, so Tailscale is worth setting up later.')
  say()
  if (LAN_OPEN) sayWifiDoor()
  else sayHowToOpenTheWifiDoor()
  say()
  ui.hint(`Could not publish over Tailscale: ${reason}`)
}

export const RENAMED = 'orbit phone is now orbit start — same command, new name.'
export const RENAMED_OFF = 'orbit phone off drops the front door and leaves the server; orbit stop takes both down.'

const CHANNELS = [
  { key: 'frontDoor', label: 'front door' },
  { key: 'server', label: 'server' },
]

export async function runStart(): Promise<number> {
  ui.heading('start')
  const panel = ui.board(CHANNELS)

  panel.begin('frontDoor', `Tailscale HTTPS → localhost:${PORT} …`)
  let published: string | null = null
  let refusal: string | null = null
  try {
    published = await preview.publishFrontDoor(PORT)
    panel.pass('frontDoor', published)
  } catch (err) {
    refusal = (err as Error).message
    panel.fail('frontDoor', 'Could not publish over Tailscale')
  }

  const pids = listeningPids(PORT)
  const alreadyThere = `Port ${PORT} already in use (PID ${pids.join(', ')})`
  if (pids.length) panel.pass('server', published ? `${alreadyThere} — the address above points at it.` : `${alreadyThere}.`)
  else panel.pass('server', `about to listen on :${PORT}`)
  panel.close()

  if (published) sayPublished(published)
  if (refusal) sayUnpublished(refusal)

  if (pids.length) {
    ui.closing(`Port ${PORT} already in use (PID ${pids.join(', ')}) — nothing new was started.`)
    return 0
  }

  say()
  await import('./index.js')
  return SERVER_OWNS_PROCESS
}
