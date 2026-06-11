[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Error "AYLA_INSTALL_FAILED: $Message"
  exit 1
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cliScript = Join-Path $repoRoot 'bin\ayla.js'
if (-not (Test-Path $cliScript)) {
  Fail "CLI script missing: $cliScript"
}

$installRoot = Join-Path $env:USERPROFILE '.ayla'
$binDir = Join-Path $installRoot 'bin'
$cmdPath = Join-Path $binDir 'ayla.cmd'

New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$cmdContent = "@echo off`r`nsetlocal`r`nnode `"$cliScript`" %*`r`n"
Set-Content -Path $cmdPath -Value $cmdContent -Encoding Ascii -NoNewline

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) {
  $userPath = ''
}

$pathEntries = $userPath -split ';' | Where-Object { $_ -and $_.Trim().Length -gt 0 }
$exists = $false
foreach ($entry in $pathEntries) {
  if ($entry.TrimEnd('\\') -ieq $binDir.TrimEnd('\\')) {
    $exists = $true
    break
  }
}

if (-not $exists) {
  $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $binDir } else { "$userPath;$binDir" }
  [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
}

if (($env:Path -split ';' | Where-Object { $_.TrimEnd('\\') -ieq $binDir.TrimEnd('\\') }).Count -eq 0) {
  $env:Path = "$binDir;$env:Path"
}

Write-Host 'Ayla command installed.' -ForegroundColor Green
Write-Host "Shim: $cmdPath"
Write-Host "Repo: $repoRoot"
Write-Host ''
Write-Host 'Use these commands:' -ForegroundColor Cyan
Write-Host 'ayla' -ForegroundColor Yellow
Write-Host 'ayla status' -ForegroundColor Yellow
Write-Host 'ayla run "<task>"' -ForegroundColor Yellow
Write-Host 'ayla vscode' -ForegroundColor Yellow
