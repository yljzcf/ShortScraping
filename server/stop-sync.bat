@echo off
setlocal

set "PORT=31919"
set "HEALTH_URL=http://127.0.0.1:%PORT%/health"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$connections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue;" ^
  "if (-not $connections) { Write-Host '[ShortScraping Sync] Service is not running.'; exit 0 }" ^
  "$pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique;" ^
  "foreach ($pidValue in $pids) {" ^
  "  $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue;" ^
  "  if ($proc -and $proc.ProcessName -eq 'node') {" ^
  "    Write-Host ('[ShortScraping Sync] Stopping node process PID ' + $pidValue + ' on port %PORT%...');" ^
  "    Stop-Process -Id $pidValue -Force;" ^
  "  } elseif ($proc) {" ^
  "    Write-Host ('[ShortScraping Sync] Port %PORT% is owned by non-node process: ' + $proc.ProcessName + ' PID ' + $pidValue);" ^
  "    exit 2;" ^
  "  }" ^
  "}"

if errorlevel 2 (
  echo [ShortScraping Sync] Stop skipped because port %PORT% is not owned by node.exe.
  pause
  exit /b 2
)

timeout /t 1 /nobreak >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri '%HEALTH_URL%' -TimeoutSec 2; if ($r.ok) { exit 1 } exit 0 } catch { exit 0 }" >nul 2>nul
if errorlevel 1 (
  echo [ShortScraping Sync] Stop command was sent, but service still responds at %HEALTH_URL%.
  pause
  exit /b 1
)

echo [ShortScraping Sync] Service stopped.
pause
exit /b 0
