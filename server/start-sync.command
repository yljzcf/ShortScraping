#!/usr/bin/env bash
# ShortScraping 同步服务 — macOS 双击启动
# 双击后 Terminal 窗口即服务窗口：关闭窗口或按 Ctrl+C 即停止服务。弹窗 🔄 重启后服务转入后台，
# 此窗口随旧进程结束，日志改写 ~/Library/Logs/ShortScraping/sync.log，停止请用弹窗 ⏹ 或 stop-sync.command。
# 已设置开机自启（setup-autostart.command）时改为拉起后台服务，不再另开前台实例。
cd "$(dirname "$0")/.." || exit 1
# 端口变量与 sync-server.js 同名（SHORTSCRAPING_PORT，缺省 31919）：不看通用的 PORT，免得继承别的项目的设置
HEALTH_URL="http://127.0.0.1:${SHORTSCRAPING_PORT:-31919}/health"
# 已在运行就不再启动（同 start-sync.bat）：否则前台实例撞端口报错；开机自启下若端口被脱离托管的
# 前台实例占着，kickstart 起来的实例只会撞端口后让位退出，白跑一趟还在 sync.log 里留一段占用报错
if curl -fsS -m 2 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then
  echo "[ShortScraping] 同步服务已在运行：${HEALTH_URL%/health}"
  exit 0
fi
AGENT="gui/$(id -u)/com.shortscraping.sync"
if launchctl print "$AGENT" >/dev/null 2>&1; then
  launchctl kickstart "$AGENT" && echo "[ShortScraping] 已拉起后台同步服务（开机自启）"
  exit 0
fi
exec node server/sync-server.js
