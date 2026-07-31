import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const SCREENSHOT_DIR = path.join(os.homedir(), '.orbit', 'screenshots')
const KEEP = 50

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })

export interface Screenshot {
  file: string
  path: string
  createdAt: string
  size: number
}

export async function capture(
  url: string,
  opts: { width?: number; height?: number; fullPage?: boolean } = {},
): Promise<Screenshot> {
  // System Chrome via playwright-core — no bundled-browser download needed.
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({
      viewport: { width: opts.width ?? 390, height: opts.height ?? 844 },
      deviceScaleFactor: 2,
    })
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 }).catch(async () => {
      // networkidle can hang on long-polling apps — fall back to load state
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {})
    })
    const file = `${Date.now()}.png`
    const filePath = path.join(SCREENSHOT_DIR, file)
    await page.screenshot({ path: filePath, fullPage: opts.fullPage ?? false })
    await prune()
    const stat = await fsp.stat(filePath)
    return { file, path: filePath, createdAt: stat.mtime.toISOString(), size: stat.size }
  } finally {
    await browser.close()
  }
}

export async function list(): Promise<Screenshot[]> {
  const names = (await fsp.readdir(SCREENSHOT_DIR).catch(() => [])).filter((n) =>
    n.endsWith('.png'),
  )
  const items = await Promise.all(
    names.map(async (file) => {
      const filePath = path.join(SCREENSHOT_DIR, file)
      const stat = await fsp.stat(filePath)
      return { file, path: filePath, createdAt: stat.mtime.toISOString(), size: stat.size }
    }),
  )
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function filePathFor(file: string): string | null {
  const name = path.basename(file)
  if (!/^[\w.-]+\.png$/.test(name)) return null
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
