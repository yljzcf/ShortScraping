import './bootstrap.cjs';
// SiteRegistry 收敛回归测试：站点映射单一真源，行为与 v1.5.0 分散字面量逐字保真。
// 用法：node tests/unit-site-registry.mjs（收敛前跑应在「唯一性断言」上 RED，收敛后全 PASS）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SiteRegistry = require(path.join(worktreeRoot, 'src/shared/site-registry.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- T1 与 v1.5.0 字面值全等 ----------
// 站点顺序＝弹窗/共享页图标与设置页分组顺序（2026-09-11 用户定：Netflix 第二、RoyalRoad 末位；
// 2026-09-12 用户定：AppleTV 紧随 Netflix 排第三）
check('T1a CATEGORY_SOURCES 顺序与全集',
  deepEq(SiteRegistry.CATEGORY_SOURCES, ['imdb', 'netflix', 'appletv', 'steam', 'mydrama', 'reelshort', 'dramashorts', 'netshort', 'flickreels', 'goodshort', 'shortical', 'shortmax', 'dramabox', 'royalroad']),
  JSON.stringify(SiteRegistry.CATEGORY_SOURCES));
check('T1b SOURCE_NAMES 字面量（含键序）',
  deepEq(SiteRegistry.SOURCE_NAMES, { imdb: 'IMDB', netflix: 'Netflix', appletv: 'AppleTV', steam: 'Steam', mydrama: 'MyDrama', reelshort: 'ReelShort', dramashorts: 'DramaShorts', netshort: 'NetShort', flickreels: 'FlickReels', goodshort: 'GoodShort', shortical: 'Shortical', shortmax: 'ShortMax', dramabox: 'DramaBox', royalroad: 'RoyalRoad' }),
  JSON.stringify(SiteRegistry.SOURCE_NAMES));
// dramabox 有两条 host 条目，hostBySource 取**首条**＝主域 dramabox.com（弹窗「去抓取」用它挑订阅 URL）
check('T1c hostBySource 字面量（含键序）',
  deepEq(SiteRegistry.hostBySource, { imdb: 'imdb.com', netflix: 'netflix.com', appletv: 'tv.apple.com', steam: 'store.steampowered.com', mydrama: 'my-drama.com', reelshort: 'reelshort.com', dramashorts: 'dramashorts.io', netshort: 'netshort.com', flickreels: 'flickreels.net', goodshort: 'goodshort.com', shortical: 'shortical.com', shortmax: 'shorttv.live', dramabox: 'dramabox.com', royalroad: 'royalroad.com' }),
  JSON.stringify(SiteRegistry.hostBySource));

// ---------- T1e 同键多 host 的注册表不变量（v1.6.11 新引入，DramaBox 两域名） ----------
// 三条缺一即静默出错：键集不等会渲染出重复标签；同键异名会让显示名取决于遍历顺序
{
  const siteKeys = SiteRegistry.SITES.map(e => e.site);
  check('T1e CATEGORY_SOURCES 是 SITES 站点键的去重序列（同键多 host 只算一次）',
    deepEq(SiteRegistry.CATEGORY_SOURCES, [...new Set(siteKeys)]), JSON.stringify(SiteRegistry.CATEGORY_SOURCES));
  const nameConflicts = SiteRegistry.SITES.filter(e => e.name !== SiteRegistry.SOURCE_NAMES[e.site]);
  check('T1e2 同一 site 键的各条 host 条目 name 必须一致',
    nameConflicts.length === 0, JSON.stringify(nameConflicts));
  const dupKeys = [...new Set(siteKeys.filter((s, i) => siteKeys.indexOf(s) !== i))];
  check('T1e3 当前仅 dramabox 一个键挂多 host（新增多域名站点时须一并更新本断言）',
    deepEq(dupKeys, ['dramabox']), JSON.stringify(dupKeys));
  check('T1e4 dramabox 的两条 host 互不为后缀（顺序不影响 siteOfHostname 判定）',
    !'www.dramaboxdb.com'.endsWith('dramabox.com') && !'www.dramabox.com'.endsWith('dramaboxdb.com'), '');
}

// settings.js 派生的订阅分组（label===tag、icon 按 site 命名）。
// v1.5.11 起顺序改由 SITE_GROUPS 决定（短剧组在最前），与弹窗头部折叠分组一致
const derivedGroups = SiteRegistry.SITE_GROUPS.flatMap(group => group.sites).map(site => ({
  site, label: SiteRegistry.SOURCE_NAMES[site], tag: SiteRegistry.SOURCE_NAMES[site], icon: `assets/icons/site-${site}.png`
}));
const expectedGroups = [
  { site: 'mydrama', label: 'MyDrama', tag: 'MyDrama', icon: 'assets/icons/site-mydrama.png' },
  { site: 'reelshort', label: 'ReelShort', tag: 'ReelShort', icon: 'assets/icons/site-reelshort.png' },
  { site: 'dramashorts', label: 'DramaShorts', tag: 'DramaShorts', icon: 'assets/icons/site-dramashorts.png' },
  { site: 'netshort', label: 'NetShort', tag: 'NetShort', icon: 'assets/icons/site-netshort.png' },
  { site: 'flickreels', label: 'FlickReels', tag: 'FlickReels', icon: 'assets/icons/site-flickreels.png' },
  { site: 'goodshort', label: 'GoodShort', tag: 'GoodShort', icon: 'assets/icons/site-goodshort.png' },
  { site: 'shortical', label: 'Shortical', tag: 'Shortical', icon: 'assets/icons/site-shortical.png' },
  { site: 'shortmax', label: 'ShortMax', tag: 'ShortMax', icon: 'assets/icons/site-shortmax.png' },
  { site: 'dramabox', label: 'DramaBox', tag: 'DramaBox', icon: 'assets/icons/site-dramabox.png' },
  { site: 'imdb', label: 'IMDB', tag: 'IMDB', icon: 'assets/icons/site-imdb.png' },
  { site: 'netflix', label: 'Netflix', tag: 'Netflix', icon: 'assets/icons/site-netflix.png' },
  { site: 'appletv', label: 'AppleTV', tag: 'AppleTV', icon: 'assets/icons/site-appletv.png' },
  { site: 'steam', label: 'Steam', tag: 'Steam', icon: 'assets/icons/site-steam.png' },
  { site: 'royalroad', label: 'RoyalRoad', tag: 'RoyalRoad', icon: 'assets/icons/site-royalroad.png' }
];
check('T1d 设置页订阅分组派生结果（按 SITE_GROUPS 顺序）', deepEq(derivedGroups, expectedGroups), JSON.stringify(derivedGroups));

// ---------- T2 匹配行为矩阵（含历史怪癖保真） ----------
const cases = [
  ['https://www.imdb.com/chart/tv/', 'imdb'],
  ['https://store.steampowered.com/category/casual', 'steam'],
  ['https://www.royalroad.com/fictions/trending', 'royalroad'],
  ['https://my-drama.com/?list=best_choices', 'mydrama'],
  ['https://www.reelshort.com/', 'reelshort'],
  ['https://dramashorts.io/top-movies', 'dramashorts'],
  ['https://www.netshort.com/?list=trending_now', 'netshort'],
  ['https://www.flickreels.net/?list=hot_picks', 'flickreels'],
  ['https://flickreels.net/', 'flickreels'],              // 裸域（站点会 301 到 www，归属仍按 suffix 命中）
  ['https://www.flickreels.net/tc/', 'flickreels'],       // 归属按 host，路径闸门在 adapter.matches
  // 三站的规范 URL 形态各不相同（实测：goodshort/shorttv 裸域 301 到 www，shortical 反过来 www 301 到裸域）。
  // suffix 语义对两种形态都命中，闸门在 adapter.matches；订阅 URL 写错 www 会静默零抓取，由 T8 单独守
  ['https://www.goodshort.com/channel/Most-Trending', 'goodshort'],
  ['https://goodshort.com/drama/x-31001719124', 'goodshort'],
  ['https://shortical.com/?list=top_recommended', 'shortical'],
  ['https://shortical.com/drama/room-service-193', 'shortical'],  // 归属按 host，路径闸门在 adapter.matches
  ['https://www.shorttv.live/?list=most_popular', 'shortmax'],
  ['https://www.shorttv.live/fandom', 'shortmax'],
  // DramaBox 一键两域名：两站都归 dramabox（两站板块内容各自独立编排，合并成一个来源）。
  // 两站裸域都 301 到 www，故订阅须带 www——suffix 语义对两种形态都命中，闸门在 adapter.matches
  ['https://www.dramabox.com/more/must-sees', 'dramabox'],
  ['https://www.dramabox.com/more/trending', 'dramabox'],
  ['https://www.dramaboxdb.com/channel/must-sees', 'dramabox'],
  ['https://www.dramaboxdb.com/channel/trending', 'dramabox'],
  ['https://dramabox.com/', 'dramabox'],                  // 裸域（301 到 www，归属仍按 suffix 命中）
  ['https://www.dramabox.com/drama/42000024547/X', 'dramabox'],   // 归属按 host，路径闸门在 adapter.matches
  ['https://thwztchapter.dramaboxdb.com/data/x.jpg', 'dramabox'], // 封面 CDN 同后缀；siteOfUrl 只作用于订阅 URL，无影响
  ['https://www.netflix.com/tudum/top10/united-states/tv', 'netflix'],
  ['https://www.netflix.com/browse', 'netflix'],         // 站点归属仍按 host（注入范围由 path 另管）
  ['https://tv.apple.com/us/collection/most-popular-now/uts.col.ChartsShows.tvs.sbd.4000', 'appletv'],
  ['https://tv.apple.com/us/show/ted-lasso/umc.cmc.x', 'appletv'], // 归属按 host，注入范围由 path 另管
  ['https://www.apple.com/tv/', null],                  // apple 其它子域不命中（exact 语义）
  ['https://music.apple.com/us/browse', null],
  ['https://steamcommunity.com/app/1', null],           // steam 社区子域不命中（exact 语义）
  ['https://help.steampowered.com/', null],             // 非商店子域不命中
  ['https://notimdb.com/x', 'imdb'],                    // 裸 endsWith 历史怪癖，保真保留
  ['not a url', null],
  ['', null]
];
for (const [url, expected] of cases) {
  const got = SiteRegistry.siteOfUrl(url);
  check(`T2 siteOfUrl(${url || '空串'}) = ${expected}`, got === expected, `got=${got}`);
}
check('T2x siteOfHostname 直入 hostname', SiteRegistry.siteOfHostname('www.dramashorts.io') === 'dramashorts', '');

// ---------- T3 收敛唯一性：映射特征只允许出现在 site-registry.js ----------
// 探针一：hostname if 链特征 endsWith('imdb.com')；探针二：显示名对象字面量特征 imdb: 'IMDB'。
// 注意 content.js 中 Steam 适配器的 API/详情页 URL 构造字面量（store.steampowered.com）
// 是业务端点非映射，不在收敛范围。
const filesToScan = [
  'src/background/background.js', 'src/content/content.js', 'src/popup/popup.js',
  'src/settings/settings.js', 'src/shared/timeline-render.js', 'src/shared/lark.js'
];
for (const rel of filesToScan) {
  const src = fs.readFileSync(path.join(worktreeRoot, rel), 'utf8');
  check(`T3 ${rel} 无 hostname if 链映射残留`, !src.includes("endsWith('imdb.com')"), '');
  check(`T3 ${rel} 无显示名字面量映射残留`, !src.includes("imdb: 'IMDB'"), '');
}

// ---------- T4 接线静态断言 ----------
const manifest = JSON.parse(fs.readFileSync(path.join(worktreeRoot, 'manifest.json'), 'utf8'));
// content.js 依赖的共享模块清单（v1.6.2 起含 translate-config：Steam 官方中文
// 采用判据 hasChineseChars 在那里）。manifest 注入与后台强制注入必须逐字一致——
// 兜底注入路径漏一个模块＝content.js 直接 ReferenceError，而那条路径正是后台
// 节流标签页的常态入口
const CONTENT_SCRIPT_FILES = ['src/shared/site-registry.js', 'src/shared/translate-config.js', 'src/content/content.js'];
check('T4a manifest content_scripts js 数组前置共享模块',
  deepEq(manifest.content_scripts[0].js, CONTENT_SCRIPT_FILES),
  JSON.stringify(manifest.content_scripts[0].js));
const bgSrc = fs.readFileSync(path.join(worktreeRoot, 'src/background/background.js'), 'utf8');
check('T4b 强制注入 files 数组与 manifest 逐字一致',
  bgSrc.includes(`files: [${CONTENT_SCRIPT_FILES.map(f => `'${f}'`).join(', ')}]`), '');
check('T4c 后台 importScripts 含 site-registry', bgSrc.includes("importScripts('../shared/site-registry.js')"), '');
for (const [rel, needle] of [
  ['src/popup/popup.html', '../shared/site-registry.js'],
  ['src/settings/settings.html', '../shared/site-registry.js'],
  ['server/public/share.html', '/shared/site-registry.js']
]) {
  const html = fs.readFileSync(path.join(worktreeRoot, rel), 'utf8');
  check(`T4d ${rel} 已引入 site-registry`, html.includes(`src="${needle}"`), '');
}
const serverSrc = fs.readFileSync(path.join(worktreeRoot, 'server/sync-server.js'), 'utf8');
check('T4e 共享页静态白名单含 site-registry', serverSrc.includes("'/shared/site-registry.js'"), '');

// 标题文案单一真源（v1.6.2）：timeline-render.js 在**模块加载时**就取
// TranslateConfig.titleDisplay，排在它后面＝弹窗/共享页加载即 TypeError 白屏。
// 顺序断言必须逐页做，只查「引入了」拦不住这个坑
for (const [rel, prefix] of [
  ['src/popup/popup.html', '../shared/'],
  ['server/public/share.html', '/shared/']
]) {
  const html = fs.readFileSync(path.join(worktreeRoot, rel), 'utf8');
  const at = needle => html.indexOf(`src="${prefix}${needle}"`);
  const cfgAt = at('translate-config.js'), renderAt = at('timeline-render.js');
  check(`T4i ${rel} 的 translate-config 排在 timeline-render 之前`,
    cfgAt >= 0 && renderAt >= 0 && cfgAt < renderAt, `cfg=${cfgAt} render=${renderAt}`);
}
check('T4j 共享页静态白名单含 translate-config', serverSrc.includes("'/shared/translate-config.js'"), '');

// lark.js 在**模块求值时**就取 SiteRegistry.SOURCE_NAMES / TranslateConfig.titleDisplay / TimelineCsv
// （lark.js:42-55），排在它们前面＝设置页加载即白屏、后台 SW 启动即 ReferenceError。只有设置页与后台
// 加载它，两处加载序都要逐个守（2026-09-17 审计 H4：此前顺序对但零测试）
{
  const LARK_DEPS = ['site-registry.js', 'timeline-csv.js', 'translate-config.js'];
  const settingsHtml = fs.readFileSync(path.join(worktreeRoot, 'src/settings/settings.html'), 'utf8');
  const htmlAt = needle => settingsHtml.indexOf(`src="../shared/${needle}"`);
  const htmlLarkAt = htmlAt('lark.js');
  check('T4k settings.html 里 site-registry / timeline-csv / translate-config 都排在 lark 之前',
    htmlLarkAt >= 0 && LARK_DEPS.every(n => htmlAt(n) >= 0 && htmlAt(n) < htmlLarkAt),
    `lark=${htmlLarkAt} deps=${JSON.stringify(LARK_DEPS.map(htmlAt))}`);
  const bgAt = needle => bgSrc.indexOf(`importScripts('../shared/${needle}')`);
  const bgLarkAt = bgAt('lark.js');
  check('T4l 后台 importScripts 里 site-registry / timeline-csv / translate-config 都排在 lark 之前',
    bgLarkAt >= 0 && LARK_DEPS.every(n => bgAt(n) >= 0 && bgAt(n) < bgLarkAt),
    `lark=${bgLarkAt} deps=${JSON.stringify(LARK_DEPS.map(bgAt))}`);
}

// ---------- T7 content.js 适配器注册表 ≡ 站点全集 ----------
// ADAPTERS 是手写映射；注册表加了站点却漏写适配器＝scrapePage 查不到 adapter 只 log 一句、静默零抓取
// （与 FlickReels「订阅漏 www → 静默零抓取」同一失败类别，2026-09-17 审计 H5）
{
  const contentSrc = fs.readFileSync(path.join(worktreeRoot, 'src/content/content.js'), 'utf8');
  const m = contentSrc.match(/const ADAPTERS = \{([^}]*)\}/);
  const keys = m ? m[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean) : [];
  check('T7 content.js ADAPTERS 键集与 CATEGORY_SOURCES 全集一致',
    keys.length > 0 && deepEq([...keys].sort(), [...SiteRegistry.CATEGORY_SOURCES].sort()), JSON.stringify(keys));
}

// 折叠标签条（v1.5.11）：弹窗与共享页共用 site-tabs.js，且都不再手写站点按钮
for (const [rel, needle] of [
  ['src/popup/popup.html', '../shared/site-tabs.js'],
  ['server/public/share.html', '/shared/site-tabs.js']
]) {
  const html = fs.readFileSync(path.join(worktreeRoot, rel), 'utf8');
  check(`T4f ${rel} 已引入 site-tabs`, html.includes(`src="${needle}"`), '');
  check(`T4g ${rel} 无手写站点按钮残留`, !html.includes('class="category-tab"'), '');
}
check('T4h 共享页静态白名单含 site-tabs', serverSrc.includes("'/shared/site-tabs.js'"), '');

// ---------- T6 manifest matches 推导：可选 path 字段限定注入路径 ----------
// Netflix 只注入 /tudum/top10*；AppleTV 只注入两个榜单 collection 页所在路径，
// 且 exact 语义下无 *. 前缀（不波及 apple.com 其它子域）。
// DramaBox 贡献两项（同一 site 键的两条 host 条目逐条展开），故项数比站点数多一
check('T6 contentScriptMatches 按站点顺序：host 通配项 + Netflix/AppleTV 路径限定项 + DramaBox 两域名',
  deepEq(SiteRegistry.contentScriptMatches(), [
    '*://*.imdb.com/*', '*://*.netflix.com/tudum/top10*', '*://tv.apple.com/us/collection/most-popular-now/*',
    '*://store.steampowered.com/*', '*://*.my-drama.com/*',
    '*://*.reelshort.com/*', '*://*.dramashorts.io/*', '*://*.netshort.com/*', '*://*.flickreels.net/*',
    '*://*.goodshort.com/*', '*://*.shortical.com/*', '*://*.shorttv.live/*',
    '*://*.dramabox.com/*', '*://*.dramaboxdb.com/*', '*://*.royalroad.com/*'
  ]),
  JSON.stringify(SiteRegistry.contentScriptMatches()));

// ---------- T5 Node 侧消费契约（lark 经 require 间接取数） ----------
const Lark = require(path.join(worktreeRoot, 'src/shared/lark.js'));
check('T5 Lark.SOURCE_NAMES 契约保留且同源', deepEq(Lark.SOURCE_NAMES, SiteRegistry.SOURCE_NAMES), '');

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
