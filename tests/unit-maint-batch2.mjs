import './bootstrap.cjs';
// 维护批次 2 回归测试：chrome 桩 + eval 真实 background.js / url-match.js / translator.js。
//   A-3 抓取串行化：手动+定时并发触发时排队执行，后台标签页并发数恒为 1，各自拿到自己的结果
//   A-4 归属精确匹配：互为前缀的订阅不串扰（退订 ?list=… 后其卡片不再挂在基础订阅名下）
//   A-5 手动翻译 join 空扫描轮也能收到终态（按钮不再 ⏳ 卡死）；纯自动空轮仍静默
//   A-6 翻译 0 成功时 summary.error 必置位（AI 传输错误原样透传，API 全失败给通用提示）
//   T9  真实 translator.js：未配置/HTTP 非 200/非 JSON 抛异常；模型内容跑偏仍返回空串数组
// 用法：node tests/unit-maint-batch2.mjs（修复前跑应 RED，修复后全 PASS）
import fs from 'node:fs';

let unhandledCount = 0;
process.on('unhandledRejection', (e) => { unhandledCount++; console.error('UNHANDLED:', e?.message || e); });

// ---------- chrome 桩 ----------
const rawStore = {};
const alarmStore = new Map();
const listeners = { runtimeMessage: [], onAlarm: [], tabUpdated: [] };

// 标签页桩：记录并发峰值；create 后异步宣告 complete，sendMessage 模拟抓取耗时
let nextTabId = 1;
const openTabs = new Set();
let maxConcurrentTabs = 0;
let scrapeMessageDelayMs = 30;
const tabCreateLog = [];
let failNextSet = false; // 注入一次 set 失败（让队列内存缓存失效，见 resetDramasCache）

function pickKeys(keys) {
  const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? rawStore);
  const out = {};
  for (const k of wanted) if (k in rawStore) out[k] = structuredClone(rawStore[k]);
  return out;
}

const chromeStub = {
  storage: {
    local: {
      // 兼容 Promise 与回调两种形式（translator.js getConfig 用回调形式）
      get(keys, cb) {
        const out = Promise.resolve().then(() => pickKeys(keys));
        if (typeof cb === 'function') { out.then(cb); return; }
        return out;
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
    sendMessage() { return Promise.resolve(undefined); }
  },
  alarms: {
    async get(name) { return alarmStore.get(name); },
    async clear(name) { return alarmStore.delete(name); },
    create(name, info) { alarmStore.set(name, { name, ...info, scheduledTime: info.when ?? Date.now() }); },
    onAlarm: { addListener(fn) { listeners.onAlarm.push(fn); } }
  },
  tabs: {
    async create({ url }) {
      const id = nextTabId++;
      openTabs.add(id);
      maxConcurrentTabs = Math.max(maxConcurrentTabs, openTabs.size);
      tabCreateLog.push(url);
      setTimeout(() => { for (const fn of listeners.tabUpdated) fn(id, { status: 'complete' }); }, 5);
      return { id };
    },
    async remove(id) { openTabs.delete(id); },
    async sendMessage(id, msg) {
      if (msg?.action !== 'scrape') return undefined;
      await new Promise(r => setTimeout(r, scrapeMessageDelayMs));
      return { success: true, data: [{ status: 'new' }] };
    },
    onUpdated: {
      addListener(fn) { listeners.tabUpdated.push(fn); },
      removeListener(fn) { const i = listeners.tabUpdated.indexOf(fn); if (i >= 0) listeners.tabUpdated.splice(i, 1); }
    }
  },
  notifications: { create() {} },
  scripting: { async executeScript() { return []; } }
};

globalThis.chrome = chromeStub;
globalThis.importScripts = () => {};
globalThis.fetch = async () => { throw new TypeError('unit stub: no network'); };

// Translator 桩：按用例切换行为
let batchBehavior = async (items) => items.map(() => ({ title: '', desc: '' }));
let singleBehavior = async () => ({ title: '', desc: '' });
globalThis.Translator = {
  translateBatchAI: (items) => batchBehavior(items),
  translateTitleAndDesc: (t, d) => singleBehavior(t, d)
};

const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

// ---------- 加载真实生产代码 ----------
try {
  (0, eval)(fs.readFileSync(new URL('../src/shared/url-match.js', import.meta.url), 'utf8'));
} catch { /* RED 检查：旧代码树没有 url-match.js */ }
try {
  // v1.5.1 起 siteOfUrl 与 lark 显示名取自 site-registry.js，须先加载
  (0, eval)(fs.readFileSync(new URL('../src/shared/site-registry.js', import.meta.url), 'utf8'));
  (0, eval)(fs.readFileSync(new URL('../src/shared/timeline-csv.js', import.meta.url), 'utf8'));
  (0, eval)(fs.readFileSync(new URL('../src/shared/schedule-config.js', import.meta.url), 'utf8'));
  (0, eval)(fs.readFileSync(new URL('../src/shared/lark.js', import.meta.url), 'utf8'));
} catch { /* 旧代码树没有这两个模块 */ }
(0, eval)(fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8'));

// 直改 rawStore.dramas 前先让队列内存缓存失效（v1.5.1 引入；缓存在 eval 私有词法
// 环境外部触不到，借生产语义：注入 set 失败让 writeDramasInQueue 置空缓存）
const resetDramasCache = async () => {
  failNextSet = true;
  await clearAllDramas().catch(() => {});
  failNextSet = false;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700);

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const BASE = 'https://my-drama.example/';
const LISTQ = 'https://my-drama.example/?list=best_choices';
const SUB2 = 'https://unit.test/list';
const mk = (n, over = {}) => ({
  id: `id-${n}`, imdbId: `tt00${n}`, title: `Title ${n}`, description: `desc ${n}`,
  status: 'trans', source: 'unittest', sourceListUrl: SUB2, tags: ['T'], titleZh: 'x', ...over
});

// ============ A-4：归属精确匹配（filterDramasByConfiguredUrls 直调） ============
{
  const dramas = [
    mk(1, { sourceListUrl: BASE }),
    mk(2, { sourceListUrl: LISTQ }),
    mk(3, { sourceListUrl: 'https://unit.test/list/' }) // 尾斜杠差异
  ];
  const onlyBase = filterDramasByConfiguredUrls(dramas, [{ urlPattern: BASE, tags: ['T'] }]);
  check('T6a 退订 ?list=… 后其卡片不再挂在基础订阅名下',
    onlyBase.length === 1 && onlyBase[0].imdbId === 'tt001', JSON.stringify(onlyBase.map(d => d.sourceListUrl)));

  const both = filterDramasByConfiguredUrls(dramas, [
    { urlPattern: BASE, tags: ['T'] }, { urlPattern: LISTQ, tags: ['T'] }
  ]);
  check('T6b 两个订阅都在时各归各位', both.length === 2, `${both.length}`);

  const slashTolerant = filterDramasByConfiguredUrls(dramas, [{ urlPattern: SUB2, tags: ['T'] }]);
  check('T6c 尾斜杠差异归一后仍命中', slashTolerant.length === 1 && slashTolerant[0].imdbId === 'tt003',
    JSON.stringify(slashTolerant.map(d => d.sourceListUrl)));
}

// ============ A-3：抓取串行化 ============
{
  rawStore.urlTags = [
    { urlPattern: 'https://www.imdb.com/search/title/?unit=1', tags: ['IMDB'] },
    { urlPattern: 'https://store.steampowered.com/category/unit', tags: ['Steam'] }
  ];
  await resetDramasCache(); rawStore.dramas = [];
  maxConcurrentTabs = 0;
  tabCreateLog.length = 0;

  const p1 = performScrape();                 // 全量：2 个 URL
  const p2 = performScrape({ site: 'imdb' }); // 并发的手动单站
  const [r1, r2] = await Promise.all([p1, p2]);

  check('T5a 两次并发调用各自拿到自己的结果', r1?.urlCount === 2 && r2?.urlCount === 1,
    JSON.stringify({ r1: r1?.urlCount, r2: r2?.urlCount }));
  check('T5b 后台抓取标签页并发峰值为 1（串行队列生效）', maxConcurrentTabs === 1, `max=${maxConcurrentTabs}`);
  check('T5c 队列按序执行（全量的 2 个 URL 先于单站的 1 个）', tabCreateLog.length === 3 &&
    tabCreateLog[2].includes('imdb'), JSON.stringify(tabCreateLog));
}

// ============ A-5：手动 join 空扫描轮也能收到终态 ============
{
  rawStore.urlTags = [{ urlPattern: SUB2, tags: ['T'] }];
  await resetDramasCache(); rawStore.dramas = [mk(1), mk(2)]; // 全部已翻译 → 空扫描
  rawStore.translateConfig = { translateMode: 'api', delayMs: 1 };

  // T7a 纯自动空轮：不写终态（收尾防闪烁语义保持）
  delete rawStore.translateRunState;
  await performTranslate();
  check('T7a 纯自动空轮仍静默（不写 translateRunState）', rawStore.translateRunState === undefined,
    JSON.stringify(rawStore.translateRunState));

  // T7b 手动 join 到进行中的自动空轮：必须写终态
  delete rawStore.translateRunState;
  const pAuto = performTranslate();               // 自动空轮起跑（在首个 await 处挂起）
  const pManual = performTranslate({ source: 'manual' }); // 同 tick join
  await Promise.all([pAuto, pManual]);
  await sleep(50);
  const st = rawStore.translateRunState;
  check('T7b 手动 join 空轮后写出终态（running:false + finishedAt）',
    st && st.running === false && typeof st.finishedAt === 'number', JSON.stringify(st));

  // T7c 终态消费后，后续纯自动空轮不再连带写终态（等待者标记已复位）
  delete rawStore.translateRunState;
  await performTranslate();
  check('T7c 等待者标记消费后复位（下轮自动空轮仍静默）', rawStore.translateRunState === undefined,
    JSON.stringify(rawStore.translateRunState));
}

// ============ A-6：翻译 0 成功必须报错 ============
{
  rawStore.urlTags = [{ urlPattern: SUB2, tags: ['T'] }];
  rawStore.translateConfig = { translateMode: 'ai', aiEndpoint: 'https://x.test/v1', aiApiKey: 'k', batchSize: 10, delayMs: 1 };

  // T8a AI 传输错误按原文透传
  await resetDramasCache(); rawStore.dramas = [mk(1, { status: 'new', titleZh: '' }), mk(2, { status: 'new', titleZh: '' })];
  batchBehavior = async () => { throw new Error('AI 接口 HTTP 400'); };
  const r1 = await performTranslate({ source: 'manual' });
  check('T8a AI 全败时 error 透传接口错误', r1?.error?.includes('HTTP 400') === true, JSON.stringify(r1));
  check('T8b 终态 summary.error 置位', rawStore.translateRunState?.summary?.error?.includes('HTTP 400') === true,
    JSON.stringify(rawStore.translateRunState?.summary));
  check('T8c 失败条目保持待翻译（下轮重试）', (rawStore.dramas || []).every(d => d.status === 'new'),
    JSON.stringify(rawStore.dramas?.map(d => d.status)));

  // T8d 有写入就不报「检查配置」——哪怕只补到一半。
  // v1.5.14 语义变更：夹具的 description 非空，只回片名不回简介＝半成品，
  // 不计完成（translatedCount 0）、保持 new 下轮补；但接口明明通了，不该报错。
  await resetDramasCache(); rawStore.dramas = [mk(1, { status: 'new', titleZh: '' }), mk(2, { status: 'new', titleZh: '' })];
  batchBehavior = async (items) => items.map((_, i) => (i === 0 ? { title: '中文', desc: '' } : { title: '', desc: '' }));
  const r2 = await performTranslate({ source: 'manual' });
  check('T8d 半成品不报「检查配置」', !r2?.error, JSON.stringify(r2));
  check('T8d2 半成品存下已得片名但保持待翻译', (rawStore.dramas || [])
    .every(d => d.status === 'new') && (rawStore.dramas || [])[0]?.titleZh === '中文',
    JSON.stringify((rawStore.dramas || []).map(d => [d.status, d.titleZh, d.descriptionZh])));

  // T8f 完整返回才计完成
  await resetDramasCache(); rawStore.dramas = [mk(1, { status: 'new', titleZh: '' }), mk(2, { status: 'new', titleZh: '' })];
  batchBehavior = async (items) => items.map((_, i) => (i === 0 ? { title: '中文', desc: '中文简介' } : { title: '', desc: '' }));
  const rComplete = await performTranslate({ source: 'manual' });
  check('T8f 完整返回的才计完成（1/2）', rComplete?.translatedCount === 1 && !rComplete?.error,
    JSON.stringify(rComplete));

  // T8e API 模式全失败给通用提示
  rawStore.translateConfig = { translateMode: 'api', delayMs: 1 };
  await resetDramasCache(); rawStore.dramas = [mk(1, { status: 'new', titleZh: '' })];
  singleBehavior = async () => ({ title: '', desc: '' });
  const r3 = await performTranslate({ source: 'manual' });
  check('T8e API 全败时给通用配置提示', r3?.error?.includes('config/trans.json') === true, JSON.stringify(r3));
}

// ============ T9：真实 translator.js 的传输层错误语义（最后跑，覆盖全局 Translator） ============
{
  (0, eval)(fs.readFileSync(new URL('../src/shared/translator.js', import.meta.url), 'utf8'));

  // 未配置端点/密钥 → 抛异常
  rawStore.translateConfig = { translateMode: 'ai', aiEndpoint: '', aiApiKey: '' };
  let msg1 = '';
  try { await globalThis.Translator.translateBatchAI([{ title: 'A', desc: '' }]); } catch (e) { msg1 = e.message; }
  check('T9a 未配置端点/密钥抛异常', msg1.includes('未配置'), msg1);

  // HTTP 非 200 → 抛异常带状态码
  rawStore.translateConfig = { translateMode: 'ai', aiEndpoint: 'https://x.test/v1', aiApiKey: 'k', requestTimeoutSec: 5 };
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  let msg2 = '';
  try { await globalThis.Translator.translateBatchAI([{ title: 'A', desc: '' }]); } catch (e) { msg2 = e.message; }
  check('T9b HTTP 非 200 抛异常带状态码', msg2.includes('401'), msg2);

  // 模型内容跑偏（解析不出）→ 不抛，返回等长空串数组
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '抱歉我不会' } }] }) });
  const arr = await globalThis.Translator.translateBatchAI([{ title: 'A', desc: '' }, { title: 'B', desc: '' }]);
  check('T9c 内容解析失败仍返回等长空串数组', Array.isArray(arr) && arr.length === 2 && arr.every(x => x.title === '' && x.desc === ''),
    JSON.stringify(arr));
}

await sleep(100);
check('T10 全程无未捕获 rejection', unhandledCount === 0, `unhandled=${unhandledCount}`);

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  origLog(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  ← ${r.detail}`}`);
}
origLog(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
