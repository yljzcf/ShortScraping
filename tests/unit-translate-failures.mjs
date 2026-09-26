import './bootstrap.cjs';
// 回归测试：翻译线的失败计次、毒条目隔离、连败熔断、语言守卫与抓取后翻译线收尾
// （2026-09-25 体检批次 B：B2 translate-poison-batch-stuck / translate-no-failure-cap /
// ai-echo-english-accepted，B3 post-scrape-loop-idle-rounds）。
//
// 起因：
//   · 空结果、整批 HTTP 失败都不计 translateAttempts——一条触发内容审核（HTTP 400）的
//     简介连同同批最多 9 个邻居永久卡在 new，抓取后翻译线每次白跑满 30 轮；
//   · 没有连败熔断：密钥过期时每轮对几百批条目逐个白发必败请求；
//   · 模型把输入原样回显时英文被当成译文写入、标 trans 永久定格；
//   · 抓取仍在进行、暂无待翻译的空转轮也计入 maxRounds，约 30 秒即退出，抓取后半程
//     入库的卡要等整点 translate-task。
//
// 契约：
//   F 组（毒条目 / 计次）：整批失败同轮拆单条重试一次；错在这条自己（应答了却没给出
//     译文、单条请求被 400/413/422 拒收）累加 translateAttempts，达 3 次按半成品同口径
//     收口 trans；通道故障（网络 / 鉴权 / 5xx / transportError）一律不计。
//   C 组（熔断）：同一轮连续 3 次请求失败即提前结束本轮，summary 带 aborted；本轮一条都
//     没翻成时，打到熔断的连败链上暂记的条目级失败作废不计。本轮已有进展后，拆出的单条
//     没译文不计入连败、照常计次，熔断链上的条目级失败也照常落账（C7/C8：队尾成批的毒条目）。
//   E 组（语言守卫）：不含汉字的片名/简介译文按空处理，批量线与单卡 🌍 同口径。
//   L 组（抓取后翻译线）：抓取进行中的空转轮不计 maxRounds；墙钟上限兜底；
//     resumePostScrapeTranslateLoop 在抓取全部结束且线已退出时再安排一次。
//   R 组（真实 translator.js）：HTTP 非 200 的错误带 status；API 模式传输失败带回
//     transportError，「译文与原文相同」仍是无 transportError 的空串。
// 用法：node tests/unit-translate-failures.mjs（修复前 F/C/E/L 应 RED）
// v1.6.20：手搓的 chrome 桩换成 background-fixture（storage 走共用的 storage-stub）。
import fs from 'node:fs';
import { background } from './background-fixture.mjs';

let unhandledCount = 0;
process.on('unhandledRejection', (e) => { unhandledCount++; console.error('UNHANDLED:', e?.message || e); });

// 弹窗发送方（不带 tab）：沿用迁移前手搓桩的口径，后台 isExtensionPageSender 放行
const POPUP_SENDER = { id: 'fixture', url: 'chrome-extension://fixture/src/popup/popup.html' };

// Translator 桩：按用例切换行为，并记录每次请求（注入后 fixture 不加载真实 translator.js）
const batchCalls = [];
const singleCalls = [];
let batchBehavior = async (items) => items.map(it => ({ title: `中·${it.title}`, desc: '中文简介' }));
let singleBehavior = async (title) => ({ title: `中·${title}`, desc: '中文简介' });
const Translator = {
  async translateBatchAI(items) { batchCalls.push(items.map(it => it.title)); return batchBehavior(items); },
  async translateTitleAndDesc(title, description) { singleCalls.push(title); return singleBehavior(title, description); }
};
const httpError = (status) => Object.assign(new Error(`AI 接口 HTTP ${status}`), { status });

// SW 上下文里的日志 fixture 已静音；这里压的是 R 组在本进程全局求值的真实 translator.js 的日志
const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

// 真定时器 + tick:1（手搓桩「先让一拍再读写」的时序）；外网一律拒（与迁移前同口径）。
// settle:false：顶层代码一跑完就拿到 bg，当拍换掉 SW 上下文的 setTimeout（见下）
const bg = await background({
  settle: false,
  translator: Translator,
  timers: 'real',
  storage: { tick: 1 },
  fetch: () => Promise.reject(new TypeError('unit stub: no network'))
});

// ---------- 定时器加速：后台脚本里的 1s 轮间隔 / 10s 预约 / 批间 delay 一律压到 ≤2ms ----------
// 只换 SW 上下文里的 setTimeout，本套件自己的 sleep 仍走真定时器。顶层同步挂上的 500ms
// CSV 预热定时器早于这里、按真时长排队：它只读 storage、推送必败，不碰任何断言对象
const realSetTimeout = globalThis.setTimeout;
bg.context.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.min(Number(ms) || 0, 2), ...args);
const sleep = ms => new Promise(r => realSetTimeout(r, ms));

// 墙钟：fixture 的 Date 是可拨的固定时钟（bg.setTime 拨动）。抓取后翻译线的墙钟上限只看
// Date.now 的差值，拨过 2 小时即越限；拨回基准即复原
const clockBase = bg.context.Date.now();

// 抓取标签页挂起到测试放行（放行即 reject：该 URL 记失败、抓取收尾，activeScrapeCount 归零）
const pendingTabCreate = [];
Object.assign(bg.context.chrome.tabs, {
  create() { return new Promise((resolve, reject) => { pendingTabCreate.push({ resolve, reject }); }); },
  async remove() {},
  async sendMessage() { return undefined; }
});

// performTranslateOnce 每轮开头读一次 translateConfig+urlTags：按 storage 桩的读日志计数
const translateScanCount = () => bg.storage.reads
  .filter(keys => Array.isArray(keys) && keys.includes('translateConfig') && keys.includes('urlTags')).length;

await sleep(150);

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const byId = () => Object.fromEntries((bg.dramas() || []).map(d => [d.id, d]));

const SUB = 'https://unit.test/list';
const mk = (id, over = {}) => ({
  id, itemId: id, title: `T-${id}`, description: `D-${id}`,
  status: 'new', source: 'unittest', sourceListUrl: SUB,
  titleZh: '', descriptionZh: '', translatedAt: null, ...over
});
const AI = { translateMode: 'ai', aiEndpoint: 'https://x.test/v1', aiApiKey: 'k', batchSize: 10, delayMs: 0 };
const API = { translateMode: 'api', delayMs: 0 };

// 等队列排空再让 dramas 内存缓存失效，随后直改 storage 等价「SW 冷启动前 storage 被外部改写」
async function seed(config, dramas) {
  await bg.resetDramasCache();
  bg.storage.seed({ urlTags: [{ urlPattern: SUB, tags: ['T'] }], translateConfig: config });
  bg.seedDramas(dramas);
  batchCalls.length = 0;
  singleCalls.length = 0;
}
const round = () => bg.context.performTranslate({ source: 'manual' });

// ============ F 组：毒条目隔离与失败计次 ============

// F1 整批 HTTP 400（内容审核）→ 同轮拆单条重试，邻居照常翻译，毒条目单独计次
await seed(AI, ['a', 'b', 'poison', 'c', 'd'].map(id => mk(id)));
batchBehavior = async (items) => {
  if (items.some(it => it.title === 'T-poison')) throw httpError(400);
  return items.map(it => ({ title: `中·${it.title}`, desc: '中文简介' }));
};
{
  const r = await round();
  const m = byId();
  check('F1 整批 400 → 拆单条重试，同批 4 个邻居本轮全部翻译落库',
    ['a', 'b', 'c', 'd'].every(id => m[id]?.status === 'trans' && m[id]?.titleZh === `中·T-${id}`),
    JSON.stringify(Object.values(m).map(d => [d.id, d.status, d.titleZh])));
  check('F1b 请求序列＝1 次整批 + 5 次单条',
    batchCalls.length === 6 && batchCalls[0].length === 5 && batchCalls.slice(1).every(c => c.length === 1),
    JSON.stringify(batchCalls));
  check('F1c 毒条目保持 new、translateAttempts=1、不写译文',
    m.poison?.status === 'new' && m.poison?.translateAttempts === 1 && !m.poison?.titleZh && !m.poison?.translatedAt,
    JSON.stringify(m.poison));
  check('F1d 本轮有译文写入 → 不报错', !r?.error && r?.translatedCount === 4, JSON.stringify(r));
}

// F2 毒条目落单后仍计次，达上限按半成品同口径收口 → 离开待翻译集合
{
  await round();
  check('F2 落单的毒条目（单条请求 400）第 2 轮 translateAttempts=2', byId().poison?.translateAttempts === 2,
    JSON.stringify(byId().poison));
  await round();
  const p = byId().poison;
  check('F2b 第 3 轮达上限收口：status=trans、写 translatedAt、清 translateAttempts、译文仍空',
    p?.status === 'trans' && Boolean(p?.translatedAt) && !('translateAttempts' in p) && !p?.titleZh,
    JSON.stringify(p));
  const r4 = await round();
  check('F2c 收口后待翻译归零（翻译线能等到 pendingCount=0 收尾）', r4?.pendingCount === 0, JSON.stringify(r4));
}

// F3 应答了但漏掉某个 id（空结果）→ 计次；其余正常
await seed(AI, [mk('x1'), mk('x2')]);
batchBehavior = async (items) => items.map(it => (it.title === 'T-x2' ? { title: '', desc: '' } : { title: `中·${it.title}`, desc: '中文简介' }));
{
  await round();
  const m = byId();
  check('F3 应答里漏掉的条目 translateAttempts=1、保持 new；同批其余照常 trans',
    m.x1?.status === 'trans' && m.x2?.status === 'new' && m.x2?.translateAttempts === 1,
    JSON.stringify([m.x1, m.x2]));
  check('F3b 部分空结果不触发拆单条重试（只 1 次请求）', batchCalls.length === 1, JSON.stringify(batchCalls));
}

// F4 通道故障（5xx / 401 / 无状态码的网络错误）多轮都不计次——临时故障不烧重试额度
for (const [tag, makeError] of [['503', () => httpError(503)], ['401', () => httpError(401)], ['网络', () => new TypeError('Failed to fetch')]]) {
  await seed(AI, [mk('n1'), mk('n2')]);
  batchBehavior = async () => { throw makeError(); };
  for (let i = 0; i < 4; i++) await round();
  const m = byId();
  check(`F4 通道故障（${tag}）连跑 4 轮：条目仍 new 且不计 translateAttempts`,
    [m.n1, m.n2].every(d => d?.status === 'new' && d?.translateAttempts === undefined),
    JSON.stringify([m.n1, m.n2]));
}

// F5 API 模式：服务答了但译文与原文相同被滤掉（片名「1923」、无简介）→ 计次、3 轮收口
await seed(API, [mk('y1923', { title: '1923', description: '' })]);
singleBehavior = async () => ({ title: '', desc: '' });
{
  for (let i = 0; i < 3; i++) await round();
  const c = byId().y1923;
  check('F5 API 模式无 transportError 的空结果计次，3 轮后收口 trans',
    c?.status === 'trans' && Boolean(c?.translatedAt) && !('translateAttempts' in c), JSON.stringify(c));
}

// F6 API 模式：transportError（MyMemory 挂了 / 额度用尽）多轮都不计次
await seed(API, [mk('z1'), mk('z2')]);
singleBehavior = async () => ({ title: '', desc: '', transportError: '翻译接口 HTTP 503' });
{
  for (let i = 0; i < 4; i++) await round();
  const m = byId();
  check('F6 API 模式 transportError 连跑 4 轮：条目仍 new 且不计 translateAttempts',
    [m.z1, m.z2].every(d => d?.status === 'new' && d?.translateAttempts === undefined), JSON.stringify([m.z1, m.z2]));
}

// ============ C 组：连败熔断 ============

// C1 密钥过期（401）且库里 100 条：整批失败拆单条，单条连败 3 次即熔断
await seed(AI, Array.from({ length: 100 }, (_, i) => mk(`k${i}`)));
batchBehavior = async () => { throw httpError(401); };
{
  const r = await round();
  check('C1 连续 3 次请求失败即提前结束本轮（1 次整批 + 3 次单条，而不是 10 批全发）',
    batchCalls.length === 4, `calls=${batchCalls.length}`);
  check('C1b summary 带 aborted 且 error 点名连败与原始错误',
    r?.aborted === true && String(r?.error || '').includes('连续 3 次') && String(r?.error || '').includes('401'),
    JSON.stringify(r));
  check('C1c 终态 summary.error 同步写出（弹窗 ❌）',
    String(bg.data.translateRunState?.summary?.error || '').includes('连续 3 次'), JSON.stringify(bg.data.translateRunState?.summary));
  check('C1d 熔断不计任何条目的 translateAttempts', (bg.dramas() || []).every(d => d.translateAttempts === undefined && d.status === 'new'), '');
}

// C2 每批 1 条（batchSize=1）：3 批连败即停
await seed({ ...AI, batchSize: 1 }, Array.from({ length: 20 }, (_, i) => mk(`s${i}`)));
batchBehavior = async () => { throw httpError(503); };
{
  const r = await round();
  check('C2 batchSize=1 时 3 次请求即熔断', batchCalls.length === 3 && r?.aborted === true, `calls=${batchCalls.length}`);
}

// C3 全局 400（例如模型名填错）打到熔断：连败链上暂记的条目级失败作废，不计次
await seed(AI, Array.from({ length: 30 }, (_, i) => mk(`m${i}`)));
batchBehavior = async () => { throw httpError(400); };
{
  for (let i = 0; i < 4; i++) await round();
  check('C3 全局 400 连跑 4 轮：熔断链作废，没有条目被计次或收口',
    (bg.dramas() || []).every(d => d.status === 'new' && d.translateAttempts === undefined),
    JSON.stringify((bg.dramas() || []).filter(d => d.translateAttempts !== undefined || d.status !== 'new').map(d => d.id)));
}

// C4 API 模式同样熔断
await seed(API, Array.from({ length: 10 }, (_, i) => mk(`p${i}`)));
singleBehavior = async () => ({ title: '', desc: '', transportError: 'Failed to fetch' });
{
  const r = await round();
  check('C4 API 模式连续 3 条 transportError 即熔断', singleCalls.length === 3 && r?.aborted === true,
    `calls=${singleCalls.length} ${JSON.stringify(r)}`);
}

// C5 模型整体答非所问（HTTP 200 但每次都解析不出，如提示词配错）：整批无译文 → 拆单条，
//    单条连续 3 次没译文即熔断；这条链作废，多轮下来没有条目被烧额度
await seed(AI, Array.from({ length: 30 }, (_, i) => mk(`g${i}`)));
batchBehavior = async (items) => items.map(() => ({ title: '', desc: '' }));
{
  const r = await round();
  check('C5 全局答非所问：1 次整批 + 3 次单条即熔断', batchCalls.length === 4 && r?.aborted === true,
    `calls=${batchCalls.length} ${JSON.stringify(r)}`);
  for (let i = 0; i < 3; i++) await round();
  check('C5b 连跑 4 轮没有条目被计次或收口',
    (bg.dramas() || []).every(d => d.status === 'new' && d.translateAttempts === undefined), '');
}

// C6 API 模式：本轮一条都没翻成、却有 ≥3 条应答为空 → 更像全局问题，不计次
await seed(API, Array.from({ length: 5 }, (_, i) => mk(`q${i}`)));
singleBehavior = async () => ({ title: '', desc: '' });
{
  for (let i = 0; i < 4; i++) await round();
  check('C6 API 模式整轮零译文且 ≥3 条应答为空：连跑 4 轮不计次',
    (bg.dramas() || []).every(d => d.status === 'new' && d.translateAttempts === undefined), '');
  // 同样的空结果，只要本轮有别的条目翻成功，就证明接口与模型正常 → 照常计次
  await bg.resetDramasCache();
  bg.seedDramas([...Array.from({ length: 5 }, (_, i) => mk(`q${i}`)), mk('q-ok')]);
  singleBehavior = async (title) => (title === 'T-q-ok' ? { title: '中文', desc: '中文简介' } : { title: '', desc: '' });
  await round();
  const m = byId();
  check('C6b 本轮有条目翻成功 → 应答为空的条目照常计次',
    m['q-ok']?.status === 'trans' && [0, 1, 2, 3, 4].every(i => m[`q${i}`]?.translateAttempts === 1), JSON.stringify(Object.values(m).map(d => [d.id, d.translateAttempts])));
}

// C7 毒条目成批落在队尾（旧卡排在库尾，自成一批）：本轮前面已有条目翻成功＝接口与提示词
//    正常，拆出的单条仍没译文只能是这条自己的问题——不计入连败、不熔断，逐条照常计次。
//    此前连败 3 次即熔断、整条链作废：这几条每轮都在熔断里作废，永远收不了口，每轮还报错停线
await seed(AI, [...Array.from({ length: 10 }, (_, i) => mk(`ok${i}`)), ...Array.from({ length: 5 }, (_, i) => mk(`bad${i}`, { title: `${1900 + i}`, description: '' }))]);
batchBehavior = async (items) => items.map(it => (/^\d+$/.test(it.title) ? { title: '', desc: '' } : { title: `中·${it.title}`, desc: '中文简介' }));
{
  const r = await round();
  const m = byId();
  check('C7 队尾整批无译文、本轮已有进展：5 条各计 1 次，不熔断',
    [0, 1, 2, 3, 4].every(i => m[`bad${i}`]?.translateAttempts === 1) && r?.aborted !== true && r?.translatedCount === 10,
    JSON.stringify({ r, bad: [0, 1, 2, 3, 4].map(i => m[`bad${i}`]?.translateAttempts) }));
  check('C7b 请求序列＝2 次整批 + 5 次单条', batchCalls.length === 7, JSON.stringify(batchCalls));
  for (let i = 0; i < 2; i++) {
    await bg.context.saveDramaRecord(mk(`fresh${i}`)); // 每轮都有新卡入库（抓取后翻译线的常态）
    await round();
  }
  const after = byId();
  check('C7c 连续 3 轮（每轮都有新卡翻成功）后队尾毒条目全部收口 trans',
    [0, 1, 2, 3, 4].every(i => after[`bad${i}`]?.status === 'trans' && !('translateAttempts' in after[`bad${i}`])),
    JSON.stringify([0, 1, 2, 3, 4].map(i => [after[`bad${i}`]?.status, after[`bad${i}`]?.translateAttempts])));
}

// C8 队尾几条都被单条 400 拒收（内容审核）：请求级失败仍按连败熔断（兜住中途变成全局 400 的
//    请求风暴），但本轮已有进展时这条链上的条目级失败照常落账，而不是作废
await seed(AI, [...Array.from({ length: 10 }, (_, i) => mk(`ok${i}`)), ...Array.from({ length: 4 }, (_, i) => mk(`mod${i}`))]);
batchBehavior = async (items) => {
  if (items.some(it => it.title.startsWith('T-mod'))) throw httpError(400);
  return items.map(it => ({ title: `中·${it.title}`, desc: '中文简介' }));
};
{
  const r = await round();
  const m = byId();
  check('C8 本轮已有进展时熔断链上的单条 400 照常计次（前 3 条各 1 次），第 4 条本轮未请求',
    r?.aborted === true && [0, 1, 2].every(i => m[`mod${i}`]?.translateAttempts === 1) && m.mod3?.translateAttempts === undefined,
    JSON.stringify({ r, mod: [0, 1, 2, 3].map(i => m[`mod${i}`]?.translateAttempts) }));
}

// ============ E 组：译文语言守卫 ============

// E1 模型把整批输入原样回显 → 整批无汉字 → 拆单条重试；英文不得写成译文
await seed(AI, [mk('e1', { title: 'Revenge Bride', description: 'A bride takes revenge.' }), mk('e2', { title: 'Second Wife', description: 'She returns.' })]);
batchBehavior = async (items) => (items.length > 1
  ? items.map(it => ({ title: it.title, desc: it.desc }))            // 原样回显
  : items.map(it => ({ title: `中·${it.title}`, desc: '中文简介' })));
{
  await round();
  const m = byId();
  check('E1 整批回显英文 → 拆单条重试后写入中文，英文未被当成译文',
    m.e1?.titleZh === '中·Revenge Bride' && m.e2?.titleZh === '中·Second Wife'
    && m.e1?.status === 'trans' && m.e2?.status === 'trans',
    JSON.stringify([m.e1, m.e2]));
}

// E2 只有片名回显英文（简介是中文）→ 片名按空：半成品留 new，不写英文 titleZh
await seed(AI, [mk('e3', { title: 'Revenge Bride' }), mk('e4')]);
batchBehavior = async (items) => items.map(it => (it.title === 'Revenge Bride'
  ? { title: 'Revenge Bride', desc: '中文简介' }
  : { title: `中·${it.title}`, desc: '中文简介' }));
{
  await round();
  const c = byId().e3;
  check('E2 片名回显英文 → titleZh 仍空、保持 new（半成品下轮补）',
    c?.titleZh === '' && c?.descriptionZh === '中文简介' && c?.status === 'new' && c?.translateAttempts === 1,
    JSON.stringify(c));
}

// E3 单卡 🌍 重译：模型回显英文片名不得覆盖既有中文译名
await seed(API, [mk('e5', { status: 'trans', titleZh: '复仇新娘', descriptionZh: '旧简介', translatedAt: '2026-07-01T00:00:00.000Z' })]);
singleBehavior = async (title) => ({ title, desc: '新简介' });
{
  const resp = await bg.send({ action: 'translateSingle', dramaId: 'e5' }, POPUP_SENDER);
  const c = byId().e5;
  check('E3 单卡重译回显英文片名 → 既有中文译名保留、简介照常换新',
    resp?.success === true && c?.titleZh === '复仇新娘' && c?.descriptionZh === '新简介', JSON.stringify({ resp, c }));
}

// E4 单卡 🌍：整条都是英文回显 → 按「翻译结果为空」处理，卡片原样不动
await seed(API, [mk('e6')]);
singleBehavior = async (title, description) => ({ title, desc: description });
{
  const before = JSON.stringify(byId().e6);
  const resp = await bg.send({ action: 'translateSingle', dramaId: 'e6' }, POPUP_SENDER);
  check('E4 单卡整条回显英文 → success=false「翻译结果为空」、卡片不动',
    resp?.success === false && String(resp?.error || '').includes('翻译结果为空') && JSON.stringify(byId().e6) === before,
    JSON.stringify({ resp, card: byId().e6 }));
}

// E5 合法中文（含 の / ー / ・ 混排）照常采用
await seed(AI, [mk('e7')]);
batchBehavior = async (items) => items.map(() => ({ title: '伪娘与扶她の陷阱屋', desc: '人间牧场ー搜查篇ー' }));
{
  await round();
  const c = byId().e7;
  check('E5 汉字混排假名/符号的译文照常采用', c?.titleZh === '伪娘与扶她の陷阱屋' && c?.status === 'trans', JSON.stringify(c));
}

// ============ L 组：抓取后翻译线 ============
await seed(API, []);
singleBehavior = async (title) => ({ title: `中·${title}`, desc: '中文简介' });
const scrapeDone = bg.context.performScrape();
await sleep(400); // 预约 10s→2ms，线启动后每轮 1s→2ms：400ms 远超 30 个空转轮
{
  const scansBefore = translateScanCount();
  check('L0 前置：抓取挂起期间翻译线在空转', scansBefore > 40, `scans=${scansBefore}`);

  await bg.context.saveDramaRecord(mk('late1'));
  let late = null;
  for (let i = 0; i < 50; i++) {
    await sleep(20);
    late = byId().late1;
    if (late?.status === 'trans') break;
  }
  check('L1 抓取仍在进行时的空转轮不计 maxRounds：很晚才入库的卡照样被本条线翻译',
    late?.status === 'trans' && late?.titleZh === '中·T-late1', JSON.stringify(late));
}

// L2 抓取结束 → 3 次空扫描收尾，线停下
pendingTabCreate.splice(0).forEach(t => t.reject(new Error('unit stub: 放行抓取')));
await scrapeDone;
await sleep(200);
{
  const a = translateScanCount();
  await sleep(200);
  check('L2 抓取结束后翻译线按空扫描收尾（不再发起新的扫描）', translateScanCount() === a, `before=${a} after=${translateScanCount()}`);
}

// L3 墙钟上限：抓取挂住时线也会退出；抓取全部结束后 resumePostScrapeTranslateLoop 再安排一次
const scrapeHung = bg.context.performScrape();
await sleep(150);
{
  check('L3 前置：resumePostScrapeTranslateLoop 已导出', typeof bg.context.resumePostScrapeTranslateLoop === 'function', '');
  const alive = translateScanCount();
  await sleep(100);
  check('L3 前置：墙钟未到时线在抓取挂住期间持续空转', translateScanCount() > alive, `before=${alive} after=${translateScanCount()}`);
  bg.setTime(clockBase + 2 * 60 * 60 * 1000 + 1000); // 越过 2 小时墙钟上限
  await sleep(150);
  const a = translateScanCount();
  await sleep(150);
  check('L3a 抓取挂住超过墙钟上限 → 线退出（空转停止）', translateScanCount() === a, `before=${a} after=${translateScanCount()}`);

  await bg.context.saveDramaRecord(mk('late2'));
  if (typeof bg.context.resumePostScrapeTranslateLoop === 'function') bg.context.resumePostScrapeTranslateLoop();
  await sleep(150);
  check('L3b 仍有抓取在进行时 resume 不动（等最后一个抓取收尾）', byId().late2?.status === 'new', JSON.stringify(byId().late2));

  pendingTabCreate.splice(0).forEach(t => t.reject(new Error('unit stub: 放行抓取')));
  await scrapeHung;
  if (typeof bg.context.resumePostScrapeTranslateLoop === 'function') bg.context.resumePostScrapeTranslateLoop();
  let late = null;
  for (let i = 0; i < 50; i++) {
    await sleep(20);
    late = byId().late2;
    if (late?.status === 'trans') break;
  }
  check('L3c 抓取全部结束且线已退出 → resume 再安排一次，挂住期间入库的卡被翻译',
    late?.status === 'trans', JSON.stringify(late));
  bg.setTime(clockBase);
  await sleep(200);
}

// ============ R 组：真实 translator.js（在本进程全局求值，与 SW 上下文里的替身互不相干） ============
{
  // translator.js 不读 storage：配置按尾参显式传入（后台由 readTranslateConfig 读取后注入）
  (0, eval)(fs.readFileSync(new URL('../src/shared/translator.js', import.meta.url), 'utf8'));

  const aiConfig = { translateMode: 'ai', aiEndpoint: 'https://x.test/v1', aiApiKey: 'k', requestTimeoutSec: 5 };
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({}) });
  let err = null;
  try { await globalThis.Translator.translateBatchAI([{ title: 'A', desc: '' }], aiConfig); } catch (e) { err = e; }
  check('R1 AI 批量 HTTP 400 抛错并带 status（后台据此归因条目级拒收）', err?.status === 400 && err?.message.includes('400'),
    JSON.stringify({ message: err?.message, status: err?.status }));

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: { message: 'invalid api key' } }) });
  let err2 = null;
  try { await globalThis.Translator.translateBatchAI([{ title: 'A', desc: '' }], aiConfig); } catch (e) { err2 = e; }
  check('R1b 中转服务 HTTP 200 + {"error":…}（缺 choices）→ 按传输失败抛错、无 status（通道故障）',
    String(err2?.message || '').includes('invalid api key') && err2?.status === undefined, String(err2?.message));

  const apiConfig = { translateMode: 'api', apiEndpoint: 'https://mt.test/get', requestTimeoutSec: 5 };
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r2 = await globalThis.Translator.translateTitleAndDesc('Hello', 'World', apiConfig);
  check('R2 API 模式 HTTP 503 → 字段空串 + transportError', r2.title === '' && r2.desc === '' && String(r2.transportError).includes('503'),
    JSON.stringify(r2));

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ responseStatus: 429, responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' } }) });
  const r3 = await globalThis.Translator.translateTitleAndDesc('Hello', '', apiConfig);
  check('R3 API 模式额度告警（HTTP 200 + responseStatus 429）→ transportError，不当成译文', r3.title === '' && Boolean(r3.transportError),
    JSON.stringify(r3));

  // 原文用 searchParams 取：URL 的查询串里空格编码成 '+'，正则 + decodeURIComponent 还原不了
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ responseStatus: 200, responseData: { translatedText: new URL(url).searchParams.get('q') } }) });
  const r4 = await globalThis.Translator.translateTitleAndDesc('1923', '', apiConfig);
  check('R4 API 模式译文与原文相同 → 空串且无 transportError（后台按「服务答了没给译文」计次）',
    r4.title === '' && r4.desc === '' && !('transportError' in r4), JSON.stringify(r4));

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ responseStatus: 200, responseData: { translatedText: '你好' } }) });
  const r5 = await globalThis.Translator.translateTitleAndDesc('Hello', 'World', apiConfig);
  check('R5 API 模式正常应答照常返回译文', r5.title === '你好' && r5.desc === '你好' && !('transportError' in r5), JSON.stringify(r5));

  // R6 mymemory-length-and-query 第 1 步（batch F）：endpoint 自带查询串（MyMemory 文档建议加
  // de=邮箱提高额度）时，旧的字符串拼接得 '…/get?de=me@x.com?q=…'，q 被吞进 de 的值里。
  // 桩按 MyMemory 的真实行为：缺 q 回 responseStatus 403「NO QUERY SPECIFIED」
  const deConfig = { translateMode: 'api', apiEndpoint: 'https://mt.test/get?de=me@x.com', requestTimeoutSec: 5 };
  const apiUrls = [];
  globalThis.fetch = async (url) => {
    apiUrls.push(String(url));
    const q = new URL(url).searchParams.get('q');
    return { ok: true, status: 200, json: async () => (q
      ? { responseStatus: 200, responseData: { translatedText: `译:${q}` } }
      : { responseStatus: 403, responseDetails: 'NO QUERY SPECIFIED. EXAMPLE REQUEST: GET?Q=HELLO&LANGPAIR=EN|IT', responseData: { translatedText: '' } }) };
  };
  const r6 = await globalThis.Translator.translateTitleAndDesc('Tom & Jerry?', 'A cat + a mouse', deConfig);
  const p6 = apiUrls[0] ? new URL(apiUrls[0]).searchParams : new URLSearchParams();
  check('R6 endpoint 自带查询串：保留 de，q / langpair 作为独立参数（含 & ? + 的原文往返无损）',
    r6.title === '译:Tom & Jerry?' && r6.desc === '译:A cat + a mouse' && !('transportError' in r6)
      && p6.get('de') === 'me@x.com' && p6.get('langpair') === 'en|zh-CN' && apiUrls.length === 2,
    JSON.stringify({ r6, urls: apiUrls }));
}

await sleep(50);
check('T0 全程无未捕获 rejection', unhandledCount === 0, `unhandled=${unhandledCount}`);

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
