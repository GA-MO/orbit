/**
 * Wire Orbit into Claude Code — MCP server and hooks — in one command.
 *
 * Everything here was once a block of JSON in docs/MCP.md that a new person
 * copied by hand, with `/Users/<you>/` left for them to substitute. All three
 * ways of getting that wrong fail *silently*:
 *
 *   - a path that points nowhere      → the phone simply never buzzes
 *   - a forgotten `"timeout": 190`    → the approval hook is cut off at 60s and
 *                                       a dangerous command slips past while
 *                                       nobody has tapped anything yet
 *   - registering before the build    → an MCP server that is not on disk
 *
 * So the launcher is whatever is running this (see launcher.ts), the timeout
 * comes with the hook it belongs to, and a checkout builds before it gets here
 * (`make setup`); the executable has nothing to build.
 *
 *   orbit setup              # register the MCP server, wire up the hooks
 *   orbit setup --uninstall  # take all of it back out
 *
 * Idempotent by construction: every hook Orbit owns is removed from the
 * settings file before the current set is written back, so running it twice
 * changes nothing, and running it after the program has moved repairs the
 * paths rather than leaving a second, broken copy behind. Hooks belonging to
 * anything else are carried across untouched.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { launcher, launcherArgv } from './launcher.js'

type Json = Record<string, any>

interface HookEntry {
  event: string
  matcher?: string
  command: string
  timeout?: number
}

/** What marks a hook entry as ours, wherever in the file it has ended up — including the ones the old scripts installed. */
const OUR_MARKS = [' hook approve', ' hook notify', 'orbit-approve.mjs', 'orbit-notify-hook.mjs']

export const isOurs = (command: unknown): boolean =>
  typeof command === 'string' && OUR_MARKS.some((mark) => command.includes(mark))

/**
 * The hooks Orbit installs, as data — so the test can assert on the plan
 * instead of on a rendered settings file.
 *
 * `Stop` and `Notification` take no matcher: they are not tool calls, and a
 * matcher on them matches nothing.
 */
export const hookPlan = (start = launcher()): HookEntry[] => [
  { event: 'PreToolUse', matcher: 'AskUserQuestion', command: `${start} hook notify` },
  /* 190 rather than the default 60: the hook waits up to 180 seconds for a
     tap. Cut short, it fails open on a command it was meant to hold. */
  { event: 'PreToolUse', matcher: 'Bash', command: `${start} hook approve`, timeout: 190 },
  { event: 'Notification', command: `${start} hook notify` },
  { event: 'Stop', command: `${start} hook notify` },
]

/** The settings file with every Orbit hook taken out, and nothing else changed. */
export const withoutOrbit = (settings: Json | null | undefined): Json => {
  const next: Json = structuredClone(settings ?? {})
  const hooks = next.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return next

  for (const [event, groups] of Object.entries(hooks as Json)) {
    if (!Array.isArray(groups)) continue
    const kept: Json[] = []
    for (const group of groups) {
      const entries: Json[] = Array.isArray(group?.hooks) ? group.hooks : []
      const remaining = entries.filter((entry) => !isOurs(entry?.command))
      if (remaining.length === entries.length) kept.push(group)
      /* A group that held ours *and* someone else's keeps the rest; one that
         held nothing else goes with it, rather than lingering as `hooks: []`. */
      else if (remaining.length > 0) kept.push({ ...group, hooks: remaining })
    }
    if (kept.length > 0) hooks[event] = kept
    else delete hooks[event]
  }
  if (Object.keys(hooks).length === 0) delete next.hooks
  return next
}

/** The settings file with exactly this program's hooks in it. */
export const withOrbit = (settings: Json | null | undefined, start = launcher()): Json => {
  const next = withoutOrbit(settings)
  const hooks: Json = (next.hooks ??= {})
  for (const { event, matcher, command, timeout } of hookPlan(start)) {
    const entry: Json = { type: 'command', command }
    if (timeout) entry.timeout = timeout
    const group = matcher ? { matcher, hooks: [entry] } : { hooks: [entry] }
    ;(hooks[event] ??= []).push(group)
  }
  return next
}

// ── doing it ────────────────────────────────────────────────────────────────

const say = (line = '') => console.log(line ? `  ${line}` : '')

export const settingsPath = () => path.join(os.homedir(), '.claude', 'settings.json')

const readJson = (file: string): Json => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    /* A settings file we cannot parse is one we must not overwrite — the user's
       own hooks are in there, and a rewrite would be their only copy gone. */
    throw new Error(`${file} is not valid JSON — fix it first (${(err as Error).message})`)
  }
}

const run = (command: string, args: string[]) => {
  try {
    return { ok: true, out: execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' }).trim() }
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string }
    return { ok: false, out: `${e.stderr ?? ''}${e.stdout ?? ''}`.trim() || e.message }
  }
}

export function runSetup(args: string[]): number {
  const uninstall = args.includes('--uninstall')
  const start = launcher()

  say()
  say(uninstall ? 'Removing Orbit from Claude Code …' : `Setting up Orbit (${start}) …`)
  say()

  // ── hooks ─────────────────────────────────────────────
  const settingsFile = settingsPath()
  let before: Json
  try {
    before = readJson(settingsFile)
  } catch (err) {
    say((err as Error).message)
    return 1
  }
  const after = uninstall ? withoutOrbit(before) : withOrbit(before, start)

  if (JSON.stringify(before) === JSON.stringify(after)) {
    say(`Hooks already as they should be — ${settingsFile}`)
  } else {
    if (fs.existsSync(settingsFile)) {
      /* Their own hooks live in this file too. One copy of what it said before
         costs nothing and is the difference between a mistake and a loss. */
      fs.copyFileSync(settingsFile, `${settingsFile}.orbit.bak`)
      say(`Backed up  ${settingsFile}.orbit.bak`)
    }
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    fs.writeFileSync(settingsFile, `${JSON.stringify(after, null, 2)}\n`)
    say(`${uninstall ? 'Removed hooks from' : 'Wrote hooks to'}  ${settingsFile}`)
  }

  // ── MCP server ────────────────────────────────────────
  /* Removed first either way: `add` on a name that exists is an error, and this
     is also what repairs the path after the program has moved. */
  const removed = run('claude', ['mcp', 'remove', '-s', 'user', 'orbit'])
  if (uninstall) {
    /* "Unregistered" regardless of whether it was would leave a registration
       behind and say otherwise. `remove` on a name that is not there is also
       an error, and that one is fine. */
    if (removed.ok || /not found|no .*server/i.test(removed.out)) say('Unregistered  orbit (MCP)')
    else {
      say('Could not unregister the MCP server with the `claude` CLI:')
      console.log(removed.out)
      say('Is Claude Code on PATH? Then run this again, or `claude mcp remove -s user orbit` by hand.')
    }
  } else {
    const added = run('claude', ['mcp', 'add', '-s', 'user', 'orbit', '--', ...launcherArgv(), 'mcp'])
    if (added.ok) {
      say(`Registered  orbit → ${start} mcp`)
    } else {
      say('Could not register the MCP server with the `claude` CLI:')
      console.log(added.out)
      say('Is Claude Code installed and on PATH? Then run this again.')
      return 1
    }
  }

  say()
  if (uninstall) {
    say('Done. Orbit itself is untouched — this only unwired Claude Code.')
  } else {
    say('Done. Restart any Claude Code session that is already open:')
    say('the MCP server is spawned when a session starts, so this one still')
    say('holds the previous build.')
    say()
    say(`Next:  ${start} phone      (serve over Tailscale, open it on the phone)`)
    say(`Undo:  ${start} setup --uninstall`)
  }
  say()
  return 0
}
