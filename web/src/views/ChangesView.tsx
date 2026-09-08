import { useCallback, useEffect, useState } from 'react'
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
  /** Whose folder to look at — the repository is wherever that sits. */
  session: SessionInfo | null
  onToast: (message: string) => void
}

/** What a status letter means, in the space a row has for it. */
const LETTER: Record<string, { label: string; className: string }> = {
  M: { label: 'M', className: 'text-live' },
  A: { label: 'A', className: 'text-ok' },
  D: { label: 'D', className: 'text-danger' },
  R: { label: 'R', className: 'text-accent' },
  C: { label: 'C', className: 'text-accent' },
  U: { label: '!', className: 'text-danger' },
  '?': { label: '+', className: 'text-ok' },
}

/* The four lines every hunk is wrapped in say what the sheet's own title
   already says, and on a 390px screen they cost a fifth of the first screenful.
   Everything else git puts in the header — a mode change, where a rename came
   from — is information the diff body does not repeat. */
const NOISE = /^(diff --git |index [0-9a-f]{4,}|--- |\+\+\+ )/

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
  add: 'bg-ok/12 text-ok',
  del: 'bg-danger/12 text-danger',
  hunk: 'bg-raised text-accent',
  meta: 'text-faint italic',
  context: 'text-mut',
}

/** The stronger wash the changed words themselves get, over the line's own. */
const WORD_STYLE: Record<string, string> = {
  add: 'bg-ok/30 text-fore rounded-[2px]',
  del: 'bg-danger/30 text-fore rounded-[2px]',
}

interface Hunk {
  header: string
  lines: string[]
  /** Exactly what goes to git if this one is staged on its own. */
  patch: string
}

/* A patch as the sheet needs it: the file header dropped, and the body cut at
   each `@@` so a hunk can be shown — and staged — as the unit it already is. */
const parseHunks = (patch: string) => {
  const meta: string[] = []
  const hunks: Hunk[] = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      hunks.push({ header: line, lines: [], patch: '' })
      continue
    }
    const current = hunks[hunks.length - 1]
    if (!current) {
      if (!NOISE.test(line)) meta.push(line)
      continue
    }
    current.lines.push(line)
  }
  for (const hunk of hunks) {
    while (hunk.lines.length && hunk.lines[hunk.lines.length - 1] === '') hunk.lines.pop()
    hunk.patch = [hunk.header, ...hunk.lines].join('\n')
  }
  return { meta, hunks }
}

/* Where the word-level marks attach: a run of removed lines and the run of
   added ones directly after it. `pair` decides whether they are versions of
   each other at all — this only finds the runs and keeps the answer by line. */
const markHunk = (lines: string[]): Map<number, Span[]> => {
  const marks = new Map<number, Span[]>()
  let i = 0
  while (i < lines.length) {
    if (!lines[i].startsWith('-')) {
      i++
      continue
    }
    let removedEnd = i
    while (removedEnd < lines.length && lines[removedEnd].startsWith('-')) removedEnd++
    let addedEnd = removedEnd
    while (addedEnd < lines.length && lines[addedEnd].startsWith('+')) addedEnd++

    const paired = pair(
      lines.slice(i, removedEnd).map((l) => l.slice(1)),
      lines.slice(removedEnd, addedEnd).map((l) => l.slice(1)),
    )
    if (paired) {
      paired.removed.forEach((spans, k) => spans && marks.set(i + k, spans))
      paired.added.forEach((spans, k) => spans && marks.set(removedEnd + k, spans))
    }
    i = addedEnd > i ? addedEnd : i + 1
  }
  return marks
}

const DiffLine = ({ line, kind, spans }: { line: string; kind: LineKind; spans?: Span[] }) => (
  <div className={`px-3 ${LINE_STYLE[kind]}`}>
    {spans ? (
      <>
        {line[0]}
        {spans.map((span, i) => (
          <span key={i} className={span.changed ? WORD_STYLE[kind] : undefined}>
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
  /** Whether a hunk of this file can go into the index on its own — see below. */
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
  const { meta, hunks } = parseHunks(diff?.patch ?? '')
  /* Hunks arrive; lines do not. A hunk is a unit the reader is choosing
     between, so a short sequence down the file helps them count. Two hundred
     lines staggering in individually is not that — it is a file that takes a
     second and a half to become readable, and the reader is already scrolling
     by the time the bottom of it shows up.

     Keyed by header rather than by position because staging one hunk refetches
     the diff, which tears the body down and builds it again: without this the
     six hunks you did not touch would replay their entrance every time you
     moved one. */
  const arriveHunk = useArrival(hunks.map((h) => h.header))
  /* A hunk of a truncated diff is a hunk that may have been cut in half, and
     git would either refuse it or — worse — accept the half. */
  const canStage = splittable && !diff?.truncated && hunks.length > 1

  return (
    <Sheet side="full" onClose={onClose} title={basename(file)}>
      {file !== basename(file) && (
        <div className="shrink-0 truncate px-5 pb-2 font-mono text-[11px] text-faint">{file}</div>
      )}
      {loading ? (
        <div className="fade-in flex flex-1 items-center justify-center">
          <OrbitMark size={34} />
        </div>
      ) : diff?.binary ? (
        <EmptyState title="Binary file" hint="There is nothing to read here line by line." />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {/* `w-max` so a long line scrolls sideways instead of wrapping: a
              wrapped diff on a narrow screen loses which column the + was in. */}
          <pre className="fade-in w-max min-w-full pb-6 font-mono text-[11.5px] leading-[1.55]">
            {meta.map((line, i) => (
              <DiffLine key={`m${i}`} line={line} kind={kindOf(line)} />
            ))}
            {hunks.map((hunk, h) => {
              const marks = markHunk(hunk.lines)
              const enter = arriveHunk(hunk.header)
              return (
                <div key={h} style={enter.style} className={enter.className}>
                  <div className={`flex items-center gap-2 px-3 ${LINE_STYLE.hunk}`}>
                    <span className="min-w-0 flex-1 truncate">{hunk.header}</span>
                    {canStage && (
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
              Truncated — this file is too large to read on a phone. Open it on the Mac.
            </div>
          )}
        </div>
      )}
    </Sheet>
  )
}

export default function ChangesView({ active, session, onToast }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [open, setOpen] = useState<{ file: string; staged: boolean; splittable: boolean } | null>(
    null,
  )
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

  /* The agent is writing files while this tab is off screen, so what was true
     when it was last open is worth nothing. Ask on arrival, and again whenever
     the phone comes back to it — never on a timer, since `git status` walks the
     working tree and a repository this size is not free. */
  useEffect(() => {
    if (!active) return
    refresh()
    const onVisible = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [active, refresh])

  /* Bumped after a hunk moves, because the diff on screen is now one hunk out
     of date on this side — and the sheet stays open on what is left of it. */
  const [diffNonce, setDiffNonce] = useState(0)

  useEffect(() => {
    if (!open || !cwd) return setDiff(null)
    let cancelled = false
    setDiff(null)
    fetchGitDiff(cwd, open.file, open.staged)
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && onToast(e instanceof Error ? e.message : 'Could not read the diff'))
    return () => {
      cancelled = true
    }
  }, [open, cwd, onToast, diffNonce])

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

  /* One hunk in or out. The sheet is left open on purpose — staging half of a
     file is nearly always followed by staging another half of it, and closing
     would send you back through the list to the row you were already on. */
  const moveHunk = async (hunk: string) => {
    if (!open || !cwd || busy) return
    setBusy('hunk')
    try {
      const next = await applyHunk(cwd, open.file, hunk, open.staged)
      setStatus(next)
      setDiffNonce((n) => n + 1)
      // Nothing left on this side of the file: the sheet has run out of subject.
      if (!next.files.some((f) => f.path === open.file)) setOpen(null)
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
      onToast(
        `Committed ${made.sha} · ${made.files} file${made.files === 1 ? '' : 's'}, +${made.added} −${made.removed}`,
      )
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

  const staged = status?.files.filter((f) => f.staged !== ' ' && f.staged !== '?') ?? []
  const changed = status?.files.filter((f) => f.worktree !== ' ' && f.worktree !== '?') ?? []
  const untracked = status?.files.filter((f) => f.worktree === '?') ?? []
  /* Offered only where it would do something: commits the remote has not seen,
     or a branch that has never been pushed. A repository with no remote at all
     gets no button — the alternative is one that only ever fails. */
  const canPush =
    !!status?.repo && status.hasRemote && (status.ahead > 0 || (!status.upstream && !!status.head))

  /* One sequence for the whole list rather than three, so the eye follows the
     screen down instead of restarting at each heading. Changes re-reads after
     every git action and on every return to the tab; `useArrival` is what keeps
     those re-reads from replaying the arrival of rows that never left. */
  const arrive = useArrival([
    ...(staged.length > 0 ? ['h:Staged', ...staged.map((f) => `i:${f.path}`)] : []),
    ...(changed.length > 0 ? ['h:Changed', ...changed.map((f) => `w:${f.path}`)] : []),
    ...(untracked.length > 0 ? ['h:Untracked', ...untracked.map((f) => `w:${f.path}`)] : []),
  ])

  const row = (f: FileChange, inIndex: boolean) => {
    const letter = LETTER[inIndex ? f.staged : f.worktree] ?? { label: '·', className: 'text-mut' }
    const key = `${inIndex ? 'i' : 'w'}:${f.path}`
    return (
      <div
        key={key}
        onClick={() =>
          setOpen({
            file: f.path,
            staged: inIndex,
            /* Only a plain modification splits cleanly. A new, deleted or
               renamed file is a whole-file decision by nature, and half an
               untracked file in the index is a state nobody asked for. */
            splittable: (inIndex ? f.staged : f.worktree) === 'M',
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
          {/* Only where it says something the name does not: a file at the root
              of the repository had a lone dot sitting under it. */}
          {(f.from || f.path.includes('/')) && (
            <span className="block truncate text-[11px] text-faint">
              {f.from ? `${f.from} → ${f.path}` : f.path.slice(0, f.path.lastIndexOf('/'))}
            </span>
          )}
        </span>
        {f.binary ? (
          <span className="shrink-0 text-[11px] text-faint">binary</span>
        ) : (
          <span className="shrink-0 font-mono text-[11px]">
            {f.added > 0 && <span className="text-ok">+{f.added}</span>}
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

  const group = (title: string, files: FileChange[], inIndex: boolean) =>
    files.length > 0 && (
      <div className="space-y-2">
        <div
          style={arrive(`h:${title}`).style}
          className={`${arrive(`h:${title}`).className} flex items-center justify-between pt-1`}
        >
          <span className="text-xs font-semibold tracking-widest text-faint uppercase">
            {title} · {files.length}
          </span>
          <button
            disabled={!!busy}
            onClick={() => setStaged(files.map((f) => f.path), !inIndex)}
            className="text-xs font-medium text-accent disabled:opacity-40"
          >
            {inIndex ? 'Unstage all' : 'Stage all'}
          </button>
        </div>
        {files.map((f) => row(f, inIndex))}
      </div>
    )

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

      {/* Only once there is something to commit: an empty box above a clean
          repository is a form asking to be filled in for no reason. */}
      {status?.repo && (staged.length > 0 || canPush) && (
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
                {busy === 'commit'
                  ? 'Committing…'
                  : `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}`}
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
          loading={!diff}
          diff={diff}
          onApply={moveHunk}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}
