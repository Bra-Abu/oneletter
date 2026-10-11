const socket = io();

// ── Player identity ────────────────────────────────────────────────────────
function getToken() {
  let t = localStorage.getItem('ol_token');
  if (!t) { t = crypto.randomUUID(); localStorage.setItem('ol_token', t); }
  return t;
}
const MY_TOKEN  = getToken();
const savedName = sessionStorage.getItem('ol_name') ||
  (() => { try { return localStorage.getItem('ol_name'); } catch { return null; } })() || 'Anonymous';

// ── State ──────────────────────────────────────────────────────────────────
let myId = null;
let myPlayerIndex = -1;
let gameState = null;
let timerInterval = null;
let selectedTileIdx = -1;
let soundEnabled = (() => { try { return localStorage.getItem('ol_sound') !== 'off'; } catch { return true; } })();

const TURN_SECS = 10;
const RING_CIRCUMFERENCE = 163.36;

// ── Sound engine (Web Audio API, no files) ─────────────────────────────────
let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function beep(freq, dur, type = 'sine', vol = 0.25) {
  if (!soundEnabled) return;
  try {
    const ctx = getAudio();
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.connect(g); g.connect(ctx.destination);
    osc.type = type; osc.frequency.value = freq;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur);
  } catch {}
}
const SFX = {
  tileSelect: () => beep(700, 0.06, 'sine', 0.15),
  goodWord:   () => beep(880, 0.08, 'sine', 0.2),
  badWord:    () => beep(220, 0.12, 'square', 0.15),
  move:       () => { beep(660, 0.07); setTimeout(() => beep(880, 0.07), 80); },
  tick:       () => beep(440, 0.05, 'sine', 0.1),
  win:        () => { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.18), i * 100)); },
  lose:       () => { [440, 370, 294].forEach((f, i) => setTimeout(() => beep(f, 0.22), i * 120)); },
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const connectingState   = document.getElementById('connectingState');
const waitingState      = document.getElementById('waitingState');
const gameMain          = document.getElementById('gameMain');
const gameOverScreen    = document.getElementById('gameOverScreen');
const chip0             = document.getElementById('chip0');
const chip1             = document.getElementById('chip1');
const wordTiles         = document.getElementById('wordTiles');
const diffTiles         = document.getElementById('diffTiles');
const wordInput         = document.getElementById('wordInput');
const submitBtn         = document.getElementById('submitBtn');
const inputHint         = document.getElementById('inputHint');
const turnLabel         = document.getElementById('turnLabel');
const timerText         = document.getElementById('timerText');
const timerRing         = document.getElementById('timerRing');
const historyChain      = document.getElementById('historyChain');
const opponentThinking  = document.getElementById('opponentThinking');
const btnGiveUp         = document.getElementById('btnGiveUp');
const gameRoomCodeDisplay = document.getElementById('gameRoomCodeDisplay');
const gameLinkInput     = document.getElementById('gameLinkInput');
const btnGameCopyLink   = document.getElementById('btnGameCopyLink');
const resultIcon        = document.getElementById('resultIcon');
const resultTitle       = document.getElementById('resultTitle');
const resultReason      = document.getElementById('resultReason');
const statsRow          = document.getElementById('statsRow');
const finalChain        = document.getElementById('finalChain');
const btnShareResult    = document.getElementById('btnShareResult');
const btnRematch        = document.getElementById('btnRematch');
const rematchStatus     = document.getElementById('rematchStatus');
const soundToggle       = document.getElementById('soundToggle');

// ── Init ───────────────────────────────────────────────────────────────────
const roomId = location.pathname.split('/').pop().toUpperCase();

socket.on('connect', () => {
  myId = socket.id;
  socket.emit('sync_game', { roomId, name: savedName, token: MY_TOKEN });
});

// ── Sound toggle ───────────────────────────────────────────────────────────
function updateSoundUI() {
  soundToggle.textContent = soundEnabled ? '🔊' : '🔇';
  soundToggle.classList.toggle('muted', !soundEnabled);
}
updateSoundUI();
soundToggle.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  try { localStorage.setItem('ol_sound', soundEnabled ? 'on' : 'off'); } catch {}
  updateSoundUI();
});

// ── Copy link ──────────────────────────────────────────────────────────────
btnGameCopyLink.addEventListener('click', () => {
  navigator.clipboard.writeText(gameLinkInput.value).then(() => {
    btnGameCopyLink.textContent = '✓';
    setTimeout(() => { btnGameCopyLink.textContent = 'Copy'; }, 2000);
  });
});

// ── Socket events ──────────────────────────────────────────────────────────
socket.on('sync_error', ({ message }) => {
  connectingState.querySelector('p').textContent = message;
  connectingState.querySelector('.spinner').style.display = 'none';
});

socket.on('host_waiting', ({ roomId: rid }) => {
  connectingState.classList.add('hidden');
  waitingState.classList.remove('hidden');
  const link = `${location.origin}/?room=${rid}`;
  gameRoomCodeDisplay.textContent = rid;
  gameLinkInput.value = link;
});

socket.on('game_start', (state) => {
  gameState = state;
  myId = socket.id;
  myPlayerIndex = state.players.findIndex(p => p.id === myId);

  connectingState.classList.add('hidden');
  waitingState.classList.add('hidden');
  gameOverScreen.classList.add('hidden');
  gameMain.classList.remove('hidden');

  btnRematch.disabled = false;
  btnRematch.textContent = 'Rematch';
  rematchStatus.textContent = '';
  rematchStatus.classList.add('hidden');
  selectedTileIdx = -1;

  renderPlayers(state);
  renderWord(state.currentWord);
  renderHistory(state.wordHistory, state.players, false);
  updateTurnUI(state);
  startTimer(state.timerEndsAt);
});

socket.on('game_update', (state) => {
  gameState = state;
  renderWord(state.currentWord, -1, true); // pop animation
  renderHistory(state.wordHistory, state.players, true);
  updateTurnUI(state);
  restartTimer(state.timerEndsAt);
  clearInput();
  selectedTileIdx = -1;
  SFX.move();
});

socket.on('move_error', ({ error }) => {
  showHint(error, 'error');
  wordInput.classList.add('invalid');
  wordInput.classList.remove('valid');
  SFX.badWord();
  wordInput.focus();
});

socket.on('game_over', (result) => {
  clearTimer();
  showGameOver(result);
});

socket.on('stats_update', (stats) => {
  renderStats(stats);
});

socket.on('rematch_status', ({ readyIds, needed }) => {
  const myReady  = readyIds.includes(socket.id);
  const allReady = readyIds.length >= needed;
  if (!allReady) {
    rematchStatus.textContent = myReady
      ? 'Waiting for opponent to accept…'
      : 'Opponent wants a rematch!';
    rematchStatus.classList.remove('hidden');
    if (!myReady) {
      btnRematch.disabled = false;
      btnRematch.textContent = 'Accept Rematch';
    }
  }
});

// ── Rendering ──────────────────────────────────────────────────────────────
function renderPlayers(state) {
  const [p0, p1] = state.players;
  chip0.querySelector('.chip-name').textContent = p0?.name || '—';
  chip1.querySelector('.chip-name').textContent = p1?.name || 'Waiting…';
}

function renderWord(word, selIdx = -1, animate = false) {
  wordTiles.innerHTML = '';
  const isMyTurn = gameState && gameState.currentPlayerId === myId;
  [...word.toUpperCase()].forEach((ch, i) => {
    const t = document.createElement('div');
    t.className = 'tile';
    if (isMyTurn) t.classList.add('tappable');
    if (i === selIdx) t.classList.add('selected');
    if (animate) t.classList.add('pop');
    t.textContent = ch;
    t.dataset.index = i;
    if (isMyTurn) {
      t.addEventListener('click', () => onTileTap(i));
    }
    wordTiles.appendChild(t);
  });
}

function renderDiff(current, typed) {
  diffTiles.innerHTML = '';
  if (!typed || typed.length !== current.length) return;
  [...typed.toUpperCase()].forEach((ch, i) => {
    const t = document.createElement('div');
    const same = ch.toLowerCase() === current[i].toLowerCase();
    t.className = `tile ${same ? 'diff-same' : 'diff-changed'}`;
    t.textContent = ch;
    diffTiles.appendChild(t);
  });
}

function renderHistory(history, players, animateNew = false) {
  const prevCount = historyChain.children.length;
  historyChain.innerHTML = '';
  history.forEach((entry, idx) => {
    if (idx > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'chain-arrow';
      arrow.textContent = '→';
      historyChain.appendChild(arrow);
    }
    const wordEl = document.createElement('div');
    wordEl.className = 'chain-word';
    if (entry.playerId === null) {
      wordEl.classList.add('start');
    } else {
      const pi = players.findIndex(p => p.id === entry.playerId);
      if (pi >= 0) wordEl.classList.add(`p${pi}`);
    }
    if (animateNew && idx === history.length - 1) wordEl.classList.add('new');
    wordEl.textContent = entry.word.toUpperCase();
    historyChain.appendChild(wordEl);
  });
  historyChain.scrollLeft = historyChain.scrollWidth;
}

function updateTurnUI(state) {
  const isMyTurn = state.currentPlayerId === myId;
  const curPlayer = state.players.find(p => p.id === state.currentPlayerId);

  [chip0, chip1].forEach((c, i) => {
    c.classList.toggle('active', state.players[i]?.id === state.currentPlayerId);
  });

  if (isMyTurn) {
    turnLabel.textContent = 'Your turn';
    wordInput.disabled = false;
    opponentThinking.classList.add('hidden');
    if (!wordInput.value) wordInput.focus();
  } else {
    turnLabel.textContent = `${curPlayer?.name || 'Opponent'}'s turn`;
    wordInput.disabled = true;
    submitBtn.disabled = true;
    opponentThinking.classList.remove('hidden');
    clearInput();
  }
  // Re-render tiles with/without tappable class
  if (gameState) renderWord(gameState.currentWord, selectedTileIdx);
}

// ── Tap-to-change ──────────────────────────────────────────────────────────
function onTileTap(i) {
  SFX.tileSelect();
  selectedTileIdx = i;

  // Fill word input with current word if empty
  if (!wordInput.value) wordInput.value = gameState.currentWord;

  // Render tiles with selected state
  renderWord(gameState.currentWord, i);

  // Select that character in the text input
  wordInput.focus();
  wordInput.setSelectionRange(i, i + 1);
}

// When user types while a tile is selected, replace just that character
wordInput.addEventListener('keydown', (e) => {
  if (selectedTileIdx < 0) return;
  if (e.key === 'Enter') return; // let Enter fall through to submit

  // A single letter key: replace the selected tile position
  if (/^[a-zA-Z]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const word = gameState.currentWord;
    const newWord = word.slice(0, selectedTileIdx) + e.key.toLowerCase() + word.slice(selectedTileIdx + 1);
    wordInput.value = newWord;
    selectedTileIdx = -1;
    renderWord(word, -1);
    wordInput.dispatchEvent(new Event('input'));
  } else if (e.key === 'Escape') {
    selectedTileIdx = -1;
    renderWord(gameState.currentWord);
    wordInput.value = '';
    clearInput();
  } else {
    // Any other key (backspace, arrow, etc) — deselect tile, let input handle it normally
    selectedTileIdx = -1;
    renderWord(gameState.currentWord);
  }
});

// ── Text input validation ──────────────────────────────────────────────────
wordInput.addEventListener('input', () => {
  const val = wordInput.value.trim().toLowerCase();
  const current = gameState?.currentWord || '';

  wordInput.classList.remove('valid', 'invalid');
  diffTiles.innerHTML = '';
  inputHint.textContent = '';
  inputHint.className = 'input-hint';
  submitBtn.disabled = true;

  if (!val) return;

  if (val.length !== current.length) {
    showHint(`Word must be ${current.length} letters`, '');
    renderDiff(current, val);
    return;
  }

  const diffCount = countDiff(current, val);
  renderDiff(current, val);

  if (diffCount === 0) {
    showHint('Same as current word — change one letter', 'error');
    wordInput.classList.add('invalid');
  } else if (diffCount === 1) {
    showHint('Looks good — press Enter or →', 'ok');
    wordInput.classList.add('valid');
    submitBtn.disabled = false;
    SFX.goodWord();
  } else {
    showHint(`${diffCount} letters changed — must be exactly 1`, 'error');
    wordInput.classList.add('invalid');
  }
});

wordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !submitBtn.disabled) doSubmit();
});
submitBtn.addEventListener('click', doSubmit);

function doSubmit() {
  const word = wordInput.value.trim().toLowerCase();
  if (!word) return;
  submitBtn.disabled = true;
  wordInput.classList.remove('valid', 'invalid');
  showHint('Checking…', '');
  socket.emit('make_move', { word });
}

function clearInput() {
  wordInput.value = '';
  wordInput.classList.remove('valid', 'invalid');
  diffTiles.innerHTML = '';
  inputHint.textContent = '';
  inputHint.className = 'input-hint';
  submitBtn.disabled = true;
}

function showHint(msg, type) {
  inputHint.textContent = msg;
  inputHint.className = `input-hint ${type}`;
}

function countDiff(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// ── Timer ──────────────────────────────────────────────────────────────────
let lastTickSecond = -1;
function startTimer(endsAt) {
  clearTimer();
  lastTickSecond = -1;
  updateTimerDisplay(endsAt);
  timerInterval = setInterval(() => updateTimerDisplay(endsAt), 100);
}
function restartTimer(endsAt) { clearTimer(); startTimer(endsAt); }
function clearTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}
function updateTimerDisplay(endsAt) {
  const remaining = Math.max(0, (endsAt - Date.now()) / 1000);
  const secs = Math.ceil(remaining);
  timerText.textContent = secs;

  const fraction = remaining / TURN_SECS;
  timerRing.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - fraction);

  timerRing.classList.remove('warning', 'danger');
  if (remaining <= 3)      { timerRing.classList.add('danger'); }
  else if (remaining <= 6) { timerRing.classList.add('warning'); }

  // Tick sound once per second in the danger zone
  if (remaining <= 4 && secs !== lastTickSecond && secs > 0) {
    lastTickSecond = secs;
    SFX.tick();
  }

  if (remaining <= 0) clearTimer();
}

// ── Give up ────────────────────────────────────────────────────────────────
btnGiveUp.addEventListener('click', () => {
  if (confirm('Give up this game?')) socket.emit('give_up');
});

// ── Rematch ────────────────────────────────────────────────────────────────
btnRematch.addEventListener('click', () => {
  btnRematch.disabled = true;
  btnRematch.textContent = 'Waiting…';
  rematchStatus.textContent = 'Waiting for opponent to accept…';
  rematchStatus.classList.remove('hidden');
  socket.emit('rematch_request');
});

// ── Game over ──────────────────────────────────────────────────────────────
function showGameOver(result) {
  clearTimer();

  const iWon  = result.winnerName === savedName;
  const iLost = result.loserName  === savedName;

  if (iWon) {
    resultIcon.textContent = '🏆';
    resultTitle.textContent = 'You Win!';
    resultTitle.style.color = 'var(--green)';
    SFX.win();
  } else if (iLost) {
    resultIcon.textContent = '😔';
    resultTitle.textContent = 'You Lose';
    resultTitle.style.color = 'var(--red)';
    SFX.lose();
  } else {
    resultIcon.textContent = '🎮';
    resultTitle.textContent = 'Game Over';
    resultTitle.style.color = 'var(--text)';
  }

  const reasons = {
    timeout:    iLost ? 'Time ran out on your turn.' : 'Opponent ran out of time.',
    forfeit:    iLost ? 'You gave up.' : 'Opponent gave up.',
    disconnect: iLost ? 'You disconnected.' : 'Opponent disconnected.',
  };
  resultReason.textContent = reasons[result.reason] || '';

  // Stats will arrive via stats_update event; clear old stats for now
  statsRow.innerHTML = '';

  renderHistoryFinal(result.wordHistory, result.players);
  gameOverScreen.classList.remove('hidden');

  btnShareResult.addEventListener('click', () => {
    const wordCount = (result.wordHistory?.length || 1) - 1;
    const text = `I played OneLetter — we made a ${wordCount}-word chain! Can you beat it?\n${location.origin}`;
    if (navigator.share) {
      navigator.share({ title: 'OneLetter', text }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text).then(() => {
        btnShareResult.textContent = '✓ Copied!';
        setTimeout(() => { btnShareResult.textContent = 'Share Result'; }, 2000);
      });
    }
  }, { once: true });
}

function renderStats(stats) {
  statsRow.innerHTML = '';
  const items = [
    { label: 'Rating', value: stats.rating, suffix: '' },
    { label: 'Change', value: stats.ratingChange, suffix: '', signed: true },
    { label: 'Wins',   value: stats.wins,    suffix: '' },
    { label: 'Losses', value: stats.losses,  suffix: '' },
    { label: 'Streak', value: stats.winStreak, suffix: '' },
  ];
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'stat-item';
    const valEl = document.createElement('div');
    valEl.className = 'stat-value';
    if (item.signed) {
      valEl.classList.add(item.value >= 0 ? 'positive' : 'negative');
      valEl.textContent = (item.value >= 0 ? '+' : '') + item.value;
    } else {
      valEl.textContent = item.value + item.suffix;
    }
    const lblEl = document.createElement('div');
    lblEl.className = 'stat-label';
    lblEl.textContent = item.label;
    el.appendChild(valEl);
    el.appendChild(lblEl);
    statsRow.appendChild(el);
  }
}

function renderHistoryFinal(history, players) {
  finalChain.innerHTML = '';
  (history || []).forEach((entry, idx) => {
    if (idx > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'chain-arrow';
      arrow.textContent = '→';
      finalChain.appendChild(arrow);
    }
    const wordEl = document.createElement('div');
    wordEl.className = 'chain-word';
    if (!entry.playerId) wordEl.classList.add('start');
    else {
      const pi = (players || []).findIndex(p => p.id === entry.playerId);
      if (pi >= 0) wordEl.classList.add(`p${pi}`);
    }
    wordEl.textContent = (entry.word || '').toUpperCase();
    finalChain.appendChild(wordEl);
  });
}
