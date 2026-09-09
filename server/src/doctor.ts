/**
 * `orbit doctor` — what this Mac has and what it is missing, in one screen.
 *
 * Orbit leans on four things it does not ship: Claude Code, Chrome, Tailscale
 * and a macOS permission. Each missing one costs a feature, not the whole
 * program, so nothing here refuses to continue — it says what is there, and
 * for what is not, the one thing to do about it.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { orbitDir } from './home.js'
import { launcher } from './launcher.js'
import * as preview from './preview.js'
import { hookPlan, settingsPath } from './setup.js'

const PORT = Number(process.env.ORBIT_PORT ?? 3001)

const onLoginPath = (command: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile('/bin/zsh', ['-l', '-i', '-c', `command -v ${command}`], { timeout: 8000 }, (err) => resolve(!err))
  })

const claudeMcp = (): Promise<{ ok: boolean; out: string }> =>
  new Promise((resolve) => {
    execFile('/bin/zsh', ['-l', '-i', '-c', 'claude mcp get orbit'], { timeout: 15000 }, (err, stdout) =>
      resolve({ ok: !err, out: String(stdout ?? '') }),
    )
  })

interface Line {
  ok: boolean | null
  what: string
  detail: string
  fix?: string
}

export async function runDoctor(): Promise<number> {
  const lines: Line[] = []
  const start = launcher()

  const claude = await onLoginPath('claude')
  lines.push({
    ok: claude,
    what: 'Claude Code',
    detail: claude ? 'on the login shell PATH' : 'not on the login shell PATH',
    fix: claude ? undefined : 'install it, or the Claude provider and `orbit setup` have nothing to talk to',
  })

  const chrome = ['/Applications/Google Chrome.app', path.join(os.homedir(), 'Applications/Google Chrome.app')].find((p) =>
    fs.existsSync(p),
  )
  lines.push({
    ok: !!chrome,
    what: 'Google Chrome',
    detail: chrome ?? 'not found in /Applications',
    fix: chrome ? undefined : 'captures (orbit_capture, the Preview tab) render in system Chrome — install it',
  })

  const ts = await preview.state(PORT)
  lines.push({
    ok: ts.available || !!ts.host,
    what: 'Tailscale',
    detail: ts.host ? `logged in as ${ts.host}` : (ts.reason ?? 'not available'),
    fix: ts.host ? undefined : 'needed only to reach Orbit away from the Mac — install and log in, then `orbit phone`',
  })

  const config = orbitDir('config.json')
  const hasToken = (() => {
    try {
      return typeof JSON.parse(fs.readFileSync(config, 'utf8')).token === 'string'
    } catch {
      return false
    }
  })()
  lines.push({
    ok: hasToken,
    what: 'Access token',
    detail: hasToken ? config : `${config} not written yet`,
    fix: hasToken ? undefined : 'it is minted on the first start — run `orbit` once and pair the phone with the token it prints',
  })

  let settings: Record<string, any> = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    // no file, or unreadable: reported as no hooks
  }
  const commands: string[] = Object.values(settings.hooks ?? {})
    .flat()
    .flatMap((group: any) => group?.hooks ?? [])
    .map((entry: any) => entry?.command)
    .filter((c: unknown): c is string => typeof c === 'string')
  const wanted = hookPlan(start).map((h) => h.command)
  const hooksOk = wanted.every((c) => commands.includes(c))
  const hooksStale = !hooksOk && commands.some((c) => / hook (approve|notify)$/.test(c) || c.includes('orbit-'))
  lines.push({
    ok: hooksOk,
    what: 'Claude Code hooks',
    detail: hooksOk ? `installed, pointing at ${start}` : hooksStale ? 'installed, but pointing somewhere else' : 'not installed',
    fix: hooksOk ? undefined : `run \`${start} setup\``,
  })

  const mcp = claude ? await claudeMcp() : { ok: false, out: '' }
  const mcpOk = mcp.ok && mcp.out.includes(start.split(' ')[0])
  lines.push({
    ok: claude ? mcpOk : null,
    what: 'MCP server',
    detail: !claude ? 'skipped (no Claude Code)' : mcpOk ? 'registered at user scope' : mcp.ok ? 'registered, but not as this program' : 'not registered',
    fix: !claude || mcpOk ? undefined : `run \`${start} setup\``,
  })

  const up = await fetch(`http://127.0.0.1:${PORT}/healthz`)
    .then((r) => r.ok)
    .catch(() => false)
  lines.push({
    ok: up ? true : null,
    what: `Server on :${PORT}`,
    detail: up ? 'running' : 'not running',
    fix: up ? undefined : `\`${start}\` to start it, or \`${start} phone\` to also publish it over Tailscale`,
  })

  lines.push({
    ok: null,
    what: 'Screen Recording',
    detail: 'cannot be checked from here',
    fix: 'if orbit_screen returns an empty desktop, grant it to the terminal that starts Orbit (System Settings → Privacy)',
  })

  console.log()
  for (const l of lines) {
    const mark = l.ok === true ? '✔' : l.ok === false ? '✘' : '–'
    console.log(`  ${mark} ${l.what.padEnd(18)} ${l.detail}`)
    if (l.fix) console.log(`    ${' '.repeat(18)} → ${l.fix}`)
  }
  console.log()
  return lines.some((l) => l.ok === false) ? 1 : 0
}
