import './bootstrap.cjs';
import { freePort } from './free-port.mjs';
// 同步服务落盘前备份回归测试（v1.6.7）。
//
// 背景（2026-09-17 事故）：退订后扩展推来的新快照少了 1847 条，同步服务原样覆盖
// db/timeline.csv 与 timeline.json（原子写 .tmp→rename，旧文件不留），本地两份副本
// 同时消失。现在覆盖前留痕：当天第一次改写留一份「改写前」的每日档；条数骤降时
// 额外留一份 drop 档并把既有的空推送警告升级为指明备份路径。
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
const child = spawn(process.execPath, ['server/sync-server.js', '--local-only'], {
  cwd: tmpRoot,
  env: { ...process.env, PORT: String(PORT) },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (d) => { serverOut += d.toString(); });
child.stderr.on('data', (d) => { serverOut += d.toString(); });

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
const postSync = async (dramas) => {
  const res = await fetch(`${BASE}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dramas, syncedAt: '2026-08-01T00:00:00.000Z' })
  });
  return res.json();
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

  // ---------- B5 空推送 → drop 档 + 警告行指明备份路径 ----------
  serverOut = '';
  await postSync([]);
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
} finally {
  child.kill();
  await sleep(200);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
