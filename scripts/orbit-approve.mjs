#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — routes the agent's own dangerous commands to
 * the phone for approval.
 *
 * Orbit already screens what *you* send into a terminal, but a command the
 * agent runs through its Bash tool never crosses that boundary: it is executed
 * inside the agent process, not typed into the PTY. This hook closes that gap
 * using the same pattern list, so `rm -rf` is `rm -rf` whoever typed it.
 *
 * Install (in the project's .claude/settings.json):
 *
 *   "hooks": {
 *     "PreToolUse": [
 *       {
 *         "matcher": "Bash",
 *         "hooks": [{ "type": "command", "command": "node <repo>/scripts/orbit-approve.mjs" }]
 *       }
 *     ]
 *   }
 *
 * Fails open when Orbit is not running — Claude Code stays usable on its own.
 * Fails closed when Orbit is running and nobody answers.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.ORBIT_PORT ?? 3001)
const TIMEOUT_SECONDS = 180

const allow = () => process.exit(0) // silent: Claude Code's normal permission flow continues

const deny = (reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
  process.exit(0)
}

const readStdin = () =>
  new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (data += c))
    process.stdin.on('end', () => resolve(data))
    setTimeout(() => resolve(data), 5000).unref()
  })

const token = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit', 'config.json'), 'utf8')).token
  } catch {
    return null
  }
}

const input = await readStdin()
  .then(JSON.parse)
  .catch(() => null)
if (!input) allow()

const command = input.tool_input?.command
if (input.tool_name !== 'Bash' || typeof command !== 'string') allow()

// The same patterns the server applies to terminal input.
const { screenCommand } = await import(
  pathToFileURL(path.join(REPO, 'server/dist/approval.js'))
).catch(() => ({ screenCommand: null }))
if (!screenCommand) allow()

const danger = screenCommand(command)
if (!danger) allow()

const accessToken = token()
if (!accessToken) allow()

let result
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      question: `Claude wants to run a ${danger.label}`,
      detail: command.slice(0, 2000),
      // Safe choice first: the phone emphasises the first option.
      options: ['Block', 'Run it'],
      source: input.cwd ?? null,
      timeoutSeconds: TIMEOUT_SECONDS,
    }),
  })
  if (!res.ok) allow() // Orbit is up but unhappy — do not hold the agent hostage
  result = await res.json()
} catch {
  allow() // Orbit is not running: this is a plain Claude Code session
}

if (result.answer === 'Run it') allow()
if (result.timedOut) {
  deny(
    result.phonesConnected === 0
      ? `Blocked: this ${danger.label} needs approval on the Orbit phone, and no phone is connected. Ask the user directly.`
      : `Blocked: nobody approved this ${danger.label} on the phone within ${TIMEOUT_SECONDS}s.`,
  )
}
deny(`The user blocked this ${danger.label} from their phone.`)
