import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  applyHunk,
  commitStaged,
  fetchGitDiff,
  fetchGitStatus,
  pushBranch,
  stageFiles,
  type FileChange,
  type GitDiff,
  type GitStatus,
  type SessionInfo,
} from '../api'
import { pair, type Span } from '../diff-words'
import {
  Button,
  EmptyState,
  IconBranch,
  IconButton,
  IconPlus,
  IconRestart,
  OrbitMark,
  Sheet,
  basename,
  useArrival,
} from '../components/ui'

interface Props {
  active: boolean
  session: SessionInfo | null
  onToast: (message: string) => void
}

const STATUS_LETTER: Record<string, { label: string; className: string }> = {
  M: { label: 'M', className: 'text-live' },
  A: { label: 'A', className: 'text-add' },
  D: { label: 'D', className: 'text-danger' },
  R: { label: 'R', className: 'text-accent' },
  C: { label: 'C', className: 'text-accent' },
  U: { label: '!', className: 'text-danger' },
  '?': { label: '+', className: 'text-add' },
}
const UNKNOWN_STATUS_LETTER = { label: '·', className: 'text-mut' }

const HEADER_LINE_THE_SHEET_TITLE_ALREADY_SAYS = /^(diff --git |index [0-9a-f]{4,}|--- |\+\+\+ )/

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context'

const kindOf = (line: string): LineKind => {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  if (/^(new file|deleted file|old mode|new mode|similarity|rename |Binary files )/.test(line)) {
    return 'meta'
  }
  return 'context'
}

const LINE_STYLE: Record<LineKind, string> = {
  add: 'bg-add/14 text-add',
  del: 'bg-danger/12 text-danger',
  hunk: 'bg-raised text-accent',
  meta: 'text-faint italic',
  context: 'text-mut',
}

const CHANGED_WORD_STYLE: Record<string, string> = {
  add: 'bg-add/32 text-fore rounded-[2px]',
  del: 'bg-danger/30 text-fore rounded-[2px]',
}

interface Hunk {
  header: string
  lines: string[]
  patch: string
}

const dropTrailingBlankLines = (lines: string[]) => {
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
}

const parseHunks = (patch: string) => {
  const fileMeta: string[] = []
  const hunks: Hunk[] = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      hunks.push({ header: line, lines: [], patch: '' })
      continue
    }
    const currentHunk = hunks[hunks.length - 1]
    if (!currentHunk) {
      if (!HEADER_LINE_THE_SHEET_TITLE_ALREADY_SAYS.test(line)) fileMeta.push(line)
      continue
    }
    currentHunk.lines.push(line)
  }
  for (const hunk of hunks) {
    dropTrailingBlankLines(hunk.lines)
    hunk.patch = [hunk.header, ...hunk.lines].join('\n')
  }
  return { meta: fileMeta, hunks }
}

const stripSign = (line: string) => line.slice(1)

const markChangedWords = (lines: string[]): Map<number, Span[]> => {
  const spansByLine = new Map<number, Span[]>()
  let runStart = 0
  while (runStart < lines.length) {
    if (!lines[runStart].startsWith('-')) {
      runStart++
      continue
    }
    let removedEnd = runStart
    while (removedEnd < lines.length && lines[removedEnd].startsWith('-')) removedEnd++
    let addedEnd = removedEnd
    while (addedEnd < lines.length && lines[addedEnd].startsWith('+')) addedEnd++

    const paired = pair(
      lines.slice(runStart, removedEnd).map(stripSign),
      lines.slice(removedEnd, addedEnd).map(stripSign),
    )
    if (paired) {
      paired.removed.forEach((spans, k) => spans && spansByLine.set(runStart + k, spans))
      paired.added.forEach((spans, k) => spans && spansByLine.set(removedEnd + k, spans))
    }
    runStart = addedEnd > runStart ? addedEnd : runStart + 1
  }
  return spansByLine
}

const DiffLine = ({ line, kind, spans }: { line: string; kind: LineKind; spans?: Span[] }) => (
  <div className={`px-3 ${LINE_STYLE[kind]}`}>
    {spans ? (
      <>
        {line[0]}
        {spans.map((span, i) => (
          <span key={i} className={span.changed ? CHANGED_WORD_STYLE[kind] : undefined}>
            {span.text}
          </span>
        ))}
      </>
    ) : (
      line || ' '
    )}
  </div>
)

function DiffSheet({
  file,
  staged,
  splittable,
  busy,
  loading,
  diff,
  onApply,
  onClose,
}: {
  file: string
  staged: boolean
  splittable: boolean
  busy: boolean
  loading: boolean
  diff: GitDiff | null
  onApply: (hunk: string) => void
  onClose: () => void
}) {
  const { meta, hunks } = useMemo(() => parseHunks(diff?.patch ?? ''), [diff?.patch])
  const marksByHunk = useMemo(() => hunks.map((hunk) => markChangedWords(hunk.lines)), [hunks])
  const arriveHunk = useArrival(hunks.map((h) => h.header))
  const aHunkMayBeCutInHalf = !!diff?.truncated
  const canStageHunks = splittable && !aHunkMayBeCutInHalf && hunks.length > 1
  const showsFullPath = file !== basename(file)

  return (
    <Sheet side="full" onClose={onClose} title={basename(file)}>
      {showsFullPath && (
        <div className="shrink-0 truncate px-5 pb-2 font-mono text-[11px] text-faint">{file}</div>
      )}
      {loading ? (
        <div className="fade-in flex flex-1 items-center justify-center">
          <OrbitMark size={34} />
        </div>
      ) : diff?.binary ? (
        <EmptyState title="Binary file" hint="There is nothing to read here line by line." />
      ) : !diff ? (
        <EmptyState title="Could not read the diff" hint="Close this and try again." />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <pre className="fade-in w-max min-w-full pb-6 font-mono text-[11.5px] leading-[1.55]">
            {meta.map((line, i) => (
              <DiffLine key={`m${i}`} line={line} kind={kindOf(line)} />
            ))}
            {hunks.map((hunk, h) => {
              const marks = marksByHunk[h]
              const enter = arriveHunk(hunk.header)
              return (
                <div key={h} style={enter.style} className={enter.className}>
                  <div className={`flex items-center gap-2 px-3 ${LINE_STYLE.hunk}`}>
                    <span className="min-w-0 flex-1 truncate">{hunk.header}</span>
                    {canStageHunks && (
                      <button
                        disabled={busy}
                        onClick={() => onApply(hunk.patch)}
                        className="sticky right-1 shrink-0 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-accent disabled:opacity-40"
                      >
                        {staged ? 'Unstage' : 'Stage'}
                      </button>
                    )}
                  </div>
                  {hunk.lines.map((line, i) => (
                    <DiffLine key={i} line={line} kind={kindOf(line)} spans={marks.get(i)} />
                  ))}
                </div>
              )
            })}
          </pre>
          {diff?.truncated && (
            <div className="border-t border-line bg-raised px-4 py-3 text-xs text-mut">
              Truncated — this file is too large to read on a phone. Open it on the desktop.
            </div>
          )}
        </div>
      )}
    </Sheet>
  )
}

const useRefreshOnArrivalAndWake = (active: boolean, refresh: () => void) => {
  useEffect(() => {
    if (!active) return
    refresh()
    const onVisible = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [active, refresh])
}

const isInIndex = (f: FileChange) => f.staged !== ' ' && f.staged !== '?'
const isInWorktree = (f: FileChange) => f.worktree !== ' ' && f.worktree !== '?'
const isUntracked = (f: FileChange) => f.worktree === '?'

const splitsIntoHunks = (statusLetter: string) => statusLetter === 'M'

const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/'))

const pluralFiles = (n: number) => `${n} file${n === 1 ? '' : 's'}`

interface OpenDiff {
  file: string
  staged: boolean
  splittable: boolean
}

export default function ChangesView({ active, session, onToast }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [open, setOpen] = useState<OpenDiff | null>(null)
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const cwd = session?.cwd ?? null

  const refresh = useCallback(async () => {
    if (!cwd) return setStatus(null)
    setLoading(true)
    try {
      setStatus(await fetchGitStatus(cwd))
    } catch (e) {
      setStatus(null)
      onToast(e instanceof Error ? e.message : 'Could not read the repository')
    } finally {
      setLoading(false)
    }
  }, [cwd, onToast])

  useRefreshOnArrivalAndWake(active, refresh)

  const [diffGeneration, setDiffGeneration] = useState(0)
  const [diffFailed, setDiffFailed] = useState(false)

  useEffect(() => {
    setDiffFailed(false)
    if (!open || !cwd) return setDiff(null)
    let cancelled = false
    setDiff(null)
    fetchGitDiff(cwd, open.file, open.staged)
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => {
        if (cancelled) return
        setDiffFailed(true)
        onToast(e instanceof Error ? e.message : 'Could not read the diff')
      })
    return () => {
      cancelled = true
    }
  }, [open, cwd, onToast, diffGeneration])

  const run = async (key: string, work: () => Promise<GitStatus>) => {
    if (busy) return
    setBusy(key)
    try {
      setStatus(await work())
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'git refused')
    } finally {
      setBusy(null)
    }
  }

  const setStaged = (files: string[], add: boolean) =>
    run(add ? `stage:${files[0]}` : `unstage:${files[0]}`, () => stageFiles(cwd!, files, add))

  const moveHunk = async (hunk: string) => {
    if (!open || !cwd || busy) return
    setBusy('hunk')
    try {
      const next = await applyHunk(cwd, open.file, hunk, open.staged)
      setStatus(next)
      setDiffGeneration((n) => n + 1)
      const fileStillHasChanges = next.files.some((f) => f.path === open.file)
      if (!fileStillHasChanges) setOpen(null)
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'git could not apply that hunk')
    } finally {
      setBusy(null)
    }
  }

  const doCommit = async () => {
    if (!cwd || !message.trim()) return
    setBusy('commit')
    try {
      const made = await commitStaged(cwd, message)
      setStatus(made.status)
      setMessage('')
      onToast(`Committed ${made.sha} · ${pluralFiles(made.files)}, +${made.added} −${made.removed}`)
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Commit refused')
    } finally {
      setBusy(null)
    }
  }

  const doPush = async () => {
    if (!cwd) return
    setBusy('push')
    try {
      const pushed = await pushBranch(cwd)
      setStatus(pushed.status)
      onToast(pushed.message)
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Push refused')
    } finally {
      setBusy(null)
    }
  }

  const files = status?.files ?? []
  const staged = files.filter(isInIndex)
  const changed = files.filter(isInWorktree)
  const untracked = files.filter(isUntracked)

  const hasUnpushedCommits = !!status && status.ahead > 0
  const branchNeverPushed = !!status && !status.upstream && !!status.head
  const canPush = !!status?.repo && status.hasRemote && (hasUnpushedCommits || branchNeverPushed)

  const arrive = useArrival([
    ...(staged.length > 0 ? ['h:Staged', ...staged.map((f) => `i:${f.path}`)] : []),
    ...(changed.length > 0 ? ['h:Changed', ...changed.map((f) => `w:${f.path}`)] : []),
    ...(untracked.length > 0 ? ['h:Untracked', ...untracked.map((f) => `w:${f.path}`)] : []),
  ])

  const row = (f: FileChange, inIndex: boolean) => {
    const statusLetter = inIndex ? f.staged : f.worktree
    const letter = STATUS_LETTER[statusLetter] ?? UNKNOWN_STATUS_LETTER
    const key = `${inIndex ? 'i' : 'w'}:${f.path}`
    const subtitle = f.from ? `${f.from} → ${f.path}` : folderOf(f.path)
    const subtitleSaysSomething = !!f.from || f.path.includes('/')
    return (
      <div
        key={key}
        onClick={() =>
          setOpen({
            file: f.path,
            staged: inIndex,
            splittable: splitsIntoHunks(statusLetter),
          })
        }
        style={arrive(key).style}
        className={`${arrive(key).className} flex cursor-pointer items-center gap-2.5 rounded-(--radius-card) border border-line-subtle bg-surface px-3 py-2.5 transition-colors hover:border-line`}
      >
        <span className={`w-3 shrink-0 text-center font-mono text-sm ${letter.className}`}>
          {letter.label}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[13px]">{basename(f.path)}</span>
          {subtitleSaysSomething && (
            <span className="block truncate text-[11px] text-faint">{subtitle}</span>
          )}
        </span>
        {f.binary ? (
          <span className="shrink-0 text-[11px] text-faint">binary</span>
        ) : (
          <span className="shrink-0 font-mono text-[11px]">
            {f.added > 0 && <span className="text-add">+{f.added}</span>}
            {f.added > 0 && f.removed > 0 && ' '}
            {f.removed > 0 && <span className="text-danger">−{f.removed}</span>}
          </span>
        )}
        <IconButton
          label={inIndex ? `Unstage ${f.path}` : `Stage ${f.path}`}
          size="lg"
          disabled={!!busy}
          className="border border-line"
          onClick={(e) => {
            e.stopPropagation()
            setStaged([f.path], !inIndex)
          }}
        >
          {inIndex ? <span className="text-lg leading-none">−</span> : <IconPlus size={16} />}
        </IconButton>
      </div>
    )
  }

  const group = (title: string, groupFiles: FileChange[], inIndex: boolean) =>
    groupFiles.length > 0 && (
      <div className="space-y-2">
        <div
          style={arrive(`h:${title}`).style}
          className={`${arrive(`h:${title}`).className} flex items-center justify-between pt-1`}
        >
          <span className="text-xs font-semibold tracking-widest text-faint uppercase">
            {title} · {groupFiles.length}
          </span>
          <button
            disabled={!!busy}
            onClick={() => setStaged(groupFiles.map((f) => f.path), !inIndex)}
            className="text-xs font-medium text-accent disabled:opacity-40"
          >
            {inIndex ? 'Unstage all' : 'Stage all'}
          </button>
        </div>
        {groupFiles.map((f) => row(f, inIndex))}
      </div>
    )

  const somethingToCommitOrPush = staged.length > 0 || canPush

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-lg font-semibold tracking-wide">Changes</h1>
          {status?.repo && (
            <div className="flex items-center gap-1.5 text-xs text-faint">
              <IconBranch size={13} className="shrink-0 text-accent" />
              <span className="truncate font-mono">{status.branch ?? 'detached'}</span>
              <span>·</span>
              <span className="truncate">{basename(status.root ?? '')}</span>
              {status.ahead > 0 && <span className="text-accent">↑{status.ahead}</span>}
              {status.behind > 0 && <span className="text-live">↓{status.behind}</span>}
            </div>
          )}
        </div>
        <IconButton label="Refresh" size="lg" disabled={loading} onClick={refresh}>
          {loading ? <OrbitMark size={18} /> : <IconRestart size={18} />}
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4">
        {!session ? (
          <EmptyState
            title="No session open"
            hint="Changes follow the folder of the session you are in — start one in a project first."
          />
        ) : status && !status.repo ? (
          <EmptyState
            title="Not a git repository"
            hint={`${basename(session.cwd)} has no history to compare against.`}
          />
        ) : status?.repo && status.files.length === 0 ? (
          <EmptyState
            title="Nothing changed"
            hint={
              status.head
                ? `Clean on ${status.head.sha} — ${status.head.subject}`
                : 'No commits here yet.'
            }
          />
        ) : (
          <>
            {group('Staged', staged, true)}
            {group('Changed', changed, false)}
            {group('Untracked', untracked, false)}
          </>
        )}
      </div>

      {status?.repo && somethingToCommitOrPush && (
        <div className="rise-in shrink-0 space-y-2 border-t border-line-subtle bg-surface px-4 py-2.5">
          {staged.length > 0 && (
            <textarea
              rows={2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What this change does…"
              className="w-full resize-none rounded-(--radius-field) border border-line bg-ink px-3.5 py-2.5 text-sm text-fore outline-none transition-colors placeholder:text-faint focus:border-accent"
            />
          )}
          <div className="flex gap-2">
            {staged.length > 0 && (
              <Button
                className="h-11 flex-1"
                disabled={!message.trim() || !!busy}
                onClick={doCommit}
              >
                {busy === 'commit' ? 'Committing…' : `Commit ${pluralFiles(staged.length)}`}
              </Button>
            )}
            {canPush && (
              <Button
                variant="outline"
                className="h-11 shrink-0 px-4"
                disabled={!!busy}
                onClick={doPush}
              >
                {busy === 'push' ? 'Pushing…' : status.ahead > 0 ? `Push ↑${status.ahead}` : 'Push'}
              </Button>
            )}
          </div>
        </div>
      )}

      {open && (
        <DiffSheet
          file={open.file}
          staged={open.staged}
          splittable={open.splittable}
          busy={!!busy}
          loading={!diff && !diffFailed}
          diff={diff}
          onApply={moveHunk}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}
