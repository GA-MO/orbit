#!/usr/bin/env node
/**
 * Wiring a fresh checkout into Claude Code (`scripts/setup.mjs`).
 *
 * This is the script a new person on the team runs before anything else works,
 * and the thing it edits — `~/.claude/settings.json` — is a file they may
 * already have hooks of their own in. Two properties matter more than the rest:
 * it must not eat those, and running it twice must not leave two copies of
 * every hook (which is how a phone ends up buzzing twice per question).
 *
 * The pure half is asserted directly. The end-to-end half runs the real script
 * against a HOME of its own — made here rather than inherited, so that running
 * this file by hand can never reach the real ~/.claude.
 *
 *   node scripts/setup-smoke.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO, hookPlan, withOrbit, withoutOrbit } from './setup.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)

/** Every hook command in a settings object, whatever event it sits under. */
const commands = (settings) =>
  Object.values(settings.hooks ?? {})
    .flat()
    .flatMap((group) => group.hooks ?? [])
    .map((entry) => entry.command)

const find = (settings, event, matcher) =>
  (settings.hooks?.[event] ?? []).filter((group) => (group.matcher ?? null) === (matcher ?? null))

section('what it writes into an empty settings file')

const fresh = withOrbit({})
check('every hook in the plan lands', commands(fresh).length === hookPlan().length, `${commands(fresh).length}`)
check(
  'paths are absolute and point into this checkout',
  commands(fresh).every((command) => command.includes(`${REPO}/scripts/`)),
  commands(fresh)[0],
)
check(
  'every script it names exists on disk',
  commands(fresh).every((command) => fs.existsSync(command.replace(/^node /, ''))),
)
/* The one that fails open when it is wrong, and says nothing. */
const bash = find(fresh, 'PreToolUse', 'Bash')[0]?.hooks?.[0]
check('the approval hook carries its 190s timeout', bash?.timeout === 190, String(bash?.timeout))
check('the approval hook is the one that screens Bash', bash?.command.endsWith('orbit-approve.mjs'))
check(
  'Stop and Notification are matched by event alone',
  find(fresh, 'Stop', null).length === 1 && find(fresh, 'Notification', null).length === 1,
)

section('living with settings that are already there')

const theirs = {
  cleanupPeriodDays: 42,
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /Users/them/lint-my-commands.mjs' }] },
    ],
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
  },
}
const merged = withOrbit(theirs)
check('unrelated settings survive', merged.cleanupPeriodDays === 42)
check('their own Bash hook is still there', commands(merged).includes('node /Users/them/lint-my-commands.mjs'))
check('an event we never touch is left alone', commands(merged).includes('echo hello'))
check('and ours were added alongside', find(merged, 'PreToolUse', 'Bash').length === 2)
check('the object handed in was not mutated', JSON.stringify(theirs.hooks.PreToolUse).length < 200)

section('running it twice, and after the checkout moves')

check(
  'a second run changes nothing',
  JSON.stringify(withOrbit(merged)) === JSON.stringify(merged),
)
const moved = withOrbit({}, '/Volumes/old/orbit')
const repaired = withOrbit(moved)
check(
  'a stale path is replaced, not joined',
  !JSON.stringify(repaired).includes('/Volumes/old/orbit'),
)
check('…leaving one hook per event, not two', commands(repaired).length === hookPlan().length)

section('taking it back out')

const removed = withoutOrbit(merged)
check('no Orbit hook is left', !commands(removed).some((c) => c.includes('orbit-')), commands(removed).join(' '))
check('theirs are all still there', commands(removed).length === 2)
check('an event that held only ours is gone', !removed.hooks.Stop && !removed.hooks.Notification)
check('an empty hooks object is dropped entirely', !('hooks' in withoutOrbit(withOrbit({}))))

section('the real script, against a HOME of its own')

/* The script registers the MCP server through the `claude` CLI, and says so by
   exiting 1 when it cannot. Nothing below is a statement about this repo on a
   machine that has no Claude Code on PATH. */
const hasClaude = (() => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-setup-'))
const settingsFile = path.join(home, '.claude', 'settings.json')
const setup = (...args) => {
  try {
    return {
      ok: true,
      out: execFileSync('node', [path.join(REPO, 'scripts', 'setup.mjs'), '--skip-build', ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
        stdio: 'pipe',
      }),
    }
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

if (!hasClaude) {
  console.log('  skip  the `claude` CLI is not on PATH — the end-to-end half needs it')
} else {
  /* Someone's real settings file, to prove the round trip does not eat it. */
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify({ cleanupPeriodDays: 42, hooks: theirs.hooks }, null, 2))

  const first = setup()
  check('it runs', first.ok, first.ok ? '' : first.out.trim().split('\n').slice(-3).join(' / '))
  const written = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  check('the settings file now carries the plan', commands(written).length === hookPlan().length + 2)
  check('their settings came through', written.cleanupPeriodDays === 42, JSON.stringify(written.cleanupPeriodDays))
  check('a backup of what was there was kept', fs.existsSync(`${settingsFile}.orbit.bak`))
  check('it says where the hooks went', first.out.includes(settingsFile))

  const second = setup()
  check('a second run leaves the file byte-identical', fs.readFileSync(settingsFile, 'utf8') === JSON.stringify(written, null, 2) + '\n')
  check('…and says so rather than claiming a write', second.out.includes('already'), second.out.trim().split('\n').find((l) => l.includes('ook')) ?? '')

  /* The MCP registration lands in this HOME too, so the real one is untouched. */
  const claudeJson = path.join(home, '.claude.json')
  if (fs.existsSync(claudeJson)) {
    const registered = JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers ?? {}
    check('the MCP server is registered at user scope', !!registered.orbit, Object.keys(registered).join(' '))
    check(
      '…pointing at the built entry point in this checkout',
      (registered.orbit?.args ?? []).some((arg) => arg === path.join(REPO, 'server', 'dist', 'mcp.js')),
      JSON.stringify(registered.orbit?.args ?? []),
    )
  } else {
    console.log('  skip  MCP registration — the `claude` CLI wrote no user config here')
  }

  const undone = setup('--uninstall')
  check('--uninstall runs', undone.ok)
  const finalSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  check('…and gives the file back as it was', JSON.stringify(finalSettings.hooks) === JSON.stringify(theirs.hooks))
}

fs.rmSync(home, { recursive: true, force: true })

console.log('')
console.log(failures === 0 ? '  setup: all good.' : `  setup: ${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
