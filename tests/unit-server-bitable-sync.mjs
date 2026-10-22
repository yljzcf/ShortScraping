import './bootstrap.cjs';
import { startIsolatedServer, card, freePort, DEFAULT_TAGS } from './server-fixture.mjs';
// 同步服务的多维表格自动同步（v1.8.3）：/sync 之后在后台把「已翻译、表里还没有」的条目追加进表。
//
//   S1 没开（没有 lark.json / 开关关着）：/sync 照常 200，对外零请求；/health 报 enabled:false
//   S2 开了：只追加已翻译的条目，按表里的列类型填值；状态落 db/lark-bitable.json；/health 回显上次结果
//   S3 /sync 不等写表：外网慢也立即回 200
//   S4 条目从 new 变 trans 后下一轮才写，已写过的不重写
//   S5 表里手删的行不会被加回来（同步服务另记已写入的 uid）
//   S6 写表失败：/sync 照常 200、/health 报错因，到点自动重试补上
//   S7 重启后靠状态文件不重写；同内容的补推不读表
//   S8 「内容标签」按内置的中文类型标签体系（src/shared/genre-taxonomy.js，v1.8.5）填，按体系维度排序
//   S12 还没归进体系的英文标签：/health 报个数和样例，新出现时日志记一行（v1.8.5）
//   S9 「测试连接」路由：配置不全 400、正常只读不写、飞书报错 502 带原因
//   S10 lark.json 坏了按未启用处理，/sync 不受影响
//   S11 默认身份（没填凭据）走 lark-cli：服务按 SHORTSCRAPING_LARK_CLI 找到 node 脚本、用自己的 node 跑，
//       写入体走 stdin、不换应用令牌；/health 与测试连接报 mode:cli；登录失效时报错因并给重新登录命令
// 隔离方式：tests/server-fixture.mjs（tmpdir 隔离树 + 随机端口）；OpenAPI 是本进程里起的假服务，
// 经 SHORTSCRAPING_LARK_API_BASE 指过去，绝不出网。
// 用法：node tests/unit-server-bitable-sync.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(40);
  }
  return false;
}

// —— 假 OpenAPI ——
const api = {
  rows: [], // [{ fields }]
  calls: [],
  failBatch: false,
  failFields: false,
  batchDelayMs: 0,
  fieldTypes: [
    ['uid', 1], ['title0', 1], ['des0', 1], ['tag0', 4], ['标题', 1], ['简介', 1], ['平台', 3], ['来源标签', 4],
    ['内容标签', 4], ['海报链接', 1], ['跳转链接', 15], ['抓取时间', 5], ['海报', 17]
  ],
  reset() { this.rows = []; this.calls = []; this.failBatch = false; this.failFields = false; this.batchDelayMs = 0; }
};
const apiServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let body = '';
  for await (const chunk of req) body += chunk;
  api.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
  const send = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const p = url.pathname;
  if (p.endsWith('/tenant_access_token/internal')) return send({ code: 0, tenant_access_token: 't-ok', expire: 7200 });
  if (p.endsWith('/wiki/v2/spaces/get_node')) return send({ code: 0, data: { node: { obj_type: 'bitable', obj_token: 'AppTok' } } });
  if (p.endsWith('/fields')) {
    if (api.failFields) return send({ code: 91403, msg: 'Forbidden' });
    return send({ code: 0, data: { items: api.fieldTypes.map(([field_name, type]) => ({ field_name, type })), has_more: false } });
  }
  if (p.endsWith('/records/batch_create')) {
    if (api.batchDelayMs) await sleep(api.batchDelayMs);
    if (api.failBatch) return send({ code: 1254291, msg: 'Write conflict' });
    const records = JSON.parse(body).records;
    for (const r of records) api.rows.push({ fields: r.fields });
    return send({ code: 0, data: { records } });
  }
  if (p.endsWith('/records')) return send({ code: 0, data: { items: api.rows.map(r => ({ fields: { uid: r.fields.uid } })), has_more: false } });
  return send({ code: 404, msg: 'nope' }, 404);
});
const apiPort = await freePort();
await new Promise(resolve => apiServer.listen(apiPort, '127.0.0.1', resolve));

const TABLE_URL = 'https://abc.usttp.larksuite.com/wiki/WikiTok?table=tblAAA';
const LARK = { bitableEnabled: true, bitableUrl: TABLE_URL, bitableAppId: 'cli_test', bitableAppSecret: 'secret' };
const env = {
  SHORTSCRAPING_LARK_API_BASE: `http://127.0.0.1:${apiPort}`,
  SHORTSCRAPING_BITABLE_DEBOUNCE_MS: '50',
  SHORTSCRAPING_BITABLE_STARTUP_MS: '600000', // 启动那一轮别在用例中途插进来
  SHORTSCRAPING_BITABLE_RETRY_MS: '400'
};
const trans = (id, extra = {}) => card(id, { status: 'trans', title: `T-${id}`, titleZh: `中-${id}`, genres: ['Drama'], ...extra });
const batchCalls = () => api.calls.filter(c => c.path.endsWith('/batch_create')).length;
const uids = () => api.rows.map(r => r.fields.uid);

try {
  // S1 + S10
  {
    const server = await startIsolatedServer({ prefix: 'shortscraping-bitable-off-', env });
    try {
      api.reset();
      const r = await server.postSync([trans('off1')]);
      await sleep(300);
      const h = await server.health();
      check('S1a 没有 lark.json：/sync 200，对外零请求，/health 报 enabled:false',
        r.status === 200 && api.calls.length === 0 && show(h.bitableSync) === show({ enabled: false }), show({ status: r.status, calls: api.calls.length, h: h?.bitableSync }));
      fs.writeFileSync(server.tree.p('config/lark.json'), JSON.stringify({ ...LARK, bitableEnabled: false }));
      await server.postSync([trans('off2')]);
      await sleep(300);
      check('S1b 开关关着：同样零请求', api.calls.length === 0, String(api.calls.length));
      fs.writeFileSync(server.tree.p('config/lark.json'), '{ 坏掉');
      const r2 = await server.postSync([trans('off3')]);
      await sleep(300);
      check('S10 lark.json 坏了：/sync 照常 200、零请求、日志有告警',
        r2.status === 200 && api.calls.length === 0 && /读取 config\/lark\.json 失败/.test(server.output), show(r2.status));
    } finally {
      await server.stop();
    }
  }

  // S2 – S8
  {
    const server = await startIsolatedServer({
      prefix: 'shortscraping-bitable-on-', env,
      config: { 'tag.json': DEFAULT_TAGS, 'lark.json': LARK }
    });
    try {
      api.reset();
      api.batchDelayMs = 800;
      const t0 = Date.now();
      const r = await server.postSync([trans('a1', { url: 'https://www.imdb.com/title/a1/', scrapedAt: '2026-10-21T04:54:06.899Z' }), trans('a2'), card('n1')]);
      const elapsed = Date.now() - t0;
      check('S3 /sync 不等写表：外网慢 800ms 也立即回 200', r.status === 200 && elapsed < 600, `${elapsed}ms`);
      await until(() => batchCalls() === 1);
      await until(async () => (await server.health())?.bitableSync?.lastOkAt);
      const row = api.rows.find(x => x.fields.uid === 'a1')?.fields;
      check('S2a 只追加已翻译的 2 条（new 的不写）', show(uids().sort()) === show(['a1', 'a2']), show(uids()));
      check('S2b 按表里的列类型填值：多选数组、单选、超链接对象、日期毫秒；表里没有的列不写',
        show(row?.tag0) === show(['Drama']) && row?.平台 === 'IMDB' && row?.标题 === '中-a1'
        && show(row?.跳转链接) === show({ text: 'https://www.imdb.com/title/a1/', link: 'https://www.imdb.com/title/a1/' })
        && row?.抓取时间 === Date.parse('2026-10-21T04:54:06.899Z') && !('IMDB跳转播放' in row), show(row));
      const state = server.tree.readJson('db/lark-bitable.json');
      const h = (await server.health()).bitableSync;
      check('S2c 状态落盘：已写入 uid、上次追加条数、无错误',
        show(state.syncedIds.sort()) === show(['a1', 'a2']) && state.lastAdded === 2 && state.lastError === null && state.target === 'wiki:WikiTok/tblAAA', show(state));
      check('S2d /health 回显：就绪、上次追加 2 条、表内 2 行、缺的列（IMDB跳转播放）',
        h.enabled && h.ready && h.lastAdded === 2 && h.rowCount === 2 && show(h.missingColumns) === show(['IMDB跳转播放'])
        && !('syncedIds' in h), show(h));
      check('S2e 用了 wiki 换 app_token 后的表地址', api.calls.some(c => c.path === '/open-apis/bitable/v1/apps/AppTok/tables/tblAAA/records/batch_create'), '');

      // S4
      api.batchDelayMs = 0;
      await server.postSync([trans('a1'), trans('a2'), trans('n1')]);
      await until(() => batchCalls() === 2);
      check('S4 new 变 trans 后下一轮只追加这一条', show(uids().sort()) === show(['a1', 'a2', 'n1']), show(uids()));

      // S5
      api.rows = api.rows.filter(x => x.fields.uid !== 'a2');
      await server.postSync([trans('a1'), trans('a2'), trans('n1'), trans('b1')]);
      await until(() => batchCalls() === 3);
      await sleep(200);
      check('S5 表里手删的 a2 不会被加回来，新的 b1 照常追加', show(uids().sort()) === show(['a1', 'b1', 'n1']), show(uids()));

      // S6
      api.failBatch = true;
      const fail = await server.postSync([trans('a1'), trans('n1'), trans('b1'), trans('c1')]);
      await until(async () => (await server.health())?.bitableSync?.lastError);
      const hf = (await server.health()).bitableSync;
      check('S6a 写表失败：/sync 照常 200，/health 带着飞书的报错', fail.status === 200 && /Write conflict/.test(hf.lastError || ''), show(hf));
      api.failBatch = false;
      await until(() => uids().includes('c1'), 4000);
      const ho = (await server.health()).bitableSync;
      check('S6b 到点自动重试补上，错误清掉', uids().includes('c1') && ho.lastError === null, show({ uids: uids(), ho }));

      // S8
      await server.postSync([trans('a1'), trans('n1'), trans('b1'), trans('c1'), trans('d1', { genres: ['Revenge', 'Romance', 'Female', 'Unknown'] })]);
      await until(() => uids().includes('d1'));
      const d1 = api.rows.find(x => x.fields.uid === 'd1')?.fields;
      check('S8 按内置体系填「内容标签」，按体系维度排、认不出的不填', show(d1?.内容标签) === show(['女频', '爱情', '复仇']), show(d1));

      // S12（d1 带着体系里没有的 Unknown）
      const gt = (await server.health()).genreTaxonomy;
      check('S12a /health 报还没归类的英文标签：个数与样例（带挂片数）',
        gt?.unmapped === 1 && show(gt.sample) === show([{ genre: 'Unknown', count: 1 }]), show(gt));
      check('S12b 新出现时日志记一行', /中文类型标签体系有 1 个英文标签待归类：Unknown（1 部）/.test(server.output), '');

      // S7
      const before = batchCalls();
      const readsBefore = api.calls.filter(c => c.path.endsWith('/records') && c.method === 'GET').length;
      await server.postSync([trans('a1'), trans('n1'), trans('b1'), trans('c1'), trans('d1', { genres: ['Revenge', 'Romance', 'Female', 'Unknown'] })]);
      await sleep(400);
      const readsAfter = api.calls.filter(c => c.path.endsWith('/records') && c.method === 'GET').length;
      check('S7a 同内容补推：不读表、不写表', readsAfter === readsBefore && batchCalls() === before, show({ readsBefore, readsAfter }));
      await server.restart();
      api.rows = api.rows.filter(x => x.fields.uid !== 'b1');
      await server.postSync([trans('a1'), trans('n1'), trans('b1'), trans('c1'), trans('d1')]);
      await until(() => api.calls.filter(c => c.path.endsWith('/records') && c.method === 'GET').length > readsAfter);
      await sleep(300);
      check('S7b 重启后头一次推送会跑一轮，但靠状态文件不重写（手删的 b1 也不回来）',
        batchCalls() === before && !uids().includes('b1'), show({ batch: batchCalls(), before, uids: uids() }));

      // S9
      const missing = await server.post('/lark/bitable/test', { larkConfig: { bitableUrl: 'nope', bitableAppId: 'cli_half' } });
      check('S9a 测试连接：配置不全 400，列出缺什么（链接认不出、凭据只填了一半）',
        missing.status === 400 && show(missing.body.missing) === show(['bitableUrl', 'bitableAppSecret']), show(missing));
      const writesBefore = batchCalls();
      const ok = await server.post('/lark/bitable/test', { larkConfig: { ...LARK, bitableEnabled: false } }, {}, { timeoutMs: 5000 });
      check('S9b 正常：200，报行数 / 待追加 / 缺的列；开关关着也能测；不写表',
        ok.status === 200 && ok.body.rowCount === api.rows.length && ok.body.pendingCount === 0
        && show(ok.body.missingColumns) === show(['IMDB跳转播放']) && batchCalls() === writesBefore, show(ok));
      api.failFields = true;
      const bad = await server.post('/lark/bitable/test', { larkConfig: LARK }, {}, { timeoutMs: 5000 });
      check('S9c 飞书报错：502 带着原因', bad.status === 502 && /Forbidden/.test(bad.body.error) && bad.body.code === 91403, show(bad));
      api.failFields = false;
      check('S9d 回给设置页的结果和日志里都不带 App Secret', !show(ok.body).includes('secret') && !server.output.includes('secret'), '');
    } finally {
      await server.stop();
    }
  }

  // S11：假 lark-cli（node 脚本，不带可执行位，验证服务用自己的 node 去跑它），把请求转给上面的假 OpenAPI
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortscraping-fake-lark-cli-'));
  try {
    const cliPath = path.join(cliDir, 'lark-cli');
    fs.writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify(args) + '\\n');
if (fs.existsSync(path.join(__dirname, 'expired'))) {
  process.stderr.write(JSON.stringify({ ok: false, error: { type: 'authorization', code: 99991677, message: 'token expired' } }));
  process.exit(1);
}
(async () => {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const [, method, apiPath] = args;
  const url = new URL(process.env.FAKE_LARK_API + apiPath);
  const params = flag('--params');
  if (params) for (const [k, v] of Object.entries(JSON.parse(params))) url.searchParams.set(k, v);
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: flag('--data') === '-' ? input : undefined });
  const json = await response.json();
  if (json.code === 0) process.stdout.write('Working...\\n' + JSON.stringify({ ok: true, identity: 'user', data: json.data }));
  else { process.stderr.write(JSON.stringify({ ok: false, error: { type: 'api', code: json.code, message: json.msg } })); process.exitCode = 1; }
})();
`);
    const cliLog = () => (fs.existsSync(path.join(cliDir, 'calls.log'))
      ? fs.readFileSync(path.join(cliDir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
    const server = await startIsolatedServer({
      prefix: 'shortscraping-bitable-cli-',
      env: { ...env, SHORTSCRAPING_LARK_CLI: cliPath, FAKE_LARK_API: `http://127.0.0.1:${apiPort}` },
      config: { 'tag.json': DEFAULT_TAGS, 'lark.json': { bitableEnabled: true, bitableUrl: TABLE_URL } }
    });
    try {
      api.reset();
      await server.postSync([trans('c1'), trans('c2'), card('c3')]);
      await until(() => uids().length === 2);
      const calls = cliLog();
      const write = calls.find(a => a[2].endsWith('/batch_create'));
      check('S11a 没填凭据：经 lark-cli 追加已翻译的 2 条，一次都没换应用令牌',
        show(uids().sort()) === show(['c1', 'c2']) && !api.calls.some(c => c.path.endsWith('/tenant_access_token/internal')), show({ uids: uids(), calls: api.calls.map(c => c.path) }));
      check('S11b 每次都是 api <方法> <路径> --as user --format json；写入体走 stdin（--data -）',
        calls.length >= 4 && calls.every(a => a[0] === 'api' && a[3] === '--as' && a[4] === 'user' && a[5] === '--format' && a[6] === 'json')
        && write && show(write.slice(-2)) === show(['--data', '-']), show(calls));
      await until(async () => (await server.health())?.bitableSync?.lastOkAt);
      const h = (await server.health()).bitableSync;
      check('S11c /health 报 mode:cli、上次追加 2 条', h.mode === 'cli' && h.lastAdded === 2 && h.ready, show(h));
      const t = await server.post('/lark/bitable/test', { larkConfig: { bitableUrl: TABLE_URL } }, {}, { timeoutMs: 8000 });
      check('S11d 测试连接也走 lark-cli：mode:cli、表内 2 行、待追加 0', t.status === 200 && t.body.mode === 'cli' && t.body.rowCount === 2 && t.body.pendingCount === 0, show(t));
      fs.writeFileSync(path.join(cliDir, 'expired'), '');
      const bad = await server.post('/lark/bitable/test', { larkConfig: { bitableUrl: TABLE_URL } }, {}, { timeoutMs: 8000 });
      check('S11e 登录失效：502，带飞书原因和重新登录命令', bad.status === 502 && /token expired/.test(bad.body.error)
        && /lark-cli auth login --domain all/.test(bad.body.error), show(bad));
    } finally {
      await server.stop();
    }
  } finally {
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
} finally {
  apiServer.close();
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
