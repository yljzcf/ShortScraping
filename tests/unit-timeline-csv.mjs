import './bootstrap.cjs';
// B1 回归测试：CSV 序列化抽共享模块 timeline-csv.js，产物与旧 sync-server 内联
// 实现的普通文本产物字节级一致；固定黄金样例 + 分支断言。
// 公式起始文本保护的逐值用例在 unit-audit-regressions，整份产物层面见 T17/T18。
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

// A6（2026-09-25 审计）：形状合法但日历非法的时间戳必须判无效（返回 null），不能抛
// RangeError——后台导入循环不在 try 里，一抛就整批失败、sendResponse 永不回
const importCard = (extra) => ({ itemId: 'tt9', sourceListUrl: SUB, ...extra });
const safeValidate = (raw) => {
  try { return { value: TimelineCsv.validateImportDrama(raw) }; } catch (error) { return { threw: error }; }
};
for (const [label, value] of [
  ['月份 13', '2026-13-01T00:00Z'],
  ['全面溢出', '2026-13-45T25:99Z'],
  ['分钟 60', '2026-01-01T23:60Z'],
  ['偏移 +24:00', '2026-01-01T10:00+24:00']
]) {
  for (const key of ['scrapedAt', 'translatedAt']) {
    const out = safeValidate(importCard({ [key]: value }));
    check(`T12 ${label}（${key}）判无效而不抛`, !out.threw && out.value === null,
      out.threw ? `threw ${out.threw.name}: ${out.threw.message}` : JSON.stringify(out.value));
  }
}
for (const value of ['2026-02-30T10:00Z', '2025-02-29T00:00Z', '2026-04-31T00:00:00.000Z']) {
  const out = safeValidate(importCard({ scrapedAt: value }));
  check(`T13 日期进位 ${value} 判无效（不静默挪到下月）`, !out.threw && out.value === null,
    out.threw ? `threw ${out.threw.message}` : JSON.stringify(out.value?.scrapedAt));
}
check('T14 闰年 2 月 29 日仍合法', TimelineCsv.validateImportDrama(importCard({ scrapedAt: '2024-02-29T00:00Z' }))?.scrapedAt
  === '2024-02-29T00:00:00.000Z', '');
check('T15 带偏移的合法时间戳照常换算成 UTC', TimelineCsv.validateImportDrama(importCard({ translatedAt: '2026-09-05T01:00:00+08:00' }))?.translatedAt
  === '2026-09-04T17:00:00.000Z', '');
check('T16 无偏移时间戳仍判无效（原有语义不变）', TimelineCsv.validateImportDrama(importCard({ scrapedAt: '2026-09-05T01:00:00' })) === null, '');

// D5（2026-09-25 审计）：db/timeline.csv 带 BOM+CRLF 就是为了让 Excel/WPS 直接打开，整份产物层面
// 再守一次公式前缀（csvEscape 的逐值用例在 unit-audit-regressions）。金样不含公式起始文本，不受影响；
// - 开头的列表式简介也加撇号是按 OWASP 的刻意取舍（见 neutralizeFormula 注释）
{
  const hostile = TimelineCsv.buildTimelineCsv([{ id: 'x', itemId: 'tt0901', title: '=HYPERLINK("http://e","c")',
    titleZh: '+1', description: '- 第一集', descriptionZh: '＠全角不算', tags: ['@SUM(1)'], sourceListUrl: SUB }]).content;
  const row = hostile.split('\r\n')[1];
  check('T17 整份 CSV：= + - @ 开头的单元格加撇号，全角与表头不加',
    row.includes('"\'=HYPERLINK(""http://e"",""c"")"') && row.includes('"\'+1"') && row.includes('"\'- 第一集"')
    && row.includes('"\'@SUM(1)"') && row.includes('"＠全角不算"')
    && hostile.split('\r\n')[0] === '\uFEFF' + TimelineCsv.CSV_COLUMNS.join(','), row);
  check('T18 neutralizeFormula 导出供其他 .csv 出口复用（lark toCsv）',
    typeof TimelineCsv.neutralizeFormula === 'function'
    && TimelineCsv.neutralizeFormula('=1') === "'=1" && TimelineCsv.neutralizeFormula('a=1') === 'a=1', '');
}

// 去重键单一真源（2026-09-25 审计 E）：/sync 不重写 CSV 时按 countTimelineRows 回报条数，
// Lark 表格导出的 tableRowKey 也直接用 rowKey——三处口径必须与 buildTimelineCsv 完全一致
{
  check('T19 rowKey：itemId 优先、旧字段 imdbId 兼容、都没有退回 id、全无为空串',
    TimelineCsv.rowKey({ id: 'a', itemId: 'tt1' }) === 'tt1' && TimelineCsv.rowKey({ id: 'a', imdbId: 'tt2' }) === 'tt2'
    && TimelineCsv.rowKey({ id: 'a' }) === 'a' && TimelineCsv.rowKey({}) === '' && TimelineCsv.rowKey(null) === '', '');
  const mixed = [...FIXTURE, { id: 'id-2', itemId: 'tt0002' }, { id: '', itemId: '' }, { id: 'only-id' }, { id: 'only-id' }];
  check('T20 countTimelineRows 与 buildTimelineCsv 的行数一致（金样卡集 + 旧字段重复 + 无键 + 只有 id）',
    TimelineCsv.countTimelineRows(FIXTURE) === count
    && TimelineCsv.countTimelineRows(mixed) === TimelineCsv.buildTimelineCsv(mixed).count
    && TimelineCsv.countTimelineRows(mixed) === 3 && TimelineCsv.countTimelineRows([]) === 0,
    `${TimelineCsv.countTimelineRows(mixed)} vs ${TimelineCsv.buildTimelineCsv(mixed).count}`);
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
