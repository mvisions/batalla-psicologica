import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRound, makeRoom, botPlan } from '../server.js';

// Partida de dos jugadores con las secuencias indicadas
function setup({ round = 1, a, b, hp0 }) {
  const room = makeRoom({ name: 'A', sub: 'a' }, false);
  room.players.push({ name: 'B', sub: 'b', attack: null, defense: null, wave: null });
  room.round = round;
  if (hp0) room.hp[0].ship = hp0;
  const [p0, p1] = room.players;
  Object.assign(p0, { attack: a.attack, defense: a.defense, wave: a.wave });
  Object.assign(p1, { attack: b.attack, defense: b.defense, wave: b.wave });
  return room;
}
const seq = (n) => [n, n, n, n];

test('dos balas por el mismo carril chocan sin darño', () => {
  const room = setup({ a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(1), defense: seq(4) } });
  const { events } = resolveRound(room);
  assert.ok(events[0].shots.every((s) => s.target === 'collision'));
  assert.equal(room.hp[0].ship, 100);
  assert.equal(room.hp[1].ship, 100);
});

test('el tiburón rival intercepta la bala en su carril', () => {
  const room = setup({ a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(1) } });
  const { events } = resolveRound(room);
  const shot = events[0].shots.find((s) => s.from === 0);
  assert.equal(shot.target, 'shark');
  assert.equal(room.hp[1].shark, 50 - 5 * 4);
  assert.equal(room.hp[1].ship, 100);
});

test('con lluvia (ronda 5) los tiburones no interceptan', () => {
  const room = setup({ round: 5, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(1) } });
  const { events } = resolveRound(room);
  assert.notEqual(events[0].shots.find((s) => s.from === 0).target, 'shark'); // da al barco o a un iceberg
  assert.equal(room.hp[1].shark, 50);
});

test('la ronda 4 hace doble daño', () => {
  const room = setup({ round: 4, a: { attack: seq(1), defense: seq(4) }, b: { attack: seq(4), defense: seq(4) } });
  resolveRound(room);
  assert.equal(room.hp[1].ship, 100 - 10 * 4);
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
