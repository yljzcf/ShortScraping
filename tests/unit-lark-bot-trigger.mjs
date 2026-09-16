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
const botPostTimes = [];      // 每次请求的时刻（S 组测节流）
const alarmStore = new Map();
let botFailCount = 0;         // 还需失败多少次（Q 组制造推送失败）

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
  // 闹钟用真存储：Q 组要断言重试闹钟被建/被清，noop 桩测不了
  alarms: {
    async getAll() { return [...alarmStore.values()]; },
    async get(name) { return alarmStore.get(name) || null; },
    async clear(name) { return alarmStore.delete(name); },
    create(name, info) { alarmStore.set(name, { name, ...info }); },
    onAlarm: { addListener(fn) { chromeStub.__onAlarm = fn; } }
  },
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
    botPostTimes.push(Date.now());
    if (botFailCount > 0) { botFailCount -= 1; throw new Error('unit stub: 机器人不可达'); }
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

// ---------- Q 组：推送失败重试队列（v1.6.0，推翻 v1.5.14 的「不重试不排队」） ----------
// 用户定：失败先推完同批次其他卡（现有实现天然如此，逐条 try/catch），
// 之后最多重试 3 次、间隔 1 分钟，全失败则丢弃。
// **不能用 setTimeout**：MV3 的 SW 空闲约 30 秒即回收，跨 1 分钟的定时器活不到，
// 只能靠 chrome.alarms（允许的最小间隔正好 1 分钟）+ storage 持久队列。
const RETRY_ALARM = 'larkBotRetry';
const queueOf = () => rawStore.larkBotState?.retryQueue || [];
const fireRetryAlarm = async () => {
  await chromeStub.__onAlarm?.({ name: RETRY_ALARM });
  await sleep(400);
};
const pushTrans = async (id, over = {}) => {
  await chromeStub.runtime.sendMessage({
    action: 'saveDrama',
    drama: { ...mk(id), status: 'trans', titleZh: `中·${id}`, descriptionZh: '中文简介', translatedAt: AFTER, ...over }
  });
  await sleep(400);
};

await resetDramasCache(); await setupBot();
botPosts.length = 0; alarmStore.clear(); rawStore.dramas = [];
botFailCount = 99;                                  // 一直失败
await pushTrans('retry1');
check('Q1 首次推送失败后进入重试队列', queueOf().length === 1
  && queueOf()[0]?.dramaId === 'retry1', JSON.stringify(rawStore.larkBotState));
check('Q2 队列只存 id 与已失败次数，不存卡片数据',
  queueOf()[0]?.attempts === 1 && !('card' in (queueOf()[0] || {})) && !('drama' in (queueOf()[0] || {})),
  JSON.stringify(queueOf()[0]));
check('Q3 入队即建 1 分钟后的重试闹钟',
  alarmStore.get(RETRY_ALARM)?.delayInMinutes === 1, JSON.stringify(alarmStore.get(RETRY_ALARM)));

botFailCount = 0;                                   // 这次会成功
botPosts.length = 0;
await fireRetryAlarm();
check('Q4 闹钟触发时按 id 重新读卡并重推', botPosts.length === 1
  && JSON.stringify(botPosts[0]).includes('中·retry1'), `posts=${botPosts.length}`);
check('Q5 重推成功后出队', queueOf().length === 0, JSON.stringify(queueOf()));
check('Q6 队列空即清除闹钟（否则扩展永远每分钟醒一次）',
  !alarmStore.has(RETRY_ALARM), JSON.stringify([...alarmStore.keys()]));

// 满 3 次重试就丢弃：总请求 = 首发 1 + 重试 3 = 4
await resetDramasCache(); await setupBot();
botPosts.length = 0; alarmStore.clear(); rawStore.dramas = [];
botFailCount = 99;
await pushTrans('deadcard');
for (let i = 0; i < 3; i++) await fireRetryAlarm();
check('Q7 首发 1 次 + 重试 3 次 = 共 4 次请求后放弃', botPosts.length === 4, `posts=${botPosts.length}`);
check('Q8 放弃后出队且闹钟清除',
  queueOf().length === 0 && !alarmStore.has(RETRY_ALARM),
  `queue=${JSON.stringify(queueOf())} alarms=${JSON.stringify([...alarmStore.keys()])}`);
botPosts.length = 0;
await fireRetryAlarm();
check('Q9 放弃之后不再重试', botPosts.length === 0, `posts=${botPosts.length}`);

// 条目已被清理 → 直接丢弃，不白发请求
await resetDramasCache(); await setupBot();
botPosts.length = 0; alarmStore.clear(); rawStore.dramas = [];
botFailCount = 99;
await pushTrans('gonecard');
// 模拟「按条件清理」删掉了它：直改 rawStore 绕不过队列缓存，必须先让缓存失效
await resetDramasCache();
rawStore.dramas = [];
botPosts.length = 0;
await fireRetryAlarm();
check('Q10 卡已从库中删除时出队丢弃、零请求',
  botPosts.length === 0 && queueOf().length === 0, `posts=${botPosts.length} queue=${queueOf().length}`);

// 队列上限：防 webhook 失效时无限膨胀
await resetDramasCache(); await setupBot();
botPosts.length = 0; alarmStore.clear(); rawStore.dramas = [];
rawStore.larkBotState = {
  enabledAt: ENABLED_AT,
  retryQueue: Array.from({ length: 50 }, (_, i) => ({ dramaId: `old${i}`, attempts: 1 }))
};
botFailCount = 99;
await pushTrans('overflow');
check('Q11 队列上限 50，超出丢最老的',
  queueOf().length === 50 && !queueOf().some(e => e.dramaId === 'old0')
  && queueOf().some(e => e.dramaId === 'overflow'),
  `len=${queueOf().length} first=${queueOf()[0]?.dramaId}`);

// 成功推送不该留下任何队列痕迹
await resetDramasCache(); await setupBot();
botPosts.length = 0; alarmStore.clear(); rawStore.dramas = [];
botFailCount = 0;
await pushTrans('okcard');
check('Q12 推送成功不入队、不建闹钟',
  queueOf().length === 0 && !alarmStore.has(RETRY_ALARM),
  `queue=${JSON.stringify(queueOf())}`);

// ---------- S 组：发送节流（飞书自定义机器人 5 次/秒、100 次/分钟，超限 11232） ----------
// 翻译线一批 10 条跑完一起回填，10 次推送会在同一个循环里连发，很容易打满「5 次/秒」。
await resetDramasCache(); await setupBot();
botPosts.length = 0; botPostTimes.length = 0; alarmStore.clear();
botFailCount = 0;
globalThis.Translator = { async translateTitleAndDesc(title) { return { title: `中·${title}`, desc: '中文简介' }; } };
rawStore.dramas = [mk('thr1'), mk('thr2'), mk('thr3')];
await runTranslateRound();
const gaps = botPostTimes.slice(1).map((t, i) => t - botPostTimes[i]);
check('S1 同批多条推送之间有节流间隔（≥240ms，即 ≤4 次/秒）',
  botPostTimes.length === 3 && gaps.every(g => g >= 240),
  `times=${botPostTimes.length} gaps=${JSON.stringify(gaps)}`);

// ---------- B 组：新站点首轮抓取只入库不推送（v1.6.6，2026-09-16 用户定） ----------
// 刚接入的站点第一轮会一次抓进几十条（FlickReels 首轮 24 条），它们是存量底座不是新动态，
// 全推进群里就是刷屏。开轮时库里零条的站点视为新站：本轮期间该站挂「进行中」一律不推
// （翻译线在开轮 10s 后并行跑，首批卡可能在收轮前就翻完），收轮时把该站基线定在完成时刻，
// 此后只推 scrapedAt 晚于基线的卡。全局水位线 enabledAt 与其它站点完全不受影响。
const FR_SUB = 'https://www.flickreels.net/?list=hot_picks';
const NS_SUB = 'https://netshort.com/?list=trending_now';
const nowIso = () => new Date().toISOString();
const mkSite = (id, source, sub, over = {}) => mk(id, { source, sourceListUrl: sub, scrapedAt: nowIso(), ...over });
const baselineOf = site => rawStore.larkBotState?.siteBaseline?.[site];
const frTrans = () => (rawStore.dramas || []).filter(d => d.source === 'flickreels' && d.status === 'trans').length;
// 用抓取桩代替真开标签页：模拟内容脚本在本轮期间把卡片经 saveDrama 入库
let fakeSaves = [];
globalThis.scrapeUrlInTab = async () => {
  for (const drama of fakeSaves) await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama });
  return { success: true, data: fakeSaves };
};

await resetDramasCache(); await setupBot();
rawStore.urlTags = [
  { urlPattern: SUB, tags: ['T'] },
  { urlPattern: FR_SUB, tags: ['FlickReels', 'HotPicks'] },
  { urlPattern: NS_SUB, tags: ['NetShort', 'Trending'] }
];
// 库里已有 netshort、没有 flickreels → flickreels 是新站
rawStore.dramas = [mk('ns-existing', { source: 'netshort', sourceListUrl: NS_SUB, status: 'trans', titleZh: '有', descriptionZh: '有', translatedAt: AFTER })];
botPosts.length = 0;
const runStart = nowIso();
fakeSaves = [
  { ...mkSite('fr-native', 'flickreels', FR_SUB), status: 'trans', titleZh: '首轮平台中文', descriptionZh: '中文简介', translatedAt: nowIso() },
  mkSite('fr-new1', 'flickreels', FR_SUB),
  mkSite('fr-new2', 'flickreels', FR_SUB)
];
await sleep(5);
await performScrapeOnce({ site: 'flickreels' });   // eslint-disable-line no-undef
await sleep(300);
check('B1 新站首轮：本轮入库即 trans 的卡不推（进行中闸门）', botPosts.length === 0, `posts=${botPosts.length}`);
const fb = baselineOf('flickreels');
check('B2 收轮时该站基线定在完成时刻（ISO，不早于开轮）', typeof fb === 'string' && fb !== 'pending' && fb >= runStart, String(fb));
check('B3 库里已有卡的站点不设基线', baselineOf('netshort') === undefined, JSON.stringify(rawStore.larkBotState));
check('B3b 全局水位线不受影响', rawStore.larkBotState?.enabledAt === ENABLED_AT, String(rawStore.larkBotState?.enabledAt));

botPosts.length = 0;
await runTranslateRound();
check('B4 首轮抓到的 new 卡翻译完成也不推（scrapedAt 不晚于基线），但正常翻完入库',
  botPosts.length === 0 && frTrans() === 3, `posts=${botPosts.length} trans=${frTrans()}`);

// 基线之后抓到的才是「有更新」：两个触发点都要照常推
botPosts.length = 0;
await sleep(5);
const later = { ...mkSite('fr-later', 'flickreels', FR_SUB), status: 'trans', titleZh: '后续新卡', descriptionZh: '中文简介', translatedAt: nowIso() };
await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama: later });
await sleep(300);
check('B5 基线之后入库即 trans 的新卡照常推', botPosts.length === 1 && JSON.stringify(botPosts[0]).includes('后续新卡'), `posts=${botPosts.length}`);
botPosts.length = 0;
await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama: mkSite('fr-later2', 'flickreels', FR_SUB) });
await runTranslateRound();
check('B6 基线之后的 new 卡翻译完成后照常推', botPosts.length === 1 && JSON.stringify(botPosts[0]).includes('中·T-fr-later2'), `posts=${botPosts.length}`);

// 老站点的抓取完全不受影响
botPosts.length = 0;
fakeSaves = [{ ...mkSite('ns-native', 'netshort', NS_SUB), status: 'trans', titleZh: '老站新卡', descriptionZh: '中文简介', translatedAt: nowIso() }];
await performScrapeOnce({ site: 'netshort' });   // eslint-disable-line no-undef
await sleep(300);
check('B7 老站点本轮入库即 trans 的卡照常推、不设基线', botPosts.length === 1 && baselineOf('netshort') === undefined,
  `posts=${botPosts.length} baseline=${String(baselineOf('netshort'))}`);

// SW 中途被回收会留下「进行中」：下一轮该站收轮时统一收口成时间戳，不能永远卡住该站
rawStore.larkBotState = { ...rawStore.larkBotState, siteBaseline: { ...(rawStore.larkBotState?.siteBaseline || {}), flickreels: 'pending' } };
fakeSaves = [];
await performScrapeOnce({ site: 'flickreels' });   // eslint-disable-line no-undef
check('B8 遗留的「进行中」在下一轮收轮时收口为时间戳', typeof baselineOf('flickreels') === 'string' && baselineOf('flickreels') !== 'pending', String(baselineOf('flickreels')));

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
