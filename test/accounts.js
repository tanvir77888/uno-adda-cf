'use strict';
/*
 * Account-system tests for UNO Adda (Cloudflare port). Expects the Worker
 * to already be running under `wrangler dev` (see test/run-local.sh) at
 * BASE_URL (default http://127.0.0.1:8787). Covers the full account
 * contract:
 *   signup validation + success -> /me -> duplicate signup 409 ->
 *   login wrong password 401 -> login ok -> daily gift (+200, then 409) ->
 *   wallet adjust (clamps, insufficient rejected) -> photo upload rules ->
 *   name change -> stats/match increments + clamps -> rescue rules ->
 *   WS: a bot game created WITH a session carries the account name +
 *   photo (payload avatar still wins); an invalid session is rejected ->
 *   logout kills the session.
 * Exits non-zero on the first failed run summary.
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

class Client {
  constructor() {
    this.states = [];
    this.errors = [];
    this.ws = null;
    this.latest = null;
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

// Unique, regex-valid BD numbers per run: 017 + 8 digits.
const stamp = Date.now().toString().slice(-8);
const PHONE1 = '017' + stamp;
const PHONE2 = '017' + String(Number(stamp) + 1).padStart(8, '0');
// A real 1x1 JPEG (tiny), and abuse cases for the photo rules.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const BIG_JPEG = 'data:image/jpeg;base64,' + 'A'.repeat(60000); // ~45KB decoded

async function main() {
  try {
    // ---------------------------------------------------------- signup validation
    let r = await request('POST', '/api/auth/signup', { phone: '12345', password: 'secret1', name: 'Tester' });
    check('signup rejects a bad phone number', r.status === 400, 'status=' + r.status);
    r = await request('POST', '/api/auth/signup', { phone: PHONE1, password: '12345', name: 'Tester' });
    check('signup rejects a short password', r.status === 400, 'status=' + r.status);
    r = await request('POST', '/api/auth/signup', { phone: PHONE1, password: 'secret1', name: 'T' });
    check('signup rejects a 1-char name', r.status === 400, 'status=' + r.status);

    // ---------------------------------------------------------- signup ok
    r = await request('POST', '/api/auth/signup', { phone: PHONE1, password: 'secret1', name: 'Acct Tester' });
    check('signup succeeds', r.status === 200 && !!r.body.token, 'status=' + r.status);
    const token = r.body.token;
    const prof = r.body.profile || {};
    check('profile shape (id from 1001, 500 coins)', prof.playerId >= 1001 && prof.phone === PHONE1 && prof.name === 'Acct Tester' && prof.coins === 500 && prof.matches === 0 && prof.wins === 0 && prof.coinsWon === 0 && prof.photo === null,
      JSON.stringify(prof));

    // ---------------------------------------------------------- /me
    r = await request('GET', '/api/auth/me');
    check('/me without a token is 401', r.status === 401, 'status=' + r.status);
    r = await request('GET', '/api/auth/me', null, 'deadbeef'.repeat(8));
    check('/me with a bogus token is 401', r.status === 401, 'status=' + r.status);
    r = await request('GET', '/api/auth/me', null, token);
    check('/me returns the profile', r.status === 200 && r.body.playerId === prof.playerId && r.body.name === 'Acct Tester',
      JSON.stringify(r.body));

    // ---------------------------------------------------------- duplicate + login
    r = await request('POST', '/api/auth/signup', { phone: PHONE1, password: 'secret1', name: 'Copycat' });
    check('duplicate signup is 409', r.status === 409, 'status=' + r.status);
    r = await request('POST', '/api/auth/login', { phone: PHONE1, password: 'wrong-pass' });
    check('login with wrong password is 401', r.status === 401, 'status=' + r.status);
    r = await request('POST', '/api/auth/login', { phone: PHONE2, password: 'secret1' });
    check('login with unknown number is 401', r.status === 401, 'status=' + r.status);
    r = await request('POST', '/api/auth/login', { phone: PHONE1, password: 'secret1' });
    check('login succeeds', r.status === 200 && !!r.body.token && r.body.profile.playerId === prof.playerId, 'status=' + r.status);
    const loginToken = r.body.token;

    // ---------------------------------------------------------- gift (once per Dhaka day)
    r = await request('POST', '/api/wallet/gift', {}, loginToken);
    check('daily gift grants +200', r.status === 200 && r.body.coins === 700, JSON.stringify(r.body));
    r = await request('POST', '/api/wallet/gift', {}, loginToken);
    check('second gift the same day is 409', r.status === 409, 'status=' + r.status);

    // ---------------------------------------------------------- adjust
    r = await request('POST', '/api/wallet/adjust', { amount: -250, reason: 'stake' }, loginToken);
    check('adjust -250 ok', r.status === 200 && r.body.coins === 450, JSON.stringify(r.body));
    r = await request('POST', '/api/wallet/adjust', { amount: -250, reason: 'stake' }, loginToken);
    check('adjust -250 ok again', r.status === 200 && r.body.coins === 200, JSON.stringify(r.body));
    r = await request('POST', '/api/wallet/adjust', { amount: -250, reason: 'stake' }, loginToken);
    check('adjust -250 rejected when balance < 250', r.status === 400, 'status=' + r.status);
    r = await request('POST', '/api/wallet/adjust', { amount: 5000, reason: 'pot' }, loginToken);
    check('adjust credit clamped to +1000', r.status === 200 && r.body.coins === 1200, JSON.stringify(r.body));
    r = await request('POST', '/api/wallet/adjust', { amount: -999, reason: 'stake' }, loginToken);
    check('adjust debit clamped to -250', r.status === 200 && r.body.coins === 950, JSON.stringify(r.body));

    // ---------------------------------------------------------- photo rules
    r = await request('POST', '/api/auth/photo', { photo: PNG }, loginToken);
    check('photo rejects a non-JPEG', r.status === 400, 'status=' + r.status);
    r = await request('POST', '/api/auth/photo', { photo: BIG_JPEG }, loginToken);
    check('photo rejects > 40KB decoded', r.status === 400, 'status=' + r.status);
    r = await request('POST', '/api/auth/photo', { photo: JPEG }, loginToken);
    check('photo upload ok', r.status === 200 && r.body.profile && r.body.profile.photo === JPEG, 'status=' + r.status);
    r = await request('GET', '/api/auth/me', null, loginToken);
    check('/me shows the uploaded photo', r.status === 200 && r.body.photo === JPEG);

    // ---------------------------------------------------------- name change
    r = await request('POST', '/api/auth/name', { name: 'Renamed Tester' }, loginToken);
    check('name change ok', r.status === 200 && r.body.profile.name === 'Renamed Tester', 'status=' + r.status);
    r = await request('POST', '/api/auth/name', { name: 'X' }, loginToken);
    check('name change rejects 1-char', r.status === 400, 'status=' + r.status);

    // ---------------------------------------------------------- stats
    r = await request('POST', '/api/stats/match', { won: true, coinsWon: 300 }, loginToken);
    check('stats: first match recorded', r.status === 200 && r.body.matches === 1 && r.body.wins === 1 && r.body.coinsWon === 300, JSON.stringify(r.body));
    r = await request('POST', '/api/stats/match', { won: false, coinsWon: 5000 }, loginToken);
    check('stats: loss + coinsWon clamped to +1000', r.status === 200 && r.body.matches === 2 && r.body.wins === 1 && r.body.coinsWon === 1300, JSON.stringify(r.body));

    // ---------------------------------------------------------- WS with a session
    const c = new Client();
    await c.open('/ws');
    c.send({ type: 'create_bot_game', name: 'Not My Name', avatar: 1, botCount: 1, rules: {}, session: loginToken });
    const snap = await c.waitFor(s => s.room.status === 'playing' && s.game, 5000, 'bot game with session');
    const me = snap.seats.find(s => s.isYou);
    check('WS seat carries the ACCOUNT name (not the payload name)', me.name === 'Renamed Tester', 'name=' + me.name);
    check('WS seat carries the account photo', me.photo === JPEG, 'photo=' + String(me.photo).slice(0, 30));
    check('WS payload avatar still wins over the account avatar', me.avatar === 1, 'avatar=' + me.avatar);
    c.close();

    // ---------------------------------------------------------- WS invalid session
    const bad = new Client();
    await bad.open('/ws');
    bad.send({ type: 'create_bot_game', name: 'Sneaky', avatar: 0, botCount: 1, rules: {}, session: 'f'.repeat(64) });
    await sleep(1200);
    check('invalid session is rejected', bad.errors.some(e => /Session expired/.test(e)), bad.errors.join('; '));
    check('invalid session creates no room', !bad.latest, 'states=' + bad.states.length);
    bad.close();

    // ---------------------------------------------------------- WS guest still works
    const guest = new Client();
    await guest.open('/ws');
    guest.send({ type: 'create_bot_game', name: 'Guest Player', avatar: 3, botCount: 1, rules: {} });
    const gsnap = await guest.waitFor(s => s.room.status === 'playing' && s.game, 5000, 'guest bot game');
    const gme = gsnap.seats.find(s => s.isYou);
    check('guest seat keeps payload name/avatar, photo null', gme.name === 'Guest Player' && gme.avatar === 3 && gme.photo === null,
      `name=${gme.name} avatar=${gme.avatar} photo=${gme.photo}`);
    guest.close();

    // ---------------------------------------------------------- rescue rules (account 2)
    r = await request('POST', '/api/auth/signup', { phone: PHONE2, password: 'secret2', name: 'Broke Player' });
    check('second signup succeeds', r.status === 200 && !!r.body.token, 'status=' + r.status);
    const token2 = r.body.token;
    r = await request('POST', '/api/wallet/rescue', {}, token2);
    check('rescue refused before the gift is claimed', r.status === 409, 'status=' + r.status);
    r = await request('POST', '/api/wallet/adjust', { amount: -250, reason: 'stake' }, token2);
    r = await request('POST', '/api/wallet/adjust', { amount: -250, reason: 'stake' }, token2);
    check('second account drained to 0', r.status === 200 && r.body.coins === 0, JSON.stringify(r.body));
    r = await request('POST', '/api/wallet/rescue', {}, token2);
    check('rescue still refused (gift not claimed yet)', r.status === 409, 'status=' + r.status);
    r = await request('POST', '/api/wallet/gift', {}, token2);
    check('second account gift +200', r.status === 200 && r.body.coins === 200, JSON.stringify(r.body));
    r = await request('POST', '/api/wallet/adjust', { amount: -200, reason: 'stake' }, token2);
    check('second account back to 0', r.status === 200 && r.body.coins === 0, JSON.stringify(r.body));
    r = await request('POST', '/api/wallet/rescue', {}, token2);
    check('rescue grants +100 when broke after gift', r.status === 200 && r.body.coins === 100, JSON.stringify(r.body));
    r = await request('POST', '/api/wallet/rescue', {}, token2);
    check('rescue is once a day', r.status === 409, 'status=' + r.status);

    // ---------------------------------------------------------- logout
    r = await request('POST', '/api/auth/logout', {}, loginToken);
    check('logout ok', r.status === 200, 'status=' + r.status);
    r = await request('GET', '/api/auth/me', null, loginToken);
    check('logged-out token is dead', r.status === 401, 'status=' + r.status);
  } catch (e) {
    check('test run completed', false, e.message);
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
