/**
 * Where Orbit keeps its own data — `~/.orbit` unless told otherwise.
 *
 * `ORBIT_HOME` moves that directory *without* moving `HOME`, and the difference
 * is the point. A second Orbit used to be isolated by handing the whole process
 * a scratch `HOME`, which also relocates everything a session inherits: the
 * shell's rc files, the PATH they build, and an agent's credentials. That is
 * fine for a test that only speaks HTTP, and fatal for anything that has to
 * start a real agent — `claude` under a HOME it has never seen is not logged in,
 * so the screenshots in docs/ could never be taken by a script.
 *
 * So the two are separated: `HOME` stays the user's, and this is the only thing
 * that moves. `$ORBIT_HOME/.orbit`, not `$ORBIT_HOME` itself, so the scratch
 * directory has the same shape as a home directory and `~/.orbit` keeps its
 * name in both.
 *
 * Read at call time rather than captured at import, so a module loaded before
 * the variable is set still lands in the right place.
 */
import os from 'node:os'
import path from 'node:path'

export const orbitDir = (...parts: string[]): string =>
  path.join(process.env.ORBIT_HOME || os.homedir(), '.orbit', ...parts)
