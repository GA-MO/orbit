/**
 * Screening for dangerous commands in terminal input.
 *
 * Only multi-character chunks are screened (paste, voice input, automation) —
 * interactive keystrokes arrive one character at a time and are the user's own
 * deliberate typing, which cannot be reconstructed reliably anyway.
 */

const DANGEROUS_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s*)+/i, label: 'recursive/forced delete (rm -rf)' },
  { pattern: /\bsudo\b/, label: 'privileged command (sudo)' },
  { pattern: /\bmkfs\b|\bdiskutil\s+(erase|partition)/i, label: 'disk format' },
  { pattern: /\bdd\s+[^|]*of=\/dev\//, label: 'raw disk write (dd)' },
  { pattern: /\b(shutdown|reboot|halt)\b/, label: 'system power command' },
  { pattern: /git\s+push\s+[^\n]*(--force|-f)\b/, label: 'git force push' },
  { pattern: /:\(\)\s*\{.*\}\s*;?\s*:/, label: 'fork bomb' },
  { pattern: /\bchmod\s+(-[a-z]*R[a-z]*\s+)?777\s+\//i, label: 'chmod 777 on root path' },
  { pattern: />\s*\/dev\/(sd|disk)/, label: 'write to raw device' },
  { pattern: /\blaunchctl\s+(unload|remove)/, label: 'disable system service' },
]

export interface Danger {
  label: string
  /** The line that matched, for display in the approval prompt. */
  line: string
}

export function screen(chunk: string): Danger | null {
  // Single keystrokes and control sequences pass through untouched.
  if (chunk.length <= 3) return null
  return screenCommand(chunk)
}

/**
 * Screen a command known to be whole — an agent's tool call rather than a
 * stream of keystrokes, so there is no length below which it is only typing.
 */
export function screenCommand(command: string): Danger | null {
  const chunk = command
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    const match = chunk.match(pattern)
    if (match) {
      const index = chunk.indexOf(match[0])
      const lineStart = chunk.lastIndexOf('\n', index) + 1
      const lineEnd = chunk.indexOf('\n', index)
      const line = chunk.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()
      return { label, line: line.slice(0, 200) }
    }
  }
  return null
}
