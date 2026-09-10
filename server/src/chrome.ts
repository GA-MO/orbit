import { spawn, type ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'

import { platform } from './platform/index.js'

const EXECUTABLE_CANDIDATES = platform.chromeExecutableCandidates

const NOT_INSTALLED =
  'Google Chrome was not found — install it from https://www.google.com/chrome, or point ORBIT_CHROME at a Chrome executable'
const CONNECTION_CLOSED = 'the browser closed the connection'
const STARTUP_TIMED_OUT = 'Chrome started but never answered on its DevTools pipe'

const LAUNCH_ARGS = [
  '--headless=new',
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-extensions',
  '--use-mock-keychain',
  '--password-store=basic',
  '--hide-scrollbars',
  '--mute-audio',
  'about:blank',
]

const CDP_PIPE_READ_FD = 4
const CDP_PIPE_WRITE_FD = 3
const MESSAGE_DELIMITER = '\0'
const STDERR_KEPT_CHARS = 2000
const LAUNCH_TIMEOUT_MS = 20_000
const COMMAND_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 5000
const NETWORK_QUIET_MS = 500
const SETTLE_POLL_MS = 50
const MAX_CAPTURE_HEIGHT_PX = 16_384
const PROFILE_PREFIX = 'orbit-chrome-'
const STALE_PROFILE_MS = 60 * 60_000

export interface Viewport {
  width: number
  height: number
  deviceScaleFactor: number
}

export interface Page {
  goto(url: string, timeoutMs: number): Promise<void>
  screenshot(opts: { fullPage: boolean }): Promise<Buffer>
  close(): Promise<void>
}

export interface Chrome {
  newPage(viewport: Viewport): Promise<Page>
  isConnected(): boolean
  onDisconnected(listener: () => void): void
  close(): Promise<void>
}

interface Event {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

interface Connection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>
  listen(handler: (event: Event) => void): () => void
  isOpen(): boolean
  onClosed(listener: () => void): void
  close(): void
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const exists = (file: string) =>
  fsp.access(file).then(
    () => true,
    () => false,
  )

async function findExecutable(): Promise<string> {
  const wanted = process.env.ORBIT_CHROME
  if (wanted) return wanted
  for (const candidate of EXECUTABLE_CANDIDATES) if (await exists(candidate)) return candidate
  throw new Error(NOT_INSTALLED)
}

function connect(chrome: ChildProcess): Connection {
  const toChrome = chrome.stdio[CDP_PIPE_WRITE_FD] as Writable
  const fromChrome = chrome.stdio[CDP_PIPE_READ_FD] as Readable
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  const handlers = new Set<(event: Event) => void>()
  const closedListeners = new Set<() => void>()
  let nextId = 1
  let buffered = ''

  const deliver = (text: string) => {
    const message = JSON.parse(text)
    if (typeof message.id !== 'number') {
      for (const handler of [...handlers]) handler(message as Event)
      return
    }
    const waiting = pending.get(message.id)
    if (!waiting) return
    pending.delete(message.id)
    if (message.error) waiting.reject(new Error(message.error.message))
    else waiting.resolve(message.result)
  }

  fromChrome.on('data', (chunk: Buffer) => {
    buffered += String(chunk)
    for (let end = buffered.indexOf(MESSAGE_DELIMITER); end >= 0; end = buffered.indexOf(MESSAGE_DELIMITER)) {
      const message = buffered.slice(0, end)
      buffered = buffered.slice(end + MESSAGE_DELIMITER.length)
      if (message) deliver(message)
    }
  })

  const markClosed = () => {
    for (const waiting of pending.values()) waiting.reject(new Error(CONNECTION_CLOSED))
    pending.clear()
    for (const listener of [...closedListeners]) listener()
  }
  fromChrome.once('close', markClosed)
  fromChrome.on('error', () => {})
  toChrome.on('error', () => {})

  return {
    send(method, params = {}, sessionId) {
      const id = nextId++
      return new Promise((settle, fail) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          fail(new Error(`${method} timed out`))
        }, COMMAND_TIMEOUT_MS)
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            settle(value)
          },
          reject: (err) => {
            clearTimeout(timer)
            fail(err)
          },
        })
        toChrome.write(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + MESSAGE_DELIMITER,
        )
      })
    },
    listen(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    isOpen: () => toChrome.writable,
    onClosed(listener) {
      closedListeners.add(listener)
    },
    close: () => toChrome.end(),
  }
}

async function openPage(connection: Connection, viewport: Viewport): Promise<Page> {
  const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
  const call = (method: string, params?: Record<string, unknown>) =>
    connection.send(method, params, sessionId)

  const inFlightRequests = new Set<string>()
  let loadFired = false
  const stopListening = connection.listen((event) => {
    if (event.sessionId !== sessionId) return
    const requestId = event.params?.requestId as string | undefined
    if (event.method === 'Network.requestWillBeSent' && requestId) inFlightRequests.add(requestId)
    else if (
      requestId &&
      (event.method === 'Network.loadingFinished' || event.method === 'Network.loadingFailed')
    ) {
      inFlightRequests.delete(requestId)
    } else if (event.method === 'Page.loadEventFired') loadFired = true
  })

  const setMetrics = (height: number) =>
    call('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: false,
    })

  await call('Page.enable')
  await call('Network.enable')
  await setMetrics(viewport.height)

  const settle = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs
    let quietSince: number | null = null
    while (Date.now() < deadline) {
      if (loadFired && inFlightRequests.size === 0) {
        quietSince ??= Date.now()
        if (Date.now() - quietSince >= NETWORK_QUIET_MS) return
      } else quietSince = null
      await delay(SETTLE_POLL_MS)
    }
  }

  return {
    async goto(url, timeoutMs) {
      inFlightRequests.clear()
      loadFired = false
      const { errorText } = await call('Page.navigate', { url })
      if (errorText) throw new Error(errorText)
      await settle(timeoutMs)
    },
    async screenshot({ fullPage }) {
      if (fullPage) {
        const metrics = await call('Page.getLayoutMetrics')
        const content = metrics.cssContentSize ?? metrics.contentSize
        const height = Math.min(Math.ceil(content?.height ?? viewport.height), MAX_CAPTURE_HEIGHT_PX)
        await setMetrics(Math.max(height, viewport.height))
      }
      const { data } = await call('Page.captureScreenshot', { format: 'png' })
      return Buffer.from(data, 'base64')
    },
    async close() {
      stopListening()
      await connection.send('Target.closeTarget', { targetId }).catch(() => {})
    },
  }
}

function answered(chrome: ChildProcess, connection: Connection, said: () => string): Promise<void> {
  const died = new Promise<never>((_, reject) =>
    chrome.once('exit', (code) =>
      reject(new Error(`Chrome exited with ${code ?? 'no code'}${said().trim() ? `: ${said().trim()}` : ''}`)),
    ),
  )
  const tooSlow = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(STARTUP_TIMED_OUT)), LAUNCH_TIMEOUT_MS).unref?.()
  })
  died.catch(() => {})
  tooSlow.catch(() => {})
  return Promise.race([connection.send('Browser.getVersion').then(() => {}), died, tooSlow])
}

export async function reapStaleProfiles(): Promise<number> {
  const parent = os.tmpdir()
  const names = (await fsp.readdir(parent).catch(() => [])).filter((name) =>
    name.startsWith(PROFILE_PREFIX),
  )
  const reaped = await Promise.all(
    names.map(async (name) => {
      const profile = path.join(parent, name)
      const stat = await fsp.stat(profile).catch(() => null)
      if (!stat || Date.now() - stat.mtimeMs < STALE_PROFILE_MS) return 0
      const removed = await fsp.rm(profile, { recursive: true, force: true }).then(
        () => 1,
        () => 0,
      )
      return removed
    }),
  )
  return reaped.reduce((total, one) => total + one, 0)
}

export async function launch(): Promise<Chrome> {
  const executable = await findExecutable()
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), PROFILE_PREFIX))
  const chrome = spawn(executable, [...LAUNCH_ARGS, `--user-data-dir=${userDataDir}`], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  })

  let said = ''
  chrome.stderr?.on('data', (chunk: Buffer) => {
    said = (said + String(chunk)).slice(-STDERR_KEPT_CHARS)
  })

  const exited = new Promise<void>((resolve) => chrome.once('exit', () => resolve()))
  const discard = async (err: Error) => {
    chrome.kill('SIGKILL')
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  const connection = connect(chrome)
  await answered(chrome, connection, () => said).catch(discard)

  let alive = true
  const disconnected = new Set<() => void>()
  const markGone = () => {
    if (!alive) return
    alive = false
    for (const listener of [...disconnected]) listener()
  }
  connection.onClosed(markGone)
  chrome.once('exit', markGone)

  return {
    newPage: (viewport) => openPage(connection, viewport),
    isConnected: () => alive && connection.isOpen(),
    onDisconnected(listener) {
      disconnected.add(listener)
    },
    async close() {
      await connection.send('Browser.close').catch(() => {})
      connection.close()
      await Promise.race([exited, delay(CLOSE_TIMEOUT_MS)])
      if (chrome.exitCode === null) chrome.kill('SIGKILL')
      await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}
