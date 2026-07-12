@echo off
setlocal

call "%~dp0stop-sync.bat" --no-pause
if errorlevel 2 exit /b 2

call "%~dp0..\start-sync.bat"
