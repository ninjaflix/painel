# Instalador SunBrowser 150 para macOS Apple Silicon

O workflow `build-sunbrowser150-macos-arm64.yml` usa um runner Apple Silicon limpo para:

1. baixar e instalar o AdsPower Global oficial;
2. iniciar a Local API em modo headless;
3. abrir um perfil configurado para o kernel SunBrowser 150;
4. aguardar o download completo em `chrome_150`;
5. validar o marcador da versao e a arquitetura ARM64;
6. gerar `NinjaFlixSunBrowser150Setup-mac-arm64.pkg`.

## Configuracao necessaria

- Secret do repositorio: `ADSPOWER_API_KEY`.
- O workflow tenta detectar automaticamente um perfil configurado para SunBrowser 150. Se necessario, informe seu ID manualmente ao executar.
- Use uma chave de membro dedicada, restrita somente ao perfil de captura. Nunca grave a chave no YAML ou em arquivos do repositorio.

O instalador fecha processos do AdsPower/SunBrowser do usuario ativo, instala o kernel em `~/Library/Application Support/adspower_global/cwd_global/chrome_150` e preserva os arquivos originais baixados pelo AdsPower.
