/*
 * UNO Adda — Leaderboard Durable Object (singleton, addressed as "global").
 *
 * Stores cumulative player stats submitted by clients after bot / quick
 * matches: { name, avatar, wins, coinsWon }. One row per player name
 * (case-insensitive). Values are clamped hard — this is a friendly,
 * honor-system board for a free game, not a secure ranking.
 *
 * HTTP contract (routed by the Worker at /api/leaderboard):
 *   POST {name, avatar, wins, coinsWon}  -> { ok: true }
 *   GET                                  -> { entries: [top 20] }
 * Entries are ordered by coinsWon desc, then wins desc.
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

export class LeaderboardDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS entries (
           name TEXT COLLATE NOCASE PRIMARY KEY,
           avatar INTEGER NOT NULL DEFAULT 0,
           wins INTEGER NOT NULL DEFAULT 0,
           coins INTEGER NOT NULL DEFAULT 0,
           updated INTEGER NOT NULL DEFAULT 0
         )`
      );
      // Optional profile photo (small JPEG data URL), added with accounts.
      try { ctx.storage.sql.exec('ALTER TABLE entries ADD COLUMN photo TEXT'); } catch { /* column already there */ }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    // Internal admin routes — reachable ONLY through the DO binding
    // (the Worker never routes these paths publicly).
    if (url.pathname === '/internal/list' && request.method === 'GET') {
      const rows = this.ctx.storage.sql
        .exec('SELECT name, avatar, wins, coins, photo FROM entries ORDER BY coins DESC, wins DESC, updated ASC LIMIT 50')
        .toArray();
      return json({
        entries: rows.map((r) => ({ name: r.name, avatar: r.avatar, wins: r.wins, coinsWon: r.coins, photo: r.photo || null })),
      });
    }
    if (url.pathname === '/internal/remove' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const name = String((body && body.name) || '').trim();
      if (name) this.ctx.storage.sql.exec('DELETE FROM entries WHERE name = ?', name);
      return json({ ok: true });
    }
    if (url.pathname === '/internal/reset' && request.method === 'POST') {
      this.ctx.storage.sql.exec('DELETE FROM entries');
      return json({ ok: true });
    }
    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad json' }, 400);
      }
      const name = String((body && body.name) || '').trim().slice(0, 20);
      if (!name) return json({ error: 'name required' }, 400);
      const avatar = clampInt(body.avatar, 0, 3, 0);
      const wins = clampInt(body.wins, 0, 100000, 0);
      const coins = clampInt(body.coinsWon, 0, 10000000, 0);
      // Optional: the player's profile photo (small JPEG data URL). Only a
      // plausible photo replaces the stored one; absence keeps the old one.
      const photo = typeof body.photo === 'string' && body.photo.startsWith('data:image/jpeg') && body.photo.length <= 60000
        ? body.photo
        : null;
      // Clients send cumulative totals, so an upsert replaces the row.
      this.ctx.storage.sql.exec(
        `INSERT INTO entries (name, avatar, wins, coins, updated, photo) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           avatar = excluded.avatar, wins = excluded.wins,
           coins = excluded.coins, updated = excluded.updated,
           photo = COALESCE(excluded.photo, entries.photo)`,
        name, avatar, wins, coins, Date.now(), photo
      );
      return json({ ok: true });
    }
    if (request.method === 'GET') {
      const rows = this.ctx.storage.sql
        .exec('SELECT name, avatar, wins, coins, photo FROM entries ORDER BY coins DESC, wins DESC, updated ASC LIMIT 20')
        .toArray();
      return json({
        entries: rows.map((r) => ({ name: r.name, avatar: r.avatar, wins: r.wins, coinsWon: r.coins, photo: r.photo || null })),
      });
    }
    return json({ error: 'method not allowed' }, 405);
  }
}
