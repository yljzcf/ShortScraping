import './bootstrap.cjs';
// SiteTabs 折叠标签条回归测试（v1.5.11）：分组划分完备性、代表站点三级优先级、
// 活动站点回退链、布局折叠规则。全部走纯函数，零 DOM。
// 用法：node tests/unit-site-tabs.mjs
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
    ['mydrama', 'reelshort', 'dramashorts', 'netshort'],
    ['imdb', 'netflix', 'appletv'],
    ['steam', 'royalroad']
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
check('R4 组内都没有更新记录时取首个可见站点（组内顺序）',
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

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
