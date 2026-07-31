import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const UPLOAD_DIR = path.join(os.homedir(), '.orbit', 'uploads')
const KEEP = 50

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

/** Drop uploads beyond the newest {@link KEEP}. */
export async function prune(): Promise<void> {
  const items = await list()
  await Promise.all(items.slice(KEEP).map((i) => fsp.rm(i.path, { force: true })))
}

export async function save(name: string, data: Buffer): Promise<string> {
  const safe = path.basename(name).replace(/[^\w.-]/g, '_').slice(0, 80) || 'image.png'
  const filePath = path.join(UPLOAD_DIR, `${Date.now()}-${safe}`)
  await fsp.writeFile(filePath, data)
  await prune()
  return filePath
}
