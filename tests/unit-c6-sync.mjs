import './bootstrap.cjs';
import { freePort } from './free-port.mjs';
// C-6 回归测试：同步服务空推送清空非空快照时必须打显著警告（行为不变，只加日志）。
// 隔离方式：sync-server.js + 依赖复制到 os.tmpdir() 隔离树，随机端口子进程——
// 全程不触碰真实 31919 与真实 db/（2026-07-15 事故预防纪律）。
// 用法：node tests/unit-c6-sync.mjs（A2 修复前跑应缺警告行 RED，修复后全 PASS）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const SUB = 'https://unit.test/list';
const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 隔离树 ----------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shortscraping-c6-'));
for (const rel of ['server', 'src/shared', 'config', 'db']) {
  fs.mkdirSync(path.join(tmpRoot, rel), { recursive: true });
}
// 整目录复制 src/shared：新增共享模块时不必再逐个套件维护复制清单
fs.copyFileSync(path.join(worktreeRoot, 'server/sync-server.js'), path.join(tmpRoot, 'server/sync-server.js'));
for (const name of fs.readdirSync(path.join(worktreeRoot, 'src/shared'))) {
  fs.copyFileSync(path.join(worktreeRoot, 'src/shared', name), path.join(tmpRoot, 'src/shared', name));
}
fs.writeFileSync(path.join(tmpRoot, 'config/tag.json'), JSON.stringify([{ url: SUB, tags: ['T'] }], null, 2));
const csvPath = path.join(tmpRoot, 'db/timeline.csv');

// ---------- 启动隔离服务并捕获输出 ----------
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
const postSync = async (dramas) => {
  const res = await fetch(`${BASE}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dramas, syncedAt: '2026-08-01T00:00:00.000Z' })
  });
  return res.json();
};

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

try {
  await waitHealthy();

  // T1 先推 1 条形成非空快照
  const first = await postSync([mk(1)]);
  check('T1a 首推成功且计 1 条', first.ok === true && first.count === 1, JSON.stringify(first));
  const csvAfterFirst = fs.readFileSync(csvPath, 'utf8');
  check('T1b CSV 含数据行', csvAfterFirst.trim().split('\r\n').length === 2, `lines=${csvAfterFirst.trim().split('\r\n').length}`);

  // A3-T1 同内容重推：CSV 不重写（mtime 不变），count 口径一致
  const mtimeBefore = fs.statSync(csvPath).mtimeMs;
  await sleep(50);
  const same = await postSync([mk(1)]);
  check('A3-T1a 同内容重推响应 ok 且 count=1', same.ok === true && same.count === 1, JSON.stringify(same));
  check('A3-T1b 同内容重推 CSV 未重写', fs.statSync(csvPath).mtimeMs === mtimeBefore, `before=${mtimeBefore} after=${fs.statSync(csvPath).mtimeMs}`);

  // A3-T2 CSV 被手删后推同内容：existsSync 守卫触发重建（自愈行为保留）
  fs.rmSync(csvPath);
  const heal = await postSync([mk(1)]);
  check('A3-T2 删 CSV 后同内容推送自愈重建', heal.ok === true && fs.existsSync(csvPath), JSON.stringify(heal));

  // A3-T3 内容变化：正常重写
  const mtimeBeforeChange = fs.statSync(csvPath).mtimeMs;
  await sleep(50);
  const changed = await postSync([mk(1), mk(2)]);
  check('A3-T3 内容变化时照常重写且计 2 条', changed.count === 2 && fs.statSync(csvPath).mtimeMs !== mtimeBeforeChange, JSON.stringify(changed));

  // T2 空推送：警告必须出现，行为（清空）不变
  serverOut = '';
  const empty = await postSync([]);
  await sleep(300); // 等 stdout flush
  check('T2a 警告行出现且含原始/过滤后条数', /警告：收到空时间线推送（原始 0 条 \/ 过滤后 0 条）/.test(serverOut), serverOut.trim().slice(0, 200));
  check('T2b 警告含现有快照条数', /现有快照 2 条即将被清空/.test(serverOut), '');
  check('T2c 响应仍 ok 且 count=0（行为不变）', empty.ok === true && empty.count === 0, JSON.stringify(empty));
  const csvAfterEmpty = fs.readFileSync(csvPath, 'utf8');
  check('T2d CSV 确被清空只剩表头（行为不变）', csvAfterEmpty.trim().split('\r\n').length === 1, `lines=${csvAfterEmpty.trim().split('\r\n').length}`);

  // T3 快照已空后再推空：不再告警（无破坏即无留痕）
  serverOut = '';
  await postSync([]);
  await sleep(300);
  check('T3 快照为空时空推不告警', !serverOut.includes('警告'), serverOut.trim().slice(0, 120));
} finally {
  child.kill();
  await sleep(200);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
