const { isValidWord, isOneLetterDiff } = require('./words');

const TURN_MS = 30000;

const STARTING_WORDS = [
  'game', 'word', 'play', 'best', 'care', 'love', 'time', 'work',
  'fire', 'gold', 'dark', 'hand', 'make', 'read', 'live', 'give',
  'find', 'feel', 'keep', 'call', 'walk', 'talk', 'look', 'take',
  'come', 'know', 'well', 'ball', 'bell', 'bill', 'will', 'tell',
  'sell', 'fill', 'fall', 'tall', 'hall', 'wall', 'call', 'bake',
  'cake', 'lake', 'make', 'rake', 'sake', 'take', 'wake', 'fake',
  'hide', 'ride', 'side', 'tide', 'wide', 'mine', 'line', 'fine',
  'wine', 'vine', 'pine', 'dine', 'nine', 'bone', 'cone', 'tone',
  'zone', 'lone', 'none', 'done', 'gone', 'bore', 'core', 'fore',
  'gore', 'lore', 'more', 'pore', 'sore', 'tore', 'wore', 'bare',
  'care', 'dare', 'fare', 'hare', 'mare', 'pare', 'rare', 'ware',
];

class GameRoom {
  constructor(roomId, p1Id, p1Name) {
    this.roomId = roomId;
    this.players = [{ id: p1Id, name: p1Name }];
    this.currentWord = null;
    this.wordHistory = [];
    this.currentPlayerIndex = 0;
    this.state = 'waiting'; // waiting | playing | finished
    this.timerHandle = null;
    this.timerEndsAt = null;
    this.winner = null;
    this.loser = null;
    this.endReason = null;
    this.createdAt = Date.now();
  }

  addPlayer(p2Id, p2Name) {
    if (this.players.length >= 2) return false;
    this.players.push({ id: p2Id, name: p2Name });
    return true;
  }

  start() {
    const pool = STARTING_WORDS.filter(w => isValidWord(w));
    this.currentWord = pool[Math.floor(Math.random() * pool.length)] || 'game';
    this.wordHistory = [{ word: this.currentWord, playerId: null, playerName: 'Start' }];
    this.state = 'playing';
    this.currentPlayerIndex = 0;
  }

  getCurrentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  makeMove(playerId, newWord) {
    if (this.state !== 'playing') return { error: 'Game is not active' };
    if (this.getCurrentPlayer().id !== playerId) return { error: "It's not your turn" };

    newWord = newWord.toLowerCase().trim();

    if (!isOneLetterDiff(this.currentWord, newWord)) {
      return { error: 'Must change exactly one letter' };
    }
    if (!isValidWord(newWord)) {
      return { error: `"${newWord}" is not a valid English word` };
    }
    if (this.wordHistory.some(h => h.word === newWord)) {
      return { error: 'That word has already been played' };
    }

    const player = this.players.find(p => p.id === playerId);
    this.wordHistory.push({ word: newWord, playerId, playerName: player?.name || 'Player' });
    this.currentWord = newWord;
    this.currentPlayerIndex = 1 - this.currentPlayerIndex;

    return { success: true };
  }

  endGame(loserId, reason) {
    this.state = 'finished';
    const loserPlayer = this.players.find(p => p.id === loserId);
    const winnerPlayer = this.players.find(p => p.id !== loserId);
    this.loserName = loserPlayer?.name || null;
    this.winnerName = winnerPlayer?.name || null;
    this.loser = loserId;
    this.winner = winnerPlayer?.id || null;
    this.endReason = reason;
    if (this.timerHandle) clearTimeout(this.timerHandle);
    return {
      winnerName: this.winnerName,
      loserName: this.loserName,
      reason,
      wordHistory: this.wordHistory,
      players: this.players,
    };
  }

  getState() {
    return {
      roomId: this.roomId,
      players: this.players,
      currentWord: this.currentWord,
      wordHistory: this.wordHistory,
      currentPlayerId: this.getCurrentPlayer()?.id || null,
      state: this.state,
      timerEndsAt: this.timerEndsAt,
    };
  }
}

module.exports = { GameRoom, TURN_MS };
