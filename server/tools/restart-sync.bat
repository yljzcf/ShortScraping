@echo off
setlocal
rem Restarts the sync service through server\tools\stop.js --restart, the same
rem helper used by npm run restart and restart-sync.command: it stops the running
rem instance gracefully via POST /shutdown (never kills other processes on the
rem port), then runs a new one in this window. Close it or press Ctrl+C to stop.

for %%I in ("%~dp0..\..") do set "PROJECT_DIR=%%~fI"

where node >nul 2>nul
if errorlevel 1 (
  echo [ShortScraping Sync] Node.js was not found in PATH.
  echo Please install Node.js or add node.exe to PATH, then run this file again.
  pause
  exit /b 1
)

rem Run from the project root so this works no matter where it was started from.
cd /d "%PROJECT_DIR%"
if errorlevel 1 (
  echo [ShortScraping Sync] Failed to enter the project folder.
  pause
  exit /b 1
)

echo [ShortScraping Sync] Restarting local sync server...
echo [ShortScraping Sync] Close this window or press Ctrl+C to stop the service.
node server\tools\stop.js --restart
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
