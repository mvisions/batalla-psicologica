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

test('el torneo de cuatro crea semifinales, final y partido por el tercer puesto', async () => {
  const port = await unusedPort();
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), START_ROUND: '36', RATE_LIMIT: '100000', GOOGLE_CLIENT_ID: '', ALLOW_DEVELOPMENT_LOGIN: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const controllers = [];
  try {
    await waitForServer(child);
    const base = `http://127.0.0.1:${port}`;
    const post = async (route, value, expected = 200) => {
      const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      assert.equal(response.status, expected);
      return response.json();
    };
    const stateFor = async (player) => {
      const query = new URLSearchParams({ code: player.league, pid: player.leaguePid, key: player.leagueKey });
      const response = await fetch(`${base}/api/league/state?${query}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const players = [await post('/api/create', { name: 'Jugador 1', mode: 'tournament4', leagueName: 'Copa de prueba' })];
    for (let i = 2; i <= 4; i++) players.push(await post('/api/join', { name: `Jugador ${i}`, token: players[0].token }));
    assert.equal((await post('/api/join', { name: 'Jugador 5', token: players[0].token }, 409)).error, 'El torneo ya está completo');

    const initialStates = await Promise.all(players.map(stateFor));
    const initial = initialStates[0];
    assert.equal(initial.name, 'Copa de prueba');
    assert.equal(initial.size, 4);
    assert.equal(initial.status, 'playing');
    assert.equal(initial.rounds[0].name, 'Semifinales');
    assert.equal(initial.rounds[0].matches.length, 2);
    assert.equal(initial.rounds[1].matches.length, 0);
    assert.deepEqual(initial.rounds[0].matches.map((match) => match.label), ['Semifinal 1', 'Semifinal 2']);
    const semifinalRooms = new Map();
    for (let i = 0; i < initialStates.length; i++) {
      const state = initialStates[i];
      assert.equal(state.match.roundName.startsWith('Semifinal'), true);
      const group = semifinalRooms.get(state.match.room) || [];
      group.push({ ...state.match, leaguePid: players[i].leaguePid });
      semifinalRooms.set(state.match.room, group);
    }
    assert.equal(semifinalRooms.size, 2);
    for (const group of semifinalRooms.values()) assert.equal(group.length, 2);

    const playMatch = async (group) => {
      group.sort((a, b) => a.pid - b.pid);
      const readers = [];
      for (let pid = 0; pid < 2; pid++) {
        const controller = new AbortController(); controllers.push(controller);
        const response = await fetch(`${base}/api/events?room=${group[pid].room}&pid=${pid}&key=${group[pid].key}`, { signal: controller.signal });
        const next = eventReader(response.body);
        assert.equal((await next()).event, 'hello');
        if (pid === 0) assert.equal((await next()).event, 'waiting');
        readers.push(next);
      }
      for (const next of readers) assert.equal((await next()).event, 'state');
      let result;
      for (let round = 0; round < 1500; round++) {
        for (let pid = 0; pid < 2; pid++) {
          const rnd = () => [0, 1, 2, 3].map(() => 1 + Math.floor(Math.random() * 4));
          await post('/api/submit', {
            room: group[pid].room, pid, key: group[pid].key,
            attack: rnd(), defense: rnd(), wave: [0, 0, 0, 0], block: rnd(),
          });
        }
        const updates = await Promise.all(readers.map(async (next) => {
          let event = await next();
          while (event.event === 'ready') event = await next();
          assert.equal(event.event, 'round');
          return JSON.parse(event.data);
        }));
        result = updates[0].winner;
        assert.equal(updates[1].winner, result);
        if (result !== null) break;
      }
      assert.notEqual(result, null, 'el duelo debe terminar');
      return { winner: group[result].leaguePid, loser: group[1 - result].leaguePid };
    };

    const semifinalResults = [];
    for (const group of semifinalRooms.values()) semifinalResults.push(await playMatch(group));
    const nextStates = await Promise.all(players.map(stateFor));
    const finals = new Map();
    const placements = new Map();
    for (let i = 0; i < nextStates.length; i++) {
      const state = nextStates[i];
      assert.equal(state.status, 'playing');
      const target = state.match.roundName === 'Final' ? finals : placements;
      const group = target.get(state.match.room) || [];
      group.push({ ...state.match, leaguePid: players[i].leaguePid });
      target.set(state.match.room, group);
    }
    assert.equal(finals.size, 1);
    assert.equal(placements.size, 1);
    const finalistIds = new Set([...finals.values()][0].map((player) => player.leaguePid));
    const thirdPlaceIds = new Set([...placements.values()][0].map((player) => player.leaguePid));
    assert.deepEqual([...finalistIds].sort(), semifinalResults.map((match) => match.winner).sort());
    assert.deepEqual([...thirdPlaceIds].sort(), semifinalResults.map((match) => match.loser).sort());
    assert.deepEqual(initial.rounds[0].matches.map((match) => match.players.length), [2, 2]);
    assert.equal(nextStates[0].rounds[1].name, 'Final y tercer puesto');
    assert.deepEqual(nextStates[0].rounds[1].matches.map((match) => match.label), ['Final', '3er puesto']);

    await Promise.all([...finals.values(), ...placements.values()].map(playMatch));
    const completed = await Promise.all(players.map(stateFor));
    const finalWinner = completed.find((state) => state.status === 'champion');
    const runnerUp = completed.find((state) => state.status === 'runnerUp');
    const thirdPlace = completed.find((state) => state.status === 'third');
    const fourthPlace = completed.find((state) => state.status === 'fourth');
    assert.ok(finalWinner);
    assert.ok(runnerUp);
    assert.ok(thirdPlace);
    assert.ok(fourthPlace);
    assert.equal(completed.filter((state) => state.status === 'champion').length, 1);
    assert.equal(completed.filter((state) => state.status === 'runnerUp').length, 1);
    assert.equal(completed.filter((state) => state.status === 'third').length, 1);
    assert.equal(completed.filter((state) => state.status === 'fourth').length, 1);
    assert.equal(completed.filter((state) => state.status === 'eliminated').length, 0);
    assert.deepEqual([finalWinner.reward, runnerUp.reward, thirdPlace.reward, fourthPlace.reward], [200, 150, 100, 0]);
  } finally {
    controllers.forEach((controller) => controller.abort());
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
});

test('tras cinco minutos completa los puestos del torneo con bots y estos juegan automáticamente', async () => {
  const port = await unusedPort();
  const projectDir = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: {
      ...process.env, PORT: String(port), START_ROUND: '36', TOURNAMENT_FILL_MS: '100', BOT_TURN_MS: '500',
      GOOGLE_CLIENT_ID: '', ALLOW_DEVELOPMENT_LOGIN: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const controllers = [];
  try {
    await waitForServer(child);
    const base = `http://127.0.0.1:${port}`;
    const hostResponse = await fetch(`${base}/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Anfitrión', mode: 'tournament4', leagueName: 'Torneo automático' }),
    });
    assert.equal(hostResponse.status, 200);
    const host = await hostResponse.json();
    const query = new URLSearchParams({ code: host.league, pid: host.leaguePid, key: host.leagueKey });
    const getState = async () => {
      const response = await fetch(`${base}/api/league/state?${query}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    let state = await getState();
    for (let attempt = 0; attempt < 30 && state.status === 'registration'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      state = await getState();
    }
    assert.equal(state.status, 'playing');
    assert.deepEqual(state.players, ['Anfitrión', 'Lamine', 'Messi', 'Ronaldo']);
    assert.deepEqual(state.countries, ['un', 'es', 'ar', 'pt']);
    assert.deepEqual(state.difficulties, [null, 'normal', 'easy', 'hard']);
    assert.equal(state.rounds[0].matches.length, 2);

    const leaguesResponse = await fetch(`${base}/api/leagues`);
    const activeLeagues = await leaguesResponse.json();
    const automatedMatch = activeLeagues[0].matches.find((match) => match.players.every((name) => state.players.indexOf(name) > 0));
    assert.ok(automatedMatch, 'la semifinal entre bots debe arrancar sin conexiones de jugadores');
    const controller = new AbortController(); controllers.push(controller);
    const spectatorResponse = await fetch(`${base}/api/spectate?room=${automatedMatch.room}`, { signal: controller.signal });
    assert.equal(spectatorResponse.status, 200);
    const nextEvent = eventReader(spectatorResponse.body);
    assert.equal((await nextEvent()).event, 'hello');
    const initial = JSON.parse((await nextEvent()).data);
    for (let i = 0; i < initial.names.length; i++) {
      const index = state.players.indexOf(initial.names[i]);
      assert.equal(initial.countries[i], state.countries[index]);
    }
    const round = await Promise.race([
      nextEvent(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('los bots no jugaron la ronda')), 3000)),
    ]);
    assert.equal(round.event, 'round');
  } finally {
    controllers.forEach((controller) => controller.abort());
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
});
