@echo off
REM ---------------------------------------------------------------------------
REM  Local dev server for the Japanese Vocab site.
REM
REM  Replaces VS Code "Live Server": this serves the static pages AND runs the
REM  Worker in worker.js, so the /api/* routes that account-settings.html
REM  depends on actually work. Live Server 404s on those.
REM
REM  Double-click this file, or run  .\dev  in a terminal.
REM  Extra arguments are passed through, e.g.  .\dev --port 3000
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

echo.
echo   Japanese Vocab - local dev server
echo   ---------------------------------
echo   Static pages + /api/* Worker routes, with live reload.
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

REM Settings now come from wrangler.jsonc (name, main, assets, KV binding,
REM compatibility_date), so no flags are needed for those.
REM
REM --persist-to is REQUIRED, and not an optimisation. The assets directory is
REM the repo root, so wrangler watches the whole repo - including .wrangler/,
REM where miniflare continuously writes its own SQLite state. That write is seen
REM as an asset change, which triggers a reload, which writes more state: an
REM endless reload loop where the server never becomes reachable (observed: 609
REM reloads in a couple of minutes, every request timing out). Keeping that state
REM outside the watched tree breaks the cycle.
npx --yes wrangler@latest dev --port 8788 --live-reload --persist-to "%TEMP%\japanesevocab-wrangler-state" %*

REM Keep the window open if wrangler exited because of an error, so the message
REM is readable when this was launched by double-clicking.
if errorlevel 1 (
  echo.
  echo   Server exited with an error - see above.
  pause
)

endlocal
