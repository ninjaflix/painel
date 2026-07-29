@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "ROOT_DIR=%SCRIPT_DIR%.."
cd /d "%ROOT_DIR%"

node --version >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale Node.js 18 ou superior: https://nodejs.org/
  pause
  exit /b 1
)

if not exist .env (
  copy .env.example .env >nul
  echo Arquivo .env criado a partir de .env.example.
)

echo Removendo instancias antigas do agente local...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$procs = Get-WmiObject Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*local-agent.js*' }; if($procs){ foreach($p in $procs){ Write-Host ('Removendo instancia antiga: PID='+$p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } }"

if not defined AGENT_HOST set "AGENT_HOST=127.0.0.1"

rem O painel do cliente sempre procura o agente local na porta 3101.
rem Ignora AGENT_PORT herdado do terminal para evitar abrir em 3102/3103
rem e parecer que o iniciar-agente.cmd nao funcionou.
set "PORTA_INICIAL=3101"
set "AGENT_PORT=3101"
set "PORTA_MAXIMA=3200"

set "TARGET_SCRIPT=%ROOT_DIR%\\scripts\\local-agent.js"
if not exist "%TARGET_SCRIPT%" (
  echo Script do agente nao encontrado: %TARGET_SCRIPT%
  pause
  exit /b 1
)

set "PORTA_CANDIDATA=%PORTA_INICIAL%"

:PROCURAR_PORTA
set "PORTA_EM_USO="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%PORTA_CANDIDATA% .*LISTENING"') do (
  set "PORTA_EM_USO=%%p"
)

if defined PORTA_EM_USO (
  echo Porta %PORTA_CANDIDATA% em uso.
  echo Tentando liberar PID %PORTA_EM_USO%...
  taskkill /PID %PORTA_EM_USO% /F >nul 2>nul
  if errorlevel 1 (
    echo Nao foi possivel encerrar o PID %PORTA_EM_USO%.
    echo A porta 3101 precisa ficar livre para o painel cliente encontrar o agente.
    pause
    exit /b 1
  )
)

set "PORTA_NOVA=%PORTA_CANDIDATA%"

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%PORTA_NOVA% .*LISTENING"') do (
  set "PORTA_EM_USO=%%p"
)

if defined PORTA_EM_USO (
  echo A porta %PORTA_NOVA% continua em uso apos a tentativa de liberacao.
  pause
  exit /b 1
)

set "AGENT_PORT=%PORTA_NOVA%"
set "PORT=%AGENT_PORT%"

if not "%PORTA_INICIAL%"=="%AGENT_PORT%" (
  echo Porta inicial %PORTA_INICIAL% indisponivel. Usando porta alternativa: %AGENT_PORT%
)

echo Iniciando Agente local em http://%AGENT_HOST%:%AGENT_PORT% ...
node "%TARGET_SCRIPT%"

set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Falha ao iniciar o agente. Codigo de erro: %EXIT_CODE%
  echo Verifique se a porta escolhida (%AGENT_PORT%) esta livre e se as dependencias estao instaladas.
  pause
  exit /b %EXIT_CODE%
)

pause
