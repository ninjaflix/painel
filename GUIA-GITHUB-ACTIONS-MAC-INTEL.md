# Compilar o NinjaFlix para Mac Intel no GitHub

Este fluxo gera, sem certificado Apple:

- a atualizacao portatil do painel em ZIP;
- o instalador completo em PKG com o AdsPower Intel.

O AdsPower nao e enviado ao repositorio. Durante a compilacao, o GitHub Actions
baixa a versao 8.6.3 pelo link oficial e confere o SHA-256 antes de utiliza-la.

## Primeira configuracao

1. Entre em https://github.com e crie uma conta ou faca login.
2. Crie um repositorio privado vazio.
3. Envie o conteudo desta pasta `AGENTE-CLIENTE-INSTALADOR` como a raiz do
   repositorio.
4. Nao envie `node_modules`, arquivos `.env`, DMGs, EXEs ou pastas de builds.
   Eles ja estao protegidos pelo `.gitignore`.

## Executar a compilacao

1. Abra o repositorio no GitHub.
2. Entre em **Actions**.
3. Escolha **Compilar macOS Intel nao assinado**.
4. Clique em **Run workflow** e confirme.
5. Quando terminar, abra a execucao e baixe o arquivo em **Artifacts**.

O artefato fica disponivel por 7 dias e contem o ZIP de atualizacao, o PKG
completo e o arquivo de verificacao SHA-256.

## Aviso do macOS

Como este e um build nao assinado e nao notarizado, o Gatekeeper pode bloquear
a primeira abertura. Ele deve ser usado somente para teste. A distribuicao
normal para clientes deve ser assinada e notarizada com uma conta Apple
Developer.

## Atualizar o AdsPower

Quando mudar a versao do AdsPower, atualize no workflow:

- `ADSPOWER_MAC_X64_URL`;
- `ADSPOWER_MAC_X64_SHA256`;

e tambem o nome/versao esperados em `scripts/build-macos.sh`.
