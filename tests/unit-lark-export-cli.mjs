import './bootstrap.cjs';
// 回归测试：scripts/export-lark-csv.mjs 的参数解析与产物形态。
// 全程在隔离 tmpdir 里跑（--input/--outDir 显式指向夹具，P 组用复制出的隔离树），不读写用户的 db/。
//
// C1/C2 是本套件的存在理由：--since 曾退回裸 Date.parse，`2026/09/05` 与无偏移的
// `2026-09-05T01:00:00` 都被静默接受、按宿主时区平移后固化，同一条命令在不同
// 机器上切出不同的导出窗口（与 TimelineCsv 导入校验同款戒律）。
// C3/C5 守的是另一头：纯日期曾按 UTC 零点切，设置页同一日期框按本地 0 点切，UTC+8 下
// 两条导出路径差出 8 小时。涉及本地时区的用例一律经 env 固定 TZ，不依赖跑测试的机器。
// 用法：node tests/unit-lark-export-cli.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(worktreeRoot, 'scripts/export-lark-csv.mjs');
const Lark = createRequire(import.meta.url)(path.join(worktreeRoot, 'src/shared/lark.js'));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-export-'));
const INPUT = path.join(workDir, 'timeline.json');
const OUT = path.join(workDir, 'out');

const FIXTURE = {
  version: 1,
  dramas: [
    { id: 'a', itemId: 'tt0001', title: 'Alpha', source: 'imdb', status: 'trans',
      poster: 'https://m.media-amazon.com/images/M/AAA@._V1_QL75_UX90_CR0,13,90,133_.jpg',
      scrapedAt: '2026-09-10T00:00:00.000Z', tags: ['IMDB'], genres: ['Drama'] },
    { id: 'b', itemId: 'st0002', title: 'Beta', source: 'steam', status: 'trans',
      poster: 'https://shared.akamai.steamstatic.com/x/header.jpg?t=1',
      scrapedAt: '2026-08-01T00:00:00.000Z', tags: ['Steam'], genres: [] },
    { id: 'c', itemId: 'md0003', title: 'Gamma', source: 'mydrama', status: 'trans',
      poster: 'https://static.my-drama.com/convert/Make%20Me%20Yours/en/2025-12-15%2016:24:39/cover.webp?format=webp&width=189',
      scrapedAt: '2026-09-11T00:00:00.000Z', tags: ['MyDrama'], genres: [] },
    { id: 'd', itemId: 'st0004', title: 'Delta', source: 'steam', status: 'trans',
      scrapedAt: '2026-09-12T00:00:00.000Z', tags: [], genres: [] }
  ]
};
fs.writeFileSync(INPUT, JSON.stringify(FIXTURE));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

function run(args, { env, cli = CLI, io = [`--input=${INPUT}`, `--outDir=${OUT}`], cwd } = {}) {
  const proc = spawnSync(process.execPath, [cli, ...io, ...args],
    { encoding: 'utf8', windowsHide: true, cwd, env: { ...process.env, ...env } });
  return { code: proc.status, out: `${proc.stdout}${proc.stderr}` };
}
const outFiles = () => (fs.existsSync(OUT) ? fs.readdirSync(OUT).sort() : []);
const reset = () => { if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true }); };

// ---------- C 组：--since 只认无歧义形态 ----------
for (const [label, value] of [['C1 拒绝斜杠日期', '2026/09/05'], ['C2 拒绝无时区 ISO', '2026-09-05T01:00:00']]) {
  reset();
  const r = run([`--since=${value}`]);
  check(label, r.code === 1 && r.out.includes('--since 只接受'), `code=${r.code} ${r.out.trim().slice(0, 90)}`);
}
// 与设置页 `new Date(`${d}T00:00:00`)` 同口径：本地 0 点，东西两侧时区各验一次
for (const [tz, expected] of [['Asia/Shanghai', '2026-08-31T16:00:00.000Z'], ['UTC', '2026-09-01T00:00:00.000Z'],
  ['America/Los_Angeles', '2026-09-01T07:00:00.000Z']]) {
  reset();
  const r = run(['--since=2026-09-01'], { env: { TZ: tz } });
  check(`C3 YYYY-MM-DD 按本地零点展开（TZ=${tz}）`, r.code === 0 && r.out.includes(`晚于 ${expected}`), r.out.trim());
}
reset();
let r = run(['--since=2026-09-11T00:00:00+08:00'], { env: { TZ: 'America/Los_Angeles' } });
check('C4 带偏移的 ISO 折算为 UTC（不受宿主时区影响）', r.code === 0 && r.out.includes('晚于 2026-09-10T16:00:00.000Z'), r.out.trim());

// 北京时间 9/1 04:00 抓到的条目：按本地 0 点切应算进 9/1，按 UTC 零点切会被漏掉
const EDGE_INPUT = path.join(workDir, 'edge.json');
fs.writeFileSync(EDGE_INPUT, JSON.stringify({ version: 1, dramas: [
  { id: 'e1', itemId: 'tt0101', title: 'Dawn', source: 'imdb', status: 'trans', scrapedAt: '2026-08-31T20:00:00.000Z' },
  { id: 'e2', itemId: 'tt0102', title: 'Dusk', source: 'imdb', status: 'trans', scrapedAt: '2026-08-31T12:00:00.000Z' }
] }));
reset();
r = run(['--since=2026-09-01'], { env: { TZ: 'Asia/Shanghai' }, io: [`--input=${EDGE_INPUT}`, `--outDir=${OUT}`] });
check('C5 北京时间当日 0–8 点抓到的条目不再被漏掉', r.code === 0 && r.out.includes('导出 1 条'), r.out.trim().split('\n')[0]);
reset();
r = run(['--since=2026-02-30'], { env: { TZ: 'Asia/Shanghai' } });
check('C6 日历上不存在的日期直接拒绝（不顺延到 3/2）', r.code === 1 && r.out.includes('不是有效日期'), r.out.trim().slice(0, 60));

// ---------- F 组：过滤与产物 ----------
reset();
r = run(['--since=2026-09-01']);
check('F1 since 过滤后计数正确（4 条中 3 条晚于 9/1）', r.out.includes('导出 3 条'), r.out.trim().split('\n')[0]);
reset();
r = run(['--source=steam']);
check('F2 source 过滤', r.code === 0 && r.out.includes('导出 2 条'), r.out.trim().split('\n')[0]);
reset();
r = run(['--source=douyin']);
check('F3 未知站点拒绝并列出可选值', r.code === 1 && r.out.includes('未知站点：douyin') && r.out.includes('royalroad'),
  r.out.trim().slice(0, 90));
reset();
r = run(['--bogus']);
check('F4 未知参数拒绝', r.code === 1 && r.out.includes('无法识别的参数'), r.out.trim().slice(0, 60));
reset();
r = run(['--format=xlsx']);
check('F5 非法 format 拒绝', r.code === 1 && r.out.includes('--format 只能是'), r.out.trim().slice(0, 60));
reset();
r = run(['--header=en']);
check('F5b 表头已固定中文，--header 不再是可选项', r.code === 1 && r.out.includes('无法识别的参数'),
  r.out.trim().slice(0, 60));
reset();
r = run(['--since=2030-01-01']);
check('F6 零命中不建文件、不报错', r.code === 0 && r.out.includes('没有可导出的条目') && outFiles().length === 0,
  `code=${r.code} files=${outFiles().length}`);

// ---------- O 组：输出文件形态 ----------
reset();
run([]);
let files = outFiles();
check('O1 不分批时产单个 csv', files.length === 1 && /^lark-import-\d{8}\.csv$/.test(files[0]), files.join(','));
let text = fs.readFileSync(path.join(OUT, files[0]), 'utf8');
check('O2 BOM + CRLF + 15 列中文表头', text.startsWith('﻿')
  && text.split('\r\n')[0].replace('﻿', '') === Lark.TABLE_HEADERS.map(h => `"${h}"`).join(','),
  text.split('\r\n')[0].slice(0, 80));
check('O3 poster 已改写（IMDB 去逗号变换段、mydrama 归一 %20/%3A）',
  text.includes('AAA@._V1_.jpg') && text.includes('Make+Me+Yours/en/2025-12-15+16:24:39')
  && !/_V1_QL75/.test(text) && !text.includes('%20'), '');
check('O4 缺封面条目不报错且计数分列', text.includes('"Delta"'), '');

reset();
run(['--chunk=2']);
files = outFiles();
check('O5 分批切文件并带两位序号', files.length === 2
  && files[0].endsWith('-01.csv') && files[1].endsWith('-02.csv'), files.join(','));
check('O6 每批各带中文表头、条数正确',
  files.every(f => fs.readFileSync(path.join(OUT, f), 'utf8').startsWith('﻿"记录ID",'))
  && fs.readFileSync(path.join(OUT, files[0]), 'utf8').trimEnd().split('\r\n').length === 3, '');

reset();
run(['--format=tsv']);
files = outFiles();
text = fs.readFileSync(path.join(OUT, files[0]), 'utf8');
// TSV 是粘贴追加用的，不带表头——带上会在表末多出一行垃圾记录
check('O7 tsv 扩展名 + 无表头无 BOM 无 CRLF', files[0].endsWith('.tsv')
  && !text.startsWith('﻿') && !text.includes('\r')
  && text.split('\n')[0].split('\t')[1] === 'tt0001',
  `${files[0]} | ${JSON.stringify(text.slice(0, 40))}`);
check('O8 tsv 每行 15 格且行数＝记录数', text.split('\n').every(line => line.split('\t').length === 15)
  && text.split('\n').length === 4, text.split('\n').map(l => l.split('\t').length).join(','));

reset();
r = run(['--input=' + path.join(workDir, 'nope.json')]);
check('O10 输入缺失给出可操作提示', r.code === 1 && r.out.includes('npm run sync'), r.out.trim().slice(0, 80));

// ---------- P 组：项目根按脚本位置推导 ----------
// 曾用 URL.pathname 推项目根：路径里的空格/中文保留百分号编码，默认的 db/timeline.json 与
// tmp/lark-export 全指到不存在的目录。这里复制出带空格和中文的隔离树，不传 --input/--outDir，
// 并从别的目录启动，证明默认路径只跟脚本位置走
const copyRoot = path.join(workDir, '短剧 工具', 'ShortScraping');
for (const rel of ['scripts', 'src/shared', 'db']) fs.mkdirSync(path.join(copyRoot, rel), { recursive: true });
fs.copyFileSync(CLI, path.join(copyRoot, 'scripts/export-lark-csv.mjs'));
for (const file of fs.readdirSync(path.join(worktreeRoot, 'src/shared'))) {
  fs.copyFileSync(path.join(worktreeRoot, 'src/shared', file), path.join(copyRoot, 'src/shared', file));
}
fs.writeFileSync(path.join(copyRoot, 'db/timeline.json'), JSON.stringify(FIXTURE));
r = run([], { cli: path.join(copyRoot, 'scripts/export-lark-csv.mjs'), io: [], cwd: workDir });
const copyOut = path.join(copyRoot, 'tmp/lark-export');
files = fs.existsSync(copyOut) ? fs.readdirSync(copyOut) : [];
check('P1 路径含空格与中文时默认输入/输出落在项目树内', r.code === 0 && r.out.includes('导出 4 条')
  && files.length === 1 && /^lark-import-\d{8}\.csv$/.test(files[0])
  && r.out.includes(path.join('tmp', 'lark-export', files[0])), `code=${r.code} files=${files.join(',')} ${r.out.trim().slice(0, 120)}`);

fs.rmSync(workDir, { recursive: true, force: true });

console.log(results.map(x => `${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass ? '' : `   [${x.detail}]`}`).join('\n'));
const failed = results.filter(x => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
