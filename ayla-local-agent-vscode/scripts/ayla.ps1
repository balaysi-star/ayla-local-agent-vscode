[CmdletBinding()]
param(
  [string]$TargetWorkspace = $env:AYLA_TARGET_WORKSPACE
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Error "AYLA_LAUNCH_BLOCKED: $Message"
  exit 1
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$FailureMessage) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) { Fail $FailureMessage }
}

function Resolve-Model([string]$OllamaBaseUrl) {
  if ($env:AYLA_MODEL) { return $env:AYLA_MODEL }
  if ($env:AYLA_ACTIVE_MODEL) { return $env:AYLA_ACTIVE_MODEL }
  try {
    $tags = Invoke-RestMethod -Uri "$OllamaBaseUrl/api/tags" -Method Get -TimeoutSec 8
    $models = @($tags.models | ForEach-Object { if ($_.name) { $_.name } elseif ($_.model) { $_.model } })
    if ($models -contains 'gemma4:12b') { return 'gemma4:12b' }
    if ($models.Count -gt 0) { return [string]$models[0] }
  } catch {
    Fail "Ollama is not reachable at $OllamaBaseUrl. $($_.Exception.Message)"
  }
  Fail 'Ollama returned no installed models.'
}

function Get-LatestVsix([string]$RepoRoot) {
  Get-ChildItem -Path $RepoRoot -Filter '*.vsix' -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($TargetWorkspace)) {
  $defaultTarget = 'D:\octopus_main\Ayla'
  $TargetWorkspace = if (Test-Path $defaultTarget) { $defaultTarget } else { $repoRoot }
}
if (-not (Test-Path $TargetWorkspace)) { Fail "Target workspace does not exist: $TargetWorkspace" }
$targetWorkspaceRoot = (Resolve-Path $TargetWorkspace).Path
Set-Location $repoRoot

if (-not (Get-Command code.cmd -ErrorAction SilentlyContinue)) {
  Fail "VS Code CLI code.cmd was not found on PATH."
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  Fail "npm.cmd was not found on PATH."
}

if (-not (Test-Path (Join-Path $repoRoot 'node_modules\typescript\bin\tsc'))) {
  Invoke-Checked 'npm.cmd' @('ci', '--no-audit', '--no-fund') 'npm ci failed.'
}
Invoke-Checked 'npm.cmd' @('run', 'compile') 'Extension compile failed.'
Invoke-Checked 'npm.cmd' @('run', 'gateway:build') 'Embedded Gateway build failed.'

$manifest = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$expectedVsixName = "ayla-local-agent-vscode-$($manifest.version).vsix"
$expectedVsix = Join-Path $repoRoot $expectedVsixName
if (Test-Path $expectedVsix) { Remove-Item $expectedVsix -Force }
& npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license
if ($LASTEXITCODE -ne 0) { Fail 'Packaging failed.' }
$latestVsix = Get-LatestVsix $repoRoot
if (-not $latestVsix -or $latestVsix.Name -ne $expectedVsixName) {
  Fail "Expected VSIX was not created: $expectedVsixName"
}

$ollamaBaseUrl = if ($env:AYLA_OLLAMA_BASE_URL) { $env:AYLA_OLLAMA_BASE_URL } else { 'http://127.0.0.1:11434' }
$selectedModel = Resolve-Model $ollamaBaseUrl

$extDir = Join-Path $repoRoot '.tmp-vscode-ext'
$userDir = Join-Path $repoRoot '.tmp-vscode-user'
$userSettingsDir = Join-Path $userDir 'User'
New-Item -ItemType Directory -Force -Path $extDir, $userDir, $userSettingsDir | Out-Null

[ordered]@{
  'ayla.ollama.baseUrl' = $ollamaBaseUrl
  'ayla.ollama.model' = $selectedModel
  'ayla.agent.maxSteps' = 12
  'ayla.agent.chatTimeoutMs' = 600000
  'ayla.embeddedCli.gatewayPort' = 0
} | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $userSettingsDir 'settings.json') -Encoding UTF8

& code.cmd --extensions-dir $extDir --user-data-dir $userDir --install-extension $latestVsix.FullName --force
if ($LASTEXITCODE -ne 0) { Fail 'VSIX install failed.' }
& code.cmd --extensions-dir $extDir --user-data-dir $userDir $targetWorkspaceRoot
if ($LASTEXITCODE -ne 0) { Fail 'Opening VS Code failed.' }

Write-Host ''
Write-Host 'AYLA embedded CLI launch complete.' -ForegroundColor Green
Write-Host "Target workspace: $targetWorkspaceRoot" -ForegroundColor Cyan
Write-Host "Model: $selectedModel" -ForegroundColor Cyan
Write-Host 'Embedded engine port: isolated dynamic port' -ForegroundColor Cyan
Write-Host 'Open Chat and select @ayla-cli, then send a normal coding task.' -ForegroundColor Yellow
