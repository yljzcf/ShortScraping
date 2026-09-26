import './bootstrap.cjs';
// 回归测试：翻译「半成品」语义（v1.5.14）。
//
// 起因（2026-09-12 实测）：后台翻译线只挑 status==='new'，而回填判据是
// 「标题**或**简介任一非空就标 trans」——模型偶发只回简介不回片名时，该条卡被
// 永久定格：有中文简介、无中文标题、status='trans'、再也不会重进队列。
// 全库实测 660 条这样卡死（另有 23 条是 Steam 适配器「官方中文只有一半」同类问题）。
//
// 新契约：
//   ① 该翻的都翻出来了才算完成——标题非空须有 titleZh，简介非空须有 descriptionZh；
//   ② 半成品存下已得部分但保持 status='new'，下轮补另一半；
//   ③ 连续 MAX_PARTIAL_TRANSLATE_ATTEMPTS 次仍补不齐才接受半成品收口（防死循环）；
//   ④ 批量线 fillOnly：只补空缺，绝不覆盖平台官方译名（Steam 官方中文）或既有译文；
//      弹窗单卡 🌍 重译不受此限，仍是新结果优先。
// 用法：node tests/unit-translate-partial.mjs（实现前跑 P2/P3/P5 应 RED）
// v1.6.20：手搓的 chrome 桩换成 background-fixture（storage 走共用的 storage-stub）。
import { background } from './background-fixture.mjs';

// 弹窗发送方（不带 tab）：沿用迁移前手搓桩的口径，后台 isExtensionPageSender 放行
const POPUP_SENDER = { id: 'fixture', url: 'chrome-extension://fixture/src/popup/popup.html' };

// Translator 桩：按标题决定返回什么，用来构造「半成品」（注入后 fixture 不加载真实 translator.js）
const stubPlan = new Map();          // title -> {title, desc}
const Translator = {
  async translateTitleAndDesc(title) {
    return stubPlan.get(title) || { title: `中·${title}`, desc: '中文简介' };
  }
};

// 真定时器：批间 delayMs 与轮询靠真时间走；tick:1 保持手搓桩「先让一拍再读写」的时序；
// 外网一律拒（与迁移前同口径：config/*.json 也读不到）
const bg = await background({
  translator: Translator,
  timers: 'real',
  storage: { tick: 1 },
  fetch: () => Promise.reject(new TypeError('unit stub: no network'))
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(150);

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
// 等队列排空再让 dramas 内存缓存失效，随后直改 storage 等价「SW 冷启动前 storage 被外部改写」
const resetDramasCache = () => bg.resetDramasCache();

const SUB = 'https://unit.test/list';
const mk = (id, over = {}) => ({
  id, itemId: id, title: `T-${id}`, description: `D-${id}`,
  status: 'new', source: 'unittest', sourceListUrl: SUB,
  titleZh: '', descriptionZh: '', translatedAt: null, ...over
});

async function runTranslateRound() {
  await bg.send({ action: 'triggerTranslate' }, POPUP_SENDER);
  for (let i = 0; i < 60; i++) {
    await sleep(80);
    const st = bg.data.translateRunState;
    if (st && st.running === false) break;
  }
  await sleep(200);
}
const byId = () => Object.fromEntries((bg.dramas() || []).map(d => [d.id, d]));

// ---------- 第一轮：完整 / 半成品 / 无简介 / 全空 ----------
await resetDramasCache();
bg.storage.seed({
  urlTags: [{ urlPattern: SUB, tags: ['T'] }],
  translateConfig: { translateMode: 'api', delayMs: 1 }
});
stubPlan.clear();
stubPlan.set('T-full', { title: '中文标题', desc: '中文简介' });
stubPlan.set('T-partial', { title: '', desc: '只回了简介' });        // 模型漏片名
stubPlan.set('T-nodesc', { title: '中文标题', desc: '' });            // 原文本就无简介
stubPlan.set('T-empty', { title: '', desc: '' });                     // 整条没回
bg.seedDramas([
  mk('full'),
  mk('partial'),
  mk('nodesc', { description: '' }),
  mk('empty')
]);
await runTranslateRound();

{
  const m = byId();
  check('P1 完整返回 → 标 trans 并写 translatedAt',
    m.full?.status === 'trans' && m.full?.titleZh === '中文标题'
    && m.full?.descriptionZh === '中文简介' && Boolean(m.full?.translatedAt),
    JSON.stringify(m.full));
  check('P2 只回简介缺片名 → 简介存下但保持 new、不写 translatedAt',
    m.partial?.status === 'new' && m.partial?.descriptionZh === '只回了简介'
    && !m.partial?.titleZh && !m.partial?.translatedAt,
    JSON.stringify(m.partial));
  check('P3 原文无简介 → 拿到标题即算完成',
    m.nodesc?.status === 'trans' && m.nodesc?.titleZh === '中文标题' && Boolean(m.nodesc?.translatedAt),
    JSON.stringify(m.nodesc));
  check('P4 整条没回 → 保持 new、不写任何译文',
    m.empty?.status === 'new' && !m.empty?.titleZh && !m.empty?.descriptionZh && !m.empty?.translatedAt,
    JSON.stringify(m.empty));
  // 2026-09-25 体检 B2：空结果与半成品共用重试额度（同批有条目翻成功＝接口正常，错在这条自己）。
  // 此前空结果不计次，永远空着的条目每轮陪跑、翻译线等不到 pendingCount 归零；
  // 失败归因与熔断的完整矩阵见 unit-translate-failures
  check('P4b 整条没回也累加 translateAttempts（与半成品共用上限）', m.empty?.translateAttempts === 1,
    JSON.stringify(m.empty));
}

// ---------- 第二轮：半成品补齐 ----------
stubPlan.set('T-partial', { title: '补上的标题', desc: '新简介' });
await runTranslateRound();
{
  const m = byId();
  check('P5 下一轮补上片名 → 转 trans',
    m.partial?.status === 'trans' && m.partial?.titleZh === '补上的标题' && Boolean(m.partial?.translatedAt),
    JSON.stringify(m.partial));
  check('P5b fillOnly：既有中文简介不被新结果覆盖',
    m.partial?.descriptionZh === '只回了简介', JSON.stringify(m.partial?.descriptionZh));
}

// ---------- 第三轮：平台官方译名不被覆盖 ----------
await resetDramasCache();
stubPlan.clear();
stubPlan.set('T-official', { title: 'AI 翻的标题', desc: 'AI 翻的简介' });
bg.seedDramas([mk('official', { titleZh: '官方中文名', descriptionZh: '' })]);
await runTranslateRound();
{
  const m = byId();
  check('P6 批量线只补空缺，不覆盖平台官方译名',
    m.official?.titleZh === '官方中文名' && m.official?.descriptionZh === 'AI 翻的简介'
    && m.official?.status === 'trans',
    JSON.stringify(m.official));
}

// ---------- 第四轮：重试上限，防死循环 ----------
await resetDramasCache();
stubPlan.clear();
stubPlan.set('T-stuck', { title: '', desc: '永远只有简介' });
bg.seedDramas([mk('stuck')]);
let rounds = 0;
for (; rounds < 6; rounds++) {
  await runTranslateRound();
  if (byId().stuck?.status === 'trans') break;
}
{
  const m = byId();
  check('P7 连续补不齐达上限后收口为 trans（不再无限重试）',
    m.stuck?.status === 'trans' && rounds >= 1 && rounds < 6,
    `rounds=${rounds} ${JSON.stringify(m.stuck)}`);
  check('P7b 收口时已得的简介仍保留',
    m.stuck?.descriptionZh === '永远只有简介', JSON.stringify(m.stuck?.descriptionZh));
}

// ---------- 单卡路径不受 fillOnly 约束 ----------
await resetDramasCache();
bg.seedDramas([mk('recard', { status: 'trans', titleZh: '旧译名', descriptionZh: '旧简介', translatedAt: '2026-07-01T00:00:00.000Z' })]);
// applyTranslation 入口已删除（2026-09-25 审查）：单卡路径（translateSingle）即不带 fillOnly 调这里
await bg.context.updateSingleDramaTranslation('recard', { title: '新译名', desc: '新简介' });
await sleep(200);
{
  const m = byId();
  check('P8 弹窗单卡重译仍以新结果优先（不走 fillOnly）',
    m.recard?.titleZh === '新译名' && m.recard?.descriptionZh === '新简介',
    JSON.stringify(m.recard));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
