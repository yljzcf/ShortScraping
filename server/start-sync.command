#!/usr/bin/env bash
# ShortScraping 同步服务 — macOS 双击启动
# 双击后 Terminal 窗口即服务窗口：关闭窗口或按 Ctrl+C 即停止服务。
cd "$(dirname "$0")/.." || exit 1
exec node server/sync-server.js
