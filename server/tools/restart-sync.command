#!/usr/bin/env bash
# ShortScraping 同步服务 — macOS 双击重启
# 判断逻辑在 stop.js --restart，与 npm run restart 共用：已设置开机自启时重启后台服务
# （launchctl kickstart -k，仍归 launchd 托管）；否则停掉旧实例后在本窗口前台启动，关闭窗口或 Ctrl+C 即停止。
cd "$(dirname "$0")/../.." || exit 1
# 从访达双击时 PATH 可能不含 Homebrew：按常见安装位置兜底（同 setup-autostart.command）。
# 旧版的开机自启分支只用 launchctl、不依赖 node，这里别因改走 stop.js 而在这种环境下失灵
NODE="$(command -v node || true)"
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$NODE" ] && break
  [ -x "$candidate" ] && NODE="$candidate"
done
exec "${NODE:-node}" server/tools/stop.js --restart
