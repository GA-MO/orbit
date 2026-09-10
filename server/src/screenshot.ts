import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { launch, type Chrome, type Page } from './chrome.js'
import { platform } from './platform/index.js'
import { orbitDir } from './home.js'

const execFileAsync = promisify(execFile)

const SCREENSHOT_DIR = orbitDir('screenshots')
const KEEP = 50
const BROWSER_IDLE_MS = 60_000
const NAVIGATION_TIMEOUT_MS = 20_000
const SCREENCAPTURE_TIMEOUT_MS = 15_000
const MIN_VIEWPORT_PX = 200
const MAX_VIEWPORT_PX = 4000
const DESKTOP_WIDTH_PX = 1200
const RETINA_SCALE = 2
const PLAIN_SCALE = 1
const LABEL_MAX = 40
const UNSAFE_LABEL_CHARS = /[^\w.:]/g
const PNG_EXTENSION = /\.png$/
const SAFE_FILE_NAME = /^[\w.:-]+\.png$/
const NAVIGATION_FAILURE = /net::[A-Z_]+/

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const PNG_HEADER_BYTES = 24
const IHDR_WIDTH_OFFSET = 16
const IHDR_HEIGHT_OFFSET = 20

const SCREEN_RECORDING_HINT = platform.screenCaptureHint

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })

export const PRESETS = {
  phone: { label: 'Phone', width: 390, height: 844 },
  tablet: { label: 'Tablet', width: 834, height: 1112 },
  desktop: { label: 'Desktop', width: 1440, height: 900 },
} as const

export type PresetId = keyof typeof PRESETS
export const isPreset = (v: unknown): v is PresetId =>
  typeof v === 'string' && v in PRESETS

export type CaptureKind = 'url' | 'screen'

export interface Screenshot {
  file: string
  path: string
  createdAt: string
  size: number
  kind: CaptureKind
  label: string | null
  width: number | null
  height: number | null
}

const sanitize = (label: string) => label.replace(UNSAFE_LABEL_CHARS, '_').slice(0, LABEL_MAX)

const labelFrom = (url: string): string => {
  try {
    const { host, pathname } = new URL(url)
    return sanitize(`${host}${pathname === '/' ? '' : pathname}`)
  } catch {
    return ''
  }
}

export interface CaptureOptions {
  preset?: PresetId
  width?: number
  height?: number
  fullPage?: boolean
  label?: string
}

let browser: Chrome | null = null
let launching: Promise<Chrome> | null = null
let idleTimer: NodeJS.Timeout | null = null
let inFlight = 0

async function getBrowser(): Promise<Chrome> {
  if (browser?.isConnected()) return browser
  if (launching) return launching
  launching = launch()
    .then((b) => {
      browser = b
      b.onDisconnected(() => {
        if (browser === b) browser = null
      })
      return b
    })
    .finally(() => {
      launching = null
    })
  return launching
}

function closeBrowserWhenIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  if (inFlight > 0) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (inFlight > 0) return
    browser?.close().catch(() => {})
    browser = null
  }, BROWSER_IDLE_MS)
  idleTimer.unref?.()
}

const beginCapture = () => {
  inFlight++
  if (idleTimer) clearTimeout(idleTimer)
}

const endCapture = () => {
  inFlight--
  closeBrowserWhenIdle()
}

export async function shutdown(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer)
  const b = browser ?? (await launching?.catch(() => null)) ?? null
  await b?.close().catch(() => {})
  browser = null
}

const clampViewport = (requested: number | undefined, fallback: number): number =>
  Number.isFinite(requested)
    ? Math.min(Math.max(Math.round(requested as number), MIN_VIEWPORT_PX), MAX_VIEWPORT_PX)
    : fallback

const scaleFactorFor = (width: number): number => (width >= DESKTOP_WIDTH_PX ? PLAIN_SCALE : RETINA_SCALE)

const navigateOrSettleForLoad = async (page: Page, url: string): Promise<void> => {
  try {
    await page.goto(url, NAVIGATION_TIMEOUT_MS)
  } catch (err) {
    const netError = (err as Error).message.match(NAVIGATION_FAILURE)?.[0]
    if (netError) throw new Error(`${url} did not respond (${netError})`)
    throw err
  }
}

const urlCaptureFileName = (url: string, label: string | undefined): string =>
  `${Date.now()}-url-${label ? sanitize(label) : labelFrom(url)}.png`

export async function capture(url: string, opts: CaptureOptions = {}): Promise<Screenshot> {
  const preset = PRESETS[opts.preset ?? 'phone']
  const width = clampViewport(opts.width, preset.width)
  const height = clampViewport(opts.height, preset.height)
  const deviceScaleFactor = scaleFactorFor(width)

  beginCapture()
  let page: Page
  try {
    page = await (await getBrowser()).newPage({ width, height, deviceScaleFactor })
  } catch (err) {
    endCapture()
    throw err
  }
  try {
    await navigateOrSettleForLoad(page, url)
    const file = urlCaptureFileName(url, opts.label)
    const filePath = path.join(SCREENSHOT_DIR, file)
    await fsp.writeFile(filePath, await page.screenshot({ fullPage: opts.fullPage ?? false }))
    await prune()
    return await describe(file)
  } finally {
    await page.close().catch(() => {})
    endCapture()
  }
}

export async function captureScreen(opts: { display?: number } = {}): Promise<Screenshot> {
  const file = `${Date.now()}-screen.png`
  const filePath = path.join(SCREENSHOT_DIR, file)

  try {
    const capture = platform.capturesWholeScreen(filePath, opts.display)
    await execFileAsync(capture.file, capture.args, { timeout: SCREENCAPTURE_TIMEOUT_MS })
  } catch (err) {
    await fsp.rm(filePath, { force: true })
    throw new Error(screenCaptureError(err as Error & { stderr?: string }))
  }

  const stat = await fsp.stat(filePath).catch(() => null)
  if (!stat?.isFile() || stat.size === 0) {
    await fsp.rm(filePath, { force: true })
    throw new Error(`the screen capture produced no image — ${SCREEN_RECORDING_HINT}`)
  }
  await prune()
  return describe(file)
}

const screenCaptureError = (err: Error & { stderr?: string }): string => {
  const detail = (err.stderr ?? err.message ?? '').trim().split('\n')[0]
  if (platform.screenCapturePermissionRefused.test(detail)) {
    return `screen capture is not permitted — ${SCREEN_RECORDING_HINT}, then restart it`
  }
  return `screen capture failed${detail ? `: ${detail}` : ''}`
}

export async function list(): Promise<Screenshot[]> {
  const names = (await fsp.readdir(SCREENSHOT_DIR).catch(() => [])).filter((n) => n.endsWith('.png'))
  const items = await Promise.all(names.map((file) => describe(file).catch(() => null)))
  return items
    .filter((i): i is Screenshot => i !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

const parseFileName = (file: string): { kind: CaptureKind; label: string | null } => {
  const [, kind, ...labelParts] = file.replace(PNG_EXTENSION, '').split('-')
  return {
    kind: kind === 'screen' ? 'screen' : 'url',
    label: labelParts.join('-') || null,
  }
}

async function describe(file: string): Promise<Screenshot> {
  const filePath = path.join(SCREENSHOT_DIR, file)
  const stat = await fsp.stat(filePath)
  const dimensions = await pngSize(filePath)
  const { kind, label } = parseFileName(file)
  return {
    file,
    path: filePath,
    createdAt: stat.mtime.toISOString(),
    size: stat.size,
    kind,
    label,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  }
}

async function pngSize(filePath: string): Promise<{ width: number; height: number } | null> {
  const handle = await fsp.open(filePath, 'r').catch(() => null)
  if (!handle) return null
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(PNG_HEADER_BYTES), 0, PNG_HEADER_BYTES, 0)
    if (bytesRead < PNG_HEADER_BYTES || !buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return null
    return { width: buffer.readUInt32BE(IHDR_WIDTH_OFFSET), height: buffer.readUInt32BE(IHDR_HEIGHT_OFFSET) }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

export function filePathFor(file: string): string | null {
  const name = path.basename(file)
  if (!SAFE_FILE_NAME.test(name)) return null
  return path.join(SCREENSHOT_DIR, name)
}

export function remove(file: string): Promise<void> {
  const p = filePathFor(file)
  return p ? fsp.rm(p, { force: true }) : Promise.resolve()
}

async function prune() {
  const items = await list()
  await Promise.all(items.slice(KEEP).map((s) => fsp.rm(s.path, { force: true })))
}

export const pruneStale = prune
