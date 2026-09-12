import './bootstrap.cjs';
// 回归测试：群机器人自动推送的触发点与启用水位线（v1.5.14）。
//
// 两个触发点（互斥，故无需持久「已推送」标记）：
//   ① 翻译线把一条从 new 补成 trans 时推（走 AI 翻译的站点）；
//   ② 抓取入库时该卡已是 trans 时推（平台自带中文齐全，不进翻译线）。
//
// **W 组是本套件的存在理由**：库里 3454 条存量（含 resetPartialTranslations
// 退回队列的 683 条）会陆续走完翻译线。没有「启用水位线」的话，一开机器人就会
// 在群里瞬间刷出几百条消息。水位线＝只推 scrapedAt 晚于启用时刻的卡。
// 用法：node tests/unit-lark-bot-trigger.mjs
import fs from 'node:fs';

const rawStore = {};
let failNextSet = false;
const botPosts = [];          // 捕获发往机器人的请求

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
      },
      async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) delete rawStore[k]; }
    },
    onChanged: { addListener(fn) { chromeStub.__onChanged = fn; } }
  },
  runtime: {
    getURL: p => `chrome-extension://unit-test/${p}`,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { chromeStub.__msg = fn; } },
    sendMessage(message) {
      return new Promise((resolve) => {
        const handled = chromeStub.__msg?.(message, {}, resolve);
        if (!handled) resolve(undefined);
      });
    },
    lastError: null
  },
  alarms: { async getAll() { return []; }, async clear() { return true; }, create() {}, onAlarm: { addListener() {} } },
  tabs: { create() {}, onUpdated: { addListener() {}, removeListener() {} } },
  notifications: { create() {} },
  scripting: { async executeScript() { return []; } }
};
globalThis.chrome = chromeStub;

globalThis.importScripts = (...paths) => {
  for (const p of paths) {
    if (String(p).includes('translator')) continue;
    const rel = String(p).replace('../shared/', '../src/shared/');
    (0, eval)(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
  }
};

const BOT_HOOK = 'https://open.larksuite.com/open-apis/bot/v2/hook/unit-test';
globalThis.fetch = async (url, options) => {
  if (String(url) === BOT_HOOK) {
    botPosts.push(JSON.parse(options?.body || '{}'));
    return { ok: true, status: 200, async text() { return JSON.stringify({ code: 0, msg: 'success' }); } };
  }
  throw new TypeError('unit stub: no network');
};

globalThis.Translator = {
  async translateTitleAndDesc(title) { return { title: `中·${title}`, desc: '中文简介' }; }
};

const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

(0, eval)(fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(150);

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const resetDramasCache = async () => { failNextSet = true; await clearAllDramas().catch(() => {}); }; // eslint-disable-line no-undef

const SUB = 'https://unit.test/list';
const ENABLED_AT = '2026-09-12T00:00:00.000Z';
const BEFORE = '2026-09-11T00:00:00.000Z';   // 启用之前抓到的（存量）
const AFTER = '2026-09-12T06:00:00.000Z';    // 启用之后抓到的（新增）

const mk = (id, over = {}) => ({
  id, itemId: id, title: `T-${id}`, description: `D-${id}`,
  status: 'new', source: 'netshort', sourceListUrl: SUB,
  titleZh: '', descriptionZh: '', translatedAt: null, scrapedAt: AFTER, ...over
});

const setupBot = async ({ enabled = true, enabledAt = ENABLED_AT } = {}) => {
  rawStore.larkConfig = { webhookUrl: '', botWebhookUrl: BOT_HOOK, botEnabled: enabled, requestTimeoutSec: 5 };
  rawStore.larkBotState = enabledAt ? { enabledAt } : {};
  rawStore.urlTags = [{ urlPattern: SUB, tags: ['T'] }];
  rawStore.translateConfig = { translateMode: 'api', delayMs: 1 };
};

async function runTranslateRound() {
  await chromeStub.runtime.sendMessage({ action: 'triggerTranslate' });
  for (let i = 0; i < 60; i++) {
    await sleep(80);
    if (rawStore.translateRunState?.running === false) break;
  }
  await sleep(250);
}

// ---------- W 组：启用水位线（防存量刷屏） ----------
await resetDramasCache(); await setupBot();
botPosts.length = 0;
rawStore.dramas = [
  mk('old1', { scrapedAt: BEFORE }),
  mk('old2', { scrapedAt: BEFORE }),
  mk('new1', { scrapedAt: AFTER })
];
await runTranslateRound();
check('W1 只推启用之后抓到的卡（存量翻完不刷屏）', botPosts.length === 1,
  `posts=${botPosts.length} ${JSON.stringify(botPosts.map(p => p.card?.elements?.[0]?.text?.content))}`);
check('W2 推的正是那条新卡', JSON.stringify(botPosts[0] || {}).includes('中·T-new1'),
  JSON.stringify(botPosts[0]?.card?.elements?.[0]));
check('W3 存量条目仍正常翻译（只是不推）',
  (rawStore.dramas || []).every(d => d.status === 'trans'),
  JSON.stringify((rawStore.dramas || []).map(d => [d.id, d.status])));

// ---------- T 组：翻译完成才推、半成品不推 ----------
await resetDramasCache(); await setupBot();
botPosts.length = 0;
globalThis.Translator = {
  async translateTitleAndDesc(title) {
    return title === 'T-partial' ? { title: '', desc: '只有简介' } : { title: `中·${title}`, desc: '中文简介' };
  }
};
rawStore.dramas = [mk('done'), mk('partial')];
await runTranslateRound();
check('T1 只有翻译完成的才推（半成品不推）', botPosts.length === 1
  && JSON.stringify(botPosts[0]).includes('中·T-done'),
  `posts=${botPosts.length} ${JSON.stringify(botPosts.map(p => JSON.stringify(p).slice(0, 60)))}`);
check('T2 半成品仍留在待翻译队列',
  (rawStore.dramas || []).find(d => d.id === 'partial')?.status === 'new', '');

// 半成品下一轮补齐后才推
globalThis.Translator = {
  async translateTitleAndDesc(title) { return { title: `中·${title}`, desc: '中文简介' }; }
};
botPosts.length = 0;
await runTranslateRound();
check('T3 半成品补齐后补推一次', botPosts.length === 1
  && JSON.stringify(botPosts[0]).includes('中·T-partial'),
  `posts=${botPosts.length}`);

// ---------- N 组：抓取时已 trans 的新卡（平台自带中文，不进翻译线） ----------
await resetDramasCache(); await setupBot();
botPosts.length = 0;
rawStore.dramas = [];
const native = { ...mk('native'), status: 'trans', titleZh: '平台中文名', descriptionZh: '平台中文简介', translatedAt: AFTER };
await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama: native });
await sleep(300);
check('N1 抓取即 trans 的新卡直接推', botPosts.length === 1
  && JSON.stringify(botPosts[0]).includes('平台中文名'), `posts=${botPosts.length}`);

// 同一条再来一次＝去重命中，不该重复推
botPosts.length = 0;
await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama: native });
await sleep(300);
check('N2 去重命中的卡不重复推', botPosts.length === 0, `posts=${botPosts.length}`);

// 存量时间的平台中文卡同样受水位线约束
botPosts.length = 0;
await chromeStub.runtime.sendMessage({
  action: 'saveDrama',
  drama: { ...native, id: 'native-old', itemId: 'native-old', scrapedAt: BEFORE }
});
await sleep(300);
check('N3 启用前抓到的平台中文卡不推', botPosts.length === 0, `posts=${botPosts.length}`);

// 新卡但仍是 new（要走翻译线）→ 入库时不推，等翻完再推
botPosts.length = 0;
await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama: mk('pending2') });
await sleep(300);
check('N4 入库时还是 new 的卡不在入库时推', botPosts.length === 0, `posts=${botPosts.length}`);

// ---------- O 组：开关与未配置 ----------
await resetDramasCache(); await setupBot({ enabled: false });
botPosts.length = 0;
globalThis.Translator = { async translateTitleAndDesc(title) { return { title: `中·${title}`, desc: '中文简介' }; } };
rawStore.dramas = [mk('offcard')];
await runTranslateRound();
check('O1 开关关闭时一条都不推', botPosts.length === 0, `posts=${botPosts.length}`);
check('O2 关闭时翻译照常进行',
  (rawStore.dramas || [])[0]?.status === 'trans', JSON.stringify(rawStore.dramas?.[0]));

// 推送失败不能影响翻译落库
await resetDramasCache(); await setupBot();
botPosts.length = 0;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url) === BOT_HOOK) throw new Error('unit stub: 机器人不可达');
  throw new TypeError('unit stub: no network');
};
rawStore.dramas = [mk('failpush')];
await runTranslateRound();
check('O3 推送失败不影响翻译落库',
  (rawStore.dramas || [])[0]?.status === 'trans' && (rawStore.dramas || [])[0]?.titleZh === '中·T-failpush',
  JSON.stringify(rawStore.dramas?.[0]));
globalThis.fetch = origFetch;

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
