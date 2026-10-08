import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreRankingStore } from '../src/firestore-ranking-store.mjs';

function fakeFirestore() {
  const collections = new Map();
  const getCollection = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  const reference = (collectionName, id) => ({
    id,
    collectionName,
    async get() {
      const value = getCollection(collectionName).get(id);
      return { exists: value !== undefined, data: () => value };
    },
    async set(value) {
      getCollection(collectionName).set(id, value);
    },
  });

  return {
    collection(name) {
      return {
        doc(id) { return reference(name, id); },
        async get() {
          const documents = [...getCollection(name)].map(([id, value]) => ({ id, data: () => value }));
          return { docs: documents };
        },
      };
    },
    batch() {
      const writes = [];
      return {
        set(ref, value) { writes.push([ref, value]); },
        async commit() {
          for (const [ref, value] of writes) await ref.set(value);
        },
      };
    },
  };
}

test('Firestore ranking store loads leaderboard and player profiles', async () => {
  const store = createFirestoreRankingStore(fakeFirestore());
  const empty = await store.load();
  assert.equal(empty.leaderboard, null);
  assert.deepEqual(empty.profiles, {});

  const leaderboard = { version: 2, weekKey: '2026-W41', allTime: [{ id: 'player', name: 'Player', best: 2 }], weekly: [] };
  const profiles = { player: { name: 'Player', points: 10, wins: 1 } };
  await store.save(leaderboard, profiles);

  assert.deepEqual(await store.load(), { leaderboard, profiles });
});

test('Firestore ranking store writes only the requested profile documents', async () => {
  const store = createFirestoreRankingStore(fakeFirestore());
  await store.save({ version: 2, weekKey: '2026-W41', allTime: [], weekly: [] }, {
    keep: { name: 'Keep', points: 10 },
    skip: { name: 'Skip', points: 0 },
  }, ['keep']);

  assert.deepEqual((await store.load()).profiles, { keep: { name: 'Keep', points: 10 } });
});