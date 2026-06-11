[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Error "AYLA_INSTALL_FAILED: $Message"
  exit 1
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$FailureMessage) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) { Fail $FailureMessage }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cliScript = Join-Path $repoRoot 'bin\ayla.js'
$gatewayEntry = Join-Path $repoRoot 'gateway\dist\server.js'
$typescriptEntry = Join-Path $repoRoot 'node_modules\typescript\bin\tsc'

if (-not (Test-Path $cliScript)) { Fail "CLI script missing: $cliScript" }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { Fail 'node.exe is not available on PATH.' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Fail 'npm.cmd is not available on PATH.' }

Set-Location $repoRoot
if (-not (Test-Path $typescriptEntry)) {
  Write-Host 'Installing locked Node dependencies...' -ForegroundColor Cyan
  Invoke-Checked 'npm.cmd' @('ci', '--no-audit', '--no-fund') 'npm ci failed.'
}
Write-Host 'Building the single AYLA CLI engine...' -ForegroundColor Cyan
Invoke-Checked 'npm.cmd' @('run', 'gateway:build') 'Gateway build failed.'
Invoke-Checked 'npm.cmd' @('run', 'compile') 'Extension bridge compile failed.'
if (-not (Test-Path $gatewayEntry)) { Fail "Gateway build output missing: $gatewayEntry" }

$installRoot = Join-Path $env:USERPROFILE '.ayla'
$binDir = Join-Path $installRoot 'bin'
$cmdPath = Join-Path $binDir 'ayla.cmd'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Set-Content -Path $cmdPath -Value "@echo off`r`nsetlocal`r`nnode `"$cliScript`" %*`r`n" -Encoding Ascii -NoNewline

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$exists = @($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') }).Count -gt 0
if (-not $exists) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $binDir).Trim(';')), 'User')
}
if (@($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') }).Count -eq 0) {
  $env:Path = "$binDir;$env:Path"
}

Write-Host 'AYLA CLI command installed.' -ForegroundColor Green
Write-Host "Shim: $cmdPath"
Write-Host "Repo: $repoRoot"
Write-Host 'Commands: ayla doctor | ayla status | ayla run "<task>" | ayla vscode'
