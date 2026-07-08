@echo off
setlocal

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
echo [ShortScraping Sync] This window keeps the service running. Close it to stop the service.
node server\sync-server.js
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo [ShortScraping Sync] Service stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
