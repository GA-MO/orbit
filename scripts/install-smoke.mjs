import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
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

const aHomeOfItsOwn = () => {
  const home = makeHome()
  return { HOME: home, ORBIT_HOME: home }
}

const runInstaller = (home, env = {}) => {
  try {
    return {
      ok: true,
      out: execFileSync('bash', [INSTALLER], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, HOME: home, ORBIT_HOME: home, PATH: BARE_PATH, ...env },
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

section('orbit update')
const { runUpdate } = await import(path.join(REPO, 'server/dist/update.js'))

const makeInstalledExecutable = (version) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-installed-'))
  const bin = path.join(dir, 'orbit')
  fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = version ] && echo ${version}\n`, { mode: 0o755 })
  return { executable: bin, compiled: true, version }
}

const update = async (args, installed, releaseDir) => {
  const said = []
  const wasLog = console.log
  const wasLocalDir = process.env.ORBIT_LOCAL_DIR
  console.log = (line = '') => said.push(String(line))
  if (releaseDir) process.env.ORBIT_LOCAL_DIR = releaseDir
  try {
    const code = await runUpdate(args, installed)
    return { code, out: said.join('\n') }
  } finally {
    console.log = wasLog
    if (wasLocalDir === undefined) delete process.env.ORBIT_LOCAL_DIR
    else process.env.ORBIT_LOCAL_DIR = wasLocalDir
  }
}

const runFromCheckout = () => {
  try {
    return { ok: true, out: execFileSync('bun', [path.join(REPO, 'server/dist/main.js'), 'update'], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const unchanged = (installed, before) => fs.readFileSync(installed.executable, 'utf8') === before

const checked = makeInstalledExecutable('9.9.9')
const checkedBefore = fs.readFileSync(checked.executable, 'utf8')
const looked = await update(['--check'], checked, makeRelease('9.9.10'))
check('--check reports what is installed and what is available', looked.code === 0 && looked.out.includes('9.9.9') && looked.out.includes('9.9.10'), lastLines(looked.out, 3))
check('--check writes nothing', unchanged(checked, checkedBefore))

const current = makeInstalledExecutable('9.9.9')
const currentBefore = fs.readFileSync(current.executable, 'utf8')
const uptodate = await update([], current, makeRelease('9.9.9'))
check('an up-to-date install says so', uptodate.code === 0 && uptodate.out.includes('already the latest'), lastLines(uptodate.out, 2))
check('…and downloads nothing', unchanged(current, currentBefore))

const tampered = makeInstalledExecutable('9.9.9')
const tamperedBefore = fs.readFileSync(tampered.executable, 'utf8')
const refused = await update([], tampered, makeRelease('9.9.10', { corrupt: true }))
check('an asset whose checksum does not match is refused', refused.code !== 0 && refused.out.includes('checksum'), lastLines(refused.out, 2))
check('…and the old executable survives untouched', unchanged(tampered, tamperedBefore))

const upgrading = makeInstalledExecutable('9.9.9')
const good = await update([], upgrading, makeRelease('9.9.10'))
check('a good release replaces the executable it is running as', good.code === 0 && installedVersion(upgrading.executable) === '9.9.10', lastLines(good.out, 3))
check('…keeping the executable bit', (fs.statSync(upgrading.executable).mode & 0o111) !== 0)
check('…and says an open Claude Code session must be restarted', good.out.includes('restart'))

const fromCheckout = runFromCheckout()
check('running from a checkout is refused', !fromCheckout.ok, lastLines(fromCheckout.out, 2))
check('…with git as the answer', fromCheckout.out.includes('git'), lastLines(fromCheckout.out, 2))

section('orbit stop')
const { runStop } = await import(path.join(REPO, 'server/dist/stop.js'))
const LIVE_PORTS = [7788, 3001]

const listenerSource = `import net from 'node:net'
const server = net.createServer()
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'))
`

const startThrowawayListener = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-stop-'))
  const script = path.join(dir, 'listener.mjs')
  fs.writeFileSync(script, listenerSource)
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] })
  const port = await new Promise((resolve, reject) => {
    let seen = ''
    child.stdout.on('data', (chunk) => {
      seen += chunk
      if (seen.includes('\n')) resolve(Number(seen.trim()))
    })
    child.once('exit', () => reject(new Error(`listener exited before it said its port: ${seen}`)))
  })
  if (LIVE_PORTS.includes(port)) throw new Error(`refusing to test against :${port}`)
  return { child, port }
}

const stop = async (port) => {
  const said = []
  const wasLog = console.log
  console.log = (line = '') => said.push(String(line))
  try {
    const code = await runStop(port)
    return { code, out: said.join('\n') }
  } finally {
    console.log = wasLog
  }
}

const listening = (port) => {
  try {
    return execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return ''
  }
}

const { child: listener, port: throwawayPort } = await startThrowawayListener()
const stopped = await stop(throwawayPort)
check('it stops what is listening on the port', stopped.code === 0, lastLines(stopped.out, 3))
check('…naming the PID it stopped', stopped.out.includes(String(listener.pid)), lastLines(stopped.out, 3))
check('…and the port is free afterwards', listening(throwawayPort) === '', listening(throwawayPort))
check('…taking the tailnet front door down with it', stopped.out.includes('Tailscale HTTPS (443) off.'), lastLines(stopped.out, 2))

const secondStop = await stop(throwawayPort)
check('stopping an already-stopped port says nothing is listening', secondStop.out.includes(`Nothing listening on :${throwawayPort}.`), lastLines(secondStop.out, 3))
check('…and is not an error', secondStop.code === 0, String(secondStop.code))
listener.kill('SIGKILL')

section('orbit start')
const { lanAddress, lanUrl } = await import(path.join(REPO, 'server/dist/banner.js'))
const MAIN = path.join(REPO, 'server/dist/main.js')
const NO_TAILSCALE = path.join(os.tmpdir(), 'orbit-no-such-tailscale')
const HEALTH_POLLS = 80
const HEALTH_POLL_MS = 250

const freeHighPort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

const orbit = (args, env) =>
  spawn(process.execPath, [MAIN, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...aHomeOfItsOwn(), ORBIT_TAILSCALE: NO_TAILSCALE, ...env },
  })

const orbitSays = (args, env = {}) => {
  try {
    return execFileSync(process.execPath, [MAIN, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, ...aHomeOfItsOwn(), ORBIT_TAILSCALE: NO_TAILSCALE, ...env },
    })
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

const answers = async (port) => {
  for (let poll = 0; poll < HEALTH_POLLS; poll++) {
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok).catch(() => false)
    if (ok) return true
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS))
  }
  return false
}

const startPort = await freeHighPort()
check('the port this test picked is not a live Orbit', !LIVE_PORTS.includes(startPort), `:${startPort}`)
check('…and nothing published can reach the real tailscale', !fs.existsSync(NO_TAILSCALE), NO_TAILSCALE)

const started = orbit(['start'], { ORBIT_PORT: String(startPort) })
let startSaid = ''
started.stdout.on('data', (chunk) => (startSaid += chunk))
started.stderr.on('data', (chunk) => (startSaid += chunk))
try {
  const serving = await answers(startPort)
  check('a Mac that cannot publish over Tailscale still gets a server', serving, lastLines(startSaid, 4))
  check('…and says why it could not publish', startSaid.includes('Could not publish over Tailscale'), lastLines(startSaid, 6))
  check('…and that HTTPS is what Tailscale would buy', startSaid.includes('need HTTPS'), lastLines(startSaid, 6))
  check('…and offers --lan as the way to let a phone on the same wi-fi in', startSaid.includes('orbit start --lan'), lastLines(startSaid, 8))
  const wifi = lanUrl(startPort)
  check(
    '…without naming a wi-fi address nothing is listening on',
    !wifi || !startSaid.includes(wifi),
    wifi ?? 'this Mac has no LAN address',
  )
} finally {
  try {
    process.kill(started.pid, 'SIGKILL')
  } catch {}
}
check('…and the port is free again once it is stopped', listening(startPort) === '', listening(startPort))

const FAKE_TAILSCALE = path.join(REPO, 'scripts/fake-tailscale.mjs')
const publishedPort = await freeHighPort()
check('the port the published case picked is not a live Orbit either', !LIVE_PORTS.includes(publishedPort), `:${publishedPort}`)
const publishedHome = makeHome()
const publishing = orbit(['start'], {
  ORBIT_PORT: String(publishedPort),
  ORBIT_TAILSCALE: FAKE_TAILSCALE,
  HOME: publishedHome,
  ORBIT_HOME: publishedHome,
})
let publishedSaid = ''
publishing.stdout.on('data', (chunk) => (publishedSaid += chunk))
publishing.stderr.on('data', (chunk) => (publishedSaid += chunk))
try {
  check('when the front door goes up, the server runs behind it', await answers(publishedPort), lastLines(publishedSaid, 4))
  check('…and the https address is what it offers the phone', publishedSaid.includes('Open on phone'), lastLines(publishedSaid, 8))
  const frontDoor = JSON.parse(fs.readFileSync(path.join(publishedHome, 'fake-tailscale.json'), 'utf8'))
  check('…pointed at this server', frontDoor.some((m) => m.publicPort === 443 && m.port === publishedPort), JSON.stringify(frontDoor))
} finally {
  try {
    process.kill(publishing.pid, 'SIGKILL')
  } catch {}
}

section('orbit phone, the old name')

const occupied = await freeHighPort()
check('the port the alias test picked is not a live Orbit', !LIVE_PORTS.includes(occupied), `:${occupied}`)
const squatter = net.createServer()
await new Promise((resolve) => squatter.listen(occupied, '127.0.0.1', resolve))
const alias = orbitSays(['phone'], { ORBIT_PORT: String(occupied) })
await new Promise((resolve) => squatter.close(resolve))
check('the old name still answers', alias.includes('orbit phone is now orbit start'), lastLines(alias, 3))
check('…and starts nothing second when the port is taken', alias.includes(`Port ${occupied} already in use`), lastLines(alias, 3))

const aliasOff = orbitSays(['phone', 'off'])
check('`phone off` still drops the front door alone', /tailscale/i.test(aliasOff), lastLines(aliasOff, 2))
check(
  '…and says which command takes both down',
  aliasOff.includes('orbit stop takes both down'),
  lastLines(aliasOff, 2),
)
const startOff = orbitSays(['start', 'off'])
check('`start off` is refused rather than quietly starting', startOff.includes('takes no arguments'), lastLines(startOff, 2))
check('…and it names the command that does take it down', startOff.includes('orbit stop'), lastLines(startOff, 2))
const help = orbitSays(['help'])
check('the usage text offers `orbit start`', help.includes('orbit start'), lastLines(help, 12))
check('…and no longer mentions `orbit phone`', !help.includes('orbit phone'), lastLines(help, 12))
check('…and the usage text names --lan', help.includes('--lan'), lastLines(help, 12))

section('which doors are open, and who gets through them')

const fakeStatus = JSON.parse(execFileSync(process.execPath, [FAKE_TAILSCALE, 'status', '--json'], { encoding: 'utf8' }))
const OWNER_LOGIN = fakeStatus.User[fakeStatus.Self.UserID].LoginName
const STRANGER_LOGIN = 'someone-else@example.com'
const LOGIN_HEADER = 'Tailscale-User-Login'
const REQUEST_TIMEOUT_MS = 4000
const REFUSED = 0

const startServer = async ({ lan = false } = {}) => {
  const port = await freeHighPort()
  if (LIVE_PORTS.includes(port)) throw new Error(`refusing to test against :${port}`)
  const serverHome = makeHome()
  const child = spawn(process.execPath, [MAIN], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: serverHome,
      ORBIT_HOME: serverHome,
      ORBIT_PORT: String(port),
      ORBIT_TAILSCALE: FAKE_TAILSCALE,
      ...(lan ? { ORBIT_LAN: '1' } : {}),
    },
  })
  let said = ''
  child.stdout.on('data', (chunk) => (said += chunk))
  child.stderr.on('data', (chunk) => (said += chunk))
  const up = await answers(port)
  const config = path.join(serverHome, '.orbit', 'config.json')
  const token = up ? JSON.parse(fs.readFileSync(config, 'utf8')).token : null
  return { child, port, token, up, said: () => said }
}

const request = async (origin, pathname, { headers = {}, body } = {}) => {
  try {
    const res = await fetch(`${origin}${pathname}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return { status: res.status, cookie: res.headers.get('set-cookie') }
  } catch {
    return { status: REFUSED, cookie: null }
  }
}

const wifiAddress = lanAddress()

const closed = await startServer()
try {
  const local = `http://127.0.0.1:${closed.port}`
  check('by default the port answers on 127.0.0.1', closed.up, lastLines(closed.said(), 4))
  if (wifiAddress) {
    const overWifi = await request(`http://${wifiAddress}:${closed.port}`, '/healthz')
    check('…and does not answer on the Mac\'s wi-fi address', overWifi.status === REFUSED, `${wifiAddress}:${closed.port} answered ${overWifi.status}`)
  }

  const bare = await request(local, '/api/auth/check')
  check('a request with neither header nor token is refused', bare.status === 401, String(bare.status))

  const owner = await request(local, '/api/auth/check', { headers: { [LOGIN_HEADER]: OWNER_LOGIN } })
  check("the owner's Tailscale login is served with no token", owner.status === 200, String(owner.status))
  check('…and is handed the session cookie the socket and images need', !!owner.cookie?.includes('orbit_session='), owner.cookie ?? 'no Set-Cookie')

  const stranger = await request(local, '/api/auth/check', { headers: { [LOGIN_HEADER]: STRANGER_LOGIN } })
  check('…while a different Tailscale login is refused', stranger.status === 401, String(stranger.status))

  const wrote = await request(local, '/api/notify', { headers: { [LOGIN_HEADER]: OWNER_LOGIN }, body: { message: 'in over the tailnet' } })
  check('…and that login carries writes, not only reads', wrote.status === 200, String(wrote.status))

  const tokened = await request(local, '/api/auth/check', { headers: { Authorization: `Bearer ${closed.token}` } })
  check('the token is accepted with the LAN closed', tokened.status === 200, String(tokened.status))
} finally {
  try {
    process.kill(closed.child.pid, 'SIGKILL')
  } catch {}
}

const opened = await startServer({ lan: true })
try {
  const local = `http://127.0.0.1:${opened.port}`
  check('under ORBIT_LAN=1 the port answers on 127.0.0.1', opened.up, lastLines(opened.said(), 4))
  if (wifiAddress) {
    const overWifi = await request(`http://${wifiAddress}:${opened.port}`, '/healthz')
    check('…and on the Mac\'s wi-fi address too', overWifi.status === 200, `${wifiAddress}:${opened.port} answered ${overWifi.status}`)
  }

  const forged = await request(local, '/api/auth/check', { headers: { [LOGIN_HEADER]: OWNER_LOGIN } })
  check('under ORBIT_LAN=1 a Tailscale-User-Login header is still refused, since anyone reaching the port can set it', forged.status === 401, String(forged.status))

  const tokened = await request(local, '/api/auth/check', { headers: { Authorization: `Bearer ${opened.token}` } })
  check('…and the token is the one credential that gets in', tokened.status === 200, String(tokened.status))
} finally {
  try {
    process.kill(opened.child.pid, 'SIGKILL')
  } catch {}
}

console.log('')
console.log(failures === 0 ? '  install: all good.' : `  install: ${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
