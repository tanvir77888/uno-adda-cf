'use strict';
/*
 * Cross-stacking matrix (Addition 6, corrected): the pending draw is
 * judged by the MOST RECENT draw card played.
 *   pending +2-led -> a +2 or a +4 may stack.
 *   pending +4-led -> ONLY a +4 may stack; a +2 is refused.
 * Totals accumulate; taking the pending draws it all; a challenge
 * against a stacked +4 resolves against the +4 player with the
 * accumulated total (success: accused draws the total; failure:
 * challenger draws total + 2).
 * Engine-level, deterministic synthetic states: node test/cross-stack.js
 */
import * as G from '../src/game.js';

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}

const C = (id, color, kind, value) => ({ id, color, kind, value: value || 0 });

function mkState({ hands, top, currentColor, pendingDraw = 0, pendingKind = null, turnIdx = 0, lastWild4 = null }) {
  return {
    seats: ['p0', 'p1'],
    rules: { stacking: true, challenge: true, allWild: false },
    deck: G.buildDeck().slice(0, 60),
    discard: [top],
    hands,
    currentColor,
    direction: 1,
    turnIdx,
    pendingDraw,
    pendingKind,
    lastWild4,
    drewCardId: null,
    unoSuspect: null,
    phase: 'playing',
    winnerSeatId: null,
    events: [],
  };
}

function main() {
  // ---- pending +2, hand with ONLY a +4 -> playable, total 6, now +4-led
  {
    const s = mkState({
      hands: {
        p0: [C('a1', 'blue', 'number', 3), C('a2', 'green', 'number', 4), C('a3', 'yellow', 'number', 1)],
        p1: [C('w1', 'wild', 'wild4'), C('b1', 'blue', 'number', 2), C('b2', 'green', 'number', 7)],
      },
      top: C('t1', 'red', 'draw2'), currentColor: 'red',
      pendingDraw: 2, pendingKind: 'draw2', turnIdx: 1,
    });
    const legal = G.legalPlays(s, 'p1');
    check('stack: +4 is playable on a +2-led pending', legal.some(c => c.id === 'w1'));
    const r = G.applyPlay(s, 'p1', 'w1', { chosenColor: 'blue', callUno: false });
    check('stack: playing the +4 succeeds', r.ok, r.error || '');
    check('stack: pending total accumulates to 6', s.pendingDraw === 6, 'pendingDraw=' + s.pendingDraw);
    check('stack: pending is now +4-led', s.pendingKind === 'wild4');
    // The next player (p0) now faces a +4-led pending: a +2 must NOT stack.
    s.hands.p0.push(C('d1', 'blue', 'draw2'));
    const legal0 = G.legalPlays(s, 'p0');
    check('stack: after the stacked +4, a +2 no longer stacks', !legal0.some(c => c.id === 'd1'));
    const r2 = G.applyPlay(s, 'p0', 'd1', {});
    check('stack: server refuses +2 on a +4-led pending', !r2.ok);
  }

  // ---- pending +4, hand with ONLY a +2 -> NOT playable
  {
    const s = mkState({
      hands: {
        p0: [C('a1', 'blue', 'number', 3), C('a2', 'green', 'number', 4)],
        p1: [C('d1', 'red', 'draw2'), C('b1', 'blue', 'number', 2), C('b2', 'green', 'number', 7)],
      },
      top: C('t1', 'wild', 'wild4'), currentColor: 'blue',
      pendingDraw: 4, pendingKind: 'wild4', turnIdx: 1,
      lastWild4: { seatId: 'p0', bluff: false },
    });
    const legal = G.legalPlays(s, 'p1');
    check('stack: +2 is NOT playable on a +4-led pending', legal.length === 0);
    const r = G.applyPlay(s, 'p1', 'd1', {});
    check('stack: server refuses the +2 on +4', !r.ok && /stack a \+4/.test(r.error || ''), r.error || '');
    // Taking the pending draws all 4 and clears it.
    const before = s.hands.p1.length;
    const rd = G.applyDraw(s, 'p1');
    check('stack: taking a +4 pending draws 4', rd.ok && s.hands.p1.length === before + 4 && s.pendingDraw === 0);
  }

  // ---- pending +2, no draw card -> must take the 2
  {
    const s = mkState({
      hands: {
        p0: [C('a1', 'blue', 'number', 3), C('a2', 'green', 'number', 4)],
        p1: [C('b1', 'red', 'number', 5), C('b2', 'green', 'number', 7), C('b3', 'blue', 'number', 1)],
      },
      top: C('t1', 'red', 'draw2'), currentColor: 'red',
      pendingDraw: 2, pendingKind: 'draw2', turnIdx: 1,
    });
    check('stack: no counter card -> no legal plays', G.legalPlays(s, 'p1').length === 0);
    const before = s.hands.p1.length;
    const rd = G.applyDraw(s, 'p1');
    check('stack: taking a +2 pending draws exactly 2', rd.ok && s.hands.p1.length === before + 2 && s.pendingDraw === 0);
  }

  // ---- +2 then +2 still allows either counter (judged by latest card)
  {
    const s = mkState({
      hands: {
        p0: [C('d1', 'green', 'draw2'), C('a2', 'green', 'number', 4), C('a3', 'red', 'number', 2)],
        p1: [C('b1', 'blue', 'number', 2), C('b2', 'green', 'number', 7)],
      },
      top: C('t1', 'red', 'draw2'), currentColor: 'red',
      pendingDraw: 2, pendingKind: 'draw2', turnIdx: 0,
    });
    const r = G.applyPlay(s, 'p0', 'd1', {});
    check('stack: +2 stacks on +2', r.ok && s.pendingDraw === 4 && s.pendingKind === 'draw2');
    s.hands.p1.push(C('w9', 'wild', 'wild4'));
    check('stack: +2-led pending still accepts a +4', G.legalPlays(s, 'p1').some(c => c.id === 'w9'));
  }

  // ---- challenge after a stacked +4: bluff -> accused draws the total (6)
  {
    const s = mkState({
      hands: {
        p0: [C('a1', 'blue', 'number', 3), C('a2', 'green', 'number', 4), C('a3', 'yellow', 'number', 1)],
        // p1 holds a red card (the color in effect) -> playing +4 is a bluff
        p1: [C('w1', 'wild', 'wild4'), C('r1', 'red', 'number', 9), C('b2', 'green', 'number', 7)],
      },
      top: C('t1', 'red', 'draw2'), currentColor: 'red',
      pendingDraw: 2, pendingKind: 'draw2', turnIdx: 1,
    });
    const r = G.applyPlay(s, 'p1', 'w1', { chosenColor: 'blue', callUno: false });
    check('challenge: stacked +4 played', r.ok && s.pendingDraw === 6 && s.pendingKind === 'wild4');
    check('challenge: bluff detected (held the color)', s.lastWild4 && s.lastWild4.bluff === true);
    const p1Before = s.hands.p1.length;
    const rc = G.applyChallenge(s, 'p0');
    check('challenge: succeeds against the bluffing stacker', rc.ok && rc.events.some(e => e.type === 'challenge_won'));
    check('challenge: accused draws the accumulated total (6)', s.hands.p1.length === p1Before + 6,
      'drew=' + (s.hands.p1.length - p1Before));
    check('challenge: pending cleared', s.pendingDraw === 0 && s.pendingKind === null);
  }

  // ---- challenge after a stacked +4: honest -> challenger draws total + 2 (8)
  {
    const s = mkState({
      hands: {
        p0: [C('a1', 'blue', 'number', 3), C('a2', 'green', 'number', 4), C('a3', 'yellow', 'number', 1)],
        p1: [C('w1', 'wild', 'wild4'), C('b1', 'blue', 'number', 9), C('b2', 'green', 'number', 7)],
      },
      top: C('t1', 'red', 'draw2'), currentColor: 'red',
      pendingDraw: 2, pendingKind: 'draw2', turnIdx: 1,
    });
    G.applyPlay(s, 'p1', 'w1', { chosenColor: 'blue', callUno: false });
    check('challenge: honest +4 is not a bluff', s.lastWild4 && s.lastWild4.bluff === false);
    const p0Before = s.hands.p0.length;
    const rc = G.applyChallenge(s, 'p0');
    check('challenge: fails against an honest stacker', rc.ok && rc.events.some(e => e.type === 'challenge_lost'));
    check('challenge: challenger draws total + 2 (8)', s.hands.p0.length === p0Before + 8,
      'drew=' + (s.hands.p0.length - p0Before));
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
