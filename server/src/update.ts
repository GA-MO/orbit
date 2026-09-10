import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { packageVersion } from './banner.js'
import { COMPILED } from './launcher.js'
import { DEFAULT_PORT } from './port.js'
import { platform } from './platform/index.js'
import * as preview from './preview.js'

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
const REPLACED_SUFFIX = '.orbit-replaced'
const CHECK_FLAG = '--check'

const say = (line = '') => console.log(line ? `  ${line}` : '')

const repo = (): string => process.env.ORBIT_REPO || DEFAULT_REPO

const localReleaseDir = (): string | undefined => process.env.ORBIT_LOCAL_DIR || undefined

export const assetName = (): string => platform.releaseAssetName()

interface ReleaseAsset {
  name: string
  read: () => Promise<Buffer>
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

const downloadAsset = (asset: { id?: number; browser_download_url?: string; name: string }) => async (): Promise<Buffer> => {
  const url = process.env.GITHUB_TOKEN
    ? `${GITHUB_API}/repos/${repo()}/releases/assets/${asset.id}`
    : asset.browser_download_url
  if (!url) throw new Error(`release asset ${asset.name} has no download address`)
  const response = await askGitHub(url, GITHUB_BINARY, DOWNLOAD_TIMEOUT_MS)
  return Buffer.from(await response.arrayBuffer())
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
  if (!found) throw new Error(`release ${release.tag} carries no ${name} — nothing to install for this machine.`)
  return found
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const publishedChecksum = (text: string): string => text.trim().split(WHITESPACE)[0].toLowerCase()

const clearQuarantine = (file: string): void => platform.clearsDownloadBlock(file)

const replaceExecutable = (executable: string, bytes: Buffer): void => {
  const mode = fs.statSync(executable).mode & MODE_BITS
  const staged = `${executable}${STAGED_SUFFIX}`
  const replaced = `${executable}${REPLACED_SUFFIX}`
  fs.writeFileSync(staged, bytes)
  fs.chmodSync(staged, mode)
  clearQuarantine(staged)
  fs.rmSync(replaced, { force: true })
  fs.renameSync(executable, replaced)
  try {
    fs.renameSync(staged, executable)
  } catch (err) {
    fs.renameSync(replaced, executable)
    throw err
  }
  fs.rmSync(replaced, { force: true })
}

const sayWhatIsLeftToDo = async (): Promise<void> => {
  const frontDoor = await preview.frontDoorTargetPort()
  if (frontDoor !== null && frontDoor !== DEFAULT_PORT) {
    say(`Tailscale still proxies the front door to :${frontDoor}, not the default :${DEFAULT_PORT} — run \`orbit start\` to move it.`)
  }
  say('A Claude Code session that is already open still holds the previous MCP server — restart it to pick this one up.')
}

const refuseFromCheckout = (): number => {
  say()
  say('This orbit is running from a checkout, not from an installed executable.')
  say('Update it with git instead:  git pull && make setup')
  say()
  return 1
}

const install = async (release: Release, installed: Installed): Promise<number> => {
  const name = assetName()
  const binary = await assetOf(release, name).read()
  const checksum = await assetOf(release, `${name}.sha256`).read()
  if (sha256(binary) !== publishedChecksum(checksum.toString('utf8'))) {
    say(`The checksum of ${name} does not match the one ${release.tag} published — not installing it.`)
    say()
    return 1
  }
  replaceExecutable(installed.executable, binary)
  say(`Updated ${installed.executable} from ${installed.version} to ${withoutLeadingV(release.tag)}.`)
  await sayWhatIsLeftToDo()
  say()
  return 0
}

const whatIsThereToDo = (latest: string, installed: string): string => {
  if (isNewerThan(latest, installed)) return 'Run `orbit update` to install it.'
  if (latest === installed) return `orbit ${installed} is already the latest release of ${repo()}.`
  return `orbit ${installed} is ahead of the latest release of ${repo()} — nothing to install.`
}

export async function runUpdate(args: string[], installed: Installed = thisInstall()): Promise<number> {
  if (!installed.compiled) return refuseFromCheckout()

  let release: Release
  try {
    release = await latestRelease()
  } catch (err) {
    say()
    say((err as Error).message)
    say()
    return 1
  }

  const latest = withoutLeadingV(release.tag)
  say()

  if (args.includes(CHECK_FLAG)) {
    say(`Installed:  ${installed.version}`)
    say(`Available:  ${latest}`)
    say(whatIsThereToDo(latest, installed.version))
    say()
    return 0
  }

  if (!isNewerThan(latest, installed.version)) {
    say(whatIsThereToDo(latest, installed.version))
    say()
    return 0
  }

  try {
    return await install(release, installed)
  } catch (err) {
    say((err as Error).message)
    say()
    return 1
  }
}
