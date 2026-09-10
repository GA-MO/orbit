import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const CDP_PIPE_READ_FD = 4
const CDP_PIPE_WRITE_FD = 3
const MESSAGE_DELIMITER = '\0'
const ANSWER_TIMEOUT_MS = 15_000
const PORT_FILE_POLL_MS = 100

const BASE_ARGS = [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-extensions',
  '--use-mock-keychain',
  '--password-store=basic',
  'about:blank',
]

const CHROME_CANDIDATES = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter((dir): dir is string => !!dir)
  .map((dir) => path.join(dir, 'Google/Chrome/Application/chrome.exe'))

const findChrome = (): string => {
  const found = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate))
  if (!found) throw new Error(`no chrome.exe in ${CHROME_CANDIDATES.join(', ')}`)
  return found
}

const withinTimeout = <T>(what: string, work: Promise<T>): Promise<T> =>
  Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ANSWER_TIMEOUT_MS)),
  ])

const kill = async (chrome: ChildProcess, userDataDir: string) => {
  chrome.kill()
  await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
}

async function tryArgs(name: string, args: string[]): Promise<string> {
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), `orbit-spike-${name}-`))
  const chrome = spawn(findChrome(), [...args, `--user-data-dir=${userDataDir}`], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  })
  try {
    const toChrome = chrome.stdio[CDP_PIPE_WRITE_FD] as NodeJS.WritableStream | null
    const fromChrome = chrome.stdio[CDP_PIPE_READ_FD] as NodeJS.ReadableStream | null
    if (!toChrome || !fromChrome) throw new Error('Chrome was given no pipe on fd 3/4')

    let said = ''
    chrome.stderr?.on('data', (chunk: Buffer) => (said = (said + String(chunk)).slice(-400)))

    const answered = new Promise<string>((resolve, reject) => {
      let buffer = ''
      fromChrome.on('data', (chunk: Buffer) => {
        buffer += String(chunk)
        const end = buffer.indexOf(MESSAGE_DELIMITER)
        if (end !== -1) resolve(buffer.slice(0, end))
      })
      fromChrome.on('error', reject)
      chrome.once('exit', (code) => reject(new Error(`Chrome exited with ${code}: ${said.trim()}`)))
    })

    toChrome.write(`${JSON.stringify({ id: 1, method: 'Browser.getVersion' })}${MESSAGE_DELIMITER}`)
    return await withinTimeout(name, answered)
  } finally {
    await kill(chrome, userDataDir)
  }
}

const PIPE_FIRST = ['--remote-debugging-pipe', '--headless=new', ...BASE_ARGS]
const HEADLESS_FIRST = ['--headless=new', '--remote-debugging-pipe', ...BASE_ARGS]
const AS_ORBIT_LAUNCHES_IT = [
  '--headless=new',
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-extensions',
  '--use-mock-keychain',
  '--password-store=basic',
  '--hide-scrollbars',
  '--mute-audio',
  'about:blank',
]
const WITHOUT_ABOUT_BLANK = AS_ORBIT_LAUNCHES_IT.filter((arg) => arg !== 'about:blank')
const OLD_HEADLESS = AS_ORBIT_LAUNCHES_IT.map((arg) => (arg === '--headless=new' ? '--headless' : arg))

async function tryOrbitsOwnChrome(): Promise<string> {
  const { launch } = await import('../server/src/chrome.js')
  const browser = await launch()
  try {
    const page = await browser.newPage({ width: 400, height: 300, deviceScaleFactor: 1 })
    const shot = await page.screenshot({ fullPage: false })
    await page.close()
    return `chrome.ts captured ${shot.length} bytes`
  } finally {
    await browser.close()
  }
}

const report = async (what: string, work: () => Promise<string>) => {
  try {
    console.log(`  ok    ${what} — ${(await work()).replace(/\s+/g, ' ').slice(0, 200)}`)
    return true
  } catch (err) {
    console.log(`  FAIL  ${what} — ${(err as Error).message}`)
    return false
  }
}

const executable = findChrome()
console.log(`\n  Chrome: ${executable}\n`)

const results: Record<string, boolean> = {}
results.pipeFirst = await report('pipe before --headless=new', () => tryArgs('pipe-first', PIPE_FIRST))
results.headlessFirst = await report('--headless=new before pipe', () => tryArgs('headless-first', HEADLESS_FIRST))
results.asOrbit = await report('exactly the args chrome.ts uses', () => tryArgs('as-orbit', AS_ORBIT_LAUNCHES_IT))
results.noAboutBlank = await report('those args without about:blank', () => tryArgs('no-blank', WITHOUT_ABOUT_BLANK))
results.oldHeadless = await report('those args with plain --headless', () => tryArgs('old-headless', OLD_HEADLESS))
results.viaChromeTs = await report('chrome.ts launch() and a real capture', tryOrbitsOwnChrome)

console.log()
if (results.viaChromeTs) console.log('  chrome.ts works on Windows as it stands.')
else if (results.asOrbit) console.log('  the args are fine — chrome.ts fails somewhere after launch.')
else console.log('  chrome.ts launch args are what Windows rejects; the passing rows above say which part.')
console.log()

process.exit(Object.values(results).some(Boolean) ? 0 : 1)
