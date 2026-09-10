import { execFileSync } from 'node:child_process'

const SCRIPT = `
Write-Host "edition       $($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"
Write-Host "modulepath    $($env:PSModulePath)"
foreach ($name in 'Get-FileHash', 'Unblock-File', 'Invoke-WebRequest', 'Invoke-RestMethod', 'Get-FileHash') {
  $found = Get-Command $name -ErrorAction SilentlyContinue
  Write-Host "$name  ->  $(if ($found) { $found.Source } else { 'NOT FOUND' })"
}
`

const said = execFileSync(
  'powershell.exe',
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SCRIPT],
  { encoding: 'utf8', env: process.env as Record<string, string> },
)
console.log(said)
