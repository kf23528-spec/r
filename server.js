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
const START_DELAY_MS = 1800;
const ROUND_DURATION_MS = 180000; // 3分
const ROUND_RESET_DELAY_MS = 1200;
const WIN_SCORE = 5;

const DAMAGE_PER_BULLET = 4;
const AI_DAMAGE_PER_HIT = 4;
const SHOT_MIN_INTERVAL_MS = 90;

// マップ定義（3種類）
const MAP_TYPES = ['urban', 'desert', 'factory'];

// マップ別コライダー
const MAP_COLLIDERS = {
  urban: [
    { x: 0, z: -35.4, w: 72, d: 1.2 },
    { x: 0, z: 35.4, w: 72, d: 1.2 },
    { x: -35.4, z: 0, w: 1.2, d: 72 },
    { x: 35.4, z: 0, w: 1.2, d: 72 },
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
  ],
  desert: [
    { x: 0, z: -35.4, w: 72, d: 1.2 },
    { x: 0, z: 35.4, w: 72, d: 1.2 },
    { x: -35.4, z: 0, w: 1.2, d: 72 },
    { x: 35.4, z: 0, w: 1.2, d: 72 },
    { x: -20, z: -20, w: 8, d: 8 },
    { x: 20, z: -20, w: 8, d: 8 },
    { x: -20, z: 20, w: 8, d: 8 },
    { x: 20, z: 20, w: 8, d: 8 },
    { x: 0, z: 0, w: 12, d: 12 },
    { x: -10, z: -5, w: 4, d: 14 },
    { x: 10, z: 5, w: 4, d: 14 },
    { x: -25, z: 0, w: 4, d: 8 },
    { x: 25, z: 0, w: 4, d: 8 },
    { x: 0, z: -25, w: 8, d: 4 },
    { x: 0, z: 25, w: 8, d: 4 },
  ],
  factory: [
    { x: 0, z: -35.4, w: 72, d: 1.2 },
    { x: 0, z: 35.4, w: 72, d: 1.2 },
    { x: -35.4, z: 0, w: 1.2, d: 72 },
    { x: 35.4, z: 0, w: 1.2, d: 72 },
    { x: -15, z: -15, w: 3, d: 20 },
    { x: 15, z: -15, w: 3, d: 20 },
    { x: -15, z: 15, w: 3, d: 20 },
    { x: 15, z: 15, w: 3, d: 20 },
    { x: 0, z: -8, w: 20, d: 3 },
    { x: 0, z: 8, w: 20, d: 3 },
    { x: -28, z: -20, w: 6, d: 6 },
    { x: 28, z: -20, w: 6, d: 6 },
    { x: -28, z: 20, w: 6, d: 6 },
    { x: 28, z: 20, w: 6, d: 6 },
    { x: 0, z: 0, w: 6, d: 6 },
  ]
};

function getMapColliders(mapType) {
  return MAP_COLLIDERS[mapType] || MAP_COLLIDERS.urban;
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
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }

  if (Math.abs(dz) < 1e-9) {
    if (z1 < minZ || z1 > maxZ) return false;
  } else {
    let t1 = (minZ - z1) / dz;
    let t2 = (maxZ - z1) / dz;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }

  return true;
}

function isLineOfSightBlocked(x1, z1, x2, z2, mapType) {
  if (![x1, z1, x2, z2].every(v => Number.isFinite(v))) return false;
  const colliders = getMapColliders(mapType || 'urban');
  for (let i = 0; i < colliders.length; i++) {
    if (segmentIntersectsRect2D(x1, z1, x2, z2, colliders[i])) return true;
  }
  return false;
}

app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const players = Object.create(null);
const roomMeta = Object.create(null);

// ランダムマッチ用待機プール
// socket.id => { joinedAt, name }
const randomPool = Object.create(null);
const RANDOM_POOL_ROOM = 'RANDOM_POOL';
const RANDOM_MATCH_WAIT_MS = 30000;
const RANDOM_ROOM_PREFIX = 'R';

const SPAWN_POINTS = {
  blue: [
    { x: -18, y: 1.6, z: -18, ry: 0 },
    { x: -16, y: 1.6, z: -6, ry: 0 },
    { x: -20, y: 1.6, z: 10, ry: 0 },
    { x: -14, y: 1.6, z: 22, ry: 0 }
  ],
  red: [
    { x: 18, y: 1.6, z: 18, ry: Math.PI },
    { x: 16, y: 1.6, z: 6, ry: Math.PI },
    { x: 20, y: 1.6, z: -10, ry: Math.PI },
    { x: 14, y: 1.6, z: -22, ry: Math.PI }
  ]
};

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

function ensureRoomMeta(room) {
  const roomId = normalizeRoom(room);
  if (!roomId) return null;

  if (!roomMeta[roomId]) {
    const mapType = MAP_TYPES[Math.floor(Math.random() * MAP_TYPES.length)];
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
      mapType: mapType,
      // 統計データ（キル数・デス数）
      playerStats: Object.create(null)
    };
  }
  return roomMeta[roomId];
}

function getOrInitPlayerStats(roomId, playerId) {
  const meta = roomMeta[roomId];
  if (!meta) return null;
  if (!meta.playerStats[playerId]) {
    meta.playerStats[playerId] = { kills: 0, deaths: 0, aiKills: 0 };
  }
  return meta.playerStats[playerId];
}

function clearRoomTimers(roomId) {
  const meta = roomMeta[roomId];
  if (!meta) return;
  if (meta.roundTimerId) { clearInterval(meta.roundTimerId); meta.roundTimerId = null; }
  if (meta.roundResetTimerId) { clearTimeout(meta.roundResetTimerId); meta.roundResetTimerId = null; }
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
    lastSeenAt: safeNum(p.lastSeenAt, Date.now())
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

function getRoomCount(room) {
  const roomId = normalizeRoom(room);
  return Object.values(players).filter(p => p && p.room === roomId).length;
}

function getAliveCount(room, team) {
  const roomId = normalizeRoom(room);
  const meta = roomMeta[roomId];

  let count = Object.values(players).filter(p => {
    return p && p.room === roomId && p.team === team && p.alive !== false && (p.hp ?? 100) > 0;
  }).length;

  if (meta && Array.isArray(meta.aiUnits)) {
    count += meta.aiUnits.filter(u => u.team === team && u.alive).length;
  }
  return count;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function assignRandomTeams(room) {
  const roomId = normalizeRoom(room);
  const ids = Object.entries(players)
    .filter(([, p]) => p && p.room === roomId)
    .map(([id]) => id);
  shuffleArray(ids);
  const blueCount = Math.ceil(ids.length / 2);
  ids.forEach((id, index) => {
    players[id].team = index < blueCount ? 'blue' : 'red';
  });
  return { blue: ids.slice(0, blueCount), red: ids.slice(blueCount) };
}

function getSpawnPoint(team, index) {
  const points = SPAWN_POINTS[team] || SPAWN_POINTS.blue;
  return points[index % points.length];
}

function applySpawnPositions(roomId) {
  const byTeam = { blue: [], red: [] };
  getRoomPlayerEntries(roomId).forEach(([id, p]) => {
    const team = p.team === 'red' ? 'red' : 'blue';
    byTeam[team].push(id);
  });
  ['blue', 'red'].forEach(team => {
    byTeam[team].forEach((id, index) => {
      const p = players[id]; if (!p) return;
      const sp = getSpawnPoint(team, index);
      p.x = sp.x; p.y = sp.y; p.z = sp.z; p.ry = sp.ry;
      p.alive = true; p.hp = 100; p.lastShotAt = 0; p.lastSeenAt = Date.now();
    });
  });
}

function emitRoomState(room) {
  const roomId = normalizeRoom(room);
  if (!roomId) return;
  const meta = ensureRoomMeta(roomId);
  if (!meta) return;
  const count = getRoomCount(roomId);
  if (count < START_MIN_PLAYERS) meta.starting = false;
  io.to(roomId).emit('room-state', {
    room: roomId, count, maxPlayers: MAX_PLAYERS,
    canStart: count >= START_MIN_PLAYERS && count <= MAX_PLAYERS && !meta.starting,
    starting: meta.starting, matchStarted: meta.matchStarted, phase: meta.phase,
    roundIndex: meta.roundIndex, roundEndsAt: meta.roundEndsAt,
    roundDurationMs: ROUND_DURATION_MS,
    blue: meta.blueScore, red: meta.redScore,
    players: getRoomPlayers(roomId),
    mapType: meta.mapType
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
  io.to(roomId).emit('room-players', { room: roomId, players: getRoomPlayers(roomId) });
}

function broadcastRoomSnapshot(room) {
  const roomId = normalizeRoom(room);
  if (!roomId) return;
  const meta = ensureRoomMeta(roomId);
  if (!meta) return;
  const payload = {
    room: roomId, players: getRoomPlayers(roomId),
    phase: meta.phase, matchStarted: meta.matchStarted,
    roundIndex: meta.roundIndex, roundEndsAt: meta.roundEndsAt,
    roundDurationMs: ROUND_DURATION_MS,
    blue: meta.blueScore, red: meta.redScore,
    mapType: meta.mapType
  };
  io.to(roomId).emit('room-snapshot', payload);
  io.to(roomId).emit('room-state', {
    room: roomId, count: getRoomCount(roomId), maxPlayers: MAX_PLAYERS,
    canStart: getRoomCount(roomId) >= START_MIN_PLAYERS && !meta.starting,
    starting: meta.starting, matchStarted: meta.matchStarted,
    phase: meta.phase, roundIndex: meta.roundIndex, roundEndsAt: meta.roundEndsAt,
    roundDurationMs: ROUND_DURATION_MS,
    blue: meta.blueScore, red: meta.redScore,
    players: getRoomPlayers(roomId),
    mapType: meta.mapType
  });
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
  // ランダムプールからも除去
  delete randomPool[socket.id];
  delete players[socket.id];
}

function initAIUnitsForRoom(roomId, isRandomMatch) {
  const meta = ensureRoomMeta(roomId);
  if (!meta) return;
  const aiCount = isRandomMatch ? 3 : 2;
  const units = [];
  ['blue', 'red'].forEach(team => {
    for (let i = 0; i < aiCount; i++) {
      units.push({ id: `ai-${team}-${i}`, team, hp: 100, maxHp: 100, alive: true });
    }
  });
  meta.aiUnits = units;
}

function reviveAIUnitsForRoom(roomId) {
  const meta = roomMeta[roomId];
  if (!meta) return;
  meta.aiUnits.forEach(u => { u.hp = u.maxHp; u.alive = true; });
}

function findAIUnit(roomId, aiId) {
  const meta = roomMeta[roomId];
  if (!meta) return null;
  return meta.aiUnits.find(u => u.id === aiId) || null;
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
    room: roomId, roundIndex: meta.roundIndex,
    startedAt: meta.startedAt, roundEndsAt: meta.roundEndsAt,
    roundDurationMs: ROUND_DURATION_MS,
    blue: meta.blueScore, red: meta.redScore,
    aiUnits: meta.aiUnits, players: getRoomPlayers(roomId),
    mapType: meta.mapType
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
    blue: meta.blueScore, red: meta.redScore,
    aiUnits: meta.aiUnits,
    mapType: meta.mapType
  });
  broadcastRoomSnapshot(roomId);
  emitRoomState(roomId);
  startRoundTimer(roomId);
}

function computeRoundWinner(roomId) {
  const blueAlive = getAliveCount(roomId, 'blue');
  const redAlive = getAliveCount(roomId, 'red');
  if (blueAlive > redAlive) return 'blue';
  if (redAlive > blueAlive) return 'red';
  return 'draw';
}

function buildResultStats(roomId) {
  const meta = roomMeta[roomId];
  if (!meta) return {};
  const stats = {};
  Object.keys(meta.playerStats).forEach(id => {
    const s = meta.playerStats[id];
    const kills = (s.kills || 0) + (s.aiKills || 0);
    const deaths = s.deaths || 0;
    const kd = deaths === 0 ? kills : Math.round((kills / deaths) * 100) / 100;
    stats[id] = {
      kills: s.kills || 0,
      aiKills: s.aiKills || 0,
      totalKills: kills,
      deaths,
      kd,
      name: players[id] ? players[id].name : id,
      team: players[id] ? players[id].team : 'blue'
    };
  });
  return stats;
}

function checkRoundEndCondition(roomId, reason) {
  const meta = roomMeta[roomId];
  if (!meta) return;
  if (meta.phase !== 'playing') return;
  if (meta.roundResolved) return;
  const blueAlive = getAliveCount(roomId, 'blue');
  const redAlive = getAliveCount(roomId, 'red');
  if (blueAlive > 0 && redAlive > 0) return;
  if (blueAlive === 0 && redAlive === 0) return;
  const winner = blueAlive === 0 ? 'red' : 'blue';
  resolveRound(roomId, winner, reason || 'elimination');
}

function resolveRound(roomId, winner, reason) {
  const meta = roomMeta[roomId];
  if (!meta) return;
  if (meta.roundResolved) return;
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
    final: isFinal,
    mapType: meta.mapType
  };
  meta.lastRoundSummary = summary;

  io.to(roomId).emit('scoreUpdate', { room: roomId, blue: meta.blueScore, red: meta.redScore, round: meta.roundIndex });
  io.to(roomId).emit('round-ended', summary);

  if (isFinal) {
    // リザルト画面用の詳細統計を追加
    const resultStats = buildResultStats(roomId);
    io.to(roomId).emit('matchFinished', Object.assign({}, summary, { resultStats }));
  }

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
      room: roomId, roundIndex: currentMeta.roundIndex,
      remainingMs, remainingSec: Math.ceil(remainingMs / 1000),
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

  if (count < START_MIN_PLAYERS) return { ok: false, message: 'Not enough players' };
  if (count > MAX_PLAYERS) return { ok: false, message: 'Room is full' };
  if (meta.starting) return { ok: false, message: 'Match already starting' };

  meta.starting = true;
  meta.lastStarter = starterId || '';
  meta.startToken += 1;
  meta.blueScore = 0;
  meta.redScore = 0;
  meta.roundIndex = 1;
  meta.roundResolved = false;
  meta.playerStats = Object.create(null);
  const token = meta.startToken;

  io.to(roomId).emit('match-starting', { room: roomId, startedBy: starterId || '', count });
  emitRoomState(roomId);

  setTimeout(() => {
    const currentMeta = roomMeta[roomId];
    if (!currentMeta || currentMeta.startToken !== token) return;
    const nowCount = getRoomCount(roomId);
    if (nowCount < START_MIN_PLAYERS) {
      currentMeta.starting = false;
      currentMeta.matchStarted = false;
      currentMeta.phase = 'lobby';
      io.to(roomId).emit('match-start-cancelled', { room: roomId, message: 'Players left before start' });
      emitRoomState(roomId);
      return;
    }

    assignRandomTeams(roomId);
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
      mapType: currentMeta.mapType
    };

    io.to(roomId).emit('match-started', payload);
    io.to(roomId).emit('round-started', payload);
    broadcastRoomSnapshot(roomId);
    emitRoomState(roomId);
    startRoundTimer(roomId);
  }, START_DELAY_MS);

  return { ok: true };
}

// ランダムマッチング: プールに2人以上いればすぐにマッチング開始
function tryMatchRandomPool() {
  const ids = Object.keys(randomPool);
  if (ids.length < 2) return;

  // マッチングするプレイヤーをまとめて1つの部屋に入れる
  const roomId = 'R' + Date.now().toString(36).toUpperCase().slice(-6);
  console.log(`🎲 Random match: ${ids.join(',')} -> room ${roomId}`);

  ensureRoomMeta(roomId);

  ids.forEach(id => {
    const p = players[id];
    if (!p) return;
    const sock = io.sockets.sockets.get(id);
    if (!sock) return;

    // 以前の部屋から離脱
    const prevRoom = normalizeRoom(p.room);
    if (prevRoom && prevRoom !== roomId) {
      sock.leave(prevRoom);
    }

    p.room = roomId;
    p.matchMode = 'casual';
    sock.join(roomId);
    delete randomPool[id];
  });

  // マッチング通知 → 試合開始
  io.to(roomId).emit('random-matched', { room: roomId, count: ids.length });

  // 全員にroom-playersを送信
  setTimeout(() => {
    broadcastRoomPlayers(roomId);
    emitRoomState(roomId);
  }, 200);

  // 少し待ってから試合開始
  setTimeout(() => {
    const result = startMatchInRoom(roomId, 'RANDOM_MATCH', true);
    if (!result.ok) {
      console.warn('Random match start failed:', result.message);
    }
  }, 800);
}

io.on('connection', (socket) => {
  console.log(`🟢 接続: ${socket.id}`);

  players[socket.id] = {
    id: socket.id,
    name: socket.id,
    team: 'blue',
    room: '',
    x: 0, y: 1.6, z: 5,
    ry: 0,
    alive: true,
    hp: 100,
    matchMode: 'ranked',
    lastShotAt: 0,
    lastSeenAt: Date.now()
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

    ensureRoomMeta(roomId);

    players[socket.id] = {
      id: socket.id, name, team: 'blue', room: roomId,
      x: Number.isFinite(data.x) ? data.x : 0,
      y: Number.isFinite(data.y) ? data.y : 1.6,
      z: Number.isFinite(data.z) ? data.z : 5,
      ry: Number.isFinite(data.ry) ? data.ry : 0,
      alive: data.alive !== false,
      hp: Number.isFinite(data.hp) ? data.hp : 100,
      matchMode, lastShotAt: 0, lastSeenAt: Date.now()
    };

    socket.join(roomId);
    console.log(`📦 join-room: ${socket.id} -> room ${roomId} (${name})`);

    emitCurrentPlayers(socket, roomId);
    const fp = flatPlayer(socket.id, players[socket.id]);
    socket.to(roomId).emit('newPlayer', fp);
    broadcastRoomPlayers(roomId);
    emitRoomState(roomId);
    const meta = ensureRoomMeta(roomId);
    socket.emit('room-snapshot', {
      room: roomId, players: getRoomPlayers(roomId),
      phase: meta.phase, matchStarted: meta.matchStarted,
      roundIndex: meta.roundIndex, roundEndsAt: meta.roundEndsAt,
      roundDurationMs: ROUND_DURATION_MS,
      blue: meta.blueScore, red: meta.redScore,
      aiUnits: meta.aiUnits,
      mapType: meta.mapType
    });
  });

  // ランダムマッチ参加
  socket.on('join-random', (data = {}) => {
    const name = String(data.name || socket.id).slice(0, 20);
    const p = players[socket.id];
    if (!p) return;

    // 既存の部屋から離脱
    const prevRoom = normalizeRoom(p.room);
    if (prevRoom) {
      socket.leave(prevRoom);
      socket.to(prevRoom).emit('playerDisconnected', socket.id);
      broadcastRoomPlayers(prevRoom);
      emitRoomState(prevRoom);
      checkRoundEndCondition(prevRoom, 'player-left');
      cleanupRoomMetaIfEmpty(prevRoom);
    }

    p.name = name;
    p.room = '';
    p.matchMode = 'casual';

    randomPool[socket.id] = { joinedAt: Date.now(), name };
    console.log(`🎲 Random pool join: ${socket.id} (${name}), pool size: ${Object.keys(randomPool).length}`);

    // 2人以上いればすぐにマッチング
    if (Object.keys(randomPool).length >= 2) {
      tryMatchRandomPool();
    } else {
      // タイムアウト後はAIのみで開始
      socket.emit('random-waiting', { position: Object.keys(randomPool).length });
    }
  });

  // ランダムマッチキャンセル
  socket.on('cancel-random', () => {
    delete randomPool[socket.id];
    console.log(`🎲 Random pool leave: ${socket.id}`);
  });

  socket.on('request-room-players', (data = {}) => {
    const roomId = normalizeRoom(data.room || (players[socket.id] && players[socket.id].room));
    if (!roomId) return;
    emitCurrentPlayers(socket, roomId);
  });

  socket.on('request-room-sync', (data = {}) => {
    const roomId = normalizeRoom(data.room || (players[socket.id] && players[socket.id].room));
    if (!roomId) return;
    broadcastRoomSnapshot(roomId);
  });

  socket.on('get-room', (data = {}) => {
    const roomId = normalizeRoom(data.room || (players[socket.id] && players[socket.id].room));
    if (!roomId) return;
    const meta = ensureRoomMeta(roomId);
    socket.emit('room-state', {
      room: roomId, count: getRoomCount(roomId), maxPlayers: MAX_PLAYERS,
      canStart: getRoomCount(roomId) >= START_MIN_PLAYERS && !meta.starting,
      starting: meta.starting, matchStarted: meta.matchStarted,
      phase: meta.phase, roundIndex: meta.roundIndex, roundEndsAt: meta.roundEndsAt,
      roundDurationMs: ROUND_DURATION_MS,
      blue: meta.blueScore, red: meta.redScore,
      players: getRoomPlayers(roomId),
      mapType: meta.mapType
    });
  });

  socket.on('request-start-match', (data = {}) => {
    const roomId = normalizeRoom(data.room || (players[socket.id] && players[socket.id].room));
    if (!roomId) return;
    const result = startMatchInRoom(roomId, socket.id, !!data.isRandom);
    if (!result.ok) {
      socket.emit('start-match-error', { room: roomId, message: result.message });
    }
  });

  socket.on('start-match', (data = {}) => {
    const roomId = normalizeRoom(data.room || (players[socket.id] && players[socket.id].room));
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
    const payload = {
      id: socket.id, playerId: socket.id,
      name: p.name, team: p.team, room: p.room,
      x: p.x, y: p.y, z: p.z, ry: p.ry
    };
    socket.to(p.room).emit('playerMoved', payload);
  });

  socket.on('playerShoot', (shotData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;
    const roomId = p.room;
    const meta = roomMeta[roomId];

    const fxPayload = Object.assign({}, shotData, {
      id: socket.id, playerId: socket.id,
      name: p.name, team: p.team, room: roomId
    });
    socket.to(roomId).emit('playerShot', fxPayload);
    socket.to(roomId).emit('playerShotFX', fxPayload);

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

      io.to(roomId).emit('damage-result', {
        room: roomId, sourceId: socket.id, targetId: unit.id,
        targetType: 'ai', hp: unit.hp, alive: unit.alive,
        killed: justDied, team: unit.team
      });

      if (justDied) {
        io.to(roomId).emit('player-died', { room: roomId, targetId: unit.id, targetType: 'ai', killerId: socket.id });
        // AI キル統計
        const stats = getOrInitPlayerStats(roomId, socket.id);
        if (stats) stats.aiKills = (stats.aiKills || 0) + 1;
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

    io.to(roomId).emit('damage-result', {
      room: roomId, sourceId: socket.id, targetId,
      targetType: 'human', hp: target.hp, alive: target.alive,
      killed: justDied, team: target.team
    });

    if (justDied) {
      io.to(roomId).emit('player-died', { room: roomId, targetId, targetType: 'human', killerId: socket.id });
      // キル/デス統計
      const killerStats = getOrInitPlayerStats(roomId, socket.id);
      if (killerStats) killerStats.kills = (killerStats.kills || 0) + 1;
      const deadStats = getOrInitPlayerStats(roomId, targetId);
      if (deadStats) deadStats.deaths = (deadStats.deaths || 0) + 1;
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
      if (isLineOfSightBlocked(data.aiX, data.aiZ, data.targetX, data.targetZ, meta.mapType)) return;
    }

    if (targetId !== aiId && typeof targetId === 'string' && targetId.indexOf('ai-') !== 0) {
      const target = players[targetId];
      if (!target || target.room !== roomId) return;
      if (target.alive === false || (target.hp ?? 100) <= 0) return;
      if (target.team === unit.team) return;

      target.hp = Math.max(0, (target.hp ?? 100) - AI_DAMAGE_PER_HIT);
      const justDied = target.hp <= 0 && target.alive !== false;
      if (target.hp <= 0) target.alive = false;
      target.lastSeenAt = Date.now();

      io.to(roomId).emit('damage-result', {
        room: roomId, sourceId: aiId, targetId,
        targetType: 'human', hp: target.hp, alive: target.alive,
        killed: justDied, team: target.team
      });

      if (justDied) {
        io.to(roomId).emit('player-died', { room: roomId, targetId, targetType: 'human', killerId: aiId });
        // デス統計
        const deadStats = getOrInitPlayerStats(roomId, targetId);
        if (deadStats) deadStats.deaths = (deadStats.deaths || 0) + 1;
      }
      broadcastRoomPlayers(roomId);
      checkRoundEndCondition(roomId, 'player-eliminated-by-ai');
      return;
    }

    if (typeof targetId === 'string' && targetId.indexOf('ai-') === 0) {
      const targetUnit = findAIUnit(roomId, targetId);
      if (!targetUnit || !targetUnit.alive || targetUnit.team === unit.team) return;
      targetUnit.hp = Math.max(0, targetUnit.hp - AI_DAMAGE_PER_HIT);
      const justDied = targetUnit.hp <= 0 && targetUnit.alive;
      if (targetUnit.hp <= 0) targetUnit.alive = false;

      io.to(roomId).emit('damage-result', {
        room: roomId, sourceId: aiId, targetId: targetUnit.id,
        targetType: 'ai', hp: targetUnit.hp, alive: targetUnit.alive,
        killed: justDied, team: targetUnit.team
      });

      if (justDied) {
        io.to(roomId).emit('player-died', { room: roomId, targetId: targetUnit.id, targetType: 'ai', killerId: aiId });
      }
      checkRoundEndCondition(roomId, 'ai-eliminated');
    }
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
    const payload = Object.assign(flatPlayer(socket.id, p), { playerId: socket.id, targetId: socket.id });
    socket.to(p.room).emit('playerState', payload);
  });

  socket.on('leave-room', () => { leaveRoom(socket); });
  socket.on('disconnect', () => {
    console.log(`❌ 切断: ${socket.id}`);
    delete randomPool[socket.id];
    leaveRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
