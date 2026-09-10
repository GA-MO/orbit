import { execFile, execFileSync } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import type { Command, ListeningSocket, Platform } from './contract.js'

const execFileAsync = promisify(execFile)

const POWERSHELL_CANDIDATES = ['pwsh.exe', 'powershell.exe']
const NON_INTERACTIVE_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']
const SESSION_ARGS = ['-NoLogo']
const QUERY_TIMEOUT_MS = 8000

const SERVICE_BY_PROCESS_NAME: Record<string, string> = {
  System: 'Windows kernel, which holds 80 and 443 through http.sys',
  svchost: 'a Windows service',
  wslrelay: 'WSL',
  vmmem: 'WSL or Hyper-V',
  'Tailscale-IPN': 'Tailscale',
  tailscaled: 'Tailscale',
}

const SINGLE_QUOTE = /'/g
const DOUBLE_QUOTE = /"/g
const WHITESPACE = /\s/

const asPowerShellString = (value: string): string => `'${value.replace(SINGLE_QUOTE, "''")}'`

const programFiles = (): string[] =>
  [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(
    (dir): dir is string => !!dir,
  )

let resolvedPowerShell: string | null = null

const powerShell = (): string => {
  if (resolvedPowerShell) return resolvedPowerShell
  for (const candidate of POWERSHELL_CANDIDATES) {
    try {
      execFileSync('where.exe', [candidate], { stdio: 'ignore' })
      resolvedPowerShell = candidate
      return candidate
    } catch {}
  }
  resolvedPowerShell = POWERSHELL_CANDIDATES[POWERSHELL_CANDIDATES.length - 1]
  return resolvedPowerShell
}

const powerShellScript = (script: string): Command => ({
  file: powerShell(),
  args: [...NON_INTERACTIVE_ARGS, script],
})

const CAPTURE_SCRIPT = (filePath: string, display?: number) => `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$wanted = ${display && display > 0 ? String(display - 1) : '-1'}
$screen = if ($wanted -ge 0 -and $wanted -lt $screens.Length) { $screens[$wanted] } else { [System.Windows.Forms.Screen]::PrimaryScreen }
$bounds = $screen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)
$bitmap.Save(${asPowerShellString(filePath)}, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`

const DOWNSCALE_SCRIPT = (source: string, destination: string, maxWidth: number) => `
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile(${asPowerShellString(source)})
$scale = [Math]::Min(1.0, ${maxWidth} / $image.Width)
$width = [int]($image.Width * $scale)
$height = [int]($image.Height * $scale)
$resized = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($resized)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.DrawImage($image, 0, 0, $width, $height)
$resized.Save(${asPowerShellString(destination)}, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$resized.Dispose()
$image.Dispose()
`

const LISTENING_SOCKETS_SCRIPT = `
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  $owner = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
  '{0}|{1}|{2}|{3}' -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess, $owner.ProcessName
}
`

const pidsListeningScript = (port: number) => `
Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
`

const SOCKET_FIELDS = 4

export const win32: Platform = {
  id: 'win32',

  runsCommandInLoginShell: (command): Command => ({
    file: powerShell(),
    args: [...SESSION_ARGS, '-Command', command],
  }),

  opensInteractiveShell: (): Command => ({
    file: process.env.ORBIT_SHELL ?? powerShell(),
    args: [...SESSION_ARGS],
  }),

  looksUpCommandOnPath: (command): Command =>
    powerShellScript(`if (-not (Get-Command ${command} -ErrorAction SilentlyContinue)) { exit 1 }`),

  capturesWholeScreen: (filePath, display): Command => powerShellScript(CAPTURE_SCRIPT(filePath, display)),

  downscalesImage: (source, destination, maxWidth): Command =>
    powerShellScript(DOWNSCALE_SCRIPT(source, destination, maxWidth)),

  screenCaptureHint: 'Windows needs no permission for this — the failure is the capture itself',

  screenCapturePermissionRefused: /access is denied|unauthorized/i,

  chromeExecutableCandidates: programFiles().flatMap((dir) => [
    path.join(dir, 'Google/Chrome/Application/chrome.exe'),
    path.join(dir, 'Google/Chrome Beta/Application/chrome.exe'),
    path.join(dir, 'Chromium/Application/chrome.exe'),
  ]),

  chromeSearchedWhere: 'not found in Program Files or the local app data',

  tailscaleCliCandidates: [
    'tailscale.exe',
    path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Tailscale/tailscale.exe'),
  ],

  listeningSockets: async (): Promise<ListeningSocket[]> => {
    const { file, args } = powerShellScript(LISTENING_SOCKETS_SCRIPT)
    let stdout = ''
    try {
      stdout = (await execFileAsync(file, args, { timeout: QUERY_TIMEOUT_MS })).stdout
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? ''
    }
    return stdout
      .split('\n')
      .map((line) => line.trim().split('|'))
      .filter((fields) => fields.length === SOCKET_FIELDS && Number(fields[1]) > 0)
      .map(([host, port, pid, command]) => ({
        host,
        port: Number(port),
        command,
        pid: Number(pid),
      }))
  },

  pidsListeningOn: (port): string[] => {
    const { file, args } = powerShellScript(pidsListeningScript(port))
    try {
      return execFileSync(file, args, { encoding: 'utf8', stdio: 'pipe', timeout: QUERY_TIMEOUT_MS })
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  },

  workingDirectoriesOf: async () => [],

  serviceThatIsNotADevServer: (command) => SERVICE_BY_PROCESS_NAME[command],

  clearsDownloadBlock: (file) => {
    const { file: shell, args } = powerShellScript(
      `Unblock-File -Path ${asPowerShellString(file)} -ErrorAction SilentlyContinue`,
    )
    try {
      execFileSync(shell, args, { stdio: 'ignore', timeout: QUERY_TIMEOUT_MS })
    } catch {}
  },

  releaseAssetName: () => 'orbit-windows-x64.exe',

  quotedForHookCommand: (word) =>
    WHITESPACE.test(word) ? `"${word.replace(DOUBLE_QUOTE, '""')}"` : word,
}
