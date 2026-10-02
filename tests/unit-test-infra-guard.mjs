// 测试基建棘轮 + 自检（v1.6.20）。
//   G 组（棘轮，只能减不能增）：
//     G1 手搓的 chrome.storage 桩（各自一份 pickKeys）只许留在白名单里的套件；套件迁到
//        background-fixture / storage-stub 后从白名单删掉它，最终白名单为空。
//     G2 除 tests/server-fixture.mjs 外，任何测试文件不得自己 spawn server/sync-server.js；
//        迁到 server-fixture 后同样从白名单删掉。
//     白名单只能是最初名单的子集：往里加新名字须同时改两处，一眼就能看出是在放宽棘轮。
//   I 组：storage-stub 的 Chromium 口径（get 各形态、克隆、onChanged 只派发真正变化的键、钩子、计数）。
//   F 组：background-fixture 的新选项（manual 计时器、translator 注入、send、scripting 桩、
//        resetDramasCache、dnr 桩）与缺省行为。
// 用法：node tests/unit-test-infra-guard.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChromeStorage } from './storage-stub.mjs';
import { background, card } from './background-fixture.mjs';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ticks = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

// ---------- 白名单（迁一个删一个；两份最初名单冻结不动） ----------
const PICKKEYS_ORIGINAL = [
  'unit-archive-actions.mjs', 'unit-csv-signature.mjs', 'unit-dramas-cache.mjs', 'unit-dramas-race.mjs',
  'unit-fetch-proxy.mjs', 'unit-lark-bot-trigger.mjs', 'unit-maint-batch1.mjs', 'unit-maint-batch2.mjs',
  'unit-migrate-skip.mjs', 'unit-translate-all.mjs', 'unit-translate-failures.mjs', 'unit-translate-partial.mjs',
  'unit-translate-single.mjs'
];
const PICKKEYS_ALLOWLIST = [];
const SERVER_FIXTURE = 'server-fixture.mjs'; // 唯一允许 spawn sync-server.js 的文件（永久例外，不进白名单）
const SPAWNERS_ORIGINAL = [
  'unit-c6-sync.mjs', 'unit-schedule-config.mjs', 'unit-server-restart.mjs', 'unit-server-safety.mjs',
  'unit-stop-restart-cli.mjs', 'unit-sync-backup.mjs'
];
const SPAWNERS_ALLOWLIST = [];

// 探测器就是对文件全文跑正则：简单、不依赖解析器。只认定义，不认注释里提到这个名字
const definesPickKeys = text => /\bfunction\s+pickKeys\s*\(|\bpickKeys\s*=/.test(text);
// 「自己 spawn 同步服务」＝引了 child_process 又出现 sync-server.js 路径（只读源码做文本断言的套件不引 child_process）
const spawnsSyncServer = text => /child_process/.test(text) && /sync-server\.js/.test(text);

const files = fs.readdirSync(testsDir).filter(name => /\.(mjs|cjs|js)$/.test(name) && name !== SELF).sort();
const read = name => fs.readFileSync(path.join(testsDir, name), 'utf8');
const outside = (list, allow) => list.filter(name => !allow.includes(name));

// ---------- G1 pickKeys 手搓桩 ----------
{
  check('G1a 探测器认得函数声明与箭头函数两种手搓桩，不认注释里的提及',
    definesPickKeys('function pickKeys(keys) {') && definesPickKeys('const pickKeys = keys => ({});')
      && !definesPickKeys('// 已去掉手搓的 pickKeys 桩') && !definesPickKeys('pickKeysOf(x)'));
  const offenders = files.filter(name => definesPickKeys(read(name)));
  check('G1b 带手搓 storage 桩（pickKeys）的文件都在白名单里（新套件请用 storage-stub / background-fixture）',
    outside(offenders, PICKKEYS_ALLOWLIST).length === 0, `白名单外：${outside(offenders, PICKKEYS_ALLOWLIST).join(', ')}`);
  check('G1c pickKeys 白名单只减不增（是最初名单的子集）',
    outside(PICKKEYS_ALLOWLIST, PICKKEYS_ORIGINAL).length === 0, `新增：${outside(PICKKEYS_ALLOWLIST, PICKKEYS_ORIGINAL).join(', ')}`);
}

// ---------- G2 自己 spawn sync-server.js ----------
{
  check('G2a 探测器认得 spawn 同步服务，不认只读源码的文本断言',
    spawnsSyncServer("import { spawn } from 'node:child_process';\nspawn(process.execPath, ['server/sync-server.js'])")
      && !spawnsSyncServer("fs.readFileSync(path.join(root, 'server/sync-server.js'), 'utf8')"));
  const spawners = files.filter(name => name !== SERVER_FIXTURE && spawnsSyncServer(read(name)));
  check('G2b 除 server-fixture 外 spawn sync-server.js 的文件都在白名单里（新套件请用 server-fixture）',
    outside(spawners, SPAWNERS_ALLOWLIST).length === 0, `白名单外：${outside(spawners, SPAWNERS_ALLOWLIST).join(', ')}`);
  check('G2c spawn 白名单只减不增（是最初名单的子集）',
    outside(SPAWNERS_ALLOWLIST, SPAWNERS_ORIGINAL).length === 0, `新增：${outside(SPAWNERS_ALLOWLIST, SPAWNERS_ORIGINAL).join(', ')}`);
}

// ---------- I1 get 各形态 ----------
{
  const store = createChromeStorage({ a: 1, b: { x: [1, 2] }, c: null });
  const byString = await store.local.get('a');
  const byArray = await store.local.get(['a', 'missing']);
  const byDefaults = await store.local.get({ a: 0, missing: 'dflt' });
  const all = await store.local.get(null);
  const allUndefined = await store.local.get();
  const viaCallback = await new Promise(resolve => store.local.get('b', resolve));
  const viaCallbackOnly = await new Promise(resolve => store.local.get(resolve));
  const promiseWithCallback = await store.local.get('a', () => {});
  check('I1a get(字符串 / 数组) 只返回存在的键', same(byString, { a: 1 }) && same(byArray, { a: 1 }), JSON.stringify({ byString, byArray }));
  check('I1b get(默认值对象) 缺的键取默认值', same(byDefaults, { a: 1, missing: 'dflt' }), JSON.stringify(byDefaults));
  check('I1c get(null) / get() 返回全部键', same(all, { a: 1, b: { x: [1, 2] }, c: null }) && same(allUndefined, all), JSON.stringify(all));
  check('I1d 回调形式：get(keys, cb)、get(cb) 都回调结果，且仍返回 Promise',
    same(viaCallback, { b: { x: [1, 2] } }) && same(viaCallbackOnly, all) && same(promiseWithCallback, { a: 1 }),
    JSON.stringify({ viaCallback, viaCallbackOnly, promiseWithCallback }));
}

// ---------- I2 结构化克隆 ----------
{
  const store = createChromeStorage({ list: [{ n: 1 }] });
  const got = await store.local.get('list');
  got.list[0].n = 99;
  const value = { list: [{ n: 2 }] };
  await store.local.set(value);
  value.list[0].n = 77;
  const seedObject = { deep: { n: 3 } };
  const seeded = createChromeStorage(seedObject);
  seedObject.deep.n = 66;
  check('I2 值按克隆存取：改 get 结果 / 改 set 过的原对象 / 改种子对象都不回写 storage',
    store.data.list[0].n === 2 && seeded.data.deep.n === 3, JSON.stringify({ list: store.data.list, deep: seeded.data.deep }));
}

// ---------- I3 onChanged ----------
{
  const store = createChromeStorage({ same: { k: 1, j: 2 }, changed: 1, gone: 'x' });
  const events = [];
  store.onChanged.addListener((changes, area) => events.push({ changes, area }));
  const setPromise = store.local.set({ same: { j: 2, k: 1 }, changed: 2, added: [1] });
  const syncCount = events.length;
  await setPromise;
  await ticks();
  check('I3a 派发在微任务里（set 调用当拍还没派发）', syncCount === 0 && events.length === 1, `sync=${syncCount} after=${events.length}`);
  const first = events[0]?.changes || {};
  check('I3b 只带值真正变化的键（同值、键序不同也算同值），新增键没有 oldValue',
    same(Object.keys(first).sort(), ['added', 'changed']) && same(first.changed, { oldValue: 1, newValue: 2 })
      && same(first.added, { newValue: [1] }) && events[0].area === 'local',
    JSON.stringify(events[0]));
  events.length = 0;
  await store.local.set({ changed: 2 });
  await ticks();
  check('I3c 整次写入都是同值：不派发', events.length === 0, JSON.stringify(events));
  await store.local.remove(['gone', 'never']);
  await ticks();
  check('I3d remove 只带真的存在过的键，没有 newValue', events.length === 1 && same(events[0].changes, { gone: { oldValue: 'x' } }), JSON.stringify(events));
  const quiet = createChromeStorage({}, { dispatchChanges: false });
  let quietCalls = 0;
  quiet.onChanged.addListener(() => { quietCalls++; });
  await quiet.local.set({ a: 1 });
  await ticks();
  check('I3e dispatchChanges:false 时不派发', quietCalls === 0, String(quietCalls));
}

// ---------- I4 / I5 钩子 ----------
{
  const store = createChromeStorage({});
  store.failNextSet(values => 'target' in values);
  await store.local.set({ other: 1 });
  let error = null;
  await store.local.set({ target: 1 }).catch(e => { error = e; });
  await store.local.set({ target: 2 });
  check('I4 failNextSet(pred)：不匹配的照常写，匹配的那次抛错不落盘，只消耗一次',
    store.data.other === 1 && /注入的 set 失败/.test(error?.message || '') && store.data.target === 2, JSON.stringify({ data: store.data, error: error?.message }));

  const cbStore = createChromeStorage({});
  cbStore.failNextSet();
  const cbArgs = await new Promise(resolve => cbStore.local.set({ a: 1 }, (...args) => resolve(args)));
  check('I4b 回调形式失败：回调不带参数、错误记在 lastError、不落盘', cbArgs.length === 0 && /注入/.test(cbStore.lastError?.message || '') && !('a' in cbStore.data),
    JSON.stringify({ cbArgs, lastError: cbStore.lastError?.message }));

  const paused = createChromeStorage({ v: 0 });
  const gate = paused.pauseNextSet(values => 'v' in values);
  const writing = paused.local.set({ v: 1 });
  const reachedWith = await gate.reached;
  await ticks();
  const whilePaused = paused.data.v;
  gate.release();
  await writing;
  check('I5 pauseNextSet：卡住期间不落盘，reached 带着要写的值，release 后落盘',
    whilePaused === 0 && same(reachedWith, { v: 1 }) && paused.data.v === 1, JSON.stringify({ whilePaused, reachedWith, after: paused.data.v }));
}

// ---------- I6 计数与 dramas 访问器 ----------
{
  const store = createChromeStorage({});
  store.seedDramas([card('tt1')]);
  await store.local.get('dramas');
  await store.local.get(['urlTags', 'dramas']);
  await store.local.get('urlTags');
  await store.local.get(null);
  check('I6a readCount 按请求键计数，get(null) 也算读了', store.readCount('dramas') === 3 && store.readCount('urlTags') === 3
    && store.dramasReadCount() === 3, JSON.stringify(store.reads));
  const list = [card('tt2')];
  store.seedDramas(list);
  list.push(card('tt3'));
  check('I6b seedDramas 按克隆写入，dramas() 读出同一张表', store.dramas().length === 1 && store.dramas()[0].itemId === 'tt2', JSON.stringify(store.dramas()));
  check('I6c writesDramas 认得写 dramas 表的 set', store.writesDramas({ dramas: [], lastScrape: 'x' }) && !store.writesDramas({ lastScrape: 'x' }));
  store.seedDramas(undefined);
  check('I6d seedDramas(undefined) 删掉这个键', store.dramas() === undefined && !('dramas' in store.data));
}

// ---------- I7 tick 时序 ----------
{
  const store = createChromeStorage({ v: 1 }, { log: [] });
  const reading = store.local.get('v');
  store.data.v = 2; // 调用之后才改：tick=0 时 get 当拍已取值
  store.local.set({ w: 1 });
  const writtenSameTick = store.data.w === 1;
  check('I7a tick=0：get 当拍取值、set 当拍落盘并记日志（与旧 fixture 逐拍一致）',
    same(await reading, { v: 1 }) && writtenSameTick && same(store.log, ['set:w']), JSON.stringify({ log: store.log }));
  const lazy = createChromeStorage({ v: 1 }, { tick: 1 });
  const lazyRead = lazy.local.get('v');
  lazy.data.v = 2;
  lazy.local.set({ w: 1 });
  const lazyWrittenSameTick = 'w' in lazy.data;
  check('I7b tick:1：读写都让出一拍再生效（手搓桩的口径）', same(await lazyRead, { v: 2 }) && !lazyWrittenSameTick && lazy.data.w === 1);
}

// ---------- F1 fixture 缺省行为 ----------
{
  const bg = await background();
  check('F1a 缺省 timers=noop：setTimeout 不执行、返回 1', bg.run('setTimeout(() => { globalThis.noopFired = true; }, 0)') === 1 && bg.timers === null
    && bg.run('typeof noopFired') === 'undefined');
  check('F1b bg.data 就是 storage 本体，缺省种空 dramas 表与订阅', bg.data === bg.storage.data && same(bg.dramas(), []) && Array.isArray(bg.data.urlTags));
  let changedCalls = 0;
  const original = bg.listeners.changed;
  bg.storage.onChanged.addListener(() => { changedCalls++; });
  await bg.run("chrome.storage.local.set({ fixtureProbe: 1 })");
  await ticks();
  check('F1c 缺省不自动派发 onChanged（历来由测试手动调 bg.listeners.changed）', changedCalls === 0 && typeof original === 'function', String(changedCalls));
  await bg.run("chrome.scripting.executeScript({ target: { tabId: 7 }, files: ['x.js'] })");
  check('F1d chrome.scripting 桩记下调用', bg.injected.length === 1 && bg.injected[0].target.tabId === 7, JSON.stringify(bg.injected));
}

// ---------- F2 manual 计时器 ----------
{
  const bg = await background({ timers: 'manual' });
  const start = bg.run('Date.now()');
  bg.run('globalThis.hits = []; setTimeout(() => { hits.push(Date.now()); setTimeout(() => hits.push(Date.now()), 1000); }, 500)');
  await bg.timers.advance(499);
  const early = bg.run('hits.length');
  await bg.timers.advance(1);
  const firstAt = bg.run('hits[0]');
  const pendingAfterFirst = bg.timers.pending();
  const fired = await bg.timers.runAll();
  const cleared = bg.run('(() => { const t = setTimeout(() => hits.push(-1), 10); clearTimeout(t); return t; })()');
  await bg.timers.runAll();
  check('F2a advance 只触发到期的定时器，回调里 Date.now() 就是到期时刻',
    early === 0 && firstAt === start + 500, JSON.stringify({ early, firstAt, start }));
  check('F2b 回调里新挂的定时器进队列，runAll 排空，clearTimeout 生效',
    pendingAfterFirst.length === 1 && pendingAfterFirst[0].delay === 1000 && fired === 1
      && same(bg.run('hits'), [start + 500, start + 1500]) && cleared > 0 && bg.timers.pending().length === 0,
    JSON.stringify({ pendingAfterFirst, fired, hits: bg.run('hits') }));
}

// ---------- F3 translator 注入 / F4 send / F5 resetDramasCache ----------
{
  const stub = { async translateTitleAndDesc() { return { title: '替身', desc: '' }; }, async translateBatchAI() { return []; } };
  const bg = await background({ translator: stub });
  check('F3 translator 注入：后台解析到替身，真实 translator.js 未加载', bg.run('Translator') === stub, typeof bg.run('Translator'));

  const state = await bg.send({ action: 'getTranslateState' });
  check('F4 send 以扩展页面身份发消息并拿到应答', typeof state?.running === 'boolean', JSON.stringify(state));

  // 启动时的队列读已把缓存装热：只改 storage 的话队列读仍拿缓存
  const queueRead = async () => (await bg.run('enqueueDramaWrite("infra-guard 读表", getDramasInQueue)')).length;
  bg.storage.seedDramas([card('tt1')]);
  const stale = await queueRead();
  await bg.resetDramasCache();
  const fresh = await queueRead();
  bg.seedDramas([card('tt1'), card('tt2'), card('tt3')]);
  const reseeded = await queueRead();
  check('F5a 只改 storage 时队列读仍命中缓存；resetDramasCache 后重读 storage', stale === 0 && fresh === 1, JSON.stringify({ stale, fresh }));
  check('F5b bg.seedDramas 改表并连带让缓存失效', reseeded === 3 && bg.dramas().length === 3, JSON.stringify({ reseeded }));
}
{
  const plain = await background();
  const stubbed = await background({ dnr: true });
  let duplicate = null;
  await stubbed.run('chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 1 }] })').catch(e => { duplicate = e.message; });
  check('F6a 缺省不提供 chrome.declarativeNetRequest（历来如此）', plain.run('typeof chrome.declarativeNetRequest') === 'undefined');
  check('F6b dnr:true 的桩与 Chrome 同口径：规则存进 bg.dnr.rules，加重复 id 会 reject',
    stubbed.dnr.rules.size === 1 && typeof duplicate === 'string' && duplicate.includes('unique'), JSON.stringify({ size: stubbed.dnr.rules.size, duplicate }));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
