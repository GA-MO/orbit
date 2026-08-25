import { execFile } from 'node:child_process'

export interface Provider {
  id: string
  name: string
  /** CLI command to launch; null means a plain login shell. */
  command: string | null
  /**
   * Command that picks the last conversation in this folder back up, for
   * agents that keep one. Null means starting again is the only option.
   */
  resumeCommand: string | null
  /**
   * For agents that let the caller name a conversation: the launch command with
   * that name pinned to it, and the command that reopens exactly that one.
   * A folder's newest conversation is then no longer the only one reachable.
   */
  conversation?: { start(id: string): string; resume(id: string): string }
}

export const PROVIDERS: Provider[] = [
  { id: 'shell', name: 'Shell', command: null, resumeCommand: null },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    resumeCommand: 'claude --continue',
    conversation: {
      start: (id) => `claude --session-id ${id}`,
      resume: (id) => `claude --resume ${id}`,
    },
  },
  { id: 'codex', name: 'Codex CLI', command: 'codex', resumeCommand: 'codex resume --last' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', resumeCommand: null },
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
