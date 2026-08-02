/**
 * What the agent actually changed — the half of the loop the phone was missing.
 *
 * Everything else in Orbit answers "what is it doing" and "how does it look".
 * Neither answers "what did it write", and the only way to ask that from a
 * phone was `git diff` in the terminal: a pager on a 390px screen, wrapped to
 * ribbons, with no way to jump between files and nothing to press at the end
 * of it. So the same questions are asked here through porcelain that is meant
 * to be parsed, and answered as a list you can tap.
 *
 * Every call is `git -C <cwd>` with arguments passed as an array — no shell, so
 * a folder or a branch with a space in it is not a command. The caller has
 * already checked that the folder is inside the home directory.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** A diff nobody is going to read on a phone. Past this it is truncated. */
const DIFF_LIMIT = 200_000
/** Generated lockfiles routinely blow past this; the summary still counts them. */
const COMMIT_MESSAGE_MAX = 2000
/** Long enough for a slow repo, short enough that a hung push is not forever. */
const TIMEOUT_MS = 20_000
/** A push that needs a password has nobody to type it — see `run`. */
const PUSH_TIMEOUT_MS = 60_000

export interface FileChange {
  path: string
  /** Index status letter, or a space when the file is not staged at all. */
  staged: string
  /** Working-tree status letter, `?` for untracked. */
  worktree: string
  /** Where a rename came from, for the row to say so. */
  from: string | null
  added: number
  removed: number
  /** git could not count lines: a binary file, or one too large to diff. */
  binary: boolean
}

export interface Status {
  repo: boolean
  /** Absolute path of the repository root, which may be above the session's cwd. */
  root: string | null
  branch: string | null
  upstream: string | null
  /** Whether there is anywhere to push to at all. */
  hasRemote: boolean
  ahead: number
  behind: number
  files: FileChange[]
  /** The commit the changes sit on top of, so a commit can be seen to land. */
  head: { sha: string; subject: string } | null
}

class GitError extends Error {}

/*  A git that asks a question has nobody to answer it: this runs with no tty,
    and a credential prompt would sit there until the timeout — reported as
    "git took too long" rather than "your remote wants a password". Refusing to
    prompt at all turns that into git's own error message, which says so. */
const run = async (cwd: string, args: string[], timeout = TIMEOUT_MS): Promise<string> => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
      },
    })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; killed?: boolean; message: string }
    if (e.killed) throw new GitError(`git ${args[0]} timed out after ${timeout / 1000}s`)
    const said = (e.stderr || e.stdout || e.message).trim()
    throw new GitError(said.split('\n').slice(0, 4).join('\n') || `git ${args[0]} failed`)
  }
}

/* `--no-index` is git's file-comparison mode rather than its repository mode,
   and it reports "these differ" by exiting 1 — which for every call made here
   is the expected answer, not a failure. The output is the point. */
const runDiffingFiles = async (cwd: string, args: string[]): Promise<string> => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? ''
  }
}

/** Anything that would climb out of the repo, or be read as an option. */
const safeRelative = (file: string): string | null => {
  if (!file || file.startsWith('-')) return null
  const normalized = path.normalize(file)
  if (path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) return null
  return normalized
}

/* `--numstat` counts lines per file, and answers `-` `-` for a binary. Two
   calls rather than one because staged and unstaged are two different diffs of
   the same file, and a row that showed their sum could not be believed. */
const numstat = async (cwd: string, staged: boolean) => {
  const out = await run(cwd, [
    'diff',
    ...(staged ? ['--cached'] : []),
    '--numstat',
    '--no-color',
    '-z',
  ])
  /* `-z` makes renames three fields (counts, old, new) and everything else two,
     with NUL after each — including after the counts line of a rename. */
  const parts = out.split('\0')
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>()
  for (let i = 0; i < parts.length; i++) {
    const field = parts[i]
    if (!field) continue
    const match = field.match(/^(\d+|-)\t(\d+|-)\t(.*)$/)
    if (!match) continue
    const [, a, r, inlineName] = match
    // A rename spells its two names in the next two fields instead of inline.
    const name = inlineName || parts[i + 2] || parts[i + 1] || ''
    if (!inlineName) i += 2
    counts.set(name, {
      added: a === '-' ? 0 : Number(a),
      removed: r === '-' ? 0 : Number(r),
      binary: a === '-' && r === '-',
    })
  }
  return counts
}

/** An untracked file has no diff to count, so its whole content is the addition. */
const untrackedSize = async (cwd: string, file: string) => {
  const out = await runDiffingFiles(cwd, ['diff', '--no-index', '--numstat', '--', '/dev/null', file])
  const match = out.match(/^(\d+|-)\t(\d+|-)\t/)
  if (!match) return { added: 0, removed: 0, binary: false }
  return {
    added: match[1] === '-' ? 0 : Number(match[1]),
    removed: 0,
    binary: match[1] === '-',
  }
}

export async function status(cwd: string): Promise<Status> {
  let root: string
  try {
    root = (await run(cwd, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    // Not a repository — the tab says so rather than reporting an error.
    return {
      repo: false,
      root: null,
      branch: null,
      upstream: null,
      hasRemote: false,
      ahead: 0,
      behind: 0,
      files: [],
      head: null,
    }
  }

  const [porcelain, branch, remotes, staged, unstaged] = await Promise.all([
    run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    run(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
    run(root, ['remote']).catch(() => ''),
    numstat(root, true).catch(() => new Map()),
    numstat(root, false).catch(() => new Map()),
  ])

  const files: FileChange[] = []
  const fields = porcelain.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry.length < 4) continue
    const staged_ = entry[0]
    const worktree = entry[1]
    let file = entry.slice(3)
    let from: string | null = null
    // A rename puts its old path in the field that follows.
    if (staged_ === 'R' || staged_ === 'C') {
      from = fields[++i] ?? null
    }
    const counts = staged.get(file) ??
      unstaged.get(file) ?? { added: 0, removed: 0, binary: false }
    files.push({ path: file, staged: staged_, worktree, from, ...counts })
  }

  // Untracked files are in no diff, so their size is counted one at a time —
  // capped, because a stray node_modules is thousands of them.
  await Promise.all(
    files
      .filter((f) => f.worktree === '?')
      .slice(0, 50)
      .map(async (f) => Object.assign(f, await untrackedSize(root, f.path))),
  )

  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  try {
    upstream = (await run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim()
    const counts = (await run(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])).trim()
    const [b, a] = counts.split(/\s+/).map(Number)
    behind = b || 0
    ahead = a || 0
  } catch {
    // No upstream (a fresh branch): pushing it is still possible, see `push`.
  }

  let head: Status['head'] = null
  try {
    const line = (await run(root, ['log', '-1', '--format=%h\t%s'])).trim()
    const [sha, ...rest] = line.split('\t')
    if (sha) head = { sha, subject: rest.join('\t') }
  } catch {
    // A repository with no commits yet.
  }

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
  /** Unified diff text, or empty when there is nothing on this side. */
  patch: string
  truncated: boolean
  binary: boolean
}

export async function diff(cwd: string, file: string, staged: boolean): Promise<Diff> {
  const relative = safeRelative(file)
  if (!relative) throw new GitError('that path is not inside the repository')
  const root = (await run(cwd, ['rev-parse', '--show-toplevel'])).trim()

  let patch: string
  if (staged) {
    patch = await run(root, ['diff', '--cached', '--no-color', '--', relative])
  } else {
    patch = await run(root, ['diff', '--no-color', '--', relative])
    /* An untracked file produces nothing from a plain `diff` — it is not in the
       index for git to compare against. Held up against /dev/null it shows as
       what it is: entirely new. */
    if (!patch.trim()) {
      patch = await runDiffingFiles(root, ['diff', '--no-index', '--no-color', '--', '/dev/null', relative])
    }
  }

  const binary = /^Binary files /m.test(patch) || patch.includes('GIT binary patch')
  const truncated = patch.length > DIFF_LIMIT
  return {
    file: relative,
    patch: binary ? '' : truncated ? patch.slice(0, DIFF_LIMIT) : patch,
    truncated,
    binary,
  }
}

/** Stage or unstage a set of paths. Returns nothing useful; the caller refetches. */
export async function stage(cwd: string, files: string[], add: boolean): Promise<void> {
  const paths = files.map(safeRelative).filter((f): f is string => !!f)
  if (paths.length === 0) throw new GitError('no valid paths')
  const root = (await run(cwd, ['rev-parse', '--show-toplevel'])).trim()
  if (add) {
    await run(root, ['add', '--', ...paths])
    return
  }
  /* `restore --staged` needs something to restore *from*, and on a repository
     with no commits there is no HEAD to name. `rm --cached` is the same move
     there: take it out of the index, leave the file alone. */
  try {
    await run(root, ['restore', '--staged', '--', ...paths])
  } catch (err) {
    if (!(err as Error).message.includes('HEAD')) throw err
    await run(root, ['rm', '--cached', '-r', '--', ...paths])
  }
}

export interface Commit {
  sha: string
  subject: string
  /** What the commit ended up holding, for the phone to say in one line. */
  files: number
  added: number
  removed: number
}

export async function commit(cwd: string, message: string): Promise<Commit> {
  const text = message.trim().slice(0, COMMIT_MESSAGE_MAX)
  if (!text) throw new GitError('a commit needs a message')
  const root = (await run(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const staged = (await run(root, ['diff', '--cached', '--name-only'])).trim()
  if (!staged) throw new GitError('nothing is staged')

  /* `-m` rather than an editor, and no `-a`: what gets committed is exactly
     what the list on the phone showed as staged. */
  await run(root, ['commit', '-m', text])
  const line = (await run(root, ['log', '-1', '--format=%h\t%s'])).trim()
  const [sha, ...rest] = line.split('\t')
  /* Counted rather than quoted: git's own "2 files changed, 4 insertions(+), 3
     deletions(-)" wraps to four lines in a toast on a 390px screen. */
  const stat = (await run(root, ['show', '--numstat', '--format=', 'HEAD'])).trim()
  let files = 0
  let added = 0
  let removed = 0
  for (const row of stat.split('\n')) {
    const match = row.match(/^(\d+|-)\t(\d+|-)\t/)
    if (!match) continue
    files++
    added += match[1] === '-' ? 0 : Number(match[1])
    removed += match[2] === '-' ? 0 : Number(match[2])
  }
  return { sha, subject: rest.join('\t'), files, added, removed }
}

/**
 * Push the current branch. A branch with no upstream is given one — that is
 * what `git push` would have asked about, and there is nobody here to ask.
 */
export async function push(cwd: string): Promise<string> {
  const root = (await run(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const branch = (await run(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  if (!branch || branch === 'HEAD') throw new GitError('not on a branch')
  const hasUpstream = await run(root, ['rev-parse', '--abbrev-ref', '@{upstream}']).then(
    () => true,
    () => false,
  )
  const args = hasUpstream ? ['push'] : ['push', '--set-upstream', 'origin', branch]
  /* Push writes its progress to stderr, which `run` only surfaces on failure —
     so success is reported from what we know rather than from what git said. */
  await run(root, args, PUSH_TIMEOUT_MS)
  return hasUpstream ? `Pushed ${branch}` : `Pushed ${branch} and set its upstream`
}
