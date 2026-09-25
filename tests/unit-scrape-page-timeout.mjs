import './bootstrap.cjs';
// 后台整页抓取期限回归测试（审查 no-fetch-timeout-hangs-scrape-queue 的后台一半）。
// 内容脚本里一个请求挂住（回了响应头、正文迟迟不发完）时，后台等 'scrape' 回复不设期限：
// sendMessage 永不 resolve，scrapeUrlInTab 的 finally 不执行、后台标签页关不掉，串行
// scrapeQueue 后面的定时 / 手动抓取全部堵死。修复：scrapeUrlInTab 外层 Promise.race 设
// 5 分钟整页期限，超时按失败抛出、finally 照常关标签页，performScrapeOnce 把该 URL 记为
// 失败继续下一个。另验：performScrape 收尾时翻译线已退出则再安排一次（批次 B3 钩子）。
// 计时：只把整页期限 / 渲染等待 / 加载超时这几个已知延时缩成毫秒级真定时器，其余延时
// （抓取后翻译线的 10 秒预约等）一律不触发，与 background-fixture 的默认桩同语义。
// 用法：node tests/unit-scrape-page-timeout.mjs
import { background } from './background-fixture.mjs';

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const sleep = ms => new Promise(r => realSetTimeout(r, ms));
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

const HANG_URL = 'https://www.imdb.com/search/title/?genres=hang';
const OK_URL = 'https://www.imdb.com/search/title/?genres=ok';

async function setup({ completes = true } = {}) {
  const bg = await background();
  const pageTimeoutMs = bg.run('SCRAPE_PAGE_TIMEOUT_MS');
  const translateDelayMs = bg.run('POST_SCRAPE_TRANSLATE_DELAY_MS');
  const scaled = new Map([[pageTimeoutMs, 60], [1500, 1], [30000, 5], [3000, 1]]);
  const timerCalls = [];
  bg.context.setTimeout = (fn, ms, ...args) => {
    timerCalls.push(ms);
    return scaled.has(ms) ? realSetTimeout(fn, scaled.get(ms), ...args) : {};
  };
  bg.context.clearTimeout = (t) => { if (t && typeof t.unref === 'function') realClearTimeout(t); };

  const tabs = new Map();      // tabId → url
  const removed = [];
  let nextTabId = 100;
  const pending = new Map();   // tabId → 挂死页面 sendMessage 的 reject（Chrome 在标签页关闭时拒掉未回复的消息）
  const counts = { send: 0, inject: 0 };
  bg.context.chrome.tabs = {
    async create({ url }) {
      const id = nextTabId++;
      tabs.set(id, url);
      return { id };
    },
    async remove(id) {
      removed.push(id); tabs.delete(id);
      pending.get(id)?.(new Error('The message port closed before a response was received.'));
      pending.delete(id);
    },
    async sendMessage(tabId) {
      counts.send++;
      const url = tabs.get(tabId);
      if (!url) throw new Error(`No tab with id: ${tabId}.`);
      if (url === HANG_URL) return new Promise((_, reject) => pending.set(tabId, reject));
      return { success: true, data: [] };
    },
    onUpdated: {
      addListener(fn) {
        // 快路径：页面加载完成事件（completes=false 时不发，逼走强制注入 + 轮询兜底）
        if (completes) setImmediate(() => { for (const id of tabs.keys()) fn(id, { status: 'complete' }); });
      },
      removeListener() {}
    }
  };
  bg.context.chrome.scripting = { async executeScript() { counts.inject++; return []; } };
  return { bg, pageTimeoutMs, translateDelayMs, timerCalls, tabs, removed, counts };
}

// ---------- T1 挂死页面：整页期限到点按失败抛出，标签页照常关闭 ----------
{
  const { bg, pageTimeoutMs, removed } = await setup();
  check('T1a 整页期限为 5 分钟', pageTimeoutMs === 5 * 60 * 1000, String(pageTimeoutMs));
  bg.context.targetUrl = HANG_URL;
  const outcome = await Promise.race([
    bg.run('scrapeUrlInTab(targetUrl)').then(() => 'resolved', e => `rejected:${e.message}`),
    sleep(2000).then(() => 'hung')
  ]);
  check('T1b 内容脚本迟迟不回复时按超时失败返回（不再无限等待）', /^rejected:.*超时/.test(outcome), outcome);
  check('T1c 超时后后台标签页被关闭', removed.length === 1 && removed[0] === 100, JSON.stringify(removed));
}

// ---------- T2 兜底路径（加载事件不来 → 强制注入 + 轮询）同样受整页期限约束 ----------
{
  const { bg, removed } = await setup({ completes: false });
  bg.context.targetUrl = HANG_URL;
  const outcome = await Promise.race([
    bg.run('scrapeUrlInTab(targetUrl)').then(() => 'resolved', e => `rejected:${e.message}`),
    sleep(2000).then(() => 'hung')
  ]);
  check('T2 兜底轮询路径挂死同样按超时失败、关闭标签页', /^rejected:.*超时/.test(outcome) && removed.length === 1, `${outcome} removed=${JSON.stringify(removed)}`);
}

// ---------- T3 一轮里挂死的 URL 记为失败，后面的 URL 照常抓 ----------
{
  const { bg, removed } = await setup();
  bg.data.urlTags = [{ urlPattern: HANG_URL, tags: ['IMDB'] }, { urlPattern: OK_URL, tags: ['IMDB'] }];
  const summary = await Promise.race([bg.run('performScrapeOnce()'), sleep(3000).then(() => null)]);
  const byUrl = Object.fromEntries((summary?.results || []).map(r => [r.url, r]));
  check('T3a 挂死的 URL 记为失败（带超时原因）', byUrl[HANG_URL]?.success === false && /超时/.test(byUrl[HANG_URL]?.error || ''), JSON.stringify(summary));
  check('T3b 同轮后面的 URL 照常抓取成功', byUrl[OK_URL]?.success === true, JSON.stringify(summary));
  check('T3c 两个标签页都已关闭', removed.length === 2, JSON.stringify(removed));
}

// ---------- T4 串行抓取队列不被堵死：排在挂死抓取之后的手动抓取能跑完 ----------
{
  const { bg, tabs } = await setup();
  bg.data.urlTags = [{ urlPattern: HANG_URL, tags: ['IMDB'] }];
  bg.context.firstRun = bg.run('performScrape()');
  // 等第一次抓取读完订阅、开出挂死页面的标签页，再换订阅排第二次
  for (let i = 0; i < 200 && ![...tabs.values()].includes(HANG_URL); i++) await sleep(1);
  bg.data.urlTags = [{ urlPattern: OK_URL, tags: ['IMDB'] }];
  const second = await Promise.race([bg.run('performScrape()'), sleep(3000).then(() => null)]);
  const first = await Promise.race([bg.run('firstRun'), sleep(1000).then(() => null)]);
  check('T4a 排在挂死抓取后面的抓取照常完成', second?.results?.[0]?.success === true, JSON.stringify(second));
  check('T4b 挂死的那次抓取以失败收尾（不是永远 pending）', first?.results?.[0]?.success === false, JSON.stringify(first));
  check('T4c 两次抓取都结束后 activeScrapeCount 归零', bg.run('activeScrapeCount') === 0, String(bg.run('activeScrapeCount')));
}

// ---------- T5 B3 钩子：最后一个抓取收尾时翻译线已退出 → 经 performScrape 的 finally 再安排一次 ----------
{
  const { bg, translateDelayMs, timerCalls } = await setup();
  bg.data.urlTags = [{ urlPattern: HANG_URL, tags: ['IMDB'] }];
  const run = bg.run('performScrape()');
  const scheduledAtStart = timerCalls.filter(ms => ms === translateDelayMs).length;
  // 模拟翻译线在抓取期间已跑完退出（maxRounds / 接口熔断）：预约与运行标记都已清空
  bg.run('postScrapeTranslateTimer = null; postScrapeTranslateRunning = false');
  await Promise.race([run, sleep(2000)]);
  const scheduledTotal = timerCalls.filter(ms => ms === translateDelayMs).length;
  check('T5a 抓取开始时预约抓取后翻译线', scheduledAtStart === 1, `scheduledAtStart=${scheduledAtStart}`);
  check('T5b 抓取收尾时翻译线已退出 → 再安排一次收尾扫描', scheduledTotal === 2 && Boolean(bg.run('postScrapeTranslateTimer')),
    `scheduledTotal=${scheduledTotal}`);

  // 翻译线还在等（预约未到点）时收尾不重复预约
  bg.data.urlTags = [{ urlPattern: OK_URL, tags: ['IMDB'] }];
  await Promise.race([bg.run('performScrape()'), sleep(2000)]);
  const afterSecond = timerCalls.filter(ms => ms === translateDelayMs).length;
  check('T5c 翻译线仍在等待时收尾不重复预约', afterSecond === 2, `scheduled=${afterSecond}`);
}

// ---------- T6 超时关页后，败下阵的抓取链不再对已关的标签页起「强制注入 + 轮询」 ----------
{
  const { bg, counts } = await setup();
  bg.context.targetUrl = HANG_URL;
  await Promise.race([bg.run('scrapeUrlInTab(targetUrl)').catch(() => {}), sleep(2000)]);
  await sleep(100);   // 留时间给残余链路（轮询间隔在本测里缩成 1ms）
  check('T6 超时关页后不再强制注入、不再轮询补发 scrape', counts.inject === 0 && counts.send === 1,
    `inject=${counts.inject} send=${counts.send}`);
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
