@echo off
REM ---------------------------------------------------------------------------
REM  Stops any local dev server left running (Windows). macOS/Linux: stop-dev.sh
REM
REM  Why this exists: killing wrangler's terminal doesn't always take its child
REM  workerd.exe with it. An orphaned workerd stays bound to port 8788 and
REM  ACCEPTS connections but never answers them, so the browser just spins and
REM  the site looks broken. Normal Ctrl+C is fine; this is the "it's wedged" fix.
REM ---------------------------------------------------------------------------
setlocal

echo.
echo   Stopping local dev servers (wrangler / workerd)...
echo.

REM Only single quotes inside the PowerShell string, so nothing needs escaping
REM for cmd. Get-CimInstance (not Get-Process) because Windows PowerShell 5.1's
REM Get-Process has no CommandLine property. Playwright is excluded so this
REM never kills an unrelated Node tool.
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|workerd' -and $_.CommandLine -match 'wrangler|workerd' -and $_.CommandLine -notmatch 'playwright' } | ForEach-Object { Write-Host ('   stopped pid ' + $_.ProcessId + ' (' + $_.Name + ')'); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

REM Full path: a bare "timeout" resolves to GNU coreutils' timeout (which takes
REM different arguments) when this runs from a Git Bash shell.
"%SystemRoot%\System32\timeout.exe" /t 2 /nobreak >nul 2>&1

netstat -ano | findstr /r /c:"TCP.*:8788 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Port 8788 is free. You can run dev.cmd again.
) else (
  echo.
  echo   [!] Something is STILL listening on port 8788.
  echo       It isn't wrangler, so find it with:  netstat -ano ^| findstr :8788
)

echo.
pause
endlocal
