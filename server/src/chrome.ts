import { spawn, type ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { WebSocket } from 'ws'

const EXECUTABLE_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

const NOT_INSTALLED =
  'Google Chrome was not found — install it from https://www.google.com/chrome, or point ORBIT_CHROME at a Chrome executable'
const CONNECTION_CLOSED = 'the browser closed the connection'
const NO_DEVTOOLS_ENDPOINT = 'Chrome started but never said where DevTools was listening'

const LAUNCH_ARGS = [
  '--headless=new',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-extensions',
  '--hide-scrollbars',
  '--mute-audio',
  'about:blank',
]

const DEVTOOLS_ENDPOINT = /^DevTools listening on (ws:\/\/\S+)$/m
const LAUNCH_TIMEOUT_MS = 20_000
const COMMAND_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 5000
const NETWORK_QUIET_MS = 500
const SETTLE_POLL_MS = 50
const MAX_CAPTURE_HEIGHT_PX = 16_384

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

function devtoolsEndpoint(chrome: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let said = ''
    const timer = setTimeout(() => done(new Error(NO_DEVTOOLS_ENDPOINT)), LAUNCH_TIMEOUT_MS)
    const done = (err: Error | null, endpoint?: string) => {
      clearTimeout(timer)
      chrome.stderr?.off('data', onData)
      chrome.off('exit', onExit)
      chrome.off('error', onError)
      if (err) reject(err)
      else resolve(endpoint as string)
    }
    const onData = (chunk: Buffer) => {
      said += String(chunk)
      const endpoint = said.match(DEVTOOLS_ENDPOINT)?.[1]
      if (endpoint) done(null, endpoint)
    }
    const onExit = (code: number | null) =>
      done(new Error(`Chrome exited with ${code ?? 'no code'}${said ? `: ${said.trim()}` : ''}`))
    const onError = (err: Error) =>
      done(new Error(`Chrome could not be started: ${err.message}`))
    chrome.stderr?.on('data', onData)
    chrome.once('exit', onExit)
    chrome.once('error', onError)
  })
}

function connect(endpoint: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint)
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
    const handlers = new Set<(event: Event) => void>()
    const closedListeners = new Set<() => void>()
    let nextId = 1

    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (typeof message.id !== 'number') {
        for (const handler of [...handlers]) handler(message as Event)
        return
      }
      const waiting = pending.get(message.id)
      if (!waiting) return
      pending.delete(message.id)
      if (message.error) waiting.reject(new Error(message.error.message))
      else waiting.resolve(message.result)
    })

    socket.once('error', reject)
    socket.once('close', () => {
      for (const waiting of pending.values()) waiting.reject(new Error(CONNECTION_CLOSED))
      pending.clear()
      for (const listener of [...closedListeners]) listener()
    })

    socket.once('open', () => {
      socket.off('error', reject)
      socket.on('error', () => {})
      resolve({
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
            socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
          })
        },
        listen(handler) {
          handlers.add(handler)
          return () => handlers.delete(handler)
        },
        isOpen: () => socket.readyState === WebSocket.OPEN,
        onClosed(listener) {
          closedListeners.add(listener)
        },
        close: () => socket.close(),
      })
    })
  })
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

export async function launch(): Promise<Chrome> {
  const executable = await findExecutable()
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-chrome-'))
  const chrome = spawn(executable, [...LAUNCH_ARGS, `--user-data-dir=${userDataDir}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  const discard = async (err: Error) => {
    chrome.kill('SIGKILL')
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  const endpoint = await devtoolsEndpoint(chrome).catch(discard)
  const connection = await connect(endpoint).catch(discard)
  chrome.stderr?.resume()

  let alive = true
  const exited = new Promise<void>((resolve) => chrome.once('exit', () => resolve()))
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
