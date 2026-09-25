#!/usr/bin/env bash
# ShortScraping 同步服务 — 撤销 macOS 开机自启（停止后台服务，删除 LaunchAgent 与一键集成小应用）
LABEL="com.shortscraping.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="$HOME/Applications/ShortScraping Launcher.app"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
rm -f "$PLIST"
if [ -d "$APP" ]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$APP" >/dev/null 2>&1
  rm -rf "$APP"
fi
echo "[ShortScraping] 已撤销开机自启与一键集成，后台服务已停止。需要时运行 npm run sync 手动启动。"
