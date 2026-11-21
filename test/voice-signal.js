'use strict';
/*
 * Voice signaling test for UNO Adda (Cloudflare port). Expects the Worker
 * to already be running under `wrangler dev` (see test/run-local.sh) at
 * BASE_URL (default http://127.0.0.1:8787). Verifies the WebRTC signaling
 * relay (no real audio / RTCPeerConnection — fake SDP payloads):
 *  1. second voice joiner receives a roster naming the first member
 *  2. first member is told a peer joined
 *  3. offer relay guest -> host stays inside the room, payload intact
 *  4. answer relay host -> guest works too
 *  5. a signal addressed to a seat in ANOTHER room is not delivered
 *     (each room is a separate Durable Object, so it cannot be)
 *  6. leaving voice notifies the remaining member
 * Exits non-zero on the first failed check.
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
  constructor(name) {
    this.name = name;
    this.latest = null;
    this.voiceMsgs = [];
    this.errors = [];
    this.ws = null;
  }
  open(path = '/ws') {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(WS_BASE + path);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'state') this.latest = msg;
        else if (msg.type === 'error') this.errors.push(msg.message);
        else this.voiceMsgs.push(msg);
      });
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  async waitState(pred, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.latest && pred(this.latest)) return this.latest;
      await sleep(50);
    }
    throw new Error('timeout waiting for state: ' + label);
  }
  async waitVoice(pred, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = this.voiceMsgs.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    throw new Error('timeout waiting for voice msg: ' + label);
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function main() {
  try {
    const host = new Client('Host');
    const guest = new Client('Guest');
    const outsider = new Client('Outsider');
    await host.open('/ws');

    // Room A: host + guest. Room B: outsider alone (its own Durable Object).
    host.send({ type: 'create_room', name: 'Host', mode: 'classic', rules: {} });
    const lobby = await host.waitState(s => s.room.status === 'waiting', 4000, 'host lobby');
    const code = lobby.room.code;
    const hostSeat = lobby.you.seatId;
    await guest.open('/ws/' + code);
    guest.send({ type: 'join_room', code, name: 'Guest' });
    const gLobby = await guest.waitState(s => s.room.status === 'waiting' && s.seats.length === 2, 4000, 'guest lobby');
    const guestSeat = gLobby.you.seatId;
    await outsider.open('/ws');
    outsider.send({ type: 'create_room', name: 'Outsider', mode: 'classic', rules: {} });
    const oLobby = await outsider.waitState(s => s.room.status === 'waiting', 4000, 'outsider lobby');
    const outsiderSeat = oLobby.you.seatId;

    // 1+2. Host joins voice first (empty roster), guest joins second.
    host.send({ type: 'voice_join' });
    const hostRoster = await host.waitVoice(m => m.type === 'voice_roster', 3000, 'host roster');
    check('first voice member gets an empty roster', Array.isArray(hostRoster.peers) && hostRoster.peers.length === 0);
    guest.send({ type: 'voice_join' });
    const guestRoster = await guest.waitVoice(m => m.type === 'voice_roster', 3000, 'guest roster');
    check('second joiner roster names the first member', guestRoster.peers.includes(hostSeat), 'peers=' + guestRoster.peers.join(','));
    const joinedNote = await host.waitVoice(m => m.type === 'voice_peer_joined', 3000, 'peer joined note');
    check('first member is told the peer joined', joinedNote.seatId === guestSeat);

    // 3. Offer guest -> host.
    const fakeOffer = { kind: 'offer', sdp: { type: 'offer', sdp: 'FAKE-SDP-OFFER-123' } };
    guest.send({ type: 'voice_signal', toSeatId: hostSeat, data: fakeOffer });
    const gotOffer = await host.waitVoice(m => m.type === 'voice_signal', 3000, 'offer relay');
    check('offer relayed within the room, payload intact',
      gotOffer.fromSeatId === guestSeat && gotOffer.data.kind === 'offer' && gotOffer.data.sdp.sdp === 'FAKE-SDP-OFFER-123');

    // 4. Answer host -> guest.
    host.send({ type: 'voice_signal', toSeatId: guestSeat, data: { kind: 'answer', sdp: { type: 'answer', sdp: 'FAKE-SDP-ANSWER-456' } } });
    const gotAnswer = await guest.waitVoice(m => m.type === 'voice_signal' && m.data && m.data.kind === 'answer', 3000, 'answer relay');
    check('answer relayed back to the guest', gotAnswer.fromSeatId === hostSeat && gotAnswer.data.sdp.sdp === 'FAKE-SDP-ANSWER-456');

    // 5. Cross-room signal must NOT be delivered (guest addresses outsider's seat).
    guest.send({ type: 'voice_signal', toSeatId: outsiderSeat, data: { kind: 'offer', sdp: { type: 'offer', sdp: 'CROSS-ROOM' } } });
    await sleep(500);
    check('signal to a seat in another room is not delivered',
      !outsider.voiceMsgs.some(m => m.type === 'voice_signal'));

    // 6. Guest leaves voice -> host is notified.
    guest.send({ type: 'voice_leave' });
    const leftNote = await host.waitVoice(m => m.type === 'voice_peer_left', 3000, 'peer left note');
    check('leaving voice notifies the remaining member', leftNote.seatId === guestSeat);

    host.close(); guest.close(); outsider.close();
  } catch (e) {
    check('test run completed', false, e.message);
  }
  console.log(failures === 0 ? '\nALL VOICE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
