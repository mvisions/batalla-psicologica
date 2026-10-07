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

test('el siguiente jugador que se une empareja con quien estaba esperando', async () => {
  const port = await unusedPort();
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), GOOGLE_CLIENT_ID: '', ALLOW_DEVELOPMENT_LOGIN: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(child);
    const base = `http://127.0.0.1:${port}`;
    const join = async (name) => {
      const response = await fetch(`${base}/api/matchmaking/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const waiting = await join('Esperando');
    assert.equal(waiting.status, 'waiting');
    const queued = await fetch(`${base}/api/matchmaking/status?ticket=${waiting.ticket}&key=${waiting.ticketKey}`);
    assert.equal((await queued.json()).status, 'waiting');

    const arriving = await join('Siguiente');
    assert.equal(arriving.status, 'matched');
    assert.equal(arriving.room.length, 4);
    assert.notEqual(arriving.pid, undefined);
    const status = await fetch(`${base}/api/matchmaking/status?ticket=${waiting.ticket}&key=${waiting.ticketKey}`);
    const paired = await status.json();
    assert.equal(paired.status, 'matched');
    assert.equal(paired.room, arriving.room);
    assert.notEqual(paired.pid, arriving.pid);

    for (const player of [paired, arriving]) {
      const response = await fetch(`${base}/api/room?room=${player.room}&pid=${player.pid}&key=${player.key}`);
      assert.equal(response.status, 200);
    }

    const cancelled = await join('Cancelado');
    const cancelResponse = await fetch(`${base}/api/matchmaking/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: cancelled.ticket, key: cancelled.ticketKey }),
    });
    assert.equal(cancelResponse.status, 200);
    const missing = await fetch(`${base}/api/matchmaking/status?ticket=${cancelled.ticket}&key=${cancelled.ticketKey}`);
    assert.equal(missing.status, 404);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
});

test('las rutas de juego y perfil rechazan acceso sin Google', async () => {
  const port = await unusedPort();
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), GOOGLE_CLIENT_ID: '', ALLOW_DEVELOPMENT_LOGIN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(child);
    const base = `http://127.0.0.1:${port}`;
    const cases = [
      ['/api/create', { name: 'Invitado', mode: 'bot' }],
      ['/api/matchmaking/join', { name: 'Invitado' }],
      ['/api/join', { name: 'Invitado', token: 'invalid' }],
      ['/api/profile', {}],
    ];
    for (const [route, body] of cases) {
      const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 401, route);
    }
    const csrf = 'google-csrf-test';
    const invalidCsrf = await fetch(`${base}/auth/google/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `g_csrf_token=${csrf}` },
      body: new URLSearchParams({ credential: 'fake', g_csrf_token: 'mismatch' }),
    });
    assert.equal(invalidCsrf.status, 403);
    const invalidCredential = await fetch(`${base}/auth/google/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `g_csrf_token=${csrf}` },
      body: new URLSearchParams({ credential: 'fake', g_csrf_token: csrf }),
    });
    assert.equal(invalidCredential.status, 401);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
});