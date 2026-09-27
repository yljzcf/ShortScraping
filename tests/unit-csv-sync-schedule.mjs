import './bootstrap.cjs';
// CSV 推送调度回归测试（v1.6.21：审查 sync-no-ordering + 整表推送止血）。
//   Q1 单飞：推送在飞时到点的定时器只记补跑，第二个 POST 等第一个落定才发，且带最新内容；
//   Q2 fetch 带 AbortSignal.timeout(60000)；
//   Q3 超时（TimeoutError）有专门文案、不记签名，下次同内容照常重推；
//   Q4 忙碌期（抓取 / 翻译轮进行中）前沿节流：空闲后第一次变化 500ms 推出，之后两次推送开跑至少隔 8 秒；
//      抓取收尾 / 翻译轮结束时把攒着的那次提前到 500ms 后推出；空闲时保持 500ms 尾随防抖；系统时钟回拨时
//      忙碌期等待仍不超过一个窗口（Q4e）；
//   Q5 冷缓存下翻译扫描 + CSV 同步合计只整表读一次（经写队列读并回填缓存）；
//   Q6 有待补跑的推送时不摘 allowEmptySync；
//   Q7 写入耗时埋点：抓取轮收尾打一行汇总日志（次数 / 平均 / 最长）。
// 全部走 background-fixture 的 manual 计时器（可控时钟），同步服务是 fetch 桩，不连任何真实端口。
// 用法：node tests/unit-csv-sync-schedule.mjs
import { background, card, PAGE_SENDER } from './background-fixture.mjs';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

const SYNC_URL = 'http://127.0.0.1:31919/sync';
// 已翻译完的卡：带中文译名，启动期「非中文译名退回 new」的迁移不会动它，翻译扫描也不会把它当待翻译
const done = (itemId, extra = {}) => card(itemId, { status: 'trans', titleZh: '中文片名', ...extra });
const OK_REPLY = () => ({ ok: true, status: 200, async json() { return { ok: true, count: 1, csvPath: 'stub.csv' }; } });

/**
 * 夹具：manual 计时器 + onChanged 自动派发（dramas 一变就走生产的 scheduleCsvSync）。
 * posts：每次 POST /sync 记 { at（虚拟时钟）, body（解析后）, options, overlapped, settle(reply|Error) }。
 * mode 'auto' 立即回 200；'manual' 挂起到测试调 settle。启动时顶层预热推送排空后清零。
 */
async function makeBg({ dramas = [done('tt0001')], data = {}, translator = null } = {}) {
  const posts = [];
  const sync = { mode: 'auto' };
  const bg = await background({
    timers: 'manual',
    storage: { dispatchChanges: true },
    dramas,
    data,
    translator: translator || { async translateTitleAndDesc() { return { title: '', desc: '' }; }, async translateBatchAI() { return []; } },
    fetch: (url, options) => {
      if (String(url) !== SYNC_URL) return undefined; // config/*.json 走 fixture 默认桩
      // overlapped：发出时还有更早的 POST 没落定（并行在飞）
      const entry = { at: bg.run('Date.now()'), body: JSON.parse(options.body), options, settled: false, overlapped: posts.some(p => !p.settled) };
      posts.push(entry);
      if (sync.mode === 'auto') { entry.settled = true; return Promise.resolve(OK_REPLY()); }
      return new Promise((resolve, reject) => {
        entry.settle = reply => { entry.settled = true; reply instanceof Error ? reject(reply) : resolve(reply || OK_REPLY()); };
      });
    }
  });
  const warnings = [];
  const logs = [];
  bg.context.console.warn = (...args) => warnings.push(args.map(String).join(' '));
  bg.context.console.log = (...args) => logs.push(args.map(String).join(' '));
  await bg.timers.runAll();         // 顶层预热推送（500ms 防抖）等启动期定时器排空
  await bg.timers.advance(60000);   // 远离启动那次推送，后续节流按「空闲后」起算
  posts.length = 0;
  const save = drama => bg.send({ action: 'saveDrama', drama }, PAGE_SENDER);
  const csvTimer = () => {
    const id = bg.run('csvSyncTimer');
    return id ? bg.timers.pending().find(t => t.id === id) || null : null;
  };
  const ids = entry => (entry?.body?.dramas || []).map(d => d.itemId).sort().join(',');
  return { bg, posts, sync, warnings, logs, save, csvTimer, ids, now: () => bg.run('Date.now()') };
}

// ---------- Q1 单飞 + Q2 signal ----------
{
  const h = await makeBg();
  const realAbortSignal = AbortSignal;
  const timeouts = [];
  h.bg.context.AbortSignal = { timeout(ms) { timeouts.push(ms); return realAbortSignal.timeout(ms); } };
  h.sync.mode = 'manual';

  await h.save(done('tt0002'));
  await h.bg.timers.advance(500);
  check('Q1a 前提：空闲时 dramas 变化 500ms 后发出第一个 POST（在飞未回）', h.posts.length === 1 && !h.posts[0].settled, `posts=${h.posts.length}`);

  await h.save(done('tt0003'));
  await h.bg.timers.advance(500);
  check('Q1b 在飞期间又到点：不发第二个 POST，只记补跑', h.posts.length === 1 && h.bg.run('csvSyncRerun') === true,
    `posts=${h.posts.length} rerun=${h.bg.run('csvSyncRerun')}`);

  h.posts[0].settle();
  await h.bg.flush();
  await h.bg.timers.advance(500);
  const second = h.posts[1];
  check('Q1c 第一个落定后补排：第二个 POST 在它落定之后才发（从不并行在飞）',
    h.posts.length === 2 && h.posts.every(p => !p.overlapped),
    JSON.stringify(h.posts.map(p => ({ at: p.at, overlapped: p.overlapped }))));
  check('Q1d 第二个 POST 带最新内容（含在飞期间新存的卡）', h.ids(second) === 'tt0001,tt0002,tt0003', h.ids(second));
  second?.settle();
  await h.bg.flush();
  check('Q1e 补跑落定后状态归位（不在飞、无补跑、无待发）',
    h.bg.run('csvSyncInFlight') === null && h.bg.run('csvSyncRerun') === false && !h.csvTimer(), '');

  check('Q2a fetch 带 AbortSignal', h.posts.every(p => p.options.signal instanceof realAbortSignal), '');
  check('Q2b 超时取 CSV_SYNC_TIMEOUT_MS=60000', timeouts.length === 2 && timeouts.every(ms => ms === 60000) && h.bg.run('CSV_SYNC_TIMEOUT_MS') === 60000,
    JSON.stringify(timeouts));
}

// ---------- Q3 超时 ----------
{
  const h = await makeBg();
  h.sync.mode = 'manual';
  await h.save(done('tt0002'));
  await h.bg.timers.advance(500);
  h.posts[0].settle(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  await h.bg.flush();
  const warn = h.warnings.filter(w => w.includes('CSV 同步失败')).join('\n');
  check('Q3a 超时有专门文案（点明 60 秒没应答、会重推），不叫人去启动服务',
    warn.includes('60 秒内没有应答') && warn.includes('重推') && !warn.includes('请确认服务已启动'), warn);
  // 签名仍是启动期那次推送的旧内容，不是这次超时没推成的
  check('Q3b 超时不记签名', h.bg.run('lastCsvSyncSerialized') !== JSON.stringify(h.posts[0].body.dramas),
    String(h.bg.run('lastCsvSyncSerialized')).slice(0, 80));
  h.sync.mode = 'auto';
  h.bg.run('scheduleCsvSync()');
  await h.bg.timers.advance(500);
  check('Q3c 下次触发同内容照常重推（未被签名跳过）', h.posts.length === 2 && h.ids(h.posts[1]) === h.ids(h.posts[0]),
    `posts=${h.posts.length}`);
  let direct;
  try { direct = h.bg.context.csvSyncNetworkError(new DOMException('x', 'TimeoutError'), '{}').message; } catch (e) { direct = `抛错：${e.message}`; }
  check('Q3d 报错构造：TimeoutError 专门分支，其他 TypeError 仍是「请确认服务已启动」',
    direct.includes('60 秒内没有应答')
      && h.bg.context.csvSyncNetworkError(new TypeError('Failed to fetch'), '{}').message.includes('请确认服务已启动'), direct);
}

// ---------- Q4a/b 抓取期间前沿节流 + 抓取收尾强推 ----------
{
  const h = await makeBg();
  // 抓取标签页挂住到测试放行（放行即 reject：该 URL 记失败、抓取收尾，activeScrapeCount 归零）
  let releaseTab = null;
  h.bg.context.chrome.tabs.create = () => new Promise((_, reject) => { releaseTab = reject; });
  const scraping = h.bg.run('performScrape({ site: "imdb" })');
  await h.bg.flush();
  check('Q4a0 前提：抓取进行中（activeScrapeCount=1，标签页挂住）', h.bg.run('activeScrapeCount') === 1 && typeof releaseTab === 'function', '');

  const start = h.now();
  await h.save(done('tt0002'));
  const leading = h.csvTimer();
  await h.bg.timers.advance(500);
  check('Q4a1 忙碌期空闲后的第一次变化：前沿 500ms 推出', leading?.dueIn === 500 && h.posts.length === 1 && h.posts[0].at === start + 500,
    JSON.stringify({ leading, posts: h.posts.map(p => p.at - start) }));

  await h.save(done('tt0003'));
  const throttled = h.csvTimer();
  await h.bg.timers.advance(1000);
  await h.save(done('tt0004'));
  const keptAfterMoreWrites = h.csvTimer();
  check('Q4a2 紧接着的变化：等满 8 秒（按上次开跑算），期间再写不重置定时器',
    throttled?.dueIn === 8000 && keptAfterMoreWrites?.id === throttled?.id && keptAfterMoreWrites?.dueIn === 7000,
    JSON.stringify({ throttled, keptAfterMoreWrites }));
  await h.bg.timers.advance(7000);
  check('Q4a3 第二次推送距第一次 ≥8 秒，且把期间的变化合成一次推送',
    h.posts.length === 2 && h.posts[1].at - h.posts[0].at >= 8000 && h.ids(h.posts[1]) === 'tt0001,tt0002,tt0003,tt0004',
    JSON.stringify(h.posts.map(p => ({ dt: p.at - start, ids: h.ids(p) }))));

  await h.save(done('tt0005'));
  const beforeEnd = h.csvTimer();
  releaseTab(new Error('unit stub: 标签页打不开'));
  await scraping;
  await h.bg.flush();
  const endAt = h.now();
  const afterEnd = h.csvTimer();
  check('Q4b1 抓取收尾前那次变化仍按节流排着（约 8 秒后）', beforeEnd?.dueIn >= 7000, JSON.stringify(beforeEnd));
  check('Q4b2 抓取收尾（activeScrapeCount 归零）：攒着的推送提前到 500ms 后', h.bg.run('activeScrapeCount') === 0 && afterEnd?.dueIn === 500,
    JSON.stringify(afterEnd));
  await h.bg.timers.advance(500);
  check('Q4b3 收尾后 500ms 内推出最新内容', h.posts.length === 3 && h.posts[2].at - endAt <= 500 && h.ids(h.posts[2]).includes('tt0005'),
    JSON.stringify(h.posts.map(p => ({ dt: p.at - endAt, ids: h.ids(p) }))));

  // Q7 写入耗时埋点：抓取轮收尾那行汇总（这一轮里存了 4 张卡）
  const summary = h.logs.find(l => l.includes('站点抓取（imdb） dramas 整表写入'));
  check('Q7a 抓取轮收尾打一行 dramas 写入汇总（次数 / 平均 / 最长）',
    Boolean(summary) && /写入 4 次，平均 [\d.]+ms，最长 [\d.]+ms/.test(summary), String(summary));
  // 只认统计 / 计时类键名（…Stats、…Timing）：larkBotState 这类正常的状态键不算（v1.7.0 起首轮 IMDb 会写机器人基线）
  check('Q7b 埋点只打日志、不写 storage', !Object.keys(h.bg.data).some(k => /stats?$|timing/i.test(k)), Object.keys(h.bg.data).join(','));
}

// ---------- Q4c 空闲时保持 500ms 尾随防抖 ----------
{
  const h = await makeBg();
  await h.save(done('tt0002'));
  await h.bg.timers.advance(400);
  await h.save(done('tt0003'));
  const rearmed = h.csvTimer();
  await h.bg.timers.advance(400);
  const beforeDue = h.posts.length;
  await h.bg.timers.advance(100);
  check('Q4c 空闲期：每次变化重置 500ms 防抖，连写合并成一次推送',
    rearmed?.dueIn === 500 && beforeDue === 0 && h.posts.length === 1 && h.ids(h.posts[0]) === 'tt0001,tt0002,tt0003',
    JSON.stringify({ rearmed, beforeDue, posts: h.posts.length }));
}

// ---------- Q4e 系统时钟回拨：忙碌期等待不超过一个节流窗口 ----------
{
  const h = await makeBg();
  let releaseTab = null;
  h.bg.context.chrome.tabs.create = () => new Promise((_, reject) => { releaseTab = reject; });
  const scraping = h.bg.run('performScrape({ site: "imdb" })');
  await h.bg.flush();
  // 上次推送开跑时刻落在「未来」一小时：等价于推送之后系统时钟被往回拨了一小时
  h.bg.run('csvSyncLastRunAt = Date.now() + 3600000');
  await h.save(done('tt0002'));
  const skewed = h.csvTimer();
  await h.bg.timers.advance(8000);
  check('Q4e 时钟回拨后忙碌期的推送最多等一个窗口（8 秒），不会等满回拨量',
    skewed?.dueIn <= 8000 && h.posts.length === 1 && h.ids(h.posts[0]) === 'tt0001,tt0002',
    JSON.stringify({ skewed, posts: h.posts.length }));
  releaseTab(new Error('unit stub: 标签页打不开'));
  await scraping;
  await h.bg.flush();
}

// ---------- Q4d 翻译轮期间节流 + 轮末强推 ----------
{
  let release = null;
  const translator = {
    translateTitleAndDesc: () => new Promise(resolve => { release = resolve; }),
    async translateBatchAI() { return []; }
  };
  const h = await makeBg({
    dramas: [card('tt0001', { status: 'new', title: 'Revenge Bride', description: 'desc' })],
    translator
  });
  const round = h.bg.run('performTranslate({ source: "manual" })');
  await h.bg.flush();
  check('Q4d0 前提：翻译轮进行中（请求挂住）', h.bg.run('translateRun !== null') && typeof release === 'function', '');
  await h.save(done('tt0002'));
  await h.bg.timers.advance(500);
  await h.save(done('tt0003'));
  const throttled = h.csvTimer();
  check('Q4d1 翻译轮也算忙碌：前沿推一次后，下一次按 8 秒节流排', h.posts.length === 1 && throttled?.dueIn === 8000,
    JSON.stringify({ posts: h.posts.length, throttled }));
  release({ title: '复仇新娘', desc: '简介' });
  await h.bg.flush();
  // 条间 pause：delayMs 取 trans.json（fixture 给 {}）归一后的默认 200ms。节流那次仍排在 8 秒后，不会被这 200ms 触发
  await h.bg.timers.advance(200);
  await round;
  await h.bg.flush();
  const afterRound = h.csvTimer();
  check('Q4d2 翻译轮结束：攒着的推送提前到 500ms 后', h.bg.run('translateRun') === null && afterRound?.dueIn === 500, JSON.stringify(afterRound));
  await h.bg.timers.advance(500);
  const last = h.posts.at(-1);
  check('Q4d3 轮末推送带上译文与期间新卡', h.posts.length === 2 && h.ids(last) === 'tt0001,tt0002,tt0003'
    && last.body.dramas.find(d => d.itemId === 'tt0001')?.titleZh === '复仇新娘', JSON.stringify(last?.body?.dramas?.map(d => [d.itemId, d.titleZh])));
}

// ---------- Q5 冷缓存：翻译扫描 + CSV 同步只整表读一次 ----------
{
  const h = await makeBg({ dramas: [done('tt0001'), done('tt0002')] });
  await h.bg.resetDramasCache();
  h.bg.storage.reads.length = 0;
  const summary = await h.bg.run('performTranslate()');
  const filled = h.bg.run('dramasCache !== null');
  h.bg.run('lastCsvSyncSerialized = null');
  await h.bg.run('syncTimelineToCsv()');
  check('Q5a 冷缓存下先翻译扫描再 CSV 同步：dramas 只整表读 1 次', h.bg.storage.readCount('dramas') === 1,
    `reads=${h.bg.storage.readCount('dramas')} ${JSON.stringify(h.bg.storage.reads)}`);
  check('Q5b 翻译扫描经写队列读表并回填了缓存', filled && summary?.pendingCount === 0, JSON.stringify(summary));
  check('Q5c CSV 同步照常推出完整内容', h.posts.length === 1 && h.ids(h.posts[0]) === 'tt0001,tt0002', `posts=${h.posts.length}`);
}

// ---------- Q6 有待补跑时不摘 allowEmptySync ----------
{
  const h = await makeBg({ data: { allowEmptySync: true } });
  h.bg.data.allowEmptySync = true; // 启动期那次推送已按规则摘掉，这里重新布置
  h.bg.run('lastCsvSyncSerialized = null');
  h.sync.mode = 'manual';
  await h.save(done('tt0002'));
  await h.bg.timers.advance(500);
  await h.save(done('tt0003'));
  await h.bg.timers.advance(500); // 在飞期间到点：记补跑
  h.posts[0].settle();
  await h.bg.flush();
  check('Q6a 在飞的推送成功但已有待补跑：标记保留，交给补跑那次判定', h.bg.data.allowEmptySync === true, String(h.bg.data.allowEmptySync));
  await h.bg.timers.advance(500);
  h.posts[1]?.settle();
  await h.bg.flush();
  check('Q6b 补跑那次（之后再无变化）成功：标记摘除', h.posts.length === 2 && !('allowEmptySync' in h.bg.data),
    JSON.stringify({ posts: h.posts.length, flag: h.bg.data.allowEmptySync }));

  // 与 config-guard S3c/S3d 同法：推送期间只置补跑标记（序号不变、没有待发定时器），单测 !csvSyncRerun 这一条
  h.bg.data.allowEmptySync = true;
  h.bg.run('lastCsvSyncSerialized = null');
  h.sync.mode = 'auto';
  const origFetch = h.bg.context.fetch;
  h.bg.context.fetch = (url, options) => { h.bg.run('csvSyncRerun = true'); return origFetch(url, options); };
  await h.bg.run('syncTimelineToCsv()');
  h.bg.context.fetch = origFetch;
  h.bg.run('csvSyncRerun = false');
  check('Q6c 推送期间只记了补跑（序号未变、无待发）：同样不摘标记', h.bg.data.allowEmptySync === true, String(h.bg.data.allowEmptySync));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
