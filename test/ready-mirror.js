'use strict';
/*
 * Ready/Start mirror (Addition 2): the host's displayed readiness must
 * mirror the server's authoritative flags in real time.
 *  - the host's own seat is ready from creation (they have no Ready
 *    button; creating the room is their ready signal),
 *  - a guest toggling ready appears in the host's NEXT state with no
 *    further action from the host,
 *  - start succeeds when everyone is ready, and an un-ready toggle
 *    blocks it again with the gate message.
 */
import WebSocket from 'ws';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Client {
  constructor() { this.states = []; this.errors = []; this.latest = null; }
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
  close() { try { this.ws.close(); } catch { /* gone */ } }
  async waitFor(pred, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.latest && pred(this.latest)) return this.latest;
      await sleep(50);
    }
    throw new Error('timeout waiting for: ' + label);
  }
  async waitStates(n, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.states.length >= n) return;
      await sleep(50);
    }
    throw new Error('timeout waiting for ' + n + ' states (got ' + this.states.length + ')');
  }
}

async function main() {
  // ------------------------------------------------ room 1: happy path
  const host = new Client(); await host.open('/ws');
  host.send({ type: 'create_room', name: 'Host', avatar: 0, mode: 'classic', maxSeats: 4, rules: { stacking: true, challenge: true, allWild: false } });
  const lobby = await host.waitFor(s => s.room.status === 'waiting' && s.seats.length === 1, 5000, 'host lobby');
  const code = lobby.room.code;
  const hostSeat = lobby.seats.find(s => s.isYou);
  check('ready: the host seat is ready from creation', hostSeat.ready === true);

  const guest = new Client(); await guest.open('/ws/' + code);
  guest.send({ type: 'join_room', code, name: 'Guest', avatar: 1 });
  await guest.waitFor(s => s.seats.length === 2, 5000, 'guest seated');
  const hostSeesGuest = await host.waitFor(s => s.seats.length === 2, 5000, 'host sees guest');
  const guestSeatForHost = hostSeesGuest.seats.find(s => !s.isYou);
  check('ready: guest starts not-ready in the host snapshot', guestSeatForHost.ready === false);

  // Un-ready guest blocks the start with the gate message.
  host.send({ type: 'start_game' });
  await sleep(500);
  check('ready: start is refused while a guest is not ready', host.errors.some(e => /Everyone must be ready/.test(e)),
    JSON.stringify(host.errors));

  // Guest readies up — the host must see it WITHOUT doing anything.
  const hostStateCount = host.states.length;
  guest.send({ type: 'set_ready', ready: true });
  await host.waitStates(hostStateCount + 1, 4000);
  const mirrored = host.latest.seats.find(s => !s.isYou);
  check('ready: host snapshot mirrors the guest ready flag unprompted', mirrored.ready === true);

  host.send({ type: 'start_game' });
  await host.waitFor(s => s.room.status === 'playing', 6000, 'game starts after everyone ready');
  check('ready: start succeeds once everyone is ready', true);
  host.close(); guest.close();

  // ------------------------------------------------ room 2: un-ready blocks again
  const h2 = new Client(); await h2.open('/ws');
  h2.send({ type: 'create_room', name: 'Host2', avatar: 0, mode: 'classic', maxSeats: 4, rules: { stacking: true, challenge: true, allWild: false } });
  const lobby2 = await h2.waitFor(s => s.room.status === 'waiting' && s.seats.length === 1, 5000, 'host2 lobby');
  const code2 = lobby2.room.code;
  const g2 = new Client(); await g2.open('/ws/' + code2);
  g2.send({ type: 'join_room', code: code2, name: 'Guest2', avatar: 2 });
  await g2.waitFor(s => s.seats.length === 2, 5000, 'guest2 seated');
  g2.send({ type: 'set_ready', ready: true });
  await h2.waitFor(s => s.seats.every(x => x.ready), 5000, 'host2 sees ready');
  g2.send({ type: 'set_ready', ready: false });
  await h2.waitFor(s => s.seats.some(x => !x.isYou && !x.ready), 5000, 'host2 sees un-ready');
  check('ready: un-ready toggle mirrors to the host too', true);
  h2.send({ type: 'start_game' });
  await sleep(500);
  check('ready: start blocked again after un-ready', h2.errors.some(e => /Everyone must be ready/.test(e)),
    JSON.stringify(h2.errors));
  check('ready: game did not start', !h2.latest || h2.latest.room.status !== 'playing');
  h2.close(); g2.close();

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
