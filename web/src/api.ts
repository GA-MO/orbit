export interface ProviderInfo {
  id: string
  name: string
  available: boolean
}

/** `waiting` is holding up work on the Mac; `done` is only worth knowing about. */
export type AttentionKind = 'waiting' | 'done'

/** The last thing a session said, kept until someone actually reads it. */
export interface Attention {
  kind: AttentionKind
  message: string
  at: string
}

export interface SessionInfo {
  id: string
  name: string | null
  /** First line typed into the session — the label when it has no name. */
  firstCommand: string | null
  providerId: string
  providerName: string
  cwd: string
  createdAt: string
  endedAt: string | null
  exitCode: number | null
  alive: boolean
  /** This agent can pick its last conversation in the folder back up. */
  resumable: boolean
  /** Unread word from this session — absent on the reply that creates one. */
  attention?: Attention | null
}

export interface DirListing {
  path: string
  parent: string | null
  isRepo: boolean
  dirs: { name: string; git: boolean }[]
}

const TOKEN_KEY = 'orbit.token'
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? ''
export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token)

export class AuthError extends Error {
  constructor() {
    super('unauthorized')
  }
}

const authFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${getToken()}` },
  })
  if (res.status === 401) throw new AuthError()
  return res
}

const get = async <T>(url: string): Promise<T> => {
  const res = await authFetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json()
}

export const checkAuth = async (): Promise<boolean> => {
  try {
    await get('/api/auth/check')
    return true
  } catch (e) {
    if (e instanceof AuthError) return false
    throw e
  }
}

export const fetchProviders = () => get<ProviderInfo[]>('/api/providers')
export const fetchSessions = () => get<SessionInfo[]>('/api/sessions')
export const fetchDirs = (path?: string) =>
  get<DirListing>(`/api/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`)

export const createSession = async (
  provider: string,
  cwd?: string,
  name?: string,
): Promise<SessionInfo> => {
  const res = await authFetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, cwd, name }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? `create failed: ${res.status}`)
  return res.json()
}

export const killSession = (id: string) => authFetch(`/api/sessions/${id}`, { method: 'DELETE' })

export const renameSession = (id: string, name: string) =>
  authFetch(`/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })

/** Mark a session's word as read — sent when it is actually on screen. */
export const clearAttention = (id: string) =>
  authFetch(`/api/sessions/${id}/attention`, { method: 'DELETE' })

/** Start again from an ended session — fresh, or resuming the agent's conversation. */
export const restartSession = async (id: string, resume = false): Promise<SessionInfo> => {
  const res = await authFetch(`/api/sessions/${id}/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resume }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? `restart failed: ${res.status}`)
  return res.json()
}

export type PresetId = 'phone' | 'tablet' | 'desktop'

export const PRESETS: { id: PresetId; label: string; width: number; height: number }[] = [
  { id: 'phone', label: 'Phone', width: 390, height: 844 },
  { id: 'tablet', label: 'Tablet', width: 834, height: 1112 },
  { id: 'desktop', label: 'Desktop', width: 1440, height: 900 },
]

export interface Screenshot {
  file: string
  path: string
  createdAt: string
  size: number
  /** A rendered URL, or the Mac's own screen. */
  kind: 'url' | 'screen'
  /** What it was of — host:port style, or null for captures taken before labels. */
  label: string | null
  width: number | null
  height: number | null
}

export const captureScreenshot = async (opts: {
  url: string
  preset?: PresetId
  fullPage?: boolean
  /** Overrides the preset's viewport width — used to render at this phone's own. */
  width?: number
  /** What the shot is of, when the URL it was fetched from says something else. */
  label?: string
}): Promise<Screenshot> => {
  const res = await authFetch('/api/screenshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? `capture failed: ${res.status}`)
  return res.json()
}

/* `POST /api/screenshot { source: 'screen' }` captures the Mac's own screen and
   has no caller here on purpose: it belongs to the agent, through the
   `orbit_screen` MCP tool. Simulators and native apps are what an agent cannot
   otherwise see; the person holding the phone is not looking at the Mac. */

/** Something on this Mac that answers HTTP right now — a dev server to look at. */
export interface DevPort {
  port: number
  /** The program holding it, as the Mac names it — `node`, `Python`, `ruby`. */
  command: string
}

export const fetchDevPorts = () => get<DevPort[]>('/api/ports')

export const fetchScreenshots = () => get<Screenshot[]>('/api/screenshots')

export const deleteScreenshot = (file: string) =>
  authFetch(`/api/screenshots/${file}`, { method: 'DELETE' })

/** Image URL usable in <img src> — the session cookie authenticates it, so the
    token never lands in a URL. */
export const screenshotUrl = (file: string) => `/api/screenshots/${file}`

/** A dev server published over https on the tailnet, so the phone can frame it. */
export interface Preview {
  port: number
  publicPort: number
  url: string
  /** Whether the dev server behind it is up — a published port outlives it. */
  listening: boolean
}

export interface PreviewState {
  available: boolean
  reason: string | null
  host: string | null
  previews: Preview[]
}

export const fetchPreviews = () => get<PreviewState>('/api/previews')

/** Just "is anything behind these ports" — cheap enough to poll. */
export const fetchLiveness = (ports: number[]) =>
  get<Record<string, boolean>>(`/api/previews/live?ports=${ports.join(',')}`)

export const startPreview = async (port: number): Promise<Preview> => {
  const res = await authFetch('/api/previews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? `share failed: ${res.status}`)
  return res.json()
}

export const stopPreview = async (publicPort: number): Promise<void> => {
  const res = await authFetch(`/api/previews/${publicPort}`, { method: 'DELETE' })
  if (!res.ok) throw new Error((await res.json()).error ?? `stop failed: ${res.status}`)
}

/* ---- What the agent changed ---- */

const post = async <T>(url: string, body: unknown): Promise<T> => {
  const res = await authFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? `${url}: ${res.status}`)
  return res.json()
}

export interface FileChange {
  path: string
  /** Index status letter, a space when the file is not staged at all. */
  staged: string
  /** Working-tree status letter, `?` for untracked. */
  worktree: string
  from: string | null
  added: number
  removed: number
  binary: boolean
}

export interface GitStatus {
  repo: boolean
  root: string | null
  branch: string | null
  upstream: string | null
  /** Whether there is anywhere to push to at all. */
  hasRemote: boolean
  ahead: number
  behind: number
  files: FileChange[]
  head: { sha: string; subject: string } | null
}

export interface GitDiff {
  file: string
  patch: string
  truncated: boolean
  binary: boolean
}

export const fetchGitStatus = (cwd: string) =>
  get<GitStatus>(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)

export const fetchGitDiff = (cwd: string, file: string, staged: boolean) =>
  get<GitDiff>(
    `/api/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}${
      staged ? '&staged=1' : ''
    }`,
  )

/** Stage (`add`) or unstage a set of paths; answers with the status that follows. */
export const stageFiles = (cwd: string, files: string[], add: boolean) =>
  post<GitStatus>('/api/git/stage', { cwd, files, add })

export const commitStaged = (cwd: string, message: string) =>
  post<{
    sha: string
    subject: string
    files: number
    added: number
    removed: number
    status: GitStatus
  }>('/api/git/commit', { cwd, message })

export const pushBranch = (cwd: string) =>
  post<{ message: string; status: GitStatus }>('/api/git/push', { cwd })

export const pushKey = () => get<{ publicKey: string }>('/api/push/key')

export const subscribeToPush = async (subscription: unknown): Promise<void> => {
  const res = await authFetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? `subscribe failed: ${res.status}`)
}

export const uploadImage = async (file: File): Promise<{ path: string }> => {
  const res = await authFetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    body: file,
  })
  if (!res.ok) throw new Error((await res.json()).error ?? `upload failed: ${res.status}`)
  return res.json()
}
