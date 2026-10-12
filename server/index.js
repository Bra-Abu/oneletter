const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { loadWords, getNeighbours } = require('./words');
const { GameRoom, TURN_MS } = require('./game');
const { saveMatch, updateStats, getPlayerStats, getLeaderboard } = require('./db');

loadWords();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../public')));
app.get('/game/:roomId', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/game.html')));

app.get('/api/online', (req, res) => {
  if (!httpRL(req, res, 60, 60000)) return;
  res.json({ count: io.engine.clientsCount });
});

app.get('/api/stats', (req, res) => {
  if (!httpRL(req, res, 30, 60000)) return;
  const { token } = req.query;
  if (!token) return res.json(null);
  res.json(getPlayerStats(token));
});

app.get('/api/leaderboard', (req, res) => {
  if (!httpRL(req, res, 30, 60000)) return;
  res.json(getLeaderboard());
});

app.get('/leaderboard', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/leaderboard.html')));

// ── Rate limiting ──────────────────────────────────────────────────────────

// Per-socket limiter: returns false if the socket has exceeded max calls
// within windowMs for the given event name.
function socketRL(socket, event, max, windowMs) {
  const now = Date.now();
  if (!socket.data._rl) socket.data._rl = {};
  let r = socket.data._rl[event];
  if (!r || now > r.reset) r = { count: 0, reset: now + windowMs };
  r.count++;
  socket.data._rl[event] = r;
  return r.count <= max;
}

// Per-IP HTTP limiter
const _ipLimits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of _ipLimits) if (now > r.reset) _ipLimits.delete(k);
}, 60000);

function httpRL(req, res, max = 60, windowMs = 60000) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let r = _ipLimits.get(ip);
  if (!r || now > r.reset) r = { count: 0, reset: now + windowMs };
  r.count++;
  _ipLimits.set(ip, r);
  if (r.count > max) { res.status(429).json({ error: 'Too many requests' }); return false; }
  return true;
}

// ── State ──────────────────────────────────────────────────────────────────
const games            = new Map();  // roomId  -> GameRoom
const queue            = [];         // [{ socketId, name, token }]
const disconnectTimers = new Map();  // socketId -> timeout handle

const BOT_ID    = '__BOT__';
const BOT_NAME  = 'Tuff 🤖';
const BOT_DELAY = 1500;

// ── Helpers ────────────────────────────────────────────────────────────────

function isInQueue(socketId) {
  return queue.some(q => q.socketId === socketId);
}
function removeFromQueue(socketId) {
  const i = queue.findIndex(q => q.socketId === socketId);
  if (i !== -1) queue.splice(i, 1);
}
function isInActiveGame(socketId) {
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

  // Update Elo + stats, then send private stat update to each human player
  const p0 = room.players[0];
  const p1 = room.players[1];
  const isBotGame = room.isBot;
  const winnerToken = room.players.find(p => p.id === room.winner)?.token || null;

  try {
    const stats = updateStats(
      p0.token, p0.name,
      isBotGame ? '__bot__' : p1.token, p1.name,
      winnerToken,
      isBotGame
    );

    for (const player of room.players) {
      if (player.id === BOT_ID) continue;
      const sock = io.sockets.sockets.get(player.id);
      if (sock && stats[player.token]) {
        sock.emit('stats_update', stats[player.token]);
      }
    }
  } catch (e) {
    console.error('[stats]', e.message);
  }

  io.to(room.roomId).emit('game_over', { ...result, scores: room.scores });
  scheduleCleanup(room.roomId);
}

function scheduleCleanup(roomId) {
  setTimeout(() => games.delete(roomId), 5 * 60 * 1000);
}

function scheduleBotMove(room) {
  if (!room.isBot || room.state !== 'playing') return;
  if (room.getCurrentPlayer().id !== BOT_ID) return;
  setTimeout(() => {
    if (room.state !== 'playing') return;
    if (room.getCurrentPlayer().id !== BOT_ID) return;
    const played = new Set(room.wordHistory.map(h => h.word));
    const nb = getNeighbours(room.currentWord, played);
    if (!nb.length) { finishGame(room, BOT_ID, 'timeout'); return; }
    const pick = nb[Math.floor(Math.random() * nb.length)];
    const res = room.makeMove(BOT_ID, pick);
    if (res.error) { finishGame(room, BOT_ID, 'timeout'); return; }
    startTurn(room);
    io.to(room.roomId).emit('game_update', room.getState());
  }, BOT_DELAY);
}

function makeRoom(roomId, p1Id, p1Name, p1Token) {
  const room = new GameRoom(roomId, p1Id, p1Name);
  room.players[0].token = p1Token;
  return room;
}

// ── Socket handlers ────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── Random matchmaking ─────────────────────────────────────────────────
  socket.on('join_random', ({ name, token }) => {
    if (!socketRL(socket, 'join_random', 5, 60000)) return;
    name  = (name  || 'Anonymous').slice(0, 20);
    token = (token || uuidv4()).slice(0, 36);
    socket.data.token = token;

    if (isInQueue(socket.id)) return;
    if (isInActiveGame(socket.id)) {
      return socket.emit('queue_error', { message: 'You are already in an active game.' });
    }

    const oppIdx = queue.findIndex(q => q.socketId !== socket.id);
    if (oppIdx !== -1) {
      const opp = queue.splice(oppIdx, 1)[0];
      const oppSocket = io.sockets.sockets.get(opp.socketId);
      const roomId = uuidv4().slice(0, 8).toUpperCase();

      const room = makeRoom(roomId, opp.socketId, opp.name, opp.token);
      room.addPlayer(socket.id, name);
      room.players[1].token = token;
      games.set(roomId, room);

      if (oppSocket) { oppSocket.join(roomId); oppSocket.data.roomId = roomId; }
      socket.join(roomId);
      socket.data.roomId = roomId;

      room.start();
      startTurn(room);
      io.to(roomId).emit('game_start', room.getState());
    } else {
      queue.push({ socketId: socket.id, name, token });
      socket.emit('waiting');
    }
  });

  socket.on('cancel_queue', () => {
    removeFromQueue(socket.id);
    socket.emit('queue_cancelled');
  });

  // ── Solo / bot ────────────────────────────────────────────────────────
  socket.on('play_bot', ({ name, token }) => {
    if (!socketRL(socket, 'play_bot', 5, 60000)) return;
    name  = (name  || 'Anonymous').slice(0, 20);
    token = (token || uuidv4()).slice(0, 36);
    socket.data.token = token;
    if (isInActiveGame(socket.id)) return;

    const roomId = uuidv4().slice(0, 8).toUpperCase();
    const room = makeRoom(roomId, socket.id, name, token);
    room.addPlayer(BOT_ID, BOT_NAME);
    room.players[1].token = '__bot__';
    room.isBot = true;
    games.set(roomId, room);

    socket.join(roomId);
    socket.data.roomId = roomId;
    room.start();
    startTurn(room);
    socket.emit('game_start', room.getState());
  });

  // ── Challenge link (created from game-over screen, doesn't touch socket.data) ──
  socket.on('create_challenge', ({ name, token }) => {
    if (!socketRL(socket, 'create_challenge', 10, 60000)) return;
    name  = (name  || 'Anonymous').slice(0, 20);
    token = (token || uuidv4()).slice(0, 36);
    const roomId = uuidv4().slice(0, 8).toUpperCase();
    const room = makeRoom(roomId, socket.id, name, token);
    games.set(roomId, room);
    socket.emit('challenge_created', { roomId });
  });

  // ── Private game ──────────────────────────────────────────────────────
  socket.on('create_game', ({ name, token }) => {
    if (!socketRL(socket, 'create_game', 5, 60000)) return;
    name  = (name  || 'Anonymous').slice(0, 20);
    token = (token || uuidv4()).slice(0, 36);
    socket.data.token = token;
    if (isInActiveGame(socket.id)) return;

    const roomId = uuidv4().slice(0, 8).toUpperCase();
    const room = makeRoom(roomId, socket.id, name, token);
    games.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('game_created', { roomId });
  });

  socket.on('join_game', ({ roomId, name, token }) => {
    if (!socketRL(socket, 'join_game', 10, 60000)) return;
    name   = (name   || 'Anonymous').slice(0, 20);
    token  = (token  || uuidv4()).slice(0, 36);
    roomId = (roomId || '').trim().toUpperCase();
    socket.data.token = token;
    const room = games.get(roomId);

    if (!room) return socket.emit('join_error', { message: 'Room not found. Check the code and try again.' });

    const existing = room.players.find(p => p.name === name);
    if (existing && room.state !== 'waiting') {
      existing.id = socket.id;
      socket.join(roomId);
      socket.data.roomId = roomId;
      if (room.state === 'playing') {
        socket.emit('game_start', room.getState());
      } else {
        socket.emit('game_over', {
          winnerName: room.winnerName, loserName: room.loserName,
          reason: room.endReason, wordHistory: room.wordHistory, players: room.players,
        });
      }
      return;
    }

    if (room.players.length >= 2) return socket.emit('join_error', { message: 'This room is already full.' });
    if (room.state !== 'waiting') return socket.emit('join_error', { message: 'Game already started.' });

    room.addPlayer(socket.id, name);
    room.players[1].token = token;
    socket.join(roomId);
    socket.data.roomId = roomId;
    room.start();
    startTurn(room);
    io.to(roomId).emit('game_start', room.getState());
  });

  // ── Sync (game page reconnect) ─────────────────────────────────────────
  socket.on('sync_game', ({ roomId, name, token }) => {
    roomId = (roomId || '').trim().toUpperCase();
    name   = (name   || 'Anonymous').slice(0, 20);
    token  = (token  || '').slice(0, 36);
    socket.data.token = token;
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
        winnerName: room.winnerName, loserName: room.loserName,
        reason: room.endReason, wordHistory: room.wordHistory, players: room.players,
        rematchReady: [...room.rematchReady],
      });
    }
  });

  // ── Move ──────────────────────────────────────────────────────────────
  socket.on('make_move', ({ word }) => {
    if (!socketRL(socket, 'make_move', 30, 60000)) return;
    const room = games.get(socket.data.roomId);
    if (!room) return;
    const result = room.makeMove(socket.id, word);
    if (result.error) return socket.emit('move_error', { error: result.error });
    startTurn(room);
    io.to(room.roomId).emit('game_update', room.getState());
  });

  // ── Give up ───────────────────────────────────────────────────────────
  socket.on('give_up', () => {
    if (!socketRL(socket, 'give_up', 5, 60000)) return;
    const room = games.get(socket.data.roomId);
    if (!room || room.state !== 'playing') return;
    finishGame(room, socket.id, 'forfeit');
  });

  // ── Rematch ───────────────────────────────────────────────────────────
  socket.on('rematch_request', () => {
    const room = games.get(socket.data.roomId);
    if (!room || room.state !== 'finished') return;

    if (room.isBot) {
      room.rematch();
      startTurn(room);
      socket.emit('game_start', room.getState());
      return;
    }

    room.rematchReady.add(socket.id);
    io.to(room.roomId).emit('rematch_status', {
      readyIds: [...room.rematchReady], needed: 2,
    });

    if (room.rematchReady.size >= 2) {
      room.rematch();
      startTurn(room);
      io.to(room.roomId).emit('game_start', room.getState());
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────
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
