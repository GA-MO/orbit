import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'

import { orbitDir } from './home.js'

const CONFIG_FILE = orbitDir('config.json')
const OWNER_ONLY = 0o600
const MIN_TOKEN_LENGTH = 8
const TOKEN_BYTES = 12

const storedToken = (): string | null => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (typeof config.token === 'string' && config.token.length >= MIN_TOKEN_LENGTH) {
      fs.chmodSync(CONFIG_FILE, OWNER_ONLY)
      return config.token
    }
  } catch {}
  return null
}

const generateAndStoreToken = (): string => {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ token }, null, 2), { mode: OWNER_ONLY })
  return token
}

export function getToken(): string {
  return storedToken() ?? generateAndStoreToken()
}

export const SESSION_COOKIE = 'orbit_session'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365
const EXPIRED_MAX_AGE = 0

const sessionValue = (token: string) =>
  createHash('sha256').update(`orbit-session:${token}`).digest('hex')

const cookie = (value: string, maxAge: number, secure: boolean): string => {
  const attrs = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`]
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}

export const sessionCookie = (token: string, secure: boolean): string =>
  cookie(sessionValue(token), COOKIE_MAX_AGE, secure)

export const expiredSessionCookie = (secure: boolean): string => cookie('', EXPIRED_MAX_AGE, secure)

export function matches(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const cookieValueNamed = (header: string, name: string): string | null => {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return part.slice(eq + 1).trim()
  }
  return null
}

export function hasSessionCookie(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.cookie
  if (!header) return false
  const given = cookieValueNamed(header, SESSION_COOKIE)
  if (given === null) return false
  return matches(given, sessionValue(token))
}

export const isSecureRequest = (req: http.IncomingMessage): boolean =>
  req.headers['x-forwarded-proto'] === 'https' ||
  !!(req.socket as { encrypted?: boolean }).encrypted
