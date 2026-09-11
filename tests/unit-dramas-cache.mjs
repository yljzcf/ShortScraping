import './bootstrap.cjs';
// A6 回归测试：dramas 单写者队列引入 SW 生命周期内存缓存。
// 断言：N 条保存只 1 次全表 get；写失败缓存失效重读不丢不叠；快照读零 get；
// copy-on-write（快照读者持有的旧引用不被就地突变）。
// 用法：node tests/unit-dramas-cache.mjs（改造前跑 T1 应 RED=20 次全表读）
import fs from 'node:fs';

const rawStore = {};
const listeners = { runtimeMessage: [] };
let getLog = [];
let failNextSet = false;

function pickKeys(keys) {
  const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? rawStore);
  const out = {};
  for (const k of wanted) if (k in rawStore) out[k] = structuredClone(rawStore[k]);
  return out;
}

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        getLog.push(typeof keys === 'string' ? [keys] : Array.isArray(keys) ? [...keys] : Object.keys(keys ?? {}));
        await Promise.resolve();
        return pickKeys(keys);
      },
      async set(obj) {
        if (failNextSet) { failNextSet = false; throw new Error('unit stub: 注入的 set 失败'); }
        await Promise.resolve();
        for (const [k, v] of Object.entries(obj)) rawStore[k] = structuredClone(v);
      }
    },
    onChanged: { addListener() {} }
  },
  runtime: {
    getURL: p => `chrome-extension://unit-test/${p}`,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { listeners.runtimeMessage.push(fn); } },
    sendMessage(message, callback) {
      const deliver = new Promise((resolve) => {
        let settled = false;
        const sendResponse = (resp) => { if (!settled) { settled = true; resolve(resp); } };
        let keepOpen = false;
        for (const fn of listeners.runtimeMessage) {
          if (fn(message, { id: 'unit-test' }, sendResponse) === true) keepOpen = true;
        }
        if (!keepOpen && !settled) { settled = true; resolve(undefined); }
      });
      if (typeof callback === 'function') { deliver.then(callback); return; }
      return deliver;
    }
  },
  alarms: { async get() { return undefined; }, async clear() { return true; }, create() {}, onAlarm: { addListener() {} } },
  tabs: { create() {}, remove() {}, onUpdated: { addListener() {}, removeListener() {} } },
  notifications: { create() {} },
  scripting: { async executeScript() { return []; } }
};
globalThis.importScripts = () => {};

const SUB = 'https://unit.test/list';
let csvPosts = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('tag.json')) return { ok: true, json: async () => [{ url: SUB, tags: ['T'] }] };
  if (u.includes('/sync')) {
    csvPosts.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ ok: true, count: 0, csvPath: 'stub.csv' }) };
  }
  throw new TypeError('unit stub: no network');
};
globalThis.Translator = { async translateTitleAndDesc() { return { title: '', desc: '' }; } };

const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

for (const rel of ['../src/shared/url-match.js', '../src/shared/site-registry.js', '../src/shared/timeline-csv.js', '../src/shared/schedule-config.js', '../src/shared/lark.js']) {
  (0, eval)(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
}
rawStore.dramas = [];
rawStore.urlTags = [{ urlPattern: SUB, tags: ['T'] }];
(0, eval)(fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700); // 顶层初始化落定（含迁移标记落库）

const mk = (n) => ({
  id: `id-${n}`, itemId: `tt${String(n).padStart(4, '0')}`, title: `Title ${n}`,
  description: `desc ${n}`, status: 'new', source: 'unittest', sourceListUrl: SUB, tags: ['T']
});
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const dramasReads = () => getLog.filter(keys => keys.includes('dramas')).length;
const send = (msg) => chrome.runtime.sendMessage(msg);

// ---------- T1 连发 20 条保存：全表 get ≤1（旧代码 RED=20 次） ----------
{
  getLog = [];
  const flags = [];
  for (let i = 1; i <= 20; i++) flags.push((await send({ action: 'saveDrama', drama: mk(i) }))?.saved);
  check('T1a 20 条保存 dramas 全表 get ≤1', dramasReads() <= 1, `reads=${dramasReads()}`);
  check('T1b 20 条全部落库', (rawStore.dramas || []).length === 20, `len=${rawStore.dramas?.length}`);
  check('T1c saved 布尔逐条为 true', flags.every(f => f === true), JSON.stringify(flags));
  const dup = await send({ action: 'saveDrama', drama: mk(1) });
  check('T1d 重复 itemId 仍被拒（缓存判重）', dup?.saved === false && (rawStore.dramas || []).length === 20, JSON.stringify(dup));
}

// ---------- T2 保存后翻译更新：零额外全表 get + copy-on-write ----------
{
  const snapshotBefore = await getDramasSnapshot(); // eslint-disable-line no-undef -- 持有缓存旧引用
  const cardBefore = snapshotBefore.find(d => d.id === 'id-5');
  getLog = [];
  const resp = await send({ action: 'applyTranslation', dramaId: 'id-5', result: { title: '五', desc: '五简介' } });
  check('T2a 翻译更新零全表 get', dramasReads() === 0, `reads=${dramasReads()}`);
  check('T2b 翻译结果落库', resp?.updated === true && (rawStore.dramas || []).find(d => d.id === 'id-5')?.titleZh === '五', JSON.stringify(resp));
  check('T2c copy-on-write：旧快照引用未被就地突变', cardBefore.titleZh === undefined && snapshotBefore.find(d => d.id === 'id-5').titleZh === undefined, JSON.stringify(cardBefore));
  const snapshotAfter = await getDramasSnapshot(); // eslint-disable-line no-undef
  check('T2d 新快照可见新值且引用已更换', snapshotAfter !== snapshotBefore && snapshotAfter.find(d => d.id === 'id-5')?.titleZh === '五', '');
}

// ---------- T3 set 失败：缓存失效重读，不丢不叠 ----------
{
  failNextSet = true;
  const failResp = await send({ action: 'saveDrama', drama: mk(21) });
  check('T3a 注入失败经消息层报错', failResp?.success === false, JSON.stringify(failResp));
  getLog = [];
  const retry = await send({ action: 'saveDrama', drama: mk(21) });
  check('T3b 失败后缓存失效重读（恰 1 次 get）', dramasReads() === 1, `reads=${dramasReads()}`);
  check('T3c 重试成功且不丢不叠', retry?.saved === true && (rawStore.dramas || []).length === 21
    && (rawStore.dramas || []).filter(d => d.itemId === 'tt0021').length === 1, `len=${rawStore.dramas?.length}`);
}

// ---------- T4 队列外快照读者（CSV 同步）零全表 get ----------
{
  getLog = [];
  csvPosts = [];
  await syncTimelineToCsv(); // eslint-disable-line no-undef
  check('T4a CSV 同步走快照零全表 get', dramasReads() === 0, `reads=${dramasReads()}`);
  check('T4b 推送内容完整（21 条）', csvPosts.length === 1 && csvPosts[0].dramas.length === 21, `posts=${csvPosts.length} len=${csvPosts[0]?.dramas?.length}`);
}

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
