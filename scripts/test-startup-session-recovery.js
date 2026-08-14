const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve(JSON.parse(raw || '{}')));
    }).on('error', reject);
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { return await request(port, '/health'); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error('Agente não iniciou durante o teste de recuperação da sessão.');
}

(async () => {
  const user = { id: 'startup-user', email: 'startup@ninjaflix.test', name: 'Teste Inicial', subscriptionEndsAt: '2099-12-31' };
  let loginRequests = 0;
  let heartbeatRequests = 0;
  const portal = http.createServer((req, res) => {
    const send = (payload) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.url === '/api/agent/customer-login' && req.method === 'POST') {
      loginRequests += 1;
      return send({ agentSessionToken: 'restored-session', user, canAccessService: true });
    }
    if (req.url === '/api/agent/heartbeat' && req.method === 'POST') {
      heartbeatRequests += 1;
      return send({ ok: true, authenticated: true, canAccessService: true, user });
    }
    if (req.url.startsWith('/api/agent/catalog-events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      return res.write('event: catalog-version\ndata: {"revision":0}\n\n');
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint ausente no mock' }));
  });
  const portalPort = await listen(portal);
  const probe = http.createServer();
  const agentPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ninjaflix-session-recovery-'));
  const statePath = path.join(testHome, 'local-agent-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ email: user.email, user }, null, 2));
  const child = spawn(process.execPath, ['scripts/local-agent.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', AGENT_HOST: '127.0.0.1', AGENT_PORT: String(agentPort), PORTAL_URL: `http://127.0.0.1:${portalPort}`, AGENT_LOCAL_STATE_PATH: statePath },
    stdio: 'ignore'
  });
  try {
    const health = await waitForHealth(agentPort);
    if (!health.authenticated || health.error || health.accessIssue) throw new Error(`Primeiro health incorreto: ${JSON.stringify(health)}`);
    if (loginRequests !== 1 || heartbeatRequests !== 1) throw new Error(`Recuperação duplicada: login=${loginRequests}, heartbeat=${heartbeatRequests}`);
    console.log('Sessão inicial OK: restaurada antes do primeiro health, sem falso dispositivo offline.');
  } finally {
    child.kill();
    await new Promise((resolve) => portal.close(resolve));
    fs.rmSync(testHome, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
