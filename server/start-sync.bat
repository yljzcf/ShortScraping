@echo off
setlocal
rem Runs the sync service in this window: close it or press Ctrl+C to stop.
rem The extension popup's restart button hands over to a new hidden background
rem instance: node in this window exits, the service keeps running and writes its
rem output to logs\sync.log in the project folder. From then on closing this
rem window does not stop it; use the popup's stop button or tools\stop-sync.bat.

for %%I in ("%~dp0..") do set "PROJECT_DIR=%%~fI"
set "SERVER_DIR=%PROJECT_DIR%\server"
set "PORT=31919"
set "HEALTH_URL=http://127.0.0.1:%PORT%/health"

where node >nul 2>nul
if errorlevel 1 (
  echo [ShortScraping Sync] Node.js was not found in PATH.
  echo Please install Node.js or add node.exe to PATH, then run this file again.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri '%HEALTH_URL%' -TimeoutSec 2; if ($r.ok) { exit 0 } exit 1 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo [ShortScraping Sync] Service is already running at %HEALTH_URL%.
  timeout /t 3 /nobreak >nul
  exit /b 0
)

cd /d "%PROJECT_DIR%"
if errorlevel 1 (
  echo [ShortScraping Sync] Failed to enter project directory: %PROJECT_DIR%
  pause
  exit /b 1
)

if not exist "%SERVER_DIR%\sync-server.js" (
  echo [ShortScraping Sync] sync-server.js was not found in %SERVER_DIR%.
  pause
  exit /b 1
)

echo [ShortScraping Sync] Starting local sync server...
echo [ShortScraping Sync] Close this window or press Ctrl+C to stop the service.
node server\sync-server.js
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo [ShortScraping Sync] Node process in this window exited with code %EXIT_CODE%.
rem Exit code 0 is either a stop or a restart handover from the popup; only errors need pause.
if not "%EXIT_CODE%"=="0" (
  pause
  exit /b %EXIT_CODE%
)
echo [ShortScraping Sync] If you clicked restart in the extension popup, the service is still running in the background.
echo [ShortScraping Sync] Log: %PROJECT_DIR%\logs\sync.log
echo [ShortScraping Sync] To stop it, use the popup's stop button or server\tools\stop-sync.bat.
timeout /t 15 >nul
exit /b 0
