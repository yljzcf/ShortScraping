#!/usr/bin/env bash
# ShortScraping 同步服务 — macOS 双击停止
# 已设置开机自启时同样适用：停止属于正常退出，launchd 不会拉回，下次登录或 start-sync.command 再起。
cd "$(dirname "$0")/../.." || exit 1
node server/tools/stop.js
