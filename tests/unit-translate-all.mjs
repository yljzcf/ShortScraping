import './bootstrap.cjs';
// 「全部翻译」后台侧回归测试（unit-dramas-race 范式；2026-08-02 现代化：
// 对齐 v1.4.1 翻译状态机——triggerTranslate 改为立即 ack {success, started}
// 不再同步回传 summary，完成态经 translateRunState 驱动，测试改为轮询落库终态）。
// 目标行为：
//   ① triggerTranslate 立即应答 started:true（fire-and-forget，弹窗不再等长跑往返）
//   ② performTranslate 语义不变：只翻 status=new 且属于订阅 URL 的条目
//   ③ clearDramas 消息接口已移除（clearAllDramas 保留给安装初始化）
//   ④ 全部翻完后二次触发不重翻（translatedAt 不变）
// 注意：v1.5.1 起 SW 队列持有 dramas 内存缓存，直改 rawStore 前必须先让缓存
// 失效（借 unit-dramas-race 的 failNextSet 范式），否则翻译线读到旧缓存零待翻。
// 用法：node tests/unit-translate-all.mjs
import fs from 'node:fs';

// ---------- chrome 桩 ----------
const rawStore = {};
const listeners = { runtimeMessage: [] };
let failNextSet = false; // 注入一次 set 失败（配合队列缓存失效，见 resetDramasCache）

function pickKeys(keys) {
  const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? rawStore);
  const out = {};
  for (const k of wanted) if (k in rawStore) out[k] = structuredClone(rawStore[k]);
  return out;
}

const chromeStub = {
  storage: {
    local: {
      async get(keys) { await Promise.resolve(); return pickKeys(keys); },
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
  alarms: {
    async get() { return undefined; },
    async clear() { return true; },
    create() {},
    onAlarm: { addListener() {} }
  },
  tabs: { create() {}, onUpdated: { addListener() {}, removeListener() {} } },
  notifications: { create() {} },
  scripting: { async executeScript() { return []; } }
};

globalThis.chrome = chromeStub;
// importScripts 真加载共享模块（noop 桩会让翻译线的 UrlMatch 订阅过滤
// ReferenceError 被 try 吃掉、零翻译）；translator.js 跳过——用下方确定性桩替代
globalThis.importScripts = (...paths) => {
  for (const p of paths) {
    if (String(p).includes('translator')) continue;
    const rel = String(p).replace('../shared/', '../src/shared/');
    (0, eval)(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
  }
};
globalThis.fetch = async () => { throw new TypeError('unit stub: no network'); };
// Translator 桩：确定性中文结果，性能开销为零
globalThis.Translator = {
  async translateTitleAndDesc(title, description) {
    return { title: `中·${title}`, desc: description ? `中文简介·${description}` : '' };
  }
};

// 压掉后台脚本自身的日志噪音，只留测试输出
const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

// ---------- 加载真实生产代码 ----------
const bgSrc = fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8');
(0, eval)(bgSrc);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(150); // 等后台顶层初始化落定

const mk = (n, itemId, over = {}) => ({
  id: `id-${n}`, itemId, title: `Title ${n}`, description: `desc ${n}`,
  status: 'new', source: 'unittest', sourceListUrl: 'https://unit.test/list',
  titleZh: '', descriptionZh: '', translatedAt: null, ...over
});
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
// 队列缓存失效（unit-dramas-race 同款）：注入一次 set 失败让 writeDramasInQueue
// 的 catch 置缓存为 null，随后直改 rawStore 等价「SW 冷启动前 storage 被外部改写」
const resetDramasCache = async () => {
  failNextSet = true;
  await clearAllDramas().catch(() => {}); // eslint-disable-line no-undef
};

// ---------- 场景数据 ----------
// A/B：待翻译且属订阅 URL；C：已翻译（不重翻）；D：待翻译但非订阅来源（须跳过）
await resetDramasCache();
rawStore.urlTags = [{ urlPattern: 'https://unit.test/list', tags: ['T'] }];
rawStore.translateConfig = { translateMode: 'api', delayMs: 1 };
rawStore.dramas = [
  mk('A', 'tt0001'),
  mk('B', 'tt0002'),
  mk('C', 'tt0003', { status: 'trans', titleZh: '既有译名', translatedAt: '2026-07-01T00:00:00.000Z' }),
  mk('D', 'tt0004', { sourceListUrl: 'https://other.example/list' })
];

// ---------- T1 triggerTranslate 立即 ack（v1.4.1 状态机语义） ----------
const resp = await chromeStub.runtime.sendMessage({ action: 'triggerTranslate' });
check('T1a triggerTranslate 成功响应', resp?.success === true, JSON.stringify(resp));
check('T1b 立即 ack started:true（不再同步回传 summary）', resp?.started === true, JSON.stringify(resp));

// 等异步翻译轮落库（Translator 桩即时返回，正常远快于上限）
for (let i = 0; i < 40; i++) {
  const ds = rawStore.dramas || [];
  if (ds.filter(d => d.status === 'trans').length >= 3) break;
  await sleep(100);
}

// ---------- T2 翻译语义不变 ----------
{
  const dramas = rawStore.dramas || [];
  const byId = Object.fromEntries(dramas.map(d => [d.itemId, d]));
  check('T2a 订阅内 new 条目已翻译落库',
    byId.tt0001?.status === 'trans' && byId.tt0001?.titleZh === '中·Title A' &&
    byId.tt0002?.status === 'trans' && byId.tt0002?.titleZh === '中·Title B',
    JSON.stringify({ A: byId.tt0001, B: byId.tt0002 }));
  check('T2b 已翻译条目不重翻',
    byId.tt0003?.titleZh === '既有译名' && byId.tt0003?.translatedAt === '2026-07-01T00:00:00.000Z',
    JSON.stringify(byId.tt0003));
  check('T2c 非订阅来源条目不动',
    byId.tt0004?.status === 'new' && !byId.tt0004?.titleZh,
    JSON.stringify(byId.tt0004));
}

// ---------- T3 clearDramas 消息接口已移除 ----------
{
  const before = (rawStore.dramas || []).length;
  const clearResp = await chromeStub.runtime.sendMessage({ action: 'clearDramas' });
  const after = (rawStore.dramas || []).length;
  check('T3a clearDramas 消息不再有处理器', clearResp === undefined, JSON.stringify(clearResp));
  check('T3b 数据未被清空', after === before && before === 4, `before=${before} after=${after}`);
}

// ---------- T4 全部翻完后二次触发不重翻（translatedAt 逐键不变） ----------
{
  const stamp = () => JSON.stringify((rawStore.dramas || []).map(d => [d.itemId, d.status, d.translatedAt, d.titleZh]));
  const before = stamp();
  const resp2 = await chromeStub.runtime.sendMessage({ action: 'triggerTranslate' });
  await sleep(600); // 给异步空扫描一轮落定时间
  check('T4a 二次触发立即 ack 且不重翻（translatedAt/译文不变）',
    resp2?.success === true && resp2?.started === true && stamp() === before,
    JSON.stringify({ resp2, after: stamp() }));
}

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
