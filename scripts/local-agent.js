const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { URL } = require('node:url');
const { Readable } = require('node:stream');
const WebSocket = require('ws');

const config = require('../src/config');
const {
  setAdspowerApiKey,
  openConfiguredProfile,
  closeConfiguredProfile,
  getBrowserStatus,
  listAdspowerGroups,
  listAdspowerProfiles
} = require('../src/adspower');

const HOST = process.env.AGENT_HOST || '127.0.0.1';
const PORT = Number(process.env.AGENT_PORT || 3101);
const APP_VERSION = process.env.AGENT_VERSION || process.env.npm_package_version || '2.0.1';
const ADSPOWER_API_PORT = '50326';
function normalizePortalUrl(value) {
  const raw = String(value || `http://127.0.0.1:${config.port}`).replace(/\/$/, '');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' && parsed.hostname === 'agente-admin.187.77.55.247.nip.io') {
      parsed.protocol = 'https:';
      parsed.port = '';
      return parsed.toString().replace(/\/$/, '');
    }
  } catch {
    return raw;
  }
  return raw;
}

const PORTAL_URL = normalizePortalUrl(process.env.PORTAL_URL);
const LOCAL_STATE_PATH = process.env.AGENT_LOCAL_STATE_PATH || path.join(__dirname, '..', 'data', 'local-agent-state.json');

function loadLocalState() {
  try {
    if (!fs.existsSync(LOCAL_STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(LOCAL_STATE_PATH, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function saveLocalState(patch = {}) {
  const current = loadLocalState();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(LOCAL_STATE_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_STATE_PATH, JSON.stringify(next, null, 2));
  return next;
}

function clearLocalState() {
  try {
    if (fs.existsSync(LOCAL_STATE_PATH)) fs.unlinkSync(LOCAL_STATE_PATH);
  } catch {
    // Ignora falhas de limpeza local para nao travar logout.
  }
}

const persistedLocalState = loadLocalState();

const state = {
  agentToken: process.env.AGENT_TOKEN || '',
  user: persistedLocalState.user || null,
  rememberedEmail: persistedLocalState.email || (String(persistedLocalState.document || '').includes('@') ? String(persistedLocalState.document).trim().toLowerCase() : null),
  machine: buildMachineInfo(),
  currentProfileSession: persistedLocalState.currentProfileSession || null,
  openProfiles: new Map(
    (Array.isArray(persistedLocalState.openProfiles) ? persistedLocalState.openProfiles : [])
      .filter((entry) => entry && entry.profileId)
      .map((entry) => [String(entry.profileId), entry])
  ),
  profileStatusCache: new Map(),
  profileRotationIndexes: persistedLocalState.profileRotationIndexes && typeof persistedLocalState.profileRotationIndexes === 'object'
    ? persistedLocalState.profileRotationIndexes
    : {},
  seenKernelVersions: persistedLocalState.seenKernelVersions || {},
  eventClients: new Set(),
  extensionSessions: new Map(),
  adspowerApiKey: '',
  cachedProfiles: persistedLocalState.cachedProfiles && typeof persistedLocalState.cachedProfiles === 'object'
    ? persistedLocalState.cachedProfiles
    : null
};

const ADSPOWER_PROFILES_CACHE_TTL_MS = Number(process.env.ADSPOWER_PROFILES_CACHE_TTL_MS || 30000);
const DASHBOARD_PROFILES_CACHE_TTL_MS = Number(process.env.DASHBOARD_PROFILES_CACHE_TTL_MS || 60000);
const DASHBOARD_PROFILES_MAX_STALE_MS = Number(process.env.DASHBOARD_PROFILES_MAX_STALE_MS || 24 * 60 * 60 * 1000);
const PORTAL_REQUEST_TIMEOUT_MS = Number(process.env.PORTAL_REQUEST_TIMEOUT_MS || 8000);
const HEARTBEAT_CACHE_TTL_MS = Number(process.env.HEARTBEAT_CACHE_TTL_MS || 30000);
const ADSPOWER_BOOTSTRAP_TIMEOUT_MS = Number(process.env.ADSPOWER_BOOTSTRAP_TIMEOUT_MS || 35000);
let adspowerProfilesCache = { expiresAt: 0, payload: null };
let adspowerProfilesInFlight = null;
let dashboardProfilesRefreshInFlight = null;
let heartbeatCache = { checkedAt: 0, payload: null };
let heartbeatInFlight = null;
let machineAuthInFlight = null;
let catalogEventStreamController = null;
let catalogEventStreamRunning = false;
let catalogRefreshTimer = null;
let adspowerLaunchInFlight = null;
let profileStatusMonitorTimer = null;
const DEFAULT_EXPECTED_ADSPOWER_KERNEL = 150;
const PROFILE_STATUS_MONITOR_MS = Number(process.env.PROFILE_STATUS_MONITOR_MS || 5000);
let adspowerBootstrapState = {
  status: 'idle',
  phase: 'idle',
  message: 'AdsPower não inicializado.',
  executable: '',
  processRunning: false,
  api: null,
  needsApiKey: false,
  terminal: false,
  startedAt: null,
  updatedAt: null,
  error: null
};

function persistProfileAccessState() {
  saveLocalState({
    currentProfileSession: state.currentProfileSession,
    openProfiles: Array.from(state.openProfiles.values()),
    profileRotationIndexes: state.profileRotationIndexes
  });
}

function bootstrapStatusValue(status) {
  const values = {
    idle: false,
    queued: false,
    starting: false,
    starting_api: false,
    running: true,
    online: true,
    requires_api_key: false,
    not_found: false,
    failed: false
  };
  return Object.prototype.hasOwnProperty.call(values, status)
    ? values[status]
    : false;
}

function nowIsoDate() {
  return new Date().toISOString();
}

function getBootstrapState() {
  return {
    ok: bootstrapStatusValue(adspowerBootstrapState.status),
    inProgress: Boolean(adspowerLaunchInFlight),
    status: adspowerBootstrapState.status,
    phase: adspowerBootstrapState.phase,
    startedAt: adspowerBootstrapState.startedAt,
    updatedAt: adspowerBootstrapState.updatedAt,
    message: adspowerBootstrapState.message,
    executable: adspowerBootstrapState.executable,
    processRunning: adspowerBootstrapState.processRunning,
    needsApiKey: adspowerBootstrapState.needsApiKey,
    terminal: adspowerBootstrapState.terminal,
    api: adspowerBootstrapState.api,
    error: adspowerBootstrapState.error
  };
}

function setBootstrapState(next = {}) {
  adspowerBootstrapState = {
    ...adspowerBootstrapState,
    ...next,
    updatedAt: nowIsoDate()
  };
  return getBootstrapState();
}

function withDefaultBootstrapState() {
  if (!adspowerBootstrapState.updatedAt) {
    setBootstrapState({
      status: 'idle',
      phase: 'idle',
      message: 'AdsPower pronto para verificação.',
      needsApiKey: false,
      terminal: false,
      error: null
    });
  }
}

function setBootstrapFailure(message, details = {}) {
  return setBootstrapState({
    status: details.status || 'failed',
    phase: details.phase || 'failed',
    executable: details.executable || adspowerBootstrapState.executable,
    processRunning: Boolean(details.processRunning || false),
    needsApiKey: Boolean(details.needsApiKey || false),
    terminal: Boolean(details.terminal || false),
    api: details.api || null,
    message: message || 'Falha ao inicializar o AdsPower.',
    error: {
      code: details.code || null,
      message: message || 'Falha ao inicializar o AdsPower.',
      details
    },
    startedAt: details.startedAt || adspowerBootstrapState.startedAt
  });
}

function setBootstrapStateFromApiResult(apiResult = {}, startedAt = null, exePath = '') {
  if (!apiResult || typeof apiResult !== 'object') return getBootstrapState();

  if (apiResult.ok) {
    if (apiResult.needsApiKey) {
      return setBootstrapState({
        status: 'requires_api_key',
        phase: apiResult.phase || 'requires_api_key',
        message: apiResult.message || 'A conexão com o AdsPower precisa de atenção. Tente novamente em instantes.',
        executable: exePath || adspowerBootstrapState.executable,
        processRunning: true,
        api: apiResult.payload
          ? {
              endpoint: apiResult.endpoint,
              status: apiResult.status,
              payload: apiResult.payload
            }
          : {
              endpoint: apiResult.endpoint,
              status: apiResult.status,
              payload: apiResult.payload || null
            },
        needsApiKey: true,
        terminal: false,
        error: null,
        startedAt: startedAt || adspowerBootstrapState.startedAt
      });
    }

    return setBootstrapState({
      status: 'online',
      phase: apiResult.phase || 'online',
      message: apiResult.message || 'AdsPower pronto para uso.',
      executable: exePath || adspowerBootstrapState.executable,
      processRunning: true,
      api: apiResult.payload
        ? {
            endpoint: apiResult.endpoint,
            status: apiResult.status,
            payload: apiResult.payload
          }
        : {
            endpoint: apiResult.endpoint,
            status: apiResult.status,
            payload: apiResult.payload || null
          },
      needsApiKey: false,
      terminal: false,
      error: null,
      startedAt: startedAt || adspowerBootstrapState.startedAt
    });
  }

  return setBootstrapFailure(apiResult.message || 'Não foi possível conectar ao AdsPower. Aguarde e tente novamente.', {
    status: 'failed',
    phase: apiResult.phase || 'api_unavailable',
    executable: exePath || adspowerBootstrapState.executable,
    processRunning: true,
    api: apiResult.payload ? { endpoint: apiResult.endpoint, status: apiResult.status, payload: apiResult.payload } : null,
    code: apiResult.status,
    terminal: Boolean(apiResult.terminal),
    startedAt: startedAt || adspowerBootstrapState.startedAt
  });
}

function classifyAdspowerApiResponse(payload) {
  const status = Number(payload?.status || 0);
  const code = Number(payload?.code || (payload && payload.body && payload.body.code) || 0);
  const message = String(payload?.message || payload?.msg || (payload && payload.body && (payload.body.msg || payload.body.message)) || '').toLowerCase();
  const needsApiKey = (status === 401 || status === 403 || code === -1) && /api[-_ ]?key|token|auth|assinatura/i.test(message);
  const isAuthEndpoint = /api[/]v1[/]user[/]list|api[/]v1[/]group[/]list/.test(String(payload?.endpoint || ''));

  return {
    needsApiKey,
    code,
    status,
    isAuthEndpoint,
    message
  };
}

const AGENT_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ninjaflix Painel ${APP_VERSION}</title>
  <style>
    :root{color-scheme:dark;--background:#03040b;--card:#151527;--secondary:#202036;--border:#2c2d43;--foreground:#f8fafc;--muted-foreground:#a8a8bb;--primary:#a855f7;--success:#59e39a;--warning:#facc15;--destructive:#fb7185;--info:#38bdf8;--gradient-brand:linear-gradient(135deg,#c084fc 0%,#8b5cf6 52%,#7c3aed 100%);--gradient-surface:linear-gradient(135deg,rgba(34,34,55,.95) 0%,rgba(18,18,32,.96) 100%);--shadow-glow:0 0 34px rgba(168,85,247,.35);--shadow-card:0 24px 80px rgba(0,0,0,.38)}*{box-sizing:border-box}body{margin:0;font-family:Arial,Helvetica,sans-serif;background:var(--background);color:var(--foreground);font-size:14px}button,input{border-radius:11px;border:1px solid var(--border);padding:10px 13px;background:var(--background);color:var(--foreground);font:inherit;font-size:13px}button{cursor:pointer;font-weight:900;transition:transform .18s ease,background .18s ease,border-color .18s ease}button:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--primary) 45%,var(--border))}button:disabled{opacity:.55;cursor:not-allowed;transform:none}.shell{position:relative;z-index:1;width:min(1120px,calc(100% - 48px));margin:0 auto;padding:22px 0 28px}.agent-top{position:sticky;top:12px;z-index:20;width:min(1120px,calc(100% - 48px));margin:0 auto;padding-top:12px}.agent-frame{border:1px solid var(--border);border-radius:22px;background:color-mix(in srgb,var(--card) 66%,transparent);box-shadow:var(--shadow-card);backdrop-filter:blur(12px);overflow:visible}.top-line{display:flex;align-items:center;gap:14px;padding:18px 14px;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--secondary) 30%,transparent)}.brand{display:flex;align-items:center;gap:12px;min-width:245px}.logo{width:36px;height:36px;border-radius:13px;background:transparent;display:grid;place-items:center;font-size:18px;font-weight:900;box-shadow:none;overflow:hidden}.logo img{width:32px;height:32px;display:block;object-fit:contain}.brand-title{font-size:17px;font-weight:900;line-height:1.05}.brand-sub{font-size:13px;margin-top:2px}.muted{color:var(--muted-foreground)}.chips{display:flex;align-items:center;gap:8px;flex:1;flex-wrap:wrap}.chip{display:flex;align-items:center;gap:7px;border:1px solid var(--border);background:color-mix(in srgb,var(--background) 62%,transparent);border-radius:13px;padding:8px 10px;color:var(--muted-foreground);white-space:nowrap;font-size:13px}.chip strong{color:var(--foreground)}.chip.ok{border-color:color-mix(in srgb,var(--success) 40%,var(--border));background:rgba(89,227,154,.10);color:var(--success);font-weight:900;text-transform:uppercase;letter-spacing:.04em}.chip.online{border-color:color-mix(in srgb,var(--success) 40%,var(--border));background:rgba(89,227,154,.10);color:var(--success);font-weight:900}.chip.warn{border-color:color-mix(in srgb,var(--warning) 55%,var(--border));background:rgba(250,204,21,.10);color:var(--warning);font-weight:900}.chip.offline{border-color:color-mix(in srgb,var(--destructive) 55%,var(--border));background:rgba(251,113,133,.10);color:var(--destructive);font-weight:900}.chip.icon{width:36px;height:36px;justify-content:center;padding:0;border-radius:12px}.support{background:color-mix(in srgb,var(--card) 72%,transparent);color:var(--foreground)}.top-actions{margin-left:auto;display:flex;align-items:center;gap:8px}.top-icon,.profile-button{width:36px;height:36px;padding:0;display:grid;place-items:center;border-radius:12px;background:color-mix(in srgb,var(--card) 72%,transparent);border:1px solid var(--border)}.top-support{height:36px;padding:0 12px;border-radius:12px;background:color-mix(in srgb,var(--card) 72%,transparent);border:1px solid var(--border);white-space:nowrap}.profile-wrap{position:relative}.profile-dropdown{position:absolute;right:0;top:44px;width:260px;border:1px solid var(--border);border-radius:16px;background:var(--card);box-shadow:var(--shadow-card);padding:12px;z-index:40}.profile-head{display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--border);margin-bottom:10px}.profile-head strong{display:block;font-size:14px}.profile-head small{display:block;margin-top:3px;color:var(--muted-foreground);font-size:12px;overflow-wrap:anywhere}.profile-avatar{width:36px;height:36px;border-radius:13px;display:grid;place-items:center;background:rgba(168,85,247,.14);color:#c084fc}.profile-row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;color:var(--muted-foreground);font-size:12px}.profile-row strong{color:var(--foreground);text-align:right}.profile-logout{width:100%;margin-top:8px}.main-menu{position:sticky;top:12px;z-index:5;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:10px;border-top:0;background:linear-gradient(135deg,rgba(168,85,247,.22),rgba(14,165,233,.14))}.main-menu button{display:flex;align-items:center;justify-content:center;gap:8px;min-height:42px;border-radius:15px;border:1px solid rgba(255,255,255,.08);color:var(--foreground);background:rgba(3,4,11,.42);font-size:13px;text-transform:uppercase;letter-spacing:.06em}.main-menu button.active,.main-menu button:hover{border-color:rgba(255,255,255,.24);background-image:var(--gradient-brand);box-shadow:var(--shadow-glow)}.hero{display:grid;grid-template-columns:1.25fr .75fr;gap:14px;margin-bottom:14px}.card{overflow:hidden;border:1px solid var(--border);border-radius:22px;background:var(--card);box-shadow:var(--shadow-card);padding:18px}.row{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.card h1{margin:0;font-size:26px;line-height:1.05;letter-spacing:-.035em}.card h2{margin:0 0 5px;font-size:19px}.card p{font-size:13px;line-height:1.45}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}.kpi{border:1px solid var(--border);border-radius:16px;background:color-mix(in srgb,var(--background) 50%,transparent);padding:13px}.kpi small{display:block;color:var(--muted-foreground);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.11em}.kpi strong{display:block;margin-top:5px;font-size:15px}.badge{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border);border-radius:999px;padding:7px 10px;font-size:12px;font-weight:900}.dot,.badge .dot,.chip .dot{width:8px;height:8px;border-radius:999px;background:currentColor}.online{color:var(--success);border-color:color-mix(in srgb,var(--success) 40%,var(--border));background:rgba(89,227,154,.10)}.offline{color:var(--destructive);border-color:color-mix(in srgb,var(--destructive) 50%,var(--border));background:rgba(251,113,133,.10)}.warn{color:var(--warning);border-color:color-mix(in srgb,var(--warning) 50%,var(--border));background:rgba(250,204,21,.10)}.ok{color:var(--success);border-color:color-mix(in srgb,var(--success) 40%,var(--border));background:rgba(89,227,154,.10)}.layout{display:grid;grid-template-columns:230px 1fr;gap:14px}.sidebar{border-right:1px solid var(--border);padding-right:12px}.cat{width:100%;display:flex;justify-content:space-between;background:color-mix(in srgb,var(--background) 50%,transparent);border-color:var(--border);color:var(--foreground);margin-bottom:9px}.cat.active{border-color:color-mix(in srgb,var(--primary) 55%,var(--border));background:rgba(168,85,247,.14)}.profile-card{display:grid;grid-template-columns:46px 1fr auto;gap:12px;align-items:center;padding:14px;border:1px solid var(--border);border-radius:16px;background:color-mix(in srgb,var(--background) 50%,transparent);margin-bottom:10px}.profile-card:hover{border-color:color-mix(in srgb,var(--primary) 40%,var(--border))}.tool-icon{width:46px;height:46px;border-radius:15px;background:color-mix(in srgb,var(--primary) 15%,transparent);color:#c084fc;display:grid;place-items:center;font-weight:900;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--primary) 20%,transparent)}.tool-title{font-size:16px;font-weight:900}.tool-meta small{display:block;margin-top:4px;font-size:12px}.actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.success{background:rgba(89,227,154,.10);border-color:color-mix(in srgb,var(--success) 45%,var(--border));color:#bbf7d0}.secondary{background:rgba(168,85,247,.12);border-color:color-mix(in srgb,var(--primary) 40%,var(--border));color:var(--foreground)}.danger{background:rgba(251,113,133,.10);border-color:color-mix(in srgb,var(--destructive) 45%,var(--border));color:#fecaca}.empty{border:1px dashed var(--border);border-radius:16px;padding:20px;color:var(--muted-foreground);text-align:center}pre{white-space:pre-wrap;background:color-mix(in srgb,var(--background) 80%,black);border:1px solid var(--border);border-radius:16px;padding:12px;max-height:240px;overflow:auto;font-size:12px}.hidden{display:none!important}.spinner{display:inline-block;width:13px;height:13px;border:2px solid #ffffff55;border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:980px){.agent-top,.shell{width:min(100% - 28px,1120px)}.top-line{align-items:flex-start;flex-direction:column}.brand{min-width:auto}.hero,.layout{grid-template-columns:1fr}.grid{grid-template-columns:1fr}.sidebar{border-right:0;padding-right:0}.profile-card{grid-template-columns:1fr}.actions{justify-content:flex-start}.main-menu{grid-template-columns:repeat(2,minmax(0,1fr))}}
.top-line{align-items:flex-start}.top-info{display:grid;gap:6px;align-self:center}.info-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.status-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.status-tag{position:relative;display:inline-flex;align-items:center;gap:5px;width:fit-content;min-height:20px;border:1px solid currentColor;border-radius:999px;padding:4px 7px;font-size:9px;line-height:1.15;font-weight:400;text-transform:lowercase;letter-spacing:.01em;white-space:nowrap;outline:0}.status-tag .dot{width:7px;height:7px;flex:0 0 auto}.status-tag::after{content:attr(data-detail);position:absolute;left:50%;top:calc(100% + 10px);transform:translateX(-50%) translateY(-4px);min-width:220px;max-width:320px;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:#101124;color:var(--foreground);box-shadow:0 18px 45px rgba(0,0,0,.48);font-size:11px;line-height:1.35;text-transform:none;white-space:normal;opacity:0;pointer-events:none;transition:.16s;z-index:80}.status-tag:hover::after,.status-tag:focus::after,.status-tag.show-tip::after{opacity:1;transform:translateX(-50%) translateY(0)}.top-actions{align-self:flex-start;margin-left:auto}.top-icon,.profile-button{width:34px;height:34px}.notice-wrap .top-icon,.profile-button{border:0!important;background:transparent!important;box-shadow:none!important}.top-support{height:34px;font-size:12px}.notice-dropdown.auto-open{display:block!important}.agent-popup .agent-modal{max-width:430px}.agent-popup .popup-level{width:fit-content;margin-bottom:10px;border:1px solid var(--primary);border-radius:999px;padding:4px 9px;color:#c084fc;font-size:10px;text-transform:uppercase;letter-spacing:.08em}.popup-cta{display:inline-flex;margin-top:12px;text-decoration:none;border:1px solid var(--primary);border-radius:12px;padding:10px 14px;background:var(--gradient-brand);color:#fff;font-weight:900;font-size:12px}@media(max-width:980px){.top-info{width:100%}.top-actions{position:absolute;right:12px;top:10px}.brand{padding-right:150px}}
.tools-shell{display:grid;grid-template-columns:220px 1fr;gap:18px}.tools-sidebar-wrap{position:sticky;top:150px;align-self:start;padding-top:10px}.tools-sidebar{border:1px solid var(--border);border-radius:22px;background:var(--card);box-shadow:var(--shadow-card);padding:14px}.sidebar-title{color:var(--muted-foreground);font-size:11px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;margin:0 0 12px 8px}.tools-content{min-width:0}.tools-toolbar{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin:28px 0 28px}.tools-toolbar h1{margin:0;font-size:34px;line-height:1.05;letter-spacing:-.05em}.tools-toolbar p{margin:8px 0 0}.tools-actions{display:flex;gap:10px;align-items:center}.tool-search{min-width:310px;border-radius:18px;background:var(--card);padding:14px 18px}.featured-label{margin:0 0 12px;color:#c084fc;font-size:13px;font-weight:900;text-transform:uppercase;letter-spacing:.14em}.tool-section{margin:0 0 24px}.tool-section-title{margin:0 0 12px;color:#c084fc;font-size:13px;font-weight:900;text-transform:uppercase;letter-spacing:.14em}.section-title-tools{margin:0 0 18px;font-size:22px}.tools-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.tools-grid .profile-card{display:grid;grid-template-columns:70px 1fr;gap:14px;min-height:186px;align-content:start}.tools-grid .tool-icon{width:32px!important;height:32px!important;border-radius:15px!important;font-size:15px!important;align-self:start}.tools-grid .tool-title{font-size:14px;line-height:1.18;font-weight:700;margin-top:10px}.tool-meta{min-width:0}.profile-state{display:inline-flex;align-items:center;gap:6px;margin-top:14px;border:1px solid currentColor;border-radius:999px;padding:5px 9px;font-size:10px;line-height:1;font-weight:400;text-transform:lowercase;letter-spacing:.01em;opacity:.9}.profile-state.open{color:var(--success);background:rgba(89,227,154,.08)}.profile-state.closed{color:var(--muted-foreground);background:rgba(168,168,187,.07)}.profile-state.busy{color:var(--warning);background:rgba(250,204,21,.09)}.profile-state .dot{width:6px;height:6px}.link-open,.link-close{padding:0;margin-top:16px;border:0;background:transparent;color:#a855f7;font-weight:900}.link-close{color:#fb7185}.profile-actions{grid-column:1/-1;display:flex;gap:18px;align-items:center;justify-content:flex-start;margin-top:4px}.profile-actions button{font-size:13px}.status-tag{font-weight:400;font-size:10px;padding:4px 8px;min-height:20px}.status-row{gap:5px}@media(max-width:1100px){.tools-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:980px){.tools-shell{grid-template-columns:1fr}.tools-sidebar{position:static}.tools-toolbar{flex-direction:column}.tool-search{min-width:0;width:100%}.tools-grid{grid-template-columns:1fr}}.modal-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px;background:rgba(3,4,11,.72);backdrop-filter:blur(10px)}.modal-backdrop.hidden{display:none}.agent-modal{width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;border:1px solid var(--border);border-radius:24px;background:var(--gradient-surface);box-shadow:0 30px 100px rgba(0,0,0,.62);padding:20px}.modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}.modal-head h2{margin:0;font-size:24px;letter-spacing:-.04em}.modal-close{width:34px;height:34px;padding:0}.notice-list{display:grid;gap:12px}.notice-item{border:1px solid var(--border);border-radius:18px;background:rgba(255,255,255,.04);padding:14px}.notice-item strong{display:block;font-size:15px;margin-bottom:6px}.notice-item p{margin:0;color:var(--muted-foreground);line-height:1.45}.notice-item small{display:block;margin-top:10px;color:var(--muted-foreground)}.support-hours{display:grid;gap:10px;margin:14px 0;padding:14px;border:1px solid var(--border);border-radius:18px;background:rgba(255,255,255,.04)}.support-form{display:grid;gap:10px}.support-form input,.support-form textarea{width:100%;border:1px solid var(--border);border-radius:14px;background:rgba(2,6,23,.55);color:var(--foreground);padding:12px}.support-form button{border-color:#a855f7;background:#a855f7;color:#fff}.support-ticket-item{border:1px solid var(--border);border-radius:16px;background:rgba(255,255,255,.04);padding:12px}.support-ticket-item .support-message{margin-top:8px;padding:9px;border-radius:12px;background:rgba(168,85,247,.10)}.whatsapp-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;border-radius:16px;border:1px solid rgba(89,227,154,.45);background:linear-gradient(135deg,#22c55e,#16a34a);color:#04130a;text-decoration:none;font-weight:900;padding:13px 16px}.profile-dropdown{position:absolute;right:0;top:calc(100% + 10px);z-index:1100}.top-actions{display:flex;align-items:flex-start;gap:8px}.top-support{order:1;display:inline-flex;align-items:center;gap:7px;height:36px;border-radius:999px;border-color:rgba(168,85,247,.34);background:rgba(168,85,247,.10);color:#ddd6fe;font-weight:800;padding:8px 12px}.top-icon{order:2;display:grid;place-items:center;border-radius:999px;border-color:rgba(168,85,247,.42);background:rgba(168,85,247,.12);color:#c084fc;font-size:0}.top-icon::before{content:'';font-size:13px;line-height:1;color:#c084fc;text-shadow:0 0 18px rgba(168,85,247,.45)}.profile-wrap{order:3;position:relative}.profile-button{display:grid;place-items:center;border-radius:999px;border-color:rgba(192,132,252,.52);background:linear-gradient(135deg,rgba(168,85,247,.24),rgba(124,58,237,.16));box-shadow:0 0 0 1px rgba(255,255,255,.04),0 0 24px rgba(168,85,247,.22);font-size:0}.profile-button::before{content:'';font-size:16px;filter:drop-shadow(0 0 10px rgba(255,255,255,.28))}.profile-actions{align-items:center}.action-pill{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;border-radius:999px;padding:10px 14px;border:1px solid rgba(168,85,247,.36);background:rgba(168,85,247,.10);font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.03em}.action-pill.open{color:#1b1024;background:#d380ff!important;border-color:#d380ff!important;box-shadow:0 12px 28px rgba(211,128,255,.28)}.action-pill.close{color:#fecdd3;border-color:rgba(251,113,133,.42);background:rgba(251,113,133,.10)}.action-pill:disabled{opacity:.55}.plan-name{color:#f5f3ff}.plan-name.design{color:#c084fc}.plan-name.avatar{color:#38bdf8}.plan-name.seo{color:#59e39a}.plan-name.ultra{color:#facc15}.tools-grid{gap:18px}.tools-grid .profile-card{position:relative;grid-template-columns:72px 1fr;min-height:238px;padding:24px;border-radius:24px;border:1px solid rgba(148,163,184,.18);background:#0b0d19;box-shadow:none;overflow:hidden}.tools-grid .profile-card::before{content:'';position:absolute;inset:0;border-radius:24px;border:1px solid transparent;background:linear-gradient(135deg,rgba(168,85,247,.48),rgba(148,163,184,.12)) border-box;mask:linear-gradient(#000 0 0) padding-box,linear-gradient(#000 0 0);mask-composite:exclude;opacity:.6;pointer-events:none}.tools-grid .profile-card:hover{border-color:rgba(168,85,247,.42);transform:translateY(-2px);transition:.18s ease}.tools-grid .tool-icon{width:66px;height:66px;border-radius:22px;background:linear-gradient(135deg,#8b5cf6,#2563eb);font-size:30px;box-shadow:none}.tool-badge{position:absolute;right:18px;top:18px;display:inline-flex;align-items:center;min-height:28px;border:1px solid rgba(168,85,247,.24);border-radius:999px;padding:6px 13px;background:rgba(15,23,42,.62);color:#c4b5fd;font-size:12px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}.tool-badge.open{color:#86efac;border-color:rgba(134,239,172,.28)}.tool-badge.busy{color:#fde68a;border-color:rgba(253,230,138,.3)}.tool-badge.closed{color:#c4b5fd}.tools-grid .tool-title{font-size:22px;margin-top:82px;grid-column:1/-1}.tools-grid .tool-meta{display:contents}.tools-grid .tool-meta small{grid-column:1/-1;font-size:16px;line-height:1.35;color:#a8a8bb}.profile-state{display:none}.profile-actions{grid-column:1/-1;margin-top:10px;gap:8px}.action-pill{min-height:0;padding:0;border:0;background:transparent;box-shadow:none;text-transform:none;letter-spacing:0;font-size:15px;color:#a855f7}.action-pill.open{background:transparent;color:#a855f7;box-shadow:none}.action-pill.close{font-size:11px;padding:5px 8px;border:1px solid rgba(251,113,133,.28);background:rgba(251,113,133,.07);color:#fb7185}.action-pill:hover{background:transparent;text-decoration:underline}.action-pill.close:hover{background:rgba(251,113,133,.12);text-decoration:none}.tools-grid .profile-card{min-height:205px!important;padding:18px!important;border-radius:22px!important}.tools-grid .tool-icon{width:54px!important;height:54px!important;border-radius:18px!important;font-size:24px!important}.tool-badge{right:14px!important;top:14px!important;min-height:24px!important;padding:5px 11px!important;font-size:11px!important}.tools-grid .tool-title{margin-top:58px!important;font-size:20px!important;line-height:1.18}.tools-grid .tool-meta small{font-size:14px!important}.profile-actions{margin-top:6px!important}.tools-sidebar{padding:12px!important}.cat{display:grid!important;grid-template-columns:28px minmax(0,1fr) auto!important;align-items:center!important;gap:10px!important;text-align:left!important;min-height:48px!important;padding:10px 12px!important;border-radius:15px!important}.cat span{display:contents!important}.cat span b{display:grid!important;place-items:center!important;width:28px!important;height:28px!important;font-size:18px!important;line-height:1!important;flex:0 0 auto!important}.cat span .cat-label{min-width:0!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;font-weight:800!important}.cat small{display:grid!important;place-items:center!important;min-width:26px!important;height:26px!important;border-radius:999px!important;background:rgba(148,163,184,.10)!important;margin-left:4px!important}.cat.active small{background:rgba(255,255,255,.18)!important}.sidebar-title{margin-left:12px!important}.tools-sidebar{width:260px!important;padding:10px!important}.tools-shell{grid-template-columns:260px 1fr!important}.cat{grid-template-columns:24px minmax(0,1fr) 30px!important;gap:8px!important;min-height:42px!important;padding:8px 10px!important}.cat span b{width:24px!important;height:24px!important;font-size:13px!important;font-weight:500!important}.cat span .cat-label{font-size:13px!important;font-weight:600!important;letter-spacing:0!important}.cat small{min-width:24px!important;height:24px!important;font-size:11px!important}.tools-grid .profile-card{min-height:188px!important;padding:14px!important}.tools-grid .tool-icon{width:46px!important;height:46px!important;border-radius:15px!important;font-size:20px!important}.tool-badge{right:12px!important;top:12px!important}.tools-grid .tool-title{margin-top:42px!important;font-size:18px!important;line-height:1.12!important}.tools-grid .tool-meta small{font-size:13px!important}.action-pill{font-size:13px!important}.action-pill.close{font-size:10px!important;padding:4px 7px!important}.notice-wrap{order:2;position:relative}.notice-dropdown{position:absolute;right:0;top:calc(100% + 10px);z-index:1100;width:min(380px,calc(100vw - 32px));max-height:420px;overflow:auto;border:1px solid var(--border);border-radius:18px;background:var(--gradient-surface);box-shadow:0 24px 80px rgba(0,0,0,.48);padding:12px}.notice-dropdown.hidden{display:none}.notice-dropdown .notice-item{padding:12px;border-radius:14px}.notice-dropdown-title{display:flex;align-items:center;justify-content:space-between;margin:0 0 10px;font-size:13px;color:#c084fc;text-transform:uppercase;letter-spacing:.08em}.top-icon{position:relative}.top-icon::before{content:'\\1F514'!important;font-size:15px!important}.top-icon.has-unread::after{content:'';position:absolute;right:6px;top:6px;width:8px;height:8px;border-radius:999px;background:#ef4444;box-shadow:0 0 0 2px #151527}.profile-button{color:#c084fc!important}.profile-button::before{color:#c084fc!important}.top-icon::before{content:''!important;width:17px;height:17px;background:#c084fc;display:block;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6v-5a7 7 0 0 0-5-6.71V3a2 2 0 1 0-4 0v1.29A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z'/%3E%3C/svg%3E") center/contain no-repeat}.profile-button::before{content:''!important;width:18px;height:18px;background:#c084fc;display:block;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-5 0-9 2.5-9 5.5V22h18v-2.5C21 16.5 17 14 12 14Z'/%3E%3C/svg%3E") center/contain no-repeat}.profile-avatar{color:#c084fc!important}
.tools-sidebar{width:100%;max-width:336px}.cat-button{width:100%;display:grid;grid-template-columns:28px 1fr auto;align-items:center;gap:12px;border:0;background:transparent;color:#a8a8bb;border-radius:14px;padding:12px 13px;margin:3px 0;font-size:16px;font-weight:700;text-align:left}.cat-button:hover{background:rgba(168,85,247,.10);color:#f8fafc;transform:none}.cat-button.active{background:linear-gradient(135deg,#c084fc,#8b5cf6);color:#fff;box-shadow:0 12px 30px rgba(168,85,247,.28)}.cat-icon{width:24px;height:24px;display:grid;place-items:center}.cat-icon svg{width:22px;height:22px;display:block}.cat-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600}.cat-count{min-width:28px;height:28px;padding:0 8px;border-radius:999px;display:grid;place-items:center;background:rgba(255,255,255,.08);font-size:12px;font-weight:800;color:inherit}.cat-button.active .cat-count{background:rgba(255,255,255,.22)}
.tool-badge{font-size:10px!important;font-weight:500!important}.kernel-status{position:relative;z-index:12;margin:12px 0 14px;padding-top:14px;border:1px solid color-mix(in srgb,var(--warning) 40%,var(--border));border-radius:16px;padding:12px 14px;background:linear-gradient(135deg,rgba(250,204,21,.13),rgba(168,85,247,.10));box-shadow:0 18px 45px rgba(0,0,0,.32);color:var(--foreground);font-size:12px;line-height:1.35}.kernel-status strong{display:block;margin-bottom:3px;color:#facc15;font-size:12px}.kernel-message{display:block}.kernel-status.progress{overflow:hidden;border-color:color-mix(in srgb,var(--warning) 70%,var(--primary));box-shadow:0 0 0 1px rgba(250,204,21,.10),0 18px 45px rgba(168,85,247,.32)}.kernel-status.progress::before{content:'';position:absolute;left:-40%;right:0;bottom:0;width:40%;height:3px;background:linear-gradient(90deg,transparent,#facc15,#c084fc,transparent);animation:kernelProgress 1.15s ease-in-out infinite}.kernel-status.progress strong::before{content:'';display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:999px;background:#facc15;box-shadow:0 0 0 0 rgba(250,204,21,.75);animation:kernelPulse 1.15s ease-in-out infinite}@keyframes kernelProgress{0%{transform:translateX(0)}100%{transform:translateX(360%)}}@keyframes kernelPulse{0%,100%{transform:scale(.82);box-shadow:0 0 0 0 rgba(250,204,21,.75)}50%{transform:scale(1.08);box-shadow:0 0 0 8px rgba(250,204,21,0)}}.kernel-actions{display:grid;grid-template-columns:1fr;gap:8px;margin-top:12px}.kernel-action{display:inline-flex;width:100%;justify-content:center;border:1px solid color-mix(in srgb,var(--success) 70%,var(--border));border-radius:14px;padding:12px 16px;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-size:13px;font-weight:900;box-shadow:0 14px 34px rgba(34,197,94,.24)}.kernel-action:hover{transform:translateY(-1px);box-shadow:0 18px 42px rgba(34,197,94,.34)}.kernel-action.secondary{background:rgba(34,197,94,.10);color:var(--success);box-shadow:none}.expired-subscription{border:1px solid rgba(251,113,133,.70);border-radius:24px;padding:28px;background:linear-gradient(135deg,rgba(127,29,29,.94),rgba(76,5,25,.92));box-shadow:0 26px 70px rgba(251,113,133,.24);color:#fff}.expired-subscription strong{display:block;margin-bottom:8px;color:#fecdd3;font-size:13px;text-transform:uppercase;letter-spacing:.12em}.expired-subscription h2{margin:0 0 10px;font-size:30px;line-height:1.05}.expired-subscription p{margin:0 0 18px;color:#ffe4e6;font-size:15px;line-height:1.5}.expired-subscription .expired-date{display:inline-flex;margin:0 0 18px;border:1px solid rgba(254,202,202,.45);border-radius:999px;padding:8px 12px;background:rgba(127,29,29,.55);color:#fff;font-weight:900}.expired-subscription a{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;border:1px solid rgba(255,255,255,.28);border-radius:14px;padding:13px 18px;background:#fff;color:#991b1b;font-size:14px;font-weight:900;box-shadow:0 16px 34px rgba(0,0,0,.24)}.expired-subscription a:hover{transform:translateY(-1px)}.kernel-status.ready{border-color:color-mix(in srgb,var(--success) 42%,var(--border));background:linear-gradient(135deg,rgba(89,227,154,.13),rgba(168,85,247,.08))}.kernel-status.ready strong{color:var(--success)}.kernel-status.error{border-color:color-mix(in srgb,var(--destructive) 46%,var(--border));background:linear-gradient(135deg,rgba(251,113,133,.14),rgba(168,85,247,.08))}.kernel-status.error strong{color:var(--destructive)}
.tools-grid .profile-card{position:relative!important;grid-template-columns:46px 1fr!important;gap:10px 12px!important;min-height:132px!important;padding:16px!important;border-color:color-mix(in srgb,var(--primary) 60%,var(--border))!important;background:linear-gradient(145deg,color-mix(in srgb,var(--tool-accent,#8b5cf6) 14%,#111225),rgba(10,11,24,.96))!important}.tools-grid .tool-icon{background:var(--tool-gradient,linear-gradient(135deg,#8b5cf6,#4f46e5))!important;color:#fff!important}.tools-grid .tool-badge{position:absolute!important;top:14px!important;right:16px!important}.tools-grid .tool-meta{padding-right:74px!important}.profile-actions{margin-top:4px!important;gap:10px!important}.action-pill.open{color:#1b1024!important;background:#d380ff!important;border-color:#d380ff!important;box-shadow:0 12px 28px rgba(211,128,255,.28)!important}
.tools-grid .profile-card{grid-template-columns:80px 1fr!important;gap:14px 16px!important;min-height:205px!important;padding:20px!important}.tools-grid .tool-icon{width:68px!important;height:68px!important;border-radius:20px!important;font-size:24px!important}.tools-grid .tool-title{font-size:22px!important;font-weight:800!important;line-height:1.12!important;margin-top:18px!important}.tools-grid .tool-meta small{font-size:16px!important;line-height:1.35!important}.profile-actions{grid-column:1/-1!important;margin-top:4px!important;align-self:end!important}.action-pill.open{font-size:16px!important;font-weight:800!important;background:#d380ff!important;border-color:#d380ff!important;color:#1b1024!important}.action-pill.close{font-size:12px!important;font-weight:700!important}.tools-grid .tool-badge{font-size:11px!important;font-weight:700!important;padding:7px 12px!important}
.tools-grid{grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:14px!important}.tools-grid .profile-card{grid-template-columns:38px 1fr!important;min-height:150px!important;padding:20px!important;align-content:stretch!important}.tools-grid .tool-icon{width:32px!important;height:32px!important;border-radius:10px!important;font-size:16px!important}.tools-grid .tool-title{font-size:13px!important;font-weight:600!important;line-height:1.12!important;margin:2px 0 0!important}.tools-grid .tool-meta small{display:block!important;margin-top:4px!important;font-size:12px!important;line-height:1.3!important}.tools-grid .tool-meta{padding-right:62px!important}.profile-actions{grid-column:1/-1!important;align-self:end!important;margin-top:auto!important;padding-top:8px!important;display:flex!important;align-items:center!important}.action-pill.open{font-size:13px!important;font-weight:800!important;background:#d380ff!important;border-color:#d380ff!important;color:#1b1024!important}.action-pill.close{font-size:11px!important;font-weight:700!important;padding:5px 9px!important}.tools-grid .tool-badge{font-size:10px!important;font-weight:600!important;padding:5px 10px!important;top:12px!important;right:12px!important}.profile-card.options-open{grid-template-columns:1fr!important;min-height:188px!important;align-content:end!important}.profile-card.options-open .tool-icon,.profile-card.options-open .tool-meta{display:none!important}.profile-card.options-open .profile-actions{grid-column:1/-1!important;display:block!important;margin-top:auto!important;padding-top:0!important;align-self:end!important}.profile-card.options-open .action-pill.open{display:none!important}.profile-card.options-open .profile-options .action-pill.close{position:absolute!important;top:8px!important;right:10px!important;width:24px!important;height:24px!important;padding:0!important;border-radius:999px!important;font-size:0!important;display:grid!important;place-items:center!important;background:transparent!important;color:#fb7185!important;border:0!important;box-shadow:none!important;z-index:36!important}.profile-card.options-open .profile-options .action-pill.close::before{content:'X';font-size:12px;font-weight:900;line-height:1}.profile-card.options-open .profile-options{grid-column:1/-1;align-self:end!important;margin-top:auto!important}.profile-options{position:relative;z-index:30;display:grid;gap:0px;padding:30px 3px 3px;border:1px solid color-mix(in srgb,var(--primary) 28%,var(--border));border-radius:15px;background:linear-gradient(145deg,rgba(16,17,36,.98),rgba(25,18,48,.96));box-shadow:0 18px 45px rgba(0,0,0,.48)}.option-row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding:8px 8px;border:0;border-radius:12px;background:none}.option-open,.option-close{padding:6px 5px!important;font-size:11px!important;border-radius:10px!important}.option-open{background:rgba(168,85,247,.18)!important;color:#c084fc!important}.option-close{background:rgba(251,113,133,.08)!important;color:#fb7185!important;border-color:rgba(251,113,133,.28)!important}
  .tools-grid .profile-card .profile-actions>button.action-pill.close,.tools-grid .profile-card .profile-actions>button.action-pill.close:hover,.tools-grid .profile-card .profile-actions>button.action-pill.close:disabled,.profile-card.options-open .profile-options>button.action-pill.close,.profile-card.options-open .profile-options>button.action-pill.close:hover{all:unset!important;display:inline!important;width:auto!important;height:auto!important;min-width:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;border-color:transparent!important;border-radius:0!important;outline:0!important;box-shadow:none!important;background:transparent!important;background-color:transparent!important;background-image:none!important;appearance:none!important;-webkit-appearance:none!important;color:#fb7185!important;font-size:11px!important;font-weight:700!important;line-height:1!important;text-decoration:none!important;text-transform:none!important;letter-spacing:0!important;cursor:pointer!important;opacity:1!important;transform:none!important}
.tools-grid .profile-card.unavailable{filter:grayscale(.85);opacity:1!important;cursor:default;border-color:rgba(148,163,184,.18)!important;background:linear-gradient(145deg,rgba(71,85,105,.18),rgba(10,11,24,.92))!important}.tools-grid .profile-card.unavailable:hover{transform:none!important;border-color:rgba(148,163,184,.32)!important}.tools-grid .profile-card.unavailable .tool-icon{background:linear-gradient(135deg,#64748b,#334155)!important;color:#cbd5e1!important;box-shadow:none!important;opacity:.58!important}.tools-grid .profile-card.unavailable .tool-title,.tools-grid .profile-card.unavailable .tool-meta small{color:#94a3b8!important;font-weight:500!important;opacity:.58!important}.tool-badge.unavailable{color:#cbd5e1!important;border-color:rgba(148,163,184,.28)!important;background:rgba(71,85,105,.34)!important;opacity:.58!important}.action-pill.unavailable,.action-pill.unavailable:disabled{all:unset!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;min-height:28px!important;border-radius:999px!important;padding:0px 12px!important;background:rgba(71,85,105,.34)!important;color:#cbd5e1!important;font-size:12px!important;font-weight:600!important;letter-spacing:.04em!important;text-transform:uppercase!important;cursor:not-allowed!important;opacity:1!important}.cat-icon img{width:18px;height:18px;object-fit:contain;display:block}.cat-icon svg{width:18px;height:18px}
.action-pill.open,.action-pill.open:hover,.action-pill.open:disabled{background:transparent!important;background-color:transparent!important;background-image:none!important;border-color:transparent!important;box-shadow:none!important;color:#d380ff!important}.upgrade-pill,.upgrade-pill:hover,.upgrade-pill:disabled{background:transparent!important;background-color:transparent!important;background-image:none!important;border:0!important;box-shadow:none!important;color:#a855f7!important}
.profile-card.unavailable .profile-actions .upgrade-pill,.profile-card.unavailable .profile-actions .upgrade-pill:hover,.profile-card.unavailable .profile-actions .upgrade-pill:disabled,.tools-grid .profile-card.unavailable .profile-actions .upgrade-pill{all:unset!important;display:inline!important;width:auto!important;height:auto!important;min-width:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;border-color:transparent!important;border-radius:0!important;outline:0!important;box-shadow:none!important;background:transparent!important;background-color:transparent!important;background-image:none!important;appearance:none!important;-webkit-appearance:none!important;color:#a855f7!important;font-size:13px!important;font-weight:800!important;line-height:1!important;text-decoration:none!important;text-transform:none!important;letter-spacing:0!important;cursor:pointer!important;opacity:1!important;transform:none!important}
.tools-grid .profile-card.unavailable{filter:none!important;opacity:1!important}.tools-grid .profile-card.unavailable .profile-actions .upgrade-pill{filter:none!important;color:#a855f7!important;opacity:1!important}.header-kernel-status{display:grid;gap:2px;width:max-content;min-width:0;max-width:100%;border:1px solid color-mix(in srgb,var(--warning) 44%,var(--border));border-radius:14px;padding:7px 11px;background:linear-gradient(135deg,rgba(250,204,21,.12),rgba(168,85,247,.10));box-shadow:0 12px 30px rgba(0,0,0,.22);font-size:11px;line-height:1.25}.header-kernel-status.hidden{display:none!important}.header-kernel-status strong{color:#facc15;font-size:11px}.header-kernel-status.ready{border-color:color-mix(in srgb,var(--success) 58%,var(--border));background:linear-gradient(135deg,rgba(89,227,154,.14),rgba(34,197,94,.08));box-shadow:0 12px 30px rgba(34,197,94,.18)}.header-kernel-status.ready strong{color:var(--success)}.header-kernel-status.ready .kernel-message{color:#b7f7d1}.header-kernel-status .kernel-message{color:var(--muted-foreground);overflow:visible;text-overflow:clip;white-space:normal;line-height:1.28}.header-kernel-status.progress{position:relative;overflow:hidden;border-color:color-mix(in srgb,var(--warning) 70%,var(--primary));box-shadow:0 0 0 1px rgba(250,204,21,.10),0 12px 30px rgba(168,85,247,.28)}.header-kernel-status.progress::before{content:'';position:absolute;left:-40%;right:0;bottom:0;width:40%;height:3px;background:linear-gradient(90deg,transparent,#facc15,#c084fc,transparent);animation:kernelProgress 1.15s ease-in-out infinite}.header-kernel-status.progress strong::before{content:'';display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:999px;background:#facc15;box-shadow:0 0 0 0 rgba(250,204,21,.75);animation:kernelPulse 1.15s ease-in-out infinite}.header-kernel-status .kernel-actions{margin-top:4px}.header-kernel-status .kernel-action{min-height:24px;padding:5px 9px;font-size:10px}.tools-sidebar-wrap>.kernel-status{display:none!important}.top-line{display:grid!important;grid-template-columns:minmax(170px,245px) minmax(0,1fr) auto!important;align-items:center!important;gap:10px!important;flex-wrap:nowrap!important;min-height:84px!important}.brand{min-width:0!important;width:auto!important}.top-info{min-width:0!important;overflow:hidden!important}.info-row{display:grid!important;grid-template-columns:auto auto minmax(0,1fr)!important;align-items:center!important;gap:8px!important;min-width:0!important;overflow:visible!important}.info-row .chip{flex:0 0 auto!important;min-width:0!important}.header-kernel-status{justify-self:start!important;width:max-content!important;min-width:0!important;max-width:100%!important}.top-actions{grid-column:3!important;grid-row:1!important;align-self:start!important;justify-self:end!important;position:static!important;right:auto!important;top:auto!important;flex:0 0 auto!important;display:flex!important;align-items:center!important;justify-content:flex-end!important;gap:6px!important;margin-left:0!important;white-space:nowrap!important;min-width:76px!important}.notice-wrap,.profile-wrap{position:relative!important;flex:0 0 auto!important}.top-icon,.profile-button{flex:0 0 34px!important;width:34px!important;height:34px!important;min-width:34px!important;padding:0!important}.main-menu{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;width:100%!important;flex-wrap:nowrap!important;overflow:visible!important}.login-card{width:min(420px,calc(100% - 48px))!important;margin:46px auto 0!important;padding:0!important;border:0!important;background:transparent!important;box-shadow:none!important}.login-form{display:grid!important;gap:14px!important}.login-form input{width:100%!important;height:48px!important;border-radius:14px!important;border:1px solid rgba(168,85,247,.34)!important;background:rgba(15,16,30,.92)!important;color:var(--foreground)!important;padding:0 16px!important;font-size:14px!important;outline:none!important}.login-form input:focus{border-color:#a855f7!important;box-shadow:0 0 0 3px rgba(168,85,247,.18)!important}.login-form button{width:100%!important;height:48px!important;border:0!important;border-radius:14px!important;background:linear-gradient(135deg,#a855f7,#7c3aed)!important;color:#fff!important;font-size:14px!important;font-weight:800!important;cursor:pointer!important;box-shadow:0 14px 30px rgba(168,85,247,.26)!important}.login-form button:hover{filter:brightness(1.08)!important}
html,body{width:100%!important;min-height:100vh!important;height:auto!important;overflow-x:hidden!important;background:#03040b!important}.shell{display:block!important;width:min(1120px,calc(100% - 48px))!important;min-height:calc(100vh - 205px)!important;margin:0 auto!important;padding:22px 0 48px!important}.agent-top{width:min(1120px,calc(100% - 48px))!important}.tools-shell{display:grid!important;grid-template-columns:260px minmax(0,1fr)!important;align-items:stretch!important;min-height:calc(100vh - 245px)!important}.tools-content{display:flex!important;flex-direction:column!important;min-height:calc(100vh - 245px)!important}.tools-toolbar{flex:0 0 auto!important}.tools-sidebar-wrap{height:fit-content!important}.tools-grid{align-content:start!important}.tools-content #profilesList{display:block!important;flex:1 1 auto!important;min-height:420px!important}.tools-content #profilesList:empty{display:grid!important;place-items:center!important;border:1px dashed rgba(168,85,247,.32)!important;border-radius:22px!important;background:rgba(21,21,39,.22)!important}.tools-content #profilesList:empty::before{content:'Carregando ferramentas do agente...'!important;color:#c084fc!important;font-weight:900!important;letter-spacing:.08em!important;text-transform:uppercase!important}#agentCard.hidden{display:none!important}#agentCard:not(.hidden){display:grid!important}#activationCard.hidden{display:none!important}@media(max-width:1100px){.tools-shell{grid-template-columns:1fr!important}.tools-sidebar-wrap{position:relative!important;top:auto!important}.tools-content,#profilesList{min-height:360px!important}}
.notice-dropdown{max-height:none!important;overflow:hidden!important}.notice-dropdown .notice-list{max-height:none!important;overflow:hidden!important}.notice-item{cursor:pointer}.notice-item p{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.agent-modal{width:min(96vw,920px)!important;max-height:calc(100vh - 40px)!important}.agent-modal .notice-list{max-height:calc(100vh - 170px)!important;overflow:hidden!important}.agent-popup .agent-modal{width:min(96vw,920px)!important;max-width:920px!important}.machine-support-box{margin:14px 0;padding:14px;border:1px solid rgba(251,113,133,.42);border-radius:16px;background:rgba(251,113,133,.10)}.machine-support-box strong{display:block;color:#fb7185;margin-bottom:6px}.machine-support-box button{margin-top:10px;background:linear-gradient(135deg,#a855f7,#7c3aed);border-color:#a855f7;color:#fff}.agent-top{position:fixed!important;top:0!important;left:50%!important;transform:translateX(-50%)!important;z-index:1000!important}.shell{padding-top:190px!important}.profile-card.maintenance .profile-actions{display:flex!important;align-items:center!important;justify-content:flex-start!important}.maintenance-label{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(250,204,21,.45);border-radius:999px;padding:10px 14px;background:rgba(250,204,21,.12);color:#facc15;font-size:12px;font-weight:900}.kernel-install-overlay{position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;background:rgba(3,4,11,.96);backdrop-filter:blur(12px)}.kernel-install-overlay.hidden{display:none!important}.kernel-install-card{width:min(520px,calc(100% - 32px));padding:34px;border:1px solid rgba(168,85,247,.65);border-radius:24px;background:linear-gradient(145deg,#17172b,#0d0e1c);box-shadow:0 30px 90px rgba(0,0,0,.72)}.kernel-install-card h2{margin:0 0 10px;color:#e9d5ff}.kernel-install-card p{margin:0;color:#c4b5d8;line-height:1.55}.kernel-install-track{height:9px;margin-top:22px;overflow:hidden;border-radius:999px;background:#292a3f}.kernel-install-progress{display:block;width:0;height:100%;background:linear-gradient(90deg,#a855f7,#d8b4fe);transition:width .25s}.kernel-install-progress.indeterminate{width:38%;animation:kernelInstallMove 1.1s ease-in-out infinite}.kernel-install-percent{display:block;margin-top:9px;text-align:right;color:#d8b4fe;font-weight:800}@keyframes kernelInstallMove{0%{transform:translateX(-110%)}100%{transform:translateX(280%)}}
  .header-kernel-status.error{border-color:rgba(251,113,133,.72);background:linear-gradient(135deg,rgba(127,29,29,.62),rgba(76,5,25,.52));box-shadow:0 12px 30px rgba(251,113,133,.18)}.header-kernel-status.error strong{color:#fb7185}.header-kernel-status.error .kernel-message{color:#fecdd3}
  #kernelStatus,#refreshProfiles{display:none!important}.tools-actions{width:min(100%,520px)}.tool-search{width:100%!important;min-width:420px!important;border:1px solid rgba(168,85,247,.68)!important;box-shadow:0 0 0 3px rgba(168,85,247,.10),0 16px 40px rgba(0,0,0,.28)!important;font-size:15px!important}.tool-search:focus{outline:none!important;border-color:#c084fc!important;box-shadow:0 0 0 4px rgba(168,85,247,.18),0 18px 48px rgba(0,0,0,.34)!important}body.agent-booting #activationCard,body.agent-booting #agentCard{display:none!important}body.agent-booting .shell::before{content:'Carregando painel...';display:grid;place-items:center;min-height:320px;color:#c084fc;font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.support-hours-only{display:grid;gap:12px;margin-top:8px;padding:16px;border:1px solid rgba(168,85,247,.28);border-radius:18px;background:rgba(255,255,255,.035)}.support-hour-row{display:flex;justify-content:space-between;gap:18px;padding-bottom:10px;border-bottom:1px solid rgba(148,163,184,.14);color:var(--muted-foreground)}.support-hour-row:last-child{padding-bottom:0;border-bottom:0}.support-hour-row strong{color:var(--foreground)}#supportModal .agent-modal{width:min(520px,calc(100vw - 32px))!important}#supportModal .whatsapp-button{margin-top:14px}.profile-card.options-open{overflow:visible!important;margin-top:24px!important}.profile-card.options-open .profile-actions{position:relative!important;overflow:visible!important}.options-close-float{position:absolute!important;right:4px!important;top:-34px!important;z-index:80!important;width:24px!important;height:24px!important;min-width:24px!important;min-height:24px!important;padding:0!important;border:0!important;border-radius:999px!important;background:transparent!important;color:#fb7185!important;box-shadow:none!important;font-size:16px!important;font-weight:900!important;line-height:1!important}.options-close-float:hover{background:rgba(251,113,133,.10)!important;transform:none!important}.profile-card.options-open .profile-options{padding-top:8px!important}@media(max-width:980px){.tools-actions{width:100%}.tool-search{min-width:0!important}}
  .profile-card.options-open{overflow:visible!important;margin-top:32px!important}
  .profile-card.options-open .profile-actions{position:relative!important;overflow:visible!important}
  .profile-card.options-open [data-act="close-options"]{all:unset!important;position:absolute!important;right:2px!important;top:-30px!important;z-index:100!important;width:24px!important;height:24px!important;display:grid!important;place-items:center!important;border-radius:999px!important;background:transparent!important;color:#fb7185!important;cursor:pointer!important;font-size:0!important;line-height:1!important}
  .profile-card.options-open [data-act="close-options"]::before{content:'×'!important;font-size:18px!important;font-weight:900!important;line-height:1!important}
  .profile-card.options-open [data-act="close-options"]:hover{background:rgba(251,113,133,.10)!important}
  .profile-card.options-open .profile-options{position:relative!important;padding-top:8px!important;overflow:visible!important}
  .profile-options-wrap{position:relative!important;width:100%!important;padding-top:30px!important}
  .profile-options-wrap .options-close-float{all:unset!important;position:absolute!important;top:0!important;right:4px!important;z-index:120!important;width:24px!important;height:24px!important;display:grid!important;place-items:center!important;border-radius:999px!important;color:#fb7185!important;cursor:pointer!important;font-size:18px!important;font-weight:900!important;line-height:1!important}
  .profile-options-wrap .options-close-float::before{content:none!important}
  .profile-options-wrap .options-close-float:hover{background:rgba(251,113,133,.10)!important}
  .profile-options-wrap .profile-options{width:100%!important;margin:0!important;padding-top:8px!important}
  .agent-intro{position:fixed;inset:0;z-index:5000;display:grid;place-items:center;padding:24px;background:rgba(3,4,11,.74);backdrop-filter:blur(16px);opacity:0;pointer-events:none;transition:opacity .45s ease}.agent-booting .agent-intro{opacity:1;pointer-events:auto}.agent-intro-card{width:min(680px,calc(100vw - 32px));overflow:hidden;border:1px solid rgba(168,85,247,.28);border-radius:24px;background:#05060d;box-shadow:0 34px 120px rgba(0,0,0,.72)}.agent-intro video{display:block;width:100%;max-height:70vh;object-fit:contain;background:#05060d}.agent-intro-progress{height:4px;overflow:hidden;background:rgba(255,255,255,.08)}.agent-intro-progress span{display:block;width:38%;height:100%;border-radius:99px;background:linear-gradient(90deg,#7c3aed,#d946ef,#38bdf8,#7c3aed);background-size:240% 100%;animation:introProgress 1.25s ease-in-out infinite}.session-loader{position:fixed;inset:0;z-index:4990;display:none;place-items:center;background:#03040b}.agent-checking-session:not(.agent-booting) .session-loader{display:grid}.session-loader-bar{width:min(280px,55vw);height:3px;overflow:hidden;border-radius:99px;background:rgba(255,255,255,.08)}.session-loader-bar span{display:block;width:38%;height:100%;border-radius:99px;background:linear-gradient(90deg,#7c3aed,#d946ef,#38bdf8);animation:introProgress .9s ease-in-out infinite}@keyframes introProgress{0%{transform:translateX(-110%);background-position:0 0}100%{transform:translateX(300%);background-position:100% 0}}
  @keyframes agentBootSpin{to{transform:rotate(360deg)}}
  html,body{max-width:100%;overflow-x:hidden}
  .desktop-update-wrap{position:relative;order:2}
  .desktop-update-wrap.hidden{display:none!important}
  .desktop-update-button{position:relative!important;border:0!important;background:transparent!important;box-shadow:none!important}
  .desktop-update-button::before{width:17px;height:17px;background:currentColor;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M12 3v10.2l3.6-3.6L17 11l-6 6-6-6 1.4-1.4 3.6 3.6V3h2Zm-7 16h14v2H5v-2Z'/%3E%3C/svg%3E") center/contain no-repeat;content:''!important}
  .desktop-update-button.has-update::after{content:'';position:absolute;right:3px;top:2px;width:8px;height:8px;border:2px solid #111223;border-radius:999px;background:#fb7185;box-shadow:0 0 12px rgba(251,113,133,.75)}
  .desktop-update-dropdown{position:absolute;right:0;top:calc(100% + 10px);z-index:1200;width:min(330px,calc(100vw - 28px));padding:14px;border:1px solid rgba(168,85,247,.42);border-radius:18px;background:#151527;box-shadow:0 24px 70px rgba(0,0,0,.58)}
  .desktop-update-dropdown h3{margin:0 0 6px;font-size:16px}.desktop-update-dropdown p{margin:0;color:var(--muted-foreground);font-size:12px;line-height:1.45}
  .desktop-update-version{display:inline-flex;margin:12px 0 8px;padding:5px 9px;border:1px solid rgba(168,85,247,.4);border-radius:999px;color:#d8b4fe;font-size:11px;font-weight:900}
  .desktop-update-status{min-height:18px;margin-top:8px!important;color:#c4b5fd!important}
  .desktop-update-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:13px}.desktop-update-actions button{padding:8px 11px}.desktop-update-install{border-color:#a855f7;background:linear-gradient(135deg,#a855f7,#7c3aed);color:#fff}
  .top-actions{min-width:112px!important}.notice-wrap{order:1}.profile-wrap{order:3}
  header.agent-top{width:auto!important;max-width:none!important;left:50px!important;right:50px!important;transform:none!important;margin-left:0!important;margin-right:0!important}
  main.shell{width:auto!important;max-width:none!important;margin-left:50px!important;margin-right:50px!important}
  .tools-shell{grid-template-columns:260px minmax(0,1fr)!important}
  .tools-sidebar-wrap{width:100%!important;max-width:100%!important;min-width:0!important}
  .tools-sidebar{box-sizing:border-box!important;width:100%!important;max-width:100%!important;min-width:0!important}
  .tools-grid{grid-template-columns:repeat(5,minmax(0,1fr))!important}
  .tools-content,.tools-toolbar>*,.profile-card>*{min-width:0}
  @media(max-width:1799px){
    .tools-grid{grid-template-columns:repeat(4,minmax(0,1fr))!important}
  }
  @media(max-width:1399px){
    .tools-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important}
  }
  @media(max-width:1050px){
    .tools-shell{grid-template-columns:260px minmax(0,1fr)!important;gap:14px!important}
    .tools-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}
    .tools-toolbar{flex-direction:column!important;margin:22px 0!important}
    .tools-actions{width:100%!important}.tool-search{width:100%!important;min-width:0!important}
  }
  @media(max-width:980px){
    header.agent-top{position:relative!important;top:auto!important;left:auto!important;right:auto!important;transform:none!important;width:auto!important;margin-left:50px!important;margin-right:50px!important}
    .shell{padding-top:18px!important}
    .top-line{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;grid-template-rows:auto auto!important;gap:12px!important;min-height:0!important;padding:14px!important}
    .brand{grid-column:1!important;grid-row:1!important;min-width:0!important;padding-right:0!important}
    .top-actions{position:static!important;grid-column:2!important;grid-row:1!important;align-self:start!important;min-width:112px!important}
    .top-info{grid-column:1/-1!important;grid-row:2!important;width:100%!important}
    .info-row{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;width:100%!important}
    .header-kernel-status{grid-column:1/-1!important;width:100%!important}
    .tools-shell{grid-template-columns:260px minmax(0,1fr)!important}
    .tools-sidebar-wrap{position:sticky!important;top:12px!important}.tools-sidebar{width:auto!important}
  }
  @media(max-width:760px){
    .tools-shell{grid-template-columns:1fr!important}
    .tools-sidebar-wrap{position:static!important}.tools-sidebar{width:100%!important}
    .tools-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}
  }
  @media(max-width:640px){
    .top-line{padding:12px!important;gap:10px!important}.brand-title{font-size:15px!important}.brand-sub{font-size:11px!important}
    .top-actions{gap:4px!important;min-width:106px!important}.top-icon,.profile-button{width:32px!important;height:32px!important}
    .info-row{grid-template-columns:1fr!important}.chip{max-width:100%!important;white-space:normal!important;overflow-wrap:anywhere}
    .main-menu{grid-template-columns:repeat(2,minmax(0,1fr))!important;position:static!important}
    .tools-toolbar h1{font-size:clamp(25px,8vw,32px)!important}.tools-actions{display:grid!important;grid-template-columns:1fr!important}
    .tools-grid{grid-template-columns:1fr!important}.tools-grid .profile-card{grid-template-columns:56px minmax(0,1fr)!important;padding:18px!important}
    .tools-grid .tool-icon{width:52px!important;height:52px!important}.tools-grid .tool-title{font-size:19px!important;margin-top:68px!important}
    .notice-dropdown,.desktop-update-dropdown,.profile-dropdown{position:fixed!important;left:10px!important;right:10px!important;top:76px!important;width:auto!important;max-height:calc(100vh - 96px)!important;overflow:auto!important}
    .modal-backdrop{padding:10px!important}.agent-modal{width:100%!important;max-height:calc(100vh - 20px)!important;padding:16px!important}
  }
  </style>
</head>
<body class="agent-booting agent-checking-session">
  <script>
    window.__agentBootStartedAt=Date.now();
    window.__showAgentIntro=!sessionStorage.getItem('ninjaflix:intro-seen');
    if(window.__showAgentIntro)sessionStorage.setItem('ninjaflix:intro-seen','1');
    else document.body.classList.remove('agent-booting');
    window.__agentIntroTimer=setTimeout(()=>document.body.classList.remove('agent-booting'),window.__showAgentIntro?6000:0);
    window.finishAgentBoot=function(){
      const wait=window.__showAgentIntro?Math.max(0,6000-(Date.now()-window.__agentBootStartedAt)):0;
      clearTimeout(window.__agentBootFinishTimer);
      window.__agentBootFinishTimer=setTimeout(()=>document.body.classList.remove('agent-booting','agent-checking-session'),wait);
    };
    window.markAgentContentReady=function(reason){window.__agentContentReady=true;window.ninjaflixDesktop?.contentReady?.({reason:String(reason||'ready')});window.finishAgentBoot()};
    window.__agentBootSafetyTimer=setTimeout(()=>window.finishAgentBoot(),30000);
    window.addEventListener('error',()=>window.finishAgentBoot());
    window.addEventListener('unhandledrejection',()=>window.finishAgentBoot());
  </script>
  <div class="agent-intro" aria-label="Carregando painel"><div class="agent-intro-card"><video src="/intro-video.mp4" autoplay muted playsinline preload="auto"></video><div class="agent-intro-progress"><span></span></div></div></div>
  <div class="session-loader" aria-label="Verificando sessão"><div class="session-loader-bar"><span></span></div></div>
  <div id="kernelInstallOverlay" class="kernel-install-overlay hidden" role="dialog" aria-modal="true" aria-live="polite"><section class="kernel-install-card"><h2 id="kernelInstallTitle">Preparando seu navegador</h2><p id="kernelInstallMessage">Aguarde enquanto preparamos tudo para abrir seu perfil.</p><div id="sunbrowserSlides" class="sunbrowser-slides hidden"></div><div class="kernel-install-track"><span id="kernelInstallProgress" class="kernel-install-progress"></span></div><span id="kernelInstallPercent" class="kernel-install-percent">0%</span></section></div>
  <header class="agent-top"><div class="agent-frame"><div class="top-line"><div class="brand"><div class="logo"><img src="/logo-roxo.svg" alt="Ninjaflix" /></div><div><div class="brand-title">Ninjaflix</div><div class="brand-sub muted">Dashboard de ferramentas</div></div></div><div class="top-info"><div class="info-row"><div class="chip"><span>Pacote:</span> <strong id="clientPackage">-</strong></div><div class="chip"><span>Validade:</span> <strong id="subscriptionInfo">-</strong></div><div id="headerKernelStatus" class="header-kernel-status hidden"></div></div></div><div class="top-actions"><div class="notice-wrap"><button id="noticeButton" class="top-icon" title="Avisos">Avisos</button><div id="noticeDropdown" class="notice-dropdown hidden"><div class="notice-dropdown-title">Avisos recentes</div><div id="noticeDropdownList" class="notice-list"><div class="notice-item"><strong>Carregando...</strong></div></div></div></div><div id="desktopUpdateWrap" class="desktop-update-wrap"><button id="desktopUpdateButton" class="top-icon desktop-update-button" title="Atualizações" aria-label="Atualizações">Atualizações</button><div id="desktopUpdateDropdown" class="desktop-update-dropdown hidden"><h3>Atualizações</h3><p id="desktopUpdateTitle">Verificando atualizações...</p><span id="desktopUpdateVersion" class="desktop-update-version"></span><p id="desktopUpdateMessage"></p><p id="desktopUpdateStatus" class="desktop-update-status"></p><div class="desktop-update-actions"><button id="desktopUpdateLater" type="button">Fechar</button><button id="desktopUpdateInstall" class="desktop-update-install hidden" type="button">Atualizar agora</button></div></div></div><div class="profile-wrap"><button id="profileButton" class="profile-button" title="Perfil do cliente">Perfil</button><div id="profileDropdown" class="profile-dropdown hidden"><div class="profile-head"><div class="profile-avatar">P</div><div><strong id="profileName">Cliente</strong><small id="profileEmail">-</small></div></div><div class="profile-row"><span>Pacote</span><strong id="profilePackage">-</strong></div><div class="profile-row"><span>Validade</span><strong id="profileValidity">-</strong></div><button id="profileLogoutButton" class="danger profile-logout">Sair do agente</button></div></div></div></div><nav class="main-menu"><button class="active" data-panel="tools">Ferramentas</button><button data-launch="financeiro">Financeiro</button><button data-launch="suporte">Suporte</button><button data-launch="tutoriais">Tutoriais</button></nav></div></header>
  <main class="shell"><section id="activationCard" class="login-card"><form id="activationForm" class="login-form"><input name="email" type="email" autocomplete="email" placeholder="E-mail usado no checkout" required /><button>Entrar e vincular maquina</button></form></section><section id="agentCard" class="tools-shell hidden"><div class="tools-sidebar-wrap"><aside class="tools-sidebar"><div class="sidebar-title">Categorias</div><div id="categoryList"></div></aside><div id="kernelStatus" class="kernel-status hidden" role="status" aria-live="polite"></div></div><section class="tools-content"><div class="tools-toolbar"><div><h1 id="toolsTitle">Plano ativo</h1><p id="toolsSubtitle" class="muted">Ferramentas prontas - organizadas por categoria</p></div><div class="tools-actions"><input id="toolSearch" class="tool-search" placeholder="Buscar ferramenta..." /><button id="refreshProfiles" class="secondary">Atualizar</button></div></div><div id="profilesList"></div><pre id="resultBox" class="hidden"></pre></section></section><section id="debugCard" class="card hidden"><h2>Debug da maquina</h2><button id="debugButton" class="secondary">Comparar com portal</button><pre id="debugBox"></pre></section></main>
  <button id="supportChatButton" class="support-chat-button hidden" type="button" aria-label="Abrir chat do suporte"><span class="support-chat-icon">?</span><span>Suporte</span><b id="supportChatUnread" class="hidden">0</b></button>
  <aside id="supportChatPanel" class="support-chat-panel hidden" aria-label="Chat do suporte">
    <header><div><strong>Suporte NinjaFlix</strong><small>Atendimento pelo painel</small></div><button id="supportChatClose" type="button" aria-label="Fechar chat">&times;</button></header>
    <div id="supportChatBody" class="support-chat-body"><div class="support-chat-loading">Carregando atendimento...</div></div>
  </aside>
  <div id="noticeModal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="noticeModalTitle"><section class="agent-modal"><div class="modal-head"><div><h2 id="noticeModalTitle">Avisos e novidades</h2><p class="muted">Ultimas noticias e informacoes enviadas pelo painel admin agente.</p></div><button class="modal-close" data-close-modal="noticeModal">x</button></div><div id="noticeList" class="notice-list"><div class="notice-item"><strong>Carregando avisos...</strong><p>Aguarde enquanto buscamos as ultimas informacoes.</p></div></div></section></div>
  <div id="agentPopupModal" class="modal-backdrop agent-popup hidden" role="dialog" aria-modal="true" aria-labelledby="agentPopupTitle"><section class="agent-modal"><div class="modal-head"><div><h2 id="agentPopupTitle">Aviso</h2></div><button class="modal-close" data-close-modal="agentPopupModal">x</button></div><div id="agentPopupBody" class="notice-list"></div><a id="agentPopupCta" class="popup-cta hidden" href="#" target="_blank" rel="noopener">Abrir link</a></section></div>
  <div id="supportModal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="supportModalTitle"><section class="agent-modal"><div class="modal-head"><div><h2 id="supportModalTitle">Suporte NinjaFlix</h2></div><button class="modal-close" data-close-modal="supportModal" aria-label="Fechar">x</button></div><div class="support-hours-only"><div class="support-hour-row"><strong>Segunda a sexta</strong><span>09h às 12h | 14h às 19h</span></div><div class="support-hour-row"><strong>Sábado</strong><span>10h às 12h | 13h30 às 15h</span></div><div class="support-hour-row"><strong>Domingos e feriados</strong><span>Fechado</span></div></div><a class="whatsapp-button" href="https://wa.me/5551981819173" target="_blank" rel="noopener">Chamar no WhatsApp</a></section></div>
  <script>
    const headerKernelStatus=document.querySelector('#headerKernelStatus'),activationCard=document.querySelector('#activationCard'),agentCard=document.querySelector('#agentCard'),profileButton=document.querySelector('#profileButton'),profileDropdown=document.querySelector('#profileDropdown'),profileName=document.querySelector('#profileName'),profileEmail=document.querySelector('#profileEmail'),profilePackage=document.querySelector('#profilePackage'),profileValidity=document.querySelector('#profileValidity'),clientPackage=document.querySelector('#clientPackage'),subscriptionInfo=document.querySelector('#subscriptionInfo'),noticeModal=document.querySelector('#noticeModal'),noticeDropdown=document.querySelector('#noticeDropdown'),noticeDropdownList=document.querySelector('#noticeDropdownList'),supportModal=document.querySelector('#supportModal'),supportTicketsList=document.querySelector('#supportTicketsList'),supportTicketForm=document.querySelector('#supportTicketForm'),noticeList=document.querySelector('#noticeList'),agentPopupModal=document.querySelector('#agentPopupModal'),agentPopupTitle=document.querySelector('#agentPopupTitle'),agentPopupBody=document.querySelector('#agentPopupBody'),agentPopupCta=document.querySelector('#agentPopupCta'),toolsTitle=document.querySelector('#toolsTitle'),toolsSubtitle=document.querySelector('#toolsSubtitle'),toolSearch=document.querySelector('#toolSearch'),accessStatus=document.querySelector('#accessStatus'),kernelStatus=document.querySelector('#kernelStatus'),profilesList=document.querySelector('#profilesList'),categoryList=document.querySelector('#categoryList'),resultBox=document.querySelector('#resultBox'),apiBadge=document.querySelector('#apiBadge'),bindBadge=document.querySelector('#bindBadge'),adspowerHealth=document.querySelector('#adspowerHealth'),states=new Map();let currentProfiles=[],currentCategories=[],activeCategory='Todas',busyProfile='',busyAction='',optionMenu='',openedProfileIds=new Map(),activeProfileCardKey='',activeProfileId='',lastVisibleAt=Date.now(),statusRefreshTimer=null,shellConfig={pages:{financeiro:'https://cliente.ninjaflix.club/financeiro',tutoriais:'https://cliente.ninjaflix.club/tutoriais',suporte:'https://cliente.ninjaflix.club/suporte',avisos:'https://cliente.ninjaflix.club/?tab=avisos',upgrade:'https://cliente.ninjaflix.club/financeiro?aba=assinatura&secao=upgrade'}};
    async function req(path,options={}){const r=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const b=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(b.error||'Erro no agente');e.payload=b;e.status=r.status;throw e}return b}function show(o){resultBox.textContent=typeof o==='string'?o:JSON.stringify(o,null,2)}function setAccessStatus(text){if(accessStatus)accessStatus.textContent=text}function setKernelStatus(kind,title,message,action){const targets=[kernelStatus,headerKernelStatus].filter(Boolean);if(!targets.length)return;targets.forEach(el=>{el.className=(el===headerKernelStatus?'header-kernel-status ':'kernel-status ')+(kind||'');if(!title){el.classList.add('hidden');el.innerHTML='';return}el.classList.remove('hidden');el.innerHTML='<strong>'+title+'</strong><span class="kernel-message">'+message+'</span>'+(action==='adspower'?'<div class="kernel-actions"><button type="button" class="kernel-action" data-kernel-action="connect-adspower">Conectar AdsPower</button></div>':'')})}function isKernelUpdateSignal(out){const raw=JSON.stringify(out||{}).toLowerCase();return raw.includes('kernel')||raw.includes('browser kernel')||raw.includes('download')||raw.includes('update')||raw.includes('install')}async function maybeShowKernelUpdate(){try{const plan=await req('/kernel-plan',{method:'POST',body:JSON.stringify({})});if(plan&&plan.shouldShowUpdate){setKernelStatus('progress','Preparando navegador AdsPower','Kernel '+plan.kernelVersion+' sendo instalado/atualizado pela primeira vez neste computador. Aguarde, isso acontece apenas uma vez por versao.')}else{setKernelStatus('progress','Abrindo perfil','Estamos abrindo seu perfil. Aguarde alguns instantes.')}return plan}catch(_e){return null}}function connectRuntimeEvents(){try{if(window.__runtimeEvents)return;const es=new EventSource('/events');window.__runtimeEvents=es;es.addEventListener('profile-status',ev=>{try{const data=JSON.parse(ev.data||'{}');if(data.cardKey)updateProfileCardOnly(data.cardKey,data.status||'closed')}catch(_e){}});es.addEventListener('kernel-status',ev=>{try{const data=JSON.parse(ev.data||'{}');if(data.status==='progress')setKernelStatus('progress',data.title||'Preparando navegador AdsPower',data.message||'Atualizando kernel do AdsPower. Aguarde.');if(data.status==='ready')setKernelStatus('ready',data.title||'Perfil pronto para uso',data.message||'Seu perfil está aberto e pronto para você usar.')}catch(_e){}})}catch(_e){}}function setBadge(el,kind,text,label,detail){if(!el)return;const current=el.className||'';el.className=(current.includes('status-tag')?'status-tag ':current.includes('chip')?'chip ':'badge ')+kind;if(el.className.includes('status-tag')){el.tabIndex=0;el.dataset.detail=detail||text||'';el.innerHTML='<span class="dot"></span> '+text}else{el.innerHTML='<span class="dot"></span> '+text}}function shortFp(v){return v?('FNP-'+String(v).slice(0,4).toUpperCase()+'-'+String(v).slice(4,8).toUpperCase()):'-'}function parseLocalDate(value){if(value===null||value===undefined)return null;const raw=String(value).trim();if(!raw)return null;const iso=new RegExp('^(\\\\d{4})-(\\\\d{2})-(\\\\d{2})(?:[T\\\\s].*)?$').exec(raw);if(iso){const y=Number(iso[1]);const m=Number(iso[2])-1;const d=Number(iso[3]);const parsed=new Date(y,m,d,0,0,0,0);return Number.isNaN(parsed.getTime())?null:parsed}const brDate=new RegExp('^(\\\\d{2})\\\\/(\\\\d{2})\\\\/(\\\\d{4})$').exec(raw);if(brDate){const y=Number(brDate[3]);const m=Number(brDate[2])-1;const d=Number(brDate[1]);const parsed=new Date(y,m,d,0,0,0,0);return Number.isNaN(parsed.getTime())?null:parsed}try{const parsed=new Date(raw);if(Number.isNaN(parsed.getTime()))return null;return new Date(parsed.getFullYear(),parsed.getMonth(),parsed.getDate())}catch{return null}}function daysLeft(date){if(!date)return 'Sem vencimento';const d=parseLocalDate(date);if(!d)return String(date);const today=new Date();const todayDateOnly=new Date(today.getFullYear(),today.getMonth(),today.getDate());const ms=d.getTime()-todayDateOnly.getTime();if(!Number.isFinite(ms))return String(date);const diff=Math.ceil(ms/86400000);return diff>=0?diff+'d':'vencida'}function fmtDate(date){if(!date)return 'Sem vencimento';const d=parseLocalDate(date);if(!d)return String(date);return d.toLocaleDateString('pt-BR')}function subscriptionBlockStartsAt(date){if(!date)return null;const d=parseLocalDate(date);if(!d)return null;return new Date(d.getFullYear(),d.getMonth(),d.getDate()+1,0,0,0,0).getTime()}function isSubscriptionExpired(date){const t=subscriptionBlockStartsAt(date);return Number.isFinite(t)&&Date.now()>=t}function subscriptionValidityText(user){const suffix=isSubscriptionExpired(user?.subscriptionEndsAt)?'vencida':daysLeft(user?.subscriptionEndsAt);return fmtDate(user?.subscriptionEndsAt)+' - '+suffix}function applyUserSubscription(user){if(!user)return;const validity=subscriptionValidityText(user);if(subscriptionInfo)subscriptionInfo.textContent=validity;if(profileValidity)profileValidity.textContent=validity;return validity}function showExpiredSubscription(user){currentProfiles=[];activeCategory='Todas';renderCategories();const validity=applyUserSubscription(user)||'vencida';if(toolsTitle)toolsTitle.textContent='Assinatura vencida';if(toolsSubtitle)toolsSubtitle.textContent='Regularize sua assinatura para voltar a acessar os perfis.';if(toolSearch)toolSearch.disabled=true;profilesList.innerHTML='<div class="expired-subscription"><strong>Acesso bloqueado</strong><h2>Assinatura vencida</h2><div class="expired-date">Validade: '+validity+'</div><p>Sua assinatura venceu e os perfis foram ocultados por seguranca. Regularize o pagamento na area financeira para liberar novamente as ferramentas.</p><a href="'+(shellConfig.pages?.financeiro||'https://cliente.ninjaflix.club/financeiro')+'">Ir para o financeiro</a></div>';setAccessStatus('Assinatura vencida. Regularize no financeiro para continuar.')}function statusFrom(result){const data=result?.adspower?.data||result?.data||{};const t=JSON.stringify(data).toLowerCase();if(t.includes('active')||t.includes('opened')||t.includes('running'))return'open';return'closed'}function normalizePlanKey(v){const t=String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');if(t.includes('avatar'))return'avatarplus';if(t.includes('ultra'))return'ultra';if(t.includes('arsenal')||t.includes('seo'))return'arsenalseo';if(t.includes('design')||t.includes('ninja'))return'ninjadesign';return t}function packageLabelFromUser(user){const meta=user?.metadata||{};const cd=meta.checkoutData||meta.checkoutMetadata||meta.syncMetadata?.checkoutData||{};const labels={ninjadesign:'Ninja Design',avatarplus:'Avatar Plus',arsenalseo:'Arsenal SEO',ultra:'Ninja Ultra'};const key=normalizePlanKey(user?.packageKey||user?.packageCode||user?.accessGroup||cd.packageKey||cd.productPackageKey||cd.packageName||cd.planTitle||meta.packageKey||meta.packageName||meta.plan||'');const name=String(user?.packageName||user?.planTitle||user?.planDescription||cd.packageName||cd.planTitle||meta.packageName||'').trim();if(labels[key])return labels[key];const nameKey=normalizePlanKey(name);if(labels[nameKey])return labels[nameKey];if(name&&!/^plano ativo$/i.test(name))return name;return 'Plano ativo'}function packageClass(label){const t=String(label||'').toLowerCase();if(t.includes('avatar'))return'avatar';if(t.includes('arsenal')||t.includes('seo'))return'seo';if(t.includes('ultra'))return'ultra';if(t.includes('design')||t.includes('ninja'))return'design';return''}function profileIcon(name){return String(name||'?').trim().slice(0,1).toUpperCase()}
    function svgIcon(path){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="'+path+'"/></svg>'}function esc(v){return String(v||'').replace(/[&<>\"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]))}function customCategoryIcon(icon,name){const value=String(icon||'').trim();if(!value)return categoryIcon(name);const lower=value.toLowerCase();if(lower.startsWith('http://')||lower.startsWith('https://')||lower.startsWith('data:image/'))return '<img src="'+esc(value)+'" alt="" />';if(lower.startsWith('<svg'))return value;return '<span>'+esc(value)+'</span>'}function categoryIcon(c){const t=String(c||'').toLowerCase();if(t==='todas')return svgIcon('M12 2l1.5 6.5L20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5L12 2z');if(t.includes('design'))return svgIcon('M12 3a9 9 0 0 0 0 18h1.5a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h3a6 6 0 0 0-3-10z');if(t.includes('marketing'))return svgIcon('M4 13h4l10-5v12L8 15H4v-2z M8 15v4');if(t.includes('video')||t.includes('vdeo'))return svgIcon('M4 7h11v10H4z M15 11l5-3v8l-5-3z');if(t.includes('seo'))return svgIcon('M4 16l5-5 4 4 7-8 M15 7h5v5');if(t.includes('ia'))return svgIcon('M12 2v5 M12 17v5 M4.9 4.9l3.5 3.5 M15.6 15.6l3.5 3.5 M2 12h5 M17 12h5 M4.9 19.1l3.5-3.5 M15.6 8.4l3.5-3.5');if(t.includes('chat'))return svgIcon('M4 5h16v11H8l-4 4V5z');if(t.includes('dev'))return svgIcon('M8 9l-4 3 4 3 M16 9l4 3-4 3 M14 5l-4 14');return svgIcon('M5 12h14')}function renderCategories(){const byName=new Map();byName.set('Todas',{name:'Todas',icon:''});(Array.isArray(currentCategories)?currentCategories:[]).forEach(c=>{const name=String(c&&c.name||'').trim();if(name)byName.set(name,{name,icon:String(c.icon||'').trim()})});(currentProfiles||[]).forEach(p=>{const name=String(p.category||'Geral').trim()||'Geral';if(!byName.has(name))byName.set(name,{name,icon:String(p.categoryIcon||'').trim()})});const cats=Array.from(byName.values());if(activeCategory!=='Todas'&&!byName.has(activeCategory))activeCategory='Todas';function catAvailable(p){return !(p&&(p.available===false||p.available==='false'||p.canOpen===false||p.canOpen==='false'||p.unavailable===true||p.unavailable==='true'))}const total=(currentProfiles||[]).filter(catAvailable).length;function count(c){return c==='Todas'?total:(currentProfiles||[]).filter(p=>(p.category||'Geral')===c).length}categoryList.innerHTML=cats.map(c=>'<button class="cat-button '+(c.name===activeCategory?'active':'')+'" data-cat="'+esc(c.name)+'"><span class="cat-icon">'+(c.name==='Todas'?categoryIcon(c.name):(c.icon?customCategoryIcon(c.icon,c.name):categoryIcon(c.name)))+'</span><span class="cat-name">'+esc(c.name)+'</span><span class="cat-count">'+count(c.name)+'</span></button>').join('')}function profileStateLabel(s){return s==='opening'?'abrindo':s==='closing'?'fechando':s==='busy'?'processando':s==='open'?'aberto':'fechado'}function tagText(p,s){return s==='opening'?'abrindo':s==='closing'?'fechando':s==='busy'?'processando':s==='open'?'aberto':s==='closed'&&states.has(p.profileId)?'fechado':(p.tagLabel||p.tag||p.badge||'novo')}function tagClass(s){return (s==='busy'||s==='opening'||s==='closing')?'busy':s==='open'?'open':'closed'}function profileKey(p){return String(p&&p.id||p&&p.profileId||'')}function findLatestProfile(cardKey,profileId){return (currentProfiles||[]).find(p=>profileKey(p)===cardKey||p.profileId===cardKey||p.profileId===profileId)||{}}async function refreshProfilesSilent(){const data=await req('/profiles');if(data.user)applyUserSubscription(data.user);currentCategories=Array.isArray(data.categories)?data.categories:currentCategories;currentProfiles=data.profiles||currentProfiles;return data}function statusFrom(out){const explicit=String(out?.status||out?.runtime?.status||out?.runtime?.browserStatus||'').toLowerCase();if(['closed','close','stopped','offline'].includes(explicit))return'closed';if(['open','active','opened','running','started'].includes(explicit))return'open';const raw=JSON.stringify(out?.adspower?.data||out?.data||out?.adspower||{}).toLowerCase();return raw.includes('active')||raw.includes('opened')||raw.includes('running')||raw.includes('started')?'open':'closed'}function hasAnyOpenProfileCard(){return Boolean(profilesList?.querySelector('.profile-state.open,.profile-state.opening,.profile-state.closing'))}function hideReadyStatusIfNoOpenProfiles(){if(kernelStatus&&kernelStatus.classList.contains('ready')&&!hasAnyOpenProfileCard())setKernelStatus('', '', '')}function updateProfileCardOnly(cardKey,state){const primary=profilesList?.querySelector('[data-card-key=\"'+CSS.escape(cardKey)+'\"]');const selector='[data-card-key=\"'+CSS.escape(cardKey)+'\"]';const cards=Array.from(profilesList?.querySelectorAll(selector)||[]);if(!cards.length)return false;cards.forEach(card=>{const key=card.dataset.cardKey||cardKey;states.set(key,state);const badge=card.querySelector('.tool-badge');const stateEl=card.querySelector('.profile-state');if(badge){badge.className='tool-badge '+tagClass(state);badge.textContent=tagText({profileId:key,tagLabel:card.dataset.tagLabel||'novo'},state)}if(stateEl){stateEl.className='profile-state '+state;stateEl.innerHTML='<span class=\"dot\"></span>'+profileStateLabel(state)}card.querySelectorAll('button[data-act=\"open\"]').forEach(b=>{b.disabled=state==='open'||state==='busy'||state==='opening'||state==='closing';b.textContent=state==='opening'?'Abrindo...':state==='open'?'Aberto':'Abrir'});card.querySelectorAll('button[data-act=\"close\"]').forEach(b=>{b.disabled=state!=='open'&&state!=='closing';b.textContent=state==='closing'?'Fechando...':'Fechar'})});hideReadyStatusIfNoOpenProfiles();return true}async function refreshActiveCardStatus(){if(!activeProfileCardKey||!activeProfileId)return;if(document.hidden&&Date.now()-lastVisibleAt>60000)return;try{const out=await req('/status',{method:'POST',body:JSON.stringify({profileId:activeProfileId})});const st=statusFrom(out);if(!updateProfileCardOnly(activeProfileCardKey,st))renderProfiles();if(st==='closed'){openedProfileIds.delete(activeProfileCardKey);activeProfileCardKey='';activeProfileId=''}}catch(_e){}}function ensureStatusRefreshTimer(){if(statusRefreshTimer)return;statusRefreshTimer=setInterval(refreshActiveCardStatus,5000)}function renderProfiles(){const q=String(toolSearch?.value||'').trim().toLowerCase();function isProfileAvailable(p){return !(p&&(p.available===false||p.available==='false'||p.canOpen===false||p.canOpen==='false'||p.unavailable===true||p.unavailable==='true'))}const base=activeCategory==='Todas'?(currentProfiles||[]).filter(isProfileAvailable):(currentProfiles||[]).filter(p=>(p.category||'Geral')===activeCategory);const list=base.filter(p=>!q||String(p.name||'').toLowerCase().includes(q)||String(p.category||'').toLowerCase().includes(q));if(toolsSubtitle)toolsSubtitle.textContent=list.length+' ferramentas no menu'+(activeCategory==='Todas'?'':' - indisponiveis aparecem desativadas');function unavailableText(p){const plans=Array.isArray(p.availablePlans)?p.availablePlans.filter(Boolean).join(', '):String(p.availablePlans||'').trim();return 'Disponível no plano: '+(plans||p.packageName||'outro plano')}function cardHtml(p){const cardKey=profileKey(p);const available=!(p.available===false||p.available==='false'||p.canOpen===false||p.canOpen==='false'||p.unavailable===true||p.unavailable==='true');const s=available?(busyProfile===cardKey?(busyAction==='close'?'closing':'opening'):(states.get(cardKey)||'closed')):'unavailable';const busy=s==='busy'||s==='opening'||s==='closing',open=s==='open';const desc=p.description||p.subtitle||'Descricao nao informada';const accent=available?(p.accentColor||'#8b5cf6'):'#64748b';const gradient=available?(p.iconGradient||('linear-gradient(135deg,'+accent+','+(p.accentColor2||'#4f46e5')+')')):'linear-gradient(135deg,#64748b,#334155)';const opts=Array.isArray(p.profileOptions)?p.profileOptions:[];const hasOpts=available&&opts.length>1;const menuOpen=hasOpts&&optionMenu===cardKey;const message=unavailableText(p);const optsHtml=menuOpen?'<div class="profile-options"><button class="action-pill close" data-act="close-options" data-id="'+esc(p.profileId||'')+'">Fechar</button>'+opts.map((o,i)=>{const oid=String(o.profileId||'');const isOpen=openedProfileIds.get(cardKey)===oid;const isBusy=busyProfile===cardKey+':'+oid;return '<div class="option-row"><button type="button" class="option-open" data-option-act="open" data-option-id="'+esc(oid)+'" data-card-id="'+esc(cardKey)+'" '+(isBusy||isOpen?'disabled':'')+'>'+(isBusy&&busyAction==='open'?'Abrindo...':isOpen?'Aberto':('Opcao '+(i+1)))+'</button><button type="button" class="option-close" data-option-act="close" data-option-id="'+esc(oid)+'" data-card-id="'+esc(cardKey)+'" '+(isBusy||!isOpen?'disabled':'')+'>'+(isBusy&&busyAction==='close'?'Fechando...':'Fechar')+'</button></div>'}).join('')+'</div>':'';const buttonsHtml=menuOpen?'':'<button class="action-pill open" data-act="'+(hasOpts?'open-options':'open')+'" data-id="'+esc(cardKey)+'" '+(!hasOpts&&(busy||open)?'disabled':'')+'>'+(s==='opening'?'Abrindo...':open?'Aberto':'Abrir')+'</button><button class="action-pill close" data-act="close" data-id="'+esc(cardKey)+'" '+(hasOpts?'disabled':((s!=='open'&&s!=='closing')?'disabled':''))+'>'+(s==='closing'?'Fechando...':'Fechar')+'</button>';const upgradeHtml='<button type="button" class="action-pill upgrade-pill" data-upgrade="1">Upgrade</button>';const actionsHtml=available?(buttonsHtml+optsHtml):upgradeHtml;return '<div class="profile-card '+(menuOpen?'options-open ':'')+(available?'':'unavailable')+'" data-card-key="'+esc(cardKey)+'" data-profile-id="'+esc(p.profileId||'')+'" data-tag-label="'+esc(p.tagLabel||p.tag||p.badge||'novo')+'" data-unavailable-message="'+esc(message)+'" title="" style="--tool-accent:'+accent+';--tool-gradient:'+gradient+'"><span class="tool-badge '+(available?tagClass(s):'unavailable')+'">'+(available?tagText(p,s):'indisponível')+'</span>'+(menuOpen?'':'<div class="tool-icon">'+profileIcon(p.name)+'</div>')+'<div class="tool-meta"><div class="tool-title">'+esc(p.name)+'</div><small class="muted">'+esc(available?desc:message)+'</small>'+(available?'<div class="profile-state '+s+'"><span class="dot"></span>'+profileStateLabel(s)+'</div>':'')+'</div><div class="profile-actions">'+actionsHtml+'</div></div>'}function sectionHtml(title,items){return items.length?'<section class="tool-section"><h2 class="tool-section-title">'+esc(title)+'</h2><div class="tools-grid">'+items.map(cardHtml).join('')+'</div></section>':''}if(!list.length){profilesList.innerHTML='<div class="empty">Nenhuma ferramenta nesta categoria.</div>';return}if(activeCategory==='Todas'){const featured=list.filter(p=>p.featured);const rest=list.filter(p=>!p.featured);const catOrder=(Array.isArray(currentCategories)?currentCategories.map(c=>String(c.name||'').trim()).filter(Boolean):[]);const cats=Array.from(new Set([...catOrder,...rest.map(p=>p.category||'Geral')]));profilesList.innerHTML=sectionHtml('Destaque',featured)+cats.map(c=>sectionHtml(c,rest.filter(p=>(p.category||'Geral')===c))).join('');return}profilesList.innerHTML='<div class="featured-label"> '+esc(activeCategory)+'</div><div class="tools-grid">'+list.map(cardHtml).join('')+'</div>'}
    async function loadShellConfig(){try{const cfg=await req('/shell-config');shellConfig=cfg||shellConfig}catch(e){}}async function tryStartAdspower(){if(!confirm('O AdsPower parece estar desligado. Deseja autorizar o NinjaFlix Agent a tentar abrir o AdsPower automaticamente?'))return;try{setKernelStatus('', 'Abrindo AdsPower', 'Tentando iniciar o AdsPower. Em alguns computadores isso pode funcionar melhor no modo executavel instalado. Aguarde alguns segundos.');await req('/admin/adspower/start',{method:'POST',body:JSON.stringify({})});setTimeout(checkAdspower,7000)}catch(err){setKernelStatus('error','Nao foi possivel abrir o AdsPower',err.message,'adspower');alert(err.message)}}async function checkAdspower(){try{const out=await req('/admin/adspower/profiles');if(out.needsApiKey){setBadge(adspowerHealth,'warn','Adspower','AdsPower','AdsPower esta aberto, mas a API local exige API Key. Configure ADSPOWER_API_KEY no arquivo .env do agente.');setKernelStatus('warn','AdsPower aberto, API Key necessaria','O AdsPower respondeu na porta local, mas recusou a listagem porque exige API Key. Nao clique em conectar: configure a chave da API local do AdsPower no .env do agente.','');return}const total=(out.rawProfiles?.data?.list||out.rawProfiles?.data||out.groups||[]).length||0;setBadge(adspowerHealth,'online','Adspower','AdsPower',total?('AdsPower conectado. Perfis encontrados: '+total+'.'):'AdsPower respondeu, mas nenhum perfil foi retornado.')}catch(e){setBadge(adspowerHealth,'offline','Adspower','AdsPower','Nao foi possivel conectar ao AdsPower local: '+(e.message||'API local indisponivel')+'. Clique para autorizar a abertura automatica.');setKernelStatus('error','AdsPower offline','O AdsPower nao respondeu. Clique no botao abaixo para autorizar a abertura automatica e minimizada.','adspower')}}async function boot(){try{connectRuntimeEvents();await loadShellConfig();const h=await req('/health');setBadge(apiBadge,'online','Dashboard','Portal','Dashboard central respondendo normalmente. Clique para ver detalhes.');if(h.user){setBadge(bindBadge,'ok','Dispositivo','Aparelho','Este computador esta autorizado e vinculado ao cliente logado.');activationCard.classList.add('hidden');document.body.classList.remove('login-mode');if(agentCard)agentCard.classList.remove('hidden');profileName.textContent=h.user.name||'Cliente';profileEmail.textContent=h.user.email||'-';const packageLabel=packageLabelFromUser(h.user);clientPackage.textContent=packageLabel;clientPackage.className='plan-name '+packageClass(packageLabel);profilePackage.textContent=packageLabel;if(toolsTitle)toolsTitle.textContent=packageLabel;applyUserSubscription(h.user);if(isSubscriptionExpired(h.user.subscriptionEndsAt)){showExpiredSubscription(h.user);refreshNoticeIndicator();checkPopups();setInterval(refreshNoticeIndicator,15000);setInterval(checkPopups,15000)}else{setAccessStatus('Ola, '+(h.user.name||'cliente')+'! Assinatura '+packageLabel+'.');if(toolSearch)toolSearch.disabled=false;await loadProfiles();refreshNoticeIndicator();checkPopups();setInterval(refreshNoticeIndicator,15000);setInterval(checkPopups,15000)}}else{setBadge(bindBadge,'warn','Dispositivo','Aparelho','Este computador ainda nao foi vinculado ao cliente. Informe o e-mail do checkout para ativar.');activationCard.classList.remove('hidden');document.body.classList.add('login-mode');if(agentCard)agentCard.classList.add('hidden');profileName.textContent='Aguardando ativacao';profileEmail.textContent='-';clientPackage.textContent='-';profilePackage.textContent='-';subscriptionInfo.textContent='-';if(toolsTitle)toolsTitle.textContent='Plano ativo';profileValidity.textContent='-';profilesList.innerHTML='<div class="empty">Nenhum cliente logado neste agente.</div>';show('Informe somente o e-mail usado no checkout para vincular esta maquina.')}checkAdspower()}catch(err){setBadge(apiBadge,'offline','Dashboardline','Portal','Falha ao consultar o agente/dashboard: '+(err.message||'erro desconhecido'));show(err.message)}}async function loadProfiles(){const data=await req('/profiles');if(data.user)applyUserSubscription(data.user);if(data.canAccessService===false&&isSubscriptionExpired(data.user?.subscriptionEndsAt)){currentProfiles=[];renderCategories();showExpiredSubscription(data.user||{});return}if(toolSearch)toolSearch.disabled=false;currentCategories=Array.isArray(data.categories)?data.categories:[];currentProfiles=data.profiles||[];setAccessStatus('Assinatura ativa');if(toolsTitle&&data.user)toolsTitle.textContent=packageLabelFromUser(data.user);renderCategories();renderProfiles()}
    async function openLaunch(target){try{show('Gerando link seguro de acesso...');const out=await req('/launch-link',{method:'POST',body:JSON.stringify({target})});if(out.url){window.location.href=out.url;show('Abrindo link seguro: '+target)}}catch(err){showMachineSupport(err.message)}}function showMachineSupport(message){const html='<div class="machine-support-box"><strong>'+esc(message||'Acesso bloqueado')+'</strong><span>Chame o suporte para regularizar seu acesso.</span><br><button type="button" data-open-support-page="true">Chamar suporte</button></div>';if(activationCard&&!activationCard.classList.contains('hidden'))activationCard.insertAdjacentHTML('beforeend',html);else show(message);setKernelStatus('error','Acesso bloqueado',message||'Chame o suporte.','');}function openModal(modal){modal?.classList.remove('hidden')}function closeModal(modal){modal?.classList.add('hidden')}function supportStatusText(status){return({open:'Aberto',answered:'Respondido',closed:'Fechado'}[String(status||'open')]||status)}async function loadSupportTickets(){if(!supportTicketsList)return;try{const out=await req('/support-tickets');const tickets=out.tickets||[];supportTicketsList.innerHTML=tickets.length?tickets.map(t=>'<div class="support-ticket-item"><strong>'+esc(t.subject||'Solicitação')+'</strong> <span class="tool-badge">'+supportStatusText(t.status)+'</span><p>'+esc(t.message||'')+'</p><small>'+new Date(t.createdAt||Date.now()).toLocaleString('pt-BR')+'</small>'+((t.messages||[]).map(m=>'<div class="support-message"><small>'+(m.from==='admin'?'Suporte':'Você')+' - '+new Date(m.createdAt||Date.now()).toLocaleString('pt-BR')+'</small><p>'+esc(m.message||'')+'</p></div>').join(''))+'</div>').join(''):'<div class="notice-item"><strong>Nenhuma solicitação criada</strong><p>Envie sua primeira solicitação pelo formulário acima.</p></div>'}catch(e){supportTicketsList.innerHTML='<div class="notice-item"><strong>Falha ao carregar suporte</strong><p>'+esc(e.message)+'</p></div>'}}async function openSupportModal(e){e?.preventDefault();e?.stopPropagation();openModal(supportModal);await loadSupportTickets()}function openNoticeFull(n){agentPopupTitle.textContent=String(n.title||'Aviso');agentPopupBody.innerHTML='<div class="popup-level">'+esc(n.level||'info')+'</div><div class="notice-item"><p>'+esc(n.message||'')+'</p><small>'+new Date(n.createdAt||n.updatedAt||Date.now()).toLocaleString('pt-BR')+'</small></div>';if(agentPopupCta)agentPopupCta.classList.add('hidden');agentPopupModal?.classList.remove('hidden')}function renderNoticeItems(notices){window.__lastNotices=(notices||[]).slice(0,3);const list=window.__lastNotices;return list.length?list.map((n,i)=>'<div class="notice-item" data-notice-index="'+i+'"><strong>'+esc(n.title||'Aviso')+'</strong><p>'+esc(n.message||'')+'</p><small>'+new Date(n.createdAt||n.updatedAt||Date.now()).toLocaleString('pt-BR')+' - '+esc(n.level||'info')+'</small></div>').join(''):'<div class="notice-item"><strong>Nenhum aviso publicado</strong><p>As novidades do admin agente aparecero aqui.</p></div>'}function showNoticeDropdown(notices,auto){if(!noticeDropdown)return;noticeDropdown.classList.remove('hidden');noticeDropdown.classList.toggle('auto-open',Boolean(auto));noticeDropdownList.innerHTML=renderNoticeItems(notices)}async function refreshNoticeIndicator(){try{const out=await req('/notices');const notices=(out.notices||[]).slice(0,3);const latest=notices[0]&&(notices[0].id||notices[0].createdAt||notices[0].updatedAt);const read=localStorage.getItem('ninjaflix:lastNoticeRead');const unread=Boolean(latest&&latest!==read);document.querySelector('#noticeButton')?.classList.toggle('has-unread',unread);if(unread)showNoticeDropdown(notices,true);return notices}catch{return[]}}async function checkPopups(){try{const out=await req('/popups');const popup=(out.popups||[])[0];if(!popup)return;const id=popup.id||popup.createdAt||popup.updatedAt;const seen=localStorage.getItem('ninjaflix:lastPopupRead');if(id&&id!==seen){agentPopupTitle.textContent=popup.title||'Aviso';const rawBtn=popup.button||{};let ctaUrl=String(popup.buttonUrl||popup.link||popup.url||popup.ctaUrl||popup.linkBotao||popup.link_botao||popup.botaoLink||popup.botao_link||rawBtn.url||rawBtn.link||'').trim();const ctaLabel=String(popup.buttonLabel||popup.buttonName||popup.ctaLabel||popup.nomeBotao||popup.nome_botao||popup.botaoNome||popup.botao_nome||popup.textoBotao||popup.texto_botao||rawBtn.label||rawBtn.name||'').trim();if(ctaUrl&&!/^(https?:|mailto:|tel:)/i.test(ctaUrl))ctaUrl='https://'+ctaUrl;agentPopupBody.innerHTML='<div class="popup-level">'+String(popup.level||'informacoes')+'</div><div class="notice-item"><p>'+String(popup.message||'')+'</p></div>';if(agentPopupCta){if(ctaUrl&&ctaLabel){agentPopupCta.href=ctaUrl;agentPopupCta.textContent=ctaLabel;agentPopupCta.classList.remove('hidden')}else{agentPopupCta.href='#';agentPopupCta.textContent='Abrir link';agentPopupCta.classList.add('hidden')}}agentPopupModal?.classList.remove('hidden');localStorage.setItem('ninjaflix:lastPopupRead',id)}}catch(e){}}async function openNotices(e){e?.stopPropagation();const hidden=noticeDropdown?.classList.contains('hidden');if(!hidden){noticeDropdown.classList.add('hidden');return}noticeDropdown?.classList.remove('hidden');noticeDropdownList.innerHTML='<div class="notice-item"><strong>Carregando avisos...</strong><p>Buscando ultimas noticias do painel admin.</p></div>';try{const notices=await refreshNoticeIndicator();showNoticeDropdown(notices,false);const latest=notices[0]&&(notices[0].id||notices[0].createdAt||notices[0].updatedAt);if(latest)localStorage.setItem('ninjaflix:lastNoticeRead',latest);document.querySelector('#noticeButton')?.classList.remove('has-unread');noticeDropdown?.classList.remove('auto-open')}catch(err){noticeDropdownList.innerHTML='<div class="notice-item"><strong>Nao foi possvel carregar</strong><p>'+err.message+'</p></div>'}}document.addEventListener('click',e=>{const tag=e.target.closest('.status-tag');document.querySelectorAll('.status-tag.show-tip').forEach(x=>{if(x!==tag)x.classList.remove('show-tip')});if(tag){tag.classList.toggle('show-tip')}});adspowerHealth?.addEventListener('click',()=>{if(adspowerHealth.className.includes('offline'))tryStartAdspower()});kernelStatus?.addEventListener('click',e=>{if(e.target.closest('[data-kernel-action="connect-adspower"]'))tryStartAdspower()});document.querySelectorAll('[data-panel]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-panel]').forEach(x=>x.classList.toggle('active',x===b));}));document.querySelectorAll('[data-launch]').forEach(b=>b.addEventListener('click',()=>openLaunch(b.dataset.launch)));document.querySelector('#noticeButton').addEventListener('click',openNotices);supportTicketForm?.addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));try{await req('/support-tickets',{method:'POST',body:JSON.stringify(data)});e.currentTarget.reset();await loadSupportTickets();show('Solicitação enviada ao suporte.')}catch(err){alert(err.message)}});document.querySelectorAll('[data-close-modal]').forEach(b=>b.addEventListener('click',()=>closeModal(document.querySelector('#'+b.dataset.closeModal))));document.querySelectorAll('.modal-backdrop').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)closeModal(m)}));categoryList.addEventListener('click',e=>{const b=e.target.closest('button[data-cat]');if(!b)return;activeCategory=b.dataset.cat;renderCategories();renderProfiles()});toolSearch?.addEventListener('input',renderProfiles);document.querySelector('#refreshProfiles').addEventListener('click',async()=>{try{await loadProfiles();await checkAdspower()}catch(e){show(e.message)}});document.querySelector('#profileLogoutButton').addEventListener('click',async()=>{await req('/logout',{method:'POST'});profileDropdown.classList.add('hidden');await boot()});profileButton.addEventListener('click',e=>{e.stopPropagation();profileDropdown.classList.toggle('hidden')});document.addEventListener('click',e=>{if(!e.target.closest('.profile-wrap'))profileDropdown.classList.add('hidden');if(!e.target.closest('.notice-wrap'))noticeDropdown?.classList.add('hidden')});document.addEventListener('click',e=>{const item=e.target.closest('[data-notice-index]');if(item&&window.__lastNotices){e.preventDefault();e.stopPropagation();openNoticeFull(window.__lastNotices[Number(item.dataset.noticeIndex)]||{})}const support=e.target.closest('[data-open-support-page]');if(support){e.preventDefault();openLaunch('suporte')}});document.addEventListener('visibilitychange',()=>{if(!document.hidden)lastVisibleAt=Date.now()});window.addEventListener('focus',()=>{lastVisibleAt=Date.now()});document.querySelector('#activationForm').addEventListener('submit',async e=>{e.preventDefault();try{document.querySelectorAll('.machine-support-box').forEach(x=>x.remove());const data=Object.fromEntries(new FormData(e.currentTarget));data.email=String(data.email||'').trim().toLowerCase();const out=await req('/customer-login',{method:'POST',body:JSON.stringify({email:data.email})});show(out);await boot()}catch(err){showMachineSupport(err.message)}});profilesList.addEventListener('click',async e=>{const upgrade=e.target.closest('button[data-upgrade]');if(upgrade){await openLaunch('upgrade');return}const opt=e.target.closest('button[data-option-act]');if(opt){const cardId=opt.dataset.cardId,profileId=opt.dataset.optionId,act=opt.dataset.optionAct;busyProfile=cardId+':'+profileId;busyAction=act;optionMenu=cardId;renderProfiles();try{await refreshProfilesSilent();const latest=findLatestProfile(cardId,profileId);const latestOpt=(latest.profileOptions||[]).find(o=>o.profileId===profileId)||{};const freshId=latestOpt.profileId||profileId;const launchUrl=latest.startUrl||latest.initialUrl||latest.launchUrl||'';busyProfile=cardId+':'+freshId;if(act==='open')await maybeShowKernelUpdate();const out=await req('/'+act,{method:'POST',body:JSON.stringify({profileId:freshId,cardKey:cardId,launchUrl})});if(act==='open'){const openedId=String(out.profileId||freshId);openedProfileIds.set(cardId,openedId);activeProfileCardKey=cardId;activeProfileId=openedId;states.set(cardId,'open');ensureStatusRefreshTimer();setKernelStatus('ready','Perfil pronto para uso','Seu perfil está aberto e pronto para você usar.') }if(act==='close'){openedProfileIds.delete(cardId);if(activeProfileCardKey===cardId){activeProfileCardKey='';activeProfileId=''}states.set(cardId,'closed')}optionMenu=cardId;show(out)}catch(err){setKernelStatus('error','Falha ao abrir perfil',err.message);show(err.message)}finally{busyProfile='';busyAction='';if(optionMenu)renderProfiles()}return}const b=e.target.closest('button[data-act]');if(!b||b.disabled)return;if(b.dataset.act==='open-options'){await refreshProfilesSilent();optionMenu=b.dataset.id;renderProfiles();return}if(b.dataset.act==='close-options'){optionMenu='';renderProfiles();return}busyProfile=b.dataset.id;busyAction=b.dataset.act;optionMenu='';renderProfiles();try{await refreshProfilesSilent();const latest=findLatestProfile(b.dataset.id,b.dataset.id);const opts=Array.isArray(latest.profileOptions)?latest.profileOptions:[];if(b.dataset.act==='open'&&opts.length>1){optionMenu=b.dataset.id;busyProfile='';busyAction='';renderProfiles();return}const targetId=b.dataset.act==='close'?(openedProfileIds.get(b.dataset.id)||latest.profileId||b.dataset.id):(latest.profileId||b.dataset.id);const launchUrl=latest.startUrl||latest.initialUrl||latest.launchUrl||'';busyProfile=b.dataset.id;if(b.dataset.act==='open')await maybeShowKernelUpdate();const out=await req('/'+b.dataset.act,{method:'POST',body:JSON.stringify({profileId:targetId,cardKey:b.dataset.id,launchUrl})});if(b.dataset.act==='open'){const openedId=String(out.profileId||targetId);openedProfileIds.set(b.dataset.id,openedId);activeProfileCardKey=b.dataset.id;activeProfileId=openedId;states.set(b.dataset.id,'open');ensureStatusRefreshTimer();setKernelStatus('ready','Perfil pronto para uso','Seu perfil está aberto e pronto para você usar.') }if(b.dataset.act==='close'){openedProfileIds.delete(b.dataset.id);if(activeProfileCardKey===b.dataset.id){activeProfileCardKey='';activeProfileId=''}states.set(b.dataset.id,'closed')}if(b.dataset.act==='status'){const st=statusFrom(out);states.set(b.dataset.id,st);updateProfileCardOnly(b.dataset.id,st)}show(out)}catch(err){setKernelStatus('error','Falha ao abrir perfil',err.message);show(err.message)}finally{busyProfile='';busyAction='';if(optionMenu)renderProfiles();else if(b?.dataset?.id)updateProfileCardOnly(b.dataset.id,states.get(b.dataset.id)||'closed')}});document.querySelector('#debugButton')?.addEventListener('click',async()=>{try{document.querySelector('#debugBox').textContent=JSON.stringify(await req('/debug'),null,2)}catch(e){document.querySelector('#debugBox').textContent=e.message}});boot();
  </script>
  <script>
    function profileIsAvailable(profile){
      return !(profile&&(profile.available===false||profile.available==='false'||profile.canOpen===false||profile.canOpen==='false'||profile.unavailable===true||profile.unavailable==='true'));
    }
    function profileCategories(profile){
      const names=Array.isArray(profile?.categoryNames)&&profile.categoryNames.length?profile.categoryNames:[profile?.category||'Geral'];
      return names.map(name=>String(name||'').trim()).filter(Boolean);
    }
    function profileMatchesCategory(profile,category){
      return category==='Todas'||profileCategories(profile).includes(category);
    }
    function uniqueProfilesWithCategories(profiles=currentProfiles){
      const unique=new Map();
      (profiles||[]).forEach((profile,index)=>{
        const identity=String(profile?.sourceProfileId||profile?.id||profile?.cardKey||((profile?.name||'perfil')+'::'+(profile?.profileId||index)));
        const previous=unique.get(identity);
        if(!previous){
          unique.set(identity,{...profile,categoryNames:Array.from(new Set(profileCategories(profile)))});
          return;
        }
        const categoryNames=Array.from(new Set([...profileCategories(previous),...profileCategories(profile)]));
        const preferred=profileIsAvailable(previous)||!profileIsAvailable(profile)?previous:profile;
        unique.set(identity,{...preferred,categoryNames});
      });
      return Array.from(unique.values());
    }
    function renderCategories(){
      const byName=new Map([['Todas',{name:'Todas',icon:''}]]);
      (currentCategories||[]).forEach(category=>{
        const name=String(category?.name||'').trim();
        if(name&&category?.mode!=='special_group')byName.set(name,{name,icon:String(category?.icon||'').trim()});
      });
      const uniqueProfiles=uniqueProfilesWithCategories();
      uniqueProfiles.forEach(profile=>{
        profileCategories(profile).forEach(name=>{
          if(!byName.has(name))byName.set(name,{name,icon:String(profile.categoryIcon||'').trim()});
        });
      });
      if(activeCategory!=='Todas'&&!byName.has(activeCategory))activeCategory='Todas';
      const categories=Array.from(byName.values());
      const count=category=>uniqueProfiles.filter(profile=>profileIsAvailable(profile)&&profileMatchesCategory(profile,category)).length;
      categoryList.innerHTML=categories.map(category=>
        '<button class="cat-button '+(category.name===activeCategory?'active':'')+'" data-cat="'+esc(category.name)+'">'+
        '<span class="cat-icon">'+(category.name==='Todas'?categoryIcon(category.name):(category.icon?customCategoryIcon(category.icon,category.name):categoryIcon(category.name)))+'</span>'+
        '<span class="cat-name">'+esc(category.name)+'</span><span class="cat-count">'+count(category.name)+'</span></button>'
      ).join('');
    }
    function unavailableProfileText(profile){
      const plans=Array.isArray(profile?.availablePlans)
        ?profile.availablePlans.filter(Boolean).join(', ')
        :String(profile?.availablePlans||'').trim();
      return 'Dispon\u00edvel no plano: '+(plans||profile?.packageName||'outro plano');
    }
    const profilePreferenceKey='ninjaflix:profile-preferences:v1';
    function profilePreferences(){try{return JSON.parse(localStorage.getItem(profilePreferenceKey)||'{"favorites":[],"usage":{}}')}catch{return {favorites:[],usage:{}}}}
    function saveProfilePreferences(value){localStorage.setItem(profilePreferenceKey,JSON.stringify(value))}
    function isFavoriteProfile(key){return profilePreferences().favorites.includes(String(key))}
    function profileUsageScore(key){
      const prefs=profilePreferences(),usage=prefs.usage||{},entries=Object.values(usage),total=entries.reduce((sum,item)=>sum+Number(item?.count||0),0);
      if(total<8)return 0;
      const mean=total/Math.max(1,entries.length),item=usage[String(key)]||{};
      return (Number(item.count||0)+(mean*5))/6;
    }
    function rememberProfileUse(key){const prefs=profilePreferences();prefs.usage=prefs.usage||{};const item=prefs.usage[String(key)]||{count:0};item.count=Number(item.count||0)+1;item.lastUsedAt=Date.now();prefs.usage[String(key)]=item;saveProfilePreferences(prefs)}
    function renderProfiles(){
      const query=String(toolSearch?.value||'').trim().toLocaleLowerCase('pt-BR');
      const uniqueProfiles=uniqueProfilesWithCategories();
      const list=uniqueProfiles
        .filter(profile=>query||(activeCategory==='Todas'?profileIsAvailable(profile):profileMatchesCategory(profile,activeCategory)))
        .filter(profile=>{
          if(!query)return true;
          const searchable=[profile.name,profile.description,profile.subtitle,...profileCategories(profile)].join(' ').toLocaleLowerCase('pt-BR');
          return searchable.includes(query);
        })
        .map((profile,index)=>({profile,index}))
        .sort((a,b)=>
          Number(!profileIsAvailable(a.profile))-Number(!profileIsAvailable(b.profile))||
          Number(!isFavoriteProfile(profileKey(a.profile)))-Number(!isFavoriteProfile(profileKey(b.profile)))||
          profileUsageScore(profileKey(b.profile))-profileUsageScore(profileKey(a.profile))||
          String(a.profile.name||'').localeCompare(String(b.profile.name||''),'pt-BR',{sensitivity:'base'})||
          a.index-b.index
        )
        .map(entry=>entry.profile);
      if(toolsSubtitle)toolsSubtitle.textContent=list.length+' ferramenta'+(list.length===1?'':'s');

      function cardHtml(profile){
        const cardKey=profileKey(profile);
        const available=profileIsAvailable(profile);
        const state=available
          ?(busyProfile===cardKey?(busyAction==='close'?'closing':'opening'):(states.get(cardKey)||'closed'))
          :'unavailable';
        const busy=['busy','opening','closing'].includes(state);
        const open=state==='open';
        const maintenanceMinutes=profile.maintenanceUntil?Math.max(0,Math.ceil((new Date(profile.maintenanceUntil).getTime()-Date.now())/60000)):0;
        const maintenanceTime=maintenanceMinutes?(Math.floor(maintenanceMinutes/60)?Math.floor(maintenanceMinutes/60)+'h'+(maintenanceMinutes%60?' '+(maintenanceMinutes%60)+'min':''):maintenanceMinutes+'min'):'';
        const description=profile.description||profile.subtitle||'Descri\u00e7\u00e3o n\u00e3o informada';
        const descriptionHtml=profile.maintenance?('Em breve no ar!'+(maintenanceTime?' <strong>'+esc(maintenanceTime+' restantes')+'</strong>':'')):esc(available?description:unavailableProfileText(profile));
        const accent=available?(profile.accentColor||'#8b5cf6'):'#64748b';
        const gradient=available
          ?(profile.iconGradient||('linear-gradient(135deg,'+accent+','+(profile.accentColor2||'#4f46e5')+')'))
          :'linear-gradient(135deg,#64748b,#334155)';
        const options=Array.isArray(profile.profileOptions)?profile.profileOptions:[];
        const hasOptions=available&&options.length>1;
        const menuOpen=hasOptions&&optionMenu===cardKey;
        const unavailableMessage=unavailableProfileText(profile);
        const optionsHtml=menuOpen
          ?'<div class="profile-options-wrap"><button type="button" class="options-close-float" data-act="close-options" data-id="'+esc(cardKey)+'" aria-label="Fechar op\u00e7\u00f5es" title="Fechar">&times;</button><div class="profile-options">'+
            options.map((option,index)=>{
              const optionId=String(option.profileId||'');
              const isOpen=openedProfileIds.get(cardKey)===optionId;
              const isBusy=busyProfile===cardKey+':'+optionId;
              return '<div class="option-row"><button type="button" class="option-open" data-option-act="open" data-option-id="'+esc(optionId)+'" data-card-id="'+esc(cardKey)+'" '+(isBusy||isOpen?'disabled':'')+'>'+
                (isBusy&&busyAction==='open'?'Abrindo...':isOpen?'Aberto':('Op\u00e7\u00e3o '+(index+1)))+
                '</button><button type="button" class="option-close" data-option-act="close" data-option-id="'+esc(optionId)+'" data-card-id="'+esc(cardKey)+'" '+(isBusy||!isOpen?'disabled':'')+'>'+
                (isBusy&&busyAction==='close'?'Fechando...':'Fechar')+'</button></div>';
            }).join('')+'</div></div>'
          :'';
        const buttonsHtml=menuOpen?'':(
          '<button class="action-pill open" data-act="'+(hasOptions?'open-options':'open')+'" data-id="'+esc(cardKey)+'" '+(!hasOptions&&(busy||open)?'disabled':'')+'>'+
          (state==='opening'?'Abrindo...':open?'Aberto':'Abrir')+'</button>'+
          '<button class="action-pill close" data-act="close" data-id="'+esc(cardKey)+'" '+(hasOptions?'disabled':((state!=='open'&&state!=='closing')?'disabled':''))+'>'+
          (state==='closing'?'Fechando...':'Fechar')+'</button>'
        );
        const actionsHtml=available
          ?buttonsHtml+optionsHtml
          :'<button type="button" class="action-pill upgrade-pill" data-upgrade="1">Upgrade</button>';
        return '<div class="profile-card '+(menuOpen?'options-open ':'')+(available?'':'unavailable')+'" data-card-key="'+esc(cardKey)+'" data-profile-id="'+esc(profile.profileId||'')+'" data-tag-label="'+esc(profile.tagLabel||profile.tag||profile.badge||'novo')+'" data-unavailable-message="'+esc(unavailableMessage)+'" title="" style="--tool-accent:'+accent+';--tool-gradient:'+gradient+'">'+
          '<div class="tool-card-top"><button type="button" class="favorite-toggle '+(isFavoriteProfile(cardKey)?'is-favorite':'')+'" data-favorite-profile="'+esc(cardKey)+'" aria-label="'+(isFavoriteProfile(cardKey)?'Remover dos favoritos':'Adicionar aos favoritos')+'" title="Favoritar">&#9733;</button>'+
          '<span class="tool-badge '+(available?tagClass(state):'unavailable')+'">'+(available?tagText(profile,state):'INDISPON\u00cdVEL')+'</span></div>'+
          (menuOpen?'':'<div class="tool-icon">'+profileIcon(profile.name)+'</div>')+
          '<div class="tool-meta"><div class="tool-title">'+esc(profile.name)+'</div><small class="muted">'+descriptionHtml+'</small>'+
          (available?'<div class="profile-state '+state+'"><span class="dot"></span>'+profileStateLabel(state)+'</div>':'')+
          '</div><div class="profile-actions">'+actionsHtml+'</div></div>';
      }
      function sectionHtml(title,items){
        return items.length?'<section class="tool-section"><h2 class="tool-section-title">'+esc(title)+'</h2><div class="tools-grid">'+items.map(cardHtml).join('')+'</div></section>':'';
      }
      if(!list.length){
        profilesList.innerHTML='<div class="empty">Nenhuma ferramenta encontrada.</div>';
        return;
      }
      if(activeCategory==='Todas'||query){
        const favorites=list.filter(profile=>isFavoriteProfile(profileKey(profile)));
        const featured=list.filter(profile=>profile.featured&&!isFavoriteProfile(profileKey(profile)));
        const regular=list.filter(profile=>!profile.featured&&!isFavoriteProfile(profileKey(profile)));
        const categoryOrder=(currentCategories||[]).map(category=>String(category?.name||'').trim()).filter(Boolean);
        const categories=Array.from(new Set([...categoryOrder,...regular.flatMap(profileCategories)]));
        const rendered=new Set();
        const sections=categories.map(category=>{
          const items=regular.filter(profile=>profileMatchesCategory(profile,category)&&!rendered.has(profileKey(profile)));
          items.forEach(profile=>rendered.add(profileKey(profile)));
          return sectionHtml(category,items);
        }).join('');
        profilesList.innerHTML=sectionHtml('Favoritos',favorites)+sectionHtml('Destaque',featured)+sections;
        return;
      }
      profilesList.innerHTML='<div class="featured-label">'+esc(activeCategory)+'</div><div class="tools-grid">'+list.map(cardHtml).join('')+'</div>';
    }

    function normalizeOptionsCloseButtons(){
      document.querySelectorAll('.profile-card.options-open').forEach(card=>{
        const options=card.querySelector('.profile-options');
        const close=card.querySelector('[data-act="close-options"]');
        if(!options||!close)return;
        let wrapper=options.closest('.profile-options-wrap');
        if(!wrapper){
          wrapper=document.createElement('div');
          wrapper.className='profile-options-wrap';
          options.before(wrapper);
          wrapper.append(options);
        }
        if(close.parentElement!==wrapper)wrapper.prepend(close);
        close.className='options-close-float';
        if(close.textContent!=='\u00d7')close.textContent='\u00d7';
        close.setAttribute('aria-label','Fechar opções');
        close.setAttribute('title','Fechar');
      });
    }
    new MutationObserver(normalizeOptionsCloseButtons).observe(profilesList,{childList:true,subtree:true});

    toolSearch?.addEventListener('input',event=>{
      event.stopImmediatePropagation();
      renderProfiles();
    },true);

    showExpiredSubscription=function(user){
      currentProfiles=[];
      activeCategory='Todas';
      renderCategories();
      const validity=applyUserSubscription(user)||'vencida';
      if(toolsTitle)toolsTitle.textContent='Assinatura vencida';
      if(toolsSubtitle)toolsSubtitle.textContent='Regularize sua assinatura para voltar a acessar os perfis.';
      if(toolSearch)toolSearch.disabled=true;
      profilesList.innerHTML='<div class="expired-subscription"><strong>Acesso bloqueado</strong><h2>Assinatura vencida</h2><div class="expired-date">Validade: '+esc(validity)+'</div><p>Sua assinatura venceu e os perfis foram ocultados por seguran\u00e7a. Regularize o pagamento para liberar novamente as ferramentas.</p><div class="profile-actions"><a target="_self" data-internal-nav="financeiro" href="'+esc(shellConfig.pages?.financeiro||'https://cliente.ninjaflix.club/financeiro')+'">Ir para o financeiro</a><a target="_self" data-internal-nav="suporte" href="'+esc(shellConfig.pages?.suporte||'https://cliente.ninjaflix.club/suporte')+'">Chamar suporte</a></div></div>';
      setAccessStatus('Assinatura vencida. Regularize no financeiro para continuar.');
    };
    showMachineSupport=function(message){
      const safeMessage=fixStatusEncoding(message||'Máquina bloqueada. Regularize o acesso para continuar.');
      if(/m[aá]quina bloqueada|dispositivo bloqueado|bloquead[ao]/i.test(safeMessage)){
        renderAgentAccessIssue({code:'machine_blocked',message:safeMessage},null);
        return;
      }
      const html='<div class="machine-support-box"><strong>'+esc(safeMessage)+'</strong><span>Você ainda pode acessar o financeiro ou falar com o suporte.</span><div class="profile-actions"><a target="_self" data-internal-nav="financeiro" href="'+esc(shellConfig.pages?.financeiro||'https://cliente.ninjaflix.club/financeiro')+'">Abrir financeiro</a><a target="_self" data-internal-nav="suporte" href="'+esc(shellConfig.pages?.suporte||'https://cliente.ninjaflix.club/suporte')+'">Chamar suporte</a></div></div>';
      document.querySelectorAll('.machine-support-box').forEach(element=>element.remove());
      if(activationCard&&!activationCard.classList.contains('hidden'))activationCard.insertAdjacentHTML('beforeend',html);
      else if(profilesList)profilesList.innerHTML=html;
      setKernelStatus('error','Máquina bloqueada',safeMessage,'');
    };

    const requestWithHealthSnapshot=req;
    req=async function(requestPath,options={}){
      const response=await requestWithHealthSnapshot(requestPath,options);
      if(requestPath==='/health'){
        window.__lastAgentHealth=response;
        window.__lastAgentHealthAt=Date.now();
      }
      return response;
    };
    function handleInitialHealth(health){
        if(health?.accessIssue){renderAgentAccessIssue(health.accessIssue,health.user);window.markAgentContentReady('access-issue')}
        else if(!health?.user)window.markAgentContentReady('login');
        else{
          let attempts=0;
          const waitForInitialProfiles=()=>{
            if(profilesList?.children?.length){window.markAgentContentReady('initial-profiles');return}
            attempts+=1;
            if(attempts<150)setTimeout(waitForInitialProfiles,100);
            else window.markAgentContentReady('initial-profiles-timeout');
          };
          waitForInitialProfiles();
        }
    }
    setTimeout(()=>{
      if(window.__lastAgentHealth){handleInitialHealth(window.__lastAgentHealth);return}
      req('/health').then(handleInitialHealth).catch(()=>window.markAgentContentReady('health-error'));
    },900);

    function renderAgentAccessIssue(issue,user){
      const message=fixStatusEncoding(String(issue?.message||'Não foi possível liberar este dispositivo.'));
      const subscriptionCode=String(issue?.code||'').toLowerCase();
      const isSubscriptionIssue=Number(issue?.status)===402||['subscription_expired','subscription_inactive','subscription_not_found','customer_inactive'].includes(subscriptionCode)||/assinatura (vencida|inativa)|pagamento\\/assinatura/i.test(message);
      if(isSubscriptionIssue){
        document.querySelector('#activationCard')?.classList.add('hidden');
        document.body.classList.remove('login-mode');
        document.querySelector('#agentCard')?.classList.remove('hidden');
        showExpiredSubscription(user||{});
        setBadge(bindBadge,'warn','Assinatura','Acesso',message);
        setKernelStatus('','','','');
        return;
      }
      const isOtherDevice=issue?.code==='machine_limit_reached'||issue?.code==='machine_mismatch';
      const isAdminBlocked=issue?.code==='machine_blocked';
      const title=isOtherDevice?'Dispositivo em uso em outra máquina':isAdminBlocked?'Dispositivo bloqueado':'Dispositivo offline';
      document.querySelector('#activationCard')?.classList.add('hidden');
      document.body.classList.remove('login-mode');
      document.querySelector('#agentCard')?.classList.remove('hidden');
      if(user){document.querySelector('#profileName').textContent=user.name||'Cliente';document.querySelector('#profileEmail').textContent=user.email||'-'}
      if(toolsTitle)toolsTitle.textContent=title;
      if(toolsSubtitle)toolsSubtitle.textContent='Os perfis foram ocultados até a regularização do acesso.';
      if(toolSearch)toolSearch.disabled=true;
      if(categoryList)categoryList.innerHTML='';
      if(profilesList)profilesList.innerHTML='<div class="expired-subscription"><strong>Acesso indisponível</strong><h2>'+esc(title)+'</h2><p>'+esc(message)+'</p><div class="profile-actions"><a target="_self" data-internal-nav="financeiro" href="'+esc(shellConfig.pages?.financeiro||'https://cliente.ninjaflix.club/financeiro')+'">Abrir financeiro</a><a target="_self" data-internal-nav="suporte" href="'+esc(shellConfig.pages?.suporte||'https://cliente.ninjaflix.club/suporte')+'">Chamar suporte</a></div></div>';
      setAccessStatus(message);
      setBadge(bindBadge,'offline','Dispositivo','Aparelho',message);
      setKernelStatus('error',title,message,'');
    }
    const loadProfilesWithAccessGuard=loadProfiles;
    loadProfiles=async function(){
      const health=Date.now()-Number(window.__lastAgentHealthAt||0)<30000?window.__lastAgentHealth:null;
      if(health?.accessIssue){
        renderAgentAccessIssue(health.accessIssue,health.user);
        return;
      }
      return loadProfilesWithAccessGuard();
    };
    const requestBeforeLoginDelay=req;
    req=async function(requestPath,options={}){
      if(requestPath!=='/customer-login')return requestBeforeLoginDelay(requestPath,options);
      const started=Date.now();
      try{return await requestBeforeLoginDelay(requestPath,options)}
      finally{
        const wait=Math.max(500,2000-(Date.now()-started));
        await new Promise(resolve=>setTimeout(resolve,wait));
      }
    };
    (function setupBlockingLoginGate(){
      if(!activationCard)return;
      activationCard.classList.add('login-gate');
      activationCard.innerHTML='<div class="login-gate-card"><div class="login-gate-brand"><img src="/logo-roxo.svg" alt="NinjaFlix" /><span>NinjaFlix</span></div><h1>Entre no seu painel</h1><p class="login-gate-copy">Use exatamente o mesmo e-mail cadastrado no momento da compra.</p><form id="activationForm" class="login-form"><label for="activationEmail">E-mail da compra</label><input id="activationEmail" name="email" type="email" autocomplete="email" placeholder="seuemail@exemplo.com" required /><button type="submit"><span class="login-button-label">Entrar e vincular dispositivo</span></button></form><div class="login-validation hidden" role="status" aria-live="polite"><div class="login-validation-head"><span class="login-validation-spinner"></span><strong class="login-validation-title">Validando acesso...</strong></div><p class="login-validation-message">Confirmando sua conta e este dispositivo.</p><div class="login-validation-track"><span class="login-validation-progress"></span></div></div><p class="login-gate-error hidden" role="alert"></p><small>O painel somente será liberado depois que a conta e o dispositivo estiverem confirmados.</small></div>';
      const style=document.createElement('style');
      style.textContent='#activationCard.login-gate{position:fixed!important;inset:0!important;z-index:2400!important;width:100%!important;height:100vh!important;margin:0!important;padding:24px!important;display:grid!important;place-items:center!important;background:rgba(3,4,11,.82)!important;backdrop-filter:blur(14px)!important}#activationCard.login-gate.hidden:not(.login-validating){display:none!important}#activationCard.login-gate.login-validating{display:grid!important}.login-gate-card{width:min(520px,calc(100vw - 32px));border:1px solid rgba(168,85,247,.55);border-radius:26px;background:linear-gradient(145deg,rgba(24,23,45,.98),rgba(12,13,28,.98));box-shadow:0 30px 100px rgba(0,0,0,.62),0 0 45px rgba(168,85,247,.14);padding:34px}.login-gate-brand{display:flex;align-items:center;gap:10px;margin-bottom:24px;color:#e9d5ff;font-size:16px;font-weight:900}.login-gate-brand img{width:34px;height:34px}.login-gate-card h1{margin:0;color:#f5f3ff;font-size:30px;letter-spacing:-.04em}.login-gate-copy{margin:10px 0 25px;color:#b7b6c9;font-size:15px;line-height:1.5}.login-gate .login-form{display:grid!important;gap:10px!important}.login-gate .login-form label{color:#ddd6fe;font-size:12px;font-weight:800}.login-gate .login-form input{height:52px!important;border:1px solid rgba(168,85,247,.46)!important;border-radius:15px!important;background:#0b0d19!important;padding:0 16px!important;font-size:15px!important;box-shadow:inset 0 0 0 1px rgba(255,255,255,.02)}.login-gate .login-form input:focus{border-color:#c084fc!important;box-shadow:0 0 0 3px rgba(168,85,247,.18)!important}.login-gate .login-form button{height:52px!important;margin-top:5px!important;border:0!important;border-radius:15px!important;background:linear-gradient(135deg,#b55cff,#7c3aed)!important;color:#fff!important;font-size:14px!important;box-shadow:0 14px 34px rgba(124,58,237,.3)!important}.login-gate .login-form button:disabled{opacity:.7!important}.login-validation{margin-top:18px;padding:15px;border:1px solid rgba(168,85,247,.3);border-radius:16px;background:rgba(168,85,247,.07)}.login-validation-head{display:flex;align-items:center;gap:10px}.login-validation-spinner{width:18px;height:18px;border:2px solid rgba(255,255,255,.2);border-top-color:#c084fc;border-radius:999px;animation:spin .75s linear infinite}.login-validation-message{margin:7px 0 12px;color:#aaa8bf;font-size:12px}.login-validation-track{height:4px;overflow:hidden;background:rgba(255,255,255,.1)}.login-validation-progress{display:block;width:12%;height:100%;background:linear-gradient(90deg,#8b5cf6,#c084fc,#f0abfc);transition:width .4s ease}.login-gate-error{margin:16px 0 0;padding:12px 14px;border:1px solid rgba(251,113,133,.45);border-radius:14px;background:rgba(251,113,133,.09);color:#fecdd3;line-height:1.4}.login-gate-card>small{display:block;margin-top:18px;color:#77768b;line-height:1.4}@media(max-width:600px){.login-gate-card{padding:25px}.login-gate-card h1{font-size:25px}}';
      style.textContent+='body.login-mode .agent-top{display:none!important}body.login-mode .shell{min-height:100vh!important;padding:0!important}body.login-mode #activationCard.login-gate{background:#03040b!important;backdrop-filter:none!important}';
      document.head.append(style);
      const form=activationCard.querySelector('#activationForm');
      const input=form.querySelector('input[name="email"]');
      const button=form.querySelector('button[type="submit"]');
      const label=button.querySelector('.login-button-label');
      const validation=activationCard.querySelector('.login-validation');
      const validationTitle=activationCard.querySelector('.login-validation-title');
      const validationMessage=activationCard.querySelector('.login-validation-message');
      const progress=activationCard.querySelector('.login-validation-progress');
      const errorBox=activationCard.querySelector('.login-gate-error');
      function loginProgress(percent,title,message){progress.style.width=Math.max(8,Math.min(100,percent))+'%';validationTitle.textContent=title;validationMessage.textContent=message}
      async function waitForAuthorizedHealth(){
        let lastHealth=null;
        for(let attempt=0;attempt<30;attempt+=1){
          lastHealth=await fetch('/health',{cache:'no-store'}).then(response=>response.json());
          const issueCode=String(lastHealth?.accessIssue?.code||'').toLowerCase();
          const subscriptionIssue=['subscription_expired','subscription_inactive','subscription_not_found','customer_inactive'].includes(issueCode);
          if(lastHealth?.authenticated&&lastHealth?.user&&(lastHealth?.machineAuthorized||subscriptionIssue))return lastHealth;
          if(lastHealth?.accessIssue&&!subscriptionIssue)throw new Error(fixStatusEncoding(lastHealth.accessIssue.message||'Este dispositivo não foi autorizado.'));
          loginProgress(45+Math.min(35,attempt*2),'Confirmando dispositivo...','Aguardando a confirmação segura desta máquina.');
          await new Promise(resolve=>setTimeout(resolve,250));
        }
        throw new Error(fixStatusEncoding(lastHealth?.error||'Não foi possível confirmar o dispositivo. Tente novamente.'));
      }
      form.addEventListener('submit',async event=>{
        event.preventDefault();
        event.stopImmediatePropagation();
        const email=String(input.value||'').trim().toLowerCase();
        if(!email||!input.checkValidity()){input.reportValidity();return}
        activationCard.classList.add('login-validating');
        activationCard.classList.remove('hidden');
        document.body.classList.add('login-mode');
        input.disabled=true;button.disabled=true;label.textContent='Validando acesso...';errorBox.classList.add('hidden');validation.classList.remove('hidden');
        loginProgress(15,'Validando seu e-mail...','Consultando o cadastro realizado na compra.');
        try{
          await req('/customer-login',{method:'POST',body:JSON.stringify({email})});
          loginProgress(42,'Conta encontrada','Agora estamos confirmando este dispositivo.');
          await waitForAuthorizedHealth();
          loginProgress(82,'Dispositivo confirmado','Carregando seu plano e suas ferramentas.');
          await boot();
          for(let attempt=0;attempt<40&&!profilesList?.children?.length;attempt+=1)await new Promise(resolve=>setTimeout(resolve,100));
          loginProgress(100,'Tudo pronto!','Dispositivo online e painel carregado.');
          await new Promise(resolve=>setTimeout(resolve,450));
          activationCard.classList.remove('login-validating');
          activationCard.classList.add('hidden');
          document.body.classList.remove('login-mode');
        }catch(error){
          activationCard.classList.remove('login-validating');
          activationCard.classList.remove('hidden');
          document.body.classList.add('login-mode');
          validation.classList.add('hidden');errorBox.textContent=fixStatusEncoding(error.message||'Não foi possível entrar.');errorBox.classList.remove('hidden');
        }finally{input.disabled=false;button.disabled=false;label.textContent='Entrar e vincular dispositivo'}
      },true);
    })();
    function fixStatusEncoding(value){
      let text=String(value||'');
      for(let pass=0;pass<2&&/[\u00c2\u00c3]/u.test(text);pass+=1){
        try{
          const bytes=Uint8Array.from(Array.from(text),char=>char.charCodeAt(0));
          const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
          if(decoded===text)break;
          text=decoded;
        }catch{break}
      }
      return text;
    }
    const fixStatusEncodingBase=fixStatusEncoding;
    fixStatusEncoding=function(value){return fixStatusEncodingBase(value)};
    const setKernelStatusEncoded=setKernelStatus;
    setKernelStatus=function(kind,title,message,action){let safeMessage=fixStatusEncoding(message);if(kind==='error'&&/(parsererror|unexpectedtoken|categoryinfo|fullyqualifiederrorid|powershell|no linha:|appdata\\\\)/i.test(safeMessage))safeMessage='Não foi possível concluir a preparação. Tente novamente. Se o problema continuar, chame o suporte.';const result=setKernelStatusEncoded(kind,fixStatusEncoding(title),safeMessage,action);if(kind==='ready')window.finishKernelInstallOverlay?.(true);if(kind==='error')window.finishKernelInstallOverlay?.(false);return result};
    maybeShowKernelUpdate=async function(){
      try{
        const plan=await req('/kernel-plan',{method:'POST',body:JSON.stringify({})});
        if(plan?.installed)setKernelStatus('progress','Abrindo seu perfil','Aguarde alguns instantes enquanto abrimos sua ferramenta.');
        else setKernelStatus('progress','Primeira preparação do navegador','Estamos instalando os arquivos necessários. Isso acontece somente na primeira vez e as próximas aberturas serão mais rápidas.');
        return plan;
      }catch(_error){return null}
    };
    const renderProfilesWithMaintenance=renderProfiles;
    function maintenanceRemaining(profile){const minutes=profile?.maintenanceUntil?Math.max(0,Math.ceil((new Date(profile.maintenanceUntil).getTime()-Date.now())/60000)):0;if(!minutes)return'';const hours=Math.floor(minutes/60),rest=minutes%60;return hours?hours+'h'+(rest?' '+rest+'min':''):minutes+'min'}
    function applyMaintenanceCard(profile,card){const minutes=profile?.maintenanceUntil?Math.max(0,Math.ceil((new Date(profile.maintenanceUntil).getTime()-Date.now())/60000)):0;card.classList.add('maintenance');const badge=card.querySelector('.tool-badge'),badgeText=minutes?minutes+'min':'Manutenção';if(badge&&badge.textContent!==badgeText)badge.textContent=badgeText;const description=card.querySelector('.tool-meta small'),remaining=maintenanceRemaining(profile),descriptionMarkup='Em breve no ar!'+(remaining?' <strong>'+esc(remaining+' restantes')+'</strong>':'');if(description&&description.innerHTML!==descriptionMarkup)description.innerHTML=descriptionMarkup;const actions=card.querySelector('.profile-actions'),maintenanceMarkup='<span class="maintenance-label">&#128295; Manuten&ccedil;&atilde;o</span>';if(actions&&!actions.querySelector('.maintenance-label'))actions.innerHTML=maintenanceMarkup}
    renderProfiles=function(){renderProfilesWithMaintenance();(currentProfiles||[]).filter(profile=>profile&&profile.maintenance).forEach(profile=>{const key=profileKey(profile);document.querySelectorAll('[data-card-key="'+CSS.escape(key)+'"]').forEach(card=>applyMaintenanceCard(profile,card))});window.markAgentContentReady?.('profiles-rendered')};
    function enforceMaintenanceCards(){const maintenanceProfiles=(currentProfiles||[]).filter(profile=>profile&&profile.maintenance);document.querySelectorAll('.profile-card[data-card-key]').forEach(card=>{const key=card.dataset.cardKey||'',profileId=card.dataset.profileId||'',profile=maintenanceProfiles.find(item=>profileKey(item)===key||String(item.profileId||'')===profileId);card.classList.toggle('maintenance',Boolean(profile));if(profile)applyMaintenanceCard(profile,card)})}
    if(profilesList)new MutationObserver(()=>enforceMaintenanceCards()).observe(profilesList,{childList:true,subtree:true});
    setInterval(async()=>{if(!document.hidden&&currentProfiles.some(profile=>profile?.maintenance)){try{await refreshProfilesSilent();renderCategories();renderProfiles()}catch{}}},15000);
    const checkAdspowerAuthenticated=checkAdspower;
    checkAdspower=async function(){
      try{
        const h=await fetch('/health',{cache:'no-store'}).then(r=>r.json());
        if(!h.authenticated){setBadge(adspowerHealth,'warn','AdsPower','AdsPower','Entre no painel para verificar o AdsPower.');if(headerKernelStatus?.textContent?.includes('AdsPower'))setKernelStatus('','','','');return}
        if(!window.__sunbrowserBootstrapDone){
          const preparation=await req('/sunbrowser-bootstrap',{method:'POST',body:'{}'});
          window.__sunbrowserBootstrapDone=true;
          if(preparation?.installed?.length)setKernelStatus('ready','Navegador atualizado','Atualizações do SunBrowser concluídas. Iniciando o AdsPower...','');
        }
        if(!window.__adspowerStartupRequested){window.__adspowerStartupRequested=true;await req('/admin/adspower/start',{method:'POST',body:'{}'}).catch(()=>null)}
        const bootstrap=await req('/admin/adspower/bootstrap-status').catch(()=>null);
        const bootstrapPending=bootstrap&&(bootstrap.inProgress||['idle','queued','starting','starting_api'].includes(String(bootstrap.status||'')));
        if(bootstrapPending){const detail='Aguarde, estamos conectando ao AdsPower...';setBadge(adspowerHealth,'checking','AdsPower','AdsPower',detail);setKernelStatus('progress','Conectando ao AdsPower',detail,'');clearTimeout(window.__adspowerCheckTimer);window.__adspowerCheckTimer=setTimeout(checkAdspower,2000);return}
        setBadge(adspowerHealth,'checking','AdsPower','AdsPower','Aguarde, conectando ao AdsPower...');
        const out=await req('/admin/adspower/profiles');
        if(out.needsApiKey){const detail='Não foi possível concluir a conexão com o AdsPower. Aguarde e tente novamente.';setBadge(adspowerHealth,'warn','AdsPower','AdsPower',detail);setKernelStatus('warn','Conexão pendente',detail,'adspower');return}
        if(out.ok===false){const detail='O AdsPower não foi conectado. Tente novamente ou abra o programa pelo atalho do Windows.';setBadge(adspowerHealth,'offline','AdsPower','AdsPower',detail);setKernelStatus('error','AdsPower não conectado',detail,'adspower');return}
        const total=(out.rawProfiles?.data?.list||out.rawProfiles?.data||out.groups||[]).length||0;
        setBadge(adspowerHealth,'online','AdsPower','AdsPower',total?'AdsPower conectado. Ferramentas encontradas: '+total+'.':'AdsPower conectado e pronto para uso.');
        if(headerKernelStatus?.textContent?.includes('AdsPower'))setKernelStatus('','','','');
      }catch(error){const detail='Não foi possível conectar ao AdsPower. Tente novamente ou abra o programa pelo atalho do Windows.';setBadge(adspowerHealth,'offline','AdsPower','AdsPower',detail);setKernelStatus('error','AdsPower não conectado',detail,'adspower')}
    };
    tryStartAdspower=async function(){
      const h=await fetch('/health',{cache:'no-store'}).then(r=>r.json()).catch(()=>({}));if(!h.authenticated)return;
      if(!confirm('Deseja tentar abrir o AdsPower agora?'))return;
      setKernelStatus('progress','Abrindo AdsPower','Tentando iniciar o programa. Aguarde a tela inicial do AdsPower carregar.','');
      try{await req('/admin/adspower/start',{method:'POST',body:'{}'});setTimeout(checkAdspower,1500)}catch(error){const instruction='Não foi possível abrir o AdsPower automaticamente. Abra o AdsPower manualmente pelo atalho do Windows, faça login e aguarde a tela inicial carregar.';setKernelStatus('error','Abra o AdsPower manualmente',instruction,'adspower');alert(instruction)}
    };
    document.addEventListener('click',event=>{const connectButton=event.target.closest('[data-kernel-action="connect-adspower"]');if(!connectButton)return;event.preventDefault();event.stopPropagation();tryStartAdspower()},true);
    (function setupKernelInstallOverlay(){const overlay=document.querySelector('#kernelInstallOverlay'),title=document.querySelector('#kernelInstallTitle'),message=document.querySelector('#kernelInstallMessage'),progress=document.querySelector('#kernelInstallProgress'),percent=document.querySelector('#kernelInstallPercent');let safetyTimer=null;window.kernelInstallOverlayVisible=()=>!overlay.classList.contains('hidden');window.showKernelInstallOverlay=function(text='Iniciando a preparação do navegador...'){clearTimeout(safetyTimer);overlay.classList.remove('hidden');void overlay.offsetWidth;title.textContent='Preparando seu navegador';message.textContent=text;progress.classList.add('indeterminate');progress.style.width='38%';percent.textContent='Aguarde...';safetyTimer=setTimeout(()=>window.finishKernelInstallOverlay?.(false,'A preparação demorou mais que o esperado. Tente novamente.'),10*60*1000)};window.updateKernelInstallOverlay=function(data={}){const hasPercent=data.percent!==null&&data.percent!==undefined&&Number.isFinite(Number(data.percent)),value=hasPercent?Number(data.percent):null;overlay.classList.remove('hidden');title.textContent=data.status==='ready'?'Concluído':'Preparando seu navegador';message.textContent=data.message||'Aguarde enquanto preparamos tudo para abrir seu perfil.';if(hasPercent){progress.classList.remove('indeterminate');progress.style.width=Math.max(0,Math.min(100,value))+'%';percent.textContent=Math.max(0,Math.min(100,value))+'%'}else{progress.classList.add('indeterminate');progress.style.width='38%';percent.textContent=data.attempts?'Tentativa '+data.attempts+' · '+(data.elapsedSeconds||0)+'s':'Aguarde...'}};window.finishKernelInstallOverlay=function(ok,errorMessage=''){clearTimeout(safetyTimer);progress.classList.remove('indeterminate');progress.style.width='100%';title.textContent=ok?'Concluído':'Não foi possível concluir';message.textContent=ok?'Instalação concluída. Finalizando a abertura do perfil...':(errorMessage||'Tente novamente. Se o problema continuar, chame o suporte.');percent.textContent=ok?'100%':'Atenção';setTimeout(()=>overlay.classList.add('hidden'),ok?3000:5000)}})();
    const requestBeforeKernelOverlay=req;req=async function(requestPath,options={}){const opening=requestPath==='/open';try{const response=await requestBeforeKernelOverlay(requestPath,options);if(opening&&window.kernelInstallOverlayVisible?.())window.finishKernelInstallOverlay?.(true);return response}catch(error){if(opening&&window.kernelInstallOverlayVisible?.())window.finishKernelInstallOverlay?.(false);throw error}};
    (function attachKernelInstallEvents(){const timer=setInterval(()=>{const es=window.__runtimeEvents;if(!es||es.__kernelInstallAttached)return;es.__kernelInstallAttached=true;clearInterval(timer);es.addEventListener('kernel-install',event=>{try{const data=JSON.parse(event.data||'{}');if(data.status==='error'){window.finishKernelInstallOverlay?.(false,data.message);return}if(data.status==='ready'){window.updateKernelInstallOverlay?.(data);window.finishKernelInstallOverlay?.(true);return}window.updateKernelInstallOverlay?.(data)}catch{}})},250)})();
    (function attachSunbrowserBootstrapEvents(){
      const slides=document.querySelector('#sunbrowserSlides');let slideTimer=null;
      function showSlides(items=[]){clearInterval(slideTimer);const usable=items.filter(item=>item&&(item.title||item.message||item.imageUrl));if(!usable.length){slides?.classList.add('hidden');return}let index=0;slides.classList.remove('hidden');const draw=()=>{const item=usable[index%usable.length];slides.innerHTML=(item.imageUrl?'<img src="'+esc(item.imageUrl)+'" alt="" />':'')+'<div><strong>'+esc(item.title||'Novidade NinjaFlix')+'</strong><p>'+esc(item.message||'')+'</p></div>';index+=1};draw();slideTimer=setInterval(draw,4500)}
      const timer=setInterval(()=>{const es=window.__runtimeEvents;if(!es||es.__sunbrowserAttached)return;es.__sunbrowserAttached=true;clearInterval(timer);es.addEventListener('sunbrowser-bootstrap',event=>{try{const data=JSON.parse(event.data||'{}');if(data.experience){showSlides(data.experience.slides||[]);document.querySelector('#kernelInstallTitle').textContent=data.experience.title||'Preparando seu navegador'}window.updateKernelInstallOverlay?.(data);if(data.status==='error')window.finishKernelInstallOverlay?.(false,data.message);if(data.status==='ready'){clearInterval(slideTimer);setTimeout(()=>slides?.classList.add('hidden'),2800);window.finishKernelInstallOverlay?.(true)}}catch{}})},250);
      const style=document.createElement('style');style.textContent='.sunbrowser-slides{display:grid;grid-template-columns:minmax(0,180px) 1fr;gap:16px;align-items:center;margin:18px 0;padding:14px;border:1px solid rgba(168,85,247,.3);border-radius:18px;background:rgba(168,85,247,.08);text-align:left}.sunbrowser-slides img{width:100%;max-height:120px;object-fit:contain;border-radius:12px}.sunbrowser-slides strong{display:block;font-size:17px}.sunbrowser-slides p{margin:7px 0 0;color:var(--muted-foreground)}@media(max-width:600px){.sunbrowser-slides{grid-template-columns:1fr}.sunbrowser-slides img{max-height:100px}}';document.head.append(style)
    })();
    document.addEventListener('click',async event=>{
      const button=event.target.closest('[data-launch],[data-internal-nav],.expired-subscription a,.machine-support-box a,a[href*="cliente.ninjaflix.club/"]');
      if(!button)return;
      event.preventDefault();
      event.stopImmediatePropagation();
      let target=String(button.dataset.launch||'').toLowerCase();
      const href=String(button.href||'');
      if(!target){
        if(href.includes('/financeiro'))target='financeiro';
        else if(href.includes('/suporte'))target='suporte';
        else if(href.includes('/tutoriais'))target='tutoriais';
        else if(href.includes('tab=avisos'))target='avisos';
      }
      const fallback=target?(shellConfig.pages?.[target]||href):href;
      try{
        const health=await fetch('/health',{cache:'no-store'}).then(response=>response.json());
        if(health?.authenticated&&target){
          const launch=await req('/launch-link',{method:'POST',body:JSON.stringify({target})});
          if(launch?.url){window.location.href=launch.url;return}
        }
      }catch(_error){}
      if(fallback)window.location.href=fallback;
    },true);
    async function reconcileAgentAccess(){try{const h=await fetch('/health',{cache:'no-store'}).then(r=>r.json());const panelWasOpen=!document.querySelector('#agentCard')?.classList.contains('hidden');if(h.accessIssue){renderAgentAccessIssue(h.accessIssue,h.user);return}if(h.canAccessService===false){showExpiredSubscription(h.user||{});return}if(h.canAccessService===true&&String(toolsTitle?.textContent||'').includes('Assinatura vencida')){window.location.reload();return}if((h.user&&!h.authenticated)||(!h.authenticated&&panelWasOpen)){renderAgentAccessIssue({code:'session_invalid',message:h.error||'Este dispositivo perdeu a autorização. Chame o suporte.'},h.user);return}if(h.authenticated&&h.user){setBadge(bindBadge,'ok','Dispositivo','Aparelho','Este computador está autorizado e vinculado ao cliente logado.');if(headerKernelStatus?.textContent?.includes('Dispositivo'))setKernelStatus('','','','');if(/^Dispositivo (offline|bloqueado|em uso)/i.test(String(toolsTitle?.textContent||'')))await loadProfiles()}else if(headerKernelStatus?.textContent?.includes('AdsPower'))setKernelStatus('','','','')}catch{}}
    (function setupDesktopUpdateCenter(){
      const bridge=window.ninjaflixDesktop;
      const wrap=document.querySelector('#desktopUpdateWrap');
      const button=document.querySelector('#desktopUpdateButton');
      const dropdown=document.querySelector('#desktopUpdateDropdown');
      const install=document.querySelector('#desktopUpdateInstall');
      const later=document.querySelector('#desktopUpdateLater');
      const title=document.querySelector('#desktopUpdateTitle');
      const version=document.querySelector('#desktopUpdateVersion');
      const message=document.querySelector('#desktopUpdateMessage');
      const status=document.querySelector('#desktopUpdateStatus');
      if(!wrap||!button)return;
      let pending=null;
      function render(payload){
        pending=payload?.update||null;
        wrap.classList.remove('hidden');
        button.classList.toggle('has-update',Boolean(pending));
        if(!pending){
          title.textContent='Painel atualizado';
          version.textContent='Nenhuma atualização pendente';
          message.textContent='Você está usando a versão mais recente disponível.';
          status.textContent='';
          install.classList.add('hidden');
          later.textContent='Fechar';
          return
        }
        title.textContent=pending.title||'Nova versão do Ninjaflix Painel';
        version.textContent='Versão '+String(pending.version||'');
        message.textContent=pending.message||'Você pode instalar agora ou deixar para mais tarde.';
        install.classList.remove('hidden');
        install.disabled=!bridge;
        install.textContent=bridge?'Atualizar agora':'Abra no aplicativo';
        later.textContent='Agora não';
        status.textContent='';
      }
      async function refresh(){
        try{const payload=await req('/updates/latest');render(payload.updateAvailable?payload:null)}catch{}
      }
      button.addEventListener('click',event=>{event.stopPropagation();dropdown.classList.toggle('hidden')});
      later.addEventListener('click',()=>dropdown.classList.add('hidden'));
      install.addEventListener('click',()=>{
        if(!pending)return;
        install.disabled=true;
        status.textContent='Preparando atualização...';
        bridge.installUpdate(pending);
      });
      document.addEventListener('click',event=>{if(!event.target.closest('.desktop-update-wrap'))dropdown.classList.add('hidden')});
      bridge?.onUpdateAvailable(render);
      bridge?.onUpdateStatus(event=>{
        if(event?.status==='downloading'){
          const percent=event.total?Math.min(100,Math.round((event.received/event.total)*100)):0;
          status.textContent='Baixando atualização... '+percent+'%';
        }else if(event?.status==='installing')status.textContent='Instalando; o painel será reiniciado...';
        else if(event?.status==='error'){status.textContent='Falha: '+(event.message||'tente novamente');install.disabled=false}
      });
      refresh();
      setInterval(refresh,5*60*1000);
      window.addEventListener('focus',refresh);
    })();
    (function setupPersistentMarketingPopups(){
      function desktopNotify(title,body,id){const key='ninjaflix:desktop-notification:'+String(id||title||'');if(!id||localStorage.getItem(key))return;localStorage.setItem(key,'1');window.ninjaflixDesktop?.notify?.({title:String(title||'NinjaFlix'),body:String(body||'')})}
      const style=document.createElement('style');
      style.textContent='.tool-card-top{display:contents!important}.tool-card-top .tool-badge{position:absolute!important;right:18px!important;top:18px!important;z-index:4!important}.favorite-toggle{position:absolute!important;right:20px!important;bottom:18px!important;top:auto!important;z-index:4!important;width:27px;height:27px;padding:0;border:0!important;background:transparent!important;box-shadow:none!important;color:#64748b;font-size:19px}.favorite-toggle:hover{background:transparent!important;transform:scale(1.08)!important}.favorite-toggle.is-favorite{color:#facc15}.agent-popup:not(.theme-transparent) .agent-modal{width:min(430px,calc(100vw - 32px))!important;max-width:430px!important}.agent-popup.theme-transparent{background:rgba(3,4,11,.38);backdrop-filter:blur(4px)}.agent-popup.theme-transparent .agent-modal{position:relative;max-width:min(860px,calc(100vw - 32px));padding:0;border:0;background:transparent;box-shadow:none;overflow:visible}.agent-popup.theme-transparent .modal-head{position:absolute;right:-4px;top:-42px}.agent-popup.theme-transparent .modal-head h2{display:none}.agent-popup.theme-transparent .modal-close{background:#0b0d19;border-color:rgba(255,255,255,.35)}.popup-banner{display:block;width:100%;max-height:calc(100vh - 150px);object-fit:contain;border-radius:24px}.popup-banner-action{display:flex;justify-content:center;margin-top:14px}.agent-popup.theme-transparent .popup-cta{margin:0;min-width:180px;justify-content:center}';
      style.textContent+='.agent-popup.theme-transparent .modal-head{right:10px;top:10px;z-index:20;margin:0}.agent-popup.theme-transparent .modal-close{display:grid;place-items:center;width:44px;height:44px;border:1px solid rgba(255,255,255,.65);border-radius:999px;background:rgba(11,13,25,.9);color:#fff;font-size:22px;font-weight:900;box-shadow:0 10px 30px rgba(0,0,0,.5)}.agent-popup.theme-transparent #agentPopupBody{display:grid;place-items:center;max-width:100%;overflow:auto;padding:0 52px}.agent-popup.theme-transparent .popup-banner{max-width:none}';
      style.textContent+='.agent-intro{background:#03040b!important;backdrop-filter:none!important}.agent-intro-card{width:min(510px,calc(100vw - 32px))!important}.tools-content #profilesList:empty::before{content:""!important;display:none!important}.tools-grid .profile-card{content-visibility:auto;contain-intrinsic-size:250px}.info-row .chip[class*="validity-"]{transition:color .25s ease,border-color .25s ease,background .25s ease,box-shadow .25s ease}.info-row .chip.validity-5{color:#facc15;border-color:rgba(250,204,21,.55);background:rgba(250,204,21,.08)}.info-row .chip.validity-4{color:#fbbf24;border-color:rgba(251,191,36,.62);background:rgba(251,191,36,.10)}.info-row .chip.validity-3{color:#f59e0b;border-color:rgba(245,158,11,.68);background:rgba(245,158,11,.12)}.info-row .chip.validity-2{color:#f97316;border-color:rgba(249,115,22,.74);background:rgba(249,115,22,.14)}.info-row .chip.validity-1{color:#ea580c;border-color:rgba(234,88,12,.82);background:rgba(234,88,12,.16);box-shadow:0 0 20px rgba(234,88,12,.14)}.info-row .chip.validity-0{color:#dc4a1f;border-color:rgba(220,74,31,.9);background:rgba(220,74,31,.18);box-shadow:0 0 22px rgba(220,74,31,.18)}';
      document.head.append(style);
      const applyUserSubscriptionBase=applyUserSubscription;
      applyUserSubscription=function(user){const validity=applyUserSubscriptionBase(user),chip=subscriptionInfo?.closest('.chip');if(chip){chip.classList.remove('validity-5','validity-4','validity-3','validity-2','validity-1','validity-0');const due=parseLocalDate(user?.subscriptionEndsAt),today=new Date(),todayOnly=new Date(today.getFullYear(),today.getMonth(),today.getDate()),remaining=due?Math.ceil((due.getTime()-todayOnly.getTime())/86400000):null;if(Number.isFinite(remaining)&&remaining>=0&&remaining<=5)chip.classList.add('validity-'+remaining)}return validity};
      setTimeout(()=>{const health=window.__lastAgentHealth;if(health?.user)applyUserSubscription(health.user)},500);
      let activePopupId='',lastPopupPollAt=0;
      function popupReadKeys(){try{const parsed=JSON.parse(localStorage.getItem('ninjaflix:popupReadKeys')||'[]');return new Set(Array.isArray(parsed)?parsed.map(String):[])}catch{return new Set()}}
      function rememberPopupRead(key){if(!key)return;const keys=popupReadKeys();keys.add(String(key));localStorage.setItem('ninjaflix:popupReadKeys',JSON.stringify(Array.from(keys).slice(-100)));localStorage.setItem('ninjaflix:lastPopupRead',String(key))}
      const originalCloseModal=closeModal;
      closeModal=function(modal){if(modal===agentPopupModal&&activePopupId){rememberPopupRead(activePopupId);activePopupId=''}originalCloseModal(modal)};
      checkPopups=async function(){
        if(Date.now()-lastPopupPollAt<300000)return;
        lastPopupPollAt=Date.now();
        try{
          const out=await req('/popups'),read=popupReadKeys(),legacy=String(localStorage.getItem('ninjaflix:lastPopupRead')||'');
          const popup=(out.popups||[]).find(item=>{const itemId=String(item.id||item.createdAt||item.updatedAt||'');const key=itemId.startsWith('invoice_due_')?itemId:(itemId+':'+String(item.updatedAt||item.createdAt||''));return itemId&&key!==legacy&&!read.has(key)});if(!popup)return;
          const id=String(popup.id||popup.createdAt||popup.updatedAt||'');
          const displayKey=id.startsWith('invoice_due_')?id:(id+':'+String(popup.updatedAt||popup.createdAt||''));
          if(!id)return;
          activePopupId=displayKey;
          desktopNotify(popup.title||'Aviso NinjaFlix',popup.message||'Há uma nova mensagem no painel.',displayKey);
          const transparent=popup.theme==='transparent'&&popup.imageUrl;
          agentPopupModal?.classList.toggle('theme-transparent',Boolean(transparent));
          agentPopupTitle.textContent=popup.title||'Aviso';
          const imageScale=Math.min(200,Math.max(40,Number(popup.imageScale||100)));
          agentPopupBody.innerHTML=transparent?'<img class="popup-banner" src="'+esc(popup.imageUrl)+'" alt="'+esc(popup.title||'Banner NinjaFlix')+'" style="width:'+imageScale+'%" />':'<div class="popup-level">'+esc(popup.level||'informacoes')+'</div><div class="notice-item"><p>'+esc(popup.message||'')+'</p></div>';
          let ctaUrl=String(popup.buttonUrl||'').trim(),ctaLabel=String(popup.buttonLabel||'').trim();
          if(ctaUrl&&!/^(https?:|mailto:|tel:)/i.test(ctaUrl))ctaUrl='https://'+ctaUrl;
          if(agentPopupCta&&ctaUrl&&ctaLabel){agentPopupCta.href=ctaUrl;agentPopupCta.target='_self';agentPopupCta.textContent=ctaLabel;agentPopupCta.classList.remove('hidden')}else agentPopupCta?.classList.add('hidden');
          agentPopupModal?.classList.remove('hidden');
        }catch{}
      };
      setTimeout(()=>checkPopups(),250);
      profilesList.addEventListener('click',event=>{const button=event.target.closest('[data-favorite-profile]');if(!button)return;event.preventDefault();event.stopImmediatePropagation();const prefs=profilePreferences(),key=String(button.dataset.favoriteProfile),set=new Set(prefs.favorites||[]);set.has(key)?set.delete(key):set.add(key);prefs.favorites=Array.from(set);saveProfilePreferences(prefs);renderProfiles()},true);
      const requestWithUsage=req;
      req=async function(requestPath,options={}){const response=await requestWithUsage(requestPath,options);if(requestPath==='/open'){try{const body=JSON.parse(options.body||'{}');rememberProfileUse(body.cardKey||body.profileId);renderProfiles()}catch{}}return response};
      const refreshNoticesWithDesktop=refreshNoticeIndicator;
      let lastNoticePollAt=0;
      refreshNoticeIndicator=async function(force=false){if(!force&&Date.now()-lastNoticePollAt<300000)return window.__lastNotices||[];lastNoticePollAt=Date.now();const notices=await refreshNoticesWithDesktop();const latest=notices?.[0],latestId=String(latest?.id||latest?.createdAt||latest?.updatedAt||'');if(latest)desktopNotify(latest.title||'Nova notificação',latest.message||'',latestId);if(latestId&&localStorage.getItem('ninjaflix:noticeDropdownDismissed')===latestId){noticeDropdown?.classList.add('hidden');noticeDropdown?.classList.remove('auto-open')}return notices};
      document.addEventListener('click',event=>{if(event.target.closest('.notice-wrap')||noticeDropdown?.classList.contains('hidden'))return;const latest=window.__lastNotices?.[0],latestId=String(latest?.id||latest?.createdAt||latest?.updatedAt||'');if(latestId)localStorage.setItem('ninjaflix:noticeDropdownDismissed',latestId);noticeDropdown?.classList.add('hidden');noticeDropdown?.classList.remove('auto-open')},true);
      document.querySelector('#noticeButton')?.addEventListener('click',()=>localStorage.removeItem('ninjaflix:noticeDropdownDismissed'),true);
      document.addEventListener('click',event=>{const item=event.target.closest('[data-notice-index]');if(!item)return;const notice=window.__lastNotices?.[Number(item.dataset.noticeIndex)];if(notice?.action!=='support')return;event.preventDefault();event.stopImmediatePropagation();noticeDropdown?.classList.add('hidden');openLaunch('suporte')},true);
      function applyBackgroundProfiles(data){
        if(!data||!Array.isArray(data.profiles)||busyProfile)return;
        if(data.user)applyUserSubscription(data.user);
        currentCategories=Array.isArray(data.categories)?data.categories:currentCategories;
        currentProfiles=data.profiles;
        renderCategories();
        renderProfiles();
      }
      let backgroundProfilesRefresh=null,lastBackgroundProfilesRefreshAt=0;
      async function refreshProfilesInBackground(force=false){
        if(document.hidden||backgroundProfilesRefresh||(!force&&Date.now()-lastBackgroundProfilesRefreshAt<60000))return;
        lastBackgroundProfilesRefreshAt=Date.now();
        backgroundProfilesRefresh=req('/profiles?refresh=1').then(applyBackgroundProfiles).catch(()=>null).finally(()=>{backgroundProfilesRefresh=null});
        return backgroundProfilesRefresh;
      }
      window.ninjaflixDesktop?.onBackgroundRefresh?.(()=>refreshProfilesInBackground(false));
      const profilesEventTimer=setInterval(()=>{
        const events=window.__runtimeEvents;
        if(!events||events.__profilesCacheAttached)return;
        events.__profilesCacheAttached=true;
        clearInterval(profilesEventTimer);
        events.addEventListener('profiles-updated',()=>{if(backgroundProfilesRefresh)return;req('/profiles').then(applyBackgroundProfiles).catch(()=>null)});
        events.addEventListener('notices-changed',()=>{lastNoticePollAt=0;refreshNoticeIndicator(true).catch(()=>null)});
        events.addEventListener('popups-changed',()=>{lastPopupPollAt=0;checkPopups().catch(()=>null)});
        events.addEventListener('subscription-updated',()=>{reconcileAgentAccess();refreshProfilesInBackground(true)});
        events.addEventListener('desktop-update-changed',()=>window.ninjaflixDesktop?.requestUpdateCheck?.());
      },250);
    })();
    (function setupSupportLiveChat(){
      const button=document.querySelector('#supportChatButton'),panel=document.querySelector('#supportChatPanel'),closeButton=document.querySelector('#supportChatClose'),body=document.querySelector('#supportChatBody'),unread=document.querySelector('#supportChatUnread');
      if(!button||!panel||!body)return;
      let topics=[
        {id:'assinatura_pagamentos',title:'Assinatura e pagamentos',description:'Planos, renovações e cobranças.'},
        {id:'problemas_acesso',title:'Problemas no acesso',description:'Login, desconexão e abertura de ferramentas.'},
        {id:'duvidas_ferramentas',title:'Dúvidas sobre as ferramentas',description:'Funcionalidades, tutoriais e ajustes.',tools:true},
        {id:'ferramentas_deslogadas',title:'Ferramentas deslogadas',description:'Falhas, indisponibilidade e reconexão.',tools:true},
        {id:'outros_assuntos',title:'Outros assuntos',description:'Demais solicitações.'}
      ];
      let quickReplies=['Ferramenta deslogada','Ferramenta indisponível','Ferramenta sem assinatura válida','Ferramenta offline','Sem créditos','Outros'];
      const style=document.createElement('style');
      style.textContent='.support-chat-button{position:fixed;right:28px;bottom:24px;z-index:1450;display:flex;align-items:center;gap:9px;width:auto!important;min-height:48px;padding:8px 16px 8px 8px;border:1px solid rgba(192,132,252,.58);border-radius:999px;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;font-weight:900;box-shadow:0 18px 50px rgba(76,29,149,.42)}.support-chat-icon{width:31px;height:31px;display:grid;place-items:center;border-radius:999px;background:rgba(255,255,255,.18);font-size:17px}.support-chat-button b{position:absolute;right:-4px;top:-5px;min-width:21px;height:21px;display:grid;place-items:center;border:2px solid #080912;border-radius:999px;background:#ef4444;color:#fff;font-size:10px}.support-chat-panel{position:fixed;right:28px;bottom:84px;z-index:1450;width:min(430px,calc(100vw - 32px));height:min(650px,calc(100vh - 120px));display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;border:1px solid rgba(168,85,247,.55);border-radius:24px;background:#0b0c18;color:#f8f7ff;box-shadow:0 28px 90px rgba(0,0,0,.62)}.support-chat-panel>header{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid rgba(148,163,184,.18);background:linear-gradient(135deg,rgba(124,58,237,.28),rgba(11,12,24,.96))}.support-chat-panel>header div{display:grid}.support-chat-panel>header small{color:#aaa8bf}.support-chat-panel>header button{width:32px;height:32px;padding:0;border:0;background:transparent;color:inherit;font-size:24px}.support-chat-body{min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;overflow:hidden;padding:0}.support-chat-body.new-ticket{display:flex;flex-direction:column;gap:12px;overflow-y:auto;padding:16px;scrollbar-width:thin;scrollbar-color:#8b5cf6 transparent}.support-chat-loading,.support-chat-empty{margin:auto;color:#aaa8bf;text-align:center}.support-chat-ticket-title{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(148,163,184,.14);background:rgba(18,20,37,.82)}.support-chat-ticket-title span{display:grid}.support-chat-ticket-title small{color:#aaa8bf}.support-chat-messages{min-height:0;display:flex;flex-direction:column;gap:12px;overflow-y:auto;overscroll-behavior:contain;padding:16px;scrollbar-width:thin;scrollbar-color:#8b5cf6 transparent}.support-chat-messages::-webkit-scrollbar,.support-chat-body.new-ticket::-webkit-scrollbar,.support-chat-tools::-webkit-scrollbar{width:6px}.support-chat-messages::-webkit-scrollbar-track,.support-chat-body.new-ticket::-webkit-scrollbar-track,.support-chat-tools::-webkit-scrollbar-track{background:transparent}.support-chat-messages::-webkit-scrollbar-thumb,.support-chat-body.new-ticket::-webkit-scrollbar-thumb,.support-chat-tools::-webkit-scrollbar-thumb{border-radius:999px;background:linear-gradient(#c084fc,#7c3aed)}.support-chat-message{align-self:flex-end;max-width:84%;padding:11px 13px;border:1px solid rgba(192,132,252,.5);border-radius:17px 17px 5px 17px;background:linear-gradient(135deg,rgba(124,58,237,.42),rgba(88,28,135,.28));box-shadow:0 6px 22px rgba(76,29,149,.12)}.support-chat-message.admin{align-self:flex-start;border-color:rgba(148,163,184,.25);border-radius:17px 17px 17px 5px;background:#171928}.support-chat-message small{display:block;margin-bottom:5px;color:#c4b5fd;font-size:10px;font-weight:800}.support-chat-message.admin small{color:#b8bdd0}.support-chat-message p{margin:0;white-space:pre-wrap;line-height:1.48}.support-chat-compose{display:grid;gap:8px;margin:0;padding:12px 14px 14px;border-top:1px solid rgba(148,163,184,.16);background:#0f1020;box-shadow:0 -12px 30px rgba(4,5,12,.45)}.support-chat-body.new-ticket .support-chat-compose{margin-top:auto;padding:0;border:0;background:transparent;box-shadow:none}.support-chat-compose textarea{min-height:66px;max-height:120px;resize:vertical;border:1px solid rgba(168,85,247,.42);border-radius:14px;background:#080914;color:#fff;padding:11px 12px;font:inherit;outline:none}.support-chat-compose textarea:focus{border-color:#a855f7;box-shadow:0 0 0 3px rgba(168,85,247,.14)}.support-chat-compose button{min-height:43px;border:1px solid #c084fc!important;background:linear-gradient(135deg,#a855f7,#7c3aed)!important;color:#fff!important;font-weight:900!important;box-shadow:0 9px 24px rgba(124,58,237,.28)}.support-chat-compose button:disabled{opacity:.65;cursor:wait}.support-chat-topics,.support-chat-tools{display:grid;gap:8px}.support-chat-choice{display:grid!important;gap:3px;width:100%!important;padding:12px!important;text-align:left!important;border:1px solid rgba(148,163,184,.2)!important;border-radius:14px!important;background:#121425!important;color:inherit!important}.support-chat-choice small{color:#aaa8bf;font-weight:500}.support-chat-tools{max-height:300px;overflow:auto;scrollbar-width:thin;scrollbar-color:#8b5cf6 transparent}.support-chat-tool{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid rgba(148,163,184,.18);border-radius:11px;background:#121425}.support-chat-tool input{width:auto}.support-chat-step-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.support-chat-step-head div{display:grid;gap:3px}.support-chat-step-head small{color:#aaa8bf}.support-chat-back{width:auto!important;padding:6px 9px!important;background:transparent!important}.support-chat-error{padding:9px 11px;border:1px solid rgba(251,113,133,.4);border-radius:12px;color:#fecdd3;background:rgba(251,113,133,.08)}.support-chat-panel.light{background:#fff;color:#20172d;border-color:#d8b4fe;box-shadow:0 28px 90px rgba(45,24,73,.24)}.support-chat-panel.light>header{background:linear-gradient(135deg,#f5edff,#fff);border-color:#eadcf8}.support-chat-panel.light>header small,.support-chat-panel.light .support-chat-ticket-title small,.support-chat-panel.light .support-chat-step-head small,.support-chat-panel.light .support-chat-choice small{color:#71677e}.support-chat-panel.light .support-chat-ticket-title{background:#faf7ff;border-color:#eadcf8}.support-chat-panel.light .support-chat-message.admin{background:#f4f1f7;border-color:#ded8e5;color:#2a2232}.support-chat-panel.light .support-chat-message.admin small{color:#665d70}.support-chat-panel.light .support-chat-message.customer{background:linear-gradient(135deg,#8b5cf6,#6d28d9);border-color:#8b5cf6;color:#fff}.support-chat-panel.light .support-chat-message.customer small{color:#eee5ff}.support-chat-panel.light .support-chat-compose{background:#fff;border-color:#eadcf8;box-shadow:0 -12px 28px rgba(76,29,149,.08)}.support-chat-panel.light .support-chat-compose textarea{background:#faf8fc;color:#20172d;border-color:#d8c8e8}.support-chat-panel.light .support-chat-choice,.support-chat-panel.light .support-chat-tool{background:#faf8fc;border-color:#e7dcef;color:#20172d!important}body.login-mode .support-chat-button,body.login-mode .support-chat-panel{display:none!important}@media(max-width:600px){.support-chat-button{right:14px;bottom:14px}.support-chat-panel{right:8px;bottom:72px;width:calc(100vw - 16px);height:calc(100vh - 90px);border-radius:20px}}';
      style.textContent+=' .support-chat-search{width:100%;min-height:42px;padding:9px 11px;border:1px solid rgba(168,85,247,.35);border-radius:12px;background:#080914;color:inherit;font:inherit;outline:none}.support-chat-search:focus{border-color:#a855f7;box-shadow:0 0 0 3px rgba(168,85,247,.12)}.support-chat-quick-replies{display:grid;gap:8px}.support-chat-quick-choice{font-weight:500!important}.support-chat-quick-choice strong{font-weight:500}.support-chat-panel.light .support-chat-search{background:#faf8fc;border-color:#d8c8e8;color:#20172d}';
      style.textContent+=' .support-chat-panel{overflow:visible}.support-chat-panel>header{position:relative;border-radius:23px 23px 0 0}.support-chat-panel>header>button{position:absolute;right:2px;top:-43px;width:34px!important;height:34px!important;display:grid!important;place-items:center!important;border:1px solid rgba(192,132,252,.5)!important;border-radius:999px!important;background:#111222!important;color:#fff!important;font-family:Arial,sans-serif!important;font-size:24px!important;font-weight:400!important;line-height:1!important;box-shadow:0 10px 28px rgba(0,0,0,.38)}.support-chat-panel.light>header>button{background:#fff!important;color:#2a1738!important}.support-chat-body{border-radius:0 0 23px 23px;background:#0b0c18}.support-chat-panel.light .support-chat-body{background:#fff}';
      document.head.append(style);
      let tickets=[],stage=0,category='',selectedTools=new Set(),loadPromise=null,loadQueued=false,sending=false;
      function operationId(prefix){return prefix+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10)}
      function syncTheme(){const declared=String(document.documentElement.dataset.theme||document.body.dataset.theme||localStorage.getItem('theme')||'').toLowerCase();let light=/light|claro/.test(declared)||document.documentElement.classList.contains('light')||document.body.classList.contains('light')||document.body.classList.contains('light-mode');if(!declared&&!light){const rgb=getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g);if(rgb&&rgb.length>=3)light=(Number(rgb[0])+Number(rgb[1])+Number(rgb[2]))/3>185}panel.classList.toggle('light',light)}
      function activeTicket(){return tickets.find(ticket=>ticket&&ticket.status!=='closed'&&!ticket.archived)||null}
      function latestAdminId(){for(const ticket of tickets){const messages=Array.isArray(ticket.messages)?ticket.messages:[];for(let i=messages.length-1;i>=0;i-=1)if(messages[i]?.from==='admin')return String(messages[i].id||messages[i].createdAt||'')}return''}
      function updateUnread(){const latest=latestAdminId(),read=localStorage.getItem('ninjaflix:support-last-read')||'',count=latest&&latest!==read?1:0;unread.textContent=String(count);unread.classList.toggle('hidden',!count);button.classList.toggle('has-unread',Boolean(count))}
      function markRead(){const latest=latestAdminId();if(latest)localStorage.setItem('ninjaflix:support-last-read',latest);updateUnread()}
      function messagesMarkup(ticket){return (ticket.messages||[]).map(message=>'<div class="support-chat-message '+(message.from==='admin'?'admin':'customer')+'"><small>'+(message.from==='admin'?'Suporte NinjaFlix':'Você')+' · '+new Date(message.createdAt||Date.now()).toLocaleString('pt-BR')+'</small><p>'+esc(message.message||'')+'</p></div>').join('')}
      function scrollMessagesToEnd(){const messages=body.querySelector('.support-chat-messages');if(messages)requestAnimationFrame(()=>{messages.scrollTop=messages.scrollHeight})}
      function renderTicket(ticket){body.classList.remove('new-ticket');body.innerHTML='<div class="support-chat-ticket-title"><span><strong>'+esc(ticket.categoryLabel||ticket.subject||'Atendimento')+'</strong><small>Ticket em andamento</small></span><span class="tool-badge">'+supportStatusText(ticket.status)+'</span></div><div class="support-chat-messages" role="log" aria-live="polite">'+messagesMarkup(ticket)+'</div><form id="supportChatReply" class="support-chat-compose"><textarea name="message" placeholder="Digite sua mensagem..." maxlength="4000" required></textarea><button type="submit">Enviar mensagem</button><div class="support-chat-send-status" aria-live="polite"></div></form>';scrollMessagesToEnd();body.querySelector('#supportChatReply')?.addEventListener('submit',sendReply)}
      function availableToolNames(){const names=[];uniqueProfilesWithCategories().filter(profile=>profileIsAvailable(profile)).forEach(profile=>{const name=String(profile.name||'').trim();if(name&&!names.includes(name))names.push(name)});return names.sort((a,b)=>a.localeCompare(b,'pt-BR'))}
      function renderNewTicket(){
        body.classList.add('new-ticket');
        if(stage===0){body.innerHTML='<div class="support-chat-step-head"><div><strong>Como podemos ajudar?</strong><small>Escolha o assunto do atendimento.</small></div></div><div class="support-chat-topics">'+topics.map(topic=>'<button class="support-chat-choice" type="button" data-support-topic="'+topic.id+'"><strong>'+esc(topic.title)+'</strong><small>'+esc(topic.description)+'</small></button>').join('')+'</div>';return}
        const topic=topics.find(item=>item.id===category)||topics[topics.length-1];
        if(stage===1&&topic.tools){const tools=availableToolNames();body.innerHTML='<div class="support-chat-step-head"><div><strong>Selecione as ferramentas</strong><small>Marque uma ou mais opções relacionadas.</small></div><button class="support-chat-back" data-support-back type="button">Voltar</button></div><input class="support-chat-search" data-support-tool-search type="search" placeholder="Buscar ferramenta..." autocomplete="off"><div class="support-chat-tools">'+(tools.length?tools.map(name=>'<label class="support-chat-tool" data-support-tool-name="'+esc(name.toLocaleLowerCase('pt-BR'))+'"><input type="checkbox" value="'+esc(name)+'" '+(selectedTools.has(name)?'checked':'')+'/><span>'+esc(name)+'</span></label>').join(''):'<div class="support-chat-empty">Nenhuma ferramenta disponível.</div>')+'<div class="support-chat-empty hidden" data-support-search-empty>Nenhuma ferramenta encontrada.</div></div><button data-support-tools-next type="button">Continuar</button>';return}
        const quick=category==='ferramentas_deslogadas'?'<div class="support-chat-quick-replies">'+quickReplies.map(text=>'<button class="support-chat-choice support-chat-quick-choice" data-support-chat-quick="'+esc(text)+'" type="button">'+esc(text)+'</button>').join('')+'</div>':'';
        body.innerHTML='<div class="support-chat-step-head"><div><strong>'+esc(topic.title)+'</strong><small>Conte o que aconteceu.</small></div><button class="support-chat-back" data-support-back type="button">Voltar</button></div>'+quick+'<form id="supportChatCreate" class="support-chat-compose"><textarea name="message" placeholder="Descreva sua solicitação" required></textarea><button type="submit">Abrir solicitação</button></form>';body.querySelector('#supportChatCreate')?.addEventListener('submit',createTicket)
      }
      function render(){const active=activeTicket();if(active)renderTicket(active);else renderNewTicket()}
      async function load(options={}){if(loadPromise){loadQueued=true;return loadPromise}loadPromise=req('/support-tickets').then(out=>{tickets=Array.isArray(out.tickets)?out.tickets:[];if(Array.isArray(out.config?.topics)&&out.config.topics.length)topics=out.config.topics;if(Array.isArray(out.config?.quickReplies)&&out.config.quickReplies.length)quickReplies=out.config.quickReplies;button.classList.remove('hidden');updateUnread();if(!panel.classList.contains('hidden')){render();if(options.markRead)markRead()}}).catch(()=>{if(!tickets.length)button.classList.add('hidden')}).finally(()=>{loadPromise=null;if(loadQueued){loadQueued=false;setTimeout(()=>load(options),0)}});return loadPromise}
      async function createTicket(event){event.preventDefault();if(sending)return;const form=event.currentTarget,message=String(new FormData(form).get('message')||'').trim();if(!message)return;const submit=form.querySelector('button[type="submit"]'),requestId=operationId('ticket');sending=true;submit.disabled=true;submit.textContent='Enviando...';try{await req('/support-tickets',{method:'POST',body:JSON.stringify({category,message,tools:Array.from(selectedTools),clientRequestId:requestId})});stage=0;category='';selectedTools.clear();await load({markRead:true})}catch(error){form.querySelector('.support-chat-error')?.remove();form.insertAdjacentHTML('beforeend','<div class="support-chat-error">'+esc(error.message||'NÃ£o foi possÃ­vel abrir a solicitaÃ§Ã£o. Tente novamente.')+'</div>');submit.disabled=false;submit.textContent='Abrir solicitaÃ§Ã£o'}finally{sending=false}}
      async function sendReply(event){event.preventDefault();if(sending)return;const ticket=activeTicket(),form=event.currentTarget,textarea=form.querySelector('textarea'),message=String(textarea?.value||'').trim();if(!ticket||!message)return;const submit=form.querySelector('button'),status=form.querySelector('.support-chat-send-status'),messageId=operationId('message');sending=true;submit.disabled=true;submit.textContent='Enviando...';if(status)status.textContent='';try{await req('/support-tickets/'+encodeURIComponent(ticket.id)+'/messages',{method:'POST',body:JSON.stringify({message,clientMessageId:messageId})});textarea.value='';await load({markRead:true})}catch(error){if(status){status.className='support-chat-send-status support-chat-error';status.textContent=error.message||'Falha ao enviar. Sua mensagem foi mantida para tentar novamente.'}submit.disabled=false;submit.textContent='Enviar mensagem'}finally{sending=false}}
      button.addEventListener('click',async()=>{panel.classList.toggle('hidden');if(!panel.classList.contains('hidden')){syncTheme();await load({markRead:true})}});
      closeButton.addEventListener('click',()=>{panel.classList.add('hidden');markRead()});
      document.addEventListener('click',event=>{if(panel.classList.contains('hidden')||event.target.closest('#supportChatPanel')||event.target.closest('#supportChatButton'))return;panel.classList.add('hidden');markRead()},true);
      body.addEventListener('click',event=>{const topicButton=event.target.closest('[data-support-topic]');if(topicButton){category=topicButton.dataset.supportTopic;selectedTools.clear();stage=(topics.find(item=>item.id===category)?.tools)?1:2;render();return}if(event.target.closest('[data-support-back]')){stage=Math.max(0,stage-1);render();return}if(event.target.closest('[data-support-tools-next]')){selectedTools=new Set(Array.from(body.querySelectorAll('.support-chat-tool input:checked')).map(input=>input.value));stage=2;render();return}const quick=event.target.closest('[data-support-chat-quick]');if(quick){const textarea=body.querySelector('textarea[name="message"]');if(textarea){textarea.value=quick.dataset.supportChatQuick||'';textarea.focus()}}});
      body.addEventListener('input',event=>{if(!event.target.matches('[data-support-tool-search]'))return;const query=String(event.target.value||'').trim().toLocaleLowerCase('pt-BR');let visible=0;body.querySelectorAll('[data-support-tool-name]').forEach(item=>{const show=!query||String(item.dataset.supportToolName||'').includes(query);item.classList.toggle('hidden',!show);if(show)visible+=1});body.querySelector('[data-support-search-empty]')?.classList.toggle('hidden',visible>0)});
      const observer=new MutationObserver(()=>{if(!agentCard?.classList.contains('hidden'))load()});if(agentCard)observer.observe(agentCard,{attributes:true,attributeFilter:['class']});
      new MutationObserver(syncTheme).observe(document.documentElement,{attributes:true,attributeFilter:['class','data-theme']});syncTheme();
      const eventTimer=setInterval(()=>{const events=window.__runtimeEvents;if(!events||events.__supportChatAttached)return;events.__supportChatAttached=true;clearInterval(eventTimer);events.addEventListener('support-chat-changed',()=>load({markRead:!panel.classList.contains('hidden')}))},250);
      setTimeout(()=>{if(!agentCard?.classList.contains('hidden'))load()},900);setInterval(()=>{if(!document.hidden&&!agentCard?.classList.contains('hidden'))load()},60000)
    })();
    const reconcileAgentAccessVisible=reconcileAgentAccess;
    reconcileAgentAccess=async function(){if(document.hidden)return;return reconcileAgentAccessVisible()};
    setTimeout(reconcileAgentAccess,1200);
    setInterval(reconcileAgentAccess,120000);
  </script>
</body>
</html>`;

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Token, Access-Control-Request-Private-Network',
    'Access-Control-Allow-Private-Network': 'true',
    'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network'
  });
  res.end(JSON.stringify(body));
}

function notFound(res) {
  return json(res, 404, { error: 'Endpoint do agente nao encontrado' });
}

function html(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function randomToken(prefix = 'tok') {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

function cleanupExtensionSessions() {
  const now = Date.now();
  for (const [token, session] of state.extensionSessions.entries()) {
    if (!session || new Date(session.expiresAt).getTime() <= now) {
      state.extensionSessions.delete(token);
    }
  }
}

function safeMacs() {
  const interfaces = os.networkInterfaces();
  return Object.entries(interfaces)
    .flatMap(([name, entries]) => (entries || []).map((entry) => ({ name, ...entry })))
    .filter((entry) => entry && entry.mac && entry.mac !== '00:00:00:00:00:00' && !entry.internal)
    .map((entry) => ({ name: entry.name, mac: entry.mac, family: entry.family, address: entry.address }));
}

function readWindowsMachineGuid() {
  if (process.platform !== 'win32') return '';
  try {
    const output = execFileSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    });
    const match = String(output || '').match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
    return String(match?.[1] || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function readMacPlatformUuid() {
  if (process.platform !== 'darwin') return '';
  try {
    const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      encoding: 'utf8',
      timeout: 3000
    });
    const match = String(output || '').match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i);
    return String(match?.[1] || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function buildMachineInfo() {
  const cpus = os.cpus() || [];
  const network = safeMacs();
  const legacyRawFingerprint = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.release(),
    cpus[0] && cpus[0].model,
    network.map((entry) => entry.mac).sort().join('|')
  ].join('::');
  const machineGuid = readWindowsMachineGuid() || readMacPlatformUuid();
  const memoryGb = Math.max(1, Math.round(os.totalmem() / 1073741824));
  const identitySignals = {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0] ? cpus[0].model : null,
    cpuCount: cpus.length,
    memoryGb,
    machineGuidHash: machineGuid ? stableHash(machineGuid) : null
  };
  const stableIdentity = machineGuid
    ? ['machine-v2', os.platform(), os.arch(), machineGuid].join('::')
    : ['machine-v2-fallback', os.platform(), os.arch(), os.hostname(), identitySignals.cpuModel, memoryGb, network.map((entry) => entry.mac).sort().join('|')].join('::');

  return {
    fingerprint: stableHash(stableIdentity),
    legacyFingerprints: [stableHash(legacyRawFingerprint)],
    identityVersion: 2,
    identitySignals,
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    type: os.type(),
    uptime: os.uptime(),
    totalMemory: os.totalmem(),
    cpuCount: cpus.length,
    cpuModel: cpus[0] ? cpus[0].model : null,
    network,
    capturedAt: new Date().toISOString(),
    agent: {
      name: 'Ninjaflix Painel',
      version: APP_VERSION,
      port: PORT,
      portalUrl: PORTAL_URL
    }
  };
}

async function portalRequest(path, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || PORTAL_REQUEST_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    'Content-Type': 'application/json',
    ...(state.agentToken ? { 'X-Agent-Token': state.agentToken } : {}),
    ...(options.headers || {})
  };

  let response;
  try {
    const { timeoutMs: _ignoredTimeout, ...fetchOptions } = options;
    response = await fetch(`${PORTAL_URL}${path}`, {
      ...fetchOptions,
      headers,
      signal: options.signal || controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('O dashboard demorou para responder. Usando os dados salvos nesta máquina.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(payload.error || `Portal retornou HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function proxyUpdateDownload(req, res, updateId) {
  await ensureMachineAuthenticated();
  let response = await fetch(`${PORTAL_URL}/api/agent/updates/${encodeURIComponent(updateId)}/download`, {
    headers: { 'X-Agent-Token': state.agentToken }
  });
  if (response.status === 401 && state.user) {
    await refreshCustomerSession();
    response = await fetch(`${PORTAL_URL}/api/agent/updates/${encodeURIComponent(updateId)}/download`, {
      headers: { 'X-Agent-Token': state.agentToken }
    });
  }
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || `Falha ao baixar atualização (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  const responseHeaders = {
    'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
    'Content-Disposition': response.headers.get('content-disposition') || 'attachment',
    'Cache-Control': 'no-store'
  };
  if (response.headers.get('content-length')) responseHeaders['Content-Length'] = response.headers.get('content-length');
  res.writeHead(200, responseHeaders);
  Readable.fromWeb(response.body).pipe(res);
}

function isInvalidAgentSession(error) {
  const message = String(error?.message || error?.payload?.error || '').toLowerCase();
  return error?.status === 401 || message.includes('token do agente invalido') || message.includes('sessao') || message.includes('token');
}

async function refreshCustomerSession() {
  const email = (state.user && state.user.email) || state.rememberedEmail;
  if (!email) {
    const error = new Error('Sessao expirada. Informe o e-mail novamente no agente local.');
    error.status = 401;
    throw error;
  }
  state.agentToken = '';
  return customerLogin({ email });
}

async function portalRequestWithSessionRefresh(path, options = {}) {
  try {
    return await portalRequest(path, options);
  } catch (error) {
    if (!isInvalidAgentSession(error) || !state.user) throw error;
    await refreshCustomerSession();
    return portalRequest(path, options);
  }
}

async function authenticateByMachine() {
  state.machine = buildMachineInfo();
  const payload = await portalRequest('/api/agent/machine-login', {
    method: 'POST',
    body: JSON.stringify({
      machineFingerprint: state.machine.fingerprint,
      machineInfo: state.machine
    })
  });
  state.agentToken = payload.agentSessionToken || state.agentToken;
  state.user = payload.user || null;
  heartbeatCache = { checkedAt: 0, payload: null };
  return payload;
}

async function ensureMachineAuthenticated() {
  if (state.agentToken && state.user) return { user: state.user, machine: state.machine };
  if (state.rememberedEmail || (state.user && state.user.email)) {
    if (machineAuthInFlight) return machineAuthInFlight;
    machineAuthInFlight = refreshCustomerSession().finally(() => { machineAuthInFlight = null; });
    return machineAuthInFlight;
  }
  const error = new Error('Informe o e-mail usado no checkout antes de acessar os perfis.');
  error.status = 401;
  throw error;
}

function logout() {
  state.agentToken = '';
  state.user = null;
  state.rememberedEmail = null;
  state.currentProfileSession = null;
  state.cachedProfiles = null;
  heartbeatCache = { checkedAt: 0, payload: null };
  heartbeatInFlight = null;
  machineAuthInFlight = null;
  if (catalogEventStreamController) catalogEventStreamController.abort();
  if (catalogRefreshTimer) clearTimeout(catalogRefreshTimer);
  state.extensionSessions.clear();
  state.machine = buildMachineInfo();
  clearLocalState();
  return { ok: true, authenticated: false, machine: state.machine };
}

function resolveProfileId(body = {}) {
  return String(body.profileId || body.user_id || config.adspower.profileId || '').trim();
}

function normalizeProfileStartUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function adspowerStatusIsOpen(payload = {}) {
  const data = payload && payload.data || {};
  const values = [
    payload.status,
    payload.active,
    payload.open,
    data.status,
    data.active,
    data.open,
    data.ws,
    data.wsUrl,
    data.ws_url,
    data.debug_port,
    data.debugPort
  ];
  if (values.some((value) => value === true)) return true;
  if (values.some((value) => ['active', 'open', 'opened', 'running', 'started', 'online'].includes(String(value || '').toLowerCase()))) return true;
  return false;
}

async function getProfileOpenState(profileId) {
  try {
    const adspower = await getBrowserStatus(profileId);
    const open = adspowerStatusIsOpen(adspower);
    if (!open) state.openProfiles.delete(profileId);
    return { open, adspower };
  } catch (error) {
    return { open: false, error };
  }
}


function expectedKernelVersion() {
  const raw = String(process.env.ADSPOWER_EXPECTED_KERNEL_VERSION || process.env.EXPECTED_ADSPOWER_KERNEL || DEFAULT_EXPECTED_ADSPOWER_KERNEL).trim();
  const version = Number.parseInt(raw, 10);
  return Number.isFinite(version) && version > 0 ? version : DEFAULT_EXPECTED_ADSPOWER_KERNEL;
}

function kernelVersionKey(version = expectedKernelVersion()) {
  const parsed = Number.parseInt(String(version || ''), 10);
  return String(Number.isFinite(parsed) && parsed > 0 ? parsed : expectedKernelVersion());
}

function buildKernelPlan(version = expectedKernelVersion()) {
  const key = kernelVersionKey(version);
  const seen = state.seenKernelVersions[key] || null;
  const installed = kernelIsInstalled(key);
  return {
    ok: true,
    kernelVersion: Number(key),
    expectedKernelVersion: Number(key),
    installed,
    alreadyCompleted: installed || Boolean(seen && seen.firstOpenCompletedAt),
    shouldShowUpdate: !installed,
    seen
  };
}

function rememberKernelStarted(version = expectedKernelVersion()) {
  const key = kernelVersionKey(version);
  const current = state.seenKernelVersions[key] || {};
  state.seenKernelVersions[key] = {
    ...current,
    firstSeenAt: current.firstSeenAt || new Date().toISOString(),
    lastStartedAt: new Date().toISOString()
  };
  saveLocalState({ seenKernelVersions: state.seenKernelVersions });
  return state.seenKernelVersions[key];
}

function rememberKernelCompleted(version = expectedKernelVersion()) {
  const key = kernelVersionKey(version);
  const current = state.seenKernelVersions[key] || {};
  state.seenKernelVersions[key] = {
    ...current,
    firstSeenAt: current.firstSeenAt || new Date().toISOString(),
    firstOpenCompletedAt: current.firstOpenCompletedAt || new Date().toISOString(),
    lastCompletedAt: new Date().toISOString()
  };
  saveLocalState({ seenKernelVersions: state.seenKernelVersions });
  return state.seenKernelVersions[key];
}

function sseSend(res, event, data = {}) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    state.eventClients.delete(res);
  }
}

function emitRuntimeEvent(event, data = {}) {
  for (const client of Array.from(state.eventClients)) sseSend(client, event, data);
}

function profileCardKey(profileId) {
  const opened = state.openProfiles.get(profileId);
  if (opened && opened.cardKey) return opened.cardKey;
  const cached = state.profileStatusCache.get(profileId);
  if (cached && cached.cardKey) return cached.cardKey;
  for (const [cardKey, status] of state.profileStatusCache.entries()) {
    if (status.profileId === profileId && status.cardKey) return status.cardKey;
    if (status.profileId === profileId && cardKey !== profileId) return cardKey;
  }
  return profileId;
}

async function verifyProfileRuntimeState(profileId) {
  const stateResult = await getProfileOpenState(profileId);
  const runtime = {
    profileId,
    status: stateResult.open ? 'open' : 'closed',
    browserStatus: stateResult.open ? 'open' : 'closed',
    confidence: stateResult.open ? 'adspower-active' : 'confirmed',
    adspower: stateResult.adspower || null,
    checkedAt: new Date().toISOString()
  };
  if (!stateResult.open) {
    state.openProfiles.delete(profileId);
    if (String(state.currentProfileSession?.profileId || '') === String(profileId)) state.currentProfileSession = null;
    persistProfileAccessState();
  }
  return runtime;
}

async function monitorOpenProfiles() {
  if (!state.openProfiles.size) return;
  for (const profileId of Array.from(state.openProfiles.keys())) {
    try {
      const runtime = await verifyProfileRuntimeState(profileId);
      runtime.cardKey = profileCardKey(profileId);
      const previous = state.profileStatusCache.get(profileId) || {};
      state.profileStatusCache.set(profileId, runtime);
      if (runtime.status !== previous.status) {
        emitRuntimeEvent('profile-status', { profileId, cardKey: profileCardKey(profileId), status: runtime.status, runtime });
      }
    } catch {
      state.openProfiles.delete(profileId);
      if (String(state.currentProfileSession?.profileId || '') === String(profileId)) state.currentProfileSession = null;
      persistProfileAccessState();
      const cardKey = profileCardKey(profileId);
      state.profileStatusCache.set(profileId, { profileId, cardKey, status: 'closed', confidence: 'error', checkedAt: new Date().toISOString() });
      emitRuntimeEvent('profile-status', { profileId, cardKey, status: 'closed' });
    }
  }
}

function ensureProfileStatusMonitor() {
  if (profileStatusMonitorTimer) return;
  profileStatusMonitorTimer = setInterval(() => monitorOpenProfiles().catch(() => null), PROFILE_STATUS_MONITOR_MS);
}

function adspowerExecutableCandidates() {
  const local = loadLocalState();
  const configured = String(process.env.ADSPOWER_EXE_PATH || process.env.ADSPOWER_PATH || local.adspowerExePath || '').trim();
  const candidates = [];
  if (configured) candidates.push(configured);
  if (process.platform === 'win32') candidates.push('C:\\Program Files\\AdsPower Global\\AdsPower Global.exe');
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.APPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean);
    for (const root of roots) {
      candidates.push(
        path.join(root, 'AdsPower Global', 'AdsPower Global.exe'),
        path.join(root, 'AdsPower', 'AdsPower.exe'),
        path.join(root, 'AdsPower Global.exe'),
        path.join(root, 'AdsPower.exe')
      );
    }
  }
  if (process.platform === 'darwin') {
    const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
    for (const root of roots) {
      candidates.push(
        path.join(root, 'AdsPower Global.app', 'Contents', 'MacOS', 'AdsPower Global'),
        path.join(root, 'AdsPower.app', 'Contents', 'MacOS', 'AdsPower')
      );
    }
  }
  if (process.platform === 'linux') {
    candidates.push(
      '/opt/AdsPower Global/adspower_global',
      '/opt/AdsPower Global/AdsPower Global',
      '/opt/adspower_global/adspower_global',
      '/opt/adspower/adspower',
      '/usr/bin/adspower_global',
      '/usr/bin/adspower'
    );
    for (const desktopFile of [
      '/usr/share/applications/adspower_global.desktop',
      '/usr/share/applications/adspower.desktop',
      path.join(os.homedir(), '.local', 'share', 'applications', 'adspower_global.desktop')
    ]) {
      try {
        if (!fs.existsSync(desktopFile)) continue;
        const match = fs.readFileSync(desktopFile, 'utf8').match(/^Exec=(?:"([^"]+)"|([^\s%]+))/m);
        if (match) candidates.push(match[1] || match[2]);
      } catch (_) {}
    }
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

function findAdspowerExecutable() {
  return adspowerExecutableCandidates().find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  }) || '';
}

function adspowerKernelRoot() {
  if (process.platform === 'darwin') {
    return process.env.ADSPOWER_KERNEL_ROOT || path.join(os.homedir(), 'Library', 'Application Support', 'adspower_global', 'cwd_global');
  }
  if (process.platform === 'linux') {
    return process.env.ADSPOWER_KERNEL_ROOT || path.join(os.homedir(), '.config', 'adspower_global', 'cwd_global');
  }
  return process.env.ADSPOWER_KERNEL_ROOT || path.join(process.env.APPDATA || os.homedir(), 'adspower_global', 'cwd_global');
}

function installedKernelPath(version = expectedKernelVersion()) {
  return path.join(adspowerKernelRoot(), `chrome_${kernelVersionKey(version)}`);
}

function kernelIsInstalled(version = expectedKernelVersion(), build = '') {
  if (['darwin', 'linux'].includes(process.platform)) return true;
  const root = installedKernelPath(version);
  const marker = path.join(root, 'update_version_key');
  if (!fs.existsSync(path.join(root, 'SunBrowser.exe')) || !fs.existsSync(path.join(root, 'chromedriver.exe')) || !fs.existsSync(marker)) return false;
  if (!build) return true;
  try { return fs.readFileSync(marker, 'utf8').trim() === String(build).trim(); } catch { return false; }
}

function runPowerShell(args) {
  return new Promise((resolve, reject) => {
    const input = Array.isArray(args) ? [...args] : [];
    const commandIndex = input.findIndex((value) => String(value).toLowerCase() === '-command');
    let powershellArgs = input;
    if (commandIndex !== -1 && input[commandIndex + 1]) {
      const script = String(input[commandIndex + 1]);
      const positional = input.slice(commandIndex + 2).map((value) => `'${String(value).replaceAll("'", "''")}'`).join(' ');
      const invocation = `& { ${script} } ${positional}`;
      const encoded = Buffer.from(invocation, 'utf16le').toString('base64');
      powershellArgs = ['-EncodedCommand', encoded];
    }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...powershellArgs], { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || stdout || error.message).trim()));
      resolve(String(stdout || '').trim());
    });
  });
}

async function downloadKernelPackage(item, targetPath) {
  await ensureMachineAuthenticated();
  let response = await fetch(`${PORTAL_URL}${item.downloadUrl}`, { headers: { 'X-Agent-Token': state.agentToken } });
  if (response.status === 401 && state.user) {
    await refreshCustomerSession();
    response = await fetch(`${PORTAL_URL}${item.downloadUrl}`, { headers: { 'X-Agent-Token': state.agentToken } });
  }
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Não foi possível baixar os arquivos necessários.');
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const hash = crypto.createHash('sha256');
  const total = Number(response.headers.get('content-length') || item.sizeBytes || 0);
  let received = 0;
  const output = fs.createWriteStream(targetPath, { flags: 'wx' });
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      received += chunk.length;
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
      const percent = total ? Math.min(99, Math.floor((received / total) * 100)) : null;
      emitRuntimeEvent('kernel-install', { status: 'downloading', kernelVersion: item.kernelVersion, percent, message: percent === null ? 'Baixando os arquivos necessários...' : `Baixando os arquivos necessários... ${percent}%` });
    }
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
  } catch (error) {
    output.destroy();
    fs.rmSync(targetPath, { force: true });
    throw error;
  }
  const actualHash = hash.digest('hex');
  if (actualHash.toLowerCase() !== String(item.sha256 || '').toLowerCase()) {
    fs.rmSync(targetPath, { force: true });
    throw new Error('A verificação dos arquivos falhou. Tente novamente.');
  }
}

let sunbrowserBootstrapInFlight = null;
async function installSunbrowserExecutable(installerPath) {
  return new Promise((resolve, reject) => {
    execFile(installerPath, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'], {
      windowsHide: true,
      timeout: 15 * 60 * 1000,
      maxBuffer: 1024 * 1024
    }, (error, stdout = '', stderr = '') => {
      if (error) return reject(new Error(String(stderr || stdout || error.message).trim()));
      resolve();
    });
  });
}

async function ensurePublishedSunbrowserUpdates(options = {}) {
  if (process.platform !== 'win32') return { ok: true, skipped: true, reason: 'platform', installed: [] };
  if (sunbrowserBootstrapInFlight) return sunbrowserBootstrapInFlight;
  const previousCheck = new Date(loadLocalState().sunbrowserLastCheckedAt || 0).getTime();
  if (!options.force && Number.isFinite(previousCheck) && Date.now() - previousCheck < 6 * 60 * 60 * 1000) {
    return { ok: true, alreadyChecked: true, installed: [], checkedAt: new Date(previousCheck).toISOString() };
  }
  sunbrowserBootstrapInFlight = (async () => {
    const plan = await portalRequestWithSessionRefresh('/api/agent/sunbrowser-bootstrap', { method: 'GET' });
    const updates = (Array.isArray(plan.updates) ? plan.updates : []).filter((item) => !kernelIsInstalled(item.kernelVersion, item.build));
    if (!updates.length) {
      const checkedAt = new Date().toISOString();
      saveLocalState({ sunbrowserLastCheckedAt: checkedAt });
      return { ok: true, alreadyUpdated: true, installed: [], checkedAt, experience: plan.experience || null };
    }
    const workRoot = path.join(os.tmpdir(), 'ninjaflix-sunbrowser-bootstrap');
    fs.mkdirSync(workRoot, { recursive: true });
    await stopAdspowerProcesses();
    const installed = [];
    emitRuntimeEvent('sunbrowser-bootstrap', { status: 'starting', percent: 1, message: 'Verificando atualizações do navegador...', experience: plan.experience || null });
    try {
      for (let index = 0; index < updates.length; index += 1) {
        const item = updates[index];
        const installerPath = path.join(workRoot, `${item.id}.exe`);
        fs.rmSync(installerPath, { force: true });
        const startPercent = Math.round((index / updates.length) * 90);
        emitRuntimeEvent('sunbrowser-bootstrap', { status: 'downloading', percent: Math.max(2, startPercent), message: `Baixando SunBrowser ${item.kernelVersion} (${index + 1} de ${updates.length})...`, experience: plan.experience || null });
        await downloadKernelPackage(item, installerPath);
        emitRuntimeEvent('sunbrowser-bootstrap', { status: 'installing', percent: Math.round(((index + 0.75) / updates.length) * 90), message: `Instalando SunBrowser ${item.kernelVersion}. Não feche o painel...`, experience: plan.experience || null });
        await installSunbrowserExecutable(installerPath);
        if (!kernelIsInstalled(item.kernelVersion, item.build)) throw new Error(`Não foi possível confirmar a instalação do SunBrowser ${item.kernelVersion}.`);
        installed.push({ id: item.id, kernelVersion: item.kernelVersion, build: item.build });
        fs.rmSync(installerPath, { force: true });
      }
      saveLocalState({ sunbrowserBootstrapCompletedAt: new Date().toISOString(), sunbrowserLastCheckedAt: new Date().toISOString(), sunbrowserInstalledUpdates: installed });
      emitRuntimeEvent('sunbrowser-bootstrap', { status: 'ready', percent: 100, message: 'Atualizações concluídas. Iniciando o AdsPower...', experience: plan.experience || null });
      return { ok: true, installed, experience: plan.experience || null };
    } catch (error) {
      emitRuntimeEvent('sunbrowser-bootstrap', { status: 'error', percent: null, message: error.message || 'Falha ao atualizar o SunBrowser.', experience: plan.experience || null });
      throw error;
    } finally {
      for (const item of updates) fs.rmSync(path.join(workRoot, `${item.id}.exe`), { force: true });
    }
  })().finally(() => { sunbrowserBootstrapInFlight = null; });
  return sunbrowserBootstrapInFlight;
}

async function extractAndValidateKernel(zipPath, temporaryRoot, item) {
  const script = [
    "$zip=$args[0];$dest=$args[1]",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$destFull=[IO.Path]::GetFullPath($dest+[IO.Path]::DirectorySeparatorChar)",
    "$archive=[IO.Compression.ZipFile]::OpenRead($zip)",
    "try{foreach($entry in $archive.Entries){$target=[IO.Path]::GetFullPath((Join-Path $dest $entry.FullName));if(-not $target.StartsWith($destFull,[StringComparison]::OrdinalIgnoreCase)){throw 'Arquivo ZIP inválido'}}}finally{$archive.Dispose()}",
    "[IO.Compression.ZipFile]::ExtractToDirectory($zip,$dest)"
  ].join(';');
  await runPowerShell(['-Command', script, zipPath, temporaryRoot]);
  let payloadRoot = temporaryRoot;
  if (!fs.existsSync(path.join(payloadRoot, 'SunBrowser.exe'))) {
    const children = fs.readdirSync(temporaryRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (children.length === 1 && fs.existsSync(path.join(temporaryRoot, children[0].name, 'SunBrowser.exe'))) payloadRoot = path.join(temporaryRoot, children[0].name);
  }
  for (const required of ['SunBrowser.exe', 'chromedriver.exe', 'chrome_proxy.exe']) {
    if (!fs.existsSync(path.join(payloadRoot, required))) throw new Error('O pacote enviado está incompleto.');
  }
  const signatureScript = "$bad=@();foreach($p in $args){$s=Get-AuthenticodeSignature -LiteralPath $p;if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'SUNFLOWER TECH'){ $bad+=$p }};if($bad.Count){throw 'Assinatura digital inválida'}";
  await runPowerShell(['-Command', signatureScript, ...['SunBrowser.exe', 'chromedriver.exe', 'chrome_proxy.exe'].map((name) => path.join(payloadRoot, name))]);
  fs.writeFileSync(path.join(payloadRoot, 'update_version_key'), String(item.build), 'utf8');
  return payloadRoot;
}

let kernelInstallInFlight = null;
async function ensureKernelPackageInstalled(version = expectedKernelVersion()) {
  if (['darwin', 'linux'].includes(process.platform)) {
    return { installed: true, alreadyInstalled: true, managedByAdspower: true };
  }
  if (kernelIsInstalled(version)) return { installed: true, alreadyInstalled: true };
  if (kernelInstallInFlight) return kernelInstallInFlight;
  kernelInstallInFlight = (async () => {
    const key = kernelVersionKey(version);
    const response = await portalRequestWithSessionRefresh(`/api/agent/kernels/${encodeURIComponent(key)}/latest`, { method: 'GET' });
    const item = response.kernel;
    if (!item || !item.downloadUrl || !item.sha256) throw new Error('Os arquivos necessários ainda não estão disponíveis. Entre em contato com o suporte.');
    if (kernelIsInstalled(key, item.build)) return { installed: true, alreadyInstalled: true, kernel: item };
    const root = adspowerKernelRoot();
    const workRoot = path.join(root, '.ninjaflix-kernel-installer');
    const zipPath = path.join(workRoot, `${item.id}.zip.part`);
    const extractRoot = path.join(workRoot, `${item.id}.extracting`);
    const finalPath = installedKernelPath(key);
    fs.mkdirSync(workRoot, { recursive: true });
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(extractRoot, { recursive: true, force: true });
    emitRuntimeEvent('kernel-install', { status: 'starting', kernelVersion: key, percent: 0, message: 'Preparando seu navegador...' });
    try {
      await downloadKernelPackage(item, zipPath);
      emitRuntimeEvent('kernel-install', { status: 'installing', kernelVersion: key, percent: 99, message: 'Instalando os arquivos. Não feche o painel...' });
      fs.mkdirSync(extractRoot, { recursive: true });
      const payloadRoot = await extractAndValidateKernel(zipPath, extractRoot, item);
      if (fs.existsSync(finalPath)) throw new Error('Já existe uma instalação incompleta. Entre em contato com o suporte.');
      fs.renameSync(payloadRoot, finalPath);
      if (!kernelIsInstalled(key, item.build)) throw new Error('Não foi possível confirmar a instalação.');
      emitRuntimeEvent('kernel-install', { status: 'ready', kernelVersion: key, percent: 100, message: 'Tudo pronto. Abrindo seu perfil...' });
      return { installed: true, kernel: item, path: finalPath };
    } catch (error) {
      emitRuntimeEvent('kernel-install', { status: 'error', kernelVersion: key, message: 'Não foi possível concluir a preparação. Tente novamente.' });
      throw error;
    } finally {
      fs.rmSync(zipPath, { force: true });
      fs.rmSync(extractRoot, { recursive: true, force: true });
    }
  })().finally(() => { kernelInstallInFlight = null; });
  return kernelInstallInFlight;
}

function isAdspowerProcessRunning() {
  if (['darwin', 'linux'].includes(process.platform)) {
    return new Promise((resolve) => {
      const pgrepPath = process.platform === 'darwin' ? '/usr/bin/pgrep' : 'pgrep';
      execFile(pgrepPath, ['-if', 'AdsPower|SunBrowser'], { timeout: 5000 }, (error, stdout = '') => {
        resolve(!error && /\d/.test(String(stdout)));
      });
    });
  }
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (error, stdout = '') => {
      if (!error && /adspower|sunbrowser/i.test(String(stdout))) return resolve(true);
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'AdsPower|SunBrowser' } | Select-Object -First 1) { 'running' }"], { windowsHide: true, timeout: 5000 }, (fallbackError, fallbackStdout = '') => {
        resolve(!fallbackError && /running/i.test(String(fallbackStdout)));
      });
    });
  });
}

function stopAdspowerProcesses() {
  if (['darwin', 'linux'].includes(process.platform)) {
    return new Promise((resolve) => {
      const pkillPath = process.platform === 'darwin' ? '/usr/bin/pkill' : 'pkill';
      execFile(pkillPath, ['-f', 'AdsPower|SunBrowser'], { timeout: 15000 }, () => resolve());
    });
  }
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve) => {
    const command = "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'AdsPower|SunBrowser' } | Stop-Process -Force -ErrorAction SilentlyContinue";
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout: 15000 },
      () => resolve()
    );
  });
}

function powershellLiteral(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function startAdspowerHeadless(exePath, apiKey) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, ['--headless=true', `--api-key=${apiKey}`, `--api-port=${ADSPOWER_API_PORT}`], {
      cwd: path.dirname(exePath),
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAdspowerApi(timeoutMs = 30000) {
  const startedAt = Date.now();
  const endpoints = [`${config.adspower.baseUrl}/api/v1/group/list?page=1&page_size=1`];
  const runtimeApiKey = String(state.adspowerApiKey || config.adspower.apiKey || '').trim();
  while (Date.now() - startedAt < timeoutMs) {
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, { headers: runtimeApiKey ? { Authorization: `Bearer ${runtimeApiKey}` } : {} });
        const status = response.status;
        let payload = null;
        try { payload = await response.json(); } catch { payload = null; }
        const classification = classifyAdspowerApiResponse({ ...(payload && typeof payload === 'object' ? payload : {}), status, endpoint });
        if (status === 200) {
          return {
            ok: true,
            online: true,
            endpoint,
            status,
            payload,
            needsApiKey: false,
            terminal: false,
            phase: 'online',
            message: 'AdsPower respondeu na porta local.'
          };
        }
        if (classification.needsApiKey) {
          return {
            ok: true,
            online: false,
            endpoint,
            status,
            payload,
            needsApiKey: true,
            terminal: false,
            phase: 'requires_api_key',
            message: 'A conexão com o AdsPower precisa de atenção. Tente novamente em instantes.'
          };
        }
        if (status === 401 || status === 403) {
          return {
            ok: false,
            online: false,
            endpoint,
            status,
            payload,
            needsApiKey: classification.needsApiKey,
            terminal: classification.needsApiKey,
            phase: 'api_auth_error',
            message: `AdsPower respondeu com ${status} sem permitir autenticação local.`
          };
        }
      } catch {
        // tenta novamente ate o AdsPower subir a API local
      }
    }
    await wait(1200);
  }
  return {
    ok: false,
    online: false,
    phase: 'api_timeout',
    needsApiKey: false,
    terminal: false,
    message: 'O AdsPower ainda está iniciando. Aguarde mais alguns instantes.'
  };
}

function launchAdspower(customPath = '') {
  if (customPath) saveLocalState({ adspowerExePath: String(customPath).trim() });
  const bootstrapAge = Date.now() - new Date(adspowerBootstrapState.updatedAt || 0).getTime();
  if (!customPath && ['online', 'running'].includes(adspowerBootstrapState.status) && bootstrapAge < 5 * 60 * 1000) {
    return Promise.resolve(getBootstrapState());
  }
  withDefaultBootstrapState();

  const exePath = customPath && fs.existsSync(String(customPath).trim()) ? String(customPath).trim() : findAdspowerExecutable();
  if (!['win32', 'darwin', 'linux'].includes(process.platform)) {
    return Promise.resolve(setBootstrapFailure(
      'A inicializacao automatica do AdsPower nao esta disponivel neste sistema.',
      {
        status: 'failed',
        phase: 'platform_unsupported',
        executable: exePath,
        terminal: true,
        processRunning: false,
        code: 400
      }
    ));
  }
  if (adspowerLaunchInFlight) {
    return adspowerLaunchInFlight;
  }

  const startAttempt = async () => {
    const startedAt = nowIsoDate();
    setBootstrapState({
      status: 'starting',
      phase: 'starting',
      message: 'Solicitando abertura do AdsPower em segundo plano...',
      executable: exePath,
      processRunning: false,
      api: null,
      needsApiKey: false,
      terminal: false,
      error: null,
      startedAt
    });

    try {
      if (!config.adspower.apiKey && !state.adspowerApiKey) {
        try { await refreshAdspowerRuntimeKey(); } catch (_error) {}
      }
      const authorizedApiKey = String(state.adspowerApiKey || config.adspower.apiKey || '').trim();
      if (!authorizedApiKey) {
        return setBootstrapFailure(
          'A chave do usuario autorizado ainda nao esta disponivel.',
          { status: 'requires_api_key', phase: 'requires_api_key', terminal: true, processRunning: false, needsApiKey: true, code: 401, startedAt }
        );
      }
      const authorizationFingerprint = crypto
        .createHash('sha256')
        .update(`${authorizedApiKey}|${config.adspower.baseUrl}`)
        .digest('hex');
      let isRunning = await isAdspowerProcessRunning();

      if (isRunning && authorizedApiKey) {
        const previousFingerprint = String(loadLocalState().adspowerAuthorizationFingerprint || '');
        const existingApi = previousFingerprint === authorizationFingerprint
          ? await waitForAdspowerApi(4000)
          : { online: false, phase: 'authorization_changed' };
        if (!existingApi.online) {
          setBootstrapState({
            status: 'starting',
            phase: 'restarting_with_authorized_user',
            message: 'Reiniciando o AdsPower com o usuario autorizado...',
            executable: exePath,
            processRunning: true,
            api: existingApi,
            needsApiKey: false,
            terminal: false,
            error: null,
            startedAt
          });
          await stopAdspowerProcesses();
          for (let attempt = 0; attempt < 10 && await isAdspowerProcessRunning(); attempt += 1) {
            await wait(500);
          }
          isRunning = await isAdspowerProcessRunning();
          if (isRunning) {
            return setBootstrapFailure(
              'Nao foi possivel reiniciar o AdsPower com o usuario autorizado.',
              { status: 'failed', phase: 'restart_failed', terminal: true, processRunning: true, code: 409, startedAt }
            );
          }
        }
      }

      if (isRunning) {
        setBootstrapState({
          status: 'starting',
          phase: 'process_started',
          message: 'AdsPower encontrado. Finalizando a conexão...',
          executable: exePath,
          processRunning: true,
          api: null,
          needsApiKey: false,
          terminal: false,
          error: null,
          startedAt
        });
      } else {
        if (!exePath) {
          return setBootstrapFailure(
            'Não foi possível localizar o AdsPower. Abra-o manualmente pelo atalho do Windows.',
            { status: 'not_found', phase: 'not_found', terminal: true, processRunning: false, code: 404, startedAt }
          );
        }
        if (!config.adspower.apiKey && !state.adspowerApiKey) {
          try { await refreshAdspowerRuntimeKey(); } catch (_error) {}
        }
        const runtimeApiKey = String(state.adspowerApiKey || config.adspower.apiKey || '').trim();
        if (!runtimeApiKey) {
          return setBootstrapFailure(
            'A conexão com o AdsPower ainda não está disponível. Aguarde e tente novamente.',
            { status: 'requires_api_key', phase: 'requires_api_key', terminal: true, processRunning: false, needsApiKey: true, code: 401, startedAt }
          );
        }
        await startAdspowerHeadless(exePath, runtimeApiKey);
        setBootstrapState({
          status: 'starting',
          phase: 'process_started',
          message: 'Iniciando AdsPower. Aguarde alguns instantes...',
          executable: exePath,
          processRunning: true,
          startedAt
        });
      }

      const api = await waitForAdspowerApi(ADSPOWER_BOOTSTRAP_TIMEOUT_MS);
      if (api.online) saveLocalState({ adspowerAuthorizationFingerprint: authorizationFingerprint });
      return setBootstrapStateFromApiResult(api, startedAt, exePath);
    } catch (error) {
      return setBootstrapFailure(
        error.message || 'Falha ao abrir o AdsPower.',
        {
          status: 'failed',
          phase: 'spawn_error',
          executable: exePath,
          processRunning: false,
          terminal: true,
          code: error.status || 500,
          startedAt
        }
      );
    }
  };

  adspowerLaunchInFlight = startAttempt().catch((error) => {
    return setBootstrapFailure(error.message || 'Falha no bootstrap do AdsPower.', {
      status: 'failed',
      phase: 'unexpected_error',
      executable: exePath,
      processRunning: false,
      terminal: true,
      code: error.status || 500,
      startedAt: nowIsoDate()
    });
  }).finally(() => {
    setTimeout(() => {
      if (adspowerLaunchInFlight) adspowerLaunchInFlight = null;
    }, 5000);
  });

  return adspowerLaunchInFlight;
}

async function login(body) {
  state.machine = buildMachineInfo();
  const payload = await portalRequest('/api/agent/login', {
    method: 'POST',
    body: JSON.stringify({
      email: body.email,
      password: body.password,
      machineFingerprint: state.machine.fingerprint,
      machineInfo: state.machine
    })
  });

  state.agentToken = payload.agentToken || state.agentToken;
  state.user = payload.user || null;
  heartbeatCache = { checkedAt: 0, payload: null };
  state.rememberedEmail = state.user && state.user.email || state.rememberedEmail;
  if (state.user || state.rememberedEmail) saveLocalState({ email: state.rememberedEmail, user: state.user });
  return payload;
}

async function customerLogin(body) {
  const previousEmail = String(state.user?.email || state.rememberedEmail || '').trim().toLowerCase();
  const requestedEmail = String(body.email || body.customerEmail || '').trim().toLowerCase();
  if (previousEmail && requestedEmail && previousEmail !== requestedEmail) state.cachedProfiles = null;
  state.machine = buildMachineInfo();
  const payload = await portalRequest('/api/agent/customer-login', {
    method: 'POST',
    body: JSON.stringify({
      email: body.email || body.customerEmail,
      machineFingerprint: state.machine.fingerprint,
      machineInfo: state.machine
    })
  });
  state.agentToken = payload.agentSessionToken || state.agentToken;
  state.user = payload.user || null;
  heartbeatCache = { checkedAt: 0, payload: null };
  state.rememberedEmail = (state.user && state.user.email) || body.email || body.customerEmail || state.rememberedEmail;
  saveLocalState({ email: state.rememberedEmail, user: state.user, cachedProfiles: state.cachedProfiles });
  return payload;
}

async function heartbeat(options = {}) {
  if (!state.agentToken) return { ok: false, authenticated: false };
  if (!options.force && heartbeatCache.payload && Date.now() - heartbeatCache.checkedAt < HEARTBEAT_CACHE_TTL_MS) {
    return heartbeatCache.payload;
  }
  if (heartbeatInFlight) return heartbeatInFlight;
  heartbeatInFlight = (async () => {
    state.machine = buildMachineInfo();
    const payload = await portalRequestWithSessionRefresh('/api/agent/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        machineFingerprint: state.machine.fingerprint,
        machineInfo: state.machine
      })
    });
    if (payload.user) {
      state.user = payload.user;
      saveLocalState({ email: state.rememberedEmail || state.user.email, user: state.user });
    }
    heartbeatCache = { checkedAt: Date.now(), payload };
    return payload;
  })().finally(() => { heartbeatInFlight = null; });
  return heartbeatInFlight;
}

function normalizeDashboardProfiles(payload) {
  if (payload.user) {
    state.user = payload.user;
    saveLocalState({ email: state.rememberedEmail || state.user.email, user: state.user });
  }
  const hiddenCategories = new Set(
    (payload.hiddenCategories || []).map((name) => String(name || '').trim()).filter(Boolean)
  );
  payload.categories = (payload.categories || []).filter((category) =>
    category?.mode !== 'special_group' &&
    !hiddenCategories.has(String(category?.name || '').trim())
  );
  payload.profiles = (payload.profiles || []).map((profile) => {
    const visibleCategoryNames = (profile.categoryNames || [profile.category || 'Geral'])
      .map((name) => String(name || '').trim())
      .filter((name) => name && !hiddenCategories.has(name));
    const categoryNames = visibleCategoryNames.length ? visibleCategoryNames : ['Geral'];
    return { ...profile, category: categoryNames[0], categoryNames };
  });
  return payload;
}

function cachedProfilesForCurrentUser() {
  const cached = state.cachedProfiles;
  if (!cached?.payload || !cached.savedAt) return null;
  const cachedEmail = String(cached.userEmail || '').trim().toLowerCase();
  const currentEmail = String(state.user?.email || state.rememberedEmail || '').trim().toLowerCase();
  if (cachedEmail && currentEmail && cachedEmail !== currentEmail) return null;
  const ageMs = Date.now() - new Date(cached.savedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > DASHBOARD_PROFILES_MAX_STALE_MS) return null;
  return { ...cached, ageMs };
}

async function refreshDashboardProfiles() {
  if (dashboardProfilesRefreshInFlight) return dashboardProfilesRefreshInFlight;
  dashboardProfilesRefreshInFlight = (async () => {
    await ensureMachineAuthenticated();
    const payload = normalizeDashboardProfiles(await portalRequestWithSessionRefresh('/api/agent/profiles', { method: 'GET' }));
    const cachedProfiles = {
      savedAt: new Date().toISOString(),
      userEmail: String(payload.user?.email || state.user?.email || state.rememberedEmail || '').trim().toLowerCase(),
      payload
    };
    state.cachedProfiles = cachedProfiles;
    saveLocalState({ cachedProfiles });
    emitRuntimeEvent('profiles-updated', { savedAt: cachedProfiles.savedAt });
    return { ...payload, cached: false, cacheSavedAt: cachedProfiles.savedAt };
  })().finally(() => { dashboardProfilesRefreshInFlight = null; });
  return dashboardProfilesRefreshInFlight;
}

async function listProfiles(options = {}) {
  const cached = cachedProfilesForCurrentUser();
  if (!options.forceRefresh && cached) {
    if (cached.ageMs > DASHBOARD_PROFILES_CACHE_TTL_MS) void refreshDashboardProfiles().catch(() => null);
    return { ...cached.payload, cached: true, stale: cached.ageMs > DASHBOARD_PROFILES_CACHE_TTL_MS, cacheSavedAt: cached.savedAt };
  }
  try {
    return await refreshDashboardProfiles();
  } catch (error) {
    if (cached) return { ...cached.payload, cached: true, stale: true, cacheFallback: true, cacheSavedAt: cached.savedAt };
    throw error;
  }
}

function currentCatalogRevision() {
  return Math.max(0, Number(state.cachedProfiles?.payload?.catalogRevision || 0));
}

function scheduleCatalogRefresh(event = {}) {
  const revision = Math.max(0, Number(event.revision || 0));
  if (revision <= currentCatalogRevision()) return;
  if (catalogRefreshTimer) clearTimeout(catalogRefreshTimer);
  const jitterMs = 250 + Math.floor(Math.random() * 1250);
  catalogRefreshTimer = setTimeout(() => {
    catalogRefreshTimer = null;
    void refreshDashboardProfiles().catch(() => null);
  }, jitterMs);
}

function handleAgentDataEvent(event = {}) {
  const scope = String(event.scope || '').trim().toLowerCase();
  if (!scope) return;
  if (scope === 'notices') emitRuntimeEvent('notices-changed', event);
  if (scope === 'support') emitRuntimeEvent('support-chat-changed', event);
  if (scope === 'popups' || (scope === 'support' && event.status === 'closed')) emitRuntimeEvent('popups-changed', event);
  if (scope === 'updates') emitRuntimeEvent('desktop-update-changed', event);
  if (scope === 'subscription' || scope === 'access') {
    heartbeatCache = { checkedAt: 0, payload: null };
    void heartbeat({ force: true })
      .then((health) => {
        emitRuntimeEvent('subscription-updated', { ...event, health });
        emitRuntimeEvent('popups-changed', event);
        emitRuntimeEvent('notices-changed', event);
        return refreshDashboardProfiles();
      })
      .catch((error) => emitRuntimeEvent('subscription-updated', { ...event, error: error.message || 'Acesso atualizado' }));
  }
  if (scope === 'sunbrowser') {
    saveLocalState({ sunbrowserLastCheckedAt: null });
    emitRuntimeEvent('sunbrowser-update-changed', event);
    if (event.action === 'publish' || event.status === 'published') {
      void ensurePublishedSunbrowserUpdates({ force: true }).catch(() => null);
    }
  }
}

async function consumeCatalogEventStream(signal) {
  const response = await fetch(`${PORTAL_URL}/api/agent/catalog-events?revision=${encodeURIComponent(currentCatalogRevision())}`, {
    method: 'GET',
    headers: state.agentToken ? { 'X-Agent-Token': state.agentToken } : {},
    signal
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || `Canal de catálogo retornou HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines = [];
  const dispatch = () => {
    if (!dataLines.length) return;
    try {
      const payload = JSON.parse(dataLines.join('\n'));
      if (eventName === 'catalog-version' || eventName === 'catalog-changed') scheduleCatalogRefresh(payload);
      if (eventName === 'agent-data-changed') handleAgentDataEvent(payload);
    } catch {
      // Ignora um evento malformado sem encerrar o canal persistente.
    }
    eventName = 'message';
    dataLines = [];
  };
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) dispatch();
      else if (line.startsWith('event:')) eventName = line.slice(6).trim() || 'message';
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
  }
  dispatch();
}

async function runCatalogEventStream() {
  if (catalogEventStreamRunning) return;
  catalogEventStreamRunning = true;
  let retryMs = 2000;
  while (catalogEventStreamRunning) {
    if (!state.agentToken || !state.user) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    const controller = new AbortController();
    catalogEventStreamController = controller;
    try {
      await consumeCatalogEventStream(controller.signal);
      retryMs = 2000;
    } catch (error) {
      if (!controller.signal.aborted && isInvalidAgentSession(error) && state.user) {
        try { await refreshCustomerSession(); } catch {}
      }
    } finally {
      if (catalogEventStreamController === controller) catalogEventStreamController = null;
    }
    if (catalogEventStreamRunning) {
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      retryMs = Math.min(30000, Math.round(retryMs * 1.7));
    }
  }
}

async function listAdminProfiles() {
  return portalRequest('/api/agent/admin/profiles', { method: 'GET' });
}

function normalizeAdspowerList(payload) {
  return Array.isArray(payload?.data?.list) ? payload.data.list : Array.isArray(payload?.data) ? payload.data : [];
}

function normalizeAdspowerProfile(profile, fallbackGroup = {}) {
  const groupId = String(profile.group_id || profile.groupId || fallbackGroup.id || '');
  const groupName = String(profile.group_name || profile.groupName || fallbackGroup.name || (groupId ? `Grupo ${groupId}` : 'Sem grupo'));
  return {
    id: String(profile.user_id || profile.profile_id || profile.id || ''),
    name: String(profile.name || profile.user_name || profile.profile_name || 'Sem nome'),
    groupId,
    groupName,
    serialNumber: profile.serial_number || profile.serialNumber || null,
    status: profile.status || profile.remark || null,
    raw: profile,
  };
}

function groupAdspowerProfiles(profiles) {
  const byGroup = new Map();
  profiles.map((profile) => normalizeAdspowerProfile(profile)).forEach((profile) => {
    const groupKey = profile.groupId || profile.groupName || 'sem-grupo';
    if (!byGroup.has(groupKey)) {
      byGroup.set(groupKey, {
        group: { id: profile.groupId, name: profile.groupName, raw: null },
        profiles: []
      });
    }
    byGroup.get(groupKey).profiles.push(profile);
  });

  return Array.from(byGroup.values()).sort((left, right) => left.group.name.localeCompare(right.group.name, 'pt-BR'));
}

async function fetchLocalAdspowerProfiles() {
  try {
    if (!config.adspower.apiKey && !state.adspowerApiKey) {
      await refreshAdspowerRuntimeKey();
    }
    const profilesPayload = await listAdspowerProfiles('');
    const profiles = normalizeAdspowerList(profilesPayload);
    const grouped = groupAdspowerProfiles(profiles);
    const groups = grouped.map((item) => item.group);
    return { ok: true, cached: false, groups, grouped, rawProfiles: profilesPayload };
  } catch (error) {
    const message = String(error && error.message || '');
    const code = error && error.body && error.body.code;
    const requiresApiKey = code === -1 && /api[-_ ]?key/i.test(message);
    if (requiresApiKey) {
      return {
        ok: true,
        cached: false,
        connected: true,
        needsApiKey: true,
        groups: [],
        grouped: [],
        rawProfiles: error.body || null,
        message: 'A conexão com o AdsPower precisa de atenção. Tente novamente em instantes.'
      };
    }
    const processRunning = await isAdspowerProcessRunning();
    return {
      ok: false,
      connected: false,
      processRunning,
      executableFound: Boolean(findAdspowerExecutable()),
      groups: [], grouped: [], rawProfiles: null,
      message: processRunning
        ? 'O AdsPower foi encontrado, mas ainda não está pronto. Aguarde alguns instantes.'
        : 'Não foi possível localizar o AdsPower. Aguarde e tente conectar novamente.'
    };
  }
}

async function refreshAdspowerRuntimeKey() {
  if (config.adspower.apiKey || state.adspowerApiKey) {
    if (state.adspowerApiKey) setAdspowerApiKey(state.adspowerApiKey);
    return { ok: true, cached: true };
  }
  await ensureMachineAuthenticated();
  const payload = await portalRequestWithSessionRefresh('/api/agent/adspower-runtime-key', { method: 'GET' });
  if (payload && payload.adspowerApiKey) {
    state.adspowerApiKey = String(payload.adspowerApiKey || '').trim();
    setAdspowerApiKey(state.adspowerApiKey);
    return { ok: true };
  }
  return { ok: false };
}

async function listLocalAdspowerProfiles(options = {}) {
  const now = Date.now();
  if (!options.forceRefresh && adspowerProfilesCache.payload && adspowerProfilesCache.expiresAt > now) {
    return { ...adspowerProfilesCache.payload, cached: true, cacheExpiresAt: new Date(adspowerProfilesCache.expiresAt).toISOString() };
  }

  if (adspowerProfilesInFlight) return adspowerProfilesInFlight;

  adspowerProfilesInFlight = fetchLocalAdspowerProfiles()
    .then((payload) => {
      adspowerProfilesCache = {
        expiresAt: Date.now() + ADSPOWER_PROFILES_CACHE_TTL_MS,
        payload
      };
      return { ...payload, cacheExpiresAt: new Date(adspowerProfilesCache.expiresAt).toISOString() };
    })
    .finally(() => {
      adspowerProfilesInFlight = null;
    });

  return adspowerProfilesInFlight;
}

async function createAdminProfile(body) {
  return portalRequest('/api/agent/admin/profiles', { method: 'POST', body: JSON.stringify(body) });
}

async function updateAdminProfile(id, body) {
  return portalRequest(`/api/agent/admin/profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
}

async function deleteAdminProfile(id) {
  return portalRequest(`/api/agent/admin/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function machineDebug() {
  state.machine = buildMachineInfo();
  return portalRequest('/api/agent/machine-debug', {
    method: 'POST',
    body: JSON.stringify({
      machineFingerprint: state.machine.fingerprint,
      machineInfo: state.machine
    })
  });
}

async function startProfileSession(profileId) {
  await ensureMachineAuthenticated();
  state.machine = buildMachineInfo();
  const payload = await portalRequestWithSessionRefresh('/api/agent/profile-sessions/start', {
    method: 'POST',
    body: JSON.stringify({
      profileId,
      machineFingerprint: state.machine.fingerprint,
      machineInfo: state.machine
    })
  });
  state.currentProfileSession = payload.profileSession || null;
  persistProfileAccessState();
  return payload;
}

async function renewProfileSession(profileSession) {
  if (!profileSession?.id) return null;
  const payload = await portalRequestWithSessionRefresh(
    `/api/agent/profile-sessions/${encodeURIComponent(profileSession.id)}/heartbeat`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  state.currentProfileSession = payload.profileSession || profileSession;
  persistProfileAccessState();
  return state.currentProfileSession;
}

async function recoverActiveProfileSession() {
  const payload = await portalRequestWithSessionRefresh('/api/agent/profile-sessions/active', { method: 'GET' });
  state.currentProfileSession = payload.profileSession || null;
  persistProfileAccessState();
  return state.currentProfileSession;
}

async function resolveProfileLaunchUrl(profileId, requestedLaunchUrl = '') {
  const directLaunchUrl = normalizeProfileStartUrl(requestedLaunchUrl);
  if (directLaunchUrl) return directLaunchUrl;
  const payload = await portalRequestWithSessionRefresh('/api/agent/profiles', { method: 'GET' });
  const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  const profile = profiles.find((item) => {
    if (item.profileId === profileId) return true;
    return Array.isArray(item.profileOptions) && item.profileOptions.some((option) => option.profileId === profileId);
  });
  return normalizeProfileStartUrl(profile && profile.startUrl);
}

async function loadProfileRuntimeDefinition(sourceProfileId = '') {
  const id = String(sourceProfileId || '').trim();
  if (!id) return null;
  const payload = await portalRequestWithSessionRefresh('/api/agent/profiles', { method: 'GET' });
  const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  return profiles.find((profile) => String(profile.id || profile.sourceProfileId || '') === id) || null;
}

function buildProfileRotationPlan(profile = null, fallbackProfileId = '') {
  const ids = Array.isArray(profile?.rotatingProfileIds)
    ? Array.from(new Set(profile.rotatingProfileIds.map((profileId) => String(profileId || '').trim()).filter(Boolean)))
    : [];
  if (profile?.profileSelectionMode !== 'rotation' || !ids.length) {
    return { profileId: String(fallbackProfileId || '').trim(), rotating: false };
  }
  const categoryId = String(profile.rotationCategoryId || profile.category || 'default').trim() || 'default';
  const currentIndex = Math.max(0, Number.parseInt(state.profileRotationIndexes[categoryId], 10) || 0) % ids.length;
  return {
    profileId: ids[currentIndex],
    rotating: true,
    categoryId,
    currentIndex,
    nextIndex: (currentIndex + 1) % ids.length,
    total: ids.length
  };
}

function commitProfileRotation(rotationPlan = {}) {
  if (!rotationPlan.rotating || !rotationPlan.categoryId) return;
  state.profileRotationIndexes[rotationPlan.categoryId] = rotationPlan.nextIndex;
}

async function loadProfileLocalStorage(sourceProfileId = '') {
  const id = String(sourceProfileId || '').trim();
  if (!id) return { enabled: false };
  try {
    return await portalRequestWithSessionRefresh(`/api/agent/profiles/${encodeURIComponent(id)}/local-storage`, { method: 'GET' });
  } catch (error) {
    if (error?.status === 404) return { enabled: false };
    throw error;
  }
}

function adspowerWebSocketCandidate(payload = {}) {
  const data = payload?.data || payload || {};
  return String(data?.ws?.puppeteer || data?.wsUrl || data?.ws_url || data?.webSocketDebuggerUrl || '').trim();
}

async function resolveAdspowerWebSocket(startResult, profileId) {
  let endpoint = adspowerWebSocketCandidate(startResult);
  let payload = startResult;
  if (!endpoint) {
    payload = await getBrowserStatus(profileId).catch(() => ({}));
    endpoint = adspowerWebSocketCandidate(payload);
  }
  if (/^wss?:\/\//i.test(endpoint)) return endpoint;
  const data = payload?.data || payload || {};
  const selenium = String(data?.ws?.selenium || '').trim().replace(/^https?:\/\//i, '');
  if (selenium) {
    const response = await fetch(`http://${selenium}/json/version`);
    if (response.ok) {
      const version = await response.json();
      if (version.webSocketDebuggerUrl) return String(version.webSocketDebuggerUrl);
    }
  }
  throw new Error('O AdsPower não forneceu o canal seguro para aplicar a sessão.');
}

function createCdpConnection(endpoint, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const pending = new Map();
    let sequence = 0;
    let settled = false;
    const rejectPending = (error) => {
      for (const operation of pending.values()) {
        clearTimeout(operation.timer);
        operation.reject(error);
      }
      pending.clear();
    };
    const timer = setTimeout(() => {
      socket.terminate();
      if (!settled) reject(new Error('Tempo limite ao conectar com o navegador AdsPower.'));
    }, timeoutMs);
    socket.once('error', (error) => {
      clearTimeout(timer);
      rejectPending(error);
      if (!settled) reject(error);
    });
    socket.once('close', () => rejectPending(new Error('A pagina do AdsPower foi fechada durante a configuracao.')));
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (!message.id || !pending.has(message.id)) return;
      const operation = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(operation.timer);
      if (message.error) operation.reject(new Error(message.error.message || 'Falha no navegador AdsPower'));
      else operation.resolve(message.result || {});
    });
    socket.once('open', () => {
      clearTimeout(timer);
      settled = true;
      resolve({
        send(method, params = {}, sessionId = null, commandTimeoutMs = 6000) {
          return new Promise((resolveCommand, rejectCommand) => {
            const id = ++sequence;
            const commandTimer = setTimeout(() => {
              pending.delete(id);
              rejectCommand(new Error(`Tempo limite no comando ${method} do navegador AdsPower.`));
            }, commandTimeoutMs);
            pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer: commandTimer });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
        close() {
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
        }
      });
    });
  });
}

async function applyProfileSessionCookiesViaCdp(startResult, profileId, sessionConfig) {
  if (!sessionConfig?.enabled || !Array.isArray(sessionConfig.cookies) || !sessionConfig.cookies.length) return null;
  const targetUrl = normalizeProfileStartUrl(sessionConfig.targetUrl);
  if (!targetUrl) throw new Error('A URL da sessão deste perfil não está configurada.');
  const endpoint = await resolveAdspowerWebSocket(startResult, profileId);
  const cdp = await createCdpConnection(endpoint);
  try {
    const targets = await cdp.send('Target.getTargets');
    let target = (targets.targetInfos || []).find((item) => item.type === 'page');
    if (!target) {
      const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
      target = { targetId: created.targetId };
    }
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await cdp.send('Network.enable', {}, sessionId);
    let applied = 0;
    let rejected = 0;
    for (const cookie of sessionConfig.cookies) {
      try {
        const result = await cdp.send('Network.setCookie', cookie, sessionId);
        if (result.success === false) rejected += 1;
        else applied += 1;
      } catch {
        rejected += 1;
      }
    }
    if (!applied) throw new Error('Nenhum cookie da sessão foi aceito pelo navegador.');
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: targetUrl }, sessionId);
    return { applied, rejected, targetUrl };
  } finally {
    cdp.close();
  }
}

function adspowerDebuggerBase(payload = {}) {
  const data = payload?.data || payload || {};
  const selenium = String(data?.ws?.selenium || '').trim();
  if (selenium) return /^https?:\/\//i.test(selenium) ? selenium.replace(/\/+$/, '') : `http://${selenium.replace(/\/+$/, '')}`;
  const browserEndpoint = adspowerWebSocketCandidate(payload);
  if (!/^wss?:\/\//i.test(browserEndpoint)) return '';
  try {
    const parsed = new URL(browserEndpoint);
    return `${parsed.protocol === 'wss:' ? 'https:' : 'http:'}//${parsed.host}`;
  } catch {
    return '';
  }
}

async function resolveAdspowerPageWebSocket(startResult, profileId, targetUrl = '') {
  let payload = startResult;
  let debuggerBase = adspowerDebuggerBase(payload);
  if (!debuggerBase) {
    payload = await getBrowserStatus(profileId).catch(() => ({}));
    debuggerBase = adspowerDebuggerBase(payload);
  }
  if (!debuggerBase) throw new Error('O AdsPower nao forneceu a porta da pagina aberta.');
  let lastError = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      const response = await fetch(`${debuggerBase}/json/list`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets = await response.json();
      const pages = (Array.isArray(targets) ? targets : []).filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      let expectedOrigin = '';
      try { expectedOrigin = targetUrl ? new URL(targetUrl).origin : ''; } catch {}
      const pageTarget = expectedOrigin
        ? pages.find((target) => String(target.url || '').startsWith(expectedOrigin))
        : pages.find((target) => !/^about:blank$/i.test(String(target.url || ''))) || pages[0];
      if (pageTarget) return String(pageTarget.webSocketDebuggerUrl);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Nao foi possivel acessar a pagina aberta do AdsPower${lastError ? `: ${lastError.message}` : '.'}`);
}

function localStorageInjectionExpression(origin, entries) {
  const payload = JSON.stringify({ origin, entries }).replace(/</g, '\\u003c');
  return `(() => {
    const config = ${payload};
    if (location.origin !== config.origin) return { applied: 0, skipped: true };
    const configuredNames = new Set(config.entries.map((entry) => String(entry.name)));
    const managedKeyPatterns = [
      /^currentVideoModelId$/,
      /^video-recent-models(?:-|$)/,
      /^user\\.videoGenerator\\./,
      /^pikaso:unlimited-mode:/,
      /^imageGenerator\\.quality$/,
      /^image:expand:v4:resolution-by-mode-v1$/
    ];
    const removed = [];
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && !configuredNames.has(key) && managedKeyPatterns.some((pattern) => pattern.test(key))) {
        localStorage.removeItem(key);
        removed.push(key);
      }
    }
    let applied = 0;
    let videoModelId = '';
    for (const entry of config.entries) {
      let value = String(entry.value ?? '');
      try {
        const parsed = JSON.parse(value);
        if (String(entry.name) === 'currentVideoModelId') {
          videoModelId = String(parsed?.value || parsed || '').trim();
        }
        if (parsed && parsed.meta && Number.isFinite(Number(parsed.meta.expiration)) && Number(parsed.meta.expiration) > 0) {
          parsed.meta.expiration = Date.now() + (30 * 24 * 60 * 60 * 1000);
          value = JSON.stringify(parsed);
        }
      } catch {}
      localStorage.setItem(String(entry.name), value);
      applied += 1;
    }
    if (videoModelId && !configuredNames.has('video-recent-models-v1')) {
      localStorage.setItem('video-recent-models-v1', JSON.stringify([videoModelId]));
    }
    const values = {};
    for (const entry of config.entries) values[String(entry.name)] = localStorage.getItem(String(entry.name));
    values['video-recent-models-v1'] = localStorage.getItem('video-recent-models-v1');
    return { applied, removed, videoModelId, values };
  })()`;
}

function localStorageConfiguredLaunchUrl(storageConfig = {}, fallbackUrl = '') {
  const targetUrl = normalizeProfileStartUrl(storageConfig.targetUrl || fallbackUrl);
  if (!targetUrl || !Array.isArray(storageConfig.entries)) return targetUrl;
  const modelEntry = storageConfig.entries.find((entry) => String(entry?.name || '') === 'currentVideoModelId');
  if (!modelEntry) return targetUrl;
  try {
    const parsed = JSON.parse(String(modelEntry.value || ''));
    const modelId = String(parsed?.value || parsed || '').trim();
    if (!modelId) return targetUrl;
    const url = new URL(targetUrl);
    if (/\/ai-video-generator\/?$/i.test(url.pathname)) url.searchParams.set('modelId', modelId);
    return url.toString();
  } catch {
    return targetUrl;
  }
}

function localStorageLaunchExpression(origin, entries, targetUrl = '') {
  const injectionExpression = localStorageInjectionExpression(origin, entries);
  const destination = JSON.stringify(targetUrl).replace(/</g, '\\u003c');
  return `(() => {
    const result = ${injectionExpression};
    if (!result || result.skipped) return result;
    const destination = ${destination};
    setTimeout(() => location.replace(destination), 50);
    return result;
  })();`;
}

async function applyProfileLocalStorageAtRuntime(startResult, profileId, storageConfig) {
  if (!storageConfig?.enabled || !Array.isArray(storageConfig.entries) || !storageConfig.entries.length) return null;
  const targetUrl = localStorageConfiguredLaunchUrl(storageConfig, storageConfig.targetUrl);
  if (!targetUrl) throw new Error('A URL das configuracoes deste perfil nao esta configurada.');
  const origin = String(storageConfig.origin || new URL(targetUrl).origin);
  const expression = localStorageLaunchExpression(origin, storageConfig.entries, targetUrl);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let cdp = null;
    try {
      const endpoint = await resolveAdspowerPageWebSocket(startResult, profileId, targetUrl);
      cdp = await createCdpConnection(endpoint);
      const evaluation = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        null,
        5000
      );
      const result = evaluation?.result?.value || {};
      const applied = Number(result.applied || 0);
      if (result.skipped) throw new Error(`A pagina aberta nao pertence ao dominio ${origin}.`);
      if (applied !== storageConfig.entries.length) {
        throw new Error(`Somente ${applied} de ${storageConfig.entries.length} configuracoes foram aplicadas.`);
      }
      return {
        applied,
        verified: true,
        origin,
        targetUrl,
        videoModelId: String(result.videoModelId || ''),
        removedKeys: Array.isArray(result.removed) ? result.removed : [],
        values: result.values || {},
        isolatedByModel: Boolean(result.videoModelId),
        attempt,
        mode: 'local-storage-runtime-reload'
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 350));
    } finally {
      if (cdp) cdp.close();
    }
  }
  throw lastError || new Error('Nao foi possivel aplicar as configuracoes do perfil.');
}

async function reportOpenResult(sessionId, result, error = null) {
  return portalRequest(`/api/agent/profile-sessions/${encodeURIComponent(sessionId)}/open-result`, {
    method: 'POST',
    body: JSON.stringify({ result, error })
  });
}

function isAdspowerKernelPending(error) {
  const text = String(error?.message || error?.body?.msg || error?.body?.message || '').toLowerCase();
  return error?.code === 'ADSPOWER_REQUEST_TIMEOUT' || ((text.includes('sunbrowser') || text.includes('kernel'))
    && (text.includes('updating') || text.includes('waiting for download') || text.includes('downloading') || text.includes('download') || text.includes('being installed') || text.includes('installing')));
}

function isAdspowerKernelInstallingMessage(error) {
  const text = String(error?.message || error?.body?.msg || error?.body?.message || '').toLowerCase();
  return (text.includes('sunbrowser') || text.includes('kernel'))
    && (text.includes('being installed') || text.includes('installing'));
}

function kernelVersionFromError(error) {
  const text = String(error?.message || error?.body?.msg || error?.body?.message || '');
  const match = text.match(/(?:sunbrowser|kernel)[^0-9]{0,12}(\d{2,3})/i);
  return match ? Number.parseInt(match[1], 10) : expectedKernelVersion();
}

async function openProfileWaitingForKernel(profileId, options = {}) {
  const maxAttempts = Math.max(1, Number(process.env.ADSPOWER_OPEN_MAX_ATTEMPTS || 5));
  const startedAt = Date.now();
  let attempts = 0;
  let lastError = null;
  let notifiedKernelPreparation = false;
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      return await openConfiguredProfile(profileId, options);
    } catch (error) {
      lastError = error;
      const actualState = await getProfileOpenState(profileId).catch(() => ({ open: false }));
      if (actualState.open) {
        if (notifiedKernelPreparation) emitRuntimeEvent('kernel-install', { status: 'ready', percent: 100, message: 'Tudo pronto. Abrindo seu perfil...' });
        return { code: 0, msg: 'Success', data: { status: 'Active' }, recoveredFromTimeout: true, runtime: actualState };
      }
      const kernelVersion = kernelVersionFromError(error);
      const installed = kernelIsInstalled(kernelVersion);
      const pending = isAdspowerKernelPending(error);
      if (isAdspowerKernelInstallingMessage(error)) {
        emitRuntimeEvent('kernel-install', { status: 'ready', percent: 100, message: 'Preparação concluída. Esta etapa acontece somente na primeira vez.' });
        return { code: 0, msg: 'Success', data: { status: 'Preparing' }, kernelInstalled: true, kernelVersion, recoveredFromInstallMessage: true };
      }
      if (attempts >= maxAttempts || (!pending && !installed)) throw error;
      const waitElapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      if (!installed) {
        notifiedKernelPreparation = true;
        emitRuntimeEvent('kernel-install', {
          status: 'downloading',
          percent: null,
          message: 'Preparando o navegador pela primeira vez. Nas próximas aberturas será mais rápido. Não feche o painel.',
          attempts,
          elapsedSeconds: waitElapsedSeconds,
          kernelVersion
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  throw lastError || new Error('Não foi possível confirmar a abertura do perfil após 5 tentativas.');
}

async function closeProfileSession(sessionId, result = null) {
  return portalRequest(`/api/agent/profile-sessions/${encodeURIComponent(sessionId)}/close`, {
    method: 'POST',
    body: JSON.stringify({ result })
  });
}

async function handleOpen(body) {
  const requestedProfileId = resolveProfileId(body);
  if (!requestedProfileId) throw new Error('profileId nao informado e ADSPOWER_PROFILE_ID nao configurado');
  const sourceProfileId = String(body.cardKey || body.sourceProfileId || '').trim();
  const runtimeProfile = await loadProfileRuntimeDefinition(sourceProfileId);
  const rotationPlan = buildProfileRotationPlan(runtimeProfile, requestedProfileId);
  const profileId = rotationPlan.profileId;
  const storageConfig = await loadProfileLocalStorage(sourceProfileId);
  const configuredLaunchUrl = normalizeProfileStartUrl(body.launchUrl || body.startUrl || body.initialUrl || runtimeProfile?.startUrl || '')
    || await resolveProfileLaunchUrl(profileId, '');
  const launchUrl = storageConfig.enabled ? localStorageConfiguredLaunchUrl(storageConfig, configuredLaunchUrl) : configuredLaunchUrl;
  if (storageConfig.enabled) storageConfig.targetUrl = launchUrl;
  const kernelPlan = buildKernelPlan();
  if (kernelPlan.shouldShowUpdate) {
    rememberKernelStarted(kernelPlan.kernelVersion);
    emitRuntimeEvent('kernel-status', { status: 'progress', kernelVersion: kernelPlan.kernelVersion, title: 'Preparando seu perfil', message: 'Estamos preparando tudo para abrir seu perfil. Aguarde alguns instantes.' });
  }
  const currentOpenState = await getProfileOpenState(profileId);
  if (currentOpenState.open) {
    const previous = state.openProfiles.get(profileId) || {};
    const previousUrl = normalizeProfileStartUrl(previous.launchUrl || '');
    const differentInitialPage = Boolean(launchUrl && previousUrl && launchUrl !== previousUrl);
    const message = differentInitialPage
      ? 'Este perfil ja esta aberto com outra pagina inicial. Feche o perfil antes de abrir com uma pagina diferente.'
      : 'Este perfil ja esta aberto. Feche o perfil antes de abrir novamente.';
    let localStorageSession = null;
    let localStorageWarning = null;
    try {
      localStorageSession = await Promise.race([
        applyProfileLocalStorageAtRuntime(currentOpenState.adspower, profileId, storageConfig),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tempo limite ao aplicar as configuracoes do perfil.')), 12000))
      ]);
    } catch (error) {
      localStorageWarning = error.message;
    }
    const cardKey = String(body.cardKey || body.cardId || body.id || profileId);
    state.openProfiles.set(profileId, { profileId, cardKey, launchUrl: previousUrl || launchUrl, openedAt: previous.openedAt || new Date().toISOString(), adspower: currentOpenState.adspower });
    let activeSession = state.currentProfileSession;
    if (!activeSession || String(activeSession.profileId || '') !== profileId || !['opening', 'opened'].includes(activeSession.status)) {
      const recovered = await startProfileSession(profileId);
      activeSession = recovered.profileSession || null;
      if (activeSession?.id) await reportOpenResult(activeSession.id, currentOpenState.adspower || {}, null);
    }
    commitProfileRotation(rotationPlan);
    persistProfileAccessState();
    emitRuntimeEvent('kernel-status', { status: 'ready', kernelVersion: kernelPlan.kernelVersion, title: 'Perfil pronto para uso', message: 'Seu perfil está aberto e pronto para você usar.' });
    return {
      ok: true,
      alreadyOpen: true,
      warning: message,
      message,
      profileId,
      launchUrl,
      currentLaunchUrl: previousUrl || null,
      localStorageSession,
      localStorageWarning,
      rotation: rotationPlan.rotating ? { categoryId: rotationPlan.categoryId, option: rotationPlan.currentIndex + 1, total: rotationPlan.total } : null,
      adspower: currentOpenState.adspower,
      profileSession: activeSession
    };
  }

  const sessionStart = await startProfileSession(profileId);
  const session = sessionStart.profileSession;

  try {
    const result = await openProfileWaitingForKernel(profileId, { launchUrl });
    let localStorageSession = null;
    let localStorageWarning = null;
    try {
      localStorageSession = await Promise.race([
        applyProfileLocalStorageAtRuntime(result, profileId, storageConfig),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tempo limite ao aplicar as configuracoes do perfil.')), 12000))
      ]);
    } catch (error) {
      localStorageWarning = error.message;
    }
    const cardKey = String(body.cardKey || body.cardId || body.id || profileId);
    state.openProfiles.set(profileId, { profileId, cardKey, launchUrl, openedAt: new Date().toISOString(), adspower: result });
    commitProfileRotation(rotationPlan);
    persistProfileAccessState();
    state.profileStatusCache.set(profileId, { profileId, cardKey, status: 'open', browserStatus: 'open', checkedAt: new Date().toISOString() });
    ensureProfileStatusMonitor();
    if (kernelPlan.shouldShowUpdate) {
      rememberKernelCompleted(kernelPlan.kernelVersion);
    }
    emitRuntimeEvent('kernel-status', { status: 'ready', kernelVersion: kernelPlan.kernelVersion, title: 'Perfil pronto para uso', message: 'Seu perfil está aberto e pronto para você usar.' });
    if (session && session.id) await reportOpenResult(session.id, result, null);
    return {
      ok: true,
      profileId,
      profileSession: session,
      extensionSessionToken: session && session.sessionToken,
      launchUrl,
      localStorageSession,
      localStorageWarning,
      rotation: rotationPlan.rotating ? { categoryId: rotationPlan.categoryId, option: rotationPlan.currentIndex + 1, total: rotationPlan.total } : null,
      kernelPlan: { ...kernelPlan, alreadyCompleted: true, shouldShowUpdate: false },
      adspower: result
    };
  } catch (error) {
    if (session && session.id) {
      await reportOpenResult(session.id, null, error.message).catch(() => null);
    }
    throw error;
  }
}

async function handleClose(body) {
  const requestedProfileId = resolveProfileId(body);
  const requestedCardKey = String(body.cardKey || body.sourceProfileId || body.cardId || '').trim();
  const trackedProfile = requestedCardKey
    ? Array.from(state.openProfiles.values()).find((entry) => String(entry.cardKey || '') === requestedCardKey)
    : null;
  const profileId = String(trackedProfile?.profileId || requestedProfileId || '').trim();
  if (!profileId) throw new Error('profileId nao informado e ADSPOWER_PROFILE_ID nao configurado');

  const beforeClose = await getProfileOpenState(profileId).catch(() => ({ open: false }));
  let result;
  if (!beforeClose.open) {
    result = { code: 0, msg: 'Success', data: { status: 'AlreadyClosed' }, alreadyClosed: true };
  } else {
    try {
      result = await closeConfiguredProfile(profileId);
    } catch (error) {
      const afterClose = await getProfileOpenState(profileId).catch(() => ({ open: false }));
      if (afterClose.open) throw error;
      result = { code: 0, msg: 'Success', data: { status: 'Closed' }, recoveredFromCloseError: true };
    }
  }
  const cardKey = requestedCardKey || profileCardKey(profileId);
  state.openProfiles.delete(profileId);
  state.profileStatusCache.set(profileId, { profileId, cardKey, status: 'closed', browserStatus: 'closed', checkedAt: new Date().toISOString() });
  emitRuntimeEvent('profile-status', { profileId, cardKey, status: 'closed' });
  const sessionId = body.profileSessionId || (state.currentProfileSession && state.currentProfileSession.id);
  if (sessionId) await closeProfileSession(sessionId, result).catch(() => null);
  if (state.currentProfileSession && state.currentProfileSession.id === sessionId) state.currentProfileSession = null;
  persistProfileAccessState();
  return { ok: true, profileId, adspower: result };
}

async function handleStatus(body) {
  const profileId = resolveProfileId(body);
  if (!profileId) throw new Error('profileId nao informado e ADSPOWER_PROFILE_ID nao configurado');
  const runtime = await verifyProfileRuntimeState(profileId);
  state.profileStatusCache.set(profileId, runtime);
  return { ok: true, profileId, status: runtime.status, runtime, adspower: runtime.adspower, profileSession: state.currentProfileSession };
}

function extensionBlocked(reason, message, extra = {}) {
  return {
    ok: true,
    allowed: false,
    status: reason,
    reason,
    message,
    action: 'BLOCK',
    redirectUrl: config.paymentUrl,
    checkEverySeconds: 30,
    ...extra
  };
}

function extensionAllowed(session, extra = {}) {
  return {
    ok: true,
    allowed: true,
    status: 'active',
    reason: 'active_customer',
    message: null,
    action: 'ALLOW',
    checkEverySeconds: 30,
    extensionSessionToken: session.sessionToken,
    expiresAt: session.expiresAt,
    user: state.user,
    machine: state.machine,
    profileSession: state.currentProfileSession,
    ...extra
  };
}

function extensionProfileIsAllowed(heartbeatResult, profileId) {
  const profiles = Array.isArray(heartbeatResult && heartbeatResult.profiles) ? heartbeatResult.profiles : [];
  return profiles.some((profile) => {
    const available = profile && profile.available !== false && profile.canOpen !== false && !profile.maintenance;
    const options = Array.isArray(profile && profile.profileOptions) ? profile.profileOptions : [];
    return available && (String(profile.profileId || '') === profileId || options.some((option) => String(option.profileId || '') === profileId));
  });
}

function activeProfileSession() {
  const session = state.currentProfileSession;
  if (!session || !session.id || !session.profileId) return null;
  if (session.status && !['opening', 'opened'].includes(session.status)) return null;
  return session;
}

async function startExtensionSession(body = {}) {
  await ensureMachineAuthenticated();
  cleanupExtensionSessions();

  state.machine = buildMachineInfo();
  const heartbeatResult = await heartbeat();
  if (!heartbeatResult || heartbeatResult.canAccessService !== true) {
    return extensionBlocked('subscription_blocked', 'Assinatura bloqueada ou inativa. Regularize o acesso para continuar.', { heartbeat: heartbeatResult });
  }

  const profileSessionCandidate = activeProfileSession() || await recoverActiveProfileSession();
  const profileSession = profileSessionCandidate ? await renewProfileSession(profileSessionCandidate) : null;
  if (!profileSession) {
    return extensionBlocked('profile_session_required', 'Abra este perfil pelo NinjaFlix Agent para autenticar o acesso.');
  }

  const requestedProfileId = String(body.browserProfileId || body.profileId || '').trim();
  const profileId = String(profileSession.profileId || '').trim();
  if (requestedProfileId && requestedProfileId !== profileId) {
    return extensionBlocked('profile_mismatch', 'Este perfil não corresponde à sessão aberta pelo NinjaFlix Agent.');
  }
  if (!extensionProfileIsAllowed(heartbeatResult, profileId)) {
    return extensionBlocked('profile_not_allowed', 'Esta ferramenta não está liberada no plano atual.');
  }

  const session = {
    id: randomToken('exts'),
    sessionToken: randomToken('ext'),
    userId: state.user && state.user.id,
    customerEmail: state.user && state.user.email,
    profileId,
    profileSessionId: profileSession.id,
    extensionInstanceId: String(body.extensionInstanceId || ''),
    origin: body.origin || null,
    url: body.url || null,
    tabId: body.tabId || null,
    extensionVersion: body.extensionVersion || null,
    machineFingerprint: state.machine.fingerprint,
    createdAt: nowIso(),
    lastSeenAt: nowIso(),
    expiresAt: addSeconds(new Date(), 2 * 60 * 60)
  };

  state.extensionSessions.set(session.sessionToken, session);
  return extensionAllowed(session, { policy: { allowed: true, reason: 'active_customer', checkEverySeconds: 30 } });
}

async function extensionHeartbeat(body = {}) {
  await ensureMachineAuthenticated();
  cleanupExtensionSessions();

  const token = String(body.extensionSessionToken || body.sessionToken || '').trim();
  const session = token ? state.extensionSessions.get(token) : null;
  if (!session) {
    return extensionBlocked('extension_session_expired', 'Sesso da extensao expirada. Reabra o perfil pelo agente local para liberar o acesso.');
  }

  state.machine = buildMachineInfo();
  if (session.machineFingerprint !== state.machine.fingerprint) {
    state.extensionSessions.delete(token);
    return extensionBlocked('machine_changed', 'Maquina diferente da sessao autorizada. Faca login novamente no agente local.');
  }
  if (session.extensionInstanceId && String(body.extensionInstanceId || '') !== session.extensionInstanceId) {
    state.extensionSessions.delete(token);
    return extensionBlocked('extension_instance_changed', 'A instalação da extensão não corresponde à sessão autenticada.');
  }

  const profileSessionCandidate = activeProfileSession();
  const profileSession = profileSessionCandidate ? await renewProfileSession(profileSessionCandidate) : null;
  if (!profileSession || profileSession.id !== session.profileSessionId || String(profileSession.profileId || '') !== session.profileId) {
    state.extensionSessions.delete(token);
    return extensionBlocked('profile_session_expired', 'A sessão do perfil foi encerrada. Abra o perfil novamente pelo NinjaFlix Agent.');
  }

  let heartbeatResult = null;
  try {
    heartbeatResult = await heartbeat();
  } catch (error) {
    state.extensionSessions.delete(token);
    return extensionBlocked('portal_unavailable', 'Nao foi possivel validar a assinatura no portal central. Acesso bloqueado por seguranca.', { details: error.payload || null });
  }

  if (!heartbeatResult || heartbeatResult.canAccessService !== true) {
    state.extensionSessions.delete(token);
    return extensionBlocked('subscription_blocked', 'Assinatura bloqueada ou inativa. Regularize o acesso para continuar.', { heartbeat: heartbeatResult });
  }
  if (!extensionProfileIsAllowed(heartbeatResult, session.profileId)) {
    state.extensionSessions.delete(token);
    return extensionBlocked('profile_not_allowed', 'Esta ferramenta não está liberada no plano atual.');
  }

  session.lastSeenAt = nowIso();
  session.url = body.url || session.url;
  session.origin = body.origin || session.origin;
  session.tabId = body.tabId || session.tabId;
  session.expiresAt = addSeconds(new Date(), 2 * 60 * 60);

  return extensionAllowed(session, { heartbeat: heartbeatResult });
}

async function reportExtensionSessionStatus(body = {}) {
  await ensureMachineAuthenticated();
  state.machine = buildMachineInfo();
  return portalRequestWithSessionRefresh('/api/agent/extension/session-status', {
    method: 'POST',
    body: JSON.stringify({
      service: body.service,
      status: body.status,
      hostname: body.hostname,
      pathname: body.pathname,
      detectedBy: body.detectedBy,
      confidence: body.confidence,
      checkedAt: body.checkedAt,
      extensionInstanceId: body.extensionInstanceId,
      extensionVersion: body.extensionVersion,
      profileId: state.currentProfileSession && state.currentProfileSession.profileId,
      profileSessionId: state.currentProfileSession && state.currentProfileSession.id,
      machineFingerprint: state.machine.fingerprint,
      machineInfo: state.machine
    })
  });
}

async function getExtensionConfig(body = {}) {
  await ensureMachineAuthenticated();
  state.machine = buildMachineInfo();
  return portalRequestWithSessionRefresh('/api/agent/extension/config', {
    method: 'POST',
    body: JSON.stringify({
      extensionInstanceId: body.extensionInstanceId,
      extensionVersion: body.extensionVersion,
      url: body.url,
      machineFingerprint: state.machine.fingerprint,
      machineInfo: state.machine,
    })
  });
}

async function reportExtensionAccess(body = {}) {
  await ensureMachineAuthenticated();
  state.machine = buildMachineInfo();
  return portalRequestWithSessionRefresh('/api/agent/extension/access-log', {
    method: 'POST',
    body: JSON.stringify({
      ...body,
      machineFingerprint: state.machine.fingerprint,
      machineName: state.machine.hostname || state.machine.osUser,
      machineInfo: state.machine,
    })
  });
}

async function route(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  try {
    if (req.method === 'GET' && (url.pathname === '/logo.svg' || url.pathname === '/logo-roxo.svg')) {
      const logoFile = url.pathname === '/logo-roxo.svg' ? 'logo-roxo.svg' : 'logo.svg';
      const logoPath = path.join(__dirname, '..', 'public', logoFile);
      if (fs.existsSync(logoPath)) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
        return res.end(fs.readFileSync(logoPath));
      }
    }

    if (req.method === 'GET' && url.pathname === '/') return html(res, AGENT_HTML);

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      state.eventClients.add(res);
      sseSend(res, 'ready', { ok: true, at: new Date().toISOString() });
      req.on('close', () => state.eventClients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      state.machine = buildMachineInfo();
      let accessIssue = null;
      let heartbeatResult = null;
      if (!state.agentToken && (state.rememberedEmail || state.user?.email)) {
        try {
          await ensureMachineAuthenticated();
        } catch (error) {
          accessIssue = {
            status: error.status || 500,
            code: error.payload?.code || 'agent_session_recovery_error',
            message: error.message || 'Não foi possível restaurar a sessão deste dispositivo.',
            supportTarget: error.payload?.supportTarget || 'suporte'
          };
        }
      }
      if (!accessIssue && state.agentToken && state.user) {
        try { heartbeatResult = await heartbeat(); } catch (error) {
          accessIssue = {
            status: error.status || 500,
            code: error.payload?.code || 'agent_access_error',
            message: error.message || 'Não foi possível validar o acesso deste dispositivo.',
            supportTarget: error.payload?.supportTarget || 'suporte'
          };
        }
      }
      return json(res, 200, {
        ok: true,
        version: APP_VERSION,
        authenticated: Boolean(state.agentToken && state.user && !accessIssue),
        user: state.user,
        accessIssue,
        canAccessService: heartbeatResult?.canAccessService ?? (accessIssue ? false : null),
        accessCode: heartbeatResult?.accessCode || accessIssue?.code || null,
        accessMessage: heartbeatResult?.accessMessage || accessIssue?.message || null,
        portalUrl: PORTAL_URL,
        machine: state.machine,
        machineAuthorized: Boolean(state.agentToken && state.user && !accessIssue),
        error: accessIssue?.message || (state.agentToken && state.user ? null : 'Nenhuma sessão ativa. Informe o e-mail usado no checkout.')
      });
    }

    if (req.method === 'GET' && url.pathname === '/machine') {
      state.machine = buildMachineInfo();
      return json(res, 200, { machine: state.machine });
    }

    if (req.method === 'GET' && url.pathname === '/debug') {
      return json(res, 200, await machineDebug());
    }

    if (req.method === 'GET' && url.pathname === '/profiles') {
      return json(res, 200, await listProfiles({ forceRefresh: url.searchParams.get('refresh') === '1' }));
    }

    if (req.method === 'GET' && url.pathname === '/intro-video.mp4') {
      const videoPath = path.join(__dirname, '..', 'public', 'video intro painel-.mp4');
      if (fs.existsSync(videoPath)) {
        const stat = fs.statSync(videoPath);
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(videoPath).pipe(res);
      }
    }

    if (req.method === 'GET' && url.pathname === '/updates/latest') {
      await ensureMachineAuthenticated();
      const result = await portalRequestWithSessionRefresh(
        `/api/agent/updates/latest?version=${encodeURIComponent(APP_VERSION)}&platform=${encodeURIComponent(process.platform)}&arch=${encodeURIComponent(process.arch)}`,
        { method: 'GET' }
      );
      if (result.updateAvailable && result.update) {
        result.update.downloadUrl = `${url.origin}/updates/${encodeURIComponent(result.update.id)}/download`;
      }
      return json(res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/electron-updates/latest.yml') {
      await ensureMachineAuthenticated();
      const result = await portalRequestWithSessionRefresh(
        `/api/agent/updates/latest?version=${encodeURIComponent(APP_VERSION)}&platform=win32&arch=${encodeURIComponent(process.arch)}`,
        { method: 'GET' }
      );
      const update = result.updateAvailable ? result.update : null;
      if (!update || !/^\d+\.\d+\.\d+$/.test(String(update.version || '')) || !String(update.sha512 || '').trim()) {
        return json(res, 404, { error: 'Nenhuma atualizacao oficial disponivel' });
      }
      const fileName = `NinjaFlixPainelSetup-${update.version}.exe`;
      const relativeUrl = `${encodeURIComponent(update.id)}/${encodeURIComponent(fileName)}`;
      const quoteYaml = (value) => JSON.stringify(String(value ?? ''));
      const metadata = [
        `version: ${quoteYaml(update.version)}`,
        'files:',
        `  - url: ${quoteYaml(relativeUrl)}`,
        `    sha512: ${quoteYaml(update.sha512)}`,
        `    size: ${Number(update.sizeBytes || 0)}`,
        `path: ${quoteYaml(relativeUrl)}`,
        `sha512: ${quoteYaml(update.sha512)}`,
        `releaseDate: ${quoteYaml(update.publishedAt || update.updatedAt || update.createdAt || new Date().toISOString())}`,
        ''
      ].join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/yaml; charset=utf-8',
        'Content-Length': Buffer.byteLength(metadata),
        'Cache-Control': 'no-store'
      });
      return res.end(metadata);
    }

    const electronUpdateDownloadMatch = url.pathname.match(/^\/electron-updates\/([^/]+)\/[^/]+\.exe$/i);
    if (req.method === 'GET' && electronUpdateDownloadMatch) {
      return proxyUpdateDownload(req, res, decodeURIComponent(electronUpdateDownloadMatch[1]));
    }

    const updateDownloadMatch = url.pathname.match(/^\/updates\/([^/]+)\/download$/);
    if (req.method === 'GET' && updateDownloadMatch) {
      return proxyUpdateDownload(req, res, decodeURIComponent(updateDownloadMatch[1]));
    }

    if (req.method === 'GET' && url.pathname === '/shell-config') {
      try {
        return json(res, 200, await portalRequest('/api/agent/client-shell-config', { method: 'GET' }));
      } catch (_error) {
        return json(res, 200, { ok: true, fallback: true, pages: { financeiro: 'https://cliente.ninjaflix.club/financeiro', tutoriais: 'https://cliente.ninjaflix.club/tutoriais', suporte: 'https://cliente.ninjaflix.club/suporte', avisos: 'https://cliente.ninjaflix.club/?tab=avisos', upgrade: 'https://cliente.ninjaflix.club/financeiro?aba=assinatura&secao=upgrade' } });
      }
    }

    if (req.method === 'GET' && url.pathname === '/notices') {
      await ensureMachineAuthenticated();
      return json(res, 200, await portalRequestWithSessionRefresh('/api/agent/notices', { method: 'GET' }));
    }

    if (req.method === 'GET' && url.pathname === '/popups') {
      await ensureMachineAuthenticated();
      return json(res, 200, await portalRequestWithSessionRefresh('/api/agent/popups', { method: 'GET' }));
    }

    if (req.method === 'GET' && url.pathname === '/support-tickets') {
      await ensureMachineAuthenticated();
      return json(res, 200, await portalRequestWithSessionRefresh('/api/agent/support-tickets', { method: 'GET' }));
    }

    if (req.method === 'POST' && url.pathname === '/support-tickets') {
      const body = await readBody(req);
      await ensureMachineAuthenticated();
      return json(res, 201, await portalRequestWithSessionRefresh('/api/agent/support-tickets', { method: 'POST', body: JSON.stringify(body) }));
    }

    const supportMessageMatch = url.pathname.match(/^\/support-tickets\/([^/]+)\/messages$/);
    if (req.method === 'POST' && supportMessageMatch) {
      const body = await readBody(req);
      await ensureMachineAuthenticated();
      return json(res, 200, await portalRequestWithSessionRefresh(`/api/agent/support-tickets/${encodeURIComponent(supportMessageMatch[1])}/messages`, { method: 'POST', body: JSON.stringify(body) }));
    }

    if (req.method === 'POST' && url.pathname === '/launch-link') {
      const body = await readBody(req);
      await ensureMachineAuthenticated();
      return json(res, 201, await portalRequestWithSessionRefresh('/api/agent/client-launch-link', { method: 'POST', body: JSON.stringify(body) }));
    }

    if (req.method === 'GET' && url.pathname === '/admin/profiles') {
      return json(res, 200, await listAdminProfiles());
    }

    if (req.method === 'GET' && url.pathname === '/admin/adspower/profiles') {
      return json(res, 200, await listLocalAdspowerProfiles({ forceRefresh: url.searchParams.get('refresh') === '1' }));
    }

    if (req.method === 'POST' && url.pathname === '/sunbrowser-bootstrap') {
      await ensureMachineAuthenticated();
      const body = await readBody(req).catch(() => ({}));
      return json(res, 200, await ensurePublishedSunbrowserUpdates({ force: Boolean(body.force) }));
    }

    if (req.method === 'GET' && url.pathname === '/admin/adspower/bootstrap-status') {
      return json(res, 200, getBootstrapState());
    }

    if (req.method === 'POST' && url.pathname === '/admin/adspower/start') {
      const body = await readBody(req);
      void launchAdspower(body?.executablePath || body?.path || '');
      return json(res, 200, getBootstrapState());
    }

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

    if (req.method === 'POST' && url.pathname === '/login') return json(res, 200, await login(body));
    if (req.method === 'POST' && url.pathname === '/customer-login') return json(res, 200, await customerLogin(body));
    if (req.method === 'POST' && url.pathname === '/logout') return json(res, 200, logout());
    if (req.method === 'POST' && url.pathname === '/heartbeat') return json(res, 200, await heartbeat({ force: true }));
    if (req.method === 'POST' && url.pathname === '/extension/session/start') return json(res, 200, await startExtensionSession(body));
    if (req.method === 'POST' && url.pathname === '/extension/heartbeat') return json(res, 200, await extensionHeartbeat(body));
    if (req.method === 'POST' && url.pathname === '/extension/session-status') return json(res, 200, await reportExtensionSessionStatus(body));
    if (req.method === 'POST' && url.pathname === '/extension/config') return json(res, 200, await getExtensionConfig(body));
    if (req.method === 'POST' && url.pathname === '/extension/access-log') return json(res, 201, await reportExtensionAccess(body));
    if (req.method === 'POST' && url.pathname === '/kernel-plan') return json(res, 200, buildKernelPlan());
    if (req.method === 'POST' && url.pathname === '/open') return json(res, 200, await handleOpen(body));
    if (req.method === 'POST' && url.pathname === '/close') return json(res, 200, await handleClose(body));
    if (req.method === 'POST' && url.pathname === '/status') return json(res, 200, await handleStatus(body));
    if (req.method === 'POST' && url.pathname === '/admin/profiles') return json(res, 201, await createAdminProfile(body));

    const adminProfileMatch = url.pathname.match(/^\/admin\/profiles\/([^/]+)$/);
    if (adminProfileMatch && req.method === 'PATCH') return json(res, 200, await updateAdminProfile(adminProfileMatch[1], body));
    if (adminProfileMatch && req.method === 'DELETE') return json(res, 200, await deleteAdminProfile(adminProfileMatch[1]));

    return notFound(res);
  } catch (error) {
    return json(res, error.status || 500, {
      ok: false,
      error: error.message,
      details: error.payload || null
    });
  }
}

const server = http.createServer(route);

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, HOST, () => {
    console.log(`Ninjaflix Painel ${APP_VERSION} local em http://${HOST}:${PORT}`);
    console.log(`Portal central configurado: ${PORTAL_URL}`);
    console.log(`Maquina: ${state.machine.hostname} (${state.machine.fingerprint.slice(0, 12)})`);
    void runCatalogEventStream();
  });
}

if (process.env.NODE_ENV === 'test') {
  module.exports = {
    buildProfileRotationPlan,
    commitProfileRotation,
    localStorageConfiguredLaunchUrl,
    localStorageInjectionExpression,
    localStorageLaunchExpression,
    state
  };
}





