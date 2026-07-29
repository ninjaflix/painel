$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$adsPowerInstaller = Join-Path $projectRoot 'adspower_exe\AdsPower-Global-8.6.3-x64.exe'
$ninjaExecutable = Join-Path $projectRoot 'dist-electron\win-unpacked\Ninjaflix Painel.exe'
$issFile = Join-Path $projectRoot 'installer\NinjaFlixBundle.iss'
$compilerCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe'),
  (Join-Path $env:ProgramFiles 'Inno Setup 7\ISCC.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 7\ISCC.exe')
)
$compiler = $compilerCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

if (-not $compiler) { throw 'Inno Setup 7 nao encontrado.' }
if (-not (Test-Path -LiteralPath $adsPowerInstaller)) { throw 'Instalador do AdsPower nao encontrado.' }
if (-not (Test-Path -LiteralPath $ninjaExecutable)) { throw 'Aplicativo empacotado do Ninjaflix Painel nao encontrado.' }

$expectedAdsHash = '99AC2ABEF961520919B8376448923DCE28A5BDBB543B77895BC3BE40AE90BD90'
$adsHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $adsPowerInstaller).Hash
if ($adsHash -ne $expectedAdsHash) { throw 'Hash do instalador AdsPower divergente.' }

$adsSignature = Get-AuthenticodeSignature -LiteralPath $adsPowerInstaller
if ($adsSignature.Status -ne 'Valid') { throw "Assinatura do AdsPower invalida: $($adsSignature.Status)" }
if ($adsSignature.SignerCertificate.Subject -notmatch 'SUNFLOWER TECH PTE\. LTD\.') { throw 'Publicador do AdsPower diferente do esperado.' }

& $compiler $issFile
if ($LASTEXITCODE -ne 0) { throw "Compilacao Inno Setup falhou com codigo $LASTEXITCODE." }

$output = Join-Path $projectRoot 'dist-bundle\NinjaFlixCompletoSetup-1.1.21.exe'
if (-not (Test-Path -LiteralPath $output)) { throw 'Instalador unificado nao foi gerado.' }
$outputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash
Write-Output "Gerado: $output"
Write-Output "SHA256: $outputHash"

$releaseDir = Join-Path $projectRoot 'ARQUIVOS-GERADOS\2-INSTALACAO-COMPLETA-NOVOS-CLIENTES'
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
Copy-Item -LiteralPath $output -Destination (Join-Path $releaseDir (Split-Path -Leaf $output)) -Force
Write-Output "Copia organizada em: $releaseDir"
