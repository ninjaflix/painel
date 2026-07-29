const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const AGENT_PORT = Number(process.env.AGENT_PORT || 3101);
const AGENT_URL = `http://127.0.0.1:${AGENT_PORT}/`;
const APP_VERSION = process.env.AGENT_VERSION || '1.1.22';
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
let agentStarted = false;
let updateInProgress = false;

function sendUpdateStatus(status, details = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', { status, ...details });
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
    const expectedExtension = process.platform === 'darwin' ? '.zip' : '.exe';
    const publishedName = path.basename(String(update.fileName || update.filename || update.originalFileName || ''));
    if (publishedName && path.extname(publishedName).toLowerCase() !== expectedExtension) {
      return reject(new Error(`Formato de atualização incompatível com ${process.platform}`));
    }
    const finalPath = path.join(
      updatesDir,
      process.platform === 'darwin'
        ? `NinjaFlixPainelUpdate-${update.version}-${process.arch}.zip`
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

async function installUpdate(update) {
  if (updateInProgress) throw new Error('Uma atualização já está em andamento');
  updateInProgress = true;
  try {
    sendUpdateStatus('starting');
    const installerPath = await downloadInstaller(update);
    sendUpdateStatus('installing');
    if (process.platform === 'darwin') {
      installMacUpdate(installerPath);
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
    const updaterLog = path.join(app.getPath('userData'), 'updates', 'last-update.log');
    const script = [
      `$currentProcessId = ${process.pid}`,
      `$installerPath = '${quotePowerShell(installerPath)}'`,
      `$logPath = '${quotePowerShell(updaterLog)}'`,
      '$deadline = (Get-Date).AddMinutes(2)',
      '"Aguardando o painel encerrar..." | Set-Content -LiteralPath $logPath -Encoding UTF8',
      'while ((Get-Process -Id $currentProcessId -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 250 }',
      'if (Get-Process -Id $currentProcessId -ErrorAction SilentlyContinue) { "O painel não encerrou no prazo." | Add-Content -LiteralPath $logPath -Encoding UTF8; exit 20 }',
      '"Iniciando o instalador da atualização..." | Add-Content -LiteralPath $logPath -Encoding UTF8',
      '$installer = Start-Process -FilePath $installerPath -ArgumentList @("/S", "--updated", "--force-run") -PassThru -WindowStyle Hidden',
      '$installer.WaitForExit()',
      '"Instalador finalizado com código " + $installer.ExitCode | Add-Content -LiteralPath $logPath -Encoding UTF8',
      'exit $installer.ExitCode'
    ].join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const helper = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    helper.once('error', reject);
    helper.once('spawn', () => {
      helper.unref();
      resolve();
      setTimeout(() => app.quit(), 500);
    });
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
  } else if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${AGENT_PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 820,
    minHeight: 640,
    useContentSize: true,
    title: `Ninjaflix Painel ${APP_VERSION}`,
    backgroundColor: '#03040b',
    icon: resolveAppIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'shell.html'));
  mainWindow.maximize();
  mainWindow.on('restore', () => {
    if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('window-reactivated');
  });
}

ipcMain.handle('agent-url', () => AGENT_URL);
ipcMain.handle('app-version', () => APP_VERSION);
ipcMain.handle('install-update', (_event, update) => installUpdate(update));

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

app.whenReady().then(async () => {
  await startAgent();
  requestAdsPowerStartup();
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
