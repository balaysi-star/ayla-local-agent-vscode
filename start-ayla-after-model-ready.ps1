$ErrorActionPreference = "Stop"

$Repo = "D:\octopus_main\ayla-local-agent-vscode"
$TargetWorkspace = if ($env:AYLA_TARGET_WORKSPACE) { $env:AYLA_TARGET_WORKSPACE } elseif (Test-Path "D:\octopus_main\Ayla") { "D:\octopus_main\Ayla" } else { $Repo }
$OllamaBaseUrl = "http://localhost:11434"
$Model = "ayla-local-coder:latest"
$ReadyToken = "AYLA_MODEL_READY"
$MaxWaitSeconds = 240

function Wait-And-WarmModel {
  param([int]$MaxSeconds)

  $deadline = (Get-Date).AddSeconds($MaxSeconds)
  $attempt = 0
  $lastError = "none"

  while ((Get-Date) -lt $deadline) {
    $attempt++

    try {
      Write-Host "Ayla boot: warm-up attempt $attempt..."

      $body = @{
        model = $Model
        stream = $false
        keep_alive = "1h"
        messages = @(
          @{
            role = "user"
            content = "Reply exactly: $ReadyToken"
          }
        )
      } | ConvertTo-Json -Depth 10

      $response = Invoke-RestMethod "$OllamaBaseUrl/api/chat" `
        -Method Post `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 180

      $content = ([string]$response.message.content).Trim()

      Write-Host "Ayla boot: response=$content"
      Write-Host "Ayla boot: total_duration=$($response.total_duration)"
      Write-Host "Ayla boot: load_duration=$($response.load_duration)"

      if ($content -eq $ReadyToken) {
        Write-Host "Ayla boot: model is ready."
        return
      }

      $lastError = "BAD_RESPONSE: $content"
    } catch {
      $lastError = $_.Exception.Message
      Write-Host "Ayla boot: warm-up failed: $lastError"
    }

    Start-Sleep -Seconds 5
  }

  throw "MODEL_NOT_READY_AFTER_${MaxSeconds}_SECONDS. Last error: $lastError"
}

Write-Host "Ayla boot: waiting until $Model can answer..."
Wait-And-WarmModel -MaxSeconds $MaxWaitSeconds

Set-Location $Repo

Write-Host "Ayla boot: compiling extension..."
npm run compile

Write-Host "Ayla boot: starting VS Code..."
code $TargetWorkspace
