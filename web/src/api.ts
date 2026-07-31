export interface ProviderInfo {
  id: string
  name: string
  available: boolean
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

export const restartSession = async (id: string): Promise<SessionInfo> => {
  const res = await authFetch(`/api/sessions/${id}/restart`, { method: 'POST' })
  if (!res.ok) throw new Error((await res.json()).error ?? `restart failed: ${res.status}`)
  return res.json()
}

export interface Screenshot {
  file: string
  path: string
  createdAt: string
  size: number
}

export const captureScreenshot = async (
  url: string,
  fullPage = false,
): Promise<Screenshot> => {
  const res = await authFetch('/api/screenshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, fullPage }),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? `capture failed: ${res.status}`)
  return res.json()
}

export const fetchScreenshots = () => get<Screenshot[]>('/api/screenshots')

export const deleteScreenshot = (file: string) =>
  authFetch(`/api/screenshots/${file}`, { method: 'DELETE' })

/** Image URL usable in <img src> — auth via query token since headers aren't possible there. */
export const screenshotUrl = (file: string) =>
  `/api/screenshots/${file}?token=${encodeURIComponent(getToken())}`

export const uploadImage = async (file: File): Promise<{ path: string }> => {
  const res = await authFetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    body: file,
  })
  if (!res.ok) throw new Error((await res.json()).error ?? `upload failed: ${res.status}`)
  return res.json()
}
