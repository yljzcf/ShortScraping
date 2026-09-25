import './bootstrap.cjs';
// content.js 'scrape' 消息 in-flight 护栏回归测试（确定性时序，非碰运气）。
// 复现 2026-07-09 mydrama e2e 报告少计：后台兜底路径（waitForTabComplete 超时 →
// 强制注入 → sendScrapeWhenReady 轮询补发）让同一标签页先后收到两条 'scrape'，
// 并行双跑经保存点去重互相分走对方的新增卡（入库无重复，但每个 response 都只有
// 部分结果，performScrape 报告计数失真：报 83 存 87）。
// T5：页面上的抓取按钮也走同一个 in-flight 护栏（审查 button-bypasses-inflight-guard）——
// 按钮以前直接调 scrapePage，抓取进行中点一下同样两轮并跑。
// 抓取上下文经 getScrapeContext 消息向后台要（content.js 不再读 storage），「跑了几轮」按它计数。
// 用法：node tests/unit-scrape-inflight.mjs
//   修复前（每条消息各起一个 scrapePage）：T1/T2 应 FAIL（RED）；按钮直调 scrapePage 时 T5 应 FAIL
//   修复后（重复消息与按钮都复用进行中的 Promise）：全部 PASS（GREEN）
import fs from 'node:fs';
import { scrapeContextReply } from './content-fixture.mjs';

// ---------- 测试数据：dramashorts /top-movies（纯 __NEXT_DATA__ 路径，无网络依赖） ----------
const LIST_URL = 'https://dramashorts.io/top-movies';
const MOVIES = [1, 2, 3, 4].map(n => ({
  id: `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`,
  title: `Movie ${n}`,
  description: `desc ${n}`,
  images: { cover: `https://cdn.test/c${n}.jpg`, coverWithTitle: `https://cdn.test/t${n}.jpg` }
}));
const NEXT_DATA = { props: { pageProps: { movies: MOVIES } } };
const ALL_IDS = MOVIES.map(m => `ds${m.id}`).sort();

// ---------- chrome / window / document 桩 ----------
const rawStore = { dramas: [] };
const listeners = [];
let contextCalls = 0;
let saveDramaCalls = 0;
// 故障注入：'throw' 模拟消息通道断开（sendMessage reject），'refuse' 模拟后台回 success:false
let failNextContext = null;

globalThis.chrome = {
  runtime: {
    onMessage: { addListener(fn) { listeners.push(fn); } },
    // 模拟后台单写者队列的 saveDrama 权威去重：同 itemId 首次 true、重复 false
    async sendMessage(message) {
      await Promise.resolve();
      if (message?.action === 'getScrapeContext') {
        contextCalls++;
        const mode = failNextContext;
        failNextContext = null;
        if (mode === 'throw') throw new Error('上下文故障注入');
        if (mode === 'refuse') return { success: false, error: '后台拒绝故障注入' };
        return scrapeContextReply(rawStore.dramas, [{ urlPattern: LIST_URL, tags: ['DS'] }]);
      }
      if (message?.action === 'saveDrama') {
        saveDramaCalls++;
        const dup = rawStore.dramas.some(d => d.itemId === message.drama.itemId);
        if (!dup) rawStore.dramas.push(structuredClone(message.drama));
        return { success: true, saved: !dup };
      }
      return { success: true };
    }
  }
};

globalThis.window = {
  location: {
    href: LIST_URL,
    hostname: 'dramashorts.io',
    pathname: '/top-movies',
    search: '',
    origin: 'https://dramashorts.io'
  }
};

// 按钮桩记下 click 监听，T5 直接调用它模拟用户点击
let scrapeButton = null;
const fakeElement = () => {
  const handlers = {};
  return {
    style: {},
    disabled: false,
    innerHTML: '',
    textContent: '',
    id: '',
    handlers,
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    querySelector() { return null; }
  };
};
globalThis.document = {
  getElementById() { return null; },
  createElement() { return fakeElement(); },
  querySelector(sel) {
    return sel === 'script#__NEXT_DATA__' ? { textContent: JSON.stringify(NEXT_DATA) } : null;
  },
  querySelectorAll() { return []; },
  body: { appendChild(node) { if (node.id === 'dramamo-scrape-btn') scrapeButton = node; } }
};

// 压掉内容脚本自身的日志噪音，只留测试输出
const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

// ---------- 加载真实生产代码（IIFE，onMessage 监听器注册进桩） ----------
// site-registry 是 content.js 的前置依赖（manifest 注入序同款），先行加载
(0, eval)(fs.readFileSync(new URL('../src/shared/site-registry.js', import.meta.url), 'utf8'));
const contentSrc = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
(0, eval)(contentSrc);
if (listeners.length !== 1) { origLog(`FAIL  期望注册 1 个 onMessage 监听器，实际 ${listeners.length}`); process.exit(1); }

// 模拟 chrome.tabs.sendMessage：每条消息独立的 sendResponse 通道
function sendScrape() {
  return new Promise(resolve => {
    for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ---------- T1/T2 核心竞态：第二条 'scrape' 在首轮抓取进行中到达 ----------
// （对应生产：sendScrapeWhenReady 每 3s 补发，抓取一跑数十秒必然重叠）
{
  const p1 = sendScrape();
  await sleep(250);          // 首轮已保存前 2 项、正在处理第 3 项
  const p2 = sendScrape();
  const [r1, r2] = await Promise.all([p1, p2]);

  const ids = resp => (resp?.data || []).map(d => d.itemId).sort();
  check('T1a 两条消息都成功响应', r1?.success === true && r2?.success === true,
    JSON.stringify({ r1: r1?.success, r2: r2?.success }));
  check('T1b 两条消息都拿到完整结果', ids(r1).length === 4 && ids(r2).length === 4,
    `r1=${ids(r1).length} r2=${ids(r2).length}（应各 4）`);
  check('T1c 两份结果一致且覆盖全部条目',
    JSON.stringify(ids(r1)) === JSON.stringify(ALL_IDS) && JSON.stringify(ids(r2)) === JSON.stringify(ALL_IDS),
    `r1=[${ids(r1).join(',')}] r2=[${ids(r2).join(',')}]`);
  check('T1d 入库恰好 4 条（后台去重兜底不变）', rawStore.dramas.length === 4, `len=${rawStore.dramas.length}`);
  check('T2a 抓取只执行一轮（只取一次抓取上下文）', contextCalls === 1, `contextCalls=${contextCalls}（应 1）`);
  check('T2b 每条目只保存一次', saveDramaCalls === 4, `saveDramaCalls=${saveDramaCalls}（应 4）`);
}

// ---------- T3 护栏须随抓取结束复位：完成后的新消息开启新一轮，不粘死 ----------
{
  const before = contextCalls;
  const r3 = await sendScrape();
  check('T3a 完成后再触发开启新一轮抓取', contextCalls === before + 1,
    `contextCalls=${contextCalls}（应 ${before + 1}）`);
  check('T3b 新一轮成功且 0 新增（全部已存在）', r3?.success === true && (r3?.data || []).length === 0,
    JSON.stringify({ success: r3?.success, len: (r3?.data || []).length }));
}

// ---------- T4 抓取出错后护栏须复位：失败不粘死后续抓取 ----------
{
  failNextContext = 'throw';
  const rErr = await sendScrape();
  const rRetry = await sendScrape();
  check('T4a 出错时响应失败信息', rErr?.success === false && /故障注入/.test(rErr?.error || ''),
    JSON.stringify(rErr));
  check('T4b 出错后重试恢复正常', rRetry?.success === true, JSON.stringify({ success: rRetry?.success }));
  // 后台应答 success:false（如写队列读表失败）同样按本轮失败报出，不当成「无订阅 / 库为空」接着抓
  failNextContext = 'refuse';
  const saveBefore = saveDramaCalls;
  const rRefused = await sendScrape();
  check('T4c 后台回 success:false → 本轮失败、带后台错误、零 saveDrama',
    rRefused?.success === false && /后台拒绝故障注入/.test(rRefused?.error || '') && saveDramaCalls === saveBefore,
    JSON.stringify({ rRefused, saves: saveDramaCalls - saveBefore }));
}

// ---------- T5 按钮与 'scrape' 消息并发：同一轮、同一份结果 ----------
// 清空桩库重来：两边都应看到完整的 4 条新增。按钮直调 scrapePage 时是两轮并跑，
// 上下文取两次、新增卡被两轮互相分走
{
  rawStore.dramas = [];
  const contextBefore = contextCalls;
  const saveBefore = saveDramaCalls;
  const click = scrapeButton?.handlers?.click?.[0];
  check('T5a 按钮已挂载且注册了 click（夹具自检）', typeof click === 'function', String(typeof click));
  if (typeof click === 'function') {
    const pScrape = sendScrape();
    await sleep(250);          // 消息那一轮已保存前 2 项
    const clicking = click();
    const [r] = await Promise.all([pScrape, clicking]);
    check('T5b 按钮复用进行中的那一轮：抓取上下文只取一次', contextCalls === contextBefore + 1,
      `contextCalls 增加 ${contextCalls - contextBefore}（应 1）`);
    check('T5c 两边拿到同一份结果：消息回 4 条、按钮显示新增 4 部',
      (r?.data || []).length === 4 && scrapeButton.textContent === '✅ 新增 4 部',
      JSON.stringify({ data: (r?.data || []).length, button: scrapeButton.textContent }));
    check('T5d 每条目只保存一次', saveDramaCalls - saveBefore === 4, `saveDramaCalls 增加 ${saveDramaCalls - saveBefore}（应 4）`);
  }
}

// ---------- T6 按钮在不在订阅里的页面上：明说「当前页不在订阅中」，不显示「新增 0 部」 ----------
{
  globalThis.window.location.href = 'https://dramashorts.io/top-movies?list=other';
  const click = scrapeButton?.handlers?.click?.[0];
  if (typeof click === 'function') {
    await click();
    check('T6 当前页不在订阅中 → 按钮提示「⚠️ 当前页不在订阅中」',
      scrapeButton.textContent === '⚠️ 当前页不在订阅中', JSON.stringify(scrapeButton.textContent));
  } else {
    check('T6 当前页不在订阅中 → 按钮提示「⚠️ 当前页不在订阅中」', false, '按钮未挂载');
  }
  globalThis.window.location.href = LIST_URL;
}

// ---------- T7 源码守卫：content.js 不再碰 chrome.storage（抓取上下文只经消息向后台要） ----------
check('T7 content.js 里不出现 chrome.storage', !contentSrc.includes('chrome.storage'), '');

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
