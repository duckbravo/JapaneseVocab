#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Local dev server for the Japanese Vocab site (macOS / Linux).
#  Windows equivalent: dev.cmd
#
#  Replaces VS Code "Live Server": this serves the static pages AND runs the
#  Cloudflare Pages Functions in functions/, so the /api/* routes that
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
  Static pages + /api/* Pages Functions, with live reload.

  URL:   $URL
  Stop:  Ctrl+C

EOF

# Refuse to start if something already holds the port. Killing wrangler can
# leave an orphaned workerd bound to 8788 that ACCEPTS connections but never
# answers - the browser then just hangs, which looks like "the site is broken"
# rather than "a stale server is in the way". Catch it up front.
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:8788 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  [!] Port 8788 is already in use — probably a leftover server."
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

# --compatibility-date is REQUIRED. With no wrangler config file in the repo,
# wrangler defaults it to TODAY, and if that's newer than the bundled workerd
# binary supports, the runtime refuses to start with:
#   "This Worker requires compatibility date X, but the newest date supported
#    by this server binary is Y"
# If you hit that after upgrading wrangler, bump the date below. Any date the
# binary supports works; older is always safe.
exec npx --yes wrangler@latest pages dev . \
  --kv LLM_KEYS \
  --compatibility-date=2026-08-08 \
  --port 8788 \
  --live-reload \
  "$@"
