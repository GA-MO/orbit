export interface ProviderInfo {
  id: string
  name: string
  available: boolean
}

export type AttentionKind = 'waiting' | 'done'

export interface Attention {
  kind: AttentionKind
  message: string
  at: string
  idle?: boolean
}

export interface SessionInfo {
  id: string
  name: string | null
  firstCommand: string | null
  providerId: string
  providerName: string
  cwd: string
  createdAt: string
  endedAt: string | null
  exitCode: number | null
  alive: boolean
  conversationId: string | null
  resumable: boolean
  external: boolean
  attention?: Attention | null
}

export interface DirListing {
  path: string
  parent: string | null
  isRepo: boolean
  dirs: { name: string; git: boolean }[]
}

const TOKEN_KEY = 'orbit.token'
export const SESSION_KEY = 'orbit.sessionId'
export const RECENTS_KEY = 'orbit.recentDirs'

const KEYS_THAT_NAME_THE_MAC = [TOKEN_KEY, SESSION_KEY, RECENTS_KEY]

const PAIR_CODE_IN_FRAGMENT = /#pair=([A-Za-z0-9_-]{8,})\s*$/

export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? ''
export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token)
export const hasToken = () => getToken() !== ''

export class AuthError extends Error {
  constructor() {
    super('unauthorized')
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

const withBearer = (headers: HeadersInit): HeadersInit => {
  const token = getToken()
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers
}

const authFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const res = await fetch(url, { ...init, headers: withBearer(init.headers ?? {}) })
  if (res.status === 401) throw new AuthError()
  return res
}

const get = async <T>(url: string): Promise<T> => {
  const res = await authFetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json()
}

const send = async (url: string, init: RequestInit): Promise<void> => {
  const res = await authFetch(url, init)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `${url}: ${res.status}`)
  }
}

const errorIn = async (res: Response, fallback: string): Promise<Error> =>
  new Error((await res.json()).error ?? fallback)

export const pairWithCode = async (code: string): Promise<boolean> => {
  const res = await fetch('/api/auth/pair', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ code }),
  })
  if (!res.ok) return false
  const { token } = await res.json()
  if (typeof token !== 'string' || !token) return false
  setToken(token)
  return true
}

export const pairCodeIn = (text: string): string | null =>
  text.match(PAIR_CODE_IN_FRAGMENT)?.[1] ?? null

export const checkAuth = async (): Promise<boolean> => {
  try {
    await get('/api/auth/check')
    return true
  } catch (e) {
    if (e instanceof AuthError) return false
    throw e
  }
}

export const checkAuthWithoutToken = async (): Promise<boolean> => {
  const res = await fetch('/api/auth/check')
  if (res.status === 401) return false
  if (!res.ok) throw new Error(`/api/auth/check: ${res.status}`)
  return true
}

export const retirePushSubscription = async (pushEndpoint: string | null): Promise<void> => {
  const res = await authFetch('/api/auth/unpair', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ endpoint: pushEndpoint }),
  })
  if (!res.ok) throw new Error(`unpair failed: ${res.status}`)
}

export const unpairPhone = async (pushEndpoint: string | null): Promise<void> => {
  await retirePushSubscription(pushEndpoint)
  forgetTheMac()
}

const forgetTheMac = () => {
  for (const key of KEYS_THAT_NAME_THE_MAC) localStorage.removeItem(key)
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
    headers: JSON_HEADERS,
    body: JSON.stringify({ provider, cwd, name }),
  })
  if (!res.ok) throw await errorIn(res, `create failed: ${res.status}`)
  return res.json()
}

export const killSession = (id: string) => send(`/api/sessions/${id}`, { method: 'DELETE' })

export const hideSession = (id: string) => send(`/api/sessions/${id}/hide`, { method: 'POST' })

export const fetchHiddenCount = () => get<{ hidden: number }>('/api/sessions/hidden')

export const unhideSessions = () => send('/api/sessions/unhide', { method: 'POST' })

export const renameSession = (id: string, name: string) =>
  send(`/api/sessions/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  })

export const clearAttention = (id: string) =>
  send(`/api/sessions/${id}/attention`, { method: 'DELETE' })

export const restartSession = async (id: string, resume = false): Promise<SessionInfo> => {
  const res = await authFetch(`/api/sessions/${id}/restart`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ resume }),
  })
  if (!res.ok) throw await errorIn(res, `restart failed: ${res.status}`)
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
  kind: 'url' | 'screen'
  label: string | null
  width: number | null
  height: number | null
}

export const captureScreenshot = async (opts: {
  url: string
  preset?: PresetId
  fullPage?: boolean
  width?: number
  label?: string
}): Promise<Screenshot> => {
  const res = await authFetch('/api/screenshot', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(opts),
  })
  if (!res.ok) throw await errorIn(res, `capture failed: ${res.status}`)
  return res.json()
}

export interface DevPort {
  port: number
  command: string
  project?: string
}

export const fetchDevPorts = () => get<DevPort[]>('/api/ports')

export const fetchScreenshots = () => get<Screenshot[]>('/api/screenshots')

export const deleteScreenshot = (file: string) =>
  authFetch(`/api/screenshots/${file}`, { method: 'DELETE' })

export const screenshotUrl = (file: string) => `/api/screenshots/${file}`

export interface Preview {
  port: number
  publicPort: number
  url: string
  listening: boolean
}

export interface PreviewState {
  available: boolean
  reason: string | null
  host: string | null
  previews: Preview[]
}

export const fetchPreviews = () => get<PreviewState>('/api/previews')

export const fetchLiveness = (ports: number[]) =>
  get<Record<string, boolean>>(`/api/previews/live?ports=${ports.join(',')}`)

export const startPreview = async (port: number): Promise<Preview> => {
  const res = await authFetch('/api/previews', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ port }),
  })
  if (!res.ok) throw await errorIn(res, `share failed: ${res.status}`)
  return res.json()
}

export const stopPreview = async (publicPort: number): Promise<void> => {
  const res = await authFetch(`/api/previews/${publicPort}`, { method: 'DELETE' })
  if (!res.ok) throw await errorIn(res, `stop failed: ${res.status}`)
}

const post = async <T>(url: string, body: unknown): Promise<T> => {
  const res = await authFetch(url, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await errorIn(res, `${url}: ${res.status}`)
  return res.json()
}

export interface FileChange {
  path: string
  staged: string
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

export const stageFiles = (cwd: string, files: string[], add: boolean) =>
  post<GitStatus>('/api/git/stage', { cwd, files, add })

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
    headers: JSON_HEADERS,
    body: JSON.stringify(subscription),
  })
  if (!res.ok) throw await errorIn(res, `subscribe failed: ${res.status}`)
}

export const uploadImage = async (file: File): Promise<{ path: string }> => {
  const res = await authFetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    body: file,
  })
  if (!res.ok) throw await errorIn(res, `upload failed: ${res.status}`)
  return res.json()
}
