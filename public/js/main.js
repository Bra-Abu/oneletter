const socket = io();

// Persistent player identity — no login required
function getToken() {
  let t = localStorage.getItem('ol_token');
  if (!t) {
    // crypto.randomUUID requires HTTPS; use Math.random fallback for HTTP
    t = (crypto.randomUUID?.() ||
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }));
    localStorage.setItem('ol_token', t);
  }
  return t;
}
const MY_TOKEN = getToken();

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
let queueTimer = null;
const queueSub = waitingOverlay.querySelector('.overlay-sub');

function startQueueTimer() {
  clearQueueTimer();
  queueTimer = setTimeout(() => {
    if (queueSub) queueSub.textContent = 'No opponents online right now.';
    const box = waitingOverlay.querySelector('.overlay-box');
    if (box && !box.querySelector('.queue-bot-btn')) {
      const b = document.createElement('button');
      b.className = 'btn-ghost queue-bot-btn';
      b.textContent = 'Play vs Bot instead';
      b.addEventListener('click', () => {
        clearQueueTimer();
        socket.emit('cancel_queue');
        waitingOverlay.classList.add('hidden');
        saveName(getName());
        sessionStorage.setItem('ol_name', getName());
        socket.emit('play_bot', { name: getName(), token: MY_TOKEN });
      });
      box.insertBefore(b, btnCancelQueue);
    }
  }, 28000);
}

function clearQueueTimer() {
  if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
  waitingOverlay.querySelector('.queue-bot-btn')?.remove();
  if (queueSub) queueSub.textContent = 'This usually takes under 30 seconds';
}

btnRandom.addEventListener('click', () => {
  saveName(getName());
  clearQueueTimer();
  waitingOverlay.classList.remove('hidden');
  socket.emit('join_random', { name: getName(), token: MY_TOKEN });
  startQueueTimer();
});

btnCancelQueue.addEventListener('click', () => {
  socket.emit('cancel_queue');
  waitingOverlay.classList.add('hidden');
  clearQueueTimer();
});

// ── Bot / solo game ──────────────────────────────────────────────────────
btnBot.addEventListener('click', () => {
  saveName(getName());
  sessionStorage.setItem('ol_name', getName());
  socket.emit('play_bot', { name: getName(), token: MY_TOKEN });
});

// ── Create private game ──────────────────────────────────────────────────
btnCreate.addEventListener('click', () => {
  saveName(getName());
  socket.emit('create_game', { name: getName(), token: MY_TOKEN });
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
  socket.emit('join_game', { roomId: code, name: joinName, token: MY_TOKEN });
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
  clearQueueTimer();
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
  clearQueueTimer();
  sessionStorage.setItem('ol_name', getName());
  window.location.href = `/game/${state.roomId}`;
});

socket.on('disconnect', () => {
  if (!waitingOverlay.classList.contains('hidden')) {
    clearQueueTimer();
    if (queueSub) queueSub.textContent = 'Connection lost — reconnecting…';
  }
});

socket.on('join_error', ({ message }) => {
  joinError.textContent = message;
  joinError.classList.remove('hidden');
});

socket.on('error', ({ message }) => {
  alert(message);
});

// ── Lobby stats ───────────────────────────────────────────────────────────
async function refreshOnlineCount() {
  try {
    const { count } = await fetch('/api/online').then(r => r.json());
    const el = document.getElementById('onlineCount');
    if (el) el.textContent = count;
  } catch {}
}

async function loadPlayerStats() {
  try {
    const stats = await fetch(`/api/stats?token=${encodeURIComponent(MY_TOKEN)}`).then(r => r.json());
    if (!stats || stats.best_streak < 1) return;
    const val  = document.getElementById('bestStreakVal');
    const stat = document.getElementById('streakStat');
    const sep  = document.getElementById('streakSep');
    if (val)  val.textContent  = `${stats.best_streak} win${stats.best_streak !== 1 ? 's' : ''}`;
    if (stat) stat.style.display = 'flex';
    if (sep)  sep.style.display  = 'block';
  } catch {}
}

refreshOnlineCount();
loadPlayerStats();
setInterval(refreshOnlineCount, 20000);

// ── Demo tile animation ───────────────────────────────────────────────────
const DEMO_CHAIN = [
  'GAME','CAME','COME','CONE','BONE','BORE','CORE','CARE',
  'DARE','DALE','TALE','PALE','PAGE','CAGE','CAVE','GAVE',
];
const MAX_TRAIL = 5;
let demoIdx  = 0;
let trail    = ['GAME'];
const tileEls  = document.querySelectorAll('#demoTiles .demo-tile');
const chainEl  = document.getElementById('demoChain');

function renderTrail() {
  chainEl.innerHTML = '';
  trail.forEach((word, i) => {
    if (i > 0) {
      const arr = document.createElement('span');
      arr.className = 'demo-chain-arrow'; arr.textContent = '›';
      chainEl.appendChild(arr);
    }
    const el = document.createElement('span');
    el.className = 'demo-chain-word' + (i === trail.length - 1 ? ' active' : '');
    el.textContent = word;
    chainEl.appendChild(el);
  });
}

function stepDemo() {
  const prev = DEMO_CHAIN[demoIdx];
  demoIdx = (demoIdx + 1) % DEMO_CHAIN.length;
  const next = DEMO_CHAIN[demoIdx];

  let changedIdx = -1;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) { changedIdx = i; break; }
  }

  tileEls.forEach((tile, i) => {
    if (i === changedIdx) {
      tile.classList.remove('flip');
      void tile.offsetWidth;
      tile.classList.add('flip');
      tile.textContent = next[i];
      setTimeout(() => tile.classList.remove('flip'), 700);
    } else {
      tile.textContent = next[i];
    }
  });

  // Update trail — keep last MAX_TRAIL words
  if (trail.length >= MAX_TRAIL) trail.shift();
  trail.push(next);
  renderTrail();
}

renderTrail();
setInterval(stepDemo, 2000);
