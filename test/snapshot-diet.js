'use strict';
/*
 * Snapshot diet test: with 4 max-size profile photos in a friend room,
 * the FIRST 'playing' state a socket receives carries every photo
 * (hundreds of KB), while LATER playing states omit them (< 10KB) —
 * the client merges the cached photos back by seat id (covered in the
 * jsdom suite). Before the diet, every state carried every photo.
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
const MAX_JPEG = 'data:image/jpeg;base64,' + 'A'.repeat(54000); // ~40.5KB decoded, under the 40KB cap

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

let seq = 0;
async function signupWithPhoto(tag) {
  seq++;
  const phone = '017' + String(31000000 + seq * 271 + Math.floor(Math.random() * 90)).padStart(8, '0');
  const res = await request('POST', '/api/auth/signup', { phone, password: 'secret1', name: tag });
  if (res.status !== 200) throw new Error('signup failed: ' + JSON.stringify(res.body));
  const up = await request('POST', '/api/auth/photo', { photo: MAX_JPEG }, res.body.token);
  if (up.status !== 200) throw new Error('photo upload failed: ' + JSON.stringify(up.body));
  return { phone, token: res.body.token };
}

class Client {
  constructor() { this.states = []; this.latest = null; } // states: { msg, bytes }
  open(path) {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(WS_BASE + path);
      this.ws.on('message', (raw) => {
        const text = raw.toString();
        const msg = JSON.parse(text);
        if (msg.type === 'state') { this.states.push({ msg, bytes: Buffer.byteLength(text) }); this.latest = msg; }
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
  playingStates() { return this.states.filter(s => s.msg.room.status === 'playing'); }
}

async function main() {
  const users = [];
  for (const tag of ['DietA', 'DietB', 'DietC', 'DietD']) users.push(await signupWithPhoto(tag));

  const host = new Client(); await host.open('/ws');
  host.send({ type: 'create_room', name: 'DietA', session: users[0].token, avatar: 0, mode: 'classic', maxSeats: 4, rules: { stacking: true, challenge: true, allWild: false } });
  const lobby = await host.waitFor(s => s.room.status === 'waiting', 5000, 'host lobby');
  const code = lobby.room.code;

  const guests = [];
  for (let i = 1; i < 4; i++) {
    const c = new Client(); await c.open('/ws/' + code);
    c.send({ type: 'join_room', code, name: 'Diet' + 'BCD'[i - 1], session: users[i].token, avatar: i });
    await c.waitFor(s => s.seats.length === i + 1, 5000, 'guest ' + i + ' seated');
    c.send({ type: 'set_ready', ready: true });
    guests.push(c);
  }
  await host.waitFor(s => s.seats.every(x => x.ready), 5000, 'everyone ready');
  host.send({ type: 'start_game' });
  await host.waitFor(s => s.room.status === 'playing', 6000, 'game starts');

  // First playing state per socket: photos ride along (baseline).
  const hostFirst = host.playingStates()[0];
  check('diet: first playing state carries all 4 photos', hostFirst.msg.seats.every(s => !!s.photo));
  check('diet: first playing state is heavy (> 150KB)', hostFirst.bytes > 150 * 1024,
    'bytes=' + hostFirst.bytes);

  // Play a few turns so several more states flow.
  const all = [host, ...guests];
  for (let turn = 0; turn < 3; turn++) {
    const cur = all.find(c => c.latest && c.latest.game && c.latest.game.isYourTurn);
    if (!cur) break;
    const legal = cur.latest.game.legalCardIds || [];
    if (legal.length) {
      const card = cur.latest.game.yourHand.find(c => c.id === legal[0]);
      cur.send({ type: 'play_card', cardId: card.id, chosenColor: 'red', callUno: true });
    } else {
      cur.send({ type: 'draw_card' });
    }
    await sleep(450);
  }

  const later = host.playingStates().slice(1);
  check('diet: more playing states flowed after the first', later.length >= 2, 'count=' + later.length);
  const lastHost = later[later.length - 1];
  check('diet: later playing state is under 10KB', lastHost.bytes < 10 * 1024, 'bytes=' + lastHost.bytes);
  check('diet: later states omit photos (client merges by seat id)', lastHost.msg.seats.every(s => !s.photo));
  const guestLater = guests[0].playingStates().slice(1);
  const lastGuest = guestLater[guestLater.length - 1];
  check('diet: guest sockets get the same diet', !!lastGuest && lastGuest.bytes < 10 * 1024,
    'bytes=' + (lastGuest && lastGuest.bytes));

  for (const c of all) c.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
