#!/usr/bin/env bash
# ShortScraping 同步服务 — macOS 双击启动
# 双击后 Terminal 窗口即服务窗口：关闭窗口或按 Ctrl+C 即停止服务。
# 已设置开机自启（setup-autostart.command）时改为拉起后台服务，不再另开前台实例。
cd "$(dirname "$0")/.." || exit 1
AGENT="gui/$(id -u)/com.shortscraping.sync"
if launchctl print "$AGENT" >/dev/null 2>&1; then
  launchctl kickstart "$AGENT" && echo "[ShortScraping] 已拉起后台同步服务（开机自启）"
  exit 0
fi
exec node server/sync-server.js
