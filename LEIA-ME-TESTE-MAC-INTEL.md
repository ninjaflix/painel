# NinjaFlix — teste no Mac Intel

Este pacote serve para testar o painel diretamente em um Mac Intel antes de
gerar o instalador completo.

## 1. Preparar o Mac

Abra o Terminal e execute:

```bash
xcode-select --install
```

Instale também o Node.js 18 ou mais recente.

## 2. Instalar o AdsPower Intel

Abra:

```text
adspower_exe/mac/AdsPower-Global-8.6.3.dmg
```

Arraste o AdsPower para Aplicativos e abra-o pelo menos uma vez.

## 3. Testar o painel sem compilar

No Terminal, entre na pasta extraída e execute:

```bash
npm ci
npm run electron:dev
```

O `npm ci` deve ser executado no próprio Mac. Não use `node_modules` copiado do
Windows.

## 4. Gerar o instalador Intel apenas para teste

Para gerar um PKG local sem assinatura ou notarização:

```bash
MAC_ALLOW_UNSIGNED=1 npm run build:mac:intel
```

O arquivo completo será criado em:

```text
ARQUIVOS-GERADOS/2-INSTALACAO-COMPLETA-NOVOS-CLIENTES/MAC/
```

Esse PKG não assinado é somente para validação. Para distribuir aos clientes,
gere novamente com certificados Apple e notarização.
