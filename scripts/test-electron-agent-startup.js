const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ninjaflix-startup-'));
const port = 32191;
const expectedVersion = require(path.join(projectRoot, 'package.json')).version;
const child = spawn(
  process.execPath,
  ['-e', "require('./scripts/local-agent.js')"],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      NINJAFLIX_AGENT_HOME: testHome,
      AGENT_LOCAL_STATE_PATH: path.join(testHome, 'local-agent-state.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }
);

let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

function health() {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function run() {
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await health();
      if (result.version !== expectedVersion) {
        throw new Error(`Versão inesperada no health: ${result.version || 'vazia'}; esperada: ${expectedVersion}`);
      }
      console.log(`Startup Electron OK: health respondeu na versão ${result.version}.`);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`O servidor local não iniciou quando carregado pelo Electron: ${lastError?.message || 'sem resposta'}\n${output}`);
}

run()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill();
    fs.rmSync(testHome, { recursive: true, force: true });
  });
