/*
 * UNO Adda — Cloudflare Worker entry point.
 *
 * - Static client (index.html / style.css / app.js) is served from the
 *   [assets] binding (./public).
 * - /health answers directly (same contract as the Node server).
 * - WebSocket upgrades are routed to one Durable Object per room:
 *     /ws          -> a fresh room code is generated (create flows)
 *     /ws/<CODE>   -> the Durable Object named <CODE> (join / reconnect)
 *   The client protocol itself is unchanged from the Node version.
 */
import { GameRoom } from './room.js';
import { LeaderboardDO } from './leaderboard.js';
import { AccountsDO } from './accounts.js';
import { MatchmakerDO } from './matchmaker.js';

export { GameRoom, LeaderboardDO, AccountsDO, MatchmakerDO };

const STUN_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

// GET /api/turn-credentials -> { iceServers } for WebRTC voice.
// STUN (Google) is always included. When the TURN_KEY_ID /
// TURN_KEY_API_TOKEN secrets are configured, short-lived Cloudflare
// TURN credentials are generated server-side and appended — symmetric
// NATs (common on mobile data) cannot punch through STUN alone, which
// is the classic "signaling works, no audio" failure. Any failure
// (secrets absent, API down) degrades quietly to STUN-only.
async function turnCredentials(env) {
  const iceServers = STUN_SERVERS.slice();
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const res = await fetch(
        'https://rtc.live.cloudflare.com/v1/turn/keys/' + env.TURN_KEY_ID + '/credentials/generate',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + env.TURN_KEY_API_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 3600 }),
        });
      if (res.ok) {
        const data = await res.json();
        if (data && data.iceServers) iceServers.push(data.iceServers);
      }
    } catch { /* STUN-only fallback */ }
  }
  return new Response(JSON.stringify({ iceServers }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
    }

    if (url.pathname === '/api/leaderboard') {
      const stub = env.BOARD.get(env.BOARD.idFromName('global'));
      return stub.fetch(request);
    }

    // Accounts (singleton DO): auth, wallet, stats, notifications,
    // web push, site settings and the admin control center.
    if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/wallet/') ||
        url.pathname.startsWith('/api/stats/') || url.pathname.startsWith('/api/admin/') ||
        url.pathname.startsWith('/api/notifications') || url.pathname.startsWith('/api/push/') ||
        url.pathname === '/api/settings') {
      const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts'));
      return stub.fetch(request);
    }

    if (url.pathname === '/api/turn-credentials' && request.method === 'GET') {
      return turnCredentials(env);
    }

    // Live matchmaking (singleton DO): the client opens this socket,
    // sends find_match, and is handed a room code + join ticket.
    if (url.pathname === '/ws-match') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      const stub = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('matchmaker'));
      return stub.fetch(request);
    }

    if (url.pathname === '/ws' || url.pathname.startsWith('/ws/')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      const code = url.pathname === '/ws'
        ? randomCode()
        : url.pathname.slice('/ws/'.length).toUpperCase();
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
