#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Local dev server for the Japanese Vocab site (macOS / Linux).
#  Windows equivalent: dev.cmd
#
#  Replaces VS Code "Live Server": this serves the static pages AND runs the
#  Worker in worker.js, so the /api/* routes that
#  account-settings.html depends on actually work. Live Server 404s on those.
#
#  Run with:  ./dev.sh        (or  bash dev.sh  if the exec bit is missing)
#  Extra arguments pass through, e.g.  ./dev.sh --port 3000
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")"

URL="http://localhost:8788"

cat <<EOF

  Japanese Vocab - local dev server
  ---------------------------------
  Static pages + /api/* Worker routes, with live reload.

  URL:   $URL
  Stop:  Ctrl+C

EOF

# Refuse to start if something already holds the port. Killing wrangler can
# leave an orphaned workerd bound to 8788 that ACCEPTS connections but never
# answers - the browser then just hangs, which looks like "the site is broken"
# rather than "a stale server is in the way". Catch it up front.
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:8788 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  [!] Port 8788 is already in use â€” probably a leftover server."
  echo "      If the page just spins and never loads, that stale process is why."
  echo
  echo "      Fix it by running:   ./stop-dev.sh"
  echo "      Then run this script again."
  echo
  exit 1
fi

echo "  Starting (first run downloads wrangler, which takes a minute)..."
echo

# Open a browser once the server has had a moment to boot. Detached so it
# never blocks or kills the server.
(
  sleep 8
  if command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
  fi
) >/dev/null 2>&1 &

# Where the local KV lives.
#
# NOT /tmp. That is where this used to be, and most systems clear /tmp on
# reboot (and macOS prunes it after a few days), which silently wipes the
# simulated KV namespace and takes your saved LLM API key with it. The symptom
# is "I have to re-enter my API key every time I start the dev server", and it
# never happens on the deployed site because that uses real Cloudflare KV, which
# nothing cleans.
#
# XDG_STATE_HOME is the standard location for exactly this kind of
# persist-across-runs state, and is still OUTSIDE the repo - which matters,
# because state inside the repo causes the endless reload loop described below.
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/japanesevocab/wrangler-state"
OLD_STATE_DIR="${TMPDIR:-/tmp}/japanesevocab-wrangler-state"

mkdir -p "$(dirname "$STATE_DIR")"

# One-time migration, so a key saved under the old location survives the move.
#
# The test is "does the new location have KV DATA yet", NOT "does the directory
# exist". Anything that starts wrangler at the new path - a manual
# `wrangler dev --persist-to`, a tool, a crashed run - creates the directory
# without any KV in it, and a directory-exists check then skips the migration
# forever, silently stranding the key in the old store. That happened.
#
# COPY rather than move, so the old store stays as a backup.
if [ ! -d "$STATE_DIR/v3/kv" ] && [ -d "$OLD_STATE_DIR/v3/kv" ]; then
  echo "  Moving local dev state out of the temp folder so it stops being"
  echo "  deleted. Your saved API key comes with it."
  echo
  mkdir -p "$STATE_DIR"
  cp -a "$OLD_STATE_DIR/." "$STATE_DIR/"
fi

# Settings now come from wrangler.jsonc (name, main, assets, KV binding,
# compatibility_date), so no flags are needed for those.
#
# --persist-to is REQUIRED, and not an optimisation. The assets directory is the
# repo root, so wrangler watches the whole repo - including .wrangler/, where
# miniflare continuously writes its own SQLite state. That write is seen as an
# asset change, which triggers a reload, which writes more state: an endless
# reload loop where the server never becomes reachable (observed: 609 reloads in
# a couple of minutes, every request timing out). Keeping that state outside the
# watched tree breaks the cycle.
exec npx --yes wrangler@latest dev \
  --port 8788 \
  --live-reload \
  --persist-to "$STATE_DIR" \
  "$@"
