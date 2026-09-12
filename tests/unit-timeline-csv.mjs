import './bootstrap.cjs';
// B1 回归测试：CSV 序列化抽共享模块 timeline-csv.js，产物与旧 sync-server 内联
// 实现的普通文本产物字节级一致；固定黄金样例 + 分支断言。
// 公式起始文本保护由 unit-audit-regressions 另行验证。
// 用法：node tests/unit-timeline-csv.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';


const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_PATH = path.join(worktreeRoot, 'tests/timeline-csv-golden.csv');
const SUB = 'https://unit.test/list';

// 固定卡集：转义（引号/换行/逗号）、tags/genres 逗号连接、imdbId 旧字段、同 itemId 去重、无键跳过
// company 刻意带上：v1.5.13 起它已不在白名单内，这里验证「入参有该键也不会漏进产物」
const FIXTURE = [
  { id: 'id-1', itemId: 'tt0001', title: 'Plain Card', titleZh: '普通卡', tags: ['IMDB', 'demo'],
    description: 'line one\nline two', descriptionZh: '中文，含逗号', company: 'Studio "A"',
    source: 'imdb', status: 'trans', url: 'https://x/1', sourceListUrl: SUB, poster: 'p1',
    scrapedAt: '2026-08-01T00:00:00.000Z', translatedAt: '2026-08-01T01:00:00.000Z',
    genres: ['Romance', 'Billionaire/CEO'] },
  { id: 'id-2', imdbId: 'tt0002', title: 'Legacy "Quoted" Field', tags: [],
    description: '', source: 'steam', status: 'new', sourceListUrl: SUB },
  { id: 'id-3', itemId: 'tt0001', title: 'Duplicate Of Card 1', sourceListUrl: SUB },
  { title: 'No Key Card', sourceListUrl: SUB }
];

// ---------- 对拍模式：require 共享模块 ----------
const require = createRequire(import.meta.url);
const TimelineCsv = require(path.join(worktreeRoot, 'src/shared/timeline-csv.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

const { content, count } = TimelineCsv.buildTimelineCsv(FIXTURE);
const golden = fs.readFileSync(GOLDEN_PATH, 'utf8');
check('T1 产物与金样字节级一致', content === golden,
  `len=${content.length}/${golden.length} first-diff=${[...content].findIndex((c, i) => c !== golden[i])}`);
check('T2 去重后计数正确（4 输入 → 2 行）', count === 2, `count=${count}`);

// 分支断言
check('T3 BOM + CRLF + 15 列表头', content.startsWith('﻿') && content.includes('\r\n')
  && content.split('\r\n')[0].replace('﻿', '') === TimelineCsv.CSV_COLUMNS.join(',')
  && TimelineCsv.CSV_COLUMNS.length === 15, `${TimelineCsv.CSV_COLUMNS.length} 列`);
check('T4 引号转义与换行折空格', content.includes('""Quoted""') && content.includes('"line one line two"'), '');
check('T5 tags 逗号连接（引号包裹保证仍是单个单元格）', content.includes('"IMDB,demo"'), '');
check('T6 imdbId 旧字段兼容映射到 itemId 列', content.includes('"tt0002"'), '');
check('T7 normalizeDrama 白名单 15 字段', Object.keys(TimelineCsv.normalizeDrama({})).length === 15,
  Object.keys(TimelineCsv.normalizeDrama({})).join(','));
check('T8 空表只有表头', TimelineCsv.buildTimelineCsv([]).content.trim().split('\r\n').length === 1, '');
check('T9 genres 逗号连接与缺省空列', content.includes('"Romance,Billionaire/CEO"')
  && content.split('\r\n')[2].endsWith(',""'), '');
// v1.5.13：company 彻底移除——列、白名单、产物三处都不该再有它
check('T10 company 已从列与白名单移除', !TimelineCsv.CSV_COLUMNS.includes('company')
  && !('company' in TimelineCsv.normalizeDrama({ company: 'x' })), '');
check('T11 入参带 company 也不漏进产物', !content.includes('Studio'), '');

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
