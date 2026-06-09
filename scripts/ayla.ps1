[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Error "AYLA_LAUNCH_BLOCKED: $Message"
  exit 1
}

function Try-GetJson([string]$Url) {
  try {
    $data = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 8
    return @{
      ok = $true
      data = $data
      error = ""
    }
  } catch {
    return @{
      ok = $false
      data = $null
      error = $_.Exception.Message
    }
  }
}

function Test-GatewayHealthy([string]$HealthUrl) {
  $result = Try-GetJson $HealthUrl
  if (-not $result.ok) {
    return @{
      ok = $false
      data = $null
      error = [string]$result.error
    }
  }
  $health = $result.data
  $status = [string]$health.status
  if ($status -eq 'ok') {
    return @{
      ok = $true
      data = $health
      error = ""
    }
  }
  return @{
    ok = $false
    data = $health
    error = "Gateway health status is '$status'"
  }
}

function Test-PortInUse([int]$Port) {
  try {
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    return @($connections).Count -gt 0
  } catch {
    $netstat = netstat -ano -p tcp | Select-String -Pattern (":$Port\s")
    return @($netstat).Count -gt 0
  }
}

function Start-GatewayProcess([string]$RepoRoot, [string]$OutLogPath, [string]$ErrLogPath) {
  if (Test-Path $OutLogPath) {
    Remove-Item -Path $OutLogPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $ErrLogPath) {
    Remove-Item -Path $ErrLogPath -Force -ErrorAction SilentlyContinue
  }

  $process = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'npm.cmd run gateway:dev') `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $OutLogPath `
    -RedirectStandardError $ErrLogPath `
    -WindowStyle Hidden `
    -PassThru

  return $process
}

function Ensure-GatewayReady([string]$RepoRoot, [string]$HealthUrl, [int]$TimeoutSeconds, [int]$PollSeconds) {
  $gatewayCommand = 'npm.cmd run gateway:dev'
  $outLogPath = Join-Path $RepoRoot 'gateway-start.out.txt'
  $errLogPath = Join-Path $RepoRoot 'gateway-start.err.txt'

  $initial = Test-GatewayHealthy $HealthUrl
  if ($initial.ok) {
    return @{
      health = $initial.data
      startedProcess = $false
      attemptedCommand = $gatewayCommand
      outLog = $outLogPath
      errLog = $errLogPath
    }
  }

  $lastError = [string]$initial.error
  $startedProcess = $false
  $gatewayProcess = $null

  if (-not (Test-PortInUse 8089)) {
    $gatewayProcess = Start-GatewayProcess -RepoRoot $RepoRoot -OutLogPath $outLogPath -ErrLogPath $errLogPath
    $startedProcess = $true
    Write-Host "Gateway down; started local gateway bootstrap process (PID $($gatewayProcess.Id))." -ForegroundColor Cyan
  } else {
    Write-Host 'Gateway port 8089 is already listening; waiting for healthy response without starting a duplicate process.' -ForegroundColor Cyan
  }

  $attempts = [Math]::Ceiling($TimeoutSeconds / [Math]::Max(1, $PollSeconds))
  if ($attempts -lt 1) {
    $attempts = 1
  }

  for ($attempt = 1; $attempt -le $attempts; $attempt++) {
    Start-Sleep -Seconds $PollSeconds
    $probe = Test-GatewayHealthy $HealthUrl
    if ($probe.ok) {
      return @{
        health = $probe.data
        startedProcess = $startedProcess
        attemptedCommand = $gatewayCommand
        outLog = $outLogPath
        errLog = $errLogPath
      }
    }
    $lastError = [string]$probe.error
  }

  $failureDetails = @(
    "Gateway is down at $HealthUrl",
    "attempted command: $gatewayCommand",
    "stdout log: $outLogPath",
    "stderr log: $errLogPath",
    "last error: $lastError"
  ) -join '; '
  Fail $failureDetails
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

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

$null = Ensure-CodeCli

$healthUrl = 'http://127.0.0.1:8089/health'
$gatewayReadiness = Ensure-GatewayReady -RepoRoot $repoRoot -HealthUrl $healthUrl -TimeoutSeconds 60 -PollSeconds 2
$health = $gatewayReadiness.health

$modelsResult = Try-GetJson 'http://127.0.0.1:8089/v1/models'
if (-not $modelsResult.ok) {
  Fail "Failed to read gateway model list from /v1/models. $($modelsResult.error)"
}
$modelsResponse = $modelsResult.data
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
if ($gatewayReadiness.startedProcess) {
  Write-Host "Gateway was auto-started with '$($gatewayReadiness.attemptedCommand)'" -ForegroundColor Cyan
  Write-Host "Logs: $($gatewayReadiness.outLog) | $($gatewayReadiness.errLog)" -ForegroundColor Cyan
} else {
  Write-Host 'Gateway already healthy; no duplicate gateway process was started.' -ForegroundColor Cyan
}
Write-Host 'Next manual chat test:' -ForegroundColor Cyan
Write-Host '@ayla-agent Say exactly AYLA_AGENT_READY' -ForegroundColor Yellow
Write-Host 'Manual launcher command:' -ForegroundColor Cyan
Write-Host 'powershell -ExecutionPolicy Bypass -File scripts/ayla.ps1' -ForegroundColor Yellow
