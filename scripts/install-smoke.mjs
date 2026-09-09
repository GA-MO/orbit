import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLER = path.join(REPO, 'install.sh')
const ARCH = os.arch() === 'arm64' ? 'arm64' : 'x64'
const ASSET = `orbit-darwin-${ARCH}`
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const SECTION_WIDTH = 58

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, SECTION_WIDTH - title.length))}`)

const makeRelease = (version, { corrupt = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-release-'))
  const bin = path.join(dir, ASSET)
  fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = version ] && echo ${version}\n`, { mode: 0o755 })
  const checksum = execFileSync('shasum', ['-a', '256', ASSET], { cwd: dir, encoding: 'utf8' })
  fs.writeFileSync(path.join(dir, `${ASSET}.sha256`), checksum)
  if (corrupt) fs.appendFileSync(bin, '# tampered after the checksum was taken\n')
  fs.writeFileSync(path.join(dir, 'VERSION'), `v${version}\n`)
  return dir
}

const makeHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-install-home-'))

const runInstaller = (home, env = {}) => {
  try {
    return {
      ok: true,
      out: execFileSync('bash', [INSTALLER], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, HOME: home, PATH: BARE_PATH, ...env },
      }),
    }
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const installedVersion = (bin) => execFileSync(bin, ['version'], { encoding: 'utf8' }).trim()
const zshrcOf = (home) => fs.readFileSync(path.join(home, '.zshrc'), 'utf8')
const pathLineCount = (home, rc) => rc.split(`${home}/.orbit/bin`).length - 1
const lastLines = (out, n) => out.trim().split('\n').slice(-n).join(' / ')

section('a clean install')
const home = makeHome()
const first = runInstaller(home, { ORBIT_LOCAL_DIR: makeRelease('9.9.9') })
check('it runs', first.ok, first.ok ? '' : lastLines(first.out, 2))
const installed = path.join(home, '.orbit', 'bin', 'orbit')
check('the binary lands in ~/.orbit/bin', fs.existsSync(installed))
check('…executable', (fs.statSync(installed).mode & 0o111) !== 0)
check('…and is the version the release said', installedVersion(installed) === '9.9.9')
check('it says which version it installed', first.out.includes('Installed orbit 9.9.9'))
const rc = zshrcOf(home)
check('~/.zshrc gained the PATH line once', pathLineCount(home, rc) === 1, rc.trim())

section('installing again')
const again = runInstaller(home, { ORBIT_LOCAL_DIR: makeRelease('9.9.10') })
check('a newer release replaces the binary', again.ok && installedVersion(installed) === '9.9.10')
check('…without a second PATH line', pathLineCount(home, zshrcOf(home)) === 1)

section('what must not install')
const bad = runInstaller(makeHome(), { ORBIT_LOCAL_DIR: makeRelease('6.6.6', { corrupt: true }) })
check('a binary whose checksum does not match is refused', !bad.ok && bad.out.includes('checksum'), lastLines(bad.out, 1))
const noChecksum = makeRelease('7.7.7')
fs.unlinkSync(path.join(noChecksum, `${ASSET}.sha256`))
const unsigned = runInstaller(makeHome(), { ORBIT_LOCAL_DIR: noChecksum })
check('a release with no checksum is refused', !unsigned.ok && unsigned.out.includes('no checksum'))

section('the knobs')
const home2 = makeHome()
const customDir = path.join(home2, 'bin')
const knobs = runInstaller(home2, { ORBIT_LOCAL_DIR: makeRelease('1.2.3'), ORBIT_INSTALL_DIR: customDir, ORBIT_NO_MODIFY_PATH: '1' })
check('ORBIT_INSTALL_DIR puts it elsewhere', knobs.ok && fs.existsSync(path.join(customDir, 'orbit')))
check('ORBIT_NO_MODIFY_PATH leaves ~/.zshrc alone', !fs.existsSync(path.join(home2, '.zshrc')))
check('…and says what to add instead', knobs.out.includes('Add it to your PATH'))
const onPath = runInstaller(makeHome(), { ORBIT_LOCAL_DIR: makeRelease('1.2.3'), ORBIT_INSTALL_DIR: customDir, PATH: `${customDir}:/usr/bin:/bin` })
check('a directory already on the PATH gets no advice', onPath.ok && !onPath.out.includes('PATH'))

console.log('')
console.log(failures === 0 ? '  install: all good.' : `  install: ${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
