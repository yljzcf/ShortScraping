#!/usr/bin/env bash
# ShortScraping 同步服务 — macOS 双击停止
# 已设置开机自启时同样适用：停止属于正常退出，launchd 不会拉回，下次登录或 start-sync.command 再起。
cd "$(dirname "$0")/../.." || exit 1
# 从访达双击时 PATH 可能不含 Homebrew：按常见安装位置兜底（同 restart-sync.command）
NODE="$(command -v node || true)"
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$NODE" ] && break
  [ -x "$candidate" ] && NODE="$candidate"
done
if [ -z "$NODE" ]; then
  echo "[ShortScraping] 未找到 Node.js：也可以在扩展弹窗里点 ⏹ 停止同步服务"
  exit 1
fi
exec "$NODE" server/tools/stop.js
