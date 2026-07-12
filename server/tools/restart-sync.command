#!/usr/bin/env bash
# ShortScraping 同步服务 — macOS 双击重启
cd "$(dirname "$0")/../.." || exit 1
node server/tools/stop.js && exec node server/sync-server.js
