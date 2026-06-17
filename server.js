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

app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// socket.id => player data
const players = Object.create(null);
// roomId => meta
const roomMeta = Object.create(null);

function normalizeRoom(room) {
  const s = String(room ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');

  return s.slice(0, 12);
}

function ensureRoomMeta(room) {
  const roomId = normalizeRoom(room);
  if (!roomId) return null;

  if (!roomMeta[roomId]) {
    roomMeta[roomId] = {
      starting: false,
      matchStarted: false,
      startedAt: 0,
      lastStarter: '',
      startToken: 0
    };
  }
  return roomMeta[roomId];
}

function cleanupRoomMetaIfEmpty(room) {
  const roomId = normalizeRoom(room);
  if (!roomId) return;

  if (getRoomCount(roomId) === 0) {
    delete roomMeta[roomId];
  }
}

function safeNum(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
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
    matchMode: p.matchMode || 'ranked'
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

function getRoomCount(room) {
  const roomId = normalizeRoom(room);
  return Object.values(players).filter(p => p && p.room === roomId).length;
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
      io.to(roomId).emit('match-start-cancelled', {
        room: roomId,
        message: 'Players left before start'
      });
      emitRoomState(roomId);
      return;
    }

    const teams = assignRandomTeams(roomId);
    currentMeta.starting = false;
    currentMeta.matchStarted = true;
    currentMeta.startedAt = Date.now();

    const payload = {
      room: roomId,
      teams,
      players: getRoomPlayers(roomId),
      startedBy: starterId || '',
      startedAt: currentMeta.startedAt
    };

    io.to(roomId).emit('match-started', payload);

    broadcastRoomPlayers(roomId);
    emitRoomState(roomId);
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
    matchMode: 'ranked'
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
      matchMode
    };

    socket.join(roomId);
    console.log(`📦 join-room: ${socket.id} -> room ${roomId} (${name})`);

    emitCurrentPlayers(socket, roomId);

    const fp = flatPlayer(socket.id, players[socket.id]);
    socket.to(roomId).emit('newPlayer', fp);

    broadcastRoomPlayers(roomId);
    emitRoomState(roomId);
  });

  socket.on('request-room-players', (data = {}) => {
    const roomId = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!roomId) return;
    emitCurrentPlayers(socket, roomId);
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

    socket.to(p.room).emit('playerMoved', flatPlayer(socket.id, p));
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

    socket.to(p.room).emit(
      'playerState',
      Object.assign(flatPlayer(socket.id, p), {
        playerId: socket.id,
        targetId: socket.id
      })
    );
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
    meta.matchStarted = false;
    meta.starting = false;

    socket.to(roomId).emit('matchFinished', data);
    emitRoomState(roomId);
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
