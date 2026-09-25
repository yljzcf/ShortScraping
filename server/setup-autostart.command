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
# plist 原样记下这个路径，launchd 拉起失败（exec 不到文件）时 sync.log 里什么都没有，所以这里先把路径定稳：
#   fnm 给的是会话级临时软链（fnm_multishells/<pid>_<ts>/bin/node），关掉终端就失效，解析到它指向的版本目录；
#   Homebrew 的 /opt/homebrew/bin/node 是稳定软链，不能 realpath——解析到 Cellar/node/<版本> 反而在
#   brew upgrade + cleanup 后失效；系统路径同样保持原样。
case "$NODE" in
  */fnm_multishells/*)
    RESOLVED="$("$NODE" -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$NODE" 2>/dev/null)"
    [ -n "$RESOLVED" ] && NODE="$RESOLVED" ;;
esac
echo "[ShortScraping] 使用 Node.js：$NODE（$("$NODE" -v 2>/dev/null)）"
case "$NODE" in
  */.nvm/versions/*|*/fnm/*|*/fnm_multishells/*)
    echo "[ShortScraping] 提示：plist 记录的是带版本号的 Node 路径，升级、切换或卸载该版本后请重新运行本脚本，否则开机自启会悄悄失效。" ;;
esac

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

# 先停掉前台运行的实例（否则端口被占），再以 LaunchAgent 重新加载（重复运行本脚本也安全）。
# 清空 SHORTSCRAPING_PORT：plist 不带它，后台服务固定在 31919，要腾的就是这个端口
SHORTSCRAPING_PORT= "$NODE" server/tools/stop.js >/dev/null 2>&1
# bootout 是异步收尾的：job 还没卸干净就 bootstrap 会报「Bootstrap failed: 5: Input/output error」，
# 而服务已被上面停掉，用户手上一个服务都没有。等 launchctl print 查不到它（最多约 2.5 秒）再注册，
# 仍失败则隔 1 秒重试一次
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
for _ in 1 2 3 4 5; do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
  sleep 1
  if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
    echo "[ShortScraping] 注册失败：launchctl bootstrap 返回错误（多为上一个后台服务尚未完全卸载），可再运行一次本脚本。"
    exit 1
  fi
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
