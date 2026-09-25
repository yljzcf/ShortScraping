// 把本地时间线导出成 Lark 多维表格能直接导入的文件（存量回填用）。
//
// 为什么不能直接拿现成的 db/timeline.csv 去导入：
//   1. 那份的 poster 是榜单页缩略图原样，含英文逗号/百分号编码——官方「链接转
//      附件」捷径解析不了，2026-09-12 全量实测有 601 条封面转不出图；本脚本经
//      Lark.buildTableRows 走 posterForPayload 改写，只剩 5 条无解；
//   2. 那份的表头是英文列名，Base 导入建表要的是中文字段名；
//   3. Base 单次导入的行数上限未知，撞上了要能 --chunk 分批切。
//
// .csv 产物与 db/timeline.csv 一样给 = + - @ 开头的单元格加撇号（OWASP CSV 注入防护，
// 2026-09-25 审计 D5）：它带 BOM 落盘，双击默认用 Excel/WPS 打开，标题/简介又是第三方可控内容。
// 代价是直接导入 Base 时以 - / + 开头的正常简介多出撇号；确定不经表格软件、直接导入 Base 的
// 加 --raw 关掉。TSV 是粘贴用的，Base 不执行公式，本来就不加。
//
// 用法：
//   npm run export-lark                          全量
//   npm run export-lark -- --since=2026-09-01    只导该日本地 0 点起入库的（同设置页日期框）
//   npm run export-lark -- --source=imdb --source=steam
//   npm run export-lark -- --chunk=1000          每 1000 条切一个文件
//   npm run export-lark -- --format=tsv          产 TSV（粘贴用；日常增量建议走设置页按钮）
//   npm run export-lark -- --raw                 .csv 不加公式撇号（只在直接导入 Base、不用 Excel 打开时用）
//   npm run export-lark -- --input=<path> --outDir=<dir>
//
// 表头固定中文（2026-09-12 用户定），不提供切换；TSV 按粘贴追加语义不带表头。
// --since 与设置页增量复制同一比较口径：入库时间 savedAt 优先、旧条目退回 scrapedAt
// （Lark.exportStamp，由 buildTableRows 统一套用）。scrapedAt 是提取列表时写的，早于入库，
// 按它切会漏掉窗口边上的卡；「导入恢复」补回的条目不写 savedAt，仍按原抓取时间落窗口。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Lark = require('../src/shared/lark.js');
const SiteRegistry = require('../src/shared/site-registry.js');

// 不用 URL.pathname：它保留百分号编码，项目路径含空格或中文时默认输入/输出全指错
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { sources: [], format: 'csv', chunk: 0, since: '', input: '', outDir: '', raw: false };
  for (const arg of argv) {
    const match = /^--([a-zA-Z]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`无法识别的参数：${arg}`);
    const [, key, rawValue] = match;
    const value = rawValue ?? '';
    switch (key) {
      case 'source': options.sources.push(value); break;
      case 'since': options.since = value; break;
      case 'format': options.format = value.toLowerCase(); break;
      case 'chunk': options.chunk = Number(value); break;
      case 'input': options.input = value; break;
      case 'outDir': options.outDir = value; break;
      // 只认裸开关：--raw=false 之类的写法按拼错拒绝，免得「以为关了、其实开着」
      case 'raw':
        if (rawValue !== undefined) throw new Error('--raw 是开关，不带值');
        options.raw = true;
        break;
      default: throw new Error(`无法识别的参数：--${key}`);
    }
  }

  if (!['csv', 'tsv'].includes(options.format)) throw new Error('--format 只能是 csv 或 tsv');
  if (!Number.isInteger(options.chunk) || options.chunk < 0) throw new Error('--chunk 必须是非负整数');

  const unknown = options.sources.filter(s => !SiteRegistry.CATEGORY_SOURCES.includes(s));
  if (unknown.length) {
    throw new Error(`未知站点：${unknown.join(', ')}（可选：${SiteRegistry.CATEGORY_SOURCES.join(', ')}）`);
  }

  // 日期只认 YYYY-MM-DD 或带时区的完整 ISO-8601。纯日期按本地 0 点展开，与设置页
  // 「导出到多维表格」的日期框同一表达式（settings.js handleLarkExportCopy），同一个日期
  // 两条导出路径切出同一窗口；要跨机器固定窗口就写带偏移的 ISO。刻意不退回裸
  // Date.parse：它认 `2026/09/05` 与无偏移的 `2026-09-05T01:00:00`，形态含糊还静默放行
  // （与 TimelineCsv 导入校验同款戒律）
  if (options.since) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(options.since)) {
      const [year, month, day] = options.since.split('-').map(Number);
      const local = new Date(`${options.since}T00:00:00`);
      // V8 会把 2026-02-30 顺延成 3/2，日期框产不出这种值，这里按拼错拒绝而不是悄悄挪窗口
      if (Number.isNaN(local.getTime()) || local.getFullYear() !== year
        || local.getMonth() !== month - 1 || local.getDate() !== day) {
        throw new Error(`--since 不是有效日期：${options.since}`);
      }
      options.since = local.toISOString();
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/.test(options.since)
      && !Number.isNaN(Date.parse(options.since))) {
      options.since = new Date(options.since).toISOString();
    } else {
      throw new Error(`--since 只接受 YYYY-MM-DD 或带时区的 ISO-8601（如 2026-09-05T00:00:00Z），收到：${options.since}`);
    }
  }

  return options;
}

function readDramas(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`找不到 ${inputPath}——同步服务跑过一轮后才会有这份快照（npm run sync）`);
  }
  const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const dramas = Array.isArray(parsed) ? parsed : parsed?.dramas;
  if (!Array.isArray(dramas)) throw new Error(`${inputPath} 里没有 dramas 数组`);
  return dramas;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = options.input ? path.resolve(options.input) : path.join(projectRoot, 'db/timeline.json');
  const outDir = options.outDir ? path.resolve(options.outDir) : path.join(projectRoot, 'tmp/lark-export');

  const dramas = readDramas(inputPath);
  const rows = Lark.buildTableRows(dramas, { since: options.since, sources: options.sources });

  if (rows.length === 0) {
    console.log(`按当前条件没有可导出的条目（读入 ${dramas.length} 条）`);
    return;
  }

  const serialize = options.format === 'tsv' ? Lark.toTsv : batch => Lark.toCsv(batch, { raw: options.raw });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const batches = options.chunk > 0
    ? Array.from({ length: Math.ceil(rows.length / options.chunk) },
      (_, i) => rows.slice(i * options.chunk, (i + 1) * options.chunk))
    : [rows];

  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  batches.forEach((batch, index) => {
    const suffix = batches.length > 1 ? `-${String(index + 1).padStart(2, '0')}` : '';
    const file = path.join(outDir, `lark-import-${stamp}${suffix}.${options.format}`);
    const text = serialize(batch);
    fs.writeFileSync(file, text);
    written.push({ file, count: batch.length, bytes: Buffer.byteLength(text) });
  });

  // 捷径致死字符：英文逗号与百分号编码（2026-07-25 两轮对照实锤）
  const stuck = rows.filter(row => row.poster && /[,%]/.test(row.poster));
  const noPoster = rows.filter(row => !row.poster);

  console.log(`读入 ${dramas.length} 条 → 导出 ${rows.length} 条${options.since ? `（晚于 ${options.since}）` : ''}${options.sources.length ? `（站点：${options.sources.join(',')}）` : ''}`);
  for (const item of written) {
    console.log(`  ${path.relative(projectRoot, item.file)}  ${item.count} 条  ${(item.bytes / 1024).toFixed(0)}KB`);
  }
  console.log(`封面：${rows.length - stuck.length - noPoster.length} 条可转附件、${noPoster.length} 条无封面、${stuck.length} 条链接含逗号或百分号编码转不了（站点数据本身的形态）`);
  if (stuck.length) stuck.slice(0, 5).forEach(row => console.log(`    [${row.source}] ${row.title}`));
  // 与设置页复制后的提示同口径：导出后译文才到的行不会自动补进 Base
  const untranslated = rows.filter(row => row.status !== 'trans').length;
  if (untranslated) console.log(`翻译：其中 ${untranslated} 条尚未翻译完（中文列为空或不全），译文完成后不会自动补发`);
}

try {
  main();
} catch (error) {
  console.error(`导出失败：${error.message}`);
  process.exitCode = 1;
}
