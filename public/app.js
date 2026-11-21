'use strict';
/* UNO Adda — client. Renders server snapshots; holds no game rules. */

const $ = (id) => document.getElementById(id);
const COLOR_NAMES = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue' };

let ws = null;
let snap = null;               // latest state snapshot
let sessionToken = null;       // account session token (auth) — NOT the room seat token
let account = null;            // account profile from /api/auth/me (coins + stats source of truth)
let unoArmed = false;          // UNO button pressed, declaration rides the next play
let pendingWildCard = null;    // card id waiting on the color picker
let colorPurpose = null;       // 'wild' | 'first'
let lastEventKey = '';
let chatSeen = { lobby: 0, game: 0 };

// ------------------------------------------------------------ connection
// Cloudflare routing: each room lives in its own Durable Object, addressed
// by room code in the socket path (/ws/<CODE>). Creates use plain /ws and
// the Worker assigns a fresh code; joins/restores must set routeCode first.
let routeCode = null;
function connect(onOpen) {
  if (ws && ws.readyState <= 1) { if (onOpen) onOpen(); return; }
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + (routeCode ? '/ws/' + routeCode : '/ws'));
  ws.onopen = () => {
    if (onOpen) onOpen();
    if (voice.joined && voice.rejoinPending) { // socket dropped mid-voice: re-announce so peers re-offer
      voice.rejoinPending = false;
      setTimeout(() => { if (voice.joined) send({ type: 'voice_join' }); }, 600);
    }
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') { snap = msg; onSnapshot(msg); }
    else if (msg.type === 'error') {
      showError(msg.message);
      if (/Session expired/.test(msg.message)) forceLogout();
    }
    else if (msg.type === 'voice_roster') onVoiceRoster(msg);
    else if (msg.type === 'voice_peer_joined') closePeer(msg.seatId); // fresh offer is coming; drop any stale pc
    else if (msg.type === 'voice_peer_left') closePeer(msg.seatId);
    else if (msg.type === 'voice_signal') onVoiceSignal(msg);
  };
  ws.onclose = () => {
    ws = null;
    if (voice.joined) { voice.rejoinPending = true; [...voice.peers.keys()].forEach(closePeer); }
    toast('Connection lost — trying to reconnect…');
    setTimeout(() => connect(tryRestore), 1500);
  };
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function myName() { return account ? account.name : 'Player'; }
function saveSession() {
  if (snap) localStorage.setItem('uno-adda-room', JSON.stringify({ code: snap.room.code, token: snap.you.token, name: myName() }));
}
function tryRestore() {
  try {
    const s = JSON.parse(localStorage.getItem('uno-adda-room') || 'null');
    if (s && s.code && s.token) send({ type: 'join_room', code: s.code, token: s.token, name: s.name, avatar: profile.avatar, session: sessionToken });
  } catch { /* nothing saved */ }
}

// ------------------------------------------------------------ home setup
function ruleTogglesHtml() {
  return `
    <label><input type="checkbox" data-rule="stacking" checked> Stacking +2/+4</label>
    <label><input type="checkbox" data-rule="challenge" checked> +4 Challenge</label>
    <label><input type="checkbox" data-rule="allWild"> All Wild</label>`;
}
function readRules(containerId) {
  const rules = {};
  document.querySelectorAll('#' + containerId + ' input[data-rule]').forEach(i => { rules[i.dataset.rule] = i.checked; });
  return rules;
}
$('bot-toggles').innerHTML = ruleTogglesHtml();
$('room-toggles').innerHTML = ruleTogglesHtml();

$('btn-bots').onclick = () => connect(() => send({
  type: 'create_bot_game', name: myName(), avatar: profile.avatar, session: sessionToken,
  botCount: parseInt($('in-bots').value, 10), rules: readRules('bot-toggles'),
}));
$('btn-wild').onclick = () => connect(() => send({
  type: 'create_bot_game', name: myName(), avatar: profile.avatar, session: sessionToken,
  botCount: parseInt($('in-bots-wild').value, 10), rules: { stacking: true, challenge: true, allWild: true },
}));
$('btn-create').onclick = () => connect(() => send({
  type: 'create_room', name: myName(), avatar: profile.avatar, session: sessionToken, mode: $('in-mode').value, rules: readRules('room-toggles'),
}));
$('btn-join').onclick = () => {
  const code = $('in-code').value.trim().toUpperCase();
  if (code.length !== 6) return showError('Enter the 6-letter room code');
  routeCode = code; // the socket must land on that room's Durable Object
  connect(() => send({ type: 'join_room', code, name: myName(), avatar: profile.avatar, session: sessionToken }));
};

// ------------------------------------------------------------ snapshot routing
function onSnapshot(msg) {
  fxRects = captureRects(); // DOM still shows the previous snapshot — flight sources
  routeCode = msg.room.code; // reconnects must return to this room's object
  saveSession();
  if (msg.room.quick && quick) quick.charged = false; // the match exists — the stake is in play
  settleQuick(msg);
  countMatchEnd(msg);
  if (!$('mm-modal').classList.contains('hidden')) renderMmSlots();
  const status = msg.room.status;
  showView(status === 'waiting' ? 'lobby' : 'game');
  if (status === 'waiting') renderLobby(msg); else renderGame(msg);
  renderVoice(msg);
  handleEvents(msg);
  renderChat('lobby', msg.chat);
  renderChat('game', msg.chat);
  applyFx(msg);
  if (msg.game && msg.game.youMustPickColor && msg.game.phase === 'firstColor') openColorPicker('first');
  if (status !== 'roundEnd') $('end-modal').classList.add('hidden');
  if (status === 'roundEnd') renderEnd(msg);
}

function showView(name) {
  for (const v of ['home', 'lobby', 'game']) $('view-' + v).classList.toggle('hidden', v !== name);
  document.body.dataset.view = name; // presentation: per-view backdrop art
}

function showError(message) {
  // A quick match that failed before it started refunds its stake (server wallet).
  if (quick && quick.charged && !$('mm-modal').classList.contains('hidden')) {
    const bet = quick.bet;
    quick = null;
    mmTimers.forEach(clearTimeout);
    mmTimers = [];
    $('mm-modal').classList.add('hidden');
    $('vs-modal').classList.add('hidden');
    apiPost('/api/wallet/adjust', { amount: bet, reason: 'refund' })
      .then((r) => { if (r.ok && r.data) setCoins(r.data.coins); });
  }
  for (const id of ['home-error', 'lobby-error']) { const el = $(id); if (el) el.textContent = message; }
  if (snap) toast(message);
  if (/Room not found/.test(message)) localStorage.removeItem('uno-adda-room');
}

// ------------------------------------------------------------ lobby
function renderLobby(msg) {
  $('lobby-code').textContent = msg.room.code;
  const r = msg.room.rules;
  $('lobby-meta').textContent =
    (msg.room.mode === '2v2' ? '2v2 Teams' : 'Classic') +
    ' · Stacking ' + (r.stacking ? 'on' : 'off') +
    ' · Challenge ' + (r.challenge ? 'on' : 'off') +
    ' · All Wild ' + (r.allWild ? 'on' : 'off') +
    ' · 30s turns · first to 500';
  const me = msg.seats.find(s => s.isYou);
  $('lobby-seats').innerHTML = msg.seats.map((s, i) => `
    <div class="seat-row" data-voice-mark="${s.id}">
      ${avatarHtml(s, i)}
      <div class="grow"><b>${esc(s.name)}</b>${s.isYou ? ' (you)' : ''}${s.isBot ? ' 🤖' : ''}<br>
      <span class="muted">Score: ${s.score}</span></div>
      ${s.id === msg.room.hostSeatId ? '<span class="badge host">HOST</span>' : ''}
      ${s.ready ? '<span class="badge ready">READY ✓</span>' : '<span class="badge">not ready</span>'}
    </div>`).join('');
  const isHost = me && me.id === msg.room.hostSeatId;
  $('btn-ready').classList.toggle('hidden', !!isHost);
  $('btn-ready').textContent = me && me.ready ? 'Ready ✓ (tap to undo)' : "I'm Ready";
  $('btn-start').classList.toggle('hidden', !isHost);
}
$('btn-copy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('lobby-code').textContent); toast('Room code copied'); };
$('btn-ready').onclick = () => {
  const me = snap.seats.find(s => s.isYou);
  send({ type: 'set_ready', ready: !(me && me.ready) });
};
$('btn-start').onclick = () => send({ type: 'start_game' });
$('btn-leave-lobby').onclick = leaveRoom;
$('btn-leave-game').onclick = leaveRoom;
function leaveRoom() {
  leaveVoice(false);
  send({ type: 'leave' });
  routeCode = null;
  quick = null;
  localStorage.removeItem('uno-adda-room');
  snap = null;
  showView('home');
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

// ------------------------------------------------------------ game rendering
function renderGame(msg) {
  const g = msg.game;
  const me = msg.seats.find(s => s.isYou);

  $('game-mode-label').textContent = msg.room.quick
    ? `⚡ Quick Match · stake ${msg.room.bet} · winner takes the pot`
    : (msg.room.mode === '2v2' ? '👥 2v2 Teams' : '🎮 Classic') + ` · Round ${msg.room.roundNo || 1}`;

  // opponents
  $('opponents').innerHTML = msg.seats.filter(s => !s.isYou).map(s => `
    <div class="opp ${s.isCurrent ? 'current' : ''} ${s.connected ? '' : 'disc'}" data-voice-mark="${s.id}">
      ${avatarHtml(s, msg.seats.indexOf(s))}
      <div><b>${esc(s.name)}</b>${s.isBot ? ' 🤖' : ''}</div>
      <div class="muted">${s.cardCount} cards · ${s.score} pts${s.team ? ' · Team ' + s.team.toUpperCase() : ''}</div>
      <div class="backs">${backsHtml(Math.min(s.cardCount, 7))}</div>
      ${g && g.unoSuspect === s.id ? `<button class="catch" data-catch="${s.id}">CATCH!</button>` : ''}
    </div>`).join('');
  document.querySelectorAll('[data-catch]').forEach(b => b.onclick = () => send({ type: 'catch_uno', targetSeatId: b.dataset.catch }));

  // piles
  $('discard-pile').innerHTML = g ? cardHtml(g.topCard, false) : '';
  $('draw-count').textContent = g ? g.drawPileCount + ' cards' : '';
  const ci = $('color-indicator');
  if (g && g.currentColor) { ci.style.background = 'var(--' + g.currentColor + ')'; ci.textContent = COLOR_NAMES[g.currentColor]; }
  else { ci.style.background = '#444'; ci.textContent = 'Pick'; }

  // banners
  const current = msg.seats.find(s => s.isCurrent);
  $('turn-banner').textContent = !g ? '' :
    g.phase === 'firstColor' ? (g.youMustPickColor ? 'You flipped a Wild — pick the starting color!' : 'Waiting for the starting color…') :
    g.isYourTurn ? 'Your turn!' : (current ? current.name + "'s turn…" : '');
  $('pending-banner').textContent = g && g.pendingDraw > 0
    ? (g.isYourTurn
        ? `You owe ${g.pendingDraw} cards — stack a ${g.pendingKind === 'draw2' ? '+2' : '+4'}, ${g.pendingKind === 'wild4' && msg.room.rules.challenge ? 'challenge, ' : ''}or take them`
        : `${current ? current.name : 'Next player'} owes ${g.pendingDraw} cards`)
    : '';

  // actions
  $('btn-pass').classList.toggle('hidden', !(g && g.isYourTurn && g.drewCardId));
  $('btn-challenge').classList.toggle('hidden', !(g && g.canChallenge));
  const unoBtn = $('btn-uno');
  unoBtn.classList.toggle('armed', unoArmed);
  unoBtn.classList.toggle('pulse', !!(g && ((me && g.yourHand.length === 2 && g.isYourTurn) || g.unoSuspect === (me && me.id))));

  // my hand
  $('my-info').textContent = me ? `${me.name} · ${me.score} pts${me.team ? ' · Team ' + me.team.toUpperCase() : ''}` : '';
  if (g) {
    const legal = new Set(g.legalCardIds);
    const sorted = g.yourHand.slice().sort(cardSort);
    $('my-hand').innerHTML = sorted.map(c => cardHtml(c, legal.has(c.id), g.drewCardId === c.id)).join('');
    document.querySelectorAll('#my-hand .card').forEach(el => {
      el.onclick = () => onCardTap(el.dataset.id, legal.has(el.dataset.id));
    });
  }
  startTimerBar(g);
}

function cardSort(a, b) {
  const order = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
  if (order[a.color] !== order[b.color]) return order[a.color] - order[b.color];
  return (a.value ?? 99) - (b.value ?? 99);
}

function backsHtml(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += '<div class="card back"><span>A</span></div>';
  return out || '<div class="muted">no cards</div>';
}

function cardHtml(card, playable, isDrew) {
  const label = cardLabel(card);
  const cls = ['card', card.color];
  if (playable === true) cls.push('playable');
  if (playable === false && snap && snap.game) cls.push('dim');
  if (isDrew) cls.push('drew');
  const inner = card.color === 'wild'
    ? `<span class="quad"><i></i><i></i><i></i><i></i></span><span class="wild-label">${label}</span>`
    : `<span class="corner tl">${label}</span><span class="oval"><span class="big">${label}</span></span><span class="corner br">${label}</span>`;
  return `<div class="${cls.join(' ')}" data-id="${card.id}" data-kind="${card.kind}">${inner}</div>`;
}
function cardLabel(card) {
  switch (card.kind) {
    case 'number': return String(card.value);
    case 'skip': return '⊘';
    case 'reverse': return '⇋';
    case 'draw2': return '+2';
    case 'wild': return 'WILD';
    case 'wild4': return '+4';
    default: return '?';
  }
}

function onCardTap(cardId, playable) {
  if (!snap || !snap.game || !snap.game.isYourTurn) return;
  if (!playable) { toast('That card does not match — match the color, number or symbol'); return; }
  const card = snap.game.yourHand.find(c => c.id === cardId);
  if (card && card.color === 'wild') { pendingWildCard = cardId; openColorPicker('wild'); return; }
  doPlay(cardId, undefined);
}
function doPlay(cardId, chosenColor) {
  send({ type: 'play_card', cardId, chosenColor, callUno: unoArmed });
  unoArmed = false;
}

$('draw-pile').onclick = () => { if (snap && snap.game && snap.game.isYourTurn) send({ type: 'draw_card' }); };
$('btn-pass').onclick = () => send({ type: 'pass' });
$('btn-challenge').onclick = () => send({ type: 'challenge' });
$('btn-uno').onclick = () => {
  unoArmed = true;
  send({ type: 'call_uno' });
  toast('UNO declared!');
  renderGame(snap);
};

// ------------------------------------------------------------ color picker
function openColorPicker(purpose) {
  colorPurpose = purpose;
  $('color-modal').classList.remove('hidden');
}
document.querySelectorAll('.color-btn').forEach(b => b.onclick = () => {
  $('color-modal').classList.add('hidden');
  if (colorPurpose === 'first') send({ type: 'pick_color', color: b.dataset.color });
  else if (pendingWildCard) { doPlay(pendingWildCard, b.dataset.color); pendingWildCard = null; }
});

// ------------------------------------------------------------ round end
function renderEnd(msg) {
  const lr = msg.lastRound;
  if (!lr) return;
  const winner = msg.seats.find(s => s.id === lr.winnerSeatId);
  const isQuick = !!msg.room.quick;
  $('end-title').textContent = winner ? `🏆 ${winner.name} wins the round!` : 'Round over';
  const mw = msg.matchWinnerSeatId && msg.seats.find(s => s.id === msg.matchWinnerSeatId);
  $('end-match').textContent = isQuick
    ? '⚡ Quick Match — single round, winner takes the pot.'
    : mw ? `🎉 ${mw.name} reached 500 and wins the match! Scores keep counting if you play on.` : `Round points: +${lr.teamPoints}`;
  $('end-table').innerHTML = '<tr><th>Player</th><th>Leftover cards</th><th>Total score</th></tr>' +
    msg.seats.map(s => `<tr><td>${esc(s.name)}${s.isYou ? ' (you)' : ''}</td><td>${lr.breakdown[s.id] ?? 0} pts</td><td>${s.score}</td></tr>`).join('');
  const isHost = msg.you.seatId === msg.room.hostSeatId;
  $('btn-again').classList.toggle('hidden', !isHost || isQuick);
  $('end-wait').classList.toggle('hidden', isHost || isQuick);
  $('btn-quick-again').classList.toggle('hidden', !isQuick);
  $('btn-exit').textContent = isQuick ? 'Lobby' : 'Back to Home';
  const pay = $('end-payout');
  if (isQuick && quick && quick.settledKey === msg.room.code + '|' + msg.room.roundNo) {
    pay.classList.remove('hidden');
    pay.innerHTML = quick.payout > 0
      ? `<img class="coin-ic" src="art/coin.webp" alt=""> You won the pot: +${quick.payout} coins!`
      : `${winner ? esc(winner.name) : 'A bot'} took the pot — your ${msg.room.bet} coins are gone.`;
  } else {
    pay.classList.add('hidden');
  }
  fxRoundEnd(msg, winner, mw);
  $('end-modal').classList.remove('hidden');
}
$('btn-again').onclick = () => { $('end-modal').classList.add('hidden'); send({ type: 'start_game' }); };
$('btn-quick-again').onclick = () => {
  const tier = quick && quick.tier;
  $('end-modal').classList.add('hidden');
  leaveRoom();
  if (tier) startQuickMatch(tier);
};
$('btn-exit').onclick = () => { $('end-modal').classList.add('hidden'); leaveRoom(); };

// ------------------------------------------------------------ chat
function renderChat(which, chat) {
  const log = $('chat-log-' + which);
  if (!log) return;
  if (chat.length === chatSeen[which] && chatSeen[which] > 0) return;
  chatSeen[which] = chat.length;
  log.innerHTML = chat.map(m => `<div><span class="who">${esc(m.name)}:</span> ${esc(m.text)}</div>`).join('');
  log.scrollTop = log.scrollHeight;
}
document.querySelectorAll('.chat-send').forEach(b => b.onclick = () => sendChat(b.dataset.for));
document.querySelectorAll('.chat-row input').forEach(i => i.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat(i.id.includes('lobby') ? 'lobby' : 'game');
}));
function sendChat(which) {
  const input = $('chat-in-' + which);
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  send({ type: 'chat', text });
}

// ------------------------------------------------------------ events & toasts
function handleEvents(msg) {
  const events = msg.events || [];
  if (!events.length) return;
  const key = JSON.stringify(events) + '|' + msg.room.roundNo + '|' + (msg.game ? msg.game.topCard.id : '');
  if (key === lastEventKey) return;
  lastEventKey = key;
  const name = (id) => { const s = msg.seats.find(x => x.id === id); return s ? s.name : 'Someone'; };
  for (const e of events) {
    switch (e.type) {
      case 'played': break; // too noisy — the card animation + swish cover it
      case 'skipped': toast(`${name(e.seatId)} is skipped!`); sfx('skip'); break;
      case 'reversed': toast('Direction reversed ⇋'); sfx('reverse'); break;
      case 'pending': toast(`${e.kind === 'draw2' ? '+2' : '+4'} — ${name(e.seatId)} owes ${e.total} cards!`); sfx('sting'); break;
      case 'took_pending': toast(`${name(e.seatId)} took ${e.count} cards`); sfx('draw'); break;
      case 'challenge_won': toast(`Bluff caught! ${name(e.accused)} draws 4`); sfx('sting'); break;
      case 'challenge_lost': toast(`Challenge failed — ${name(e.seatId)} draws ${e.count}`); sfx('sting'); break;
      case 'uno_called': toast(`${name(e.seatId)}: UNO!`); showUnoPop(name(e.seatId)); sfx('uno'); break;
      case 'uno_suspect': toast(`${name(e.seatId)} has ONE card — catch them before their turn is safe!`); sfx('alert'); break;
      case 'uno_caught': toast(`Caught! ${name(e.seatId)} forgot UNO and draws 2`); sfx('sting'); break;
      case 'timeout': toast(`${name(e.seatId)} ran out of time`); sfx('skip'); break;
      case 'color_chosen': toast(`Color is now ${COLOR_NAMES[e.color]}`); sfx('click'); break;
      case 'round_end': break; // modal covers it
    }
  }
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 3400);
}

// ------------------------------------------------------------ timer bar
let timerInterval = null;
function startTimerBar(g) {
  if (timerInterval) clearInterval(timerInterval);
  if (!g || !g.turnEndsAt) { $('timerfill').style.width = '100%'; return; }
  const total = 30000;
  const endsAt = g.turnEndsAt;
  timerInterval = setInterval(() => {
    const left = Math.max(0, endsAt - Date.now());
    const pct = (left / total) * 100;
    const fill = $('timerfill');
    fill.style.width = pct + '%';
    fill.style.background = left < 6000 ? 'var(--red)' : left < 12000 ? 'var(--yellow)' : 'var(--green)';
    if (left <= 0) clearInterval(timerInterval);
  }, 120);
}

// ------------------------------------------------------------ helpers
function initials(name) { return (name || '?').trim().slice(0, 2).toUpperCase(); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// A seat's face: the uploaded account photo when there is one, otherwise
// the chosen character sprite. Used for every avatar on every screen.
function avatarHtml(s, idx, tag) {
  tag = tag || 'div';
  if (s && s.photo) return `<${tag} class="avatar has-photo"><img class="avatar-img" src="${esc(s.photo)}" alt=""></${tag}>`;
  const n = s && s.avatar != null ? s.avatar : ((idx || 0) % 4);
  return `<${tag} class="avatar av${n}"></${tag}>`;
}
function paintAvatarEl(el, baseClass, s, idx) {
  if (!el) return;
  if (s && s.photo) {
    el.className = baseClass + ' has-photo';
    el.innerHTML = `<img class="avatar-img" src="${esc(s.photo)}" alt="">`;
  } else {
    const n = s && s.avatar != null ? s.avatar : ((idx || 0) % 4);
    el.className = baseClass + ' av' + n;
    el.innerHTML = '';
  }
}

// ------------------------------------------------------------ voice chat (WebRTC mesh)
// Peer-to-peer audio; the server only relays signaling inside the room.
// Optional — the game works fully without it. New joiners offer to the
// members already in voice, so there is exactly one offerer per pair.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const voice = {
  joined: false, muted: false, rejoinPending: false,
  stream: null, ctx: null,
  peers: new Map(),  // seatId -> { pc, audio }
  levels: new Map(), // seatId -> { analyser, data }
  meterTimer: null,
};

function mySeatId() { return snap && snap.you ? snap.you.seatId : null; }

function voiceNote(text) {
  document.querySelectorAll('.voice-note').forEach(el => { el.textContent = text; });
  if (text) toast(text);
}

async function joinVoice() {
  if (voice.joined) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof RTCPeerConnection === 'undefined') {
    return voiceNote('Voice chat needs a secure page (HTTPS or localhost) and a browser with microphone support.');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return voiceNote('Microphone permission was denied — allow mic access in your browser settings, then tap Join Voice again.');
  }
  voice.stream = stream;
  voice.joined = true;
  voice.muted = false;
  ensureAudioCtx();
  if (mySeatId()) addAnalyser(mySeatId(), stream);
  send({ type: 'voice_join' });
  startMeter();
  voiceNote('');
  renderVoice(snap);
}

function leaveVoice(notify = true) {
  if (!voice.joined) return;
  voice.joined = false;
  voice.rejoinPending = false;
  [...voice.peers.keys()].forEach(closePeer);
  if (voice.stream) { voice.stream.getTracks().forEach(t => t.stop()); voice.stream = null; }
  voice.levels.clear();
  if (voice.meterTimer) { clearInterval(voice.meterTimer); voice.meterTimer = null; }
  if (notify) send({ type: 'voice_leave' });
  renderVoice(snap);
}

function toggleMute() {
  if (!voice.joined || !voice.stream) return;
  voice.muted = !voice.muted;
  voice.stream.getAudioTracks().forEach(t => { t.enabled = !voice.muted; });
  renderVoice(snap);
}

function onVoiceRoster(msg) {
  if (!voice.joined) return;
  for (const seatId of msg.peers || []) peerFor(seatId, true);
}

async function onVoiceSignal(msg) {
  if (!voice.joined || !msg.data) return;
  const from = msg.fromSeatId;
  const data = msg.data;
  try {
    if (data.kind === 'offer') {
      const p = peerFor(from, false);
      await p.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      send({ type: 'voice_signal', toSeatId: from, data: { kind: 'answer', sdp: p.pc.localDescription } });
    } else if (data.kind === 'answer') {
      const p = voice.peers.get(from);
      if (p) await p.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.kind === 'ice') {
      const p = voice.peers.get(from);
      if (p && data.candidate) await p.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch { /* a failed negotiation just means that peer stays silent */ }
}

function peerFor(seatId, initiator) {
  const existing = voice.peers.get(seatId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const p = { pc, audio: null };
  voice.peers.set(seatId, p);
  if (voice.stream) voice.stream.getTracks().forEach(t => pc.addTrack(t, voice.stream));
  pc.onicecandidate = (ev) => {
    if (ev.candidate) send({ type: 'voice_signal', toSeatId: seatId, data: { kind: 'ice', candidate: ev.candidate } });
  };
  pc.ontrack = (ev) => {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = ev.streams[0];
    $('voice-audios').appendChild(audio);
    p.audio = audio;
    addAnalyser(seatId, ev.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(seatId);
  };
  if (initiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: 'voice_signal', toSeatId: seatId, data: { kind: 'offer', sdp: pc.localDescription } });
      } catch { /* peer will stay silent; game is unaffected */ }
    };
  }
  return p;
}

function closePeer(seatId) {
  const p = voice.peers.get(seatId);
  if (!p) return;
  voice.peers.delete(seatId);
  voice.levels.delete(seatId);
  try { p.pc.close(); } catch { /* already closed */ }
  if (p.audio) p.audio.remove();
}

function ensureAudioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (!voice.ctx) voice.ctx = new AC();
  if (voice.ctx.state === 'suspended') voice.ctx.resume();
}

function addAnalyser(seatId, stream) {
  if (!voice.ctx) return;
  try {
    const src = voice.ctx.createMediaStreamSource(stream);
    const analyser = voice.ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    voice.levels.set(seatId, { analyser, data: new Uint8Array(analyser.frequencyBinCount) });
  } catch { /* speaking indicator is best-effort */ }
}

function startMeter() {
  if (voice.meterTimer) return;
  voice.meterTimer = setInterval(() => {
    voice.levels.forEach((L, seatId) => {
      L.analyser.getByteFrequencyData(L.data);
      let sum = 0;
      for (let i = 0; i < L.data.length; i++) sum += L.data[i];
      const speaking = sum / L.data.length > 12 && !(seatId === mySeatId() && voice.muted);
      document.querySelectorAll('[data-voice-mark="' + seatId + '"]').forEach(el => el.classList.toggle('speaking', speaking));
    });
  }, 180);
}

function renderVoice(msg) {
  // Voice only makes sense with another human in the room — bot games hide it.
  const hasHumanPeer = !!(msg && msg.seats.some(s => !s.isYou && !s.isBot));
  document.querySelectorAll('.voice-panel').forEach(panel => {
    panel.classList.toggle('hidden', !hasHumanPeer);
    if (!hasHumanPeer) return;
    panel.querySelector('.voice-join').classList.toggle('hidden', voice.joined);
    panel.querySelector('.voice-mute').classList.toggle('hidden', !voice.joined);
    panel.querySelector('.voice-leave').classList.toggle('hidden', !voice.joined);
    panel.querySelector('.voice-mute').textContent = voice.muted ? '🔊 Unmute' : '🔇 Mute';
    const inVoice = msg.seats.filter(s => s.inVoice);
    panel.querySelector('.voice-status').textContent = voice.joined
      ? '— you are in voice'
      : inVoice.length ? '— ' + inVoice.length + ' in voice' : '';
    panel.querySelector('.voice-members').innerHTML = inVoice.length
      ? inVoice.map(s => `<span class="voice-member" data-voice-mark="${s.id}">🎤 ${esc(s.name)}${s.isYou ? ' (you)' : ''}</span>`).join('')
      : '<span class="muted">Nobody is in voice yet.</span>';
  });
  // Drop peer connections for seats that left the room entirely.
  if (voice.joined && msg) {
    const present = new Set(msg.seats.map(s => s.id));
    [...voice.peers.keys()].forEach(seatId => { if (!present.has(seatId)) closePeer(seatId); });
  }
}

document.querySelectorAll('.voice-join').forEach(b => { b.onclick = joinVoice; });
document.querySelectorAll('.voice-mute').forEach(b => { b.onclick = toggleMute; });
document.querySelectorAll('.voice-leave').forEach(b => { b.onclick = () => leaveVoice(true); });

// ------------------------------------------------------------ presentation FX
// Pure presentation: sounds, animations, confetti. Reads snapshots and
// diffs them; never sends protocol messages and never touches game state.
let fxPrev = null;
let fxRects = null; // element rects captured just before each re-render (flight sources)
let fxDealKey = '';
let fxEndKey = '';
let fxPopTimer = null;
let fxConfettiTimer = null;

function applyFx(msg) {
  try { applyFxInner(msg); } catch { /* presentation must never break the game */ }
  fxPrev = msg;
}

function applyFxInner(msg) {
  const g = msg.game;
  const pg = fxPrev && fxPrev.game;
  const me = msg.seats.find(s => s.isYou);

  // profile chip: my game avatar shows my photo or chosen character
  if (me) paintAvatarEl($('my-avatar'), 'my-avatar av', me, msg.seats.indexOf(me));

  // banner visibility + my-turn scene state
  const tb = $('turn-banner');
  tb.classList.toggle('show', !!tb.textContent.trim());
  tb.classList.toggle('mine', !!(g && g.isYourTurn));
  $('view-game').classList.toggle('my-turn', !!(g && g.isYourTurn));

  if (!g) return;

  // direction-of-play ring
  const ring = $('direction-ring');
  if (ring) ring.classList.toggle('rev', g.direction < 0);

  // hand fan density
  const handEl = $('my-hand');
  const count = g.yourHand.length;
  handEl.classList.toggle('tight', count > 9 && count <= 13);
  handEl.classList.toggle('tight2', count > 13);

  // fresh round dealt (we were not playing in the previous snapshot)
  const dealKey = msg.room.code + '|' + msg.room.roundNo;
  if (fxPrev && fxPrev.room.status !== 'playing' && msg.room.status === 'playing' && fxDealKey !== dealKey) {
    fxDealKey = dealKey;
    handEl.querySelectorAll('.card').forEach((el, i) => {
      el.classList.add('deal-in');
      el.style.animationDelay = (i * 70) + 'ms';
    });
    sfx('deal');
    return; // the deal snapshot is not a play/draw diff
  }

  if (!pg) return;

  // a card landed on the discard pile — fly it in from whoever played it
  if (g.topCard.id !== pg.topCard.id) {
    const top = document.querySelector('#discard-pile .card');
    sfx('play');
    const actor = msg.seats.find(s => {
      const p = fxPrev.seats.find(x => x.id === s.id);
      return p && s.cardCount < p.cardCount;
    });
    let flew = false;
    if (top && actor && fxRects) {
      const toRect = top.getBoundingClientRect();
      const from = actor.isYou
        ? fxRects.hand[g.topCard.id]
        : cardRectAround(fxRects.opps[actor.id], toRect.width, toRect.height);
      if (from) flew = flyCard(cardHtml(g.topCard, false), from, toRect, top);
    }
    if (!flew && top) top.classList.add('played-in');
    if (actor && !actor.isYou) markOpp(actor.id, 'acted');
  }

  // I drew cards (hand grew without the top card changing)
  const prevIds = new Set(pg.yourHand.map(c => c.id));
  const fresh = g.yourHand.filter(c => !prevIds.has(c.id));
  if (fresh.length && g.topCard.id === pg.topCard.id) {
    const drawRect = fxRects && fxRects.draw;
    fresh.forEach((c, i) => {
      const el = handEl.querySelector('[data-id="' + c.id + '"]');
      if (el) el.classList.add('drew-in');
      // fly a card-back in from the draw pile for the first few
      if (el && drawRect && i < 3) {
        setTimeout(() => flyCard('<div class="card back"><span>UNO<br>Adda</span></div>', drawRect, el.getBoundingClientRect(), el), i * 90);
      }
    });
    sfx('draw');
    handEl.scrollTo({ left: handEl.scrollWidth, behavior: 'smooth' });
  }

  // opponents drew cards
  for (const s of msg.seats) {
    if (s.isYou) continue;
    const p = fxPrev.seats.find(x => x.id === s.id);
    if (p && s.cardCount > p.cardCount) {
      markOpp(s.id, 'drew-fx');
      if (fxRects && fxRects.draw) {
        const el = document.querySelector('#opponents .opp[data-voice-mark="' + s.id + '"]');
        const to = el ? cardRectAround(el.getBoundingClientRect(), 40, 58) : null;
        if (to) flyCard('<div class="card back"><span>UNO<br>Adda</span></div>', fxRects.draw, to, null);
      }
    }
  }

  // the turn came around to me
  if (g.isYourTurn && !pg.isYourTurn) sfx('ding');

  // current color changed — pulse the gem; a fresh Wild/+4 color bursts
  if (g.currentColor !== pg.currentColor) {
    const ci = $('color-indicator');
    ci.classList.remove('gem-pulse');
    void ci.offsetWidth;
    ci.classList.add('gem-pulse');
    if (g.topCard.kind === 'wild' || g.topCard.kind === 'wild4') splashColor(g.currentColor);
  }
}

function markOpp(seatId, cls) {
  document.querySelectorAll('#opponents .opp').forEach(el => {
    if (el.dataset.voiceMark === seatId) {
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
    }
  });
}

// ------------------------------------------------------------ card flights & splash
// FLIP flights: rects of the pre-render DOM are captured in onSnapshot
// (fxRects); a fixed-position clone then glides to the post-render target.
// Purely decorative — any missing rect skips the flight silently.
function captureRects() {
  const r = { hand: {}, opps: {}, draw: null };
  try {
    document.querySelectorAll('#my-hand .card').forEach(el => { if (el.dataset.id) r.hand[el.dataset.id] = el.getBoundingClientRect(); });
    document.querySelectorAll('#opponents .opp').forEach(el => { if (el.dataset.voiceMark) r.opps[el.dataset.voiceMark] = el.getBoundingClientRect(); });
    const dp = $('draw-pile');
    if (dp) r.draw = dp.getBoundingClientRect();
  } catch { /* rects are best-effort */ }
  return r;
}

function cardRectAround(rect, w, h) {
  if (!rect || !rect.width) return null;
  return { left: rect.left + rect.width / 2 - w / 2, top: rect.top + rect.height / 2 - h / 2, width: w, height: h };
}

function flyCard(html, fromRect, toRect, hideEl) {
  if (!fromRect || !fromRect.width || !toRect || !toRect.width) return false;
  const wrap = document.createElement('div');
  wrap.className = 'fly-wrap';
  wrap.innerHTML = html;
  wrap.style.left = fromRect.left + 'px';
  wrap.style.top = fromRect.top + 'px';
  wrap.style.width = fromRect.width + 'px';
  wrap.style.height = fromRect.height + 'px';
  document.body.appendChild(wrap);
  if (hideEl) hideEl.style.opacity = '0';
  const dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
  const dy = (toRect.top + toRect.height / 2) - (fromRect.top + fromRect.height / 2);
  const scale = toRect.width / fromRect.width;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    wrap.style.transform = `translate(${dx}px, ${dy}px) rotate(7deg) scale(${scale})`;
  }));
  setTimeout(() => { wrap.remove(); if (hideEl) hideEl.style.opacity = ''; }, 500);
  return true;
}

function splashColor(color) {
  if (!color) return;
  const pile = $('discard-pile');
  if (pile) {
    const r = pile.getBoundingClientRect();
    if (r.width) {
      const el = document.createElement('div');
      el.className = 'wild-splash';
      el.style.background = 'radial-gradient(circle, var(--' + color + ') 0%, rgba(0,0,0,0) 65%)';
      el.style.left = (r.left + r.width / 2) + 'px';
      el.style.top = (r.top + r.height / 2) + 'px';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 620);
    }
  }
  const t = $('table');
  if (t) {
    t.style.setProperty('--splash', 'var(--' + color + ')');
    t.classList.remove('splash-glow');
    void t.offsetWidth;
    t.classList.add('splash-glow');
  }
}

function showUnoPop(name) {
  const pop = $('uno-pop');
  pop.querySelector('.uno-pop-name').textContent = name ? name + ' called' : '';
  pop.classList.remove('hidden', 'show');
  void pop.offsetWidth;
  pop.classList.add('show');
  if (fxPopTimer) clearTimeout(fxPopTimer);
  fxPopTimer = setTimeout(() => { pop.classList.add('hidden'); pop.classList.remove('show'); }, 1550);
}

function fxRoundEnd(msg, winner) {
  const key = msg.room.code + '|' + msg.room.roundNo + '|' + (winner ? winner.id : '');
  if (fxEndKey === key) return;
  fxEndKey = key;
  const me = msg.seats.find(s => s.isYou);
  const iWon = !!(winner && me && winner.id === me.id);
  const teamWon = !!(winner && me && me.team && winner.team === me.team);
  if (iWon) { confettiBurst(90); sfx('win'); }
  else if (teamWon) { confettiBurst(45); sfx('win'); }
}

function confettiBurst(n) {
  const box = $('confetti');
  const colors = ['#e0342b', '#f6c90e', '#2ea84f', '#2277d4', '#ffffff'];
  for (let i = 0; i < n; i++) {
    const p = document.createElement('span');
    p.className = 'confetti-piece';
    const w = 6 + Math.random() * 5;
    p.style.left = (Math.random() * 100) + '%';
    p.style.width = w + 'px';
    p.style.height = (w * 1.55) + 'px';
    p.style.background = colors[(Math.random() * colors.length) | 0];
    p.style.animationDuration = (2.2 + Math.random() * 1.5) + 's';
    p.style.animationDelay = (Math.random() * 0.35) + 's';
    p.style.setProperty('--dx', ((Math.random() * 180) - 90) + 'px');
    p.style.setProperty('--rot', (360 + Math.random() * 720) + 'deg');
    box.appendChild(p);
  }
  if (fxConfettiTimer) clearTimeout(fxConfettiTimer);
  fxConfettiTimer = setTimeout(() => { box.innerHTML = ''; }, 4600);
}

// ------------------------------------------------------------ sound (WebAudio synth, no files)
const sfxState = { ctx: null, muted: localStorage.getItem('uno-adda-muted') === '1' };
function sfxEnsure() {
  if (sfxState.ctx) { if (sfxState.ctx.state === 'suspended') sfxState.ctx.resume(); return sfxState.ctx; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { sfxState.ctx = new AC(); } catch { return null; }
  return sfxState.ctx;
}
document.addEventListener('pointerdown', () => { if (!sfxState.muted) sfxEnsure(); }, { passive: true });

function tone(freqA, freqB, dur, opts) {
  const o = opts || {};
  const ctx = sfxEnsure(); if (!ctx || sfxState.muted) return;
  const t0 = ctx.currentTime + (o.delay || 0);
  const osc = ctx.createOscillator();
  const gn = ctx.createGain();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(freqA, t0);
  if (freqB && freqB !== freqA) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freqB), t0 + dur);
  gn.gain.setValueAtTime(0, t0);
  gn.gain.linearRampToValueAtTime(o.gain || .1, t0 + .012);
  gn.gain.exponentialRampToValueAtTime(.0008, t0 + dur);
  osc.connect(gn); gn.connect(ctx.destination);
  osc.start(t0); osc.stop(t0 + dur + .05);
}
function noiseBurst(dur, opts) {
  const o = opts || {};
  const ctx = sfxEnsure(); if (!ctx || sfxState.muted) return;
  const t0 = ctx.currentTime + (o.delay || 0);
  const len = Math.max(1, (dur * ctx.sampleRate) | 0);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.1;
  f.frequency.setValueAtTime(o.freqA || 900, t0);
  f.frequency.exponentialRampToValueAtTime(o.freqB || 2400, t0 + dur);
  const gn = ctx.createGain();
  gn.gain.setValueAtTime(o.gain || .07, t0);
  gn.gain.exponentialRampToValueAtTime(.0008, t0 + dur);
  src.connect(f); f.connect(gn); gn.connect(ctx.destination);
  src.start(t0);
}
function sfx(kind) {
  if (sfxState.muted) return;
  switch (kind) {
    case 'click': tone(620, 340, .06, { type: 'triangle', gain: .055 }); break;
    case 'play':
      noiseBurst(.16, { freqA: 700, freqB: 2800, gain: .09 });
      tone(190, 120, .07, { type: 'triangle', gain: .05, delay: .1 });
      break;
    case 'draw':
      noiseBurst(.09, { freqA: 500, freqB: 1200, gain: .06 });
      noiseBurst(.09, { freqA: 500, freqB: 1200, gain: .06, delay: .11 });
      break;
    case 'deal':
      for (let i = 0; i < 5; i++) noiseBurst(.06, { freqA: 600, freqB: 1500, gain: .045, delay: i * .07 });
      break;
    case 'ding': tone(880, 880, .14, { gain: .07 }); tone(1318, 1318, .2, { gain: .06, delay: .09 }); break;
    case 'alert':
      tone(1174, 1174, .08, { type: 'square', gain: .032 });
      tone(1174, 1174, .08, { type: 'square', gain: .032, delay: .13 });
      break;
    case 'sting': tone(220, 82, .3, { type: 'sawtooth', gain: .07 }); break;
    case 'skip': tone(520, 240, .13, { type: 'triangle', gain: .07 }); break;
    case 'reverse': tone(300, 660, .15, { type: 'triangle', gain: .07 }); break;
    case 'uno': [523, 659, 784, 1046].forEach((f, i) => tone(f, f, .12, { type: 'triangle', gain: .08, delay: i * .07 })); break;
    case 'win': [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => tone(f, f, .16, { type: 'triangle', gain: .085, delay: i * .1 })); break;
  }
}

const soundBtn = $('btn-sound');
function paintSoundBtn() {
  soundBtn.textContent = sfxState.muted ? '🔇' : '🔊';
  soundBtn.classList.toggle('off', sfxState.muted);
}
soundBtn.onclick = () => {
  sfxState.muted = !sfxState.muted;
  localStorage.setItem('uno-adda-muted', sfxState.muted ? '1' : '0');
  paintSoundBtn();
  if (!sfxState.muted) sfx('click');
};
paintSoundBtn();
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest && e.target.closest('.btn, .color-btn')) sfx('click');
}, { passive: true });
// ------------------------------------------------------------ accounts: API, wallet, profile, quick match, leaderboard
// Coins and stats live in the player's ACCOUNT on the server (see
// src/accounts.js) — the account is the source of truth. The localStorage
// 'uno-adda-wallet' blob is now only a paint cache so the coin chip can
// render instantly; every API response reconciles it.
const TIERS = [
  { id: 'casual', name: 'Casual', bet: 20 },
  { id: 'standard', name: 'Standard', bet: 50 },
  { id: 'pro', name: 'Pro', bet: 100 },
  { id: 'master', name: 'Master', bet: 250 },
];

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}
function loadWallet() {
  try {
    const w = JSON.parse(localStorage.getItem('uno-adda-wallet') || 'null');
    if (w && typeof w.balance === 'number') return { balance: Math.max(0, Math.floor(w.balance)), lastGiftDate: w.lastGiftDate || '', lastRescueDate: w.lastRescueDate || '' };
  } catch { /* fresh wallet */ }
  return { balance: 500, lastGiftDate: '', lastRescueDate: '' };
}
let wallet = loadWallet();
function saveWallet() { localStorage.setItem('uno-adda-wallet', JSON.stringify(wallet)); }

// ------------------------------------------------------------ account API
async function apiFetch(path, opts) {
  opts = opts || {};
  try {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(sessionToken ? { Authorization: 'Bearer ' + sessionToken } : {}),
      },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, ok: res.ok, data };
  } catch {
    return { status: 0, ok: false, data: null };
  }
}
function apiGet(path) { return apiFetch(path); }
function apiPost(path, body) { return apiFetch(path, { method: 'POST', body: body || {} }); }

// Reconcile the painted balance with a server-confirmed coin count.
function setCoins(n) {
  wallet.balance = Math.max(0, Math.floor(Number(n) || 0));
  if (account) account.coins = wallet.balance;
  saveWallet();
  paintWallet();
}

function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem('uno-adda-profile') || 'null');
    if (p) return {
      avatar: (Number.isInteger(p.avatar) && p.avatar >= 0 && p.avatar <= 3) ? p.avatar : null,
      wins: Math.max(0, p.wins | 0),
      coinsWon: Math.max(0, p.coinsWon | 0),
    };
  } catch { /* fresh profile */ }
  return { avatar: null, wins: 0, coinsWon: 0 };
}
let profile = loadProfile();
function saveProfile() { localStorage.setItem('uno-adda-profile', JSON.stringify(profile)); }
function myAvatar() { return profile.avatar != null ? profile.avatar : 0; }

function paintWallet() {
  document.querySelectorAll('.coin-balance').forEach(el => { el.textContent = wallet.balance; });
  paintGift();
}
function paintGift() {
  const b = $('btn-gift');
  if (!b) return;
  const claimed = wallet.lastGiftDate === todayStr();
  b.disabled = claimed;
  b.textContent = claimed ? '🎁 Come back tomorrow' : '🎁 Daily Gift +200';
}
function coinBurst(anchor) {
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  for (let i = 0; i < 9; i++) {
    const img = document.createElement('img');
    img.src = 'art/coin.webp';
    img.alt = '';
    img.className = 'coin-fly';
    img.style.left = (r.left + r.width / 2 - 15) + 'px';
    img.style.top = (r.top + r.height / 2 - 15) + 'px';
    img.style.setProperty('--dx', ((Math.random() * 170) - 85) + 'px');
    img.style.setProperty('--dy', (-(40 + Math.random() * 110)) + 'px');
    document.body.appendChild(img);
    setTimeout(() => img.remove(), 900);
  }
}
async function claimGift() {
  if (wallet.lastGiftDate === todayStr()) return; // button is disabled anyway
  const res = await apiPost('/api/wallet/gift');
  if (res.ok && res.data) {
    wallet.lastGiftDate = todayStr(); // paint hint only — the server decides
    setCoins(res.data.coins);
    coinBurst($('btn-gift'));
    sfx('win');
    toast('🎁 Daily gift: +200 coins!');
  } else if (res.status === 409) {
    wallet.lastGiftDate = todayStr();
    saveWallet();
    paintWallet();
    toast('🎁 Already claimed — come back tomorrow!');
  } else {
    toast('Gift failed — check your connection and try again.');
  }
}
// Free refill so nobody is ever hard-locked: the server grants +100 once
// a day when the balance is under 20 and today's gift is already claimed.
async function apiRescue() {
  const res = await apiPost('/api/wallet/rescue');
  if (res.ok && res.data) {
    wallet.lastRescueDate = todayStr();
    setCoins(res.data.coins);
    toast('🪙 Free refill: +100 coins — good luck!');
    return true;
  }
  return false;
}
$('btn-gift').onclick = claimGift;

// ------------------------------------------------------------ home tiles & tiers
function selectTile(name) {
  document.querySelectorAll('.tile').forEach(t => t.classList.toggle('active', t.dataset.tile === name));
  document.querySelectorAll('.tile-panel').forEach(p => p.classList.toggle('hidden', p.id !== 'panel-' + name));
}
document.querySelectorAll('.tile').forEach(t => { t.onclick = () => selectTile(t.dataset.tile); });
selectTile('quick');

$('tier-list').innerHTML = TIERS.map(t => `
  <button class="tier" data-tier="${t.id}">
    <span class="tier-name">${t.name}</span>
    <span class="tier-tag">Winner takes ×4 pot</span>
    <span class="tier-bet"><img class="coin-ic" src="art/coin.webp" alt=""> ${t.bet}</span>
  </button>`).join('');
document.querySelectorAll('.tier').forEach(b => {
  b.onclick = () => startQuickMatch(TIERS.find(t => t.id === b.dataset.tier));
});

// ------------------------------------------------------------ profile chip & avatar picker
// The home chip shows my account (photo or character, name, Player ID) and
// opens the profile screen. The character picker lives in the profile.
function paintProfileChip() {
  paintAvatarEl($('name-avatar'), 'name-avatar av',
    account ? { photo: account.photo, avatar: myAvatar() } : null, 0);
  const n = $('profile-chip-name');
  if (n) n.textContent = account ? account.name : 'Player';
  const i = $('profile-chip-id');
  if (i) i.textContent = account ? 'ID: ' + account.playerId : 'ID: —';
}
$('profile-chip').onclick = openProfile;
$('my-avatar').onclick = openProfile;
paintProfileChip();
document.querySelectorAll('.pick-av').forEach(b => {
  b.onclick = () => {
    profile.avatar = Number(b.dataset.av);
    if (account) account.avatar = profile.avatar;
    saveProfile();
    paintProfileChip();
    if (account) paintProfile();
    sfx('click');
  };
});

// ------------------------------------------------------------ quick match flow
let quick = null; // { tier, bet, charged, settledKey, payout }
let mmTimers = [];
let mmRevealed = 1;
let mmStartedAt = 0;
const countedMatchRooms = new Set();

async function startQuickMatch(tier) {
  if (!tier) return;
  if (wallet.balance < 20) await apiRescue(); // server grants the free refill if eligible
  if (wallet.balance < tier.bet) {
    const hint = wallet.lastGiftDate !== todayStr()
      ? 'Claim your Daily Gift 🎁 — or play a cheaper tier.'
      : 'Try the Casual tier — or come back tomorrow for your Daily Gift.';
    showError(`Not enough coins for ${tier.name} (needs ${tier.bet}, you have ${wallet.balance}). ${hint}`);
    toast(`Not enough coins for ${tier.name} — ${hint}`);
    return;
  }
  // The stake leaves the account wallet BEFORE matchmaking; a pre-start
  // failure refunds it (see showError), a finished match settles it.
  const res = await apiPost('/api/wallet/adjust', { amount: -tier.bet, reason: 'stake' });
  if (!res.ok || !res.data) {
    showError((res.data && res.data.error) || 'Could not place your stake — please try again.');
    return;
  }
  setCoins(res.data.coins);
  quick = { tier, bet: tier.bet, charged: true, settledKey: null, payout: 0 };
  showMatchmaking();
  connect(() => send({
    type: 'create_bot_game', name: myName(), avatar: profile.avatar, session: sessionToken,
    botCount: 3, rules: { stacking: true, challenge: true, allWild: false },
    quick: true, bet: tier.bet,
  }));
}

function showMatchmaking() {
  mmRevealed = 1;
  mmStartedAt = Date.now();
  renderMmSlots();
  $('mm-modal').classList.remove('hidden');
  mmTimers.forEach(clearTimeout);
  mmTimers = [];
  [750, 1500, 2250].forEach((t, i) => mmTimers.push(setTimeout(() => { mmRevealed = i + 2; renderMmSlots(); sfx('click'); }, t)));
  mmTimers.push(setTimeout(maybeShowVS, 2600));
}

function renderMmSlots() {
  const box = $('mm-slots');
  if (!box) return;
  const seats = snap && snap.room && snap.room.quick && snap.game ? snap.seats : null;
  box.innerHTML = [0, 1, 2, 3].map(i => {
    const s = seats && seats[i];
    if (s && (i === 0 || i < mmRevealed)) {
      return `<div class="mm-slot filled">${avatarHtml(s, i, 'span')}<b>${esc(s.name)}</b></div>`;
    }
    if (i === 0) {
      return `<div class="mm-slot filled">${avatarHtml({ photo: account && account.photo, avatar: myAvatar() }, 0, 'span')}<b>${esc(myName())}</b></div>`;
    }
    return `<div class="mm-slot"><span class="avatar avq">?</span><b>Searching…</b></div>`;
  }).join('');
}

function maybeShowVS() {
  if (!quick) { $('mm-modal').classList.add('hidden'); return; }
  if (!(snap && snap.room.quick && snap.game)) {
    if (Date.now() - mmStartedAt > 12000) {
      showError('Could not reach the game server — your stake was refunded.');
      return;
    }
    mmTimers.push(setTimeout(maybeShowVS, 500));
    return;
  }
  mmRevealed = 4;
  renderMmSlots();
  $('mm-modal').classList.add('hidden');
  paintAvatarEl($('vs-my-avatar'), 'avatar', { photo: account && account.photo, avatar: myAvatar() }, 0);
  $('vs-my-name').textContent = myName();
  $('vs-opps').innerHTML = snap.seats.filter(s => !s.isYou).map(s => `
    <div class="vs-card">${avatarHtml(s, 0, 'span')}<b>${esc(s.name)}</b></div>`).join('');
  $('vs-modal').classList.remove('hidden');
  sfx('ding');
  mmTimers.push(setTimeout(() => $('vs-modal').classList.add('hidden'), 1600));
}

// Settle a finished quick match exactly once per room+round: the pot is
// credited to the account wallet and the match is recorded in the stats.
function settleQuick(msg) {
  if (!quick || !msg.room.quick || msg.room.status !== 'roundEnd' || !msg.lastRound) return;
  const key = msg.room.code + '|' + msg.room.roundNo;
  if (quick.settledKey === key) return;
  quick.settledKey = key;
  const winner = msg.seats.find(s => s.id === msg.lastRound.winnerSeatId);
  const pot = (msg.room.bet || quick.bet) * msg.seats.length;
  if (winner && winner.isYou) {
    quick.payout = pot;
    coinBurst($('game-topbar'));
    apiPost('/api/wallet/adjust', { amount: pot, reason: 'pot' })
      .then((r) => { if (r.ok && r.data) setCoins(r.data.coins); });
    apiStatsMatch(true, pot);
  } else {
    quick.payout = 0;
    apiStatsMatch(false, 0);
  }
}

// Record a finished match in the account stats; the response carries the
// authoritative cumulative totals, which also feed the leaderboard.
function apiStatsMatch(won, coinsWon) {
  return apiPost('/api/stats/match', { won: !!won, coinsWon: coinsWon || 0 }).then((res) => {
    if (res.ok && res.data) {
      if (account) {
        account.matches = res.data.matches;
        account.wins = res.data.wins;
        account.coinsWon = res.data.coinsWon;
      }
      profile.wins = res.data.wins;
      profile.coinsWon = res.data.coinsWon;
      saveProfile();
      if (won) submitStats();
    }
  });
}

// Any non-quick match (classic bots or a friend room) ends when someone
// reaches 500 — record it once per room.
function countMatchEnd(msg) {
  if (msg.room.quick || !msg.matchWinnerSeatId) return;
  if (countedMatchRooms.has(msg.room.code)) return;
  countedMatchRooms.add(msg.room.code);
  apiStatsMatch(msg.matchWinnerSeatId === msg.you.seatId, 0);
}

// ------------------------------------------------------------ leaderboard
async function submitStats() {
  try {
    await fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: myName(), avatar: myAvatar(), wins: profile.wins, coinsWon: profile.coinsWon,
        photo: account && account.photo ? account.photo : undefined,
      }),
    });
  } catch { /* offline — the board is best-effort */ }
}
async function openBoard() {
  $('board-modal').classList.remove('hidden');
  const box = $('board-rows');
  box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const res = await fetch('/api/leaderboard');
    if (!res.ok) throw new Error('board ' + res.status);
    const data = await res.json();
    renderBoard(data.entries || []);
  } catch {
    box.innerHTML = '<p class="muted">Leaderboard unavailable right now — play a Quick Match and check back!</p>';
  }
}
function renderBoard(entries) {
  const box = $('board-rows');
  if (!entries.length) {
    box.innerHTML = '<p class="muted">No scores yet — win a Quick Match and be the first!</p>';
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  box.innerHTML = entries.map((e, i) => `
    <div class="board-row ${String(e.name).toLowerCase() === myName().toLowerCase() ? 'mine' : ''}">
      <span class="board-rank">${medals[i] || (i + 1)}</span>
      ${avatarHtml(e, 0, 'span')}
      <span class="board-name">${esc(e.name)}</span>
      <span class="board-wins">${e.wins} wins</span>
      <span class="board-coins"><img class="coin-ic" src="art/coin.webp" alt=""> ${e.coinsWon}</span>
    </div>`).join('');
}
$('btn-board').onclick = openBoard;
$('btn-board-close').onclick = () => $('board-modal').classList.add('hidden');

paintWallet();

// ------------------------------------------------------------ auth gate & profile screen
// Playing requires an account: on load, a stored session token is checked
// with GET /api/auth/me; without one (or on a 401) the auth screen is the
// first thing shown and no socket is opened.
function showAuth() {
  for (const v of ['home', 'lobby', 'game']) $('view-' + v).classList.add('hidden');
  $('view-auth').classList.remove('hidden');
  document.body.dataset.view = 'auth';
}
function setAuthTab(which) {
  $('tab-login').classList.toggle('active', which === 'login');
  $('tab-signup').classList.toggle('active', which === 'signup');
  $('auth-panel-login').classList.toggle('hidden', which !== 'login');
  $('auth-panel-signup').classList.toggle('hidden', which !== 'signup');
  $('auth-error').textContent = '';
}
$('tab-login').onclick = () => setAuthTab('login');
$('tab-signup').onclick = () => setAuthTab('signup');

function authFail(res, fallback) {
  $('auth-error').textContent = (res.data && res.data.error) || fallback;
}
async function doLogin() {
  const res = await apiPost('/api/auth/login', {
    phone: $('auth-login-phone').value.trim(),
    password: $('auth-login-pass').value,
  });
  if (res.ok && res.data && res.data.token) return afterAuth(res.data);
  authFail(res, 'Login failed — check your number and password.');
}
async function doSignup() {
  if ($('auth-pass').value !== $('auth-pass2').value) {
    $('auth-error').textContent = 'Passwords do not match';
    return;
  }
  const res = await apiPost('/api/auth/signup', {
    name: $('auth-name').value.trim(),
    phone: $('auth-phone').value.trim(),
    password: $('auth-pass').value,
  });
  if (res.ok && res.data && res.data.token) return afterAuth(res.data);
  authFail(res, 'Could not create the account — please check the details.');
}
$('btn-login').onclick = doLogin;
$('btn-signup').onclick = doSignup;
$('auth-login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('auth-pass2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignup(); });

function afterAuth(data) {
  sessionToken = data.token;
  localStorage.setItem('uno-adda-session', sessionToken);
  account = data.profile;
  syncFromAccount();
  $('view-auth').classList.add('hidden');
  showView('home');
  startSocket();
  toast('Welcome, ' + account.name + '! 🎉');
}

// Pull the account's coins + cumulative stats into the local paint caches.
function syncFromAccount() {
  if (!account) return;
  wallet.balance = account.coins;
  profile.wins = account.wins;
  profile.coinsWon = account.coinsWon;
  if (profile.avatar == null && Number.isInteger(account.avatar)) profile.avatar = account.avatar;
  saveWallet();
  saveProfile();
  paintWallet();
  paintProfileChip();
}

// The saved room code must be known BEFORE the socket opens, so the
// Worker routes us to the right Durable Object.
function startSocket() {
  try {
    const saved = JSON.parse(localStorage.getItem('uno-adda-room') || 'null');
    if (saved && saved.code) routeCode = saved.code;
  } catch { /* nothing saved */ }
  connect(tryRestore);
}

// Local-only logout cleanup (also used when the server says the session
// is gone). The error toast that triggered it carries the explanation.
function forceLogout() {
  if (snap) leaveRoom();
  sessionToken = null;
  account = null;
  localStorage.removeItem('uno-adda-session');
  localStorage.removeItem('uno-adda-room');
  $('profile-modal').classList.add('hidden');
  showAuth();
}
async function doLogout() {
  try { await apiPost('/api/auth/logout'); } catch { /* local cleanup happens anyway */ }
  forceLogout();
  toast('Logged out — see you soon!');
}
$('btn-logout').onclick = doLogout;

// ------------------------------------------------------------ profile screen
function openProfile() {
  if (!account) return;
  paintProfile();
  $('profile-modal').classList.remove('hidden');
}
function paintProfile() {
  if (!account) return;
  paintAvatarEl($('profile-photo'), 'profile-photo av', { photo: account.photo, avatar: myAvatar() }, 0);
  $('profile-name').value = account.name;
  $('profile-id').textContent = 'ID: ' + account.playerId;
  $('profile-phone').textContent = account.phone;
  $('stat-matches').textContent = account.matches;
  $('stat-wins').textContent = account.wins;
  $('stat-winrate').textContent = (account.matches ? Math.round((account.wins / account.matches) * 100) : 0) + '%';
  $('stat-coins-won').textContent = account.coinsWon;
  $('profile-coins').textContent = account.coins;
  document.querySelectorAll('.pick-av').forEach(b => b.classList.toggle('selected', Number(b.dataset.av) === myAvatar()));
}
$('btn-profile-close').onclick = () => $('profile-modal').classList.add('hidden');
$('btn-save-name').onclick = async () => {
  const name = $('profile-name').value.trim();
  if (name.length < 2) return toast('Name must be at least 2 characters');
  const res = await apiPost('/api/auth/name', { name });
  if (res.ok && res.data && res.data.profile) {
    account = res.data.profile;
    paintProfile();
    paintProfileChip();
    toast('Name saved ✓');
  } else {
    toast((res.data && res.data.error) || 'Could not save the name');
  }
};
$('btn-photo').onclick = () => $('photo-file').click();
$('photo-file').addEventListener('change', () => {
  const file = $('photo-file').files && $('photo-file').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = async () => {
      try {
        // Center-crop to a square and shrink to 256×256 JPEG (~15KB), so
        // the photo fits the account record and every seat snapshot.
        const c = document.createElement('canvas');
        c.width = 256; c.height = 256;
        const cx = c.getContext('2d');
        const side = Math.min(img.width, img.height);
        cx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
        const data = c.toDataURL('image/jpeg', 0.82);
        const res = await apiPost('/api/auth/photo', { photo: data });
        if (res.ok && res.data && res.data.profile) {
          account = res.data.profile;
          paintProfile();
          paintProfileChip();
          toast('📷 Photo updated!');
        } else {
          toast((res.data && res.data.error) || 'Photo upload failed');
        }
      } catch {
        toast('Could not process that photo');
      }
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

// ------------------------------------------------------------ boot: auth gate first
(function boot() {
  const token = localStorage.getItem('uno-adda-session');
  if (!token) { showAuth(); return; }
  sessionToken = token;
  apiGet('/api/auth/me').then((res) => {
    if (res.ok && res.data && res.data.playerId) {
      account = res.data;
      syncFromAccount();
      $('view-auth').classList.add('hidden');
      showView('home');
      startSocket();
    } else {
      sessionToken = null;
      localStorage.removeItem('uno-adda-session');
      showAuth();
    }
  });
})();
