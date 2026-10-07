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

function eventReader(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    while (true) {
      const match = buffer.match(/event: ([^\n]+)\ndata: ([^\n]*)\n\n/);
      if (match) {
        buffer = buffer.slice(match[0].length);
        return { event: match[1], data: match[2] };
      }
      const { value, done } = await reader.read();
      assert.equal(done, false, 'el servidor cerró inesperadamente el SSE');
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

test('liga de ocho crea cuatro cruces aleatorios con todos los participantes', async () => {
  const port = await unusedPort();
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), GOOGLE_CLIENT_ID: '', ALLOW_DEVELOPMENT_LOGIN: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const controllers = [];
  try {
    await waitForServer(child);
    const base = `http://127.0.0.1:${port}`;
    const post = async (route, value) => {
      const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const host = await post('/api/create', { name: 'Jugador 1', mode: 'league', leagueName: 'Champions League' });
    const players = [host];
    for (let i = 2; i <= 8; i++) players.push(await post('/api/join', { name: `Jugador ${i}`, token: host.token }));

    const states = await Promise.all(players.map(async (player) => {
      const query = new URLSearchParams({ code: player.league, pid: player.leaguePid, key: player.leagueKey });
      const response = await fetch(`${base}/api/league/state?${query}`);
      assert.equal(response.status, 200);
      return response.json();
    }));
    const quarterfinals = states[0].rounds[0];
    assert.equal(states[0].name, 'Champions League');
    assert.equal(states[0].createdBy, 'Jugador 1');
    assert.equal(states[0].status, 'playing');
    assert.equal(quarterfinals.name, 'Cuartos de final');
    assert.equal(quarterfinals.matches.length, 4);
    assert.deepEqual(states[0].rounds.slice(1).map((round) => round.matches.length), [0, 0]);

    const rooms = new Map();
    for (const state of states) {
      assert.equal(state.status, 'playing');
      assert.ok(state.match);
      const group = rooms.get(state.match.room) || [];
      group.push({ pid: state.match.pid, opponent: state.match.opponent });
      rooms.set(state.match.room, group);
    }
    assert.equal(rooms.size, 4);
    for (const group of rooms.values()) {
      assert.equal(group.length, 2);
      assert.deepEqual(group.map((seat) => seat.pid).sort(), [0, 1]);
    }

    const activeRoom = states[0].match.room;
    const playersInRoom = states.filter((state) => state.match.room === activeRoom).sort((a, b) => a.match.pid - b.match.pid);
    const playerStreams = [];
    for (let pid = 0; pid < 2; pid++) {
      const player = playersInRoom[pid].match;
      const controller = new AbortController(); controllers.push(controller);
      const response = await fetch(`${base}/api/events?room=${player.room}&pid=${pid}&key=${player.key}`, { signal: controller.signal });
      const next = eventReader(response.body);
      assert.equal((await next()).event, 'hello');
      if (pid === 0) assert.equal((await next()).event, 'waiting');
      playerStreams.push(next);
    }
    assert.equal((await playerStreams[0]()).event, 'state');
    assert.equal((await playerStreams[1]()).event, 'state');

    const activeResponse = await fetch(`${base}/api/leagues`);
    const activeLeagues = await activeResponse.json();
    assert.equal(activeLeagues.length, 1);
    assert.equal(activeLeagues[0].name, 'Champions League');
    assert.equal(activeLeagues[0].createdBy, 'Jugador 1');
    assert.equal(activeLeagues[0].matches.length, 1);

    for (let count = 0; count < 2; count++) {
      const controller = new AbortController(); controllers.push(controller);
      const response = await fetch(`${base}/api/spectate?room=${activeRoom}`, { signal: controller.signal });
      assert.equal(response.status, 200);
      const next = eventReader(response.body);
      assert.equal((await next()).event, 'hello');
      assert.equal((await next()).event, 'state');
    }
    const full = await fetch(`${base}/api/spectate?room=${activeRoom}`);
    assert.equal(full.status, 429);
    assert.match((await full.json()).error, /Máximo de 2/);
  } finally {
    controllers.forEach((controller) => controller.abort());
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
});