import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { PORT } from './port.js'
import { orbitDir } from './home.js'
import { packageVersion } from './banner.js'
import { COMPILED, launcher } from './launcher.js'
import { latestVersion } from './update.js'
import * as preview from './preview.js'
import { hookPlan, settingsPath } from './setup.js'

const LOGIN_SHELL = '/bin/zsh'
const LOGIN_SHELL_ARGS = ['-l', '-i', '-c']
const PATH_LOOKUP_TIMEOUT_MS = 8000
const CLAUDE_MCP_TIMEOUT_MS = 15000
const WHAT_COLUMN_WIDTH = 18
const OUR_HOOK_COMMAND = / hook (approve|notify)$/

const CHROME_LOCATIONS = ['/Applications/Google Chrome.app', path.join(os.homedir(), 'Applications/Google Chrome.app')]

const onLoginPath = (command: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(
      LOGIN_SHELL,
      [...LOGIN_SHELL_ARGS, `command -v ${command}`],
      { timeout: PATH_LOOKUP_TIMEOUT_MS },
      (err) => resolve(!err),
    )
  })

interface CommandResult {
  ok: boolean
  out: string
}

const claudeMcp = (): Promise<CommandResult> =>
  new Promise((resolve) => {
    execFile(
      LOGIN_SHELL,
      [...LOGIN_SHELL_ARGS, 'claude mcp get orbit'],
      { timeout: CLAUDE_MCP_TIMEOUT_MS },
      (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '') }),
    )
  })

interface Line {
  ok: boolean | null
  what: string
  detail: string
  fix?: string
}

const checkClaude = (claude: boolean): Line => ({
  ok: claude,
  what: 'Claude Code',
  detail: claude ? 'on the login shell PATH' : 'not on the login shell PATH',
  fix: claude ? undefined : 'install it, or the Claude provider and `orbit setup` have nothing to talk to',
})

const checkChrome = (): Line => {
  const chrome = CHROME_LOCATIONS.find((location) => fs.existsSync(location))
  return {
    ok: !!chrome,
    what: 'Google Chrome',
    detail: chrome ?? 'not found in /Applications',
    fix: chrome ? undefined : 'captures (orbit_capture, the Preview tab) render in system Chrome — install it',
  }
}

const checkTailscale = async (): Promise<Line> => {
  const ts = await preview.state(PORT)
  return {
    ok: ts.available || !!ts.host,
    what: 'Tailscale',
    detail: ts.host ? `logged in as ${ts.host}` : (ts.reason ?? 'not available'),
    fix: ts.host ? undefined : 'needed only to reach Orbit away from the Mac — install and log in, then `orbit start`',
  }
}

const configHasToken = (config: string): boolean => {
  try {
    return typeof JSON.parse(fs.readFileSync(config, 'utf8')).token === 'string'
  } catch {
    return false
  }
}

const checkToken = (): Line => {
  const config = orbitDir('config.json')
  const hasToken = configHasToken(config)
  return {
    ok: hasToken,
    what: 'Access token',
    detail: hasToken ? config : `${config} not written yet`,
    fix: hasToken ? undefined : 'it is minted on the first start — run `orbit` once and pair the phone with the token it prints',
  }
}

const readSettings = (): Record<string, any> => {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

const installedHookCommands = (settings: Record<string, any>): string[] =>
  Object.values(settings.hooks ?? {})
    .flat()
    .flatMap((group: any) => group?.hooks ?? [])
    .map((entry: any) => entry?.command)
    .filter((c: unknown): c is string => typeof c === 'string')

const looksLikeOurHook = (command: string): boolean => OUR_HOOK_COMMAND.test(command) || command.includes('orbit-')

const checkHooks = (start: string): Line => {
  const commands = installedHookCommands(readSettings())
  const wanted = hookPlan(start, { approval: false }).map((h) => h.command)
  const hooksOk = wanted.every((c) => commands.includes(c))
  const hooksStale = !hooksOk && commands.some(looksLikeOurHook)
  const approval = commands.includes(`${start} hook approve`)
  return {
    ok: hooksOk,
    what: 'Claude Code hooks',
    detail: hooksOk
      ? `installed, pointing at ${start}${approval ? '' : ' (without the approval hook)'}`
      : hooksStale
        ? 'installed, but pointing somewhere else'
        : 'not installed',
    fix: hooksOk ? undefined : `run \`${start} setup\``,
  }
}

const checkMcp = async (claude: boolean, start: string): Promise<Line> => {
  const mcp = claude ? await claudeMcp() : { ok: false, out: '' }
  const executable = start.split(' ')[0]
  const mcpOk = mcp.ok && mcp.out.includes(executable)
  return {
    ok: claude ? mcpOk : null,
    what: 'MCP server',
    detail: !claude ? 'skipped (no Claude Code)' : mcpOk ? 'registered at user scope' : mcp.ok ? 'registered, but not as this program' : 'not registered',
    fix: !claude || mcpOk ? undefined : `run \`${start} setup\``,
  }
}

const checkServer = async (start: string): Promise<Line> => {
  const up = await fetch(`http://127.0.0.1:${PORT}/healthz`)
    .then((r) => r.ok)
    .catch(() => false)
  return {
    ok: up ? true : null,
    what: `Server on :${PORT}`,
    detail: up ? 'running' : 'not running',
    fix: up ? undefined : `\`${start}\` to start it, or \`${start} phone\` to also publish it over Tailscale`,
  }
}

const checkVersion = async (): Promise<Line> => {
  const installed = packageVersion()
  if (!COMPILED) return { ok: null, what: 'Version', detail: `${installed}, running from a checkout` }
  const latest = await latestVersion().catch(() => null)
  if (!latest) return { ok: null, what: 'Version', detail: `${installed} — could not ask GitHub whether a newer one is out` }
  if (latest === installed) return { ok: true, what: 'Version', detail: `${installed}, the latest release` }
  return { ok: null, what: 'Version', detail: `${installed}, and ${latest} has been released`, fix: 'run `orbit update`' }
}

const screenRecordingLine: Line = {
  ok: null,
  what: 'Screen Recording',
  detail: 'cannot be checked from here',
  fix: 'if orbit_screen returns an empty desktop, grant it to the terminal that starts Orbit (System Settings → Privacy)',
}

const markFor = (ok: boolean | null): string => (ok === true ? '✔' : ok === false ? '✘' : '–')

const printReport = (lines: Line[]) => {
  console.log()
  for (const line of lines) {
    console.log(`  ${markFor(line.ok)} ${line.what.padEnd(WHAT_COLUMN_WIDTH)} ${line.detail}`)
    if (line.fix) console.log(`    ${' '.repeat(WHAT_COLUMN_WIDTH)} → ${line.fix}`)
  }
  console.log()
}

export async function runDoctor(): Promise<number> {
  const start = launcher()
  const claude = await onLoginPath('claude')

  const lines: Line[] = [
    await checkVersion(),
    checkClaude(claude),
    checkChrome(),
    await checkTailscale(),
    checkToken(),
    checkHooks(start),
    await checkMcp(claude, start),
    await checkServer(start),
    screenRecordingLine,
  ]

  printReport(lines)
  return lines.some((line) => line.ok === false) ? 1 : 0
}
