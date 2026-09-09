/**
 * `orbit phone` — the server on its port, published over the tailnet as
 * https, which is what voice input and Add to Home Screen need. `tailscale
 * serve` is tailnet-only, never `funnel`: nothing here reaches the internet.
 *
 *   orbit phone        publish :3001 on https://<mac>.<tailnet>.ts.net and run
 *   orbit phone off    take the front door down (the server is left alone)
 */
import { execFileSync } from 'node:child_process'

import * as preview from './preview.js'

const PORT = Number(process.env.ORBIT_PORT ?? 3001)
const say = (line = '') => console.log(line ? `  ${line}` : '')

const listeningPids = (port: number): string[] => {
  try {
    return execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: 'pipe' })
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

export async function runPhone(args: string[]): Promise<number> {
  if (args[0] === 'off') {
    try {
      await preview.unpublishFrontDoor()
      say('Tailscale HTTPS (443) off.')
      return 0
    } catch (err) {
      say((err as Error).message)
      return 1
    }
  }

  say()
  say(`Enabling Tailscale HTTPS → localhost:${PORT} …`)
  let url: string
  try {
    url = await preview.publishFrontDoor(PORT)
  } catch (err) {
    say(`Could not publish: ${(err as Error).message}`)
    say('Is Tailscale installed and logged in, with HTTPS enabled in its admin console?')
    return 1
  }
  say()
  say('Open on phone (Tailscale VPN on):')
  say(`  ${url}`)
  say()
  say('Works in the browser or the Home Screen app.')
  say('Stop the front door:  orbit phone off')
  say()

  const pids = listeningPids(PORT)
  if (pids.length) {
    say(`Port ${PORT} already in use (PID ${pids.join(', ')}) — the address above points at it.`)
    say()
    return 0
  }
  await import('./index.js')
  return -1 // the server owns the process from here
}
