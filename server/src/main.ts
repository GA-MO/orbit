const [command, ...rest] = process.argv.slice(2)

const TAGLINE = 'a phone-side console for the coding agents on this Mac'

const COMMANDS: Array<[invocation: string, blurb: string]> = [
  ['orbit [--lan]', 'run the server (ORBIT_PORT, default 7788; --lan opens it to the Wi-Fi)'],
  ['orbit start [--lan]', 'run it published over the tailnet as https, for the phone'],
  ['orbit stop', 'stop the server on that port, and the tailnet front door'],
  ['orbit setup [--approval] [--uninstall]', 'wire the hooks and MCP server into Claude Code (--approval adds the phone-side gate)'],
  ['orbit pair', 'a fresh QR to pair a phone with the running server'],
  ['orbit doctor', 'what this Mac has and what it is missing'],
  ['orbit update [--check]', 'replace this executable with the latest release'],
  ['orbit mcp', 'the MCP server on stdio (what Claude Code runs)'],
  ['orbit hook approve|notify', 'the Claude Code hooks (what `setup` installs)'],
  ['orbit version', 'which build this is'],
]

const invocationWidth = Math.max(...COMMANDS.map(([invocation]) => invocation.length))

const usage = async (): Promise<string> => {
  const ui = await import('./ui.js')
  const lines = COMMANDS.map(
    ([invocation, blurb]) => `  ${ui.ink(ui.HORIZON, invocation.padEnd(invocationWidth))}   ${ui.dim(blurb)}`,
  )
  const wide = (ui.columns() ?? 0) >= ui.BLOCK_WORDMARK_WIDTH + 4
  const head = wide
    ? ['', ...ui.blockWordmark().map((line) => `  ${line}`), '', `  ${ui.dim(TAGLINE)}`, ui.ruleLine(), '']
    : [...ui.headingLines('help'), `  ${ui.dim(TAGLINE)}`, '']
  return [...head, ...lines, ''].join('\n')
}

const plainUsage = (): string =>
  COMMANDS.map(([invocation, blurb]) => `  ${invocation.padEnd(invocationWidth)}   ${blurb}`).join('\n')

const exit = (code: number) => {
  if (code >= 0) process.exit(code)
}

const UNUSABLE_PORT = 'ORBIT_UNUSABLE_PORT'

const LAN_FLAG = '--lan'

const openTheLan = () => {
  process.env.ORBIT_LAN = '1'
}

const reportConfigProblemsPlainly = (err: unknown): never => {
  if ((err as NodeJS.ErrnoException)?.code === UNUSABLE_PORT) {
    console.error(`orbit: ${(err as Error).message}`)
    process.exit(2)
  }
  throw err
}

try {
  await dispatch()
} catch (err) {
  reportConfigProblemsPlainly(err)
}

async function dispatch(): Promise<void> {
switch (command) {
  case undefined:
  case 'serve':
  case LAN_FLAG:
    if (command === LAN_FLAG || rest.includes(LAN_FLAG)) openTheLan()
    await import('./index.js')
    break
  case 'mcp':
    await import('./mcp.js')
    break
  case 'start': {
    const unexpected = rest.filter((arg) => arg !== LAN_FLAG)
    if (unexpected.length) {
      console.error(
        `orbit start takes no arguments but ${LAN_FLAG} — to take it down, use \`orbit stop\`.`,
      )
      process.exit(2)
    }
    if (rest.includes(LAN_FLAG)) openTheLan()
    exit(await (await import('./start.js')).runStart())
    break
  }
  case 'phone': {
    const start = await import('./start.js')
    if (rest[0] === 'off') {
      console.log(`  ${start.RENAMED_OFF}`)
      exit(await (await import('./stop.js')).takeFrontDoorDown())
      break
    }
    console.log(`  ${start.RENAMED}`)
    exit(await start.runStart())
    break
  }
  case 'stop':
    exit(await (await import('./stop.js')).runStop())
    break
  case 'setup':
    exit((await import('./setup.js')).runSetup(rest))
    break
  case 'pair':
    exit(await (await import('./pair.js')).runPair())
    break
  case 'doctor':
    exit(await (await import('./doctor.js')).runDoctor())
    break
  case 'update':
    exit(await (await import('./update.js')).runUpdate(rest))
    break
  case 'hook': {
    const hooks = await import('./hooks.js')
    if (rest[0] === 'approve') exit(await hooks.runApproveHook())
    else if (rest[0] === 'notify') exit(await hooks.runNotifyHook())
    else {
      console.error(`orbit hook: expected "approve" or "notify", got "${rest[0] ?? ''}"`)
      process.exit(2)
    }
    break
  }
  case 'version':
  case '--version':
  case '-v':
    console.log((await import('./version.js')).packageVersion())
    break
  case 'help':
  case '--help':
  case '-h':
    console.log(await usage())
    break
  default:
    console.error(`orbit: unknown command "${command}"\n\n${plainUsage()}\n`)
    process.exit(2)
}
}
