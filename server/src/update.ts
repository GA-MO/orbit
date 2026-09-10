import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { packageVersion } from './version.js'
import { COMPILED } from './launcher.js'
import { DEFAULT_PORT } from './port.js'
import * as preview from './preview.js'
import * as ui from './ui.js'

const DEFAULT_REPO = 'GA-MO/orbit'
const GITHUB_API = 'https://api.github.com'
const GITHUB_JSON = 'application/vnd.github+json'
const GITHUB_BINARY = 'application/octet-stream'
const ASK_TIMEOUT_MS = 6_000
const DOWNLOAD_TIMEOUT_MS = 120_000
const MODE_BITS = 0o7777
const LEADING_V = /^v/
const WHITESPACE = /\s+/
const VERSION_SEPARATOR = '.'
const STAGED_SUFFIX = '.orbit-update'
const CHECK_FLAG = '--check'

const say = ui.say

const repo = (): string => process.env.ORBIT_REPO || DEFAULT_REPO

const localReleaseDir = (): string | undefined => process.env.ORBIT_LOCAL_DIR || undefined

export const assetName = (): string => `orbit-darwin-${os.arch() === 'arm64' ? 'arm64' : 'x64'}`

export type ArrivalReport = (received: number, total: number | null) => void

interface ReleaseAsset {
  name: string
  read: (onArrival?: ArrivalReport) => Promise<Buffer>
}

interface Release {
  tag: string
  assets: ReleaseAsset[]
}

const githubHeaders = (accept: string): Record<string, string> => ({
  Accept: accept,
  'User-Agent': 'orbit',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
})

const unreachable = (): Error =>
  new Error(`Could not reach GitHub to ask about ${repo()} — check the network and try again.`)

const refused = (status: number): Error =>
  new Error(
    `GitHub would not say what the latest release of ${repo()} is (HTTP ${status}) — if it is private, set GITHUB_TOKEN or point ORBIT_REPO somewhere readable.`,
  )

const askGitHub = async (url: string, accept: string, timeout: number): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, { headers: githubHeaders(accept), signal: AbortSignal.timeout(timeout) })
  } catch {
    throw unreachable()
  }
  if (!response.ok) throw refused(response.status)
  return response
}

const announcedLength = (response: Response): number | null => {
  const header = Number(response.headers.get('content-length'))
  return Number.isFinite(header) && header > 0 ? header : null
}

const drain = async (response: Response, onArrival: ArrivalReport): Promise<Buffer> => {
  const total = announcedLength(response)
  const chunks: Uint8Array[] = []
  let received = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
    received += chunk.byteLength
    onArrival(received, total)
  }
  return Buffer.concat(chunks)
}

const downloadAsset =
  (asset: { id?: number; browser_download_url?: string; name: string }) =>
  async (onArrival?: ArrivalReport): Promise<Buffer> => {
    const url = process.env.GITHUB_TOKEN
      ? `${GITHUB_API}/repos/${repo()}/releases/assets/${asset.id}`
      : asset.browser_download_url
    if (!url) throw new Error(`release asset ${asset.name} has no download address`)
    const response = await askGitHub(url, GITHUB_BINARY, DOWNLOAD_TIMEOUT_MS)
    if (!onArrival || !response.body) return Buffer.from(await response.arrayBuffer())
    return drain(response, onArrival)
  }

const releaseOnDisk = (dir: string): Release => ({
  tag: fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(),
  assets: fs
    .readdirSync(dir)
    .map((name) => ({ name, read: async () => fs.readFileSync(path.join(dir, name)) })),
})

const releaseFromGitHub = async (): Promise<Release> => {
  const response = await askGitHub(`${GITHUB_API}/repos/${repo()}/releases/latest`, GITHUB_JSON, ASK_TIMEOUT_MS)
  const body: any = await response.json()
  const tag: string = body?.tag_name ?? ''
  if (!tag) throw new Error(`${repo()} has no published release yet.`)
  const assets: any[] = Array.isArray(body?.assets) ? body.assets : []
  return { tag, assets: assets.map((asset) => ({ name: String(asset?.name ?? ''), read: downloadAsset(asset) })) }
}

export const latestRelease = async (): Promise<Release> => {
  const dir = localReleaseDir()
  return dir ? releaseOnDisk(dir) : releaseFromGitHub()
}

const withoutLeadingV = (tag: string): string => tag.replace(LEADING_V, '')

export const latestVersion = async (): Promise<string> => withoutLeadingV((await latestRelease()).tag)

const versionNumbers = (version: string): number[] =>
  version.split(VERSION_SEPARATOR).map((part) => Number.parseInt(part, 10) || 0)

export const isNewerThan = (candidate: string, current: string): boolean => {
  const offered = versionNumbers(candidate)
  const running = versionNumbers(current)
  const depth = Math.max(offered.length, running.length)
  for (let place = 0; place < depth; place += 1) {
    const [left, right] = [offered[place] ?? 0, running[place] ?? 0]
    if (left !== right) return left > right
  }
  return false
}

export interface Installed {
  executable: string
  compiled: boolean
  version: string
}

const thisInstall = (): Installed => ({
  executable: process.execPath,
  compiled: COMPILED,
  version: packageVersion(),
})

const assetOf = (release: Release, name: string): ReleaseAsset => {
  const found = release.assets.find((asset) => asset.name === name)
  if (!found) throw new Error(`release ${release.tag} carries no ${name} — nothing to install for this Mac.`)
  return found
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const publishedChecksum = (text: string): string => text.trim().split(WHITESPACE)[0].toLowerCase()

const clearQuarantine = (file: string): void => {
  try {
    execFileSync('xattr', ['-d', 'com.apple.quarantine', file], { stdio: 'ignore' })
  } catch {}
}

const replaceExecutable = (executable: string, bytes: Buffer): void => {
  const mode = fs.statSync(executable).mode & MODE_BITS
  const staged = `${executable}${STAGED_SUFFIX}`
  fs.writeFileSync(staged, bytes)
  fs.chmodSync(staged, mode)
  clearQuarantine(staged)
  fs.renameSync(staged, executable)
}

const whatIsLeftToDo = async (): Promise<string[]> => {
  const left: string[] = []
  const frontDoor = await preview.frontDoorTargetPort()
  if (frontDoor !== null && frontDoor !== DEFAULT_PORT) {
    left.push(`Tailscale still proxies the front door to :${frontDoor}, not the default :${DEFAULT_PORT} — run \`orbit start\` to move it.`)
  }
  left.push('A Claude Code session that is already open still holds the previous MCP server — restart it to pick this one up.')
  return left
}

const refuseFromCheckout = (installed: Installed): number => {
  ui.heading('update', installed.version)
  say('This orbit is running from a checkout, not from an installed executable.')
  ui.closing('Update it with git instead:  git pull && make setup')
  return 1
}

const CHANNELS = [
  { key: 'release', label: 'release' },
  { key: 'download', label: 'download' },
  { key: 'checksum', label: 'checksum' },
  { key: 'install', label: 'install' },
]

const SHORT_DIGEST = 12

const install = async (release: Release, installed: Installed, panel: ui.Board): Promise<number> => {
  const name = assetName()
  panel.begin('download', name)
  const binary = await assetOf(release, name).read((received, total) => {
    if (total) panel.progress('download', received / total, `${ui.bytes(received)} / ${ui.bytes(total)}`)
  })
  panel.pass('download', `${name}   ${ui.bytes(binary.length)}`)

  panel.begin('checksum')
  const checksum = await assetOf(release, `${name}.sha256`).read()
  const digest = sha256(binary)
  if (digest !== publishedChecksum(checksum.toString('utf8'))) {
    panel.fail('checksum', `not the digest ${release.tag} published`)
    panel.skip('install', 'nothing written')
    panel.close()
    ui.closing(`The checksum of ${name} does not match the one ${release.tag} published — not installing it.`)
    return 1
  }
  panel.pass('checksum', `sha256 ${digest.slice(0, SHORT_DIGEST)}…`)

  panel.begin('install', installed.executable)
  replaceExecutable(installed.executable, binary)
  panel.pass('install', installed.executable)
  panel.close()

  ui.closing(
    `Updated ${installed.executable} from ${installed.version} to ${withoutLeadingV(release.tag)}.`,
    await whatIsLeftToDo(),
  )
  return 0
}

const whatIsThereToDo = (latest: string, installed: string): string => {
  if (isNewerThan(latest, installed)) return 'Run `orbit update` to install it.'
  if (latest === installed) return `orbit ${installed} is already the latest release of ${repo()}.`
  return `orbit ${installed} is ahead of the latest release of ${repo()} — nothing to install.`
}

const runCheck = async (installed: Installed): Promise<number> => {
  ui.heading('update --check', installed.version)
  const panel = ui.board([
    { key: 'installed', label: 'installed' },
    { key: 'available', label: 'available' },
  ])
  panel.pass('installed', installed.version)
  panel.begin('available', repo())
  let latest: string
  try {
    latest = await latestVersion()
  } catch (err) {
    panel.fail('available', (err as Error).message)
    panel.close()
    ui.closing('Could not tell whether a newer release is out.')
    return 1
  }
  panel.pass('available', `${latest}  ·  ${repo()}`)
  panel.close()
  ui.closing(whatIsThereToDo(latest, installed.version))
  return 0
}

export async function runUpdate(args: string[], installed: Installed = thisInstall()): Promise<number> {
  if (!installed.compiled) return refuseFromCheckout(installed)
  if (args.includes(CHECK_FLAG)) return runCheck(installed)

  ui.heading('update', installed.version)
  const panel = ui.board(CHANNELS)
  panel.begin('release', repo())

  let release: Release
  try {
    release = await latestRelease()
  } catch (err) {
    panel.fail('release', (err as Error).message)
    panel.close()
    ui.closing('Nothing was installed.')
    return 1
  }

  const latest = withoutLeadingV(release.tag)
  panel.pass('release', `${latest}  ·  ${repo()}`)

  if (!isNewerThan(latest, installed.version)) {
    for (const key of ['download', 'checksum', 'install']) panel.skip(key, 'nothing to fetch')
    panel.close()
    ui.closing(whatIsThereToDo(latest, installed.version))
    return 0
  }

  try {
    return await install(release, installed, panel)
  } catch (err) {
    panel.close()
    ui.closing((err as Error).message)
    return 1
  }
}
