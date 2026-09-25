import './bootstrap.cjs';
// SiteTabs 折叠标签条回归测试（v1.5.11）：分组划分完备性、代表站点三级优先级、
// 活动站点回退链、布局折叠规则；v1.6.9 加横向拖动判据（D/E 组）与两份 CSS 同步（F 组）。
// 逻辑断言走纯函数、零 DOM；CSS 只做文本断言；H 组（render 跨重建保焦点与拖动）用文末的极小假 DOM。
// 用法：node tests/unit-site-tabs.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SiteRegistry = require(path.join(worktreeRoot, 'src/shared/site-registry.js'));
const SiteTabs = require(path.join(worktreeRoot, 'src/shared/site-tabs.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const setOf = (...sites) => new Set(sites);
const iso = s => new Date(s).toISOString();

// ---------- G 分组定义 ----------
const flattened = SiteRegistry.SITE_GROUPS.flatMap(entry => entry.sites);
check('G1a 分组展平无重复', new Set(flattened).size === flattened.length, flattened.join(','));
check('G1b 分组展平与 CATEGORY_SOURCES 互为排列（无重无漏）',
  deepEq(flattened.slice().sort(), SiteRegistry.CATEGORY_SOURCES.slice().sort()),
  `分组内=${flattened.join(',')} / 注册表=${SiteRegistry.CATEGORY_SOURCES.join(',')}`);

check('G2a 分组顺序：短剧 → 影视 → 游戏·网文',
  deepEq(SiteRegistry.SITE_GROUPS.map(g => g.group), ['shortdrama', 'video', 'game']),
  JSON.stringify(SiteRegistry.SITE_GROUPS.map(g => g.group)));
check('G2b 组内站点字面量（2026-09-12 用户定）',
  deepEq(SiteRegistry.SITE_GROUPS.map(g => g.sites), [
    ['mydrama', 'reelshort', 'dramashorts', 'netshort', 'flickreels', 'goodshort', 'shortical', 'shortmax', 'dramabox'],
    ['imdb', 'netflix', 'appletv'],
    ['steam', 'royalroad', 'pinedrama']
  ]),
  JSON.stringify(SiteRegistry.SITE_GROUPS.map(g => g.sites)));
check('G2c 默认展开短剧组', SiteRegistry.DEFAULT_GROUP === 'shortdrama', SiteRegistry.DEFAULT_GROUP);

check('G3a groupOfSite 反向映射',
  SiteRegistry.groupOfSite('netflix') === 'video' &&
  SiteRegistry.groupOfSite('netshort') === 'shortdrama' &&
  SiteRegistry.groupOfSite('royalroad') === 'game', '');
check('G3b groupOfSite 未知站点返回 null', SiteRegistry.groupOfSite('nosuchsite') === null, '');

// ---------- U latestUpdateBySite ----------
const dramas = [
  { source: 'netflix', scrapedAt: iso('2026-09-10T10:00:00Z') },
  { source: 'netflix', scrapedAt: iso('2026-09-12T08:00:00Z') },  // 该站最新
  { source: 'imdb', scrapedAt: iso('2026-09-11T09:00:00Z') },
  { source: 'appletv', scrapedAt: null },                          // 缺时间戳，跳过
  { source: 'appletv', scrapedAt: '不是时间' },                    // 非法时间戳，跳过
  null                                                              // 脏数据不炸
];
const latest = SiteTabs.latestUpdateBySite(dramas);
check('U1 每站取 scrapedAt 最大值',
  latest.netflix === Date.parse(iso('2026-09-12T08:00:00Z')) &&
  latest.imdb === Date.parse(iso('2026-09-11T09:00:00Z')),
  JSON.stringify(latest));
check('U2 缺失/非法时间戳的站点不进结果', !('appletv' in latest), JSON.stringify(latest));
check('U3 空输入返回空对象', deepEq(SiteTabs.latestUpdateBySite([]), {}) && deepEq(SiteTabs.latestUpdateBySite(null), {}), '');

// ---------- R pickRepresentative ----------
const videoGroup = SiteRegistry.SITE_GROUPS.find(g => g.group === 'video');
const allVisible = setOf(...SiteRegistry.CATEGORY_SOURCES);

check('R1 固定项优先于最近更新',
  SiteTabs.pickRepresentative(videoGroup, {
    visibleSites: allVisible, latestBySite: latest, pins: { video: 'appletv' }
  }) === 'appletv', '');
check('R2 固定到未订阅站点时按自动处理',
  SiteTabs.pickRepresentative(videoGroup, {
    visibleSites: setOf('imdb', 'netflix'), latestBySite: latest, pins: { video: 'appletv' }
  }) === 'netflix', '');
check('R3 无固定项时取组内最近有更新的站点',
  SiteTabs.pickRepresentative(videoGroup, { visibleSites: allVisible, latestBySite: latest }) === 'netflix', '');
check('R4 组内都没有更新记录时取首个可见站点（注册表组内顺序）',
  SiteTabs.pickRepresentative(videoGroup, { visibleSites: setOf('netflix', 'appletv'), latestBySite: {} }) === 'netflix', '');
check('R5 组内零可见站点返回 null',
  SiteTabs.pickRepresentative(videoGroup, { visibleSites: setOf('steam'), latestBySite: latest }) === null, '');
check('R6 visibleSites 省略＝全部可见',
  SiteTabs.pickRepresentative(videoGroup, { latestBySite: {} }) === 'imdb', '');

// ---------- A resolveActiveSource ----------
check('A1 记忆站点仍被订阅时沿用',
  SiteTabs.resolveActiveSource({ visibleSites: allVisible, activeSource: 'royalroad', latestBySite: latest }) === 'royalroad', '');
check('A2 记忆站点已退订 → 回退到默认短剧组的代表站点',
  SiteTabs.resolveActiveSource({
    visibleSites: setOf('mydrama', 'netshort', 'imdb'),
    activeSource: 'royalroad',
    latestBySite: { netshort: 100 }
  }) === 'netshort', '');
check('A3 无记忆时取默认短剧组代表站点',
  SiteTabs.resolveActiveSource({ visibleSites: allVisible, activeSource: null, latestBySite: {} }) === 'mydrama', '');
check('A4 短剧组无订阅 → 顺延到下一个有可见站点的组（SITE_GROUPS 顺序）',
  SiteTabs.resolveActiveSource({ visibleSites: setOf('steam', 'appletv'), activeSource: null, latestBySite: {} }) === 'appletv',
  'video 组排在 game 组之前');
check('A5 零订阅返回 null',
  SiteTabs.resolveActiveSource({ visibleSites: setOf(), activeSource: 'imdb', latestBySite: {} }) === null, '');
check('A6 记忆值是未知站点时不采信',
  SiteTabs.resolveActiveSource({ visibleSites: allVisible, activeSource: 'nosuchsite', latestBySite: {} }) === 'mydrama', '');

// ---------- L resolveLayout ----------
const layoutAll = SiteTabs.resolveLayout({ visibleSites: allVisible, activeSource: 'netflix', latestBySite: latest });
check('L1 展开的组恒等于活动站点所在的组',
  layoutAll.activeGroup === 'video' &&
  layoutAll.groups.filter(g => !g.collapsed).map(g => g.group).join(',') === 'video',
  JSON.stringify(layoutAll.groups.map(g => [g.group, g.collapsed])));
check('L2 组顺序与 SITE_GROUPS 一致（短剧组在最前）',
  deepEq(layoutAll.groups.map(g => g.group), ['shortdrama', 'video', 'game']),
  JSON.stringify(layoutAll.groups.map(g => g.group)));
check('L3 收起组各自带代表站点',
  layoutAll.groups.every(g => g.representative && g.sites.includes(g.representative)),
  JSON.stringify(layoutAll.groups.map(g => [g.group, g.representative])));

const layoutSingle = SiteTabs.resolveLayout({
  visibleSites: setOf('mydrama', 'reelshort', 'steam'), activeSource: 'mydrama', latestBySite: {}
});
check('L4 单可见站点的组不折叠（steam 组 collapsed=false）',
  layoutSingle.groups.find(g => g.group === 'game').collapsed === false,
  JSON.stringify(layoutSingle.groups.map(g => [g.group, g.sites.length, g.collapsed])));
check('L5 零可见站点的组整组不出现（video 组缺席）',
  !layoutSingle.groups.some(g => g.group === 'video'),
  JSON.stringify(layoutSingle.groups.map(g => g.group)));
check('L6 组内只列可见站点',
  deepEq(layoutSingle.groups.find(g => g.group === 'shortdrama').sites, ['mydrama', 'reelshort']),
  JSON.stringify(layoutSingle.groups.find(g => g.group === 'shortdrama').sites));

// ---------- S 组内排序：最近有更新的排最前（2026-09-12 用户定） ----------
const shortGroup = SiteRegistry.SITE_GROUPS.find(g => g.group === 'shortdrama');
const shortLatest = { dramashorts: 400, mydrama: 100, netshort: 300 };  // reelshort 无记录
check('S1 组内按最近更新降序排，无记录的排最后',
  deepEq(SiteTabs.resolveLayout({ visibleSites: allVisible, activeSource: 'mydrama', latestBySite: shortLatest })
    .groups.find(g => g.group === 'shortdrama').sites,
    ['dramashorts', 'netshort', 'mydrama', 'reelshort', 'flickreels', 'goodshort', 'shortical', 'shortmax', 'dramabox']),   // 无记录的几家彼此并列，按注册表序排在有记录的之后
  JSON.stringify(SiteTabs.resolveLayout({ visibleSites: allVisible, activeSource: 'mydrama', latestBySite: shortLatest })
    .groups.find(g => g.group === 'shortdrama').sites));

const SHORT_REGISTRY_ORDER = ['mydrama', 'reelshort', 'dramashorts', 'netshort', 'flickreels', 'goodshort', 'shortical', 'shortmax', 'dramabox'];
const allTied = Object.fromEntries(SHORT_REGISTRY_ORDER.map(site => [site, 500]));

check('S2 全都无更新记录时保持注册表组内顺序（稳定排序）',
  deepEq(SiteTabs.visibleSitesOfGroup(shortGroup, allVisible, {}), SHORT_REGISTRY_ORDER),
  JSON.stringify(SiteTabs.visibleSitesOfGroup(shortGroup, allVisible, {})));

check('S3 更新时间并列时保持注册表组内顺序',
  deepEq(SiteTabs.visibleSitesOfGroup(shortGroup, allVisible, allTied), SHORT_REGISTRY_ORDER),
  JSON.stringify(SiteTabs.visibleSitesOfGroup(shortGroup, allVisible, allTied)));

check('S4 排序不改注册表本身（SITE_GROUPS.sites 未被就地重排）',
  deepEq(shortGroup.sites, SHORT_REGISTRY_ORDER),
  JSON.stringify(shortGroup.sites));

check('S5 排序后的首个站点即代表站点（与收起胶囊一致）',
  SiteTabs.pickRepresentative(shortGroup, { visibleSites: allVisible, latestBySite: shortLatest }) === 'dramashorts', '');

const layoutEmpty = SiteTabs.resolveLayout({ visibleSites: setOf(), activeSource: null, latestBySite: {} });
check('L7 零订阅时无任何分组、activeSource 为 null',
  layoutEmpty.groups.length === 0 && layoutEmpty.activeSource === null, JSON.stringify(layoutEmpty));

// 收起胶囊上显示的 logo＝点开后会选中的站点（同一个 pickRepresentative）
const chipLayout = SiteTabs.resolveLayout({
  visibleSites: allVisible, activeSource: 'mydrama', latestBySite: latest, pins: { game: 'royalroad' }
});
const gameChip = chipLayout.groups.find(g => g.group === 'game');
check('L8 收起胶囊的代表站点遵循固定项',
  gameChip.collapsed === true && gameChip.representative === 'royalroad', JSON.stringify(gameChip));

// ---------- D 展开组横向拖动的判据（v1.6.9，2026-09-17 用户定「按住即拖」） ----------
// 核心：原地按一下仍是选站，只有真拖过才吞掉那一下 click。
check('D1 默认阈值 5px', SiteTabs.DRAG_THRESHOLD_PX === 5, String(SiteTabs.DRAG_THRESHOLD_PX));

const d0 = SiteTabs.beginDrag(100, 40);
check('D2 按下即记起点与当前 scrollLeft，尚未算拖动',
  d0.active === true && d0.moved === false && d0.startX === 100 && d0.startScroll === 40 && d0.scrollLeft === 40,
  JSON.stringify(d0));

check('D3 位移不足阈值不算拖动，松手仍是点击',
  SiteTabs.endDrag(SiteTabs.moveDrag(d0, 104)).suppressClick === false,
  JSON.stringify(SiteTabs.moveDrag(d0, 104)));
check('D3b 恰好等于阈值即算拖动（>=，边界含等号）',
  SiteTabs.moveDrag(d0, 105).moved === true, JSON.stringify(SiteTabs.moveDrag(d0, 105)));
check('D3c 反向位移同样按绝对值判定',
  SiteTabs.moveDrag(d0, 95).moved === true, JSON.stringify(SiteTabs.moveDrag(d0, 95)));

// 往右拖（clientX 变大）＝内容左移＝scrollLeft 变小，位移始终相对**按下那一刻**算，
// 不是逐帧累加（累加会因丢帧漂移）
check('D4 scrollLeft = 按下时的 scrollLeft − 相对按下点的位移',
  SiteTabs.moveDrag(d0, 130).scrollLeft === 10 && SiteTabs.moveDrag(d0, 70).scrollLeft === 70,
  JSON.stringify([SiteTabs.moveDrag(d0, 130).scrollLeft, SiteTabs.moveDrag(d0, 70).scrollLeft]));

// moved 单向置位：拖出去又拖回原点，松手不能变回「点击」——否则会误切站点
const dBackAndForth = SiteTabs.moveDrag(SiteTabs.moveDrag(d0, 160), 100);
check('D5 moved 一旦置位不回落（拖出去又拖回原点仍算拖动）',
  dBackAndForth.moved === true && dBackAndForth.scrollLeft === 40 && SiteTabs.endDrag(dBackAndForth).suppressClick === true,
  JSON.stringify(dBackAndForth));

check('D6 endDrag 一律收掉 active', SiteTabs.endDrag(dBackAndForth).active === false, '');
check('D6b endDrag 容忍空状态（组外松手 / 重复触发）',
  SiteTabs.endDrag(null).suppressClick === false && SiteTabs.endDrag(undefined).active === false, '');
check('D7 moveDrag 对未按下的状态是恒等变换',
  SiteTabs.moveDrag(null, 999) === null && SiteTabs.moveDrag({ active: false }, 999).active === false, '');
check('D8 moveDrag 不就地改状态（保持可预测的纯函数语义）',
  SiteTabs.moveDrag(d0, 200) !== d0 && d0.moved === false && d0.scrollLeft === 40, JSON.stringify(d0));

// 活动站点滚进视区：纯横向计算，不用 scrollIntoView（那个会连带竖向滚动整个弹窗）
const visible = SiteTabs.scrollLeftForVisible;
check('E1 已在视区内则不动', visible(50, 44, 40, 200) === 40, String(visible(50, 44, 40, 200)));
check('E2 在视区左侧则左对齐到它', visible(10, 44, 40, 200) === 10, String(visible(10, 44, 40, 200)));
check('E3 在视区右侧则右对齐到它', visible(300, 44, 40, 200) === 144, String(visible(300, 44, 40, 200)));
check('E4 首个元素（offsetLeft 0）能回到最左', visible(0, 44, 60, 200) === 0, String(visible(0, 44, 60, 200)));

// ---------- F 标签条滚动规则 ----------
// 两页共用 src/shared/timeline-cards.css 里的这一份（2026-09-25 审计 E 前是 popup.css / share.css
// 各一份，只改一边会让共享页的图标继续撑破容器）；两页都引入它由 unit-card-layout D2 守着
const squash = s => s.replace(/\s+/g, ' ');
const ruleBody = (src, selector) => {
  const m = squash(src).match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`));
  return m ? m[1].trim() : null;
};
for (const rel of ['src/shared/timeline-cards.css']) {
  const src = fs.readFileSync(path.join(worktreeRoot, rel), 'utf8');
  const open = ruleBody(src, '.tab-group.is-open');
  check(`F1 ${rel} 展开组横向可滚且不显滚动条`,
    Boolean(open) && /overflow-x:\s*auto/.test(open) && /min-width:\s*0/.test(open) && /scrollbar-width:\s*none/.test(open),
    open || '(未匹配到规则)');
  // 容器不清 min-width，展开组只会撑破 .category-tabs 而永远不进入滚动
  const tabs = ruleBody(src, '.category-tabs');
  check(`F2 ${rel} .category-tabs 清了 min-width`, Boolean(tabs) && /min-width:\s*0/.test(tabs), tabs || '(未匹配到规则)');
  // 图标与收起胶囊都不许被压缩——否则是「挤扁」而不是「溢出滚动」
  const tab = ruleBody(src, '.tab-group.is-open .category-tab');
  check(`F3 ${rel} 组内图标 flex-shrink: 0`, Boolean(tab) && /flex-shrink:\s*0/.test(tab), tab || '(未匹配到规则)');
  const chip = ruleBody(src, '.tab-group-chip');
  check(`F4 ${rel} 收起胶囊 flex-shrink: 0`, Boolean(chip) && /flex-shrink:\s*0/.test(chip), chip || '(未匹配到规则)');
  check(`F5 ${rel} 拖动中换 grabbing 手型`,
    /\.tab-group\.is-open\.is-dragging \{[^}]*cursor:\s*grabbing/.test(squash(src)), '');
}
// 上面那个 is-dragging 类必须真的由共享渲染模块加上，类名拼错就全盘失效
const tabsSrc = fs.readFileSync(path.join(worktreeRoot, 'src/shared/site-tabs.js'), 'utf8');
check('F6 site-tabs.js 拖动时加 is-dragging 类', tabsSrc.includes("classList.add('is-dragging')"), '');
check('F7 site-tabs.js 在捕获阶段拦 click（拖完那一下不选站）',
  /addEventListener\('click',[\s\S]{0,260}?\}, true\)/.test(tabsSrc), '');

// F8/F9 是 2026-09-18 线上 bug「能拖但点不动」的定影。**这两条不是风格洁癖**：
// 指针被 setPointerCapture 捕获后，Chrome 会把随后的 click 改派到捕获元素上，
// 图标自己的 click 监听器再也收不到 → 单击选站彻底失效，而拖动一切正常（所以很像「只是点击没反应」）。
// 当时没被测出来，是因为 e2e 用 JS 合成的 btn.click()——那条路压根不经过 pointer 事件。
// 真正能抓住它的是「真实鼠标序列点一下」，见 tmp/probe-tab-click.mjs 的 T1/T3。
// 只匹配**调用**（`.setPointerCapture(`），不匹配文字——上面那段注释里就写着这个词，
// 按裸词匹配会让守卫被自己的说明绊倒
check('F8 site-tabs.js 绝不调用 setPointerCapture（会把 click 改派到捕获元素上，单击选站失效）',
  !/\.setPointerCapture\s*\(/.test(tabsSrc), '源码里有 .setPointerCapture( 调用');
check('F9 拖动的 move/up 挂在 window 上（手滑出标签栏仍跟手，且不影响 click 派发目标）',
  /window\.addEventListener\('pointermove'/.test(tabsSrc)
  && /window\.addEventListener\('pointerup'/.test(tabsSrc)
  && /window\.removeEventListener\('pointermove'/.test(tabsSrc), '');

// ---------- H render 跨重建：焦点与进行中的拖动（2026-09-25 审计 tabbar-rebuild-focus-drag） ----------
// render 每次整条重建（抓取期间弹窗 ≤1 次/秒）。修复前：① 清空容器把焦点掉回 body，键盘用户
// Tab 到图标按 Enter 后下一次 Tab 从页面开头开始；② 拖动状态和监听挂在展开组节点的闭包里，
// 重建后正在进行的拖动只改脱离 DOM 的旧节点，条子不跟手、拖完那一下的 click 也拦不住（误切站点）。
// 这里给一棵极小的假 DOM（只覆盖 render 用到的那点 API：类/data-* 复合选择器、捕获+冒泡派发、
// 焦点随节点移除掉回 body），真跑 SiteTabs.render。
{
  class FakeNode {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.dataset = {};
      this.attrs = {};
      this.listeners = [];
      this.classSet = new Set();
      this.scrollLeft = 0;
      this.offsetLeft = 0;
      this.offsetWidth = 44;
      this.clientWidth = 200;
      this.focusCalls = [];
      const node = this;
      this.classList = {
        add: (...names) => names.forEach(n => node.classSet.add(n)),
        remove: (...names) => names.forEach(n => node.classSet.delete(n)),
        contains: name => node.classSet.has(name),
        toggle: (name, force) => {
          const on = force === undefined ? !node.classSet.has(name) : Boolean(force);
          if (on) node.classSet.add(name); else node.classSet.delete(name);
          return on;
        }
      };
    }
    get className() { return [...this.classSet].join(' '); }
    set className(value) { this.classSet = new Set(String(value).split(/\s+/).filter(Boolean)); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    set innerHTML(value) {
      if (value !== '') throw new Error('假 DOM 只支持 innerHTML = \'\'');
      const doc = globalThis.document;
      for (const child of this.children) {
        if (doc.activeElement && child.contains(doc.activeElement)) doc.activeElement = doc.body; // 浏览器语义
        child.parentNode = null;
      }
      this.children = [];
    }
    contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
    descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
    matches(selector) {
      const m = String(selector).match(/^((?:\.[\w-]+)*)((?:\[[\w-]+="[^"]*"\])*)$/);
      if (!m) throw new Error(`假 DOM 不支持选择器 ${selector}`);
      const classes = (m[1].match(/\.[\w-]+/g) || []).map(c => c.slice(1));
      const attrs = [...m[2].matchAll(/\[([\w-]+)="([^"]*)"\]/g)];
      return classes.every(c => this.classSet.has(c)) && attrs.every(([, name, value]) =>
        (name.startsWith('data-') ? this.dataset[name.slice(5)] : this.attrs[name]) === value);
    }
    querySelectorAll(selector) { return this.descendants().filter(n => n.matches(selector)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, fn, options) {
      const capture = options === true || Boolean(options && options.capture);
      this.listeners.push({ type, fn, capture });
    }
    focus(options) { this.focusCalls.push(options); globalThis.document.activeElement = this; }
  }

  const windowListeners = new Map();
  globalThis.window = {
    addEventListener(type, fn) { (windowListeners.get(type) || windowListeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { windowListeners.get(type)?.delete(fn); }
  };
  const body = new FakeNode('body');
  globalThis.document = { createElement: tag => new FakeNode(tag), body, activeElement: body };
  const fireWindow = (type, init) => {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const fn of [...(windowListeners.get(type) || [])]) fn(event);
    return event;
  };
  /** 捕获（根→目标）+ 冒泡（目标→根），尊重 stopPropagation。 */
  const dispatch = (target, type, init = {}) => {
    const event = {
      type, target, defaultPrevented: false, stopped: false, ...init,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }
    };
    const path = [];
    for (let n = target; n; n = n.parentNode) path.push(n);
    for (const node of [...path].reverse()) {
      for (const l of node.listeners) if (l.type === type && l.capture && !event.stopped) l.fn(event);
    }
    for (const node of path) {
      for (const l of node.listeners) if (l.type === type && !l.capture && !event.stopped) l.fn(event);
    }
    return event;
  };

  const selected = [];
  const expanded = [];
  const container = new FakeNode('div');
  body.appendChild(container);
  const renderWith = (activeSource) => SiteTabs.render(container,
    SiteTabs.resolveLayout({ visibleSites: allVisible, activeSource, latestBySite: {} }), {
      assetsBase: '/icons',
      onSelectSite: site => selected.push(site),
      onExpandGroup: (group, rep) => expanded.push([group, rep])
    });
  const tabOf = source => container.querySelector(`.category-tab[data-source="${source}"]`);
  const chipOf = group => container.querySelector(`.tab-group-chip[data-group="${group}"]`);
  const openGroup = () => container.querySelector('.tab-group.is-open');

  // —— 焦点 ——
  renderWith('mydrama');
  const before = tabOf('netshort');
  before.focus();
  renderWith('mydrama');
  const after = tabOf('netshort');
  check('H1 焦点在组内图标上：重建后回到同一站点的新按钮',
    after !== before && document.activeElement === after, `active=${document.activeElement?.dataset?.source || document.activeElement?.tagName}`);
  check('H1b 找回焦点不滚动页面（preventScroll）', after.focusCalls.at(-1)?.preventScroll === true, JSON.stringify(after.focusCalls));

  chipOf('video').focus();
  renderWith('mydrama');
  check('H2 焦点在收起胶囊上、重建后仍收起：回到同组的新胶囊',
    document.activeElement === chipOf('video'), `active=${document.activeElement?.dataset?.group}`);

  chipOf('video').focus();
  renderWith('imdb');   // 点胶囊＝展开该组并选中代表站点
  check('H3 焦点在胶囊上、该组已展开：落到活动图标上',
    document.activeElement === tabOf('imdb') && tabOf('imdb').classList.contains('active'),
    `active=${document.activeElement?.dataset?.source}`);

  const outside = new FakeNode('input');
  body.appendChild(outside);
  outside.focus();
  renderWith('imdb');
  check('H4 焦点不在标签条里：重建不抢焦点', document.activeElement === outside, '');

  // —— 拖动跨重建 ——
  renderWith('mydrama');
  const pointerdownListeners = () => container.listeners.filter(l => l.type === 'pointerdown').length;
  const clickCaptureListeners = () => container.listeners.filter(l => l.type === 'click' && l.capture).length;
  check('H5 拖动监听挂在容器上且只挂一次（多次重建不累积）',
    pointerdownListeners() === 1 && clickCaptureListeners() === 1, `pointerdown=${pointerdownListeners()} click=${clickCaptureListeners()}`);

  const firstGroup = openGroup();
  dispatch(tabOf('reelshort'), 'pointerdown', { clientX: 100, button: 0, pointerType: 'mouse' });
  fireWindow('pointermove', { clientX: 80 });             // 位移 20px ＞ 阈值：锁定为拖动
  check('H6 前提：拖动中展开组跟手（scrollLeft = 起点 + 20）并加 is-dragging',
    firstGroup.scrollLeft === 20 && firstGroup.classList.contains('is-dragging'), `scrollLeft=${firstGroup.scrollLeft}`);

  renderWith('mydrama');                                  // 抓取期间的去抖重渲染
  const rebuilt = openGroup();
  check('H7 前提：重建换了新的展开组节点，横向位置原样保住', rebuilt !== firstGroup && rebuilt.scrollLeft === 20,
    `same=${rebuilt === firstGroup} scrollLeft=${rebuilt.scrollLeft}`);
  fireWindow('pointermove', { clientX: 60 });
  check('H8 重建后继续拖：写到当前（新）展开组上，条子仍跟手',
    rebuilt.scrollLeft === 40 && rebuilt.classList.contains('is-dragging'), `new=${rebuilt.scrollLeft} old=${firstGroup.scrollLeft}`);

  fireWindow('pointerup', {});
  check('H9 松手后当前展开组去掉 is-dragging、window 监听全部卸掉',
    !rebuilt.classList.contains('is-dragging') && ['pointermove', 'pointerup', 'pointercancel'].every(t => !windowListeners.get(t)?.size), '');
  selected.length = 0;
  const swallowed = dispatch(tabOf('reelshort'), 'click');
  check('H10 重建后拖完那一下的 click 仍被吞掉（不误切站点）', selected.length === 0 && swallowed.defaultPrevented,
    JSON.stringify(selected));

  dispatch(tabOf('netshort'), 'pointerdown', { clientX: 50, button: 0, pointerType: 'mouse' });
  fireWindow('pointermove', { clientX: 52 });              // 不足阈值
  fireWindow('pointerup', {});
  dispatch(tabOf('netshort'), 'click');
  check('H11 原地点一下仍是选站', JSON.stringify(selected) === '["netshort"]', JSON.stringify(selected));

  selected.length = 0;
  dispatch(chipOf('video'), 'pointerdown', { clientX: 10, button: 0, pointerType: 'mouse' });
  fireWindow('pointermove', { clientX: 90 });
  check('H12 在收起胶囊上按住拖不起拖（只有展开组可拖）',
    !windowListeners.get('pointermove')?.size && openGroup().scrollLeft === 40, `scrollLeft=${openGroup().scrollLeft}`);
  dispatch(chipOf('video'), 'click');
  check('H12b 胶囊点击照常展开', JSON.stringify(expanded.at(-1)) === '["video","imdb"]', JSON.stringify(expanded));

  // 拖到标签条外松手：没有 click 可吞，拦截标记残留。拦截器现在挂在整条容器上，
  // 接下来点胶囊（不在展开组里、不起拖）也必须先清掉它，否则这一下被吞
  expanded.length = 0;
  dispatch(tabOf('reelshort'), 'pointerdown', { clientX: 100, button: 0, pointerType: 'mouse' });
  fireWindow('pointermove', { clientX: 20 });
  fireWindow('pointerup', {});
  dispatch(chipOf('video'), 'pointerdown', { clientX: 10, button: 0, pointerType: 'mouse' });
  fireWindow('pointerup', {});
  dispatch(chipOf('video'), 'click');
  check('H13 拖到条外松手后再点胶囊：不被残留的拦截标记吞掉', JSON.stringify(expanded) === '[["video","imdb"]]',
    JSON.stringify(expanded));

  // 同样拖到条外松手，接着用键盘（Tab 到图标按 Enter）选站：键盘合成的 click 没有 pointerdown
  // 先清标记，detail 为 0，不能被当成「拖完松手那一下」吞掉
  selected.length = 0;
  dispatch(tabOf('reelshort'), 'pointerdown', { clientX: 100, button: 0, pointerType: 'mouse' });
  fireWindow('pointermove', { clientX: 20 });
  fireWindow('pointerup', {});
  const keyboardClick = dispatch(tabOf('netshort'), 'click', { detail: 0 });
  check('H14 拖到条外松手后键盘 Enter 选站：不被残留的拦截标记吞掉',
    JSON.stringify(selected) === '["netshort"]' && !keyboardClick.defaultPrevented, JSON.stringify(selected));

  delete globalThis.document;
  delete globalThis.window;
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
