const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { loadWords, getNeighbours } = require('./words');
const { GameRoom, TURN_MS } = require('./game');
const { saveMatch } = require('./db');

loadWords();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../public')));
app.get('/game/:roomId', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/game.html')));

// ── State ──────────────────────────────────────────────────────────────────
const games           = new Map();  // roomId  -> GameRoom
const queue           = [];         // [{ socketId, name }]  — ordered waitlist
const disconnectTimers = new Map(); // socketId -> timeout handle

const BOT_ID      = '__BOT__';
const BOT_NAME    = 'OneBot 🤖';
const BOT_DELAY   = 1500;

// ── Helpers ────────────────────────────────────────────────────────────────

function isInQueue(socketId) {
  return queue.some(q => q.socketId === socketId);
}

function removeFromQueue(socketId) {
  const i = queue.findIndex(q => q.socketId === socketId);
  if (i !== -1) queue.splice(i, 1);
}

function isInActiveGame(socketId) {
  // True if this socket is a player in any room that is waiting or playing
  for (const room of games.values()) {
    if (room.state === 'finished') continue;
    if (room.players.some(p => p.id === socketId)) return true;
  }
  return false;
}

function startTurn(room) {
  if (room.timerHandle) clearTimeout(room.timerHandle);
  room.timerEndsAt = Date.now() + TURN_MS;

  room.timerHandle = setTimeout(() => {
    if (room.state !== 'playing') return;
    finishGame(room, room.getCurrentPlayer().id, 'timeout');
  }, TURN_MS);

  scheduleBotMove(room);
}

function finishGame(room, loserId, reason) {
  const result = room.endGame(loserId, reason);
  if (!result) return;
  saveMatch(room);
  io.to(room.roomId).emit('game_over', result);
  scheduleCleanup(room.roomId);
}

function scheduleCleanup(roomId) {
  setTimeout(() => games.delete(roomId), 5 * 60 * 1000);
}

function scheduleBotMove(room) {
  if (!room.isBot) return;
  if (room.state !== 'playing') return;
  if (room.getCurrentPlayer().id !== BOT_ID) return;

  setTimeout(() => {
    if (room.state !== 'playing') return;
    if (room.getCurrentPlayer().id !== BOT_ID) return;

    const played = new Set(room.wordHistory.map(h => h.word));
    const neighbours = getNeighbours(room.currentWord, played);

    if (neighbours.length === 0) {
      finishGame(room, BOT_ID, 'timeout');
      return;
    }

    const pick = neighbours[Math.floor(Math.random() * neighbours.length)];
    const res = room.makeMove(BOT_ID, pick);
    if (res.error) { finishGame(room, BOT_ID, 'timeout'); return; }

    startTurn(room);
    io.to(room.roomId).emit('game_update', room.getState());
  }, BOT_DELAY);
}

// ── Socket handlers ────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── Random matchmaking ─────────────────────────────────────────────────
  socket.on('join_random', ({ name }) => {
    name = (name || 'Anonymous').slice(0, 20);

    // Prevent joining if already queued
    if (isInQueue(socket.id)) return;

    // Prevent joining if already in an active game
    if (isInActiveGame(socket.id)) {
      return socket.emit('queue_error', { message: 'You are already in an active game.' });
    }

    // Find a waiting opponent that is not this player
    const oppIdx = queue.findIndex(q => q.socketId !== socket.id);

    if (oppIdx !== -1) {
      const opp = queue.splice(oppIdx, 1)[0];
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
      queue.push({ socketId: socket.id, name });
      socket.emit('waiting');
    }
  });

  socket.on('cancel_queue', () => {
    removeFromQueue(socket.id);
    socket.emit('queue_cancelled');
  });

  // ── Solo / bot game ────────────────────────────────────────────────────
  socket.on('play_bot', ({ name }) => {
    name = (name || 'Anonymous').slice(0, 20);
    if (isInActiveGame(socket.id)) return;

    const roomId = uuidv4().slice(0, 8).toUpperCase();
    const room = new GameRoom(roomId, socket.id, name);
    room.addPlayer(BOT_ID, BOT_NAME);
    room.isBot = true;
    games.set(roomId, room);

    socket.join(roomId);
    socket.data.roomId = roomId;

    room.start();
    startTurn(room);
    socket.emit('game_start', room.getState());
  });

  // ── Private game ──────────────────────────────────────────────────────
  socket.on('create_game', ({ name }) => {
    name = (name || 'Anonymous').slice(0, 20);
    if (isInActiveGame(socket.id)) return;

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

    // Reconnect by name
    const existing = room.players.find(p => p.name === name);
    if (existing && room.state !== 'waiting') {
      existing.id = socket.id;
      socket.join(roomId);
      socket.data.roomId = roomId;
      if (room.state === 'playing') {
        socket.emit('game_start', room.getState());
      } else {
        socket.emit('game_over', {
          winnerName:  room.winnerName,
          loserName:   room.loserName,
          reason:      room.endReason,
          wordHistory: room.wordHistory,
          players:     room.players,
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

  // ── Sync (game page reconnect after navigation) ────────────────────────
  socket.on('sync_game', ({ roomId, name }) => {
    roomId = (roomId || '').trim().toUpperCase();
    name   = (name  || 'Anonymous').slice(0, 20);
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
        winnerName:  room.winnerName,
        loserName:   room.loserName,
        reason:      room.endReason,
        wordHistory: room.wordHistory,
        players:     room.players,
        rematchReady: [...room.rematchReady],
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
    if (result.error) return socket.emit('move_error', { error: result.error });

    startTurn(room);
    io.to(roomId).emit('game_update', room.getState());
  });

  // ── Give up ────────────────────────────────────────────────────────────
  socket.on('give_up', () => {
    const room = games.get(socket.data.roomId);
    if (!room || room.state !== 'playing') return;
    finishGame(room, socket.id, 'forfeit');
  });

  // ── Rematch ────────────────────────────────────────────────────────────
  socket.on('rematch_request', () => {
    const room = games.get(socket.data.roomId);
    if (!room || room.state !== 'finished') return;

    // Bot game: restart immediately, no need for opponent consent
    if (room.isBot) {
      room.rematch();
      startTurn(room);
      socket.emit('game_start', room.getState());
      return;
    }

    room.rematchReady.add(socket.id);

    // Tell the room how many have accepted so the UI can update
    io.to(room.roomId).emit('rematch_status', {
      readyIds: [...room.rematchReady],
      needed:   2,
    });

    // Both players agreed — start rematch
    if (room.rematchReady.size >= 2) {
      room.rematch();
      startTurn(room);
      io.to(room.roomId).emit('game_start', room.getState());
    }
  });

  // ── Disconnect ─────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    removeFromQueue(socket.id);

    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = games.get(roomId);
    if (!room || room.state !== 'playing') return;

    const sid = socket.id;
    const timer = setTimeout(() => {
      if (room.state !== 'playing') return;
      if (!room.players.some(p => p.id === sid)) return;
      finishGame(room, sid, 'disconnect');
    }, 6000);

    disconnectTimers.set(sid, timer);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`OneLetter listening on http://localhost:${PORT}`));
