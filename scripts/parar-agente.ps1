$connections = Get-NetTCPConnection -LocalPort 3101 -State Listen -ErrorAction SilentlyContinue
if (-not $connections) {
  Write-Host "Nenhum agente escutando na porta 3101."
  exit 0
}

$connections | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
  Write-Host "Parando processo $_ na porta 3101..."
  Stop-Process -Id $_ -Force
}
