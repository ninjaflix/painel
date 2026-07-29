# NinjaFlix — teste no Mac Intel sem AdsPower

Este pacote contém somente o painel NinjaFlix e os arquivos necessários para
testá-lo em um Mac Intel. O instalador do AdsPower não está incluído.

## Requisitos

- macOS 11 ou mais recente;
- Node.js 18 ou mais recente;
- Xcode Command Line Tools;
- AdsPower já instalado e configurado no computador.

No Terminal:

```bash
xcode-select --install
```

## Testar o painel sem compilar

Entre na pasta extraída e execute:

```bash
npm ci
npm run electron:dev
```

O `npm ci` precisa ser executado no próprio Mac. Não reutilize `node_modules`
gerado no Windows.

## Gerar somente o painel para teste

O fluxo completo `build:mac:intel` exige o DMG do AdsPower para montar o PKG
completo. Sem esse arquivo, use este pacote apenas para executar e validar o
painel diretamente com `npm run electron:dev`.
