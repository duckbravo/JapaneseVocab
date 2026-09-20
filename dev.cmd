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

REM ---------------------------------------------------------------------------
REM  Where the local KV lives.
REM
REM  NOT %TEMP%. That is where this used to be, and it is where Windows Storage
REM  Sense and Disk Cleanup both delete files on a schedule - which silently
REM  wipes the simulated KV namespace and takes your saved LLM API key with it.
REM  The symptom is "I have to re-enter my API key every time I open localhost",
REM  and it never happens on the deployed site because that uses real Cloudflare
REM  KV, which nothing cleans.
REM
REM  %LOCALAPPDATA% is the per-user data location Windows itself uses for
REM  exactly this kind of state, is never auto-cleaned, and is still OUTSIDE the
REM  repo - which matters, because state inside the repo causes the endless
REM  reload loop described below.
REM ---------------------------------------------------------------------------
set "STATE_DIR=%LOCALAPPDATA%\japanesevocab\wrangler-state"
set "OLD_STATE_DIR=%TEMP%\japanesevocab-wrangler-state"

if not exist "%LOCALAPPDATA%\japanesevocab" mkdir "%LOCALAPPDATA%\japanesevocab" >nul 2>&1

REM One-time migration, so a key saved under the old location survives the move.
REM
REM The test is "does the new location have KV DATA yet", NOT "does the
REM directory exist". Anything that starts wrangler at the new path - a manual
REM `wrangler dev --persist-to`, a tool, a crashed run - creates the directory
REM without any KV in it, and a directory-exists check then skips the migration
REM forever, silently stranding the key in the old store. That happened.
REM
REM COPY rather than move, so the old store stays as a backup; it lives in
REM %TEMP% and will be cleaned up by Windows on its own schedule.
if not exist "%STATE_DIR%\v3\kv" (
  if exist "%OLD_STATE_DIR%\v3\kv" (
    echo   Moving local dev state out of the temp folder so Windows stops
    echo   deleting it. Your saved API key comes with it.
    echo.
    xcopy "%OLD_STATE_DIR%" "%STATE_DIR%" /E /I /Y /Q >nul 2>&1
  )
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
npx --yes wrangler@latest dev --port 8788 --live-reload --persist-to "%STATE_DIR%" %*

REM Keep the window open if wrangler exited because of an error, so the message
REM is readable when this was launched by double-clicking.
if errorlevel 1 (
  echo.
  echo   Server exited with an error - see above.
  pause
)

endlocal
