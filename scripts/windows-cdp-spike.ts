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

async function tryPipeTransport(executable: string): Promise<string> {
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-spike-pipe-'))
  const chrome = spawn(executable, ['--remote-debugging-pipe', ...BASE_ARGS, `--user-data-dir=${userDataDir}`], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  })
  try {
    const toChrome = chrome.stdio[CDP_PIPE_WRITE_FD] as NodeJS.WritableStream | null
    const fromChrome = chrome.stdio[CDP_PIPE_READ_FD] as NodeJS.ReadableStream | null
    if (!toChrome || !fromChrome) throw new Error('Chrome was given no pipe on fd 3/4')

    const answered = new Promise<string>((resolve, reject) => {
      let buffer = ''
      fromChrome.on('data', (chunk: Buffer) => {
        buffer += String(chunk)
        const end = buffer.indexOf(MESSAGE_DELIMITER)
        if (end !== -1) resolve(buffer.slice(0, end))
      })
      fromChrome.on('error', reject)
      chrome.once('exit', (code) => reject(new Error(`Chrome exited with ${code}`)))
    })

    toChrome.write(`${JSON.stringify({ id: 1, method: 'Browser.getVersion' })}${MESSAGE_DELIMITER}`)
    return await withinTimeout('pipe transport', answered)
  } finally {
    await kill(chrome, userDataDir)
  }
}

async function tryPortTransport(executable: string): Promise<string> {
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-spike-port-'))
  const chrome = spawn(executable, ['--remote-debugging-port=0', ...BASE_ARGS, `--user-data-dir=${userDataDir}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  try {
    const portFile = path.join(userDataDir, 'DevToolsActivePort')
    const readPort = (async () => {
      for (;;) {
        const text = await fsp.readFile(portFile, 'utf8').catch(() => '')
        const port = Number(text.split('\n')[0])
        if (port > 0) return port
        await new Promise((resolve) => setTimeout(resolve, PORT_FILE_POLL_MS))
      }
    })()
    const port = await withinTimeout('DevToolsActivePort', readPort)
    const res = await fetch(`http://127.0.0.1:${port}/json/version`)
    return `port ${port} → ${(await res.text()).slice(0, 200)}`
  } finally {
    await kill(chrome, userDataDir)
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

const pipeWorks = await report('--remote-debugging-pipe over fd 3/4', () => tryPipeTransport(executable))
const portWorks = await report('--remote-debugging-port=0 + DevToolsActivePort', () => tryPortTransport(executable))

console.log()
if (pipeWorks) console.log('  chrome.ts can stay as it is on Windows.')
else if (portWorks) console.log('  chrome.ts needs a second transport: pipe on macOS, WebSocket on Windows.')
else console.log('  neither transport answered — captures cannot work on Windows yet.')
console.log()

process.exit(pipeWorks || portWorks ? 0 : 1)
