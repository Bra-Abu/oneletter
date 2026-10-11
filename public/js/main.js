const socket = io();

const nameInput        = document.getElementById('nameInput');
const btnRandom        = document.getElementById('btnRandom');
const btnBot           = document.getElementById('btnBot');
const btnCreate        = document.getElementById('btnCreate');
const btnJoin          = document.getElementById('btnJoin');
const waitingOverlay   = document.getElementById('waitingOverlay');
const createOverlay    = document.getElementById('createOverlay');
const joinOverlay      = document.getElementById('joinOverlay');
const btnCancelQueue   = document.getElementById('btnCancelQueue');
const btnCancelCreate  = document.getElementById('btnCancelCreate');
const btnCancelJoin    = document.getElementById('btnCancelJoin');
const btnConfirmJoin   = document.getElementById('btnConfirmJoin');
const joinNameInput    = document.getElementById('joinNameInput');
const joinCodeInput    = document.getElementById('joinCodeInput');
const joinError        = document.getElementById('joinError');
const roomCodeDisplay  = document.getElementById('roomCodeDisplay');
const shareLink        = document.getElementById('shareLink');
const btnCopyLink      = document.getElementById('btnCopyLink');

function getName() {
  return nameInput.value.trim() || 'Anonymous';
}

function saveName(n) {
  try { localStorage.setItem('ol_name', n); } catch {}
}

function loadName() {
  try { return localStorage.getItem('ol_name') || ''; } catch { return ''; }
}

nameInput.value = loadName();

// ── Random match ────────────────────────────────────────────────────────
btnRandom.addEventListener('click', () => {
  saveName(getName());
  waitingOverlay.classList.remove('hidden');
  socket.emit('join_random', { name: getName() });
});

btnCancelQueue.addEventListener('click', () => {
  socket.emit('cancel_queue');
  waitingOverlay.classList.add('hidden');
});

// ── Bot / solo game ──────────────────────────────────────────────────────
btnBot.addEventListener('click', () => {
  saveName(getName());
  sessionStorage.setItem('ol_name', getName());
  socket.emit('play_bot', { name: getName() });
});

// ── Create private game ──────────────────────────────────────────────────
btnCreate.addEventListener('click', () => {
  saveName(getName());
  socket.emit('create_game', { name: getName() });
});

btnCancelCreate.addEventListener('click', () => {
  createOverlay.classList.add('hidden');
});

btnCopyLink.addEventListener('click', () => {
  navigator.clipboard.writeText(shareLink.value).then(() => {
    btnCopyLink.textContent = '✓';
    setTimeout(() => { btnCopyLink.textContent = 'Copy'; }, 2000);
  });
});

// ── Join game ────────────────────────────────────────────────────────────
btnJoin.addEventListener('click', () => {
  joinOverlay.classList.remove('hidden');
  joinCodeInput.value = '';
  joinNameInput.value = loadName();
  joinError.classList.add('hidden');
  joinNameInput.focus();
});

btnCancelJoin.addEventListener('click', () => {
  joinOverlay.classList.add('hidden');
});

btnConfirmJoin.addEventListener('click', doJoin);
joinCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const code = joinCodeInput.value.trim();
  if (!code) return;
  const joinName = joinNameInput.value.trim() || getName() || 'Anonymous';
  saveName(joinName);
  sessionStorage.setItem('ol_name', joinName);
  socket.emit('join_game', { roomId: code, name: joinName });
}

// ── Handle URL param: auto-join if ?room=XXXXX ───────────────────────────
const urlRoom = new URLSearchParams(window.location.search).get('room');
if (urlRoom) {
  joinCodeInput.value = urlRoom;
  joinNameInput.value = loadName();
  joinOverlay.classList.remove('hidden');
  joinNameInput.focus();
}

// ── Socket events ─────────────────────────────────────────────────────────
socket.on('waiting', () => {
  waitingOverlay.classList.remove('hidden');
});

socket.on('queue_cancelled', () => {
  waitingOverlay.classList.add('hidden');
});

socket.on('queue_error', ({ message }) => {
  waitingOverlay.classList.add('hidden');
  alert(message);
});

socket.on('game_created', ({ roomId }) => {
  sessionStorage.setItem('ol_name', getName());
  window.location.href = `/game/${roomId}`;
});

socket.on('game_start', (state) => {
  // Store name so game.js can use it after navigation
  sessionStorage.setItem('ol_name', getName());
  window.location.href = `/game/${state.roomId}`;
});

socket.on('join_error', ({ message }) => {
  joinError.textContent = message;
  joinError.classList.remove('hidden');
});

socket.on('error', ({ message }) => {
  alert(message);
});
