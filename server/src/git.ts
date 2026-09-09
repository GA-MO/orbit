import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DIFF_LIMIT = 200_000
const COMMIT_MESSAGE_MAX = 2000
const TIMEOUT_MS = 20_000
const PUSH_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const ERROR_LINES_SHOWN = 4
const MAX_UNTRACKED_FILES_SIZED = 50
const EMPTY_FILE = '/dev/null'

const NEVER_PROMPT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
const NO_ASKPASS_ENV = { GIT_ASKPASS: '', SSH_ASKPASS: '' }

const NUMSTAT_ROW = /^(\d+|-)\t(\d+|-)\t(.*)$/
const NUMSTAT_COUNTS = /^(\d+|-)\t(\d+|-)\t/
const BINARY_FILES_LINE = /^Binary files /m
const BINARY_PATCH_MARKER = 'GIT binary patch'
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/
const HUNK_BODY_LINE = /^[ +\-\\]/
const FILE_HEADER_LINE = /^(---|\+\+\+) /
const TRAILING_NEWLINE = /\n$/

const STATUS_PATH_OFFSET = 3
const DETACHED_HEAD = 'HEAD'

export interface FileChange {
  path: string
  staged: string
  worktree: string
  from: string | null
  added: number
  removed: number
  binary: boolean
}

export interface Status {
  repo: boolean
  root: string | null
  branch: string | null
  upstream: string | null
  hasRemote: boolean
  ahead: number
  behind: number
  files: FileChange[]
  head: { sha: string; subject: string } | null
}

interface LineCounts {
  added: number
  removed: number
  binary: boolean
}

class GitError extends Error {}

const firstLines = (text: string): string => text.split('\n').slice(0, ERROR_LINES_SHOWN).join('\n')

const countOf = (field: string): number => (field === '-' ? 0 : Number(field))

const noLineCounts = (): LineCounts => ({ added: 0, removed: 0, binary: false })

const run = async (cwd: string, args: string[], timeout = TIMEOUT_MS): Promise<string> => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, ...NEVER_PROMPT_ENV, ...NO_ASKPASS_ENV },
    })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; killed?: boolean; message: string }
    if (e.killed) throw new GitError(`git ${args[0]} timed out after ${timeout / 1000}s`)
    const said = (e.stderr || e.stdout || e.message).trim()
    throw new GitError(firstLines(said) || `git ${args[0]} failed`)
  }
}

const runNoIndexDiff = async (cwd: string, args: string[]): Promise<string> => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    })
    return stdout
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? ''
  }
}

const runWithInput = (cwd: string, args: string[], input: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      env: { ...process.env, ...NEVER_PROMPT_ENV },
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new GitError(e.message))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve(out)
      const said = firstLines((err || out).trim())
      reject(new GitError(said || `git ${args[0]} failed`))
    })
    child.stdin.end(input)
  })

const repoRoot = async (cwd: string): Promise<string> =>
  (await run(cwd, ['rev-parse', '--show-toplevel'])).trim()

const safeRelative = (file: string): string | null => {
  if (!file || file.startsWith('-')) return null
  const normalized = path.normalize(file)
  if (path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) return null
  return normalized
}

const parseNumstatFields = (fields: string[]): Map<string, LineCounts> => {
  const counts = new Map<string, LineCounts>()
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field) continue
    const match = field.match(NUMSTAT_ROW)
    if (!match) continue
    const [, added, removed, inlineName] = match
    const isRename = !inlineName
    const name = isRename ? fields[i + 2] || fields[i + 1] || '' : inlineName
    if (isRename) i += 2
    counts.set(name, {
      added: countOf(added),
      removed: countOf(removed),
      binary: added === '-' && removed === '-',
    })
  }
  return counts
}

const lineCountsPerFile = async (cwd: string, staged: boolean): Promise<Map<string, LineCounts>> => {
  const out = await run(cwd, [
    'diff',
    ...(staged ? ['--cached'] : []),
    '--numstat',
    '--no-color',
    '-z',
  ])
  return parseNumstatFields(out.split('\0'))
}

const untrackedFileSize = async (cwd: string, file: string): Promise<LineCounts> => {
  const out = await runNoIndexDiff(cwd, ['diff', '--no-index', '--numstat', '--', EMPTY_FILE, file])
  const match = out.match(NUMSTAT_COUNTS)
  if (!match) return noLineCounts()
  return {
    added: countOf(match[1]),
    removed: 0,
    binary: match[1] === '-',
  }
}

const readHead = async (root: string): Promise<{ sha: string; subject: string }> => {
  const line = (await run(root, ['log', '-1', '--format=%h\t%s'])).trim()
  const [sha, ...subjectParts] = line.split('\t')
  return { sha, subject: subjectParts.join('\t') }
}

const notARepository = (): Status => ({
  repo: false,
  root: null,
  branch: null,
  upstream: null,
  hasRemote: false,
  ahead: 0,
  behind: 0,
  files: [],
  head: null,
})

const isRenameOrCopy = (indexStatus: string): boolean => indexStatus === 'R' || indexStatus === 'C'

const parseStatusEntries = (
  porcelain: string,
  staged: Map<string, LineCounts>,
  unstaged: Map<string, LineCounts>,
): FileChange[] => {
  const files: FileChange[] = []
  const fields = porcelain.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry.length <= STATUS_PATH_OFFSET) continue
    const indexStatus = entry[0]
    const worktree = entry[1]
    const file = entry.slice(STATUS_PATH_OFFSET)
    let from: string | null = null
    if (isRenameOrCopy(indexStatus)) {
      from = fields[++i] ?? null
    }
    const counts = staged.get(file) ?? unstaged.get(file) ?? noLineCounts()
    files.push({ path: file, staged: indexStatus, worktree, from, ...counts })
  }
  return files
}

const sizeUntrackedFiles = async (root: string, files: FileChange[]): Promise<void> => {
  await Promise.all(
    files
      .filter((f) => f.worktree === '?')
      .slice(0, MAX_UNTRACKED_FILES_SIZED)
      .map(async (f) => Object.assign(f, await untrackedFileSize(root, f.path))),
  )
}

const upstreamCounts = async (
  root: string,
): Promise<{ upstream: string | null; ahead: number; behind: number }> => {
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  try {
    upstream = (await run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim()
    const counts = (await run(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])).trim()
    const [behindCount, aheadCount] = counts.split(/\s+/).map(Number)
    behind = behindCount || 0
    ahead = aheadCount || 0
  } catch {}
  return { upstream, ahead, behind }
}

const headOrNull = async (root: string): Promise<Status['head']> => {
  try {
    const { sha, subject } = await readHead(root)
    if (sha) return { sha, subject }
  } catch {}
  return null
}

export async function status(cwd: string): Promise<Status> {
  let root: string
  try {
    root = await repoRoot(cwd)
  } catch {
    return notARepository()
  }

  const [porcelain, branch, remotes, staged, unstaged] = await Promise.all([
    run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    run(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
    run(root, ['remote']).catch(() => ''),
    lineCountsPerFile(root, true).catch(() => new Map<string, LineCounts>()),
    lineCountsPerFile(root, false).catch(() => new Map<string, LineCounts>()),
  ])

  const files = parseStatusEntries(porcelain, staged, unstaged)
  await sizeUntrackedFiles(root, files)
  const { upstream, ahead, behind } = await upstreamCounts(root)
  const head = await headOrNull(root)

  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    repo: true,
    root,
    branch: branch.trim() || null,
    upstream,
    hasRemote: remotes.trim().length > 0,
    ahead,
    behind,
    files,
    head,
  }
}

export interface Diff {
  file: string
  patch: string
  truncated: boolean
  binary: boolean
}

const looksBinary = (patch: string): boolean =>
  BINARY_FILES_LINE.test(patch) || patch.includes(BINARY_PATCH_MARKER)

const unstagedPatch = async (root: string, relative: string): Promise<string> => {
  const patch = await run(root, ['diff', '--no-color', '--', relative])
  if (patch.trim()) return patch
  return runNoIndexDiff(root, ['diff', '--no-index', '--no-color', '--', EMPTY_FILE, relative])
}

export async function diff(cwd: string, file: string, staged: boolean): Promise<Diff> {
  const relative = safeRelative(file)
  if (!relative) throw new GitError('that path is not inside the repository')
  const root = await repoRoot(cwd)

  const patch = staged
    ? await run(root, ['diff', '--cached', '--no-color', '--', relative])
    : await unstagedPatch(root, relative)

  const binary = looksBinary(patch)
  const truncated = patch.length > DIFF_LIMIT
  return {
    file: relative,
    patch: binary ? '' : truncated ? patch.slice(0, DIFF_LIMIT) : patch,
    truncated,
    binary,
  }
}

const assertSingleHunk = (lines: string[]): void => {
  if (!HUNK_HEADER.test(lines[0] ?? '')) throw new GitError('that is not a hunk')
  for (const line of lines.slice(1)) {
    if (!HUNK_BODY_LINE.test(line) && line !== '') throw new GitError('that is not a hunk')
    if (FILE_HEADER_LINE.test(line)) throw new GitError('that is not a hunk')
  }
}

const patchForFile = (relative: string, hunkLines: string[]): string =>
  [
    `diff --git a/${relative} b/${relative}`,
    `--- a/${relative}`,
    `+++ b/${relative}`,
    ...hunkLines,
    '',
  ].join('\n')

export async function applyHunk(
  cwd: string,
  file: string,
  hunk: string,
  unstage: boolean,
): Promise<void> {
  const relative = safeRelative(file)
  if (!relative) throw new GitError('that path is not inside the repository')
  const lines = hunk.replace(TRAILING_NEWLINE, '').split('\n')
  assertSingleHunk(lines)
  const root = await repoRoot(cwd)
  const patch = patchForFile(relative, lines)
  await runWithInput(root, ['apply', '--cached', ...(unstage ? ['--reverse'] : []), '-'], patch)
}

const isMissingHead = (err: unknown): boolean => (err as Error).message.includes('HEAD')

const unstagePaths = async (root: string, paths: string[]): Promise<void> => {
  try {
    await run(root, ['restore', '--staged', '--', ...paths])
  } catch (err) {
    if (!isMissingHead(err)) throw err
    await run(root, ['rm', '--cached', '-r', '--', ...paths])
  }
}

export async function stage(cwd: string, files: string[], add: boolean): Promise<void> {
  const paths = files.map(safeRelative).filter((f): f is string => !!f)
  if (paths.length === 0) throw new GitError('no valid paths')
  const root = await repoRoot(cwd)
  if (add) {
    await run(root, ['add', '--', ...paths])
    return
  }
  await unstagePaths(root, paths)
}

export interface Commit {
  sha: string
  subject: string
  files: number
  added: number
  removed: number
}

const sumNumstat = (rows: string[]): { files: number; added: number; removed: number } => {
  let files = 0
  let added = 0
  let removed = 0
  for (const row of rows) {
    const match = row.match(NUMSTAT_COUNTS)
    if (!match) continue
    files++
    added += countOf(match[1])
    removed += countOf(match[2])
  }
  return { files, added, removed }
}

export async function commit(cwd: string, message: string): Promise<Commit> {
  const text = message.trim().slice(0, COMMIT_MESSAGE_MAX)
  if (!text) throw new GitError('a commit needs a message')
  const root = await repoRoot(cwd)
  const staged = (await run(root, ['diff', '--cached', '--name-only'])).trim()
  if (!staged) throw new GitError('nothing is staged')

  await run(root, ['commit', '-m', text])
  const { sha, subject } = await readHead(root)
  const stat = (await run(root, ['show', '--numstat', '--format=', 'HEAD'])).trim()
  return { sha, subject, ...sumNumstat(stat.split('\n')) }
}

const hasUpstream = (root: string): Promise<boolean> =>
  run(root, ['rev-parse', '--abbrev-ref', '@{upstream}']).then(
    () => true,
    () => false,
  )

export async function push(cwd: string): Promise<string> {
  const root = await repoRoot(cwd)
  const branch = (await run(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  if (!branch || branch === DETACHED_HEAD) throw new GitError('not on a branch')
  const tracked = await hasUpstream(root)
  const args = tracked ? ['push'] : ['push', '--set-upstream', 'origin', branch]
  await run(root, args, PUSH_TIMEOUT_MS)
  return tracked ? `Pushed ${branch}` : `Pushed ${branch} and set its upstream`
}
