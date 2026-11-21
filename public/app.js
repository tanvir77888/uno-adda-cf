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
let wsRoute; // the routeCode the live socket was actually opened for
function connect(onOpen) {
  if (ws && ws.readyState <= 1 && wsRoute === routeCode) { if (onOpen) onOpen(); return; }
  if (ws) {
    // The live socket points at a DIFFERENT room's Durable Object than the
    // one we need now — e.g. the boot socket startSocket() opened on plain
    // /ws before the user typed a friend's code. A join sent over it lands
    // on an empty object and comes back "Room not found", so close it
    // quietly (handlers detached: no reconnect toast, no stale sends) and
    // open a fresh socket to the right object.
    const old = ws;
    ws = null;
    old.onopen = old.onmessage = old.onclose = null;
    try { old.close(); } catch { /* already gone */ }
  }
  wsRoute = routeCode;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + (routeCode ? '/ws/' + routeCode : '/ws'));
  ws.onerror = () => {}; // a dying socket reports through onclose; never let it throw
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
    else if (msg.type === 'opponent_gone') handleOpponentGone();
    else if (msg.type === 'room_closed') { toast(msg.message || 'রুমটি অ্যাডমিন বন্ধ করে দিয়েছেন'); leaveRoom(true); }
    else if (msg.type === 'voice_roster') onVoiceRoster(msg);
    else if (msg.type === 'voice_peer_joined') onVoicePeerJoined(msg.seatId);
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
  botCount: botsPick, rules: readRules('bot-toggles'),
}));
$('btn-wild-find').onclick = () => startWildMatch();
$('btn-create').onclick = () => connect(() => send({
  type: 'create_room', name: myName(), avatar: profile.avatar, session: sessionToken, mode: friendMode, maxSeats: seatsPick, rules: readRules('room-toggles'),
}));
$('btn-join').onclick = () => {
  const code = $('in-code').value.trim().toUpperCase();
  if (code.length !== 6) return showError('Enter the 6-letter room code');
  routeCode = code; // the socket must land on that room's Durable Object
  connect(() => send({ type: 'join_room', code, name: myName(), avatar: profile.avatar, session: sessionToken }));
};

// ------------------------------------------------------------ snapshot routing
// Photo merge for the snapshot diet: during 'playing' the server sends
// each seat's photo only in the first state a socket receives; later
// states carry photo:null and the cached photo is merged back by seat
// id, so avatars never flicker or vanish mid-game.
const photoCache = new Map();
let photoRoomCode = null;
function mergePhotos(msg) {
  if (photoRoomCode !== msg.room.code) { photoCache.clear(); photoRoomCode = msg.room.code; }
  for (const s of msg.seats) {
    if (s.photo) photoCache.set(s.id, s.photo);
    else if (photoCache.has(s.id)) s.photo = photoCache.get(s.id);
  }
}

function onSnapshot(msg) {
  fxRects = captureRects(); // DOM still shows the previous snapshot — flight sources
  routeCode = msg.room.code; // reconnects must return to this room's object
  mergePhotos(msg);
  saveSession();
  // A fresh authoritative state supersedes any stale error text (e.g.
  // "Everyone must be ready first" lingering after the last guest
  // readied up — the display must mirror the server's real gate).
  for (const id of ['home-error', 'lobby-error']) { const el = $(id); if (el) el.textContent = ''; }
  deductLiveStake(msg);
  settleQuick(msg);
  countMatchEnd(msg);
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

const ALL_VIEWS = ['auth', 'home', 'quick', 'bots', 'wild', 'friends', 'about', 'lobby', 'game'];
const APP_VERSION = '4.0';
function showView(name) {
  for (const v of ALL_VIEWS) { const el = $('view-' + v); if (el) el.classList.toggle('hidden', v !== name); }
  document.body.dataset.view = name; // presentation: per-view backdrop art
}

function showError(message) {
  for (const id of ['home-error', 'lobby-error']) { const el = $(id); if (el) el.textContent = message; }
  if (snap) toast(message);
  if (/Room not found/.test(message)) localStorage.removeItem('uno-adda-room');
}

// ------------------------------------------------------------ lobby
function renderLobby(msg) {
  $('lobby-code').textContent = msg.room.code;
  $('btn-copy').classList.toggle('hidden', !!msg.room.liveKind);
  const r = msg.room.rules;
  $('lobby-meta').textContent =
    (msg.room.liveKind === 'quick' ? '⚡ Quick Match — Live' : msg.room.liveKind === 'wild' ? '🌈 Go Wild — Live' : (msg.room.mode === '2v2' ? 'Team Mode' : 'Classic')) +
    ' · Seats ' + msg.seats.length + '/' + (msg.room.maxSeats || 4) +
    ' · Stacking ' + (r.stacking ? 'on' : 'off') +
    ' · Challenge ' + (r.challenge ? 'on' : 'off') +
    ' · All Wild ' + (r.allWild ? 'on' : 'off') +
    ' · 30s turns · first to 500';
  const me = msg.seats.find(s => s.isYou);
  $('lobby-seats').innerHTML = msg.seats.map((s, i) => `
    <div class="seat-row" data-voice-mark="${s.id}">
      ${avatarHtml(s, i)}
      <div class="grow"><b>${esc(s.name)}</b>${badgeDotHtml(s)}${s.isYou ? ' (you)' : ''}${s.isBot ? ' 🤖' : ''}<br>
      <span class="muted">Score: ${s.score}</span></div>
      ${s.id === msg.room.hostSeatId ? '<span class="badge host">HOST</span>' : ''}
      ${s.ready ? '<span class="badge ready">READY ✓</span>' : '<span class="badge">not ready</span>'}
    </div>`).join('');
  const isHost = me && me.id === msg.room.hostSeatId;
  $('btn-ready').classList.toggle('hidden', !!isHost);
  $('btn-ready').textContent = me && me.ready ? 'Ready ✓ (tap to undo)' : "I'm Ready";
  $('btn-start').classList.toggle('hidden', !isHost);
  // Start-button mirror: the button's enabled state and the hint under
  // it are computed from THIS snapshot's ready flags with the same gate
  // the server applies, so what the host sees is what the server will
  // do — no stale "not ready" after the last guest readies up.
  const startBtn = $('btn-start');
  if (msg.room.liveKind) {
    $('btn-ready').classList.add('hidden');
    startBtn.classList.add('hidden');
    $('start-hint').textContent = '⏳ Waiting for your opponent to join — the match starts automatically.';
  } else if (isHost) {
    const others = msg.seats.filter(s => !s.isBot && s.id !== msg.room.hostSeatId);
    let canStart = msg.seats.length >= 2 && others.every(s => s.ready);
    if (msg.room.mode === '2v2' && (msg.seats.length < 4 || msg.seats.length % 2 !== 0)) canStart = false;
    startBtn.disabled = !canStart;
    $('start-hint').textContent = msg.seats.length < 2
      ? 'Waiting for players to join…'
      : canStart
        ? '✅ Everyone is ready — start when you like!'
        : 'Waiting for ' + others.filter(s => !s.ready).map(s => s.name).join(', ') + ' to ready up…';
  } else {
    startBtn.disabled = false;
    $('start-hint').textContent = '';
  }
}
$('btn-copy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('lobby-code').textContent); toast('Room code copied'); };
$('btn-ready').onclick = () => {
  const me = snap.seats.find(s => s.isYou);
  send({ type: 'set_ready', ready: !(me && me.ready) });
};
$('btn-start').onclick = () => send({ type: 'start_game' });
$('btn-leave-lobby').onclick = leaveRoom;
$('btn-leave-game').onclick = leaveRoom;

// The matched opponent never showed up (or backed out) before the
// start: the room is gone and no stake was ever taken. Return home
// quietly — without a 'leave' send into the dead room.
function handleOpponentGone() {
  toast("Your opponent didn't show up — match cancelled. No coins were taken.");
  leaveRoom(true);
}

function leaveRoom(silent) {
  teardownLiveSearch(true);
  leaveVoice(false);
  if (!silent) send({ type: 'leave' });
  // cancel any running round intro — its timers must not fire into the lobby
  introState = null;
  window.__intro = null;
  $('view-game').classList.remove('intro-on');
  document.querySelectorAll('.shuffle-fx').forEach(el => el.remove());
  routeCode = null;
  quick = null;
  photoCache.clear();
  photoRoomCode = null;
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
    : msg.room.liveKind === 'wild'
      ? `🌈 Go Wild — Live · Round ${msg.room.roundNo || 1}`
      : (msg.room.mode === '2v2' ? '👥 Team Mode' : '🎮 Classic') + ` · Round ${msg.room.roundNo || 1}`;

  // opponents — up to 3 get the classic ring positions; more switch the
  // strip to compact chips so an 11-opponent table stays readable.
  const oppCount = msg.seats.filter(s => !s.isYou).length;
  $('opponents').classList.toggle('many', oppCount > 3);
  $('opponents').innerHTML = msg.seats.filter(s => !s.isYou).map(s => `
    <div class="opp ${s.isCurrent ? 'current' : ''} ${s.connected ? '' : 'disc'}" data-voice-mark="${s.id}">
      <span class="av-wrap">${avatarHtml(s, msg.seats.indexOf(s))}${s.isCurrent && g ? '<svg class="turn-ring" viewBox="0 0 52 52" aria-hidden="true"><circle class="turn-ring-bg" cx="26" cy="26" r="23"/><circle class="turn-ring-fg" cx="26" cy="26" r="23"/></svg>' : ''}</span>
      <div><b>${esc(s.name)}</b>${badgeDotHtml(s)}${s.isBot ? ' 🤖' : ''}</div>
      <div class="muted">${s.cardCount} cards · ${s.score} pts${s.team ? ' · Team ' + s.team.toUpperCase() : ''}</div>
      <div class="backs">${introState ? (introState.dealt[s.id] ? backsHtml(Math.min(s.cardCount, introState.dealt[s.id])) : '') : backsHtml(Math.min(s.cardCount, 7))}</div>
      ${g && g.unoSuspect === s.id ? `<button class="catch" data-catch="${s.id}">CATCH!</button>` : ''}
    </div>`).join('');
  document.querySelectorAll('[data-catch]').forEach(b => b.onclick = () => send({ type: 'catch_uno', targetSeatId: b.dataset.catch }));

  // piles — the top card rests at its own slight tilt; during the round
  // intro the flip stays hidden until the deal completes
  $('discard-pile').innerHTML = g ? cardHtml(g.topCard, false) : '';
  const topEl = $('discard-pile').querySelector('.card');
  if (topEl && g) topEl.style.transform = 'rotate(' + tiltFor(g.topCard.id) + 'deg)';
  $('discard-pile').style.visibility = introState ? 'hidden' : '';
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
        ? `You owe ${g.pendingDraw} cards — stack a ${g.pendingKind === 'draw2' ? '+2 or +4' : '+4'}, ${g.pendingKind === 'wild4' && msg.room.rules.challenge ? 'challenge, ' : ''}or take them`
        : `${current ? current.name : 'Next player'} owes ${g.pendingDraw} cards`)
    : '';

  // actions
  $('btn-pass').classList.toggle('hidden', !(g && g.isYourTurn && g.drewCardId));
  $('btn-challenge').classList.toggle('hidden', !(g && g.canChallenge));
  const unoBtn = $('btn-uno');
  unoBtn.classList.toggle('armed', unoArmed);
  unoBtn.classList.toggle('pulse', !!(g && ((me && g.yourHand.length === 2 && g.isYourTurn) || g.unoSuspect === (me && me.id))));

  // my seat: badge dot + the turn ring around my own avatar
  $('my-info').innerHTML = me ? `${esc(me.name)}${badgeDotHtml(me)} · ${me.score} pts${me.team ? ' · Team ' + me.team.toUpperCase() : ''}` : '';
  $('my-ring').classList.toggle('hidden', !(g && me && me.isCurrent));
  // draw hint: my turn, nothing playable, nothing drawn yet -> I must
  // draw (or take the pending pile). The finger points at the pile.
  const mustDraw = !!(g && g.isYourTurn && !introState && g.legalCardIds.length === 0 && !g.drewCardId);
  $('draw-hint').classList.toggle('hidden', !mustDraw);
  $('draw-pile').classList.toggle('hint-pulse', mustDraw);

  // my hand
  if (g) {
    const legal = new Set(g.legalCardIds);
    const sorted = g.yourHand.slice().sort(cardSort);
    $('my-hand').innerHTML = sorted.map(c => cardHtml(c, legal.has(c.id), g.drewCardId === c.id)).join('');
    document.querySelectorAll('#my-hand .card').forEach(el => {
      el.onclick = () => onCardTap(el, el.dataset.id, legal.has(el.dataset.id));
    });
    // during the intro, my cards stay face-down until their deal flight lands
    if (introState) {
      document.querySelectorAll('#my-hand .card').forEach((el, i) => {
        if (i >= introState.revealedMe) el.classList.add('intro-hidden');
      });
    }
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

function onCardTap(el, cardId, playable) {
  if (introState) return; // the shuffle/deal intro owns the table
  if (!snap || !snap.game) return;
  if (!playable) { invalidFeedback(el, cardId); return; }
  const card = snap.game.yourHand.find(c => c.id === cardId);
  if (card && card.color === 'wild') { pendingWildCard = cardId; openColorPicker('wild'); return; }
  doPlay(cardId, undefined);
}

// Invalid-card feedback: shake the tapped card and float a Bengali hint
// near the hand explaining WHY it cannot be played, derived from the
// snapshot (turn, pending draw and its led kind, the just-drawn card).
let handHintTimer = null;
function invalidReason(cardId) {
  const g = snap && snap.game;
  if (!g) return 'রঙ বা নম্বর মিলছে না';
  if (!g.isYourTurn) return 'আপনার পালা নয়';
  if (g.pendingDraw > 0) {
    if (g.pendingKind === 'wild4') return '+4 মারতে হবে';
    return 'আগে ড্র কার্ড মারুন বা কার্ড তুলুন';
  }
  if (g.drewCardId && cardId !== g.drewCardId) return 'শুধু তোলা কার্ডটাই খেলতে পারবেন, নাহলে Pass করুন';
  return 'রঙ বা নম্বর মিলছে না';
}
function invalidFeedback(el, cardId) {
  if (el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }
  const hint = $('hand-hint');
  hint.textContent = invalidReason(cardId);
  hint.classList.remove('hidden');
  if (handHintTimer) clearTimeout(handHintTimer);
  handHintTimer = setTimeout(() => hint.classList.add('hidden'), 2200);
  sfx('skip');
}
function doPlay(cardId, chosenColor) {
  send({ type: 'play_card', cardId, chosenColor, callUno: unoArmed });
  unoArmed = false;
}

$('draw-pile').onclick = () => { if (!introState && snap && snap.game && snap.game.isYourTurn) send({ type: 'draw_card' }); };
$('btn-pass').onclick = () => { if (!introState) send({ type: 'pass' }); };
$('btn-challenge').onclick = () => { if (!introState) send({ type: 'challenge' }); };
$('btn-uno').onclick = () => {
  if (introState) return;
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
  if (introState) return;
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
  // Match scorecard: cumulative per-player counters for the whole
  // match (for Quick this IS the match; for multi-round games the line
  // under the table breaks out this round alone).
  const sc = $('end-scorecard');
  const stats = msg.stats || {};
  const rstats = msg.roundStats || {};
  if (Object.keys(stats).length) {
    const winnerTeam = winner ? winner.team : null;
    const roundPts = (s) => (winner && (s.id === winner.id || (winnerTeam && s.team === winnerTeam))) ? (lr.teamPoints || 0) : 0;
    sc.innerHTML = '<h4 class="scorecard-h">📊 Match scorecard</h4>' +
      '<table class="scorecard-table"><tr><th>Player</th><th>Played</th><th>UNO</th><th>Drawn</th><th>Rd pts</th></tr>' +
      msg.seats.map(s => {
        const t = stats[s.id] || { played: 0, uno: 0, drawn: 0 };
        const r = rstats[s.id] || { played: 0, uno: 0, drawn: 0 };
        return `<tr><td>${avatarHtml(s, 0, 'span')} ${esc(s.name)}${badgeDotHtml(s)}</td><td>${t.played}</td><td>${t.uno}</td><td>${t.drawn}</td><td>${roundPts(s)}</td></tr>` +
          (msg.room.roundNo > 1 ? `<tr class="scorecard-sub"><td colspan="5">এই রাউন্ডে: ${r.played} played · ${r.uno} UNO · ${r.drawn} drawn</td></tr>` : '');
      }).join('') + '</table>';
  } else {
    sc.innerHTML = '';
  }
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

// ------------------------------------------------------------ spoken announcements
// Client-side speechSynthesis event announcements (Addition: voice
// announcements). Driven by the same event stream as the toasts.
// Queue discipline: announcements from one burst of states (an inline
// bot chain can produce several in milliseconds) are collected for
// ~130ms, then coalesced — the LAST played card plus at most one
// special line (pending / UNO / win / block / color), never more than
// 2 utterances per burst, and a new burst cancels stale speech.
// Announcements ride the 🔊 sound toggle: sound off = no speech. They
// only start after the first user gesture (autoplay policy).
const ann = { unlocked: false, burst: null, timer: null };
document.addEventListener('pointerdown', () => { ann.unlocked = true; }, { passive: true });

function annVoice() {
  try {
    const vs = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    return (vs || []).find(v => /bn/i.test(v.lang || '')) || null;
  } catch { return null; }
}
function speakNow(text) {
  const synth = window.speechSynthesis;
  if (!synth || typeof synth.speak !== 'function') return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    const bn = annVoice();
    if (bn) { u.voice = bn; u.lang = 'bn-BD'; }
    u.rate = 1.05;
    synth.speak(u);
  } catch { /* speech is best-effort */ }
}
// kind: 'card' (a played card — only the last one of a burst is kept)
// or 'fx' (special lines — only the last one is kept alongside it).
function announce(text, kind) {
  if (!text || sfxState.muted || !ann.unlocked) return;
  if (!ann.burst) ann.burst = { card: null, fx: null };
  if (kind === 'card') ann.burst.card = text; else ann.burst.fx = text;
  if (ann.timer) return;
  ann.timer = setTimeout(() => {
    ann.timer = null;
    const b = ann.burst;
    ann.burst = null;
    if (!b || sfxState.muted) return;
    const synth = window.speechSynthesis;
    if (synth && typeof synth.cancel === 'function') { try { synth.cancel(); } catch { /* ignore */ } }
    if (b.card) speakNow(b.card);
    if (b.fx) speakNow(b.fx);
  }, 130);
}
function cardSpeech(card) {
  if (!card) return '';
  const kindName = {
    number: String(card.value), skip: 'Skip', reverse: 'Reverse',
    draw2: 'Draw Two', wild: 'Wild', wild4: 'Wild Draw Four',
  }[card.kind] || '';
  return card.color === 'wild' ? kindName : (COLOR_NAMES[card.color] + ' ' + kindName);
}
function bnCount(n) { return n === 2 ? '২' : n === 4 ? '৪' : String(n); }

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
      case 'played': announce(cardSpeech(e.card), 'card'); break;
      case 'skipped': toast(`${name(e.seatId)} is skipped!`); sfx('skip'); announce(`${name(e.seatId)} block!`, 'fx'); break;
      case 'reversed': toast('Direction reversed ⇋'); sfx('reverse'); announce('দিক বদলে গেল!', 'fx'); break;
      case 'pending': {
        toast(`${e.kind === 'draw2' ? '+2' : '+4'} — ${name(e.seatId)} owes ${e.total} cards!`); sfx('sting');
        const counter = e.kind === 'wild4' ? '+4 থাকলে মারো' : 'ড্র কার্ড থাকলে মারো';
        announce(`${name(e.seatId)}, ${counter}, নাহলে ${bnCount(e.total)}টা কার্ড তুলতে হবে`, 'fx');
        break;
      }
      case 'took_pending': toast(`${name(e.seatId)} took ${e.count} cards`); sfx('draw'); break;
      case 'challenge_won': toast(`Bluff caught! ${name(e.accused)} draws ${e.count || 4}`); sfx('sting'); break;
      case 'challenge_lost': toast(`Challenge failed — ${name(e.seatId)} draws ${e.count}`); sfx('sting'); break;
      case 'uno_called': toast(`${name(e.seatId)}: UNO!`); showUnoPop(name(e.seatId)); sfx('uno'); announce(`${name(e.seatId)} UNO!`, 'fx'); break;
      case 'uno_suspect': toast(`${name(e.seatId)} has ONE card — catch them before their turn is safe!`); sfx('alert'); break;
      case 'uno_caught': toast(`Caught! ${name(e.seatId)} forgot UNO and draws 2`); sfx('sting'); announce(`${name(e.seatId)} UNO বলতে ভুলেছে — ২টা কার্ড!`, 'fx'); break;
      case 'timeout': toast(`${name(e.seatId)} ran out of time`); sfx('skip'); break;
      case 'color_chosen': toast(`Color is now ${COLOR_NAMES[e.color]}`); sfx('click'); announce(`${COLOR_NAMES[e.color]} বাছাই হয়েছে`, 'fx'); break;
      case 'round_end': {
        const winner = msg.seats.find(s => s.id === e.winnerSeatId);
        if (winner) announce(winner.isYou ? 'আপনি জিতেছেন!' : `${winner.name} জিতেছে!`, 'fx');
        break;
      }
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
let lastTickSec = -1;
const RING_C = 2 * Math.PI * 23; // turn-ring circumference (r=23)
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
    // Turn rings around the current player's avatar deplete with the
    // same deadline; red in the last 10 seconds.
    document.querySelectorAll('.turn-ring-fg').forEach(c => {
      c.style.strokeDashoffset = (RING_C * (1 - left / total)).toFixed(1);
      c.style.stroke = left < 10000 ? 'var(--red)' : 'var(--green)';
    });
    // Timer warning ticks: once per second in MY last 10 seconds, soft,
    // and never over announcement speech.
    if (g.isYourTurn && left <= 10000 && left > 0) {
      const sec = Math.ceil(left / 1000);
      if (sec !== lastTickSec) {
        lastTickSec = sec;
        if (!(window.speechSynthesis && window.speechSynthesis.speaking)) sfx('tick');
      }
    } else if (!g.isYourTurn) {
      lastTickSec = -1;
    }
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
// Optional — the game works fully without it.
//
// Why voice used to fail silently on real phones (fixed in this pass):
//  1. ICE candidates that arrived BEFORE the remote description were
//     passed straight to addIceCandidate, which throws in that state —
//     the catch swallowed the error and the candidate was LOST. On
//     mobile NATs the srflx/relay candidates are exactly the early
//     ones, so pairs never connected. Candidates are now queued per
//     peer and flushed after setRemoteDescription.
//  2. Only the joiner ever offered, and an existing member dropped its
//     peer connection on voice_peer_joined expecting a fresh offer —
//     any hiccup (reconnect, simultaneous join) left pairs with no
//     working connection at all. Negotiation is now PERFECT
//     NEGOTIATION: both sides may offer; the "polite" peer (higher
//     seat number) rolls back on glare, so every pair converges to
//     exactly one working connection.
//  3. Remote <audio> elements were created detached in ontrack and
//     play() was never called — mobile browsers block that. Elements
//     are now created per peer as the peer is set up, play() is called
//     on track arrival and on connection, and a pointerdown unlock
//     retries playback.
//  4. STUN alone cannot cross symmetric NATs (most mobile data). The
//     client now fetches ICE servers from /api/turn-credentials, which
//     adds short-lived Cloudflare TURN credentials when the server has
//     a TURN key configured (STUN-only fallback otherwise).
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const voice = {
  joined: false, muted: false, rejoinPending: false,
  stream: null, ctx: null,
  iceServers: null, iceCache: null,
  peers: new Map(),  // seatId -> { pc, audio, polite, makingOffer, ignoreOffer, iceQueue, closed }
  levels: new Map(), // seatId -> { analyser, data }
  meterTimer: null,
};

function mySeatId() { return snap && snap.you ? snap.you.seatId : null; }
function seatNum(id) { const n = parseInt(String(id || '').replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : 0; }

function voiceNote(text) {
  document.querySelectorAll('.voice-note').forEach(el => { el.textContent = text; });
  if (text) toast(text);
}

// ICE servers for this session: TURN credentials when the server can
// mint them, STUN-only otherwise. Fetched once, on the Join Voice tap.
async function getIceServers() {
  if (voice.iceCache) return voice.iceCache;
  const r = await apiGet('/api/turn-credentials');
  if (r.ok && r.data && Array.isArray(r.data.iceServers) && r.data.iceServers.length) {
    voice.iceCache = r.data.iceServers;
  }
  return voice.iceCache || ICE_SERVERS;
}

async function joinVoice() {
  if (voice.joined) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof RTCPeerConnection === 'undefined') {
    return voiceNote('Voice chat needs a secure page (HTTPS or localhost) and a browser with microphone support.');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    return voiceNote('মাইক্রোফোনের অনুমতি দিন / Microphone permission needed — allow mic access in your browser settings, then tap Join Voice again.');
  }
  voice.iceServers = await getIceServers();
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
  // The late joiner sets up a connection to EVERY existing voice
  // member; adding the local track fires negotiationneeded, so the
  // joiner offers to all of them (perfect negotiation resolves any
  // simultaneous offers from the other side).
  for (const seatId of msg.peers || []) peerFor(seatId);
}

function onVoicePeerJoined(seatId) {
  if (!voice.joined) return;
  const p = voice.peers.get(seatId);
  if (p && (p.pc.connectionState === 'failed' || p.pc.connectionState === 'closed')) closePeer(seatId);
  peerFor(seatId); // ensure a connection exists; negotiation does the rest
}

async function flushIce(p) {
  const queued = p.iceQueue.splice(0, p.iceQueue.length);
  for (const c of queued) {
    try { await p.pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* stale candidate */ }
  }
}

async function onVoiceSignal(msg) {
  if (!voice.joined || !msg.data) return;
  const from = msg.fromSeatId;
  const data = msg.data;
  const p = peerFor(from);
  try {
    if (data.kind === 'offer') {
      const collision = p.makingOffer || p.pc.signalingState !== 'stable';
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return; // the polite side's offer wins; ours stands
      if (collision) { try { await p.pc.setLocalDescription({ type: 'rollback' }); } catch { /* no local offer to roll back */ } }
      await p.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      await flushIce(p);
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      send({ type: 'voice_signal', toSeatId: from, data: { kind: 'answer', sdp: p.pc.localDescription } });
    } else if (data.kind === 'answer') {
      if (p.pc.signalingState === 'have-local-offer') {
        await p.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        await flushIce(p);
      }
    } else if (data.kind === 'ice') {
      if (!data.candidate) return;
      if (p.pc.remoteDescription) {
        try { await p.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch { /* stale candidate */ }
      } else {
        p.iceQueue.push(data.candidate); // too early — queue, never drop
      }
    }
  } catch { /* a failed negotiation just means that peer stays silent */ }
}

function peerFor(seatId) {
  const existing = voice.peers.get(seatId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers: voice.iceServers || ICE_SERVERS });
  const p = {
    pc, audio: null, iceQueue: [], makingOffer: false, ignoreOffer: false, closed: false,
    // Perfect-negotiation roles by seat order: exactly one side of
    // each pair is polite (the higher seat number), so glare always
    // resolves the same way.
    polite: seatNum(mySeatId()) > seatNum(seatId),
  };
  voice.peers.set(seatId, p);
  // The remote audio element exists from the start (created on the
  // back of the Join Voice gesture), so mobile autoplay policies see
  // a user-activated element; the stream attaches on ontrack.
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.playsInline = true;
  $('voice-audios').appendChild(audio);
  p.audio = audio;
  pc.onicecandidate = (ev) => {
    if (ev.candidate) send({ type: 'voice_signal', toSeatId: seatId, data: { kind: 'ice', candidate: ev.candidate } });
  };
  pc.ontrack = (ev) => {
    p.audio.srcObject = ev.streams[0];
    if (p.audio.play) p.audio.play().catch(() => { /* the pointerdown unlock retries */ });
    addAnalyser(seatId, ev.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected' && p.audio && p.audio.srcObject && p.audio.play) {
      p.audio.play().catch(() => { /* unlock retries on next tap */ });
    }
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(seatId);
  };
  pc.onnegotiationneeded = async () => {
    if (p.makingOffer || p.closed) return;
    p.makingOffer = true;
    try {
      const offer = await pc.createOffer();
      if (p.closed) return;
      await pc.setLocalDescription(offer);
      send({ type: 'voice_signal', toSeatId: seatId, data: { kind: 'offer', sdp: pc.localDescription } });
    } catch { /* peer will stay silent; game is unaffected */ } finally {
      p.makingOffer = false;
    }
  };
  if (voice.stream) voice.stream.getTracks().forEach(t => pc.addTrack(t, voice.stream));
  return p;
}

// Mobile autoplay unlock: any tap retries playback of remote audio.
document.addEventListener('pointerdown', () => {
  voice.peers.forEach(p => {
    if (p.audio && p.audio.srcObject && p.audio.play) p.audio.play().catch(() => { /* still blocked */ });
  });
}, { passive: true });

function closePeer(seatId) {
  const p = voice.peers.get(seatId);
  if (!p) return;
  p.closed = true;
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

// ------------------------------------------------------------ round intro
// Staged round opening, layered over the (already dealt) start snapshot:
// the deck is visibly shuffled on the table, then cards are dealt one by
// one — a card-back flight from the deck to every seat in turn order,
// the player's own cards flipping face-up as they land — and only then
// does the first turn begin. Purely presentational: the server state is
// already final, game input is blocked while it runs (see the guards on
// the action handlers), and it is skipped for a round that has already
// begun (mid-round join / reconnect), which roundProgressed() detects.
const INTRO_DEFAULTS = { shuffleMs: 1100, flightMs: 210 };
let introState = null; // { phase, dealt: {seatId: n}, revealedMe, landed, total }

function tiltFor(cardId) {
  let h = 0;
  const s = String(cardId || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 9) - 4; // a natural, stable -4°..+4° resting tilt per card
}

function roundProgressed(msg) {
  const g = msg.game;
  if (!g) return true;
  if (msg.seats.some(s => s.cardCount !== 7)) return true;
  const playedTypes = ['played', 'drew', 'timeout', 'skipped', 'reversed', 'color_chosen', 'took_pending', 'pending', 'caught', 'challenge'];
  return (msg.events || []).some(e => playedTypes.includes(e.type));
}

function runIntro(msg) {
  const T = Object.assign({}, INTRO_DEFAULTS, window.UNO_INTRO_TIMING || {});
  const total = msg.seats.length * 7;
  const stagger = Math.max(12, Math.min(38, Math.round(1700 / Math.max(1, total))));
  const st = introState = { phase: 'shuffle', dealt: {}, revealedMe: 0, landed: 0, total };
  window.__intro = st;
  $('view-game').classList.add('intro-on');

  // Phase 1 — the shuffle: a riffle visual over the draw pile.
  const pile = $('draw-pile');
  const pr = pile ? pile.getBoundingClientRect() : null;
  let shEl = null;
  if (pr && pr.width) {
    shEl = document.createElement('div');
    shEl.className = 'shuffle-fx';
    shEl.innerHTML = '<div class="sh-half sh-l"></div><div class="sh-half sh-r"></div><div class="card back sh-top"><span>UNO<br>Adda</span></div>';
    shEl.style.left = pr.left + 'px';
    shEl.style.top = pr.top + 'px';
    shEl.style.width = pr.width + 'px';
    shEl.style.height = pr.height + 'px';
    document.body.appendChild(shEl);
  }

  setTimeout(() => {
    if (shEl) shEl.remove();
    if (introState !== st) return;
    st.phase = 'deal';
    try { sfx('deal'); } catch { /* sound must never break the intro */ }
    // Phase 2 — deal one by one, round-robin in seat order.
    const handCards = Array.from(document.querySelectorAll('#my-hand .card'));
    let seq = 0;
    for (let round = 0; round < 7; round++) {
      for (const s of msg.seats) {
        const delay = seq * stagger;
        seq++;
        let toRect = null;
        if (s.isYou) {
          const el = handCards[round];
          if (el) toRect = el.getBoundingClientRect();
        } else {
          const el = document.querySelector('#opponents .opp[data-voice-mark="' + s.id + '"]');
          if (el) toRect = cardRectAround(el.getBoundingClientRect(), 40, 58);
        }
        dealFly(pr, toRect, delay, T.flightMs, () => {
          if (introState !== st) return;
          st.landed++;
          if (s.isYou) {
            st.revealedMe = Math.max(st.revealedMe, round + 1);
            const el = handCards[round];
            if (el) el.classList.remove('intro-hidden');
          } else {
            st.dealt[s.id] = (st.dealt[s.id] || 0) + 1;
          }
          if (st.landed >= st.total) finishIntro(st);
        });
      }
    }
    // Layout-less environments still complete on the same schedule.
    setTimeout(() => finishIntro(st), total * stagger + T.flightMs + 400);
  }, T.shuffleMs);
}

function finishIntro(st) {
  if (introState !== st) return;
  st.phase = 'done';
  introState = null;
  window.__intro = st;
  $('view-game').classList.remove('intro-on');
  if (snap) renderGame(snap);
}

// One card-back flight from the deck to a seat. State progression is
// driven by timers (never by the animation itself), so a missing or
// interrupted animation can never stall the intro.
function dealFly(fromRect, toRect, delayMs, flightMs, onLand) {
  let done = false;
  const land = () => { if (!done) { done = true; if (onLand) onLand(); } };
  if (fromRect && fromRect.width && toRect && toRect.width) {
    const wrap = document.createElement('div');
    wrap.className = 'fly-wrap deal-fx';
    wrap.innerHTML = '<div class="card back"><span>UNO<br>Adda</span></div>';
    wrap.style.left = fromRect.left + 'px';
    wrap.style.top = fromRect.top + 'px';
    wrap.style.width = fromRect.width + 'px';
    wrap.style.height = fromRect.height + 'px';
    document.body.appendChild(wrap);
    const dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
    const dy = (toRect.top + toRect.height / 2) - (fromRect.top + fromRect.height / 2);
    const scale = toRect.width / fromRect.width;
    if (wrap.animate) {
      try {
        const anim = wrap.animate([
          { transform: 'translate(0px, 0px) rotate(0deg) scale(1)' },
          { transform: `translate(${dx}px, ${dy}px) rotate(6deg) scale(${scale})` },
        ], { duration: flightMs, delay: delayMs, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'backwards' });
        anim.onfinish = () => { wrap.remove(); land(); };
      } catch { setTimeout(() => { wrap.remove(); land(); }, delayMs + flightMs); }
    } else {
      wrap.style.transitionDuration = flightMs + 'ms';
      setTimeout(() => { wrap.style.transform = `translate(${dx}px, ${dy}px) rotate(6deg) scale(${scale})`; }, delayMs);
      setTimeout(() => { wrap.remove(); land(); }, delayMs + flightMs + 60);
    }
    setTimeout(land, delayMs + flightMs + 1500); // a lost animation never stalls the deal
  } else {
    setTimeout(land, delayMs + flightMs);
  }
}

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

  // fresh round dealt? Run the staged intro (shuffle → one-by-one deal)
  // over the start snapshot — unless the round has already begun, which
  // is the case for a mid-round join or a reconnect.
  const dealKey = msg.room.code + '|' + msg.room.roundNo;
  const freshRound = msg.room.status === 'playing' && fxDealKey !== dealKey &&
    (!fxPrev || fxPrev.room.status !== 'playing' || fxPrev.room.roundNo !== msg.room.roundNo);
  if (freshRound) {
    fxDealKey = dealKey;
    if (!roundProgressed(msg)) { runIntro(msg); return; }
  }
  if (introState) return; // the intro owns the table until it completes

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
      if (from) flew = flyCard(cardHtml(g.topCard, false), from, toRect, top, { arc: true, tilt: tiltFor(g.topCard.id) });
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

  // the turn came around to me: chime + a short buzz + the spoken
  // "আপনার পালা". Because bot chains resolve inline, intermediate
  // states never show my turn — this fires only when the turn actually
  // settles on me.
  if (g.isYourTurn && !pg.isYourTurn) {
    sfx('turn');
    try { if (navigator.vibrate) navigator.vibrate(80); } catch { /* no vibrate API */ }
    announce('আপনার পালা', 'fx');
  }

  // social sounds: a human joining or leaving this room
  if (fxPrev && fxPrev.room.code === msg.room.code) {
    const before = new Set(fxPrev.seats.filter(s => !s.isBot).map(s => s.id));
    const nowIds = new Set(msg.seats.filter(s => !s.isBot).map(s => s.id));
    for (const id of nowIds) if (!before.has(id)) sfx('join');
    for (const id of before) if (!nowIds.has(id)) sfx('leave');
  }

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

function flyCard(html, fromRect, toRect, hideEl, opts) {
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
  const tilt = opts && typeof opts.tilt === 'number' ? opts.tilt : 7;
  // Played cards arc: lift off the hand, sail with a slight rotation,
  // land on the pile with a small bounce at the card's resting tilt.
  if (opts && opts.arc && wrap.animate) {
    const lift = Math.min(64, Math.hypot(dx, dy) * 0.22 + 22);
    try {
      const anim = wrap.animate([
        { transform: 'translate(0px, 0px) rotate(0deg) scale(1)' },
        { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - lift}px) rotate(${tilt * 0.3}deg) scale(${1 + (scale - 1) * 0.55})`, offset: 0.55 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${tilt}deg) scale(${scale * 1.06})`, offset: 0.85 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${tilt}deg) scale(${scale})`, offset: 1 },
      ], { duration: 500, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' });
      let cleaned = false;
      const cleanup = () => { if (!cleaned) { cleaned = true; wrap.remove(); if (hideEl) hideEl.style.opacity = ''; } };
      anim.onfinish = cleanup;
      setTimeout(cleanup, 750);
      return true;
    } catch { /* fall through to the transition path */ }
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    wrap.style.transform = `translate(${dx}px, ${dy}px) rotate(${tilt}deg) scale(${scale})`;
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
  else if (winner) sfx('lose'); // someone else took the round — gentle descending tone
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
    case 'turn': tone(1046, 1046, .12, { type: 'triangle', gain: .06 }); tone(1568, 1568, .18, { type: 'triangle', gain: .05, delay: .08 }); break;
    case 'tick': tone(1250, 1250, .03, { type: 'sine', gain: .018 }); break;
    case 'join': tone(520, 940, .09, { type: 'triangle', gain: .06 }); break;
    case 'leave': tone(700, 420, .1, { type: 'triangle', gain: .045 }); break;
    case 'match': [659, 880, 1318].forEach((f, i) => tone(f, f, .12, { type: 'triangle', gain: .07, delay: i * .07 })); break;
    case 'lose': [392, 330, 262].forEach((f, i) => tone(f, f, .22, { type: 'sine', gain: .055, delay: i * .13 })); break;
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
  if (!sfxState.muted) { sfx('click'); musicStart(); } else musicStop();
};
paintSoundBtn();

// ------------------------------------------------------------ background music
// A light procedural ambient loop (WebAudio oscillators only — no
// files): a slow C–Am–F–G chord drift at very low volume, casino-lobby
// feel. Starts only after the first user gesture, has its own 🎵
// toggle (choice remembered), pauses when the tab is hidden, and is
// silenced by the main sound toggle too.
const musicState = { on: localStorage.getItem('uno-adda-music') !== '0', timer: null, nextAt: 0, chord: 0 };
const MUSIC_CHORDS = [
  [261.63, 329.63, 392.0],   // C
  [220.0, 261.63, 329.63],   // Am
  [174.61, 220.0, 261.63],   // F
  [196.0, 246.94, 293.66],   // G
];
function musicToneAt(freq, t0, dur) {
  const ctx = sfxState.ctx;
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gn = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t0);
    gn.gain.setValueAtTime(0, t0);
    gn.gain.linearRampToValueAtTime(.026, t0 + .15);
    gn.gain.exponentialRampToValueAtTime(.0008, t0 + dur);
    osc.connect(gn); gn.connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + dur + .05);
  } catch { /* music is best-effort */ }
}
function musicSchedule() {
  const ctx = sfxState.ctx;
  if (!ctx) return;
  if (musicState.nextAt < ctx.currentTime) musicState.nextAt = ctx.currentTime + .1;
  while (musicState.nextAt < ctx.currentTime + 1.2) {
    const chord = MUSIC_CHORDS[musicState.chord % MUSIC_CHORDS.length];
    chord.forEach((f, i) => musicToneAt(f, musicState.nextAt + i * .23, 1.9));
    musicToneAt(chord[0] / 2, musicState.nextAt, 2.3); // soft bass root
    musicState.nextAt += 2.4;
    musicState.chord++;
  }
}
function musicStart() {
  if (musicState.timer || !musicState.on || sfxState.muted) return;
  if (!sfxEnsure()) return;
  musicSchedule();
  musicState.timer = setInterval(musicSchedule, 400);
}
function musicStop() {
  if (musicState.timer) { clearInterval(musicState.timer); musicState.timer = null; }
}
function paintMusicBtn() {
  $('btn-music').classList.toggle('off', !musicState.on);
}
$('btn-music').onclick = () => {
  musicState.on = !musicState.on;
  localStorage.setItem('uno-adda-music', musicState.on ? '1' : '0');
  paintMusicBtn();
  if (musicState.on) musicStart(); else musicStop();
};
paintMusicBtn();
document.addEventListener('pointerdown', () => { musicStart(); }, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) musicStop();
  else musicStart();
});

// ------------------------------------------------------------ badges & skins
// Profile badge tiers from lifetime account wins: Bronze 10+, Silver
// 50+, Gold 150+. One helper maps wins -> tier everywhere it renders.
function badgeTier(wins) {
  const w = Number(wins) || 0;
  if (w >= 150) return { id: 'gold', label: 'Gold', emoji: '🥇' };
  if (w >= 50) return { id: 'silver', label: 'Silver', emoji: '🥈' };
  if (w >= 10) return { id: 'bronze', label: 'Bronze', emoji: '🥉' };
  return null;
}
function badgeChipHtml(wins) {
  const t = badgeTier(wins);
  return t ? `<span class="badge-tier tier-${t.id}">${t.emoji} ${t.label}</span>` : '';
}
function badgeDotHtml(s) {
  const t = s ? badgeTier(s.wins) : null;
  return t ? ` <span class="badge-dot dot-${t.id}" title="${t.label} player · ${s.wins} wins"></span>` : '';
}

// Table skins: local cosmetics persisted in localStorage; a class on
// the game view re-tints the felt + ring (tint overlay over the art).
function applySkin() {
  const skin = localStorage.getItem('uno-adda-skin') || 'green';
  const v = $('view-game');
  v.classList.toggle('skin-blue', skin === 'blue');
  v.classList.toggle('skin-purple', skin === 'purple');
  document.querySelectorAll('.skin-pick').forEach(b => b.classList.toggle('selected', b.dataset.skin === skin));
}
document.querySelectorAll('.skin-pick').forEach(b => {
  b.onclick = () => { localStorage.setItem('uno-adda-skin', b.dataset.skin); applySkin(); sfx('click'); };
});
applySkin();
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
  if (typeof paintTierStates === 'function') paintTierStates();
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

// ------------------------------------------------------------ mode navigation
// The lobby is ONLY a header + the 4 mode tiles. Every tile opens a
// dedicated full-screen mode view (its own screen, back button, and
// one big action); no options ever expand inline in the lobby.
function openMode(name) {
  showView(name);
  if (name === 'quick') paintTierStates();
  sfx('click');
}
document.querySelectorAll('.tile').forEach(t => { t.onclick = () => openMode(t.dataset.tile); });
document.querySelectorAll('[data-back]').forEach(b => { b.onclick = () => { showView('home'); sfx('click'); }; });

// ------------------------------------------------------------ quick tiers
let selectedTier = TIERS[0];
$('tier-list').innerHTML = TIERS.map(t => `
  <button class="tier" data-tier="${t.id}">
    <span class="tier-main">
      <span class="tier-name">${t.name}</span>
      <span class="tier-tag">Winner takes the pot · pot <img class="coin-ic" src="art/coin.webp" alt=""> ${t.bet * 2}</span>
      <span class="tier-cant hidden">Not enough coins</span>
    </span>
    <span class="tier-bet"><img class="coin-ic" src="art/coin.webp" alt=""> ${t.bet}</span>
  </button>`).join('');
function selectTier(t) {
  if (!t) return;
  selectedTier = t;
  paintTierStates();
  sfx('click');
}
function paintTierStates() {
  document.querySelectorAll('.tier').forEach(b => {
    const t = TIERS.find(x => x.id === b.dataset.tier);
    if (!t) return;
    b.classList.toggle('selected', selectedTier && t.id === selectedTier.id);
    const cant = wallet.balance < t.bet;
    b.classList.toggle('cant-afford', cant);
    const badge = b.querySelector('.tier-cant');
    if (badge) badge.classList.toggle('hidden', !cant);
  });
  if (selectedTier) {
    $('btn-quick-find').textContent = `🔎 Find Match · stake ${selectedTier.bet} 🪙`;
    $('quick-note').textContent = wallet.balance < selectedTier.bet
      ? `You have ${wallet.balance} coins — this tier needs ${selectedTier.bet}. Claim the Daily Gift 🎁 or pick a cheaper tier; a free refill may apply at Find Match.`
      : `Winner takes the pot: ${selectedTier.bet * 2} coins. Stake is deducted only when the match starts.`;
  }
}
document.querySelectorAll('.tier').forEach(b => {
  b.onclick = () => selectTier(TIERS.find(t => t.id === b.dataset.tier));
});
$('btn-quick-find').onclick = () => startQuickMatch(selectedTier);

// ------------------------------------------------------------ mode pickers (bots / friends)
let botsPick = 2;
document.querySelectorAll('#bots-pick-row .seg-card').forEach(b => {
  b.onclick = () => {
    botsPick = Number(b.dataset.bots) || 2;
    document.querySelectorAll('#bots-pick-row .seg-card').forEach(x => x.classList.toggle('selected', x === b));
    sfx('click');
  };
});
let friendMode = 'classic';
document.querySelectorAll('#mode-pick-row .seg-card').forEach(b => {
  b.onclick = () => {
    friendMode = b.dataset.mode || 'classic';
    document.querySelectorAll('#mode-pick-row .seg-card').forEach(x => x.classList.toggle('selected', x === b));
    sfx('click');
  };
});
let seatsPick = 4;
document.querySelectorAll('#seats-pick-row .seg-chip').forEach(b => {
  b.onclick = () => {
    seatsPick = Number(b.dataset.seats) || 4;
    document.querySelectorAll('#seats-pick-row .seg-chip').forEach(x => x.classList.toggle('selected', x === b));
    sfx('click');
  };
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

// ------------------------------------------------------------ live matchmaking
// Quick Match and Go Wild are LIVE-only: a dedicated socket to the
// MatchmakerDO (/ws-match) queues this player in exactly one pool
// ('quick:<bet>' or 'wild'); pools are strictly isolated server-side.
// NO stake is deducted while queueing — the Quick stake moves only
// when the match actually starts (see deductLiveStake), so a search
// that finds nobody, or an opponent who never shows, costs nothing.
let quick = null; // { tier, bet, roomCode, deductedFor, settledKey, payout }
let live = null;  // { kind: 'quick'|'wild', pool, tier, bet, startedAt, notFound }
let mmWs = null;
let mmElapsedTimer = null;
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
  quick = { tier, bet: tier.bet, roomCode: null, deductedFor: null, settledKey: null, payout: 0 };
  startLiveSearch('quick', tier);
}

function startWildMatch() {
  startLiveSearch('wild', null);
}

function poolLabel() {
  if (!live) return '';
  return live.kind === 'quick'
    ? `Quick Match · ${live.tier.name} · stake ${live.bet}`
    : 'Go Wild — Live · no stakes';
}

function startLiveSearch(kind, tier) {
  live = {
    kind,
    tier: tier || null,
    bet: tier ? tier.bet : 0,
    pool: kind === 'quick' ? 'quick:' + tier.bet : 'wild',
    startedAt: Date.now(),
    notFound: false,
  };
  $('mm-title').textContent = kind === 'quick' ? '⚡ Finding a live player…' : '🌈 Finding a live player…';
  $('mm-pool-label').textContent = kind === 'quick'
    ? 'Quick Match · one round · winner takes the pot'
    : 'Go Wild — Live · first to 500';
  $('mm-searching').classList.remove('hidden');
  $('mm-notfound').classList.add('hidden');
  renderMmSlots(null);
  $('mm-modal').classList.remove('hidden');
  if (mmElapsedTimer) clearInterval(mmElapsedTimer);
  mmElapsedTimer = setInterval(paintMmElapsed, 250);
  paintMmElapsed();
  openMmSocket();
}

function paintMmElapsed() {
  if (!live) return;
  const sec = Math.floor((Date.now() - live.startedAt) / 1000);
  $('mm-elapsed').textContent = `Searching… ${sec}s · ${poolLabel()}`;
  // At ~35s show the not-found panel even though the server queue
  // entry lives until its 40s TTL — a match landing in the gap still
  // proceeds straight into the game.
  if (sec >= 35 && !live.notFound) showNotFound();
}

function openMmSocket() {
  if (mmWs && mmWs.readyState <= 1) { sendFindMatch(); return; }
  mmWs = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws-match');
  mmWs.onerror = () => {}; // surfaced through onclose
  mmWs.onopen = () => sendFindMatch();
  mmWs.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'matched') onMatched(msg);
    else if (msg.type === 'match_timeout') showNotFound();
    else if (msg.type === 'error') {
      showError(msg.message);
      if (/Session expired/.test(msg.message)) { teardownLiveSearch(true); forceLogout(); }
    }
  };
  mmWs.onclose = () => {
    mmWs = null;
    if (live && !live.notFound) showNotFound(); // server unreachable mid-search
  };
}

function sendFindMatch() {
  if (mmWs && mmWs.readyState === 1 && live) {
    mmWs.send(JSON.stringify({ type: 'find_match', pool: live.pool, session: sessionToken, avatar: profile.avatar }));
  }
}

function showNotFound() {
  if (!live || live.notFound) return;
  live.notFound = true;
  if (mmElapsedTimer) { clearInterval(mmElapsedTimer); mmElapsedTimer = null; }
  $('mm-searching').classList.add('hidden');
  $('mm-notfound').classList.remove('hidden');
}

function teardownLiveSearch(closeSocket) {
  if (mmElapsedTimer) { clearInterval(mmElapsedTimer); mmElapsedTimer = null; }
  live = null;
  if (closeSocket && mmWs) {
    const s = mmWs;
    mmWs = null;
    s.onclose = s.onmessage = s.onopen = null;
    try { s.close(); } catch { /* already gone */ }
  }
  $('mm-modal').classList.add('hidden');
  $('vs-modal').classList.add('hidden');
}

function cancelLiveSearch() {
  if (mmWs && mmWs.readyState === 1) {
    try { mmWs.send(JSON.stringify({ type: 'cancel_queue' })); } catch { /* ignore */ }
  }
  teardownLiveSearch(true);
}
$('btn-mm-cancel').onclick = () => {
  const backTo = live && live.kind === 'wild' ? 'wild' : 'quick';
  cancelLiveSearch();
  quick = null;
  showView(backTo); // searching cancels back to the mode screen, not the lobby
};
$('btn-mm-retry').onclick = () => {
  if (!live) return;
  live.startedAt = Date.now();
  live.notFound = false;
  $('mm-notfound').classList.add('hidden');
  $('mm-searching').classList.remove('hidden');
  if (mmElapsedTimer) clearInterval(mmElapsedTimer);
  mmElapsedTimer = setInterval(paintMmElapsed, 250);
  paintMmElapsed();
  openMmSocket();
};
$('btn-mm-bots').onclick = () => {
  cancelLiveSearch();
  quick = null;
  openMode('bots');
};

function renderMmSlots(opponent) {
  const box = $('mm-slots');
  if (!box) return;
  box.innerHTML = `
    <div class="mm-slot filled">${avatarHtml({ photo: account && account.photo, avatar: myAvatar() }, 0, 'span')}<b>${esc(myName())}</b></div>
    ${opponent
      ? `<div class="mm-slot filled">${avatarHtml(opponent, 1, 'span')}<b>${esc(opponent.name)}</b></div>`
      : `<div class="mm-slot"><span class="avatar avq">?</span><b>Searching…</b></div>`}`;
}

// A match was found: VS screen up, room join in parallel (the reserved
// seat waits 20s — plenty). The matchmaker socket's job is done.
function onMatched(msg) {
  if (!live) return;
  const kind = live.kind;
  const bet = live.bet;
  if (mmElapsedTimer) { clearInterval(mmElapsedTimer); mmElapsedTimer = null; }
  if (mmWs) {
    const s = mmWs;
    mmWs = null;
    s.onclose = s.onmessage = s.onopen = null;
    try { s.close(); } catch { /* ignore */ }
  }
  if (quick && kind === 'quick') quick.roomCode = msg.code;
  live = null;
  sfx('match');
  renderMmSlots(msg.opponent);
  $('mm-modal').classList.add('hidden');
  showLiveVS(msg.opponent, kind, bet);
  routeCode = msg.code;
  connect(() => send({
    type: 'join_room', code: msg.code, ticket: msg.ticket,
    name: myName(), avatar: profile.avatar, session: sessionToken,
  }));
}

function showLiveVS(opponent, kind, bet) {
  paintAvatarEl($('vs-my-avatar'), 'avatar', { photo: account && account.photo, avatar: myAvatar() }, 0);
  $('vs-my-name').textContent = myName();
  $('vs-my-badge').innerHTML = badgeChipHtml(account && account.wins);
  $('vs-opps').innerHTML = opponent ? `
    <div class="vs-card">${avatarHtml(opponent, 0, 'span')}<b>${esc(opponent.name)}</b>${badgeChipHtml(opponent.wins)}</div>` : '';
  $('vs-sub').textContent = kind === 'quick'
    ? `⚡ Quick Match · stake ${bet} · winner takes the pot (${bet * 2})`
    : '🌈 Go Wild — Live · first to 500';
  $('vs-modal').classList.remove('hidden');
  setTimeout(() => $('vs-modal').classList.add('hidden'), 1800);
}

// The Quick stake leaves the wallet exactly once per room: when the
// first PLAYING state of the matched room arrives (both players in,
// game started). Pre-start failure therefore costs nothing, ever.
function deductLiveStake(msg) {
  if (!quick || !msg.room.quick || msg.room.liveKind !== 'quick') return;
  if (msg.room.code !== quick.roomCode || msg.room.status !== 'playing') return;
  if (quick.deductedFor === msg.room.code) return;
  quick.deductedFor = msg.room.code;
  apiPost('/api/wallet/adjust', { amount: -quick.bet, reason: 'stake' })
    .then((r) => {
      if (r.ok && r.data) setCoins(r.data.coins);
      else toast('Stake could not be taken — this match is on the house.');
    });
}

// Settle a finished quick match exactly once per room+round: the pot
// (both stakes) is credited to the account wallet and the match is
// recorded in the stats. The pot is only paid when the stake actually
// left this wallet (deductedFor), so a failed deduction mints nothing.
function settleQuick(msg) {
  if (!quick || !msg.room.quick || msg.room.status !== 'roundEnd' || !msg.lastRound) return;
  const key = msg.room.code + '|' + msg.room.roundNo;
  if (quick.settledKey === key) return;
  quick.settledKey = key;
  const winner = msg.seats.find(s => s.id === msg.lastRound.winnerSeatId);
  const pot = (msg.room.bet || quick.bet) * msg.seats.length;
  if (winner && winner.isYou && quick.deductedFor === msg.room.code) {
    quick.payout = pot;
    coinBurst($('game-topbar'));
    apiPost('/api/wallet/adjust', { amount: pot, reason: 'pot' })
      .then((r) => { if (r.ok && r.data) setCoins(r.data.coins); });
    apiStatsMatch(true, pot);
  } else {
    quick.payout = 0;
    apiStatsMatch(!!(winner && winner.isYou), 0);
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
      <span class="board-name">${esc(e.name)} ${badgeChipHtml(e.wins)}</span>
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
  for (const v of ALL_VIEWS) { const el = $('view-' + v); if (el) el.classList.toggle('hidden', v !== 'auth'); }
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
  onAppEntry();
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
  teardownLiveSearch(true);
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
  $('profile-badge').innerHTML = badgeChipHtml(account.wins) ||
    '<span class="muted">No badge yet — 10 wins earns Bronze 🥉</span>';
  $('stat-matches').textContent = account.matches;
  $('stat-wins').textContent = account.wins;
  $('stat-winrate').textContent = (account.matches ? Math.round((account.wins / account.matches) * 100) : 0) + '%';
  $('stat-coins-won').textContent = account.coinsWon;
  $('profile-coins').textContent = account.coins;
  $('btn-admin').classList.toggle('hidden', !account.isAdmin);
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

// ------------------------------------------------------------ notifications, push, site settings
// Service worker (Web Push receiver). Best-effort: the game works
// without it.
if ('serviceWorker' in navigator) {
  try { navigator.serviceWorker.register('/sw.js').catch(() => {}); } catch { /* no SW */ }
}

let siteSettings = { announcement: '', maintenance: false, aboutText: '' };
// Built-in About text — identical to the server's seed; the admin can
// replace it from the panel (settings key about_text) with no redeploy.
const DEFAULT_ABOUT_TEXT = 'UNO Adda একটি সম্পূর্ণ ফ্রি অনলাইন কার্ড গেম — যেখানে বাংলাদেশসহ বিশ্বের যেকোনো প্রান্তের বন্ধুদের সাথে লাইভ খেলা যায়।\n\nআমাদের উদ্দেশ্য একটাই: বন্ধুদের আড্ডা যেন দূরত্বে হারিয়ে না যায়। ব্যস্ত জীবনে সবাই ছড়িয়ে-ছিটিয়ে — কিন্তু এক রাউন্ড খেলা আর ভয়েস আড্ডায় সেই পুরনো মজাটা ফিরে আসে।\n\nএখানে কোনো আসল টাকার খেলা হয় না — সব কয়েন শুধুই খেলার মজার জন্য।\n\nভালোবাসা দিয়ে বানানো — আহমেদ তানভীর, হবিগঞ্জ, বাংলাদেশ।';
let lastSeenNotifId = Number(localStorage.getItem('uno-adda-notif-seen') || 0);
let notifPollStarted = false;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function subscribePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg || !reg.pushManager) return;
    const keyRes = await apiGet('/api/push/vapid-public-key');
    const pub = keyRes.ok && keyRes.data ? keyRes.data.publicKey : '';
    if (!pub) return;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(pub),
      });
    }
    const json = sub && sub.toJSON ? sub.toJSON() : sub;
    if (json && json.endpoint) await apiPost('/api/push/subscribe', { subscription: json });
  } catch { /* push is best-effort */ }
}

// Notification access (user order 2026-11-22): the app asks on entry —
// one tap on the browser's Allow and everything else is silent. If the
// browser will not show the prompt without a gesture, the FIRST tap
// anywhere asks instead. 'denied' is never re-prompted; the inbox
// shows a settings hint instead.
async function initPush() {
  if (!('Notification' in window) || !('PushManager' in window)) return;
  if (!('serviceWorker' in navigator)) return;
  if (Notification.permission === 'granted') return subscribePush();
  if (Notification.permission === 'denied') return;
  let result = 'default';
  try { result = await Notification.requestPermission(); } catch { result = 'default'; }
  if (result === 'granted') return subscribePush();
  if (result === 'default') {
    const ask = async () => {
      document.removeEventListener('pointerdown', ask);
      try {
        const r = await Notification.requestPermission();
        if (r === 'granted') subscribePush();
      } catch { /* ignore */ }
    };
    document.addEventListener('pointerdown', ask);
  }
}

// Runs after every successful login / session restore.
function onAppEntry() {
  initPush();
  fetchSiteSettings();
  refreshNotifications(true);
  if (!notifPollStarted) {
    notifPollStarted = true;
    setInterval(() => { if (sessionToken) refreshNotifications(false); }, 60000);
  }
}

async function fetchSiteSettings() {
  const res = await apiGet('/api/settings');
  if (res.ok && res.data) {
    siteSettings = {
      announcement: res.data.announcement || '',
      maintenance: !!res.data.maintenance,
      aboutText: res.data.aboutText || '',
    };
  }
  applySiteSettings();
  renderAbout();
}

// ------------------------------------------------------------ ⋯ menu + About screen
function renderAbout() {
  const box = $('about-text');
  if (!box) return;
  const text = siteSettings.aboutText || DEFAULT_ABOUT_TEXT;
  box.innerHTML = text.split(/\n\s*\n/).map(p =>
    '<p>' + escHtml(p).replace(/\n/g, '<br>') + '</p>').join('');
  const v = $('about-version');
  if (v) v.textContent = APP_VERSION;
}
function closeMoreMenu() { $('more-menu').classList.add('hidden'); }
$('btn-more').onclick = (e) => {
  e.stopPropagation();
  $('more-menu').classList.toggle('hidden');
  sfx('click');
};
document.addEventListener('pointerdown', (e) => {
  const menu = $('more-menu');
  if (menu && !menu.classList.contains('hidden') && !e.target.closest('.more-wrap')) closeMoreMenu();
});
$('btn-menu-about').onclick = () => { closeMoreMenu(); renderAbout(); showView('about'); sfx('click'); };
$('btn-menu-gift').onclick = () => { closeMoreMenu(); $('btn-gift').click(); };
$('btn-menu-rules').onclick = () => {
  closeMoreMenu();
  openMode('friends');
  const rules = document.querySelector('#view-friends .rules');
  if (rules) rules.open = true;
};

function applySiteSettings() {
  const banner = $('announce-banner');
  if (banner) {
    banner.textContent = siteSettings.announcement ? '📣 ' + siteSettings.announcement : '';
    banner.classList.toggle('hidden', !siteSettings.announcement);
  }
  // Maintenance replaces the login form — unless you are (or may be)
  // the admin: the escape link reveals the form again.
  const maint = $('auth-maintenance');
  if (maint && !account) {
    const showMaint = siteSettings.maintenance && !authEscapeUsed;
    maint.classList.toggle('hidden', !showMaint);
    if (showMaint) {
      document.querySelector('.auth-tabs').classList.add('hidden');
      $('auth-panel-login').classList.add('hidden');
      $('auth-panel-signup').classList.add('hidden');
    } else {
      restoreAuthPanels();
    }
  }
}
let authEscapeUsed = false;
function restoreAuthPanels() {
  document.querySelectorAll('.auth-tabs').forEach((el) => el.classList.remove('hidden'));
  const loginActive = $('tab-login').classList.contains('active');
  $('auth-panel-login').classList.toggle('hidden', !loginActive);
  $('auth-panel-signup').classList.toggle('hidden', loginActive);
}
$('btn-admin-escape').onclick = () => {
  authEscapeUsed = true;
  $('auth-maintenance').classList.add('hidden');
  restoreAuthPanels();
};

async function refreshNotifications(first) {
  if (!sessionToken) return;
  const res = await apiGet('/api/notifications/unread-count');
  if (res.ok && res.data) paintBellBadge(res.data.count || 0);
  const list = await apiGet('/api/notifications');
  if (list.ok && list.data && Array.isArray(list.data.notifications)) {
    renderInboxRows(list.data.notifications);
    // A fresh broadcast while the app is open pops a one-time banner.
    const newest = list.data.notifications[0];
    if (newest && newest.id > lastSeenNotifId) {
      if (!first && !newest.read) showNotifBanner(newest);
      lastSeenNotifId = newest.id;
      localStorage.setItem('uno-adda-notif-seen', String(lastSeenNotifId));
    }
  }
}

function paintBellBadge(count) {
  const badge = $('bell-badge');
  badge.textContent = count;
  badge.classList.toggle('hidden', !count);
}

function showNotifBanner(n) {
  $('notif-banner-title').textContent = n.title;
  $('notif-banner-body').textContent = n.body;
  $('notif-banner').classList.remove('hidden');
  setTimeout(() => $('notif-banner').classList.add('hidden'), 8000);
}
$('notif-banner').onclick = () => { $('notif-banner').classList.add('hidden'); openInbox(); };
$('btn-bell').onclick = () => openInbox();

function renderInboxRows(notifications) {
  const box = $('inbox-rows');
  if (!notifications.length) {
    box.innerHTML = '<p class="muted">No notifications yet.</p>';
  } else {
    box.innerHTML = notifications.map((n) =>
      '<button class="inbox-row' + (n.read ? '' : ' unread') + '" data-nid="' + n.id + '">' +
      '<span class="inbox-row-main"><b>' + escHtml(n.title) + '</b><span>' + escHtml(n.body) + '</span></span>' +
      '<span class="inbox-row-time">' + new Date(n.createdAt).toLocaleString() + (n.read ? '' : ' •') + '</span></button>'
    ).join('');
    box.querySelectorAll('.inbox-row').forEach((row) => {
      row.onclick = async () => {
        await apiPost('/api/notifications/read', { id: Number(row.dataset.nid) });
        refreshNotifications(true);
      };
    });
  }
  // Push state surfaces: denied -> settings hint; still 'default'
  // (automatic attempt blocked) -> the enable button as a fallback.
  const denied = 'Notification' in window && Notification.permission === 'denied';
  $('inbox-push-hint').classList.toggle('hidden', !denied);
  const canAsk = 'Notification' in window && Notification.permission === 'default';
  $('inbox-enable-row').classList.toggle('hidden', !canAsk);
}

function openInbox() {
  renderInboxRows([]);
  $('inbox-modal').classList.remove('hidden');
  refreshNotifications(true);
}
$('btn-inbox-close').onclick = () => $('inbox-modal').classList.add('hidden');
$('btn-inbox-readall').onclick = async () => {
  await apiPost('/api/notifications/read', { all: true });
  refreshNotifications(true);
};
$('btn-inbox-enable').onclick = async () => {
  try {
    const r = await Notification.requestPermission();
    if (r === 'granted') { subscribePush(); toast('📲 নোটিফিকেশন চালু হয়েছে!'); }
  } catch { /* ignore */ }
  refreshNotifications(true);
};

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ------------------------------------------------------------ admin control center
function adminConfirm(btn, label, fn) {
  // Two-step confirm without blocking dialogs: first tap arms the
  // button for 3s, second tap executes.
  if (btn.dataset.armed === '1') {
    btn.dataset.armed = '';
    btn.textContent = label;
    fn();
    return;
  }
  btn.dataset.armed = '1';
  btn.textContent = 'Sure? Tap again ✓';
  setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = label; } }, 3000);
}

async function openAdmin() {
  if (!account || !account.isAdmin) return;
  $('profile-modal').classList.add('hidden');
  $('admin-modal').classList.remove('hidden');
  loadAdminOverview();
  loadAdminUsers('');
  loadAdminHistory();
  loadAdminBoard();
  loadAdminRooms();
  loadAdminSettings();
  loadAdminAudit();
}
$('btn-admin').onclick = () => openAdmin();
$('btn-admin-close').onclick = () => $('admin-modal').classList.add('hidden');
document.querySelectorAll('.admin-tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.admin-tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.admin-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.apane !== t.dataset.atab));
    sfx('click');
  };
});

async function adminFail(res) {
  toast((res.data && res.data.error) || 'Admin action failed');
}

async function loadAdminOverview() {
  const res = await apiGet('/api/admin/stats');
  if (!res.ok) return adminFail(res);
  const d = res.data;
  $('admin-stats').innerHTML =
    '<div><b>' + d.users + '</b><span>Users</span></div>' +
    '<div><b>' + d.matches + '</b><span>Matches</span></div>' +
    '<div><b>' + d.coins + '</b><span>Coins out</span></div>' +
    '<div><b>' + d.notifications + '</b><span>Notices sent</span></div>' +
    '<div><b>' + d.joinedToday + '</b><span>Joined today</span></div>';
}

async function loadAdminUsers(q) {
  const res = await apiGet('/api/admin/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
  if (!res.ok) return adminFail(res);
  const box = $('admin-users');
  box.innerHTML = res.data.users.map((u) =>
    '<button class="admin-user-row" data-phone="' + escHtml(u.phone) + '">' +
    '<span class="aur-main"><b>' + escHtml(u.name) + '</b> ' + badgeChipHtml(u.wins) +
    '<span class="muted">' + escHtml(u.phone) + ' · ID ' + u.playerId + '</span></span>' +
    '<span class="aur-side">🪙 ' + u.coins + ' · 🏆 ' + u.wins + (u.banned ? ' · 🚫 banned' : '') + '</span></button>'
  ).join('') || '<p class="muted">No users found.</p>';
  box.querySelectorAll('.admin-user-row').forEach((row) => {
    row.onclick = () => loadAdminUserDetail(row.dataset.phone);
  });
}
$('btn-admin-search').onclick = () => loadAdminUsers($('admin-user-q').value.trim());

async function loadAdminUserDetail(phone) {
  const res = await apiGet('/api/admin/users/' + phone);
  if (!res.ok) return adminFail(res);
  const u = res.data.user;
  const box = $('admin-user-detail');
  box.classList.remove('hidden');
  box.innerHTML =
    '<div class="aud-head"><b>' + escHtml(u.name) + '</b> ' + badgeChipHtml(u.wins) +
    '<span class="muted">' + escHtml(u.phone) + ' · ID ' + u.playerId + '</span></div>' +
    '<p class="muted">🪙 ' + u.coins + ' coins · 🎮 ' + u.matches + ' matches · 🏆 ' + u.wins + ' wins · ' +
    (res.data.pushSubscribed ? '📲 push on' : '📵 no push') + (u.banned ? ' · 🚫 BANNED' : '') + '</p>' +
    '<div class="aud-actions">' +
    '<input id="aud-coins" type="number" placeholder="± coins">' +
    '<button id="aud-adjust" class="btn small">Adjust coins</button>' +
    '<input id="aud-pass" type="text" placeholder="New password (6+)">' +
    '<button id="aud-resetpw" class="btn small">Reset password</button>' +
    '<button id="aud-ban" class="btn small danger">' + (u.banned ? 'Unban' : 'Ban') + '</button>' +
    '<button id="aud-notify" class="btn small">📢 Notify this user</button>' +
    '<input id="aud-del-confirm" type="text" placeholder="Type phone to delete">' +
    '<button id="aud-delete" class="btn small danger">Delete account</button>' +
    '</div>';
  $('aud-adjust').onclick = async () => {
    const amount = Number($('aud-coins').value);
    if (!amount) return toast('Enter an amount');
    const r = await apiPost('/api/admin/users/adjust-coins', { phone: u.phone, amount });
    if (r.ok) { toast('Coins updated: ' + r.data.coins); loadAdminUserDetail(u.phone); loadAdminUsers($('admin-user-q').value.trim()); }
    else adminFail(r);
  };
  $('aud-resetpw').onclick = (e) => adminConfirm(e.target, 'Reset password', async () => {
    const newPassword = $('aud-pass').value;
    if (newPassword.length < 6) return toast('Password must be 6+ characters');
    const r = await apiPost('/api/admin/users/reset-password', { phone: u.phone, newPassword });
    if (r.ok) toast('Password reset — user logged out everywhere');
    else adminFail(r);
  });
  $('aud-ban').onclick = (e) => adminConfirm(e.target, u.banned ? 'Unban' : 'Ban', async () => {
    const r = await apiPost('/api/admin/users/ban', { phone: u.phone, banned: !u.banned });
    if (r.ok) { toast(u.banned ? 'User unbanned' : 'User banned'); loadAdminUserDetail(u.phone); }
    else adminFail(r);
  });
  $('aud-notify').onclick = () => {
    $('adm-n-phone').value = u.phone;
    document.querySelector('.admin-tab[data-atab="notify"]').click();
  };
  $('aud-delete').onclick = (e) => {
    if ($('aud-del-confirm').value.trim() !== u.phone) return toast('Type the phone number to confirm delete');
    adminConfirm(e.target, 'Delete account', async () => {
      const r = await apiPost('/api/admin/users/delete', { phone: u.phone });
      if (r.ok) { toast('Account deleted'); box.classList.add('hidden'); loadAdminUsers($('admin-user-q').value.trim()); }
      else adminFail(r);
    });
  };
}

$('btn-adm-notify').onclick = (e) => adminConfirm(e.target, '📢 Send notification', async () => {
  const title = $('adm-n-title').value.trim();
  const body = $('adm-n-body').value.trim();
  const phone = $('adm-n-phone').value.trim();
  if (!title || !body) return toast('Title and message are required');
  const r = await apiPost('/api/admin/notify', { title, body, phone: phone || undefined });
  if (r.ok) {
    toast('Sent ✓ (push ok ' + r.data.pushOk + '/' + r.data.pushAttempted + ')');
    $('adm-n-title').value = '';
    $('adm-n-body').value = '';
    loadAdminHistory();
    loadAdminOverview();
  } else adminFail(r);
});

async function loadAdminHistory() {
  const res = await apiGet('/api/admin/history');
  if (!res.ok) return;
  $('admin-history').innerHTML = res.data.history.map((h) =>
    '<div class="admin-list-row"><span><b>' + escHtml(h.title) + '</b> — ' + escHtml(h.body) +
    '<span class="muted"> → ' + (h.target ? escHtml(h.target) : 'everyone') + ' · push ' + h.pushOk + '/' + h.pushAttempted + '</span></span>' +
    '<span class="muted">' + new Date(h.createdAt).toLocaleString() + '</span></div>'
  ).join('') || '<p class="muted">No notifications sent yet.</p>';
}

async function loadAdminBoard() {
  const res = await apiGet('/api/admin/leaderboard');
  if (!res.ok) return;
  $('admin-board').innerHTML = res.data.entries.map((e) =>
    '<div class="admin-list-row"><span><b>' + escHtml(e.name) + '</b> ' + badgeChipHtml(e.wins) +
    '<span class="muted">🏆 ' + e.wins + ' · 🪙 ' + e.coinsWon + '</span></span>' +
    '<button class="btn small danger" data-remove="' + escHtml(e.name) + '">Remove</button></div>'
  ).join('') || '<p class="muted">Leaderboard is empty.</p>';
  $('admin-board').querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = () => adminConfirm(b, 'Remove', async () => {
      const r = await apiPost('/api/admin/leaderboard/remove', { name: b.dataset.remove });
      if (r.ok) { toast('Removed from leaderboard'); loadAdminBoard(); } else adminFail(r);
    });
  });
}
$('btn-adm-board-reset').onclick = (e) => adminConfirm(e.target, 'Reset leaderboard', async () => {
  const r = await apiPost('/api/admin/leaderboard/reset', {});
  if (r.ok) { toast('Leaderboard reset'); loadAdminBoard(); } else adminFail(r);
});

async function loadAdminRooms() {
  const res = await apiGet('/api/admin/rooms');
  if (!res.ok) return;
  $('admin-rooms').innerHTML = res.data.rooms.map((r) =>
    '<div class="admin-list-row"><span><b>' + escHtml(r.code) + '</b>' +
    '<span class="muted"> ' + escHtml(r.mode || '') + ' · host ' + escHtml(r.hostName || '—') +
    ' · ' + r.seats + ' seats · ' + escHtml(r.phase || '') + '</span></span>' +
    '<button class="btn small danger" data-close="' + escHtml(r.code) + '">Close room</button></div>'
  ).join('') || '<p class="muted">No active rooms right now.</p>';
  $('admin-rooms').querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = () => adminConfirm(b, 'Close room', async () => {
      const r = await apiPost('/api/admin/rooms/close', { code: b.dataset.close });
      if (r.ok) { toast('Room closed'); loadAdminRooms(); } else adminFail(r);
    });
  });
}
$('btn-adm-rooms-refresh').onclick = () => loadAdminRooms();

async function loadAdminSettings() {
  const res = await apiGet('/api/admin/settings');
  if (!res.ok) return;
  $('adm-s-announce').value = res.data.announcement || '';
  $('adm-s-maintenance').checked = !!res.data.maintenance;
  $('adm-s-about').value = res.data.aboutText || '';
}
$('btn-adm-settings-save').onclick = async () => {
  const r = await apiPost('/api/admin/settings', {
    announcement: $('adm-s-announce').value,
    maintenance: $('adm-s-maintenance').checked,
    aboutText: $('adm-s-about').value,
  });
  if (r.ok) {
    toast('Settings saved ✓');
    siteSettings = { announcement: r.data.announcement, maintenance: r.data.maintenance, aboutText: r.data.aboutText || '' };
    applySiteSettings();
    renderAbout();
  }
  else adminFail(r);
};

async function loadAdminAudit() {
  const res = await apiGet('/api/admin/audit');
  if (!res.ok) return;
  $('admin-audit').innerHTML = res.data.audit.map((a) =>
    '<div class="admin-list-row"><span><b>' + escHtml(a.action) + '</b>' +
    '<span class="muted"> ' + (a.target ? '→ ' + escHtml(a.target) + ' ' : '') + escHtml(a.detail || '') + '</span></span>' +
    '<span class="muted">' + new Date(a.createdAt).toLocaleString() + '</span></div>'
  ).join('') || '<p class="muted">No admin activity yet.</p>';
}

// Settings are public — fetch at boot too, so the auth screen can show
// the maintenance state before anyone logs in.
fetchSiteSettings();

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
      onAppEntry();
    } else {
      sessionToken = null;
      localStorage.removeItem('uno-adda-session');
      showAuth();
    }
  });
})();

// ------------------------------------------------------------ long-press hygiene (Addition 13)
// No context menu / text selection / image dragging anywhere in the
// app — a long-press on a card must never pop the Android selection
// toolbar. Real text fields are exempt: editing there stays normal.
document.addEventListener('contextmenu', (e) => {
  if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
  e.preventDefault();
});
document.addEventListener('dragstart', (e) => {
  if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
  e.preventDefault();
});
