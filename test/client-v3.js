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
    matches: 0, wins: 0, coinsWon: 0,
  };
  const state = {
    acct,
    giftClaimed: !!opts.giftClaimed,
    rescueUsed: false,
    adjustCalls: 0,
    failAdjust: !!opts.failAdjust,
    statsCalls: 0,
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
    dom.window.document.querySelector('.tier[data-tier="master"]').click();
    await sleep(200);
    check('stake: insufficient balance never opens matchmaking', !shown($(dom, 'mm-modal')));
    check('stake: insufficient balance shows the block message', /Not enough coins/.test($(dom, 'home-error').textContent),
      $(dom, 'home-error').textContent);
    check('stake: no adjust call was made', dom.window.__fakeState.adjustCalls === 0,
      'adjustCalls=' + dom.window.__fakeState.adjustCalls);
    check('stake: balance untouched', balanceOf(dom).textContent === '30');
    dom.window.close();
  }

  // ------------------------------------------------ stake refused by the server
  {
    const dom = makePage({ token: true, coins: 500, failAdjust: true });
    await sleep(150);
    dom.window.document.querySelector('.tier[data-tier="casual"]').click();
    await sleep(200);
    check('stake: server refusal aborts matchmaking', !shown($(dom, 'mm-modal')));
    check('stake: server refusal surfaces an error', $(dom, 'home-error').textContent.length > 0,
      $(dom, 'home-error').textContent);
    check('stake: balance unchanged after refusal', balanceOf(dom).textContent === '500');
    dom.window.close();
  }

  // ------------------------------------------------ rescue path: 0 coins + gift claimed -> stake goes through
  {
    const dom = makePage({ token: true, coins: 0, giftClaimed: true });
    await sleep(150);
    dom.window.document.querySelector('.tier[data-tier="casual"]').click();
    await sleep(300);
    check('rescue: broke player gets the refill and enters matchmaking', shown($(dom, 'mm-modal')));
    check('rescue: balance is 100 refill − 20 stake = 80', balanceOf(dom).textContent === '80',
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

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
