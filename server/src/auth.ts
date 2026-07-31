import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG_FILE = path.join(os.homedir(), '.orbit', 'config.json')

/** Load the access token, generating and persisting one on first run. */
export function getToken(): string {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (typeof config.token === 'string' && config.token.length >= 8) return config.token
  } catch {
    // fall through to generate
  }
  const token = randomBytes(12).toString('base64url')
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ token }, null, 2))
  return token
}
