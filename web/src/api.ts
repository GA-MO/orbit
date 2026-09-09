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
  /** Orbit noticed the session go quiet; the agent did not say anything. */
  idle?: boolean
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
  /** The conversation this session holds, where the agent lets Orbit name one. */
  conversationId: string | null
  /** ↻ would reach the conversation this row is actually about. */
  resumable: boolean
  /** Ran in a terminal on the Mac — Orbit reads its transcript and owns nothing. */
  external: boolean
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
/** The session this phone last had open — written by the app shell. */
export const SESSION_KEY = 'orbit.sessionId'
/** Folders sessions have been started in — written by the new-session sheet. */
export const RECENTS_KEY = 'orbit.recentDirs'

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

/* A write that returned the Response as-is let its caller "succeed" on a
   4xx: the rename showed the old name and nothing said why. */
const send = async (url: string, init: RequestInit): Promise<void> => {
  const res = await authFetch(url, init)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `${url}: ${res.status}`)
  }
}

/**
 * A pairing code — from the QR on the Mac's screen, by way of the address the
 * camera opened or the login screen's own scanner — exchanged for the token.
 * False means the code is not good any more; the server says nothing more
 * specific, on purpose.
 */
export const pairWithCode = async (code: string): Promise<boolean> => {
  const res = await fetch('/api/auth/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!res.ok) return false
  const { token } = await res.json()
  if (typeof token !== 'string' || !token) return false
  setToken(token)
  return true
}

/** The pairing code in an address the camera opened, or that the scanner read. */
export const pairCodeIn = (text: string): string | null =>
  text.match(/#pair=([A-Za-z0-9_-]{8,})\s*$/)?.[1] ?? null

export const checkAuth = async (): Promise<boolean> => {
  try {
    await get('/api/auth/check')
    return true
  } catch (e) {
    if (e instanceof AuthError) return false
    throw e
  }
}

/**
 * Un-pair this phone from the Mac: the server expires the session cookie and
 * retires this browser's push subscription, then everything the phone was
 * holding on to goes.
 *
 * The server call comes first and nothing local is thrown away unless it
 * succeeds. Clearing storage on a failed request would leave a phone with no
 * token but a live cookie — logged out of the app while still able to open a
 * socket, which is the exact half-signed-out state this whole route exists to
 * avoid, and unrecoverable without retyping the token.
 *
 * What is forgotten is what names this Mac or reaches it: the token, the
 * session that was on screen, and the folders sessions were started in — the
 * next person to hold the phone should not be given a listing of someone's
 * projects. What survives is what describes the phone rather than the Mac —
 * the dictation language, whether the mic was granted, whether the key row was
 * expanded, the capture viewport. None of it is a credential and none of it
 * says anything about the machine that was paired, so destroying it would only
 * make re-pairing feel like a factory reset.
 */
export const unpairPhone = async (pushEndpoint: string | null): Promise<void> => {
  const res = await authFetch('/api/auth/unpair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: pushEndpoint }),
  })
  if (!res.ok) throw new Error(`unpair failed: ${res.status}`)
  for (const key of [TOKEN_KEY, SESSION_KEY, RECENTS_KEY]) localStorage.removeItem(key)
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

export const killSession = (id: string) => send(`/api/sessions/${id}`, { method: 'DELETE' })

/* A conversation from the Mac has no ✕ — its history is Claude Code's file and
   Orbit only reads it. Hiding is what the phone can honestly offer instead: the
   row goes away, the transcript does not. */
export const hideSession = (id: string) => send(`/api/sessions/${id}/hide`, { method: 'POST' })

export const fetchHiddenCount = () => get<{ hidden: number }>('/api/sessions/hidden')

export const unhideSessions = () => send('/api/sessions/unhide', { method: 'POST' })

export const renameSession = (id: string, name: string) =>
  send(`/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })

/** Mark a session's word as read — sent when it is actually on screen. */
export const clearAttention = (id: string) =>
  send(`/api/sessions/${id}/attention`, { method: 'DELETE' })

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
  /** The project it is serving, when the Mac can say — the basename of the
      process's working directory. Absent when it cannot be determined. */
  project?: string
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

/**
 * Move one hunk into the index (`staged: false`) or take it back out
 * (`staged: true`) — which side it came from is which direction it goes.
 */
export const applyHunk = (cwd: string, file: string, hunk: string, staged: boolean) =>
  post<GitStatus>('/api/git/hunk', { cwd, file, hunk, staged })

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
