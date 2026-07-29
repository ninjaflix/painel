param(
  [string]$InstallDir = "$env:LOCALAPPDATA\NinjaFlixAgent"
)

$ErrorActionPreference = "Stop"

function Assert-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw "Node.js nao encontrado. Instale Node.js 18 ou superior em https://nodejs.org/ e execute novamente."
  }
}

Assert-Node

$source = Resolve-Path (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $source "*") -Destination $InstallDir -Recurse -Force

$envPath = Join-Path $InstallDir ".env"
if (-not (Test-Path $envPath)) {
  Copy-Item (Join-Path $InstallDir ".env.example") $envPath
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "NinjaFlix Agent.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "cmd.exe"
$shortcut.Arguments = "/c `"$InstallDir\scripts\iniciar-agente.cmd`""
$shortcut.WorkingDirectory = $InstallDir
$shortcut.IconLocation = "cmd.exe"
$shortcut.Save()

Write-Host "NinjaFlix Agent instalado em: $InstallDir"
Write-Host "Atalho criado na Area de Trabalho: $shortcutPath"
Write-Host "Execute o atalho e acesse: http://127.0.0.1:3101"
