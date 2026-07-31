import { execFile } from 'node:child_process'

export interface Provider {
  id: string
  name: string
  /** CLI command to launch; null means a plain login shell. */
  command: string | null
}

export const PROVIDERS: Provider[] = [
  { id: 'shell', name: 'Shell', command: null },
  { id: 'claude', name: 'Claude Code', command: 'claude' },
  { id: 'codex', name: 'Codex CLI', command: 'codex' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini' },
]

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

const AVAILABILITY_TTL_MS = 60_000
let cached: Record<string, boolean> | null = null
let cachedAt = 0

/**
 * Check which provider CLIs exist. Runs through an interactive login shell so
 * the user's real PATH (homebrew, npm globals, ~/.zshrc additions) applies.
 */
export async function detectAvailability(): Promise<Record<string, boolean>> {
  if (cached && Date.now() - cachedAt < AVAILABILITY_TTL_MS) return cached

  const entries = await Promise.all(
    PROVIDERS.map(async (p): Promise<[string, boolean]> => {
      if (!p.command) return [p.id, true]
      const ok = await new Promise<boolean>((resolve) => {
        execFile(
          '/bin/zsh',
          ['-l', '-i', '-c', `command -v ${p.command}`],
          { timeout: 8000 },
          (err) => resolve(!err),
        )
      })
      return [p.id, ok]
    }),
  )

  cached = Object.fromEntries(entries)
  cachedAt = Date.now()
  return cached
}
