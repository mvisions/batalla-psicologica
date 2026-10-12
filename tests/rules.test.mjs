import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRound, makeRoom, botPlan, shipMaxHpForLevel, randomSpecialRounds } from '../server.js';

// Partida de dos jugadores con las secuencias indicadas
function setup({ round = 1, a, b, hp0 }) {
  const room = makeRoom({ name: 'A', sub: 'a' }, false);
  room.players.push({ name: 'B', sub: 'b', attack: null, defense: null, wave: null });
  room.maxShipHp[1] = shipMaxHpForLevel(1);
  room.hp[1].ship = room.maxShipHp[1];
  room.round = round;
  room.medkitMatch = false;
  room.wildlife = false;
  room.justiceRound = 100; room.santaRound = 101; room.halloweenRound = 102;
  room.justiceUsed = false; room.santaUsed = false; room.halloweenUsed = false;
  if (hp0) room.hp[0].ship = hp0;
  const [p0, p1] = room.players;
  Object.assign(p0, { attack: a.attack, defense: a.defense, wave: a.wave });
  Object.assign(p1, { attack: b.attack, defense: b.defense, wave: b.wave });
  return room;
}
const seq = (n) => [n, n, n, n];

test('el Barco de la Justicia selecciona los extremos de vida y no duplica eventos normales', () => {
  const room = setup({ round: 6, hp0: 80, a: { attack: seq(1), defense: seq(4), wave: seq(0) }, b: { attack: seq(4), defense: seq(1), wave: seq(0) } });
  room.hp[1].ship = 90;
  room.justiceRound = 6;
  room.players.forEach((player) => { player.bot = true; });

  const { events } = resolveRound(room);

  assert.ok(events.every((event) => event.justice));
  assert.deepEqual(events[0].justice, { target: 1, cannonDamage: 15, medkitTarget: 1, medkitHeal: 25 });
  let previousHp = [80, 90];
  for (const event of events) {
    const { target, cannonDamage, medkitTarget, medkitHeal } = event.justice;
    assert.equal(previousHp[target], Math.max(...previousHp));
    const afterCannon = [...previousHp]; afterCannon[target] -= cannonDamage;
    assert.equal(afterCannon[medkitTarget], Math.min(...afterCannon));
    assert.ok(cannonDamage <= 15 && medkitHeal <= 25);
    previousHp = event.hp.map((health) => health.ship);
  }
  assert.equal(events[0].swell, false);
  assert.equal(events[0].whale, null);
  assert.ok(room.hp.every((health) => health.ship > 0));
  assert.equal(room.justiceUsed, true);
});

test('cada partida sortea eventos en rondas distintas y solo activa los estacionales en su fecha', () => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const room = makeRoom({ name: 'A', sub: `event-test-${attempt}` }, false);
    const rounds = [room.justiceRound, room.santaRound, room.halloweenRound];
    const scheduled = rounds.filter((round) => round !== null);
    assert.equal(new Set(scheduled).size, scheduled.length);
    assert.ok(scheduled.every((round) => round >= 3 && round <= 18 && ![9, 10, 11, 15].includes(round)));
  }
  const at = (month, day) => new Date(Date.UTC(2026, month, day, 12));
  assert.equal(randomSpecialRounds(at(9, 24))[2], null);
  assert.ok(randomSpecialRounds(at(9, 25))[2] >= 3);
  assert.ok(randomSpecialRounds(at(9, 31))[2] >= 3);
  assert.equal(randomSpecialRounds(at(10, 1))[2], null);
  assert.equal(randomSpecialRounds(at(10, 31))[2], null);
  assert.ok(randomSpecialRounds(at(11, 1))[1] >= 3);
  assert.ok(randomSpecialRounds(at(11, 31))[1] >= 3);
  assert.equal(randomSpecialRounds(at(0, 1))[1], null);
});

test('Santa concede una skin distinta a cada jugador en una única ronda', () => {
  const room = setup({ round: 12, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(1) } });
  room.santaRound = 12;
  room.players.forEach((player) => { player.bot = true; });

  const { events } = resolveRound(room);

  assert.deepEqual(events[0].santa.skins, room.santaSkins);
  assert.ok(events.every((event) => !event.swell && event.shots.every((shot) => shot.target === 'santa')));
  assert.equal(room.santaUsed, true);
  assert.deepEqual(room.hp.map((health) => health.ship), room.maxShipHp);
});

test('Halloween paga 10 monedas por impacto a la calabaza y no hace daño a los barcos', () => {
  const room = setup({ round: 15, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(1) } });
  room.halloweenRound = 15;
  room.players.forEach((player) => { player.bot = true; });

  const { events } = resolveRound(room);

  const shots = events.flatMap((event) => event.shots);
  assert.ok(events[0].halloween);
  assert.ok(shots.length > 0);
  assert.ok(shots.every((shot) => shot.target === 'pumpkin' && shot.coin === 10));
  assert.ok(events.every((event) => !event.swell && event.shots.every((shot) => shot.damage === 0)));
  assert.deepEqual(room.hp.map((health) => health.ship), room.maxShipHp);
  assert.equal(room.halloweenUsed, true);
});

test('dos balas por el mismo carril chocan sin darño', () => {
  const room = setup({ a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(1), defense: seq(4) } });
  const { events } = resolveRound(room);
  assert.ok(events[0].shots.every((s) => s.target === 'collision'));
  assert.equal(room.hp[0].ship, 105);
  assert.equal(room.hp[1].ship, 105);
});

test('cada nivel suma 5 de vida máxima; nivel 30 suma 150', () => {
  assert.equal(shipMaxHpForLevel(1), 105);
  assert.equal(shipMaxHpForLevel(30), 250);
});

test('en ronda 10 cada jugador puede bloquear los cañones elegidos en orden', () => {
  const room = setup({ round: 10, a: { attack: seq(1), defense: seq(3) }, b: { attack: seq(4), defense: seq(1) } });
  room.players[0].block = seq(2);
  room.players[1].block = seq(1);

  const { events } = resolveRound(room);
  assert.equal(events[0].shots.find((shot) => shot.from === 0).target, 'blocked');
  assert.notEqual(events[0].shots.find((shot) => shot.from === 1).target, 'blocked');
  assert.equal(room.hp[1].ship, 105);
});

test('fuera de ronda 10 la secuencia de bloqueo no detiene disparos', () => {
  const room = setup({ round: 9, a: { attack: seq(1), defense: seq(3) }, b: { attack: seq(4), defense: seq(1) } });
  room.players[1].block = seq(1);

  const { events } = resolveRound(room);
  assert.notEqual(events[0].shots.find((shot) => shot.from === 0).target, 'blocked');
});

test('el tiburón rival intercepta la bala en su carril', () => {
  const room = setup({ a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(1) } });
  const { events } = resolveRound(room);
  const shot = events[0].shots.find((s) => s.from === 0);
  assert.equal(shot.target, 'shark');
  assert.equal(room.hp[1].shark, 50 - 7 * 4);
  assert.equal(room.hp[1].ship, 105);
});

test('con lluvia (ronda 5) los tiburones no interceptan', () => {
  const room = setup({ round: 5, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(1) } });
  const { events } = resolveRound(room);
  assert.notEqual(events[0].shots.find((s) => s.from === 0).target, 'shark'); // da al barco o a un iceberg
  assert.equal(room.hp[1].shark, 50);
});

test('la ronda 15 es nevada y mantiene activa la defensa contra tiburones', () => {
  const room = setup({ round: 15, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(1) } });
  const originalRandom = Math.random;
  let events;
  try { Math.random = () => 0.999; ({ events } = resolveRound(room)); } finally { Math.random = originalRandom; }
  assert.equal(events[0].shots.find((shot) => shot.from === 0).target, 'shark');
});

test('la ronda 4 hace doble daño', () => {
  const room = setup({ round: 4, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(4) } });
  resolveRound(room);
  assert.equal(room.hp[1].ship, 105 - 14 * 4);
});

test('un cañón roto no dispara y se regenera con 15 al acabar la ronda', () => {
  const room = setup({ a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(4) } });
  room.cannons[0][0] = 0;
  const { events } = resolveRound(room);
  assert.equal(events[0].shots.find((s) => s.from === 0).target, 'broken');
  assert.equal(room.cannons[0][0], 15);
});

test('romper un cañón rival cura 5 de vida', () => {
  const room = setup({ hp0: 90, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(3), defense: seq(2) } });
  room.cannons[1][0] = 5;
  const { events } = resolveRound(room);
  assert.deepEqual(events[0].heal, [5, 0]);
  assert.equal(events[0].cannons[1][0], 0);
  // el cañón ya roto no vuelve a curar
  assert.deepEqual(events[1].heal, [0, 0]);
});

test('el botiquín aparece en todas las partidas y solo en rondas 3, 6, 9…', () => {
  assert.equal(makeRoom({ name: 'A', sub: 'a' }, false).medkitMatch, true);

  for (const round of [1, 2, 4, 5, 7]) {
    const room = setup({ round, a: { attack: seq(2), defense: seq(4), wave: seq(0) }, b: { attack: seq(4), defense: seq(1), wave: seq(0) } });
    room.medkitMatch = true;
    assert.ok(resolveRound(room).events.every((event) => event.medkit === null));
  }

  const laterRound = setup({ round: 6, a: { attack: seq(2), defense: seq(4), wave: seq(0) }, b: { attack: seq(4), defense: seq(1), wave: seq(0) } });
  laterRound.medkitMatch = true;
  laterRound.cannons[0] = [0, 0, 0, 0]; laterRound.cannons[1] = [0, 0, 0, 0];
  assert.deepEqual(resolveRound(laterRound).events.map((event) => event.medkit?.x ?? null), [-3, -1, 1, 3]);
});

test('el botiquín recorre los cuatro puestos desde ronda 3 y cura 40 una sola vez', () => {
  const room = setup({ round: 3, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(1) } });
  room.medkitMatch = true;
  room.cannons[0] = [0, 0, 0, 0];
  room.cannons[1] = [0, 0, 0, 0];
  const { events } = resolveRound(room);

  assert.deepEqual(events.map((event) => event.medkit?.x ?? null), [-3, -1, 1, 3]);
  assert.ok(events.every((event) => event.heal.every((amount) => amount === 0)));
});

test('recoger el botiquín suma 40 de vida al barco y lo retira del recorrido', () => {
  const room = setup({ round: 3, hp0: 55, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(1) } });
  room.medkitMatch = true;
  room.cannons[1] = [0, 0, 0, 0];
  const random = Math.random;
  let events;
  try { Math.random = () => 0.999; ({ events } = resolveRound(room)); } finally { Math.random = random; }

  assert.equal(events[0].shots.find((shot) => shot.from === 0).target, 'medkit');
  assert.deepEqual(events[0].heal, [40, 0]);
  assert.equal(events[0].hp[0].ship, 95);
  assert.deepEqual(events.slice(1).map((event) => event.medkit), [null, null, null]);
});

test('el botiquín no supera la vida máxima del nivel', () => {
  const room = setup({ hp0: 80, round: 3, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(1) } });
  room.medkitMatch = true; room.cannons[1] = [0, 0, 0, 0];
  const originalRandom = Math.random;
  let events;
  try { Math.random = () => 0.999; ({ events } = resolveRound(room)); } finally { Math.random = originalRandom; }

  assert.deepEqual(events[0].heal, [40, 0]);
  assert.equal(events[0].hp[0].ship, 105);
});

test('el pulpo de ronda 2 devuelve el disparo por otro puesto contra el rival', () => {
  const room = setup({ round: 2, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(1) } });
  room.octopusLane = 1;
  const originalRandom = Math.random;
  let events;
  try { Math.random = () => 0.99; ({ events } = resolveRound(room)); } finally { Math.random = originalRandom; }

  assert.equal(events[0].shots.find((shot) => shot.from === 0).target, 'octopus');
  assert.equal(events[0].octopus.release.from, 0);
  assert.equal(events[0].octopus.release.owner, 1);
  assert.notEqual(events[0].octopus.release.lane, 1);
  assert.ok([2, 3, 4].includes(events[0].octopus.release.lane));
  assert.equal(events[0].octopus.release.target, 'ship');
  assert.equal(events[0].hp[1].ship, 98);
  assert.equal(room.octopusUsed, true);
  assert.equal(events[1].octopus, null);
});

test('con oleaje un barco desplazado hace fallar la bala', () => {
  const room = setup({
    round: 6,
    a: { attack: seq(1), defense: seq(1), wave: [2, 2, 0, 0] },
    b: { attack: seq(4), defense: seq(3), wave: [0, 0, 0, 0] },
  });
  const random = Math.random;
  Math.random = () => 0;
  let events;
  try { ({ events } = resolveRound(room)); } finally { Math.random = random; }
  assert.deepEqual(events[1].pos, [-2, 0]);
  assert.equal(events[1].shots.find((s) => s.from === 1).target, 'miss');
});

test('la orca (ronda 7) rebota la bala contra el barco que disparó', () => {
  let rebotes = 0;
  for (let n = 0; n < 40; n++) {
    const room = setup({ round: 7, a: { attack: [1, 2, 3, 4], defense: seq(1) }, b: { attack: [4, 3, 2, 1], defense: seq(1) } });
    const { events } = resolveRound(room);
    for (const ev of events) {
      assert.ok([-3, -1, 1, 3].includes(ev.whale));
      for (const s of ev.shots.filter((x) => x.target === 'whale')) { assert.equal(s.owner, s.from); rebotes++; }
    }
  }
  assert.ok(rebotes > 0);
});

test('el bot difícil solo usa cañones que funcionan', () => {
  const room = makeRoom({ name: 'A', sub: 'a' }, true, 'hard');
  room.cannons[1] = [0, 25, 0, 25];
  for (let n = 0; n < 20; n++) {
    const plan = botPlan(room, 1);
    assert.ok(plan.attack.every((l) => l === 2 || l === 4));
    assert.equal(plan.defense.length, 4);
  }
});

test('el submarino (ronda 3) aparece en los 3 primeros disparos y se va antes del último', () => {
  const room = setup({ round: 3, a: { attack: seq(1), defense: seq(1) }, b: { attack: seq(4), defense: seq(4) } });
  const { events } = resolveRound(room);
  assert.equal(events.length, 4);
  for (let i = 0; i < 3; i++) {
    assert.ok([-3, -1, 1, 3].includes(events[i].sub.x));
    assert.ok([0, 1].includes(events[i].sub.toward));
    assert.ok(['ship', 'shark', 'miss'].includes(events[i].sub.target));
  }
  assert.equal(events[3].sub, null);
});

test('quien da al submarino se cura 5, sea yo o el rival', () => {
  let curas = 0;
  for (let n = 0; n < 60; n++) {
    const room = setup({ round: 3, hp0: 80, a: { attack: [1, 2, 3, 4], defense: seq(1) }, b: { attack: [4, 3, 2, 1], defense: seq(1) } });
    room.hp[1].ship = 80;
    const { events } = resolveRound(room);
    for (const ev of events) {
      for (const s of ev.shots.filter((x) => x.target === 'sub')) { assert.ok(ev.heal[s.from] >= 5); curas++; }
    }
  }
  assert.ok(curas > 0);
});

test('dar al submarino cura el barco y repara 5 el cañón que disparó', () => {
  const room = setup({
    round: 3,
    a: { attack: seq(1), defense: seq(4) },
    b: { attack: seq(4), defense: seq(4) },
  });
  const random = Math.random;
  let calls = 0;
  Math.random = () => (++calls === 1 ? 0 : 0.999);
  let events;
  try { ({ events } = resolveRound(room)); } finally { Math.random = random; }
  assert.equal(events[0].shots.find((shot) => shot.from === 0).target, 'sub');
  assert.equal(events[0].heal[0], 5);
  assert.equal(events[0].cannons[0][0], 25);
});

test('con lluvia hay dos icebergs y la bala que da a uno lo destruye', () => {
  let destruidos = 0;
  for (let n = 0; n < 60; n++) {
    const room = setup({ round: 5, a: { attack: [1, 2, 3, 4], defense: seq(1) }, b: { attack: [4, 3, 2, 1], defense: seq(1) } });
    const { events } = resolveRound(room);
    const rotos = new Set();
    for (const ev of events) {
      assert.equal(ev.ice.length, 2);
      for (const id of rotos) assert.equal(ev.ice[id], null); // un iceberg destruido ya no aparece
      for (const s of ev.shots.filter((x) => x.target === 'ice')) { rotos.add(s.ice); destruidos++; }
    }
  }
  assert.ok(destruidos > 0);
});

test('la gaviota vuela a un carril al azar y da 15 de vida a quien la derriba', () => {
  let hits = 0;
  for (let n = 0; n < 300; n++) {
    const room = setup({ round: 13, a: { attack: [1, 2, 3, 4], defense: seq(4) }, b: { attack: seq(4), defense: seq(4) }, hp0: 50 });
    room.wildlife = true;
    const { events } = resolveRound(room);
    let down = false;
    for (const ev of events) {
      if (down) assert.equal(ev.gull, null);
      const shot = ev.shots.find((s) => s.from === 0);
      if (shot.target === 'gull') { hits++; down = true; assert.equal(shot.x, ev.gull.x); assert.ok(ev.heal[0] >= 15); }
    }
  }
  assert.ok(hits > 0);
});

test('el calamar sale una ronda sí y otra no', () => {
  const run = (round) => {
    const room = setup({ round, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(4) } });
    room.wildlife = true;
    return resolveRound(room).events.some((e) => e.squid);
  };
  assert.equal(run(3), true);
  assert.equal(run(4), false);
});

test('el calamar fuera del agua detiene cualquier bala y bajo el agua la deja pasar', () => {
  let blockedRuns = 0, downRuns = 0;
  for (let n = 0; n < 400; n++) {
    const room = setup({ round: 13, a: { attack: seq(4), defense: seq(1) }, b: { attack: seq(3), defense: seq(3) } });
    room.wildlife = true;
    const weak = n % 2; // alterna cuál de los dos jugadores es el más perjudicado
    room.hp[weak].ship = 40;
    const { events } = resolveRound(room);
    let blocked = false;
    for (const ev of events) {
      const shot = ev.shots.find((s) => s.from === 0);
      const squid = ev.squid;
      if (squid) assert.equal(squid.owner, weak);
      const expected = Boolean(squid && squid.up && squid.x === 3 && !blocked && shot.target !== 'gull');
      if (shot.target === 'squid') { assert.ok(expected); blocked = true; blockedRuns++; }
      else if (squid && !squid.up && squid.x === 3 && shot.target !== 'gull') { assert.equal(shot.target, 'ship'); downRuns++; }
      if (blocked) assert.ok(!events[events.indexOf(ev) + 1]?.squid);
    }
  }
  assert.ok(blockedRuns > 0 && downRuns > 0);
});

test('el helicóptero pedido con 5 de vida suelta un botiquín de 15 al inicio de la ronda', () => {
  const room = setup({ round: 4, a: { attack: seq(4), defense: seq(4) }, b: { attack: seq(4), defense: seq(4) }, hp0: 5 });
  room.players[0].heli = true;
  const { events } = resolveRound(room);
  assert.deepEqual(events[0].heli, [{ owner: 0 }]);
  assert.equal(room.hp[0].ship, 20);
  assert.equal(room.players[0].heli, false);
});

test('sin pedirlo el helicóptero no acude', () => {
  const room = setup({ round: 4, a: { attack: seq(4), defense: seq(4) }, b: { attack: seq(4), defense: seq(4) }, hp0: 5 });
  const { events } = resolveRound(room);
  assert.equal(events[0].heli, undefined);
});

test('desde la ronda 20 el árbol horizontal bloquea dos carriles contiguos para ambos lados', () => {
  let withLog = 0;
  for (let n = 0; n < 300; n++) {
    const room = setup({ round: 26, a: { attack: [1, 2, 3, 4], defense: seq(2) }, b: { attack: [4, 3, 2, 1], defense: seq(2) } });
    room.wildlife = true;
    const { events } = resolveRound(room);
    for (const ev of events) {
      if (!ev.log) continue;
      withLog++;
      assert.equal(ev.log.lanes.length, 2);
      assert.equal(ev.log.lanes[1] - ev.log.lanes[0], 2);
      assert.equal(ev.log.x, (ev.log.lanes[0] + ev.log.lanes[1]) / 2);
      for (const shot of ev.shots) if (ev.log.lanes.includes(shot.x) && shot.target !== 'broken' && !(shot.target === 'shark' && shot.owner === shot.from)) assert.equal(shot.target, 'log');
    }
  }
  assert.ok(withLog > 0);
});

test('el pez espada quita 10 a la ballena rival y vuelve a estar listo a las 4 rondas', () => {
  const room = setup({ round: 1, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(1), defense: seq(4) } });
  room.players[0].sword = true;
  const { events } = resolveRound(room);
  assert.deepEqual(events[0].sword, [{ owner: 0, target: 1, def: 4, dmg: 10 }]);
  assert.equal(room.hp[1].shark, 40);
  assert.equal(room.hp[0].shark, 50);
  assert.deepEqual(room.swordCd, [3, 0]);
  for (let i = 0; i < 3; i++) {
    Object.assign(room.players[0], { attack: seq(1), defense: seq(4), sword: true });
    Object.assign(room.players[1], { attack: seq(1), defense: seq(4) });
    room.round = 1;
    assert.equal(resolveRound(room).events[0].sword, undefined);
  }
  assert.equal(room.hp[1].shark, 40);
  assert.deepEqual(room.swordCd, [0, 0]);
});

test('el ataque infernal dispara los 4 cañones en la primera secuencia y vuelve a estar listo a las 6 rondas', () => {
  const room = setup({ round: 1, a: { attack: seq(2), defense: seq(1) }, b: { attack: seq(3), defense: seq(1) } });
  room.hp[0].shark = 0; room.hp[1].shark = 0;
  room.hp[1].ship = 100000;
  room.players[0].infernal = true;
  const base = setup({ round: 1, a: { attack: seq(2), defense: seq(1) }, b: { attack: seq(3), defense: seq(1) } });
  base.hp[0].shark = 0; base.hp[1].shark = 0;
  base.hp[1].ship = 100000;
  const baseHit = 100000 - resolveRound(base).events[0].hp[1].ship;
  const { events } = resolveRound(room);
  assert.equal(events.length, 4);
  const firstSequence = events[0].shots.filter((s) => s.from === 0);
  assert.deepEqual(firstSequence.map((s) => s.lane).sort(), [1, 2, 3, 4]);
  assert.ok(firstSequence.every((s) => s.target === 'ship' && s.owner === 1));
  assert.equal(firstSequence.filter((s) => s.infernal).length, 3);
  assert.deepEqual(events[0].infernal, [0]);
  for (const ev of events.slice(1)) {
    const mine = ev.shots.filter((s) => s.from === 0);
    assert.deepEqual(mine.map((s) => s.lane), [2]);
    assert.equal(mine[0].target, 'ship');
    assert.equal(mine[0].owner, 1);
    assert.equal(mine.some((s) => s.infernal), false);
    assert.equal(ev.infernal, undefined);
  }
  assert.equal(100000 - events[0].hp[1].ship, 4 * baseHit);
  assert.deepEqual(room.infernoCd, [5, 0]);
});

test('el ataque infernal no se repite hasta pasadas 6 rondas', () => {
  const room = setup({ round: 1, a: { attack: seq(2), defense: seq(1) }, b: { attack: seq(3), defense: seq(1) } });
  room.hp[0].shark = 0; room.hp[1].shark = 0;
  room.hp[1].ship = 100000;
  room.infernoCd = [1, 0];
  room.players[0].infernal = true;
  const { events } = resolveRound(room);
  assert.ok(events.every((ev) => !ev.infernal && ev.shots.filter((s) => s.from === 0).length === 1));
  assert.deepEqual(room.infernoCd, [0, 0]);
});

test('antes de la ronda 20 no hay troncos salvo en la ronda 7', () => {
  const seven = setup({ round: 7, a: { attack: seq(1), defense: seq(2) }, b: { attack: seq(4), defense: seq(2) } });
  seven.wildlife = true;
  assert.ok(resolveRound(seven).events.every((ev) => ev.log));
  const room = setup({ round: 19, a: { attack: seq(1), defense: seq(2) }, b: { attack: seq(4), defense: seq(2) } });
  room.wildlife = true;
  assert.ok(resolveRound(room).events.every((ev) => !ev.log));
});

test('desde la ronda 36 todas las rondas son x2', () => {
  const room = setup({ round: 37, a: { attack: seq(4), defense: seq(2) }, b: { attack: seq(2), defense: seq(2) } });
  resolveRound(room);
  assert.equal(room.hp[1].ship, 105 - 4 * 14);
});

test('si ambos alcanzan la gaviota, la vida es para quien envió antes la secuencia', () => {
  let both = 0;
  for (let n = 0; n < 400; n++) {
    const room = setup({ round: 13, a: { attack: seq(1), defense: seq(2) }, b: { attack: seq(1), defense: seq(2) } });
    room.wildlife = true;
    room.players[0].submittedAt = 2; room.players[1].submittedAt = 1;
    const { events } = resolveRound(room);
    for (const ev of events) {
      if (ev.shots.length === 2 && ev.shots.every((s) => s.target === 'gull')) { both++; assert.equal(ev.heal[1], 15); assert.equal(ev.heal[0], 0); }
    }
  }
  assert.ok(both > 0);
});

test('el cubo flotante (rondas 8, 11, 14…) se hunde con un disparo y cura 10', () => {
  let healed = 0;
  for (let n = 0; n < 200; n++) {
    const room = setup({ round: 8, a: { attack: [1, 2, 3, 4], defense: seq(2) }, b: { attack: seq(1), defense: seq(2) } });
    room.wildlife = true;
    const { events } = resolveRound(room);
    const hits = events.flatMap((ev) => ev.shots).filter((shot) => shot.target === 'bucket');
    assert.ok(hits.length <= 1);
    healed += hits.length;
  }
  assert.ok(healed > 0);
  for (const [round, expected] of [[7, false], [9, false], [10, false], [11, false], [14, true], [17, true]]) {
    const other = setup({ round, a: { attack: seq(1), defense: seq(2) }, b: { attack: seq(4), defense: seq(2) } });
    other.wildlife = true;
    assert.equal(resolveRound(other).events[0].bucket !== null, expected);
  }
});

test('el barco de guerra pirata tiene vida compartida, se puede hundir y quita el 20 % a cada barco', () => {
  for (const round of [13, 21, 44]) {
    const room = setup({ round, a: { attack: seq(1), defense: seq(2) }, b: { attack: seq(4), defense: seq(2) } });
    assert.ok(resolveRound(room).events.every((ev) => !ev.warship));
  }
  for (const round of [11, 22, 33]) {
    const room = setup({ round, a: { attack: [1, 2, 3, 4], defense: seq(1) }, b: { attack: [4, 3, 2, 1], defense: seq(1) }, hp0: 100 });
    room.wildlife = true; room.medkitMatch = true;
    room.players.forEach((player) => { player.bot = true; });
    room.players[0].sword = true; room.players[0].troops = true;
    const { events } = resolveRound(room);
    assert.equal(events.length, 4);
    for (const ev of events) {
      assert.ok(ev.warship);
      assert.ok(ev.shots.every((s) => s.target === 'warship'));
      assert.equal(ev.gull, null); assert.equal(ev.squid, null); assert.equal(ev.log, null); assert.equal(ev.bucket, null); assert.equal(ev.medkit, null); assert.equal(ev.whale, null); assert.equal(ev.sub, null);
      assert.equal(ev.troops, undefined); assert.equal(ev.sword, undefined);
    }
    assert.deepEqual(events.map((ev) => ev.warship.hp), [42, 28, 14, 0]);
    assert.equal(events[0].warship.hpBefore, 56);
    assert.equal(events[3].warship.sunkBy, 1);
    assert.equal(events[3].warship.reward, 0);
    assert.equal(events.flatMap((ev) => ev.shots).reduce((damage, shot) => damage + shot.damage, 0), 56);
    for (const [owner, lane] of events[3].warship.disabledCannons.entries()) {
      const hitCounts = [0, 0, 0, 0];
      for (const ev of events) hitCounts[ev.warship.targetCannons[owner]]++;
      assert.equal(hitCounts[lane], Math.max(...hitCounts));
      assert.equal(events[3].cannons[owner][lane], 0);
      assert.equal(room.cannons[owner][lane], 0);
    }
    assert.deepEqual(events.map((ev) => ev.warship.laser === null), [true, false, true, false]);
    assert.notEqual(events[1].warship.laser, events[3].warship.laser);
    assert.equal(room.hp[0].ship, 80);
    assert.equal(room.hp[1].ship, 105 - 21);
    assert.equal(room.hp[0].shark, 50);

    for (let owner = 0; owner < 2; owner++) {
      const lane = events[3].warship.disabledCannons[owner] + 1;
      Object.assign(room.players[owner], { attack: seq(lane), defense: seq(1), wave: seq(0) });
    }
    const { events: repairEvents } = resolveRound(room);
    for (const [owner, lane] of events[3].warship.disabledCannons.entries()) {
      assert.ok(repairEvents.every((ev) => ev.shots.find((shot) => shot.from === owner).target === 'broken'));
      assert.equal(room.cannons[owner][lane], 15);
    }
  }
  const low = setup({ round: 22, a: { attack: seq(1), defense: seq(1) }, b: { attack: seq(1), defense: seq(1) }, hp0: 1 });
  low.cannons.forEach((cannons) => cannons.fill(0));
  resolveRound(low);
  assert.equal(low.hp[0].ship, 1); // el barco de guerra no hunde a nadie
});

test('la isla de los monos (solo ronda 9): mono fijo por carril, cae de un disparo y luego la bala pasa al barco', () => {
  for (const round of [8, 17, 19]) {
    const room = setup({ round, a: { attack: seq(1), defense: seq(2) }, b: { attack: seq(4), defense: seq(2) } });
    assert.ok(resolveRound(room).events.every((ev) => !ev.monkeys));
  }
  const room = setup({ round: 9, a: { attack: [1, 1, 2, 2], defense: seq(1) }, b: { attack: [4, 3, 4, 3], defense: seq(4) } });
  room.wildlife = true; room.medkitMatch = true;
  const { events } = resolveRound(room);
  assert.deepEqual(events[0].monkeys.map((m) => m.x), [-3, -1, 1, 3]);
  assert.deepEqual(events[0].monkeys.map((m) => m.target).sort(), [0, 0, 1, 1]);
  const coconut = [0, 0];
  for (const ev of events) {
    assert.equal(ev.gull, null); assert.equal(ev.squid, null); assert.equal(ev.log, null); assert.equal(ev.medkit, null); assert.equal(ev.sub, null);
    assert.deepEqual((ev.coconuts || []).map((c) => c.id), ev.monkeys.map((m) => m.id));
    for (const c of ev.coconuts || []) {
      coconut[c.target] += c.dmg;
      if (c.lane !== null) assert.equal(ev.cannons[c.target][c.lane], 0);
    }
  }
  const t = (step, from) => events[step].shots.find((s) => s.from === from);
  // El primer disparo puede abatir al mono; los cocos posteriores pueden dejar inutilizado ese cañón.
  assert.equal(t(0, 0).target, 'monkey'); assert.equal(t(0, 0).coin, 1); assert.equal(t(0, 0).monkey, 0);
  assert.ok(events.flatMap((ev) => ev.shots).every((shot) => ['broken', 'monkey', 'ship'].includes(shot.target)));
  const disabled = [new Set(), new Set()];
  for (const c of events.flatMap((ev) => ev.coconuts || [])) if (c.lane !== null) {
    assert.ok(!disabled[c.target].has(c.lane), 'cada coco bloquea una torreta distinta mientras haya torretas activas');
    disabled[c.target].add(c.lane);
  }
  for (let player = 0; player < 2; player++) for (const lane of disabled[player]) assert.equal(room.cannons[player][lane], 15, 'las torretas se reactivan al terminar la ronda de los monos');
  assert.equal(room.hp[0].shark, 50); assert.equal(room.hp[1].shark, 50);
  for (let player = 0; player < 2; player++) {
    const shipHits = events.flatMap((ev) => ev.shots).filter((shot) => shot.target === 'ship' && shot.owner === player).length;
    assert.equal(room.hp[player].ship, 105 - coconut[player] - 7 * shipHits);
  }
});
