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

// 静的ファイル配信
app.use(express.static(__dirname));

// トップページ
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

function getRoomPlayers(room) {
  const result = Object.create(null);
  for (const [id, p] of Object.entries(players)) {
    if (p && p.room === room) {
      result[id] = {
        id,
        name: p.name || id,
        team: p.team || 'blue',
        room: p.room,
        roomId: p.room,
        x: Number.isFinite(p.x) ? p.x : 0,
        y: Number.isFinite(p.y) ? p.y : 1.6,
        z: Number.isFinite(p.z) ? p.z : 5,
        ry: Number.isFinite(p.ry) ? p.ry : 0,
        alive: p.alive !== false,
        matchMode: p.matchMode || 'ranked'
      };
    }
  }
  return result;
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

    // ルーム内の他人に通知
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

  // まずは未入室の状態
  players[socket.id] = {
    id: socket.id,
    name: socket.id,
    team: 'blue',
    room: '',
    roomId: '',
    x: 0,
    y: 1.6,
    z: 5,
    ry: 0,
    alive: true,
    matchMode: 'ranked'
  };

  // 部屋に入る
  socket.on('join-room', (data = {}) => {
    const room = normalizeRoom(data.room);
    const name = (data.name || socket.id).toString().slice(0, 20);
    const team = (data.team === 'red' ? 'red' : 'blue');
    const matchMode = data.matchMode || 'ranked';

    if (!room) {
      socket.emit('join-room-error', { message: 'Invalid room number' });
      return;
    }

    // 既存の部屋があれば抜ける
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

    // 登録
    players[socket.id] = {
      id: socket.id,
      name,
      team,
      room,
      roomId: room,
      x: Number.isFinite(data.x) ? data.x : 0,
      y: Number.isFinite(data.y) ? data.y : 1.6,
      z: Number.isFinite(data.z) ? data.z : 5,
      ry: Number.isFinite(data.ry) ? data.ry : 0,
      alive: true,
      matchMode
    };

    socket.join(room);

    console.log(`📦 join-room: ${socket.id} -> room ${room} (${name})`);

    // 自分へ現在の部屋情報を送る
    emitCurrentPlayers(socket, room);

    // 部屋の他人へ新規参加を通知
    socket.to(room).emit('newPlayer', {
      id: socket.id,
      playerId: socket.id,
      name,
      team,
      room,
      roomId: room,
      alive: true,
      playerInfo: {
        id: socket.id,
        name,
        team,
        room,
        roomId: room,
        x: players[socket.id].x,
        y: players[socket.id].y,
        z: players[socket.id].z,
        ry: players[socket.id].ry,
        alive: true,
        matchMode
      }
    });

    // 部屋全体へ最新一覧を送る
    socket.to(room).emit('room-players', {
      room,
      players: getRoomPlayers(room)
    });

    // room-state も送る
    emitRoomState(room);
  });

  // 部屋メンバー一覧を要求されたら返す
  socket.on('request-room-players', (data = {}) => {
    const room = normalizeRoom(data.room || (players[socket.id] && players[socket.id].room));
    if (!room) return;
    emitCurrentPlayers(socket, room);
  });

  // 互換用
  socket.on('get-room', (data = {}) => {
    const room = normalizeRoom(data.room || (players[socket.id] && players[socket.id].room));
    if (!room) return;
    socket.emit('room-state', {
      room,
      count: getRoomCount(room),
      players: getRoomPlayers(room)
    });
  });

  // 移動同期
  socket.on('playerMovement', (movementData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    if (Number.isFinite(movementData.x)) p.x = movementData.x;
    if (Number.isFinite(movementData.y)) p.y = movementData.y;
    if (Number.isFinite(movementData.z)) p.z = movementData.z;
    if (Number.isFinite(movementData.ry)) p.ry = movementData.ry;

    socket.to(p.room).emit('playerMoved', {
      playerId: socket.id,
      playerInfo: {
        id: socket.id,
        name: p.name,
        team: p.team,
        room: p.room,
        roomId: p.room,
        x: p.x,
        y: p.y,
        z: p.z,
        ry: p.ry,
        alive: p.alive !== false,
        matchMode: p.matchMode || 'ranked'
      }
    });
  });

  // 射撃同期
  socket.on('playerShoot', (shotData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    socket.to(p.room).emit('playerShot', {
      playerId: socket.id,
      playerInfo: {
        id: socket.id,
        name: p.name,
        team: p.team,
        room: p.room,
        roomId: p.room,
        x: p.x,
        y: p.y,
        z: p.z,
        ry: p.ry,
        alive: p.alive !== false,
        matchMode: p.matchMode || 'ranked'
      },
      shotData
    });

    // client 側が playerShot / playerShotFX のどちらを見ても大丈夫なように
    socket.to(p.room).emit('playerShotFX', {
      playerId: socket.id,
      shotData
    });
  });

  // 任意: 生存状態などを更新したい時用
  socket.on('playerState', (stateData = {}) => {
    const p = players[socket.id];
    if (!p || !p.room) return;

    if (typeof stateData.alive === 'boolean') p.alive = stateData.alive;
    socket.to(p.room).emit('playerState', {
      playerId: socket.id,
      playerInfo: {
        id: socket.id,
        name: p.name,
        team: p.team,
        room: p.room,
        roomId: p.room,
        x: p.x,
        y: p.y,
        z: p.z,
        ry: p.ry,
        alive: p.alive !== false,
        matchMode: p.matchMode || 'ranked'
      }
    });
  });

  // 明示的に部屋を抜ける
  socket.on('leave-room', () => {
    leaveRoom(socket);
  });

  // 切断
  socket.on('disconnect', () => {
    console.log(`❌ 切断: ${socket.id}`);
    leaveRoom(socket);
  });
});

// 起動
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
