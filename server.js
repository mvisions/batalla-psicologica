import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Firestore } from '@google-cloud/firestore';
import { createFirestoreRankingStore } from './src/firestore-ranking-store.mjs';
import { limitLeaderboard, migrateLegacyRanking, upsertLeaderboard } from './src/leaderboard.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

// En hosting, una variable estable conserva sesiones e invitaciones entre reinicios.
const KEY_FILE = path.join(DATA, 'secret.key');
const KEY = process.env.SESSION_SECRET
  ? crypto.createHash('sha256').update(process.env.SESSION_SECRET).digest()
  : (() => {
    if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  })();

function encryptCode(code) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(code, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}
function decryptCode(token) {
  try {
    const b = Buffer.from(String(token), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}

const RANK_FILE = path.join(DATA, 'ranking.json');
const PROFILE_FILE = path.join(DATA, 'profiles.json');
const storedRanking = fs.existsSync(RANK_FILE) ? JSON.parse(fs.readFileSync(RANK_FILE, 'utf8')) : {};
const storedProfiles = fs.existsSync(PROFILE_FILE) ? JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')) : null;
// Semana ISO (ej. 2026-W41) para el ranking semanal
const weekKey = (d = new Date()) => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t - y0) / 864e5 + 1) / 7)}`;
};
const currentWeek = weekKey();
const hasLeaderboardFormat = storedRanking.version === 2;
const ranking = storedProfiles || (hasLeaderboardFormat ? storedRanking.profiles || {} : storedRanking);
let rankingNeedsMigration = !hasLeaderboardFormat || !storedProfiles;
const leaderboard = hasLeaderboardFormat
  ? {
    weekKey: storedRanking.weekKey || currentWeek,
    allTime: limitLeaderboard(storedRanking.allTime || []),
    weekly: limitLeaderboard(storedRanking.weekly || []),
  }
  : migrateLegacyRanking(storedRanking, currentWeek);
for (const profile of Object.values(ranking)) {
  delete profile.best;
  delete profile.wBest;
}

const rankingStorage = process.env.RANKING_STORAGE || 'file';
if (!['file', 'firestore'].includes(rankingStorage)) throw new Error('RANKING_STORAGE debe ser file o firestore');
if (rankingStorage === 'firestore' && (!process.env.GOOGLE_CLOUD_PROJECT || !process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  throw new Error('Firestore requiere GOOGLE_CLOUD_PROJECT y GOOGLE_APPLICATION_CREDENTIALS');
}
if (rankingStorage === 'firestore' && !fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  throw new Error('No se encontró el archivo de credenciales de Firestore');
}
const firestoreDatabase = rankingStorage === 'firestore'
  ? new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT })
  : null;
const firestoreRankingStore = firestoreDatabase ? createFirestoreRankingStore(firestoreDatabase) : null;
let firestoreWriteQueue = Promise.resolve();

function rankingDocument() {
  return { version: 2, weekKey: leaderboard.weekKey, allTime: leaderboard.allTime, weekly: leaderboard.weekly };
}

function writeLocalRanking() {
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(ranking));
  fs.writeFileSync(RANK_FILE, JSON.stringify(rankingDocument()));
  rankingNeedsMigration = false;
}

function persistRanking(profileIds = Object.keys(ranking)) {
  writeLocalRanking();
  if (!firestoreRankingStore) return firestoreWriteQueue;

  const leaderboardSnapshot = structuredClone(rankingDocument());
  const profileSnapshot = structuredClone(Object.fromEntries(profileIds
    .filter((id) => ranking[id])
    .map((id) => [id, ranking[id]])));
  const ids = Object.keys(profileSnapshot);
  firestoreWriteQueue = firestoreWriteQueue
    .catch(() => {})
    .then(() => firestoreRankingStore.save(leaderboardSnapshot, profileSnapshot, ids));
  firestoreWriteQueue.catch((error) => console.error('No se pudo guardar el ranking en Firestore:', error));
  return firestoreWriteQueue;
}

async function initializeRankingStore() {
  if (!firestoreRankingStore) return;

  const remote = await firestoreRankingStore.load();
  if (remote.leaderboard?.version === 2) {
    for (const id of Object.keys(ranking)) delete ranking[id];
    Object.assign(ranking, remote.profiles);
    leaderboard.weekKey = remote.leaderboard.weekKey || currentWeek;
    leaderboard.allTime = limitLeaderboard(remote.leaderboard.allTime || []);
    leaderboard.weekly = limitLeaderboard(remote.leaderboard.weekly || []);
    rankingNeedsMigration = false;
  } else {
    Object.assign(ranking, remote.profiles);
    await firestoreRankingStore.save(rankingDocument(), structuredClone(ranking), Object.keys(ranking));
    rankingNeedsMigration = false;
  }
  applyBotStartLevels();
  writeLocalRanking();
}

function ensureCurrentWeek() {
  const key = weekKey();
  if (leaderboard.weekKey === key) return;
  leaderboard.weekKey = key;
  leaderboard.weekly = [];
  for (const profile of Object.values(ranking)) {
    profile.weekKey = key;
    profile.wStreak = 0;
  }
  persistRanking([winner.sub, loser.sub]);
}

const RONALDO_SUB = 'tournament-bot-ronaldo'; // el único bot que sube de nivel: 1 punto por partida ganada
const BOT_START_LEVELS = { 'tournament-bot-messi': ['Messi', 1], 'tournament-bot-lamine': ['Lamine', 5], [RONALDO_SUB]: ['Ronaldo', 20] };
const levelForPoints = (points) => Math.floor(points / 100) + 1;
function applyBotStartLevels() { // nivel inicial de los bots del torneo (Ronaldo supera el máximo de los jugadores)
  for (const [sub, [name, level]] of Object.entries(BOT_START_LEVELS)) {
    const entry = (ranking[sub] ||= { name, streak: 0, points: 0, wins: 0, level: 1 });
    entry.name = name; entry.points = Math.max(entry.points || 0, (level - 1) * 100); entry.level = Math.max(entry.level || 1, level);
  }
}
applyBotStartLevels();
const pointsPerWin = (level) => (level >= 15 ? 10 : 50); // a partir del nivel 15 cada victoria da menos puntos
const DAILY_WINS = 3, DAILY_COINS = 10;
const SHOP = { swordfish: { name: 'Pez espada', price: 150 }, infernal: { name: 'Ataque infernal', price: 450 }, viking: { name: 'Barco vikingo', price: 250 }, fireballs: { name: 'Balas de fuego', price: 500 }, fireDragon: { name: 'Dragón de fuego', price: 1500 }, stormDragon: { name: 'Dragón de rayos', price: 1500 } };
// las skins de nivel cambian en los niveles 5, 10, 15, 20, 25 y 30
const skinTier = (level) => Math.min(30, Math.floor((Number(level) || 1) / 5) * 5);
// el barco vikingo se mantiene mientras no se alcance un nivel con skin nueva
const activeSkin = (entry) => (entry?.viking && entry.vikingTier === skinTier(entry.level) ? 'viking' : null);
const today = () => new Date().toISOString().slice(0, 10);
function dailyProgress(entry) {
  return entry.dailyDay === today() ? Number(entry.dailyWins) || 0 : 0;
}
// el reto del día (3 victorias) se premia una sola vez con monedas
function countDailyWin(entry) {
  const wins = dailyProgress(entry) + 1;
  entry.dailyDay = today(); entry.dailyWins = wins;
  if (wins === DAILY_WINS) entry.coins = (Number(entry.coins) || 0) + DAILY_COINS;
}
function profileView(entry) {
  const points = Number(entry.points) || 0;
  return {
    points, wins: Number(entry.wins) || 0, level: Number(entry.level) || levelForPoints(points),
    coins: Number(entry.coins) || 0, swordfish: Boolean(entry.swordfish), infernal: Boolean(entry.infernal), viking: Boolean(entry.viking), fireballs: Boolean(entry.fireballs), fireDragon: Boolean(entry.fireDragon), stormDragon: Boolean(entry.stormDragon), skin: activeSkin(entry),
    daily: { wins: Math.min(DAILY_WINS, dailyProgress(entry)), goal: DAILY_WINS, reward: DAILY_COINS },
    shop: Object.entries(SHOP).map(([id, { name, price }]) => ({ id, name, price })),
  };
}
function recordResult(winner, loser) {
  ensureCurrentWeek();
  const key = leaderboard.weekKey;
  const get = (p) => {
    const e = (ranking[p.sub] ||= { name: p.name, streak: 0, points: 0, wins: 0, level: 1 });
    e.name = p.name;
    e.points ||= 0; e.wins ||= 0; e.level ||= 1;
    if (e.weekKey !== key) { e.weekKey = key; e.wStreak = 0; }
    return e;
  };
  const w = get(winner), l = get(loser);
  w.streak++; w.wStreak++;
  w.points += pointsPerWin(w.level); w.wins++; w.level = levelForPoints(w.points);
  countDailyWin(w);
  l.streak = 0; l.wStreak = 0;
  leaderboard.allTime = upsertLeaderboard(leaderboard.allTime, { id: winner.sub, name: w.name, best: w.streak });
  leaderboard.weekly = upsertLeaderboard(leaderboard.weekly, { id: winner.sub, name: w.name, best: w.wStreak });
  persistRanking([winner.sub]);
}
function recordBotWin(winner) {
  ensureCurrentWeek();
  const entry = (ranking[winner.sub] ||= { name: winner.name, streak: 0, points: 0, wins: 0, level: 1 });
  entry.name = winner.name;
  entry.points = (entry.points || 0) + pointsPerWin(entry.level);
  entry.wins = (entry.wins || 0) + 1;
  entry.level = levelForPoints(entry.points);
  countDailyWin(entry);
  persistRanking();
}
const TOURNAMENT_POINTS = { champion: 200, runnerUp: 150, third: 100, fourth: 0 };
function awardTournamentPoints(league) {
  if (league.awarded) return;
  league.awarded = true;
  const placements = { champion: league.champion, runnerUp: league.runnerUp, third: league.third, fourth: league.fourth };
  if (league.size !== 4) { // liga de 8: solo campeón y finalista
    const final = league.rounds[2]?.[0];
    placements.runnerUp = final ? final.players.find((id) => id !== final.winner) : undefined;
    delete placements.third; delete placements.fourth;
  }
  league.rewards = {};
  for (const [place, id] of Object.entries(placements)) {
    const player = league.players[id];
    if (id === undefined || id === null || !player || player.bot || !player.sub) continue;
    const entry = (ranking[player.sub] ||= { name: player.name, streak: 0, points: 0, wins: 0, level: 1 });
    entry.points = (entry.points || 0) + TOURNAMENT_POINTS[place];
    entry.level = levelForPoints(entry.points);
    league.rewards[id] = TOURNAMENT_POINTS[place];
    persistRanking([player.sub]);
  }
}
const GAMES_FILE = path.join(DATA, 'games.json');
const games = fs.existsSync(GAMES_FILE) ? JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8')) : [];
function recordGame(room, winner) {
  const [a, b] = room.players;
  games.unshift({ a: a.name, b: b.name, winner: winner === 'draw' ? null : room.players[winner].name, ms: Date.now() - room.startedAt, at: Date.now() });
  games.length = Math.min(games.length, 20);
  fs.writeFileSync(GAMES_FILE, JSON.stringify(games));
}
const topRanking = (period) => {
  ensureCurrentWeek();
  if (rankingNeedsMigration) persistRanking();
  return (period === 'week' ? leaderboard.weekly : leaderboard.allTime).map(({ name, best }) => ({ name, best }));
};
const randSeq = () => Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 4));
const randWave = () => Array.from({ length: 4 }, () => Math.floor(Math.random() * 3));

// La autenticación de jugadores siempre requiere una sesión de Google verificada.
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ALLOW_DEVELOPMENT_LOGIN = process.env.ALLOW_DEVELOPMENT_LOGIN === 'true';

// Dirección con la que otros jugadores pueden entrar: PUBLIC_URL, o la IP de la red local si no se define
const EXPLICIT_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const API_BASE_URL = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean));
if (EXPLICIT_URL) {
  try { allowedOrigins.add(new URL(EXPLICIT_URL).origin); } catch { /* invalid public URL is rejected by deployment checks */ }
}
function lanUrl() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return `http://${i.address}:${PORT}`;
  }
  return `http://localhost:${PORT}`;
}
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', KEY).update(s).digest('base64url');
function makeSession(user) {
  const p = b64(JSON.stringify({ ...user, exp: Date.now() + 7 * 864e5 }));
  return `${p}.${sign(p)}`;
}
function readSession(tok) {
  const [p, sig] = String(tok || '').split('.');
  if (!p || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const u = JSON.parse(Buffer.from(p, 'base64url').toString());
    return u.exp > Date.now() ? { sub: u.sub, name: u.name, picture: u.picture } : null;
  } catch { return null; }
}
async function verifyGoogle(credential) {
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(String(credential))}`);
  if (!r.ok) return null;
  const t = await r.json();
  if (t.aud !== CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(t.iss) || Number(t.exp) * 1000 < Date.now()) return null;
  return { sub: 'g:' + t.sub, name: cleanName(t.name || t.given_name || t.email), picture: t.picture };
}
// El acceso por nombre solo se permite explícitamente en procesos de prueba.
function identify(b) {
  if (CLIENT_ID) return readSession(b.session);
  if (!ALLOW_DEVELOPMENT_LOGIN) return null;
  const name = cleanName(b.name);
  return { sub: 'n:' + name.toLowerCase(), name };
}
const PORT = process.env.PORT || 3000;
const START_ROUND = Number(process.env.START_ROUND) || 1; // solo para pruebas
const DMG = 7;
const rooms = new Map();
const leagues = new Map();
let leagueWriteQueue = Promise.resolve();
const leagueRecord = (league) => { const { registrationTimer, ...rest } = league; return rest; };
function saveLeague(league) { // los torneos sobreviven a reinicios del servidor (solo con Firestore)
  if (!firestoreRankingStore) return;
  const record = league.status === 'complete' ? null : structuredClone(leagueRecord(league));
  leagueWriteQueue = leagueWriteQueue // en orden, para que un guardado antiguo no resucite un torneo ya terminado
    .then(() => (record ? firestoreRankingStore.saveLeague(league.code, record) : firestoreRankingStore.deleteLeague(league.code)))
    .catch((error) => console.error('No se pudo guardar el torneo:', error.message));
}
const matchQueue = [];
const matchTickets = new Map();

const valid = (s) => Array.isArray(s) && s.length === 4 && s.every((n) => Number.isInteger(n) && n >= 1 && n <= 4);
const validWave = (s) => Array.isArray(s) && s.length === 4 && s.every((n) => Number.isInteger(n) && n >= 0 && n <= 2);
const cleanName = (n) => String(n || '').trim().slice(0, 16) || 'Jugador';
const cleanCountry = (c) => (/^[a-z]{2}$/i.test(String(c)) ? String(c).toLowerCase() : 'un'); // 'un' = bandera internacional
function shipMaxHpForLevel(level) { return 100 + 5 * Math.max(1, Math.floor(Number(level) || 1)); }
function maxShipHealthForPlayer(player) { return player?.bot ? (BOT_START_LEVELS[player.sub] ? shipMaxHpForLevel(ranking[player.sub]?.level) : 100) : shipMaxHpForLevel(ranking[player?.sub]?.level); }
function setRoomPlayerMaxHealth(room, index) {
  room.maxShipHp[index] = maxShipHealthForPlayer(room.players[index]);
  if (room.hp[index]) room.hp[index].ship = room.maxShipHp[index];
}

const DOME_COOLDOWN = 2, FOOD_COOLDOWN = 5, FOOD_HEAL = 25;
const SWORD_COOLDOWN = 4, SWORD_DMG = 10; // el pez espada comprado en la tienda ataca a la ballena rival cada 4 rondas
const FIRE_COOLDOWN = 6, FIRE_DMG = 3; // las balas de fuego quitan 3 más; siguen encendidas hasta apagarlas y solo se encienden cada 6 rondas
const DRAGON_COOLDOWN = 6, DRAGON_PCT = 0.25; // dragones de la tienda: el de fuego quita el 25% de la vida actual del barco rival y el de rayos el 25% de cada cañón rival
const dragonsOf = (p) => ({ fire: !p?.bot && Boolean(ranking[p?.sub]?.fireDragon), storm: !p?.bot && Boolean(ranking[p?.sub]?.stormDragon) });
const INFERNO_COOLDOWN = 6; // el ataque infernal comprado en la tienda dispara los 4 cañones en los 4 disparos, cada 6 rondas
const TROOP_DMG = 15, TROOP_COOLDOWN = 2; // el barquito vuelve a estar listo dos rondas después
function resolveRound(room) {
  const medkitPosts = [-3, -1, 1, 3];
  const medkitRound = room.medkitMatch && room.round >= 3 && (room.round - 3) % 3 === 0;
  const blockRound = room.round % 10 === 0;
  let medkitCollected = false;
  const rain = room.round % 5 === 0 && room.round !== 15; // la ronda 15 es nevada, no lluvia
  const whaleRound = room.round % 7 === 0; // ballena extra en medio del mar, en un carril al azar por disparo
  const swell = room.round % 6 === 0; // con oleaje los barcos se desplazan: 1 derecha, 2 izquierda, 0 quieto
  const pos = [0, 0]; // desplazamiento de cada barco en unidades de medio carril
  const MOVE = [0, 1, -1];
  const [p0, p1] = room.players;
  const P = [p0, p1];
  const events = [];
  const cann = room.cannons, mult = room.round % 4 === 0 || room.round >= 36 ? 2 : 1;
  const hpRatio0 = (room.maxShipHp[0] + room.maxShipHp[1]) / 2 / 105, capRatio = 255 / 105; // hasta el nivel 30 el daño crece poco y los duelos se alargan; a partir de ahí crece con la vida y la duración se estabiliza
  const hpScale = Math.max(1, Math.pow(Math.min(hpRatio0, capRatio), 0.04) * Math.max(1, Math.pow(hpRatio0 / capRatio, 0.5)));
  const hull = (n) => Math.round(n * hpScale);
  const iceAlive = [true, true]; // icebergs de la ronda de lluvia
  const wild = room.wildlife !== false;
  let gullAlive = wild; // la gaviota vuela a un carril al azar en cada disparo
  const squidRound = wild && room.round % 2 === 1; // el calamar sale una ronda sí y otra no
  const hpRatio = (k) => room.hp[k].ship / room.maxShipHp[k];
  const squidOwner = !squidRound ? null : hpRatio(0) === hpRatio(1) ? Math.floor(Math.random() * 2) : hpRatio(0) < hpRatio(1) ? 0 : 1; // protege al más perjudicado
  let squidAlive = squidRound;
  const logRound = wild && (room.round === 7 || (room.round >= 20 && Math.random() < 0.5)); // tronco en la ronda 7 y, desde la 20, al azar
  let bucketAlive = wild && room.round >= 8 && (room.round - 8) % 3 === 0; // desde la ronda 8 y cada 3 rondas flota un cubo en un carril al azar que se hunde de un disparo y cura 10
  const firstSubmitter = (P[0].submittedAt ?? Infinity) <= (P[1].submittedAt ?? Infinity) ? 0 : 1; // se lleva la vida de la gaviota si ambos la alcanzan
  const heliFor = [0, 1].map((k) => room.hp[k].ship > 0 && room.hp[k].ship <= 5 && Boolean(P[k].heli || P[k].bot));
  const troopsFor = [0, 1].map((k) => (room.troopsCd?.[k] || 0) === 0 && Boolean(P[k].troops || (P[k].bot && !room.tutorial && Math.random() < 0.5)));
  room.troopsCd ||= [0, 0];
  for (const k of [0, 1]) if (troopsFor[k]) room.troopsCd[k] = TROOP_COOLDOWN;
  room.domeCd ||= [0, 0];
  const domeFor = [0, 1].map((k) => room.domeCd[k] === 0 && Boolean(P[k].dome || (P[k].bot && !room.tutorial && Math.random() < 0.5)));
  const domeIdx = [null, null]; // la cúpula cubre durante toda la ronda al cañón más débil que sigue en pie
  for (const k of [0, 1]) if (domeFor[k]) {
    let weak = -1;
    for (let l = 0; l < 4; l++) if (cann[k][l] > 0 && (weak < 0 || cann[k][l] < cann[k][weak])) weak = l;
    if (weak >= 0) { domeIdx[k] = weak; room.domeCd[k] = DOME_COOLDOWN; }
  }
  room.foodCd ||= [0, 0];
  const foodFor = [0, 1].map((k) => room.foodCd[k] === 0 && room.hp[k].shark > 0 && Boolean(P[k].food || (P[k].bot && !room.tutorial && room.hp[k].shark <= 25)));
  for (const k of [0, 1]) if (foodFor[k]) room.foodCd[k] = FOOD_COOLDOWN;
  room.swordCd ||= [0, 0];
  const swordFor = [0, 1].map((k) => room.swordCd[k] === 0 && Boolean(P[k].sword) && room.hp[1 - k].shark > 0);
  for (const k of [0, 1]) if (swordFor[k]) room.swordCd[k] = SWORD_COOLDOWN;
  room.dragonCd ||= [0, 0];
  const dragonFor = [0, 1].map((k) => { const d = dragonsOf(P[k]); return room.dragonCd[k] === 0 && Boolean(P[k].dragon) && (d.fire || d.storm); });
  for (const k of [0, 1]) if (dragonFor[k]) room.dragonCd[k] = DRAGON_COOLDOWN;
  room.infernoCd ||= [0, 0];
  const infernoFor = [0, 1].map((k) => room.infernoCd[k] === 0 && Boolean(P[k].infernal));
  for (const k of [0, 1]) if (infernoFor[k]) room.infernoCd[k] = INFERNO_COOLDOWN;
  // cañón del barco k más cercano al punto de impacto x
  const nearestCannon = (k, x) => {
    let best = 0;
    for (let l = 1; l < 4; l++) if (Math.abs(x - (2 * (l + 1) - 5 + pos[k])) < Math.abs(x - (2 * (best + 1) - 5 + pos[k]))) best = l;
    return best;
  };
  for (let i = 0; i < 4; i++) {
    const atk = [p0.attack[i], p1.attack[i]];
    const def = [p0.defense[i], p1.defense[i]];
    if (swell) for (const k of [0, 1]) pos[k] = Math.max(-2, Math.min(2, pos[k] + MOVE[P[k].wave[i]]));
    const whaleX = whaleRound ? [-3, -1, 1, 3][Math.floor(Math.random() * 4)] : null;
    // submarino (rondas múltiplo de 3): cruza el centro en un carril al azar, dispara a un lado al azar y se va antes del último disparo
    const subRound = room.round % 3 === 0 && i < 3;
    const subX = subRound ? [-3, -1, 1, 3][Math.floor(Math.random() * 4)] : null;
    const octopusX = room.round === 2 && !room.octopusUsed ? 2 * room.octopusLane - 5 : null;
    const medkitX = medkitRound && !medkitCollected ? medkitPosts[i] : null;
    const gullX = gullAlive ? medkitPosts[Math.floor(Math.random() * 4)] : null;
    const squidX = squidAlive ? medkitPosts[Math.floor(Math.random() * 4)] : null;
    const bucketX = bucketAlive ? medkitPosts[Math.floor(Math.random() * 4)] : null;
    // árbol caído en horizontal: ocupa dos carriles contiguos a la vez
    const logStart = logRound ? Math.floor(Math.random() * 3) : null;
    const logXs = logStart === null ? [] : [medkitPosts[logStart], medkitPosts[logStart + 1]];
    const logX = logStart === null ? null : (logXs[0] + logXs[1]) / 2;
    const onLog = (x) => logXs.includes(x);
    const squidUp = squidAlive && Math.random() < 0.5; // bajo el agua no detiene el disparo
    // icebergs (lluvia): dos, derivan a carriles al azar en cada disparo; la primera bala que da a uno lo destruye
    const lanePool = [-3, -1, 1, 3].sort(() => Math.random() - 0.5);
    const iceX = rain ? [iceAlive[0] ? lanePool[0] : null, iceAlive[1] ? lanePool[1] : null] : null;
    const iceAt = (x) => (iceX ? iceX.findIndex((v) => v !== null && v === x) : -1);
    const ev = { step: i, atk, def, pos: [...pos], swell, whale: whaleX, ice: iceX, sub: subRound ? { x: subX, toward: Math.floor(Math.random() * 2) } : null, octopus: octopusX === null ? null : { x: octopusX, release: null }, medkit: medkitX === null ? null : { x: medkitX }, gull: gullX === null ? null : { x: gullX }, squid: squidX === null ? null : { x: squidX, up: squidUp, owner: squidOwner }, log: logX === null ? null : { x: logX, lanes: logXs }, bucket: bucketX === null ? null : { x: bucketX }, shots: [] };
    ev.dome = [...domeIdx];
    const heal = [0, 0], heliHeal = [0, 0];
    if (i === 0) {
      for (const k of [0, 1]) if (foodFor[k]) {
        room.hp[k].shark = Math.min(50, room.hp[k].shark + FOOD_HEAL);
        (ev.food ||= []).push({ owner: k });
      }
      for (const k of [0, 1]) if (heliFor[k]) {
        room.hp[k].ship = Math.min(room.maxShipHp[k], room.hp[k].ship + 15);
        heliHeal[k] = 15;
        (ev.heli ||= []).push({ owner: k });
      }
    }
    const dmg = [{ ship: 0, shark: 0 }, { ship: 0, shark: 0 }];
    const cdmg = [[0, 0, 0, 0], [0, 0, 0, 0]]; // daño a cada cañón en este disparo
    const crepair = [[0, 0, 0, 0], [0, 0, 0, 0]];
    const hitBy = [[null, null, null, null], [null, null, null, null]]; // quién golpeó cada cañón
    const shielded = (k, c) => { // la cúpula absorbe cualquier impacto sobre su cañón
      if (domeIdx[k] !== c) return false;
      (ev.domeBlocks ||= []).push({ owner: k, lane: c + 1 });
      return true;
    };
    if (i === 0) { // el barquito esquiva todo y se estrella contra el cañón más débil del rival
      for (const k of [0, 1]) if (troopsFor[k]) {
        const t = 1 - k;
        let weak = -1;
        for (let l = 0; l < 4; l++) if (cann[t][l] > 0 && (weak < 0 || cann[t][l] < cann[t][weak])) weak = l;
        if (weak < 0) continue;
        const blocked = shielded(t, weak);
        if (!blocked) { dmg[t].ship += hull(TROOP_DMG); cdmg[t][weak] += TROOP_DMG; hitBy[t][weak] = k; }
        (ev.troops ||= []).push({ owner: k, target: t, lane: weak + 1, x: 2 * (weak + 1) - 5 + pos[t], blocked });
      }
      for (const k of [0, 1]) if (dragonFor[k]) { // los dragones pasan sobre el barco rival
        const t = 1 - k, d = dragonsOf(P[k]);
        const hit = { owner: k, target: t, fire: d.fire, storm: d.storm, shipDmg: 0, cannonDmg: [0, 0, 0, 0] };
        if (d.fire) { hit.shipDmg = Math.ceil(room.hp[t].ship * DRAGON_PCT); dmg[t].ship += hit.shipDmg; }
        if (d.storm) for (let l = 0; l < 4; l++) {
          if (cann[t][l] <= 0 || shielded(t, l)) continue;
          hit.cannonDmg[l] = Math.ceil(cann[t][l] * DRAGON_PCT); cdmg[t][l] += hit.cannonDmg[l]; hitBy[t][l] = k;
        }
        (ev.dragon ||= []).push(hit);
      }
      for (const k of [0, 1]) if (swordFor[k]) { // el pez espada embiste a la ballena rival
        dmg[1 - k].shark += SWORD_DMG;
        (ev.sword ||= []).push({ owner: k, target: 1 - k, def: def[1 - k], dmg: SWORD_DMG });
      }
    }
    const live = [cann[0][atk[0] - 1] > 0, cann[1][atk[1] - 1] > 0]; // un cañón roto no dispara
    const blocked = [
      blockRound && room.players[1].block?.[i] === atk[0],
      blockRound && room.players[0].block?.[i] === atk[1],
    ];
    const firing = live.map((isLive, player) => isLive && !blocked[player]);
    // posición real de cada bala (el cañón se mueve con el barco)
    const xu = [2 * atk[0] - 5 + pos[0], 2 * atk[1] - 5 + pos[1]];
    const simultaneousCollision = firing[0] && firing[1] && xu[0] === xu[1] && xu[0] !== subX && iceAt(xu[0]) < 0 && xu[0] !== gullX && !onLog(xu[0]) && !(squidUp && xu[0] === squidX);
    let octopusCaughtThisStep = false;
    let medkitCaughtThisStep = false;
    const gullHits = [];
    const squidHit = (x) => squidUp && squidAlive && x === squidX;
    const fireShot = (from, lane, x, extra = false) => {
      const other = 1 - from;
      const tag = extra ? { infernal: true } : {};
      if (room.fireOn?.[from]) tag.fire = true;
      if (!extra && !live[from]) { ev.shots.push({ from, lane, x, target: 'broken' }); return; }
      if (!extra && blocked[from]) { ev.shots.push({ from, lane, x, target: 'blocked', ...tag }); return; }
      const sharkAt = (k) => !rain && room.hp[k].shark > 0 && 2 * def[k] - 5 === x;
      let target, owner, iceId;
      if (!extra && simultaneousCollision && from === 1 && (octopusCaughtThisStep || medkitCaughtThisStep)) { target = 'collision'; }
      else if (squidHit(x) && from === squidOwner) { target = 'squid'; owner = squidOwner; squidAlive = false; ev.squid.blocked = true; }
      else if (sharkAt(from)) { target = 'shark'; owner = from; }
      else if (onLog(x)) { target = 'log'; } // el árbol para los disparos de ambos lados en sus dos carriles
      else if (octopusX !== null && !room.octopusUsed && x === octopusX) {
        target = 'octopus'; owner = other;
        room.octopusUsed = true;
        octopusCaughtThisStep = true;
        const returnLanes = [1, 2, 3, 4].filter((l) => l !== lane);
        const returnLane = returnLanes[Math.floor(Math.random() * returnLanes.length)];
        const returnX = 2 * returnLane - 5;
        const returnTarget = !rain && room.hp[other].shark > 0 && 2 * def[other] - 5 === returnX
          ? 'shark'
          : Math.abs(returnX - pos[other]) <= 4 ? 'ship' : 'miss';
        const amount = DMG * mult;
        if (returnTarget === 'shark') dmg[other].shark += amount;
        else if (returnTarget === 'ship') {
          const cannon = nearestCannon(other, returnX);
          if (!shielded(other, cannon)) {
            dmg[other].ship += hull(amount);
            cdmg[other][cannon] += amount;
            hitBy[other][cannon] = from;
          }
        }
        ev.octopus.release = { from, lane: returnLane, x: returnX, target: returnTarget, owner: other };
      }
      else if (medkitX !== null && x === medkitX && !medkitCollected) {
        target = 'medkit';
        medkitCollected = true;
        medkitCaughtThisStep = true;
        heal[from] += 40;
      }
      else if (iceAt(x) >= 0) { target = 'ice'; iceId = iceAt(x); iceAlive[iceId] = false; } // el iceberg se autodestruye con la bala
      else if (subX !== null && x === subX) {
        target = 'sub'; heal[from] += 5; crepair[from][lane - 1] += 5;
      }
      else if (bucketX !== null && bucketAlive && x === bucketX) { target = 'bucket'; bucketAlive = false; heal[from] += 10; }
      else if (gullX !== null && gullAlive && x === gullX) { target = 'gull'; gullHits.push(from); }
      else if (whaleX !== null && x === whaleX) { target = 'whale'; owner = from; } // la orca rebota la bala contra el barco que disparó
      else if (sharkAt(other)) { target = 'shark'; owner = other; }
      else if (squidHit(x)) { target = 'squid'; owner = squidOwner; squidAlive = false; ev.squid.blocked = true; }
      else if (Math.abs(x - pos[other]) <= 4) { target = 'ship'; owner = other; }
      else { target = 'miss'; owner = other; }
      const fire = Boolean(room.fireOn?.[from]);
      const amount = DMG * mult + (fire ? FIRE_DMG : 0);
      if (target === 'ship') {
        const c = nearestCannon(owner, x);
        if (!shielded(owner, c)) { dmg[owner].ship += hull(amount); cdmg[owner][c] += amount; hitBy[owner][c] = from; }
      } else if (target === 'shark') dmg[owner].shark += amount;
      else if (target === 'whale') {
        const c = nearestCannon(from, x);
        if (!shielded(from, c)) { dmg[from].ship += hull(amount); cdmg[from][c] += amount; }
      }
      ev.shots.push({ from, lane, x, target, owner, ice: iceId, ...tag });
    };
    if (simultaneousCollision && xu[0] !== medkitX && xu[0] !== octopusX) {
      ev.shots = [0, 1].map((from) => ({ from, lane: atk[from], x: xu[from], target: 'collision', ...(room.fireOn?.[from] ? { fire: true } : {}) }));
    } else {
      // el calamar está junto a su barco: lo alcanza antes la bala de su protegido
      const order = squidHit(xu[0]) && squidHit(xu[1]) ? [squidOwner, 1 - squidOwner] : [0, 1];
      for (const from of order) fireShot(from, atk[from], xu[from]);
    }
    // ataque infernal: además del disparo elegido, disparan a la vez el resto de cañones en pie
    for (const k of [0, 1]) if (infernoFor[k]) {
      for (let lane = 1; lane <= 4; lane++) {
        if (lane === atk[k] || cann[k][lane - 1] <= 0) continue;
        const x = 2 * lane - 5 + pos[k];
        if (blockRound && room.players[1 - k].block?.[i] === lane) { ev.shots.push({ from: k, lane, x, target: 'blocked', infernal: true }); continue; }
        fireShot(k, lane, x, true);
      }
    }
    if (infernoFor.some(Boolean)) ev.infernal = [0, 1].filter((k) => infernoFor[k]);
    if (gullHits.length) { gullAlive = false; heal[gullHits.includes(firstSubmitter) ? firstSubmitter : gullHits[0]] += 15; }
    // disparo del submarino hacia el jugador elegido: lo para su tiburón si está en ese carril; si no, da al barco
    if (ev.sub) {
      const k = ev.sub.toward, amount = DMG * mult;
      ev.sub.owner = k;
      if (!rain && room.hp[k].shark > 0 && 2 * def[k] - 5 === subX) { ev.sub.target = 'shark'; dmg[k].shark += amount; }
      else if (Math.abs(subX - pos[k]) <= 4) {
        ev.sub.target = 'ship';
        const c = nearestCannon(k, subX);
        if (!shielded(k, c)) { dmg[k].ship += hull(amount); cdmg[k][c] += amount; } // sin hitBy: no cura a nadie
      } else ev.sub.target = 'miss';
    }
    for (const k of [0, 1]) {
      room.hp[k].ship = Math.max(0, room.hp[k].ship - dmg[k].ship);
      room.hp[k].shark = Math.max(0, room.hp[k].shark - dmg[k].shark);
      for (let l = 0; l < 4; l++) {
        const before = cann[k][l];
        cann[k][l] = Math.max(0, before - cdmg[k][l]);
        if (before > 0 && cann[k][l] === 0 && hitBy[k][l] !== null) heal[hitBy[k][l]] += 5; // romper un cañón rival cura 5
        cann[k][l] = Math.min(25, cann[k][l] + crepair[k][l]);
      }
    }
    for (const k of [0, 1]) if (heal[k] > 0 && room.hp[k].ship > 0) room.hp[k].ship = Math.min(room.maxShipHp[k], room.hp[k].ship + heal[k]);
    ev.heal = heal.map((h, k) => h + heliHeal[k]);
    ev.maxShipHp = [...room.maxShipHp];
    ev.hp = JSON.parse(JSON.stringify(room.hp));
    ev.cannons = JSON.parse(JSON.stringify(cann));
    events.push(ev);
    if (room.hp[0].ship <= 0 || room.hp[1].ship <= 0) break;
  }
  let winner = null;
  const dead0 = room.hp[0].ship <= 0, dead1 = room.hp[1].ship <= 0;
  if (dead0 || dead1) winner = dead0 && dead1 ? 'draw' : dead0 ? 1 : 0;
  const seqs = P.map((p) => ({ attack: p.attack, defense: p.defense, wave: p.wave, block: p.block }));
  P.forEach((p, k) => {
    room.hist[k].push({ attack: p.attack, defense: p.defense });
    if (room.hist[k].length > 10) room.hist[k].shift();
    p.attack = null; p.defense = null; p.wave = null; p.block = null; p.heli = false; p.troops = false; p.dome = false; p.food = false; p.sword = false; p.infernal = false; p.dragon = false; p.submittedAt = null;
  });
  room.troopsCd = room.troopsCd.map((n) => Math.max(0, n - 1));
  room.domeCd = room.domeCd.map((n) => Math.max(0, n - 1));
  room.foodCd = room.foodCd.map((n) => Math.max(0, n - 1));
  room.swordCd = room.swordCd.map((n) => Math.max(0, n - 1));
  room.infernoCd = room.infernoCd.map((n) => Math.max(0, n - 1));
  room.fireCd = (room.fireCd || [0, 0]).map((n) => Math.max(0, n - 1));
  room.dragonCd = (room.dragonCd || [0, 0]).map((n) => Math.max(0, n - 1));
  // un cañón roto se regenera con 15 de vida para la siguiente ronda
  for (const k of [0, 1]) for (let l = 0; l < 4; l++) if (cann[k][l] === 0) cann[k][l] = 15;
  room.round = room.leagueMatch ? 1 + Math.floor(Math.random() * 37) : room.round + 1; // en torneos y ligas las rondas son aleatorias (1-37)
  return { events, winner, seqs };
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(room, event, data) {
  room.players.forEach((p) => p.stream && send(p.stream, event, data));
  room.spectators?.forEach((stream) => send(stream, event, data));
}
const info = (room) => ({ names: room.players.map((p) => p.name), countries: room.players.map((p) => p.country || 'un'), levels: room.players.map((p) => Number(ranking[p.sub]?.level) || 1), skins: room.players.map((p) => (p.bot ? null : activeSkin(ranking[p.sub]))), maxShipHp: room.players.map(maxShipHealthForPlayer), blockRound: room.round % 10 === 0, hp: room.hp, cannons: room.cannons, round: room.round, over: room.over, tutorial: room.tutorial, inputMs: room.tutorial ? null : INPUT_MS, troopsCd: room.troopsCd || [0, 0], domeCd: room.domeCd || [0, 0], foodCd: room.foodCd || [0, 0], swordCd: room.swordCd || [0, 0], swordfish: room.players.map((p) => !p.bot && Boolean(ranking[p.sub]?.swordfish)), infernoCd: room.infernoCd || [0, 0], infernal: room.players.map((p) => !p.bot && Boolean(ranking[p.sub]?.infernal)), fireCd: room.fireCd || [0, 0], fireOn: room.fireOn || [false, false], fireballs: room.players.map((p) => !p.bot && Boolean(ranking[p.sub]?.fireballs)), dragonCd: room.dragonCd || [0, 0], dragons: room.players.map(dragonsOf) });

// Secuencia aleatoria usando solo cañones que funcionan
const workingSeq = (room, k) => {
  const ok = [1, 2, 3, 4].filter((l) => room.cannons[k][l - 1] > 0);
  const pool = ok.length ? ok : [1];
  return Array.from({ length: 4 }, () => pool[Math.floor(Math.random() * pool.length)]);
};

const INPUT_MS = 30000, SHOT_MS = 5000;

const newKey = () => crypto.randomBytes(12).toString('hex');
const blankPlayer = (name, sub, extra = {}) => ({ name, sub, key: newKey(), stream: null, attack: null, defense: null, wave: null, block: null, rematch: false, ...extra });
function joinMatchmaking(who, country) {
  const existing = Array.from(matchTickets.values()).find((ticket) => ticket.sub === who.sub && ticket.status === 'waiting');
  if (existing) return existing;
  const ticket = { id: crypto.randomBytes(12).toString('hex'), key: newKey(), sub: who.sub, player: { ...who, country: cleanCountry(country) }, status: 'waiting' };
  const opponentIndex = matchQueue.findIndex((waiting) => waiting.status === 'waiting' && waiting.sub !== who.sub);
  if (opponentIndex >= 0) {
    const opponent = matchQueue.splice(opponentIndex, 1)[0];
    const code = newRoomCode();
    const room = makeRoom(opponent.player, false);
    room.players.push(blankPlayer(ticket.player.name, ticket.player.sub, { country: ticket.player.country }));
    setRoomPlayerMaxHealth(room, 1);
    room.startedAt = Date.now();
    room.matchmaking = true;
    rooms.set(code, room);
    opponent.status = 'matched'; opponent.room = code; opponent.pid = 0; opponent.playerKey = room.players[0].key;
    ticket.status = 'matched'; ticket.room = code; ticket.pid = 1; ticket.playerKey = room.players[1].key;
  } else matchQueue.push(ticket);
  matchTickets.set(ticket.id, ticket);
  return ticket;
}
function matchmakingState(ticket) {
  return ticket.status === 'matched' ? {
    status: 'matched', room: ticket.room, pid: ticket.pid, key: ticket.playerKey,
  } : { status: ticket.status };
}
function resetState(room) {
  room.maxShipHp = [0, 1].map((index) => maxShipHealthForPlayer(room.players[index]));
  room.hp = room.maxShipHp.map((ship) => ({ ship, shark: 50 }));
  room.cannons = [[25, 25, 25, 25], [25, 25, 25, 25]];
  room.medkitMatch = true;
  room.octopusLane = 1 + Math.floor(Math.random() * 4);
  room.octopusUsed = false;
  room.round = START_ROUND; room.over = false; room.hist = [[], []]; room.startedAt = Date.now();
}
function makeRoom(who, bot, level = 'normal', tutorial = false) {
  const room = { players: [blankPlayer(who.name, who.sub, { country: cleanCountry(who.country) })], bot, level, tutorial: Boolean(bot && tutorial), started: false, timer: null, deadline: 0 };
  if (bot) room.players.push(blankPlayer('Computer', 'bot', { bot: true, country: 'un' }));
  resetState(room);
  return room;
}

const LEAGUE_ROUNDS = ['Cuartos de final', 'Semifinales', 'Final'];
const newRoomCode = () => {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(code));
  return code;
};
function buildLeagueRoom(league, round, matchIndex, players) {
  const [first, second] = players.map((id) => league.players[id]);
  const room = makeRoom(first, false);
  Object.assign(room.players[0], { bot: Boolean(first.bot), botDifficulty: first.botDifficulty });
  setRoomPlayerMaxHealth(room, 0);
  room.players.push(blankPlayer(second.name, second.sub, { country: second.country, bot: Boolean(second.bot), botDifficulty: second.botDifficulty }));
  setRoomPlayerMaxHealth(room, 1);
  room.startedAt = Date.now();
  room.leagueMatch = { code: league.code, round, match: matchIndex };
  room.round = 1 + Math.floor(Math.random() * 37);
  const code = newRoomCode();
  rooms.set(code, room);
  if (room.players.every((player) => player.bot)) {
    room.started = true;
    armTimer(room, Number(process.env.BOT_TURN_MS) || 250);
  }
  return code;
}
function createLeagueMatch(league, round, players) {
  const matchIndex = league.rounds[round].length;
  const code = buildLeagueRoom(league, round, matchIndex, players);
  const label = league.size === 4 ? (round === 0 ? `Semifinal ${matchIndex + 1}` : matchIndex === 0 ? 'Final' : '3er puesto') : LEAGUE_ROUNDS[round];
  league.rounds[round].push({ players, room: code, winner: null, label });
}
function armRegistrationTimer(league) {
  league.registrationTimer = setTimeout(() => fillFourPlayerTournament(league), Math.max(0, league.registrationDeadline - Date.now()));
}
async function restoreLeagues() {
  if (!firestoreRankingStore) return;
  for (const league of await firestoreRankingStore.loadLeagues()) {
    if (league.status === 'complete' || leagues.has(league.code)) continue;
    leagues.set(league.code, league);
    if (league.status === 'registration' && league.registrationDeadline) armRegistrationTimer(league);
    league.rounds.forEach((round, r) => round.forEach((match, m) => { // las partidas en curso se reinician con las mismas claves de jugador
      if (match.winner === null) match.room = buildLeagueRoom(league, r, m, match.players);
    }));
  }
  console.log(`Torneos restaurados: ${leagues.size}`);
}
function startLeague(league) {
  clearTimeout(league.registrationTimer);
  league.registrationDeadline = null;
  const order = league.players.map((_, id) => id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  league.status = 'running';
  league.rounds = league.size === 4 ? [[], []] : [[], [], []];
  for (let i = 0; i < league.size; i += 2) createLeagueMatch(league, 0, order.slice(i, i + 2));
  saveLeague(league);
}
function fillFourPlayerTournament(league) {
  if (league.size !== 4 || league.status !== 'registration') return;
  const bots = [
    { name: 'Lamine', sub: 'tournament-bot-lamine', country: 'es', botDifficulty: 'normal' },
    { name: 'Messi', sub: 'tournament-bot-messi', country: 'ar', botDifficulty: 'easy' },
    { name: 'Ronaldo', sub: RONALDO_SUB, country: 'pt', botDifficulty: 'hard' },
  ];
  while (league.players.length < league.size) {
    const bot = bots[league.players.filter((player) => player.bot).length];
    league.players.push({ ...bot, bot: true, key: newKey() });
  }
  startLeague(league);
}
function addLeaguePlayer(league, who, country) {
  const existing = league.players.find((p) => p.sub === who.sub);
  if (existing) return existing;
  if (league.status !== 'registration' || league.players.length >= league.size) return null;
  const player = { name: cleanName(who.name), sub: who.sub, country: cleanCountry(country), key: newKey() };
  league.players.push(player);
  if (league.players.length === league.size) startLeague(league);
  else saveLeague(league);
  return player;
}
function createLeague(who, country, name, size = 8) {
  let code;
  do { code = crypto.randomBytes(4).toString('hex').toUpperCase(); } while (leagues.has(code));
  const league = { code, size, name: String(name || '').trim().slice(0, 48) || (size === 4 ? 'Torneo de 4 jugadores' : 'Liga de 8 jugadores'), createdBy: cleanName(who.name), status: 'registration', players: [], rounds: [], champion: null, runnerUp: null, third: null, fourth: null };
  leagues.set(code, league);
  const player = addLeaguePlayer(league, who, country);
  if (size === 4 && league.status === 'registration') {
    league.registrationDeadline = Date.now() + (Number(process.env.TOURNAMENT_FILL_MS) || 5 * 60 * 1000);
    armRegistrationTimer(league);
  }
  saveLeague(league);
  return { league, player };
}
function completeLeagueMatch(room, winner) {
  const ref = room.leagueMatch;
  const league = ref && leagues.get(ref.code);
  const match = league?.rounds[ref.round]?.[ref.match];
  if (!match || match.winner !== null) return;
  const winnerIndex = winner === 'draw' ? Math.floor(Math.random() * 2) : winner;
  match.winner = match.players[winnerIndex];
  saveLeague(league);
  const roundMatches = league.rounds[ref.round];
  if (!roundMatches.every((entry) => entry.winner !== null)) return;
  if (league.size === 4 && ref.round === 0) {
    const winners = roundMatches.map((entry) => entry.winner);
    const losers = roundMatches.map((entry) => entry.players.find((player) => player !== entry.winner));
    createLeagueMatch(league, 1, winners);
    createLeagueMatch(league, 1, losers);
    saveLeague(league);
    return;
  }
  if (league.size === 4 && ref.round === 1) {
    league.champion = roundMatches[0].winner;
    league.runnerUp = roundMatches[0].players.find((player) => player !== roundMatches[0].winner);
    league.third = roundMatches[1].winner;
    league.fourth = roundMatches[1].players.find((player) => player !== roundMatches[1].winner);
    league.status = 'complete';
    awardTournamentPoints(league);
    saveLeague(league);
    return;
  }
  if (ref.round === 2) {
    league.champion = match.winner;
    league.status = 'complete';
    awardTournamentPoints(league);
    saveLeague(league);
    return;
  }
  const winners = roundMatches.map((entry) => entry.winner);
  for (let i = 0; i < winners.length; i += 2) createLeagueMatch(league, ref.round + 1, winners.slice(i, i + 2));
  saveLeague(league);
}
function leagueSnapshot(league, playerId) {
  let active = null;
  for (let round = 0; round < league.rounds.length && !active; round++) {
    const match = league.rounds[round].find((entry) => entry.winner === null && entry.players.includes(playerId));
    if (match) active = { match, round };
  }
  const lost = league.rounds.some((round) => round.some((match) => match.players.includes(playerId) && match.winner !== null && match.winner !== playerId));
  let status = active ? 'playing' : league.status === 'registration' ? 'registration' : league.champion === playerId ? 'champion' : league.size === 4 && league.runnerUp === playerId ? 'runnerUp' : league.size === 4 && league.third === playerId ? 'third' : league.size === 4 && league.fourth === playerId ? 'fourth' : lost ? 'eliminated' : 'waiting';
  let match = null;
  if (active) {
    const seat = active.match.players.indexOf(playerId);
    const room = rooms.get(active.match.room);
    match = { room: active.match.room, pid: seat, key: room.players[seat].key, round: active.round, roundName: active.match.label, opponent: league.players[active.match.players[1 - seat]].name };
  }
  return {
    name: league.name, createdBy: league.createdBy, size: league.size, status, registrationDeadline: league.registrationDeadline || null,
    players: league.players.map((p) => p.name), countries: league.players.map((p) => p.country), difficulties: league.players.map((p) => p.botDifficulty || null),
    reward: league.rewards?.[playerId] ?? null,
    champion: league.champion === null ? null : league.players[league.champion].name,
    rounds: league.rounds.map((round, i) => ({ name: league.size === 4 ? (i === 0 ? 'Semifinales' : 'Final y tercer puesto') : LEAGUE_ROUNDS[i], matches: round.map((entry) => ({
      label: entry.label,
      players: entry.players.map((id) => league.players[id].name), winner: entry.winner === null ? null : league.players[entry.winner].name,
    })) })),
    match,
  };
}

// Plan de la máquina según el nivel; el difícil estudia las últimas secuencias del humano
function botPlan(room, k) {
  const wave = randWave();
  const level = room.players[k].botDifficulty || room.level || 'normal';
  if (level === 'easy') return { attack: randSeq(), defense: randSeq(), wave };
  if (level === 'normal') return { attack: workingSeq(room, k), defense: randSeq(), wave };
  const h = room.hist[1 - k].slice(-8);
  const ok = [1, 2, 3, 4].filter((l) => room.cannons[k][l - 1] > 0);
  const pool = ok.length ? ok : [1];
  const pick = (lanes, score, best) => {
    let top = null, tied = [];
    for (const l of lanes) {
      const s = score(l);
      if (top === null || (best === 'max' ? s > top : s < top)) { top = s; tied = [l]; } else if (s === top) tied.push(l);
    }
    return tied[Math.floor(Math.random() * tied.length)];
  };
  const attack = [], defense = [];
  for (let i = 0; i < 4; i++) {
    const atkF = [0, 0, 0, 0, 0], defF = [0, 0, 0, 0, 0];
    for (const s of h) { atkF[s.attack[i]]++; defF[s.defense[i]]++; }
    defense.push(pick([1, 2, 3, 4], (l) => atkF[l], 'max')); // pongo el tiburón donde más suele disparar
    attack.push(pick(pool, (l) => defF[l] * 2 + atkF[l], 'min')); // disparo donde menos suele defender o disparar
  }
  return { attack, defense, wave };
}

function armTimer(room, delay) {
  clearTimeout(room.timer);
  if (room.tutorial) { room.timer = null; room.deadline = 0; return; }
  const botDelay = room.players.every((player) => player.bot) ? (Number(process.env.BOT_TURN_MS) || 250) : delay;
  room.players.forEach((player, index) => {
    if (player.bot && !player.attack) Object.assign(player, botPlan(room, index));
    if (room.round % 10 === 0 && player.bot && !player.block) player.block = randSeq();
  });
  room.deadline = Date.now() + botDelay;
  room.timer = setTimeout(() => {
    if (room.over) return;
    room.players.forEach((p, k) => {
      if (!p.attack) Object.assign(p, p.bot ? botPlan(room, k) : { attack: workingSeq(room, k), defense: randSeq(), wave: randWave(), block: room.round % 10 === 0 ? randSeq() : null });
      if (room.round % 10 === 0 && !p.block) p.block = randSeq();
    });
    runRound(room);
  }, botDelay);
}

const stateFor = (room, k) => ({
  ...info(room), submitted: !!room.players[k].attack, heli: !!room.players[k].heli, troops: !!room.players[k].troops, dome: !!room.players[k].dome, food: !!room.players[k].food, sword: !!room.players[k].sword, infernalSent: !!room.players[k].infernal, dragonSent: !!room.players[k].dragon,
  inputMs: room.tutorial ? null : Math.max(1000, Math.min(INPUT_MS, room.deadline - Date.now())),
});

function finishMatch(room, winner) {
  room.over = true;
  clearTimeout(room.timer);
  recordGame(room, winner);
  if (room.leagueMatch) completeLeagueMatch(room, winner);
  if (winner === 'draw') return;
  const won = room.players[winner];
  if (room.bot) { if (!won.bot) recordBotWin(won); }
  else if (!won.bot && !room.players[1 - winner].bot) recordResult(won, room.players[1 - winner]);
  else if (won.sub === RONALDO_SUB && room.leagueMatch) {
    const entry = (ranking[RONALDO_SUB] ||= { name: won.name, streak: 0, points: 0, wins: 0, level: 1 });
    entry.points = (entry.points || 0) + 1; entry.wins = (entry.wins || 0) + 1; entry.level = Math.floor(entry.points / 100) + 1;
    persistRanking([RONALDO_SUB]);
  }
  else if (!won.bot && room.leagueMatch) recordBotWin(won); // ganar a un bot de torneo también suma puntos
}

function runRound(room) {
  const result = resolveRound(room);
  if (result.winner !== null) finishMatch(room, result.winner);
  else armTimer(room, result.events.length * SHOT_MS + INPUT_MS);
  const update = { ...result, ...info(room) };
  room.lastRound = update;
  broadcast(room, 'round', update);
}

// Retirarse: el rival gana al instante
function resign(room, pid) {
  const update = { events: [], seqs: [], winner: 1 - pid, resigned: pid, ...info(room) };
  finishMatch(room, 1 - pid);
  update.over = true;
  room.lastRound = update;
  broadcast(room, 'round', update);
}

function body(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function formBody(req) {
  return new Promise((resolve) => {
    let value = '';
    req.on('data', (chunk) => { value += chunk; if (value.length > 4096) req.destroy(); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(value))));
  });
}
function cookie(req, name) {
  const entry = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : '';
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const EMOTES = ['¡Buen tiro!', '¡Cuidado!', 'Gracias', '¡GG!', '¡Vamos!', 'Uy...'];
const hits = new Map(); // límite de peticiones POST por IP

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (url.pathname.startsWith('/api/')) {
    const origin = req.headers.origin;
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const sameOrigin = `${forwardedProto || 'http'}://${req.headers.host}`;
    if (origin && origin !== sameOrigin && !allowedOrigins.has(origin)) return json(res, 403, { error: 'Origen no autorizado' });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  if (req.method === 'POST') {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress, now = Date.now(); // tras el proxy de Render la IP real va en x-forwarded-for
    if (hits.size > 5000) for (const [key, value] of hits) if (now - value.t > 60000) hits.delete(key);
    const h = hits.get(ip);
    if (!h || now - h.t > 60000) hits.set(ip, { t: now, n: 1 });
    else if (++h.n > (Number(process.env.RATE_LIMIT) || 240)) return json(res, 429, { error: 'Demasiadas peticiones, espera un momento' });
  }
  if (req.method === 'POST' && url.pathname === '/api/matchmaking/join') {
    const b = await body(req);
    const who = identify(b);
    if (!who) return json(res, 401, { error: 'Inicia sesión con Google' });
    const ticket = joinMatchmaking(who, b.country);
    return json(res, 200, { ticket: ticket.id, ticketKey: ticket.key, ...matchmakingState(ticket) });
  }
  if (req.method === 'GET' && url.pathname === '/api/matchmaking/status') {
    const ticket = matchTickets.get(url.searchParams.get('ticket'));
    if (!ticket || ticket.key !== url.searchParams.get('key')) return json(res, 404, { error: 'Búsqueda de partida no encontrada' });
    return json(res, 200, matchmakingState(ticket));
  }
  if (req.method === 'POST' && url.pathname === '/api/matchmaking/cancel') {
    const b = await body(req);
    const ticket = matchTickets.get(b.ticket);
    if (!ticket || ticket.key !== b.key) return json(res, 404, { error: 'Búsqueda de partida no encontrada' });
    if (ticket.status !== 'waiting') return json(res, 409, { error: 'La partida ya encontró rival' });
    ticket.status = 'cancelled';
    const index = matchQueue.indexOf(ticket);
    if (index >= 0) matchQueue.splice(index, 1);
    matchTickets.delete(ticket.id);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/create') {
    const b = await body(req);
    const who = identify(b);
    if (!who) return json(res, 401, { error: 'Inicia sesión con Google' });
    if (b.mode === 'league' || b.mode === 'tournament4') {
      const size = b.mode === 'tournament4' ? 4 : 8;
      const { league, player } = createLeague(who, b.country, b.leagueName, size);
      return json(res, 200, { league: league.code, leaguePid: league.players.indexOf(player), leagueKey: player.key, token: encryptCode(`league:${league.code}`) });
    }
    const bot = b.mode === 'bot';
    const code = newRoomCode();
    const room = makeRoom({ ...who, country: b.country }, bot, ['easy', 'normal', 'hard'].includes(b.level) ? b.level : 'normal', b.tutorial === true);
    rooms.set(code, room);
    return json(res, 200, { room: code, pid: 0, key: room.players[0].key, token: bot ? null : encryptCode(code) });
  }
  if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { clientId: CLIENT_ID, apiBaseUrl: API_BASE_URL, publicUrl: EXPLICIT_URL || lanUrl(), explicit: !!EXPLICIT_URL });
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && url.pathname === '/auth/google/callback') {
    const form = await formBody(req);
    if (!form.g_csrf_token || form.g_csrf_token !== cookie(req, 'g_csrf_token')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('Solicitud de inicio de sesión no válida');
    }
    const user = CLIENT_ID && await verifyGoogle(form.credential).catch(() => null);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('No se pudo verificar la cuenta de Google');
    }
    const nonce = crypto.randomBytes(18).toString('base64');
    const token = JSON.stringify(makeSession(user));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'`,
    });
    return res.end(`<!doctype html><html lang="es"><meta charset="utf-8"><title>Acceso correcto</title><script nonce="${nonce}">localStorage.setItem('session',${token});location.replace('/');</script></html>`);
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const { credential } = await body(req);
    const user = CLIENT_ID && await verifyGoogle(credential).catch(() => null);
    if (!user) return json(res, 401, { error: 'Login de Google no válido' });
    return json(res, 200, { session: makeSession(user), name: user.name, picture: user.picture });
  }
  if (req.method === 'POST' && url.pathname === '/api/session') {
    const user = readSession((await body(req)).session);
    return user ? json(res, 200, user) : json(res, 401, { error: 'Sesión caducada' });
  }
  if (req.method === 'POST' && url.pathname === '/api/profile') {
    const user = identify(await body(req));
    if (!user) return json(res, 401, { error: 'Inicia sesión con Google' });
    const entry = ranking[user.sub] || {};
    return json(res, 200, profileView(entry));
  }
  if (req.method === 'POST' && url.pathname === '/api/skin') {
    const user = identify(await body(req));
    if (!user) return json(res, 401, { error: 'Inicia sesión con Google' });
    const entry = ranking[user.sub];
    if (!entry?.viking) return json(res, 403, { error: 'Compra el barco vikingo en la tienda' });
    entry.vikingTier = activeSkin(entry) ? null : skinTier(entry.level);
    persistRanking([user.sub]);
    return json(res, 200, profileView(entry));
  }
  if (req.method === 'POST' && url.pathname === '/api/shop/buy') {
    const b = await body(req);
    const user = identify(b);
    if (!user) return json(res, 401, { error: 'Inicia sesión con Google' });
    const item = SHOP[b.item];
    if (!Object.hasOwn(SHOP, String(b.item))) return json(res, 400, { error: 'Artículo no válido' });
    const entry = ranking[user.sub];
    if (entry?.[b.item]) return json(res, 409, { error: `Ya tienes el ${item.name.toLowerCase()}` });
    if (!entry || (Number(entry.coins) || 0) < item.price) return json(res, 402, { error: `Necesitas ${item.price} monedas` });
    entry.coins = Number(entry.coins) - item.price;
    entry[b.item] = true;
    if (b.item === 'viking') entry.vikingTier = skinTier(entry.level); // recién comprado se equipa
    persistRanking([user.sub]);
    return json(res, 200, profileView(entry));
  }
  if (req.method === 'GET' && url.pathname === '/api/ranking') return json(res, 200, topRanking(url.searchParams.get('period')));
  if (req.method === 'GET' && url.pathname === '/api/games') return json(res, 200, games);
  if (req.method === 'GET' && url.pathname === '/api/league/state') {
    const league = leagues.get(url.searchParams.get('code'));
    const playerId = Number(url.searchParams.get('pid'));
    const player = league?.players.find((p) => p.key === url.searchParams.get('key')) || league?.players[playerId];
    if (!player || player.key !== url.searchParams.get('key')) return json(res, 404, { error: 'Liga no encontrada' });
    if (league.status === 'registration' && league.registrationDeadline && Date.now() >= league.registrationDeadline) fillFourPlayerTournament(league); // respaldo si el temporizador no llegó a ejecutarse
    return json(res, 200, leagueSnapshot(league, league.players.indexOf(player)));
  }
  if (req.method === 'POST' && url.pathname === '/api/league/leave') {
    const b = await body(req);
    const league = leagues.get(b.code);
    const index = league ? league.players.findIndex((p) => p.key === b.key) : -1;
    if (index < 0) return json(res, 404, { error: 'Torneo no encontrado' });
    if (league.status !== 'registration') return json(res, 409, { error: 'El torneo ya ha empezado' });
    league.players.splice(index, 1);
    if (!league.players.length) {
      clearTimeout(league.registrationTimer);
      league.status = 'complete';
      saveLeague(league);
      leagues.delete(league.code);
    } else saveLeague(league);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/leagues') {
    const active = Array.from(leagues.values()).filter((league) => league.status === 'running' && league.rounds.some((round) => round.some((match) => rooms.get(match.room)?.started))).map((league) => ({
      code: league.code,
      name: league.name,
      createdBy: league.createdBy,
      size: league.size,
      players: league.players.map((p) => p.name),
      rounds: league.rounds.map((round, i) => ({ name: league.size === 4 ? (i === 0 ? 'Semifinales' : 'Final y tercer puesto') : LEAGUE_ROUNDS[i], matches: round.map((match) => ({
        players: match.players.map((id) => league.players[id].name), winner: match.winner === null ? null : league.players[match.winner].name,
      })) })),
      matches: league.rounds.flatMap((round, i) => round.flatMap((match) => {
        const game = rooms.get(match.room);
        return match.winner === null && game?.started ? [{
          room: match.room, roundName: match.label, players: match.players.map((id) => league.players[id].name),
          spectators: game.spectators?.size || 0,
        }] : [];
      })),
    }));
    return json(res, 200, active);
  }
  if (req.method === 'GET' && url.pathname === '/api/qr') {
    const invite = url.searchParams.get('url') || '';
    let target;
    try { target = new URL(invite); } catch { return json(res, 400, { error: 'Invitación inválida' }); }
    if (invite.length > 2048 || !['http:', 'https:'].includes(target.protocol) || !target.searchParams.has('j')) {
      return json(res, 400, { error: 'Invitación inválida' });
    }
    try {
      const svg = await QRCode.toString(target.href, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 220 });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(svg);
    } catch { return json(res, 400, { error: 'El enlace de invitación es demasiado largo' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/join') {
    const b = await body(req);
    const who = identify(b);
    if (!who) return json(res, 401, { error: 'Inicia sesión con Google' });
    const code = decryptCode(b.token);
    if (code?.startsWith('league:')) {
      const league = leagues.get(code.slice(7));
      if (!league) return json(res, 404, { error: 'Liga inexistente' });
      const player = addLeaguePlayer(league, who, b.country);
      if (!player) return json(res, 409, { error: 'El torneo ya está completo' });
      return json(res, 200, { league: league.code, leaguePid: league.players.indexOf(player), leagueKey: player.key, token: b.token });
    }
    const room = code && rooms.get(code);
    if (!room || room.bot) return json(res, 404, { error: 'Invitación no válida o partida inexistente' });
    if (room.over) return json(res, 409, { error: 'La partida ya terminó' });
    if (room.players.length >= 2) return json(res, 409, { error: 'La partida ya tiene dos jugadores' });
    room.startedAt = Date.now();
    const guest = blankPlayer(who.name, who.sub, { country: cleanCountry(b.country) });
    room.players.push(guest);
    setRoomPlayerMaxHealth(room, 1);
    return json(res, 200, { room: String(code), pid: 1, key: guest.key });
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const room = rooms.get(url.searchParams.get('room'));
    const pid = Number(url.searchParams.get('pid'));
    if (!room || !room.players[pid] || room.players[pid].key !== url.searchParams.get('key')) return json(res, 404, { error: 'Sala no encontrada' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    room.players[pid].stream = res;
    res.on('close', () => {
      if (room.players[pid].stream !== res) return;
      room.players[pid].stream = null;
      broadcast(room, 'left', {});
      setTimeout(() => { if (room.players.every((p) => !p.stream)) rooms.delete(url.searchParams.get('room')); }, 600000);
    });
    send(res, 'hello', { pid });
    if (room.players.length === 2) {
      if (!room.timer) armTimer(room, INPUT_MS);
      if (!room.started && room.players.every((p) => p.stream || p.bot)) {
        room.started = true;
        room.players.forEach((p, k) => p.stream && send(p.stream, 'state', stateFor(room, k)));
      } else if (room.started) send(res, 'state', stateFor(room, pid)); // reconexión: solo para quien vuelve
      else send(res, 'waiting', {});
    } else send(res, 'waiting', {});
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/spectate') {
    const room = rooms.get(url.searchParams.get('room'));
    if (!room?.leagueMatch || !room.started || room.over) return json(res, 404, { error: 'Partida no disponible para espectadores' });
    const spectators = room.spectators ||= new Set();
    if (spectators.size >= 2) return json(res, 429, { error: 'Máximo de 2 espectadores por partida' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    spectators.add(res);
    res.on('close', () => spectators.delete(res));
    send(res, 'hello', { spectator: true });
    send(res, 'state', { ...info(room), started: room.started, spectator: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/room') {
    const room = rooms.get(url.searchParams.get('room'));
    const p = room?.players[Number(url.searchParams.get('pid'))];
    return p && p.key === url.searchParams.get('key') ? json(res, 200, { ok: true, over: room.over }) : json(res, 404, { error: 'Sala no encontrada' });
  }
  if (req.method === 'POST' && url.pathname === '/api/rematch') {
    const { room: code, pid, key } = await body(req);
    const room = rooms.get(String(code));
    const me = room?.players[pid];
    if (!me || me.key !== key || !room.over) return json(res, 400, { error: 'Inválido' });
    me.rematch = true;
    if (room.players.every((p) => p.rematch || p.bot)) {
      resetState(room);
      room.players.forEach((p) => { p.rematch = false; p.attack = null; p.defense = null; p.wave = null; p.block = null; p.heli = false; p.troops = false; p.dome = false; p.food = false; p.sword = false; p.infernal = false; p.dragon = false; p.submittedAt = null; });
      room.troopsCd = [0, 0]; room.domeCd = [0, 0]; room.foodCd = [0, 0]; room.swordCd = [0, 0]; room.infernoCd = [0, 0]; room.fireCd = [0, 0]; room.fireOn = [false, false]; room.dragonCd = [0, 0];
      armTimer(room, INPUT_MS);
      broadcast(room, 'rematch', {});
      room.players.forEach((p, k) => p.stream && send(p.stream, 'state', stateFor(room, k)));
    } else broadcast(room, 'rematchWait', { pid });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/resign') {
    const { room: code, pid, key } = await body(req);
    const room = rooms.get(String(code));
    const me = room?.players[pid];
    if (!me || me.key !== key || room.players.length < 2 || room.over || room.tutorial || !room.started) return json(res, 400, { error: 'Inválido' });
    resign(room, pid);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/emote') {
    const { room: code, pid, key, i } = await body(req);
    const room = rooms.get(String(code));
    const me = room?.players[pid];
    if (!me || me.key !== key || !EMOTES[i]) return json(res, 400, { error: 'Inválido' });
    broadcast(room, 'emote', { pid, text: EMOTES[i] });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/heli') {
    const { room: code, pid, key } = await body(req);
    const room = rooms.get(String(code));
    const me = room?.players[pid];
    if (!me || me.key !== key || room.players.length < 2 || room.over) return json(res, 400, { error: 'Inválido' });
    const hp = room.hp[pid].ship;
    if (hp <= 0 || hp > 5) return json(res, 409, { error: 'El helicóptero solo acude con 5 de vida o menos' });
    me.heli = true;
    broadcast(room, 'heli', { pid });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/troops') {
    const { room: code, pid, key } = await body(req);
    const room = rooms.get(String(code));
    const me = room?.players[pid];
    if (!me || me.key !== key || room.players.length < 2 || room.over || room.tutorial) return json(res, 400, { error: 'Inválido' });
    if ((room.troopsCd?.[pid] || 0) > 0) return json(res, 409, { error: 'Las tropas aún no están listas' });
    me.troops = true;
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/dome') {
    const { room: code, pid, key } = await body(req);
    const room = rooms.get(String(code));
    const me = room?.players[pid];
    if (!me || me.key !== key || room.players.length < 2 || room.over || room.tutorial) return json(res, 400, { error: 'Inválido' });
    if ((room.domeCd?.[pid] || 0) > 0) return json(res, 409, { error: 'La cúpula aún no está lista' });
    me.dome = true;
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/sword') {
    const { room: code, pid, key } = await body(req);
    const room = rooms.get(String(code));
    const me = room?.players[pid];
    if (!me || me.key !== key || room.players.length < 2 || room.over || room.tutorial) return json(res, 400, { error: 'Inválido' });
    if (me.bot || !ranking[me.sub]?.swordfish) return json(res, 403, { error: 'Compra el pez espada en la tienda' });
    if ((room.swordCd?.[pid] || 0) > 0) return json(res, 409, { error: 'El pez espada aún no está listo' });
    if (room.hp[1 - pid].shark <= 0) return json(res, 409, { error: 'La ballena rival ya no está viva' });
    me.sword = true;
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/infernal') {
    const { room: code, pid, key } = await body(req);
    const room = rooms.get(String(code));
    const me = room?.players[pid];
    if (!me || me.key !== key || room.players.length < 2 || room.over || room.tutorial) return json(res, 400, { error: 'Inválido' });
    if (me.bot || !ranking[me.sub]?.infernal) return json(res, 403, { error: 'Compra el ataque infernal en la tienda' });
    if ((room.infernoCd?.[pid] || 0) > 0) return json(res, 409, { error: 'El ataque infernal aún no está listo' });
    me.infernal = true;
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/dragon') {
    const { room: code, pid, key } = await body(req);
    const room = rooms.get(String(code));
    const me = room?.players[pid];
    if (!me || me.key !== key || room.players.length < 2 || room.over || room.tutorial) return json(res, 400, { error: 'Inválido' });
    const d = dragonsOf(me);
    if (!d.fire && !d.storm) return json(res, 403, { error: 'Compra un dragón en la tienda' });
    if ((room.dragonCd?.[pid] || 0) > 0) return json(res, 409, { error: 'Tus dragones aún están descansando' });
    me.dragon = true;
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/fire') {
    const { room: code, pid, key } = await body(req);
    const room = rooms.get(String(code));
    const me = room?.players[pid];
    if (!me || me.key !== key || room.players.length < 2 || room.over || room.tutorial) return json(res, 400, { error: 'Inválido' });
    if (me.bot || !ranking[me.sub]?.fireballs) return json(res, 403, { error: 'Compra las balas de fuego en la tienda' });
    room.fireOn ||= [false, false]; room.fireCd ||= [0, 0];
    if (room.fireOn[pid]) room.fireOn[pid] = false; // apagarlas se puede siempre
    else {
      if (room.fireCd[pid] > 0) return json(res, 409, { error: `Las balas de fuego estarán listas en ${room.fireCd[pid]} ronda${room.fireCd[pid] === 1 ? '' : 's'}` });
      room.fireOn[pid] = true; room.fireCd[pid] = FIRE_COOLDOWN;
    }
    return json(res, 200, { ok: true, fireOn: room.fireOn[pid], fireCd: room.fireCd[pid] });
  }
  if (req.method === 'POST' && url.pathname === '/api/food') {
    const { room: code, pid, key } = await body(req);
    const room = rooms.get(String(code));
    const me = room?.players[pid];
    if (!me || me.key !== key || room.players.length < 2 || room.over || room.tutorial) return json(res, 400, { error: 'Inválido' });
    if (room.hp[pid].shark <= 0) return json(res, 409, { error: 'Tu ballena ya no está viva' });
    if ((room.foodCd?.[pid] || 0) > 0) return json(res, 409, { error: 'La comida aún no está lista' });
    me.food = true;
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/submit') {
    const { room: code, pid, key, attack, defense, wave, block } = await body(req);
    const room = rooms.get(String(code));
    const me = room?.players[pid];
    if (!me || me.key !== key || room.players.length < 2 || room.over) return json(res, 400, { error: 'Inválido' });
    if (!valid(attack) || !valid(defense)) return json(res, 400, { error: 'Secuencia inválida' });
    if (room.round % 6 === 0 && !validWave(wave)) return json(res, 400, { error: 'Oleaje inválido' });
    if (room.round % 10 === 0 && !valid(block)) return json(res, 400, { error: 'Secuencia de bloqueo inválida' });
    if (me.attack) return json(res, 409, { error: 'Ya enviaste' });
    me.submittedAt = Date.now();
    me.attack = attack; me.defense = defense; me.wave = wave; me.block = room.round % 10 === 0 ? block : null;
    const bot = room.players.find((p) => p.bot);
    if (bot) Object.assign(bot, { ...botPlan(room, room.players.indexOf(bot)), block: room.round % 10 === 0 ? randSeq() : null });
    if (room.tutorial && bot) room.tutorial = false;
    if (room.players.every((p) => p.attack)) {
      runRound(room);
    } else {
      broadcast(room, 'ready', { pid });
    }
    return json(res, 200, { ok: true });
  }
  // estáticos
  const file = path.join(DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  initializeRankingStore()
    .then(() => restoreLeagues().catch((error) => console.error('No se pudieron restaurar los torneos:', error.message)))
    .then(() => server.listen(PORT, '0.0.0.0', () => console.log(`Servidor en http://localhost:${PORT} · invitaciones: ${EXPLICIT_URL || lanUrl()}`)))
    .catch((error) => {
      console.error('No se pudo inicializar el almacenamiento del ranking:', error);
      process.exitCode = 1;
    });
}

export { resolveRound, makeRoom, botPlan, workingSeq, shipMaxHpForLevel };
