$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

Push-Location $root

Write-Host "Validando sintaxe do agente e do launcher Electron..."
npm run check
if ($LASTEXITCODE -ne 0) { throw "Falha na validacao de sintaxe do agente cliente." }

node --check electron/main.js
if ($LASTEXITCODE -ne 0) { throw "Falha na validacao de electron/main.js." }

node --check electron/preload.js
if ($LASTEXITCODE -ne 0) { throw "Falha na validacao de electron/preload.js." }

if (!(Test-Path "node_modules\electron") -or !(Test-Path "node_modules\electron-builder")) {
  Write-Host "Instalando dependencias Electron da primeira versao..."
  npm install
  if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar dependencias npm." }
}

Write-Host "Gerando instalador Electron de validacao..."
npx electron-builder --win nsis --x64
if ($LASTEXITCODE -ne 0) { throw "Falha ao gerar instalador Electron." }

Write-Host "Instalador gerado em: dist-electron"
Write-Host "Esta primeira versao NAO inclui ADSPower embutido. O ADSPower deve estar instalado e com API local ativa."

$updateInstaller = Join-Path $root 'dist-electron\NinjaFlixPainelSetup-1.1.22.exe'
$releaseDir = Join-Path $root 'ARQUIVOS-GERADOS\1-ATUALIZACAO-PAINEL-PUBLICAR-NO-ADMIN'
if (!(Test-Path -LiteralPath $updateInstaller)) { throw "Atualizador leve nao foi encontrado: $updateInstaller" }
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
Copy-Item -LiteralPath $updateInstaller -Destination (Join-Path $releaseDir (Split-Path -Leaf $updateInstaller)) -Force
Write-Host "Atualizador leve copiado para: $releaseDir"
Write-Host "PUBLIQUE NO ADMIN SOMENTE O ARQUIVO DESTA PASTA."

Pop-Location
