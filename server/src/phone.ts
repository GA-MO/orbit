import { execFileSync } from 'node:child_process'

import * as preview from './preview.js'

const PORT = Number(process.env.ORBIT_PORT ?? 3001)
const SERVER_OWNS_PROCESS = -1
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

const takeFrontDoorDown = async (): Promise<number> => {
  try {
    await preview.unpublishFrontDoor()
    say('Tailscale HTTPS (443) off.')
    return 0
  } catch (err) {
    say((err as Error).message)
    return 1
  }
}

const sayPublished = (url: string) => {
  say()
  say('Open on phone (Tailscale VPN on):')
  say(`  ${url}`)
  say()
  say('Works in the browser or the Home Screen app.')
  say('Stop the front door:  orbit phone off')
  say()
}

export async function runPhone(args: string[]): Promise<number> {
  if (args[0] === 'off') return takeFrontDoorDown()

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
  sayPublished(url)

  const pids = listeningPids(PORT)
  if (pids.length) {
    say(`Port ${PORT} already in use (PID ${pids.join(', ')}) — the address above points at it.`)
    say()
    return 0
  }
  await import('./index.js')
  return SERVER_OWNS_PROCESS
}
