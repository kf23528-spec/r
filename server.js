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

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// socket.id => player data
const players = Object.create(null);

function normalizeRoom(room) {
  return String(room || '')
    .replace(/\D/g, '')
    .slice(0, 4);
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
    playerId: id,        // 互換用
    name:      p.name      || id,
    team:      p.team      || 'blue',
    room:      p.room      || '',
    roomId:    p.room      || '',
    x:   Number.isFinite(p.x)  ? p.x  : 0,
    y:   Number.isFinite(p.y)  ? p.y  : 1.6,
    z:   Number.isFinite(p.z)  ? p.z  : 5,
    ry:  Number.isFinite(p.ry) ? p.ry : 0,
    alive:     p.alive !== false,
    matchMode: p.matchMode || 'ranked'
  };
}

function getRoomCount(room) {
  return Object.values(players).filter(p => p && p.room === room).length;
}

function emitRoomState(room) {
  if (!room) return;
  const roomPlayers = getRoomPlayers(room);
  io.to(room).emit('room-state', {
    room,
    count: Object.keys(roomPlayers).length,
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

io.on('connection', (socket) => {
  console.log(`🟢 接続: ${socket.id}`);

  players[socket.id] = {
    id: socket.id,
    name: socket.id,
    team: 'blue',
    room: '',
    x: 0, y: 1.6, z: 5, ry: 0,
    alive: true,
    matchMode: 'ranked'
  };

  // ── 部屋に入る ──
  socket.on('join-room', (data = {}) => {
    const room      = normalizeRoom(data.room);
    const name      = (data.name || socket.id).toString().slice(0, 20);
    const team      = data.team === 'red' ? 'red' : 'blue';
    const matchMode = data.matchMode || 'ranked';

    if (!room) {
      socket.emit('join-room-error', { message: 'Invalid room number' });
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
      emitRoomState(prev.room);
    }

    players[socket.id] = {
      id: socket.id,
      name,
      team,
      room,
      x:   Number.isFinite(data.x)  ? data.x  : 0,
      y:   Number.isFinite(data.y)  ? data.y  : 1.6,
      z:   Number.isFinite(data.z)  ? data.z  : 5,
      ry:  Number.isFinite(data.ry) ? data.ry : 0,
      alive: true,
      matchMode
    };

    socket.join(room);
    console.log(`📦 join-room: ${socket.id} -> room ${room} (${name})`);

    // 自分に現在の部屋情報を送る
    emitCurrentPlayers(socket, room);

    // ── newPlayer: クライアントは d.id / d.name / d.team / d.x / d.z / d.ry を直接参照 ──
    const fp = flatPlayer(socket.id, players[socket.id]);
    socket.to(room).emit('newPlayer', fp);

    // 全員に最新一覧
    socket.to(room).emit('room-players', {
      room,
      players: getRoomPlayers(room)
    });

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
      players: getRoomPlayers(room)
    });
  });

  // ── 移動同期（最重要）──
  // クライアントは playerMoved で d.id / d.x / d.y / d.z / d.ry を直接参照する
  // → フラット形式で転送する
  socket.on('playerMovement', (movementData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    // サーバー側の座標を更新
    if (Number.isFinite(movementData.x))  p.x  = movementData.x;
    if (Number.isFinite(movementData.y))  p.y  = movementData.y;
    if (Number.isFinite(movementData.z))  p.z  = movementData.z;
    if (Number.isFinite(movementData.ry)) p.ry = movementData.ry;

    // ── フラット形式で送信 ──
    // クライアントの playerMoved ハンドラが d.x / d.z / d.ry / d.id を使う
    socket.to(p.room).emit('playerMoved', flatPlayer(socket.id, p));
  });

  // ── 射撃同期 ──
  // クライアントの playerShot ハンドラ: spawnRemoteShotFX(d) → d.ox/d.oy/d.oz/d.dx/d.dy/d.dz を使う
  socket.on('playerShoot', (shotData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    // shotData に ox/oy/oz/dx/dy/dz が入っているのでそのまま転送 + id を付与
    const payload = Object.assign({}, shotData, {
      id:       socket.id,
      playerId: socket.id,
      name:     p.name,
      team:     p.team
    });

    socket.to(p.room).emit('playerShot',   payload);
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
