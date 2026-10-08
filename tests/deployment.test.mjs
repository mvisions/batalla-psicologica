import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('el servidor no arrancó')), 5000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Servidor en')) { clearTimeout(timeout); resolve(); }
    });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`el servidor terminó con código ${code}`)); });
  });
}

test('CORS permite GitHub Pages configurado y rechaza otros sitios', async () => {
  const port = await unusedPort();
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(port),
      GOOGLE_CLIENT_ID: '',
      ALLOW_DEVELOPMENT_LOGIN: 'true',
      PUBLIC_URL: 'https://mvisions.github.io/batalla-psicologica',
      API_BASE_URL: 'https://batalla-psicologica-api.onrender.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(child);
    const base = `http://127.0.0.1:${port}`;
    const preflight = await fetch(`${base}/api/matchmaking/join`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://mvisions.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://mvisions.github.io');

    const config = await fetch(`${base}/api/config`, { headers: { Origin: 'https://mvisions.github.io' } });
    assert.equal(config.status, 200);
    assert.equal(config.headers.get('access-control-allow-origin'), 'https://mvisions.github.io');
    assert.equal((await config.json()).publicUrl, 'https://mvisions.github.io/batalla-psicologica');

    const forbidden = await fetch(`${base}/api/config`, { headers: { Origin: 'https://example.invalid' } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers.get('access-control-allow-origin'), null);

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
});