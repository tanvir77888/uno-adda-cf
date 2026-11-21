#!/usr/bin/env bash
# Local verification for the Cloudflare port:
#   1. boots `wrangler dev` on a scratch port
#   2. runs the adapted smoke test and voice-signal test against it
#   3. runs the engine stress test against the ported engine (src/game.js)
set -u
cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
export BASE_URL="http://127.0.0.1:${PORT}"
export WRANGLER_SEND_METRICS=false
export CI=true

npx wrangler dev --port "${PORT}" --ip 127.0.0.1 > /tmp/uno-adda-cf-wrangler.log 2>&1 &
WPID=$!
trap 'kill ${WPID} 2>/dev/null' EXIT

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
node test/smoke.js || fail=1
node test/voice-signal.js || fail=1
node test/engine-stress.js || fail=1
node test/v3.js || fail=1
node test/accounts.js || fail=1
node test/friends-e2e.js || fail=1
node test/client-v3.js || fail=1

if [ "${fail}" = "0" ]; then echo "LOCAL VERIFICATION: ALL SUITES PASSED"; else echo "LOCAL VERIFICATION: FAILURES (see above)"; fi
exit ${fail}
