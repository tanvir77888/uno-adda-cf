/*
 * UNO Adda — GameRoom Durable Object.
 *
 * One instance per room, addressed by room code (idFromName(code)). This is
 * the Node server.js room layer re-hosted on a Durable Object:
 *
 * - All game rules still live in game.js (imported unchanged).
 * - Sockets use the WebSocket Hibernation API (ctx.acceptWebSocket), so a
 *   room's connections survive the object being evicted from memory.
 * - Room state is plain JSON (the Node version kept it in a Map), so it is
 *   persisted to DO storage after every change and restored on wake —
 *   rooms now survive eviction, which the Node process never could.
 * - Node's setTimeout turn/bot timers and the setInterval UNO-catch sweep
 *   become one Durable Object alarm, always set to the earliest pending
 *   deadline. Alarms are durable: they fire even after eviction.
 *
 * The wire protocol (message types, snapshot shape) is identical to the
 * Node version; the client only changed its socket URL.
 */
import * as G from './game.js';

const BOT_NAMES = ['Bot Rafi', 'Bot Nila', 'Bot Tanu'];

// A chosen character avatar is an int 0..3; anything else (including a
// missing/null field from an older client) means "not chosen" -> null,
// and snapshots fall back to the seat index for that seat.
function validAvatar(a) {
  if (a === null || a === undefined) return null;
  const n = Number(a);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : null;
}

function clampBet(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.min(1000, Math.max(0, n));
}

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;          // the room object (same shape as Node's)
    this.seatSeq = 0;
    this.pendingBotAt = null;  // timestamp: when the current bot should act
    this.nextCatchAt = null;   // timestamp: next bot UNO-catch sweep
    this.sockets = new Map();  // seatId -> WebSocket (live attachments)

    // Restore persisted state before any event is delivered.
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('state');
      if (saved && saved.room) {
        this.room = saved.room;
        this.seatSeq = saved.seatSeq || 0;
        this.pendingBotAt = saved.pendingBotAt || null;
        this.nextCatchAt = saved.nextCatchAt || null;
      }
      for (const ws of ctx.getWebSockets()) {
        const att = ws.deserializeAttachment();
        if (att && att.seatId) this.sockets.set(att.seatId, ws);
      }
      if (this.room) {
        for (const s of this.room.seats) s.connected = this.sockets.has(s.id);
        this.scheduleAlarm();
      }
    });
  }

  // ------------------------------------------------------------ upgrade
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------ persistence
  async save() {
    if (!this.room) return;
    await this.ctx.storage.put('state', {
      room: this.room,
      seatSeq: this.seatSeq,
      pendingBotAt: this.pendingBotAt,
      nextCatchAt: this.nextCatchAt,
    });
  }

  async destroyRoom(notifyMessage) {
    if (this.room && notifyMessage) {
      for (const s of this.room.seats) {
        if (!s.isBot) this.sendError(this.sockets.get(s.id), notifyMessage);
      }
    }
    for (const ws of this.sockets.values()) {
      try { ws.serializeAttachment({}); } catch { /* socket already gone */ }
    }
    this.sockets.clear();
    this.room = null;
    this.pendingBotAt = null;
    this.nextCatchAt = null;
    await this.ctx.storage.delete('state');
    await this.ctx.storage.deleteAlarm();
  }

  // ------------------------------------------------------------ seats & sockets
  newSeatId() { return 's' + (++this.seatSeq); }

  makeSeat(name, isBot, avatar) {
    return {
      id: this.newSeatId(),
      token: randomHex(12),
      name: String(name || 'Player').slice(0, 20),
      isBot: !!isBot,
      avatar: validAvatar(avatar),
      photo: null, // account profile photo (JPEG data URL) when logged in
      ready: false,
      connected: true,
      team: null,
      inVoice: false,
    };
  }

  bindSocket(ws, seat) {
    const old = this.sockets.get(seat.id);
    if (old && old !== ws) { try { old.close(1000, 'replaced'); } catch { /* ignore */ } }
    this.sockets.set(seat.id, ws);
    ws.serializeAttachment({ seatId: seat.id });
    seat.connected = true;
  }

  unbindSocket(ws) {
    const att = ws.deserializeAttachment();
    if (att && att.seatId && this.sockets.get(att.seatId) === ws) this.sockets.delete(att.seatId);
    try { ws.serializeAttachment({}); } catch { /* ignore */ }
  }

  seatOf(ws) {
    if (!this.room) return null;
    const att = ws.deserializeAttachment();
    if (!att || !att.seatId) return null;
    return this.room.seats.find((s) => s.id === att.seatId) || null;
  }

  sendRaw(ws, obj) {
    if (!ws) return;
    try { ws.send(JSON.stringify(obj)); } catch { /* socket is gone */ }
  }

  sendToSeat(seat, obj) {
    if (seat) this.sendRaw(this.sockets.get(seat.id), obj);
  }

  sendError(ws, message) {
    this.sendRaw(ws, { type: 'error', message });
  }

  // ------------------------------------------------------------ accounts
  // Create/join payloads may carry an account `session` token. When one is
  // present it is resolved against the AccountsDO (DO-to-DO fetch); the
  // seat then takes the account's name + photo, so a logged-in player
  // cannot be impersonated by a hand-typed name. No token at all keeps
  // the classic guest behavior (the product gate is client-side).
  async resolveAccount(token) {
    if (typeof token !== 'string' || !token || !this.env.ACCOUNTS) return null;
    try {
      const stub = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('accounts'));
      const res = await stub.fetch('https://accounts.internal/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // -> { account } when a valid session was sent, { guest: true } when no
  // session was sent, { invalid: true } when one was sent but rejected.
  async sessionIdentity(msg) {
    if (!msg.session) return { guest: true };
    const account = await this.resolveAccount(msg.session);
    return account ? { account } : { invalid: true };
  }

  // Stamp a seat with the resolved account identity. The payload avatar
  // (the client's character picker) still wins for this session; the
  // account avatar is the fallback.
  applyIdentity(seat, msg, account) {
    seat.name = String(account.name || seat.name).slice(0, 20);
    seat.photo = account.photo || null;
    if (validAvatar(msg.avatar) === null) {
      const fallback = validAvatar(account.avatar);
      if (fallback !== null) seat.avatar = fallback;
    }
  }

  // ------------------------------------------------------------ room lifecycle
  makeRoom(hostSeat, mode, rules, opts = {}) {
    const room = {
      code: this.ctx.id.name,
      hostSeatId: hostSeat.id,
      mode: mode === '2v2' ? '2v2' : 'classic',
      // Quick Match (v3): a single-round bot match with a coin stake.
      // Classic rooms leave both at their defaults and behave as before.
      quick: !!opts.quick,
      bet: clampBet(opts.bet),
      rules: {
        stacking: !rules || rules.stacking !== false,
        challenge: !rules || rules.challenge !== false,
        allWild: !!(rules && rules.allWild),
        timerSec: 30,
      },
      status: 'waiting', // waiting | playing | roundEnd
      seats: [hostSeat],
      game: null,
      scores: {},
      roundNo: 0,
      chat: [],
      lastEvents: [],
      lastRound: null,
      turnEndsAt: null,
    };
    room.scores[hostSeat.id] = 0;
    this.room = room;
    return room;
  }

  assignTeams(room) {
    room.seats.forEach((s, i) => { s.team = room.mode === '2v2' ? (i % 2 === 0 ? 'a' : 'b') : null; });
  }

  startRound(room) {
    this.assignTeams(room);
    room.game = G.createRound(room.seats.map((s) => s.id), room.rules);
    room.status = 'playing';
    room.roundNo++;
    this.afterChange(room.game.events);
  }

  finishIfEnded(room) {
    const g = room.game;
    if (!g || g.phase !== 'finished' || room.status !== 'playing') return;
    room.status = 'roundEnd';
    const breakdown = {};
    for (const id of g.seats) breakdown[id] = G.handValue(g.hands[id]);
    const winner = room.seats.find((s) => s.id === g.winnerSeatId);
    if (room.mode === '2v2' && winner) {
      const pts = g.seats
        .filter((id) => room.seats.find((s) => s.id === id).team !== winner.team)
        .reduce((sum, id) => sum + breakdown[id], 0);
      for (const s of room.seats) if (s.team === winner.team) room.scores[s.id] += pts;
      room.lastRound = { winnerSeatId: g.winnerSeatId, teamPoints: pts, breakdown };
    } else if (winner) {
      const pts = g.seats.filter((id) => id !== g.winnerSeatId).reduce((sum, id) => sum + breakdown[id], 0);
      room.scores[g.winnerSeatId] += pts;
      room.lastRound = { winnerSeatId: g.winnerSeatId, teamPoints: pts, breakdown };
    }
  }

  // ------------------------------------------------------------ snapshots
  snapshotFor(room, viewer) {
    const g = room.game;
    const snap = {
      type: 'state',
      room: { code: room.code, mode: room.mode, rules: room.rules, status: room.status, hostSeatId: room.hostSeatId, roundNo: room.roundNo, quick: !!room.quick, bet: room.bet || 0 },
      you: { seatId: viewer.id, token: viewer.token },
      seats: room.seats.map((s, i) => ({
        id: s.id, name: s.name, isBot: s.isBot, ready: s.ready, connected: s.connected, inVoice: !!s.inVoice,
        avatar: s.avatar != null ? s.avatar : i % 4,
        photo: s.photo || null,
        team: s.team, score: room.scores[s.id] || 0,
        cardCount: g ? g.hands[s.id].length : 0,
        isCurrent: g ? G.currentSeatId(g) === s.id : false,
        isYou: s.id === viewer.id,
      })),
      chat: room.chat.slice(-30),
      events: room.lastEvents,
      game: null,
      lastRound: room.status === 'roundEnd' ? room.lastRound : null,
      matchWinnerSeatId: this.matchWinner(room),
    };
    if (g) {
      snap.game = {
        phase: g.phase,
        yourHand: g.hands[viewer.id].slice(),
        topCard: G.topCard(g),
        currentColor: g.currentColor,
        direction: g.direction,
        drawPileCount: g.deck.length,
        pendingDraw: g.pendingDraw,
        pendingKind: g.pendingKind,
        canChallenge: g.pendingKind === 'wild4' && G.currentSeatId(g) === viewer.id && room.rules.challenge,
        youMustPickColor: g.phase === 'firstColor' && g.seats[0] === viewer.id,
        drewCardId: G.currentSeatId(g) === viewer.id ? g.drewCardId : null,
        unoSuspect: g.unoSuspect,
        legalCardIds: G.legalPlays(g, viewer.id).map((c) => c.id),
        turnEndsAt: room.turnEndsAt || null,
        isYourTurn: G.currentSeatId(g) === viewer.id && g.phase === 'playing',
      };
    }
    return snap;
  }

  matchWinner(room) {
    const hit = room.seats.find((s) => (room.scores[s.id] || 0) >= 500);
    return hit ? hit.id : null;
  }

  broadcast(room) {
    for (const s of room.seats) {
      if (!s.isBot) this.sendToSeat(s, this.snapshotFor(room, s));
    }
  }

  // ------------------------------------------------------------ voice chat
  // WebRTC mesh: the server never touches audio. It only tracks who is in
  // voice and relays SDP/ICE signaling between seats of the SAME room —
  // and since one object IS one room, cross-room delivery is impossible.
  voiceMembers(room, except) {
    return room.seats.filter((s) => s.inVoice && !s.isBot && s !== except);
  }

  leaveVoice(room, seat) {
    if (!seat.inVoice) return;
    seat.inVoice = false;
    for (const s of room.seats) {
      if (s.id !== seat.id) this.sendToSeat(s, { type: 'voice_peer_left', seatId: seat.id });
    }
  }

  // ------------------------------------------------------------ turn flow & timers
  afterChange(events) {
    const room = this.room;
    if (!room) return;
    room.lastEvents = events || [];
    this.finishIfEnded(room);
    this.broadcast(room);
    this.schedule();
  }

  // Mirrors the Node schedule(): every state change restarts the current
  // player's 30s clock and (re)arms the bot move. Deadlines are timestamps;
  // the single DO alarm is set to whichever comes first.
  schedule() {
    const room = this.room;
    this.pendingBotAt = null;
    if (!room) { this.scheduleAlarm(); return; }
    const g = room.game;
    if (room.status !== 'playing' || !g || g.phase === 'finished') {
      this.nextCatchAt = null;
      this.scheduleAlarm();
      return;
    }
    room.turnEndsAt = Date.now() + room.rules.timerSec * 1000;
    const currentId = g.phase === 'firstColor' ? g.seats[0] : G.currentSeatId(g);
    const current = room.seats.find((s) => s.id === currentId);
    if (current && current.isBot) {
      this.pendingBotAt = Date.now() + 350 + Math.random() * 350;
    }
    if (g.unoSuspect) {
      if (!this.nextCatchAt) this.nextCatchAt = Date.now() + 1500;
    } else {
      this.nextCatchAt = null;
    }
    this.scheduleAlarm();
  }

  scheduleAlarm() {
    const times = [];
    const room = this.room;
    if (room && room.status === 'playing' && room.turnEndsAt) times.push(room.turnEndsAt);
    if (this.pendingBotAt) times.push(this.pendingBotAt);
    if (this.nextCatchAt) times.push(this.nextCatchAt);
    if (times.length) {
      this.ctx.storage.setAlarm(Math.min(...times));
    } else {
      this.ctx.storage.deleteAlarm();
    }
  }

  async alarm() {
    const room = this.room;
    if (!room) return;
    const now = Date.now();
    const g = room.game;

    // Bot UNO-catch sweep (was a 1.5s setInterval in the Node server).
    if (this.nextCatchAt && now >= this.nextCatchAt) {
      this.nextCatchAt = null;
      if (g && room.status === 'playing' && g.unoSuspect) {
        const suspect = room.seats.find((s) => s.id === g.unoSuspect);
        const bot = room.seats.find((s) => s.isBot && s.id !== g.unoSuspect);
        if (suspect && !suspect.isBot && bot && Math.random() < 0.25) {
          const res = G.applyCatchUno(g, bot.id, g.unoSuspect);
          if (res.ok) this.afterChange(res.events);
        }
        if (g.unoSuspect) this.nextCatchAt = now + 1500;
      }
    }

    // Bot move due?
    if (this.room && this.pendingBotAt && now >= this.pendingBotAt) {
      this.pendingBotAt = null;
      this.botAct();
    }

    // Turn timer due? (Re-read state: botAct may have changed everything.)
    const room2 = this.room;
    if (room2 && room2.status === 'playing' && room2.game && room2.game.phase !== 'finished'
        && room2.turnEndsAt && Date.now() >= room2.turnEndsAt) {
      const gg = room2.game;
      const seatId = gg.phase === 'firstColor' ? gg.seats[0] : G.currentSeatId(gg);
      const res = G.applyTimeout(gg, seatId);
      this.afterChange(res.events || []);
    }

    this.scheduleAlarm();
    await this.save();
  }

  // ------------------------------------------------------------ bots
  botAct() {
    const room = this.room;
    if (!room) return;
    const g = room.game;
    if (!g || room.status !== 'playing' || g.phase === 'finished') return;
    const seatId = g.phase === 'firstColor' ? g.seats[0] : G.currentSeatId(g);
    const seat = room.seats.find((s) => s.id === seatId);
    if (!seat || !seat.isBot) return;
    let res;
    if (g.phase === 'firstColor') {
      res = G.applyFirstColor(g, seatId, G.mostCommonColor(g.hands[seatId]));
      return this.afterChange(res.events || []);
    }
    // UNO catch: if a human forgot, bots notice half the time.
    if (g.pendingDraw > 0 && g.pendingKind === 'wild4' && Math.random() < 0.3) {
      res = G.applyChallenge(g, seatId);
      if (res.ok) return this.afterChange(res.events);
    }
    const legal = G.legalPlays(g, seatId);
    if (legal.length === 0) {
      res = G.applyDraw(g, seatId);
      return this.afterChange(res.events || []);
    }
    const hand = g.hands[seatId];
    const pick = legal.reduce((best, c) => (botCardScore(c, hand) > botCardScore(best, hand) ? c : best), legal[0]);
    const callUno = hand.length === 2 && Math.random() < 0.92;
    const chosenColor = pick.color === 'wild' ? G.mostCommonColor(hand) : undefined;
    res = G.applyPlay(g, seatId, pick.id, { chosenColor, callUno });
    if (!res.ok) { // fall back to drawing rather than stalling the game
      res = G.applyDraw(g, seatId);
    }
    this.afterChange(res.events || []);
  }

  // ------------------------------------------------------------ ws events
  async webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return this.sendError(ws, 'Bad message');
    }
    try {
      await this.handle(ws, msg);
    } catch (e) {
      this.sendError(ws, 'Server error: ' + e.message);
    }
    await this.save();
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (!att || !att.seatId) return;
    // A stale socket (seat already rebound to a newer one) changes nothing.
    if (this.sockets.get(att.seatId) !== ws) return;
    this.sockets.delete(att.seatId);
    const room = this.room;
    if (!room) return;
    const seat = room.seats.find((s) => s.id === att.seatId);
    if (!seat) return;
    this.leaveVoice(room, seat);
    seat.connected = false;
    if (room.status === 'waiting' && seat.id === room.hostSeatId) {
      await this.destroyRoom('The host left — room closed');
      return;
    }
    if (!room.seats.some((s) => !s.isBot && s.connected)) {
      await this.destroyRoom(null);
      return;
    }
    this.broadcast(room);
    this.schedule();
    await this.save();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  // ------------------------------------------------------------ message handling
  async handle(ws, msg) {
    switch (msg.type) {
      case 'create_bot_game': {
        if (this.room) return this.sendError(ws, 'Leave this room first');
        const ident = await this.sessionIdentity(msg);
        if (ident.invalid) return this.sendError(ws, 'Session expired — please log in again');
        const seat = this.makeSeat(msg.name, false, msg.avatar);
        if (ident.account) this.applyIdentity(seat, msg, ident.account);
        seat.ready = true;
        const room = this.makeRoom(seat, 'classic', msg.rules || {}, { quick: !!msg.quick, bet: msg.bet });
        this.bindSocket(ws, seat);
        const bots = Math.min(3, Math.max(1, msg.botCount || 1));
        // Bots get distinct random avatars per match, preferring characters
        // the human did not pick.
        const pool = [0, 1, 2, 3].filter((a) => a !== seat.avatar);
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        for (let i = 0; i < bots; i++) {
          const bot = this.makeSeat(BOT_NAMES[i % BOT_NAMES.length], true, pool[i % pool.length]);
          bot.ready = true;
          room.seats.push(bot);
          room.scores[bot.id] = 0;
        }
        return this.startRound(room);
      }
      case 'create_room': {
        if (this.room) return this.sendError(ws, 'Leave this room first');
        const ident = await this.sessionIdentity(msg);
        if (ident.invalid) return this.sendError(ws, 'Session expired — please log in again');
        const seat = this.makeSeat(msg.name, false, msg.avatar);
        if (ident.account) this.applyIdentity(seat, msg, ident.account);
        const room = this.makeRoom(seat, msg.mode, msg.rules || {});
        this.bindSocket(ws, seat);
        return this.afterChange([]);
      }
      case 'join_room': {
        const room = this.room;
        const code = String(msg.code || '').toUpperCase().trim();
        if (!room || room.code !== code) return this.sendError(ws, 'Room not found — check the code');
        const ident = await this.sessionIdentity(msg);
        if (ident.invalid) return this.sendError(ws, 'Session expired — please log in again');
        if (msg.token) {
          const existing = room.seats.find((s) => s.token === msg.token);
          if (existing && !existing.isBot) {
            this.bindSocket(ws, existing);
            if (msg.name) existing.name = String(msg.name).slice(0, 20);
            const av = validAvatar(msg.avatar);
            if (av !== null) existing.avatar = av;
            if (ident.account) this.applyIdentity(existing, msg, ident.account);
            return this.afterChange([]);
          }
        }
        if (room.status !== 'waiting') return this.sendError(ws, 'That game has already started');
        if (room.seats.length >= 4) return this.sendError(ws, 'That room is full');
        const seat = this.makeSeat(msg.name, false, msg.avatar);
        if (ident.account) this.applyIdentity(seat, msg, ident.account);
        room.seats.push(seat);
        room.scores[seat.id] = 0;
        this.bindSocket(ws, seat);
        return this.afterChange([]);
      }
    }

    const room = this.room;
    const seat = this.seatOf(ws);
    if (!room || !seat) return this.sendError(ws, 'Join a room first');

    switch (msg.type) {
      case 'set_ready':
        seat.ready = !!msg.ready;
        return this.afterChange([]);
      case 'start_game': {
        if (seat.id !== room.hostSeatId) return this.sendError(ws, 'Only the host can start');
        // Quick Match is a single round: once it ends, the match is over.
        if (room.quick && room.status === 'roundEnd') return this.sendError(ws, 'Quick match is over — start a new one from the lobby');
        if (room.status === 'playing') return this.sendError(ws, 'The game is already running');
        if (room.seats.length < 2) return this.sendError(ws, 'You need at least 2 players');
        if (room.mode === '2v2' && room.seats.length !== 4) return this.sendError(ws, '2v2 needs exactly 4 players');
        if (room.seats.some((s) => !s.isBot && s.id !== room.hostSeatId && !s.ready))
          return this.sendError(ws, 'Everyone must be ready first');
        return this.startRound(room);
      }
      case 'play_card': {
        const res = G.applyPlay(room.game, seat.id, msg.cardId, { chosenColor: msg.chosenColor, callUno: !!msg.callUno });
        if (!res.ok) return this.sendError(ws, res.error);
        return this.afterChange(res.events);
      }
      case 'draw_card': {
        const res = G.applyDraw(room.game, seat.id);
        if (!res.ok) return this.sendError(ws, res.error);
        return this.afterChange(res.events);
      }
      case 'pass': {
        const res = G.applyPass(room.game, seat.id);
        if (!res.ok) return this.sendError(ws, res.error);
        return this.afterChange(res.events);
      }
      case 'challenge': {
        const res = G.applyChallenge(room.game, seat.id);
        if (!res.ok) return this.sendError(ws, res.error);
        return this.afterChange(res.events);
      }
      case 'pick_color': {
        const res = G.applyFirstColor(room.game, seat.id, msg.color);
        if (!res.ok) return this.sendError(ws, res.error);
        return this.afterChange(res.events);
      }
      case 'call_uno': {
        const res = G.applyCallUno(room.game, seat.id);
        if (!res.ok) return this.sendError(ws, res.error);
        return this.afterChange(res.events);
      }
      case 'catch_uno': {
        const res = G.applyCatchUno(room.game, seat.id, msg.targetSeatId);
        if (!res.ok) return this.sendError(ws, res.error);
        return this.afterChange(res.events);
      }
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return;
        room.chat.push({ name: seat.name, text, at: Date.now() });
        if (room.chat.length > 50) room.chat.shift();
        return this.broadcast(room);
      }
      case 'voice_join': {
        if (seat.isBot) return;
        const wasInVoice = seat.inVoice;
        seat.inVoice = true;
        // The joiner initiates offers to everyone already in voice.
        this.sendToSeat(seat, { type: 'voice_roster', peers: this.voiceMembers(room, seat).map((s) => s.id) });
        if (!wasInVoice) {
          for (const s of this.voiceMembers(room, seat)) this.sendToSeat(s, { type: 'voice_peer_joined', seatId: seat.id });
        }
        return this.broadcast(room);
      }
      case 'voice_leave':
        this.leaveVoice(room, seat);
        return this.broadcast(room);
      case 'voice_signal': {
        // Relay only to a seat in the same room — never outside it. One
        // object hosts exactly one room, so a foreign seat id simply
        // matches nobody here.
        const target = room.seats.find((s) => s.id === msg.toSeatId);
        if (target && target.id !== seat.id && !target.isBot) {
          this.sendToSeat(target, { type: 'voice_signal', fromSeatId: seat.id, data: msg.data });
        }
        return;
      }
      case 'leave': {
        this.leaveVoice(room, seat);
        seat.connected = false;
        this.unbindSocket(ws);
        if (room.status === 'waiting') {
          room.seats = room.seats.filter((s) => s.id !== seat.id);
          delete room.scores[seat.id];
          if (seat.id === room.hostSeatId || room.seats.length === 0) {
            await this.destroyRoom('The room was closed');
            return;
          }
        }
        return this.broadcast(room);
      }
      default:
        return this.sendError(ws, 'Unknown message: ' + msg.type);
    }
  }
}

function botCardScore(card, hand) {
  let v = card.kind === 'number' ? card.value : card.kind === 'wild' || card.kind === 'wild4' ? 50 : 20;
  if (card.kind === 'wild') v -= 35;  // keep plain wilds in reserve
  if (card.kind === 'wild4') v -= 25;
  if (hand.length <= 2) v += 60;      // late game: dump high cards
  return v;
}
