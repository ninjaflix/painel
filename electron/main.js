const { app, BrowserWindow, ipcMain, shell, Notification, nativeTheme } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const AGENT_PORT = Number(process.env.AGENT_PORT || 3101);
const AGENT_URL = `http://127.0.0.1:${AGENT_PORT}/`;
const APP_VERSION = app.isPackaged ? app.getVersion() : (process.env.AGENT_VERSION || app.getVersion());
app.setName('Ninjaflix');
const CANONICAL_USER_DATA = process.env.NINJAFLIX_USER_DATA
  ? path.resolve(process.env.NINJAFLIX_USER_DATA)
  : path.join(app.getPath('appData'), 'Ninjaflix');
app.setPath('userData', CANONICAL_USER_DATA);
nativeTheme.themeSource = 'dark';
if (process.platform === 'win32') app.setAppUserModelId('club.ninjaflix.agent');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
const ADSPOWER_BASE_URL = 'http://127.0.0.1:50326';
const ADSPOWER_DISABLE_PASSWORD_FILLING = '0';
const ADSPOWER_ENABLE_PASSWORD_SAVING = '1';
function resolveAppIcon() {
  const candidates = [
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.ico')
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || path.join(__dirname, '..', 'build', 'icon.ico');
}

let mainWindow = null;
let splashWindow = null;
let agentStarted = false;
let updateInProgress = false;
let splashFallbackTimer = null;
let updaterConfigured = false;

function migrateLegacyRuntimeState() {
  fs.mkdirSync(CANONICAL_USER_DATA, { recursive: true });
  const legacyRoots = [
    path.join(app.getPath('appData'), 'ninjaflix-agent-cliente'),
    path.join(app.getPath('appData'), 'NinjaFlix Agent')
  ];
  const files = [path.join('data', 'local-agent-state.json'), '.env'];
  for (const relative of files) {
    const target = path.join(CANONICAL_USER_DATA, relative);
    if (fs.existsSync(target)) continue;
    const source = legacyRoots.map((root) => path.join(root, relative)).find((candidate) => fs.existsSync(candidate));
    if (!source) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function sendUpdateStatus(status, details = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', { status, ...details });
}

function configureOfficialUpdater() {
  if (updaterConfigured || process.platform !== 'win32' || !app.isPackaged) return;
  updaterConfigured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: `${AGENT_URL}electron-updates/`,
    useMultipleRangeRequest: false
  });
  autoUpdater.on('download-progress', (progress = {}) => {
    sendUpdateStatus('downloading', {
      received: Number(progress.transferred || 0),
      total: Number(progress.total || 0),
      percent: Number(progress.percent || 0)
    });
  });
  autoUpdater.on('error', (error) => {
    if (updateInProgress) sendUpdateStatus('official-error', { message: error?.message || 'Falha no atualizador oficial' });
  });
}

async function installWindowsOfficialUpdate(update) {
  configureOfficialUpdater();
  if (!updaterConfigured) throw new Error('Atualizador oficial indisponivel neste ambiente');
  const result = await autoUpdater.checkForUpdates();
  const available = result?.updateInfo;
  if (!available?.version) throw new Error('O servidor nao retornou uma atualizacao oficial');
  if (String(available.version) !== String(update.version || '')) {
    throw new Error(`Versao oficial divergente: esperada ${update.version}, recebida ${available.version}`);
  }
  const downloadedFiles = await autoUpdater.downloadUpdate();
  const installerPath = Array.isArray(downloadedFiles) ? downloadedFiles[0] : null;
  if (!installerPath || !fs.existsSync(installerPath)) throw new Error('O atualizador oficial não retornou o instalador baixado');
  sendUpdateStatus('installing', { official: true, version: available.version });
  await scheduleWindowsUpdate(installerPath);
  return { ok: true, official: true };
}

function downloadInstaller(update) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(String(update.downloadUrl || ''));
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || Number(parsed.port) !== AGENT_PORT) {
      return reject(new Error('Origem da atualização não permitida'));
    }
    if (!/^\d+\.\d+\.\d+$/.test(String(update.version || ''))) return reject(new Error('Versão da atualização inválida'));
    if (!/^[a-f0-9]{64}$/i.test(String(update.sha256 || ''))) return reject(new Error('Hash da atualização inválido'));
    const expectedSize = Number(update.sizeBytes || 0);
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) return reject(new Error('Tamanho da atualização inválido'));
    const updatesDir = path.join(app.getPath('userData'), 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    const expectedExtension = process.platform === 'darwin'
      ? '.zip'
      : process.platform === 'linux'
        ? '.appimage'
        : '.exe';
    const publishedName = path.basename(String(update.fileName || update.filename || update.originalFileName || ''));
    if (publishedName && path.extname(publishedName).toLowerCase() !== expectedExtension) {
      return reject(new Error(`Formato de atualização incompatível com ${process.platform}`));
    }
    const finalPath = path.join(
      updatesDir,
      process.platform === 'darwin'
        ? `NinjaFlixPainelUpdate-${update.version}-${process.arch}.zip`
        : process.platform === 'linux'
          ? `NinjaFlixPainelUpdate-${update.version}-linux-${process.arch}.AppImage`
          : `NinjaFlixPainelSetup-${update.version}.exe`
    );
    const partPath = `${finalPath}.part`;
    fs.rmSync(partPath, { force: true });
    const output = fs.createWriteStream(partPath, { flags: 'wx' });
    const hash = crypto.createHash('sha256');
    let received = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      output.destroy();
      fs.rm(partPath, { force: true }, () => reject(error));
    };
    const request = (parsed.protocol === 'https:' ? https : http).get(parsed, { timeout: 30000 }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return fail(new Error(`Download recusado (HTTP ${response.statusCode})`));
      }
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > expectedSize) return fail(new Error('Arquivo maior que o tamanho publicado'));
        hash.update(chunk);
        sendUpdateStatus('downloading', { received, total: expectedSize });
      });
      response.pipe(output);
      output.on('finish', () => {
        output.close(() => {
          if (settled) return;
          const digest = hash.digest('hex');
          if (received !== expectedSize) return fail(new Error('Download incompleto'));
          if (digest.toLowerCase() !== String(update.sha256).toLowerCase()) return fail(new Error('SHA-256 da atualização não confere'));
          settled = true;
          fs.rmSync(finalPath, { force: true });
          fs.renameSync(partPath, finalPath);
          resolve(finalPath);
        });
      });
      response.on('error', fail);
    });
    request.on('timeout', () => request.destroy(new Error('Tempo limite do download excedido')));
    request.on('error', fail);
    output.on('error', fail);
  });
}

function installMacUpdate(updatePath) {
  const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const currentAppPath = path.resolve(process.execPath, '..', '..', '..');
  if (!currentAppPath.endsWith('.app')) throw new Error('O painel precisa estar instalado como aplicativo para receber a atualização');
  const updateRoot = path.join(app.getPath('userData'), 'updates', `apply-${Date.now()}`);
  const extractedRoot = path.join(updateRoot, 'extracted');
  const scriptPath = path.join(updateRoot, 'install-update.sh');
  const privilegedScriptPath = path.join(updateRoot, 'replace-app.sh');
  fs.mkdirSync(extractedRoot, { recursive: true });
  const privilegedScript = [
    '#!/bin/sh',
    'set -eu',
    `SOURCE=${shellQuote(path.join(extractedRoot, 'Ninjaflix Painel.app'))}`,
    `TARGET=${shellQuote(currentAppPath)}`,
    'BACKUP="${TARGET}.ninjaflix-backup"',
    '/bin/rm -rf "$BACKUP"',
    '/bin/mv "$TARGET" "$BACKUP"',
    'if /usr/bin/ditto "$SOURCE" "$TARGET"; then',
    '  /bin/rm -rf "$BACKUP"',
    'else',
    '  /bin/rm -rf "$TARGET"',
    '  /bin/mv "$BACKUP" "$TARGET"',
    '  exit 1',
    'fi'
  ].join('\n');
  fs.writeFileSync(privilegedScriptPath, `${privilegedScript}\n`, { mode: 0o700 });
  const elevatedCommand = `/bin/sh ${shellQuote(privilegedScriptPath)}`;
  const appleScript = `do shell script ${JSON.stringify(elevatedCommand)} with administrator privileges`;
  const script = [
    '#!/bin/sh',
    'set -eu',
    `CURRENT_PID=${process.pid}`,
    `ARCHIVE=${shellQuote(updatePath)}`,
    `EXTRACTED=${shellQuote(extractedRoot)}`,
    `TARGET=${shellQuote(currentAppPath)}`,
    'while kill -0 "$CURRENT_PID" 2>/dev/null; do sleep 1; done',
    '/usr/bin/ditto -x -k "$ARCHIVE" "$EXTRACTED"',
    'SOURCE="$(/usr/bin/find "$EXTRACTED" -maxdepth 1 -type d -name \'*.app\' -print -quit)"',
    'test -n "$SOURCE"',
    '/usr/bin/codesign --verify --deep --strict "$SOURCE"',
    `/usr/bin/osascript -e ${shellQuote(appleScript)}`,
    '/usr/bin/open "$TARGET"',
    '/bin/rm -rf "$EXTRACTED" "$ARCHIVE" "$0"'
  ].join('\n');
  fs.writeFileSync(scriptPath, `${script}\n`, { mode: 0o700 });
  const child = spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' });
  child.once('spawn', () => setTimeout(() => app.quit(), 1200));
  child.unref();
}

function installLinuxUpdate(updatePath) {
  const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const currentAppImage = String(process.env.APPIMAGE || '').trim();
  if (!currentAppImage || !currentAppImage.endsWith('.AppImage')) {
    throw new Error('O painel precisa estar instalado pelo pacote Linux para receber a atualização');
  }
  const updateRoot = path.join(app.getPath('userData'), 'updates', `apply-${Date.now()}`);
  const scriptPath = path.join(updateRoot, 'install-update.sh');
  fs.mkdirSync(updateRoot, { recursive: true });
  fs.chmodSync(updatePath, 0o755);
  const script = [
    '#!/bin/sh',
    'set -eu',
    `CURRENT_PID=${process.pid}`,
    `SOURCE=${shellQuote(updatePath)}`,
    `TARGET=${shellQuote(currentAppImage)}`,
    'while kill -0 "$CURRENT_PID" 2>/dev/null; do sleep 1; done',
    'if test -w "$(dirname "$TARGET")"; then',
    '  /usr/bin/install -m 755 "$SOURCE" "$TARGET"',
    'elif command -v pkexec >/dev/null 2>&1; then',
    '  pkexec /usr/bin/install -m 755 "$SOURCE" "$TARGET"',
    'else',
    '  exit 13',
    'fi',
    'nohup "$TARGET" >/dev/null 2>&1 &',
    '/bin/rm -f "$SOURCE" "$0"'
  ].join('\n');
  fs.writeFileSync(scriptPath, `${script}\n`, { mode: 0o700 });
  const child = spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' });
  child.once('spawn', () => setTimeout(() => app.quit(), 1200));
  child.unref();
}

async function installUpdate(update) {
  if (updateInProgress) throw new Error('Uma atualização já está em andamento');
  updateInProgress = true;
  try {
    sendUpdateStatus('starting');
    if (process.platform === 'win32') {
      try {
        return await installWindowsOfficialUpdate(update);
      } catch (officialError) {
        sendUpdateStatus('fallback', {
          message: `Atualizador oficial indisponivel; usando modo de compatibilidade. ${officialError.message || ''}`.trim()
        });
      }
    }
    const installerPath = await downloadInstaller(update);
    sendUpdateStatus('installing');
    if (process.platform === 'darwin') {
      installMacUpdate(installerPath);
      return { ok: true };
    }
    if (process.platform === 'linux') {
      installLinuxUpdate(installerPath);
      return { ok: true };
    }
    await scheduleWindowsUpdate(installerPath);
    return { ok: true };
  } catch (error) {
    updateInProgress = false;
    sendUpdateStatus('error', { message: error.message });
    throw error;
  }
}

function scheduleWindowsUpdate(installerPath) {
  return new Promise((resolve, reject) => {
    const quotePowerShell = (value) => String(value).replaceAll("'", "''");
    const updatesDir = path.join(app.getPath('userData'), 'updates');
    const updaterLog = path.join(updatesDir, 'last-update.log');
    const updateScriptPath = path.join(updatesDir, 'install-update.ps1');
    const updateShortcutPath = path.join(updatesDir, 'install-update.lnk');
    const currentExecutable = process.execPath;
    fs.mkdirSync(updatesDir, { recursive: true });
    const script = [
      `$currentProcessId = ${process.pid}`,
      `$installerPath = '${quotePowerShell(installerPath)}'`,
      `$logPath = '${quotePowerShell(updaterLog)}'`,
      `$previousExecutable = '${quotePowerShell(currentExecutable)}'`,
      '$canonicalExecutable = Join-Path $env:LOCALAPPDATA "Programs\\Ninjaflix Painel\\Ninjaflix Painel.exe"',
      '$deadline = (Get-Date).AddMinutes(2)',
      '"Aguardando o painel encerrar..." | Set-Content -LiteralPath $logPath -Encoding UTF8',
      'while ((Get-Process -Id $currentProcessId -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 250 }',
      'if (Get-Process -Id $currentProcessId -ErrorAction SilentlyContinue) { "O painel não encerrou no prazo." | Add-Content -LiteralPath $logPath -Encoding UTF8; exit 20 }',
      '"Estabilizando o encerramento dos processos do painel..." | Add-Content -LiteralPath $logPath -Encoding UTF8',
      'for ($attempt = 0; $attempt -lt 12; $attempt++) { $remainingPanels = Get-Process -Name "Ninjaflix Painel" -ErrorAction SilentlyContinue; if ($remainingPanels) { $remainingPanels | Stop-Process -Force -ErrorAction SilentlyContinue }; $netstatLines = & (Join-Path $env:SystemRoot "System32\\netstat.exe") -ano -p tcp; foreach ($line in $netstatLines) { if ($line -match "^\\s*TCP\\s+127\\.0\\.0\\.1:3101\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$") { Stop-Process -Id ([int]$Matches[1]) -Force -ErrorAction SilentlyContinue } }; Start-Sleep -Milliseconds 250 }',
      '"Iniciando o instalador da atualização..." | Add-Content -LiteralPath $logPath -Encoding UTF8',
      '$installer = Start-Process -FilePath $installerPath -ArgumentList @("/S", "--force-run") -PassThru -WindowStyle Hidden',
      '$installer.WaitForExit()',
      'if ($installer.ExitCode -eq 0) { $nextExecutable = if (Test-Path -LiteralPath $canonicalExecutable) { $canonicalExecutable } else { $previousExecutable }; if (-not (Test-Path -LiteralPath $nextExecutable)) { "Executavel novo nao encontrado." | Add-Content -LiteralPath $logPath -Encoding UTF8; exit 21 }; Start-Sleep -Seconds 2; if (-not (Get-Process -Name "Ninjaflix Painel" -ErrorAction SilentlyContinue)) { Start-Process -FilePath $nextExecutable -ArgumentList @("--updated") -WindowStyle Normal }; "Painel atualizado: " + $nextExecutable | Add-Content -LiteralPath $logPath -Encoding UTF8 }',
      '"Instalador finalizado com código " + $installer.ExitCode | Add-Content -LiteralPath $logPath -Encoding UTF8',
      'exit $installer.ExitCode'
    ].join('\r\n');
    const powerShellExecutable = path.join(
      process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
    );
    const launchViaWindowsShell = async () => {
      fs.writeFileSync(updateScriptPath, `\uFEFF${script}\r\n`, 'utf8');
      fs.writeFileSync(updaterLog, 'Preparando a atualização pelo ShellExecute...\r\n', 'utf8');
      const shortcutCreated = shell.writeShortcutLink(updateShortcutPath, 'create', {
        target: powerShellExecutable,
        args: `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${updateScriptPath}"`,
        cwd: updatesDir,
        description: 'Atualizador do Ninjaflix Painel'
      });
      if (!shortcutCreated) throw new Error('Não foi possível criar o atalho auxiliar da atualização');
      const openPromise = shell.openPath(updateShortcutPath);
      sendUpdateStatus('installing', { official: true, shellExecute: true });
      resolve();
      openPromise.then((openError) => {
        if (openError) fs.appendFileSync(updaterLog, `Falha ao abrir o auxiliar: ${openError}\r\n`, 'utf8');
      }).catch((error) => {
        fs.appendFileSync(updaterLog, `Falha no ShellExecute: ${error.message}\r\n`, 'utf8');
      });
      setTimeout(() => app.exit(0), 1000);
    };
    launchViaWindowsShell().catch(reject);
  });
}

function ensureRuntimeFiles() {
  const home = app.getPath('userData');
  const dataDir = path.join(home, 'data');
  const logsDir = path.join(home, 'logs');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const envPath = path.join(home, '.env');
  if (!fs.existsSync(envPath)) {
    const bundledEnv = path.join(process.resourcesPath || app.getAppPath(), 'app.asar.unpacked', '.env.example');
    const appEnv = path.join(app.getAppPath(), '.env.example');
    const fallback = [bundledEnv, appEnv].find((candidate) => fs.existsSync(candidate));
    if (fallback) {
      fs.copyFileSync(fallback, envPath);
    } else {
      fs.writeFileSync(envPath, [
        'AGENT_HOST=127.0.0.1',
        `AGENT_PORT=${AGENT_PORT}`,
        'PORTAL_URL=https://agente-admin.187.77.55.247.nip.io',
        `ADSPOWER_BASE_URL=${ADSPOWER_BASE_URL}`,
        'AGENT_TOKEN=',
        'ADSPOWER_PROFILES_CACHE_TTL_MS=30000',
        ''
      ].join('\n'));
    }
  }

  const envContents = fs.readFileSync(envPath, 'utf8');
  const forcedSettings = {
    ADSPOWER_BASE_URL,
    ADSPOWER_DISABLE_PASSWORD_FILLING,
    ADSPOWER_ENABLE_PASSWORD_SAVING
  };
  let forcedEnvContents = envContents;
  for (const [key, value] of Object.entries(forcedSettings)) {
    const linePattern = new RegExp(`^${key}=.*$`, 'm');
    forcedEnvContents = linePattern.test(forcedEnvContents)
      ? forcedEnvContents.replace(linePattern, `${key}=${value}`)
      : `${forcedEnvContents.replace(/\s*$/, '\n')}${key}=${value}\n`;
  }
  if (forcedEnvContents !== envContents) fs.writeFileSync(envPath, forcedEnvContents);

  process.env.NINJAFLIX_AGENT_HOME = home;
  process.env.AGENT_VERSION = APP_VERSION;
  process.env.AGENT_LOCAL_STATE_PATH = path.join(dataDir, 'local-agent-state.json');
  process.env.AGENT_HOST = process.env.AGENT_HOST || '127.0.0.1';
  process.env.AGENT_PORT = String(AGENT_PORT);
  process.env.ADSPOWER_BASE_URL = ADSPOWER_BASE_URL;
  process.env.ADSPOWER_DISABLE_PASSWORD_FILLING = ADSPOWER_DISABLE_PASSWORD_FILLING;
  process.env.ADSPOWER_ENABLE_PASSWORD_SAVING = ADSPOWER_ENABLE_PASSWORD_SAVING;
}

function checkExistingAgent() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${AGENT_PORT}/health`, { timeout: 1200 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 500) return resolve(false);
        try {
          const health = JSON.parse(body || '{}');
          resolve(health.version === APP_VERSION);
        } catch (_) {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function stopAgentOnPort() {
  const { spawnSync } = require('node:child_process');
  if (process.platform === 'win32') {
    const script = `$pids=(Get-NetTCPConnection -LocalPort ${AGENT_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); foreach($processId in $pids){ if($processId -and $processId -ne $PID){ Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue } }`;
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
  } else if (['darwin', 'linux'].includes(process.platform)) {
    const lsofPath = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
    const result = spawnSync(lsofPath, ['-nP', `-iTCP:${AGENT_PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    for (const pid of String(result.stdout || '').trim().split(/\s+/).filter((value) => /^\d+$/.test(value))) {
      if (Number(pid) !== process.pid) {
        try { process.kill(Number(pid), 'SIGTERM'); } catch (_) {}
      }
    }
  }
}

async function startAgent() {
  if (agentStarted) return;
  ensureRuntimeFiles();
  if (await checkExistingAgent()) {
    agentStarted = true;
    return;
  }
  stopAgentOnPort();
  agentStarted = true;
  require('../scripts/local-agent.js');
}

function revealMainWindow() {
  clearTimeout(splashFallbackTimer);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setSkipTaskbar(false);
    mainWindow.setPosition(0, 0, false);
    mainWindow.show();
    mainWindow.maximize();
    mainWindow.focus();
  }
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 530,
    height: 530,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  splashWindow.setIgnoreMouseEvents(true);
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashFallbackTimer = setTimeout(revealMainWindow, 30000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 820,
    minHeight: 640,
    show: true,
    x: -20000,
    y: -20000,
    skipTaskbar: true,
    useContentSize: true,
    title: `Ninjaflix Painel ${APP_VERSION}`,
    backgroundColor: '#03040b',
    icon: resolveAppIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      backgroundThrottling: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'shell.html'));
  mainWindow.on('restore', () => {
    if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('window-reactivated');
  });
}

ipcMain.handle('agent-url', () => AGENT_URL);
ipcMain.handle('app-version', () => APP_VERSION);
ipcMain.on('panel-content-ready', () => revealMainWindow());
ipcMain.handle('install-update', (_event, update) => installUpdate(update));
ipcMain.handle('show-notification', (_event, payload = {}) => {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({ title: 'Ninjaflix', body: String(payload.body || payload.message || payload.title || '') });
  notification.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  notification.show();
  return true;
});

ipcMain.handle('open-external-browser', async (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
  }
});

function requestAdsPowerStartup() {
  try {
    const payload = JSON.stringify({});
    const request = http.request(new URL('/admin/adspower/start', AGENT_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, () => {
      request.destroy();
    });

    request.on('error', () => {});
    request.write(payload);
    request.end();
  } catch (_error) {
    // Intencional: falha de trigger do bootstrap não deve bloquear a UI.
  }
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      setImmediate(() => contents.loadURL(url));
    }
    return { action: 'deny' };
  });
});

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    migrateLegacyRuntimeState();
    configureOfficialUpdater();
    createSplashWindow();
    await startAgent();
    createWindow();
  });
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createSplashWindow();
    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
