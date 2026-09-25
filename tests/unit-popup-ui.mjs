import './bootstrap.cjs';
// 弹窗底栏 / 单站刷新 / 标签条重画 / 「前往榜单页面」的回归测试（2026-09-25 审计批次 F）。
//
// 做法同 unit-popup-sync-control：vm 跑真实 popup.js（只把 DOMContentLoaded 注册行换成导出
// 内部函数），配一棵只含弹窗用到的节点的假 DOM；SiteRegistry / SubscriptionConfig / UrlMatch
// 用真实模块，SiteTabs 保留真实的纯函数、render 换成记录调用的桩（它的 DOM 行为在
// unit-site-tabs H 组），TimelineRender 换成桩（只数重建次数）。setTimeout 走手动时钟。
//
// 分组：
//   L 组：底栏「抓取于 …」——弹窗开着时跟上 lastScrape；最近一轮全部失败（lastScrapeFailure
//         比 lastScrape 新）时后缀「· 最近一轮全部失败」、原因进 title（契约 C1）
//   M 组：单站刷新——并入进行中的全量轮（merged:true）立即停转圈并提示；刷新中再点别的站
//         给出「正在刷新 X，请稍候」而不是静默吞掉（契约 C2）
//   T 组：本页选站写 siteTabPrefs 的回声不再重画标签条；设置页改了分组固定项才重画
//   G 组：「前往榜单页面」按域名归类挑当前站点的订阅页，挑不到去设置页（不再按 host 子串、不回退 urls[0]）
//   W 组：订阅归属判定委托 SubscriptionConfig.dramasUnderUrls，popup.html 按依赖顺序加载它
// 用法：node tests/unit-popup-ui.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SiteRegistry = require(path.join(root, 'src/shared/site-registry.js'));
const SiteTabs = require(path.join(root, 'src/shared/site-tabs.js'));
const SubscriptionConfig = require(path.join(root, 'src/shared/subscription-config.js'));
const UrlMatch = require(path.join(root, 'src/shared/url-match.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

class FakeEl {
  constructor(id) {
    this.id = id;
    this.listeners = {};
    this.classes = new Set();
    this.title = '';
    this.textContent = '';
    this.disabled = false;
    this.dataset = {};
    this.scrollTop = 0;
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
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ target: this, stopPropagation() {} }); }
  contains(node) { return node === this; }
  focus() {}
  querySelectorAll() { return []; }
}

const IMDB = 'https://www.imdb.com/chart/tvmeter/';
const DRAMABOXDB = 'https://www.dramaboxdb.com/ranking';
const REELSHORT = 'https://www.reelshort.com/';

async function popupFixture({ stored = {} } = {}) {
  const byId = {};
  const misc = {};
  const doc = {
    getElementById: id => byId[id] || (byId[id] = new FakeEl(id)),
    querySelector: sel => misc[sel] || (misc[sel] = new FakeEl(sel)),
    addEventListener() {},
    createElement: () => new FakeEl('')
  };

  const store = structuredClone(stored);
  let onChanged = null;
  const messages = [];
  const pendingScrapes = [];
  const tabsCreated = [];
  const storageGets = [];
  const chrome = {
    runtime: {
      sendMessage(message) {
        messages.push(message);
        if (message.action === 'triggerScrape') return new Promise(resolve => pendingScrapes.push(resolve));
        if (message.action === 'getTranslateState') return Promise.resolve({ running: false });
        return Promise.resolve(undefined);
      },
      getURL: p => `chrome-extension://unit-test/${p}`,
      getManifest: () => ({ version: '9.9.9' })
    },
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          storageGets.push(list);
          return Object.fromEntries(list.filter(k => k in store).map(k => [k, structuredClone(store[k])]));
        },
        async set(obj) { Object.assign(store, structuredClone(obj)); }
      },
      onChanged: { addListener(fn) { onChanged = fn; } }
    },
    tabs: { create(opts) { tabsCreated.push(opts.url); } }
  };

  const tabRenders = [];
  let timelineRenders = 0;
  const timers = new Map();
  let seq = 0;
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    document: doc,
    window: { location: { href: '' } },
    navigator: { platform: 'MacIntel' },
    chrome,
    SiteRegistry,
    SubscriptionConfig,
    UrlMatch,
    SiteTabs: { ...SiteTabs, render: (container, layout, opts) => { tabRenders.push({ layout, opts }); } },
    TimelineRender: {
      CATEGORY_SOURCES: SiteRegistry.CATEGORY_SOURCES,
      dramaSource: d => d.source,
      renderTimeline: () => { timelineRenders++; return true; },
      formatRelativeTime: iso => `REL(${iso})`
    },
    QrCode: { drawToCanvas() {} },
    AbortController,
    fetch: async () => { throw new TypeError('Failed to fetch'); },
    setTimeout(fn, ms = 0) { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });

  let script = fs.readFileSync(path.join(root, 'src/popup/popup.js'), 'utf8');
  const marker = "document.addEventListener('DOMContentLoaded', init);";
  if (!script.includes(marker)) throw new Error('popup.js 的 DOMContentLoaded 注册行已变，夹具需同步');
  script = script.replace(marker, 'globalThis.fixture = { elements, state, init, refreshActiveSource, '
    + 'filterDramasByConfiguredUrls, setToast: fn => { showToast = fn; } };');
  vm.runInContext(script, context);
  const fx = context.fixture;
  const toasts = [];
  fx.setToast((message, opts = {}) => toasts.push({ message, type: opts.type || 'info' }));

  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  /** 触发全部到期计时器（去抖渲染等），不推进真实时间。 */
  const flushTimers = () => { const due = [...timers.values()]; timers.clear(); due.forEach(t => t.fn()); return due.length; };

  fx.init();
  await settle();

  return {
    fx, byId, store, messages, pendingScrapes, tabsCreated, storageGets, tabRenders, toasts, settle, flushTimers,
    timelineRenders: () => timelineRenders,
    fireChange: changes => onChanged(changes, 'local'),
    lastUpdate: () => byId.statsLastUpdate
  };
}

const T0 = '2026-09-25T10:00:00.000Z';
const T1 = '2026-09-25T11:00:00.000Z';
const T2 = '2026-09-25T12:00:00.000Z';
const baseStore = (extra = {}) => ({
  urlTags: [{ urlPattern: IMDB, tags: ['IMDB'] }, { urlPattern: REELSHORT, tags: ['ReelShort'] }],
  dramas: [{ id: 'a', source: 'imdb', sourceListUrl: IMDB, status: 'new' }],
  siteTabPrefs: { activeSource: 'imdb' },
  ...extra
});

// ============ L 组：底栏 lastScrape / lastScrapeFailure ============
{
  const h = await popupFixture({ stored: baseStore({ lastScrape: T0 }) });
  check('L0 前提：打开时显示「抓取于 …」、无失败后缀',
    h.lastUpdate().textContent === `抓取于 REL(${T0})` && h.lastUpdate().title === '', h.lastUpdate().textContent);

  const before = h.timelineRenders();
  h.fireChange({ lastScrape: { oldValue: T0, newValue: T1 } });
  check('L1 弹窗开着时后台收轮只写 lastScrape：底栏立即跟上（修复前停在旧时间）',
    h.lastUpdate().textContent === `抓取于 REL(${T1})`, h.lastUpdate().textContent);
  check('L1b 只有 lastScrape 变化不重建时间线', h.timelineRenders() === before && h.flushTimers() === 0,
    `renders ${before}→${h.timelineRenders()}`);

  h.fireChange({ lastScrapeFailure: { newValue: { at: T2, failed: 3, total: 3, error: 'net::ERR_INTERNET_DISCONNECTED' } } });
  check('L2 最近一轮全部失败（比 lastScrape 新）：「抓取于」后接「· 最近一轮全部失败」',
    h.lastUpdate().textContent === `抓取于 REL(${T1}) · 最近一轮全部失败`, h.lastUpdate().textContent);
  check('L2b 失败原因与条数进 title，并标红', h.lastUpdate().title.includes('net::ERR_INTERNET_DISCONNECTED')
    && h.lastUpdate().title.includes('3/3') && h.lastUpdate().classes.has('is-failed'), h.lastUpdate().title);

  const T3 = '2026-09-25T13:00:00.000Z';
  h.fireChange({ lastScrape: { newValue: T3 }, lastScrapeFailure: { newValue: null } });
  check('L3 下一轮有成功（同一次写清掉失败记录）：后缀、title、标红一并撤掉',
    h.lastUpdate().textContent === `抓取于 REL(${T3})` && h.lastUpdate().title === '' && !h.lastUpdate().classes.has('is-failed'),
    `${h.lastUpdate().textContent} | ${h.lastUpdate().title}`);

  h.fireChange({ dramas: { newValue: [] }, lastScrape: { newValue: null } });
  h.flushTimers();
  check('L4 清空数据（dramas 与 lastScrape:null 同一次写）：去抖渲染后显示「未抓取」',
    h.lastUpdate().textContent === '未抓取', h.lastUpdate().textContent);
}
{
  const h = await popupFixture({ stored: baseStore({ lastScrape: T2, lastScrapeFailure: { at: T1, failed: 2, total: 2, error: 'x' } }) });
  check('L5 失败记录比最近一次成功旧：不提示', h.lastUpdate().textContent === `抓取于 REL(${T2})` && h.lastUpdate().title === '',
    h.lastUpdate().textContent);
}
{
  const h = await popupFixture({ stored: baseStore({ lastScrapeFailure: { at: T1, failed: 2, total: 2, error: 'timeout' } }) });
  check('L6 从未成功过、只有失败记录：「未抓取 · 最近一轮全部失败」',
    h.lastUpdate().textContent === '未抓取 · 最近一轮全部失败' && h.lastUpdate().title.includes('timeout'), h.lastUpdate().textContent);
  check('L7 打开弹窗时一并读取 lastScrapeFailure', h.storageGets.some(keys => keys.includes('lastScrapeFailure')),
    JSON.stringify(h.storageGets));
}

// ============ M 组：单站刷新 ============
{
  const h = await popupFixture({ stored: baseStore({ lastScrape: T0 }) });
  const run = h.fx.refreshActiveSource('imdb');
  await h.settle();
  check('M0 前提：发出 triggerScrape 且图标转圈', h.messages.filter(m => m.action === 'triggerScrape').length === 1
    && h.tabRenders.at(-1).opts.refreshingSite === 'imdb', JSON.stringify(h.messages));

  const other = h.fx.refreshActiveSource('reelshort');
  await h.settle();
  check('M1 刷新中再点别的站：提示「正在刷新 IMDB，请稍候」而不是静默吞掉',
    h.toasts.at(-1)?.message === '正在刷新 IMDB，请稍候', JSON.stringify(h.toasts));
  check('M1b 且不发第二条 triggerScrape、转圈仍是原站', h.messages.filter(m => m.action === 'triggerScrape').length === 1
    && h.fx.state.refreshingSite === 'imdb', JSON.stringify(h.messages));
  await other;

  const getsBefore = h.storageGets.length;
  h.pendingScrapes.shift()({ success: true, merged: true });
  await run;
  check('M2 后台回 merged:true（并入进行中的全量轮）：提示本轮内更新、卡片自动出现',
    h.toasts.at(-1)?.message === '全量抓取进行中，该站点会在本轮内更新，新卡片会自动出现', JSON.stringify(h.toasts.at(-1)));
  check('M2b 立即停转圈（refreshingSite 清空并重画标签条）',
    h.fx.state.refreshingSite === null && h.tabRenders.at(-1).opts.refreshingSite === null, '');
  check('M2c 合并时不报「刷新失败」、也不去重读整库（卡片经 onChanged 到达）',
    !h.toasts.some(t => t.type === 'error') && h.storageGets.length === getsBefore, JSON.stringify(h.toasts));

  const again = h.fx.refreshActiveSource('reelshort');
  await h.settle();
  check('M3 合并后可立刻刷新别的站', h.messages.filter(m => m.action === 'triggerScrape').at(-1)?.site === 'reelshort', '');
  h.pendingScrapes.shift()({ success: true, summary: { totalNewCount: 2, results: [{ success: true }] } });
  await again;
  check('M4 正常应答（未合并）照旧：重读数据并报新增条数',
    h.toasts.at(-1)?.message === '本次刷新新增 2 条内容' && h.fx.state.refreshingSite === null, JSON.stringify(h.toasts.at(-1)));
}

// ============ T 组：siteTabPrefs 回声 ============
{
  const h = await popupFixture({ stored: baseStore({ siteTabPrefs: { activeSource: 'imdb', pins: { video: 'netflix' } } }) });
  const before = h.tabRenders.length;
  h.fireChange({ siteTabPrefs: { newValue: { activeSource: 'reelshort', pins: { video: 'netflix' } } } });
  check('T1 本页选站写 siteTabPrefs（pins 未变）：不再重画标签条', h.tabRenders.length === before,
    `renders ${before}→${h.tabRenders.length}`);
  h.fireChange({ siteTabPrefs: { newValue: { activeSource: 'reelshort', pins: { video: 'appletv' } } } });
  check('T2 设置页改了分组固定项：重画一次且带上新固定项',
    h.tabRenders.length === before + 1 && JSON.stringify(h.fx.state.groupPins) === '{"video":"appletv"}',
    `renders ${before}→${h.tabRenders.length}`);
  h.fireChange({ siteTabPrefs: { newValue: undefined } });
  check('T3 固定项被清空（键被删）：按「全部自动」重画', h.tabRenders.length === before + 2
    && JSON.stringify(h.fx.state.groupPins) === '{}', JSON.stringify(h.fx.state.groupPins));
}

// ============ G 组：「前往榜单页面」 ============
{
  const h = await popupFixture({ stored: baseStore({
    urlTags: [{ urlPattern: IMDB, tags: ['IMDB'] }, { urlPattern: DRAMABOXDB, tags: ['DramaBox'] }],
    siteTabPrefs: { activeSource: 'dramabox' }
  }) });
  check('G0 前提：活动站点为 DramaBox', h.fx.state.activeSource === 'dramabox', h.fx.state.activeSource);
  h.byId.btnGoScrape.click();
  check('G1 只订了 dramaboxdb.com：打开 DramaBox 的订阅页（修复前 host 子串不中，回退打开了 IMDB）',
    JSON.stringify(h.tabsCreated) === JSON.stringify([DRAMABOXDB]), JSON.stringify(h.tabsCreated));

  h.tabsCreated.length = 0;
  h.fx.state.activeSource = 'netflix';   // 当前站点名下没有订阅 URL
  h.byId.btnGoScrape.click();
  check('G2 当前站点没有订阅页：去设置页，不再随手开 urls[0]',
    JSON.stringify(h.tabsCreated) === JSON.stringify(['chrome-extension://unit-test/src/settings/settings.html']),
    JSON.stringify(h.tabsCreated));

  h.tabsCreated.length = 0;
  h.fx.state.activeSource = null;
  h.byId.btnGoScrape.click();
  check('G3 没有活动站点（零订阅）：去设置页', h.tabsCreated.length === 1 && h.tabsCreated[0].endsWith('settings.html'),
    JSON.stringify(h.tabsCreated));
}

// ============ W 组：订阅归属判定只在 subscription-config 一处 ============
{
  const h = await popupFixture({ stored: baseStore() });
  const cards = [
    { id: 'a', sourceListUrl: IMDB },
    { id: 'b', sourceListUrl: IMDB.replace(/\/$/, '') },   // 尾斜杠差异仍归属
    { id: 'c', sourceListUrl: `${IMDB}?ref=x` },           // 带参是另一条订阅，不归属
    null,                                                   // 脏条目不炸
    { id: 'd' }
  ];
  let kept;
  try { kept = h.fx.filterDramasByConfiguredUrls(cards).map(d => d.id); } catch (e) { kept = `抛错：${e.message}`; }
  check('W1 弹窗过滤与 SubscriptionConfig.dramasUnderUrls 同口径（尾斜杠归一、精确等值、脏条目跳过）',
    JSON.stringify(kept) === '["a","b"]', JSON.stringify(kept));
  h.fx.state.urlTags = [];
  check('W2 零订阅得空', h.fx.filterDramasByConfiguredUrls(cards).length === 0, '');

  const src = fs.readFileSync(path.join(root, 'src/popup/popup.js'), 'utf8');
  check('W3 popup.js 委托 SubscriptionConfig.dramasUnderUrls，不再自拼 UrlMatch 集合',
    src.includes('SubscriptionConfig.dramasUnderUrls(') && !src.includes('UrlMatch.buildConfiguredUrlSet'), '');
  const html = fs.readFileSync(path.join(root, 'src/popup/popup.html'), 'utf8');
  const at = needle => html.indexOf(`src="${needle}"`);
  check('W4 popup.html 按依赖顺序加载：url-match → subscription-config → popup.js',
    at('../shared/url-match.js') >= 0 && at('../shared/url-match.js') < at('../shared/subscription-config.js')
    && at('../shared/subscription-config.js') < at('popup.js'),
    JSON.stringify([at('../shared/url-match.js'), at('../shared/subscription-config.js'), at('popup.js')]));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
