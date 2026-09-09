import { useEffect, useState } from 'react'
import {
  createSession,
  fetchDirs,
  fetchProviders,
  RECENTS_KEY,
  type DirListing,
  type ProviderInfo,
} from '../api'
import {
  Button,
  Field,
  IconBack,
  IconBranch,
  IconButton,
  IconFolder,
  IconHome,
  Sheet,
  basename,
  shortPath,
  useArrival,
  PROVIDER_GLYPH,
} from '../components/ui'

const RECENTS_MAX = 5
const DEFAULT_PROVIDER = 'claude'
const SHELL_PROVIDER = 'shell'
const FOLDER_FILTER_SHOWN_ABOVE = 8
const BROAD_FOLDER_MAX_DEPTH = 1

const loadRecents = (): string[] => {
  try {
    const list = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : []
  } catch {
    return []
  }
}

const pushRecent = (path: string) => {
  const list = [path, ...loadRecents().filter((p) => p !== path)].slice(0, RECENTS_MAX)
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list))
}

const pickProvider = (providers: ProviderInfo[], current: string) => {
  if (providers.find((p) => p.id === current && p.available)) return current
  return providers.find((p) => p.available && p.id !== SHELL_PROVIDER)?.id ?? SHELL_PROVIDER
}

const folderDepth = (path: string) => shortPath(path).split('/').filter(Boolean).length - 1

const providerKey = (id: string) => `p:${id}`
const recentKey = (path: string) => `r:${path}`
const dirKey = (parent: string, name: string) => `d:${parent}/${name}`

type Arrive = ReturnType<typeof useArrival>

interface Props {
  onCreated: (id: string) => void
  onClose: () => void
}

function ProviderPicker({
  providers,
  selected,
  onSelect,
  arrive,
}: {
  providers: ProviderInfo[]
  selected: string
  onSelect: (id: string) => void
  arrive: Arrive
}) {
  return (
    <div className="grid shrink-0 grid-cols-2 gap-2">
      {providers.map((p) => {
        const active = p.id === selected
        return (
          <button
            key={p.id}
            disabled={!p.available}
            onClick={() => onSelect(p.id)}
            style={arrive(providerKey(p.id)).style}
            className={`${arrive(providerKey(p.id)).className} flex items-center gap-3 rounded-(--radius-card) border px-3.5 py-3 text-left transition-colors disabled:opacity-35 ${
              active ? 'border-accent bg-accent/10' : 'border-line bg-raised hover:border-faint'
            }`}
          >
            <span className={`font-mono text-lg ${active ? 'text-accent' : 'text-mut'}`}>
              {PROVIDER_GLYPH[p.id]}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{p.name}</span>
              <span className="block text-xs text-faint">
                {p.available ? (p.id === SHELL_PROVIDER ? 'zsh' : 'CLI agent') : 'Not installed'}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function RecentProjects({
  recents,
  disabled,
  onPick,
  arrive,
}: {
  recents: string[]
  disabled: boolean
  onPick: (path: string) => void
  arrive: Arrive
}) {
  return (
    <div className="shrink-0">
      <div className="mb-2 text-xs font-semibold tracking-widest text-faint uppercase">
        Recent projects
      </div>
      <div className="flex flex-col gap-1">
        {recents.map((path) => (
          <button
            key={path}
            disabled={disabled}
            onClick={() => onPick(path)}
            style={arrive(recentKey(path)).style}
            className={`${arrive(recentKey(path)).className} flex items-center gap-3 rounded-(--radius-field) px-3 py-2.5 text-left transition-colors hover:bg-raised active:bg-overlay disabled:opacity-40`}
          >
            <IconFolder size={17} className="shrink-0 text-accent" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{basename(path)}</span>
              <span className="block truncate font-mono text-xs text-faint">{shortPath(path)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function FolderBrowser({
  listing,
  visibleDirs,
  filter,
  onFilter,
  onBrowse,
  arrive,
}: {
  listing: DirListing
  visibleDirs: DirListing['dirs']
  filter: string
  onFilter: (text: string) => void
  onBrowse: (path: string) => void
  arrive: Arrive
}) {
  return (
    <div className="fade-in flex shrink-0 flex-col overflow-hidden rounded-(--radius-card) border border-line">
      <div className="flex items-center gap-1 border-b border-line bg-ink px-2 py-1.5">
        <IconButton
          label="Parent folder"
          disabled={!listing.parent}
          onClick={() => listing.parent && onBrowse(listing.parent)}
          className="size-8"
        >
          <IconBack size={16} />
        </IconButton>
        <IconButton label="Home" onClick={() => onBrowse('~')} className="size-8">
          <IconHome size={15} />
        </IconButton>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-mut">
          {shortPath(listing.path)}
        </span>
        {listing.isRepo && (
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-ok/40 px-2 py-0.5 text-[10px] text-ok">
            <IconBranch size={11} /> repo
          </span>
        )}
      </div>
      {listing.dirs.length > FOLDER_FILTER_SHOWN_ABOVE && (
        <input
          className="w-full border-b border-line bg-ink px-3.5 py-2 text-sm text-fore outline-none placeholder:text-faint"
          type="search"
          placeholder="Filter folders…"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
        />
      )}
      <div className="py-1">
        {visibleDirs.map((dir) => (
          <button
            key={dir.name}
            onClick={() => onBrowse(`${listing.path}/${dir.name}`)}
            style={arrive(dirKey(listing.path, dir.name)).style}
            className={`${arrive(dirKey(listing.path, dir.name)).className} flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-raised`}
          >
            <IconFolder size={15} className="shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{dir.name}</span>
            {dir.git && <IconBranch size={13} className="shrink-0 text-ok/80" />}
          </button>
        ))}
        {visibleDirs.length === 0 && (
          <div className="px-4 py-3 text-sm text-faint">
            {filter ? 'No folders match' : 'No subfolders — use this folder'}
          </div>
        )}
      </div>
    </div>
  )
}

export default function NewSessionSheet({ onCreated, onClose }: Props) {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [provider, setProvider] = useState(DEFAULT_PROVIDER)
  const [name, setName] = useState('')
  const [listing, setListing] = useState<DirListing | null>(null)
  const [filter, setFilter] = useState('')
  const [recents, setRecents] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const stored = loadRecents()
    setRecents(stored)
    fetchProviders()
      .then((list) => {
        setProviders(list)
        setProvider((current) => pickProvider(list, current))
      })
      .catch(() => setProviders([]))
    fetchDirs(stored[0]).then(setListing).catch(() => setListing(null))
  }, [])

  const browse = (path: string) => {
    setFilter('')
    fetchDirs(path).then(setListing).catch(() => {})
  }

  const start = async (cwd: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const session = await createSession(provider, cwd, name.trim() || undefined)
      pushRecent(cwd)
      onCreated(session.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const providerName = providers.find((p) => p.id === provider)?.name ?? ''
  const visibleDirs = listing
    ? listing.dirs.filter((d) => d.name.toLowerCase().includes(filter.toLowerCase()))
    : []
  const broadFolder =
    provider !== SHELL_PROVIDER &&
    listing !== null &&
    folderDepth(listing.path) <= BROAD_FOLDER_MAX_DEPTH &&
    !listing.isRepo

  const arrive = useArrival([
    ...providers.map((p) => providerKey(p.id)),
    ...recents.map(recentKey),
    ...(listing ? visibleDirs.map((d) => dirKey(listing.path, d.name)) : []),
  ])

  return (
    <Sheet title="New session" onClose={onClose}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pt-2 pb-4">
        <ProviderPicker
          providers={providers}
          selected={provider}
          onSelect={setProvider}
          arrive={arrive}
        />

        <Field
          placeholder="Session name (optional) — e.g. fix login bug"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {recents.length > 0 && (
          <RecentProjects recents={recents} disabled={busy} onPick={start} arrive={arrive} />
        )}

        {listing && (
          <FolderBrowser
            listing={listing}
            visibleDirs={visibleDirs}
            filter={filter}
            onFilter={setFilter}
            onBrowse={browse}
            arrive={arrive}
          />
        )}

        {error && <div className="fade-in text-sm text-danger">{error}</div>}
        {broadFolder && (
          <div className="rise-in rounded-(--radius-field) bg-live/10 px-3.5 py-2.5 text-[13px] leading-snug text-live">
            Broad folder — {providerName} works best inside a specific project
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line-subtle px-5 py-3">
        <Button
          className="w-full py-3"
          disabled={busy || !listing}
          onClick={() => listing && start(listing.path)}
        >
          {busy ? 'Starting…' : `Start ${providerName} in ${listing ? basename(listing.path) : '…'}`}
        </Button>
      </div>
    </Sheet>
  )
}
