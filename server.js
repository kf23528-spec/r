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

// ============================================================
// FIX: ダメージ判定をサーバー側で一元管理するための定数。
// クライアント側の DAMAGE_PER_BULLET / AI_DAMAGE_PER_HIT と同じ値を使う。
// これにより「誰が誰に何ダメージ与えたか」はサーバーが唯一の真実になる。
// ============================================================
const DAMAGE_PER_BULLET = 4;
// FIX: AIのダメージ(12)が人間の弾(4)の3倍で、AIに撃たれるだけで
// 一瞬でHPが溶びてしまい強すぎるとの報告。人間と同じ威力に揃える。
const AI_DAMAGE_PER_HIT = 4;
const SHOT_MIN_INTERVAL_MS = 90; // 1人のプレイヤーが連続でダメージ判定を要求できる最短間隔(チート・多重送信対策)

// ============================================================
// FIX(重要): AIが撃った弾が壁を貫通してくる不具合への対応。
// 以前は ai-attack ハンドラが壁の有無を一切チェックせず、
// クライアントから「このAIがこの相手を狙った」という報告を
// そのまま信用してダメージを通していた。
// クライアント側の buildMap() で配置している壁と同じ座標データを
// サーバー側にも複製し、AIの座標→ターゲットの座標の間に壁があれば
// ダメージを無効化するようにする。
// (このデータは index.html の buildMap() 内のコライダー配置と
//  常に一致させること。マップを変更した場合はここも更新する。)
// ============================================================
const MAP_COLLIDERS = [
  // 外周4壁
  { x: 0, z: -35.4, w: 72, d: 1.2 },
  { x: 0, z: 35.4, w: 72, d: 1.2 },
  { x: -35.4, z: 0, w: 1.2, d: 72 },
  { x: 35.4, z: 0, w: 1.2, d: 72 },
  // 中間の障害物群(buildMapの配列と同じ座標・サイズ)
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
];

// 2D(x,z)の線分が軸並行の矩形(AABB)と交差するかどうかを判定する。
// AIの攻撃判定は地上の平面上の話なので、高さ(y)は無視して2Dで十分。
function segmentIntersectsRect2D(x1, z1, x2, z2, rect) {
  const halfW = rect.w / 2;
  const halfD = rect.d / 2;
  const minX = rect.x - halfW, maxX = rect.x + halfW;
  const minZ = rect.z - halfD, maxZ = rect.z + halfD;

  const dx = x2 - x1, dz = z2 - z1;
  let tmin = 0, tmax = 1;

  // X軸方向のスラブ
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

  // Z軸方向のスラブ
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

// AIの座標とターゲットの座標の間に、マップの壁(MAP_COLLIDERS)が
// 1つでも挟まっていれば true (=遮蔽されている)を返す。
// 座標が不正(NaN等)な場合は安全側に倒して「遮蔽されていない」扱いにする
// (クライアントが座標を送っていない古いバージョンとの互換性のため)。
function isLineOfSightBlocked(x1, z1, x2, z2) {
  if (![x1, z1, x2, z2].every(v => Number.isFinite(v))) return false;
  for (let i = 0; i < MAP_COLLIDERS.length; i++) {
    if (segmentIntersectsRect2D(x1, z1, x2, z2, MAP_COLLIDERS[i])) return true;
  }
  return false;
}

app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// socket.id => player data
const players = Object.create(null);
// roomId => meta
const roomMeta = Object.create(null);

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
    roomMeta[roomId] = {
      starting: false,
      matchStarted: false,
      phase: 'lobby', // lobby | starting | playing | roundOver | finished
      startedAt: 0,
      roundIndex: 1,
      roundEndsAt: 0,
      lastStarter: '',
      startToken: 0,
      roundTimerId: null,
      roundResetTimerId: null,
      lastRoundSummary: null,
      // FIX: スコアもサーバー側で一元管理する(クライアント自己申告のscoreUpdateに依存しない)
      blueScore: 0,
      redScore: 0,
      roundResolved: false,
      // FIX: AIユニットの状態をサーバー側でも保持し、AIのダメージ判定もサーバー権威にする
      aiUnits: [] // { id, team, hp, alive }
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
    return p &&
      p.room === roomId &&
      p.team === team &&
      p.alive !== false &&
      (p.hp ?? 100) > 0;
  }).length;

  // FIX: AIユニットの生存数もカウントに含める(ラウンド終了判定をサーバーが正しく行うため)
  if (meta && Array.isArray(meta.aiUnits)) {
    count += meta.aiUnits.filter(u => u.team === team && u.alive).length;
  }

  return count;
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

  return {
    blue: ids.slice(0, blueCount),
    red: ids.slice(blueCount)
  };
}

function getSpawnPoint(team, index) {
  const points = SPAWN_POINTS[team] || SPAWN_POINTS.blue;
  return points[index % points.length];
}

function applySpawnPositions(roomId) {
  const byTeam = {
    blue: [],
    red: []
  };

  getRoomPlayerEntries(roomId).forEach(([id, p]) => {
    const team = p.team === 'red' ? 'red' : 'blue';
    byTeam[team].push(id);
  });

  ['blue', 'red'].forEach(team => {
    byTeam[team].forEach((id, index) => {
      const p = players[id];
      if (!p) return;
      const sp = getSpawnPoint(team, index);
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

function emitRoomState(room) {
  const roomId = normalizeRoom(room);
  if (!roomId) return;

  const meta = ensureRoomMeta(roomId);
  if (!meta) return;

  const count = getRoomCount(roomId);
  if (count < START_MIN_PLAYERS) {
    meta.starting = false;
  }

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
    players: getRoomPlayers(roomId)
  });
}

function emitCurrentPlayers(socket, room) {
  const roomId = normalizeRoom(room);
  if (!roomId) return;

  const roomPlayers = getRoomPlayers(roomId);
  socket.emit('currentPlayers', roomPlayers);
  socket.emit('room-players', {
    room: roomId,
    players: roomPlayers
  });
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
    red: meta.redScore
  };

  io.to(roomId).emit('room-snapshot', payload);
  io.to(roomId).emit('room-state', {
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
    players: getRoomPlayers(roomId)
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

    // FIX: プレイヤーが抜けたことでラウンドの全滅条件が満たされる可能性があるのでチェックする
    checkRoundEndCondition(roomId, 'player-left');

    cleanupRoomMetaIfEmpty(roomId);
  }

  delete players[socket.id];
}

// ============================================================
// FIX: AIユニットの初期化・管理をサーバー側に追加。
// クライアントは見た目(アバターの表示・移動アニメ)だけを担当し、
// 「HPがいくつか」「死んでいるか」はサーバーのaiUnitsが真実になる。
// ============================================================
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
        alive: true
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
  });
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
    room: roomId,
    roundIndex: meta.roundIndex,
    startedAt: meta.startedAt,
    roundEndsAt: meta.roundEndsAt,
    roundDurationMs: ROUND_DURATION_MS,
    blue: meta.blueScore,
    red: meta.redScore,
    aiUnits: meta.aiUnits,
    players: getRoomPlayers(roomId)
  };

  // FIX: round-reset / round-started / match-started の3つを送るのは維持しつつ、
  // 全プレイヤーのalive/hpをこのタイミングで強制的にtrue/100にする情報を含める。
  // クライアント側はこれらのイベントを受け取ったら「問答無用で」復活処理をする。
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
    aiUnits: meta.aiUnits
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

// ============================================================
// FIX: ラウンド終了→スコア加算→次ラウンド or 試合終了 を
// 完全にサーバー側で一括処理する関数。
// 以前はクライアントの clearRoundIfNeededFromStates が各クライアントで
// 独立に判定していたため、複数クライアントが同時にendRoundByWinnerを呼んで
// 二重カウントする可能性があった。これをサーバー側で一度だけ実行するようにする。
// ============================================================
function checkRoundEndCondition(roomId, reason) {
  const meta = roomMeta[roomId];
  if (!meta) return;
  if (meta.phase !== 'playing') return;
  if (meta.roundResolved) return;

  const blueAlive = getAliveCount(roomId, 'blue');
  const redAlive = getAliveCount(roomId, 'red');

  // どちらかのチームが0人になったらラウンド終了
  if (blueAlive > 0 && redAlive > 0) return;
  // 両方0人(誰も部屋にいない等)の場合は判定しない
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
    final: isFinal
  };

  meta.lastRoundSummary = summary;

  // FIX(重要): 以前は isFinal(本当に WIN_SCORE に達したか)に関係なく
  // 毎ラウンド matchFinished を送っていた。クライアント側がこの
  // イベントを受け取ると即座に「試合終了」画面を表示してしまうため、
  // 1ラウンド勝っただけで試合が終わったように見える不具合の原因になっていた。
  // matchFinished は本当に試合が終わった(isFinal===true)ときだけ送る。
  // ラウンドの結果自体は scoreUpdate と round-ended で常に通知する。
  io.to(roomId).emit('scoreUpdate', { room: roomId, blue: meta.blueScore, red: meta.redScore, round: meta.roundIndex });
  io.to(roomId).emit('round-ended', summary);
  if (isFinal) {
    io.to(roomId).emit('matchFinished', summary);
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
      room: roomId,
      roundIndex: currentMeta.roundIndex,
      remainingMs,
      remainingSec: Math.ceil(remainingMs / 1000),
      roundEndsAt: currentMeta.roundEndsAt
    });

    if (remainingMs <= 0) {
      // FIX: タイムアウト時は生存人数が多いチームの勝利、同数ならdraw扱いでblue勝利(既存仕様を維持)
      const blueAlive = getAliveCount(roomId, 'blue');
      const redAlive = getAliveCount(roomId, 'red');
      const winner = blueAlive >= redAlive ? 'blue' : 'red';
      resolveRound(roomId, winner, 'timeout');
    }
  }, 500);
}

function startMatchInRoom(room, starterId, isRandomMatch) {
  const roomId = normalizeRoom(room);
  if (!roomId) {
    return { ok: false, message: 'Invalid room' };
  }

  const meta = ensureRoomMeta(roomId);
  const count = getRoomCount(roomId);

  if (count < START_MIN_PLAYERS) {
    return { ok: false, message: 'Not enough players' };
  }
  if (count > MAX_PLAYERS) {
    return { ok: false, message: 'Room is full' };
  }
  if (meta.starting) {
    return { ok: false, message: 'Match already starting' };
  }

  meta.starting = true;
  meta.lastStarter = starterId || '';
  meta.startToken += 1;
  meta.blueScore = 0;
  meta.redScore = 0;
  meta.roundIndex = 1;
  meta.roundResolved = false;
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
    if (nowCount < START_MIN_PLAYERS) {
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
      aiUnits: currentMeta.aiUnits
    };

    io.to(roomId).emit('match-started', payload);
    io.to(roomId).emit('round-started', payload);

    broadcastRoomSnapshot(roomId);
    emitRoomState(roomId);
    startRoundTimer(roomId);
  }, START_DELAY_MS);

  return { ok: true };
}

io.on('connection', (socket) => {
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
      socket.emit('join-room-error', {
        message: 'Room is full (max 8 players)'
      });
      return;
    }

    ensureRoomMeta(roomId);

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
      lastSeenAt: Date.now()
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
      room: roomId,
      players: getRoomPlayers(roomId),
      phase: meta.phase,
      matchStarted: meta.matchStarted,
      roundIndex: meta.roundIndex,
      roundEndsAt: meta.roundEndsAt,
      roundDurationMs: ROUND_DURATION_MS,
      blue: meta.blueScore,
      red: meta.redScore,
      aiUnits: meta.aiUnits
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
      socket.emit('start-match-error', {
        room: roomId,
        message: result.message
      });
    }
  });

  socket.on('start-match', (data = {}) => {
    const roomId = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!roomId) return;

    const result = startMatchInRoom(roomId, socket.id, !!data.isRandom);
    if (!result.ok) {
      socket.emit('start-match-error', {
        room: roomId,
        message: result.message
      });
    }
  });

  // FIX: playerMovement は座標同期のみを行う。HP/alive はここでは絶対に変更しない。
  // 以前はこのイベントが移動とHPの両方を運んでいたため、移動パケットが
  // 古いHP値を持って届くと、ダメージ判定後の最新HPを上書きしてしまうことがあった。
  //
  // FIX(重要): 死んでいる(alive===false)プレイヤーは観戦(スペクテイト)
  // カメラを操作しているだけで、ゲーム上の実体としては存在しない。
  // 以前はここで alive を見ずに座標を無条件で更新・他クライアントに
  // 中継していたため、観戦カメラが「観戦対象の背後」に動き続けることで
  // サーバー上の死亡プレイヤーの座標がそこに書き換わり、他クライアントの
  // 当たり判定(bulletHitsAvatar は avatar.position を見るだけで
  // visible/alive を見ない)が観戦者の座標を巻き込んでしまい、
  // 「観戦者に当たり判定を吸われて狙った相手に当たらない」不具合の
  // 原因になっていた。死亡中は座標更新・中継を完全に止める。
  socket.on('playerMovement', (movementData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;
    if (p.alive === false) return; // 観戦中は座標を更新・中継しない

    if (Number.isFinite(movementData.x)) p.x = movementData.x;
    if (Number.isFinite(movementData.y)) p.y = movementData.y;
    if (Number.isFinite(movementData.z)) p.z = movementData.z;
    if (Number.isFinite(movementData.ry)) p.ry = movementData.ry;

    p.lastSeenAt = Date.now();

    // alive/hp は含めず、座標のみを中継する
    const payload = {
      id: socket.id,
      playerId: socket.id,
      name: p.name,
      team: p.team,
      room: p.room,
      x: p.x,
      y: p.y,
      z: p.z,
      ry: p.ry
    };
    socket.to(p.room).emit('playerMoved', payload);
  });

  // ============================================================
  // FIX: playerShoot がダメージ判定の唯一の入口になる。
  // クライアントは「自分がこの方向に撃った」「当てたつもりのtargetId」を送るだけ。
  // サーバーがtargetの現在HPを確認し、実際にダメージを適用、
  // 結果(誰が何HPになったか/死んだか)を damage-result として
  // 部屋の全員(撃った本人含む)に同じ内容で配信する。
  // これにより撃った側と撃たれた側のHP表示が必ず一致するようになる。
  // ============================================================
  socket.on('playerShoot', (shotData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    const roomId = p.room;
    const meta = roomMeta[roomId];

    // 見た目用のFX(マズルフラッシュ・弾の軌跡)はそのまま中継する
    const fxPayload = Object.assign({}, shotData, {
      id: socket.id,
      playerId: socket.id,
      name: p.name,
      team: p.team,
      room: roomId
    });
    socket.to(roomId).emit('playerShot', fxPayload);
    socket.to(roomId).emit('playerShotFX', fxPayload);

    if (!meta || meta.phase !== 'playing') return;

    const now = Date.now();
    if (p.lastShotAt && now - p.lastShotAt < SHOT_MIN_INTERVAL_MS) {
      // 連射しすぎ(チート/重複送信)はダメージ判定をスキップ(FXは出すが当たらない)
      return;
    }
    p.lastShotAt = now;

    const targetId = shotData.targetId;
    if (!targetId) return; // 何にも当たっていない(空振り)

    // ターゲットがAIユニットの場合
    if (typeof targetId === 'string' && targetId.indexOf('ai-') === 0) {
      const unit = findAIUnit(roomId, targetId);
      if (!unit || !unit.alive) return;
      if (unit.team === p.team) return; // 味方AIには当たらない

      const dmg = Number.isFinite(shotData.damage) ? shotData.damage : DAMAGE_PER_BULLET;
      unit.hp = Math.max(0, unit.hp - dmg);
      const justDied = unit.hp <= 0 && unit.alive;
      if (unit.hp <= 0) unit.alive = false;

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
        io.to(roomId).emit('player-died', { room: roomId, targetId: unit.id, targetType: 'ai', killerId: socket.id });
      }

      checkRoundEndCondition(roomId, 'ai-eliminated');
      return;
    }

    // ターゲットが人間プレイヤーの場合
    const target = players[targetId];
    if (!target || target.room !== roomId) return;
    if (target.alive === false || (target.hp ?? 100) <= 0) return; // 既に死んでいる相手には重複ダメージを与えない
    if (target.team === p.team) return; // 味方には当たらない(フレンドリーファイア無効)

    const dmg = Number.isFinite(shotData.damage) ? shotData.damage : DAMAGE_PER_BULLET;
    target.hp = Math.max(0, (target.hp ?? 100) - dmg);
    const justDied = target.hp <= 0 && target.alive !== false;
    if (target.hp <= 0) target.alive = false;
    target.lastSeenAt = Date.now();

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
      io.to(roomId).emit('player-died', { room: roomId, targetId, targetType: 'human', killerId: socket.id });
    }

    broadcastRoomPlayers(roomId);
    checkRoundEndCondition(roomId, 'player-eliminated');
  });

  // ============================================================
  // FIX: AIによるダメージもサーバー側で確定させる。
  // クライアントの各端末はAIの行動をローカルでシミュレートしているため、
  // 「AIが誰に何ダメージ与えたか」は端末ごとにズレる可能性がある。
  // そこで「このAIがこの座標からこの相手を狙って攻撃した」という
  // 意図だけをサーバーに送り、実際にダメージを適用するかはサーバーが決める。
  // 複数端末から同じ内容が重複して送られてくる可能性があるため、
  // AIごとのクールダウン(最短間隔)をサーバー側でも管理する。
  // ============================================================
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
    if (unit.lastAttackAt && now - unit.lastAttackAt < 400) return; // 複数端末からの重複攻撃要求を間引く
    unit.lastAttackAt = now;

    const targetId = data.targetId;
    if (!targetId) return;

    // FIX(重要): AIの座標とターゲットの座標の間に壁があれば、
    // ダメージを無効化する(=AIの弾が壁を貫通してくる不具合の修正)。
    // 座標はクライアントの ai-attack 送信時に追加されたフィールド
    // (aiX/aiZ/targetX/targetZ)から取得する。座標が送られていない
    // 古いクライアントの場合は安全側(=遮蔽なし扱い)で通す(後方互換)。
    if (
      Number.isFinite(data.aiX) && Number.isFinite(data.aiZ) &&
      Number.isFinite(data.targetX) && Number.isFinite(data.targetZ)
    ) {
      if (isLineOfSightBlocked(data.aiX, data.aiZ, data.targetX, data.targetZ)) {
        return; // 壁に遮蔽されているのでダメージなし(弾は壁に当たって止まる)
      }
    }

    // AIが人間を攻撃
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
        io.to(roomId).emit('player-died', { room: roomId, targetId, targetType: 'human', killerId: aiId });
      }

      broadcastRoomPlayers(roomId);
      checkRoundEndCondition(roomId, 'player-eliminated-by-ai');
      return;
    }

    // AIが別のAIを攻撃(チーム戦なのでAI同士の交戦もあり得る設計を残す)
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
        io.to(roomId).emit('player-died', { room: roomId, targetId: targetUnit.id, targetType: 'ai', killerId: aiId });
      }

      checkRoundEndCondition(roomId, 'ai-eliminated');
    }
  });

  // FIX: playerState は「自分の生死・HPをサーバーに直接書き込む」用途では使わせない。
  // 生死とHPはサーバーのdamage-result/resolveRoundでのみ変更される。
  // ここではクライアントが見た目上の座標補正等を送ってきても、座標の中継のみ行う。
  // FIX(重要): playerMovement と同様、死亡中(観戦中)は座標の更新・中継を
  // 止める。観戦カメラの位置が他クライアントに伝わって当たり判定を
  // 乱す問題を防ぐため。
  socket.on('playerState', (stateData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;
    if (p.alive === false) return; // 観戦中は座標を更新・中継しない

    if (Number.isFinite(stateData.x)) p.x = stateData.x;
    if (Number.isFinite(stateData.y)) p.y = stateData.y;
    if (Number.isFinite(stateData.z)) p.z = stateData.z;
    if (Number.isFinite(stateData.ry)) p.ry = stateData.ry;

    p.lastSeenAt = Date.now();

    // FIX: alive/hp はサーバーの値をそのまま使う(クライアントの自己申告で上書きしない)
    const payload = Object.assign(flatPlayer(socket.id, p), {
      playerId: socket.id,
      targetId: socket.id
    });

    socket.to(p.room).emit('playerState', payload);
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
