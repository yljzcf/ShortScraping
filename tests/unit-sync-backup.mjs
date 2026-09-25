import './bootstrap.cjs';
import { freePort } from './free-port.mjs';
// 同步服务落盘前备份回归测试（v1.6.7）。
//
// 背景（2026-09-17 事故）：退订后扩展推来的新快照少了 1847 条，同步服务原样覆盖
// db/timeline.csv 与 timeline.json（原子写 .tmp→rename，旧文件不留），本地两份副本
// 同时消失。现在覆盖前留痕：当天第一次改写留一份「改写前」的每日档；条数骤降时
// 额外留一份 drop 档并把既有的空推送警告升级为指明备份路径。
//
// 之后补充：落盘失败时内存签名不先行（否则重推同内容被跳过、磁盘停在旧版本）、
// 先写 json 快照再写 CSV（CSV 被锁不冻结共享页）、同一源状态的 drop 档不重复留、
// CSV 落后于快照时重启后首次推送照样补写。
//
// 隔离方式沿用 unit-c6-sync：sync-server.js + src/shared 复制到 os.tmpdir() 隔离树，
// 随机端口子进程——全程不触碰真实 31919 与真实 db/（2026-07-15 事故预防纪律）。
// 用法：node tests/unit-sync-backup.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const SUB = 'https://unit.test/list';
const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shortscraping-backup-'));
for (const rel of ['server', 'src/shared', 'config', 'db']) {
  fs.mkdirSync(path.join(tmpRoot, rel), { recursive: true });
}
fs.copyFileSync(path.join(worktreeRoot, 'server/sync-server.js'), path.join(tmpRoot, 'server/sync-server.js'));
for (const name of fs.readdirSync(path.join(worktreeRoot, 'src/shared'))) {
  fs.copyFileSync(path.join(worktreeRoot, 'src/shared', name), path.join(tmpRoot, 'src/shared', name));
}
fs.writeFileSync(path.join(tmpRoot, 'config/tag.json'), JSON.stringify([{ url: SUB, tags: ['T'] }], null, 2));
const csvPath = path.join(tmpRoot, 'db/timeline.csv');
const jsonPath = path.join(tmpRoot, 'db/timeline.json');
const historyDir = path.join(tmpRoot, 'db/history');

let serverOut = '';
function startServer() {
  const proc = spawn(process.execPath, ['server/sync-server.js', '--local-only'], {
    cwd: tmpRoot,
    env: { ...process.env, SHORTSCRAPING_PORT: String(PORT) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', (d) => { serverOut += d.toString(); });
  proc.stderr.on('data', (d) => { serverOut += d.toString(); });
  return proc;
}
let child = startServer();
// B10 要验证「重启后」的行为：停掉旧进程、清空输出（waitHealthy 认的是启动行）再起一个
async function restartServer(whileStopped) {
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await exited;
  if (whileStopped) whileStopped();
  serverOut = '';
  child = startServer();
  await waitHealthy();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error(`隔离服务退出: ${serverOut}`);
    if (!serverOut.includes(`服务已启动：${BASE}`)) { await sleep(250); continue; }
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* 未就绪，继续等 */ }
    await sleep(250);
  }
  throw new Error('隔离服务 40 次探测内未就绪');
}

const mk = (n) => ({
  id: `id-${n}`, itemId: `tt000${n}`, title: `Title ${n}`, titleZh: '', tags: ['T'],
  description: `desc ${n}`, descriptionZh: '', source: 'unittest',
  status: 'new', url: `${SUB}/${n}`, sourceListUrl: SUB, poster: '',
  scrapedAt: '2026-08-01T00:00:00.000Z', translatedAt: ''
});
const many = (n) => Array.from({ length: n }, (_, i) => mk(i + 1));
// extra 合入请求体：空推送要清空非空快照必须带 allowEmpty:true，否则 409（批次 A1）
const postSync = async (dramas, extra = {}) => {
  const res = await fetch(`${BASE}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dramas, syncedAt: '2026-08-01T00:00:00.000Z', ...extra })
  });
  return { status: res.status, ...(await res.json()) };
};

const today = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
})();
const ls = () => (fs.existsSync(historyDir) ? fs.readdirSync(historyDir).sort() : []);
const dailyCsvs = () => ls().filter(n => new RegExp(`^timeline-\\d{8}\\.csv$`).test(n));
const dropCsvs = () => ls().filter(n => /^timeline-\d{8}-\d{6}-\d{3}-drop\.csv$/.test(n));
const dataRows = (text) => text.trim().split('\r\n').length - 1;

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

try {
  await waitHealthy();

  // ---------- B1 首次真实改写 → 生成当天的每日档（内容＝改写前的状态） ----------
  await postSync(many(10));
  check('B1a 生成当日每日档 CSV', fs.existsSync(path.join(historyDir, `timeline-${today}.csv`)), ls().join(','));
  check('B1b 每日档是「改写前」的内容（ensureDb 建的空表头）',
    dataRows(fs.readFileSync(path.join(historyDir, `timeline-${today}.csv`), 'utf8')) === 0, ls().join(','));
  check('B1c 当前 CSV 已是新的 10 条', dataRows(fs.readFileSync(csvPath, 'utf8')) === 10, '');

  // ---------- B2 同内容重推 → 不走重写分支，不产生任何新备份 ----------
  const snapshotB2 = ls().join(',');
  await postSync(many(10));
  check('B2 同内容重推零新增备份', ls().join(',') === snapshotB2, `${snapshotB2} -> ${ls().join(',')}`);

  // ---------- B3 内容变化但没有骤降 → 当日档不重复生成、无 drop 档 ----------
  await postSync(many(11));
  check('B3a 当日每日档仍只有一份', dailyCsvs().length === 1, ls().join(','));
  check('B3b 未骤降时不产生 drop 档', dropCsvs().length === 0, ls().join(','));
  check('B3c 每日档内容未被二次覆盖（仍是当天第一次改写前的空表）',
    dataRows(fs.readFileSync(path.join(historyDir, `timeline-${today}.csv`), 'utf8')) === 0, '');

  // ---------- B4 骤降（11 → 3，跌 72%）→ 额外 drop 档，内容是旧的 11 条 ----------
  await postSync(many(3));
  const drops = dropCsvs();
  check('B4a 骤降产生 drop 档', drops.length === 1, ls().join(','));
  check('B4b drop 档内容是覆盖前的 11 条',
    drops.length === 1 && dataRows(fs.readFileSync(path.join(historyDir, drops[0]), 'utf8')) === 11,
    drops.length === 1 ? String(dataRows(fs.readFileSync(path.join(historyDir, drops[0]), 'utf8'))) : '无');
  check('B4c drop 档同时留了 json 快照',
    fs.existsSync(path.join(historyDir, drops[0].replace(/\.csv$/, '.json'))), ls().join(','));

  // ---------- B5 空推送（带 allowEmpty，用户确认过的清空）→ drop 档 + 警告行指明备份路径 ----------
  serverOut = '';
  await postSync([], { allowEmpty: true });
  await sleep(300);
  check('B5a 空推送再留一份 drop 档', dropCsvs().length === 2, ls().join(','));
  check('B5b 既有的空推送警告仍在', /警告：收到空时间线推送/.test(serverOut), serverOut.trim().slice(0, 200));
  check('B5c 警告点名备份文件', /已备份到[\s\S]*db[\\/]history/.test(serverOut), serverOut.trim().slice(0, 300));
  check('B5d 清空行为不变（CSV 只剩表头）', dataRows(fs.readFileSync(csvPath, 'utf8')) === 0, '');

  // ---------- B6 轮转：每日档保留 14 份、drop 档保留 10 份 ----------
  // 造历史文件（日期均早于今天），再触发一次真实改写验证裁剪
  for (let i = 1; i <= 20; i++) {
    const day = `202601${String(i).padStart(2, '0')}`;
    fs.writeFileSync(path.join(historyDir, `timeline-${day}.csv`), 'old');
    fs.writeFileSync(path.join(historyDir, `timeline-${day}.json`), '{}');
    fs.writeFileSync(path.join(historyDir, `timeline-${day}-120000-000-drop.csv`), 'old');
    fs.writeFileSync(path.join(historyDir, `timeline-${day}-120000-000-drop.json`), '{}');
  }
  fs.rmSync(path.join(historyDir, `timeline-${today}.csv`));   // 让当天的每日档重新生成一次
  fs.rmSync(path.join(historyDir, `timeline-${today}.json`), { force: true });
  await postSync(many(9));                                      // 0 → 9，非骤降，只生成每日档
  check('B6a 每日档裁到 14 份', dailyCsvs().length === 14, `daily=${dailyCsvs().length} [${dailyCsvs().join(',')}]`);
  check('B6b 保留的是最新的（今天在内、20260101 已删）',
    dailyCsvs().includes(`timeline-${today}.csv`) && !dailyCsvs().includes('timeline-20260101.csv'), dailyCsvs().join(','));
  check('B6c 每日档的 json 同步裁剪',
    ls().filter(n => /^timeline-\d{8}\.json$/.test(n)).length === 14,
    String(ls().filter(n => /^timeline-\d{8}\.json$/.test(n)).length));

  await postSync(many(1));                                      // 9 → 1，骤降，生成 drop 档并触发 drop 轮转
  check('B6d drop 档裁到 10 份', dropCsvs().length === 10, `drop=${dropCsvs().length}`);
  check('B6e drop 档保留最新的（20260101 的已删）',
    !dropCsvs().includes('timeline-20260101-120000-000-drop.csv'), dropCsvs().join(','));

  // ---------- B7 备份目录不干扰共享页/CSV 正常行为 ----------
  check('B7 当前 CSV 仍是最后一次推送的 1 条', dataRows(fs.readFileSync(csvPath, 'utf8')) === 1, '');
  check('B7b 快照 json 仍可读', JSON.parse(fs.readFileSync(jsonPath, 'utf8')).dramas.length === 1, '');

  // ---------- B8 快照落盘失败：内存签名不前进，重推同内容必须真正写入；drop 档不重复 ----------
  // 用同名 .tmp 目录让原子写的第一步失败（源文件本身完好，备份照常能拷）
  const jsonRows = () => JSON.parse(fs.readFileSync(jsonPath, 'utf8')).dramas.length;
  const getTimeline = async () => (await fetch(`${BASE}/api/timeline`)).json();
  for (const name of ls().filter(n => /-drop\.(csv|json)$/.test(n))) fs.rmSync(path.join(historyDir, name));
  await postSync(many(10));
  fs.mkdirSync(`${jsonPath}.tmp`);
  const b8a = await postSync(many(2));                          // 10 → 2 骤降：先留 drop 档，再写快照失败
  const b8b = await postSync(many(2));                          // 扩展失败后重推同一份
  check('B8a 快照写失败返回错误', b8a.ok === false && b8b.ok === false, JSON.stringify([b8a, b8b]));
  check('B8b 先写快照：快照失败时 CSV 与 json 都保持旧的 10 条', dataRows(fs.readFileSync(csvPath, 'utf8')) === 10 && jsonRows() === 10, '');
  check('B8c 同一源状态的重试不重复留 drop 档', dropCsvs().length === 1, ls().join(','));
  fs.rmdirSync(`${jsonPath}.tmp`);
  const b8d = await postSync(many(2));                          // 恢复后同内容再推：不能被当成「未变化」跳过
  check('B8d 恢复后同内容重推真正落盘', b8d.ok === true && b8d.count === 2 && jsonRows() === 2
    && dataRows(fs.readFileSync(csvPath, 'utf8')) === 2, JSON.stringify(b8d));
  check('B8e 共享页随之更新', (await getTimeline()).dramas.length === 2, '');
  check('B8f 恢复后的写入也不重复留 drop 档', dropCsvs().length === 1, ls().join(','));

  // ---------- B9 CSV 写失败（Windows 上 Excel 锁住）：共享页照常前进，下次同内容推送补写 CSV ----------
  fs.mkdirSync(`${csvPath}.tmp`);
  const b9a = await postSync(many(3));
  const lockedView = await getTimeline();
  check('B9a CSV 写失败返回错误', b9a.ok === false, JSON.stringify(b9a));
  check('B9b 快照先落盘：共享页与 json 已是新的 3 条', lockedView.dramas.length === 3 && jsonRows() === 3, '');
  check('B9c CSV 仍是旧的 2 条', dataRows(fs.readFileSync(csvPath, 'utf8')) === 2, '');
  fs.rmdirSync(`${csvPath}.tmp`);
  const b9d = await postSync(many(3));
  check('B9d 恢复后同内容重推补写 CSV', b9d.ok === true && b9d.count === 3
    && dataRows(fs.readFileSync(csvPath, 'utf8')) === 3, JSON.stringify(b9d));
  check('B9e 快照内容未变：版本号不再 bump', (await getTimeline()).version === lockedView.version, '');

  // ---------- B10 CSV 写失败后没等到补写就重启：CSV 比快照旧，重启后首次同内容推送仍要补写 ----------
  fs.mkdirSync(`${csvPath}.tmp`);
  const b10a = await postSync(many(4));
  check('B10a 前提：快照已是 4 条、CSV 仍是 3 条', b10a.ok === false && jsonRows() === 4
    && dataRows(fs.readFileSync(csvPath, 'utf8')) === 3, JSON.stringify(b10a));
  fs.rmdirSync(`${csvPath}.tmp`);
  await restartServer();
  const b10b = await postSync(many(4));
  check('B10b 重启后同内容推送补写 CSV', b10b.ok === true && b10b.count === 4
    && dataRows(fs.readFileSync(csvPath, 'utf8')) === 4, JSON.stringify(b10b));
  // 两份已一致时重启：同内容推送照旧不重写 CSV（预热推送不刷盘的老约定）
  await restartServer();
  const csvMtime = fs.statSync(csvPath).mtimeMs;
  const b10c = await postSync(many(4));
  check('B10c 两份一致时重启，同内容推送不重写 CSV', b10c.ok === true && b10c.count === 4
    && fs.statSync(csvPath).mtimeMs === csvMtime, `${JSON.stringify(b10c)} ${csvMtime} -> ${fs.statSync(csvPath).mtimeMs}`);
  // 停机期间 CSV 被手删：启动时 ensureDb 先补建只有表头的空表（比快照新，mtime 认不出落后），
  // 首次同内容推送仍要按快照补全，不能一直停在空表
  await restartServer(() => fs.rmSync(csvPath));
  const b10d = await postSync(many(4));
  check('B10d 停机期间删掉 CSV，重启后同内容推送补写', b10d.ok === true && b10d.count === 4
    && dataRows(fs.readFileSync(csvPath, 'utf8')) === 4, JSON.stringify(b10d));

  // ---------- B11 空库护栏在重启后同样生效：快照从 timeline.json 恢复，未带 allowEmpty 的空推送 409 ----------
  // 正是事故形态：服务刚被 launchd 拉起，重装后的扩展 SW 启动即推 []。409 分支在备份之前返回，
  // 连每日档 / drop 档都不产生（没有覆盖就没有留痕）
  await restartServer();
  fs.rmSync(path.join(historyDir, `timeline-${today}.csv`), { force: true });  // 让「会不会留每日档」可观测
  fs.rmSync(path.join(historyDir, `timeline-${today}.json`), { force: true });
  const historyBefore = ls().join(',');
  const csvBefore = fs.readFileSync(csvPath, 'utf8');
  const jsonBefore = fs.readFileSync(jsonPath, 'utf8');
  const b11 = await postSync([]);
  check('B11a 重启后未带 allowEmpty 的空推送 409', b11.status === 409 && b11.code === 'EMPTY_REJECTED'
    && /现有 4 条/.test(b11.error), JSON.stringify(b11));
  check('B11b CSV / json 原样', fs.readFileSync(csvPath, 'utf8') === csvBefore && fs.readFileSync(jsonPath, 'utf8') === jsonBefore, '');
  check('B11c 拒绝时不留任何备份', ls().join(',') === historyBefore, `${historyBefore} -> ${ls().join(',')}`);
  check('B11d 共享页仍是 4 条', (await getTimeline()).dramas.length === 4, '');
} finally {
  child.kill();
  await sleep(200);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
