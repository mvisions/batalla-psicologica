import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  return async (wanted) => {
    while (true) {
      const match = buffer.match(/event: ([^\n]+)\ndata: ([^\n]*)\n\n/);
      if (match) {
        buffer = buffer.slice(match[0].length);
        if (match[1] === wanted) return JSON.parse(match[2]);
        continue;
      }
      const { value, done } = await reader.read();
      assert.equal(done, false, 'el servidor cerró inesperadamente el SSE');
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

test('el reto diario da 10 monedas y con 150 se compra el pez espada, que ataca a la ballena rival', async () => {
  const port = await unusedPort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-shop-'));
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dataDir, 'ranking.json'), JSON.stringify({ version: 2, allTime: [], weekly: [] }));
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({
    'n:ana': { name: 'Ana', streak: 0, points: 0, wins: 2, level: 1, coins: 140, dailyDay: today, dailyWins: 2 },
  }));
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, GOOGLE_CLIENT_ID: '', ALLOW_DEVELOPMENT_LOGIN: 'true', RATE_LIMIT: '100000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const controllers = [];
  try {
    await waitForServer(child);
    const base = `http://127.0.0.1:${port}`;
    const post = async (route, value) => {
      const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      return { status: response.status, body: await response.json() };
    };
    const listen = async (roomCode, pid, key) => {
      const controller = new AbortController();
      controllers.push(controller);
      return eventReader((await fetch(`${base}/api/events?room=${roomCode}&pid=${pid}&key=${key}`, { signal: controller.signal })).body);
    };
    const startMatch = async () => {
      const a = (await post('/api/create', { name: 'Ana', mode: 'pvp' })).body;
      const b = (await post('/api/join', { name: 'Beto', token: a.token })).body;
      const nextA = await listen(a.room, 0, a.key);
      await listen(a.room, 1, b.key);
      const state = await nextA('state');
      return { a, b, nextA, state };
    };

    let profile = (await post('/api/profile', { name: 'Ana' })).body;
    assert.equal(profile.coins, 140);
    assert.deepEqual(profile.daily, { wins: 2, goal: 3, reward: 10 });
    assert.equal(profile.swordfish, false);
    assert.equal((await post('/api/shop/buy', { name: 'Ana', item: 'swordfish' })).status, 402);
    assert.equal((await post('/api/shop/buy', { name: 'Ana', item: 'ballena' })).status, 400);

    // tercera victoria del día: el rival se retira y Ana recibe 10 monedas
    const first = await startMatch();
    assert.deepEqual(first.state.swordfish, [false, false]);
    assert.equal((await post('/api/sword', { room: first.a.room, pid: 0, key: first.a.key })).status, 403);
    assert.equal((await post('/api/resign', { room: first.a.room, pid: 1, key: first.b.key })).status, 200);
    profile = (await post('/api/profile', { name: 'Ana' })).body;
    assert.equal(profile.coins, 150);
    assert.equal(profile.daily.wins, 3);

    const bought = await post('/api/shop/buy', { name: 'Ana', item: 'swordfish' });
    assert.equal(bought.status, 200);
    assert.equal(bought.body.coins, 0);
    assert.equal(bought.body.swordfish, true);
    assert.equal((await post('/api/shop/buy', { name: 'Ana', item: 'swordfish' })).status, 409);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'))['n:ana'];
    assert.equal(saved.coins, 0);
    assert.equal(saved.swordfish, true);

    const second = await startMatch();
    assert.deepEqual(second.state.swordfish, [true, false]);
    assert.equal((await post('/api/sword', { room: second.a.room, pid: 1, key: second.b.key })).status, 403);
    assert.equal((await post('/api/sword', { room: second.a.room, pid: 0, key: second.a.key })).status, 200);
    const seq = { attack: [1, 1, 1, 1], defense: [4, 4, 4, 4], wave: [0, 0, 0, 0] };
    await post('/api/submit', { room: second.a.room, pid: 0, key: second.a.key, ...seq });
    await post('/api/submit', { room: second.a.room, pid: 1, key: second.b.key, ...seq });
    const round = await second.nextA('round');
    assert.deepEqual(round.events[0].sword, [{ owner: 0, target: 1, def: 4, dmg: 10 }]);
    assert.equal(round.hp[1].shark, 40);
    assert.deepEqual(round.swordCd, [3, 0]);
    assert.equal((await post('/api/sword', { room: second.a.room, pid: 0, key: second.a.key })).status, 409);
  } finally {
    controllers.forEach((c) => c.abort());
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('con 450 monedas se compra el ataque infernal y dispara los 4 cañones en la ronda', async () => {
  const port = await unusedPort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-shop-'));
  fs.writeFileSync(path.join(dataDir, 'ranking.json'), JSON.stringify({ version: 2, allTime: [], weekly: [] }));
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({
    'n:ana': { name: 'Ana', streak: 0, points: 0, wins: 2, level: 1, coins: 445, dailyDay: new Date().toISOString().slice(0, 10), dailyWins: 2 },
  }));
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, GOOGLE_CLIENT_ID: '', ALLOW_DEVELOPMENT_LOGIN: 'true', RATE_LIMIT: '100000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const controllers = [];
  try {
    await waitForServer(child);
    const base = `http://127.0.0.1:${port}`;
    const post = async (route, value) => {
      const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      return { status: response.status, body: await response.json() };
    };
    const listen = async (roomCode, pid, key) => {
      const controller = new AbortController();
      controllers.push(controller);
      return eventReader((await fetch(`${base}/api/events?room=${roomCode}&pid=${pid}&key=${key}`, { signal: controller.signal })).body);
    };

    const startMatch = async () => {
      const a = (await post('/api/create', { name: 'Ana', mode: 'pvp' })).body;
      const b = (await post('/api/join', { name: 'Beto', token: a.token })).body;
      const nextA = await listen(a.room, 0, a.key);
      await listen(a.room, 1, b.key);
      const state = await nextA('state');
      return { a, b, nextA, state };
    };
    assert.equal((await post('/api/shop/buy', { name: 'Ana', item: 'infernal' })).status, 402);

    const first = await startMatch();
    assert.deepEqual(first.state.infernal, [false, false]);
    assert.equal((await post('/api/infernal', { room: first.a.room, pid: 0, key: first.a.key })).status, 403);
    assert.equal((await post('/api/resign', { room: first.a.room, pid: 1, key: first.b.key })).status, 200);

    const bought = await post('/api/shop/buy', { name: 'Ana', item: 'infernal' });
    assert.equal(bought.status, 200);
    assert.equal(bought.body.coins, 5);
    assert.equal(bought.body.infernal, true);
    assert.equal((await post('/api/shop/buy', { name: 'Ana', item: 'infernal' })).status, 409);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'))['n:ana'].infernal, true);

    const second = await startMatch();
    assert.deepEqual(second.state.infernal, [true, false]);
    assert.equal((await post('/api/infernal', { room: second.a.room, pid: 1, key: second.b.key })).status, 403);
    assert.equal((await post('/api/infernal', { room: second.a.room, pid: 0, key: second.a.key })).status, 200);
    const seq = { attack: [2, 2, 2, 2], defense: [1, 1, 1, 1], wave: [0, 0, 0, 0] };
    await post('/api/submit', { room: second.a.room, pid: 0, key: second.a.key, ...seq });
    await post('/api/submit', { room: second.a.room, pid: 1, key: second.b.key, ...seq, attack: [3, 3, 3, 3] });
    const round = await second.nextA('round');
    for (const ev of round.events) {
      assert.deepEqual(ev.infernal, [0]);
      assert.deepEqual(ev.shots.filter((shot) => shot.from === 0).map((shot) => shot.lane).sort(), [1, 2, 3, 4]);
    }
    assert.deepEqual(round.infernoCd, [5, 0]);
    assert.equal((await post('/api/infernal', { room: second.a.room, pid: 0, key: second.a.key })).status, 409);
  } finally {
    controllers.forEach((c) => c.abort());
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('con 500 monedas se compran las balas de fuego: +3 de daño, encendidas hasta apagarlas y cada 6 rondas', async () => {
  const port = await unusedPort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-shop-'));
  fs.writeFileSync(path.join(dataDir, 'ranking.json'), JSON.stringify({ version: 2, allTime: [], weekly: [] }));
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({
    'n:ana': { name: 'Ana', streak: 0, points: 0, wins: 2, level: 1, coins: 495, dailyDay: new Date().toISOString().slice(0, 10), dailyWins: 2 },
  }));
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, GOOGLE_CLIENT_ID: '', ALLOW_DEVELOPMENT_LOGIN: 'true', RATE_LIMIT: '100000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const controllers = [];
  try {
    await waitForServer(child);
    const base = `http://127.0.0.1:${port}`;
    const post = async (route, value) => {
      const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      return { status: response.status, body: await response.json() };
    };
    const listen = async (roomCode, pid, key) => {
      const controller = new AbortController();
      controllers.push(controller);
      return eventReader((await fetch(`${base}/api/events?room=${roomCode}&pid=${pid}&key=${key}`, { signal: controller.signal })).body);
    };

    const startMatch = async () => {
      const a = (await post('/api/create', { name: 'Ana', mode: 'pvp' })).body;
      const b = (await post('/api/join', { name: 'Beto', token: a.token })).body;
      const nextA = await listen(a.room, 0, a.key);
      await listen(a.room, 1, b.key);
      const state = await nextA('state');
      return { a, b, nextA, state };
    };
    assert.equal((await post('/api/shop/buy', { name: 'Ana', item: 'fireballs' })).status, 402);
    const first = await startMatch();
    assert.deepEqual(first.state.fireballs, [false, false]);
    assert.equal((await post('/api/fire', { room: first.a.room, pid: 0, key: first.a.key })).status, 403);
    assert.equal((await post('/api/resign', { room: first.a.room, pid: 1, key: first.b.key })).status, 200);

    const bought = await post('/api/shop/buy', { name: 'Ana', item: 'fireballs' });
    assert.equal(bought.status, 200);
    assert.equal(bought.body.coins, 5);
    assert.equal(bought.body.fireballs, true);
    assert.ok(bought.body.shop.some((item) => item.id === 'fireballs' && item.price === 500));

    const second = await startMatch();
    const { room } = second.a;
    assert.deepEqual(second.state.fireballs, [true, false]);
    assert.equal((await post('/api/fire', { room, pid: 1, key: second.b.key })).status, 403);
    const on = await post('/api/fire', { room, pid: 0, key: second.a.key });
    assert.deepEqual(on.body, { ok: true, fireOn: true, fireCd: 6 });
    const play = async (seqA, seqB) => {
      await post('/api/submit', { room, pid: 0, key: second.a.key, ...seqA });
      await post('/api/submit', { room, pid: 1, key: second.b.key, ...seqB });
      return second.nextA('round');
    };
    // Beto defiende el carril 2 al que dispara Ana: cada bala que da a su ballena quita 7 + 3
    const ana = { attack: [2, 2, 2, 2], defense: [1, 1, 1, 1], wave: [0, 0, 0, 0] };
    const beto = { attack: [4, 4, 4, 4], defense: [2, 2, 2, 2], wave: [0, 0, 0, 0] };
    let round = await play(ana, beto), shark = 50;
    for (const ev of round.events) {
      const mine = ev.shots.filter((shot) => shot.from === 0);
      assert.ok(mine.every((shot) => shot.fire === true));
      assert.ok(ev.shots.filter((shot) => shot.from === 1).every((shot) => !shot.fire));
      const hits = mine.filter((shot) => shot.target === 'shark' && shot.owner === 1).length;
      assert.equal(shark - ev.hp[1].shark, hits * 10);
      shark = ev.hp[1].shark;
    }
    assert.deepEqual(round.fireOn, [true, false]);
    assert.deepEqual(round.fireCd, [5, 0]);
    // siguen encendidas en la ronda siguiente sin volver a pulsar
    round = await play(ana, beto);
    assert.ok(round.events.every((ev) => ev.shots.filter((shot) => shot.from === 0).every((shot) => shot.fire)));
    const off = await post('/api/fire', { room, pid: 0, key: second.a.key });
    assert.deepEqual(off.body, { ok: true, fireOn: false, fireCd: 4 });
    assert.equal((await post('/api/fire', { room, pid: 0, key: second.a.key })).status, 409);
    round = await play(ana, beto);
    assert.ok(round.events.every((ev) => ev.shots.every((shot) => !shot.fire)));
  } finally {
    controllers.forEach((c) => c.abort());
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('los dragones cuestan 1500 cada uno; con los dos, un solo botón quita el 25% del barco y de cada cañón rival cada 6 rondas', async () => {
  const port = await unusedPort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-shop-'));
  fs.writeFileSync(path.join(dataDir, 'ranking.json'), JSON.stringify({ version: 2, allTime: [], weekly: [] }));
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({
    'n:ana': { name: 'Ana', streak: 0, points: 0, wins: 2, level: 1, coins: 2990, dailyDay: new Date().toISOString().slice(0, 10), dailyWins: 2 },
  }));
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, GOOGLE_CLIENT_ID: '', ALLOW_DEVELOPMENT_LOGIN: 'true', RATE_LIMIT: '100000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const controllers = [];
  try {
    await waitForServer(child);
    const base = `http://127.0.0.1:${port}`;
    const post = async (route, value) => {
      const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      return { status: response.status, body: await response.json() };
    };
    const listen = async (roomCode, pid, key) => {
      const controller = new AbortController();
      controllers.push(controller);
      return eventReader((await fetch(`${base}/api/events?room=${roomCode}&pid=${pid}&key=${key}`, { signal: controller.signal })).body);
    };

    const startMatch = async () => {
      const a = (await post('/api/create', { name: 'Ana', mode: 'pvp' })).body;
      const b = (await post('/api/join', { name: 'Beto', token: a.token })).body;
      const nextA = await listen(a.room, 0, a.key);
      await listen(a.room, 1, b.key);
      const state = await nextA('state');
      return { a, b, nextA, state };
    };
    const first = await startMatch();
    assert.deepEqual(first.state.dragons, [{ fire: false, storm: false }, { fire: false, storm: false }]);
    assert.equal((await post('/api/dragon', { room: first.a.room, pid: 0, key: first.a.key })).status, 403);
    assert.equal((await post('/api/resign', { room: first.a.room, pid: 1, key: first.b.key })).status, 200);

    const fireBuy = await post('/api/shop/buy', { name: 'Ana', item: 'fireDragon' });
    assert.equal(fireBuy.status, 200);
    assert.equal(fireBuy.body.coins, 1500);
    assert.equal(fireBuy.body.fireDragon, true);
    assert.ok(fireBuy.body.shop.some((item) => item.id === 'stormDragon' && item.price === 1500));
    const stormBuy = await post('/api/shop/buy', { name: 'Ana', item: 'stormDragon' });
    assert.equal(stormBuy.body.coins, 0);
    assert.equal(stormBuy.body.stormDragon, true);

    const second = await startMatch();
    const { room } = second.a;
    assert.deepEqual(second.state.dragons, [{ fire: true, storm: true }, { fire: false, storm: false }]);
    assert.equal((await post('/api/dragon', { room, pid: 1, key: second.b.key })).status, 403);
    assert.equal((await post('/api/dragon', { room, pid: 0, key: second.a.key })).status, 200);
    const play = async (seqA, seqB) => {
      await post('/api/submit', { room, pid: 0, key: second.a.key, ...seqA });
      await post('/api/submit', { room, pid: 1, key: second.b.key, ...seqB });
      return second.nextA('round');
    };
    const ana = { attack: [2, 2, 2, 2], defense: [1, 1, 1, 1], wave: [0, 0, 0, 0] };
    const beto = { attack: [4, 4, 4, 4], defense: [2, 2, 2, 2], wave: [0, 0, 0, 0] };
    const shipBefore = second.state.hp[1].ship;
    const cannonsBefore = second.state.cannons[1];
    let round = await play(ana, beto);
    const [hit] = round.events[0].dragon;
    assert.equal(round.events[0].dragon.length, 1);
    assert.equal(hit.owner, 0); assert.equal(hit.target, 1);
    assert.equal(hit.fire, true); assert.equal(hit.storm, true);
    assert.equal(hit.shipDmg, Math.ceil(shipBefore * 0.25));
    assert.deepEqual(hit.cannonDmg, cannonsBefore.map((c) => Math.ceil(c * 0.25)));
    assert.ok(round.events[0].hp[1].ship < shipBefore); // puede haber curas aleatorias en el mismo disparo
    assert.ok(round.events.slice(1).every((ev) => !ev.dragon));
    assert.deepEqual(round.dragonCd, [5, 0]);
    assert.equal((await post('/api/dragon', { room, pid: 0, key: second.a.key })).status, 409);
    round = await play(ana, beto);
    assert.ok(round.events.every((ev) => !ev.dragon));
  } finally {
    controllers.forEach((c) => c.abort());
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('el barco vikingo se compra por 250, se alterna con la skin de nivel y cede al subir a un nivel con skin nueva', async () => {
  const port = await unusedPort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-shop-'));
  fs.writeFileSync(path.join(dataDir, 'ranking.json'), JSON.stringify({ version: 2, allTime: [], weekly: [] }));
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({
    'n:ana': { name: 'Ana', streak: 0, points: 860, wins: 0, level: 9, coins: 260 },
    'n:beto': { name: 'Beto', streak: 0, points: 560, wins: 0, level: 6, coins: 0, viking: true, vikingTier: 5 },
  }));
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, GOOGLE_CLIENT_ID: '', ALLOW_DEVELOPMENT_LOGIN: 'true', RATE_LIMIT: '100000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const controllers = [];
  try {
    await waitForServer(child);
    const base = `http://127.0.0.1:${port}`;
    const post = async (route, value) => {
      const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      return { status: response.status, body: await response.json() };
    };
    const listen = async (roomCode, pid, key) => {
      const controller = new AbortController();
      controllers.push(controller);
      return eventReader((await fetch(`${base}/api/events?room=${roomCode}&pid=${pid}&key=${key}`, { signal: controller.signal })).body);
    };
    const startMatch = async () => {
      const a = (await post('/api/create', { name: 'Ana', mode: 'pvp' })).body;
      const b = (await post('/api/join', { name: 'Beto', token: a.token })).body;
      const nextA = await listen(a.room, 0, a.key);
      await listen(a.room, 1, b.key);
      return { a, b, state: await nextA('state') };
    };

    assert.equal((await post('/api/skin', { name: 'Ana' })).status, 403);
    const bought = await post('/api/shop/buy', { name: 'Ana', item: 'viking' });
    assert.equal(bought.status, 200);
    assert.equal(bought.body.coins, 10);
    assert.equal(bought.body.viking, true);
    assert.equal(bought.body.skin, 'viking');
    assert.equal((await post('/api/skin', { name: 'Ana' })).body.skin, null);
    assert.equal((await post('/api/skin', { name: 'Ana' })).body.skin, 'viking');

    const first = await startMatch();
    assert.deepEqual(first.state.skins, ['viking', 'viking']);
    // Ana gana, pasa al nivel 10 (skin nueva) y vuelve a verse la skin de nivel
    await post('/api/resign', { room: first.a.room, pid: 1, key: first.b.key });
    let ana = (await post('/api/profile', { name: 'Ana' })).body;
    assert.equal(ana.level, 10);
    assert.equal(ana.skin, null);
    assert.equal(ana.viking, true);
    ana = (await post('/api/skin', { name: 'Ana' })).body;
    assert.equal(ana.skin, 'viking');

    // Beto gana y sube del 6 al 7: misma skin de nivel, conserva el vikingo
    const second = await startMatch();
    await post('/api/resign', { room: second.a.room, pid: 0, key: second.a.key });
    const beto = (await post('/api/profile', { name: 'Beto' })).body;
    assert.equal(beto.level, 7);
    assert.equal(beto.skin, 'viking');
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'));
    assert.equal(saved['n:ana'].vikingTier, 10);
  } finally {
    controllers.forEach((c) => c.abort());
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('la ruleta cuesta 350, se tira una sola vez y su premio se queda como si se hubiese comprado', async () => {
  const { rouletteOdds, spinRoulette } = await import('../server.js');
  const odds = rouletteOdds({});
  const pct = Object.fromEntries(odds.map((o) => [o.id, o.pct]));
  assert.equal(pct.lifebuoy, 25);
  assert.ok(Math.abs(odds.reduce((s, o) => s + o.pct, 0) - 100) < 1e-9);
  assert.ok(pct.swordfish > pct.viking && pct.viking > pct.infernal && pct.infernal > pct.fireballs && pct.fireballs > pct.fireDragon);
  assert.equal(pct.fireDragon, pct.stormDragon);
  assert.equal(spinRoulette({}, 0), 'swordfish');
  assert.equal(spinRoulette({}, 0.999), 'lifebuoy');
  assert.ok(!rouletteOdds({ swordfish: true }).some((o) => o.id === 'swordfish'));
  assert.deepEqual(rouletteOdds({ swordfish: true, infernal: true, viking: true, fireballs: true, fireDragon: true, stormDragon: true }).map((o) => [o.id, o.pct]), [['lifebuoy', 100]]);

  const port = await unusedPort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-roulette-'));
  fs.writeFileSync(path.join(dataDir, 'ranking.json'), JSON.stringify({ version: 2, allTime: [], weekly: [] }));
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({
    'n:ana': { name: 'Ana', streak: 0, points: 0, wins: 0, level: 1, coins: 360 },
    'n:beto': { name: 'Beto', streak: 0, points: 0, wins: 0, level: 1, coins: 100 },
  }));
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, GOOGLE_CLIENT_ID: '', ALLOW_DEVELOPMENT_LOGIN: 'true', RATE_LIMIT: '100000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const controller = new AbortController();
  try {
    await waitForServer(child);
    const base = `http://127.0.0.1:${port}`;
    const post = async (route, value) => {
      const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      return { status: response.status, body: await response.json() };
    };
    const before = (await post('/api/profile', { name: 'Ana' })).body;
    assert.equal(before.roulette.price, 350);
    assert.equal(before.roulette.used, false);
    assert.equal((await post('/api/roulette', { name: 'Beto' })).status, 402);

    const spin = await post('/api/roulette', { name: 'Ana' });
    assert.equal(spin.status, 200);
    const ids = ['swordfish', 'infernal', 'viking', 'fireballs', 'fireDragon', 'stormDragon', 'lifebuoy'];
    assert.ok(ids.includes(spin.body.prize));
    assert.equal(spin.body.profile.coins, 10);
    assert.equal(spin.body.profile[spin.body.prize], true);
    assert.deepEqual({ ...spin.body.profile.roulette, odds: undefined }, { price: 350, used: true, prize: spin.body.prize, odds: undefined });
    assert.equal(spin.body.profile.roulette.odds.length, 7);
    assert.equal((await post('/api/roulette', { name: 'Ana' })).status, 409);

    const a = (await post('/api/create', { name: 'Ana', mode: 'pvp' })).body;
    const b = (await post('/api/join', { name: 'Beto', token: a.token })).body;
    const next = eventReader((await fetch(`${base}/api/events?room=${a.room}&pid=0&key=${a.key}`, { signal: controller.signal })).body);
    await fetch(`${base}/api/events?room=${a.room}&pid=1&key=${b.key}`, { signal: controller.signal });
    const state = await next('state');
    assert.deepEqual(state.lifebuoys, [spin.body.prize === 'lifebuoy', false]);
  } finally {
    controller.abort();
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
