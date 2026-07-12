#!/usr/bin/env bash
# ShortScraping 同步服务 — macOS 双击停止
cd "$(dirname "$0")/../.." || exit 1
node server/tools/stop.js
