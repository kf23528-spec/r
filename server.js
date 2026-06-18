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
      lastRoundSummary: null
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
  return Object.values(players).filter(p => {
    return p &&
      p.room === roomId &&
      p.team === team &&
      p.alive !== false &&
      (p.hp ?? 100) > 0;
  }).length;
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
    roundDurationMs: ROUND_DURATION_MS
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
    cleanupRoomMetaIfEmpty(roomId);
  }

  delete players[socket.id];
}

function resetPlayersForNextRound(roomId) {
  const meta = ensureRoomMeta(roomId);
  if (!meta) return;

  applySpawnPositions(roomId);
  meta.matchStarted = true;
  meta.starting = false;
  meta.phase = 'playing';
  meta.startedAt = Date.now();
  meta.roundEndsAt = Date.now() + ROUND_DURATION_MS;

  const payload = {
    room: roomId,
    roundIndex: meta.roundIndex,
    startedAt: meta.startedAt,
    roundEndsAt: meta.roundEndsAt,
    roundDurationMs: ROUND_DURATION_MS,
    players: getRoomPlayers(roomId)
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
    roundDurationMs: ROUND_DURATION_MS
  });

  broadcastRoomSnapshot(roomId);
  emitRoomState(roomId);
}

function computeRoundWinner(roomId) {
  const blueAlive = getAliveCount(roomId, 'blue');
  const redAlive = getAliveCount(roomId, 'red');

  if (blueAlive > redAlive) return 'blue';
  if (redAlive > blueAlive) return 'red';
  return 'draw';
}

function finishRound(roomId, reason = 'round-end', forceFinal = false) {
  const meta = ensureRoomMeta(roomId);
  if (!meta) return;

  if (meta.phase === 'roundOver' && !forceFinal) return;

  clearRoomTimers(roomId);
  meta.phase = forceFinal ? 'finished' : 'roundOver';
  meta.matchStarted = !forceFinal;
  meta.roundEndsAt = 0;

  const winner = computeRoundWinner(roomId);
  const summary = {
    room: roomId,
    reason,
    winner,
    blueAlive: getAliveCount(roomId, 'blue'),
    redAlive: getAliveCount(roomId, 'red'),
    roundIndex: meta.roundIndex,
    players: getRoomPlayers(roomId)
  };

  meta.lastRoundSummary = summary;

  io.to(roomId).emit('round-ended', summary);
  io.to(roomId).emit('matchFinished', Object.assign({}, summary, {
    final: forceFinal
  }));

  emitRoomState(roomId);

  if (!forceFinal) {
    meta.roundResetTimerId = setTimeout(() => {
      const currentMeta = roomMeta[roomId];
      if (!currentMeta) return;

      currentMeta.roundIndex += 1;
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
      finishRound(roomId, 'timeout', false);
    }
  }, 500);
}

function startMatchInRoom(room, starterId) {
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

    currentMeta.starting = false;
    currentMeta.matchStarted = true;
    currentMeta.phase = 'playing';
    currentMeta.startedAt = Date.now();
    currentMeta.roundIndex = currentMeta.roundIndex || 1;
    currentMeta.roundEndsAt = Date.now() + ROUND_DURATION_MS;

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
      roundDurationMs: ROUND_DURATION_MS
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
      lastSeenAt: Date.now()
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
      phase: ensureRoomMeta(roomId).phase,
      matchStarted: ensureRoomMeta(roomId).matchStarted,
      roundIndex: ensureRoomMeta(roomId).roundIndex,
      roundEndsAt: ensureRoomMeta(roomId).roundEndsAt,
      roundDurationMs: ROUND_DURATION_MS
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
      players: getRoomPlayers(roomId)
    });
  });

  socket.on('request-start-match', (data = {}) => {
    const roomId = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!roomId) return;

    const result = startMatchInRoom(roomId, socket.id);
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

    const result = startMatchInRoom(roomId, socket.id);
    if (!result.ok) {
      socket.emit('start-match-error', {
        room: roomId,
        message: result.message
      });
    }
  });

  socket.on('playerMovement', (movementData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    if (Number.isFinite(movementData.x)) p.x = movementData.x;
    if (Number.isFinite(movementData.y)) p.y = movementData.y;
    if (Number.isFinite(movementData.z)) p.z = movementData.z;
    if (Number.isFinite(movementData.ry)) p.ry = movementData.ry;

    p.lastSeenAt = Date.now();

    const payload = flatPlayer(socket.id, p);
    socket.to(p.room).emit('playerMoved', payload);
    socket.to(p.room).emit('playerState', payload);
  });

  socket.on('playerShoot', (shotData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    const payload = Object.assign({}, shotData, {
      id: socket.id,
      playerId: socket.id,
      name: p.name,
      team: p.team,
      room: p.room
    });

    socket.to(p.room).emit('playerShot', payload);
    socket.to(p.room).emit('playerShotFX', payload);
  });

  socket.on('playerState', (stateData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    if (typeof stateData.alive === 'boolean') p.alive = stateData.alive;
    if (Number.isFinite(stateData.hp)) p.hp = stateData.hp;
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
    socket.to(p.room).emit('room-players', {
      room: p.room,
      players: getRoomPlayers(p.room)
    });
  });

  socket.on('scoreUpdate', (data = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;
    socket.to(p.room).emit('scoreUpdate', data);
  });

  socket.on('enemyKilledAck', (data = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;
    socket.to(p.room).emit('enemyKilledAck', data);
  });

  socket.on('matchFinished', (data = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    const roomId = normalizeRoom(data.room || p.room);
    if (!roomId) return;

    const meta = ensureRoomMeta(roomId);
    if (!meta) return;

    const isFinal = !!data.final || !!data.matchOver || !!data.gameOver;

    if (isFinal) {
      meta.phase = 'finished';
      meta.matchStarted = false;
      clearRoomTimers(roomId);
    } else {
      meta.phase = 'roundOver';
    }

    meta.lastRoundSummary = {
      room: roomId,
      reason: data.reason || 'matchFinished',
      winner: data.winner || computeRoundWinner(roomId),
      blueAlive: getAliveCount(roomId, 'blue'),
      redAlive: getAliveCount(roomId, 'red'),
      roundIndex: meta.roundIndex,
      players: getRoomPlayers(roomId)
    };

    socket.to(roomId).emit('matchFinished', Object.assign({}, meta.lastRoundSummary, {
      final: isFinal
    }));

    io.to(roomId).emit('round-ended', meta.lastRoundSummary);
    emitRoomState(roomId);

    if (!isFinal) {
      clearRoomTimers(roomId);
      meta.roundResetTimerId = setTimeout(() => {
        const currentMeta = roomMeta[roomId];
        if (!currentMeta) return;
        currentMeta.roundIndex += 1;
        resetPlayersForNextRound(roomId);
        currentMeta.roundResetTimerId = null;
      }, ROUND_RESET_DELAY_MS);
    }
  });

  socket.on('roundFinished', (data = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    const roomId = normalizeRoom(data.room || p.room);
    if (!roomId) return;

    const meta = ensureRoomMeta(roomId);
    if (!meta) return;

    meta.phase = 'roundOver';
    meta.lastRoundSummary = {
      room: roomId,
      reason: data.reason || 'roundFinished',
      winner: data.winner || computeRoundWinner(roomId),
      blueAlive: getAliveCount(roomId, 'blue'),
      redAlive: getAliveCount(roomId, 'red'),
      roundIndex: meta.roundIndex,
      players: getRoomPlayers(roomId)
    };

    io.to(roomId).emit('round-ended', meta.lastRoundSummary);
    io.to(roomId).emit('matchFinished', Object.assign({}, meta.lastRoundSummary, {
      final: false
    }));

    emitRoomState(roomId);

    clearRoomTimers(roomId);
    meta.roundResetTimerId = setTimeout(() => {
      const currentMeta = roomMeta[roomId];
      if (!currentMeta) return;
      currentMeta.roundIndex += 1;
      resetPlayersForNextRound(roomId);
      currentMeta.roundResetTimerId = null;
    }, ROUND_RESET_DELAY_MS);
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
