import './bootstrap.cjs';
// 人机验证插页（v1.7.5）：标签页打开的是 AWS WAF / Cloudflare 的验证页时，后台等它自动通过并重载后再要一次结果。
//
// 起因（2026-10-12 回访）：IMDb 对新会话先回 HTTP 202 的 AWS WAF 静默验证页，脚本几秒内拿到 token 后自动重载，
// token cookie 对整个域名生效。扩展以前「加载完 → 1.5 秒 → 要结果 → 关标签页」，内容脚本在验证页上回「0 条」，
// 一轮里排在最前面的一两页 IMDb 订阅十多天零产出，后面的页因为 token 已有而正常。
//
//   C1 验证页 → 重载 → 再要一次拿到真列表：结果以第二次为准，整轮只开一个标签页、照常关掉
//   C2 验证页、到期没重载 → 仍再要一次，还是验证页就按 blocked 记告警，detail 写「人机验证页未通过」
//   C3 正常页：只要一次结果，不挂等重载的监听、不多等
//   C4 重载抢在监听挂上之前（竞态）：到期后照样再要一次，拿到真列表
//   C5 等重载期间标签页已被整页期限关掉（page.closed）：不再要结果，按首次应答返回
// 计时：只把 1.5 秒渲染等待、20 秒验证等待缩成毫秒级真定时器，其余延时不触发（同 unit-scrape-page-timeout）。
// 用法：node tests/unit-scrape-challenge.mjs
import { background } from './background-fixture.mjs';

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const sleep = ms => new Promise(r => realSetTimeout(r, ms));
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);

const IMDB = 'https://www.imdb.com/search/title/?interests=in0000310';
const challengeReply = { success: true, newCount: 0, subscribed: true, listCount: 0, httpStatus: 202, pageUrl: IMDB, challenge: 'awswaf' };
const realReply = { success: true, newCount: 3, subscribed: true, listCount: 50, httpStatus: 200, pageUrl: IMDB };

// replies：按 sendMessage 次序给出的应答；reloadAfterFirst：第一次应答后是否模拟验证通过重载（'before-listener' 为抢在监听挂上之前）
async function setup({ replies, reloadAfterFirst = false } = {}) {
  const bg = await background();
  bg.data.scheduleConfig = { ...bg.data.scheduleConfig, imdbWindowDays: 0 };
  bg.data.urlTags = [{ urlPattern: IMDB, tags: ['IMDB'] }];
  const passTimeout = bg.run('CHALLENGE_PASS_TIMEOUT_MS');
  const scaled = new Map([[1500, 1], [30000, 5], [passTimeout, 40], [1000, 1]]);
  const timerCalls = [];
  bg.context.setTimeout = (fn, ms, ...args) => {
    timerCalls.push(ms);
    return scaled.has(ms) ? realSetTimeout(fn, scaled.get(ms), ...args) : {};
  };
  bg.context.clearTimeout = (t) => { if (t && typeof t.unref === 'function') realClearTimeout(t); };

  const tabs = new Map();
  const listeners = new Set();
  const removed = [];
  const sends = [];
  let nextTabId = 100;
  const emit = (status) => { for (const id of tabs.keys()) for (const fn of [...listeners]) fn(id, { status }); };
  bg.context.chrome.tabs = {
    async create({ url }) { const id = nextTabId++; tabs.set(id, url); return { id }; },
    async remove(id) { removed.push(id); tabs.delete(id); },
    async sendMessage(tabId, message) {
      if (!tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}.`);
      sends.push(message.action);
      const reply = replies[Math.min(sends.length - 1, replies.length - 1)];
      if (sends.length === 1 && reloadAfterFirst === 'before-listener') {
        // 应答还没交回后台、监听还没挂上，页面就重载完了：事件发给当时的监听者（此刻一个都没有）
        emit('loading'); emit('complete');
      } else if (sends.length === 1 && reloadAfterFirst) {
        setImmediate(() => { emit('loading'); setImmediate(() => emit('complete')); });
      }
      return structuredClone(reply);
    },
    onUpdated: {
      addListener(fn) {
        listeners.add(fn);
        // 首次加载：挂上监听就立刻完成
        if (listeners.size === 1 && sends.length === 0) setImmediate(() => { for (const id of tabs.keys()) fn(id, { status: 'complete' }); });
      },
      removeListener(fn) { listeners.delete(fn); }
    }
  };
  bg.context.chrome.scripting = { async executeScript() { return []; } };
  const round = () => bg.run('performScrapeOnce()');
  return { bg, passTimeout, timerCalls, tabs, removed, sends, listeners, round };
}

// ---------- C1 验证页 → 重载 → 真列表 ----------
{
  const h = await setup({ replies: [challengeReply, realReply], reloadAfterFirst: true });
  const r = await h.round();
  const imdb = r.results.find(x => x.url === IMDB);
  check('C1a 第二次应答为准：新增 3、无告警、不记 blocked', imdb?.success === true && imdb.newCount === 3 && !imdb.warning && r.totalNewCount === 3, show(r.results));
  check('C1b 同一个标签页要了两次结果，整轮只开一个标签页、最后照常关掉', h.sends.length === 2 && h.removed.length === 1 && h.tabs.size === 0, show({ sends: h.sends, removed: h.removed }));
  check('C1c 等重载的监听事后已摘掉', h.listeners.size === 0, String(h.listeners.size));
  check('C1d 本轮不记告警', h.bg.data.lastScrapeWarnings === null, show(h.bg.data.lastScrapeWarnings));
}

// ---------- C2 验证页、到期没重载 ----------
{
  const h = await setup({ replies: [challengeReply, challengeReply] });
  const r = await h.round();
  const imdb = r.results.find(x => x.url === IMDB);
  check('C2a 到期后仍再要一次；还是验证页 → warning=blocked、detail 说明人机验证未通过（含 HTTP 202）',
    h.sends.length === 2 && imdb?.warning === 'blocked' && imdb.detail === '人机验证页未通过（awswaf，HTTP 202）', show({ sends: h.sends, imdb }));
  check('C2b 告警落库：kind=blocked 带同一个 detail', h.bg.data.lastScrapeWarnings?.items?.[0]?.kind === 'blocked'
    && h.bg.data.lastScrapeWarnings.items[0].detail === '人机验证页未通过（awswaf，HTTP 202）', show(h.bg.data.lastScrapeWarnings));
  check('C2c 等过 20 秒验证期限（计时器按该时长挂过一次）', h.timerCalls.includes(h.passTimeout), show(h.timerCalls));
  check('C2d 标签页照常关掉、监听已摘', h.removed.length === 1 && h.listeners.size === 0, show({ removed: h.removed, listeners: h.listeners.size }));
}

// ---------- C3 正常页 ----------
{
  const h = await setup({ replies: [realReply] });
  const r = await h.round();
  check('C3 正常页只要一次结果，不挂验证等待（没有 20 秒计时器）', h.sends.length === 1 && r.totalNewCount === 3 && !h.timerCalls.includes(h.passTimeout),
    show({ sends: h.sends, timers: h.timerCalls }));
}

// ---------- C4 重载抢在监听之前 ----------
{
  const h = await setup({ replies: [challengeReply, realReply], reloadAfterFirst: 'before-listener' });
  const r = await h.round();
  const imdb = r.results.find(x => x.url === IMDB);
  check('C4 没等到重载事件也再要一次：拿到真列表、无告警', h.sends.length === 2 && imdb?.newCount === 3 && !imdb.warning, show({ sends: h.sends, imdb }));
}

// ---------- C5 等重载期间标签页已关 ----------
{
  const h = await setup({ replies: [challengeReply, realReply] });
  // 直接调 scrapeLoadedTab，模拟整页期限已把 page 标成 closed
  const tab = await h.bg.context.chrome.tabs.create({ url: IMDB });
  h.bg.context.__tab = tab.id;
  h.bg.context.__page = { closed: false };
  const run = h.bg.run('scrapeLoadedTab(__tab, "' + IMDB + '", __page)');
  await sleep(5);           // 首次应答已回、正在等重载
  h.bg.context.__page.closed = true;
  const out = await run;
  check('C5 等重载期间 page.closed：不再要结果，按首次（验证页）应答返回', h.sends.length === 1 && out?.challenge === 'awswaf', show({ sends: h.sends, out }));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
