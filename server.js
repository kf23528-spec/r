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

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// socket.id => player data
const players = Object.create(null);
// room => meta
const roomMeta = Object.create(null);

function normalizeRoom(room) {
  return String(room || '')
    .replace(/\D/g, '')
    .slice(0, 4);
}

function ensureRoomMeta(room) {
  const r = normalizeRoom(room);
  if (!roomMeta[r]) {
    roomMeta[r] = {
      starting: false,
      matchStarted: false,
      startedAt: 0,
      lastStarter: ''
    };
  }
  return roomMeta[r];
}

/**
 * ルーム内の全プレイヤーをフラット形式で返す
 * クライアントは d.x / d.y / d.z / d.ry / d.id / d.name / d.team を直接参照する
 */
function getRoomPlayers(room) {
  const result = Object.create(null);
  for (const [id, p] of Object.entries(players)) {
    if (p && p.room === room) {
      result[id] = flatPlayer(id, p);
    }
  }
  return result;
}

/** プレイヤーデータをクライアントが期待するフラット形式に変換 */
function flatPlayer(id, p) {
  return {
    id,
    playerId: id,
    name: p.name || id,
    team: p.team || 'blue',
    room: p.room || '',
    roomId: p.room || '',
    x: Number.isFinite(p.x) ? p.x : 0,
    y: Number.isFinite(p.y) ? p.y : 1.6,
    z: Number.isFinite(p.z) ? p.z : 5,
    ry: Number.isFinite(p.ry) ? p.ry : 0,
    alive: p.alive !== false,
    matchMode: p.matchMode || 'ranked'
  };
}

function getRoomCount(room) {
  return Object.values(players).filter(p => p && p.room === room).length;
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
  if (!room) return;

  const roomId = normalizeRoom(room);
  const meta = ensureRoomMeta(roomId);
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
  const roomPlayers = getRoomPlayers(room);
  socket.emit('currentPlayers', roomPlayers);
  socket.emit('room-players', {
    room,
    players: roomPlayers
  });
}

function broadcastRoomPlayers(room) {
  io.to(room).emit('room-players', {
    room,
    players: getRoomPlayers(room)
  });
}

function leaveRoom(socket) {
  const p = players[socket.id];
  if (!p) return;

  const room = p.room;
  if (room) {
    socket.leave(room);
    socket.to(room).emit('playerDisconnected', socket.id);
    socket.to(room).emit('room-players', {
      room,
      players: getRoomPlayers(room)
    });
    emitRoomState(room);
  }

  delete players[socket.id];
}

function assignRandomTeams(room) {
  const ids = Object.entries(players)
    .filter(([, p]) => p && p.room === room)
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

function startMatchInRoom(room, starterId) {
  const roomId = normalizeRoom(room);
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

  io.to(roomId).emit('match-starting', {
    room: roomId,
    startedBy: starterId || '',
    count
  });

  emitRoomState(roomId);

  setTimeout(() => {
    const nowCount = getRoomCount(roomId);
    if (nowCount < START_MIN_PLAYERS) {
      meta.starting = false;
      meta.matchStarted = false;
      io.to(roomId).emit('match-start-cancelled', {
        room: roomId,
        message: 'Players left before start'
      });
      emitRoomState(roomId);
      return;
    }

    const teams = assignRandomTeams(roomId);
    meta.starting = false;
    meta.matchStarted = true;
    meta.startedAt = Date.now();

    const payload = {
      room: roomId,
      teams,
      players: getRoomPlayers(roomId),
      startedBy: starterId || '',
      startedAt: meta.startedAt
    };

    // 互換性のため複数イベントを送る
    io.to(roomId).emit('match-started', payload);
    io.to(roomId).emit('start-match', payload);
    io.to(roomId).emit('game-start', payload);

    broadcastRoomPlayers(roomId);
    emitRoomState(roomId);
  }, 1800);

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
    matchMode: 'ranked'
  };

  // ── 部屋に入る ──
  socket.on('join-room', (data = {}) => {
    const room = normalizeRoom(data.room);
    const name = (data.name || socket.id).toString().slice(0, 20);
    const matchMode = data.matchMode || 'ranked';

    if (!room) {
      socket.emit('join-room-error', { message: 'Invalid room number' });
      return;
    }

    const countNow = getRoomCount(room);
    const prev = players[socket.id];

    // 前の部屋から抜ける
    if (prev && prev.room && prev.room !== room) {
      socket.leave(prev.room);
      socket.to(prev.room).emit('playerDisconnected', socket.id);
      socket.to(prev.room).emit('room-players', {
        room: prev.room,
        players: getRoomPlayers(prev.room)
      });
      emitRoomState(prev.room);
    }

    // 最大8人制限
    if ((!prev || prev.room !== room) && countNow >= MAX_PLAYERS) {
      socket.emit('join-room-error', {
        message: 'Room is full (max 8 players)'
      });
      return;
    }

    // room初期化
    ensureRoomMeta(room);

    players[socket.id] = {
      id: socket.id,
      name,
      team: 'blue',
      room,
      x: Number.isFinite(data.x) ? data.x : 0,
      y: Number.isFinite(data.y) ? data.y : 1.6,
      z: Number.isFinite(data.z) ? data.z : 5,
      ry: Number.isFinite(data.ry) ? data.ry : 0,
      alive: true,
      matchMode
    };

    socket.join(room);
    console.log(`📦 join-room: ${socket.id} -> room ${room} (${name})`);

    // 自分に現在の部屋情報を送る
    emitCurrentPlayers(socket, room);

    // 新規プレイヤー通知
    const fp = flatPlayer(socket.id, players[socket.id]);
    socket.to(room).emit('newPlayer', fp);

    // 全員に最新一覧
    broadcastRoomPlayers(room);

    emitRoomState(room);
  });

  // ── 部屋メンバー要求 ──
  socket.on('request-room-players', (data = {}) => {
    const room = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!room) return;
    emitCurrentPlayers(socket, room);
  });

  // ── 互換用 ──
  socket.on('get-room', (data = {}) => {
    const room = normalizeRoom(
      data.room || (players[socket.id] && players[socket.id].room)
    );
    if (!room) return;
    socket.emit('room-state', {
      room,
      count: getRoomCount(room),
      maxPlayers: MAX_PLAYERS,
      canStart: getRoomCount(room) >= START_MIN_PLAYERS,
      starting: ensureRoomMeta(room).starting,
      matchStarted: ensureRoomMeta(room).matchStarted,
      players: getRoomPlayers(room)
    });
  });

  // ── 出撃ボタン押下 ──
  // 誰が押してもOK
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

  // ── 旧イベント名互換 ──
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

  // ── 移動同期（最重要）──
  socket.on('playerMovement', (movementData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    if (Number.isFinite(movementData.x)) p.x = movementData.x;
    if (Number.isFinite(movementData.y)) p.y = movementData.y;
    if (Number.isFinite(movementData.z)) p.z = movementData.z;
    if (Number.isFinite(movementData.ry)) p.ry = movementData.ry;

    socket.to(p.room).emit('playerMoved', flatPlayer(socket.id, p));
  });

  // ── 射撃同期 ──
  socket.on('playerShoot', (shotData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    const payload = Object.assign({}, shotData, {
      id: socket.id,
      playerId: socket.id,
      name: p.name,
      team: p.team
    });

    socket.to(p.room).emit('playerShot', payload);
    socket.to(p.room).emit('playerShotFX', payload);
  });

  // ── 生存状態更新 ──
  socket.on('playerState', (stateData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    if (typeof stateData.alive === 'boolean') p.alive = stateData.alive;

    socket.to(p.room).emit(
      'playerState',
      Object.assign(flatPlayer(socket.id, p), {
        playerId: socket.id
      })
    );
  });

  // ── 明示的に部屋を抜ける ──
  socket.on('leave-room', () => {
    leaveRoom(socket);
  });

  // ── 切断 ──
  socket.on('disconnect', () => {
    console.log(`❌ 切断: ${socket.id}`);
    leaveRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
