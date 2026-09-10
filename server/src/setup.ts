import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { launcher, launcherArgv } from './launcher.js'
import * as ui from './ui.js'

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
const CODEX_NOTIFY_KEY = 'notify'
const FIRST_TABLE_HEADER = /^\s*\[/
const TOP_LEVEL_NOTIFY = /^\s*notify\s*=/
const OUR_NOTIFY_ARGV = '"hook","notify"'
const WHITESPACE_OUTSIDE_NOTHING = /\s+/g
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

export const codexNotifyLine = (start = launcher()): string =>
  `${CODEX_NOTIFY_KEY} = ${JSON.stringify([...launcherArgv(), 'hook', 'notify'])}`

const splitAtFirstTable = (toml: string): [before: string[], after: string[]] => {
  const lines = toml.split('\n')
  const firstTable = lines.findIndex((line) => FIRST_TABLE_HEADER.test(line))
  return firstTable === -1 ? [lines, []] : [lines.slice(0, firstTable), lines.slice(firstTable)]
}

const joinBack = (before: string[], after: string[]): string => {
  const body = [...before, ...after].join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
  return body.trim() ? `${body.trimEnd()}\n` : ''
}

const withLineAfterTheLastKey = (lines: string[], line: string): string[] => {
  let afterLastKey = lines.length
  while (afterLastKey > 0 && !lines[afterLastKey - 1].trim()) afterLastKey--
  return [...lines.slice(0, afterLastKey), line, ...lines.slice(afterLastKey)]
}

const isOurNotify = (line: string): boolean =>
  TOP_LEVEL_NOTIFY.test(line) && line.replace(WHITESPACE_OUTSIDE_NOTHING, '').includes(OUR_NOTIFY_ARGV)

export const withoutOrbitNotify = (toml: string): string => {
  const [before, after] = splitAtFirstTable(toml)
  return joinBack(before.filter((line) => !isOurNotify(line)), after)
}

export const withOrbitNotify = (toml: string, start = launcher()): string => {
  const cleared = withoutOrbitNotify(toml)
  const [before, after] = splitAtFirstTable(cleared)
  const theirs = before.some((line) => TOP_LEVEL_NOTIFY.test(line))
  if (theirs) return cleared
  return joinBack(withLineAfterTheLastKey(before, codexNotifyLine(start)), after)
}

const say = ui.say

export const settingsPath = () => path.join(os.homedir(), '.claude', 'settings.json')

export const codexConfigPath = () => path.join(os.homedir(), '.codex', 'config.toml')

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

interface Outcome {
  state: 'passed' | 'failed' | 'skipped'
  detail: string
  note?: string
}

const backUp = (file: string): string | undefined => {
  if (!fs.existsSync(file)) return undefined
  fs.copyFileSync(file, `${file}.orbit.bak`)
  return `backed up  ${file}.orbit.bak`
}

function writeSettings(settingsFile: string, after: Json, uninstall: boolean): Outcome {
  const note = backUp(settingsFile)
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, `${JSON.stringify(after, null, 2)}\n`)
  return { state: 'passed', detail: `${uninstall ? 'removed from' : 'written to'}  ${settingsFile}`, note }
}

function updateHooks(uninstall: boolean, start: string, options: SetupOptions): Outcome {
  const settingsFile = settingsPath()
  let before: Json
  try {
    before = readJson(settingsFile)
  } catch (err) {
    return { state: 'failed', detail: (err as Error).message }
  }
  const after = uninstall ? withoutOrbit(before) : withOrbit(before, start, options)

  if (sameJson(before, after)) return { state: 'passed', detail: `already as they should be — ${settingsFile}` }
  return writeSettings(settingsFile, after, uninstall)
}

const readTextOrEmpty = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function updateCodexNotify(uninstall: boolean, start: string): Outcome {
  const configFile = codexConfigPath()
  const codexHasRun = fs.existsSync(path.dirname(configFile))
  if (!codexHasRun) {
    return { state: 'skipped', detail: uninstall ? 'never wired' : 'no ~/.codex yet, so run it once and set up again' }
  }

  const before = readTextOrEmpty(configFile)
  const after = uninstall ? withoutOrbitNotify(before) : withOrbitNotify(before, start)

  if (after === before) {
    const theirsWon = !uninstall && !after.includes(codexNotifyLine(start))
    return theirsWon
      ? { state: 'skipped', detail: `left alone — a notify of your own in ${configFile}` }
      : { state: 'passed', detail: `already as it should be — ${configFile}` }
  }

  const note = before ? backUp(configFile) : undefined
  fs.writeFileSync(configFile, after)
  return { state: 'passed', detail: `${uninstall ? 'removed from' : 'written to'}  ${configFile}`, note }
}

function unregisterMcp(removed: RunResult): Outcome {
  if (removed.ok || NOT_REGISTERED.test(removed.out)) return { state: 'passed', detail: 'unregistered' }
  return {
    state: 'failed',
    detail: 'the `claude` CLI would not unregister it',
    note: 'is Claude Code on PATH? Then run this again, or `claude mcp remove -s user orbit` by hand.',
  }
}

function registerMcp(start: string): { outcome: Outcome; complaint: string } {
  const added = run('claude', ['mcp', 'add', ...MCP_SCOPE_ARGS, MCP_SERVER_NAME, '--', ...launcherArgv(), 'mcp'])
  if (added.ok) return { outcome: { state: 'passed', detail: `orbit → ${start} mcp` }, complaint: '' }
  return {
    outcome: {
      state: 'failed',
      detail: 'the `claude` CLI would not register it',
      note: 'is Claude Code installed and on PATH? Then run this again.',
    },
    complaint: added.out,
  }
}

const closingHints = (uninstall: boolean, start: string): string[] =>
  uninstall
    ? []
    : [
        'The MCP server is spawned when a session starts, so an open one still holds the previous build.',
        `Next:  ${start} start      (run it, published over Tailscale for the phone)`,
        `Undo:  ${start} setup --uninstall`,
      ]

const CHANNELS = [
  { key: 'hooks', label: 'hooks' },
  { key: 'codex', label: 'Codex notify' },
  { key: 'mcp', label: 'MCP server' },
]

const settle = (panel: ui.Board, key: string, outcome: Outcome): Outcome => {
  panel[outcome.state === 'passed' ? 'pass' : outcome.state === 'failed' ? 'fail' : 'skip'](
    key,
    outcome.detail,
    outcome.note,
  )
  return outcome
}

export function runSetup(args: string[]): number {
  const uninstall = args.includes('--uninstall')
  const options: SetupOptions = { approval: args.includes('--approval') }
  const start = launcher()

  ui.heading(uninstall ? 'setup --uninstall' : 'setup')
  say(ui.dim(uninstall ? 'Removing Orbit from Claude Code …' : `Wiring Orbit (${start}) into Claude Code …`))
  if (!uninstall && options.approval) say(ui.dim('With the approval hook: dangerous commands wait for a tap on the phone.'))
  say()

  const panel = ui.board(CHANNELS)

  panel.begin('hooks', settingsPath())
  const hooks = settle(panel, 'hooks', updateHooks(uninstall, start, options))
  if (hooks.state === 'failed') {
    panel.skip('codex', 'not reached')
    panel.skip('mcp', 'not reached')
    panel.close()
    ui.closing('Nothing was changed.')
    return 1
  }

  panel.begin('codex', codexConfigPath())
  settle(panel, 'codex', updateCodexNotify(uninstall, start))

  panel.begin('mcp', 'asking the `claude` CLI …')
  const removed = run('claude', ['mcp', 'remove', ...MCP_SCOPE_ARGS, MCP_SERVER_NAME])
  const registration = uninstall ? { outcome: unregisterMcp(removed), complaint: removed.out } : registerMcp(start)
  const mcp = settle(panel, 'mcp', registration.outcome)
  panel.close()

  if (mcp.state === 'failed') {
    say()
    if (registration.complaint) console.log(registration.complaint)
    ui.closing('Claude Code is only half wired.')
    return 1
  }

  ui.closing(
    uninstall
      ? 'Done. Orbit itself is untouched — this only unwired Claude Code.'
      : 'Done. Restart any Claude Code session that is already open.',
    closingHints(uninstall, start),
  )
  return 0
}
