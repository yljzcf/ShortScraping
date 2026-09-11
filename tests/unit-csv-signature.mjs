import './bootstrap.cjs';
// A7 回归测试：CSV 同步客户端内容签名跳过 + warmup 强推兜底。
// 用法：node tests/unit-csv-signature.mjs（改造前跑 T1 应 RED=同内容两次 POST）
import fs from 'node:fs';

const rawStore = {};
const listeners = { runtimeMessage: [] };

function pickKeys(keys) {
  const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? rawStore);
  const out = {};
  for (const k of wanted) if (k in rawStore) out[k] = structuredClone(rawStore[k]);
  return out;
}

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) { await Promise.resolve(); return pickKeys(keys); },
      async set(obj) { await Promise.resolve(); for (const [k, v] of Object.entries(obj)) rawStore[k] = structuredClone(v); }
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
let failCsvPost = false;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('tag.json')) return { ok: true, json: async () => [{ url: SUB, tags: ['T'] }] };
  if (u.includes('/sync')) {
    if (failCsvPost) { failCsvPost = false; throw new TypeError('unit stub: 同步服务不可达'); }
    csvPosts.push(init.body);
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
await sleep(700);

const mk = (n) => ({
  id: `id-${n}`, itemId: `tt${String(n).padStart(4, '0')}`, title: `Title ${n}`,
  description: `desc ${n}`, status: 'new', source: 'unittest', sourceListUrl: SUB, tags: ['T']
});
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const send = (msg) => chrome.runtime.sendMessage(msg);

// 数据经生产路径灌入（缓存同步）
await send({ action: 'saveDrama', drama: mk(1) });
await send({ action: 'saveDrama', drama: mk(2) });

// ---------- T1 同内容两次触发只 POST 一次 ----------
{
  csvPosts = [];
  await syncTimelineToCsv(); // eslint-disable-line no-undef
  await syncTimelineToCsv(); // eslint-disable-line no-undef
  check('T1 同内容两触发仅 1 次 POST（旧代码 2 次）', csvPosts.length === 1, `posts=${csvPosts.length}`);
}

// ---------- T2 body 拼接正确性：解析回与数据深等 ----------
{
  const parsed = JSON.parse(csvPosts[0]);
  check('T2a body 可解析且 dramas 深等', JSON.stringify(parsed.dramas) === JSON.stringify(rawStore.dramas), '');
  check('T2b syncedAt 为合法 ISO 串', typeof parsed.syncedAt === 'string' && !Number.isNaN(Date.parse(parsed.syncedAt)), String(parsed.syncedAt));
}

// ---------- T3 内容变化后照常 POST ----------
{
  csvPosts = [];
  await send({ action: 'saveDrama', drama: mk(3) });
  await syncTimelineToCsv(); // eslint-disable-line no-undef
  check('T3 内容变化后照常推送', csvPosts.length === 1 && JSON.parse(csvPosts[0]).dramas.length === 3, `posts=${csvPosts.length}`);
}

// ---------- T4 POST 失败签名不记录，下次重试 ----------
{
  csvPosts = [];
  await send({ action: 'saveDrama', drama: mk(4) });
  failCsvPost = true;
  let threw = false;
  await syncTimelineToCsv().catch(() => { threw = true; }); // eslint-disable-line no-undef
  await syncTimelineToCsv(); // eslint-disable-line no-undef
  check('T4 失败不记签名、重试成功推送', threw === true && csvPosts.length === 1 && JSON.parse(csvPosts[0]).dramas.length === 4, `threw=${threw} posts=${csvPosts.length}`);
}

// ---------- T5 warmup 消息强推：同内容也重新 POST ----------
{
  csvPosts = [];
  await send({ action: 'warmupCsvSync' });
  await sleep(700); // 等 500ms 防抖后的推送落定
  check('T5 warmup 清签名后同内容强推', csvPosts.length === 1, `posts=${csvPosts.length}`);
}

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
