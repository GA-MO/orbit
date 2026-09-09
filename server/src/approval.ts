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

const KEYSTROKE_MAX_LENGTH = 3
const LINE_MAX_CHARS = 200

export interface Danger {
  label: string
  line: string
}

export function screen(chunk: string): Danger | null {
  if (chunk.length <= KEYSTROKE_MAX_LENGTH) return null
  return screenCommand(chunk)
}

const lineContaining = (text: string, index: number): string => {
  const lineStart = text.lastIndexOf('\n', index) + 1
  const lineEnd = text.indexOf('\n', index)
  return text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()
}

export function screenCommand(command: string): Danger | null {
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    const match = command.match(pattern)
    if (match) {
      const line = lineContaining(command, command.indexOf(match[0]))
      return { label, line: line.slice(0, LINE_MAX_CHARS) }
    }
  }
  return null
}
