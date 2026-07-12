@echo off
rem Removes the shortscraping:// protocol registration created by setup-launcher.bat.
reg delete "HKCU\Software\Classes\shortscraping" /f >nul 2>nul
if errorlevel 1 (
  echo [ShortScraping] Nothing to remove: shortscraping:// was not registered.
) else (
  echo [ShortScraping] Protocol registration removed.
)
pause
exit /b 0
