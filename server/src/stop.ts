import { setTimeout as wait } from 'node:timers/promises'

import { PORT } from './port.js'
import { platform } from './platform/index.js'
import * as preview from './preview.js'

const GRACE_MS = 300
const RELEASE_POLL_MS = 50

const say = (line = '') => console.log(line ? `  ${line}` : '')

export const listeningPids = (port: number): string[] => platform.pidsListeningOn(port)

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

export async function runStop(port: number = PORT): Promise<number> {
  say()
  const pids = listeningPids(port)
  if (pids.length === 0) {
    say(`Nothing listening on :${port}.`)
  } else {
    say(`Stopping PID ${pids.join(', ')} on :${port} …`)
    signal(pids, 'SIGTERM')
    const stubborn = await waitForRelease(port)
    if (stubborn.length) {
      say(`Still there — force-killing PID ${stubborn.join(', ')}.`)
      signal(stubborn, 'SIGKILL')
      await waitForRelease(port)
    } else {
      say(`Stopped PID ${pids.join(', ')}.`)
    }
  }

  await takeFrontDoorDown()

  const held = listeningPids(port)
  if (held.length) {
    say(`Port ${port} is still held by PID ${held.join(', ')}.`)
    say()
    return 1
  }
  say()
  return 0
}
