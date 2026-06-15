const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*", // どこからでも接続できるように許可
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const players = {};

// プレイヤーが接続してきたときの処理
io.on('connection', (socket) => {
    console.log(`🟢 プレイヤー接続: ${socket.id}`);

    // 新規プレイヤーの初期データを登録して全員に通知
    players[socket.id] = { x: 0, y: 1.6, z: 5, ry: 0 };
    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', { playerId: socket.id, playerInfo: players[socket.id] });

    // 他のプレイヤーから位置移動・視点データが送られてきたときの処理
    socket.on('playerMovement', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;
            players[socket.id].z = movementData.z;
            players[socket.id].ry = movementData.ry;
            // 自分以外の全員に位置を拡散（同期）
            socket.broadcast.emit('playerMoved', { playerId: socket.id, playerInfo: players[socket.id] });
        }
    });

    // 誰かが銃を撃ったときの処理
    socket.on('playerShoot', () => {
        // 他のプレイヤーの画面でも銃声やエフェクトを鳴らすために通知
        socket.broadcast.emit('playerShot', { playerId: socket.id });
    });

    // プレイヤーが切断したときの処理
    socket.on('disconnect', () => {
        console.log(`❌ プレイヤー切断: ${socket.id}`);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

// サーバー起動
http.listen(PORT, () => {
    console.log(`🚀 VALORANT通信サーバーがポート ${PORT} で爆速起動中！`);
});
