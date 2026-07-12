/**
 * ShortScraping Sync — 跨平台 CSV 编码修复
 *
 * 将 db/timeline.csv 重写为「UTF-8 带 BOM + CRLF 换行」，用于修复中文乱码，
 * 便于 Excel/WPS 直接识别。等价于 tools/fix-csv-encoding.bat 的 PowerShell 版本，
 * 但为纯 Node 实现，无平台分支（Windows / macOS / Linux 通用）。
 *
 * 用法：node server/tools/fix-csv-encoding.js
 */

const fs = require('fs');
const path = require('path');

// 与 server/sync-server.js 保持一致：带 BOM 的 UTF-8 + Windows 换行
const CSV_BOM = '﻿';
const CSV_NEWLINE = '\r\n';
// 本文件在 server/tools/ 下，退两级到项目根再进 db/
const CSV_PATH = path.join(__dirname, '..', '..', 'db', 'timeline.csv');

function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`[ShortScraping Sync] 未找到 CSV 文件：${CSV_PATH}`);
    process.exit(1);
  }

  let text = fs.readFileSync(CSV_PATH, 'utf8');

  // 去掉可能已存在的 BOM，避免重复叠加
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  // 换行统一归一为 CRLF
  text = text.replace(/\r\n|\r|\n/g, CSV_NEWLINE);

  fs.writeFileSync(CSV_PATH, CSV_BOM + text, 'utf8');
  console.log(`[ShortScraping Sync] 已将 CSV 重写为 UTF-8（带 BOM）+ CRLF：${CSV_PATH}`);
}

main();
