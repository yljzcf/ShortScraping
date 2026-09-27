import './bootstrap.cjs';
import { startIsolatedServer, card, SUB } from './server-fixture.mjs';
// 订阅配置缺失保护（v1.7.0 审查 M1）。
//
// 起因：同步服务读不到 config/tag.json（被删、改名、项目挪了位置——它是 gitignored 文件）时一律按「零订阅」
// 处理，下一次非空推送被滤成 []，照写 db/timeline.json / .csv 与局域网共享页，只剩一份 drop 档；扩展那头
// 读不到文件时保留上一次的订阅照常推，用户毫无察觉。README 还让重装扩展后从 db/timeline.json 导入恢复。
// 现在：缺文件且现有快照非空 → 409 TAG_CONFIG_MISSING、什么都不写；/health 报 tagConfigMissing 供弹窗提示；
// 缺文件且快照为空（新 clone 的引导态）照旧按零订阅 200；带 allowEmpty 的空推送照旧放行。
//
// 隔离方式：tests/server-fixture.mjs（os.tmpdir() 隔离树 + 随机端口，绝不碰 31919 与真实 db/）。
// 用法：node tests/unit-server-tag-missing.mjs
import fs from 'node:fs';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);

const TAGS = [{ url: SUB, tags: ['IMDB'] }];
const server = await startIsolatedServer({ prefix: 'shortscraping-tagmissing-', config: {} });
try {
  const tagFile = server.tree.p('config/tag.json');
  const jsonPath = server.tree.p('db/timeline.json');
  const csvPath = server.tree.p('db/timeline.csv');
  const historyDir = server.tree.p('db/history');
  const historyFiles = () => (fs.existsSync(historyDir) ? fs.readdirSync(historyDir).sort() : []);

  // ---------- 引导态：没有 tag.json、快照为空 ----------
  const h0 = await server.health();
  check('M1 引导态 /health 报 tagConfigMissing=true', h0?.tagConfigMissing === true, show(h0));
  const boot = await server.postSync([card('tt1')]);
  check('M2 引导态（缺文件、快照为空）推送照旧 200、按零订阅处理（新 clone 不能每次推送都报错）',
    boot.status === 200 && boot.count === 0, show(boot));

  // ---------- 保存订阅 → 文件生成 → 正常写入 ----------
  const saved = await server.post('/config/tag', { urlTags: TAGS });
  const h1 = await server.health();
  const pushed = await server.postSync([card('tt1'), card('tt2')]);
  check('M3 设置页保存订阅后 tagConfigMissing=false、推送照常写入',
    saved.status === 200 && h1?.tagConfigMissing === false && pushed.status === 200 && pushed.count === 2,
    show({ saved: saved.status, flag: h1?.tagConfigMissing, pushed }));

  // ---------- 文件被删、快照非空：拒绝 ----------
  const beforeJson = fs.readFileSync(jsonPath, 'utf8');
  const beforeCsv = fs.readFileSync(csvPath, 'utf8');
  const historyBefore = historyFiles();
  const versionBefore = (await server.health())?.version;
  fs.unlinkSync(tagFile);
  const rejected = await server.postSync([card('tt1'), card('tt2'), card('tt3')]);
  check('M4 删了 tag.json、快照非空 → 409 TAG_CONFIG_MISSING，文案指向设置页保存',
    rejected.status === 409 && rejected.code === 'TAG_CONFIG_MISSING' && /设置页/.test(rejected.error || ''), show(rejected));
  check('M5 被拒时一个字节都不写：timeline.json / .csv 原样、不留 drop 档、版本不变',
    fs.readFileSync(jsonPath, 'utf8') === beforeJson && fs.readFileSync(csvPath, 'utf8') === beforeCsv
      && show(historyFiles()) === show(historyBefore) && (await server.health())?.version === versionBefore,
    show({ history: historyFiles(), before: historyBefore }));
  check('M6 /health 报 tagConfigMissing=true（弹窗据此提示去设置页保存一次订阅）',
    (await server.health())?.tagConfigMissing === true, '');

  // ---------- 重启后快照从 timeline.json 回读，照样拒绝 ----------
  await server.restart();
  const afterRestart = await server.postSync([card('tt1')]);
  check('M7 重启后（快照回读自 timeline.json）仍 409，不因内存快照清零而放行',
    afterRestart.status === 409 && afterRestart.code === 'TAG_CONFIG_MISSING' && fs.readFileSync(jsonPath, 'utf8') === beforeJson,
    show(afterRestart));

  // ---------- 保存一次订阅即恢复 ----------
  await server.post('/config/tag', { urlTags: TAGS });
  const recovered = await server.postSync([card('tt1'), card('tt2'), card('tt3')]);
  check('M8 保存订阅（重建 tag.json）后推送恢复', recovered.status === 200 && recovered.count === 3, show(recovered));

  // ---------- 用户确认过的清空不受影响 ----------
  fs.unlinkSync(tagFile);
  const cleared = await server.postSync([], { allowEmpty: true });
  check('M9 缺文件时带 allowEmpty 的空推送（退订 / 按条件清理后用户确认的清空）照常放行',
    cleared.status === 200 && cleared.count === 0, show(cleared));
} finally {
  await server.stop();
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
