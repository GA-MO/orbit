import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { orbitDir } from './home.js'

const UPLOAD_DIR = orbitDir('uploads')
const KEEP = 50
const NAME_MAX = 80
const DEFAULT_NAME = 'image.png'
const UNSAFE_NAME_CHARS = /[^\w.-]/g

export const LIMIT = 20 * 1024 * 1024

fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const list = async () => {
  const names = await fsp.readdir(UPLOAD_DIR).catch(() => [] as string[])
  const items = await Promise.all(
    names.map(async (file) => {
      const filePath = path.join(UPLOAD_DIR, file)
      const stat = await fsp.stat(filePath).catch(() => null)
      if (!stat?.isFile()) return null
      return { file, path: filePath, createdAt: stat.mtime.toISOString() }
    }),
  )
  return items
    .filter((i): i is NonNullable<typeof i> => i !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function prune(): Promise<void> {
  const items = await list()
  await Promise.all(items.slice(KEEP).map((i) => fsp.rm(i.path, { force: true })))
}

const safeFileName = (name: string): string =>
  path.basename(name).replace(UNSAFE_NAME_CHARS, '_').slice(0, NAME_MAX) || DEFAULT_NAME

export async function save(name: string, data: Buffer): Promise<string> {
  const filePath = path.join(UPLOAD_DIR, `${Date.now()}-${safeFileName(name)}`)
  await fsp.writeFile(filePath, data)
  await prune()
  return filePath
}
