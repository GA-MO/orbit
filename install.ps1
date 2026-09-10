#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = if ($env:ORBIT_REPO) { $env:ORBIT_REPO } else { 'GA-MO/orbit' }
$installDir = if ($env:ORBIT_INSTALL_DIR) { $env:ORBIT_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.orbit\bin' }
$wantedVersion = $env:ORBIT_VERSION
$localDir = $env:ORBIT_LOCAL_DIR
$asset = 'orbit-windows-x64.exe'

function Say($text) { Write-Host "  $text" }
function Fail($text) { Write-Error "  $text"; exit 1 }

if ([Environment]::Is64BitOperatingSystem -eq $false) {
  Fail 'Orbit needs a 64-bit Windows.'
}

function Get-GitHubJson($path) {
  $headers = @{ 'User-Agent' = 'orbit-install' }
  if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
  Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo/$path"
}

function Get-LatestTag {
  if ($localDir) { return (Get-Content (Join-Path $localDir 'VERSION') -Raw).Trim() }
  (Get-GitHubJson 'releases/latest').tag_name
}

function Get-Asset($name, $destination) {
  if ($localDir) {
    Copy-Item (Join-Path $localDir $name) $destination -Force
    return
  }
  $headers = @{ 'User-Agent' = 'orbit-install' }
  if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
  Invoke-WebRequest -Headers $headers -Uri "https://github.com/$repo/releases/download/$tag/$name" -OutFile $destination
}

Write-Host ''
$tag = if ($wantedVersion) { $wantedVersion } else { Get-LatestTag }
if (-not $tag) { Fail "could not find a release of $repo - is it private? Set GITHUB_TOKEN." }
Say "Installing orbit $tag for x64 -> $installDir"

$work = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $binary = Join-Path $work $asset
  $checksumFile = Join-Path $work "${asset}.sha256"

  try { Get-Asset $asset $binary } catch { Fail "could not download $asset from $repo $tag" }
  try { Get-Asset "${asset}.sha256" $checksumFile } catch {
    Fail "release $tag carries no checksum for $asset - not installing it"
  }

  $published = ((Get-Content $checksumFile -Raw).Trim() -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 -Path $binary).Hash
  if ($published.ToLower() -ne $actual.ToLower()) {
    Fail 'checksum of the download does not match the one the release published - not installing it'
  }

  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  $installed = Join-Path $installDir 'orbit.exe'
  $replaced = "$installed.orbit-replaced"
  Remove-Item $replaced -Force -ErrorAction SilentlyContinue
  if (Test-Path $installed) { Move-Item $installed $replaced -Force }
  try {
    Copy-Item $binary $installed -Force
  } catch {
    if (Test-Path $replaced) { Move-Item $replaced $installed -Force }
    throw
  }
  Remove-Item $replaced -Force -ErrorAction SilentlyContinue
  Unblock-File -Path $installed -ErrorAction SilentlyContinue

  $installedVersion = (& $installed version 2>$null | Out-String).Trim()
  if (-not $installedVersion) { Fail "$installed did not start" }
  Say "Installed orbit $installedVersion"
}
finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

$onPath = ($env:Path -split ';') -contains $installDir
if (-not $onPath) {
  if ($env:ORBIT_NO_MODIFY_PATH) {
    Say "Add it to your PATH:  `$env:Path += ';$installDir'"
  }
  else {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $installDir) {
      $joined = if ($userPath) { "$userPath;$installDir" } else { $installDir }
      [Environment]::SetEnvironmentVariable('Path', $joined, 'User')
      Say "Added $installDir to your PATH - open a new terminal to pick it up"
    }
  }
}

Write-Host ''
Say 'Next:'
Say '  orbit doctor    what this machine has and is missing'
Say '  orbit setup     wire the hooks and MCP server into Claude Code'
Say '  orbit start     run it, published over your tailnet as https'
Write-Host ''
