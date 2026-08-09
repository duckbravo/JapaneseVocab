@echo off
REM ---------------------------------------------------------------------------
REM  Local dev server for the Japanese Vocab site.
REM
REM  Replaces VS Code "Live Server": this serves the static pages AND runs the
REM  Cloudflare Pages Functions in functions/, so the /api/* routes that
REM  account-settings.html depends on actually work. Live Server 404s on those.
REM
REM  Double-click this file, or run  .\dev  in a terminal.
REM  Extra arguments are passed through, e.g.  .\dev --port 3000
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

echo.
echo   Japanese Vocab - local dev server
echo   ---------------------------------
echo   Static pages + /api/* Pages Functions, with live reload.
echo.
echo   URL:   http://localhost:8788
echo   Stop:  Ctrl+C  (then Y)
echo.

REM Refuse to start if something already holds the port. Killing wrangler can
REM leave an orphaned workerd.exe bound to 8788 that ACCEPTS connections but
REM never answers - the browser then just hangs, which looks like "the site is
REM broken" rather than "a stale server is in the way". Catch it up front.
netstat -ano | findstr /r /c:"TCP.*:8788 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo   [!] Port 8788 is already in use.
  echo.
  echo       This is usually a leftover server from a previous run. If the page
  echo       just spins and never loads, that stale process is why.
  echo.
  echo       Fix it by running:   stop-dev.cmd
  echo       Then run this script again.
  echo.
  pause
  exit /b 1
)

echo   Starting (first run downloads wrangler, which takes a minute)...
echo.

REM Open a browser once the server has had a moment to boot. Detached so it
REM doesn't block the server itself.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 8; Start-Process 'http://localhost:8788'"

REM --compatibility-date is REQUIRED. With no wrangler config file in the repo,
REM wrangler defaults it to TODAY, and if that's newer than the bundled workerd
REM binary supports, the runtime refuses to start with:
REM   "This Worker requires compatibility date X, but the newest date supported
REM    by this server binary is Y"
REM If you hit that after upgrading wrangler, bump the date below. Any date the
REM binary supports works; older is always safe.
npx --yes wrangler@latest pages dev . --kv LLM_KEYS --compatibility-date=2026-08-08 --port 8788 --live-reload %*

REM Keep the window open if wrangler exited because of an error, so the message
REM is readable when this was launched by double-clicking.
if errorlevel 1 (
  echo.
  echo   Server exited with an error - see above.
  pause
)

endlocal
