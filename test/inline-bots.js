'use strict';
/*
 * Inline-bot regression (Addition 1): runs against a SECOND wrangler
 * instance started with UNO_BOT_THINK_MS=60000, so the alarm fallback
 * cannot possibly fire within the test window (the production bug was
 * bots taking 19–39s per move through the alarm/wake path). Any bot
 * progress observed here is therefore purely the inline chain: after
 * the human acts, at least 2 bot actions complete and the turn comes
 * back to the human — all inside one invocation chain.
 * BASE_URL points at the phase-2 instance (see run-local.sh).
 */
import WebSocket from 'ws';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8789';
const WS_BASE = BASE.replace(/^http/, 'ws');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Client {
  constructor() { this.states = []; this.latest = null; }
  open(path = '/ws') {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(WS_BASE + path);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'state') { this.states.push(msg); this.latest = msg; }
      });
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

function botActionsIn(states, mySeatId) {
  let n = 0;
  for (const s of states) {
    for (const e of s.events || []) {
      if (e.seatId && e.seatId !== mySeatId && ['played', 'drew', 'took_pending', 'passed'].includes(e.type)) n++;
    }
  }
  return n;
}

async function main() {
  const c = new Client(); await c.open('/ws');
  c.send({ type: 'create_bot_game', name: 'InlineTester', avatar: 0, botCount: 3, rules: { stacking: true, challenge: true, allWild: false } });

  // Wait until the game is playing and it is the human's turn (if a
  // bot opened, the inline chain at create must already have run).
  const t0 = Date.now();
  let mine = null;
  while (Date.now() - t0 < 6000) {
    if (c.latest && c.latest.room.status === 'roundEnd') break;
    if (c.latest && c.latest.game && c.latest.game.isYourTurn) { mine = c.latest; break; }
    await sleep(60);
  }
  check('inline: game reaches the human turn (or round end) with 60s think time', !!mine || (c.latest && c.latest.room.status === 'roundEnd'),
    'status=' + (c.latest && c.latest.room.status));
  if (!mine) { // round already ended — the chain ran the whole table
    check('inline: bot actions happened purely inline at open', botActionsIn(c.states, c.latest.you.seatId) >= 2,
      'botActions=' + botActionsIn(c.states, c.latest.you.seatId));
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  }
  const mySeatId = mine.you.seatId;
  const openingBotActions = botActionsIn(c.states, mySeatId);

  // The human acts once — and the turn must genuinely LEAVE the human
  // (a drawn playable card keeps the turn, so pass in that case).
  const before = c.states.length;
  const legal = mine.game.legalCardIds || [];
  if (legal.length) {
    const card = mine.game.yourHand.find(x => x.id === legal[0]);
    c.send({ type: 'play_card', cardId: card.id, chosenColor: 'red', callUno: true });
  } else {
    c.send({ type: 'draw_card' });
  }
  // If a drawn playable card kept the turn, pass it on. (The bot
  // chain can complete inside a single poll gap, so "the turn left
  // me" is judged from the recorded states below, not live polling.)
  const tPass = Date.now();
  while (Date.now() - tPass < 3000) {
    const L = c.latest;
    if (L && L.room.status === 'roundEnd') break;
    if (L && L.game && L.game.drewCardId) { c.send({ type: 'pass' }); break; }
    if (L && L.game && !L.game.isYourTurn) break;
    await sleep(50);
  }

  // Within 4 seconds — far below the 60s think time — the bots must
  // act inline and the turn must come back (or the round must end).
  const t1 = Date.now();
  let returned = false;
  while (Date.now() - t1 < 4000) {
    if (c.latest && (c.latest.room.status === 'roundEnd' || (c.latest.game && c.latest.game.isYourTurn))) { returned = true; break; }
    await sleep(50);
  }
  const afterStates = c.states.slice(before);
  const botActs = botActionsIn(afterStates, mySeatId);
  const leftMe = afterStates.some(s => s.room.status === 'roundEnd' ||
    (s.seats || []).some(x => x.isCurrent && !x.isYou));
  check('inline: the human action genuinely passed the turn to the bots', leftMe);
  check('inline: at least 2 bot actions complete after the human plays', botActs >= 2, 'botActions=' + botActs);
  check('inline: turn returns to the human purely inline', returned);
  check('inline: it all happened fast (< 4s, think time is 60s)', Date.now() - t1 < 4000);
  console.log('  (opening bot actions before the human moved: ' + openingBotActions + ')');
  c.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
