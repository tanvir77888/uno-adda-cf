#!/usr/bin/env bash
# Local verification for the Cloudflare port:
#   phase 1: `wrangler dev` on 8787 with MATCH_TIMEOUT_MS shrunk (6s)
#            and a test ADMIN_PHONE, running every suite;
#   phase 2: a second instance on 8789 with UNO_BOT_THINK_MS=60000 —
#            the inline-bot regression proves bots move without the
#            alarm path (production bots took 19–39s/move through it).
# Test state is wiped first: several suites (leaderboard, accounts)
# assert on a fresh world.
set -u
cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
export BASE_URL="http://127.0.0.1:${PORT}"
export WRANGLER_SEND_METRICS=false
export CI=true

# A stale `wrangler dev` on the same port would keep serving (and its
# state dir must not be wiped from under it) — stop it first. Killing
# the npx wrapper is NOT enough: the workerd child survives it, keeps
# the port bound, and then answers /health while its (just-deleted)
# SQLite files fail every DO request with SQLITE_CANTOPEN. So kill by
# LISTENING PORT and wait until the port is actually free.
kill_port() {
  local p="$1" pid i
  pid=$(ss -ltnp 2>/dev/null | grep ":${p} " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  [ -n "${pid}" ] && kill -9 "${pid}" 2>/dev/null
  for i in $(seq 1 20); do
    ss -ltn 2>/dev/null | grep -q ":${p} " || return 0
    sleep 0.5
  done
}
kill_port "${PORT}"
kill_port 8789
rm -rf .wrangler/state /tmp/uno-adda-phase2

npx wrangler dev --port "${PORT}" --ip 127.0.0.1 \
  --var MATCH_TIMEOUT_MS:6000 --var ADMIN_PHONE:01711111111 \
  > /tmp/uno-adda-cf-wrangler.log 2>&1 &
WPID=$!
trap 'kill ${WPID} 2>/dev/null; kill_port "${PORT}" 2>/dev/null; kill_port 8789 2>/dev/null' EXIT

up=0
for i in $(seq 1 60); do
  if curl -sf "${BASE_URL}/health" > /dev/null 2>&1; then up=1; break; fi
  sleep 1
done
if [ "${up}" != "1" ]; then
  echo "wrangler dev did not come up — log tail:"
  tail -20 /tmp/uno-adda-cf-wrangler.log
  exit 1
fi

fail=0
node test/push-crypto.js || fail=1
node test/cross-stack.js || fail=1
node test/smoke.js || fail=1
node test/voice-signal.js || fail=1
node test/engine-stress.js || fail=1
node test/v3.js || fail=1
node test/accounts.js || fail=1
node test/friends-e2e.js || fail=1
node test/ready-mirror.js || fail=1
node test/matchmaking.js || fail=1
node test/snapshot-diet.js || fail=1
node test/admin.js || fail=1
node test/client-v3.js || fail=1

# ------------------------------------------------------------ phase 2
kill ${WPID} 2>/dev/null; wait ${WPID} 2>/dev/null
kill_port "${PORT}"
PORT2=8789
kill_port "${PORT2}"
npx wrangler dev --port "${PORT2}" --ip 127.0.0.1 \
  --persist-to /tmp/uno-adda-phase2 \
  --var UNO_BOT_THINK_MS:60000 \
  > /tmp/uno-adda-cf-wrangler2.log 2>&1 &
WPID=$!
up=0
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT2}/health" > /dev/null 2>&1; then up=1; break; fi
  sleep 1
done
if [ "${up}" != "1" ]; then
  echo "phase-2 wrangler dev did not come up — log tail:"
  tail -20 /tmp/uno-adda-cf-wrangler2.log
  fail=1
else
  BASE_URL="http://127.0.0.1:${PORT2}" node test/inline-bots.js || fail=1
fi

if [ "${fail}" = "0" ]; then echo "LOCAL VERIFICATION: ALL SUITES PASSED"; else echo "LOCAL VERIFICATION: FAILURES (see above)"; fi
exit ${fail}
