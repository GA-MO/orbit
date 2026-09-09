/**
 * The entry point of the compiled binary — one file that is both the server
 * and the MCP server, told apart by the first argument, because a phone-side
 * install should be one executable and not a folder of them:
 *
 *   orbit          the server, on :3001 (ORBIT_PORT to change)
 *   orbit mcp      the MCP server, on stdio — what `claude mcp add` runs
 *
 * A checkout still runs `server/dist/index.js` and `server/dist/mcp.js`
 * directly; this file only exists so `bun build --compile` has one root.
 */
const command = process.argv[2]
if (command === 'mcp') {
  await import('./mcp.js')
} else if (command === undefined || command === 'serve') {
  await import('./index.js')
} else {
  console.error(`orbit: unknown command "${command}" — try \`orbit\` or \`orbit mcp\``)
  process.exit(2)
}
