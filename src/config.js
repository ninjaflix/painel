const path = require('node:path');
const fs = require('node:fs');

const RUNTIME_ROOT = process.env.NINJAFLIX_AGENT_HOME || (process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..'));

function loadDotEnv() {
  const envPath = path.join(RUNTIME_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function readEnv(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null || value === '' ? fallback : value;
}

module.exports = {
  port: Number(readEnv('PORT', '3000')),
  appSecret: readEnv('APP_SECRET', 'dev-secret-change-me'),
  internalApiSecret: readEnv('INTERNAL_API_SECRET', readEnv('APP_SECRET', 'dev-secret-change-me')),
  dataFile: path.join(RUNTIME_ROOT, 'data', 'db.json'),
  adspower: {
    baseUrl: readEnv('ADSPOWER_BASE_URL', 'http://127.0.0.1:50326').replace(/\/$/, ''),
    apiKey: readEnv('ADSPOWER_API_KEY', ''),
    profileId: readEnv('ADSPOWER_PROFILE_ID', ''),
    openTabs: readEnv('ADSPOWER_OPEN_TABS', '1'),
    ipTab: readEnv('ADSPOWER_IP_TAB', '0'),
    disablePasswordFilling: readEnv('ADSPOWER_DISABLE_PASSWORD_FILLING', '0'),
    enablePasswordSaving: readEnv('ADSPOWER_ENABLE_PASSWORD_SAVING', '1'),
    clearCacheAfterClosing: readEnv('ADSPOWER_CLEAR_CACHE_AFTER_CLOSING', '0')
  },
  externalServiceName: readEnv('EXTERNAL_SERVICE_NAME', 'NinjaFlix'),
  paymentUrl: readEnv('PAYMENT_URL', 'https://pagamento.ninjaflix.club/'),
  integrations: {
    checkoutUrl: readEnv('CHECKOUT_URL', 'https://pagamento.ninjaflix.club'),
    ativadorUrl: readEnv('ATIVADOR_URL', ''),
    legadoUrl: readEnv('LEGADO_CADASTRO_URL', '')
  }
};
