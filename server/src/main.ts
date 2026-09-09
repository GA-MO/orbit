/**
 * The entry point — one program that is the server, the MCP server, the
 * Claude Code hooks and the installer, told apart by the first argument,
 * because a phone-side install should be one executable and not a folder
 * of them. A checkout runs the same thing as `bun server/dist/main.js`.
 */
const [command, ...rest] = process.argv.slice(2)

const usage = `orbit — a phone-side console for the coding agents on this Mac

  orbit                    run the server (ORBIT_PORT, default 3001)
  orbit phone [off]        run it published over the tailnet as https
  orbit setup [--uninstall]  wire the hooks and MCP server into Claude Code
  orbit pair               a fresh QR to pair a phone with the running server
  orbit doctor             what this Mac has and what it is missing
  orbit mcp                the MCP server on stdio (what Claude Code runs)
  orbit hook approve|notify  the Claude Code hooks (what \`setup\` installs)
  orbit version            which build this is
`

const exit = (code: number) => {
  if (code >= 0) process.exit(code)
}

switch (command) {
  case undefined:
  case 'serve':
    await import('./index.js')
    break
  case 'mcp':
    await import('./mcp.js')
    break
  case 'phone':
    exit(await (await import('./phone.js')).runPhone(rest))
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
    console.log((await import('./banner.js')).packageVersion())
    break
  case 'help':
  case '--help':
  case '-h':
    console.log(usage)
    break
  default:
    console.error(`orbit: unknown command "${command}"\n\n${usage}`)
    process.exit(2)
}
