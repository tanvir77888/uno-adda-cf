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

export { GameRoom };

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
