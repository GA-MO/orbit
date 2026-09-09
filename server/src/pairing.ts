import { randomBytes, timingSafeEqual } from 'node:crypto'
import os from 'node:os'

const TTL_MS = 10 * 60 * 1000
const USES = 10
const CODE_BYTES = 9
const TRAILING_SLASH = /\/$/

interface Code {
  code: string
  expiresAt: number
  usesLeft: number
}

const codes = new Map<string, Code>()

const isSpent = (entry: Code, now: number): boolean => entry.expiresAt <= now || entry.usesLeft <= 0

const sweep = (now: number) => {
  for (const [key, entry] of codes) if (isSpent(entry, now)) codes.delete(key)
}

export function mint(): { code: string; expiresAt: number } {
  const now = Date.now()
  sweep(now)
  const code = randomBytes(CODE_BYTES).toString('base64url')
  const entry = { code, expiresAt: now + TTL_MS, usesLeft: USES }
  codes.set(code, entry)
  return { code, expiresAt: entry.expiresAt }
}

const sameCode = (have: string, want: Buffer): boolean => {
  const haveBytes = Buffer.from(have)
  return haveBytes.length === want.length && timingSafeEqual(haveBytes, want)
}

export function redeem(candidate: string): boolean {
  const now = Date.now()
  sweep(now)
  const want = Buffer.from(candidate)
  for (const entry of codes.values()) {
    if (!sameCode(entry.code, want)) continue
    entry.usesLeft--
    return true
  }
  return false
}

export const pairUrl = (base: string, code: string) => `${base.replace(TRAILING_SLASH, '')}/#pair=${code}`

export function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) return nic.address
    }
  }
  return null
}
