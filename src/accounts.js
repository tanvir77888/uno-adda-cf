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
 * Notifications / Web Push / admin control center:
 *   GET  /api/notifications            (Bearer) -> my notifications + read flags
 *   POST /api/notifications/read       (Bearer) {id} | {all:true}
 *   GET  /api/notifications/unread-count (Bearer) -> {count}
 *   POST /api/push/subscribe           (Bearer) {subscription}
 *   POST /api/push/unsubscribe         (Bearer) {endpoint}
 *   GET  /api/push/vapid-public-key    -> {publicKey}      (public)
 *   GET  /api/settings                 -> {announcement, maintenance} (public)
 *   /api/admin/*                       (Bearer + is_admin, else 403):
 *     users list/detail, adjust-coins, grant-all, reset-password, ban,
 *     delete, stats, notify, history, leaderboard, rooms, settings, audit
 *   POST /internal/room-event          (internal, DO->DO) room registry
 *   GET  /internal/settings            (internal, DO->DO) maintenance read
 *
 * Admin bootstrap: the account whose phone equals env ADMIN_PHONE is
 * admin (flag set at signup, re-asserted at login). No other path.
 *
 * profile = {playerId, phone, name, photo, avatar, coins, matches, wins, coinsWon, isAdmin, banned}
 */
import { sendPush } from './push.js';

const MAINTENANCE_MSG = 'সার্ভার রক্ষণাবেক্ষণ চলছে, কিছুক্ষণ পরে আবার চেষ্টা করুন';
const BANNED_MSG = 'এই অ্যাকাউন্টটি বন্ধ করা হয়েছে';
// Seeded About text (Addition 12): stored in settings as `about_text`,
// editable from the admin panel; this constant is the seed/fallback.
const DEFAULT_ABOUT_TEXT = 'UNO Adda একটি সম্পূর্ণ ফ্রি অনলাইন কার্ড গেম — যেখানে বাংলাদেশসহ বিশ্বের যেকোনো প্রান্তের বন্ধুদের সাথে লাইভ খেলা যায়।\n\nআমাদের উদ্দেশ্য একটাই: বন্ধুদের আড্ডা যেন দূরত্বে হারিয়ে না যায়। ব্যস্ত জীবনে সবাই ছড়িয়ে-ছিটিয়ে — কিন্তু এক রাউন্ড খেলা আর ভয়েস আড্ডায় সেই পুরনো মজাটা ফিরে আসে।\n\nএখানে কোনো আসল টাকার খেলা হয় না — সব কয়েন শুধুই খেলার মজার জন্য।\n\nভালোবাসা দিয়ে বানানো — আহমেদ তানভীর, হবিগঞ্জ, বাংলাদেশ।';
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
      // Admin flag + ban flag on existing accounts (guarded, like the
      // leaderboard photo column).
      const cols = sql.exec("SELECT name FROM pragma_table_info('accounts')").toArray().map((r) => r.name);
      if (!cols.includes('is_admin')) sql.exec('ALTER TABLE accounts ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
      if (!cols.includes('banned')) sql.exec('ALTER TABLE accounts ADD COLUMN banned INTEGER NOT NULL DEFAULT 0');
      // Notifications inbox (target_phone NULL = broadcast to everyone).
      sql.exec(
        `CREATE TABLE IF NOT EXISTS notifications (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           target_phone TEXT,
           title TEXT NOT NULL,
           body TEXT NOT NULL,
           push_attempted INTEGER NOT NULL DEFAULT 0,
           push_ok INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL DEFAULT 0
         )`
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS notification_reads (
           phone TEXT NOT NULL,
           notification_id INTEGER NOT NULL,
           read_at INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (phone, notification_id)
         )`
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS push_subs (
           phone TEXT NOT NULL,
           endpoint TEXT NOT NULL UNIQUE,
           keys_json TEXT NOT NULL,
           updated_at INTEGER NOT NULL DEFAULT 0
         )`
      );
      // Site settings (announcement, maintenance) — simple key/value.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS settings (
           key TEXT PRIMARY KEY,
           value TEXT
         )`
      );
      // Every mutating admin action leaves an audit row.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS admin_audit (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           admin_phone TEXT NOT NULL,
           action TEXT NOT NULL,
           target TEXT,
           detail TEXT,
           created_at INTEGER NOT NULL DEFAULT 0
         )`
      );
      // Live room registry, fed by GameRoom lifecycle events.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS rooms (
           code TEXT PRIMARY KEY,
           mode TEXT,
           host_name TEXT,
           seats INTEGER NOT NULL DEFAULT 0,
           phase TEXT,
           updated_at INTEGER NOT NULL DEFAULT 0
         )`
      );
    });
  }

  isAdminRow(row) {
    if (!row) return false;
    if (row.is_admin === 1) return true;
    return !!(this.env.ADMIN_PHONE && row.phone === this.env.ADMIN_PHONE);
  }

  audit(adminPhone, action, target, detail) {
    try {
      this.sql().exec(
        'INSERT INTO admin_audit (admin_phone, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)',
        adminPhone, action, target || null, detail == null ? null : String(detail).slice(0, 300), Date.now()
      );
    } catch { /* audit is best-effort */ }
  }

  getSetting(key) {
    const r = this.sql().exec('SELECT value FROM settings WHERE key = ?', key).toArray()[0];
    return r ? r.value : null;
  }

  setSetting(key, value) {
    this.sql().exec(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, value
    );
  }

  maintenanceOn() {
    return this.getSetting('maintenance') === '1';
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
      isAdmin: this.isAdminRow(row),
      banned: row.banned === 1,
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
        wins: acct.wins || 0, // badge tier (Bronze/Silver/Gold) in lobbies & games
        banned: acct.banned === 1, // room/matchmaker refuse banned seats
      });
    }

    // GameRoom lifecycle -> live room registry (binding-only).
    if (path === '/internal/room-event' && method === 'POST') {
      const body = await this.readBody(request);
      if (!body || !body.code) return json({ error: 'bad room event' }, 400);
      const code = String(body.code).toUpperCase();
      if (body.phase === 'closed') {
        this.sql().exec('DELETE FROM rooms WHERE code = ?', code);
      } else {
        this.sql().exec(
          `INSERT INTO rooms (code, mode, host_name, seats, phase, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(code) DO UPDATE SET mode = excluded.mode, host_name = excluded.host_name,
             seats = excluded.seats, phase = excluded.phase, updated_at = excluded.updated_at`,
          code, String(body.mode || ''), String(body.hostName || ''),
          clampInt(body.seats, 0, 99, 0), String(body.phase || ''), Date.now()
        );
      }
      return json({ ok: true });
    }

    // Cached maintenance read for rooms / matchmaker (binding-only).
    if (path === '/internal/settings' && method === 'GET') {
      return json({ maintenance: this.maintenanceOn(), announcement: this.getSetting('announcement') || '' });
    }

    // ---------------------------------------------------------- public
    if (path === '/api/settings' && method === 'GET') {
      return json({
        announcement: this.getSetting('announcement') || '',
        maintenance: this.maintenanceOn(),
        aboutText: this.getSetting('about_text') || DEFAULT_ABOUT_TEXT,
      });
    }

    if (path === '/api/push/vapid-public-key' && method === 'GET') {
      return json({ publicKey: this.env.VAPID_PUBLIC_KEY || '' });
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
      // Maintenance blocks new signups (the bootstrap admin's own
      // signup is allowed so the panel can always be reached).
      if (this.maintenanceOn() && !(this.env.ADMIN_PHONE && phone === this.env.ADMIN_PHONE)) {
        return json({ error: MAINTENANCE_MSG }, 503);
      }
      const idRow = this.sql().exec("SELECT value FROM meta WHERE key = 'next_player_id'").toArray()[0];
      const playerId = parseInt(idRow && idRow.value, 10) || 1001;
      this.sql().exec("UPDATE meta SET value = ? WHERE key = 'next_player_id'", String(playerId + 1));
      const salt = randomHex(16);
      const passHash = await hashPassword(password, salt);
      const isAdmin = this.env.ADMIN_PHONE && phone === this.env.ADMIN_PHONE ? 1 : 0;
      this.sql().exec(
        `INSERT INTO accounts (phone, player_id, pass_hash, salt, name, photo, avatar, coins, created_at, is_admin)
         VALUES (?, ?, ?, ?, ?, NULL, 0, 500, ?, ?)`,
        phone, playerId, passHash, salt, name, Date.now(), isAdmin
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
      if (acct.banned === 1) return json({ error: BANNED_MSG }, 403);
      // Bootstrap admin re-assert: the env phone is always admin.
      if (this.env.ADMIN_PHONE && phone === this.env.ADMIN_PHONE && acct.is_admin !== 1) {
        this.sql().exec('UPDATE accounts SET is_admin = 1 WHERE phone = ?', phone);
        acct.is_admin = 1;
      }
      // Maintenance blocks logins — except the admin's.
      if (this.maintenanceOn() && !this.isAdminRow(acct)) {
        return json({ error: MAINTENANCE_MSG }, 503);
      }
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

    // ------------------------------------------------- notifications (user)
    if (path === '/api/notifications' && method === 'GET') {
      const rows = this.sql().exec(
        `SELECT n.id, n.title, n.body, n.target_phone, n.created_at,
                (r.notification_id IS NOT NULL) AS is_read
         FROM notifications n
         LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.phone = ?
         WHERE n.target_phone IS NULL OR n.target_phone = ?
         ORDER BY n.id DESC LIMIT 50`,
        phone, phone
      ).toArray();
      return json({
        notifications: rows.map((r) => ({
          id: r.id, title: r.title, body: r.body,
          direct: r.target_phone !== null,
          read: r.is_read === 1 || r.is_read === true,
          createdAt: r.created_at,
        })),
      });
    }

    if ((path === '/api/notifications/read' || path === '/api/notifications/read-all') && method === 'POST') {
      const body = await this.readBody(request);
      if (path === '/api/notifications/read-all' || (body && body.all === true)) {
        const rows = this.sql().exec(
          'SELECT id FROM notifications WHERE target_phone IS NULL OR target_phone = ?', phone
        ).toArray();
        for (const r of rows) {
          this.sql().exec(
            'INSERT OR IGNORE INTO notification_reads (phone, notification_id, read_at) VALUES (?, ?, ?)',
            phone, r.id, Date.now()
          );
        }
        return json({ ok: true });
      }
      const id = body && Math.floor(Number(body.id));
      if (!id) return json({ error: 'bad id' }, 400);
      this.sql().exec(
        'INSERT OR IGNORE INTO notification_reads (phone, notification_id, read_at) VALUES (?, ?, ?)',
        phone, id, Date.now()
      );
      return json({ ok: true });
    }

    if (path === '/api/notifications/unread-count' && method === 'GET') {
      const r = this.sql().exec(
        `SELECT COUNT(*) AS c FROM notifications n
         LEFT JOIN notification_reads rd ON rd.notification_id = n.id AND rd.phone = ?
         WHERE (n.target_phone IS NULL OR n.target_phone = ?) AND rd.notification_id IS NULL`,
        phone, phone
      ).toArray()[0];
      return json({ count: r ? r.c : 0 });
    }

    // ------------------------------------------------- web push (user)
    if (path === '/api/push/subscribe' && method === 'POST') {
      const body = await this.readBody(request);
      const sub = body && body.subscription;
      if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return json({ error: 'bad subscription' }, 400);
      }
      this.sql().exec(
        `INSERT INTO push_subs (phone, endpoint, keys_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET phone = excluded.phone,
           keys_json = excluded.keys_json, updated_at = excluded.updated_at`,
        phone, sub.endpoint, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }), Date.now()
      );
      return json({ ok: true });
    }

    if ((path === '/api/push/unsubscribe' && method === 'POST') ||
        (path === '/api/push/subscribe' && method === 'DELETE')) {
      const body = await this.readBody(request);
      const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint : '';
      if (endpoint) this.sql().exec('DELETE FROM push_subs WHERE endpoint = ?', endpoint);
      return json({ ok: true });
    }

    // ------------------------------------------------- admin control center
    if (path.startsWith('/api/admin/')) {
      if (!this.isAdminRow(acct)) return json({ error: 'Admins only' }, 403);
      const adminPhone = phone;
      // NB: the leaderboard singleton is addressed as 'global'
      // (worker.js) — any other name would be a different, empty DO.
      const boardStub = () => this.env.BOARD.get(this.env.BOARD.idFromName('global'));

      // ---- users: list / search / detail
      if (path === '/api/admin/users' && method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        const rows = q
          ? this.sql().exec(
              'SELECT * FROM accounts WHERE name LIKE ? OR phone LIKE ? ORDER BY created_at DESC LIMIT 100',
              '%' + q + '%', '%' + q + '%'
            ).toArray()
          : this.sql().exec('SELECT * FROM accounts ORDER BY created_at DESC LIMIT 100').toArray();
        return json({ users: rows.map((r) => this.profileOf(r)) });
      }

      const userDetailMatch = path.match(/^\/api\/admin\/users\/(\d{6,15})$/);
      if (userDetailMatch && method === 'GET') {
        const target = this.accountByPhone(userDetailMatch[1]);
        if (!target) return json({ error: 'user not found' }, 404);
        const recent = this.sql().exec(
          `SELECT id, title, body, created_at FROM notifications
           WHERE target_phone IS NULL OR target_phone = ? ORDER BY id DESC LIMIT 10`,
          target.phone
        ).toArray();
        const sub = this.sql().exec(
          'SELECT COUNT(*) AS c FROM push_subs WHERE phone = ?', target.phone
        ).toArray()[0];
        return json({
          user: { ...this.profileOf(target), createdAt: target.created_at },
          pushSubscribed: !!(sub && sub.c > 0),
          recentNotifications: recent.map((r) => ({ id: r.id, title: r.title, body: r.body, createdAt: r.created_at })),
        });
      }

      // ---- user management actions
      if (path === '/api/admin/users/adjust-coins' && method === 'POST') {
        const body = await this.readBody(request);
        const target = body && this.accountByPhone(String(body.phone || ''));
        if (!target) return json({ error: 'user not found' }, 404);
        const amount = clampInt(body.amount, -100000, 100000, 0);
        const coins = Math.max(0, target.coins + amount);
        this.sql().exec('UPDATE accounts SET coins = ? WHERE phone = ?', coins, target.phone);
        this.audit(adminPhone, 'adjust-coins', target.phone, (amount >= 0 ? '+' : '') + amount + ' -> ' + coins);
        return json({ ok: true, coins });
      }

      if (path === '/api/admin/users/grant-all' && method === 'POST') {
        const body = await this.readBody(request);
        const amount = clampInt(body && body.amount, 1, 100000, 0);
        if (!amount) return json({ error: 'amount required' }, 400);
        const res = this.sql().exec('UPDATE accounts SET coins = coins + ?', amount);
        const affected = res && typeof res.rowsWritten === 'number' ? res.rowsWritten : 0;
        this.audit(adminPhone, 'grant-all', null, '+' + amount + ' to ' + affected + ' users');
        return json({ ok: true, affected });
      }

      if (path === '/api/admin/users/reset-password' && method === 'POST') {
        const body = await this.readBody(request);
        const target = body && this.accountByPhone(String(body.phone || ''));
        if (!target) return json({ error: 'user not found' }, 404);
        const newPassword = String((body && body.newPassword) || '');
        if (newPassword.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400);
        const salt = randomHex(16);
        const passHash = await hashPassword(newPassword, salt);
        this.sql().exec('UPDATE accounts SET pass_hash = ?, salt = ? WHERE phone = ?', passHash, salt, target.phone);
        this.sql().exec('DELETE FROM sessions WHERE phone = ?', target.phone);
        this.audit(adminPhone, 'reset-password', target.phone, 'sessions revoked');
        return json({ ok: true });
      }

      if (path === '/api/admin/users/ban' && method === 'POST') {
        const body = await this.readBody(request);
        const target = body && this.accountByPhone(String(body.phone || ''));
        if (!target) return json({ error: 'user not found' }, 404);
        if (target.phone === adminPhone) return json({ error: 'You cannot ban yourself' }, 400);
        const banned = body.banned ? 1 : 0;
        this.sql().exec('UPDATE accounts SET banned = ? WHERE phone = ?', banned, target.phone);
        if (banned) this.sql().exec('DELETE FROM sessions WHERE phone = ?', target.phone);
        this.audit(adminPhone, banned ? 'ban' : 'unban', target.phone, null);
        return json({ ok: true, banned: !!banned });
      }

      if (path === '/api/admin/users/delete' && method === 'POST') {
        const body = await this.readBody(request);
        const target = body && this.accountByPhone(String(body.phone || ''));
        if (!target) return json({ error: 'user not found' }, 404);
        if (target.phone === adminPhone) return json({ error: 'You cannot delete yourself' }, 400);
        this.sql().exec('DELETE FROM accounts WHERE phone = ?', target.phone);
        this.sql().exec('DELETE FROM sessions WHERE phone = ?', target.phone);
        this.sql().exec('DELETE FROM push_subs WHERE phone = ?', target.phone);
        this.sql().exec('DELETE FROM notification_reads WHERE phone = ?', target.phone);
        this.audit(adminPhone, 'delete-user', target.phone, target.name);
        return json({ ok: true });
      }

      // ---- overview stats
      if (path === '/api/admin/stats' && method === 'GET') {
        const one = (q) => this.sql().exec(q).toArray()[0] || {};
        const users = one('SELECT COUNT(*) AS c FROM accounts').c || 0;
        const matches = one('SELECT COALESCE(SUM(matches), 0) AS s FROM accounts').s || 0;
        const coins = one('SELECT COALESCE(SUM(coins), 0) AS s FROM accounts').s || 0;
        const notifs = one('SELECT COUNT(*) AS c FROM notifications').c || 0;
        const dayStart = Date.parse(dhakaToday() + 'T00:00:00+06:00') || 0;
        const joinedToday = this.sql().exec(
          'SELECT COUNT(*) AS c FROM accounts WHERE created_at >= ?', dayStart
        ).toArray()[0].c || 0;
        return json({ users, matches, coins, notifications: notifs, joinedToday });
      }

      // ---- notify (store + bounded push fan-out)
      if (path === '/api/admin/notify' && method === 'POST') {
        const body = await this.readBody(request);
        const title = String((body && body.title) || '').trim().slice(0, 80);
        const text = String((body && body.body) || '').trim().slice(0, 500);
        if (!title || !text) return json({ error: 'title and body are required' }, 400);
        const targetPhone = body && body.phone ? String(body.phone) : null;
        if (targetPhone && !this.accountByPhone(targetPhone)) {
          return json({ error: 'target user not found' }, 404);
        }
        const ins = this.sql().exec(
          'INSERT INTO notifications (target_phone, title, body, created_at) VALUES (?, ?, ?, ?)',
          targetPhone, title, text, Date.now()
        );
        const notifId = ins && typeof ins.lastRowId === 'number' ? ins.lastRowId : null;
        const subs = (targetPhone
          ? this.sql().exec('SELECT * FROM push_subs WHERE phone = ?', targetPhone)
          : this.sql().exec('SELECT * FROM push_subs')
        ).toArray();
        // Bounded fan-out: every send has a 5s timeout and failures
        // never block or fail the notify call itself.
        let pushOk = 0;
        await Promise.allSettled(subs.map(async (s) => {
          let keys = null;
          try { keys = JSON.parse(s.keys_json); } catch { keys = null; }
          if (!keys) return;
          const status = await sendPush(this.env, { endpoint: s.endpoint, keys }, { title, body: text, url: '/' });
          if (status >= 200 && status < 300) pushOk++;
          if (status === 404 || status === 410) {
            this.sql().exec('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint);
          }
        }));
        if (notifId) {
          this.sql().exec(
            'UPDATE notifications SET push_attempted = ?, push_ok = ? WHERE id = ?',
            subs.length, pushOk, notifId
          );
        }
        this.audit(adminPhone, 'notify', targetPhone, title);
        return json({ stored: true, pushAttempted: subs.length, pushOk });
      }

      if (path === '/api/admin/history' && method === 'GET') {
        const rows = this.sql().exec(
          'SELECT * FROM notifications ORDER BY id DESC LIMIT 50'
        ).toArray();
        return json({
          history: rows.map((r) => ({
            id: r.id, title: r.title, body: r.body, target: r.target_phone,
            pushAttempted: r.push_attempted, pushOk: r.push_ok, createdAt: r.created_at,
          })),
        });
      }

      // ---- leaderboard control (via the LeaderboardDO binding)
      if (path === '/api/admin/leaderboard' && method === 'GET') {
        const res = await boardStub().fetch('https://board.internal/internal/list');
        const data = await res.json().catch(() => ({ entries: [] }));
        return json({ entries: data.entries || [] });
      }
      if (path === '/api/admin/leaderboard/remove' && method === 'POST') {
        const body = await this.readBody(request);
        const name = String((body && body.name) || '');
        if (!name) return json({ error: 'name required' }, 400);
        await boardStub().fetch('https://board.internal/internal/remove', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        this.audit(adminPhone, 'leaderboard-remove', name, null);
        return json({ ok: true });
      }
      if (path === '/api/admin/leaderboard/reset' && method === 'POST') {
        await boardStub().fetch('https://board.internal/internal/reset', { method: 'POST' });
        this.audit(adminPhone, 'leaderboard-reset', null, null);
        return json({ ok: true });
      }

      // ---- live rooms
      if (path === '/api/admin/rooms' && method === 'GET') {
        const rows = this.sql().exec(
          'SELECT * FROM rooms WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 100',
          Date.now() - 10 * 60 * 1000
        ).toArray();
        return json({
          rooms: rows.map((r) => ({
            code: r.code, mode: r.mode, hostName: r.host_name,
            seats: r.seats, phase: r.phase, updatedAt: r.updated_at,
          })),
        });
      }
      if (path === '/api/admin/rooms/close' && method === 'POST') {
        const body = await this.readBody(request);
        const code = String((body && body.code) || '').toUpperCase();
        if (!code) return json({ error: 'code required' }, 400);
        const stub = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(code));
        await stub.fetch('https://room.internal/admin-close', { method: 'POST' }).catch(() => null);
        this.sql().exec('DELETE FROM rooms WHERE code = ?', code);
        this.audit(adminPhone, 'room-close', code, null);
        return json({ ok: true });
      }

      // ---- site settings
      if (path === '/api/admin/settings' && method === 'GET') {
        return json({
          announcement: this.getSetting('announcement') || '',
          maintenance: this.maintenanceOn(),
          aboutText: this.getSetting('about_text') || DEFAULT_ABOUT_TEXT,
        });
      }
      if (path === '/api/admin/settings' && method === 'POST') {
        const body = await this.readBody(request);
        if (!body) return json({ error: 'bad json' }, 400);
        const changes = [];
        if (typeof body.announcement === 'string') {
          this.setSetting('announcement', body.announcement.slice(0, 300));
          changes.push('announcement');
        }
        if (typeof body.aboutText === 'string') {
          this.setSetting('about_text', body.aboutText.slice(0, 4000));
          changes.push('about_text');
        }
        if (body.maintenance !== undefined) {
          this.setSetting('maintenance', body.maintenance ? '1' : '0');
          changes.push('maintenance=' + (body.maintenance ? 'on' : 'off'));
        }
        this.audit(adminPhone, 'settings', null, changes.join(', '));
        return json({
          ok: true,
          announcement: this.getSetting('announcement') || '',
          maintenance: this.maintenanceOn(),
          aboutText: this.getSetting('about_text') || DEFAULT_ABOUT_TEXT,
        });
      }

      // ---- audit log
      if (path === '/api/admin/audit' && method === 'GET') {
        const rows = this.sql().exec(
          'SELECT * FROM admin_audit ORDER BY id DESC LIMIT 100'
        ).toArray();
        return json({
          audit: rows.map((r) => ({
            id: r.id, admin: r.admin_phone, action: r.action,
            target: r.target, detail: r.detail, createdAt: r.created_at,
          })),
        });
      }

      return json({ error: 'not found' }, 404);
    }

    return json({ error: 'not found' }, 404);
  }
}
