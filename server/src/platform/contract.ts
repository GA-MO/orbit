export interface Command {
  file: string
  args: string[]
}

export interface ListeningSocket {
  host: string
  port: number
  command: string
  pid: number
}

export interface Platform {
  id: 'darwin' | 'win32'
  runsCommandInLoginShell(command: string): Command
  opensInteractiveShell(): Command
  looksUpCommandOnPath(command: string): Command
  capturesWholeScreen(filePath: string, display?: number): Command
  downscalesImage(source: string, destination: string, maxWidth: number): Command
  screenCaptureHint: string
  screenCapturePermissionRefused: RegExp
  chromeExecutableCandidates: string[]
  chromeSearchedWhere: string
  tailscaleCliCandidates: string[]
  listeningSockets(): Promise<ListeningSocket[]>
  pidsListeningOn(port: number): string[]
  workingDirectoriesOf(pids: number[]): Promise<[pid: number, cwd: string][]>
  serviceThatIsNotADevServer(command: string): string | undefined
  clearsDownloadBlock(file: string): void
  releaseAssetName(): string
  quotedForHookCommand(word: string): string
}
