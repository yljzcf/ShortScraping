#!/usr/bin/env bash
# ShortScraping 同步服务 — macOS 双击修复 CSV 编码
cd "$(dirname "$0")/../.." || exit 1
node server/tools/fix-csv-encoding.js
