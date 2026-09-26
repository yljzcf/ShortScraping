import './bootstrap.cjs';
// 「全部翻译」后台侧回归测试（unit-dramas-race 范式；2026-08-02 现代化：
// 对齐 v1.4.1 翻译状态机——triggerTranslate 改为立即 ack {success, started}
// 不再同步回传 summary，完成态经 translateRunState 驱动，测试改为轮询落库终态）。
// 目标行为：
//   ① triggerTranslate 立即应答 started:true（fire-and-forget，弹窗不再等长跑往返）
//   ② performTranslate 语义不变：只翻 status=new 且属于订阅 URL 的条目
//   ③ clearDramas 消息接口已移除（clearAllDramas 保留给安装初始化）
//   ④ 全部翻完后二次触发不重翻（translatedAt 不变）
// 注意：v1.5.1 起 SW 队列持有 dramas 内存缓存，直改 storage 前必须先让缓存失效
// （bg.resetDramasCache），否则翻译线读到旧缓存零待翻。
// v1.6.20：手搓的 chrome 桩换成 background-fixture（storage 走共用的 storage-stub）。
// 用法：node tests/unit-translate-all.mjs
import { background } from './background-fixture.mjs';

// 弹窗发送方（不带 tab）：沿用迁移前手搓桩的口径，后台 isExtensionPageSender 放行
const POPUP_SENDER = { id: 'fixture', url: 'chrome-extension://fixture/src/popup/popup.html' };

// Translator 桩：确定性中文结果，性能开销为零（注入后 fixture 不加载真实 translator.js）
const Translator = {
  async translateTitleAndDesc(title, description) {
    return { title: `中·${title}`, desc: description ? `中文简介·${description}` : '' };
  }
};

// ---------- 加载真实生产代码 ----------
// 真定时器：批间 delayMs 与本套件的轮询都靠真时间走；tick:1 保持手搓桩「先让一拍再读写」的时序；
// 外网一律拒（与迁移前同口径：config/*.json 也读不到，初始化走「读取失败保留旧值」分支）
const bg = await background({
  translator: Translator,
  timers: 'real',
  storage: { tick: 1 },
  fetch: () => Promise.reject(new TypeError('unit stub: no network'))
});
const send = message => bg.send(message, POPUP_SENDER);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(150); // 等后台顶层初始化落定

const mk = (n, itemId, over = {}) => ({
  id: `id-${n}`, itemId, title: `Title ${n}`, description: `desc ${n}`,
  status: 'new', source: 'unittest', sourceListUrl: 'https://unit.test/list',
  titleZh: '', descriptionZh: '', translatedAt: null, ...over
});
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ---------- 场景数据 ----------
// A/B：待翻译且属订阅 URL；C：已翻译（不重翻）；D：待翻译但非订阅来源（须跳过）
// 等队列排空再让缓存失效，随后直改 storage 等价「SW 冷启动前 storage 被外部改写」
await bg.resetDramasCache();
bg.storage.seed({
  urlTags: [{ urlPattern: 'https://unit.test/list', tags: ['T'] }],
  translateConfig: { translateMode: 'api', delayMs: 1 }
});
bg.seedDramas([
  mk('A', 'tt0001'),
  mk('B', 'tt0002'),
  mk('C', 'tt0003', { status: 'trans', titleZh: '既有译名', translatedAt: '2026-07-01T00:00:00.000Z' }),
  mk('D', 'tt0004', { sourceListUrl: 'https://other.example/list' })
]);

// ---------- T1 triggerTranslate 立即 ack（v1.4.1 状态机语义） ----------
const resp = await send({ action: 'triggerTranslate' });
check('T1a triggerTranslate 成功响应', resp?.success === true, JSON.stringify(resp));
check('T1b 立即 ack started:true（不再同步回传 summary）', resp?.started === true, JSON.stringify(resp));

// 等异步翻译轮落库（Translator 桩即时返回，正常远快于上限）
for (let i = 0; i < 40; i++) {
  const ds = bg.dramas() || [];
  if (ds.filter(d => d.status === 'trans').length >= 3) break;
  await sleep(100);
}

// ---------- T2 翻译语义不变 ----------
{
  const dramas = bg.dramas() || [];
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
  const before = (bg.dramas() || []).length;
  const clearResp = await send({ action: 'clearDramas' });
  const after = (bg.dramas() || []).length;
  check('T3a clearDramas 消息不再有处理器', clearResp === undefined, JSON.stringify(clearResp));
  check('T3b 数据未被清空', after === before && before === 4, `before=${before} after=${after}`);
}

// ---------- T4 全部翻完后二次触发不重翻（translatedAt 逐键不变） ----------
{
  const stamp = () => JSON.stringify((bg.dramas() || []).map(d => [d.itemId, d.status, d.translatedAt, d.titleZh]));
  const before = stamp();
  const resp2 = await send({ action: 'triggerTranslate' });
  await sleep(600); // 给异步空扫描一轮落定时间
  check('T4a 二次触发立即 ack 且不重翻（translatedAt/译文不变）',
    resp2?.success === true && resp2?.started === true && stamp() === before,
    JSON.stringify({ resp2, after: stamp() }));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
