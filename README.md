# NinjaFlix Agent Cliente

## Linha de versao 2.0

- `2.0.0` e a versao de transicao manual para clientes instalados nas linhas `1.1.33` a `1.1.48`.
- Atualizacao leve: `ARQUIVOS-GERADOS/1-ATUALIZACAO-PAINEL-PUBLICAR-NO-ADMIN/NinjaFlixPainelSetup-2.0.0.exe`.
- Instalacao completa com AdsPower: `ARQUIVOS-GERADOS/2-INSTALACAO-COMPLETA-NOVOS-CLIENTES/NinjaFlixCompletoSetup-2.0.0.exe`.
- Depois da instalacao manual da `2.0.0`, as proximas versoes usam o atualizador oficial do Electron.
- `2.0.2` migra o portal central do agente para `https://painel.ninjaflix.club`, inclusive nas instalacoes atualizadas sobre a 2.0.1.
- `2.0.1` adiciona o aceite obrigatorio dos Termos de Uso e da Politica de Privacidade no instalador completo.
- O instalador `2.0.1` tenta atualizar os documentos em `https://ativar.ninjaflix.club/api/public/legal/installer.txt`, salva uma copia local e mantem um fallback embutido para instalacoes offline.
- Arquivos locais `2.0.1`: `NinjaFlixPainelSetup-2.0.1.exe` (painel) e `NinjaFlixCompletoSetup-2.0.1.exe` (painel + AdsPower).
- Nunca confundir a atualizacao leve com o instalador completo para novos clientes.

Repositório mínimo para gerar/instalar o agente local em uma máquina de cliente.

O agente local roda em `http://127.0.0.1:3101`, autentica o cliente pelo CPF usado no checkout, vincula a máquina ao cliente no Gestão/agent-admin e lista somente os perfis ADSPower liberados no painel central.

## O que este pacote faz

- Captura a máquina local e vincula ao CPF do cliente.
- Consulta o portal central em `https://painel.ninjaflix.club`.
- Lista os perfis liberados no agente-admin.
- Abre, fecha e consulta status dos perfis no ADSPower local.
- Serve endpoints locais usados pela extensão em `http://127.0.0.1:3101`.
- Usa cache curto para evitar rate limit ao detectar perfis ADSPower.

## Pré-requisitos

1. Windows 10/11.
2. ADSPower instalado e aberto na máquina.
3. API local do ADSPower ativa.
   - Endereço obrigatório: `http://127.0.0.1:50326`
4. Cliente já criado/pago no checkout e CPF disponível.

Docker não é usado neste instalador local.

Node.js só é necessário se você for rodar este repositório em modo código-fonte. Para o cliente final, gere o pacote portable `.exe` em uma máquina técnica e entregue apenas o executável/pasta final.

## Regra de segurança para `.env` e chaves

O instalador local que será enviado ao cliente **não deve conter segredos**.

- Não coloque `ADSPOWER_API_KEY` no instalador local.
- Não envie `.env` preenchido junto com o `.exe`.
- O `.env` com chaves sensíveis deve existir somente na VPS, em local protegido, com permissão restrita.
- O agente local deve conter apenas configurações públicas, como `PORTAL_URL`, `AGENT_HOST`, `AGENT_PORT` e `ADSPOWER_BASE_URL`.

## Instalação recomendada sem Node.js no cliente

Em uma máquina técnica/desenvolvedor, com Node.js instalado, execute:

```powershell
npm run build:exe
```

Isso cria:

```text
dist/NinjaFlixAgent-Portable/
```

Copie essa pasta para a máquina do cliente e execute:

```text
iniciar-agente.cmd
```

Nesse modo, o cliente não precisa instalar Node.js nem qualquer ambiente de container.

## Instalação rápida no Windows

### Opção 1 — instalar com PowerShell usando Node.js

Abra PowerShell dentro desta pasta e execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\instalar-windows.ps1
```

Isso copia o agente para:

```text
%LOCALAPPDATA%\NinjaFlixAgent
```

E cria um atalho na Área de Trabalho chamado:

```text
NinjaFlix Agent
```

### Opção 2 — rodar direto sem instalar

Dentro desta pasta, execute:

```cmd
scripts\iniciar-agente.cmd
```

Ou:

```powershell
npm run agent
```

Depois abra no navegador:

```text
http://127.0.0.1:3101
```

## Configuração

Na primeira execução, se não existir `.env`, o script cria uma cópia de `.env.example` somente com configurações públicas.

Configuração padrão recomendada:

```env
AGENT_HOST=127.0.0.1
AGENT_PORT=3101
PORTAL_URL=https://painel.ninjaflix.club
ADSPOWER_BASE_URL=http://127.0.0.1:50326
AGENT_TOKEN=
```

Observações:

- `PORTAL_URL` deve ficar em HTTPS.
- `AGENT_TOKEN` pode ficar vazio, porque o login por CPF cria/renova a sessão automaticamente.
- `ADSPOWER_API_KEY` não deve existir no `.env` enviado ao cliente.
- Se o ADSPower não responder em `local.adspower.net`, tente trocar para:

```env
ADSPOWER_BASE_URL=http://127.0.0.1:50326
```

## Primeiro uso pelo cliente

1. Abra o ADSPower.
2. Abra o atalho `NinjaFlix Agent`.
3. Acesse `http://127.0.0.1:3101`.
4. Informe apenas o CPF usado no checkout.
5. O agente vai:
   - localizar o cliente no portal central;
   - vincular a máquina;
   - salvar a sessão local;
   - listar os perfis liberados.

## Testes úteis

### Verificar se o agente está online

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:3101/health -UseBasicParsing
```

### Verificar perfis liberados

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:3101/profiles -UseBasicParsing
```

### Verificar status via script

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\status-agente.ps1
```

### Parar agente preso na porta 3101

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\parar-agente.ps1
```

## Estrutura de arquivos

```text
AGENTE-CLIENTE-INSTALADOR/
├─ package.json
├─ .env.example
├─ README.md
├─ data/
│  └─ .gitkeep
├─ scripts/
│  ├─ local-agent.js
│  ├─ iniciar-agente.cmd
│  ├─ instalar-windows.ps1
│  ├─ status-agente.ps1
│  └─ parar-agente.ps1
└─ src/
   ├─ adspower.js
   └─ config.js
```

## Erros comuns

### `Endpoint não encontrado` em `/profiles`

Normalmente indica que o agente está apontando para um portal antigo ou HTTP. Confirme no log se aparece:

```text
Portal central configurado: https://painel.ninjaflix.club
```

### `Token do agente inválido`

Faça login novamente pelo CPF em `http://127.0.0.1:3101`. O agente renova a sessão com a máquina vinculada.

### `Falha ao consultar ADSPower`

Verifique se:

- ADSPower está aberto.
- API local do ADSPower está ativa.
- `ADSPOWER_BASE_URL` está correto no `.env`.
- Se o ADSPower retornar `Require api-key`, não coloque chave no instalador distribuído ao cliente; a chave sensível deve permanecer somente na VPS/ambiente operacional protegido.

### Porta 3101 ocupada

Execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\parar-agente.ps1
```

Depois inicie novamente.

## Segurança operacional

- Não envie `.env` preenchido para terceiros.
- Não inclua `ADSPOWER_API_KEY` no instalador, no `.exe`, em `.env.example`, em README ou em qualquer arquivo local distribuído.
- Segredos ficam somente na VPS, fora do código versionado, em arquivo de ambiente protegido.
- Não versionar arquivos em `data/*.json`, pois podem conter sessão local.
- A máquina deve ser administrada pelo Gestão NinjaFlix, não pelo agente local.
- Bloqueio/ativação/remove máquina deve continuar no Gestão.
