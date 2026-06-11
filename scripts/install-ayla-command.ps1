[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Error "AYLA_INSTALL_FAILED: $Message"
  exit 1
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$FailureMessage) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail $FailureMessage
  }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cliScript = Join-Path $repoRoot 'bin\ayla.js'
$gatewayEntry = Join-Path $repoRoot 'gateway\dist\server.js'
$typescriptEntry = Join-Path $repoRoot 'node_modules\typescript\bin\tsc'
$agentSource = Join-Path $repoRoot '.github\agents\AYLA.agent.md'

if (-not (Test-Path $cliScript)) {
  Fail "CLI script missing: $cliScript"
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  Fail 'node.exe is not available on PATH.'
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  Fail 'npm.cmd is not available on PATH.'
}

Set-Location $repoRoot

if (-not (Test-Path $typescriptEntry)) {
  Write-Host 'Installing locked Node dependencies...' -ForegroundColor Cyan
  Invoke-Checked 'npm.cmd' @('ci', '--no-audit', '--no-fund') 'npm ci failed.'
}

Write-Host 'Building AYLA Gateway...' -ForegroundColor Cyan
Invoke-Checked 'npm.cmd' @('run', 'gateway:build') 'Gateway build failed.'
if (-not (Test-Path $gatewayEntry)) {
  Fail "Gateway build output missing: $gatewayEntry"
}

$installRoot = Join-Path $env:USERPROFILE '.ayla'
$binDir = Join-Path $installRoot 'bin'
$cmdPath = Join-Path $binDir 'ayla.cmd'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$cmdContent = "@echo off`r`nsetlocal`r`nnode `"$cliScript`" %*`r`n"
Set-Content -Path $cmdPath -Value $cmdContent -Encoding Ascii -NoNewline

$userAgentDir = Join-Path $env:USERPROFILE '.copilot\agents'
if (Test-Path $agentSource) {
  New-Item -ItemType Directory -Force -Path $userAgentDir | Out-Null
  Copy-Item -Path $agentSource -Destination (Join-Path $userAgentDir 'AYLA.agent.md') -Force
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$pathEntries = $userPath -split ';' | Where-Object { $_ -and $_.Trim().Length -gt 0 }
$exists = $false
foreach ($entry in $pathEntries) {
  if ($entry.TrimEnd('\') -ieq $binDir.TrimEnd('\')) { $exists = $true; break }
}
if (-not $exists) {
  $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $binDir } else { "$userPath;$binDir" }
  [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
}
if (($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') }).Count -eq 0) {
  $env:Path = "$binDir;$env:Path"
}

Write-Host 'Ayla command installed.' -ForegroundColor Green
Write-Host "Shim: $cmdPath"
Write-Host "Repo: $repoRoot"
Write-Host "Gateway build: $gatewayEntry"
if (Test-Path $agentSource) { Write-Host "Global agent: $(Join-Path $userAgentDir 'AYLA.agent.md')" }
Write-Host ''
Write-Host 'Run this diagnostic first:' -ForegroundColor Cyan
Write-Host 'ayla doctor' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Use these commands:' -ForegroundColor Cyan
Write-Host 'ayla' -ForegroundColor Yellow
Write-Host 'ayla status' -ForegroundColor Yellow
Write-Host 'ayla run "<task>"' -ForegroundColor Yellow
Write-Host 'ayla vscode' -ForegroundColor Yellow
