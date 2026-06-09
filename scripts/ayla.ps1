[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Error "AYLA_LAUNCH_BLOCKED: $Message"
  exit 1
}

function Ensure-CodeCli() {
  $code = Get-Command code.cmd -ErrorAction SilentlyContinue
  if (-not $code) {
    Fail "VS Code CLI code.cmd not found on PATH. Install VS Code and enable the 'code' shell command."
  }
  return $code.Source
}

function Invoke-Npm([string[]]$NpmArgs, [string]$FailureMessage) {
  & npm.cmd @NpmArgs
  if ($LASTEXITCODE -ne 0) {
    Fail $FailureMessage
  }
}

function Get-LatestVsix([string]$RepoRoot) {
  return Get-ChildItem -Path $RepoRoot -Filter '*.vsix' -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
}

function Get-LatestSourceWriteTimeUtc([string]$RepoRoot) {
  $candidates = @(
    (Join-Path $RepoRoot 'package.json')
    (Join-Path $RepoRoot 'tsconfig.json')
    (Join-Path $RepoRoot 'src')
    (Join-Path $RepoRoot 'scripts')
  )
  $items = @()
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      $item = Get-Item $candidate
      if ($item.PSIsContainer) {
        $items += Get-ChildItem -Path $candidate -Recurse -File -ErrorAction SilentlyContinue
      } else {
        $items += $item
      }
    }
  }
  if ($items.Count -eq 0) {
    return (Get-Date).ToUniversalTime()
  }
  return ($items | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
}

function Invoke-PackageVsix([string]$FailureMessage) {
  & npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license
  if ($LASTEXITCODE -ne 0) {
    Fail $FailureMessage
  }
}

function Get-Json([string]$Url, [string]$FailureMessage) {
  try {
    return Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 8
  } catch {
    Fail "$FailureMessage. $($_.Exception.Message)"
  }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

$null = Ensure-CodeCli

$health = Get-Json 'http://127.0.0.1:8089/health' 'Gateway is down at http://127.0.0.1:8089/health'
if (-not $health -or -not $health.status -or $health.status -ne 'ok') {
  Fail "Gateway health status is not ok."
}

$modelsResponse = Get-Json 'http://127.0.0.1:8089/v1/models' 'Failed to read gateway model list from /v1/models'
$models = @()
if ($modelsResponse -and $modelsResponse.data) {
  $models = @($modelsResponse.data | ForEach-Object { $_.id })
}
if ($models.Count -eq 0) {
  Fail 'Gateway returned no models from /v1/models.'
}

$selectedModel = [string]$health.selectedModel
if ([string]::IsNullOrWhiteSpace($selectedModel) -or $selectedModel -eq 'unset') {
  if ($env:AYLA_ACTIVE_MODEL) {
    $selectedModel = $env:AYLA_ACTIVE_MODEL
  } else {
    $selectedModel = 'ayla-local-coder:latest'
  }
}

if (-not ($models -contains $selectedModel)) {
  $available = ($models -join ', ')
  Fail "Selected model '$selectedModel' is missing. Available: $available"
}

Invoke-Npm @('run', 'compile') 'Compile failed.'

$latestVsix = Get-LatestVsix $repoRoot
$latestSourceWriteUtc = Get-LatestSourceWriteTimeUtc $repoRoot
$needsPackage = $true
if ($latestVsix) {
  $needsPackage = $latestVsix.LastWriteTimeUtc -lt $latestSourceWriteUtc
}
if ($needsPackage) {
  Invoke-PackageVsix 'Packaging failed.'
  $latestVsix = Get-LatestVsix $repoRoot
}
if (-not $latestVsix) {
  Fail 'No VSIX was found after packaging.'
}

$extDir = Join-Path $repoRoot '.tmp-vscode-ext'
$userDir = Join-Path $repoRoot '.tmp-vscode-user'
New-Item -ItemType Directory -Force -Path $extDir, $userDir | Out-Null

& code.cmd --extensions-dir $extDir --user-data-dir $userDir --install-extension $latestVsix.FullName --force
if ($LASTEXITCODE -ne 0) {
  Fail 'VSIX install failed.'
}

& code.cmd --extensions-dir $extDir --user-data-dir $userDir $repoRoot
if ($LASTEXITCODE -ne 0) {
  Fail 'Opening VS Code failed.'
}

Write-Host ''
Write-Host 'Ayla launch complete.' -ForegroundColor Green
Write-Host 'Next manual chat test:' -ForegroundColor Cyan
Write-Host '@ayla-agent Say exactly AYLA_AGENT_READY' -ForegroundColor Yellow
