/*
 * UNO Adda — MatchmakerDO (singleton).
 *
 * Live-human matchmaking for Quick Match and Go Wild. One queue per
 * pool, keyed by an exact pool string:
 *   'quick:20' | 'quick:50' | 'quick:100' | 'quick:250' | 'wild'
 * STRICT isolation is structural: queues live in separate arrays and a
 * match is only ever formed from two entries of the SAME array, so a
 * player searching one slot/tier can never land with another.
 *
 * Flow: client opens a socket to /ws-match and sends
 *   { type: 'find_match', pool, session, avatar }
 * The account identity is resolved through the AccountsDO exactly like
 * the room layer does (guests cannot queue). Entries are FIFO with a
 * server-side TTL (env MATCH_TIMEOUT_MS, default 40000): on expiry the
 * entry is removed and the client gets { type: 'match_timeout', pool }.
 * When two entries share a pool, the matchmaker mints a room code,
 * reserves both seats in that room's GameRoom DO (POST /reserve with a
 * one-time join ticket per player), and tells each client
 *   { type: 'matched', code, ticket, pool, opponent: {name, photo, avatar} }
 * The clients then join /ws/<CODE> with their ticket; the room claims
 * the reserved seat and auto-starts once both are in. No coins move
 * here — Quick stakes are deducted by the clients at match start.
 *
 * Queue entries are persisted (without sockets) so an eviction does not
 * silently drop searching players; sockets rebind from hibernation
 * attachments on wake.
 */

const POOL_RULES = {
  quick: { stacking: true, challenge: true, allWild: false },
  wild: { stacking: true, challenge: true, allWild: true },
};
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// -> { kind: 'quick', bet } | { kind: 'wild', bet: 0 } | null
function parsePool(pool) {
  if (pool === 'wild') return { kind: 'wild', bet: 0 };
  const m = /^quick:(20|50|100|250)$/.exec(String(pool || ''));
  if (m) return { kind: 'quick', bet: Number(m[1]) };
  return null;
}

export class MatchmakerDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queues = new Map();   // pool -> [entry]
    // (maintenance is read fresh per find_match — see maintenanceOn())
    this.entryWs = new Map();  // entryId -> WebSocket (live attachments)
    this.seq = 0;

    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('mmqueue');
      if (saved && Array.isArray(saved.entries)) {
        for (const e of saved.entries) {
          if (!parsePool(e.pool)) continue;
          if (!this.queues.has(e.pool)) this.queues.set(e.pool, []);
          this.queues.get(e.pool).push(e);
        }
        this.seq = saved.seq || 0;
      }
      for (const ws of ctx.getWebSockets()) {
        const att = ws.deserializeAttachment();
        if (att && att.mmEntryId) this.entryWs.set(att.mmEntryId, ws);
      }
      // Entries whose socket is gone are dead weight — drop them.
      let changed = false;
      for (const [pool, arr] of this.queues) {
        const alive = arr.filter((e) => this.entryWs.has(e.id));
        if (alive.length !== arr.length) { this.queues.set(pool, alive); changed = true; }
      }
      if (changed) await this.persist();
      this.scheduleAlarm();
    });
  }

  ttlMs() {
    const n = Number(this.env && this.env.MATCH_TIMEOUT_MS);
    return n > 0 ? n : 40000;
  }

  async persist() {
    const entries = [];
    for (const arr of this.queues.values()) {
      for (const e of arr) {
        entries.push({
          id: e.id, pool: e.pool, phone: e.phone, playerId: e.playerId,
          name: e.name, photo: e.photo, avatar: e.avatar, wins: e.wins || 0, deadline: e.deadline,
        });
      }
    }
    try { await this.ctx.storage.put('mmqueue', { entries, seq: this.seq }); } catch { /* best-effort */ }
  }

  earliestDeadline() {
    let min = null;
    for (const arr of this.queues.values()) {
      for (const e of arr) if (min === null || e.deadline < min) min = e.deadline;
    }
    return min;
  }

  scheduleAlarm() {
    const at = this.earliestDeadline();
    try {
      if (at !== null) this.ctx.storage.setAlarm(at);
      else this.ctx.storage.deleteAlarm();
    } catch { /* registration heals on the next event */ }
  }

  async alarm() {
    const now = Date.now();
    const expired = [];
    for (const [pool, arr] of this.queues) {
      const keep = [];
      for (const e of arr) (e.deadline <= now ? expired : keep).push(e);
      this.queues.set(pool, keep);
    }
    for (const e of expired) {
      const ws = this.entryWs.get(e.id);
      this.entryWs.delete(e.id);
      if (ws) {
        try { ws.serializeAttachment({}); } catch { /* gone */ }
        this.sendRaw(ws, { type: 'match_timeout', pool: e.pool });
      }
    }
    await this.persist();
    this.scheduleAlarm();
  }

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

  sendRaw(ws, obj) {
    if (!ws) return;
    try { ws.send(JSON.stringify(obj)); } catch { /* socket is gone */ }
  }

  sendError(ws, message) {
    this.sendRaw(ws, { type: 'error', message });
  }

  removeEntry(entryId) {
    for (const [pool, arr] of this.queues) {
      const i = arr.findIndex((e) => e.id === entryId);
      if (i >= 0) { arr.splice(i, 1); return true; }
    }
    return false;
  }

  removeSocketEntries(ws) {
    const att = ws.deserializeAttachment();
    if (att && att.mmEntryId) {
      this.removeEntry(att.mmEntryId);
      this.entryWs.delete(att.mmEntryId);
    }
  }

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

  async webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return this.sendError(ws, 'Bad message');
    }
    try {
      if (msg.type === 'find_match') await this.findMatch(ws, msg);
      else if (msg.type === 'cancel_queue') {
        this.removeSocketEntries(ws);
        await this.persist();
        this.scheduleAlarm();
      } else {
        this.sendError(ws, 'Unknown message: ' + msg.type);
      }
    } catch (e) {
      this.sendError(ws, 'Server error: ' + e.message);
    }
  }

  async webSocketClose(ws) {
    // Disconnect while queueing removes the entry.
    this.removeSocketEntries(ws);
    await this.persist();
    this.scheduleAlarm();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  // Maintenance flag via the AccountsDO. Read FRESH on every find_match
  // (one DO-to-DO fetch per queue join is cheap, and it makes an admin
  // flipping maintenance take effect immediately — a 30s cache here let
  // players keep queueing for up to half a minute after the switch).
  // A failed read defaults to NOT maintenance, same contract as rooms.
  async maintenanceOn() {
    try {
      const stub = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('accounts'));
      const res = await stub.fetch('https://accounts.internal/internal/settings');
      if (res.ok) {
        const data = await res.json();
        return !!data.maintenance;
      }
    } catch { /* default: not maintenance */ }
    return false;
  }

  async findMatch(ws, msg) {
    const parsed = parsePool(msg.pool);
    if (!parsed) return this.sendError(ws, 'Unknown matchmaking pool');
    if (!msg.session) return this.sendError(ws, 'Log in to play live matches');
    const account = await this.resolveAccount(msg.session);
    if (!account) return this.sendError(ws, 'Session expired — please log in again');
    if (account.banned) return this.sendError(ws, 'এই অ্যাকাউন্টটি বন্ধ করা হয়েছে');
    if (await this.maintenanceOn()) return this.sendError(ws, 'সার্ভার রক্ষণাবেক্ষণ চলছে, কিছুক্ষণ পরে আবার চেষ্টা করুন');

    // One queue slot per player and per socket: re-queueing replaces
    // any previous entry (this is also what "Try again" relies on).
    this.removeSocketEntries(ws);
    for (const arr of this.queues.values()) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].phone === account.phone) {
          this.entryWs.delete(arr[i].id);
          arr.splice(i, 1);
        }
      }
    }

    const av = Number(msg.avatar);
    const entry = {
      id: 'q' + (++this.seq) + '-' + randomHex(4),
      pool: msg.pool,
      phone: account.phone,
      playerId: account.playerId,
      name: String(account.name || 'Player').slice(0, 20),
      photo: account.photo || null,
      wins: Number.isInteger(account.wins) ? account.wins : 0,
      avatar: Number.isInteger(av) && av >= 0 && av <= 3 ? av
        : (Number.isInteger(account.avatar) ? account.avatar : null),
      deadline: Date.now() + this.ttlMs(),
    };
    if (!this.queues.has(entry.pool)) this.queues.set(entry.pool, []);
    this.queues.get(entry.pool).push(entry);
    this.entryWs.set(entry.id, ws);
    ws.serializeAttachment({ mmEntryId: entry.id });
    await this.persist();
    this.scheduleAlarm();
    await this.tryMatch(entry.pool);
  }

  // Form a match from the two OLDEST entries of one pool (FIFO). Only
  // ever called with a single pool key — cross-pool matching is
  // impossible by construction.
  async tryMatch(pool) {
    const arr = this.queues.get(pool);
    if (!arr || arr.length < 2) return;
    const parsed = parsePool(pool);
    const [a, b] = [arr[0], arr[1]];

    let reserved = null;
    for (let attempt = 0; attempt < 3 && !reserved; attempt++) {
      const code = randomCode();
      const mk = (e) => ({
        ticket: randomHex(16),
        name: e.name, photo: e.photo, avatar: e.avatar, wins: e.wins || 0,
        phone: e.phone, playerId: e.playerId,
      });
      const pa = mk(a);
      const pb = mk(b);
      try {
        const stub = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(code));
        const res = await stub.fetch('https://room.internal/reserve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: parsed.kind,
            bet: parsed.bet,
            rules: POOL_RULES[parsed.kind],
            players: [pa, pb],
          }),
        });
        if (res.ok) reserved = { code, ta: pa.ticket, tb: pb.ticket };
        // 409 = code collision with a live room: mint another code.
      } catch { /* fall through to the next attempt */ }
    }

    if (!reserved) {
      // Could not create the room — drop both entries with an error
      // rather than leaving them queued against a broken room.
      this.removeEntry(a.id);
      this.removeEntry(b.id);
      for (const e of [a, b]) {
        const ws = this.entryWs.get(e.id);
        this.entryWs.delete(e.id);
        if (ws) this.sendError(ws, 'Could not create the match room — please try again');
      }
      await this.persist();
      this.scheduleAlarm();
      return;
    }

    this.removeEntry(a.id);
    this.removeEntry(b.id);
    const deliver = (e, ticket, opp) => {
      const ws = this.entryWs.get(e.id);
      this.entryWs.delete(e.id);
      if (ws) {
        try { ws.serializeAttachment({}); } catch { /* gone */ }
        this.sendRaw(ws, {
          type: 'matched', code: reserved.code, ticket, pool,
          opponent: { name: opp.name, photo: opp.photo, avatar: opp.avatar, wins: opp.wins || 0 },
        });
      }
    };
    deliver(a, reserved.ta, b);
    deliver(b, reserved.tb, a);
    await this.persist();
    this.scheduleAlarm();
  }
}
