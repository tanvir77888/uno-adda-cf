'use strict';
/*
 * End-to-end friend-room tests for UNO Adda:
 *
 * Part 1 (real client, two logged-in accounts in jsdom + real WebSocket):
 *   the 2026-11-22 join bug — a room created on one "phone" could not be
 *   joined by code on another, because the client's boot socket (opened
 *   on plain /ws) was reused for the join and the join_room message landed
 *   on an empty Durable Object. A creates a room, B joins by typing the
 *   code in lowercase, both ready/start, the round intro completes, and
 *   each plays a turn. Acceptance rule: any phone that enters the code
 *   lands in the SAME room, then the game starts.
 *
 * Part 2 (raw WebSocket clients):
 *   - a 12-seat friend room: create with maxSeats 12, 11 joins, a 13th is
 *     refused, all ready, host starts, turns rotate through the table;
 *   - a default room still caps at 4 seats;
 *   - team mode at 6 seats (parity teams) starts and plays;
 *   - voice signaling works inside a friend room (roster + peer_joined).
 *
 * Run (with the dev server up): BASE_URL=http://127.0.0.1:8787 node test/friends-e2e.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(80); }
  throw new Error('timeout waiting: ' + label);
}
async function req(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: parsed };
}

// ------------------------------------------------------------ raw WS client
class Client {
  constructor() { this.states = []; this.errors = []; this.msgs = []; this.latest = null; this.ws = null; }
  open(p = '/ws') {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(WS_BASE + p);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        this.msgs.push(msg);
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
      await sleep(50);
    }
    throw new Error('timeout waiting for: ' + label + ' (errors: ' + this.errors.join('; ') + ')');
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// Drive one raw client through its turns until `shouldStop()` is true.
async function autoPlay(client, shouldStop, deadlineMs) {
  let actedKey = '';
  const end = Date.now() + deadlineMs;
  while (Date.now() < end && !shouldStop()) {
    const s = client.latest;
    if (s && s.game && s.room.status === 'playing') {
      const g = s.game;
      const key = s.seats.map(x => x.cardCount).join(',') + '|' + (g.topCard ? g.topCard.id : '') + '|' + s.seats.findIndex(x => x.isCurrent) + '|' + g.phase + '|' + (g.drewCardId || '') + '|' + g.pendingDraw;
      if (g.youMustPickColor) {
        if (actedKey !== key) { actedKey = key; client.send({ type: 'pick_color', color: 'red' }); }
      } else if (g.isYourTurn && actedKey !== key) {
        actedKey = key;
        if (g.legalCardIds && g.legalCardIds.length) {
          const cardId = g.legalCardIds[0];
          const card = g.yourHand.find(c => c.id === cardId);
          const m = { type: 'play_card', cardId, callUno: g.yourHand.length === 2 };
          if (card && card.color === 'wild') m.chosenColor = 'red';
          client.send(m);
        } else if (g.drewCardId) {
          client.send({ type: 'pass' });
        } else {
          client.send({ type: 'draw_card' });
        }
      }
    }
    await sleep(45);
  }
}

// ------------------------------------------------------------ jsdom page (real client)
function makePage(token) {
  const store = new Map();
  if (token) store.set('uno-adda-session', token);
  const dom = new JSDOM(html, {
    url: BASE + '/',
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
      window.WebSocket = WebSocket;
      window.fetch = (url, init) => fetch(new URL(url, BASE + '/').toString(), init);
      window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      window.AudioContext = class {
        constructor() { this.currentTime = 0; this.destination = {}; this.state = 'running'; }
        resume() { return Promise.resolve(); }
        createOscillator() { return { connect() {}, start() {}, stop() {}, type: '', frequency: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
        createGain() { return { connect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
        createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
        createBufferSource() { return { connect() {}, start() {}, stop() {}, buffer: null }; }
        createBiquadFilter() { return { connect() {}, type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, Q: { value: 0 } }; }
      };
      window.webkitAudioContext = window.AudioContext;
    },
  });
  dom.window.eval(appJs);
  return dom;
}
const $ = (dom, id) => dom.window.document.getElementById(id);
const shown = (dom, id) => !$(dom, id).classList.contains('hidden');

async function part1() {
  console.log('--- part 1: two logged-in clients, create → join → start → play');
  const stamp = Date.now().toString().slice(-8);
  const a = await req('POST', '/api/auth/signup', { phone: '017' + stamp, password: 'secret1', name: 'Host A' });
  const b = await req('POST', '/api/auth/signup', { phone: '018' + stamp, password: 'secret1', name: 'Joiner B' });
  check('part1: both accounts created', a.status === 200 && b.status === 200, a.status + '/' + b.status);

  const domA = makePage(a.body.token);
  const domB = makePage(b.body.token);
  try {
    await waitFor(() => shown(domA, 'view-home'), 9000, 'A home');
    await waitFor(() => shown(domB, 'view-home'), 9000, 'B home');
    $(domA, 'btn-create').click();
    const code = await waitFor(() => {
      const t = ($(domA, 'lobby-code').textContent || '').trim();
      return t.length === 6 ? t : null;
    }, 9000, 'A room code');
    check('part1: host created a room', !!code, 'code=' + code);

    // B's client already holds a boot socket (the join bug's trigger).
    $(domB, 'in-code').value = code.toLowerCase();
    $(domB, 'btn-join').click();
    const bCode = await waitFor(() => {
      const t = ($(domB, 'lobby-code').textContent || '').trim();
      return t === code ? t : null;
    }, 9000, 'B in the same lobby');
    check('part1: joiner lands in the SAME room by code (typed lowercase)', bCode === code);
    await waitFor(() => domB.window.document.querySelectorAll('#lobby-seats .seat-row').length === 2, 5000, 'B sees 2 seats');
    await waitFor(() => domA.window.document.querySelectorAll('#lobby-seats .seat-row').length === 2, 5000, 'A sees 2 seats');
    check('part1: both lobbies show 2 players', true);

    $(domB, 'btn-ready').click();
    await sleep(400);
    $(domA, 'btn-start').click();
    await waitFor(() => shown(domA, 'view-game') && shown(domB, 'view-game'), 9000, 'both in game view');
    check('part1: game started on both phones', true);

    // The round intro (shuffle → deal) runs, then input unblocks.
    await waitFor(() => {
      const ia = domA.window.__intro;
      return !$(domA, 'view-game').classList.contains('intro-on') && (!ia || ia.phase === 'done');
    }, 12000, 'intro completes on A');
    check('part1: round intro completed before play', true);

    // Each phone plays one turn (driven through the real DOM).
    const played = { A: false, B: false };
    const driveTurn = async (dom, who) => {
      const hand = dom.window.document.querySelectorAll('#my-hand .card.playable');
      if (hand.length) {
        hand[0].click();
        await sleep(250);
        const colorBtn = dom.window.document.querySelector('.color-btn');
        if (colorBtn && shown(dom, 'color-modal')) colorBtn.click();
      } else {
        $(dom, 'draw-pile').click();
        await sleep(350);
        if (shown(dom, 'btn-pass')) $(dom, 'btn-pass').click();
      }
      played[who] = true;
    };
    const end = Date.now() + 45000;
    const wasTurn = { A: false, B: false };
    while (Date.now() < end && !(played.A && played.B)) {
      for (const [dom, who] of [[domA, 'A'], [domB, 'B']]) {
        const mine = $(dom, 'view-game').classList.contains('my-turn');
        if (mine && !played[who] && !wasTurn[who]) { wasTurn[who] = true; await driveTurn(dom, who); }
        if (!mine && wasTurn[who] && !played[who]) played[who] = true; // acted via modal path
      }
      await sleep(150);
    }
    check('part1: host played a turn', played.A);
    check('part1: joiner played a turn', played.B);
  } finally {
    domA.window.close();
    domB.window.close();
  }
}

async function part2() {
  console.log('--- part 2: raw clients — 12 seats, default cap, team mode, voice');
  // ---------- 12-seat room
  const host = new Client();
  await host.open('/ws');
  host.send({ type: 'create_room', name: 'Host', avatar: 0, mode: 'classic', maxSeats: 12, rules: {} });
  const created = await host.waitFor(s => s.room.status === 'waiting', 6000, '12-seat room created');
  const code = created.room.code;
  check('part2: 12-seat room created with maxSeats 12', created.room.maxSeats === 12, 'maxSeats=' + created.room.maxSeats);

  const joiners = [];
  for (let i = 0; i < 11; i++) {
    const c = new Client();
    await c.open('/ws/' + code);
    c.send({ type: 'join_room', code, name: 'P' + (i + 2), avatar: i % 4 });
    joiners.push(c);
  }
  await host.waitFor(s => s.seats.length === 12, 9000, 'all 12 seated');
  check('part2: 12 players seated', true);

  const extra = new Client();
  await extra.open('/ws/' + code);
  extra.send({ type: 'join_room', code, name: 'Thirteen', avatar: 0 });
  await waitFor(() => extra.errors.some(e => /full/i.test(e)), 5000, '13th refused');
  check('part2: 13th join refused (room full)', true);
  extra.close();

  for (const c of joiners) c.send({ type: 'set_ready', ready: true });
  await host.waitFor(s => s.seats.every(x => x.isYou || x.ready), 6000, 'all ready');
  host.send({ type: 'start_game' });
  const started = await host.waitFor(s => s.room.status === 'playing' && s.game, 6000, '12-seat game started');
  check('part2: 12-seat game started, 7 cards each', started.seats.every(s => s.cardCount === 7),
    'counts=' + started.seats.map(s => s.cardCount).join(','));

  // Rotate turns around the big table.
  let transitions = 0;
  let lastCurrent = null;
  const seenCurrent = new Set();
  const stopAt = Date.now() + 70000;
  const drivers = [host, ...joiners].map(c => autoPlay(c, () => Date.now() > stopAt || transitions >= 40, 70000));
  while (Date.now() < stopAt && transitions < 40) {
    const s = host.latest;
    if (s && s.game) {
      const cur = s.seats.find(x => x.isCurrent);
      if (cur && cur.id !== lastCurrent) {
        if (lastCurrent !== null) transitions++;
        lastCurrent = cur.id;
        seenCurrent.add(cur.id);
      }
      if (s.room.status === 'roundEnd') break;
    }
    await sleep(60);
  }
  await Promise.race([Promise.all(drivers), sleep(3000)]);
  check('part2: turns rotate at 12 seats', transitions >= 25, 'transitions=' + transitions);
  check('part2: play reached most of the table', seenCurrent.size >= 8, 'distinct seats=' + seenCurrent.size);
  const errs = [host, ...joiners].flatMap(c => c.errors);
  check('part2: no errors during 12-seat play', errs.length === 0, errs.join('; '));
  for (const c of [host, ...joiners]) c.close();

  // ---------- default room still caps at 4
  const h2 = new Client();
  await h2.open('/ws');
  h2.send({ type: 'create_room', name: 'Host2', avatar: 0, mode: 'classic', rules: {} });
  const c2 = await h2.waitFor(s => s.room.status === 'waiting', 6000, 'default room created');
  check('part2: default room maxSeats is 4', (c2.room.maxSeats || 4) === 4, 'maxSeats=' + c2.room.maxSeats);
  const js = [];
  for (let i = 0; i < 3; i++) {
    const c = new Client();
    await c.open('/ws/' + c2.room.code);
    c.send({ type: 'join_room', code: c2.room.code, name: 'D' + i, avatar: 1 });
    js.push(c);
  }
  await h2.waitFor(s => s.seats.length === 4, 6000, 'default room filled to 4');
  const fifth = new Client();
  await fifth.open('/ws/' + c2.room.code);
  fifth.send({ type: 'join_room', code: c2.room.code, name: 'Fifth', avatar: 2 });
  await waitFor(() => fifth.errors.some(e => /full/i.test(e)), 5000, '5th refused');
  check('part2: default room refuses the 5th player', true);
  fifth.close();

  // ---------- voice signaling inside this friend room (host + first joiner)
  const vh = h2;
  const vj = js[0];
  vh.send({ type: 'voice_join' });
  await waitFor(() => vh.msgs.some(m => m.type === 'voice_roster'), 5000, 'host voice roster');
  vj.send({ type: 'voice_join' });
  const roster = await waitFor(() => vj.msgs.find(m => m.type === 'voice_roster' && m.peers && m.peers.length >= 1), 5000, 'joiner voice roster with peer');
  await waitFor(() => vh.msgs.some(m => m.type === 'voice_peer_joined'), 5000, 'host sees peer_joined');
  check('part2: voice signaling works in a friend room', !!roster);
  for (const c of [h2, ...js]) c.close();

  // ---------- team mode at 6 seats
  const th = new Client();
  await th.open('/ws');
  th.send({ type: 'create_room', name: 'THost', avatar: 0, mode: '2v2', maxSeats: 6, rules: {} });
  const tc = await th.waitFor(s => s.room.status === 'waiting', 6000, 'team room created');
  const tjs = [];
  for (let i = 0; i < 5; i++) {
    const c = new Client();
    await c.open('/ws/' + tc.room.code);
    c.send({ type: 'join_room', code: tc.room.code, name: 'T' + i, avatar: 2 });
    tjs.push(c);
  }
  await th.waitFor(s => s.seats.length === 6, 6000, 'team room filled to 6');
  for (const c of tjs) c.send({ type: 'set_ready', ready: true });
  await th.waitFor(s => s.seats.every(x => x.isYou || x.ready), 6000, 'team room ready');
  th.send({ type: 'start_game' });
  const tstart = await th.waitFor(s => s.room.status === 'playing' && s.game, 6000, 'team game started');
  const teams = tstart.seats.map(s => s.team).join('');
  check('part2: team mode starts at 6 seats with parity teams', teams === 'ababab', 'teams=' + teams);
  for (const c of [th, ...tjs]) c.close();
}

async function main() {
  await part1();
  await part2();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error('FRIENDS E2E ERROR', e); process.exit(1); });
