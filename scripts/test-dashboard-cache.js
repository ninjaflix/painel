const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ninjaflix-cache-'));
let profilesRequests = 0;
let heartbeatRequests = 0;
let catalogRevision = 0;
const catalogClients = new Set();

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        const payload = raw ? JSON.parse(raw) : {};
        if (response.statusCode >= 400) return reject(new Error(payload.error || `HTTP ${response.statusCode}`));
        resolve(payload);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(check, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function waitForAgent(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { return await request(port, '/health'); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error('Agente local não iniciou durante o teste de cache.');
}

(async () => {
  const user = { id: 'cache-test', email: 'cache@ninjaflix.test', name: 'Teste Cache', subscriptionEndsAt: '2099-12-31' };
  const portal = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    if (req.url === '/api/agent/customer-login' && req.method === 'POST') {
      return sendJson(res, 200, { agentSessionToken: 'cache-token', user });
    }
    if (req.url === '/api/agent/heartbeat' && req.method === 'POST') {
      heartbeatRequests += 1;
      return sendJson(res, 200, { ok: true, authenticated: true, canAccessService: true, user });
    }
    if (requestUrl.pathname === '/api/agent/profiles' && req.method === 'GET') {
      profilesRequests += 1;
      return sendJson(res, 200, {
        user,
        catalogRevision,
        categories: [{ id: 'cat-cache', name: 'Cache' }],
        profiles: [{ id: 'profile-cache', profileId: 'ads-cache', name: `Perfil ${profilesRequests}`, category: 'Cache' }]
      });
    }
    if (requestUrl.pathname === '/api/agent/catalog-events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      catalogClients.add(res);
      res.write(`event: catalog-version\ndata: ${JSON.stringify({ revision: catalogRevision })}\n\n`);
      req.on('close', () => catalogClients.delete(res));
      return;
    }
    return sendJson(res, 404, { error: `Mock sem endpoint: ${req.method} ${req.url}` });
  });
  const portalPort = await listen(portal);
  const portProbe = http.createServer();
  const agentPort = await listen(portProbe);
  await new Promise((resolve) => portProbe.close(resolve));
  const child = spawn(process.execPath, ['scripts/local-agent.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(agentPort),
      PORTAL_URL: `http://127.0.0.1:${portalPort}`,
      NINJAFLIX_AGENT_HOME: testHome,
      AGENT_LOCAL_STATE_PATH: path.join(testHome, 'local-agent-state.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForAgent(agentPort);
    await request(agentPort, '/customer-login', { method: 'POST', body: { email: user.email } });
    await request(agentPort, '/health');
    await request(agentPort, '/health');
    if (heartbeatRequests !== 1) throw new Error(`Heartbeat não foi deduplicado: ${heartbeatRequests} chamadas.`);

    const first = await request(agentPort, '/profiles');
    const second = await request(agentPort, '/profiles');
    if (first.cached || !second.cached || profilesRequests !== 1) {
      throw new Error(`Cache não foi reutilizado: first=${first.cached}, second=${second.cached}, portal=${profilesRequests}.`);
    }
    const refreshed = await request(agentPort, '/profiles?refresh=1');
    if (refreshed.cached || profilesRequests !== 2 || refreshed.profiles?.[0]?.name !== 'Perfil 2') {
      throw new Error('Atualização forçada em segundo plano não renovou o cache.');
    }
    await waitFor(() => catalogClients.size > 0, 'Agente não abriu o canal persistente do catálogo.');
    catalogRevision += 1;
    for (const client of catalogClients) client.write(`event: catalog-changed\ndata: ${JSON.stringify({ revision: catalogRevision, reason: 'profile-updated' })}\n\n`);
    await waitFor(() => profilesRequests === 3, 'Evento da VPS não atualizou os perfis em segundo plano.');
    const afterEvent = await request(agentPort, '/profiles');
    if (!afterEvent.cached || afterEvent.catalogRevision !== 1 || afterEvent.profiles?.[0]?.name !== 'Perfil 3') {
      throw new Error('Cache local não recebeu a alteração enviada pelo canal persistente.');
    }
    const saved = JSON.parse(fs.readFileSync(path.join(testHome, 'local-agent-state.json'), 'utf8'));
    if (!saved.cachedProfiles?.payload?.profiles?.length) throw new Error('Cache não foi persistido no disco da máquina.');
    console.log('Cache OK: disco, evento da VPS, atualização seletiva e heartbeat deduplicado.');
  } finally {
    child.kill();
    for (const client of catalogClients) client.end();
    await new Promise((resolve) => portal.close(resolve));
    fs.rmSync(testHome, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
