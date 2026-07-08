@echo off
setlocal

call "%~dp0stop-sync.bat"
if errorlevel 2 exit /b 2

call "%~dp0start-sync.bat"
