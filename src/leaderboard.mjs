export const RANKING_LIMIT = 20;

export function limitLeaderboard(entries) {
  return entries
    .filter((entry) => Number(entry.best) > 0)
    .sort((a, b) => Number(b.best) - Number(a.best) || a.id.localeCompare(b.id))
    .slice(0, RANKING_LIMIT);
}

export function migrateLegacyRanking(legacy, currentWeek) {
  const entries = Object.entries(legacy);
  return {
    weekKey: currentWeek,
    allTime: limitLeaderboard(entries.map(([id, entry]) => ({ id, name: entry.name, best: Number(entry.best) || 0 }))),
    weekly: limitLeaderboard(entries
      .filter(([, entry]) => entry.weekKey === currentWeek)
      .map(([id, entry]) => ({ id, name: entry.name, best: Number(entry.wBest) || 0 }))),
  };
}

export function upsertLeaderboard(entries, candidate) {
  const index = entries.findIndex((entry) => entry.id === candidate.id);
  if (index < 0 && entries.length >= RANKING_LIMIT && candidate.best <= entries.at(-1).best) return entries;

  const next = index < 0
    ? [...entries, candidate]
    : entries.map((entry, entryIndex) => entryIndex === index
      ? { ...entry, ...candidate, best: Math.max(entry.best, candidate.best) }
      : entry);
  return limitLeaderboard(next);
}