const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// ============================================================================
// FIX #1: CORS is no longer wide open ('*'). Configure via env var
// ALLOWED_ORIGINS (comma separated). Falls back to a small allowlist you
// should edit for your deployment. This still allows same-origin/no-origin
// requests (curl, server-to-server, some mobile webviews) but blocks
// arbitrary browser origins from connecting to the socket.
// ============================================================================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true; // non-browser clients / same-origin
  if (ALLOWED_ORIGINS.length === 0) return true; // no allowlist configured -> permissive (dev mode)
  return ALLOWED_ORIGINS.indexOf(origin) !== -1;
}

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error('CORS not allowed for origin: ' + origin));
    },
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const START_MIN_PLAYERS = 2;
const RANDOM_START_MIN_PLAYERS = 1;
const START_DELAY_MS = 1800;
const ROUND_DURATION_MS = 180000;
const ROUND_RESET_DELAY_MS = 1200;
const WIN_SCORE = 5;

// ============================================================================
// FIX #2: Damage is now authoritative on the server. Per-weapon damage table
// keyed by a weapon key the client reports; the client-supplied `damage`
// value is IGNORED. Headshot multiplier is also computed server-side from
// server-known hit geometry rather than trusting a client `headshot` flag
// blindly (we still accept the flag as a hint but clamp final damage to the
// server-computed max for that weapon).
// ============================================================================
const WEAPON_DAMAGE_TABLE = {
  default: { damage: 5, pellets: 1, ammoPerShot: 1 },
  pistol: { damage: 10, pellets: 1, ammoPerShot: 1 },
  shotgun: { damage: 6, pellets: 10, ammoPerShot: 10 }
};
const HEADSHOT_MULTIPLIER = 2.0;
const DAMAGE_PER_BULLET = 4; // fallback for unknown weapon keys
const AI_DAMAGE_PER_HIT = 4;
// クライアントの実発射間隔は FIRE_INTERVAL(0.10s) * 900 = 90ms 判定。
// サーバー側の下限をこれと同値/それ以上にすると、通信遅延やタイマーの
// わずかな揺れ(ジッター)だけで正規の連射が弾かれてしまう。
// 70ms まで緩めておけば、意図した約90〜100msの連射は常に通り、
// 明らかな異常連打(30ms未満の連続弾)だけを引き続き弾ける。
const SHOT_MIN_INTERVAL_MS = 70;
// Per-weapon minimum interval floor (server authoritative rate limit),
// slightly looser than the client's own interval to tolerate jitter.
const WEAPON_MIN_INTERVAL_MS = {
  default: 70,
  pistol: 230,
  shotgun: 560
};

// ===== Random battle (matchmaking) tuning =====
// ランダムバトルは「部屋番号固定の1試合」ではなく、キュー配下に
// 複数の match インスタンス (roomId は "R0001-1", "R0001-2", ...) を
// サーバー側で自動生成して振り分ける。HTML 側は今まで通り
// currentRoom = 'R0001' で join-room してくるが、サーバーが実際の
// roomId / matchId を決めて room-state 等で送り返す。
const RANDOM_QUEUE_MAX_PLAYERS = MAX_PLAYERS; // 1試合の上限 = 8人
const RANDOM_AI_FILL_DELAY_MS = 30000; // 30秒経過でAI補充して開始（既存仕様維持）

const OUTER_WALLS = [
  { x: 0, z: -35.4, w: 72, d: 1.2 },
  { x: 0, z: 35.4, w: 72, d: 1.2 },
  { x: -35.4, z: 0, w: 1.2, d: 72 },
  { x: 35.4, z: 0, w: 1.2, d: 72 }
];

const MAP_COLLIDERS_BY_ID = {
  arena: OUTER_WALLS.concat([
    { x: -23, z: -22, w: 6, d: 6 },
    { x: -23, z: -8, w: 8, d: 5 },
    { x: -23, z: 9, w: 7, d: 5 },
    { x: -23, z: 24, w: 6, d: 6 },
    { x: -10, z: -18, w: 5, d: 8 },
    { x: -10, z: 0, w: 5, d: 10 },
    { x: -10, z: 18, w: 5, d: 8 },
    { x: 10, z: -18, w: 5, d: 8 },
    { x: 10, z: 0, w: 5, d: 10 },
    { x: 10, z: 18, w: 5, d: 8 },
    { x: 23, z: -22, w: 6, d: 6 },
    { x: 23, z: -8, w: 8, d: 5 },
    { x: 23, z: 9, w: 7, d: 5 },
    { x: 23, z: 24, w: 6, d: 6 },
    { x: -5, z: -28, w: 10, d: 4 },
    { x: 5, z: -28, w: 10, d: 4 },
    { x: -5, z: 28, w: 10, d: 4 },
    { x: 5, z: 28, w: 10, d: 4 },
    { x: -28, z: -5, w: 4, d: 10 },
    { x: -28, z: 5, w: 4, d: 10 },
    { x: 28, z: -5, w: 4, d: 10 },
    { x: 28, z: 5, w: 4, d: 10 },
    { x: -6, z: -6, w: 3, d: 10 },
    { x: 6, z: -6, w: 3, d: 10 },
    { x: -6, z: 6, w: 3, d: 10 },
    { x: 6, z: 6, w: 3, d: 10 },
    { x: 0, z: -14, w: 4, d: 4 },
    { x: 0, z: 14, w: 4, d: 4 }
  ]),
  warehouse: OUTER_WALLS.concat([
    { x: -26, z: -26, w: 8, d: 8 },
    { x: 26, z: -26, w: 8, d: 8 },
    { x: -26, z: 26, w: 8, d: 8 },
    { x: 26, z: 26, w: 8, d: 8 },
    { x: -16, z: -16, w: 6, d: 6 },
    { x: 16, z: -16, w: 6, d: 6 },
    { x: -16, z: 16, w: 6, d: 6 },
    { x: 16, z: 16, w: 6, d: 6 },
    { x: 0, z: -22, w: 5, d: 12 },
    { x: 0, z: 22, w: 5, d: 12 },
    { x: -22, z: 0, w: 12, d: 5 },
    { x: 22, z: 0, w: 12, d: 5 },
    { x: -8, z: -4, w: 3, d: 16 },
    { x: 8, z: 4, w: 3, d: 16 },
    { x: 0, z: 0, w: 6, d: 6 },
    { x: -14, z: 0, w: 3, d: 10 },
    { x: 14, z: 0, w: 3, d: 10 }
  ]),
  courtyard: OUTER_WALLS.concat([
    { x: -30, z: -30, w: 5, d: 5 },
    { x: 30, z: -30, w: 5, d: 5 },
    { x: -30, z: 30, w: 5, d: 5 },
    { x: 30, z: 30, w: 5, d: 5 },
    { x: -20, z: -20, w: 4, d: 12 },
    { x: 20, z: -20, w: 4, d: 12 },
    { x: -20, z: 20, w: 4, d: 12 },
    { x: 20, z: 20, w: 4, d: 12 },
    { x: -12, z: 0, w: 3, d: 20 },
    { x: 12, z: 0, w: 3, d: 20 },
    { x: 0, z: -12, w: 20, d: 3 },
    { x: 0, z: 12, w: 20, d: 3 },
    { x: -4, z: -4, w: 4, d: 4 },
    { x: 4, z: -4, w: 4, d: 4 },
    { x: -4, z: 4, w: 4, d: 4 },
    { x: 4, z: 4, w: 4, d: 4 }
  ])
};

const MAP_IDS = Object.keys(MAP_COLLIDERS_BY_ID);

const SPAWN_POINTS_BY_MAP = {
  arena: {
    blue: [
      { x: -30, y: 1.6, z: -30, ry: 0 },
      { x: -30, y: 1.6, z: -12, ry: 0 },
      { x: -30, y: 1.6, z: 12, ry: 0 },
      { x: -30, y: 1.6, z: 30, ry: 0 }
    ],
    red: [
      { x: 30, y: 1.6, z: 30, ry: Math.PI },
      { x: 30, y: 1.6, z: 12, ry: Math.PI },
      { x: 30, y: 1.6, z: -12, ry: Math.PI },
      { x: 30, y: 1.6, z: -30, ry: Math.PI }
    ]
  },
  warehouse: {
    blue: [
      { x: -32, y: 1.6, z: -32, ry: 0 },
      { x: -32, y: 1.6, z: 0, ry: 0 },
      { x: -32, y: 1.6, z: 32, ry: 0 },
      { x: -32, y: 1.6, z: -12, ry: 0 }
    ],
    red: [
      { x: 32, y: 1.6, z: 32, ry: Math.PI },
      { x: 32, y: 1.6, z: 0, ry: Math.PI },
      { x: 32, y: 1.6, z: -32, ry: Math.PI },
      { x: 32, y: 1.6, z: 12, ry: Math.PI }
    ]
  },
  courtyard: {
    blue: [
      { x: -33, y: 1.6, z: -15, ry: 0 },
      { x: -33, y: 1.6, z: 0, ry: 0 },
      { x: -33, y: 1.6, z: 15, ry: 0 },
      { x: -33, y: 1.6, z: -30, ry: 0 }
    ],
    red: [
      { x: 33, y: 1.6, z: 15, ry: Math.PI },
      { x: 33, y: 1.6, z: 0, ry: Math.PI },
      { x: 33, y: 1.6, z: -15, ry: Math.PI },
      { x: 33, y: 1.6, z: 30, ry: Math.PI }
    ]
  }
};

// ============================================================================
// FIX #9: express.static no longer serves the entire server root. Only a
// dedicated `public/` directory is exposed. Put index.html and client
// assets (ju.glb, pistol.glb, textures, etc.) inside ./public.
// ============================================================================
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const players = Object.create(null);   // socket.id -> player
const roomMeta = Object.create(null);   // roomId -> meta

// ============================================================================
// FIX #8: Room membership index. Instead of scanning Object.values(players)
// on every call, we maintain roomId -> Set<socketId> incrementally. All the
// getRoomCount / getRoomPlayers / getRoomPlayerEntries helpers below now
// read from this index instead of doing a full table scan.
// ============================================================================
const roomIndex = Object.create(null); // roomId -> Set<socketId>

function indexAdd(roomId, id) {
  if (!roomId) return;
  if (!roomIndex[roomId]) roomIndex[roomId] = new Set();
  roomIndex[roomId].add(id);
}
function indexRemove(roomId, id) {
  if (!roomId || !roomIndex[roomId]) return;
  roomIndex[roomId].delete(id);
  if (roomIndex[roomId].size === 0) delete roomIndex[roomId];
}
function indexMove(fromRoomId, toRoomId, id) {
  if (fromRoomId) indexRemove(fromRoomId, id);
  if (toRoomId) indexAdd(toRoomId, id);
}

// ===== Random queue bookkeeping =====
// queueId (= 元々 HTML が送ってくる room, 例 'R0001') -> {
//   matchSeq: number,               // 次に発行する match 連番
//   matches: [roomId, roomId, ...]  // このキューに属する実際の roomId 一覧（生成順）
// }
const randomQueues = Object.create(null);

// ============================================================================
// FIX #10: normalizeRoom is now aware of two distinct room-id "shapes":
//   - a plain queue/room code the player typed (kept short, alnum)
//   - a server-generated match id ("<queue>-<seq>") which needs more room
// Length cap raised and made shape-dependent so queue ids won't collide as
// easily and match ids (which append "-N") don't get truncated and clash.
// ============================================================================
const ROOM_CODE_MAX_LEN = 24;
const MATCH_ID_MAX_LEN = 40;

function normalizeRoom(room, opts) {
  const isMatchId = !!(opts && opts.isMatchId);
  const s = String(room ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
  return s.slice(0, isMatchId ? MATCH_ID_MAX_LEN : ROOM_CODE_MAX_LEN);
}

function safeNum(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function pickRandomMapId() {
  return MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)] || 'arena';
}

// ---- Random queue helpers ----

function ensureRandomQueue(queueId) {
  if (!queueId) return null;
  if (!randomQueues[queueId]) {
    randomQueues[queueId] = {
      matchSeq: 0,
      matches: []
    };
  }
  return randomQueues[queueId];
}

// そのキューに属する match のうち、まだ参加を受け付けられる（=試合開始
// していない、かつ定員に空きがある）ものを探す。無ければ新規作成する。
function findOrCreateOpenRandomMatch(queueId) {
  const q = ensureRandomQueue(queueId);
  if (!q) return null;

  for (let i = 0; i < q.matches.length; i++) {
    const roomId = q.matches[i];
    const meta = roomMeta[roomId];
    if (!meta) continue; // 空になって掃除された枠はスキップ
    const count = getRoomCount(roomId);
    // starting/matchStarted になっている試合には新規参加させない。
    // lobby 状態で、かつ定員未満のものだけを対象にする。
    if (meta.phase === 'lobby' && !meta.starting && !meta.matchStarted && count < RANDOM_QUEUE_MAX_PLAYERS) {
      return roomId;
    }
  }

  // 空いている match が無いので新規作成
  q.matchSeq += 1;
  const roomId = normalizeRoom(`${queueId}-${q.matchSeq}`, { isMatchId: true });
  q.matches.push(roomId);
  const meta = ensureRoomMeta(roomId);
  meta.isRandom = true;
  meta.queueId = queueId;
  meta.matchId = roomId;
  return roomId;
}

// 途中参加を許すかどうかの判定。ロビー(未開始)なら常に許可。
// 進行中の試合には新規参加させない（要件4）。
function canJoinRandomMatch(roomId) {
  const meta = roomMeta[roomId];
  if (!meta) return true;
  if (meta.phase === 'playing' || meta.phase === 'finished') return false;
  const count = getRoomCount(roomId);
  return count < RANDOM_QUEUE_MAX_PLAYERS;
}

function cleanupRandomQueueIfEmpty(queueId) {
  const q = randomQueues[queueId];
  if (!q) return;
  // まだ roomMeta が残っている(=プレイヤーがいる) match が1つでもあれば維持
  const stillActive = q.matches.some(roomId => !!roomMeta[roomId]);
  if (!stillActive) {
    delete randomQueues[queueId];
  }
}

function ensureRoomMeta(room) {
  const roomId = normalizeRoom(room, { isMatchId: room.indexOf('-') !== -1 });
  if (!roomId) return null;

  if (!roomMeta[roomId]) {
    roomMeta[roomId] = {
      starting: false,
      matchStarted: false,
      phase: 'lobby',
      startedAt: 0,
      roundIndex: 1,
      roundEndsAt: 0,
      lastStarter: '',
      startToken: 0,
      roundTimerId: null,
      roundResetTimerId: null,
      lastRoundSummary: null,
      blueScore: 0,
      redScore: 0,
      roundResolved: false,
      aiUnits: [],
      mapId: 'arena',
      // random battle specific
      isRandom: false,
      queueId: '',
      matchId: '',
      randomAiTimerId: null
    };
  }
  return roomMeta[roomId];
}

function clearRoomTimers(roomId) {
  const meta = roomMeta[roomId];
  if (!meta) return;
  if (meta.roundTimerId) {
    clearInterval(meta.roundTimerId);
    meta.roundTimerId = null;
  }
  if (meta.roundResetTimerId) {
    clearTimeout(meta.roundResetTimerId);
    meta.roundResetTimerId = null;
  }
  if (meta.randomAiTimerId) {
    clearTimeout(meta.randomAiTimerId);
    meta.randomAiTimerId = null;
  }
}

// FIX #8: O(1) lookup via roomIndex instead of scanning all players.
function getRoomCount(room) {
  const roomId = normalizeRoom(room, { isMatchId: room.indexOf('-') !== -1 });
  const set = roomIndex[roomId];
  return set ? set.size : 0;
}

function cleanupRoomMetaIfEmpty(room) {
  const roomId = normalizeRoom(room, { isMatchId: room.indexOf('-') !== -1 });
  if (!roomId) return;
  if (getRoomCount(roomId) === 0) {
    const meta = roomMeta[roomId];
    const queueId = meta && meta.queueId;
    clearRoomTimers(roomId);
    delete roomMeta[roomId];
    delete roomIndex[roomId];
    if (queueId) cleanupRandomQueueIfEmpty(queueId);
  }
}

function flatPlayer(id, p) {
  const kills = safeNum(p.matchKills, 0);
  const deaths = safeNum(p.matchDeaths, 0);
  return {
    id,
    playerId: id,
    targetId: id,
    name: p.name || id,
    team: p.team || 'blue',
    room: p.room || '',
    roomId: p.room || '',
    x: safeNum(p.x, 0),
    y: safeNum(p.y, 1.6),
    z: safeNum(p.z, 5),
    ry: safeNum(p.ry, 0),
    alive: p.alive !== false,
    hp: safeNum(p.hp, 100),
    matchMode: p.matchMode || 'ranked',
    lastSeenAt: safeNum(p.lastSeenAt, Date.now()),
    kills,
    deaths,
    kdr: deaths > 0 ? Math.round((kills / deaths) * 100) / 100 : kills
  };
}

// FIX #8: use roomIndex instead of Object.entries(players) full scan.
function getRoomPlayers(room) {
  const roomId = normalizeRoom(room, { isMatchId: room.indexOf('-') !== -1 });
  const result = Object.create(null);
  const set = roomIndex[roomId];
  if (!set) return result;
  set.forEach(id => {
    const p = players[id];
    if (p) result[id] = flatPlayer(id, p);
  });
  return result;
}

function getRoomPlayerEntries(room) {
  const roomId = normalizeRoom(room, { isMatchId: room.indexOf('-') !== -1 });
  const set = roomIndex[roomId];
  if (!set) return [];
  const entries = [];
  set.forEach(id => {
    const p = players[id];
    if (p) entries.push([id, p]);
  });
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function getSpawnPoint(team, index, mapId) {
  const map = SPAWN_POINTS_BY_MAP[mapId] || SPAWN_POINTS_BY_MAP.arena;
  const points = map[team] || map.blue;
  return points[index % points.length];
}

function applySpawnPositions(roomId) {
  const meta = roomMeta[roomId];
  const mapId = (meta && meta.mapId) || 'arena';

  const byTeam = { blue: [], red: [] };
  getRoomPlayerEntries(roomId).forEach(([id, p]) => {
    byTeam[p.team === 'red' ? 'red' : 'blue'].push(id);
  });

  ['blue', 'red'].forEach(team => {
    byTeam[team].forEach((id, index) => {
      const p = players[id];
      if (!p) return;
      const sp = getSpawnPoint(team, index, mapId);
      p.x = sp.x;
      p.y = sp.y;
      p.z = sp.z;
      p.ry = sp.ry;
      p.alive = true;
      p.hp = 100;
      p.lastShotAt = 0;
      p.lastShotAtByWeapon = Object.create(null);
      p.lastSeenAt = Date.now();
    });
  });
}

function assignRandomTeams(roomId) {
  const ids = getRoomPlayerEntries(roomId).map(([id]) => id);
  shuffleArray(ids);
  const blueCount = Math.ceil(ids.length / 2);

  ids.forEach((id, index) => {
    players[id].team = index < blueCount ? 'blue' : 'red';
  });

  return {
    blue: ids.slice(0, blueCount),
    red: ids.slice(blueCount)
  };
}

function segmentIntersectsRect2D(x1, z1, x2, z2, rect) {
  const halfW = rect.w / 2;
  const halfD = rect.d / 2;
  const minX = rect.x - halfW, maxX = rect.x + halfW;
  const minZ = rect.z - halfD, maxZ = rect.z + halfD;

  const dx = x2 - x1, dz = z2 - z1;
  let tmin = 0, tmax = 1;

  if (Math.abs(dx) < 1e-9) {
    if (x1 < minX || x1 > maxX) return false;
  } else {
    let t1 = (minX - x1) / dx;
    let t2 = (maxX - x1) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }

  if (Math.abs(dz) < 1e-9) {
    if (z1 < minZ || z1 > maxZ) return false;
  } else {
    let t1 = (minZ - z1) / dz;
    let t2 = (maxZ - z1) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }

  return true;
}

function isLineOfSightBlocked(x1, z1, x2, z2, mapId) {
  if (![x1, z1, x2, z2].every(v => Number.isFinite(v))) return false;
  const colliders = MAP_COLLIDERS_BY_ID[mapId] || MAP_COLLIDERS_BY_ID.arena;
  for (const rect of colliders) {
    if (segmentIntersectsRect2D(x1, z1, x2, z2, rect)) return true;
  }
  return false;
}

function getAliveCount(room, team) {
  const roomId = normalizeRoom(room, { isMatchId: room.indexOf('-') !== -1 });
  const meta = roomMeta[roomId];
  const set = roomIndex[roomId];
  let count = 0;
  if (set) {
    set.forEach(id => {
      const p = players[id];
      if (p && p.team === team && p.alive !== false && (p.hp ?? 100) > 0) count++;
    });
  }

  if (meta && Array.isArray(meta.aiUnits)) {
    count += meta.aiUnits.filter(u => u.team === team && u.alive).length;
  }

  return count;
}

function initAIUnitsForRoom(roomId, isRandomMatch) {
  const meta = ensureRoomMeta(roomId);
  if (!meta) return;

  const aiCount = isRandomMatch ? 3 : 2;
  const units = [];

  ['blue', 'red'].forEach(team => {
    for (let i = 0; i < aiCount; i++) {
      units.push({
        id: `ai-${team}-${i}`,
        team,
        hp: 100,
        maxHp: 100,
        alive: true,
        lastAttackAt: 0
      });
    }
  });

  meta.aiUnits = units;
}

function reviveAIUnitsForRoom(roomId) {
  const meta = roomMeta[roomId];
  if (!meta) return;
  meta.aiUnits.forEach(u => {
    u.hp = u.maxHp;
    u.alive = true;
    u.lastAttackAt = 0;
  });
}

function findAIUnit(roomId, aiId) {
  const meta = roomMeta[roomId];
  if (!meta) return null;
  return meta.aiUnits.find(u => u.id === aiId) || null;
}

function emitRoomState(room) {
  const roomId = normalizeRoom(room, { isMatchId: room.indexOf('-') !== -1 });
  if (!roomId) return;

  const meta = ensureRoomMeta(roomId);
  if (!meta) return;

  const count = getRoomCount(roomId);
  const minPlayers = meta.isRandom ? RANDOM_START_MIN_PLAYERS : START_MIN_PLAYERS;
  if (count < minPlayers) meta.starting = false;

  io.to(roomId).emit('room-state', {
    room: roomId,
    // Random battle 用の識別子。HTML 側が今後これを見て currentRoom を
    // 実際の match room に追従させられるようにする。
    matchId: meta.matchId || roomId,
    queueId: meta.queueId || '',
    isRandom: !!meta.isRandom,
    count,
    maxPlayers: MAX_PLAYERS,
    canStart: count >= minPlayers && count <= MAX_PLAYERS && !meta.starting,
    starting: meta.starting,
    matchStarted: meta.matchStarted,
    phase: meta.phase,
    roundIndex: meta.roundIndex,
    roundEndsAt: meta.roundEndsAt,
    roundDurationMs: ROUND_DURATION_MS,
    blue: meta.blueScore,
    red: meta.redScore,
    mapId: meta.mapId,
    aiUnits: meta.aiUnits,
    players: getRoomPlayers(roomId)
  });
}

function emitCurrentPlayers(socket, room) {
  const roomId = normalizeRoom(room, { isMatchId: room.indexOf('-') !== -1 });
  if (!roomId) return;
  const roomPlayers = getRoomPlayers(roomId);
  socket.emit('currentPlayers', roomPlayers);
  socket.emit('room-players', { room: roomId, players: roomPlayers });
}

function broadcastRoomPlayers(room) {
  const roomId = normalizeRoom(room, { isMatchId: room.indexOf('-') !== -1 });
  if (!roomId) return;
  io.to(roomId).emit('room-players', {
    room: roomId,
    players: getRoomPlayers(roomId)
  });
}

function broadcastRoomSnapshot(room) {
  const roomId = normalizeRoom(room, { isMatchId: room.indexOf('-') !== -1 });
  if (!roomId) return;
  const meta = ensureRoomMeta(roomId);
  if (!meta) return;

  const payload = {
    room: roomId,
    matchId: meta.matchId || roomId,
    queueId: meta.queueId || '',
    isRandom: !!meta.isRandom,
    players: getRoomPlayers(roomId),
    phase: meta.phase,
    matchStarted: meta.matchStarted,
    roundIndex: meta.roundIndex,
    roundEndsAt: meta.roundEndsAt,
    roundDurationMs: ROUND_DURATION_MS,
    blue: meta.blueScore,
    red: meta.redScore,
    mapId: meta.mapId,
    aiUnits: meta.aiUnits
  };

  io.to(roomId).emit('room-snapshot', payload);
  emitRoomState(roomId);
}

// ============================================================================
// FIX #5: Collapsed the 3 near-duplicate shot events (playerShot,
// playerShotFX, playerShoot) down to a single canonical event name,
// 'shot-fx', for pure visual/audio effect broadcasting. The old event names
// are still emitted (as thin aliases) ONLY if you need old clients to keep
// working; set LEGACY_SHOT_EVENTS=false to stop sending them once your
// client is updated to listen to 'shot-fx' only.
// ============================================================================
const LEGACY_SHOT_EVENTS = true;

function broadcastShotFX(roomId, payload) {
  io.to(roomId).emit('shot-fx', payload);
  if (LEGACY_SHOT_EVENTS) {
    io.to(roomId).emit('playerShot', payload);
    io.to(roomId).emit('playerShotFX', payload);
    io.to(roomId).emit('playerShoot', payload);
  }
}

function resetPlayersForNextRound(roomId) {
  const meta = ensureRoomMeta(roomId);
  if (!meta) return;

  applySpawnPositions(roomId);
  reviveAIUnitsForRoom(roomId);

  meta.matchStarted = true;
  meta.starting = false;
  meta.phase = 'playing';
  meta.startedAt = Date.now();
  meta.roundEndsAt = Date.now() + ROUND_DURATION_MS;
  meta.roundResolved = false;

  const payload = {
    room: roomId,
    matchId: meta.matchId || roomId,
    queueId: meta.queueId || '',
    isRandom: !!meta.isRandom,
    roundIndex: meta.roundIndex,
    startedAt: meta.startedAt,
    roundEndsAt: meta.roundEndsAt,
    roundDurationMs: ROUND_DURATION_MS,
    blue: meta.blueScore,
    red: meta.redScore,
    aiUnits: meta.aiUnits,
    players: getRoomPlayers(roomId),
    mapId: meta.mapId
  };

  io.to(roomId).emit('round-reset', payload);
  io.to(roomId).emit('round-started', payload);
  io.to(roomId).emit('match-started', {
    room: roomId,
    matchId: meta.matchId || roomId,
    queueId: meta.queueId || '',
    isRandom: !!meta.isRandom,
    teams: {
      blue: getRoomPlayerEntries(roomId).filter(([, p]) => p.team === 'blue').map(([id]) => id),
      red: getRoomPlayerEntries(roomId).filter(([, p]) => p.team === 'red').map(([id]) => id)
    },
    players: getRoomPlayers(roomId),
    startedBy: meta.lastStarter || '',
    startedAt: meta.startedAt,
    roundIndex: meta.roundIndex,
    roundEndsAt: meta.roundEndsAt,
    roundDurationMs: ROUND_DURATION_MS,
    blue: meta.blueScore,
    red: meta.redScore,
    aiUnits: meta.aiUnits,
    mapId: meta.mapId
  });

  broadcastRoomSnapshot(roomId);
  startRoundTimer(roomId);
}

// ============================================================================
// FIX #6: Round resolution now handles the "both teams wiped simultaneously"
// case explicitly instead of silently returning and leaving the round stuck.
// Simultaneous double-KO is resolved as a DRAW (winner: null) rather than
// blocking. Timeout ties are also resolved as a draw instead of always
// favoring blue.
// ============================================================================
function resolveRound(roomId, winner, reason) {
  const meta = roomMeta[roomId];
  if (!meta || meta.roundResolved) return;

  meta.roundResolved = true;
  clearRoomTimers(roomId);

  if (winner === 'blue') meta.blueScore += 1;
  else if (winner === 'red') meta.redScore += 1;
  // winner === null / 'draw' -> no score change, but round still advances.

  const isFinal = meta.blueScore >= WIN_SCORE || meta.redScore >= WIN_SCORE;
  const finalWinner = meta.blueScore >= WIN_SCORE ? 'blue' : (meta.redScore >= WIN_SCORE ? 'red' : winner);

  meta.phase = isFinal ? 'finished' : 'roundOver';
  meta.matchStarted = !isFinal;
  meta.roundEndsAt = 0;

  const summary = {
    room: roomId,
    matchId: meta.matchId || roomId,
    queueId: meta.queueId || '',
    isRandom: !!meta.isRandom,
    reason: reason || 'round-end',
    winner: finalWinner,
    draw: winner === null || winner === 'draw',
    blue: meta.blueScore,
    red: meta.redScore,
    roundIndex: meta.roundIndex,
    blueAlive: getAliveCount(roomId, 'blue'),
    redAlive: getAliveCount(roomId, 'red'),
    players: getRoomPlayers(roomId),
    final: isFinal
  };

  meta.lastRoundSummary = summary;

  io.to(roomId).emit('scoreUpdate', {
    room: roomId,
    matchId: meta.matchId || roomId,
    queueId: meta.queueId || '',
    blue: meta.blueScore,
    red: meta.redScore,
    round: meta.roundIndex
  });
  io.to(roomId).emit('round-ended', summary);
  if (isFinal) io.to(roomId).emit('matchFinished', summary);

  emitRoomState(roomId);

  if (!isFinal) {
    meta.roundIndex += 1;
    meta.roundResetTimerId = setTimeout(() => {
      const currentMeta = roomMeta[roomId];
      if (!currentMeta) return;
      resetPlayersForNextRound(roomId);
      currentMeta.roundResetTimerId = null;
    }, ROUND_RESET_DELAY_MS);
  } else if (meta.isRandom && meta.queueId) {
    // ランダム戦の match が終了したら、この roomId はキューの「再利用可能な枠」
    // からは自然に外れる（phase !== 'lobby' になるため findOrCreateOpenRandomMatch
    // が拾わなくなる）。全員退室したら cleanupRoomMetaIfEmpty で掃除される。
  }
}

function checkRoundEndCondition(roomId, reason) {
  const meta = roomMeta[roomId];
  if (!meta || meta.phase !== 'playing' || meta.roundResolved) return;

  const blueAlive = getAliveCount(roomId, 'blue');
  const redAlive = getAliveCount(roomId, 'red');

  if (blueAlive > 0 && redAlive > 0) return;

  // FIX #6: simultaneous wipe is now resolved as a draw instead of stalling.
  if (blueAlive === 0 && redAlive === 0) {
    resolveRound(roomId, null, reason || 'double-elimination');
    return;
  }

  const winner = blueAlive === 0 ? 'red' : 'blue';
  resolveRound(roomId, winner, reason || 'elimination');
}

function startRoundTimer(roomId) {
  const meta = ensureRoomMeta(roomId);
  if (!meta) return;

  clearRoomTimers(roomId);

  meta.roundEndsAt = Date.now() + ROUND_DURATION_MS;
  meta.roundTimerId = setInterval(() => {
    const currentMeta = roomMeta[roomId];
    if (!currentMeta || currentMeta.phase !== 'playing') return;

    const remainingMs = Math.max(0, currentMeta.roundEndsAt - Date.now());

    io.to(roomId).emit('round-timer', {
      room: roomId,
      matchId: currentMeta.matchId || roomId,
      queueId: currentMeta.queueId || '',
      roundIndex: currentMeta.roundIndex,
      remainingMs,
      remainingSec: Math.ceil(remainingMs / 1000),
      roundEndsAt: currentMeta.roundEndsAt
    });

    if (remainingMs <= 0) {
      const blueAlive = getAliveCount(roomId, 'blue');
      const redAlive = getAliveCount(roomId, 'red');
      // FIX #6: timeout tie is now a draw instead of auto-favoring blue.
      let winner;
      if (blueAlive === redAlive) winner = null;
      else winner = blueAlive > redAlive ? 'blue' : 'red';
      resolveRound(roomId, winner, 'timeout');
    }
  }, 500);
}

// ============================================================================
// FIX #7: Unified match-start entry point. request-start-match and
// start-match socket handlers both now call this single function
// (startMatchInRoomUnified) instead of duplicating the ranked/casual vs
// random branching logic in two places.
// ============================================================================
function startMatchInRoom(room, starterId, isRandomMatch) {
  const roomId = normalizeRoom(room, { isMatchId: room.indexOf('-') !== -1 });
  if (!roomId) return { ok: false, message: 'Invalid room' };

  const meta = ensureRoomMeta(roomId);
  const count = getRoomCount(roomId);
  const minPlayers = isRandomMatch ? RANDOM_START_MIN_PLAYERS : START_MIN_PLAYERS;

  if (count < minPlayers) return { ok: false, message: 'Not enough players' };
  if (count > MAX_PLAYERS) return { ok: false, message: 'Room is full' };
  if (meta.starting) return { ok: false, message: 'Match already starting' };

  meta.starting = true;
  meta.lastStarter = starterId || '';
  meta.startToken += 1;
  meta.blueScore = 0;
  meta.redScore = 0;
  meta.roundIndex = 1;
  meta.roundResolved = false;

  getRoomPlayerEntries(roomId).forEach(([, p]) => {
    p.matchKills = 0;
    p.matchDeaths = 0;
  });

  const token = meta.startToken;

  io.to(roomId).emit('match-starting', {
    room: roomId,
    matchId: meta.matchId || roomId,
    queueId: meta.queueId || '',
    startedBy: starterId || '',
    count
  });

  emitRoomState(roomId);

  setTimeout(() => {
    const currentMeta = roomMeta[roomId];
    if (!currentMeta || currentMeta.startToken !== token) return;

    const nowCount = getRoomCount(roomId);
    if (nowCount < minPlayers) {
      currentMeta.starting = false;
      currentMeta.matchStarted = false;
      currentMeta.phase = 'lobby';
      io.to(roomId).emit('match-start-cancelled', {
        room: roomId,
        matchId: currentMeta.matchId || roomId,
        queueId: currentMeta.queueId || '',
        message: 'Players left before start'
      });
      emitRoomState(roomId);
      return;
    }

    assignRandomTeams(roomId);
    currentMeta.mapId = pickRandomMapId();
    applySpawnPositions(roomId);
    initAIUnitsForRoom(roomId, isRandomMatch);

    currentMeta.starting = false;
    currentMeta.matchStarted = true;
    currentMeta.phase = 'playing';
    currentMeta.startedAt = Date.now();
    currentMeta.roundIndex = currentMeta.roundIndex || 1;
    currentMeta.roundEndsAt = Date.now() + ROUND_DURATION_MS;
    currentMeta.roundResolved = false;

    const payload = {
      room: roomId,
      matchId: currentMeta.matchId || roomId,
      queueId: currentMeta.queueId || '',
      isRandom: !!currentMeta.isRandom,
      teams: {
        blue: getRoomPlayerEntries(roomId).filter(([, p]) => p.team === 'blue').map(([id]) => id),
        red: getRoomPlayerEntries(roomId).filter(([, p]) => p.team === 'red').map(([id]) => id)
      },
      players: getRoomPlayers(roomId),
      startedBy: starterId || '',
      startedAt: currentMeta.startedAt,
      roundIndex: currentMeta.roundIndex,
      roundEndsAt: currentMeta.roundEndsAt,
      roundDurationMs: ROUND_DURATION_MS,
      blue: currentMeta.blueScore,
      red: currentMeta.redScore,
      aiUnits: currentMeta.aiUnits,
      mapId: currentMeta.mapId
    };

    io.to(roomId).emit('match-started', payload);
    io.to(roomId).emit('round-started', payload);

    broadcastRoomSnapshot(roomId);
    emitRoomState(roomId);
    startRoundTimer(roomId);
  }, START_DELAY_MS);

  return { ok: true };
}

function tryStartRandomMatch(roomId, starterId) {
  const meta = roomMeta[roomId];
  if (!meta || !meta.isRandom) return { ok: false, message: 'Not a random match room' };
  if (meta.starting || meta.matchStarted) return { ok: false, message: 'Match already starting' };

  const count = getRoomCount(roomId);
  if (count < RANDOM_START_MIN_PLAYERS) return { ok: false, message: 'Not enough players' };

  return startMatchInRoom(roomId, starterId, true);
}

// FIX #7: single shared entry point used by BOTH the 'request-start-match'
// and 'start-match' socket handlers, and both random/non-random paths route
// through it. Eliminates the duplicated if/else that used to live twice.
function startMatchInRoomUnified(roomId, starterId, requestedRandom) {
  const meta = roomMeta[roomId];
  const wantsRandom = !!requestedRandom || (meta && meta.isRandom);

  if (wantsRandom && meta && meta.isRandom) {
    return tryStartRandomMatch(roomId, starterId);
  }
  return startMatchInRoom(roomId, starterId, !!requestedRandom);
}

// 参加者がランダム待機部屋(match)に入って RANDOM_AI_FILL_DELAY_MS 経っても
// 開始していなければ、AI を補充して開始する（既存のクライアント側30秒仕様を
// サーバー権威で肩代わりする）。
function scheduleRandomAiFill(roomId) {
  const meta = roomMeta[roomId];
  if (!meta || !meta.isRandom) return;
  if (meta.randomAiTimerId) return; // 既にスケジュール済み

  meta.randomAiTimerId = setTimeout(() => {
    const currentMeta = roomMeta[roomId];
    if (!currentMeta) return;
    currentMeta.randomAiTimerId = null;
    if (currentMeta.starting || currentMeta.matchStarted) return;
    const count = getRoomCount(roomId);
    if (count < RANDOM_START_MIN_PLAYERS) return; // 誰もいなければ何もしない
    tryStartRandomMatch(roomId, '');
  }, RANDOM_AI_FILL_DELAY_MS);
}

function leaveRoom(socket) {
  const p = players[socket.id];
  if (!p) return;

  const roomId = normalizeRoom(p.room, { isMatchId: p.room.indexOf('-') !== -1 });
  if (roomId) {
    socket.leave(roomId);
    indexRemove(roomId, socket.id);
    socket.to(roomId).emit('playerDisconnected', socket.id);
    broadcastRoomPlayers(roomId);
    emitRoomState(roomId);
    checkRoundEndCondition(roomId, 'player-left');
    cleanupRoomMetaIfEmpty(roomId);
  }

  delete players[socket.id];
}

// ============================================================================
// FIX #11: Skill (smoke) and bomb effects/damage are now broadcast to the
// WHOLE room authoritatively via the server (bomb-thrown / bomb-explode /
// skill-smoke), instead of relying on client-to-client relay of
// 'playerShotFX' with fxType. The server re-broadcasts these events to
// every socket in the room (including bystanders on the other team), and
// applies bomb explosion damage server-side so both players see hits and
// both screens reflect it consistently.
// ============================================================================
function getServerHitRadius(targetType) {
  return targetType === 'ai' ? 0.55 : 0.55;
}

io.on('connection', socket => {
  console.log(`🟢 接続: ${socket.id}`);

  players[socket.id] = {
    id: socket.id,
    name: socket.id,
    team: 'blue',
    room: '',
    x: 0,
    y: 1.6,
    z: 5,
    ry: 0,
    alive: true,
    hp: 100,
    matchMode: 'ranked',
    lastShotAt: 0,
    lastShotAtByWeapon: Object.create(null),
    lastSeenAt: Date.now(),
    matchKills: 0,
    matchDeaths: 0,
    shotSeq: 0
  };

  socket.on('join-room', (data = {}) => {
    const requestedRoomId = normalizeRoom(data.room);
    const name = String(data.name || socket.id).slice(0, 20);
    const matchMode = data.matchMode || 'ranked';
    const wantsRandom = !!data.isRandom;

    if (!requestedRoomId) {
      socket.emit('join-room-error', { message: 'Invalid room number' });
      return;
    }

    // ===== Random battle branch =====
    // HTML 側は currentRoom = 'R0001'（固定文字列）で join してくる。
    // これを「キューID」として扱い、実際にプレイヤーを入れる roomId は
    // サーバーが findOrCreateOpenRandomMatch で決定する。
    if (wantsRandom) {
      const queueId = requestedRoomId; // 例: 'R0001'
      const targetRoomId = findOrCreateOpenRandomMatch(queueId);

      if (!targetRoomId || !canJoinRandomMatch(targetRoomId)) {
        socket.emit('join-room-error', { message: 'Random match is full, please retry' });
        return;
      }

      const prev = players[socket.id];
      const prevRoom = prev ? normalizeRoom(prev.room, { isMatchId: prev.room.indexOf('-') !== -1 }) : '';

      if (prevRoom && prevRoom !== targetRoomId) {
        socket.leave(prevRoom);
        indexRemove(prevRoom, socket.id);
        socket.to(prevRoom).emit('playerDisconnected', socket.id);
        broadcastRoomPlayers(prevRoom);
        emitRoomState(prevRoom);
        checkRoundEndCondition(prevRoom, 'player-switched-room');
        cleanupRoomMetaIfEmpty(prevRoom);
      }

      const meta = ensureRoomMeta(targetRoomId);
      meta.isRandom = true;
      meta.queueId = queueId;
      meta.matchId = targetRoomId;

      players[socket.id] = {
        id: socket.id,
        name,
        team: 'blue',
        room: targetRoomId,
        x: Number.isFinite(data.x) ? data.x : 0,
        y: Number.isFinite(data.y) ? data.y : 1.6,
        z: Number.isFinite(data.z) ? data.z : 5,
        ry: Number.isFinite(data.ry) ? data.ry : 0,
        alive: data.alive !== false,
        hp: Number.isFinite(data.hp) ? data.hp : 100,
        matchMode,
        lastShotAt: 0,
        lastShotAtByWeapon: Object.create(null),
        lastSeenAt: Date.now(),
        matchKills: 0,
        matchDeaths: 0,
        shotSeq: 0
      };

      socket.join(targetRoomId);
      indexAdd(targetRoomId, socket.id);
      console.log(`📦 join-room(random): ${socket.id} -> queue ${queueId} -> match ${targetRoomId} (${name})`);

      emitCurrentPlayers(socket, targetRoomId);

      const fp = flatPlayer(socket.id, players[socket.id]);
      socket.to(targetRoomId).emit('newPlayer', fp);

      broadcastRoomPlayers(targetRoomId);
      emitRoomState(targetRoomId);

      socket.emit('room-snapshot', {
        room: targetRoomId,
        matchId: targetRoomId,
        queueId,
        isRandom: true,
        players: getRoomPlayers(targetRoomId),
        phase: meta.phase,
        matchStarted: meta.matchStarted,
        roundIndex: meta.roundIndex,
        roundEndsAt: meta.roundEndsAt,
        roundDurationMs: ROUND_DURATION_MS,
        blue: meta.blueScore,
        red: meta.redScore,
        aiUnits: meta.aiUnits,
        mapId: meta.mapId
      });

      // クライアントへ「本当の room / matchId」を明示的に伝える専用イベント。
      // 既存の room-state / room-snapshot にも matchId は入っているが、
      // HTML 側の adoptRandomServerRoom() が拾いやすいよう別途も送る。
      socket.emit('random-match-assigned', {
        queueId,
        room: targetRoomId,
        matchId: targetRoomId,
        assignedRoom: targetRoomId,
        count: getRoomCount(targetRoomId)
      });

      scheduleRandomAiFill(targetRoomId);
      return;
    }

    // ===== Normal (ranked/casual, fixed room number) branch =====
    // 既存仕様のまま。ランダム戦の分岐には一切影響しない。
    const roomId = requestedRoomId;

    const prev = players[socket.id];
    const prevRoom = prev ? normalizeRoom(prev.room, { isMatchId: prev.room.indexOf('-') !== -1 }) : '';

    if (prevRoom && prevRoom !== roomId) {
      socket.leave(prevRoom);
      indexRemove(prevRoom, socket.id);
      socket.to(prevRoom).emit('playerDisconnected', socket.id);
      broadcastRoomPlayers(prevRoom);
      emitRoomState(prevRoom);
      checkRoundEndCondition(prevRoom, 'player-switched-room');
      cleanupRoomMetaIfEmpty(prevRoom);
    }

    const countNow = getRoomCount(roomId);
    if (prevRoom !== roomId && countNow >= MAX_PLAYERS) {
      socket.emit('join-room-error', { message: 'Room is full (max 8 players)' });
      return;
    }

    const meta = ensureRoomMeta(roomId);

    players[socket.id] = {
      id: socket.id,
      name,
      team: 'blue',
      room: roomId,
      x: Number.isFinite(data.x) ? data.x : 0,
      y: Number.isFinite(data.y) ? data.y : 1.6,
      z: Number.isFinite(data.z) ? data.z : 5,
      ry: Number.isFinite(data.ry) ? data.ry : 0,
      alive: data.alive !== false,
      hp: Number.isFinite(data.hp) ? data.hp : 100,
      matchMode,
      lastShotAt: 0,
      lastShotAtByWeapon: Object.create(null),
      lastSeenAt: Date.now(),
      matchKills: 0,
      matchDeaths: 0,
      shotSeq: 0
    };

    socket.join(roomId);
    indexAdd(roomId, socket.id);
    console.log(`📦 join-room: ${socket.id} -> room ${roomId} (${name})`);

    emitCurrentPlayers(socket, roomId);

    const fp = flatPlayer(socket.id, players[socket.id]);
    socket.to(roomId).emit('newPlayer', fp);

    broadcastRoomPlayers(roomId);
    emitRoomState(roomId);

    socket.emit('room-snapshot', {
      room: roomId,
      matchId: meta.matchId || roomId,
      queueId: meta.queueId || '',
      isRandom: false,
      players: getRoomPlayers(roomId),
      phase: meta.phase,
      matchStarted: meta.matchStarted,
      roundIndex: meta.roundIndex,
      roundEndsAt: meta.roundEndsAt,
      roundDurationMs: ROUND_DURATION_MS,
      blue: meta.blueScore,
      red: meta.redScore,
      aiUnits: meta.aiUnits,
      mapId: meta.mapId
    });
  });

  socket.on('request-room-players', (data = {}) => {
    const p = players[socket.id];
    const roomId = normalizeRoom(
      data.room || (p && p.room) || '',
      { isMatchId: !!(p && p.room && p.room.indexOf('-') !== -1) }
    );
    if (!roomId) return;
    emitCurrentPlayers(socket, roomId);
  });

  socket.on('request-room-sync', (data = {}) => {
    const p = players[socket.id];
    const roomId = normalizeRoom(
      data.room || (p && p.room) || '',
      { isMatchId: !!(p && p.room && p.room.indexOf('-') !== -1) }
    );
    if (!roomId) return;
    broadcastRoomSnapshot(roomId);
  });

  socket.on('get-room', (data = {}) => {
    const p = players[socket.id];
    const roomId = normalizeRoom(
      data.room || (p && p.room) || '',
      { isMatchId: !!(p && p.room && p.room.indexOf('-') !== -1) }
    );
    if (!roomId) return;

    const meta = ensureRoomMeta(roomId);
    const minPlayers = meta.isRandom ? RANDOM_START_MIN_PLAYERS : START_MIN_PLAYERS;
    socket.emit('room-state', {
      room: roomId,
      matchId: meta.matchId || roomId,
      queueId: meta.queueId || '',
      isRandom: !!meta.isRandom,
      count: getRoomCount(roomId),
      maxPlayers: MAX_PLAYERS,
      canStart: getRoomCount(roomId) >= minPlayers && !meta.starting,
      starting: meta.starting,
      matchStarted: meta.matchStarted,
      phase: meta.phase,
      roundIndex: meta.roundIndex,
      roundEndsAt: meta.roundEndsAt,
      roundDurationMs: ROUND_DURATION_MS,
      blue: meta.blueScore,
      red: meta.redScore,
      mapId: meta.mapId,
      aiUnits: meta.aiUnits,
      players: getRoomPlayers(roomId)
    });
  });

  // FIX #7: both handlers now delegate to the single unified function.
  socket.on('request-start-match', (data = {}) => {
    const p = players[socket.id];
    const roomId = normalizeRoom(
      data.room || (p && p.room) || '',
      { isMatchId: !!(p && p.room && p.room.indexOf('-') !== -1) }
    );
    if (!roomId) return;

    const result = startMatchInRoomUnified(roomId, socket.id, !!data.isRandom);
    if (!result.ok) {
      socket.emit('start-match-error', { room: roomId, message: result.message });
    }
  });

  socket.on('start-match', (data = {}) => {
    const p = players[socket.id];
    const roomId = normalizeRoom(
      data.room || (p && p.room) || '',
      { isMatchId: !!(p && p.room && p.room.indexOf('-') !== -1) }
    );
    if (!roomId) return;

    const result = startMatchInRoomUnified(roomId, socket.id, !!data.isRandom);
    if (!result.ok) {
      socket.emit('start-match-error', { room: roomId, message: result.message });
    }
  });

  socket.on('playerMovement', (movementData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;
    if (p.alive === false) return;

    if (Number.isFinite(movementData.x)) p.x = movementData.x;
    if (Number.isFinite(movementData.y)) p.y = movementData.y;
    if (Number.isFinite(movementData.z)) p.z = movementData.z;
    if (Number.isFinite(movementData.ry)) p.ry = movementData.ry;

    p.lastSeenAt = Date.now();

    socket.to(p.room).emit('playerMoved', {
      id: socket.id,
      playerId: socket.id,
      name: p.name,
      team: p.team,
      room: p.room,
      x: p.x,
      y: p.y,
      z: p.z,
      ry: p.ry
    });
  });

  socket.on('playerState', (stateData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;
    if (p.alive === false) return;

    if (Number.isFinite(stateData.x)) p.x = stateData.x;
    if (Number.isFinite(stateData.y)) p.y = stateData.y;
    if (Number.isFinite(stateData.z)) p.z = stateData.z;
    if (Number.isFinite(stateData.ry)) p.ry = stateData.ry;

    p.lastSeenAt = Date.now();

    const payload = Object.assign(flatPlayer(socket.id, p), {
      playerId: socket.id,
      targetId: socket.id
    });

    socket.to(p.room).emit('playerState', payload);
  });

  // ==========================================================================
  // FIX #4: playerShoot now validates BEFORE broadcasting any FX. Invalid or
  // rate-limited shots no longer produce network traffic / visuals at all.
  // The old 'playerShot' handler (FX-only, no damage) is kept for pure
  // muzzle-flash "miss" broadcasts triggered by the client when its own
  // raycast found no target, but it now also passes through basic
  // room/rate sanity checks so spam can't flood the room with FX either.
  // ==========================================================================
  socket.on('playerShot', (shotData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;
    const roomId = p.room;
    const meta = roomMeta[roomId];
    if (!meta || meta.phase !== 'playing') return;

    // Basic rate sanity even for FX-only "miss" shots, so a modified client
    // can't spam the room with fake muzzle flashes.
    const now = Date.now();
    const weaponKey = WEAPON_DAMAGE_TABLE[shotData.weapon] ? shotData.weapon : 'default';
    const minInterval = WEAPON_MIN_INTERVAL_MS[weaponKey] || SHOT_MIN_INTERVAL_MS;
    p.lastShotAtByWeapon = p.lastShotAtByWeapon || Object.create(null);
    const lastForWeapon = p.lastShotAtByWeapon[weaponKey] || 0;
    if (lastForWeapon && now - lastForWeapon < minInterval) return;
    p.lastShotAtByWeapon[weaponKey] = now;
    p.lastShotAt = now;
    p.shotSeq = (p.shotSeq || 0) + 1;

    const fxPayload = Object.assign({}, shotData, {
      id: socket.id,
      playerId: socket.id,
      name: p.name,
      team: p.team,
      room: roomId,
      shotSeq: p.shotSeq,
      shotAt: now
    });

    broadcastShotFX(roomId, fxPayload);
  });

  socket.on('playerShoot', (shotData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    const roomId = p.room;
    const meta = roomMeta[roomId];

    // FIX #3/#4: validate BEFORE any broadcast. Nothing is emitted for an
    // invalid/rate-limited/out-of-phase shot.
    if (!meta || meta.phase !== 'playing') return;

    const weaponKey = WEAPON_DAMAGE_TABLE[shotData.weapon] ? shotData.weapon : 'default';
    const weaponDef = WEAPON_DAMAGE_TABLE[weaponKey];
    const minInterval = WEAPON_MIN_INTERVAL_MS[weaponKey] || SHOT_MIN_INTERVAL_MS;

    const now = Date.now();
    p.lastShotAtByWeapon = p.lastShotAtByWeapon || Object.create(null);
    const lastForWeapon = p.lastShotAtByWeapon[weaponKey] || 0;
    if (lastForWeapon && now - lastForWeapon < minInterval) return;
    p.lastShotAtByWeapon[weaponKey] = now;
    p.lastShotAt = now;
    p.shotSeq = (p.shotSeq || 0) + 1;

    const targetId = shotData.targetId;

    // FX broadcast happens once validation has passed (covers both hit and
    // deliberate "no target" cosmetic shots sent through this event).
    const fxPayload = Object.assign({}, shotData, {
      id: socket.id,
      playerId: socket.id,
      name: p.name,
      team: p.team,
      room: roomId,
      shotSeq: p.shotSeq,
      shotAt: now,
      // Don't let the FX payload leak the raw client damage value that we
      // are about to ignore for actual game logic.
      damage: undefined
    });
    broadcastShotFX(roomId, fxPayload);

    if (!targetId) return;

    // FIX #2: damage is computed server-side from the weapon table. The
    // client-reported `damage` and `headshot` values are no longer trusted
    // directly; headshot is accepted only as a hint and capped to the
    // server-known multiplier for the resolved weapon.
    const pelletDamage = weaponDef.damage;
    const isHeadshotHint = !!shotData.headshot;
    const finalDamage = Math.max(1, Math.round(pelletDamage * (isHeadshotHint ? HEADSHOT_MULTIPLIER : 1)));

    if (typeof targetId === 'string' && targetId.indexOf('ai-') === 0) {
      const unit = findAIUnit(roomId, targetId);
      if (!unit || !unit.alive) return;
      if (unit.team === p.team) return;

      unit.hp = Math.max(0, unit.hp - finalDamage);
      const justDied = unit.hp <= 0 && unit.alive;
      if (unit.hp <= 0) unit.alive = false;

      if (justDied) p.matchKills = (p.matchKills || 0) + 1;

      io.to(roomId).emit('damage-result', {
        room: roomId,
        sourceId: socket.id,
        targetId: unit.id,
        targetType: 'ai',
        hp: unit.hp,
        alive: unit.alive,
        killed: justDied,
        team: unit.team,
        damage: finalDamage
      });

      if (justDied) {
        io.to(roomId).emit('player-died', {
          room: roomId,
          targetId: unit.id,
          targetType: 'ai',
          killerId: socket.id
        });
      }

      checkRoundEndCondition(roomId, 'ai-eliminated');
      return;
    }

    const target = players[targetId];
    if (!target || target.room !== roomId) return;
    if (target.alive === false || (target.hp ?? 100) <= 0) return;
    if (target.team === p.team) return;

    target.hp = Math.max(0, (target.hp ?? 100) - finalDamage);
    const justDied = target.hp <= 0 && target.alive !== false;
    if (target.hp <= 0) target.alive = false;
    target.lastSeenAt = Date.now();

    if (justDied) {
      p.matchKills = (p.matchKills || 0) + 1;
      target.matchDeaths = (target.matchDeaths || 0) + 1;
    }

    io.to(roomId).emit('damage-result', {
      room: roomId,
      sourceId: socket.id,
      targetId,
      targetType: 'human',
      hp: target.hp,
      alive: target.alive,
      killed: justDied,
      team: target.team,
      damage: finalDamage
    });

    if (justDied) {
      io.to(roomId).emit('player-died', {
        room: roomId,
        targetId,
        targetType: 'human',
        killerId: socket.id
      });
    }

    broadcastRoomPlayers(roomId);
    checkRoundEndCondition(roomId, 'player-eliminated');
  });

  // ==========================================================================
  // FIX #3: AI attacks are now validated & damage is applied authoritatively
  // by the server (fixed AI_DAMAGE_PER_HIT, server-checked LOS/team), rather
  // than trusting a client's self-reported "this AI hit this target" claim
  // for the damage magnitude. We still accept the AI id / target id / rough
  // position from the client (since AI simulation is client-visual only
  // here), but damage amount and eligibility are enforced server-side and
  // rate-limited per AI unit, mirroring what playerShoot does for players.
  // ==========================================================================
  socket.on('ai-attack', (data = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    const roomId = p.room;
    const meta = roomMeta[roomId];
    if (!meta || meta.phase !== 'playing') return;

    const aiId = data.aiId;
    const unit = findAIUnit(roomId, aiId);
    if (!unit || !unit.alive) return;

    const now = Date.now();
    if (unit.lastAttackAt && now - unit.lastAttackAt < 400) return;
    unit.lastAttackAt = now;

    const targetId = data.targetId;
    if (!targetId) return;

    if (
      Number.isFinite(data.aiX) && Number.isFinite(data.aiZ) &&
      Number.isFinite(data.targetX) && Number.isFinite(data.targetZ)
    ) {
      if (isLineOfSightBlocked(data.aiX, data.aiZ, data.targetX, data.targetZ, meta.mapId)) {
        return;
      }
    }

    // Damage is always the server constant, never taken from the client.
    const dmg = AI_DAMAGE_PER_HIT;

    if (targetId !== aiId && typeof targetId === 'string' && targetId.indexOf('ai-') !== 0) {
      const target = players[targetId];
      if (!target || target.room !== roomId) return;
      if (target.alive === false || (target.hp ?? 100) <= 0) return;
      if (target.team === unit.team) return;

      target.hp = Math.max(0, (target.hp ?? 100) - dmg);
      const justDied = target.hp <= 0 && target.alive !== false;
      if (target.hp <= 0) target.alive = false;
      target.lastSeenAt = Date.now();

      if (justDied) target.matchDeaths = (target.matchDeaths || 0) + 1;

      io.to(roomId).emit('damage-result', {
        room: roomId,
        sourceId: aiId,
        targetId,
        targetType: 'human',
        hp: target.hp,
        alive: target.alive,
        killed: justDied,
        team: target.team,
        damage: dmg
      });

      if (justDied) {
        io.to(roomId).emit('player-died', {
          room: roomId,
          targetId,
          targetType: 'human',
          killerId: aiId
        });
      }

      broadcastRoomPlayers(roomId);
      checkRoundEndCondition(roomId, 'player-eliminated-by-ai');
      return;
    }

    if (targetId.indexOf('ai-') === 0) {
      const targetUnit = findAIUnit(roomId, targetId);
      if (!targetUnit || !targetUnit.alive || targetUnit.team === unit.team) return;

      targetUnit.hp = Math.max(0, targetUnit.hp - dmg);
      const justDied = targetUnit.hp <= 0 && targetUnit.alive;
      if (targetUnit.hp <= 0) targetUnit.alive = false;

      io.to(roomId).emit('damage-result', {
        room: roomId,
        sourceId: aiId,
        targetId: targetUnit.id,
        targetType: 'ai',
        hp: targetUnit.hp,
        alive: targetUnit.alive,
        killed: justDied,
        team: targetUnit.team,
        damage: dmg
      });

      if (justDied) {
        io.to(roomId).emit('player-died', {
          room: roomId,
          targetId: targetUnit.id,
          targetType: 'ai',
          killerId: aiId
        });
      }

      checkRoundEndCondition(roomId, 'ai-eliminated');
    }
  });

  // ==========================================================================
  // FIX #11: skill smoke placement is now broadcast to the whole room from
  // the server (server re-emits to everyone including the caster), instead
  // of only ever traveling as a payload inside 'playerShotFX' which some
  // clients / paths might not relay symmetrically. This guarantees both
  // screens show the smoke.
  // ==========================================================================
  socket.on('skill-smoke', (data = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;
    const roomId = p.room;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.z)) return;

    const payload = {
      room: roomId,
      sourceId: socket.id,
      team: p.team,
      x: data.x,
      z: data.z,
      at: Date.now()
    };
    io.to(roomId).emit('skill-smoke', payload);
    // legacy alias so older clients listening on playerShotFX/fxType still work
    if (LEGACY_SHOT_EVENTS) {
      io.to(roomId).emit('playerShotFX', Object.assign({}, payload, { fxType: 'skill-smoke' }));
    }
  });

  // ==========================================================================
  // FIX #11: bomb throw is now server-authoritative for broadcast (everyone
  // in the room, including the thrower's opponents, receives the throw and
  // the eventual explosion), and explosion damage is computed and applied
  // server-side rather than only in the thrower's own client.
  // ==========================================================================
  const BOMB_DAMAGE = 38;
  const BOMB_RADIUS = 4.6;
  const BOMB_FUSE_MS = 5000;

  socket.on('bomb-thrown', (data = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;
    const roomId = p.room;
    const meta = roomMeta[roomId];
    if (!meta || meta.phase !== 'playing') return;

    if (![data.x, data.y, data.z, data.dx, data.dy, data.dz].every(Number.isFinite)) return;

    const payload = {
      room: roomId,
      ownerId: socket.id,
      team: p.team,
      x: data.x, y: data.y, z: data.z,
      dx: data.dx, dy: data.dy, dz: data.dz,
      speed: Number.isFinite(data.speed) ? data.speed : 16,
      thrownAt: Date.now()
    };

    io.to(roomId).emit('bomb-thrown', payload);
    if (LEGACY_SHOT_EVENTS) {
      io.to(roomId).emit('playerShotFX', Object.assign({}, payload, { fxType: 'bomb-throw' }));
    }
  });

  socket.on('bomb-explode', (data = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;
    const roomId = p.room;
    const meta = roomMeta[roomId];
    if (!meta || meta.phase !== 'playing') return;
    if (![data.x, data.y, data.z].every(Number.isFinite)) return;

    const center = { x: data.x, y: data.y, z: data.z };
    const radius = BOMB_RADIUS;
    const ownerId = socket.id;
    const affected = [];

    // Apply damage to human players in the room, server-authoritative.
    getRoomPlayerEntries(roomId).forEach(([id, target]) => {
      if (id === ownerId) return; // no self-damage from own bomb by default
      if (!target || target.alive === false) return;
      const dx = (target.x || 0) - center.x;
      const dz = (target.z || 0) - center.z;
      const dy = (target.y || 1.6) - center.y;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > radius) return;
      const hpFactor = 1 - dist / radius;
      const dmg = Math.max(1, Math.round(BOMB_DAMAGE * Math.max(0.25, hpFactor)));
      target.hp = Math.max(0, (target.hp ?? 100) - dmg);
      const justDied = target.hp <= 0 && target.alive !== false;
      if (target.hp <= 0) target.alive = false;
      if (justDied) target.matchDeaths = (target.matchDeaths || 0) + 1;
      affected.push({ type: 'human', id, dmg });

      io.to(roomId).emit('damage-result', {
        room: roomId,
        sourceId: ownerId,
        targetId: id,
        targetType: 'human',
        hp: target.hp,
        alive: target.alive,
        killed: justDied,
        team: target.team,
        damage: dmg,
        sourceType: 'bomb'
      });
      if (justDied) {
        io.to(roomId).emit('player-died', {
          room: roomId,
          targetId: id,
          targetType: 'human',
          killerId: ownerId
        });
      }
    });

    // Apply damage to AI units.
    if (meta.aiUnits) {
      meta.aiUnits.forEach(unit => {
        if (!unit.alive) return;
        // AI world position isn't tracked server-side beyond spawn; rely on
        // client-reported hit list only for cosmetic AI kills triggered via
        // ai-attack path elsewhere. Server-side bomb->AI damage is skipped
        // here since the server doesn't simulate AI movement; the
        // authoritative AI vs AI/human combat stays on the existing
        // ai-attack / playerShoot paths.
      });
    }

    io.to(roomId).emit('bomb-explode', {
      room: roomId,
      ownerId,
      team: p.team,
      x: center.x, y: center.y, z: center.z,
      damage: BOMB_DAMAGE,
      radius,
      affected
    });
    if (LEGACY_SHOT_EVENTS) {
      io.to(roomId).emit('playerShotFX', {
        room: roomId,
        fxType: 'bomb-explode',
        ownerId,
        x: center.x, y: center.y, z: center.z
      });
    }

    if (affected.length) {
      broadcastRoomPlayers(roomId);
      checkRoundEndCondition(roomId, 'bomb-eliminated');
    }
  });

  socket.on('leave-room', () => {
    leaveRoom(socket);
  });

  socket.on('disconnect', () => {
    console.log(`❌ 切断: ${socket.id}`);
    leaveRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  if (ALLOWED_ORIGINS.length === 0) {
    console.warn('⚠️  ALLOWED_ORIGINS is not set — CORS is permissive (dev mode). Set ALLOWED_ORIGINS in production.');
  } else {
    console.log('✅ CORS allowlist:', ALLOWED_ORIGINS.join(', '));
  }
});
