@echo off
setlocal
rem Stops the sync service through server\tools\stop.js, the same helper used by
rem npm run stop and stop-sync.command: it asks this service to exit gracefully
rem via POST /shutdown and never scans the port or kills other processes.
rem Pass --no-pause to skip the key prompt.
set "SKIP_PAUSE=%~1"

where node >nul 2>nul
if errorlevel 1 (
  echo [ShortScraping Sync] Node.js was not found in PATH.
  echo Please install Node.js or add node.exe to PATH, then run this file again.
  if /I not "%SKIP_PAUSE%"=="--no-pause" pause
  exit /b 1
)

rem Run from the project root so this works no matter where it was started from.
cd /d "%~dp0..\.."
if errorlevel 1 (
  echo [ShortScraping Sync] Failed to enter the project folder.
  if /I not "%SKIP_PAUSE%"=="--no-pause" pause
  exit /b 1
)

node server\tools\stop.js
set "EXIT_CODE=%ERRORLEVEL%"
if /I not "%SKIP_PAUSE%"=="--no-pause" pause
exit /b %EXIT_CODE%
