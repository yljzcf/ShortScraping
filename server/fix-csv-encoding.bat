@echo off
setlocal

for %%I in ("%~dp0..") do set "PROJECT_DIR=%%~fI"
set "CSV_PATH=%PROJECT_DIR%\db\timeline.csv"

if not exist "%CSV_PATH%" (
  echo [ShortScraping Sync] CSV file was not found: %CSV_PATH%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$path = '%CSV_PATH%';" ^
  "$text = Get-Content -LiteralPath $path -Raw -Encoding UTF8;" ^
  "$text = $text -replace \"`r`n|`r|`n\", \"`r`n\";" ^
  "$utf8Bom = New-Object System.Text.UTF8Encoding($true);" ^
  "[System.IO.File]::WriteAllText($path, $text, $utf8Bom);" ^
  "Write-Host ('[ShortScraping Sync] Rewrote CSV as UTF-8 with BOM: ' + $path);"

pause
exit /b 0
