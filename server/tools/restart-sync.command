#!/usr/bin/env bash
# ShortScraping 同步服务 — macOS 双击重启
cd "$(dirname "$0")/../.." || exit 1
AGENT="gui/$(id -u)/com.shortscraping.sync"
if launchctl print "$AGENT" >/dev/null 2>&1; then
  launchctl kickstart -k "$AGENT" && echo "[ShortScraping] 已重启后台同步服务（开机自启）"
  exit 0
fi
node server/tools/stop.js && exec node server/sync-server.js
