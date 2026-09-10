import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REPO = path.resolve(import.meta.dir, '..')
const SCRIPT = path.join(REPO, 'scripts/fake-tailscale.mjs')
const ARGS = ['version']

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cli-probe-'))
const shim = path.join(dir, 'fake-tailscale.cmd')
fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${SCRIPT}" %*\r\n`)

const ways: [string, () => Promise<{ stdout: string }>][] = [
  ['execFile(shim.cmd, args)', () => execFileAsync(shim, ARGS)],
  ['execFile(cmd.exe, [/d /s /c, shim, ...args])', () => execFileAsync('cmd.exe', ['/d', '/s', '/c', shim, ...ARGS])],
  ['execFile(cmd.exe, [/c, shim, ...args])', () => execFileAsync('cmd.exe', ['/c', shim, ...ARGS])],
  ['execFile(shim.cmd, args, {shell:true})', () => execFileAsync(shim, ARGS, { shell: true } as any)],
  ['execFile(bun, [script, ...args])', () => execFileAsync(process.execPath, [SCRIPT, ...ARGS])],
]

for (const [what, run] of ways) {
  try {
    const { stdout } = await run()
    console.log(`  ok    ${what} -> ${stdout.trim()}`)
  } catch (err) {
    const said = String((err as Error).message).split('\n')[0]
    console.log(`  FAIL  ${what} -> ${said.slice(0, 160)}`)
  }
}

fs.rmSync(dir, { recursive: true, force: true })
