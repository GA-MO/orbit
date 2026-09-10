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

const OUR_MARKS = [' hook approve', ' hook notify', 'orbit-approve.mjs', 'orbit-notify-hook.mjs']

const APPROVE_HOOK_TIMEOUT_S = 190

const MCP_SERVER_NAME = 'orbit'
const MCP_SCOPE_ARGS = ['-s', 'user']
const NOT_REGISTERED = /not found|no .*server/i

export const isOurs = (command: unknown): boolean =>
  typeof command === 'string' && OUR_MARKS.some((mark) => command.includes(mark))

export interface SetupOptions {
  approval: boolean
}

export const DEFAULT_OPTIONS: SetupOptions = { approval: false }

export const hookPlan = (start = launcher(), options: SetupOptions = DEFAULT_OPTIONS): HookEntry[] => {
  const notify: HookEntry[] = [
    { event: 'PreToolUse', matcher: 'AskUserQuestion', command: `${start} hook notify` },
    { event: 'Notification', command: `${start} hook notify` },
    { event: 'Stop', command: `${start} hook notify` },
  ]
  const approve: HookEntry[] = options.approval
    ? [{ event: 'PreToolUse', matcher: 'Bash', command: `${start} hook approve`, timeout: APPROVE_HOOK_TIMEOUT_S }]
    : []
  return [notify[0], ...approve, notify[1], notify[2]]
}

const isPlainObject = (value: unknown): value is Json =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const withoutOurEntries = (groups: Json[]): Json[] => {
  const kept: Json[] = []
  for (const group of groups) {
    const entries: Json[] = Array.isArray(group?.hooks) ? group.hooks : []
    const remaining = entries.filter((entry) => !isOurs(entry?.command))
    if (remaining.length === entries.length) kept.push(group)
    else if (remaining.length > 0) kept.push({ ...group, hooks: remaining })
  }
  return kept
}

export const withoutOrbit = (settings: Json | null | undefined): Json => {
  const next: Json = structuredClone(settings ?? {})
  const hooks = next.hooks
  if (!isPlainObject(hooks)) return next

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    const kept = withoutOurEntries(groups)
    if (kept.length > 0) hooks[event] = kept
    else delete hooks[event]
  }
  if (Object.keys(hooks).length === 0) delete next.hooks
  return next
}

const toSettingsGroup = ({ matcher, command, timeout }: HookEntry): Json => {
  const entry: Json = { type: 'command', command }
  if (timeout) entry.timeout = timeout
  return matcher ? { matcher, hooks: [entry] } : { hooks: [entry] }
}

export const withOrbit = (
  settings: Json | null | undefined,
  start = launcher(),
  options: SetupOptions = DEFAULT_OPTIONS,
): Json => {
  const next = withoutOrbit(settings)
  const hooks: Json = (next.hooks ??= {})
  for (const planned of hookPlan(start, options)) {
    ;(hooks[planned.event] ??= []).push(toSettingsGroup(planned))
  }
  return next
}

const say = (line = '') => console.log(line ? `  ${line}` : '')

export const settingsPath = () => path.join(os.homedir(), '.claude', 'settings.json')

const readJson = (file: string): Json => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`${file} is not valid JSON — fix it first (${(err as Error).message})`)
  }
}

interface RunResult {
  ok: boolean
  out: string
}

const run = (command: string, args: string[]): RunResult => {
  try {
    return { ok: true, out: execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' }).trim() }
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string }
    return { ok: false, out: `${e.stderr ?? ''}${e.stdout ?? ''}`.trim() || e.message }
  }
}

const sameJson = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b)

function writeSettings(settingsFile: string, after: Json, uninstall: boolean): void {
  if (fs.existsSync(settingsFile)) {
    fs.copyFileSync(settingsFile, `${settingsFile}.orbit.bak`)
    say(`Backed up  ${settingsFile}.orbit.bak`)
  }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, `${JSON.stringify(after, null, 2)}\n`)
  say(`${uninstall ? 'Removed hooks from' : 'Wrote hooks to'}  ${settingsFile}`)
}

function updateHooks(uninstall: boolean, start: string, options: SetupOptions): boolean {
  const settingsFile = settingsPath()
  let before: Json
  try {
    before = readJson(settingsFile)
  } catch (err) {
    say((err as Error).message)
    return false
  }
  const after = uninstall ? withoutOrbit(before) : withOrbit(before, start, options)

  if (sameJson(before, after)) {
    say(`Hooks already as they should be — ${settingsFile}`)
  } else {
    writeSettings(settingsFile, after, uninstall)
  }
  return true
}

function unregisterMcp(removed: RunResult): void {
  if (removed.ok || NOT_REGISTERED.test(removed.out)) {
    say('Unregistered  orbit (MCP)')
    return
  }
  say('Could not unregister the MCP server with the `claude` CLI:')
  console.log(removed.out)
  say('Is Claude Code on PATH? Then run this again, or `claude mcp remove -s user orbit` by hand.')
}

function registerMcp(start: string): boolean {
  const added = run('claude', ['mcp', 'add', ...MCP_SCOPE_ARGS, MCP_SERVER_NAME, '--', ...launcherArgv(), 'mcp'])
  if (added.ok) {
    say(`Registered  orbit → ${start} mcp`)
    return true
  }
  say('Could not register the MCP server with the `claude` CLI:')
  console.log(added.out)
  say('Is Claude Code installed and on PATH? Then run this again.')
  return false
}

function sayClosing(uninstall: boolean, start: string): void {
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
}

export function runSetup(args: string[]): number {
  const uninstall = args.includes('--uninstall')
  const options: SetupOptions = { approval: args.includes("--approval") }
  const start = launcher()

  say()
  say(uninstall ? 'Removing Orbit from Claude Code …' : `Setting up Orbit (${start}) …`)
  if (!uninstall && options.approval) say('With the approval hook: dangerous commands wait for a tap on the phone.')
  say()

  if (!updateHooks(uninstall, start, options)) return 1

  const removed = run('claude', ['mcp', 'remove', ...MCP_SCOPE_ARGS, MCP_SERVER_NAME])
  if (uninstall) {
    unregisterMcp(removed)
  } else if (!registerMcp(start)) {
    return 1
  }

  sayClosing(uninstall, start)
  return 0
}
