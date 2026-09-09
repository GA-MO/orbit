#!/usr/bin/env node
/**
 * Wire this checkout into Claude Code — MCP server and hooks — in one command.
 *
 * Everything here was previously a block of JSON in docs/MCP.md that a new
 * person copied by hand, with `/Users/<you>/` left for them to substitute. All
 * three ways of getting that wrong fail *silently*:
 *
 *   - a path that points nowhere        → the phone simply never buzzes
 *   - a forgotten `"timeout": 190`      → the approval hook is cut off at 60s
 *                                         and a dangerous command slips past
 *                                         while nobody has tapped anything yet
 *   - registering before `npm run build`→ an MCP server that is not on disk
 *
 * So the paths are resolved from this file rather than typed, the timeout comes
 * with the hook it belongs to, and the build runs first.
 *
 *   node scripts/setup.mjs              # build, register, wire up hooks
 *   node scripts/setup.mjs --skip-build # when the build is already current
 *   node scripts/setup.mjs --uninstall  # take all of it back out
 *
 * Idempotent by construction: every hook this repo owns is removed from the
 * settings file before the current set is written back, so running it twice
 * changes nothing, and running it after moving the checkout repairs the paths
 * rather than leaving a second, broken copy behind. Hooks belonging to anything
 * else are carried across untouched.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const NOTIFY = 'orbit-notify-hook.mjs'
const APPROVE = 'orbit-approve.mjs'

/** What marks a hook entry as ours, wherever in the file it has ended up. */
export const OUR_SCRIPTS = [NOTIFY, APPROVE]

/**
 * The hooks this repo installs, as data — so the test can assert on the plan
 * instead of on a rendered settings file.
 *
 * `Stop` and `Notification` take no matcher: they are not tool calls, and a
 * matcher on them matches nothing.
 */
export const hookPlan = (repo = REPO) =>
  [
    { event: 'PreToolUse', matcher: 'AskUserQuestion', script: NOTIFY },
    /* 190 rather than the default 60: the hook waits up to 180 seconds for a
       tap. Cut short, it fails open on a command it was meant to hold. */
    { event: 'PreToolUse', matcher: 'Bash', script: APPROVE, timeout: 190 },
    { event: 'Notification', script: NOTIFY },
    { event: 'Stop', script: NOTIFY },
  ].map((entry) => ({ ...entry, command: `node ${path.join(repo, 'scripts', entry.script)}` }))

const isOurs = (command) =>
  typeof command === 'string' && OUR_SCRIPTS.some((script) => command.includes(script))

/** The settings file with every Orbit hook taken out, and nothing else changed. */
export const withoutOrbit = (settings) => {
  const next = structuredClone(settings ?? {})
  const hooks = next.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return next

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    const kept = []
    for (const group of groups) {
      const entries = Array.isArray(group?.hooks) ? group.hooks : []
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

/** The settings file with exactly this checkout's hooks in it. */
export const withOrbit = (settings, repo = REPO) => {
  const next = withoutOrbit(settings)
  const hooks = (next.hooks ??= {})
  for (const { event, matcher, command, timeout } of hookPlan(repo)) {
    const entry = { type: 'command', command }
    if (timeout) entry.timeout = timeout
    const group = matcher ? { matcher, hooks: [entry] } : { hooks: [entry] }
    ;(hooks[event] ??= []).push(group)
  }
  return next
}

// ── doing it ────────────────────────────────────────────────────────────────

const say = (line = '') => console.log(line ? `  ${line}` : '')

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    /* A settings file we cannot parse is one we must not overwrite — the user's
       own hooks are in there, and a rewrite would be their only copy gone. */
    throw new Error(`${file} is not valid JSON — fix it first (${err.message})`)
  }
}

const run = (command, args) => {
  try {
    return { ok: true, out: execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' }).trim() }
  } catch (err) {
    return { ok: false, out: `${err.stderr ?? ''}${err.stdout ?? ''}`.trim() || err.message }
  }
}

const main = () => {
  const args = process.argv.slice(2)
  const uninstall = args.includes('--uninstall')
  const skipBuild = uninstall || args.includes('--skip-build') || process.env.SKIP_BUILD === '1'

  say()
  say(uninstall ? 'Removing Orbit from Claude Code …' : `Setting up Orbit from ${REPO} …`)
  say()

  if (!skipBuild) {
    say('Building (server + web) …')
    const built = run('npm', ['run', 'build', '--prefix', REPO])
    if (!built.ok) {
      say('Build failed — nothing was registered:')
      console.log(built.out)
      process.exit(1)
    }
  }

  // ── hooks ─────────────────────────────────────────────
  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json')
  const before = readJson(settingsFile)
  const after = uninstall ? withoutOrbit(before) : withOrbit(before)

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
  const entry = path.join(REPO, 'server', 'dist', 'mcp.js')
  if (!uninstall && !fs.existsSync(entry)) {
    say()
    say(`No ${entry} — run without --skip-build.`)
    process.exit(1)
  }

  /* Removed first either way: `add` on a name that exists is an error, and this
     is also what repairs the path after the checkout has moved. */
  run('claude', ['mcp', 'remove', '-s', 'user', 'orbit'])
  if (uninstall) {
    say('Unregistered  orbit (MCP)')
  } else {
    const added = run('claude', ['mcp', 'add', '-s', 'user', 'orbit', '--', 'node', entry])
    if (added.ok) {
      say(`Registered  orbit → node ${entry}`)
    } else {
      say('Could not register the MCP server with the `claude` CLI:')
      console.log(added.out)
      say('Is Claude Code installed and on PATH? Then run this again.')
      process.exit(1)
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
    say('Next:  make phone     (serve :3001 over Tailscale, open it on the phone)')
    say('Undo:  node scripts/setup.mjs --uninstall')
  }
  say()
}

/* Importable for the test without running any of it. */
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main()
