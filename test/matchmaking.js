'use strict';
/*
 * Live matchmaking tests (MatchmakerDO). Expects wrangler dev at
 * BASE_URL with MATCH_TIMEOUT_MS shrunk (run-local passes 6000).
 * Covers: same-pool pair matched into the SAME room with tickets and
 * the game auto-starts + a turn is played; strict pool isolation
 * (quick:20 vs quick:50, quick:20 vs wild) ending in match_timeout;
 * a reserved seat cannot be claimed without its ticket; cancel /
 * disconnect frees the queue slot; /api/turn-credentials shape.
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

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request(BASE + path, { method, headers }, (res) => {
      let out = '';
      res.on('data', (d) => out += d);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(out); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let phoneSeq = 0;
async function signup(tag) {
  phoneSeq++;
  const phone = '017' + String(20000000 + phoneSeq * 137 + Math.floor(Math.random() * 90)).padStart(8, '0');
  const res = await request('POST', '/api/auth/signup', { phone, password: 'secret1', name: tag });
  if (res.status !== 200) throw new Error('signup failed for ' + tag + ': ' + JSON.stringify(res.body));
  return { phone, token: res.body.token, profile: res.body.profile };
}

// A matchmaking-socket client: collects matched / timeout / errors.
class MmClient {
  constructor() { this.msgs = []; this.matched = null; this.timedOut = false; this.errors = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(WS_BASE + '/ws-match');
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        this.msgs.push(m);
        if (m.type === 'matched') this.matched = m;
        if (m.type === 'match_timeout') this.timedOut = true;
        if (m.type === 'error') this.errors.push(m.message);
      });
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
  }
  find(pool, token) { this.ws.send(JSON.stringify({ type: 'find_match', pool, session: token, avatar: 1 })); }
  cancel() { this.ws.send(JSON.stringify({ type: 'cancel_queue' })); }
  close() { try { this.ws.close(); } catch { /* gone */ } }
  async waitFor(pred, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (pred(this)) return;
      await sleep(60);
    }
    throw new Error('timeout waiting for: ' + label);
  }
}

// A room client (same shape as the other suites).
class Client {
  constructor() { this.states = []; this.errors = []; this.latest = null; }
  open(path) {
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
  close() { try { this.ws.close(); } catch { /* gone */ } }
  async waitFor(pred, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.latest && pred(this.latest)) return this.latest;
      await sleep(60);
    }
    throw new Error('timeout waiting for: ' + label);
  }
}

async function main() {
  // ------------------------------------------------ turn credentials shape
  const tc = await request('GET', '/api/turn-credentials');
  check('turn: endpoint returns iceServers', tc.status === 200 && Array.isArray(tc.body.iceServers) && tc.body.iceServers.length >= 1);
  check('turn: STUN is always present', JSON.stringify(tc.body.iceServers).includes('stun:'));

  const A = await signup('MmA');
  const B = await signup('MmB');

  // ------------------------------------------------ same pool -> matched, same room, game plays
  const mmA = new MmClient(); await mmA.open();
  const mmB = new MmClient(); await mmB.open();
  mmA.find('quick:20', A.token);
  await sleep(150);
  mmB.find('quick:20', B.token);
  await mmA.waitFor(c => c.matched, 5000, 'A matched');
  await mmB.waitFor(c => c.matched, 5000, 'B matched');
  check('mm: both players matched', !!mmA.matched && !!mmB.matched);
  check('mm: matched into the SAME room code', mmA.matched.code === mmB.matched.code,
    mmA.matched.code + ' vs ' + mmB.matched.code);
  check('mm: each got a distinct one-time ticket', !!mmA.matched.ticket && !!mmB.matched.ticket && mmA.matched.ticket !== mmB.matched.ticket);
  const code = mmA.matched.code;

  // A third player must NOT be able to claim a reserved seat.
  const G = await signup('MmGate');
  const gate = new Client(); await gate.open('/ws/' + code);
  gate.send({ type: 'join_room', code, name: 'Gate', session: G.token, avatar: 0 });
  await sleep(500);
  check('mm: ticketless join of a live room is refused', gate.errors.some(e => /live-match/.test(e)),
    JSON.stringify(gate.errors));
  gate.close();

  const roomA = new Client(); await roomA.open('/ws/' + code);
  roomA.send({ type: 'join_room', code, ticket: mmA.matched.ticket, session: A.token, avatar: 1 });
  const roomB = new Client(); await roomB.open('/ws/' + code);
  roomB.send({ type: 'join_room', code, ticket: mmB.matched.ticket, session: B.token, avatar: 2 });
  const startA = await roomA.waitFor(s => s.room.status === 'playing', 6000, 'A sees the game start');
  await roomB.waitFor(s => s.room.status === 'playing', 6000, 'B sees the game start');
  check('mm: game auto-starts when both ticketed players join', startA.room.liveKind === 'quick');
  check('mm: exactly 2 seats, no bots', startA.seats.length === 2 && startA.seats.every(s => !s.isBot));

  // A turn is played by whoever is current.
  const cur = startA.seats.find(s => s.isCurrent);
  const actor = cur.isYou ? roomA : roomB;
  const other = cur.isYou ? roomB : roomA;
  const actorState = actor.latest;
  const legal = actorState.game.legalCardIds || [];
  if (legal.length) {
    const card = actorState.game.yourHand.find(c => c.id === legal[0]);
    actor.send({ type: 'play_card', cardId: card.id, chosenColor: 'red', callUno: true });
  } else {
    actor.send({ type: 'draw_card' });
  }
  const t0 = Date.now();
  let moved = false;
  let passed = false;
  while (Date.now() - t0 < 5000) {
    // A drawn playable card keeps the turn — pass it on deliberately.
    if (!passed && actor.latest && actor.latest.game && actor.latest.game.drewCardId) {
      actor.send({ type: 'pass' });
      passed = true;
    }
    if (other.latest && other.latest.game && other.latest.game.isYourTurn) { moved = true; break; }
    if (actor.latest && actor.latest.room.status === 'roundEnd') { moved = true; break; }
    await sleep(80);
  }
  check('mm: a turn is played and play moves on', moved);
  roomA.close(); roomB.close(); mmA.close(); mmB.close();

  // ------------------------------------------------ strict pool isolation -> timeouts
  const C = await signup('MmC');
  const D = await signup('MmD');
  const E = await signup('MmE');
  const F = await signup('MmF');
  const mmC = new MmClient(); await mmC.open();
  const mmD = new MmClient(); await mmD.open();
  const mmE = new MmClient(); await mmE.open();
  const mmF = new MmClient(); await mmF.open();
  mmC.find('quick:50', C.token);
  mmD.find('quick:20', D.token);
  mmE.find('quick:20', E.token); // same pool as D — wait, D and E WOULD match.
  mmF.find('wild', F.token);
  // D and E are both quick:20, so they match each other — that is the
  // control case. C (quick:50) and F (wild) must time out alone.
  await mmD.waitFor(c => c.matched, 5000, 'D matched with E (control)');
  await mmE.waitFor(c => c.matched, 5000, 'E matched with D (control)');
  check('mm: control pair in the same pool matches', mmD.matched.code === mmE.matched.code);
  await mmC.waitFor(c => c.timedOut, 12000, 'C times out in quick:50');
  await mmF.waitFor(c => c.timedOut, 12000, 'F times out in wild');
  check('mm: quick:50 searcher never matched across pools', !mmC.matched && mmC.timedOut);
  check('mm: wild searcher never matched with quick searchers', !mmF.matched && mmF.timedOut);
  mmC.close(); mmD.close(); mmE.close(); mmF.close();

  // ------------------------------------------------ cancel/disconnect frees the slot
  const H = await signup('MmH');
  const I = await signup('MmI');
  const J = await signup('MmJ');
  const mmH = new MmClient(); await mmH.open();
  mmH.find('quick:100', H.token);
  await sleep(250);
  mmH.cancel();
  mmH.close(); // disconnect as well — double removal must be safe
  await sleep(250);
  const mmI = new MmClient(); await mmI.open();
  mmI.find('quick:100', I.token);
  await sleep(700);
  check('mm: a cancelled/disconnected entry never matches', !mmI.matched);
  const mmJ = new MmClient(); await mmJ.open();
  mmJ.find('quick:100', J.token);
  await mmI.waitFor(c => c.matched, 5000, 'I matched with J');
  await mmJ.waitFor(c => c.matched, 5000, 'J matched with I');
  check('mm: the freed pool matches the next pair', mmI.matched.code === mmJ.matched.code);
  mmI.close(); mmJ.close();

  // ------------------------------------------------ guests cannot queue
  const mmGuest = new MmClient(); await mmGuest.open();
  mmGuest.ws.send(JSON.stringify({ type: 'find_match', pool: 'wild' }));
  await sleep(500);
  check('mm: guests cannot queue', mmGuest.errors.some(e => /Log in/.test(e)), JSON.stringify(mmGuest.errors));
  mmGuest.close();

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
