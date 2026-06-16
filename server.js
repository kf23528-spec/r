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
const WIN_SCORE = 5;
const MAX_PLAYERS_PER_ROOM = 8;
const MIN_PLAYERS_TO_START = 2;

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// socket.id => player data
const players = Object.create(null);
// room => room data
const rooms = Object.create(null);

function normalizeRoom(room) {
  return String(room || '')
    .replace(/\D/g, '')
    .slice(0, 4);
}

function ensureRoom(room) {
  if (!rooms[room]) {
    rooms[room] = {
      started: false,
      finished: false,
      starterId: null,
      startedAt: null,
      finishedAt: null,
      scores: { blue: 0, red: 0 }
    };
  }
  return rooms[room];
}

function resetRoomState(room) {
  const r = ensureRoom(room);
  r.started = false;
  r.finished = false;
  r.starterId = null;
  r.startedAt = null;
  r.finishedAt = null;
  r.scores.blue = 0;
  r.scores.red = 0;
  return r;
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
    playerId: id, // 互換用
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

function getRoomIds(room) {
  return Object.entries(players)
    .filter(([, p]) => p && p.room === room)
    .map(([id]) => id);
}

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function assignRandomTeams(room) {
  const ids = shuffle(getRoomIds(room));
  if (ids.length === 0) return;

  const splitIndex = Math.ceil(ids.length / 2);
  const blueIds = ids.slice(0, splitIndex);
  const redIds = ids.slice(splitIndex);

  for (const id of blueIds) {
    if (players[id]) players[id].team = 'blue';
  }
  for (const id of redIds) {
    if (players[id]) players[id].team = 'red';
  }
}

function emitRoomState(room) {
  if (!room) return;

  const roomPlayers = getRoomPlayers(room);
  const count = Object.keys(roomPlayers).length;
  const roomState = ensureRoom(room);

  io.to(room).emit('room-state', {
    room,
    count,
    started: roomState.started,
    finished: roomState.finished,
    canStart: !roomState.started && count >= MIN_PLAYERS_TO_START && count <= MAX_PLAYERS_PER_ROOM,
    starterId: roomState.starterId,
    startedAt: roomState.startedAt,
    scores: roomState.scores,
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    minPlayers: MIN_PLAYERS_TO_START,
    players: roomPlayers
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

function emitScoreUpdate(room) {
  const roomState = ensureRoom(room);
  io.to(room).emit('scoreUpdate', {
    room,
    blue: roomState.scores.blue,
    red: roomState.scores.red,
    scores: {
      blue: roomState.scores.blue,
      red: roomState.scores.red
    },
    winScore: WIN_SCORE
  });
}

function finishMatch(room, winnerTeam) {
  const roomState = ensureRoom(room);
  if (roomState.finished) return;

  roomState.finished = true;
  roomState.finishedAt = Date.now();

  const payload = {
    room,
    winnerTeam,
    winner: winnerTeam,
    blue: roomState.scores.blue,
    red: roomState.scores.red,
    scores: {
      blue: roomState.scores.blue,
      red: roomState.scores.red
    },
    winScore: WIN_SCORE,
    finishedAt: roomState.finishedAt
  };

  io.to(room).emit('matchFinished', payload);
  io.to(room).emit('gameFinished', payload); // 互換
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

    const count = getRoomCount(room);
    if (count <= 0) {
      delete rooms[room];
    } else {
      emitRoomState(room);
    }
  }

  delete players[socket.id];
}

function beginMatch(room, starterId) {
  const roomState = ensureRoom(room);
  const count = getRoomCount(room);

  if (roomState.started) {
    return { ok: false, reason: 'already-started' };
  }
  if (count < MIN_PLAYERS_TO_START) {
    return { ok: false, reason: 'not-enough-players' };
  }
  if (count > MAX_PLAYERS_PER_ROOM) {
    return { ok: false, reason: 'too-many-players' };
  }

  // ランダムチーム割り当て
  assignRandomTeams(room);

  // 生存状態とスコア初期化
  const ids = getRoomIds(room);
  for (const id of ids) {
    if (players[id]) {
      players[id].alive = true;
    }
  }

  roomState.started = true;
  roomState.finished = false;
  roomState.starterId = starterId || null;
  roomState.startedAt = Date.now();
  roomState.finishedAt = null;
  roomState.scores.blue = 0;
  roomState.scores.red = 0;

  const roomPlayers = getRoomPlayers(room);
  const payload = {
    room,
    starterId: roomState.starterId,
    startedAt: roomState.startedAt,
    scores: {
      blue: 0,
      red: 0
    },
    winScore: WIN_SCORE,
    players: roomPlayers
  };

  // 互換性のため複数イベント名で送信
  io.to(room).emit('matchStarted', payload);
  io.to(room).emit('gameStarted', payload);
  io.to(room).emit('startMatch', payload);
  io.to(room).emit('game-start', payload);

  emitScoreUpdate(room);
  emitRoomState(room);

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

    const currentCount = getRoomCount(room);
    const alreadyInThisRoom = players[socket.id] && players[socket.id].room === room;

    if (!alreadyInThisRoom && currentCount >= MAX_PLAYERS_PER_ROOM) {
      socket.emit('join-room-error', { message: 'Room is full' });
      socket.emit('room-full', {
        room,
        maxPlayers: MAX_PLAYERS_PER_ROOM
      });
      return;
    }

    // 前の部屋から抜ける
    const prev = players[socket.id];
    if (prev && prev.room && prev.room !== room) {
      socket.leave(prev.room);
      socket.to(prev.room).emit('playerDisconnected', socket.id);
      socket.to(prev.room).emit('room-players', {
        room: prev.room,
        players: getRoomPlayers(prev.room)
      });

      const prevCount = getRoomCount(prev.room);
      if (prevCount <= 0) {
        delete rooms[prev.room];
      } else {
        emitRoomState(prev.room);
      }
    }

    // 既存部屋を作成
    ensureRoom(room);

    players[socket.id] = {
      id: socket.id,
      name,
      team: Math.random() < 0.5 ? 'blue' : 'red',
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

    // 追加された直後の自分のデータを送る
    const fp = flatPlayer(socket.id, players[socket.id]);
    socket.to(room).emit('newPlayer', fp);

    // 全員に最新一覧
    socket.to(room).emit('room-players', {
      room,
      players: getRoomPlayers(room)
    });

    emitRoomState(room);
  });

  // ── 手動開始要求 ──
  const startRequestHandler = () => {
    const p = players[socket.id];
    if (!p || !p.room) {
      socket.emit('startDenied', { reason: 'not-in-room' });
      return;
    }

    const room = p.room;
    const result = beginMatch(room, socket.id);

    if (!result.ok) {
      socket.emit('startDenied', {
        room,
        reason: result.reason
      });
    }
  };

  socket.on('request-start', startRequestHandler);
  socket.on('startMatch', startRequestHandler);
  socket.on('manualStart', startRequestHandler);
  socket.on('begin-game', startRequestHandler);
  socket.on('start-game', startRequestHandler);
  socket.on('startGame', startRequestHandler);
  socket.on('beginMatch', startRequestHandler);

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
    const r = ensureRoom(room);
    socket.emit('room-state', {
      room,
      count: getRoomCount(room),
      started: r.started,
      finished: r.finished,
      canStart: !r.started && getRoomCount(room) >= MIN_PLAYERS_TO_START && getRoomCount(room) <= MAX_PLAYERS_PER_ROOM,
      starterId: r.starterId,
      scores: r.scores,
      players: getRoomPlayers(room)
    });
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

    socket.to(p.room).emit('playerState', Object.assign(
      flatPlayer(socket.id, p),
      { playerId: socket.id }
    ));
  });

  // ── 敵撃破報告（ボット撃破） ──
  socket.on('enemyKilled', (data = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    const room = p.room;
    const roomState = ensureRoom(room);
    if (!roomState.started || roomState.finished) return;

    const team = data.team === 'red' ? 'red' : 'blue';
    roomState.scores[team] = (roomState.scores[team] || 0) + 1;

    emitScoreUpdate(room);

    if (roomState.scores[team] >= WIN_SCORE) {
      finishMatch(room, team);
    }
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
