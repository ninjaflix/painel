# Plano do executável e instalador completo — NinjaFlix Agent Cliente

## 1. Objetivo

Criar um caminho de entrega em fases para o NinjaFlix Agent Cliente no Windows.

A primeira versão será um executável normal para validação do agente, sem ADSPower embutido e sem instalador final Inno Setup obrigatório.

A fase final será um instalador completo em Inno Setup, com atalho na Área de Trabalho, agente rodando em segundo plano, inicialização automática e suporte para instalar/detectar o ADSPower junto.

## 2. Premissas obrigatórias

- O agente do cliente deve usar como fonte principal a pasta `AGENTE-CLIENTE-INSTALADOR`.
- O agente deve escutar somente em `127.0.0.1:3101`.
- O cliente não deve precisar abrir terminal, PowerShell, Node.js ou processos paralelos manualmente.
- No uso normal, o cliente deve clicar apenas no atalho do NinjaFlix Agent; o painel deve abrir em janela própria do aplicativo, não em aba do navegador padrão.
- O único aplicativo externo visível permitido no fluxo operacional é o ADSPower/SunBrowser quando uma ferramenta/perfil for aberto.
- O instalador/arquivo entregue ao cliente não pode conter segredos.
- O ADSPower API Key não deve ser embutido no executável nem no `.env` distribuído.
- O Docker não deve ser usado na máquina do cliente.

## 3. Escopo da primeira versão — executável normal de validação

### 3.1 O que entra na primeira versão

A primeira versão tem objetivo de validar o agente cliente local com o menor risco possível:

- Gerar um executável do NinjaFlix Agent Cliente.
- Para validação inicial, aceitar abrir a interface em navegador ou em janela própria simples, mas registrar que a entrega final deve ser janela própria.
- Não embutir ADSPower.
- Não criar ainda o instalador final Inno Setup com wizard completo.
- Manter o ADSPower como pré-requisito instalado manualmente.
- Validar abertura do painel local em `http://127.0.0.1:3101/`.
- Validar login por e-mail/documento do checkout.
- Validar carregamento dos perfis liberados.
- Validar abertura/fechamento/status via ADSPower Local API.
- Validar visual, botões, suporte e popups antes de avançar para instalador final.

### 3.2 Entrega esperada da primeira versão

Entrega sugerida:

```text
AGENTE-CLIENTE-INSTALADOR/dist/NinjaFlixAgent-Validacao/
├─ ninjaflix-agent.exe
├─ iniciar-agente.cmd
├─ diagnostico-agente.cmd
├─ status-agente.cmd
├─ parar-agente.cmd
├─ .env.example
├─ README.md
├─ data/
└─ logs/
```

Nessa etapa, o cliente/testador ainda pode executar `iniciar-agente.cmd` para validação, mas o objetivo técnico é já testar o `ninjaflix-agent.exe` como base do produto final.

### 3.3 Pré-requisitos da primeira versão

- Windows 10/11.
- ADSPower instalado manualmente.
- ADSPower aberto.
- API local do ADSPower ativa.
- Portal central acessível via HTTPS.
- Cliente já existente/ativo no checkout ou no agente admin.

### 3.4 Configuração da primeira versão

O pacote deve conter apenas `.env.example` com variáveis públicas:

```env
AGENT_HOST=127.0.0.1
AGENT_PORT=3101
PORTAL_URL=https://agente-admin.187.77.55.247.nip.io
ADSPOWER_BASE_URL=http://local.adspower.net:50325
AGENT_TOKEN=
ADSPOWER_PROFILES_CACHE_TTL_MS=30000
```

Não incluir:

```env
ADSPOWER_API_KEY=
AGENTE_INTERNAL_API_SECRET=
POSTGRES_PASSWORD=
SMTP_PASS=
ASAAS_API_KEY=
```

## 4. Validações antes de gerar a primeira versão

### 4.1 Validar fonte correta

Antes do build, confirmar que a versão usada é:

```text
AGENTE-CLIENTE-INSTALADOR/scripts/local-agent.js
```

Não validar somente a cópia de:

```text
AGENTE DESKTOP/scripts/local-agent.js
```

Quando houver correção que também precisa existir na VPS/container, espelhar nos dois arquivos.

### 4.2 Validar sintaxe

Executar:

```powershell
node --check "AGENTE-CLIENTE-INSTALADOR/scripts/local-agent.js"
node --check "AGENTE DESKTOP/scripts/local-agent.js"
node --check "AGENTE DESKTOP/src/server.js"
```

Também validar o JavaScript embutido no HTML servido pelo agente, pois o `node --check` do arquivo principal não garante que o script do navegador esteja válido.

### 4.3 Validar processo correto na porta 3101

Antes de testar a UI, encerrar processo antigo da porta `3101` e iniciar o agente a partir da pasta correta:

```powershell
$pid = (Get-NetTCPConnection -LocalPort 3101 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
if ($pid) { Stop-Process -Id $pid -Force }
Start-Process -FilePath "node" -ArgumentList "scripts/local-agent.js" -WorkingDirectory "c:\RAFAEL\NINJAFLIX\GESTÃO DE CLIENTES\AGENTE-CLIENTE-INSTALADOR"
```

Conferir:

```powershell
Get-NetTCPConnection -LocalPort 3101 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess
```

### 4.4 Validar interface local

Abrir:

```text
http://127.0.0.1:3101/
```

Conferir obrigatoriamente:

- Login por e-mail/documento.
- Plano ativo.
- Perfis liberados carregando.
- Botão `Abrir` com visual correto.
- Botão `Upgrade` legível e sem efeito apagado indevido.
- Categoria `Gerador de IA` com card indisponível e botão `Upgrade` válido.
- Suporte abrindo `https://cliente.ninjaflix.club/suporte`.
- Popups direcionados funcionando.
- Popup de ferramenta resolvida aparecendo apenas uma vez por usuário.
- ADSPower offline exibindo mensagem clara.
- ADSPower online permitindo abrir/fechar/status.

## 5. Build da primeira versão

### 5.1 Comando previsto

Usar o script atual de build portable como base:

```powershell
cd "c:\RAFAEL\NINJAFLIX\GESTÃO DE CLIENTES\AGENTE-CLIENTE-INSTALADOR"
powershell -ExecutionPolicy Bypass -File ".\scripts\build-portable-exe.ps1"
```

### 5.2 Ajuste planejado para primeira versão

Se necessário, ajustar o script para separar claramente a saída de validação:

```text
dist/NinjaFlixAgent-Validacao/
```

ou manter a saída atual:

```text
dist/NinjaFlixAgent-Portable/
```

O mais importante nessa fase é gerar um executável funcional para validar o comportamento do agente antes do instalador completo.

## 6. Testes após gerar a primeira versão

Executar em máquina de teste ou ambiente limpo:

- Confirmar que não há Node.js instalado e, mesmo assim, o pacote roda quando houver fallback com runtime embutido.
- Confirmar que o ADSPower precisa estar instalado manualmente nessa fase.
- Abrir `iniciar-agente.cmd` ou executar `ninjaflix-agent.exe`.
- Acessar `http://127.0.0.1:3101/health`.
- Acessar `http://127.0.0.1:3101/`.
- Fazer login com cliente ativo.
- Abrir perfil ADSPower.
- Fechar perfil ADSPower.
- Consultar status.
- Reiniciar o agente.
- Validar logs em `logs/agent.log` e `logs/agent-error.log`.

## 7. Critérios para avançar para fase final

A fase final só deve começar quando a primeira versão passar nestes critérios:

- Agente local estável por pelo menos uma sessão completa de uso.
- Login e vínculo de máquina funcionando.
- Perfis liberados corretos por plano/cliente.
- ADSPower abre perfil corretamente pela API local.
- Botões e UI validados.
- Suporte redirecionando para o dashboard do cliente.
- Sem segredos no pacote.
- Logs suficientes para diagnóstico.
- Nenhum processo duplicado preso na porta `3101`.

## 8. Escopo da fase final — instalador completo Inno Setup

### 8.1 Objetivo final

Criar um instalador único:

```text
NinjaFlixAgentSetup.exe
```

Esse instalador deve:

- Instalar o NinjaFlix Agent.
- Embutir runtime Node oficial ou executável final do agente.
- Instalar/detectar ADSPower.
- Criar atalho na Área de Trabalho.
- Criar entrada no Menu Iniciar.
- Criar tarefa agendada para iniciar o agente no login.
- Rodar o agente em segundo plano, sem terminal.
- Abrir a interface local em janela própria do NinjaFlix Agent pelo atalho, sem usar aba do navegador padrão.
- Remover tarefas/atalhos/processos na desinstalação.

### 8.3 Janela própria do aplicativo

A fase final deve ter dois componentes locais:

1. Processo do agente/API local em segundo plano, responsável por `127.0.0.1:3101`.
2. Aplicativo de janela própria, responsável por carregar a interface local dentro de uma janela desktop.

Opções técnicas para a janela própria:

- Electron: mais simples para empacotar uma janela desktop que carrega `http://127.0.0.1:3101/`, porém gera pacote maior.
- WebView2: mais leve e nativo no Windows moderno, porém exige wrapper próprio ou runtime WebView2 instalado.
- Tauri: leve, mas adiciona cadeia Rust/build mais complexa.

Decisão por fase:

- Primeira fase: usar Electron para validar rapidamente a janela própria, o agente local, a navegação interna e o fluxo completo sem depender do navegador padrão.
- Segunda fase: migrar/reescrever a janela própria para WebView2, buscando pacote mais leve, aparência mais nativa no Windows e melhor acabamento para distribuição final.
- Tauri fica fora do caminho inicial, porque adiciona Rust e maior complexidade antes da validação do produto.

Comportamento esperado da janela própria:

- O atalho `NinjaFlix Agent` abre essa janela.
- A janela verifica se o agente local está ativo.
- Se o agente não estiver ativo, inicia/reinicia o processo de segundo plano.
- A janela carrega `http://127.0.0.1:3101/` internamente.
- O navegador padrão do usuário não é aberto.
- Ao fechar a janela, o agente pode continuar em segundo plano para manter disponibilidade, ou encerrar conforme decisão operacional futura.

### 8.4 Barra superior da janela desktop

A janela própria do NinjaFlix Agent deve ter uma barra superior pequena, discreta e nativa do aplicativo, separada do conteúdo do agente.

Itens obrigatórios da barra superior:

- Botão `Voltar`.
- Botão `Avançar`.
- Botão `Atualizar`.
- Indicador discreto de carregamento quando a página estiver navegando.
- Altura reduzida, sem competir visualmente com o header do agente.
- Visual neutro/escuro para combinar com o tema do NinjaFlix Agent.

Comportamento esperado:

- `Voltar` usa o histórico da janela própria.
- `Avançar` usa o histórico da janela própria.
- `Atualizar` recarrega a página atual.
- Se a página atual for o agente local, recarrega `http://127.0.0.1:3101/`.
- Se a página atual for externa, recarrega a página externa dentro da janela própria.

### 8.5 Header fixo do agente e navegação externa

O header/menu superior do agente deve permanecer fixo no topo da janela, mesmo quando o usuário abrir páginas externas a partir do agente.

Regra de navegação:

- O shell do NinjaFlix Agent fica como camada principal da experiência.
- O header/menu superior do agente permanece fixo.
- Páginas externas devem abrir abaixo do header fixo.
- Não usar `iframe` para carregar páginas externas.
- No Electron, a implementação deve usar navegação controlada por janela/webContents, BrowserView ou WebContentsView, mantendo a barra/header do aplicativo fora da página carregada.
- No WebView2, a implementação deve usar WebView controlado dentro de um layout nativo, mantendo a barra/header fora do conteúdo web carregado.
- Links externos sensíveis, como suporte, checkout, dashboard do cliente ou páginas de ferramentas, devem ser carregados na área de conteúdo abaixo do header, sem abrir o navegador padrão.
- Quando necessário, deve existir ação para voltar ao painel inicial do agente local.

Objetivo visual:

- O usuário sempre percebe que está dentro do NinjaFlix Agent.
- O menu superior do agente não desaparece ao abrir páginas externas.
- A página externa ocupa somente a área abaixo do header fixo.
- A solução evita `iframe` para reduzir problemas de bloqueio por `X-Frame-Options`, CSP, login, cookies e incompatibilidade com sites externos.

### 8.6 Estrutura planejada para fase final

```text
AGENTE-CLIENTE-INSTALADOR/
├─ installer/
│  └─ NinjaFlixAgentSetup.iss
├─ scripts/
│  ├─ build-installer.ps1
│  ├─ local-agent.js
│  ├─ service-start-agent.ps1
│  ├─ open-agent-ui.ps1
│  ├─ detect-adspower.ps1
│  ├─ install-adspower.ps1
│  ├─ status-agente.ps1
│  └─ parar-agente.ps1
├─ vendor/
│  ├─ node/
│  │  └─ node.exe
│  └─ adspower/
│     └─ ADSPowerSetup.exe
├─ src/
│  ├─ config.js
│  └─ adspower.js
└─ public/
   ├─ logo.svg
   └─ logo-roxo.svg
```

### 8.7 Pasta de instalação

Para evitar permissão de administrador na primeira fase final, usar:

```text
%LOCALAPPDATA%\NinjaFlixAgent
```

Em uma versão corporativa futura, avaliar:

```text
C:\Program Files\NinjaFlix Agent
```

## 9. Comportamento da fase final

### 9.1 Durante instalação

O instalador deve:

1. Copiar arquivos do agente.
2. Copiar runtime Node ou executável do agente.
3. Criar `.env` local somente com variáveis públicas.
4. Detectar ADSPower instalado.
5. Se não houver ADSPower, instalar usando `vendor/adspower/ADSPowerSetup.exe`.
6. Criar tarefa agendada `NinjaFlixAgent`.
7. Criar atalho `NinjaFlix Agent` na Área de Trabalho.
8. Criar atalho de diagnóstico no Menu Iniciar.
9. Iniciar o agente em segundo plano.
10. Opcionalmente abrir a interface local ao finalizar.

### 9.2 Após instalação

Ao clicar no atalho `NinjaFlix Agent`:

1. O aplicativo de janela própria verifica se `127.0.0.1:3101/health` responde.
2. Se não responder, inicia/reinicia o agente em segundo plano.
3. Detecta se o ADSPower está aberto.
4. Se o ADSPower estiver fechado, tenta abrir o executável instalado.
5. Carrega `http://127.0.0.1:3101/` dentro da janela própria.
6. Não abre aba no navegador padrão.
7. Não mantém terminal aberto.
8. Mantém barra superior discreta com `Voltar`, `Avançar` e `Atualizar`.
9. Mantém o header/menu do agente fixo durante navegação interna e externa.
10. Carrega páginas externas abaixo do header fixo, sem `iframe`.

## 10. ADSPower embutido na fase final

### 10.1 Primeira versão final com ADSPower offline

Preferência para robustez:

```text
AGENTE-CLIENTE-INSTALADOR/vendor/adspower/ADSPowerSetup.exe
```

O arquivo deve ser o instalador oficial do ADSPower.

Vantagens:

- Funciona com internet instável.
- Evita URL de download quebrar.
- Experiência do cliente fica em um único instalador.

Desvantagens:

- Instalador final maior.
- Necessidade de atualizar manualmente o instalador do ADSPower quando houver versão nova.

### 10.2 Fallback se ADSPower offline não estiver disponível

Se o instalador offline não existir:

- Detectar ausência do ADSPower.
- Abrir a página oficial de download.
- Exibir instrução clara para instalar e abrir ADSPower.
- Não bloquear instalação do NinjaFlix Agent.

### 10.3 Detecção planejada do ADSPower

Procurar em caminhos comuns:

```text
%LOCALAPPDATA%\Programs\adspower_global\ADSPower.exe
%LOCALAPPDATA%\Programs\ADSPower\ADSPower.exe
%ProgramFiles%\ADSPower\ADSPower.exe
%ProgramFiles(x86)%\ADSPower\ADSPower.exe
```

Também validar a API local:

```text
http://local.adspower.net:50325
http://127.0.0.1:50325
```

## 11. Robustez operacional

### 11.1 Tarefa agendada

Criar tarefa agendada:

```text
NinjaFlixAgent
```

Configuração desejada:

- Executar no login do usuário.
- Rodar com menor privilégio possível.
- Não abrir janela visível.
- Reiniciar em caso de falha quando possível.
- Usar working directory da pasta instalada.

### 11.2 Logs

Manter logs em:

```text
%LOCALAPPDATA%\NinjaFlixAgent\logs
```

Arquivos mínimos:

```text
agent.log
agent-error.log
launcher.log
installer.log
adspower-detect.log
```

### 11.3 Diagnóstico

O instalador final deve criar um comando de diagnóstico que coleta:

- Status da porta `3101`.
- Processo dono da porta.
- Resultado de `/health`.
- Caminho detectado do ADSPower.
- Status da API local do ADSPower.
- Últimas linhas de logs.

## 12. Desinstalação

O desinstalador deve:

- Encerrar o agente.
- Remover tarefa agendada `NinjaFlixAgent`.
- Remover atalhos.
- Remover arquivos do NinjaFlix Agent.
- Preservar ou perguntar antes de remover dados locais, se houver sessão/cache.
- Não desinstalar ADSPower automaticamente sem confirmação explícita, porque o cliente pode usar ADSPower para outras finalidades.

## 13. Checklist de segurança antes de distribuir

- [ ] Verificar ausência de `ADSPOWER_API_KEY` preenchido.
- [ ] Verificar ausência de `.env` sensível.
- [ ] Verificar ausência de tokens internos.
- [ ] Confirmar `PORTAL_URL` em HTTPS.
- [ ] Confirmar que o agente escuta apenas em `127.0.0.1`.
- [ ] Confirmar que não há Docker no pacote cliente.
- [ ] Confirmar que logs não imprimem segredos.
- [ ] Confirmar que o ADSPower embutido é o instalador oficial.

## 14. Checklist de validação da fase final

- [ ] Instalar em Windows limpo sem Node.js.
- [ ] Confirmar atalho na Área de Trabalho.
- [ ] Confirmar que o atalho abre uma janela própria do NinjaFlix Agent.
- [ ] Confirmar que o navegador padrão não é aberto ao iniciar o NinjaFlix Agent.
- [ ] Confirmar barra superior pequena com botões `Voltar`, `Avançar` e `Atualizar`.
- [ ] Confirmar header/menu do agente fixo durante navegação.
- [ ] Confirmar páginas externas abrindo abaixo do header fixo.
- [ ] Confirmar que páginas externas não usam `iframe`.
- [ ] Confirmar agente rodando sem terminal.
- [ ] Confirmar tarefa agendada criada.
- [ ] Confirmar ADSPower detectado ou instalado.
- [ ] Confirmar API local do ADSPower respondendo.
- [ ] Confirmar `http://127.0.0.1:3101/health`.
- [ ] Confirmar login por e-mail/documento.
- [ ] Confirmar perfis liberados.
- [ ] Confirmar abrir/fechar/status.
- [ ] Reiniciar Windows e confirmar agente ativo.
- [ ] Desinstalar e confirmar limpeza.

## 15. Ordem recomendada de execução

1. Validar agente atual em modo código-fonte.
2. Gerar primeira versão com executável normal, sem ADSPower embutido.
3. Testar em máquina de validação com ADSPower instalado manualmente.
4. Corrigir falhas do agente e da UI.
5. Criar instalador Inno Setup sem ADSPower embutido, apenas para instalar agente e atalho.
6. Validar instalação/desinstalação.
7. Adicionar detecção robusta do ADSPower.
8. Adicionar instalação opcional do ADSPower via instalador offline.
9. Gerar instalador final completo.
10. Testar em máquina limpa.

## 16. Resultado final esperado

Ao final do projeto, o cliente receberá um único instalador `NinjaFlixAgentSetup.exe`.

Na primeira validação, o cliente/testador receberá apenas um executável normal do agente, sem ADSPower embutido.

Na fase final, o instalador completo será responsável por instalar o agente, preparar execução em segundo plano, criar atalho, detectar/instalar ADSPower e entregar uma experiência simples: clicar no atalho `NinjaFlix Agent`, acessar o painel local e abrir as ferramentas pelo ADSPower/SunBrowser.
