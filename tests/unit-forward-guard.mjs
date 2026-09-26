import './bootstrap.cjs';
// 前向兼容护栏回归测试（v1.6.21，为日后按站点分片存储预留；本版本不分片）。
// 更新版本改用分片布局时写 dramasMeta = { layout: 2 }、旧键 dramas 冻结。回退到本版本时若照常在冻结
// 快照上跑，会重复翻译（花钱）、重复入库重复推群。护栏：读到 layout 高于本版本认识的布局就只读。
//   G1 layout:2 → 后台拒写（入库 / 清库都拒）、不推 CSV、不翻译（翻译轮与单卡 🌍）、不开抓（不开订阅页），各告警一次；
//      缓存未命中的读都会刷新标记
//   G2 没有 dramasMeta → 一切照旧（入库、推送、翻译）
//   G3 layout:1（本版本自己的布局）→ 照旧
//   P  弹窗打开时读 dramasMeta：layout:2 状态栏提示「数据已由更新版本升级，请升级扩展」；没有时照常显示翻译计数
// 用法：node tests/unit-forward-guard.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { background, card } from './background-fixture.mjs';
import { createChromeStorage } from './storage-stub.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

const SYNC_URL = 'http://127.0.0.1:31919/sync';
const CONTENT_SENDER = { id: 'fixture', url: 'https://www.imdb.com/search/title/?genres=short', tab: { id: 7, url: 'https://www.imdb.com/search/title/?genres=short' } };
const HINT = '数据已由更新版本升级，请升级扩展';

async function makeBg({ meta } = {}) {
  const posts = [];
  const translateCalls = [];
  const bg = await background({
    timers: 'manual',
    storage: { dispatchChanges: true },
    dramas: [card('tt0001', { title: 'Revenge Bride' })], // status new：正常时会被翻译
    data: meta === undefined ? {} : { dramasMeta: meta },
    translator: {
      async translateTitleAndDesc(title) { translateCalls.push(title); return { title: '复仇新娘', desc: '' }; },
      async translateBatchAI(items) { translateCalls.push(...items.map(i => i.title)); return items.map(() => ({ title: '复仇新娘', desc: '' })); }
    },
    fetch: (url, options) => {
      if (String(url) !== SYNC_URL) return undefined;
      posts.push(JSON.parse(options.body));
      return Promise.resolve({ ok: true, status: 200, async json() { return { ok: true, count: 1, csvPath: 'stub.csv' }; } });
    }
  });
  const warnings = [];
  bg.context.console.warn = (...args) => warnings.push(args.map(String).join(' '));
  await bg.timers.runAll(); // 顶层预热推送（500ms 防抖）
  const ids = () => (bg.dramas() || []).map(d => d.itemId).sort().join(',');
  // 翻译轮里条间 pause 等定时器：边跑边推时钟，直到这一轮落定
  const translate = async source => {
    const round = bg.run(`performTranslate({ source: ${JSON.stringify(source)} })`);
    let done = false;
    round.then(() => { done = true; });
    for (let i = 0; i < 50 && !done; i++) await bg.timers.advance(250);
    return round;
  };
  return { bg, posts, translateCalls, warnings, ids, translate };
}
const readOnlyWarnings = (h, what) => h.warnings.filter(w => w.includes(`${what}跳过`) && w.includes('请升级扩展'));

// ---------- G1 layout:2 → 只读 ----------
{
  const h = await makeBg({ meta: { layout: 2, sites: ['imdb'] } });
  check('G1a 启动预热推送被拦下：零 POST /sync', h.posts.length === 0, `posts=${h.posts.length}`);
  h.bg.run('lastCsvSyncSerialized = null');
  h.bg.run('scheduleCsvSync()');
  await h.bg.timers.runAll();
  await h.bg.run('syncTimelineToCsv()');
  check('G1b 之后的推送（定时器 / 直接调用）同样不发，只告警一次', h.posts.length === 0 && readOnlyWarnings(h, 'CSV 同步').length === 1,
    JSON.stringify({ posts: h.posts.length, warnings: h.warnings }));

  const saved = await h.bg.send({ action: 'saveDrama', drama: card('tt0002') }, CONTENT_SENDER);
  check('G1c 入库被拒：回 success:false 且点明请升级扩展，表不变',
    saved?.success === false && /请升级扩展/.test(saved?.error || '') && /layout=2/.test(saved?.error || '') && h.ids() === 'tt0001',
    JSON.stringify({ saved, ids: h.ids() }));

  const summary = await h.translate('manual');
  await h.translate('auto');
  check('G1d 翻译扫描直接返回：一条都不请求翻译接口', h.translateCalls.length === 0, JSON.stringify(h.translateCalls));
  check('G1e 手动触发带回报错并写终态（弹窗能收尾显示原因）',
    /请升级扩展/.test(summary?.error || '') && summary?.pendingCount === 0
      && /请升级扩展/.test(h.bg.data.translateRunState?.summary?.error || '') && h.bg.data.translateRunState?.running === false,
    JSON.stringify({ summary, state: h.bg.data.translateRunState }));
  check('G1f 翻译扫描跳过只告警一次（两轮）', readOnlyWarnings(h, '翻译扫描').length === 1, JSON.stringify(h.warnings));
  check('G1g 表里那张 new 卡原样（没被翻、没被改）', h.bg.dramas()?.[0]?.status === 'new' && !h.bg.dramas()?.[0]?.titleZh,
    JSON.stringify(h.bg.dramas()));
  const single = await h.bg.send({ action: 'translateSingle', dramaId: 'id_tt0001' });
  check('G1k 单卡 🌍 也先拦下：不发翻译请求、回报错', single?.success === false && /请升级扩展/.test(single?.error || '') && h.translateCalls.length === 0,
    JSON.stringify({ single, calls: h.translateCalls }));

  // 抓取：入库必被拒，就不该再逐个打开订阅页（冷缓存下由开轮那次读表连带读出标记）
  h.bg.run('dramasLayoutAhead = null; dramasCache = null');
  const tabsBefore = h.bg.log.filter(e => e.startsWith('tab:')).length;
  const botStateBefore = JSON.stringify(h.bg.data.larkBotState ?? null);
  const scrapeSummary = await h.bg.run('performScrape()');
  const refreshed = await h.bg.send({ action: 'triggerScrape', site: 'imdb' });
  await h.bg.flush();
  const tabsOpened = h.bg.log.filter(e => e.startsWith('tab:')).length - tabsBefore;
  check('G1l 抓取也停下：不开订阅页、不标首轮基线；定时轮只告警一次，弹窗单站刷新回报错',
    tabsOpened === 0 && scrapeSummary?.readOnly === true && scrapeSummary?.urlCount === 0
      && refreshed?.success === false && /请升级扩展/.test(refreshed?.error || '')
      && JSON.stringify(h.bg.data.larkBotState ?? null) === botStateBefore
      && readOnlyWarnings(h, '抓取').length === 1 && h.bg.run('activeScrapeCount') === 0,
    JSON.stringify({ tabsOpened, scrapeSummary, refreshed, warnings: readOnlyWarnings(h, '抓取').length }));

  // 清库这类「不先读表就写」的路径：缓存为空、标记未知时也要先补读布局标记再判
  h.bg.run('dramasLayoutAhead = null; dramasCache = null');
  let clearError = null;
  await h.bg.run('clearAllDramas()').catch(e => { clearError = e; });
  check('G1h 冷缓存下清库同样被拒（写前补读 dramasMeta），表不变',
    /请升级扩展/.test(clearError?.message || '') && h.ids() === 'tt0001', JSON.stringify({ error: clearError?.message, ids: h.ids() }));

  h.bg.run('dramasLayoutAhead = null; dramasCache = null');
  await h.bg.run('getDramasSnapshot()');
  const viaSnapshot = h.bg.run('dramasLayoutAhead !== null');
  h.bg.run('dramasLayoutAhead = null; dramasCache = null');
  await h.bg.run('enqueueDramaWrite("unit 读表", getDramasInQueue)');
  const viaQueue = h.bg.run('dramasLayoutAhead !== null');
  check('G1i 缓存未命中的两种读（getDramasSnapshot / getDramasInQueue）都连带刷新布局标记', viaSnapshot && viaQueue,
    JSON.stringify({ viaSnapshot, viaQueue }));
  check('G1j 连带读与 dramas 同一次 get（不多一次读）',
    h.bg.storage.reads.some(keys => Array.isArray(keys) && keys.includes('dramas') && keys.includes('dramasMeta')), JSON.stringify(h.bg.storage.reads.slice(-4)));
}

// ---------- G2 没有 dramasMeta → 照旧 ----------
{
  const h = await makeBg();
  check('G2a 启动预热照常推送', h.posts.length === 1 && h.posts[0].dramas.length === 1, `posts=${h.posts.length}`);
  const saved = await h.bg.send({ action: 'saveDrama', drama: card('tt0002') }, CONTENT_SENDER);
  check('G2b 入库照常', saved?.success === true && saved?.saved === true && h.ids() === 'tt0001,tt0002', JSON.stringify(saved));
  const summary = await h.translate('manual');
  check('G2c 翻译照常请求接口并回填', h.translateCalls.length === 2 && summary?.translatedCount === 2 && !summary?.error,
    JSON.stringify({ calls: h.translateCalls, summary }));
  await h.bg.timers.runAll();
  check('G2d 推送照常（变化后又推出去了），没有任何只读告警',
    h.posts.length >= 2 && h.warnings.every(w => !w.includes('请升级扩展')), JSON.stringify({ posts: h.posts.length, warnings: h.warnings }));
}

// ---------- G3 layout:1（本版本自己的布局）→ 照旧 ----------
{
  const h = await makeBg({ meta: { layout: 1 } });
  const saved = await h.bg.send({ action: 'saveDrama', drama: card('tt0002') }, CONTENT_SENDER);
  check('G3 layout:1 不触发只读：推送与入库照常', h.posts.length === 1 && saved?.saved === true && h.bg.run('dramasLayoutAhead') === null,
    JSON.stringify({ posts: h.posts.length, saved }));
}

// ---------- P 弹窗状态栏提示 ----------
const SiteRegistry = require(path.join(root, 'src/shared/site-registry.js'));
const SiteTabs = require(path.join(root, 'src/shared/site-tabs.js'));
const SubscriptionConfig = require(path.join(root, 'src/shared/subscription-config.js'));
const UrlMatch = require(path.join(root, 'src/shared/url-match.js'));
const IMDB = 'https://www.imdb.com/chart/tvmeter/';

class FakeEl {
  constructor(id) {
    this.id = id;
    this.classes = new Set();
    this.title = '';
    this.textContent = '';
    this.dataset = {};
    this.classList = {
      add: (...names) => names.forEach(n => this.classes.add(n)),
      remove: (...names) => names.forEach(n => this.classes.delete(n)),
      toggle: (name, force) => {
        const on = force === undefined ? !this.classes.has(name) : Boolean(force);
        if (on) this.classes.add(name); else this.classes.delete(name);
        return on;
      },
      contains: name => this.classes.has(name)
    };
  }
  addEventListener() {}
  contains(node) { return node === this; }
  focus() {}
  querySelectorAll() { return []; }
}

/** vm 跑真实 popup.js（DOMContentLoaded 注册行换成导出 init），storage 用共用的 storage-stub。 */
async function popupFixture(stored) {
  const byId = {};
  const misc = {};
  const store = createChromeStorage(stored);
  let onChanged = null;
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: id => byId[id] || (byId[id] = new FakeEl(id)),
      querySelector: sel => misc[sel] || (misc[sel] = new FakeEl(sel)),
      addEventListener() {},
      createElement: () => new FakeEl('')
    },
    window: { location: { href: '' } },
    navigator: { platform: 'MacIntel' },
    chrome: {
      runtime: {
        sendMessage: message => Promise.resolve(message.action === 'getTranslateState' ? { running: false } : undefined),
        getURL: p => `chrome-extension://unit-test/${p}`,
        getManifest: () => ({ version: '9.9.9' })
      },
      storage: { local: store.local, onChanged: { addListener(fn) { onChanged = fn; } } },
      tabs: { create() {} }
    },
    SiteRegistry, SubscriptionConfig, UrlMatch,
    SiteTabs: { ...SiteTabs, render() {} },
    TimelineRender: {
      CATEGORY_SOURCES: SiteRegistry.CATEGORY_SOURCES,
      dramaSource: d => d.source,
      renderTimeline: () => true,
      formatRelativeTime: iso => `REL(${iso})`
    },
    QrCode: { drawToCanvas() {} },
    AbortController,
    fetch: async () => { throw new TypeError('Failed to fetch'); },
    setTimeout: () => 0,
    clearTimeout() {}
  });
  let script = fs.readFileSync(path.join(root, 'src/popup/popup.js'), 'utf8');
  const marker = "document.addEventListener('DOMContentLoaded', init);";
  if (!script.includes(marker)) throw new Error('popup.js 的 DOMContentLoaded 注册行已变，夹具需同步');
  script = script.replace(marker, 'globalThis.fixture = { init, state };');
  vm.runInContext(script, context);
  context.fixture.init();
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  return { status: () => byId.statusText, store, fireChange: changes => onChanged(changes, 'local') };
}

const popupStore = extra => ({
  urlTags: [{ urlPattern: IMDB, tags: ['IMDB'] }],
  dramas: [{ id: 'a', source: 'imdb', sourceListUrl: IMDB, status: 'new' }, { id: 'b', source: 'imdb', sourceListUrl: IMDB, status: 'trans' }],
  siteTabPrefs: { activeSource: 'imdb' },
  ...extra
});
{
  const p = await popupFixture(popupStore({ dramasMeta: { layout: 2 } }));
  check('P1 layout:2：状态栏显示升级提示并标红，悬停说明原因',
    p.status().textContent === HINT && p.status().classes.has('is-warning') && /最新版扩展/.test(p.status().title),
    JSON.stringify({ text: p.status().textContent, title: p.status().title, classes: [...p.status().classes] }));
  check('P2 弹窗打开时与 dramas 同一次读 dramasMeta', p.store.reads.some(keys => keys?.includes('dramas') && keys.includes('dramasMeta')),
    JSON.stringify(p.store.reads));
}
{
  const p = await popupFixture(popupStore());
  check('P3 没有 dramasMeta：照常显示翻译计数、不标红', p.status().textContent === '1 已翻译, 1 待翻译' && !p.status().classes.has('is-warning'),
    JSON.stringify({ text: p.status().textContent, classes: [...p.status().classes] }));
  p.fireChange({ dramasMeta: { newValue: { layout: 2 } } });
  check('P4 弹窗开着时出现 layout:2 标记：状态栏随即换成升级提示', p.status().textContent === HINT && p.status().classes.has('is-warning'),
    p.status().textContent);
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
