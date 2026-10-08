import test from 'node:test';
import assert from 'node:assert/strict';
import { limitLeaderboard, migrateLegacyRanking, upsertLeaderboard } from '../src/leaderboard.mjs';

function fullLeaderboard() {
  return Array.from({ length: 20 }, (_, index) => ({
    id: `player-${index}`,
    name: `Player ${index}`,
    best: 20 - index,
  }));
}

test('no admite una marca que solo empata el puesto 20', () => {
  const current = fullLeaderboard();
  const updated = upsertLeaderboard(current, { id: 'new-player', name: 'New', best: 1 });

  assert.equal(updated.length, 20);
  assert.equal(updated.some((entry) => entry.id === 'new-player'), false);
  assert.equal(updated.at(-1).id, 'player-19');
});

test('una marca superior entra y elimina al puesto 20', () => {
  const updated = upsertLeaderboard(fullLeaderboard(), { id: 'new-player', name: 'New', best: 2 });

  assert.equal(updated.length, 20);
  assert.equal(updated[0].id, 'player-0');
  assert.equal(updated.some((entry) => entry.id === 'new-player'), true);
  assert.equal(updated.some((entry) => entry.id === 'player-19'), false);
});

test('limita cualquier lista migrada a sus veinte mejores marcas', () => {
  const entries = Array.from({ length: 25 }, (_, index) => ({ id: `player-${index}`, name: `Player ${index}`, best: 25 - index }));

  assert.equal(limitLeaderboard(entries).length, 20);
  assert.equal(limitLeaderboard(entries).at(-1).best, 6);
});

test('migra el ranking antiguo y limita cada periodo por separado', () => {
  const currentWeek = '2026-W41';
  const legacy = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [
    `player-${index}`,
    { name: `Player ${index}`, best: 25 - index, weekKey: currentWeek, wBest: 25 - index },
  ]));
  const migrated = migrateLegacyRanking(legacy, currentWeek);

  assert.equal(migrated.allTime.length, 20);
  assert.equal(migrated.weekly.length, 20);
  assert.equal(migrated.allTime.at(-1).best, 6);
  assert.equal(migrated.weekly.at(-1).best, 6);
});