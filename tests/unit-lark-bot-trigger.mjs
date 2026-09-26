import './bootstrap.cjs';
// 回归测试：群机器人自动推送的触发点与启用水位线（v1.5.14）。
//
// 触发点（都只在「这一次写入把卡变成 trans」时推，故无需持久「已推送」标记）：
//   ① 翻译线把一条从 new 补成 trans 时推（走 AI 翻译的站点）；
//   ② 抓取入库时该卡已是 trans 时推（平台自带中文齐全，不进翻译线）；
//   ③ 弹窗单卡 🌍 把一条从 new 翻成 trans 时推（P 组：与批量线抢同一张卡时只推一次）。
//
// **W 组是本套件的存在理由**：库里 3454 条存量（含 resetPartialTranslations
// 退回队列的 683 条）会陆续走完翻译线。没有「启用水位线」的话，一开机器人就会
// 在群里瞬间刷出几百条消息。水位线＝只推 scrapedAt 晚于启用时刻的卡。
// 用法：node tests/unit-lark-bot-trigger.mjs
import fs from 'node:fs';
import { createChromeStorage } from './storage-stub.mjs';

// storage 走共用 storage-stub（v1.6.20 起不再手搓）：tick:1 保持手搓桩「让出一拍再读写」的时序，onChanged 从不派发。
// 后台仍在本进程全局作用域 eval：B 组拿测试侧的真时钟与后台写的基线比先后，background-fixture 的固定时钟对不上
const store = createChromeStorage({}, { tick: 1, dispatchChanges: false });
const botPosts = [];          // 捕获发往机器人的请求
const botPostTimes = [];      // 每次请求的时刻（S 组测节流）
const alarmStore = new Map();
let botFailCount = 0;         // 还需失败多少次（Q 组制造推送失败）
let botGate = null;           // 非空时机器人请求先挂在这个 promise 上（R 组制造「处理进行中」的窗口）
let botGateReached = null;    // 有请求挂上闸门时回调（R 组据此在处理中途插入入队）

const chromeStub = {
  storage: { local: store.local, onChanged: store.onChanged },
  runtime: {
    id: 'unit-test',
    getURL: p => `chrome-extension://unit-test/${p}`,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { chromeStub.__msg = fn; } },
    sendMessage(message) {
      return new Promise((resolve) => {
        const handled = chromeStub.__msg?.(message, { id: 'unit-test', url: 'chrome-extension://unit-test/src/popup/popup.html' }, resolve);
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
    if (botGate) { botGateReached?.(); await botGate; }
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
// 直改 storage 里的 dramas 表前先让队列内存缓存失效：缓存在 eval 私有词法环境外部触不到，借生产语义——
// 注入一次 set 失败，writeDramasInQueue 的 catch 置空缓存（失败不落盘）
const resetDramasCache = async () => { store.failNextSet(); await clearAllDramas().catch(() => {}); }; // eslint-disable-line no-undef

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
  store.data.larkConfig = { webhookUrl: '', botWebhookUrl: BOT_HOOK, botEnabled: enabled, requestTimeoutSec: 5 };
  store.data.larkBotState = enabledAt ? { enabledAt } : {};
  store.data.urlTags = [{ urlPattern: SUB, tags: ['T'] }];
  store.data.translateConfig = { translateMode: 'api', delayMs: 1 };
};

async function runTranslateRound() {
  await chromeStub.runtime.sendMessage({ action: 'triggerTranslate' });
  for (let i = 0; i < 60; i++) {
    await sleep(80);
    if (store.data.translateRunState?.running === false) break;
  }
  await sleep(250);
}

// ---------- W 组：启用水位线（防存量刷屏） ----------
await resetDramasCache(); await setupBot();
botPosts.length = 0;
store.seedDramas([
  mk('old1', { scrapedAt: BEFORE }),
  mk('old2', { scrapedAt: BEFORE }),
  mk('new1', { scrapedAt: AFTER })
]);
await runTranslateRound();
check('W1 只推启用之后抓到的卡（存量翻完不刷屏）', botPosts.length === 1,
  `posts=${botPosts.length} ${JSON.stringify(botPosts.map(p => p.card?.elements?.[0]?.text?.content))}`);
check('W2 推的正是那条新卡', JSON.stringify(botPosts[0] || {}).includes('中·T-new1'),
  JSON.stringify(botPosts[0]?.card?.elements?.[0]));
check('W3 存量条目仍正常翻译（只是不推）',
  (store.dramas() || []).every(d => d.status === 'trans'),
  JSON.stringify((store.dramas() || []).map(d => [d.id, d.status])));

// ---------- T 组：翻译完成才推、半成品不推 ----------
await resetDramasCache(); await setupBot();
botPosts.length = 0;
globalThis.Translator = {
  async translateTitleAndDesc(title) {
    return title === 'T-partial' ? { title: '', desc: '只有简介' } : { title: `中·${title}`, desc: '中文简介' };
  }
};
store.seedDramas([mk('done'), mk('partial')]);
await runTranslateRound();
check('T1 只有翻译完成的才推（半成品不推）', botPosts.length === 1
  && JSON.stringify(botPosts[0]).includes('中·T-done'),
  `posts=${botPosts.length} ${JSON.stringify(botPosts.map(p => JSON.stringify(p).slice(0, 60)))}`);
check('T2 半成品仍留在待翻译队列',
  (store.dramas() || []).find(d => d.id === 'partial')?.status === 'new', '');

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
store.seedDramas([]);
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

// ---------- P 组：🌍 抢在批量线之前翻完同一张卡（审查 bot-push-trigger-assumption-broken） ----------
// 批量线已把卡读进本轮、请求还在飞，用户点 🌍 先翻完：由 🌍（触发点③）推一次；批量线随后回填
// （fillOnly，照样算完成）时卡已是 trans，不再推第二次。此前 🌍 完全不推、由批量线推——批量线
// 若没翻它（接口熔断停线等），这张新卡永远不会推群。
await resetDramasCache(); await setupBot();
botPosts.length = 0;
{
  let releaseBatch;
  const batchGate = new Promise(r => { releaseBatch = r; });
  let calls = 0;
  globalThis.Translator = {
    async translateTitleAndDesc(title) {
      calls++;
      if (calls === 1) await batchGate;   // 第一次调用＝批量线，挂住
      return { title: `中·${title}`, desc: '中文简介' };
    }
  };
  store.seedDramas([mk('race')]);
  const round = performTranslate({ source: 'manual' }); // eslint-disable-line no-undef
  for (let i = 0; i < 50 && calls < 1; i++) await sleep(10);
  const single = await chromeStub.runtime.sendMessage({ action: 'translateSingle', dramaId: 'race' });
  await sleep(600); // 触发点③不 await 推送 + 250ms 节流
  check('P1 🌍 抢先把 new 卡翻成 trans → 由 🌍 推一次（批量线请求仍在飞）',
    calls === 2 && single?.complete === true && botPosts.length === 1 && JSON.stringify(botPosts[0]).includes('中·T-race'),
    `calls=${calls} single=${JSON.stringify(single)} posts=${botPosts.length}`);
  releaseBatch();
  await round;
  await sleep(600);
  check('P2 批量线随后回填同一张卡（已是 trans）不再推第二次',
    botPosts.length === 1 && (store.dramas() || [])[0]?.status === 'trans', `posts=${botPosts.length}`);
}
globalThis.Translator = { async translateTitleAndDesc(title) { return { title: `中·${title}`, desc: '中文简介' }; } };

// ---------- O 组：开关与未配置 ----------
await resetDramasCache(); await setupBot({ enabled: false });
botPosts.length = 0;
globalThis.Translator = { async translateTitleAndDesc(title) { return { title: `中·${title}`, desc: '中文简介' }; } };
store.seedDramas([mk('offcard')]);
await runTranslateRound();
check('O1 开关关闭时一条都不推', botPosts.length === 0, `posts=${botPosts.length}`);
check('O2 关闭时翻译照常进行',
  (store.dramas() || [])[0]?.status === 'trans', JSON.stringify(store.dramas()?.[0]));

// 推送失败不能影响翻译落库
await resetDramasCache(); await setupBot();
botPosts.length = 0;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url) === BOT_HOOK) throw new Error('unit stub: 机器人不可达');
  throw new TypeError('unit stub: no network');
};
store.seedDramas([mk('failpush')]);
await runTranslateRound();
check('O3 推送失败不影响翻译落库',
  (store.dramas() || [])[0]?.status === 'trans' && (store.dramas() || [])[0]?.titleZh === '中·T-failpush',
  JSON.stringify(store.dramas()?.[0]));
globalThis.fetch = origFetch;

// ---------- Q 组：推送失败重试队列（v1.6.0，推翻 v1.5.14 的「不重试不排队」） ----------
// 用户定：失败先推完同批次其他卡（现有实现天然如此，逐条 try/catch），
// 之后最多重试 3 次、间隔 1 分钟，全失败则丢弃。
// **不能用 setTimeout**：MV3 的 SW 空闲约 30 秒即回收，跨 1 分钟的定时器活不到，
// 只能靠 chrome.alarms（允许的最小间隔正好 1 分钟）+ storage 持久队列。
const RETRY_ALARM = 'larkBotRetry';
const queueOf = () => store.data.larkBotState?.retryQueue || [];
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
botPosts.length = 0; alarmStore.clear(); store.seedDramas([]);
botFailCount = 99;                                  // 一直失败
await pushTrans('retry1');
check('Q1 首次推送失败后进入重试队列', queueOf().length === 1
  && queueOf()[0]?.dramaId === 'retry1', JSON.stringify(store.data.larkBotState));
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
botPosts.length = 0; alarmStore.clear(); store.seedDramas([]);
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
botPosts.length = 0; alarmStore.clear(); store.seedDramas([]);
botFailCount = 99;
await pushTrans('gonecard');
// 模拟「按条件清理」删掉了它：直改 storage 绕不过队列缓存，必须先让缓存失效
await resetDramasCache();
store.seedDramas([]);
botPosts.length = 0;
await fireRetryAlarm();
check('Q10 卡已从库中删除时出队丢弃、零请求',
  botPosts.length === 0 && queueOf().length === 0, `posts=${botPosts.length} queue=${queueOf().length}`);

// 队列上限：防 webhook 失效时无限膨胀
await resetDramasCache(); await setupBot();
botPosts.length = 0; alarmStore.clear(); store.seedDramas([]);
store.data.larkBotState = {
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
botPosts.length = 0; alarmStore.clear(); store.seedDramas([]);
botFailCount = 0;
await pushTrans('okcard');
check('Q12 推送成功不入队、不建闹钟',
  queueOf().length === 0 && !alarmStore.has(RETRY_ALARM),
  `queue=${JSON.stringify(queueOf())}`);

// ---------- R 组：重试处理与入队并发（审查 bot-retry-queue-overwrite / bot-retry-queue-lost-update） ----------
// 逐条重推要跑好几分钟（每条请求超时 15s、最多 50 条），这期间翻译线照常失败入队、并建 1 分钟后的闹钟。
// 此前收尾拿开轮快照整体写回：期间入队的卡连同闹钟一起丢；期间闹钟触发的第二轮读到未写回的整队，
// 已推成功的卡再推一遍（群里重复卡片）。闸门把第一条重推请求挂住，制造「处理进行中」的窗口。
const armGate = () => {
  let open, reached;
  const hit = new Promise(r => { reached = r; });
  botGate = new Promise(r => { open = r; });
  botGateReached = reached;
  return {
    hit: Promise.race([hit, sleep(3000)]),   // 兜底：闸门没被撞上也别把整套件挂死
    release: () => { botGate = null; botGateReached = null; open(); }
  };
};
const startRetryRun = () => chromeStub.__onAlarm?.({ name: RETRY_ALARM });
const retryIds = () => queueOf().map(e => `${e.dramaId}:${e.attempts}`).join(',');
const postCount = text => botPosts.filter(p => JSON.stringify(p).includes(text)).length;

await resetDramasCache(); await setupBot();
botPosts.length = 0; alarmStore.clear(); store.seedDramas([]);
botFailCount = 99;
await pushTrans('r-old');
botFailCount = 0;
botPosts.length = 0;
{
  const gate = armGate();
  const run = startRetryRun();
  await gate.hit;                                   // 正在重推 r-old
  await enqueueBotRetry('r-new', 1);                // eslint-disable-line no-undef -- 翻译线此刻推送失败入队
  gate.release();
  await run; await sleep(100);
}
check('R1 处理期间新入队的条目在收尾写回后仍在（不被开轮快照覆盖）',
  retryIds() === 'r-new:1', `queue=${retryIds()}`);
check('R1b 合并后队列非空：重试闹钟保留，不被清掉',
  alarmStore.get(RETRY_ALARM)?.delayInMinutes === 1, JSON.stringify([...alarmStore.keys()]));
check('R1c 本轮处理过的条目照常出队（r-old 推成功一次）',
  botPosts.length === 1 && postCount('中·r-old') === 1, `posts=${botPosts.length}`);

// 本轮推失败的条目与期间入队的条目并存：失败的次数 +1 留在前面（入队更早），新条目排在后面
await resetDramasCache(); await setupBot();
botPosts.length = 0; alarmStore.clear(); store.seedDramas([]);
botFailCount = 99;
await pushTrans('r-fail');
botFailCount = 0;
{
  const gate = armGate();
  const run = startRetryRun();
  await gate.hit;
  await enqueueBotRetry('r-new2', 1);               // eslint-disable-line no-undef
  botFailCount = 1;                                 // 挂住的这次重推失败
  gate.release();
  await run; await sleep(100);
}
check('R2 本轮失败的条目（次数 +1）与期间新入队的条目合并保留',
  retryIds() === 'r-fail:2,r-new2:1' && alarmStore.has(RETRY_ALARM), `queue=${retryIds()} alarms=${[...alarmStore.keys()]}`);

// 并发：第一轮还挂在请求上，期间入队建的闹钟又触发一轮——第二轮必须直接返回，不重复推
await resetDramasCache(); await setupBot();
botPosts.length = 0; alarmStore.clear(); store.seedDramas([]);
botFailCount = 99;
await pushTrans('c1');
await pushTrans('c2');
botFailCount = 0;
botPosts.length = 0;
{
  const gate = armGate();
  const first = startRetryRun();
  await gate.hit;
  const second = startRetryRun();                   // 第一轮尚未写回
  await sleep(300);
  gate.release();
  await Promise.all([first, second]); await sleep(100);
}
check('R3 两轮重试并发时每张卡只推一次（第二轮被内存标记挡下）',
  botPosts.length === 2 && postCount('中·c1') === 1 && postCount('中·c2') === 1,
  `posts=${botPosts.length} c1=${postCount('中·c1')} c2=${postCount('中·c2')}`);
check('R3b 全部推成功后队列清空、闹钟清除', queueOf().length === 0 && !alarmStore.has(RETRY_ALARM),
  `queue=${retryIds()} alarms=${[...alarmStore.keys()]}`);
botPosts.length = 0;
await pushTrans('c3', {});                          // 推成功，不入队
store.data.larkBotState = { ...store.data.larkBotState, retryQueue: [{ dramaId: 'c3', attempts: 1 }] };
await fireRetryAlarm();
check('R3c 处理标记随收尾复位：下一次闹钟照常处理', botPosts.length === 2 && queueOf().length === 0,
  `posts=${botPosts.length} queue=${retryIds()}`);

// 处理期间同一张卡被重新入队（attempts 回到 1，与开轮值不同）：按新条目保留，并顶掉本轮给它留的旧重试
await resetDramasCache(); await setupBot();
botPosts.length = 0; alarmStore.clear(); store.seedDramas([]);
botFailCount = 0;
await pushTrans('e1');
store.data.larkBotState = { ...store.data.larkBotState, retryQueue: [{ dramaId: 'e1', attempts: 2 }] };
{
  const gate = armGate();
  const run = startRetryRun();
  await gate.hit;
  await enqueueBotRetry('e1', 1);                   // eslint-disable-line no-undef
  botFailCount = 1;
  gate.release();
  await run; await sleep(100);
}
check('R4 同一张卡处理期间重新入队：只留最新一条（与 enqueueBotRetry 同 id 只留一条同口径）',
  retryIds() === 'e1:1' && alarmStore.has(RETRY_ALARM), `queue=${retryIds()}`);
botGate = null; botGateReached = null; botFailCount = 0;

// ---------- S 组：发送节流（飞书自定义机器人 5 次/秒、100 次/分钟，超限 11232） ----------
// 翻译线一批 10 条跑完一起回填，10 次推送会在同一个循环里连发，很容易打满「5 次/秒」。
await resetDramasCache(); await setupBot();
botPosts.length = 0; botPostTimes.length = 0; alarmStore.clear();
botFailCount = 0;
globalThis.Translator = { async translateTitleAndDesc(title) { return { title: `中·${title}`, desc: '中文简介' }; } };
store.seedDramas([mk('thr1'), mk('thr2'), mk('thr3')]);
await runTranslateRound();
const gaps = botPostTimes.slice(1).map((t, i) => t - botPostTimes[i]);
check('S1 同批多条推送之间有节流间隔（≥240ms，即 ≤4 次/秒）',
  botPostTimes.length === 3 && gaps.every(g => g >= 240),
  `times=${botPostTimes.length} gaps=${JSON.stringify(gaps)}`);

// ---------- A 组：AI 批量线整批回填（v1.6.22）后的触发点① ----------
// 成功批改成一次队列操作写整批（一次 dramas 整表 set，而不是每条一次）；推群仍在落库之后按批内顺序
// 逐条走、只推这次翻成 trans 的卡、照样过 250ms 节流，水位线前的存量与半成品照旧不推。
// 上面各组都是 API 模式（逐条翻译逐条写），这组钉住 AI 整批写路径的推送条数与顺序
await resetDramasCache(); await setupBot();
store.data.translateConfig = { translateMode: 'ai', aiEndpoint: 'https://x.test/v1', aiApiKey: 'k', batchSize: 10, delayMs: 1 };
botPosts.length = 0; botPostTimes.length = 0; alarmStore.clear();
botFailCount = 0;
const aiBatchCalls = [];
globalThis.Translator = {
  async translateBatchAI(items) {
    aiBatchCalls.push(items.length);
    return items.map(it => (it.title === 'T-ai-half' ? { title: '', desc: '只有简介' } : { title: `中·${it.title}`, desc: '中文简介' }));
  },
  async translateTitleAndDesc(title) { return { title: `中·${title}`, desc: '中文简介' }; }
};
store.seedDramas([mk('ai1'), mk('ai-old', { scrapedAt: BEFORE }), mk('ai2'), mk('ai-half'), mk('ai3'), mk('ai4')]);
let aiDramaWrites = 0;
const setBeforeAi = store.local.set;
store.local.set = (values, callback) => {
  if (store.writesDramas(values)) aiDramaWrites++;
  return setBeforeAi(values, callback);
};
await runTranslateRound();
store.local.set = setBeforeAi;
{
  const posted = botPosts.map(p => (JSON.stringify(p).match(/中·T-(ai[\w-]*)/) || [])[1] || '?');
  const aiGaps = botPostTimes.slice(1).map((t, i) => t - botPostTimes[i]);
  check('A1 AI 整批回填：推群 4 次、按批内顺序（存量 ai-old、半成品 ai-half 不推）',
    aiBatchCalls.join(',') === '6' && posted.join(',') === 'ai1,ai2,ai3,ai4',
    `calls=${aiBatchCalls} posted=${posted}`);
  check('A2 整批落库后的连续推送仍有节流间隔（≥240ms）', aiGaps.length === 3 && aiGaps.every(g => g >= 240),
    `gaps=${JSON.stringify(aiGaps)}`);
  check('A3 这一批 6 条（含半成品）只写一次 dramas 整表', aiDramaWrites === 1, `writes=${aiDramaWrites}`);
  const ds = Object.fromEntries((store.dramas() || []).map(d => [d.id, d]));
  check('A4 落库照旧：5 条 trans（含存量），半成品保持 new 并计次',
    ['ai1', 'ai-old', 'ai2', 'ai3', 'ai4'].every(id => ds[id]?.status === 'trans')
      && ds['ai-half']?.status === 'new' && ds['ai-half']?.translateAttempts === 1,
    JSON.stringify(Object.values(ds).map(d => [d.id, d.status, d.translateAttempts])));
}
globalThis.Translator = { async translateTitleAndDesc(title) { return { title: `中·${title}`, desc: '中文简介' }; } };

/// ---------- B 组：订阅 URL 首轮抓取只入库不推送（v1.6.7，2026-09-17 用户定；取代 v1.6.6 站点级规则） ----------
// 刚订阅的 URL 第一轮会一次抓进几十条（FlickReels 首轮 24 条、IMDB 新加 9 条出品公司筛选约 300 条），是存量底座
// 不是新动态，全推即刷屏。粒度是订阅 URL 而非站点——IMDB 库里已有 482 条，按站点永远判不出「新」；新站点只是
// 「该站所有 URL 都零条」的特例。开轮时库里零条的订阅 URL 挂「进行中」一律不推（翻译线在开轮 10s 后并行跑，
// 首批卡可能在收轮前就翻完），收轮时基线定在完成时刻，此后只推 scrapedAt 晚于基线的卡。
// 全局水位线 enabledAt 与其它订阅 URL 完全不受影响。
const IMDB_A = 'https://www.imdb.com/search/title/?release_date=2026-01-01,&genres=Drama';        // 老订阅，库里有卡
const IMDB_B = 'https://www.imdb.com/search/title/?release_date=2026-01-01,&companies=co1116954'; // 新加的出品公司筛选
const FR_SUB = 'https://www.flickreels.net/?list=hot_picks';
const NS_SUB = 'https://netshort.com/?list=trending_now';
const nowIso = () => new Date().toISOString();
const mkSub = (id, source, sub, over = {}) => mk(id, { source, sourceListUrl: sub, scrapedAt: nowIso(), ...over });
const mkNative = (id, source, sub, zh) => ({ ...mkSub(id, source, sub), status: 'trans', titleZh: zh, descriptionZh: '中文简介', translatedAt: nowIso() });
const mkOldTrans = (id, source, sub, over = {}) => mkSub(id, source, sub, { status: 'trans', titleZh: '有', descriptionZh: '有', translatedAt: AFTER, ...over });
const baselineOf = url => store.data.larkBotState?.urlBaseline?.[url];
const transCount = pred => (store.dramas() || []).filter(d => pred(d) && d.status === 'trans').length;
const posted = text => botPosts.some(p => JSON.stringify(p).includes(text));
// 抓取桩按 URL 回放：模拟内容脚本在本轮期间把该订阅页的卡片经 saveDrama 入库
let fakeSavesByUrl = {};
globalThis.scrapeUrlInTab = async (url) => {
  const saves = fakeSavesByUrl[url] || [];
  for (const drama of saves) await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama });
  return { success: true, data: saves };
};
const setupSubs = async (dramas) => {
  await resetDramasCache(); await setupBot();
  store.data.urlTags = [
    { urlPattern: SUB, tags: ['T'] },
    { urlPattern: IMDB_A, tags: ['IMDB', 'drama'] },
    { urlPattern: IMDB_B, tags: ['IMDB', 'MyDrama'] },
    { urlPattern: FR_SUB, tags: ['FlickReels', 'HotPicks'] },
    { urlPattern: NS_SUB, tags: ['NetShort', 'Trending'] }
  ];
  store.seedDramas(dramas);
  botPosts.length = 0;
};

// —— 老站点加新订阅 URL（IMDB 场景，本次改动的存在理由）
await setupSubs([mkOldTrans('a-existing', 'imdb', IMDB_A)]);
const runStart = nowIso();
await sleep(5);
fakeSavesByUrl = {
  [IMDB_A]: [mkNative('a-native', 'imdb', IMDB_A, '老订阅平台中文'), mkSub('a-new', 'imdb', IMDB_A)],
  [IMDB_B]: [mkNative('b-native', 'imdb', IMDB_B, '新订阅平台中文'), mkSub('b-new1', 'imdb', IMDB_B), mkSub('b-new2', 'imdb', IMDB_B)]
};
await performScrapeOnce({ site: 'imdb' });   // eslint-disable-line no-undef
await sleep(300);
check('B1 同站新订阅 URL 首轮：入库即 trans 的卡不推（进行中闸门），老订阅 URL 的同类卡照常推',
  botPosts.length === 1 && posted('老订阅平台中文') && !posted('新订阅平台中文'), `posts=${botPosts.length}`);
check('B2 收轮时新订阅 URL 基线定在完成时刻（ISO，不早于开轮）',
  typeof baselineOf(IMDB_B) === 'string' && baselineOf(IMDB_B) !== 'pending' && baselineOf(IMDB_B) >= runStart, String(baselineOf(IMDB_B)));
check('B3 库里已有卡的订阅 URL 不设基线（同站不连坐）', baselineOf(IMDB_A) === undefined, JSON.stringify(store.data.larkBotState?.urlBaseline));
check('B3b 全局水位线不受影响', store.data.larkBotState?.enabledAt === ENABLED_AT, String(store.data.larkBotState?.enabledAt));

botPosts.length = 0;
await runTranslateRound();
check('B4 首轮抓到的 new 卡翻完不推（scrapedAt 不晚于基线）、老订阅的 new 卡翻完照常推；都正常翻完入库',
  botPosts.length === 1 && posted('中·T-a-new') && transCount(d => d.sourceListUrl === IMDB_B) === 3,
  `posts=${botPosts.length} transB=${transCount(d => d.sourceListUrl === IMDB_B)}`);

// 基线之后抓到的才是「有更新」：两个触发点都要照常推
botPosts.length = 0;
await sleep(5);
await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama: mkNative('b-later', 'imdb', IMDB_B, '后续新卡') });
await sleep(300);
check('B5 基线之后入库即 trans 的新卡照常推', botPosts.length === 1 && posted('后续新卡'), `posts=${botPosts.length}`);
botPosts.length = 0;
await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama: mkSub('b-later2', 'imdb', IMDB_B) });
await runTranslateRound();
check('B6 基线之后的 new 卡翻译完成后照常推', botPosts.length === 1 && posted('中·T-b-later2'), `posts=${botPosts.length}`);

// —— 全新站点＝其所有 URL 都零条，同一规则覆盖（v1.6.6 的 FlickReels 场景不退化）
await setupSubs([mkOldTrans('ns-existing', 'netshort', NS_SUB)]);
const frStart = nowIso();
await sleep(5);
fakeSavesByUrl = { [FR_SUB]: [mkNative('fr-native', 'flickreels', FR_SUB, '首轮平台中文'), mkSub('fr-new1', 'flickreels', FR_SUB)] };
await performScrapeOnce({ site: 'flickreels' });   // eslint-disable-line no-undef
await sleep(300);
check('B7 全新站点首轮：入库即 trans 的卡不推、收轮定基线',
  botPosts.length === 0 && typeof baselineOf(FR_SUB) === 'string' && baselineOf(FR_SUB) !== 'pending' && baselineOf(FR_SUB) >= frStart,
  `posts=${botPosts.length} baseline=${String(baselineOf(FR_SUB))}`);
botPosts.length = 0;
await runTranslateRound();
check('B7b 新站首轮 new 卡翻完不推但正常入库', botPosts.length === 0 && transCount(d => d.source === 'flickreels') === 2,
  `posts=${botPosts.length} trans=${transCount(d => d.source === 'flickreels')}`);

// 老订阅 URL 的抓取完全不受影响
botPosts.length = 0;
fakeSavesByUrl = { [NS_SUB]: [mkNative('ns-native', 'netshort', NS_SUB, '老站新卡')] };
await performScrapeOnce({ site: 'netshort' });   // eslint-disable-line no-undef
await sleep(300);
check('B8 老订阅 URL 本轮入库即 trans 的卡照常推、不设基线', botPosts.length === 1 && baselineOf(NS_SUB) === undefined,
  `posts=${botPosts.length} baseline=${String(baselineOf(NS_SUB))}`);

// SW 中途被回收会留下「进行中」：下一轮含该 URL 的收轮时收口成时间戳；但只碰本轮 URL——
// 弹窗单站刷新传的是过滤后的列表，别站遗留的 pending 原样保留、零条的别站 URL 也不被标记
store.data.larkBotState = { ...store.data.larkBotState, urlBaseline: { ...(store.data.larkBotState?.urlBaseline || {}), [FR_SUB]: 'pending', [IMDB_B]: 'pending' } };
fakeSavesByUrl = {};
await performScrapeOnce({ site: 'flickreels' });   // eslint-disable-line no-undef
check('B9 遗留的「进行中」在下一轮收轮时收口为时间戳', typeof baselineOf(FR_SUB) === 'string' && baselineOf(FR_SUB) !== 'pending', String(baselineOf(FR_SUB)));
check('B9b 单站刷新只碰本轮 URL：别站遗留 pending 原样保留、零条的别站 URL 不被标记',
  baselineOf(IMDB_B) === 'pending' && baselineOf(IMDB_A) === undefined, JSON.stringify(store.data.larkBotState?.urlBaseline));

// —— 尾斜杠归一（UrlMatch.normalizeListUrl，与订阅归属判定同口径）双向
const RS_CFG = 'https://www.reelshort.com/';    // 手写配置带尾斜杠
const RS_STORED = 'https://www.reelshort.com';  // 库中卡 sourceListUrl 不带
await setupSubs([mkOldTrans('rs-existing', 'reelshort', RS_STORED)]);
store.data.urlTags.push({ urlPattern: RS_CFG, tags: ['ReelShort'] });
fakeSavesByUrl = { [RS_CFG]: [mkNative('rs-native', 'reelshort', RS_CFG, '老订阅斜杠差异')] };
await performScrapeOnce({ site: 'reelshort' });   // eslint-disable-line no-undef
await sleep(300);
check('B10 配置带尾斜杠、库中卡不带：仍算已有卡，不被误当首轮静音、不设基线',
  botPosts.length === 1 && baselineOf(RS_STORED) === undefined && baselineOf(RS_CFG) === undefined,
  `posts=${botPosts.length} ${JSON.stringify(store.data.larkBotState?.urlBaseline)}`);
const DS_CFG = 'https://dramashorts.io/';
const DS_STORED = 'https://dramashorts.io';
store.data.urlTags.push({ urlPattern: DS_CFG, tags: ['DramaShorts'] });
botPosts.length = 0;
fakeSavesByUrl = { [DS_CFG]: [mkNative('ds-native', 'dramashorts', DS_STORED, '新订阅斜杠差异')] };
await performScrapeOnce({ site: 'dramashorts' });   // eslint-disable-line no-undef
await sleep(300);
check('B11 新订阅带尾斜杠、卡片 sourceListUrl 不带：基线按归一键存、首轮照样拦住',
  botPosts.length === 0 && typeof baselineOf(DS_STORED) === 'string' && baselineOf(DS_STORED) !== 'pending' && baselineOf(DS_CFG) === undefined,
  `posts=${botPosts.length} ${JSON.stringify(store.data.larkBotState?.urlBaseline)}`);

// —— 无 sourceListUrl 的卡（理论形态：content.js 一律写订阅 URL、订阅外清理也会删它）不受基线约束
botPosts.length = 0;
store.data.larkBotState = { ...store.data.larkBotState, urlBaseline: { ...(store.data.larkBotState?.urlBaseline || {}), [NS_SUB]: 'pending' } };
const orphan = mkNative('orphan', 'netshort', NS_SUB, '无归属卡');
delete orphan.sourceListUrl;
await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama: orphan });
await sleep(300);
check('B12 无 sourceListUrl 的卡不受基线约束（落到既有水位线判定）', botPosts.length === 1 && posted('无归属卡'), `posts=${botPosts.length}`);

// —— v1.6.6 遗留的 larkBotState.siteBaseline（存量形如 { flickreels: ISO }）：首次收轮时折进同站所有订阅 URL 里
// 尚无基线的那些、再删掉该键——FlickReels 首轮里尚未翻完的卡仍按老基线拦住，不因换粒度被补推。
// 折的是全部订阅不只本轮：别站的单站刷新也要能触发
const LEGACY_AT = '2026-09-16T22:00:00.000Z';
await setupSubs([
  mkOldTrans('ns-existing2', 'netshort', NS_SUB),
  mkOldTrans('fr-old-trans', 'flickreels', FR_SUB, { scrapedAt: '2026-09-16T21:50:00.000Z' }),
  mkSub('fr-old-new', 'flickreels', FR_SUB, { scrapedAt: '2026-09-16T21:51:00.000Z' })   // 首轮抓到、尚未翻完
]);
store.data.larkBotState = { enabledAt: ENABLED_AT, siteBaseline: { flickreels: LEGACY_AT } };
fakeSavesByUrl = {};
await performScrapeOnce({ site: 'netshort' });   // eslint-disable-line no-undef
check('B13 遗留站点基线折进该站所有订阅 URL 后删除 siteBaseline 键',
  baselineOf(FR_SUB) === LEGACY_AT && !('siteBaseline' in (store.data.larkBotState || {})) && store.data.larkBotState?.enabledAt === ENABLED_AT,
  JSON.stringify(store.data.larkBotState));
botPosts.length = 0;
await runTranslateRound();
check('B14 首轮遗留未翻完的卡翻完仍不推（scrapedAt 早于继承的基线）', botPosts.length === 0 && transCount(d => d.id === 'fr-old-new') === 1,
  `posts=${botPosts.length}`);
botPosts.length = 0;
await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama: mkNative('fr-after-legacy', 'flickreels', FR_SUB, '继承基线之后') });
await sleep(300);
check('B14b 继承基线之后的新卡照常推', botPosts.length === 1 && posted('继承基线之后'), `posts=${botPosts.length}`);

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
