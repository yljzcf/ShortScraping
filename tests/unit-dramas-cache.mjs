import './bootstrap.cjs';
// A6 回归测试：dramas 单写者队列引入 SW 生命周期内存缓存。
// 断言：N 条保存只 1 次全表 get；写失败缓存失效重读不丢不叠；快照读零 get；
// copy-on-write（快照读者持有的旧引用不被就地突变）；CSV 同步失败的报错文案按失败形态区分（T5）。
// 用法：node tests/unit-dramas-cache.mjs（改造前跑 T1 应 RED=20 次全表读）
import { background } from './background-fixture.mjs';

// 后台走共用 background-fixture（v1.6.20 起不再手搓 chrome 桩）。发送方按真实弹窗构造（扩展页面、不带 tab），
// 与改造前手搓 runtime.sendMessage 桩给的身份一致
const POPUP_SENDER = { id: 'fixture', url: 'chrome-extension://fixture/src/popup/popup.html' };
const SUB = 'https://unit.test/list';
let csvPosts = [];
let syncReply = null; // T5：替换 /sync 的应答（抛错＝连不上）
const bg = await background({
  // 真定时器：T5 走生产的 500ms 防抖 + catch 打日志路径；tick:1 保持手搓桩「让出一拍再读写」的时序
  timers: 'real',
  storage: { tick: 1 },
  data: { urlTags: [{ urlPattern: SUB, tags: ['T'] }] },
  translator: { async translateTitleAndDesc() { return { title: '', desc: '' }; } },
  // 后台所有请求都经这里：tag.json 与 /sync 给桩响应，其余一律断网
  fetch: (url, init) => {
    const u = String(url);
    if (u.includes('tag.json')) return { ok: true, json: async () => [{ url: SUB, tags: ['T'] }] };
    if (u.includes('/sync')) {
      if (syncReply) return syncReply(init);
      csvPosts.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ ok: true, count: 0, csvPath: 'stub.csv' }) };
    }
    throw new TypeError('unit stub: no network');
  }
});
// 后台的顶层函数声明是 vm 上下文的全局属性
const { getDramasSnapshot, updateSingleDramaTranslation, syncTimelineToCsv, csvSyncNetworkError } = bg.context;

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700); // 顶层初始化落定（含迁移标记落库）

const mk = (n) => ({
  id: `id-${n}`, itemId: `tt${String(n).padStart(4, '0')}`, title: `Title ${n}`,
  description: `desc ${n}`, status: 'new', source: 'unittest', sourceListUrl: SUB, tags: ['T']
});
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const dramasReads = () => bg.storage.dramasReadCount();
const resetReads = () => { bg.storage.reads.length = 0; };
const send = (msg) => bg.send(msg, POPUP_SENDER);

// ---------- T1 连发 20 条保存：全表 get ≤1（旧代码 RED=20 次） ----------
{
  resetReads();
  const flags = [];
  for (let i = 1; i <= 20; i++) flags.push((await send({ action: 'saveDrama', drama: mk(i) }))?.saved);
  check('T1a 20 条保存 dramas 全表 get ≤1', dramasReads() <= 1, `reads=${dramasReads()}`);
  check('T1b 20 条全部落库', (bg.dramas() || []).length === 20, `len=${bg.dramas()?.length}`);
  check('T1c saved 布尔逐条为 true', flags.every(f => f === true), JSON.stringify(flags));
  const dup = await send({ action: 'saveDrama', drama: mk(1) });
  check('T1d 重复 itemId 仍被拒（缓存判重）', dup?.saved === false && (bg.dramas() || []).length === 20, JSON.stringify(dup));
}

// ---------- T2 保存后翻译更新：零额外全表 get + copy-on-write ----------
{
  const snapshotBefore = await getDramasSnapshot(); // 持有缓存旧引用
  const cardBefore = snapshotBefore.find(d => d.id === 'id-5');
  resetReads();
  // applyTranslation 入口已删除（2026-09-25 审查），直接走单卡路径共用的队列内写入
  const updated = await updateSingleDramaTranslation('id-5', { title: '五', desc: '五简介' });
  check('T2a 翻译更新零全表 get', dramasReads() === 0, `reads=${dramasReads()}`);
  check('T2b 翻译结果落库', updated?.done === true && (bg.dramas() || []).find(d => d.id === 'id-5')?.titleZh === '五', JSON.stringify(updated));
  check('T2c copy-on-write：旧快照引用未被就地突变', cardBefore.titleZh === undefined && snapshotBefore.find(d => d.id === 'id-5').titleZh === undefined, JSON.stringify(cardBefore));
  const snapshotAfter = await getDramasSnapshot();
  check('T2d 新快照可见新值且引用已更换', snapshotAfter !== snapshotBefore && snapshotAfter.find(d => d.id === 'id-5')?.titleZh === '五', '');
}

// ---------- T3 set 失败：缓存失效重读，不丢不叠 ----------
{
  bg.storage.failNextSet(); // 下一次 set（这条保存的写回）抛错、不落盘
  const failResp = await send({ action: 'saveDrama', drama: mk(21) });
  check('T3a 注入失败经消息层报错', failResp?.success === false, JSON.stringify(failResp));
  resetReads();
  const retry = await send({ action: 'saveDrama', drama: mk(21) });
  check('T3b 失败后缓存失效重读（恰 1 次 get）', dramasReads() === 1, `reads=${dramasReads()}`);
  check('T3c 重试成功且不丢不叠', retry?.saved === true && (bg.dramas() || []).length === 21
    && (bg.dramas() || []).filter(d => d.itemId === 'tt0021').length === 1, `len=${bg.dramas()?.length}`);
}

// ---------- T4 队列外快照读者（CSV 同步）零全表 get ----------
{
  resetReads();
  csvPosts = [];
  await syncTimelineToCsv();
  check('T4a CSV 同步走快照零全表 get', dramasReads() === 0, `reads=${dramasReads()}`);
  check('T4b 推送内容完整（21 条）', csvPosts.length === 1 && csvPosts[0].dramas.length === 21, `posts=${csvPosts.length} len=${csvPosts[0]?.dramas?.length}`);
}

// ---------- T5 CSV 同步失败的报错文案（审查 body-limit-ceiling / readbody-cap-vs-growth 的扩展一半） ----------
// 修复前所有失败都打「请确认本地同步服务已启动: HTTP 413」：服务端回了 413 超限、/health 一切正常时
// 这句话只会误导。现在连不上才提示确认服务已启动，服务端回了错误就打印它给的原因
{
  const warns = [];
  // 后台的 console 是 fixture 上下文里的静默桩：只换它的 warn 来收报错文案
  bg.context.console.warn = (...a) => { if (String(a[0]).includes('CSV 同步失败')) warns.push(a.map(String).join(' ')); };
  const runSync = async (reply) => {
    syncReply = reply;
    warns.length = 0;
    await send({ action: 'warmupCsvSync' }); // 清内容签名强制推送，走生产的防抖 + catch 打日志路径
    await sleep(700);
    syncReply = null;
    return warns.join('\n');
  };
  const w413 = await runSync(async () => ({ ok: false, status: 413,
    json: async () => ({ ok: false, code: 'BODY_TOO_LARGE', error: '请求体超过 64MB 上限，本次未写入任何文件' }) }));
  check('T5a 413：带状态码与服务端原因，不再叫人确认服务已启动',
    w413.includes('413') && w413.includes('请求体超过 64MB 上限') && !w413.includes('请确认'), w413);
  const w500 = await runSync(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: '写入 timeline.csv 失败' }) }));
  check('T5b 其他非 2xx 同样带上服务端 error', w500.includes('HTTP 500') && w500.includes('写入 timeline.csv 失败') && !w500.includes('请确认'), w500);
  const wNet = await runSync(async () => { throw new TypeError('Failed to fetch'); });
  check('T5c 连不上（推送体不大）才提示确认服务已启动', wNet.includes('请确认服务已启动') && wNet.includes('Failed to fetch') && !wNet.includes('20MB'), wNet);
  // 推送体超过旧版服务 20MB 上限时连接被断开，浏览器同样只给 TypeError：直接测报错构造，免得在库里堆 20MB
  let big;
  try { big = csvSyncNetworkError(new TypeError('Failed to fetch'), 'x'.repeat(21 * 1024 * 1024)).message; }
  catch (e) { big = `抛错：${e.message}`; }
  check('T5d 推送体超旧版 20MB 上限又连不上：点明多半是超限被断开', big.includes('超限被断开') && big.includes('21.0MB'), big);
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
