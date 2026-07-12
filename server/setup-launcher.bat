@echo off
setlocal
rem One-time setup: registers the shortscraping:// protocol (current user only,
rem no admin required) so the extension popup can open the server folder and
rem start the sync service with one click. Undo with remove-launcher.bat.

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "LAUNCHER=%SCRIPT_DIR%\launcher.vbs"

if not exist "%LAUNCHER%" (
  echo [ShortScraping] launcher.vbs was not found next to this script.
  pause
  exit /b 1
)

reg add "HKCU\Software\Classes\shortscraping" /ve /d "URL:ShortScraping Launcher" /f >nul
if errorlevel 1 goto :fail
reg add "HKCU\Software\Classes\shortscraping" /v "URL Protocol" /d "" /f >nul
if errorlevel 1 goto :fail
reg add "HKCU\Software\Classes\shortscraping\shell\open\command" /ve /d "wscript.exe \"%LAUNCHER%\" \"%%1\"" /f >nul
if errorlevel 1 goto :fail

echo [ShortScraping] Protocol shortscraping:// registered successfully.
echo   - Popup folder button opens: %SCRIPT_DIR%
echo   - Popup start button runs:   %SCRIPT_DIR%\start-sync.bat
echo   - Chrome asks for confirmation on first use; tick "Always allow" to skip it.
echo   - To undo, run remove-launcher.bat.
pause
exit /b 0

:fail
echo [ShortScraping] Failed to write registry keys under HKCU\Software\Classes.
pause
exit /b 1
