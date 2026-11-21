'use strict';
/*
 * Client-level tests for UNO Adda v4 (account system): the auth gate,
 * the server-side wallet (daily gift / rescue / quick-match stake) and
 * the leaderboard panel — driven through the REAL page in jsdom against
 * a fake WebSocket, with fetch() mocked to a fake account API that
 * implements the src/accounts.js contract. Run:
 *   node test/client-v3.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------ fake server
// A tiny fake of the account + leaderboard HTTP API. One fake account per
// page; gift/rescue rules mirror the real server's.
function installFakeApi(window, opts) {
  const acct = {
    playerId: 1007, phone: '01712345678', name: opts.name || 'Player',
    photo: null, avatar: 0, coins: opts.coins != null ? opts.coins : 500,
    matches: 0, wins: opts.wins || 0, coinsWon: 0,
  };
  const state = {
    acct,
    giftClaimed: !!opts.giftClaimed,
    rescueUsed: false,
    adjustCalls: 0,
    failAdjust: !!opts.failAdjust,
    statsCalls: 0,
    pushSub: null,
  };
  window.__acct = acct;
  window.__fakeState = state;
  const json = (status, obj) => ({
    status, ok: status >= 200 && status < 300,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });
  const profileOf = () => ({
    playerId: acct.playerId, phone: acct.phone, name: acct.name,
    photo: acct.photo, avatar: acct.avatar, coins: acct.coins,
    matches: acct.matches, wins: acct.wins, coinsWon: acct.coinsWon,
    isAdmin: !!opts.isAdmin, banned: false,
  });
  window.fetch = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    const auth = !!(init && init.headers && init.headers.Authorization === 'Bearer tok-abc');
    if (u === '/api/auth/me') return auth ? json(200, profileOf()) : json(401, { error: 'Not logged in' });
    if (u === '/api/auth/login') {
      if (body.password === 'wrongpass') return json(401, { error: 'Wrong phone number or password' });
      return json(200, { token: 'tok-abc', profile: profileOf() });
    }
    if (u === '/api/auth/signup') return json(200, { token: 'tok-abc', profile: profileOf() });
    if (u === '/api/auth/logout') return json(200, { ok: true });
    if (u === '/api/auth/name') { acct.name = body.name; return json(200, { ok: true, profile: profileOf() }); }
    if (u === '/api/auth/photo') { acct.photo = body.photo; return json(200, { ok: true, profile: profileOf() }); }
    if (u === '/api/wallet/gift') {
      if (state.giftClaimed) return json(409, { error: 'already' });
      state.giftClaimed = true; acct.coins += 200;
      return json(200, { coins: acct.coins });
    }
    if (u === '/api/wallet/rescue') {
      if (acct.coins < 20 && state.giftClaimed && !state.rescueUsed) {
        state.rescueUsed = true; acct.coins += 100;
        return json(200, { coins: acct.coins });
      }
      return json(409, { error: 'not-eligible' });
    }
    if (u === '/api/wallet/adjust') {
      state.adjustCalls++;
      if (state.failAdjust) return json(400, { error: 'Insufficient coins' });
      const amt = Math.max(-250, Math.min(1000, Math.round(Number(body.amount) || 0)));
      if (amt < 0 && acct.coins + amt < 0) return json(400, { error: 'Not enough coins' });
      acct.coins += amt;
      return json(200, { coins: acct.coins });
    }
    if (u === '/api/stats/match') {
      state.statsCalls++;
      acct.matches++; if (body.won) acct.wins++;
      acct.coinsWon += Math.max(0, Math.min(1000, Number(body.coinsWon) || 0));
      return json(200, { matches: acct.matches, wins: acct.wins, coinsWon: acct.coinsWon });
    }
    if (u === '/api/settings') return json(200, { announcement: '', maintenance: false, aboutText: opts.aboutText || '' });
    if (u === '/api/notifications/unread-count') return json(200, { count: 0 });
    if (u === '/api/notifications') return json(200, { notifications: [] });
    if (u === '/api/notifications/read') return json(200, { ok: true });
    if (u === '/api/push/vapid-public-key') return json(200, { publicKey: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    if (u === '/api/push/subscribe') { state.pushSub = body.subscription || body; return json(200, { ok: true }); }
    if (u === '/api/turn-credentials') return json(200, { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] });
    if (u === '/api/leaderboard' && init && init.method === 'POST') return json(200, { ok: true });
    if (u === '/api/leaderboard') {
      if (window.__boardFail) throw new Error('offline');
      return json(200, { entries: window.__boardEntries || [] });
    }
    throw new Error('unexpected fetch: ' + u);
  };
}

// ------------------------------------------------------------ page harness
function makePage(opts = {}) {
  const store = new Map(Object.entries(opts.storage || {}));
  if (opts.token) store.set('uno-adda-session', 'tok-abc');
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, 'localStorage', {
        value: {
          getItem: (k) => (store.has(k) ? store.get(k) : null),
          setItem: (k, v) => store.set(k, String(v)),
          removeItem: (k) => store.delete(k),
          clear: () => store.clear(),
        },
      });
      class FakeWebSocket {
        constructor() {
          this.readyState = 1;
          this.sent = [];
          (window.__sockets = window.__sockets || []).push(this);
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send(data) { this.sent.push(JSON.parse(data)); }
        deliver(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
        close() { this.readyState = 3; }
      }
      FakeWebSocket.OPEN = 1;
      window.WebSocket = FakeWebSocket;
      window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      // ---- WebRTC fakes: enough of the surface for the voice code —
      // offers fire via onnegotiationneeded when a track is added,
      // exactly like the real thing.
      window.__rtcPeers = [];
      window.RTCSessionDescription = class { constructor(d) { Object.assign(this, d); } };
      window.RTCIceCandidate = class { constructor(c) { this.candidate = c; Object.assign(this, c || {}); } };
      window.RTCPeerConnection = class {
        constructor(config) {
          this.config = config;
          this.localDescription = null;
          this.remoteDescription = null;
          this.signalingState = 'stable';
          this.connectionState = 'new';
          this.addedIce = [];
          this.tracks = [];
          window.__rtcPeers.push(this);
        }
        addTrack(track) {
          this.tracks.push(track);
          queueMicrotask(() => { if (this.onnegotiationneeded) this.onnegotiationneeded(); });
        }
        async createOffer() { return { type: 'offer', sdp: 'fake-offer' }; }
        async createAnswer() { return { type: 'answer', sdp: 'fake-answer' }; }
        async setLocalDescription(d) {
          if (d && d.type === 'rollback') { this.signalingState = 'stable'; return; }
          this.localDescription = d;
          this.signalingState = d && d.type === 'offer' ? 'have-local-offer' : 'stable';
        }
        async setRemoteDescription(d) {
          this.remoteDescription = d;
          this.signalingState = d && d.type === 'offer' ? 'have-remote-offer' : 'stable';
        }
        async addIceCandidate(c) { this.addedIce.push(c); }
        close() { this.connectionState = 'closed'; }
      };
      const fakeStream = { getTracks: () => [{ kind: 'audio', stop() {}, enabled: true }], getAudioTracks: () => [{ kind: 'audio', stop() {}, enabled: true }] };
      Object.defineProperty(window.navigator, 'mediaDevices', {
        value: { getUserMedia: async () => fakeStream }, configurable: true,
      });
      // ---- speech synthesis mock (announcements)
      window.__utterances = [];
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      window.speechSynthesis = {
        speaking: false,
        getVoices: () => [{ lang: 'en-US', name: 'Fake' }],
        speak: (u) => { window.__utterances.push(u.text); },
        cancel: () => {},
      };
      // ---- push environment (Addition 10), only when asked
      if (opts.push) {
        const perm = opts.push;
        window.__permAsked = 0;
        window.Notification = Object.assign(function Notification() {}, {
          permission: perm.permission,
          requestPermission: async () => {
            window.__permAsked++;
            window.Notification.permission = perm.result;
            return perm.result;
          },
        });
        window.PushManager = class {};
        const fakeSub = {
          endpoint: 'https://push.test/abc',
          toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BPx', auth: 'auth1' } }; },
        };
        const fakeReg = {
          pushManager: {
            getSubscription: async () => null,
            subscribe: async () => fakeSub,
          },
        };
        Object.defineProperty(window.navigator, 'serviceWorker', {
          value: { register: async () => fakeReg, ready: Promise.resolve(fakeReg) },
          configurable: true,
        });
      }
      installFakeApi(window, opts);
    },
  });
  dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'));
  return dom;
}
const $ = (dom, id) => dom.window.document.getElementById(id);
const balanceOf = (dom) => dom.window.document.querySelector('.coin-balance');
const shown = (el) => el && !el.classList.contains('hidden');

async function main() {
  // ------------------------------------------------ auth gate: no token
  {
    const dom = makePage({});
    check('gate: no token shows the auth screen', shown($(dom, 'view-auth')) && !shown($(dom, 'view-home')));
    check('gate: login tab is the default', shown($(dom, 'auth-panel-login')) && !shown($(dom, 'auth-panel-signup')));
    $(dom, 'auth-login-phone').value = '01712345678';
    $(dom, 'auth-login-pass').value = 'secret1';
    $(dom, 'btn-login').click();
    await sleep(150);
    check('gate: UI login enters the lobby', !shown($(dom, 'view-auth')) && shown($(dom, 'view-home')));
    check('gate: balance paints from the account', balanceOf(dom).textContent === '500',
      'balance=' + balanceOf(dom).textContent);
    check('gate: profile chip shows name + ID',
      $(dom, 'profile-chip-name').textContent === 'Player' && $(dom, 'profile-chip-id').textContent === 'ID: 1007',
      $(dom, 'profile-chip-name').textContent + ' / ' + $(dom, 'profile-chip-id').textContent);
    dom.window.close();
  }

  // ------------------------------------------------ auth gate: bad password
  {
    const dom = makePage({});
    $(dom, 'auth-login-phone').value = '01712345678';
    $(dom, 'auth-login-pass').value = 'wrongpass';
    $(dom, 'btn-login').click();
    await sleep(150);
    check('gate: wrong password shows the server error', /Wrong phone number or password/.test($(dom, 'auth-error').textContent),
      $(dom, 'auth-error').textContent);
    check('gate: wrong password stays on the auth screen', shown($(dom, 'view-auth')));
    dom.window.close();
  }

  // ------------------------------------------------ gift via the API (200 then idempotent)
  {
    const dom = makePage({ token: true });
    await sleep(150);
    check('gift: seeded session enters the lobby directly', shown($(dom, 'view-home')) && !shown($(dom, 'view-auth')));
    check('gift: balance starts at the account value 500', balanceOf(dom).textContent === '500');
    $(dom, 'btn-gift').click();
    await sleep(150);
    check('gift: click grants +200 via the API', balanceOf(dom).textContent === '700',
      'balance=' + balanceOf(dom).textContent);
    check('gift: button disables after claiming', $(dom, 'btn-gift').disabled === true);
    $(dom, 'btn-gift').click();
    await sleep(150);
    check('gift: second click changes nothing', balanceOf(dom).textContent === '700');
    dom.window.close();
  }

  // ------------------------------------------------ stake blocked: insufficient (no adjust call)
  {
    const dom = makePage({ token: true, coins: 30 });
    await sleep(150);
    dom.window.document.querySelector('.tile[data-tile="quick"]').click();
    dom.window.document.querySelector('.tier[data-tier="master"]').click();
    $(dom, 'btn-quick-find').click();
    await sleep(200);
    check('stake: insufficient balance never opens matchmaking', !shown($(dom, 'mm-modal')));
    check('stake: insufficient balance shows the block message', /Not enough coins/.test($(dom, 'home-error').textContent),
      $(dom, 'home-error').textContent);
    check('stake: no adjust call was made', dom.window.__fakeState.adjustCalls === 0,
      'adjustCalls=' + dom.window.__fakeState.adjustCalls);
    check('stake: balance untouched', balanceOf(dom).textContent === '30');
    dom.window.close();
  }

  // ------------------------------------------------ no stake while queueing (live redesign)
  {
    const dom = makePage({ token: true, coins: 500 });
    await sleep(150);
    dom.window.document.querySelector('.tile[data-tile="quick"]').click();
    dom.window.document.querySelector('.tier[data-tier="casual"]').click();
    $(dom, 'btn-quick-find').click();
    await sleep(250);
    check('stake: Find Match opens the searching screen', shown($(dom, 'mm-modal')));
    check('stake: NO wallet adjust happens while queueing', dom.window.__fakeState.adjustCalls === 0,
      'adjustCalls=' + dom.window.__fakeState.adjustCalls);
    check('stake: balance unchanged while searching', balanceOf(dom).textContent === '500');
    const mmSock = dom.window.__sockets[dom.window.__sockets.length - 1];
    const fm = mmSock.sent.find(m => m.type === 'find_match');
    check('stake: find_match sent for pool quick:20', !!fm && fm.pool === 'quick:20', JSON.stringify(mmSock.sent));
    dom.window.close();
  }

  // ------------------------------------------------ rescue path: 0 coins + gift claimed -> refill, no deduction
  {
    const dom = makePage({ token: true, coins: 0, giftClaimed: true });
    await sleep(150);
    dom.window.document.querySelector('.tile[data-tile="quick"]').click();
    $(dom, 'btn-quick-find').click(); // casual is pre-selected
    await sleep(300);
    check('rescue: broke player gets the refill and enters matchmaking', shown($(dom, 'mm-modal')));
    check('rescue: balance is the full 100 refill (stake moves only at match start)', balanceOf(dom).textContent === '100',
      'balance=' + balanceOf(dom).textContent);
    dom.window.close();
  }

  // ------------------------------------------------ leaderboard rows
  {
    const dom = makePage({ token: true });
    await sleep(150);
    dom.window.__boardEntries = [
      { name: 'Zed', avatar: 1, wins: 9, coinsWon: 900 },
      { name: 'Player', avatar: 2, wins: 3, coinsWon: 300 },
    ];
    $(dom, 'btn-board').click();
    await sleep(200);
    const rows = $(dom, 'board-rows').children;
    check('board: two rows render', rows.length === 2, 'rows=' + rows.length);
    check('board: gold medal on the first row', rows[0] && rows[0].textContent.includes('🥇'));
    check('board: my row is highlighted', rows[1] && rows[1].classList.contains('mine'));
    dom.window.close();
  }

  // ------------------------------------------------ leaderboard offline
  {
    const dom = makePage({ token: true });
    await sleep(150);
    dom.window.__boardFail = true;
    $(dom, 'btn-board').click();
    await sleep(200);
    check('board: offline shows a friendly message', /unavailable/i.test($(dom, 'board-rows').textContent),
      $(dom, 'board-rows').textContent.trim());
    dom.window.close();
  }

  // ------------------------------------------------ profile screen
  {
    const dom = makePage({ token: true });
    await sleep(150);
    $(dom, 'profile-chip').click();
    check('profile: chip opens the profile screen', shown($(dom, 'profile-modal')));
    check('profile: shows the Player ID', $(dom, 'profile-id').textContent === 'ID: 1007',
      $(dom, 'profile-id').textContent);
    check('profile: shows the phone', $(dom, 'profile-phone').textContent === '01712345678');
    dom.window.document.querySelector('.pick-av[data-av="2"]').click();
    const prof = JSON.parse(dom.window.localStorage.getItem('uno-adda-profile'));
    check('profile: character pick saves', prof.avatar === 2, 'avatar=' + prof.avatar);
    check('profile: home chip avatar follows', $(dom, 'name-avatar').className.includes('av2'),
      $(dom, 'name-avatar').className);
    dom.window.close();
  }

  // ------------------------------------------------ round intro: shuffle → deal → play
  {
    const dom = makePage({ token: true });
    await sleep(150);
    const w = dom.window;
    w.UNO_INTRO_TIMING = { shuffleMs: 60, flightMs: 20 }; // shrink the staging for the test
    w.Element.prototype.getBoundingClientRect = () => ({ left: 100, top: 100, width: 60, height: 84, right: 160, bottom: 184, x: 100, y: 100 });
    const sock = w.__sockets[w.__sockets.length - 1];
    const C = (id, color, kind, value) => ({ id, color, kind, value });
    const seat = (id, isYou, cardCount) => ({
      id, name: 'P-' + id, isBot: false, ready: true, connected: true, inVoice: false,
      avatar: 0, photo: null, team: null, score: 0, cardCount, isCurrent: id === 's1', isYou: !!isYou,
    });
    const rules = { stacking: true, challenge: true, allWild: false, timerSec: 30 };
    const base = {
      type: 'state',
      room: { code: 'TEST12', mode: 'classic', rules, status: 'waiting', hostSeatId: 's1', roundNo: 0, quick: false, bet: 0, maxSeats: 4 },
      you: { seatId: 's1', token: 'tok1' },
      seats: [seat('s1', true, 0), seat('s2', false, 0), seat('s3', false, 0), seat('s4', false, 0)],
      chat: [], events: [], game: null, lastRound: null, matchWinnerSeatId: null,
    };
    sock.deliver(base); // lobby snapshot first (the previous state is "not playing")
    await sleep(60);
    const hand = [C('h1', 'red', 'number', 3), C('h2', 'green', 'number', 4), C('h3', 'blue', 'number', 6), C('h4', 'yellow', 'number', 8), C('h5', 'red', 'number', 9), C('h6', 'green', 'number', 1), C('h7', 'blue', 'number', 2)];
    const playing = JSON.parse(JSON.stringify(base));
    playing.room.status = 'playing';
    playing.room.roundNo = 1;
    playing.seats = [seat('s1', true, 7), seat('s2', false, 7), seat('s3', false, 7), seat('s4', false, 7)];
    playing.game = {
      phase: 'playing', topCard: C('c1', 'red', 'number', 5), drawPileCount: 79, currentColor: 'red',
      isYourTurn: true, youMustPickColor: false, pendingDraw: 0, pendingKind: null,
      canChallenge: false, drewCardId: null, unoSuspect: null, direction: 1,
      yourHand: hand, legalCardIds: ['h1'],
    };
    sock.deliver(playing); // the round-start snapshot

    await sleep(25);
    check('intro: shuffle phase is shown at round start', !!w.__intro && w.__intro.phase === 'shuffle',
      'phase=' + (w.__intro && w.__intro.phase));
    check('intro: shuffle element is on the table', !!dom.window.document.querySelector('.shuffle-fx'));
    check('intro: table is marked intro-on (input staging)', $(dom, 'view-game').classList.contains('intro-on'));
    const firstCard = dom.window.document.querySelector('#my-hand .card');
    if (firstCard) firstCard.click();
    check('intro: card taps are blocked during the intro', !sock.sent.some(m => m.type === 'play_card'),
      'sent=' + JSON.stringify(sock.sent.map(m => m.type)));

    let sawDeal = false;
    let sawFlights = 0;
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      if (w.__intro && w.__intro.phase === 'deal') sawDeal = true;
      sawFlights = Math.max(sawFlights, dom.window.document.querySelectorAll('.deal-fx').length);
      if (w.__intro && w.__intro.phase === 'done') break;
      await sleep(15);
    }
    check('intro: deal phase follows the shuffle', sawDeal);
    check('intro: deal flights are created (one per card)', sawFlights > 0, 'max .deal-fx seen=' + sawFlights);
    check('intro: sequence completes into the play state', !!w.__intro && w.__intro.phase === 'done' && !$(dom, 'view-game').classList.contains('intro-on'),
      'phase=' + (w.__intro && w.__intro.phase));
    check('intro: all my cards are face-up after the deal', dom.window.document.querySelectorAll('#my-hand .card.intro-hidden').length === 0);
    check('intro: the flipped card is revealed after the deal', $(dom, 'discard-pile').style.visibility !== 'hidden');
    const playable = dom.window.document.querySelector('#my-hand .card.playable');
    if (playable) playable.click();
    await sleep(60);
    check('intro: input works again once play begins', sock.sent.some(m => m.type === 'play_card'),
      'sent=' + JSON.stringify(sock.sent.map(m => m.type)));
    dom.window.close();
  }

  // ------------------------------------------------ mode navigation (Addition 11)
  {
    const dom = makePage({ token: true });
    await sleep(150);
    const w = dom.window;
    check('nav: the lobby itself contains no tier list / stake panel',
      !$(dom, 'view-home').querySelector('#tier-list') && !$(dom, 'view-home').querySelector('.tile-panel'));
    check('nav: lobby starts on the tiles', shown($(dom, 'view-home')) && !shown($(dom, 'view-quick')));
    w.document.querySelector('.tile[data-tile="quick"]').click();
    check('nav: Quick tile opens the Quick screen', shown($(dom, 'view-quick')) && !shown($(dom, 'view-home')));
    check('nav: Quick screen has 4 tier cards', w.document.querySelectorAll('#view-quick .tier').length === 4);
    w.document.querySelector('#view-quick .tier[data-tier="pro"]').click();
    check('nav: tapping a tier selects it (no matchmaking yet)',
      w.document.querySelector('#view-quick .tier[data-tier="pro"]').classList.contains('selected') && !shown($(dom, 'mm-modal')));
    $(dom, 'btn-quick-find').click();
    await sleep(200);
    const mmSock = w.__sockets[w.__sockets.length - 1];
    const fm = mmSock.sent.find(m => m.type === 'find_match');
    check('nav: Find Match queues pool quick:100 for the Pro tier', !!fm && fm.pool === 'quick:100',
      JSON.stringify(mmSock.sent));
    $(dom, 'btn-mm-cancel').click();
    await sleep(100);
    check('nav: cancelling the search returns to the Quick screen, not the lobby',
      shown($(dom, 'view-quick')) && !shown($(dom, 'view-home')) && !shown($(dom, 'mm-modal')));
    w.document.querySelector('#view-quick [data-back]').click();
    check('nav: back button returns to the lobby', shown($(dom, 'view-home')) && !shown($(dom, 'view-quick')));
    // Bots screen Play path
    w.document.querySelector('.tile[data-tile="bots"]').click();
    check('nav: Bots tile opens the Bots screen', shown($(dom, 'view-bots')));
    w.document.querySelector('#bots-pick-row .seg-card[data-bots="3"]').click();
    $(dom, 'btn-bots').click();
    await sleep(150);
    const roomSock = w.__sockets[0];
    const cbg = roomSock.sent.find(m => m.type === 'create_bot_game');
    check('nav: Bots Play sends create_bot_game with the picked count', !!cbg && cbg.botCount === 3,
      JSON.stringify(roomSock.sent.map(m => m.type)));
    dom.window.close();
  }

  // ------------------------------------------------ voice: late joiner + ICE queue (Addition C)
  {
    const dom = makePage({ token: true });
    await sleep(150);
    const w = dom.window;
    w.Element.prototype.getBoundingClientRect = () => ({ left: 100, top: 100, width: 60, height: 84, right: 160, bottom: 184, x: 100, y: 100 });
    const sock = w.__sockets[w.__sockets.length - 1];
    const seat = (id, isYou) => ({
      id, name: 'P-' + id, isBot: false, ready: true, connected: true, inVoice: false,
      avatar: 0, photo: null, wins: 0, team: null, score: 0, cardCount: 0, isCurrent: false, isYou: !!isYou,
    });
    sock.deliver({
      type: 'state',
      room: { code: 'VOICE1', mode: 'classic', rules: { stacking: true, challenge: true, allWild: false }, status: 'waiting', hostSeatId: 's1', roundNo: 0, quick: false, bet: 0, maxSeats: 4 },
      you: { seatId: 's1', token: 'tok1' },
      seats: [seat('s1', true), seat('s2', false)],
      chat: [], events: [], game: null, lastRound: null, matchWinnerSeatId: null,
    });
    await sleep(60);
    w.document.querySelector('.voice-join').click();
    await sleep(300);
    check('voice: Join Voice sends voice_join', sock.sent.some(m => m.type === 'voice_join'),
      JSON.stringify(sock.sent.map(m => m.type)));
    sock.deliver({ type: 'voice_roster', peers: ['s2'] });
    await sleep(200);
    check('voice: late joiner creates a peer connection for the existing member', w.__rtcPeers.length === 1,
      'peers=' + w.__rtcPeers.length);
    check('voice: the joiner offers to the existing member',
      sock.sent.some(m => m.type === 'voice_signal' && m.toSeatId === 's2' && m.data && m.data.kind === 'offer'),
      JSON.stringify(sock.sent.filter(m => m.type === 'voice_signal')));
    check('voice: a remote <audio> element exists from the gesture path',
      !!w.document.querySelector('#voice-audios audio'));
    const pc = w.__rtcPeers[0];
    sock.deliver({ type: 'voice_signal', fromSeatId: 's2', data: { kind: 'ice', candidate: { candidate: 'candidate:early', sdpMid: '0' } } });
    await sleep(100);
    check('voice: ICE arriving before the remote description is queued, not dropped', pc.addedIce.length === 0,
      'addedIce=' + pc.addedIce.length);
    sock.deliver({ type: 'voice_signal', fromSeatId: 's2', data: { kind: 'answer', sdp: { type: 'answer', sdp: 'fake' } } });
    await sleep(150);
    check('voice: queued ICE flushes after the answer lands', pc.addedIce.length === 1,
      'addedIce=' + pc.addedIce.length);
    dom.window.close();
  }

  // ------------------------------------------------ announcements + draw hint + invalid tap (Additions 4/7)
  {
    const dom = makePage({ token: true });
    await sleep(150);
    const w = dom.window;
    w.Element.prototype.getBoundingClientRect = () => ({ left: 100, top: 100, width: 60, height: 84, right: 160, bottom: 184, x: 100, y: 100 });
    w.document.dispatchEvent(new w.Event('pointerdown')); // first gesture unlocks speech
    const sock = w.__sockets[w.__sockets.length - 1];
    const C = (id, color, kind, value) => ({ id, color, kind, value: value || 0 });
    const seat = (id, name, isYou, cardCount) => ({
      id, name, isBot: false, ready: true, connected: true, inVoice: false,
      avatar: 0, photo: null, wins: 0, team: null, score: 0, cardCount, isCurrent: id === 's2', isYou: !!isYou,
    });
    let topSeq = 0;
    const playingState = (game, events) => ({
      type: 'state',
      room: { code: 'ANN123', mode: 'classic', rules: { stacking: true, challenge: true, allWild: false }, status: 'playing', hostSeatId: 's1', roundNo: 1, quick: false, bet: 0, maxSeats: 4 },
      you: { seatId: 's1', token: 'tok1' },
      seats: [seat('s1', 'Tanvir', true, game.yourHand.length), seat('s2', 'Rafi', false, 5)],
      chat: [], events: events || [], game, lastRound: null, matchWinnerSeatId: null,
    });
    const baseGame = (over) => Object.assign({
      phase: 'playing', topCard: C('top' + (++topSeq), 'red', 'number', 5), drawPileCount: 60, currentColor: 'red',
      isYourTurn: false, youMustPickColor: false, pendingDraw: 0, pendingKind: null,
      canChallenge: false, drewCardId: null, unoSuspect: null, direction: 1,
      yourHand: [C('h1', 'red', 'number', 3)], legalCardIds: [], turnEndsAt: Date.now() + 30000,
    }, over || {});

    sock.deliver(playingState(baseGame(), [{ type: 'played', seatId: 's2', card: C('x1', 'blue', 'number', 8) }]));
    await sleep(300);
    check('speak: a played Blue 8 is announced', w.__utterances.includes('Blue 8'), JSON.stringify(w.__utterances));

    sock.deliver(playingState(baseGame(), [
      { type: 'played', seatId: 's2', card: C('x2', 'red', 'skip') },
      { type: 'skipped', seatId: 's1' },
    ]));
    await sleep(300);
    check('speak: a Skip on me announces "Tanvir block!"', w.__utterances.includes('Tanvir block!'), JSON.stringify(w.__utterances));

    sock.deliver(playingState(baseGame({ pendingDraw: 2, pendingKind: 'draw2' }),
      [{ type: 'pending', seatId: 's1', kind: 'draw2', total: 2 }]));
    await sleep(300);
    const pendingUtt = w.__utterances.find(u => /কার্ড তুলতে হবে/.test(u));
    check('speak: pending +2 speaks the Bengali counter-or-draw line', !!pendingUtt && /ড্র কার্ড থাকলে মারো/.test(pendingUtt) && /২টা/.test(pendingUtt),
      pendingUtt || JSON.stringify(w.__utterances));

    const beforeBurst = w.__utterances.length;
    sock.deliver(playingState(baseGame(), [
      { type: 'played', seatId: 's2', card: C('y1', 'green', 'number', 1) },
      { type: 'played', seatId: 's2', card: C('y2', 'green', 'number', 2) },
      { type: 'played', seatId: 's2', card: C('y3', 'yellow', 'number', 9) },
    ]));
    await sleep(300);
    const burstCount = w.__utterances.length - beforeBurst;
    check('speak: a 3-event bot burst coalesces to at most 2 utterances', burstCount >= 1 && burstCount <= 2,
      'burst=' + burstCount);

    $(dom, 'btn-sound').click(); // sound off
    const beforeMute = w.__utterances.length;
    sock.deliver(playingState(baseGame(), [{ type: 'played', seatId: 's2', card: C('z1', 'blue', 'number', 4) }]));
    await sleep(300);
    check('speak: sound toggle off means zero speech', w.__utterances.length === beforeMute);
    $(dom, 'btn-sound').click(); // back on

    // Draw hint: my turn, nothing playable -> finger shows; playable -> hides.
    sock.deliver(playingState(baseGame({ isYourTurn: true, yourHand: [C('h9', 'blue', 'number', 9)], legalCardIds: [] }), []));
    await sleep(120);
    check('hint: draw finger shows when I must draw', !$(dom, 'draw-hint').classList.contains('hidden'));
    sock.deliver(playingState(baseGame({ isYourTurn: true, yourHand: [C('h9', 'red', 'number', 9)], legalCardIds: ['h9'] }), []));
    await sleep(120);
    check('hint: draw finger hides once a card is playable', $(dom, 'draw-hint').classList.contains('hidden'));

    // Invalid tap reasons.
    sock.deliver(playingState(baseGame({
      isYourTurn: true,
      yourHand: [C('h7', 'blue', 'number', 7), C('h8', 'red', 'number', 2)],
      legalCardIds: ['h8'],
    }), []));
    await sleep(120);
    const badCard = [...w.document.querySelectorAll('#my-hand .card')].find(el => el.dataset.id === 'h7');
    check('hint: the unplayable card is in the hand', !!badCard);
    badCard.click();
    await sleep(80);
    check('hint: tapping an unplayable card shakes it', badCard.classList.contains('shake'));
    check('hint: wrong-color reason is shown', /রঙ বা নম্বর মিলছে না/.test($(dom, 'hand-hint').textContent),
      $(dom, 'hand-hint').textContent);
    sock.deliver(playingState(baseGame({
      isYourTurn: true, pendingDraw: 2, pendingKind: 'draw2',
      yourHand: [C('h5', 'red', 'number', 5)], legalCardIds: [],
    }), []));
    await sleep(120);
    const pendCard = w.document.querySelectorAll('#my-hand .card')[0];
    pendCard.click();
    await sleep(80);
    check('hint: pending reason is shown', /আগে ড্র কার্ড মারুন বা কার্ড তুলুন/.test($(dom, 'hand-hint').textContent),
      $(dom, 'hand-hint').textContent);
    dom.window.close();
  }

  // ------------------------------------------------ timer ring + badges + skin + music (Additions 5/7)
  {
    const dom = makePage({ token: true, wins: 60 });
    await sleep(150);
    const w = dom.window;
    w.Element.prototype.getBoundingClientRect = () => ({ left: 100, top: 100, width: 60, height: 84, right: 160, bottom: 184, x: 100, y: 100 });
    const sock = w.__sockets[w.__sockets.length - 1];
    const C = (id, color, kind, value) => ({ id, color, kind, value: value || 0 });
    sock.deliver({
      type: 'state',
      room: { code: 'RING12', mode: 'classic', rules: { stacking: true, challenge: true, allWild: false }, status: 'playing', hostSeatId: 's1', roundNo: 1, quick: false, bet: 0, maxSeats: 4 },
      you: { seatId: 's1', token: 'tok1' },
      seats: [
        { id: 's1', name: 'Tanvir', isBot: false, ready: true, connected: true, inVoice: false, avatar: 0, photo: null, wins: 60, team: null, score: 0, cardCount: 3, isCurrent: false, isYou: true },
        { id: 's2', name: 'Rafi', isBot: false, ready: true, connected: true, inVoice: false, avatar: 1, photo: null, wins: 12, team: null, score: 0, cardCount: 4, isCurrent: true, isYou: false },
      ],
      chat: [], events: [],
      game: {
        phase: 'playing', topCard: C('t1', 'red', 'number', 5), drawPileCount: 60, currentColor: 'red',
        isYourTurn: false, youMustPickColor: false, pendingDraw: 0, pendingKind: null,
        canChallenge: false, drewCardId: null, unoSuspect: null, direction: 1,
        yourHand: [C('h1', 'red', 'number', 3)], legalCardIds: [], turnEndsAt: Date.now() + 30000,
      },
      lastRound: null, matchWinnerSeatId: null,
    });
    await sleep(150);
    const ring = w.document.querySelector('.turn-ring-fg');
    check('ring: current player avatar carries a timer ring', !!ring);
    const off1 = parseFloat(ring.style.strokeDashoffset || '0');
    await sleep(800);
    const off2 = parseFloat(ring.style.strokeDashoffset || '0');
    check('ring: the ring depletes with the turn deadline', off2 > off1, off1 + ' -> ' + off2);
    check('badge: a Bronze seat dot renders for a 12-win player', !!w.document.querySelector('.badge-dot.dot-bronze'));
    // profile badge (account has 60 wins -> Silver)
    $(dom, 'profile-chip').click();
    check('badge: profile shows the Silver chip at 60 wins', /Silver/.test($(dom, 'profile-badge').textContent),
      $(dom, 'profile-badge').textContent);
    // skin persistence
    w.document.querySelector('.skin-pick[data-skin="blue"]').click();
    check('skin: picking Royal Blue persists + applies', w.localStorage.getItem('uno-adda-skin') === 'blue' && $(dom, 'view-game').classList.contains('skin-blue'));
    $(dom, 'btn-profile-close').click();
    // music toggle persistence (default on -> off -> on)
    $(dom, 'btn-music').click();
    check('music: toggle off persists', w.localStorage.getItem('uno-adda-music') === '0',
      w.localStorage.getItem('uno-adda-music'));
    $(dom, 'btn-music').click();
    check('music: toggle on persists', w.localStorage.getItem('uno-adda-music') === '1');
    dom.window.close();
    // skin survives a fresh page
    const dom2 = makePage({ token: true, storage: { 'uno-adda-skin': 'blue' } });
    await sleep(150);
    check('skin: saved skin applies on the next visit', $(dom2, 'view-game').classList.contains('skin-blue'));
    dom2.window.close();
  }

  // ------------------------------------------------ photo merge (snapshot diet, client half)
  {
    const dom = makePage({ token: true });
    await sleep(150);
    const w = dom.window;
    const sock = w.__sockets[w.__sockets.length - 1];
    const PHOTO = 'data:image/jpeg;base64,QUJD';
    const C = (id, color, kind, value) => ({ id, color, kind, value: value || 0 });
    const mkState = (photo) => ({
      type: 'state',
      room: { code: 'DIET99', mode: 'classic', rules: { stacking: true, challenge: true, allWild: false }, status: 'playing', hostSeatId: 's1', roundNo: 1, quick: false, bet: 0, maxSeats: 4 },
      you: { seatId: 's1', token: 'tok1' },
      seats: [
        { id: 's1', name: 'Tanvir', isBot: false, ready: true, connected: true, inVoice: false, avatar: 0, photo: null, wins: 0, team: null, score: 0, cardCount: 3, isCurrent: false, isYou: true },
        { id: 's2', name: 'Rafi', isBot: false, ready: true, connected: true, inVoice: false, avatar: 1, photo, wins: 0, team: null, score: 0, cardCount: 4, isCurrent: true, isYou: false },
      ],
      chat: [], events: [],
      game: {
        phase: 'playing', topCard: C('t1', 'red', 'number', 5), drawPileCount: 60, currentColor: 'red',
        isYourTurn: false, youMustPickColor: false, pendingDraw: 0, pendingKind: null,
        canChallenge: false, drewCardId: null, unoSuspect: null, direction: 1,
        yourHand: [C('h1', 'red', 'number', 3)], legalCardIds: [], turnEndsAt: Date.now() + 30000,
      },
      lastRound: null, matchWinnerSeatId: null,
    });
    sock.deliver(mkState(PHOTO));
    await sleep(120);
    check('diet: photo renders from the first playing state',
      !!w.document.querySelector('#opponents img.avatar-img'));
    sock.deliver(mkState(null)); // dieted state: photo omitted
    await sleep(120);
    const img = w.document.querySelector('#opponents img.avatar-img');
    check('diet: photo still renders after a photo-less state (merged by seat id)',
      !!img && img.getAttribute('src') === PHOTO, img && img.getAttribute('src'));
    dom.window.close();
  }

  // ------------------------------------------------ push permission flow (Addition 10)
  {
    const dom = makePage({ token: true, push: { permission: 'default', result: 'granted' } });
    await sleep(400);
    check('push: entering the app asks for notification permission directly', dom.window.__permAsked >= 1,
      'asked=' + dom.window.__permAsked);
    check('push: on grant the subscription is POSTed silently',
      !!dom.window.__fakeState.pushSub && dom.window.__fakeState.pushSub.endpoint === 'https://push.test/abc',
      JSON.stringify(dom.window.__fakeState.pushSub));
    dom.window.close();

    const dom2 = makePage({ token: true, push: { permission: 'denied', result: 'denied' } });
    await sleep(300);
    check('push: a denied permission is never re-prompted', dom2.window.__permAsked === 0);
    $(dom2, 'btn-bell').click();
    await sleep(150);
    check('push: the inbox shows the browser-settings hint when denied', shown($(dom2, 'inbox-push-hint')));
    dom2.window.close();
  }

  // ------------------------------------------------ ⋯ menu + About screen (Addition 12)
  {
    const dom = makePage({ token: true });
    await sleep(200);
    const w = dom.window;
    check('about: the ⋯ menu starts closed', !shown($(dom, 'more-menu')));
    $(dom, 'btn-more').click();
    check('about: the ⋯ menu opens with an About entry', shown($(dom, 'more-menu')) && /About Us/.test($(dom, 'btn-menu-about').textContent),
      $(dom, 'btn-menu-about').textContent);
    $(dom, 'btn-menu-about').click();
    await sleep(100);
    check('about: About opens its own screen', shown($(dom, 'view-about')) && !shown($(dom, 'view-home')));
    check('about: tagline renders', /আড্ডার আসল ঠিকানা/.test($(dom, 'view-about').textContent));
    check('about: with no server text the built-in default renders',
      /সম্পূর্ণ ফ্রি অনলাইন কার্ড গেম/.test($(dom, 'about-text').textContent) && /আহমেদ তানভীর/.test($(dom, 'about-text').textContent),
      $(dom, 'about-text').textContent.slice(0, 60));
    check('about: version label shows 4.0', $(dom, 'about-version').textContent === '4.0');
    check('about: Habiganj line renders', /Habiganj/.test($(dom, 'view-about').textContent));
    w.document.querySelector('#view-about [data-back]').click();
    check('about: back returns to the lobby', shown($(dom, 'view-home')));
    dom.window.close();
  }
  {
    // server-provided about text wins over the built-in default
    const dom = makePage({ token: true, aboutText: 'কাস্টম অ্যাবাউট — সার্ভার থেকে এসেছে' });
    await sleep(200);
    $(dom, 'btn-more').click();
    $(dom, 'btn-menu-about').click();
    await sleep(100);
    check('about: server text renders when /api/settings provides it',
      /কাস্টম অ্যাবাউট — সার্ভার থেকে এসেছে/.test($(dom, 'about-text').textContent) &&
      !/সম্পূর্ণ ফ্রি অনলাইন কার্ড গেম/.test($(dom, 'about-text').textContent),
      $(dom, 'about-text').textContent.slice(0, 60));
    dom.window.close();
  }

  // ------------------------------------------------ long-press hygiene (Addition 13)
  {
    const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
    check('press: stylesheet disables user-select globally', /user-select:\s*none/.test(css) && /-webkit-user-select:\s*none/.test(css));
    check('press: stylesheet disables the touch callout', /-webkit-touch-callout:\s*none/.test(css));
    check('press: text fields keep normal selection (input exception)',
      /input,\s*textarea[^{]*\{[^}]*user-select:\s*text/.test(css));
    check('press: tap highlight is transparent', /-webkit-tap-highlight-color:\s*transparent/.test(css));
    const dom = makePage({ token: true });
    await sleep(150);
    const w = dom.window;
    const gameEv = new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    w.document.getElementById('view-game').dispatchEvent(gameEv);
    check('press: contextmenu on the game surface is prevented', gameEv.defaultPrevented === true);
    const handEv = new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    w.document.getElementById('my-hand').dispatchEvent(handEv);
    check('press: contextmenu on the hand is prevented', handEv.defaultPrevented === true);
    const inputEv = new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    w.document.getElementById('in-code').dispatchEvent(inputEv);
    check('press: contextmenu inside a text input is NOT prevented', inputEv.defaultPrevented === false);
    const dragEv = new w.Event('dragstart', { bubbles: true, cancelable: true });
    w.document.getElementById('view-home').dispatchEvent(dragEv);
    check('press: dragstart is prevented outside inputs', dragEv.defaultPrevented === true);
    dom.window.close();
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
