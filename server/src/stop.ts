import { execFileSync } from 'node:child_process'
import { setTimeout as wait } from 'node:timers/promises'

import { PORT } from './port.js'
import * as preview from './preview.js'
import * as ui from './ui.js'

const GRACE_MS = 300
const RELEASE_POLL_MS = 50

const say = ui.say

export const listeningPids = (port: number): string[] => {
  try {
    return execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: 'pipe' })
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

export const takeFrontDoorDown = async (): Promise<number> => {
  try {
    await preview.unpublishFrontDoor()
    say('Tailscale HTTPS (443) off.')
    return 0
  } catch (err) {
    say((err as Error).message)
    return 1
  }
}

const signal = (pids: string[], sig: NodeJS.Signals): void => {
  for (const pid of pids) {
    try {
      process.kill(Number(pid), sig)
    } catch {}
  }
}

const waitForRelease = async (port: number): Promise<string[]> => {
  const until = Date.now() + GRACE_MS
  let left = listeningPids(port)
  while (left.length && Date.now() < until) {
    await wait(RELEASE_POLL_MS)
    left = listeningPids(port)
  }
  return left
}

const CHANNELS = [
  { key: 'server', label: 'server' },
  { key: 'frontDoor', label: 'front door' },
]

const stopTheServer = async (port: number, panel: ui.Board): Promise<void> => {
  const pids = listeningPids(port)
  if (pids.length === 0) {
    panel.skip('server', `Nothing listening on :${port}.`)
    return
  }
  panel.begin('server', `Stopping PID ${pids.join(', ')} on :${port} …`)
  signal(pids, 'SIGTERM')
  const stubborn = await waitForRelease(port)
  if (!stubborn.length) {
    panel.pass('server', `Stopped PID ${pids.join(', ')} on :${port}.`)
    return
  }
  panel.begin('server', `Still there — force-killing PID ${stubborn.join(', ')}.`)
  signal(stubborn, 'SIGKILL')
  await waitForRelease(port)
  panel.pass('server', `Stopped PID ${pids.join(', ')} on :${port}, the hard way.`)
}

const dropTheFrontDoor = async (panel: ui.Board): Promise<void> => {
  panel.begin('frontDoor', 'asking Tailscale …')
  try {
    await preview.unpublishFrontDoor()
    panel.pass('frontDoor', 'Tailscale HTTPS (443) off.')
  } catch (err) {
    panel.fail('frontDoor', (err as Error).message)
  }
}

export async function runStop(port: number = PORT): Promise<number> {
  ui.heading('stop')
  const panel = ui.board(CHANNELS)

  await stopTheServer(port, panel)
  await dropTheFrontDoor(panel)
  panel.close()

  const held = listeningPids(port)
  if (held.length) {
    ui.closing(`Port ${port} is still held by PID ${held.join(', ')}.`)
    return 1
  }
  ui.closing(`Nothing of Orbit is listening on :${port} any more.`)
  return 0
}
