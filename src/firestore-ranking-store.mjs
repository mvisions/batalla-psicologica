const PROFILE_COLLECTION = 'rankingProfiles';
const RANKING_COLLECTION = 'gameState';
const RANKING_DOCUMENT = 'leaderboards';
const LEAGUE_COLLECTION = 'activeLeagues';
const PROFILE_BATCH_SIZE = 499;

export function createFirestoreRankingStore(database) {
  const rankingRef = database.collection(RANKING_COLLECTION).doc(RANKING_DOCUMENT);
  const profiles = database.collection(PROFILE_COLLECTION);

  const leagues = database.collection(LEAGUE_COLLECTION);

  return {
    // Firestore no admite arrays anidados, así que cada torneo se guarda como JSON
    async saveLeague(code, league) { await leagues.doc(code).set({ data: JSON.stringify(league), updatedAt: Date.now() }); },
    async deleteLeague(code) { await leagues.doc(code).delete(); },
    async loadLeagues() { return (await leagues.get()).docs.map((document) => JSON.parse(document.data().data)); },

    async load() {
      const [rankingSnapshot, profileSnapshot] = await Promise.all([
        rankingRef.get(),
        profiles.get(),
      ]);

      return {
        leaderboard: rankingSnapshot.exists ? rankingSnapshot.data() : null,
        profiles: Object.fromEntries(profileSnapshot.docs.map((document) => [document.id, document.data()])),
      };
    },

    async save(leaderboard, profileData, profileIds = Object.keys(profileData)) {
      const ids = profileIds.filter((id) => profileData[id]);
      for (let offset = 0; offset < ids.length; offset += PROFILE_BATCH_SIZE) {
        const batch = database.batch();
        for (const id of ids.slice(offset, offset + PROFILE_BATCH_SIZE)) {
          batch.set(profiles.doc(id), profileData[id]);
        }
        await batch.commit();
      }
      await rankingRef.set(leaderboard);
    },
  };
}