const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/matches.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    id          TEXT PRIMARY KEY,
    player1     TEXT NOT NULL,
    player2     TEXT NOT NULL,
    start_word  TEXT NOT NULL,
    word_chain  TEXT NOT NULL,
    winner      TEXT,
    loser       TEXT,
    end_reason  TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS players (
    token       TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT 'Anonymous',
    rating      INTEGER NOT NULL DEFAULT 1000,
    wins        INTEGER NOT NULL DEFAULT 0,
    losses      INTEGER NOT NULL DEFAULT 0,
    win_streak  INTEGER NOT NULL DEFAULT 0,
    loss_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  );
`);

// Add best_chain column to existing databases that predate it
try { db.exec(`ALTER TABLE players ADD COLUMN best_chain INTEGER NOT NULL DEFAULT 0`); } catch {}

// ── Matches ─────────────────────────────────────────────────────────────────

const _insertMatch = db.prepare(`
  INSERT OR IGNORE INTO matches
    (id, player1, player2, start_word, word_chain, winner, loser, end_reason, started_at, ended_at, duration_ms)
  VALUES
    (@id, @player1, @player2, @start_word, @word_chain, @winner, @loser, @end_reason, @started_at, @ended_at, @duration_ms)
`);

function saveMatch(room) {
  try {
    _insertMatch.run({
      id:          room.roomId,
      player1:     room.players[0]?.name || 'Unknown',
      player2:     room.players[1]?.name || 'Unknown',
      start_word:  room.wordHistory[0]?.word || '',
      word_chain:  JSON.stringify(room.wordHistory),
      winner:      room.winnerName || null,
      loser:       room.loserName  || null,
      end_reason:  room.endReason  || 'unknown',
      started_at:  room.startedAt  || Date.now(),
      ended_at:    Date.now(),
      duration_ms: Date.now() - (room.startedAt || Date.now()),
    });
  } catch (e) {
    console.error('[db] saveMatch:', e.message);
  }
}

// ── Players / Elo ────────────────────────────────────────────────────────────

const _upsertPlayer = db.prepare(`
  INSERT INTO players (token, name, rating, wins, losses, win_streak, loss_streak, best_streak, updated_at)
  VALUES (@token, @name, 1000, 0, 0, 0, 0, 0, @now)
  ON CONFLICT(token) DO UPDATE SET name = @name, updated_at = @now
`);

const _getPlayer = db.prepare(`SELECT * FROM players WHERE token = ?`);

const _updatePlayer = db.prepare(`
  UPDATE players SET
    rating      = @rating,
    wins        = @wins,
    losses      = @losses,
    win_streak  = @win_streak,
    loss_streak = @loss_streak,
    best_streak = @best_streak,
    best_chain  = @best_chain,
    updated_at  = @now
  WHERE token = @token
`);

function eloChange(myRating, opponentRating, won, K = 32) {
  const expected = 1 / (1 + Math.pow(10, (opponentRating - myRating) / 400));
  return Math.round(K * ((won ? 1 : 0) - expected));
}

// Upsert both players, compute Elo, persist, return stat snapshots.
// Returns { [token]: { rating, ratingChange, wins, losses, winStreak, bestStreak } }
// Skip Elo for bot games (pass botGame = true).
function updateStats(p1Token, p1Name, p2Token, p2Name, winnerToken, botGame = false, chainLength = 0) {
  const now = Date.now();
  _upsertPlayer.run({ token: p1Token, name: p1Name, now });
  if (!botGame) _upsertPlayer.run({ token: p2Token, name: p2Name, now });

  const p1 = _getPlayer.get(p1Token);
  const p2 = botGame ? { rating: 1000 } : _getPlayer.get(p2Token);

  const result = {};

  for (const [token, row, oppRating] of [
    [p1Token, p1, p2.rating],
    ...(botGame ? [] : [[p2Token, p2, p1.rating]]),
  ]) {
    const won = token === winnerToken;
    const delta = botGame ? 0 : eloChange(row.rating, oppRating, won);
    const newRating  = Math.max(100, row.rating + delta);
    const winStreak  = won ? row.win_streak  + 1 : 0;
    const lossStreak = won ? 0 : row.loss_streak + 1;
    const bestStreak = Math.max(row.best_streak, winStreak);
    const bestChain  = Math.max(row.best_chain || 0, chainLength);

    _updatePlayer.run({
      token,
      rating:      newRating,
      wins:        row.wins   + (won ? 1 : 0),
      losses:      row.losses + (won ? 0 : 1),
      win_streak:  winStreak,
      loss_streak: lossStreak,
      best_streak: bestStreak,
      best_chain:  bestChain,
      now,
    });

    result[token] = {
      rating:          newRating,
      ratingChange:    delta,
      wins:            row.wins   + (won ? 1 : 0),
      losses:          row.losses + (won ? 0 : 1),
      winStreak,
      bestStreak,
      bestChain,
      isNewBestChain:  bestChain > (row.best_chain || 0) && chainLength > 0,
    };
  }

  return result;
}

const _getPlayerStats = db.prepare(
  `SELECT rating, wins, losses, win_streak, best_streak FROM players WHERE token = ?`
);
function getPlayerStats(token) {
  try { return _getPlayerStats.get(token) || null; } catch { return null; }
}

const _getLeaderboard = db.prepare(
  `SELECT token, name, rating, wins, best_streak
   FROM players
   WHERE wins >= 3
   ORDER BY rating DESC
   LIMIT 20`
);
function getLeaderboard() {
  try { return _getLeaderboard.all(); } catch { return []; }
}

const _getTopChains = db.prepare(
  `SELECT token, name, best_chain, wins, losses
   FROM players
   WHERE best_chain >= 3
   ORDER BY best_chain DESC
   LIMIT 20`
);
function getTopChains() {
  try { return _getTopChains.all(); } catch { return []; }
}

module.exports = { saveMatch, updateStats, getPlayerStats, getLeaderboard, getTopChains };
