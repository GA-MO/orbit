/**
 * How this program is started — the one fact `setup` has to write down.
 *
 * Compiled, it is a single executable and the answer is its own path. From a
 * checkout it is `bun server/dist/main.js`, and both halves are spelled out in
 * full: the hooks and the MCP server run wherever Claude Code runs them, which
 * is not a shell with this user's PATH, and `~/.bun/bin` is on nothing else's.
 */
import { fileURLToPath } from 'node:url'

export const COMPILED = import.meta.url.startsWith('file:///$bunfs/')

const quote = (s: string) => (/\s/.test(s) ? JSON.stringify(s) : s)

/** The words that start this program, ready to be followed by a subcommand. */
export const launcherArgv = (): string[] =>
  COMPILED ? [process.execPath] : [process.execPath, fileURLToPath(new URL('./main.js', import.meta.url))]

/** The same, as one shell-ready string. */
export const launcher = (): string => launcherArgv().map(quote).join(' ')
