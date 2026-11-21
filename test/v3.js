'use strict';
/*
 * v3 feature tests for UNO Adda (Cloudflare port). Expects the Worker to
 * already be running under `wrangler dev` (see test/run-local.sh) at
 * BASE_URL (default http://127.0.0.1:8787). Checks:
 *  a. a quick bot room reports quick/bet in snapshots, ends after ONE
 *     round with a winner, and refuses to start a next round
 *  b. a chosen avatar in create/join payloads is echoed in snapshots
 *     for every seat (bots get distinct avatars, never the human's pick)
 *  c. the leaderboard accepts a POST and returns entries sorted by
 *     coinsWon (then wins) over GET
 * Exits non-zero on the first failed check.
 */
import http from 'node:http';
import WebSocket from 'ws';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + path, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let out = '';
      res.on('data', (d) => out += d);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

class Client {
  constructor(name) {
    this.name = name;
    this.states = [];
    this.errors = [];
    this.ws = null;
  }
  open(path = '/ws') {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(WS_BASE + path);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'state') { this.states.push(msg); this.latest = msg; }
        if (msg.type === 'error') this.errors.push(msg.message);
      });
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  async waitFor(pred, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.latest && pred(this.latest)) return this.latest;
      await sleep(60);
    }
    throw new Error('timeout waiting for: ' + label);
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// Same driving strategy as the smoke test: play the first legal card.
async function autoPlay(client, seconds) {
  const t0 = Date.now();
  let acted = new Set();
  while (Date.now() - t0 < seconds * 1000) {
    const s = client.latest;
    if (s && s.room.status === 'roundEnd') return true;
    if (s && s.game && s.room.status === 'playing') {
      const g = s.game;
      if (g.youMustPickColor) {
        client.send({ type: 'pick_color', color: 'red' });
        await sleep(120);
        continue;
      }
      if (g.isYourTurn) {
        const key = g.topCard.id + '|' + g.yourHand.length + '|' + g.pendingDraw + '|' + (g.drewCardId || '');
        if (!acted.has(key)) {
          acted.add(key);
          if (g.drewCardId) {
            const drawnPlayable = g.legalCardIds.includes(g.drewCardId);
            client.send(drawnPlayable ? { type: 'play_card', cardId: g.drewCardId, callUno: true, chosenColor: 'blue' } : { type: 'pass' });
          } else if (g.legalCardIds.length) {
            const card = g.yourHand.find(c => c.id === g.legalCardIds[0]);
            client.send({ type: 'play_card', cardId: card.id, callUno: true, chosenColor: 'green' });
          } else if (g.canChallenge && Math.random() < 0.5) {
            client.send({ type: 'challenge' });
          } else {
            client.send({ type: 'draw_card' });
          }
        }
      }
    }
    await sleep(100);
  }
  return !!(client.latest && client.latest.room.status === 'roundEnd');
}

async function main() {
  try {
    // ---- (b) avatars in a bot game ----
    const solo = new Client('Solo');
    await solo.open('/ws');
    solo.send({ type: 'create_bot_game', name: 'AvatarFan', avatar: 2, botCount: 3, rules: {} });
    const bg = await solo.waitFor(s => s.room.status === 'playing' && s.game, 5000, 'bot game start');
    const me = bg.seats.find(s => s.isYou);
    check('chosen avatar echoed for the human seat', me.avatar === 2, 'avatar=' + me.avatar);
    const bots = bg.seats.filter(s => s.isBot);
    check('bots have valid avatars', bots.every(s => Number.isInteger(s.avatar) && s.avatar >= 0 && s.avatar <= 3),
      bots.map(s => s.avatar).join(','));
    check('bot avatars are distinct and not the human pick',
      new Set(bots.map(s => s.avatar)).size === bots.length && bots.every(s => s.avatar !== 2),
      bots.map(s => s.avatar).join(','));
    solo.close();

    // ---- (b) avatars in a friend room ----
    const host = new Client('Host');
    const guest = new Client('Guest');
    await host.open('/ws');
    host.send({ type: 'create_room', name: 'Host', avatar: 1, mode: 'classic', rules: {} });
    const lobby = await host.waitFor(s => s.room.status === 'waiting', 4000, 'lobby');
    const code = lobby.room.code;
    check('host avatar echoed in lobby', lobby.seats[0].avatar === 1, 'avatar=' + lobby.seats[0].avatar);
    await guest.open('/ws/' + code);
    guest.send({ type: 'join_room', code, name: 'Guest', avatar: 3 });
    const joined = await host.waitFor(s => s.seats.length === 2, 4000, 'guest joined');
    const guestSeat = joined.seats.find(s => s.name === 'Guest');
    check('guest avatar echoed to other clients', guestSeat && guestSeat.avatar === 3, 'avatar=' + (guestSeat && guestSeat.avatar));
    host.close(); guest.close();

    // ---- (c) leaderboard POST -> GET, sorted ----
    const stamp = Date.now().toString(36);
    const lowName = 'Low' + stamp;
    const highName = 'High' + stamp;
    const p1 = await request('POST', '/api/leaderboard', { name: lowName, avatar: 1, wins: 2, coinsWon: 300 });
    check('leaderboard POST accepted', p1.status === 200, 'status=' + p1.status);
    await request('POST', '/api/leaderboard', { name: highName, avatar: 3, wins: 1, coinsWon: 900 });
    const g1 = await request('GET', '/api/leaderboard');
    const board = JSON.parse(g1.body);
    const li = board.entries.findIndex(e => e.name === lowName);
    const hi = board.entries.findIndex(e => e.name === highName);
    check('leaderboard GET returns posted entries', li >= 0 && hi >= 0, `low@${li} high@${hi} of ${board.entries.length}`);
    check('leaderboard sorted by coinsWon desc', hi >= 0 && li >= 0 && hi < li);
    const highEntry = board.entries[hi];
    check('leaderboard entry shape', !!highEntry && highEntry.avatar === 3 && highEntry.wins === 1 && highEntry.coinsWon === 900,
      JSON.stringify(highEntry));
    const sorted = board.entries.every((e, i, arr) => i === 0 || arr[i - 1].coinsWon > e.coinsWon ||
      (arr[i - 1].coinsWon === e.coinsWon && arr[i - 1].wins >= e.wins));
    check('leaderboard fully sorted (coinsWon, then wins)', sorted);

    // ---- (a) quick match: one round, winner, no next round ----
    const q = new Client('Quick');
    await q.open('/ws');
    q.send({ type: 'create_bot_game', name: 'QuickTester', avatar: 0, botCount: 3, rules: { stacking: true, challenge: true, allWild: false }, quick: true, bet: 50 });
    const qs = await q.waitFor(s => s.room.status === 'playing' && s.game, 5000, 'quick game start');
    check('quick room snapshot carries quick + bet', qs.room.quick === true && qs.room.bet === 50,
      `quick=${qs.room.quick} bet=${qs.room.bet}`);
    check('quick room has 4 seats', qs.seats.length === 4, 'seats=' + qs.seats.length);
    const ended = await autoPlay(q, 240);
    check('quick round ends', ended, 'status=' + (q.latest && q.latest.room.status));
    const endSnap = q.latest;
    check('quick round has a winner', !!(endSnap.lastRound && endSnap.lastRound.winnerSeatId),
      endSnap.lastRound ? 'winner=' + endSnap.lastRound.winnerSeatId : 'no lastRound');
    const errorsBefore = q.errors.length;
    q.send({ type: 'start_game' });
    await sleep(1200);
    check('quick room refuses a next round', q.errors.slice(errorsBefore).some(e => /quick match is over/i.test(e)),
      q.errors.slice(errorsBefore).join('; '));
    check('quick room stays at roundEnd', q.latest.room.status === 'roundEnd', 'status=' + q.latest.room.status);
    q.close();
  } catch (e) {
    check('test run completed', false, e.message);
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
