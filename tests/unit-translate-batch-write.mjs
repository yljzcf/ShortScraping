import './bootstrap.cjs';
// 回归测试：AI 翻译成功批整批合并写（v1.6.22，设计「v1.6.24：AI 翻译按批合并写」并入本版）。
//
// 起因：翻译线 AI 模式一批最多 10 条，此前每条拿到译文都各排一次队列、各写一次整表
// （updateSingleDramaTranslation → writeDramasInQueue）——一批 10 次数 MB 的 set，每次还各换一个
// dramasStamp、各触发一轮 onChanged → CSV 调度。
//
// 契约：
//   B 组（整批写）：一批里拿到译文的条目一次队列操作合并、只写一次整表（一次 set、一个 dramasStamp）；
//     多批各写一次；卡在请求在飞期间被删不复活，整批的卡都没了不写。
//   E 组（与逐条写等价）：同一组译文结果走 AI 整批写与走 API 模式逐条写，落库记录逐条相同，
//     推群的条数与顺序、summary 计数、轮末失败落账（translateAttempts / 收口）都相同；整批写失败时
//     与逐条写第一次落库就失败同口径（E2）。
//   K 组（保持逐条写的路径）：整批失败后的拆单重试、API 模式仍然一条一写。
//   R 组（与 🌍 抢同一张卡）：🌍 在批量请求在飞时先落库，整批写 fillOnly 不覆盖它的译文、不再推第二次。
//   M 组（mergeTranslation 纯函数）：不改入参；fillOnly / 覆盖两种口径；半成品计次与达上限收口；now 选项。
// 用法：node tests/unit-translate-batch-write.mjs（实现前 B1/B2/B3/B4/E1d/E2b/M0 应 RED）
import { background } from './background-fixture.mjs';

let unhandledCount = 0;
process.on('unhandledRejection', (e) => { unhandledCount++; console.error('UNHANDLED:', e?.message || e); });

// 弹窗发送方（不带 tab）：后台 isExtensionPageSender 放行 translateSingle
const POPUP_SENDER = { id: 'fixture', url: 'chrome-extension://fixture/src/popup/popup.html' };

// Translator 桩：按标题查 plan 决定每条回什么（AI 批量与 API 逐条共用同一份 plan，E 组据此比对两条路径）
const batchCalls = [];
const singleCalls = [];
let plan = new Map();                 // title -> { title, desc } | Error（抛出）
let batchHook = null;                 // 批量请求在飞时的钩子（R / B5 组在这里插入别的队列写）
const answer = (title) => {
  const planned = plan.get(title);
  if (planned instanceof Error) throw planned;
  return planned || { title: `中·${title}`, desc: '中文简介' };
};
const Translator = {
  async translateBatchAI(items) {
    batchCalls.push(items.map(it => it.title));
    if (batchHook) await batchHook(items);
    // 一条被拒收整批跟着失败（同真实接口：一次请求只有一个状态码）；单条请求由 answer 抛出
    const rejected = items.find(it => plan.get(it.title) instanceof Error);
    if (rejected) throw plan.get(rejected.title);
    return items.map(it => answer(it.title));
  },
  async translateTitleAndDesc(title) {
    singleCalls.push(title);
    return answer(title);
  }
};
const httpError = (status) => Object.assign(new Error(`AI 接口 HTTP ${status}`), { status });

// 真定时器 + 压时长（同 unit-translate-failures）：批间 delayMs、推群 250ms 节流一律 ≤2ms。
// settle:false：顶层代码一跑完就换掉 SW 上下文的 setTimeout
const bg = await background({
  settle: false,
  translator: Translator,
  timers: 'real',
  storage: { tick: 1 },
  fetch: () => Promise.reject(new TypeError('unit stub: no network'))
});
const realSetTimeout = globalThis.setTimeout;
bg.context.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.min(Number(ms) || 0, 2), ...args);
const sleep = ms => new Promise(r => realSetTimeout(r, ms));

// 触发点①的推群替身：记下每次推的是哪条、推时读回的记录长什么样（真实推送链路与节流见
// unit-lark-bot-trigger 的 A / S 组）。后台顶层函数声明＝vm 上下文全局属性，调用时按名解析到替身
const pushes = [];
bg.context.maybeBotPush = async (drama) => {
  pushes.push({ id: drama?.id, status: drama?.status, titleZh: drama?.titleZh, descriptionZh: drama?.descriptionZh });
  return true;
};

// 数 dramas 整表写：包一层 storage.set，按 storage-stub 的 writesDramas 判定（不直写键名）
const dramaWrites = [];
const origSet = bg.storage.local.set;
bg.storage.local.set = (values, callback) => {
  if (bg.storage.writesDramas(values)) dramaWrites.push(Object.keys(values).sort().join(','));
  return origSet(values, callback);
};

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
async function seed(config, dramas, nextPlan = new Map()) {
  await bg.resetDramasCache();
  bg.storage.seed({ urlTags: [{ urlPattern: SUB, tags: ['T'] }], translateConfig: config });
  bg.seedDramas(dramas);
  plan = nextPlan;
  batchHook = null;
  batchCalls.length = 0;
  singleCalls.length = 0;
  pushes.length = 0;
  dramaWrites.length = 0;
}
const round = () => bg.context.performTranslate({ source: 'manual' });
const summaryOf = () => {
  const s = bg.data.translateRunState?.summary || {};
  return { pendingCount: s.pendingCount, processedCount: s.processedCount, translatedCount: s.translatedCount, error: s.error };
};

// ============ B 组：成功批整批一次写 ============

// B1 10 条一批全部翻成 → 只写一次整表
await seed(AI, Array.from({ length: 10 }, (_, i) => mk(`a${i}`)));
{
  const r = await round();
  const m = byId();
  check('B1 10 条一批全部翻成：本轮 dramas 整表只 set 一次', dramaWrites.length === 1, JSON.stringify(dramaWrites));
  check('B1a 前置：一次批量请求、10 条都落库为 trans 且带译文',
    batchCalls.length === 1 && batchCalls[0].length === 10
      && Array.from({ length: 10 }, (_, i) => m[`a${i}`]).every((d, i) => d?.status === 'trans' && d?.titleZh === `中·T-a${i}`
        && d?.descriptionZh === '中文简介' && Boolean(d?.translatedAt) && !('translateAttempts' in d)),
    JSON.stringify({ batchCalls, m }));
  check('B1b 那一次 set 连带换一个 dramasStamp（同一次写），pending 按写后的表算＝0',
    dramaWrites[0] === 'dramas,dramasStamp' && bg.data.dramasStamp?.pending === 0 && typeof bg.data.dramasStamp?.rev === 'string',
    JSON.stringify({ dramaWrites, stamp: bg.data.dramasStamp }));
  check('B1c 推群 10 次、按批内顺序，推的是落库后读回的记录',
    pushes.map(p => p.id).join(',') === Array.from({ length: 10 }, (_, i) => `a${i}`).join(',')
      && pushes.every((p, i) => p.status === 'trans' && p.titleZh === `中·T-a${i}`),
    JSON.stringify(pushes.map(p => [p.id, p.status, p.titleZh])));
  check('B1d summary 计数不变：待翻 10 / 处理 10 / 完成 10、无错误',
    r?.translatedCount === 10 && r?.pendingCount === 10 && !r?.error
      && JSON.stringify(summaryOf()) === JSON.stringify({ pendingCount: 10, processedCount: 10, translatedCount: 10 }),
    JSON.stringify({ r, summary: summaryOf() }));
}

// B2 25 条分 3 批（10/10/5）→ 每批各写一次，共 3 次
await seed(AI, Array.from({ length: 25 }, (_, i) => mk(`b${i}`)));
{
  const r = await round();
  check('B2 25 条分 3 批：每批一次整表写，共 3 次（此前 25 次）',
    batchCalls.length === 3 && dramaWrites.length === 3 && r?.translatedCount === 25,
    JSON.stringify({ calls: batchCalls.map(c => c.length), writes: dramaWrites.length, r }));
  check('B2a 推群 25 次、跨批按原顺序', pushes.map(p => p.id).join(',') === Array.from({ length: 25 }, (_, i) => `b${i}`).join(','),
    JSON.stringify(pushes.map(p => p.id)));
}

// B3 一批里有空结果与半成品：成功的仍一次写；空结果照旧轮末逐条落账（与逐条写时一样）
await seed(AI, [mk('c0'), mk('c1'), mk('c2'), mk('c3')], new Map([
  ['T-c1', { title: '', desc: '' }],                // 应答了却漏了这条 → 暂记失败，轮末落账
  ['T-c2', { title: '', desc: '只回了简介' }]         // 半成品 → 本批合并写里保持 new、计次
]));
{
  const r = await round();
  const m = byId();
  check('B3 成功 / 半成品合并为 1 次写 + 空结果轮末 1 次落账＝共 2 次',
    dramaWrites.length === 2, JSON.stringify(dramaWrites));
  check('B3a 字段规则不变：半成品存下简介保持 new、计 1 次；空结果计 1 次；其余 trans',
    m.c0?.status === 'trans' && m.c3?.status === 'trans'
      && m.c2?.status === 'new' && m.c2?.descriptionZh === '只回了简介' && !m.c2?.titleZh && m.c2?.translateAttempts === 1 && !m.c2?.translatedAt
      && m.c1?.status === 'new' && m.c1?.translateAttempts === 1 && !m.c1?.titleZh,
    JSON.stringify([m.c0, m.c1, m.c2, m.c3]));
  check('B3b 计数：完成 2（半成品不计）、处理 4；推群只推翻成 trans 的 c0、c3',
    r?.translatedCount === 2 && summaryOf().processedCount === 4 && pushes.map(p => p.id).join(',') === 'c0,c3',
    JSON.stringify({ r, summary: summaryOf(), pushes: pushes.map(p => p.id) }));
  check('B3c 部分空结果不触发拆单重试（仍是 1 次批量请求）', batchCalls.length === 1, JSON.stringify(batchCalls));
}

// B4 请求在飞期间有一张卡被删：整批写不把它写回来，其余照常一次写
await seed(AI, [mk('d0'), mk('gone'), mk('d2')]);
batchHook = async () => {
  batchHook = null;
  await bg.context.enqueueDramaWrite('测试删卡', async () => {
    const current = await bg.context.getDramasInQueue();
    await bg.context.writeDramasInQueue(current.filter(d => d.id !== 'gone'));
  });
};
{
  const r = await round();
  const m = byId();
  check('B4 请求在飞时被删的卡不复活，其余照常落库；整批仍只写 1 次（另 1 次是测试自己的删卡）',
    !m.gone && m.d0?.status === 'trans' && m.d2?.status === 'trans' && dramaWrites.length === 2 && (bg.dramas() || []).length === 2,
    JSON.stringify({ ids: Object.keys(m), writes: dramaWrites.length }));
  check('B4a 被删的卡不推、不计完成（同逐条写时「卡片不存在」的返回）',
    pushes.map(p => p.id).join(',') === 'd0,d2' && r?.translatedCount === 2, JSON.stringify({ pushes: pushes.map(p => p.id), r }));
}

// B5 整批的卡都在请求在飞时被删光：不写空操作
await seed(AI, [mk('e0'), mk('e1')]);
batchHook = async () => {
  batchHook = null;
  await bg.context.enqueueDramaWrite('测试删卡', async () => { await bg.context.writeDramasInQueue([]); });
};
{
  await round();
  check('B5 整批的卡都没了：整批写跳过（只剩测试自己那 1 次删卡写）',
    dramaWrites.length === 1 && (bg.dramas() || []).length === 0 && pushes.length === 0,
    JSON.stringify({ writes: dramaWrites, pushes }));
}

// ============ E 组：与逐条写等价（同一组结果分别走 AI 整批写 / API 逐条写，逐项比对） ============
// 10 条覆盖所有分支：完整、空结果、半成品、平台官方译名（fillOnly 不覆盖）、原文无简介、
// 半成品达上限收口、空结果达上限收口（轮末落账收口也推群，排在批内推送之后）
const scenario = () => [
  mk('f0'),
  mk('f1'),                                                       // 空结果 → 轮末计次
  mk('f2'),                                                       // 半成品
  mk('f3', { titleZh: '官方中文名' }),                             // 平台自带片名：fillOnly 只补简介
  mk('f4', { description: '' }),                                  // 原文无简介：拿到片名即完成
  mk('f5', { translateAttempts: 2 }),                             // 半成品第 3 次 → 收口 trans
  mk('f6', { translateAttempts: 2 }),                             // 空结果第 3 次 → 轮末收口 trans
  mk('f7'), mk('f8'), mk('f9')
];
const scenarioPlan = () => new Map([
  ['T-f1', { title: '', desc: '' }],
  ['T-f2', { title: '', desc: '只有简介' }],
  ['T-f3', { title: 'AI 片名', desc: 'AI 简介' }],
  ['T-f4', { title: '只有片名', desc: '' }],
  ['T-f5', { title: '', desc: '三次仍缺片名' }],
  ['T-f6', { title: '', desc: '' }]
]);
const capture = (r) => ({
  records: scenario().map(d => byId()[d.id]),
  pushes: pushes.map(p => JSON.stringify(p)),
  result: r,
  summary: summaryOf(),
  writes: dramaWrites.length,
  stamp: bg.data.dramasStamp?.pending
});

await seed(AI, scenario(), scenarioPlan());
const viaBatch = capture(await round());
const batchRequests = batchCalls.length;
await seed(API, scenario(), scenarioPlan());
const viaSingle = capture(await round());
{
  check('E1 前置：AI 路径 1 次批量请求，API 路径 10 次逐条请求', batchRequests === 1 && singleCalls.length === 10,
    `batch=${batchRequests} single=${singleCalls.length}`);
  check('E1a 落库记录逐条相同（含 status / 译文 / translateAttempts / translatedAt）',
    JSON.stringify(viaBatch.records) === JSON.stringify(viaSingle.records),
    JSON.stringify({ batch: viaBatch.records, single: viaSingle.records }));
  check('E1b 推群条数与顺序相同（批内翻成 trans 的按批内顺序，轮末收口的 f6 最后）',
    JSON.stringify(viaBatch.pushes) === JSON.stringify(viaSingle.pushes)
      && viaBatch.pushes.map(p => JSON.parse(p).id).join(',') === 'f0,f3,f4,f5,f7,f8,f9,f6',
    JSON.stringify({ batch: viaBatch.pushes.map(p => JSON.parse(p).id), single: viaSingle.pushes.map(p => JSON.parse(p).id) }));
  check('E1c summary 与返回值相同（完成 7：f6 轮末收口不计完成；处理 10）',
    JSON.stringify(viaBatch.summary) === JSON.stringify(viaSingle.summary)
      && JSON.stringify(viaBatch.result) === JSON.stringify(viaSingle.result)
      && viaBatch.result?.translatedCount === 7 && viaBatch.summary.processedCount === 10,
    JSON.stringify({ batch: [viaBatch.result, viaBatch.summary], single: [viaSingle.result, viaSingle.summary] }));
  check('E1d 整表写次数：整批 1 + 轮末落账 2＝3；逐条 8 + 2＝10',
    viaBatch.writes === 3 && viaSingle.writes === 10, `batch=${viaBatch.writes} single=${viaSingle.writes}`);
  check('E1e 写后 dramasStamp.pending 相同（f1、f2 仍是 new）', viaBatch.stamp === 2 && viaSingle.stamp === 2,
    `batch=${viaBatch.stamp} single=${viaSingle.stamp}`);
  const m = Object.fromEntries(viaBatch.records.map(d => [d.id, d]));
  check('E1f 字段规则抽查：官方片名保留只补简介；无简介拿到片名即完成；两条达上限收口、清计数',
    m.f3?.titleZh === '官方中文名' && m.f3?.descriptionZh === 'AI 简介' && m.f3?.status === 'trans'
      && m.f4?.status === 'trans' && m.f4?.titleZh === '只有片名'
      && m.f5?.status === 'trans' && m.f5?.descriptionZh === '三次仍缺片名' && !('translateAttempts' in m.f5)
      && m.f6?.status === 'trans' && !m.f6?.titleZh && !('translateAttempts' in m.f6),
    JSON.stringify([m.f3, m.f4, m.f5, m.f6]));
}

// E2 整批写失败（storage set 抛错）：与逐条写时第一次落库就失败同口径——整批写在第一条有译文的
//    条目走到落库时才发出，排在它前面的空结果已暂记（处理 1），随后抛错结束本轮；什么都没落库、不推群
const failScenario = () => [mk('w0'), mk('w1'), mk('w2')];
const failPlan = () => new Map([['T-w0', { title: '', desc: '' }]]);
const captureFail = (r) => ({ result: r, summary: summaryOf(), pushes: pushes.length, records: failScenario().map(d => byId()[d.id]) });
await seed(AI, failScenario(), failPlan());
bg.storage.failNextSet(bg.storage.writesDramas, 'unit stub: 整表写失败');
const failBatch = captureFail(await round());
plan = new Map();
dramaWrites.length = 0;
const recovered = await round();
const recoveredWrites = dramaWrites.length;
await seed(API, failScenario(), failPlan());
bg.storage.failNextSet(bg.storage.writesDramas, 'unit stub: 整表写失败');
const failSingle = captureFail(await round());
{
  check('E2 整批写失败：本轮带错收尾，计数与逐条写首次落库失败时相同（处理 1 / 完成 0）',
    JSON.stringify(failBatch.summary) === JSON.stringify(failSingle.summary)
      && failBatch.summary.processedCount === 1 && failBatch.summary.translatedCount === 0
      && String(failBatch.summary.error || '').includes('整表写失败'),
    JSON.stringify({ batch: failBatch.summary, single: failSingle.summary }));
  check('E2a 写失败时不推群、库里一条都没动', failBatch.pushes === 0
      && failBatch.records.every(d => d?.status === 'new' && !d?.titleZh && d?.translateAttempts === undefined),
    JSON.stringify(failBatch));
  check('E2b 写失败后缓存作废，下一轮重读照常整批落库（1 次写）', recovered?.translatedCount === 3 && recoveredWrites === 1,
    JSON.stringify({ recovered, writes: recoveredWrites }));
}

// ============ K 组：拆单重试与 API 模式仍然逐条写 ============

// K1 整批 400（一条触发内容审核）→ 拆单条重试：翻成的 4 条各写一次，毒条目轮末落账 1 次
await seed(AI, ['k0', 'k1', 'poison', 'k3', 'k4'].map(id => mk(id)), new Map([['T-poison', httpError(400)]]));
{
  const r = await round();
  const m = byId();
  check('K1 整批失败拆单重试：逐条写（4 条成功各 1 次 + 毒条目轮末 1 次＝5 次）',
    batchCalls.length === 6 && dramaWrites.length === 5 && r?.translatedCount === 4 && m.poison?.translateAttempts === 1,
    JSON.stringify({ calls: batchCalls.map(c => c.length), writes: dramaWrites.length, r, poison: m.poison }));
  check('K1a 拆单重试的推群顺序不变', pushes.map(p => p.id).join(',') === 'k0,k1,k3,k4', JSON.stringify(pushes.map(p => p.id)));
}

// K2 API 模式逐条翻译逐条写
await seed(API, [mk('p0'), mk('p1'), mk('p2')]);
{
  await round();
  check('K2 API 模式仍一条一写（3 条 3 次）', dramaWrites.length === 3 && singleCalls.length === 3,
    JSON.stringify({ writes: dramaWrites.length, calls: singleCalls.length }));
}

// ============ R 组：🌍 在批量请求在飞时抢先翻完同一张卡 ============
await seed(AI, [mk('r0'), mk('race'), mk('r2')]);
batchHook = async () => {
  batchHook = null;
  const resp = await bg.send({ action: 'translateSingle', dramaId: 'race' }, POPUP_SENDER);
  check('R0 前置：🌍 在批量请求在飞时落库成功', resp?.success === true && resp?.complete === true, JSON.stringify(resp));
  await sleep(20); // 触发点③的推送不 await（getDramasSnapshot().then(maybeBotPush)）
};
plan = new Map([['T-race', { title: '中·T-race', desc: '中文简介' }]]);
{
  const r = await round();
  const m = byId();
  check('R1 整批写 fillOnly：🌍 已写的译文不被覆盖，卡照样算完成（完成 3）',
    m.race?.status === 'trans' && m.race?.titleZh === '中·T-race' && r?.translatedCount === 3,
    JSON.stringify({ race: m.race, r }));
  check('R2 这张卡只推一次（🌍 那次）：整批写按队列内当前记录判 becameTrans=false',
    pushes.filter(p => p.id === 'race').length === 1 && pushes.map(p => p.id).join(',') === 'race,r0,r2',
    JSON.stringify(pushes.map(p => p.id)));
}

// ============ M 组：mergeTranslation 纯函数 ============
{
  const { mergeTranslation } = bg.context;
  check('M0 mergeTranslation 已导出（后台顶层函数）', typeof mergeTranslation === 'function', typeof mergeTranslation);
  if (typeof mergeTranslation === 'function') {
    const current = Object.freeze(mk('m1', { titleZh: '旧片名', translateAttempts: 1 }));
    const fill = mergeTranslation(current, { title: '新片名', desc: '新简介' }, { fillOnly: true, now: '2026-09-26T00:00:00.000Z' });
    check('M1 fillOnly 只补空缺、完成即收口：保留旧片名、补简介、写 now、清计数、becameTrans',
      fill.record.titleZh === '旧片名' && fill.record.descriptionZh === '新简介' && fill.record.status === 'trans'
        && fill.record.translatedAt === '2026-09-26T00:00:00.000Z' && !('translateAttempts' in fill.record)
        && fill.done === true && fill.becameTrans === true,
      JSON.stringify(fill));
    check('M1a 不改入参（current 冻结也不抛），返回新对象', fill.record !== current && current.translateAttempts === 1 && current.status === 'new',
      JSON.stringify(current));
    const over = mergeTranslation(mk('m2', { status: 'trans', titleZh: '旧', descriptionZh: '旧简介' }), { title: '新', desc: '' });
    check('M2 不带 fillOnly（🌍 重译）新结果优先、空字段保留旧值；本来就是 trans → becameTrans=false',
      over.record.titleZh === '新' && over.record.descriptionZh === '旧简介' && over.done === true && over.becameTrans === false
        && typeof over.record.translatedAt === 'string',
      JSON.stringify(over));
    const half = mergeTranslation(mk('m3', { translateAttempts: 1 }), { title: '', desc: '只简介' }, { fillOnly: true });
    check('M3 半成品：保持 new、计次 +1、不写 translatedAt',
      half.done === false && half.becameTrans === false && half.record.status === 'new' && half.record.translateAttempts === 2
        && half.record.translatedAt === null,
      JSON.stringify(half));
    const capped = mergeTranslation(mk('m4', { translateAttempts: 2 }), { title: '', desc: '' }, { fillOnly: true });
    check('M4 第 3 次仍没翻全：收口 trans、清计数、becameTrans',
      capped.done === true && capped.becameTrans === true && capped.record.status === 'trans' && !('translateAttempts' in capped.record),
      JSON.stringify(capped));
  }
}

await sleep(50);
check('T0 全程无未捕获 rejection', unhandledCount === 0, `unhandled=${unhandledCount}`);

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
