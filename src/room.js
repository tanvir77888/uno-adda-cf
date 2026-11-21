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
    this.botChain = false;     // re-entrancy guard for the inline bot chain
    // Snapshot photo diet: per live socket, the set of seat ids whose
    // photo has already been sent during 'playing'. WeakMap so a dead
    // socket's entry vanishes with it; a reconnect (new socket) gets
    // the photos once more. In-memory only — an eviction simply means
    // one full-photo state per socket again, which is always correct.
    this.photoSentWs = new WeakMap();
    this.settingsCache = null; // { at, maintenance } — admin maintenance flag, 30s TTL

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
        // Register the PERSISTED deadlines exactly as saved. Do NOT
        // re-derive them here (e.g. via schedule()): when an alarm comes
        // due on an evicted object, the runtime instantiates the object
        // to deliver it, and a constructor registration for a LATER time
        // cancels that very delivery ("alarm handler canceled with
        // requestScheduledAlarm") and defers the game by a full turn
        // clock — or, if the registration is awaited inside
        // blockConcurrencyWhile, wedges the object for good. A persisted
        // deadline in the past simply delivers immediately.
        this.scheduleAlarm();
      }
    });
  }

  // ------------------------------------------------------------ upgrade
  async fetch(request) {
    // Internal DO-to-DO endpoint used by the MatchmakerDO: pre-create a
    // room with both seats reserved for matched live players. Each seat
    // carries a one-time join ticket; the seats can only be claimed by
    // presenting that ticket (see join_room). Not a websocket upgrade.
    const url = new URL(request.url);
    if (url.pathname === '/reserve' && request.method === 'POST') {
      return this.handleReserve(request);
    }
    // Admin control center: the AccountsDO (after verifying the caller
    // is an admin) can force-close this room. Everyone connected gets a
    // room_closed notice, then the room tears down like a host leave.
    if (url.pathname === '/admin-close' && request.method === 'POST') {
      if (this.room) {
        for (const s of this.room.seats) {
          if (!s.isBot) this.sendToSeat(s, { type: 'room_closed', message: 'রুমটি অ্যাডমিন বন্ধ করে দিয়েছেন' });
        }
        await this.destroyRoom(null);
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }
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

  // The room's lifeline, run at the end of every async entry point:
  // persist state best-effort, then re-register the alarm from the
  // current deadlines. Neither step may throw: a throwing alarm()
  // handler gets its alarm discarded by the runtime once retries run
  // out, and a throwing message handler can roll back the storage
  // writes (including the alarm registration) made earlier in the same
  // invocation — either way the room freezes with everyone still
  // connected. Because EVERY entry point ends here, a registration lost
  // to a failed save heals on the very next event.
  async persistAndArm() {
    try {
      await this.save();
    } catch (e) {
      console.log('UNO Adda: state save failed:', e && e.message);
    }
    try {
      await this.armAlarm();
    } catch (e) {
      console.log('UNO Adda: alarm registration failed:', e && e.message);
    }
  }

  async destroyRoom(notifyMessage) {
    this.reportRoom('closed');
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
      wins: null,  // account lifetime wins (badge tier); null for guests/bots
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
  // session was sent, { invalid: true } when one was sent but rejected,
  // { banned: true } when the account is banned by the admin.
  async sessionIdentity(msg) {
    if (!msg.session) return { guest: true };
    const account = await this.resolveAccount(msg.session);
    if (!account) return { invalid: true };
    if (account.banned) return { banned: true };
    return { account };
  }

  // ------------------------------------------------------------ admin plumbing
  // Live room registry: lifecycle events are reported to the AccountsDO
  // (best-effort, never blocks play) so the admin panel can list and
  // close active rooms.
  reportRoom(phase) {
    const room = this.room;
    try {
      if (!this.env.ACCOUNTS) return;
      const stub = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('accounts'));
      const host = room ? room.seats.find((s) => s.id === room.hostSeatId) : null;
      const p = stub.fetch('https://accounts.internal/internal/room-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: room ? room.code : this.ctx.id.name,
          mode: room ? (room.liveKind || (room.quick ? 'quick-bots' : room.mode)) : '',
          hostName: host ? host.name : '',
          seats: room ? room.seats.length : 0,
          phase,
        }),
      }).catch(() => {});
      if (this.ctx.waitUntil) this.ctx.waitUntil(p);
    } catch { /* registry is best-effort */ }
  }

  // Maintenance flag, read through the AccountsDO and cached for 30s
  // so the hot path never fetches per action. A failed read defaults
  // to NOT maintenance — the game must never freeze on this check.
  async maintenanceOn() {
    const now = Date.now();
    if (this.settingsCache && now - this.settingsCache.at < 30000) return this.settingsCache.maintenance;
    let maintenance = false;
    try {
      const stub = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('accounts'));
      const res = await stub.fetch('https://accounts.internal/internal/settings');
      if (res.ok) {
        const data = await res.json();
        maintenance = !!data.maintenance;
      }
    } catch { /* default: not maintenance */ }
    this.settingsCache = { at: now, maintenance };
    return maintenance;
  }

  // Stamp a seat with the resolved account identity. The payload avatar
  // (the client's character picker) still wins for this session; the
  // account avatar is the fallback.
  applyIdentity(seat, msg, account) {
    seat.name = String(account.name || seat.name).slice(0, 20);
    seat.photo = account.photo || null;
    if (Number.isInteger(account.wins)) seat.wins = account.wins;
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
      // Live matchmaking (v5): 'quick' | 'wild' | null. Live rooms are
      // created by the MatchmakerDO via /reserve with both seats
      // pre-claimed by ticket; they auto-start when both players join
      // and can never contain bots.
      liveKind: opts.live || null,
      reserved: null, // { expiresAt } while a reserved seat is unclaimed
      // Friend rooms choose their size at creation: 2–12 seats
      // (default 4, the original size). Bot/quick rooms ignore it.
      maxSeats: Math.min(12, Math.max(2, Math.round(Number(opts.maxSeats) || 4))),
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
      // Match scorecard counters (Addition: professional feel) —
      // stats = cumulative for the whole match, roundStats = this
      // round only. Incremented centrally from game events in
      // afterChange, so bot plays, timeouts and penalties all count.
      stats: {},
      roundStats: {},
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

  // Matchmaker reservation: body = { kind: 'quick'|'wild', bet, rules,
  // players: [{ ticket, name, photo, avatar, phone, playerId }] x2 }.
  // Creates the room in 'waiting' with both seats pre-made from the
  // resolved account identities. The seats stay unclaimed (connected:
  // false) until join_room presents the matching one-time ticket.
  // Reservations expire after 20s (see alarm()) so a player who never
  // shows up cannot squat the room; the partner is told opponent_gone.
  async handleReserve(request) {
    if (this.room) {
      return new Response(JSON.stringify({ error: 'room busy' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const players = Array.isArray(body.players) ? body.players.slice(0, 2) : [];
    if (players.length !== 2 || players.some((p) => !p || !p.ticket)) {
      return new Response(JSON.stringify({ error: 'need two ticketed players' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const kind = body.kind === 'wild' ? 'wild' : 'quick';
    const seats = players.map((p) => {
      const seat = this.makeSeat(p.name, false, p.avatar);
      seat.photo = p.photo || null;
      if (Number.isInteger(p.wins)) seat.wins = p.wins;
      seat.playerPhone = p.phone || null; // internal: ticket-claim check
      seat.ticket = String(p.ticket);     // internal: never in snapshots
      seat.claimed = false;
      seat.connected = false;
      seat.ready = true; // queued intentionally — no ready step in live rooms
      return seat;
    });
    const room = this.makeRoom(seats[0], 'classic', body.rules || {}, {
      quick: kind === 'quick',
      bet: kind === 'quick' ? body.bet : 0,
      live: kind,
      maxSeats: 2,
    });
    room.seats.push(seats[1]);
    room.scores[seats[1].id] = 0;
    room.reserved = { expiresAt: Date.now() + 20000 };
    try { await this.save(); } catch { /* persistAndArm discipline does not apply to fetch(); best-effort */ }
    try { await this.armAlarm(); } catch { /* the reservation deadline */ }
    return new Response(JSON.stringify({ ok: true, code: room.code }), { headers: { 'Content-Type': 'application/json' } });
  }

  assignTeams(room) {
    room.seats.forEach((s, i) => { s.team = room.mode === '2v2' ? (i % 2 === 0 ? 'a' : 'b') : null; });
  }

  startRound(room) {
    this.assignTeams(room);
    room.roundStats = {};
    room.game = G.createRound(room.seats.map((s) => s.id), room.rules);
    room.status = 'playing';
    room.roundNo++;
    this.reportRoom('playing');
    this.afterChange(room.game.events);
  }

  // Scorecard counters from the event stream of one action. Drawn
  // counts every card a seat receives involuntarily or by drawing:
  // normal draws, taken pendings, final-card draws, challenge outcomes
  // and UNO-catch penalties.
  countStats(room, events) {
    if (!events || !events.length) return;
    const bump = (obj, id, field, n) => {
      if (!id) return;
      if (!obj[id]) obj[id] = { played: 0, uno: 0, drawn: 0 };
      obj[id][field] += n;
    };
    for (const e of events) {
      switch (e.type) {
        case 'played': bump(room.stats, e.seatId, 'played', 1); bump(room.roundStats, e.seatId, 'played', 1); break;
        case 'uno_called': bump(room.stats, e.seatId, 'uno', 1); bump(room.roundStats, e.seatId, 'uno', 1); break;
        case 'drew': bump(room.stats, e.seatId, 'drawn', e.count || 1); bump(room.roundStats, e.seatId, 'drawn', e.count || 1); break;
        case 'took_pending': bump(room.stats, e.seatId, 'drawn', e.count || 0); bump(room.roundStats, e.seatId, 'drawn', e.count || 0); break;
        case 'final_draw': bump(room.stats, e.seatId, 'drawn', e.count || 0); bump(room.roundStats, e.seatId, 'drawn', e.count || 0); break;
        case 'challenge_won': bump(room.stats, e.accused, 'drawn', e.count || 0); bump(room.roundStats, e.accused, 'drawn', e.count || 0); break;
        case 'challenge_lost': bump(room.stats, e.seatId, 'drawn', e.count || 0); bump(room.roundStats, e.seatId, 'drawn', e.count || 0); break;
        case 'uno_caught': bump(room.stats, e.seatId, 'drawn', 2); bump(room.roundStats, e.seatId, 'drawn', 2); break;
        case 'first_draw2': bump(room.stats, e.seatId, 'drawn', 2); bump(room.roundStats, e.seatId, 'drawn', 2); break;
      }
    }
  }

  finishIfEnded(room) {
    const g = room.game;
    if (!g || g.phase !== 'finished' || room.status !== 'playing') return;
    room.status = 'roundEnd';
    this.reportRoom('roundEnd');
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
  // photoSet (optional): seat ids whose photo this socket has already
  // received during 'playing'. A seat's photo (~54KB data URL at the
  // 40KB cap) is by far the heaviest field in a state; sending it on
  // every broadcast made each action ship ~61KB per photo'd seat. The
  // diet: while playing, a photo rides only the FIRST state a socket
  // receives; later states send photo:null and the client merges the
  // cached photo by seat id. Lobby/roundEnd states always carry photos
  // (they are rare and the lobby shows them prominently).
  snapshotFor(room, viewer, photoSet) {
    const g = room.game;
    const snap = {
      type: 'state',
      room: { code: room.code, mode: room.mode, rules: room.rules, status: room.status, hostSeatId: room.hostSeatId, roundNo: room.roundNo, quick: !!room.quick, bet: room.bet || 0, maxSeats: room.maxSeats || 4, liveKind: room.liveKind || null },
      you: { seatId: viewer.id, token: viewer.token },
      seats: room.seats.map((s, i) => ({
        id: s.id, name: s.name, isBot: s.isBot, ready: s.ready, connected: s.connected, inVoice: !!s.inVoice,
        avatar: s.avatar != null ? s.avatar : i % 4,
        photo: this.photoFor(room, s, photoSet),
        wins: s.wins != null ? s.wins : null,
        team: s.team, score: room.scores[s.id] || 0,
        cardCount: g ? g.hands[s.id].length : 0,
        isCurrent: g ? G.currentSeatId(g) === s.id : false,
        isYou: s.id === viewer.id,
      })),
      chat: room.chat.slice(-30),
      events: room.lastEvents,
      stats: room.stats || {},
      roundStats: room.roundStats || {},
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

  photoFor(room, seat, photoSet) {
    if (!seat.photo) return null;
    if (room.status !== 'playing' || !photoSet) return seat.photo;
    if (photoSet.has(seat.id)) return null;
    photoSet.add(seat.id);
    return seat.photo;
  }

  broadcast(room) {
    for (const s of room.seats) {
      if (s.isBot) continue;
      const ws = this.sockets.get(s.id);
      if (!ws) continue;
      let sent = this.photoSentWs.get(ws);
      if (!sent) { sent = new Set(); this.photoSentWs.set(ws, sent); }
      this.sendRaw(ws, this.snapshotFor(room, s, sent));
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
    this.countStats(room, events);
    this.finishIfEnded(room);
    this.broadcast(room);
    this.schedule();
  }

  // Mirrors the Node schedule(): every state change restarts the current
  // player's 30s clock, recomputes the bot-move deadline and registers
  // the single DO alarm at whichever deadline comes first. Deadlines are
  // timestamps; registration is synchronous (the constructor path must
  // never await — see the restore note in the constructor).
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
      // UNO_BOT_THINK_MS (test-only override): pin the alarm fallback to
      // a fixed think time so the inline-chain regression can prove bots
      // move WITHOUT the alarm ever coming due.
      const fixed = Number(this.env && this.env.UNO_BOT_THINK_MS);
      this.pendingBotAt = Date.now() + (fixed > 0 ? fixed : 120 + Math.random() * 180);
    }
    if (g.unoSuspect) {
      if (!this.nextCatchAt) this.nextCatchAt = Date.now() + 1500;
    } else {
      this.nextCatchAt = null;
    }
    this.scheduleAlarm();
  }

  // The single DO alarm is always the earliest pending deadline.
  alarmTime() {
    const times = [];
    const room = this.room;
    if (room && room.status === 'playing' && room.turnEndsAt) times.push(room.turnEndsAt);
    if (this.pendingBotAt) times.push(this.pendingBotAt);
    if (this.nextCatchAt) times.push(this.nextCatchAt);
    if (room && room.reserved) times.push(room.reserved.expiresAt);
    return times.length ? Math.min(...times) : null;
  }

  // Synchronous registration from the current deadlines (see schedule()
  // for why this is never awaited in constructor/schedule paths).
  scheduleAlarm() {
    const at = this.alarmTime();
    if (at !== null) {
      this.ctx.storage.setAlarm(at);
    } else {
      this.ctx.storage.deleteAlarm();
    }
  }

  // Awaited registration, used by persistAndArm at handler boundaries
  // (never inside blockConcurrencyWhile — see the constructor note).
  async armAlarm() {
    const at = this.alarmTime();
    if (at !== null) {
      await this.ctx.storage.setAlarm(at);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async alarm() {
    const room = this.room;
    if (!room) return;
    const now = Date.now();
    const g = room.game;
    let acted = false; // a state change happened -> bots may be up next

    // Live-match reservation expiry: a matched player who never claimed
    // their seat within the window loses the room; the partner who DID
    // show up is told opponent_gone (no stake was ever taken — stakes
    // move at match start, which never happened).
    if (room.reserved && now >= room.reserved.expiresAt) {
      const unclaimed = room.seats.some((s) => s.ticket && !s.claimed);
      if (unclaimed) {
        for (const s of room.seats) {
          if (s.claimed && !s.isBot) this.sendToSeat(s, { type: 'opponent_gone' });
        }
        await this.destroyRoom(null);
        await this.persistAndArm();
        return;
      }
      room.reserved = null; // both claimed — the deadline is moot
    }

    // Bot UNO-catch sweep (was a 1.5s setInterval in the Node server).
    if (this.nextCatchAt && now >= this.nextCatchAt) {
      this.nextCatchAt = null;
      if (g && room.status === 'playing' && g.unoSuspect) {
        const suspect = room.seats.find((s) => s.id === g.unoSuspect);
        const bot = room.seats.find((s) => s.isBot && s.id !== g.unoSuspect);
        if (suspect && !suspect.isBot && bot && Math.random() < 0.25) {
          const res = G.applyCatchUno(g, bot.id, g.unoSuspect);
          if (res.ok) { this.afterChange(res.events); acted = true; }
        }
        if (g.unoSuspect) this.nextCatchAt = now + 1500;
      }
    }

    // Bot move due? (The alarm is the FALLBACK driver — the inline chain
    // normally plays bots inside the action's own invocation. This path
    // covers chains cut short by the safety cap or an eviction.)
    if (this.room && this.pendingBotAt && now >= this.pendingBotAt) {
      this.pendingBotAt = null;
      this.botAct();
      acted = true;
    }

    // Turn timer due? (Re-read state: botAct may have changed everything.)
    const room2 = this.room;
    if (room2 && room2.status === 'playing' && room2.game && room2.game.phase !== 'finished'
        && room2.turnEndsAt && Date.now() >= room2.turnEndsAt) {
      const gg = room2.game;
      const seatId = gg.phase === 'firstColor' ? gg.seats[0] : G.currentSeatId(gg);
      const res = G.applyTimeout(gg, seatId);
      this.afterChange(res.events || []);
      acted = true;
    }

    // A timeout resolution (or a fallback bot move) can hand the turn to
    // another bot — run the chain so it does not wait for another alarm.
    if (acted && this.room) this.runBotChain();

    // Never let persistence fail this handler: a throwing alarm() gets
    // its alarm discarded by the runtime once retries run out, which
    // would freeze the room for good. persistAndArm also re-registers
    // the alarm for whatever deadline comes next.
    await this.persistAndArm();
  }

  // ------------------------------------------------------------ bots
  // INLINE bot chain (the primary bot driver). Production measurement
  // (2026-11-22) showed bots taking 19–39s per move even with a
  // 120–300ms think time: the bottleneck is the DO alarm/wake path, not
  // the think time. So after any state change, if the current seat is a
  // bot, play the whole bot sequence INSIDE this invocation — each
  // botAct broadcasts through afterChange as usual, the client receives
  // the states back-to-back and its flight animations pace the visuals.
  // The chain stops at the first human seat, at round end, or at a
  // safety cap of 24 consecutive bot actions; pendingBotAt + the alarm
  // remain armed as the fallback for a chain cut short (cap/eviction).
  // Re-entrancy: botAct -> afterChange -> schedule() never re-enters
  // the chain (it only runs from handler boundaries); the flag is a
  // belt-and-braces guard.
  runBotChain() {
    if (this.botChain) return;
    this.botChain = true;
    try {
      for (let n = 0; n < 24; n++) {
        const room = this.room;
        if (!room || room.status !== 'playing' || !room.game || room.game.phase === 'finished') break;
        const g = room.game;
        const seatId = g.phase === 'firstColor' ? g.seats[0] : G.currentSeatId(g);
        const seat = room.seats.find((s) => s.id === seatId);
        if (!seat || !seat.isBot) break;
        this.pendingBotAt = null; // inline supersedes this action's alarm deadline
        this.botAct();
      }
    } finally {
      this.botChain = false;
    }
  }

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
    // Any action (play/draw/pass/challenge/pick_color, game start,
    // round start) may hand the turn to a bot — run the bot chain
    // inline, in this same invocation, before persisting.
    if (this.room) this.runBotChain();
    await this.persistAndArm();
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
    if (room.liveKind && room.status === 'waiting') {
      // A matched player vanishing before the start cancels the match;
      // the partner gets the friendly opponent_gone, not a dead lobby.
      for (const s of room.seats) {
        if (s.id !== seat.id && s.claimed) this.sendToSeat(s, { type: 'opponent_gone' });
      }
      await this.destroyRoom(null);
      return;
    }
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
    await this.persistAndArm();
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
        if (ident.banned) return this.sendError(ws, 'এই অ্যাকাউন্টটি বন্ধ করা হয়েছে');
        if (await this.maintenanceOn()) return this.sendError(ws, 'সার্ভার রক্ষণাবেক্ষণ চলছে, কিছুক্ষণ পরে আবার চেষ্টা করুন');
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
        if (ident.banned) return this.sendError(ws, 'এই অ্যাকাউন্টটি বন্ধ করা হয়েছে');
        if (await this.maintenanceOn()) return this.sendError(ws, 'সার্ভার রক্ষণাবেক্ষণ চলছে, কিছুক্ষণ পরে আবার চেষ্টা করুন');
        const seat = this.makeSeat(msg.name, false, msg.avatar);
        if (ident.account) this.applyIdentity(seat, msg, ident.account);
        // The host is implicitly ready: creating the room IS their
        // ready signal (their button is Start, not Ready). Without
        // this, the host's own seat row showed "not ready" forever
        // while Start actually worked — the display disagreed with
        // the server's gate (user report 2026-11-22).
        seat.ready = true;
        const room = this.makeRoom(seat, msg.mode, msg.rules || {}, { maxSeats: msg.maxSeats });
        this.bindSocket(ws, seat);
        this.reportRoom('waiting');
        return this.afterChange([]);
      }
      case 'join_room': {
        const room = this.room;
        const code = String(msg.code || '').toUpperCase().trim();
        if (!room || room.code !== code) return this.sendError(ws, 'Room not found — check the code');
        const ident = await this.sessionIdentity(msg);
        if (ident.invalid) return this.sendError(ws, 'Session expired — please log in again');
        if (ident.banned) return this.sendError(ws, 'এই অ্যাকাউন্টটি বন্ধ করা হয়েছে');
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
        // Live-match rooms: seats are reserved by the MatchmakerDO and
        // can ONLY be claimed with the one-time ticket issued at match
        // time. The plain join-by-code path must never claim one.
        if (room.liveKind) {
          if (ident.guest) return this.sendError(ws, 'Log in to join a live match');
          if (!msg.ticket) return this.sendError(ws, 'This is a live-match room — join through matchmaking');
          const seat = room.seats.find((s) => s.ticket && s.ticket === String(msg.ticket) && !s.claimed);
          if (!seat) return this.sendError(ws, 'Match ticket already used or invalid');
          if (seat.playerPhone && ident.account && ident.account.phone !== seat.playerPhone)
            return this.sendError(ws, 'This match ticket belongs to another player');
          seat.claimed = true;
          seat.ticket = null; // one-time: burned on use
          this.bindSocket(ws, seat);
          const av = validAvatar(msg.avatar);
          if (av !== null) seat.avatar = av;
          if (room.seats.every((s) => s.claimed)) {
            // Both matched players are in — host-less auto-start.
            room.reserved = null;
            return this.startRound(room);
          }
          return this.afterChange([]);
        }
        if (await this.maintenanceOn()) return this.sendError(ws, 'সার্ভার রক্ষণাবেক্ষণ চলছে, কিছুক্ষণ পরে আবার চেষ্টা করুন');
        if (room.status !== 'waiting') return this.sendError(ws, 'That game has already started');
        if (room.seats.length >= (room.maxSeats || 4)) return this.sendError(ws, 'That room is full');
        const seat = this.makeSeat(msg.name, false, msg.avatar);
        if (ident.account) this.applyIdentity(seat, msg, ident.account);
        room.seats.push(seat);
        room.scores[seat.id] = 0;
        this.bindSocket(ws, seat);
        this.reportRoom('waiting');
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
        if (room.liveKind) return this.sendError(ws, 'Live matches start automatically');
        if (seat.id !== room.hostSeatId) return this.sendError(ws, 'Only the host can start');
        // Quick Match is a single round: once it ends, the match is over.
        if (room.quick && room.status === 'roundEnd') return this.sendError(ws, 'Quick match is over — start a new one from the lobby');
        if (room.status === 'playing') return this.sendError(ws, 'The game is already running');
        if (room.seats.length < 2) return this.sendError(ws, 'You need at least 2 players');
        // Team mode pairs seats by parity (see assignTeams), which
        // generalizes to any even table: 4, 6, 8, 10 or 12 players.
        if (room.mode === '2v2' && (room.seats.length < 4 || room.seats.length % 2 !== 0))
          return this.sendError(ws, 'Team mode needs an even number of players (4–12)');
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
        if (room.liveKind && room.status === 'waiting') {
          // A matched player backing out before the start cancels the
          // match for the partner too (no stake was taken pre-start).
          for (const s of room.seats) {
            if (s.id !== seat.id && s.claimed) this.sendToSeat(s, { type: 'opponent_gone' });
          }
          await this.destroyRoom(null);
          return;
        }
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
