const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { loadWords } = require('./words');
const { GameRoom, TURN_MS } = require('./game');
const { saveMatch } = require('./db');

loadWords();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../public')));

app.get('/game/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/game.html'));
});

const games = new Map();             // roomId -> GameRoom
const queue = [];                    // [{ socketId, name }]
const disconnectTimers = new Map();  // oldSocketId -> timeout handle

// ── Helpers ────────────────────────────────────────────────────────────────

function startTurn(room) {
  if (room.timerHandle) clearTimeout(room.timerHandle);
  room.timerEndsAt = Date.now() + TURN_MS;

  room.timerHandle = setTimeout(() => {
    if (room.state !== 'playing') return;
    const current = room.getCurrentPlayer();
    finishGame(room, current.id, 'timeout');
  }, TURN_MS);
}

// Single authoritative path for ending a game: mutate state, persist, broadcast.
function finishGame(room, loserId, reason) {
  const result = room.endGame(loserId, reason);
  if (!result) return; // endGame returns null if already finished
  saveMatch(room);
  io.to(room.roomId).emit('game_over', result);
  scheduleCleanup(room.roomId);
}

function scheduleCleanup(roomId) {
  setTimeout(() => games.delete(roomId), 5 * 60 * 1000);
}

// ── Socket handlers ────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── Random matchmaking ─────────────────────────────────────────────────
  socket.on('join_random', ({ name }) => {
    name = (name || 'Anonymous').slice(0, 20);

    if (queue.length > 0 && queue[0].socketId !== socket.id) {
      const opp = queue.shift();
      const oppSocket = io.sockets.sockets.get(opp.socketId);

      const roomId = uuidv4().slice(0, 8).toUpperCase();
      const room = new GameRoom(roomId, opp.socketId, opp.name);
      room.addPlayer(socket.id, name);
      games.set(roomId, room);

      if (oppSocket) {
        oppSocket.join(roomId);
        oppSocket.data.roomId = roomId;
      }
      socket.join(roomId);
      socket.data.roomId = roomId;

      room.start();
      startTurn(room);
      io.to(roomId).emit('game_start', room.getState());
    } else {
      const existing = queue.findIndex(q => q.socketId === socket.id);
      if (existing !== -1) queue.splice(existing, 1);
      queue.push({ socketId: socket.id, name });
      socket.emit('waiting');
    }
  });

  socket.on('cancel_queue', () => {
    const idx = queue.findIndex(q => q.socketId === socket.id);
    if (idx !== -1) queue.splice(idx, 1);
  });

  // ── Private game ──────────────────────────────────────────────────────
  socket.on('create_game', ({ name }) => {
    name = (name || 'Anonymous').slice(0, 20);
    const roomId = uuidv4().slice(0, 8).toUpperCase();
    const room = new GameRoom(roomId, socket.id, name);
    games.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('game_created', { roomId });
  });

  socket.on('join_game', ({ roomId, name }) => {
    name = (name || 'Anonymous').slice(0, 20);
    roomId = (roomId || '').trim().toUpperCase();
    const room = games.get(roomId);

    if (!room) return socket.emit('join_error', { message: 'Room not found. Check the code and try again.' });

    // Reconnect by name (socket ID changed due to page navigation)
    const existing = room.players.find(p => p.name === name);
    if (existing && room.state !== 'waiting') {
      existing.id = socket.id;
      socket.join(roomId);
      socket.data.roomId = roomId;
      if (room.state === 'playing') {
        socket.emit('game_start', room.getState());
      } else {
        socket.emit('game_over', {
          winnerName: room.winnerName,
          loserName:  room.loserName,
          reason:     room.endReason,
          wordHistory: room.wordHistory,
          players:    room.players,
        });
      }
      return;
    }

    if (room.players.length >= 2) return socket.emit('join_error', { message: 'This room is already full.' });
    if (room.state !== 'waiting') return socket.emit('join_error', { message: 'Game already started.' });

    room.addPlayer(socket.id, name);
    socket.join(roomId);
    socket.data.roomId = roomId;

    room.start();
    startTurn(room);
    io.to(roomId).emit('game_start', room.getState());
  });

  // ── Sync (game page loads / reconnect after navigation) ────────────────
  socket.on('sync_game', ({ roomId, name }) => {
    roomId = (roomId || '').trim().toUpperCase();
    name = (name || 'Anonymous').slice(0, 20);
    const room = games.get(roomId);

    if (!room) return socket.emit('sync_error', { message: 'Game not found — it may have expired.' });

    socket.join(roomId);
    socket.data.roomId = roomId;

    const player = room.players.find(p => p.name === name);
    if (player) {
      const oldId = player.id;
      player.id = socket.id;
      if (disconnectTimers.has(oldId)) {
        clearTimeout(disconnectTimers.get(oldId));
        disconnectTimers.delete(oldId);
      }
    }

    if (room.state === 'waiting') {
      socket.emit('host_waiting', { roomId });
    } else if (room.state === 'playing') {
      socket.emit('game_start', room.getState());
    } else {
      socket.emit('game_over', {
        winnerName: room.winnerName,
        loserName:  room.loserName,
        reason:     room.endReason,
        wordHistory: room.wordHistory,
        players:    room.players,
      });
    }
  });

  // ── Move submission ────────────────────────────────────────────────────
  socket.on('make_move', ({ word }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = games.get(roomId);
    if (!room) return;

    const result = room.makeMove(socket.id, word);
    if (result.error) {
      return socket.emit('move_error', { error: result.error });
    }

    // Valid move: reset the authoritative server timer and broadcast new state
    startTurn(room);
    io.to(roomId).emit('game_update', room.getState());
  });

  // ── Give up ────────────────────────────────────────────────────────────
  socket.on('give_up', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = games.get(roomId);
    if (!room || room.state !== 'playing') return;
    finishGame(room, socket.id, 'forfeit');
  });

  // ── Disconnect ─────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    const qi = queue.findIndex(q => q.socketId === socket.id);
    if (qi !== -1) queue.splice(qi, 1);

    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = games.get(roomId);
    if (!room || room.state !== 'playing') return;

    // Grace period: player has 6 s to reconnect (covers landing→game navigation)
    const sid = socket.id;
    const timer = setTimeout(() => {
      if (room.state !== 'playing') return;
      const stillOwns = room.players.some(p => p.id === sid);
      if (!stillOwns) return;
      finishGame(room, sid, 'disconnect');
    }, 6000);

    disconnectTimers.set(sid, timer);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`OneLetter listening on http://localhost:${PORT}`));
