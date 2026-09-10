#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = path.join(REPO, 'server', 'dist', 'main.js')
const { hookPlan, withOrbit, withoutOrbit } = await import(path.join(REPO, 'server', 'dist', 'setup.js'))
const START = `${process.execPath} ${MAIN}`
const APPROVE_TIMEOUT_S = 190
const SECTION_WIDTH = 58
const THEIR_HOOK_COUNT = 2
const STALE_CHECKOUT = '/Volumes/old/orbit'

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, SECTION_WIDTH - title.length))}`)

const hookCommands = (settings) =>
  Object.values(settings.hooks ?? {})
    .flat()
    .flatMap((group) => group.hooks ?? [])
    .map((entry) => entry.command)

const hookGroups = (settings, event, matcher) =>
  (settings.hooks?.[event] ?? []).filter((group) => (group.matcher ?? null) === (matcher ?? null))

const lastLines = (out, n) => out.trim().split('\n').slice(-n).join(' / ')

section('what it writes into an empty settings file')

const fresh = withOrbit({})
check('every hook in the plan lands', hookCommands(fresh).length === hookPlan().length, `${hookCommands(fresh).length}`)
check(
  'every hook starts this checkout by its full path',
  hookCommands(fresh).every((command) => command.startsWith(START + ' hook ')),
  hookCommands(fresh)[0],
)
check('the entry point it names exists on disk', fs.existsSync(MAIN))
const approveHook = hookGroups(fresh, 'PreToolUse', 'Bash')[0]?.hooks?.[0]
check('the approval hook carries its 190s timeout', approveHook?.timeout === APPROVE_TIMEOUT_S, String(approveHook?.timeout))
check('the approval hook is the one that screens Bash', approveHook?.command.endsWith(' hook approve'))
check(
  'Stop and Notification are matched by event alone',
  hookGroups(fresh, 'Stop', null).length === 1 && hookGroups(fresh, 'Notification', null).length === 1,
)

section('living with settings that are already there')

const THEIR_BASH_HOOK = 'node /Users/them/lint-my-commands.mjs'
const theirs = {
  cleanupPeriodDays: 42,
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: THEIR_BASH_HOOK }] },
    ],
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
  },
}
const merged = withOrbit(theirs)
check('unrelated settings survive', merged.cleanupPeriodDays === 42)
check('their own Bash hook is still there', hookCommands(merged).includes(THEIR_BASH_HOOK))
check('an event we never touch is left alone', hookCommands(merged).includes('echo hello'))
check('and ours were added alongside', hookGroups(merged, 'PreToolUse', 'Bash').length === 2)
check('the object handed in was not mutated', JSON.stringify(theirs.hooks.PreToolUse).length < 200)

section('running it twice, and after the checkout moves')

check(
  'a second run changes nothing',
  JSON.stringify(withOrbit(merged)) === JSON.stringify(merged),
)
const moved = withOrbit({}, STALE_CHECKOUT)
const repaired = withOrbit(moved)
check(
  'a stale path is replaced, not joined',
  !JSON.stringify(repaired).includes(STALE_CHECKOUT),
)
const legacy = withOrbit({
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/node /old/orbit/scripts/orbit-approve.mjs', timeout: APPROVE_TIMEOUT_S }] }] },
})
check('the old scripts\' hooks are taken over, not doubled', hookGroups(legacy, 'PreToolUse', 'Bash').length === 1)
check('…leaving one hook per event, not two', hookCommands(repaired).length === hookPlan().length)
const withoutApproval = withOrbit({}, START, { approval: false })
check('--no-approval leaves the Bash hook out', !hookCommands(withoutApproval).some((c) => c.endsWith(' hook approve')))
check('…and keeps the three notify hooks', hookCommands(withoutApproval).length === 3)
check('…and a later run with approval adds it without doubling', hookCommands(withOrbit(withoutApproval, START)).length === hookPlan().length)

section('taking it back out')

const removed = withoutOrbit(merged)
check('no Orbit hook is left', !hookCommands(removed).some((c) => c.includes(' hook ')), hookCommands(removed).join(' '))
check('theirs are all still there', hookCommands(removed).length === THEIR_HOOK_COUNT)
check('an event that held only ours is gone', !removed.hooks.Stop && !removed.hooks.Notification)
check('an empty hooks object is dropped entirely', !('hooks' in withoutOrbit(withOrbit({}))))

section('the real script, against a HOME of its own')

const claudeIsOnPath = () => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-setup-'))
const settingsFile = path.join(home, '.claude', 'settings.json')
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'))

const runSetup = (...args) => {
  try {
    return {
      ok: true,
      out: execFileSync(process.execPath, [MAIN, 'setup', ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
        stdio: 'pipe',
      }),
    }
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const checkMcpRegistration = () => {
  const claudeJson = path.join(home, '.claude.json')
  if (!fs.existsSync(claudeJson)) {
    console.log('  skip  MCP registration — the `claude` CLI wrote no user config here')
    return
  }
  const registered = JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers ?? {}
  check('the MCP server is registered at user scope', !!registered.orbit, Object.keys(registered).join(' '))
  check(
    '…pointing at the built entry point in this checkout',
    registered.orbit?.command === process.execPath && (registered.orbit?.args ?? []).join(' ') === `${MAIN} mcp`,
    `${registered.orbit?.command} ${JSON.stringify(registered.orbit?.args ?? [])}`,
  )
}

const runEndToEnd = () => {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify({ cleanupPeriodDays: 42, hooks: theirs.hooks }, null, 2))

  const first = runSetup()
  check('it runs', first.ok, first.ok ? '' : lastLines(first.out, 3))
  const written = readSettings()
  check('the settings file now carries the plan', hookCommands(written).length === hookPlan().length + THEIR_HOOK_COUNT)
  check('their settings came through', written.cleanupPeriodDays === 42, JSON.stringify(written.cleanupPeriodDays))
  check('a backup of what was there was kept', fs.existsSync(`${settingsFile}.orbit.bak`))
  check('it says where the hooks went', first.out.includes(settingsFile))

  const second = runSetup()
  check('a second run leaves the file byte-identical', fs.readFileSync(settingsFile, 'utf8') === JSON.stringify(written, null, 2) + '\n')
  check('…and says so rather than claiming a write', second.out.includes('already'), second.out.trim().split('\n').find((l) => l.includes('ook')) ?? '')

  checkMcpRegistration()

  const undone = runSetup('--uninstall')
  check('--uninstall runs', undone.ok)
  const finalSettings = readSettings()
  check('…and gives the file back as it was', JSON.stringify(finalSettings.hooks) === JSON.stringify(theirs.hooks))
}

if (!claudeIsOnPath()) {
  console.log('  skip  the `claude` CLI is not on PATH — the end-to-end half needs it')
} else {
  runEndToEnd()
}

fs.rmSync(home, { recursive: true, force: true })

console.log('')
console.log(failures === 0 ? '  setup: all good.' : `  setup: ${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
