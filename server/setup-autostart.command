#!/usr/bin/env bash
# ShortScraping 同步服务 — macOS 开机自启 + 弹窗一键集成（一次性设置，双击或终端运行均可）
# 注册当前用户的 launchd LaunchAgent：登录即在后台启动服务，崩溃自动拉起；
# npm run stop / 弹窗 ⏹ 属于正常退出（exit 0），不会被拉回。
# 同时生成 ~/Applications/ShortScraping Launcher.app 接住 shortscraping:// 协议（弹窗 ▶ / 📁）。
# 撤销：server/tools/remove-autostart.command
# 项目文件夹移动后需重新运行本脚本（plist 里记的是绝对路径）。
cd "$(dirname "$0")/.." || exit 1
PROJECT_DIR="$(pwd)"
LABEL="com.shortscraping.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/ShortScraping"
DOMAIN="gui/$(id -u)"

# 从访达双击时 PATH 可能不含 Homebrew，按常见安装位置兜底
NODE="$(command -v node || true)"
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$NODE" ] && break
  [ -x "$candidate" ] && NODE="$candidate"
done
if [ -z "$NODE" ]; then
  echo "[ShortScraping] 未找到 Node.js，请先安装（brew install node）后重试。"
  exit 1
fi

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "$PROJECT_DIR/server/sync-server.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$PROJECT_DIR")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_DIR/sync.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_DIR/sync.log")</string>
</dict>
</plist>
EOF

# —— 一键集成：注册 shortscraping:// 协议（对应 Windows 的 setup-launcher.bat + launcher.vbs）——
# 弹窗 ▶ 启动 / 📁 会打开 shortscraping://start-sync | open-folder，由这个小应用接住。
# 安全：只做固定动作的整串匹配，URL 内容从不拼进任何命令；未知动作静默忽略。
# 在「应用程序」里双击它也能启动服务。
APP="$HOME/Applications/ShortScraping Launcher.app"
as_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
BUILD_DIR="$(mktemp -d)"
SCRIPT_FILE="$BUILD_DIR/launcher.applescript"
cat > "$SCRIPT_FILE" <<EOF
property agentTarget : "gui/$(id -u)/$LABEL"
property serverDir : "$(as_escape "$PROJECT_DIR/server")"

on startSync()
  do shell script "launchctl kickstart " & quoted form of agentTarget
end startSync

on run
  startSync()
end run

on open location theURL
  if theURL is in {"shortscraping://start-sync", "shortscraping://start-sync/"} then
    startSync()
  else if theURL is in {"shortscraping://open-folder", "shortscraping://open-folder/"} then
    do shell script "open " & quoted form of serverDir
  end if
end open location
EOF
mkdir -p "$HOME/Applications"
rm -rf "$APP"
if osacompile -o "$APP" "$SCRIPT_FILE"; then
  PLIST_BUDDY=/usr/libexec/PlistBuddy
  INFO="$APP/Contents/Info.plist"
  "$PLIST_BUDDY" -c "Set :CFBundleIdentifier com.shortscraping.launcher" "$INFO" 2>/dev/null \
    || "$PLIST_BUDDY" -c "Add :CFBundleIdentifier string com.shortscraping.launcher" "$INFO"
  "$PLIST_BUDDY" -c "Add :LSUIElement bool true" \
    -c "Add :CFBundleURLTypes array" \
    -c "Add :CFBundleURLTypes:0 dict" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLName string com.shortscraping.launcher" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string shortscraping" "$INFO"
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1   # 改过 Info.plist 后重新做本机签名
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
  echo "[ShortScraping] 已注册一键集成：弹窗 ▶ 启动 / 📁 可直接使用（首次点击 Chrome 会询问是否打开，可勾选始终允许）"
else
  echo "[ShortScraping] 一键集成注册失败（不影响开机自启）；弹窗 ▶ / 📁 将退化为提示与复制路径。"
fi
rm -rf "$BUILD_DIR"

# 先停掉前台运行的实例（否则端口被占），再以 LaunchAgent 重新加载（重复运行本脚本也安全）
"$NODE" server/tools/stop.js >/dev/null 2>&1
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
  echo "[ShortScraping] 注册失败：launchctl bootstrap 返回错误。"
  exit 1
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -m 2 http://127.0.0.1:31919/health >/dev/null 2>&1; then
    echo "[ShortScraping] 已设置开机自启，服务正在后台运行：http://127.0.0.1:31919"
    echo "[ShortScraping] 日志：$LOG_DIR/sync.log"
    exit 0
  fi
  sleep 1
done
echo "[ShortScraping] 已注册开机自启，但 10 秒内未检测到服务，最近日志："
tail -n 20 "$LOG_DIR/sync.log" 2>/dev/null
exit 1
