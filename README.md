# UNO Adda — Cloudflare Workers + Durable Objects port

A free, clean-room UNO-style card game: play vs bots or in private rooms
with friends, with WebRTC voice chat. Original code and artwork; not
affiliated with Mattel.

This is the Cloudflare port of the Node version in `~/workspace/uno-adda-v2/`
(which stays untouched). Same game, same wire protocol, same client — only
the hosting shape changed, because Cloudflare's free plan is permanent and
needs no card.

## Architecture

```
Browser ──HTTP──▶ Worker (src/worker.js) ──▶ [assets] binding serves public/
Browser ──WSS───▶ Worker ──▶ GameRoom Durable Object (one per room code)
```

- **Worker** (`src/worker.js`) — serves the static client via the Workers
  static-assets binding, answers `/health`, and routes WebSocket upgrades:
  `/ws` mints a fresh room code (create flows); `/ws/<CODE>` routes to the
  Durable Object named `<CODE>` (join / reconnect).
- **GameRoom Durable Object** (`src/room.js`) — one instance per room. It is
  the Node `server.js` room layer re-hosted: seats, lobby, bots, chat,
  scores, and the voice-signaling relay. Sockets use the WebSocket
  Hibernation API; room state is plain JSON persisted to DO storage after
  every change, so a room survives the object being evicted (the Node
  version lost rooms on process restart).
- **Engine** (`src/game.js`) — the original pure-JS rules engine, byte-for-
  byte identical logic; only `module.exports` became ESM named exports.
  Stacking, +4 challenge, UNO call/catch, 7 cards, All Wild, 2v2 teams and
  scoring to 500 all live here and are unchanged.
- **Timers** — the Node version's `setTimeout` turn/bot timers and the
  `setInterval` UNO-catch sweep are replaced by a single Durable Object
  alarm, always set to the earliest pending deadline (bot move ~1s, catch
  sweep 1.5s, turn timeout 30s). Alarms are durable and wake the object.
- **Client** (`public/`) — same wire protocol and message flow as the Node
  version; the socket connects to `/ws` to create and `/ws/<CODE>` to
  join/restore, so the Worker can route to the right object. The WebRTC
  voice code is unchanged. On top of that sits a presentation layer
  (2026-11-21 visual overhaul): glossy CSS card art, an oval table with
  players seated around it, snapshot-diff animations (deal / play / draw,
  UNO pop, win confetti) and WebAudio-synthesized sound effects with a
  mute toggle — all in `public/`, no server or protocol changes.
  Screenshots: `design-preview/`.

## Run locally

```bash
npm install
npm test          # boots `wrangler dev`, runs smoke + voice + engine suites
# or by hand:
npx wrangler dev  # http://localhost:8787
```

Tests (adapted from the Node version, same check names):

- `test/smoke.js` — 12 checks: health/home, bot game, room create/join/
  ready/start, game progress. Targets `BASE_URL` (default
  `http://127.0.0.1:8787`) instead of spawning a server.
- `test/voice-signal.js` — 7 checks: voice roster/relay inside a room;
  cross-room signals are undeliverable by construction (separate objects).
- `test/engine-stress.js` — 480 full rounds against the ported engine,
  asserting 108 cards conserved at every step.
- `test/run-local.sh` — the harness `npm test` runs.

## Deploy (later — needs Tanvir's Cloudflare account)

Free plan throughout: Workers free tier + SQLite-backed Durable Objects
(`new_sqlite_classes` in `wrangler.toml`, the free-plan DO class type).

```bash
npx wrangler login   # one-time, opens the browser for Cloudflare OAuth
npx wrangler deploy
```

`wrangler deploy` prints the live URL (`https://uno-adda.<account>.workers.dev`
unless a custom domain is attached). No build step, no environment variables,
no paid services: voice audio is peer-to-peer WebRTC (public Google STUN,
same as before — no TURN, so very strict NATs can still block audio between
two phones; the game itself is unaffected).
