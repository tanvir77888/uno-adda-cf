'use strict';
/*
 * Smoke test for UNO Adda (Cloudflare port). Expects the Worker to already
 * be running under `wrangler dev` (see test/run-local.sh) at BASE_URL
 * (default http://127.0.0.1:8787). Checks:
 *  1. /health and the home page load over HTTP
 *  2. a bot game starts, the test player can play cards, bots take turns
 *  3. a room can be created, a second client joins by code (connecting to
 *     /ws/<CODE> so the Worker routes it to that room's Durable Object),
 *     ready + start works
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

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
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

// Play whenever it is our turn: first legal card, UNO declared, color = red-ish.
async function autoPlay(client, seconds, stats) {
  const t0 = Date.now();
  let acted = new Set();
  while (Date.now() - t0 < seconds * 1000) {
    const s = client.latest;
    if (s && s.game && s.room.status === 'playing') {
      const g = s.game;
      if (g.youMustPickColor) {
        client.send({ type: 'pick_color', color: 'red' });
        await sleep(150);
        continue;
      }
      if (g.isYourTurn) {
        const key = g.topCard.id + '|' + g.yourHand.length + '|' + g.pendingDraw + '|' + (g.drewCardId || '');
        if (!acted.has(key)) {
          acted.add(key);
          if (g.drewCardId) {
            const drawnPlayable = g.legalCardIds.includes(g.drewCardId);
            client.send(drawnPlayable ? { type: 'play_card', cardId: g.drewCardId, callUno: true, chosenColor: 'blue' } : { type: 'pass' });
            stats.plays++;
          } else if (g.legalCardIds.length) {
            const card = g.yourHand.find(c => c.id === g.legalCardIds[0]);
            client.send({ type: 'play_card', cardId: card.id, callUno: true, chosenColor: 'green' });
            stats.plays++;
          } else if (g.canChallenge && Math.random() < 0.5) {
            client.send({ type: 'challenge' });
            stats.plays++;
          } else {
            client.send({ type: 'draw_card' });
            stats.draws++;
          }
        }
      }
    }
    if (s && s.room.status === 'roundEnd') break;
    await sleep(120);
  }
}

async function main() {
  try {
    // 1. HTTP
    const h = await get('/health');
    check('worker is up and /health answers', h.body === 'ok');
    const home = await get('/');
    check('home page loads', home.status === 200 && home.body.includes('UNO') && home.body.includes('Adda'));

    // 2. Bot game (socket at /ws — the Worker assigns a fresh room object)
    const solo = new Client('Solo');
    await solo.open('/ws');
    solo.send({ type: 'create_bot_game', name: 'Tester', botCount: 2, rules: { stacking: true, challenge: true, allWild: false } });
    const started = await solo.waitFor(s => s.room.status === 'playing' && s.game, 5000, 'bot game start');
    check('bot game starts with 3 seats', started.seats.length === 3, 'seats=' + started.seats.length);
    check('player dealt 7 cards', started.game.yourHand.length === 7, 'hand=' + started.game.yourHand.length);
    const stats = { plays: 0, draws: 0 };
    await autoPlay(solo, 25, stats);
    const after = solo.latest;
    const discardGrew = after.game && after.seats.reduce((n, s) => n + s.cardCount, 0) !== 21;
    check('cards were played/drawn during bot game', stats.plays + stats.draws > 0 && discardGrew,
      `plays=${stats.plays} draws=${stats.draws}`);
    check('no server errors in bot game', solo.errors.length === 0, solo.errors.join('; '));
    solo.close();

    // 3. Room create + join + start
    const host = new Client('Host');
    const guest = new Client('Guest');
    await host.open('/ws');
    host.send({ type: 'create_room', name: 'Host', mode: 'classic', rules: {} });
    const lobby = await host.waitFor(s => s.room.status === 'waiting', 4000, 'lobby');
    const code = lobby.room.code;
    check('room created with 6-letter code', /^[A-Z2-9]{6}$/.test(code), code);
    // The guest's socket must be routed to the same Durable Object.
    await guest.open('/ws/' + code);
    guest.send({ type: 'join_room', code, name: 'Guest' });
    await guest.waitFor(s => s.room.status === 'waiting' && s.seats.length === 2, 4000, 'guest in lobby');
    check('second client joined by code', true);
    guest.send({ type: 'join_room', code: 'ZZZZZZ', name: 'Nobody' });
    await sleep(300);
    check('bad room code rejected', guest.errors.some(e => /not found/i.test(e)), guest.errors.join('; '));
    guest.send({ type: 'set_ready', ready: true });
    await host.waitFor(s => s.seats.find(x => x.name === 'Guest' && x.ready), 4000, 'ready state');
    check('ready state syncs to host', true);
    host.send({ type: 'start_game' });
    const live = await guest.waitFor(s => s.room.status === 'playing' && s.game, 5000, 'room game start');
    check('room game starts; guest has 7 cards', live.game.yourHand.length === 7);
    const rstats = { plays: 0, draws: 0 };
    const errorsBefore = host.errors.length + guest.errors.length; // includes the intentional bad-code error above
    // Whoever's turn it is plays via their own client; drive both.
    const both = (async () => { await autoPlay(host, 12, rstats); })();
    await autoPlay(guest, 12, rstats);
    await both;
    const newErrors = host.errors.length + guest.errors.length - errorsBefore;
    check('room game progresses without errors', newErrors === 0 && rstats.plays + rstats.draws > 0,
      `plays=${rstats.plays} draws=${rstats.draws} newErrors=${newErrors}`);
    host.close(); guest.close();
  } catch (e) {
    check('test run completed', false, e.message);
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
