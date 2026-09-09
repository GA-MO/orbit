/**
 * The installer (`install.sh`), against a HOME of its own and a "release"
 * that is a directory — so it runs with no network, no GitHub and no real
 * binary. What is asserted is what the installer is for: the right file
 * lands in the right place, a bad checksum installs nothing, and the PATH is
 * touched exactly when it should be.
 *
 *   bun scripts/install-smoke.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARCH = os.arch() === 'arm64' ? 'arm64' : 'x64'
const ASSET = `orbit-darwin-${ARCH}`

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)

/** A release directory: a stand-in binary that answers `version`, and its checksum. */
const release = (version, { corrupt = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-release-'))
  const bin = path.join(dir, ASSET)
  fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = version ] && echo ${version}\n`, { mode: 0o755 })
  const sum = execFileSync('shasum', ['-a', '256', ASSET], { cwd: dir, encoding: 'utf8' })
  fs.writeFileSync(path.join(dir, `${ASSET}.sha256`), sum)
  if (corrupt) fs.appendFileSync(bin, '# tampered after the checksum was taken\n')
  fs.writeFileSync(path.join(dir, 'VERSION'), `v${version}\n`)
  return dir
}

const run = (home, env = {}) => {
  try {
    return {
      ok: true,
      out: execFileSync('bash', [path.join(REPO, 'install.sh')], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...env },
      }),
    }
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

section('a clean install')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-install-home-'))
const first = run(home, { ORBIT_LOCAL_DIR: release('9.9.9') })
check('it runs', first.ok, first.ok ? '' : first.out.trim().split('\n').slice(-2).join(' / '))
const installed = path.join(home, '.orbit', 'bin', 'orbit')
check('the binary lands in ~/.orbit/bin', fs.existsSync(installed))
check('…executable', (fs.statSync(installed).mode & 0o111) !== 0)
check('…and is the version the release said', execFileSync(installed, ['version'], { encoding: 'utf8' }).trim() === '9.9.9')
check('it says which version it installed', first.out.includes('Installed orbit 9.9.9'))
const rc = fs.readFileSync(path.join(home, '.zshrc'), 'utf8')
check('~/.zshrc gained the PATH line once', rc.split(`${home}/.orbit/bin`).length === 2, rc.trim())

section('installing again')
const again = run(home, { ORBIT_LOCAL_DIR: release('9.9.10') })
check('a newer release replaces the binary', again.ok && execFileSync(installed, ['version'], { encoding: 'utf8' }).trim() === '9.9.10')
check('…without a second PATH line', fs.readFileSync(path.join(home, '.zshrc'), 'utf8').split(`${home}/.orbit/bin`).length === 2)

section('what must not install')
const bad = run(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-install-home-')), { ORBIT_LOCAL_DIR: release('6.6.6', { corrupt: true }) })
check('a binary whose checksum does not match is refused', !bad.ok && bad.out.includes('checksum'), bad.out.trim().split('\n').pop())
const noSum = release('7.7.7')
fs.unlinkSync(path.join(noSum, `${ASSET}.sha256`))
const unsigned = run(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-install-home-')), { ORBIT_LOCAL_DIR: noSum })
check('a release with no checksum is refused', !unsigned.ok && unsigned.out.includes('no checksum'))

section('the knobs')
const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-install-home-'))
const custom = path.join(home2, 'bin')
const knobs = run(home2, { ORBIT_LOCAL_DIR: release('1.2.3'), ORBIT_INSTALL_DIR: custom, ORBIT_NO_MODIFY_PATH: '1' })
check('ORBIT_INSTALL_DIR puts it elsewhere', knobs.ok && fs.existsSync(path.join(custom, 'orbit')))
check('ORBIT_NO_MODIFY_PATH leaves ~/.zshrc alone', !fs.existsSync(path.join(home2, '.zshrc')))
check('…and says what to add instead', knobs.out.includes('Add it to your PATH'))
const onPath = run(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-install-home-')), { ORBIT_LOCAL_DIR: release('1.2.3'), ORBIT_INSTALL_DIR: custom, PATH: `${custom}:/usr/bin:/bin` })
check('a directory already on the PATH gets no advice', onPath.ok && !onPath.out.includes('PATH'))

console.log('')
console.log(failures === 0 ? '  install: all good.' : `  install: ${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
