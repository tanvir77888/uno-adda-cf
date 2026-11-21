/*
 * UNO Adda — Accounts Durable Object (singleton, addressed as "accounts").
 *
 * Player accounts for a completely free game: a Bangladeshi mobile number
 * plus a password — no SMS, no OTP, no external service. Passwords are
 * PBKDF2-SHA256 hashes (100k iterations, per-account random salt). Session
 * tokens are 32 random bytes; only their SHA-256 hash is stored.
 *
 * The account record is the source of truth for the coin wallet and the
 * cumulative stats (matches / wins / coins won). Wallet moves that credit
 * coins (pot payouts) are honor-system by design — this is a friendly
 * free game, not a bank.
 *
 * HTTP contract (routed by the Worker):
 *   POST /api/auth/signup  {phone, password, name}      -> {token, profile}
 *   POST /api/auth/login   {phone, password}            -> {token, profile}
 *   GET  /api/auth/me      (Bearer)                     -> profile
 *   POST /api/auth/logout  (Bearer)                     -> {ok:true}
 *   POST /api/auth/name    (Bearer) {name}              -> {ok:true, profile}
 *   POST /api/auth/photo   (Bearer) {photo}             -> {ok:true, profile}
 *   POST /api/wallet/gift   (Bearer)                    -> {coins} | 409
 *   POST /api/wallet/rescue (Bearer)                    -> {coins} | 409
 *   POST /api/wallet/adjust (Bearer) {amount, reason}   -> {coins} | 400
 *   POST /api/stats/match   (Bearer) {won, coinsWon}    -> {matches, wins, coinsWon}
 *   POST /resolve           {token}  (internal, DO->DO) -> identity | 401
 *
 * profile = {playerId, phone, name, photo, avatar, coins, matches, wins, coinsWon}
 */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  return bytesToHex(new Uint8Array(bits));
}

// Calendar day in Dhaka — the daily gift / rescue reset on local (BD) time,
// not on the player's device clock.
function dhakaToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

const PHONE_RE = /^01[3-9]\d{8}$/;
const GIFT_COINS = 200;
const RESCUE_COINS = 100;
const MAX_PHOTO_BYTES = 40 * 1024;

export class AccountsDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(
        `CREATE TABLE IF NOT EXISTS accounts (
           phone TEXT PRIMARY KEY,
           player_id INTEGER UNIQUE,
           pass_hash TEXT NOT NULL,
           salt TEXT NOT NULL,
           name TEXT NOT NULL,
           photo TEXT,
           avatar INTEGER NOT NULL DEFAULT 0,
           coins INTEGER NOT NULL DEFAULT 500,
           matches INTEGER NOT NULL DEFAULT 0,
           wins INTEGER NOT NULL DEFAULT 0,
           coins_won INTEGER NOT NULL DEFAULT 0,
           last_gift TEXT,
           last_rescue TEXT,
           created_at INTEGER NOT NULL DEFAULT 0
         )`
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS sessions (
           token_hash TEXT PRIMARY KEY,
           phone TEXT NOT NULL,
           created_at INTEGER NOT NULL DEFAULT 0
         )`
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (
           key TEXT PRIMARY KEY,
           value TEXT
         )`
      );
      sql.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('next_player_id', '1001')`);
    });
  }

  sql() { return this.ctx.storage.sql; }

  accountByPhone(phone) {
    return this.sql().exec('SELECT * FROM accounts WHERE phone = ?', phone).toArray()[0] || null;
  }

  profileOf(row) {
    return {
      playerId: row.player_id,
      phone: row.phone,
      name: row.name,
      photo: row.photo || null,
      avatar: row.avatar,
      coins: row.coins,
      matches: row.matches,
      wins: row.wins,
      coinsWon: row.coins_won,
    };
  }

  async newSession(phone) {
    const token = randomHex(32);
    const tokenHash = await sha256Hex(token);
    this.sql().exec(
      'INSERT INTO sessions (token_hash, phone, created_at) VALUES (?, ?, ?)',
      tokenHash, phone, Date.now()
    );
    return token;
  }

  // Bearer token -> account row (or null).
  async accountFor(request) {
    const header = request.headers.get('Authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const tokenHash = await sha256Hex(m[1].trim());
    const s = this.sql().exec('SELECT phone FROM sessions WHERE token_hash = ?', tokenHash).toArray()[0];
    if (!s) return null;
    return this.accountByPhone(s.phone);
  }

  async readBody(request) {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---------------------------------------------------------- internal
    if (path === '/resolve' && method === 'POST') {
      const body = await this.readBody(request);
      const token = body && typeof body.token === 'string' ? body.token : '';
      if (!token) return json({ error: 'invalid session' }, 401);
      const tokenHash = await sha256Hex(token);
      const s = this.sql().exec('SELECT phone FROM sessions WHERE token_hash = ?', tokenHash).toArray()[0];
      if (!s) return json({ error: 'invalid session' }, 401);
      const acct = this.accountByPhone(s.phone);
      if (!acct) return json({ error: 'invalid session' }, 401);
      return json({
        phone: acct.phone,
        playerId: acct.player_id,
        name: acct.name,
        photo: acct.photo || null,
        avatar: acct.avatar,
      });
    }

    // ---------------------------------------------------------- signup
    if (path === '/api/auth/signup' && method === 'POST') {
      const body = await this.readBody(request);
      if (!body) return json({ error: 'bad json' }, 400);
      const phone = String(body.phone || '').trim();
      const password = String(body.password || '');
      const name = String(body.name || '').trim().slice(0, 20);
      if (!PHONE_RE.test(phone)) {
        return json({ error: 'Enter a valid mobile number (11 digits, starting 01 — e.g. 01712345678)' }, 400);
      }
      if (password.length < 6) {
        return json({ error: 'Password must be at least 6 characters' }, 400);
      }
      if (name.length < 2) {
        return json({ error: 'Name must be at least 2 characters' }, 400);
      }
      if (this.accountByPhone(phone)) {
        return json({ error: 'This number already has an account — try logging in instead.' }, 409);
      }
      const idRow = this.sql().exec("SELECT value FROM meta WHERE key = 'next_player_id'").toArray()[0];
      const playerId = parseInt(idRow && idRow.value, 10) || 1001;
      this.sql().exec("UPDATE meta SET value = ? WHERE key = 'next_player_id'", String(playerId + 1));
      const salt = randomHex(16);
      const passHash = await hashPassword(password, salt);
      this.sql().exec(
        `INSERT INTO accounts (phone, player_id, pass_hash, salt, name, photo, avatar, coins, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, 0, 500, ?)`,
        phone, playerId, passHash, salt, name, Date.now()
      );
      const token = await this.newSession(phone);
      return json({ token, profile: this.profileOf(this.accountByPhone(phone)) });
    }

    // ---------------------------------------------------------- login
    if (path === '/api/auth/login' && method === 'POST') {
      const body = await this.readBody(request);
      if (!body) return json({ error: 'bad json' }, 400);
      const phone = String(body.phone || '').trim();
      const password = String(body.password || '');
      const acct = PHONE_RE.test(phone) ? this.accountByPhone(phone) : null;
      if (!acct) return json({ error: 'Wrong phone number or password' }, 401);
      const candidate = await hashPassword(password, acct.salt);
      if (candidate !== acct.pass_hash) return json({ error: 'Wrong phone number or password' }, 401);
      const token = await this.newSession(phone);
      return json({ token, profile: this.profileOf(acct) });
    }

    // ---------------------------------------------------------- authed routes
    const acct = await this.accountFor(request);
    if (!acct) return json({ error: 'Please log in again' }, 401);
    const phone = acct.phone;

    if (path === '/api/auth/me' && method === 'GET') {
      return json(this.profileOf(acct));
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      const header = request.headers.get('Authorization') || '';
      const m = header.match(/^Bearer\s+(.+)$/i);
      if (m) {
        const tokenHash = await sha256Hex(m[1].trim());
        this.sql().exec('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
      }
      return json({ ok: true });
    }

    if (path === '/api/auth/name' && method === 'POST') {
      const body = await this.readBody(request);
      if (!body) return json({ error: 'bad json' }, 400);
      const name = String(body.name || '').trim().slice(0, 20);
      if (name.length < 2) return json({ error: 'Name must be at least 2 characters' }, 400);
      this.sql().exec('UPDATE accounts SET name = ? WHERE phone = ?', name, phone);
      return json({ ok: true, profile: this.profileOf(this.accountByPhone(phone)) });
    }

    if (path === '/api/auth/photo' && method === 'POST') {
      const body = await this.readBody(request);
      if (!body) return json({ error: 'bad json' }, 400);
      const photo = typeof body.photo === 'string' ? body.photo : '';
      if (!photo.startsWith('data:image/jpeg')) {
        return json({ error: 'Photo must be a JPEG image' }, 400);
      }
      const comma = photo.indexOf(',');
      const b64 = comma >= 0 ? photo.slice(comma + 1) : '';
      if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) {
        return json({ error: 'Photo data looks broken — try another photo' }, 400);
      }
      const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
      const decodedBytes = Math.floor((b64.length * 3) / 4) - padding;
      if (decodedBytes > MAX_PHOTO_BYTES) {
        return json({ error: 'Photo is too large — pick a smaller one' }, 400);
      }
      this.sql().exec('UPDATE accounts SET photo = ? WHERE phone = ?', photo, phone);
      return json({ ok: true, profile: this.profileOf(this.accountByPhone(phone)) });
    }

    if (path === '/api/wallet/gift' && method === 'POST') {
      const today = dhakaToday();
      if (acct.last_gift === today) return json({ error: 'already' }, 409);
      const coins = acct.coins + GIFT_COINS;
      this.sql().exec('UPDATE accounts SET coins = ?, last_gift = ? WHERE phone = ?', coins, today, phone);
      return json({ coins });
    }

    if (path === '/api/wallet/rescue' && method === 'POST') {
      const today = dhakaToday();
      const eligible = acct.coins < 20 && acct.last_gift === today && acct.last_rescue !== today;
      if (!eligible) return json({ error: 'not eligible' }, 409);
      const coins = acct.coins + RESCUE_COINS;
      this.sql().exec('UPDATE accounts SET coins = ?, last_rescue = ? WHERE phone = ?', coins, today, phone);
      return json({ coins });
    }

    if (path === '/api/wallet/adjust' && method === 'POST') {
      const body = await this.readBody(request);
      if (!body) return json({ error: 'bad json' }, 400);
      const amount = clampInt(body.amount, -250, 1000, 0);
      if (amount < 0 && acct.coins + amount < 0) {
        return json({ error: 'Not enough coins' }, 400);
      }
      const coins = acct.coins + amount;
      this.sql().exec('UPDATE accounts SET coins = ? WHERE phone = ?', coins, phone);
      return json({ coins });
    }

    if (path === '/api/stats/match' && method === 'POST') {
      const body = await this.readBody(request);
      if (!body) return json({ error: 'bad json' }, 400);
      const matches = acct.matches + 1;
      const wins = acct.wins + (body.won ? 1 : 0);
      const coinsWon = acct.coins_won + clampInt(body.coinsWon, 0, 1000, 0);
      this.sql().exec(
        'UPDATE accounts SET matches = ?, wins = ?, coins_won = ? WHERE phone = ?',
        matches, wins, coinsWon, phone
      );
      return json({ matches, wins, coinsWon });
    }

    return json({ error: 'not found' }, 404);
  }
}
