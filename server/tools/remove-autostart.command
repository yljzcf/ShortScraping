#!/usr/bin/env bash
# ShortScraping 同步服务 — 撤销 macOS 开机自启（停止后台服务，删除 LaunchAgent 与一键集成小应用）
# 日志目录 ~/Library/Logs/ShortScraping 保留，便于事后排查。
cd "$(dirname "$0")/../.." || exit 1
LABEL="com.shortscraping.sync"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="$HOME/Applications/ShortScraping Launcher.app"
# 据实报告：先看 job 是否已加载，而不是不管 bootout 成没成功都说「已停止」
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  if launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    echo "[ShortScraping] 已停止后台服务并撤销开机自启。"
  else
    echo "[ShortScraping] 撤销开机自启时 launchctl bootout 返回错误；plist 仍会删除，下次登录不再自启。"
  fi
else
  echo "[ShortScraping] 未设置开机自启（LaunchAgent 未加载）。"
fi
rm -f "$PLIST"
if [ -d "$APP" ]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$APP" >/dev/null 2>&1
  rm -rf "$APP"
  echo "[ShortScraping] 已删除一键集成小应用（shortscraping:// 协议）。"
fi
# 端口上可能还有脱离 launchd 托管的前台实例（npm run sync、🔄 派生的后台接替实例），bootout 管不到它：
# 再走一次 stop.js（它自己会报告「已停止」或「未运行」）。找不到 node 就跳过（同 restart-sync.command 的兜底）。
# 清空 SHORTSCRAPING_PORT：要停的是扩展连接的默认端口
NODE="$(command -v node || true)"
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$NODE" ] && break
  [ -x "$candidate" ] && NODE="$candidate"
done
if [ -n "$NODE" ]; then
  SHORTSCRAPING_PORT= "$NODE" server/tools/stop.js
else
  echo "[ShortScraping] 未找到 Node.js，跳过前台实例检查；如仍有服务在跑，可在弹窗点 ⏹ 停止。"
fi
echo "[ShortScraping] 需要时运行 npm run sync 手动启动。"
