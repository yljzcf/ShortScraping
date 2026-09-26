import './bootstrap.cjs';
// C-6 回归测试：同步服务空推送清空非空快照时必须打显著警告（行为不变，只加日志）。
// 批次 A1 起：原始 dramas 为空且未带 allowEmpty:true、而共享快照非空 → 409 EMPTY_REJECTED、一个字节都不写；
// 带 allowEmpty 的空推送与「非空推送被 tag.json 过滤成空」仍按原行为清空并告警。
// 隔离方式：tests/server-fixture.mjs 的 os.tmpdir() 隔离树 + 随机端口子进程——
// 全程不触碰真实 31919 与真实 db/（2026-07-15 事故预防纪律）。
// 用法：node tests/unit-c6-sync.mjs（A2 修复前跑应缺警告行 RED，修复后全 PASS）
import fs from 'node:fs';
import { startIsolatedServer } from './server-fixture.mjs';

const SUB = 'https://unit.test/list';

// ---------- 隔离树 + 启动隔离服务（输出捕获在 server.output） ----------
const server = await startIsolatedServer({ prefix: 'shortscraping-c6-', config: { 'tag.json': [{ url: SUB, tags: ['T'] }] } });
const csvPath = server.tree.p('db/timeline.csv');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mk = (n) => ({
  id: `id-${n}`, itemId: `tt000${n}`, title: `Title ${n}`, titleZh: '', tags: ['T'],
  description: `desc ${n}`, descriptionZh: '', source: 'unittest',
  status: 'new', url: `${SUB}/${n}`, sourceListUrl: SUB, poster: '',
  scrapedAt: '2026-08-01T00:00:00.000Z', translatedAt: ''
});
// extra 合入请求体（allowEmpty 等）；返回体上挂 status，409 与 200 的区分要看它
const postSync = server.postSync;
const jsonPath = server.tree.p('db/timeline.json');
const getTimeline = server.timeline;

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

try {
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

  // A1-T1 空库护栏：未带 allowEmpty 的空推送遇到非空快照 → 409，CSV / json / 共享页一个字节都不动
  // 场景：新 profile 或重装扩展后 storage 为空，SW 启动预热推送 []（旧版扩展没有客户端闸门）
  const csvBeforeReject = fs.readFileSync(csvPath, 'utf8');
  const jsonBeforeReject = fs.readFileSync(jsonPath, 'utf8');
  const versionBeforeReject = (await getTimeline()).version;
  server.clearOutput();
  const rejected = await postSync([]);
  await sleep(300);
  check('A1-T1a 未带 allowEmpty 的空推送返回 409 EMPTY_REJECTED',
    rejected.status === 409 && rejected.ok === false && rejected.code === 'EMPTY_REJECTED', JSON.stringify(rejected));
  check('A1-T1b 错误信息点名现有条数与 allowEmpty',
    rejected.error === '拒绝用空时间线覆盖现有 2 条（未带 allowEmpty）', String(rejected.error));
  check('A1-T1c CSV 与 json 快照未改写', fs.readFileSync(csvPath, 'utf8') === csvBeforeReject
    && fs.readFileSync(jsonPath, 'utf8') === jsonBeforeReject, '');
  const afterReject = await getTimeline();
  check('A1-T1d 共享页仍是 2 条、版本号不动', afterReject.dramas.length === 2 && afterReject.version === versionBeforeReject,
    `len=${afterReject.dramas.length} v=${versionBeforeReject}->${afterReject.version}`);
  check('A1-T1e 拒绝时只打拒绝日志、不打「即将被清空」告警',
    /拒绝用空时间线覆盖现有 2 条/.test(server.output) && !server.output.includes('即将被清空'), server.output.trim().slice(0, 200));

  // A1-T2 allowEmpty 必须严格为 true：字符串 'true'、false、1 都不算声明
  const looseFlags = [await postSync([], { allowEmpty: 'true' }), await postSync([], { allowEmpty: false }), await postSync([], { allowEmpty: 1 })];
  check('A1-T2 非布尔 true 的 allowEmpty 一律 409', looseFlags.every(r => r.status === 409 && r.code === 'EMPTY_REJECTED')
    && fs.readFileSync(csvPath, 'utf8') === csvBeforeReject, JSON.stringify(looseFlags.map(r => r.status)));

  // T2 带 allowEmpty:true 的空推送（用户在扩展里确认过的清空/退订）：警告必须出现，行为（清空）不变
  server.clearOutput();
  const empty = await postSync([], { allowEmpty: true });
  await sleep(300); // 等 stdout flush
  check('T2a 警告行出现且含原始/过滤后条数', /警告：收到空时间线推送（原始 0 条 \/ 过滤后 0 条）/.test(server.output), server.output.trim().slice(0, 200));
  check('T2b 警告含现有快照条数', /现有快照 2 条即将被清空/.test(server.output), '');
  check('T2b2 警告标明是扩展声明的主动清空', /用户主动清空（allowEmpty）/.test(server.output), server.output.trim().slice(0, 200));
  check('T2c 响应仍 ok 且 count=0（行为不变）', empty.status === 200 && empty.ok === true && empty.count === 0, JSON.stringify(empty));
  const csvAfterEmpty = fs.readFileSync(csvPath, 'utf8');
  check('T2d CSV 确被清空只剩表头（行为不变）', csvAfterEmpty.trim().split('\r\n').length === 1, `lines=${csvAfterEmpty.trim().split('\r\n').length}`);

  // T3 快照已空后再推空（不带 allowEmpty）：无可覆盖，照常 200、不告警（无破坏即无留痕）
  server.clearOutput();
  const emptyOnEmpty = await postSync([]);
  await sleep(300);
  check('T3a 快照已空时不带 allowEmpty 的空推送照常 200', emptyOnEmpty.status === 200 && emptyOnEmpty.ok === true && emptyOnEmpty.count === 0,
    JSON.stringify(emptyOnEmpty));
  check('T3b 快照为空时空推不告警', !server.output.includes('警告') && !server.output.includes('拒绝'), server.output.trim().slice(0, 120));

  // A1-T3 非空推送只因 tag.json 过滤而变空（订阅已取消）：不受 allowEmpty 约束，保持原行为（清空 + 告警）
  const refill = await postSync([mk(1)]);
  check('A1-T3a 前提：快照重新有 1 条', refill.status === 200 && refill.count === 1, JSON.stringify(refill));
  server.clearOutput();
  const foreign = await postSync([{ ...mk(9), sourceListUrl: 'https://unit.test/unsubscribed' }]);
  await sleep(300);
  check('A1-T3b 过滤成空的非空推送照常 200 且 count=0', foreign.status === 200 && foreign.ok === true && foreign.count === 0,
    JSON.stringify(foreign));
  check('A1-T3c 仍打原有的清空告警（原始 1 条 / 过滤后 0 条）',
    /警告：收到空时间线推送（原始 1 条 \/ 过滤后 0 条）/.test(server.output) && /若非主动清空订阅/.test(server.output), server.output.trim().slice(0, 200));
  check('A1-T3d 共享页随之清空', (await getTimeline()).dramas.length === 0, '');
} finally {
  await server.stop();
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
