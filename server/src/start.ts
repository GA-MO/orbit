import { lanUrl } from './banner.js'
import { LAN_OPEN } from './network.js'
import { PORT } from './port.js'
import * as preview from './preview.js'
import { listeningPids } from './stop.js'

const SERVER_OWNS_PROCESS = -1
const say = (line = '') => console.log(line ? `  ${line}` : '')

const sayPublished = (url: string) => {
  say()
  say('Open on phone (Tailscale VPN on):')
  say(`  ${url}`)
  say()
  say('Works in the browser or the Home Screen app.')
  say('Stop it, and the front door:  orbit stop')
  say()
}

const sayWifiDoor = () => {
  const wifi = lanUrl(PORT)
  if (wifi) {
    say('Until then, on a phone on the same Wi-Fi:')
    say(`  ${wifi}/`)
    return
  }
  say(`This machine has no Wi-Fi address to offer a phone — http://localhost:${PORT} works on it directly.`)
}

const sayHowToOpenTheWifiDoor = () => {
  say('Orbit is listening on this machine alone, so no phone can reach it yet.')
  say('Until then, to let a phone on the same Wi-Fi in:')
  say('  orbit start --lan')
}

const sayUnpublished = (reason: string) => {
  say()
  say(`Could not publish over Tailscale: ${reason}`)
  say('Voice input and Add to Home Screen need HTTPS, so Tailscale is worth setting up later.')
  say()
  if (LAN_OPEN) sayWifiDoor()
  else sayHowToOpenTheWifiDoor()
  say()
}

export const RENAMED = 'orbit phone is now orbit start — same command, new name.'
export const RENAMED_OFF = 'orbit phone off drops the front door and leaves the server; orbit stop takes both down.'

export async function runStart(): Promise<number> {
  say()
  say(`Enabling Tailscale HTTPS → localhost:${PORT} …`)
  let published: string | null = null
  try {
    published = await preview.publishFrontDoor(PORT)
  } catch (err) {
    sayUnpublished((err as Error).message)
  }
  if (published) sayPublished(published)

  const pids = listeningPids(PORT)
  if (pids.length) {
    say(`Port ${PORT} already in use (PID ${pids.join(', ')}) — the address above points at it.`)
    say()
    return 0
  }
  await import('./index.js')
  return SERVER_OWNS_PROCESS
}
