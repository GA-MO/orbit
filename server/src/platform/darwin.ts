import { execFile, execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { Command, ListeningSocket, Platform } from './contract.js'

const execFileAsync = promisify(execFile)

const LOGIN_SHELL = '/bin/zsh'
const LOGIN_SHELL_ARGS = ['-l', '-i', '-c']
const LSOF_TIMEOUT_MS = 4000
const LISTEN_ADDRESS = /^(.*):(\d+)$/

const APPLICATION_DIRS = ['/Applications', path.join(os.homedir(), 'Applications')]
const BROWSER_NAMES = ['Google Chrome', 'Google Chrome Beta', 'Google Chrome Canary', 'Chromium']

const SERVICE_BY_LSOF_NAME_PREFIX: Record<string, string> = {
  ControlCe: 'AirPlay receiver, on 5000 and 7000',
  rapportd: 'Continuity',
  sharingd: 'AirDrop and Handoff',
  IPNExten: 'Tailscale',
  Tailscal: 'Tailscale',
  remoted: 'remoted',
  launchd: 'launchd',
}

const WHITESPACE = /\s/

const runLsofKeepingPartialOutput = async (args: string[]): Promise<string> => {
  try {
    const { stdout } = await execFileAsync('lsof', args, { timeout: LSOF_TIMEOUT_MS })
    return stdout
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? ''
  }
}

const fieldTag = (line: string): string => line[0]
const fieldValue = (line: string): string => line.slice(1)

const isHomeOrAboveHome = (cwd: string, home: string): boolean =>
  !path.isAbsolute(cwd) || home.startsWith(cwd)

export const darwin: Platform = {
  id: 'darwin',

  runsCommandInLoginShell: (command): Command => ({
    file: LOGIN_SHELL,
    args: [...LOGIN_SHELL_ARGS, `exec ${command}`],
  }),

  opensInteractiveShell: (): Command => ({
    file: process.env.SHELL ?? LOGIN_SHELL,
    args: ['-l'],
  }),

  looksUpCommandOnPath: (command): Command => ({
    file: LOGIN_SHELL,
    args: [...LOGIN_SHELL_ARGS, `command -v ${command}`],
  }),

  runsExecutableOnPath: (command, args): Command => ({ file: command, args }),

  capturesWholeScreen: (filePath, display): Command => {
    const args = ['-x', '-t', 'png']
    if (display && display > 0) args.push('-D', String(display))
    args.push(filePath)
    return { file: '/usr/sbin/screencapture', args }
  },

  downscalesImage: (source, destination, maxWidth): Command => ({
    file: '/usr/bin/sips',
    args: ['-Z', String(maxWidth), source, '--out', destination],
  }),

  screenCaptureHint:
    'grant Screen Recording to the app running the Orbit server in System Settings → Privacy & Security',

  screenCapturePermissionRefused: /not authorized|permission|denied/i,

  chromeExecutableCandidates: APPLICATION_DIRS.flatMap((dir) =>
    BROWSER_NAMES.map((name) => path.join(dir, `${name}.app/Contents/MacOS/${name}`)),
  ),

  chromeSearchedWhere: 'not found in /Applications',

  tailscaleCliCandidates: ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'],

  listeningSockets: async (): Promise<ListeningSocket[]> => {
    const stdout = await runLsofKeepingPartialOutput(['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])
    const found: ListeningSocket[] = []
    let command = ''
    let pid = 0
    for (const line of stdout.split('\n')) {
      if (fieldTag(line) === 'p') pid = Number(fieldValue(line))
      else if (fieldTag(line) === 'c') command = fieldValue(line)
      else if (fieldTag(line) === 'n') {
        const match = fieldValue(line).match(LISTEN_ADDRESS)
        if (match) found.push({ host: match[1], port: Number(match[2]), command, pid })
      }
    }
    return found
  },

  pidsListeningOn: (port): string[] => {
    try {
      return execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: 'pipe' })
        .trim()
        .split('\n')
        .filter(Boolean)
    } catch {
      return []
    }
  },

  stopsProcess: (pid, force) => {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch {}
  },

  workingDirectoriesOf: async (pids): Promise<[number, string][]> => {
    if (pids.length === 0) return []
    const stdout = await runLsofKeepingPartialOutput(['-a', '-d', 'cwd', '-F', 'pn', '-p', pids.join(',')])
    const home = os.homedir()
    const found: [number, string][] = []
    let pid = 0
    for (const line of stdout.split('\n')) {
      if (fieldTag(line) === 'p') pid = Number(fieldValue(line))
      else if (fieldTag(line) === 'n') {
        const cwd = fieldValue(line)
        if (isHomeOrAboveHome(cwd, home)) continue
        found.push([pid, cwd])
      }
    }
    return found
  },

  serviceThatIsNotADevServer: (command) =>
    Object.entries(SERVICE_BY_LSOF_NAME_PREFIX).find(([prefix]) => command.startsWith(prefix))?.[1],

  clearsDownloadBlock: (file) => {
    try {
      execFileSync('xattr', ['-d', 'com.apple.quarantine', file], { stdio: 'ignore' })
    } catch {}
  },

  releaseAssetName: () => `orbit-darwin-${os.arch() === 'arm64' ? 'arm64' : 'x64'}`,

  quotedForHookCommand: (word) => (WHITESPACE.test(word) ? JSON.stringify(word) : word),
}
