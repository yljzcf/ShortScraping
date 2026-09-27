import './bootstrap.cjs';
// 弹窗单站刷新并入全量轮回归测试（审查 manual-refresh-queued-behind-full-scrape，方案 A / 契约 C2）。
// 修复前：定时全量抓取进行中点单站刷新，triggerScrape 一律排到整轮后面，弹窗转圈到全量轮结束
// 再加本站重抓一遍，而这些 URL 几分钟前刚抓过。修复：全量轮在跑或排队、且还没开抓该站的任何
// URL 时，triggerScrape 立即回 { success:true, merged:true }、不再入队；已开抓该站 / 本轮清单
// 里没有该站 / 没有全量轮时照旧排队并等本次抓取结束（响应形状不变）。
// 每个页面的 'scrape' 回复由测试手动放行，以此卡住全量轮停在指定 URL 上。
// 用法：node tests/unit-scrape-merge.mjs
import { background, PAGE_SENDER } from './background-fixture.mjs';

const realSetTimeout = setTimeout;
const sleep = ms => new Promise(r => realSetTimeout(r, ms));
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
// 读后台内部状态：旧代码没有该变量时记为失败而不是整套崩掉
const peek = (bg, expr) => { try { return bg.run(expr); } catch (e) { return `抛错：${e.message}`; } };

const IMDB_A = 'https://www.imdb.com/search/title/?genres=a';
const IMDB_B = 'https://www.imdb.com/search/title/?genres=b';
const STEAM = 'https://store.steampowered.com/category/merge';
const tag = url => ({ urlPattern: url, tags: ['T'] });

async function setup(urls) {
  const bg = await background();
  bg.data.urlTags = urls.map(tag);
  // 本套件拿 IMDb 搜索页地址当占位、按打开的地址认页面：关掉 v1.7.0 的 IMDb 日期窗口（0＝不限），
  // 免得打开的地址末尾多出 release_date、对不上闸门
  bg.data.scheduleConfig = { ...bg.data.scheduleConfig, imdbWindowDays: 0 };
  bg.context.setTimeout = (fn, ms, ...args) => (ms === 1500 ? realSetTimeout(fn, 0, ...args) : {});
  const tabs = new Map();
  const opened = [];                 // 按开页顺序记 URL
  const gates = new Map();           // URL → 放行该页 'scrape' 回复
  let nextTabId = 100;
  bg.context.chrome.tabs = {
    async create({ url }) { const id = nextTabId++; tabs.set(id, url); opened.push(url); return { id }; },
    async remove(id) { tabs.delete(id); },
    async sendMessage(tabId) {
      const url = tabs.get(tabId);
      return new Promise(resolve => gates.set(url, () => { gates.delete(url); resolve({ success: true, newCount: 0, subscribed: true, listCount: 3 }); }));
    },
    onUpdated: {
      addListener(fn) { setImmediate(() => { for (const id of tabs.keys()) fn(id, { status: 'complete' }); }); },
      removeListener() {}
    }
  };
  bg.context.chrome.scripting = { async executeScript() { return []; } };

  const waitOpen = async (url, count = 1) => {
    for (let i = 0; i < 500 && opened.filter(u => u === url).length < count; i++) await sleep(1);
    for (let i = 0; i < 500 && !gates.has(url); i++) await sleep(1);
    return gates.has(url);
  };
  const release = async (url) => { await waitOpen(url); gates.get(url)?.(); await sleep(5); };
  // 经消息层发 triggerScrape：记下监听器是否保留异步通道、响应是否已到
  const trigger = (site) => {
    const out = { keepOpen: null, resp: undefined, responded: false };
    out.done = new Promise(resolve => {
      out.keepOpen = bg.listeners.message({ action: 'triggerScrape', site }, PAGE_SENDER, (resp) => {
        out.resp = resp; out.responded = true; resolve(resp);
      });
    });
    return out;
  };
  return { bg, opened, gates, waitOpen, release, trigger };
}

// ---------- M1 全量轮停在 imdb 上，刷新还没开抓的 steam → 立即并入 ----------
{
  const { bg, opened, waitOpen, release, trigger } = await setup([IMDB_A, STEAM]);
  bg.context.full = bg.run('performScrape()');
  await waitOpen(IMDB_A);
  const t = trigger('steam');
  check('M1a 立即回 { success:true, merged:true }（同步应答、不保留异步通道）',
    t.responded && t.keepOpen === false && t.resp?.success === true && t.resp?.merged === true, JSON.stringify(t));
  check('M1b 并入时不再排一次单站抓取', bg.run('activeScrapeCount') === 1, `active=${bg.run('activeScrapeCount')}`);
  await release(IMDB_A);
  await release(STEAM);
  const summary = await Promise.race([bg.run('full'), sleep(2000).then(() => null)]);
  check('M1c 全量轮照常抓到 steam（本轮内更新）', summary?.results?.some(r => r.url === STEAM && r.success), JSON.stringify(summary));
  await sleep(20);
  check('M1d steam 全程只开一次标签页（不重抓）', opened.filter(u => u === STEAM).length === 1, JSON.stringify(opened));
  check('M1e 全量轮收尾后进度与排队标记清空', peek(bg, 'fullScrapeProgress === null && pendingFullScrape === null') === true, '');
}

// ---------- M2 全量轮已开抓该站（哪怕只到该站第一个 URL）→ 照旧排队，等单站抓完才回 ----------
{
  const { bg, opened, waitOpen, release, trigger } = await setup([IMDB_A, IMDB_B, STEAM]);
  bg.context.full = bg.run('performScrape()');
  await waitOpen(IMDB_A);
  const t = trigger('imdb');
  check('M2a 已开抓的站不并入：保留异步通道、暂不应答', t.keepOpen === true && !t.responded, JSON.stringify(t));
  check('M2b 排了一次单站抓取', bg.run('activeScrapeCount') === 2, `active=${bg.run('activeScrapeCount')}`);
  await release(IMDB_A); await release(IMDB_B); await release(STEAM);
  await waitOpen(IMDB_A, 2); await release(IMDB_A);
  await waitOpen(IMDB_B, 2); await release(IMDB_B);
  const resp = await Promise.race([t.done, sleep(2000).then(() => null)]);
  check('M2c 响应为原形状 { success:true, summary }（无 merged）', resp?.success === true && resp?.merged === undefined
    && resp?.summary?.urlCount === 2, JSON.stringify(resp));
  check('M2d 单站抓取排在全量轮之后', opened.join(',') === [IMDB_A, IMDB_B, STEAM, IMDB_A, IMDB_B].join(','), JSON.stringify(opened));
}

// ---------- M3 全量轮排在一次单站抓取后面（尚未开跑）→ 并入排队中的那轮 ----------
{
  const { bg, waitOpen, release, trigger } = await setup([IMDB_A, STEAM]);
  bg.context.single = bg.run("performScrape({ site: 'steam' })");
  await waitOpen(STEAM);
  bg.context.full = bg.run('performScrape()');
  const t = trigger('imdb');
  check('M3a 排队中的全量轮开跑时才读订阅，必然涵盖该站 → merged', t.responded && t.resp?.merged === true, JSON.stringify(t));
  check('M3b 计数只有单站 + 全量两次', bg.run('activeScrapeCount') === 2, `active=${bg.run('activeScrapeCount')}`);
  await release(STEAM); await release(IMDB_A);
  await waitOpen(STEAM, 2); await release(STEAM);
  await Promise.race([bg.run('full'), sleep(2000)]);
}

// ---------- M4 全量轮已读出订阅前（pendingSites 仍为 null）→ 视同全部站点都在前头 ----------
{
  const { bg, waitOpen, release, trigger } = await setup([IMDB_A, STEAM]);
  const realGet = bg.context.chrome.storage.local.get;
  let unblock = null;
  bg.context.chrome.storage.local.get = async (keys) => {
    // 开轮读订阅（v1.7.0 起与 scheduleConfig 同一次读：['urlTags', 'scheduleConfig']）
    const readsUrlTags = keys === 'urlTags' || (Array.isArray(keys) && keys.includes('urlTags'));
    if (readsUrlTags && !unblock) await new Promise(r => { unblock = r; });
    return realGet(keys);
  };
  bg.context.full = bg.run('performScrape()');
  for (let i = 0; i < 200 && !unblock; i++) await sleep(1);
  const t = trigger('steam');
  check('M4a 全量轮开跑但还没读订阅时并入', Boolean(unblock) && peek(bg, 'fullScrapeProgress?.pendingSites') === null
    && t.resp?.merged === true, JSON.stringify(t));
  unblock();
  await release(IMDB_A); await release(STEAM);
  await Promise.race([bg.run('full'), sleep(2000)]);
}

// ---------- M5 本轮清单里没有该站 / 没有全量轮 → 照旧排队 ----------
{
  const { bg, waitOpen, release, trigger } = await setup([IMDB_A]);
  bg.context.full = bg.run('performScrape()');
  await waitOpen(IMDB_A);
  const t = trigger('steam');
  check('M5a 正在跑的全量轮清单里没有该站 → 不并入', t.keepOpen === true && !t.responded, JSON.stringify(t));
  await release(IMDB_A);
  const resp = await Promise.race([t.done, sleep(2000).then(() => null)]);
  check('M5b 照旧等单站抓取结束（无该站订阅＝0 个 URL）', resp?.success === true && resp?.merged === undefined
    && resp?.summary?.urlCount === 0, JSON.stringify(resp));

  const idle = trigger('imdb');
  check('M5c 没有全量轮时不并入', idle.keepOpen === true && !idle.responded, JSON.stringify(idle));
  await release(IMDB_A);
  const idleResp = await Promise.race([idle.done, sleep(2000).then(() => null)]);
  check('M5d 照旧回单站抓取汇总', idleResp?.success === true && idleResp?.summary?.urlCount === 1, JSON.stringify(idleResp));
}

// ---------- M6 全量轮已抓过该站、正在抓后面的站 → 不并入 ----------
{
  const { bg, waitOpen, release, trigger } = await setup([IMDB_A, STEAM]);
  bg.context.full = bg.run('performScrape()');
  await release(IMDB_A);
  await waitOpen(STEAM);
  const t = trigger('imdb');
  check('M6 已抓过的站不并入（照旧排队重抓）', t.keepOpen === true && !t.responded && bg.run('activeScrapeCount') === 2, JSON.stringify(t));
  await release(STEAM);
  await release(IMDB_A);
  await Promise.race([t.done, sleep(2000)]);
}

// ---------- M7 storage 里旧版本留下的「仅尾斜杠之差」两条订阅：本轮只抓一次（审查 urltags-dedupe-raw 第 3 步） ----------
// 新写入的 urlTags 经 SubscriptionConfig.normalizeUrlTags 已按归一去重；这里直接往 storage 塞两种写法，
// 模拟升级前的存量。按原串去重时同一页开两个标签页抓两遍
{
  const { bg, opened, release } = await setup([STEAM, `${STEAM}/`, IMDB_A]);
  bg.context.full = bg.run('performScrape()');
  await release(STEAM);
  await release(IMDB_A);
  const summary = await Promise.race([bg.run('full'), sleep(2000).then(() => null)]);
  await sleep(20);
  check('M7a 仅尾斜杠之差的两条订阅只开一个标签页，保留先出现的原串写法',
    opened.join(',') === [STEAM, IMDB_A].join(','), JSON.stringify(opened));
  check('M7b 本轮 URL 数按去重后计', summary?.urlCount === 2, JSON.stringify(summary));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
