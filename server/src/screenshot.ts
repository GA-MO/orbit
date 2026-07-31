import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { chromium, type Browser } from 'playwright-core'

const execFileAsync = promisify(execFile)

const SCREENSHOT_DIR = path.join(os.homedir(), '.orbit', 'screenshots')
const KEEP = 50
/** Chrome stays warm between captures — launching it costs about a second. */
const BROWSER_IDLE_MS = 60_000

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })

export const PRESETS = {
  phone: { label: 'Phone', width: 390, height: 844 },
  tablet: { label: 'Tablet', width: 834, height: 1112 },
  desktop: { label: 'Desktop', width: 1440, height: 900 },
} as const

export type PresetId = keyof typeof PRESETS
export const isPreset = (v: unknown): v is PresetId =>
  typeof v === 'string' && v in PRESETS

/** Where the pixels came from: a rendered URL, or the Mac's own screen. */
export type CaptureKind = 'url' | 'screen'

export interface Screenshot {
  file: string
  path: string
  createdAt: string
  size: number
  kind: CaptureKind
  /** What was captured — a host:port, or the screen. Null for older captures. */
  label: string | null
  /** Real pixel size, read from the PNG header — null if it could not be read. */
  width: number | null
  height: number | null
}

/* Thirty phone-sized thumbnails all look alike; the filename is the only place
   to keep what each one was of without inventing a database for it. */
const labelFrom = (url: string): string => {
  try {
    const { host, pathname } = new URL(url)
    /* A colon survives (host:port is the whole point of the label and reads
       badly without it); a slash cannot — it would leave the directory. */
    return `${host}${pathname === '/' ? '' : pathname}`.replace(/[^\w.:]/g, '_').slice(0, 40)
  } catch {
    return ''
  }
}

export interface CaptureOptions {
  preset?: PresetId
  width?: number
  height?: number
  fullPage?: boolean
}

// ---- Shared browser ----

let browser: Browser | null = null
let idleTimer: NodeJS.Timeout | null = null

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser
  // System Chrome via playwright-core — no bundled-browser download needed.
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  browser.on('disconnected', () => {
    browser = null
  })
  return browser
}

function touchIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    browser?.close().catch(() => {})
    browser = null
  }, BROWSER_IDLE_MS)
  idleTimer.unref?.()
}

export async function shutdown(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer)
  await browser?.close().catch(() => {})
  browser = null
}

// ---- Capture ----

/* Chrome renders its own "can't be reached" page when a dev server is down, and
   screenshotting that looks exactly like success from the phone. Navigation
   errors are net::* — those are real failures and must surface as errors. Load
   timeouts are not: apps that long-poll never reach networkidle, so those fall
   back to the weaker `load` state and still produce a usable picture. */
const NAVIGATION_FAILURE = /net::[A-Z_]+/

export async function capture(url: string, opts: CaptureOptions = {}): Promise<Screenshot> {
  const preset = PRESETS[opts.preset ?? 'phone']
  const width = opts.width ?? preset.width
  const height = opts.height ?? preset.height
  // Retina detail is worth it on phone-sized shots; on a desktop viewport it
  // only doubles an already large image.
  const deviceScaleFactor = width >= 1200 ? 1 : 2

  const page = await (await getBrowser()).newPage({ viewport: { width, height }, deviceScaleFactor })
  try {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 })
    } catch (err) {
      const message = (err as Error).message
      const netError = message.match(NAVIGATION_FAILURE)?.[0]
      if (netError) throw new Error(`${url} did not respond (${netError})`)
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {})
    }
    const file = `${Date.now()}-url-${labelFrom(url)}.png`
    const filePath = path.join(SCREENSHOT_DIR, file)
    await page.screenshot({ path: filePath, fullPage: opts.fullPage ?? false })
    await prune()
    return await describe(file)
  } finally {
    await page.close().catch(() => {})
    touchIdleTimer()
  }
}

/**
 * Capture the Mac's own screen — the things headless Chrome cannot see:
 * a simulator, Xcode, a native app the agent just built.
 */
export async function captureScreen(opts: { display?: number } = {}): Promise<Screenshot> {
  const file = `${Date.now()}-screen.png`
  const filePath = path.join(SCREENSHOT_DIR, file)
  const args = ['-x', '-t', 'png']
  if (opts.display && opts.display > 0) args.push('-D', String(opts.display))
  args.push(filePath)

  try {
    await execFileAsync('/usr/sbin/screencapture', args, { timeout: 15_000 })
  } catch (err) {
    await fsp.rm(filePath, { force: true })
    throw new Error(screenCaptureError(err as Error & { stderr?: string }))
  }

  const stat = await fsp.stat(filePath).catch(() => null)
  if (!stat?.isFile() || stat.size === 0) {
    await fsp.rm(filePath, { force: true })
    throw new Error(
      'screencapture produced no image — grant Screen Recording to the app running the Orbit server in System Settings → Privacy & Security',
    )
  }
  await prune()
  return describe(file)
}

const screenCaptureError = (err: Error & { stderr?: string }): string => {
  const detail = (err.stderr ?? err.message ?? '').trim().split('\n')[0]
  if (/not authorized|permission|denied/i.test(detail)) {
    return 'screen capture is not permitted — grant Screen Recording to the app running the Orbit server in System Settings → Privacy & Security, then restart it'
  }
  return `screen capture failed${detail ? `: ${detail}` : ''}`
}

// ---- Listing ----

export async function list(): Promise<Screenshot[]> {
  const names = (await fsp.readdir(SCREENSHOT_DIR).catch(() => [])).filter((n) => n.endsWith('.png'))
  const items = await Promise.all(names.map((file) => describe(file).catch(() => null)))
  return items
    .filter((i): i is Screenshot => i !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function describe(file: string): Promise<Screenshot> {
  const filePath = path.join(SCREENSHOT_DIR, file)
  const stat = await fsp.stat(filePath)
  const dimensions = await pngSize(filePath)
  // <timestamp>-<kind>-<label>.png; captures taken before this are URL renders.
  const [, kind, ...rest] = file.replace(/\.png$/, '').split('-')
  return {
    file,
    path: filePath,
    createdAt: stat.mtime.toISOString(),
    size: stat.size,
    kind: kind === 'screen' ? 'screen' : 'url',
    label: rest.join('-') || null,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  }
}

/* The gallery lays every capture out at its real aspect ratio, so it needs the
   pixel size. A PNG carries it in the IHDR chunk, 24 bytes in — cheaper and
   more honest than trusting the viewport we asked for (fullPage ignores it). */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

async function pngSize(filePath: string): Promise<{ width: number; height: number } | null> {
  const handle = await fsp.open(filePath, 'r').catch(() => null)
  if (!handle) return null
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(24), 0, 24, 0)
    if (bytesRead < 24 || !buffer.subarray(0, 4).equals(PNG_MAGIC)) return null
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

export function filePathFor(file: string): string | null {
  const name = path.basename(file)
  if (!/^[\w.:-]+\.png$/.test(name)) return null
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

/** Prune on server start so stale files above {@link KEEP} are removed even without new captures. */
export const pruneStale = prune
