const socket = io();

// ── Identity ───────────────────────────────────────────────────────────────
function getToken() {
  let t = localStorage.getItem('ol_token');
  if (!t) {
    t = (crypto.randomUUID?.() ||
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }));
    localStorage.setItem('ol_token', t);
  }
  return t;
}
const MY_TOKEN  = getToken();
const savedName = sessionStorage.getItem('ol_name') ||
  (() => { try { return localStorage.getItem('ol_name'); } catch { return null; } })() || 'Anonymous';

// ── State ──────────────────────────────────────────────────────────────────
let myId             = null;
let myPlayerIndex    = -1;
let gameState        = null;
let timerInterval    = null;
let selectedTileIdx  = -1;
let changedFlashIdx  = -1;    // index of last changed letter (shown briefly)
let flashTimer       = null;
let lastTickSec      = -1;
let prevMyTurn       = null;  // tracks turn ownership across updates
let challengeRoomId  = null;  // cached challenge room for share button
let lastResult       = null;  // last game-over result
let tapHintShown     = false; // one-time tap hint per session
let soundEnabled     = (() => { try { return localStorage.getItem('ol_sound') !== 'off'; } catch { return true; } })();

const TURN_SECS        = 10;
const RING_CIRC        = 188.5; // 2π × 30
const BOT_NAME         = 'OneBot 🤖';

// ── Audio ──────────────────────────────────────────────────────────────────
let audioCtx = null;
function audio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function beep(freq, dur, type = 'sine', vol = 0.22) {
  if (!soundEnabled) return;
  try {
    const ctx = audio();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.start(); o.stop(ctx.currentTime + dur);
  } catch {}
}
const SFX = {
  tap:    () => beep(700, 0.055, 'sine', 0.13),
  valid:  () => beep(880, 0.08,  'sine', 0.18),
  bad:    () => beep(220, 0.13,  'square', 0.13),
  move:   () => { beep(660, 0.07); setTimeout(() => beep(900, 0.07), 75); },
  tick:   () => beep(440, 0.04,  'sine', 0.08),
  win:    () => [523,659,784,1047].forEach((f,i) => setTimeout(() => beep(f, .18), i*90)),
  lose:   () => [440,370,294].forEach((f,i) => setTimeout(() => beep(f, .22), i*110)),
};

// ── DOM ────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const connectingState  = $('connectingState');
const waitingState     = $('waitingState');
const gameMain         = $('gameMain');
const gameOverScreen   = $('gameOverScreen');
const playerBlock0     = $('playerBlock0');
const playerBlock1     = $('playerBlock1');
const avatar0          = $('avatar0');
const avatar1          = $('avatar1');
const pname0           = $('pname0');
const pname1           = $('pname1');
const pscore0          = $('pscore0');
const pscore1          = $('pscore1');
const timerRing        = $('timerRing');
const timerText        = $('timerText');
const timerWrap        = timerRing?.closest('.timer-ring-wrap');
const turnLabel        = $('turnLabel');
const wordTiles        = $('wordTiles');
const diffTiles        = $('diffTiles');
const wordInput        = $('wordInput');
const submitBtn        = $('submitBtn');
const inputHint        = $('inputHint');
const opponentThinking = $('opponentThinking');
const historyChain     = $('historyChain');
const soundToggle      = $('soundToggle');
const btnGiveUp        = $('btnGiveUp');
const gameRoomCodeDisplay = $('gameRoomCodeDisplay');
const gameLinkInput    = $('gameLinkInput');
const btnGameCopyLink  = $('btnGameCopyLink');
const resultIcon       = $('resultIcon');
const resultTitle      = $('resultTitle');
const resultReason     = $('resultReason');
const statsRow         = $('statsRow');
const finalChain       = $('finalChain');
const goScoreboard     = $('goScoreboard');
const btnShareResult   = $('btnShareResult');
const btnRematch       = $('btnRematch');
const rematchStatus    = $('rematchStatus');
const topTimerBar      = $('topTimerBar');
const topTimerFill     = $('topTimerFill');
const wordHeroSection  = $('wordHeroSection');
const wordHeroLabel    = $('wordHeroLabel');
const tapHint          = $('tapHint');
const youBadge0        = $('youBadge0');
const youBadge1        = $('youBadge1');
const ariaAnnouncer    = $('ariaAnnouncer');

// ── Connect ────────────────────────────────────────────────────────────────
const roomId = location.pathname.split('/').pop().toUpperCase();
socket.on('connect', () => {
  myId = socket.id;
  socket.emit('sync_game', { roomId, name: savedName, token: MY_TOKEN });
});

// ── Sound toggle ───────────────────────────────────────────────────────────
function refreshSoundUI() {
  soundToggle.textContent = soundEnabled ? '🔊' : '🔇';
  soundToggle.classList.toggle('muted', !soundEnabled);
}
refreshSoundUI();
soundToggle.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  try { localStorage.setItem('ol_sound', soundEnabled ? 'on' : 'off'); } catch {}
  refreshSoundUI();
});

// ── Copy link ──────────────────────────────────────────────────────────────
btnGameCopyLink?.addEventListener('click', () => {
  navigator.clipboard.writeText(gameLinkInput.value).then(() => {
    btnGameCopyLink.textContent = '✓';
    setTimeout(() => { btnGameCopyLink.textContent = 'Copy'; }, 2000);
  });
});

// ── Socket events ──────────────────────────────────────────────────────────
socket.on('sync_error', ({ message }) => {
  connectingState.innerHTML = `
    <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:16px;">
      <div style="font-size:2.4rem">🔌</div>
      <p style="color:var(--text);font-weight:700;font-size:1.05rem;">Game not found</p>
      <p style="color:var(--muted);font-size:.85rem;max-width:260px;line-height:1.6;">
        This game has expired or the server restarted.<br>Start a fresh game below.
      </p>
      <a href="/" class="btn-primary" style="text-decoration:none;padding:12px 28px;">Back to Home</a>
    </div>
  `;
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
  topTimerBar?.classList.remove('hidden');

  selectedTileIdx = -1;
  changedFlashIdx = -1;
  challengeRoomId = null;
  lastResult      = null;
  clearRematchTimer();

  // Reset rematch UI
  btnRematch.disabled = false;
  btnRematch.textContent = 'Rematch';
  rematchStatus.textContent = '';
  rematchStatus.classList.add('hidden');

  renderHeader(state);
  renderWord(state.currentWord, -1, -1);
  renderHistory(state.wordHistory, state.players, false);
  applyTurnUI(state);
  startTimer(Date.now() + state.timerRemaining);
});

socket.on('game_update', (state) => {
  // Detect which letter changed
  const prev = gameState?.currentWord || '';
  const next = state.currentWord;
  changedFlashIdx = -1;
  if (prev.length === next.length) {
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== next[i]) { changedFlashIdx = i; break; }
    }
  }

  gameState = state;
  renderWord(state.currentWord, -1, changedFlashIdx, true);
  renderHistory(state.wordHistory, state.players, true);
  updateScores(state);
  applyTurnUI(state);
  restartTimer(Date.now() + state.timerRemaining);
  clearInput();
  selectedTileIdx = -1;
  SFX.move();

  // Clear flash after 1.4 s
  if (flashTimer) clearTimeout(flashTimer);
  if (changedFlashIdx >= 0) {
    flashTimer = setTimeout(() => {
      changedFlashIdx = -1;
      if (gameState) renderWord(gameState.currentWord, selectedTileIdx, -1);
    }, 1400);
  }
});

socket.on('move_error', ({ error }) => {
  showHint(error, 'error');
  wordInput.classList.add('invalid');
  wordInput.classList.remove('valid');
  SFX.bad();
  wordInput.focus();
});

socket.on('game_over', (result) => {
  clearTimer();
  topTimerBar?.classList.add('hidden');
  showGameOver(result);
});

socket.on('stats_update', (stats) => renderStats(stats));

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

function avatarLetter(name) {
  return (name || '?').charAt(0).toUpperCase();
}

function renderHeader(state) {
  const [p0, p1] = state.players;
  avatar0.textContent = avatarLetter(p0?.name);
  avatar1.textContent = avatarLetter(p1?.name || BOT_NAME);
  pname0.textContent  = p0?.name  || '—';
  pname1.textContent  = p1?.name  || 'Waiting…';
  // Mark which side is "me"
  const myIdx = state.players.findIndex(p => p.id === myId);
  youBadge0?.classList.toggle('hidden', myIdx !== 0);
  youBadge1?.classList.toggle('hidden', myIdx !== 1);
  playerBlock0.setAttribute('aria-label', myIdx === 0 ? 'You' : (p0?.name || 'Player 1'));
  playerBlock1.setAttribute('aria-label', myIdx === 1 ? 'You' : (p1?.name || 'Player 2'));
  updateScores(state);
}

function updateScores(state) {
  const scores = state.scores || [0, 0];
  pscore0.textContent = `${scores[0]} W`;
  pscore1.textContent = `${scores[1]} W`;
  // Highlight leader
  pscore0.classList.toggle('leading', scores[0] > scores[1]);
  pscore1.classList.toggle('leading', scores[1] > scores[0]);
}

// Dynamic tile sizing based on word length and viewport
function tileSize(wordLen) {
  const avail = Math.min(window.innerWidth - 40, 460);
  const gap   = Math.max(6, Math.min(10, 8));
  const raw   = (avail - gap * (wordLen - 1)) / wordLen;
  return {
    w:    Math.max(44, Math.min(92, raw)),
    gap,
    font: Math.max(1.1, Math.min(2.5, raw * 0.028)) + 'rem',
  };
}

function renderWord(word, selIdx = -1, flashIdx = -1, pop = false) {
  const isMyTurn = gameState && gameState.currentPlayerId === myId;
  const { w, gap, font } = tileSize(word.length);

  wordTiles.innerHTML = '';
  wordTiles.style.setProperty('--tile-gap', gap + 'px');

  [...word.toUpperCase()].forEach((ch, i) => {
    const t = document.createElement('div');
    t.className = 'tile';
    t.style.setProperty('--tw', w + 'px');
    t.style.setProperty('--tf', font);

    if (isMyTurn) t.classList.add('tappable');
    if (i === selIdx)   t.classList.add('selected');
    if (i === flashIdx) t.classList.add('just-changed');
    if (pop && i !== flashIdx) t.classList.add('pop');

    t.textContent = ch;
    if (isMyTurn) t.addEventListener('click', () => onTileTap(i));
    wordTiles.appendChild(t);
  });
}

function renderDiff(current, typed) {
  diffTiles.innerHTML = '';
  if (!typed || typed.length !== current.length) return;
  [...typed.toUpperCase()].forEach((ch, i) => {
    const d = document.createElement('div');
    const same = ch.toLowerCase() === current[i].toLowerCase();
    d.className = `diff-tile${same ? '' : ' changed'}`;
    d.textContent = ch;
    diffTiles.appendChild(d);
  });
}

function renderHistory(history, players, animateNew = false) {
  historyChain.innerHTML = '';
  history.forEach((entry, idx) => {
    if (idx > 0) {
      const a = document.createElement('span');
      a.className = 'h-arrow'; a.textContent = '→';
      historyChain.appendChild(a);
    }
    const w = document.createElement('div');
    w.className = 'h-word';
    if (!entry.playerId) {
      w.classList.add('start');
    } else {
      const pi = players.findIndex(p => p.id === entry.playerId);
      if (pi >= 0) w.classList.add(`p${pi}`);
    }
    if (animateNew && idx === history.length - 1) w.classList.add('new');
    w.textContent = entry.word.toUpperCase();
    historyChain.appendChild(w);
  });
  historyChain.scrollLeft = historyChain.scrollWidth;
}

function applyTurnUI(state) {
  const isMyTurn  = state.currentPlayerId === myId;
  const curPlayer = state.players.find(p => p.id === state.currentPlayerId);

  // Active player avatar glow
  playerBlock0.classList.toggle('active', state.players[0]?.id === state.currentPlayerId);
  playerBlock1.classList.toggle('active', state.players[1]?.id === state.currentPlayerId);

  turnLabel.textContent = isMyTurn ? 'Your turn' : `${curPlayer?.name || 'Opponent'}'s turn`;
  turnLabel.classList.toggle('my-turn', isMyTurn);

  // Dynamic label teaches the tap mechanic
  if (wordHeroLabel) {
    wordHeroLabel.textContent = isMyTurn ? 'Tap a letter — or type below' : 'Change one letter';
    wordHeroLabel.classList.toggle('my-turn', isMyTurn);
  }

  // One-time tap hint for new players on their very first turn
  if (isMyTurn && !tapHintShown) {
    try { tapHintShown = !!localStorage.getItem('ol_tap_hint_seen'); } catch {}
    if (!tapHintShown) {
      tapHintShown = true;
      try { localStorage.setItem('ol_tap_hint_seen', '1'); } catch {}
      if (tapHint) {
        tapHint.classList.remove('hidden');
        setTimeout(() => {
          tapHint.classList.add('fade-out');
          setTimeout(() => tapHint.classList.add('hidden'), 500);
        }, 3500);
      }
    }
  }

  // Flash the word area and announce when turn switches to/from me
  if (prevMyTurn !== null && isMyTurn !== prevMyTurn) {
    if (isMyTurn) {
      wordHeroSection?.classList.remove('turn-flash');
      void wordHeroSection?.offsetWidth;
      wordHeroSection?.classList.add('turn-flash');
      setTimeout(() => wordHeroSection?.classList.remove('turn-flash'), 900);
      if (ariaAnnouncer) ariaAnnouncer.textContent = 'Your turn — change one letter.';
    } else {
      if (ariaAnnouncer) ariaAnnouncer.textContent = `${curPlayer?.name || 'Opponent'}'s turn.`;
    }
  }
  prevMyTurn = isMyTurn;

  if (isMyTurn) {
    wordInput.disabled = false;
    wordInput.removeAttribute('aria-disabled');
    opponentThinking.classList.add('hidden');
    if (!wordInput.value) wordInput.focus();
  } else {
    wordInput.disabled = true;
    wordInput.setAttribute('aria-disabled', 'true');
    submitBtn.disabled = true;
    opponentThinking.classList.remove('hidden');
    clearInput();
  }

  // Re-render with correct tappable state
  if (gameState) renderWord(gameState.currentWord, selectedTileIdx, changedFlashIdx);
}

// ── Tap-to-change ──────────────────────────────────────────────────────────
function onTileTap(i) {
  SFX.tap();
  selectedTileIdx = i;
  renderWord(gameState.currentWord, i, changedFlashIdx);

  // Fill input with current word and position cursor at tapped index
  wordInput.value = gameState.currentWord;
  wordInput.focus();
  wordInput.setSelectionRange(i, i + 1);
  wordInput.dispatchEvent(new Event('input'));
}

wordInput.addEventListener('keydown', (e) => {
  if (selectedTileIdx < 0) return;
  if (e.key === 'Enter') return;
  if (/^[a-zA-Z]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const w    = gameState.currentWord;
    const newW = w.slice(0, selectedTileIdx) + e.key.toLowerCase() + w.slice(selectedTileIdx + 1);
    wordInput.value = newW;
    selectedTileIdx = -1;
    renderWord(w, -1, changedFlashIdx);
    wordInput.dispatchEvent(new Event('input'));
  } else if (e.key === 'Escape') {
    selectedTileIdx = -1;
    renderWord(gameState.currentWord, -1, changedFlashIdx);
    wordInput.value = '';
    clearInput();
  } else {
    selectedTileIdx = -1;
    renderWord(gameState.currentWord, -1, changedFlashIdx);
  }
});

// ── Input validation ───────────────────────────────────────────────────────
wordInput.addEventListener('input', () => {
  const val     = wordInput.value.trim().toLowerCase();
  const current = gameState?.currentWord || '';

  wordInput.classList.remove('valid', 'invalid');
  diffTiles.innerHTML = '';
  showHint('', '');
  submitBtn.disabled = true;

  if (!val) return;
  if (val.length !== current.length) {
    showHint(`Word must be ${current.length} letters`, '');
    renderDiff(current, val);
    return;
  }

  const d = countDiff(current, val);
  renderDiff(current, val);

  if (d === 0) {
    showHint('Same word — change one letter', 'error');
    wordInput.classList.add('invalid');
  } else if (d === 1) {
    showHint('Looks good — press Submit or Enter', 'ok');
    wordInput.classList.add('valid');
    submitBtn.disabled = false;
    SFX.valid();
  } else {
    showHint(`${d} letters changed — must be exactly 1`, 'error');
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
  showHint('', '');
  submitBtn.disabled = true;
}

function showHint(msg, type) {
  inputHint.textContent = msg;
  inputHint.className   = `input-hint${type ? ' ' + type : ''}`;
}

function countDiff(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// ── Timer ──────────────────────────────────────────────────────────────────
function startTimer(endsAt) {
  clearTimer();
  lastTickSec = -1;
  tick(endsAt);
  timerInterval = setInterval(() => tick(endsAt), 100);
}
function restartTimer(endsAt) { clearTimer(); startTimer(endsAt); }
function clearTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}
function tick(endsAt) {
  const rem  = Math.max(0, (endsAt - Date.now()) / 1000);
  const secs = Math.ceil(rem);
  const pct  = rem / TURN_SECS;

  timerText.textContent = secs;
  timerRing.style.strokeDashoffset = RING_CIRC * (1 - pct);

  // Top bar
  if (topTimerFill) topTimerFill.style.transform = `scaleX(${pct})`;

  // Colour states — ring and bar in sync
  timerRing.classList.remove('warning', 'danger');
  timerWrap?.classList.remove('urgent');
  if (topTimerFill) topTimerFill.classList.remove('warning', 'danger');

  if (rem <= 3) {
    timerRing.classList.add('danger');
    timerWrap?.classList.add('urgent');
    topTimerFill?.classList.add('danger');
  } else if (rem <= 6) {
    timerRing.classList.add('warning');
    topTimerFill?.classList.add('warning');
  }

  if (rem <= 4 && secs !== lastTickSec && secs > 0) {
    lastTickSec = secs; SFX.tick();
  }
  if (rem <= 0) clearTimer();
}

// ── Controls ───────────────────────────────────────────────────────────────
const giveUpModal      = document.getElementById('giveUpModal');
const btnGiveUpCancel  = document.getElementById('btnGiveUpCancel');
const btnGiveUpConfirm = document.getElementById('btnGiveUpConfirm');

btnGiveUp.addEventListener('click', () => {
  giveUpModal.classList.remove('hidden');
});
btnGiveUpCancel.addEventListener('click', () => {
  giveUpModal.classList.add('hidden');
});
btnGiveUpConfirm.addEventListener('click', () => {
  giveUpModal.classList.add('hidden');
  socket.emit('give_up');
});

// ── Rematch ────────────────────────────────────────────────────────────────
let rematchTimer = null;

function clearRematchTimer() {
  if (rematchTimer) { clearTimeout(rematchTimer); rematchTimer = null; }
}

btnRematch.addEventListener('click', () => {
  btnRematch.disabled = true;
  btnRematch.textContent = 'Waiting…';
  rematchStatus.textContent = 'Waiting for opponent to accept…';
  rematchStatus.classList.remove('hidden');
  socket.emit('rematch_request');

  // Reset if game_start never arrives within 20 s
  rematchTimer = setTimeout(() => {
    btnRematch.disabled = false;
    btnRematch.textContent = lastResult?.players?.some(p => p.name === BOT_NAME) ? 'Play Again' : 'Rematch';
    rematchStatus.textContent = 'Opponent didn\'t respond.';
  }, 20000);
});

// ── Game over ──────────────────────────────────────────────────────────────
function showGameOver(result) {
  clearTimer();
  const iWon  = result.winnerName === savedName;
  const iLost = result.loserName  === savedName;

  if (iWon)       { resultIcon.textContent = '🏆'; resultTitle.textContent = 'You Win!';  resultTitle.style.color = 'var(--green)'; SFX.win(); }
  else if (iLost) { resultIcon.textContent = '😔'; resultTitle.textContent = 'You Lose';  resultTitle.style.color = 'var(--red)';   SFX.lose(); }
  else            { resultIcon.textContent = '🎮'; resultTitle.textContent = 'Game Over'; resultTitle.style.color = 'var(--text)'; }

  const reasons = {
    timeout:    iLost ? 'You ran out of time.' : 'Opponent ran out of time.',
    forfeit:    iLost ? 'You gave up.' : 'Opponent gave up.',
    disconnect: iLost ? 'You disconnected.' : 'Opponent disconnected.',
  };
  resultReason.textContent = reasons[result.reason] || '';
  statsRow.innerHTML = '';

  // Scoreboard — both players with session win counts
  const players = result.players || [];
  const scores  = result.scores  || [0, 0];
  const p0 = players[0], p1 = players[1];
  const p0Won = result.winnerName === p0?.name;
  const p1Won = result.winnerName === p1?.name;
  goScoreboard.innerHTML = `
    <div class="go-sb-player${p0Won ? ' winner' : ''}">
      <div class="go-sb-avatar p0">${(p0?.name || '?').charAt(0).toUpperCase()}</div>
      <div class="go-sb-score">${scores[0]}</div>
      <div class="go-sb-name">${p0?.name || '—'}</div>
    </div>
    <div class="go-sb-vs">VS</div>
    <div class="go-sb-player${p1Won ? ' winner' : ''}">
      <div class="go-sb-avatar p1">${(p1?.name || '?').charAt(0).toUpperCase()}</div>
      <div class="go-sb-score">${scores[1]}</div>
      <div class="go-sb-name">${p1?.name || '—'}</div>
    </div>
  `;

  // Button label: bot game = "Play Again", PvP = "Rematch"
  const isBot = players.some(p => p.name === BOT_NAME);
  btnRematch.textContent = isBot ? 'Play Again' : 'Rematch';

  renderHistoryFinal(result.wordHistory, result.players);
  lastResult = result;
  gameOverScreen.classList.remove('hidden');
}

// ── Challenge share ────────────────────────────────────────────────────────
function doShare(roomId) {
  const url  = `https://1letter.world/game/${roomId}`;
  const text = `Think you can beat me at OneLetter? Accept my challenge 👉 ${url}`;
  const fallback = () => navigator.clipboard.writeText(text).then(() => {
    btnShareResult.textContent = '✓ Copied!';
    setTimeout(() => { btnShareResult.textContent = 'Share'; }, 2000);
  });
  if (navigator.share) {
    navigator.share({ title: 'OneLetter Challenge', text, url }).catch(fallback);
  } else {
    fallback();
  }
}

btnShareResult.addEventListener('click', () => {
  if (!lastResult) return;
  if (challengeRoomId) { doShare(challengeRoomId); return; }
  btnShareResult.textContent = 'Creating…';
  btnShareResult.disabled = true;
  socket.emit('create_challenge', { name: savedName, token: MY_TOKEN });
});

socket.on('challenge_created', ({ roomId }) => {
  challengeRoomId = roomId;
  btnShareResult.disabled = false;
  btnShareResult.textContent = 'Share';
  doShare(roomId);
});

function renderStats(stats) {
  statsRow.innerHTML = '';
  const items = [
    { l: 'Rating', v: stats.rating,       signed: false },
    { l: 'Change', v: stats.ratingChange, signed: true  },
    { l: 'Wins',   v: stats.wins,         signed: false },
    { l: 'Streak', v: stats.winStreak,    signed: false },
  ];
  items.forEach(({ l, v, signed }) => {
    const el  = document.createElement('div'); el.className = 'stat-item';
    const val = document.createElement('div'); val.className = 'stat-value';
    if (signed) {
      val.classList.add(v >= 0 ? 'pos' : 'neg');
      val.textContent = (v >= 0 ? '+' : '') + v;
    } else { val.textContent = v; }
    const lbl = document.createElement('div'); lbl.className = 'stat-label'; lbl.textContent = l;
    el.append(val, lbl);
    statsRow.appendChild(el);
  });
}

function renderHistoryFinal(history, players) {
  finalChain.innerHTML = '';
  (history || []).forEach((entry, idx) => {
    if (idx > 0) {
      const a = document.createElement('span'); a.className = 'h-arrow'; a.textContent = '→';
      finalChain.appendChild(a);
    }
    const w = document.createElement('div'); w.className = 'h-word';
    if (!entry.playerId) w.classList.add('start');
    else {
      const pi = (players || []).findIndex(p => p.id === entry.playerId);
      if (pi >= 0) w.classList.add(`p${pi}`);
    }
    w.textContent = (entry.word || '').toUpperCase();
    finalChain.appendChild(w);
  });
}
