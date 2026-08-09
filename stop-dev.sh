#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Stops any local dev server left running (macOS/Linux). Windows: stop-dev.cmd
#
#  Why this exists: killing wrangler's terminal doesn't always take its child
#  workerd process with it. An orphaned workerd stays bound to port 8788 and
#  ACCEPTS connections but never answers them, so the browser just spins and the
#  site looks broken. Normal Ctrl+C is fine; this is the "it's wedged" fix.
# ---------------------------------------------------------------------------
set -uo pipefail

PORT=8788

echo
echo "  Stopping local dev servers (wrangler / workerd)..."
echo

if command -v lsof >/dev/null 2>&1; then
  pids=$(lsof -t -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)
  for pid in $pids; do
    echo "   stopped pid $pid (was holding port $PORT)"
    kill -9 "$pid" 2>/dev/null || true
  done
fi

# Catch wrangler/workerd processes that aren't holding the port but would
# interfere on the next run.
pkill -f 'wrangler pages dev' 2>/dev/null && echo "   stopped wrangler pages dev"
pkill -f 'workerd' 2>/dev/null && echo "   stopped workerd"

sleep 1

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo
  echo "  [!] Something is STILL listening on port $PORT."
  echo "      It isn't wrangler, so find it with:  lsof -nP -iTCP:$PORT -sTCP:LISTEN"
  exit 1
fi

echo
echo "  Port $PORT is free. You can run ./dev.sh again."
echo
