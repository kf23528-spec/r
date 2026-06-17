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

const players = Object.create(null);   // socket.id -> player
const roomMeta = Object.create(null);   // roomId -> meta

function normalizeRoom(room) {
  const s = String(room ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');

  return s;
}

function isValidRoom(room) {
  return /^(\d{4}|R\d{4})$/.test(room);
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
      startToken: 0,
      timer: null
    };
  }
  return roomMeta[roomId];
}

function deleteRoomMetaIfEmpty(room) {
  const roomId = normalizeRoom(room);
  if (!roomId) return;

  if (getRoomCount(roomId) === 0) {
    const meta = roomMeta[roomId];
    if (meta && meta.timer) {
      clearTimeout(meta.timer);
      meta.timer = null;
    }
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
  const count = getRoomCount(roomId);

  if (count < START_MIN_PLAYERS) {
    meta.starting = false;
  }

  io.to(roomId).emit('room-state', {
    room: roomId,
    count,
    maxPlayers: MAX_PLAYERS,
    canStart: count >= START_MIN_PLAYERS && count <= MAX_PLAYERS && !meta.starting && !meta.matchStarted,
    starting: meta.starting,
    matchStarted: meta.matchStarted,
    players: getRoomPlayers(roomId)
  });
}

function emitCurrentPlayers(socket, room) {
  const roomId = normalizeRoom(room);
  const roomPlayers = getRoomPlayers(roomId);

  socket.emit('currentPlayers', roomPlayers);
  socket.emit('room-players', {
    room: roomId,
    players: roomPlayers
  });
}

function broadcastRoomPlayers(room) {
  const roomId = normalizeRoom(room);
  io.to(roomId).emit('room-players', {
    room: roomId,
    players: getRoomPlayers(roomId)
  });
}

function leaveRoom(socket) {
  const p = players[socket.id];
  if (!p) return;

  const room = normalizeRoom(p.room);
  if (room) {
    socket.leave(room);
    socket.to(room).emit('playerDisconnected', {
      id: socket.id,
      playerId: socket.id,
      room
    });

    socket.to(room).emit('room-players', {
      room,
      players: getRoomPlayers(room)
    });

    emitRoomState(room);
    deleteRoomMetaIfEmpty(room);
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
  const redCount = ids.length - blueCount;

  ids.forEach((id, index) => {
    players[id].team = index < blueCount ? 'blue' : 'red';
  });

  return {
    blue: ids.slice(0, blueCount),
    red: ids.slice(blueCount, blueCount + redCount)
  };
}

function finishMatch(room) {
  const roomId = normalizeRoom(room);
  const meta = roomMeta[roomId];
  if (!meta) return;

  meta.starting = false;
  meta.matchStarted = false;
  meta.startedAt = 0;
  meta.lastStarter = '';
  meta.startToken += 1;

  if (meta.timer) {
    clearTimeout(meta.timer);
    meta.timer = null;
  }

  emitRoomState(roomId);
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
  if (meta.matchStarted) {
    return { ok: false, message: 'Match already running' };
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

  meta.timer = setTimeout(() => {
    const currentMeta = roomMeta[roomId];
    if (!currentMeta || currentMeta.startToken !== token) {
      return;
    }

    const nowCount = getRoomCount(roomId);
    if (nowCount < START_MIN_PLAYERS) {
      currentMeta.starting = false;
      currentMeta.matchStarted = false;
      currentMeta.startedAt = 0;

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

    // ここは1回だけ。二重開始の原因になりやすい game-start は送らない。
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
    const room = normalizeRoom(data.room);
    const name = String(data.name || socket.id).slice(0, 20);
    const matchMode = data.matchMode || 'ranked';

    if (!room || !isValidRoom(room)) {
      socket.emit('join-room-error', { message: 'Invalid room number' });
      return;
    }

    const prev = players[socket.id];
    const prevRoom = prev ? normalizeRoom(prev.room) : '';

    if (prevRoom && prevRoom !== room) {
      socket.leave(prevRoom);
      socket.to(prevRoom).emit('playerDisconnected', {
        id: socket.id,
        playerId: socket.id,
        room: prevRoom
      });
      socket.to(prevRoom).emit('room-players', {
        room: prevRoom,
        players: getRoomPlayers(prevRoom)
      });
      emitRoomState(prevRoom);
      deleteRoomMetaIfEmpty(prevRoom);
    }

    if ((!prevRoom || prevRoom !== room) && getRoomCount(room) >= MAX_PLAYERS) {
      socket.emit('join-room-error', {
        message: 'Room is full (max 8 players)'
      });
      return;
    }

    ensureRoomMeta(room);

    players[socket.id] = {
      id: socket.id,
      name,
      team: 'blue',
      room,
      x: safeNum(data.x, 0),
      y: safeNum(data.y, 1.6),
      z: safeNum(data.z, 5),
      ry: safeNum(data.ry, 0),
      alive: true,
      hp: safeNum(data.hp, 100),
      matchMode
    };

    socket.join(room);

    console.log(`📦 join-room: ${socket.id} -> room ${room} (${name})`);

    emitCurrentPlayers(socket, room);

    const fp = flatPlayer(socket.id, players[socket.id]);
    socket.to(room).emit('newPlayer', fp);

    broadcastRoomPlayers(room);
    emitRoomState(room);
  });

  socket.on('request-room-players', (data = {}) => {
    const room = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!room) return;

    emitCurrentPlayers(socket, room);
  });

  socket.on('get-room', (data = {}) => {
    const room = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!room) return;

    const meta = ensureRoomMeta(room);
    socket.emit('room-state', {
      room,
      count: getRoomCount(room),
      maxPlayers: MAX_PLAYERS,
      canStart: getRoomCount(room) >= START_MIN_PLAYERS && !meta.starting && !meta.matchStarted,
      starting: meta.starting,
      matchStarted: meta.matchStarted,
      players: getRoomPlayers(room)
    });
  });

  socket.on('request-start-match', (data = {}) => {
    const room = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!room) return;

    const result = startMatchInRoom(room, socket.id);
    if (!result.ok) {
      socket.emit('start-match-error', {
        room,
        message: result.message
      });
    }
  });

  socket.on('start-match', (data = {}) => {
    const room = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!room) return;

    const result = startMatchInRoom(room, socket.id);
    if (!result.ok) {
      socket.emit('start-match-error', {
        room,
        message: result.message
      });
    }
  });

  socket.on('playerMovement', (movementData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    if (movementData.room && normalizeRoom(movementData.room) !== p.room) return;

    if (Number.isFinite(movementData.x)) p.x = movementData.x;
    if (Number.isFinite(movementData.y)) p.y = movementData.y;
    if (Number.isFinite(movementData.z)) p.z = movementData.z;
    if (Number.isFinite(movementData.ry)) p.ry = movementData.ry;
    if (Number.isFinite(movementData.hp)) p.hp = movementData.hp;
    if (typeof movementData.alive === 'boolean') p.alive = movementData.alive;

    socket.to(p.room).emit('playerMoved', flatPlayer(socket.id, p));
  });

  socket.on('playerShoot', (shotData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    if (shotData.room && normalizeRoom(shotData.room) !== p.room) return;

    const payload = Object.assign({}, shotData, {
      id: socket.id,
      playerId: socket.id,
      targetId: socket.id,
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

    if (stateData.room && normalizeRoom(stateData.room) !== p.room) return;

    if (typeof stateData.alive === 'boolean') p.alive = stateData.alive;
    if (Number.isFinite(stateData.hp)) p.hp = stateData.hp;
    if (Number.isFinite(stateData.x)) p.x = stateData.x;
    if (Number.isFinite(stateData.y)) p.y = stateData.y;
    if (Number.isFinite(stateData.z)) p.z = stateData.z;
    if (Number.isFinite(stateData.ry)) p.ry = stateData.ry;

    socket.to(p.room).emit('playerState', Object.assign(flatPlayer(socket.id, p), {
      playerId: socket.id,
      targetId: socket.id
    }));
  });

  socket.on('scoreUpdate', (data = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    const room = normalizeRoom(data.room || p.room);
    if (room !== p.room) return;

    io.to(room).emit('scoreUpdate', Object.assign({}, data, { room }));
  });

  socket.on('enemyKilledAck', (data = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    const room = normalizeRoom(data.room || p.room);
    if (room !== p.room) return;

    io.to(room).emit('enemyKilledAck', Object.assign({}, data, { room }));
  });

  socket.on('matchFinished', (data = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    const room = normalizeRoom(data.room || p.room);
    if (room !== p.room) return;

    finishMatch(room);
    io.to(room).emit('matchFinished', Object.assign({}, data, { room }));
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
