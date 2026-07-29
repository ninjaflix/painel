$ErrorActionPreference = "SilentlyContinue"

$connection = Get-NetTCPConnection -LocalPort 3101 -State Listen | Select-Object -First 1
if (-not $connection) {
  Write-Host "Agente nao esta escutando na porta 3101."
  exit 1
}

Write-Host "Agente escutando na porta 3101. Processo: $($connection.OwningProcess)"
try {
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:3101/health" -UseBasicParsing -TimeoutSec 10
  Write-Host "Health HTTP: $($response.StatusCode)"
  Write-Host $response.Content
} catch {
  Write-Host "Falha ao consultar /health: $($_.Exception.Message)"
  exit 1
}
