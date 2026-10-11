const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/matches.db');

// Ensure data dir exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    id          TEXT PRIMARY KEY,
    player1     TEXT NOT NULL,
    player2     TEXT NOT NULL,
    start_word  TEXT NOT NULL,
    word_chain  TEXT NOT NULL,   -- JSON array of { word, playerName }
    winner      TEXT,            -- player name, NULL if draw/unknown
    loser       TEXT,
    end_reason  TEXT NOT NULL,   -- timeout | forfeit | disconnect
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  )
`);

const insertMatch = db.prepare(`
  INSERT INTO matches
    (id, player1, player2, start_word, word_chain, winner, loser, end_reason, started_at, ended_at, duration_ms)
  VALUES
    (@id, @player1, @player2, @start_word, @word_chain, @winner, @loser, @end_reason, @started_at, @ended_at, @duration_ms)
`);

function saveMatch(room) {
  try {
    insertMatch.run({
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
  } catch (err) {
    console.error('[db] saveMatch failed:', err.message);
  }
}

module.exports = { saveMatch };
