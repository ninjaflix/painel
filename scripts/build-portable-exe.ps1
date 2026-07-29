$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$dist = Join-Path $root "dist"
$packageDir = Join-Path $dist "NinjaFlixAgent-Portable"
$logsDir = Join-Path $packageDir "logs"
$runtimeDir = Join-Path $packageDir "runtime"
$portableSourceDir = Join-Path $packageDir "app"
$nodeVersion = "20.11.1"
$nodeZip = Join-Path $dist "node-v$nodeVersion-win-x64.zip"
$nodeExtractDir = Join-Path $dist "node-v$nodeVersion-win-x64"

New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

Write-Host "Validando sintaxe..."
Push-Location $root
npm run check
if ($LASTEXITCODE -ne 0) { throw "Falha na validacao de sintaxe do agente cliente." }

Write-Host "Gerando executavel portable com Node embutido..."
$pkgOk = $false
npx --yes @yao-pkg/pkg . --targets node18-win-x64 --output "$packageDir\ninjaflix-agent.exe"
if ($LASTEXITCODE -eq 0 -and (Test-Path "$packageDir\ninjaflix-agent.exe")) {
  $pkgOk = $true
} else {
  Write-Warning "Nao foi possivel gerar EXE unico com pkg neste Windows. Gerando portable com Node embutido na pasta runtime, sem instalar Node na maquina cliente."
}

if (!$pkgOk) {
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  New-Item -ItemType Directory -Force -Path $portableSourceDir | Out-Null
  if (!(Test-Path $nodeZip)) {
    Write-Host "Baixando Node portable $nodeVersion..."
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile $nodeZip -UseBasicParsing
  }
  if (Test-Path $nodeExtractDir) { Remove-Item $nodeExtractDir -Recurse -Force }
  Expand-Archive -Path $nodeZip -DestinationPath $dist -Force
  Copy-Item "$nodeExtractDir\node.exe" "$runtimeDir\node.exe" -Force
  Copy-Item "scripts" "$portableSourceDir\scripts" -Recurse -Force
  Copy-Item "src" "$portableSourceDir\src" -Recurse -Force
  Copy-Item "package.json" "$portableSourceDir\package.json" -Force
}

Copy-Item ".env.example" "$packageDir\.env.example" -Force
Copy-Item "README.md" "$packageDir\README.md" -Force
New-Item -ItemType Directory -Force -Path (Join-Path $packageDir "data") | Out-Null
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

@'
@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
if not exist .env (
  copy .env.example .env >nul
  echo Arquivo .env criado. Confira se o ADSPower esta aberto.
)
echo [%date% %time%] Iniciando NinjaFlix Agent portable...>> logs\agent.log
echo Use sempre iniciar-agente.cmd desta pasta portable. Nao precisa instalar Node no Windows.>> logs\agent.log
if exist ninjaflix-agent.exe (
  ninjaflix-agent.exe >> logs\agent.log 2>> logs\agent-error.log
) else if exist runtime\node.exe (
  runtime\node.exe app\scripts\local-agent.js >> logs\agent.log 2>> logs\agent-error.log
) else (
  echo ERRO: nao encontrei ninjaflix-agent.exe nem runtime\node.exe. Gere o pacote novamente.>> logs\agent-error.log
  echo ERRO: pacote incompleto. Veja logs\agent-error.log.
)
echo [%date% %time%] Agente finalizado com codigo %errorlevel%.>> logs\agent.log
echo.
echo Agente finalizado. Veja logs\agent.log e logs\agent-error.log para diagnostico.
pause
'@ | Set-Content -Path "$packageDir\iniciar-agente.cmd" -Encoding ASCII

@'
@echo off
cd /d "%~dp0"
echo ===== NinjaFlix Agent Portable - Diagnostico =====
echo Pasta: %cd%
echo.
if exist ninjaflix-agent.exe (
  echo OK: ninjaflix-agent.exe encontrado.
) else if exist runtime\node.exe (
  echo OK: runtime\node.exe encontrado. Portable usa Node embutido na pasta runtime, sem instalar no Windows.
) else (
  echo ERRO: nem ninjaflix-agent.exe nem runtime\node.exe foram encontrados. O pacote portable nao foi gerado corretamente.
)
if exist .env (
  echo OK: .env encontrado.
) else (
  echo AVISO: .env nao encontrado. O iniciar-agente.cmd cria uma copia do .env.example automaticamente.
)
echo.
echo Verificando porta 3101...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-NetTCPConnection -LocalPort 3101 -State Listen -ErrorAction SilentlyContinue; if($c){$c|Select LocalAddress,LocalPort,OwningProcess; $c|Select -Expand OwningProcess -Unique|%%{Get-Process -Id $_ -ErrorAction SilentlyContinue|Select Id,ProcessName,Path}} else {Write-Host 'Nenhum processo escutando na porta 3101'}"
echo.
echo Testando http://127.0.0.1:3101/health ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{Invoke-WebRequest -Uri 'http://127.0.0.1:3101/health' -UseBasicParsing -TimeoutSec 5|Select StatusCode,Content}else{Write-Host ('Falha no health: '+$_.Exception.Message)}"
echo.
echo Ultimas linhas do log principal:
if exist logs\agent.log powershell -NoProfile -Command "Get-Content 'logs\agent.log' -Tail 60" else echo Sem logs\agent.log
echo.
echo Ultimas linhas do log de erro:
if exist logs\agent-error.log powershell -NoProfile -Command "Get-Content 'logs\agent-error.log' -Tail 60" else echo Sem logs\agent-error.log
pause
'@ | Set-Content -Path "$packageDir\diagnostico-agente.cmd" -Encoding ASCII

@'
@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{Invoke-WebRequest -Uri 'http://127.0.0.1:3101/health' -UseBasicParsing -TimeoutSec 5|Select StatusCode,Content}else{Write-Host ('Agente nao respondeu: '+$_.Exception.Message)}"
pause
'@ | Set-Content -Path "$packageDir\status-agente.cmd" -Encoding ASCII

@'
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-NetTCPConnection -LocalPort 3101 -State Listen -ErrorAction SilentlyContinue; if($c){$c|Select -Expand OwningProcess -Unique|%%{Stop-Process -Id $_ -Force; Write-Host 'Processo parado:' $_}} else {Write-Host 'Nenhum agente rodando na porta 3101'}"
'@ | Set-Content -Path "$packageDir\parar-agente.cmd" -Encoding ASCII

Pop-Location

Write-Host "Pacote portable criado em: $packageDir"
Write-Host "Na maquina cliente, basta copiar essa pasta e abrir iniciar-agente.cmd."
Write-Host "Se houver erro no cliente, abra diagnostico-agente.cmd e envie os arquivos da pasta logs."
