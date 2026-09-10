import { execFile } from 'node:child_process'

export interface Provider {
  id: string
  name: string
  command: string | null
  resumeCommand: string | null
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
]

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

const AVAILABILITY_TTL_MS = 60_000
const COMMAND_LOOKUP_TIMEOUT_MS = 8000

let cached: Record<string, boolean> | null = null
let cachedAt = 0

const isOnUsersLoginShellPath = (command: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(
      '/bin/zsh',
      ['-l', '-i', '-c', `command -v ${command}`],
      { timeout: COMMAND_LOOKUP_TIMEOUT_MS },
      (err) => resolve(!err),
    )
  })

export async function detectAvailability(): Promise<Record<string, boolean>> {
  if (cached && Date.now() - cachedAt < AVAILABILITY_TTL_MS) return cached

  const entries = await Promise.all(
    PROVIDERS.map(async (p): Promise<[string, boolean]> => {
      if (!p.command) return [p.id, true]
      return [p.id, await isOnUsersLoginShellPath(p.command)]
    }),
  )

  cached = Object.fromEntries(entries)
  cachedAt = Date.now()
  return cached
}
