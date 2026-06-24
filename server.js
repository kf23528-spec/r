const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
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

const DAMAGE_PER_BULLET = 4;
const AI_DAMAGE_PER_HIT = 4;
const SHOT_MIN_INTERVAL_MS = 90;

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

app.use(express.static(__dirname));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const players = Object.create(null);   // socket.id -> player
const roomMeta = Object.create(null);   // roomId -> meta

function normalizeRoom(room) {
  const s = String(room ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
  return s.slice(0, 12);
}

function safeNum(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function pickRandomMapId() {
  return MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)] || 'arena';
}

function ensureRoomMeta(room) {
  const roomId = normalizeRoom(room);
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
      mapId: 'arena'
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
}

function getRoomCount(room) {
  const roomId = normalizeRoom(room);
  return Object.values(players).filter(p => p && p.room === roomId).length;
}

function cleanupRoomMetaIfEmpty(room) {
  const roomId = normalizeRoom(room);
  if (!roomId) return;
  if (getRoomCount(roomId) === 0) {
    clearRoomTimers(roomId);
    delete roomMeta[roomId];
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

function getRoomPlayers(room) {
  const roomId = normalizeRoom(room);
  const result = Object.create(null);

  for (const [id, p] of Object.entries(players)) {
    if (p && p.room === roomId) {
      result[id] = flatPlayer(id, p);
    }
  }
  return result;
}

function getRoomPlayerEntries(room) {
  const roomId = normalizeRoom(room);
  return Object.entries(players)
    .filter(([, p]) => p && p.room === roomId)
    .sort(([a], [b]) => a.localeCompare(b));
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
  const roomId = normalizeRoom(room);
  const meta = roomMeta[roomId];
  let count = Object.values(players).filter(p => {
    return p &&
      p.room === roomId &&
      p.team === team &&
      p.alive !== false &&
      (p.hp ?? 100) > 0;
  }).length;

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
  const roomId = normalizeRoom(room);
  if (!roomId) return;

  const meta = ensureRoomMeta(roomId);
  if (!meta) return;

  const count = getRoomCount(roomId);
  if (count < START_MIN_PLAYERS) meta.starting = false;

  io.to(roomId).emit('room-state', {
    room: roomId,
    count,
    maxPlayers: MAX_PLAYERS,
    canStart: count >= START_MIN_PLAYERS && count <= MAX_PLAYERS && !meta.starting,
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
  const roomId = normalizeRoom(room);
  if (!roomId) return;
  const roomPlayers = getRoomPlayers(roomId);
  socket.emit('currentPlayers', roomPlayers);
  socket.emit('room-players', { room: roomId, players: roomPlayers });
}

function broadcastRoomPlayers(room) {
  const roomId = normalizeRoom(room);
  if (!roomId) return;
  io.to(roomId).emit('room-players', {
    room: roomId,
    players: getRoomPlayers(roomId)
  });
}

function broadcastRoomSnapshot(room) {
  const roomId = normalizeRoom(room);
  if (!roomId) return;
  const meta = ensureRoomMeta(roomId);
  if (!meta) return;

  const payload = {
    room: roomId,
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

function broadcastShotFX(roomId, payload) {
  io.to(roomId).emit('playerShot', payload);
  io.to(roomId).emit('playerShotFX', payload);
  io.to(roomId).emit('playerShoot', payload);
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

function resolveRound(roomId, winner, reason) {
  const meta = roomMeta[roomId];
  if (!meta || meta.roundResolved) return;

  meta.roundResolved = true;
  clearRoomTimers(roomId);

  if (winner === 'blue') meta.blueScore += 1;
  else if (winner === 'red') meta.redScore += 1;

  const isFinal = meta.blueScore >= WIN_SCORE || meta.redScore >= WIN_SCORE;
  const finalWinner = meta.blueScore >= WIN_SCORE ? 'blue' : (meta.redScore >= WIN_SCORE ? 'red' : winner);

  meta.phase = isFinal ? 'finished' : 'roundOver';
  meta.matchStarted = !isFinal;
  meta.roundEndsAt = 0;

  const summary = {
    room: roomId,
    reason: reason || 'round-end',
    winner: finalWinner,
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
  }
}

function checkRoundEndCondition(roomId, reason) {
  const meta = roomMeta[roomId];
  if (!meta || meta.phase !== 'playing' || meta.roundResolved) return;

  const blueAlive = getAliveCount(roomId, 'blue');
  const redAlive = getAliveCount(roomId, 'red');

  if (blueAlive > 0 && redAlive > 0) return;
  if (blueAlive === 0 && redAlive === 0) return;

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
      roundIndex: currentMeta.roundIndex,
      remainingMs,
      remainingSec: Math.ceil(remainingMs / 1000),
      roundEndsAt: currentMeta.roundEndsAt
    });

    if (remainingMs <= 0) {
      const blueAlive = getAliveCount(roomId, 'blue');
      const redAlive = getAliveCount(roomId, 'red');
      const winner = blueAlive >= redAlive ? 'blue' : 'red';
      resolveRound(roomId, winner, 'timeout');
    }
  }, 500);
}

function startMatchInRoom(room, starterId, isRandomMatch) {
  const roomId = normalizeRoom(room);
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

function leaveRoom(socket) {
  const p = players[socket.id];
  if (!p) return;

  const roomId = normalizeRoom(p.room);
  if (roomId) {
    socket.leave(roomId);
    socket.to(roomId).emit('playerDisconnected', socket.id);
    broadcastRoomPlayers(roomId);
    emitRoomState(roomId);
    checkRoundEndCondition(roomId, 'player-left');
    cleanupRoomMetaIfEmpty(roomId);
  }

  delete players[socket.id];
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
    lastSeenAt: Date.now(),
    matchKills: 0,
    matchDeaths: 0
  };

  socket.on('join-room', (data = {}) => {
    const roomId = normalizeRoom(data.room);
    const name = String(data.name || socket.id).slice(0, 20);
    const matchMode = data.matchMode || 'ranked';

    if (!roomId) {
      socket.emit('join-room-error', { message: 'Invalid room number' });
      return;
    }

    const prev = players[socket.id];
    const prevRoom = prev ? normalizeRoom(prev.room) : '';

    if (prevRoom && prevRoom !== roomId) {
      socket.leave(prevRoom);
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
      lastSeenAt: Date.now(),
      matchKills: 0,
      matchDeaths: 0
    };

    socket.join(roomId);
    console.log(`📦 join-room: ${socket.id} -> room ${roomId} (${name})`);

    emitCurrentPlayers(socket, roomId);

    const fp = flatPlayer(socket.id, players[socket.id]);
    socket.to(roomId).emit('newPlayer', fp);

    broadcastRoomPlayers(roomId);
    emitRoomState(roomId);

    socket.emit('room-snapshot', {
      room: roomId,
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
    const roomId = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!roomId) return;
    emitCurrentPlayers(socket, roomId);
  });

  socket.on('request-room-sync', (data = {}) => {
    const roomId = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!roomId) return;
    broadcastRoomSnapshot(roomId);
  });

  socket.on('get-room', (data = {}) => {
    const roomId = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!roomId) return;

    const meta = ensureRoomMeta(roomId);
    socket.emit('room-state', {
      room: roomId,
      count: getRoomCount(roomId),
      maxPlayers: MAX_PLAYERS,
      canStart: getRoomCount(roomId) >= START_MIN_PLAYERS && !meta.starting,
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

  socket.on('request-start-match', (data = {}) => {
    const roomId = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!roomId) return;
    const result = startMatchInRoom(roomId, socket.id, !!data.isRandom);
    if (!result.ok) {
      socket.emit('start-match-error', { room: roomId, message: result.message });
    }
  });

  socket.on('start-match', (data = {}) => {
    const roomId = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!roomId) return;
    const result = startMatchInRoom(roomId, socket.id, !!data.isRandom);
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

  socket.on('playerShot', (shotData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;
    const roomId = p.room;

    const fxPayload = Object.assign({}, shotData, {
      id: socket.id,
      playerId: socket.id,
      name: p.name,
      team: p.team,
      room: roomId
    });

    broadcastShotFX(roomId, fxPayload);
  });

  socket.on('playerShoot', (shotData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    const roomId = p.room;
    const meta = roomMeta[roomId];

    const fxPayload = Object.assign({}, shotData, {
      id: socket.id,
      playerId: socket.id,
      name: p.name,
      team: p.team,
      room: roomId
    });

    broadcastShotFX(roomId, fxPayload);

    if (!meta || meta.phase !== 'playing') return;

    const now = Date.now();
    if (p.lastShotAt && now - p.lastShotAt < SHOT_MIN_INTERVAL_MS) return;
    p.lastShotAt = now;

    const targetId = shotData.targetId;
    if (!targetId) return;

    if (typeof targetId === 'string' && targetId.indexOf('ai-') === 0) {
      const unit = findAIUnit(roomId, targetId);
      if (!unit || !unit.alive) return;
      if (unit.team === p.team) return;

      const dmg = Number.isFinite(shotData.damage) ? shotData.damage : DAMAGE_PER_BULLET;
      unit.hp = Math.max(0, unit.hp - dmg);
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
        team: unit.team
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

    const dmg = Number.isFinite(shotData.damage) ? shotData.damage : DAMAGE_PER_BULLET;
    target.hp = Math.max(0, (target.hp ?? 100) - dmg);
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
      team: target.team
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

    if (targetId !== aiId && typeof targetId === 'string' && targetId.indexOf('ai-') !== 0) {
      const target = players[targetId];
      if (!target || target.room !== roomId) return;
      if (target.alive === false || (target.hp ?? 100) <= 0) return;
      if (target.team === unit.team) return;

      const dmg = AI_DAMAGE_PER_HIT;
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
        team: target.team
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

      targetUnit.hp = Math.max(0, targetUnit.hp - AI_DAMAGE_PER_HIT);
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
        team: targetUnit.team
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
});
