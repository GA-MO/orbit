import { useEffect, useState } from 'react'
import {
  fetchProviders,
  fetchSessions,
  fetchDirs,
  createSession,
  killSession,
  renameSession,
  restartSession,
  type ProviderInfo,
  type SessionInfo,
  type DirListing,
} from './api'

const PROVIDER_ICON: Record<string, string> = {
  shell: '❯',
  claude: '✳',
  codex: '◎',
  gemini: '✦',
}

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

const timeAgo = (iso: string) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

const RECENTS_KEY = 'orbit.recentDirs'
const RECENTS_MAX = 5

const loadRecents = (): string[] => {
  try {
    const list = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : []
  } catch {
    return []
  }
}

const pushRecent = (path: string): string[] => {
  const list = [path, ...loadRecents().filter((p) => p !== path)].slice(0, RECENTS_MAX)
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list))
  return list
}

interface Props {
  open: boolean
  currentId: string | null
  onClose: () => void
  onSelect: (id: string) => void
}

export default function Drawer({ open, currentId, onClose, onSelect }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [selectedProvider, setSelectedProvider] = useState('claude')
  const [sessionName, setSessionName] = useState('')
  const [listing, setListing] = useState<DirListing | null>(null)
  const [filter, setFilter] = useState('')
  const [recents, setRecents] = useState<string[]>([])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setRenamingId(null)
    const rec = loadRecents()
    setRecents(rec)
    fetchSessions().then(setSessions).catch(() => setSessions([]))
    fetchProviders()
      .then((ps) => {
        setProviders(ps)
        // Default to the first available agent, falling back to shell.
        setSelectedProvider((cur) => {
          const stillOk = ps.find((p) => p.id === cur && p.available)
          if (stillOk) return cur
          return ps.find((p) => p.available && p.id !== 'shell')?.id ?? 'shell'
        })
      })
      .catch(() => setProviders([]))
    // Default the browser to the most recent project — the common case becomes one tap.
    fetchDirs(rec[0]).then(setListing).catch(() => setListing(null))
  }, [open])

  const browse = (path: string) => {
    setFilter('')
    fetchDirs(path).then(setListing).catch(() => {})
  }

  const startIn = async (cwd: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const session = await createSession(selectedProvider, cwd, sessionName.trim() || undefined)
      pushRecent(cwd)
      setSessionName('')
      onSelect(session.id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const kill = async (id: string) => {
    await killSession(id)
    // The PTY exits asynchronously after the signal; give it a beat before refreshing.
    await new Promise((r) => setTimeout(r, 400))
    const remaining = await fetchSessions().catch(() => [])
    setSessions(remaining)
    if (id === currentId) {
      const next = remaining.find((s) => s.alive)
      if (next) {
        onSelect(next.id)
      } else {
        const fresh = await createSession('shell')
        onSelect(fresh.id)
      }
      onClose()
    }
  }

  const relaunch = async (id: string) => {
    if (busy) return
    setBusy(true)
    try {
      const session = await restartSession(id)
      onSelect(session.id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const forget = async (id: string) => {
    await killSession(id)
    fetchSessions().then(setSessions).catch(() => {})
  }

  const beginRename = (s: SessionInfo) => {
    setRenamingId(s.id)
    setRenameValue(s.name ?? '')
  }

  const commitRename = async (id: string) => {
    setRenamingId(null)
    await renameSession(id, renameValue.trim())
    fetchSessions().then(setSessions).catch(() => {})
  }

  if (!open) return null

  const alive = sessions.filter((s) => s.alive)
  const ended = sessions.filter((s) => !s.alive)
  const providerName = providers.find((p) => p.id === selectedProvider)?.name ?? ''

  // Depth below home: ~ → 0, ~/Development → 1, ~/Development/orbit → 2.
  const depth = listing ? shortPath(listing.path).split('/').filter(Boolean).length - 1 : 0
  const broadFolder =
    selectedProvider !== 'shell' && listing !== null && depth <= 1 && !listing.isRepo

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-section drawer-section--sessions">
          <div className="drawer-title">Sessions</div>
          {alive.length === 0 && <div className="drawer-empty">No active sessions</div>}
          {alive.map((s) => (
            <div
              key={s.id}
              className={`session-row ${s.id === currentId ? 'session-row--current' : ''}`}
              onClick={() => {
                if (renamingId === s.id) return
                onSelect(s.id)
                onClose()
              }}
            >
              <span className="session-icon">{PROVIDER_ICON[s.providerId] ?? '❯'}</span>
              {renamingId === s.id ? (
                <input
                  className="session-rename-input"
                  value={renameValue}
                  placeholder={s.providerName}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => commitRename(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(s.id)
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                />
              ) : (
                <span className="session-info">
                  <span className="session-name">{s.name ?? s.providerName}</span>
                  <span className="session-cwd">
                    {s.name ? `${s.providerName} · ` : ''}
                    {basename(s.cwd)} · {timeAgo(s.createdAt)}
                  </span>
                </span>
              )}
              <button
                className="session-action"
                title="Rename session"
                onClick={(e) => {
                  e.stopPropagation()
                  beginRename(s)
                }}
              >
                ✎
              </button>
              <button
                className="session-action session-action--kill"
                title="Kill session"
                onClick={(e) => {
                  e.stopPropagation()
                  kill(s.id)
                }}
              >
                ✕
              </button>
            </div>
          ))}

          {ended.length > 0 && (
            <>
              <div className="drawer-title drawer-title--ended">Ended</div>
              {ended.map((s) => (
                <div
                  key={s.id}
                  className={`session-row session-row--ended ${
                    s.id === currentId ? 'session-row--current' : ''
                  }`}
                  title="View history (read-only)"
                  onClick={() => {
                    onSelect(s.id)
                    onClose()
                  }}
                >
                  <span className="session-icon session-icon--ended">
                    {PROVIDER_ICON[s.providerId] ?? '❯'}
                  </span>
                  <span className="session-info">
                    <span className="session-name">{s.name ?? s.providerName}</span>
                    <span className="session-cwd">
                      {s.name ? `${s.providerName} · ` : ''}
                      {basename(s.cwd)} · ended {s.endedAt ? timeAgo(s.endedAt) : '?'}
                    </span>
                  </span>
                  <button
                    className="session-action"
                    title="Relaunch (same provider + folder)"
                    onClick={(e) => {
                      e.stopPropagation()
                      relaunch(s.id)
                    }}
                  >
                    ↻
                  </button>
                  <button
                    className="session-action session-action--kill"
                    title="Forget (delete history)"
                    onClick={(e) => {
                      e.stopPropagation()
                      forget(s.id)
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="drawer-section drawer-section--new">
          <div className="drawer-title">New session</div>
          <div className="provider-chips">
            {providers.map((p) => (
              <button
                key={p.id}
                className={`chip ${p.id === selectedProvider ? 'chip--active' : ''}`}
                disabled={!p.available}
                title={p.available ? p.name : `${p.name} — not installed`}
                onClick={() => setSelectedProvider(p.id)}
              >
                {PROVIDER_ICON[p.id]} {p.name}
              </button>
            ))}
          </div>

          <input
            className="session-name-input"
            type="text"
            placeholder="Session name (optional) — e.g. fix login bug"
            maxLength={60}
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
          />

          {recents.length > 0 && (
            <div className="recents">
              {recents.map((p) => (
                <button
                  key={p}
                  className="recent-row"
                  disabled={busy}
                  title={`Start ${providerName} in ${shortPath(p)}`}
                  onClick={() => startIn(p)}
                >
                  <span className="recent-icon">↻</span>
                  <span className="recent-info">
                    <span className="recent-name">{basename(p)}</span>
                    <span className="recent-path">{shortPath(p)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {listing && (
            <div className="dir-browser">
              <div className="dir-path">
                <button
                  className="dir-up"
                  disabled={!listing.parent}
                  title="Parent folder"
                  onClick={() => listing.parent && browse(listing.parent)}
                >
                  ←
                </button>
                <button className="dir-up" title="Home" onClick={() => browse('~')}>
                  ~
                </button>
                <span className="dir-path-text">{shortPath(listing.path)}</span>
                {listing.isRepo && <span className="repo-badge">⎇ repo</span>}
              </div>
              {listing.dirs.length > 8 && (
                <input
                  className="dir-filter"
                  type="search"
                  placeholder="Filter folders…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              )}
              <div className="dir-list">
                {listing.dirs
                  .filter((d) => d.name.toLowerCase().includes(filter.toLowerCase()))
                  .map((d) => (
                    <button
                      key={d.name}
                      className="dir-item"
                      onClick={() => browse(`${listing.path}/${d.name}`)}
                    >
                      <span className="dir-item-icon">▸</span> {d.name}
                      {d.git && <span className="dir-git">⎇</span>}
                    </button>
                  ))}
                {listing.dirs.filter((d) => d.name.toLowerCase().includes(filter.toLowerCase()))
                  .length === 0 && (
                  <div className="drawer-empty">
                    {filter ? 'No folders match' : 'No subfolders — use this folder'}
                  </div>
                )}
              </div>
            </div>
          )}

          {error && <div className="drawer-error">{error}</div>}
          {broadFolder && (
            <div className="drawer-hint">
              Broad folder — {providerName} works best inside a specific project (⎇)
            </div>
          )}

          <button
            className="start-button"
            disabled={busy || !listing}
            onClick={() => listing && startIn(listing.path)}
          >
            {busy
              ? 'Starting…'
              : `Start ${providerName} in ${listing ? basename(listing.path) : '…'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
