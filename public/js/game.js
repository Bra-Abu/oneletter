const socket = io();

// ── State ──────────────────────────────────────────────────────────────
let myId = null;
let myPlayerIndex = -1; // 0 or 1
let gameState = null;
let timerInterval = null;

const TURN_SECS = 10;
const RING_CIRCUMFERENCE = 163.36; // 2 * PI * 26

// ── DOM refs ──────────────────────────────────────────────────────────
const connectingState    = document.getElementById('connectingState');
const waitingState       = document.getElementById('waitingState');
const gameMain           = document.getElementById('gameMain');
const gameOverScreen     = document.getElementById('gameOverScreen');
const chip0              = document.getElementById('chip0');
const chip1              = document.getElementById('chip1');
const wordTiles          = document.getElementById('wordTiles');
const diffTiles          = document.getElementById('diffTiles');
const wordInput          = document.getElementById('wordInput');
const submitBtn          = document.getElementById('submitBtn');
const inputHint          = document.getElementById('inputHint');
const turnLabel          = document.getElementById('turnLabel');
const timerText          = document.getElementById('timerText');
const timerRing          = document.getElementById('timerRing');
const historyChain       = document.getElementById('historyChain');
const opponentThinking   = document.getElementById('opponentThinking');
const btnGiveUp          = document.getElementById('btnGiveUp');
const gameRoomCodeDisplay = document.getElementById('gameRoomCodeDisplay');
const gameLinkInput      = document.getElementById('gameLinkInput');
const btnGameCopyLink    = document.getElementById('btnGameCopyLink');
const resultIcon         = document.getElementById('resultIcon');
const resultTitle        = document.getElementById('resultTitle');
const resultReason       = document.getElementById('resultReason');
const finalChain         = document.getElementById('finalChain');
const btnShareResult     = document.getElementById('btnShareResult');
const btnRematch         = document.getElementById('btnRematch');
const rematchStatus      = document.getElementById('rematchStatus');

// ── Init ───────────────────────────────────────────────────────────────
const roomId = location.pathname.split('/').pop().toUpperCase();
const savedName = sessionStorage.getItem('ol_name') ||
                  (() => { try { return localStorage.getItem('ol_name'); } catch { return null; } })() ||
                  'Anonymous';

socket.on('connect', () => {
  myId = socket.id;
  socket.emit('sync_game', { roomId, name: savedName });
});

// ── Socket events ──────────────────────────────────────────────────────
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

btnGameCopyLink.addEventListener('click', () => {
  navigator.clipboard.writeText(gameLinkInput.value).then(() => {
    btnGameCopyLink.textContent = '✓';
    setTimeout(() => { btnGameCopyLink.textContent = 'Copy'; }, 2000);
  });
});

socket.on('game_start', (state) => {
  gameState = state;
  myId = socket.id;
  myPlayerIndex = state.players.findIndex(p => p.id === myId);

  // Hide all other screens, show game
  connectingState.classList.add('hidden');
  waitingState.classList.add('hidden');
  gameOverScreen.classList.add('hidden');
  gameMain.classList.remove('hidden');

  // Reset rematch UI for fresh game
  btnRematch.disabled = false;
  btnRematch.textContent = 'Rematch';
  rematchStatus.textContent = '';
  rematchStatus.classList.add('hidden');

  renderPlayers(state);
  renderWord(state.currentWord);
  renderHistory(state.wordHistory, state.players);
  updateTurnUI(state);
  startTimer(state.timerEndsAt);
});

socket.on('game_update', (state) => {
  gameState = state;
  renderWord(state.currentWord);
  renderHistory(state.wordHistory, state.players);
  updateTurnUI(state);
  restartTimer(state.timerEndsAt);
  clearInput();
});

socket.on('move_error', ({ error }) => {
  showHint(error, 'error');
  wordInput.classList.add('invalid');
  wordInput.classList.remove('valid');
  wordInput.focus();
});

socket.on('game_over', (result) => {
  clearTimer();
  showGameOver(result);
});

// ── Rendering ─────────────────────────────────────────────────────────
function renderPlayers(state) {
  const [p0, p1] = state.players;
  chip0.querySelector('.chip-name').textContent = p0?.name || '—';
  chip1.querySelector('.chip-name').textContent = p1?.name || 'Waiting…';
}

function renderWord(word) {
  wordTiles.innerHTML = '';
  [...word.toUpperCase()].forEach(ch => {
    const t = document.createElement('div');
    t.className = 'tile';
    t.textContent = ch;
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

function renderHistory(history, players) {
  historyChain.innerHTML = '';
  history.forEach((entry, idx) => {
    if (idx > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'chain-arrow';
      arrow.textContent = '→';
      historyChain.appendChild(arrow);
    }
    const item = document.createElement('div');
    item.className = 'chain-item';
    const wordEl = document.createElement('div');
    wordEl.className = 'chain-word';
    if (entry.playerId === null) {
      wordEl.classList.add('start');
    } else {
      const pi = players.findIndex(p => p.id === entry.playerId);
      if (pi >= 0) wordEl.classList.add(`p${pi}`);
    }
    wordEl.textContent = entry.word.toUpperCase();
    item.appendChild(wordEl);
    historyChain.appendChild(item);
  });
  // Scroll to end
  historyChain.scrollLeft = historyChain.scrollWidth;
}

function updateTurnUI(state) {
  const isMyTurn = state.currentPlayerId === myId;
  const curPlayer = state.players.find(p => p.id === state.currentPlayerId);

  // Active chip
  const chips = [chip0, chip1];
  chips.forEach((c, i) => {
    const pid = state.players[i]?.id;
    c.classList.toggle('active', pid === state.currentPlayerId);
  });

  if (isMyTurn) {
    turnLabel.textContent = 'Your turn';
    wordInput.disabled = false;
    wordInput.focus();
    submitBtn.disabled = true;
    opponentThinking.classList.add('hidden');
  } else {
    turnLabel.textContent = `${curPlayer?.name || 'Opponent'}'s turn`;
    wordInput.disabled = true;
    submitBtn.disabled = true;
    opponentThinking.classList.remove('hidden');
    clearInput();
  }
}

// ── Timer ─────────────────────────────────────────────────────────────
function startTimer(endsAt) {
  clearTimer();
  updateTimerDisplay(endsAt);
  timerInterval = setInterval(() => updateTimerDisplay(endsAt), 200);
}

function restartTimer(endsAt) {
  clearTimer();
  startTimer(endsAt);
}

function clearTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

function updateTimerDisplay(endsAt) {
  const remaining = Math.max(0, (endsAt - Date.now()) / 1000);
  const secs = Math.ceil(remaining);
  timerText.textContent = secs;

  const fraction = remaining / TURN_SECS;
  const offset = RING_CIRCUMFERENCE * (1 - fraction);
  timerRing.style.strokeDashoffset = offset;

  timerRing.classList.remove('warning', 'danger');
  if (remaining <= 3) timerRing.classList.add('danger');
  else if (remaining <= 6) timerRing.classList.add('warning');

  if (remaining <= 0) clearTimer();
}

// ── Input handling ────────────────────────────────────────────────────
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
  } else {
    showHint(`${diffCount} letters changed — must be exactly 1`, 'error');
    wordInput.classList.add('invalid');
  }
});

wordInput.addEventListener('keydown', e => {
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

// ── Give up ────────────────────────────────────────────────────────────
btnGiveUp.addEventListener('click', () => {
  if (confirm('Give up this game?')) socket.emit('give_up');
});

// ── Rematch ────────────────────────────────────────────────────────────
btnRematch.addEventListener('click', () => {
  btnRematch.disabled = true;
  btnRematch.textContent = 'Waiting…';
  rematchStatus.textContent = 'Waiting for opponent to accept…';
  rematchStatus.classList.remove('hidden');
  socket.emit('rematch_request');
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

// ── Game over ─────────────────────────────────────────────────────────
function showGameOver(result) {
  clearTimer();

  const iWon  = result.winnerName === savedName;
  const iLost = result.loserName  === savedName;

  if (iWon) {
    resultIcon.textContent = '🏆';
    resultTitle.textContent = 'You Win!';
    resultTitle.style.color = 'var(--green)';
  } else if (iLost) {
    resultIcon.textContent = '😔';
    resultTitle.textContent = 'You Lose';
    resultTitle.style.color = 'var(--red)';
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

  renderHistoryFinal(result.wordHistory, result.players);

  gameOverScreen.classList.remove('hidden');

  btnShareResult.addEventListener('click', () => {
    const wordCount = (result.wordHistory?.length || 1) - 1;
    const text = `I played OneLetter and we made a ${wordCount}-word chain! Can you beat it?\n${location.origin}`;
    if (navigator.share) {
      navigator.share({ title: 'OneLetter', text }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text).then(() => {
        btnShareResult.textContent = '✓ Copied!';
      });
    }
  }, { once: true });
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
    if (entry.playerId === null) {
      wordEl.classList.add('start');
    } else {
      const pi = (players || []).findIndex(p => p.id === entry.playerId);
      if (pi >= 0) wordEl.classList.add(`p${pi}`);
    }
    wordEl.textContent = (entry.word || '').toUpperCase();
    finalChain.appendChild(wordEl);
  });
}
