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
const UrlMatch = require(path.join(worktreeRoot, 'src/shared/url-match.js'));
const SubscriptionConfig = require(path.join(worktreeRoot, 'src/shared/subscription-config.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- T1 与 v1.5.0 字面值全等 ----------
// 站点顺序＝弹窗/共享页图标与设置页分组顺序（2026-09-11 用户定：Netflix 第二、RoyalRoad 末位；
// 2026-09-12 用户定：AppleTV 紧随 Netflix 排第三；2026-09-27：Higgsfield 紧随 AppleTV，同在影视组）
check('T1a CATEGORY_SOURCES 顺序与全集',
  deepEq(SiteRegistry.CATEGORY_SOURCES, ['imdb', 'netflix', 'appletv', 'higgsfield', 'steam', 'mydrama', 'reelshort', 'dramashorts', 'netshort', 'flickreels', 'goodshort', 'shortical', 'shortmax', 'dramabox', 'royalroad', 'pinedrama']),
  JSON.stringify(SiteRegistry.CATEGORY_SOURCES));
check('T1b SOURCE_NAMES 字面量（含键序）',
  deepEq(SiteRegistry.SOURCE_NAMES, { imdb: 'IMDB', netflix: 'Netflix', appletv: 'AppleTV', higgsfield: 'Higgsfield', steam: 'Steam', mydrama: 'MyDrama', reelshort: 'ReelShort', dramashorts: 'DramaShorts', netshort: 'NetShort', flickreels: 'FlickReels', goodshort: 'GoodShort', shortical: 'Shortical', shortmax: 'ShortMax', dramabox: 'DramaBox', royalroad: 'RoyalRoad', pinedrama: 'PinesDramas' }),
  JSON.stringify(SiteRegistry.SOURCE_NAMES));
// hostBySource（站点→主域）只剩测试在用，弹窗「去抓取」早已改用 siteOfUrl 按域名归类：v1.7.0 删导出
check('T1c 无人使用的 hostBySource 导出已删', !('hostBySource' in SiteRegistry), JSON.stringify(Object.keys(SiteRegistry)));

// ---------- T1s 卡片归属站点 siteOfDrama（v1.7.0 收拢 timeline-render 的 dramaSource 与 sync-server 的副本） ----------
check('T1s siteOfDrama：站点全集里的 source 原样，注册表外 / 缺失的归 imdb（source 字段出现前只有 IMDB）',
  SiteRegistry.siteOfDrama({ source: 'dramabox' }) === 'dramabox' && SiteRegistry.siteOfDrama({ source: 'pinedrama' }) === 'pinedrama'
    && SiteRegistry.siteOfDrama({ source: 'unittest' }) === 'imdb' && SiteRegistry.siteOfDrama({}) === 'imdb'
    && SiteRegistry.siteOfDrama(null) === 'imdb', '');

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
  { site: 'higgsfield', label: 'Higgsfield', tag: 'Higgsfield', icon: 'assets/icons/site-higgsfield.png' },
  { site: 'steam', label: 'Steam', tag: 'Steam', icon: 'assets/icons/site-steam.png' },
  { site: 'royalroad', label: 'RoyalRoad', tag: 'RoyalRoad', icon: 'assets/icons/site-royalroad.png' },
  { site: 'pinedrama', label: 'PinesDramas', tag: 'PinesDramas', icon: 'assets/icons/site-pinedrama.png' }
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
// 采用判据 hasChineseChars 在那里；v1.6.18 起含 scrape-rules：与后台共用的采集口径；
// 其后含 url-match：订阅判定 matchSubscription 与三端归属过滤共用）。manifest 注入与后台强制注入必须逐字一致——
// 兜底注入路径漏一个模块＝content.js 直接 ReferenceError，而那条路径正是后台
// 节流标签页的常态入口
const CONTENT_SCRIPT_FILES = ['src/shared/site-registry.js', 'src/shared/translate-config.js', 'src/shared/scrape-rules.js', 'src/shared/url-match.js', 'src/content/content.js'];
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

// lark.js 在**模块求值时**就取 SiteRegistry.SOURCE_NAMES / TranslateConfig.titleDisplay / TimelineCsv /
// FetchUtil（lark.js 顶部依赖区），排在它们前面＝设置页加载即白屏、后台 SW 启动即 ReferenceError。只有设置页
// 与后台加载它，两处加载序都要逐个守（2026-09-17 审计 H4：此前顺序对但零测试；fetch-util 为 v1.7.0 新增）
{
  const LARK_DEPS = ['site-registry.js', 'timeline-csv.js', 'translate-config.js', 'fetch-util.js'];
  const settingsHtml = fs.readFileSync(path.join(worktreeRoot, 'src/settings/settings.html'), 'utf8');
  const htmlAt = needle => settingsHtml.indexOf(`src="../shared/${needle}"`);
  const htmlLarkAt = htmlAt('lark.js');
  check('T4k settings.html 里 site-registry / timeline-csv / translate-config / fetch-util 都排在 lark 之前',
    htmlLarkAt >= 0 && LARK_DEPS.every(n => htmlAt(n) >= 0 && htmlAt(n) < htmlLarkAt),
    `lark=${htmlLarkAt} deps=${JSON.stringify(LARK_DEPS.map(htmlAt))}`);
  const bgAt = needle => bgSrc.indexOf(`importScripts('../shared/${needle}')`);
  const bgLarkAt = bgAt('lark.js');
  check('T4l 后台 importScripts 里 site-registry / timeline-csv / translate-config / fetch-util 都排在 lark 之前',
    bgLarkAt >= 0 && LARK_DEPS.every(n => bgAt(n) >= 0 && bgAt(n) < bgLarkAt),
    `lark=${bgLarkAt} deps=${JSON.stringify(LARK_DEPS.map(bgAt))}`);
  // translator.js 同样在求值时取 FetchUtil（与 TranslateConfig 并列），它只由后台加载
  const bgTranslatorAt = bgAt('translator.js');
  check('T4m 后台 importScripts 里 fetch-util 与 translate-config 都排在 translator 之前',
    bgTranslatorAt >= 0 && ['fetch-util.js', 'translate-config.js'].every(n => bgAt(n) >= 0 && bgAt(n) < bgTranslatorAt),
    `translator=${bgTranslatorAt} fetch-util=${bgAt('fetch-util.js')} translate-config=${bgAt('translate-config.js')}`);
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
// IMDB / Steam / RoyalRoad 收窄到 adapter.matches 认的订阅入口（2026-09-25 审查
// manifest-overbroad-injection），IMDB 与 Steam 的 path 是数组、各展开两项；
// DramaBox 贡献两项（同一 site 键的两条 host 条目逐条展开）；Higgsfield 只注入 /community/originals*（v1.7.2，
// exact 语义同 AppleTV，只认裸域 higgsfield.ai）
check('T6 contentScriptMatches 按站点顺序：路径限定项（IMDB/Steam 各两项）+ 短剧站整站 + DramaBox 两域名',
  deepEq(SiteRegistry.contentScriptMatches(), [
    '*://*.imdb.com/search/title*', '*://*.imdb.com/find*',
    '*://*.netflix.com/tudum/top10*', '*://tv.apple.com/us/collection/most-popular-now/*',
    '*://higgsfield.ai/community/originals*',
    '*://store.steampowered.com/category/*', '*://store.steampowered.com/tags/*', '*://*.my-drama.com/*',
    '*://*.reelshort.com/*', '*://*.dramashorts.io/*', '*://*.netshort.com/*', '*://*.flickreels.net/*',
    '*://*.goodshort.com/*', '*://*.shortical.com/*', '*://*.shorttv.live/*',
    '*://*.dramabox.com/*', '*://*.dramaboxdb.com/*', '*://*.royalroad.com/fictions/*', '*://*.pinedrama.com/*'
  ]),
  JSON.stringify(SiteRegistry.contentScriptMatches()));

// ---------- T6b 收窄后每个订阅 URL 仍被 manifest 注入 ----------
// 按 Chrome 匹配模式语义逐条核对：scheme '*' 只认 http/https；'*.host' 含裸域与任意子域；
// 路径段连查询串一起匹配（'/search/title*' 要能吃下 '/search/title/?release_date=…'）。
// tag.example.json 即设置页的订阅目录（SUBSCRIPTION_CATALOG_FILE），用户能勾选的订阅全在里面；
// README 的示例订阅也一并核对。漏匹配＝该订阅页不再自动注入、浮动按钮消失，后台只能走兜底注入
function matchesPattern(pattern, url) {
  const m = pattern.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/);
  if (!m) return false;
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  const scheme = u.protocol.slice(0, -1);
  if (m[1] === '*' ? !['http', 'https'].includes(scheme) : scheme !== m[1]) return false;
  if (m[2].startsWith('*.')) {
    const base = m[2].slice(2);
    if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return false;
  } else if (u.hostname !== m[2]) {
    return false;
  }
  const escaped = m[3].split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(u.pathname + u.search);
}
const injected = url => SiteRegistry.contentScriptMatches().some(p => matchesPattern(p, url));
{
  const catalog = JSON.parse(fs.readFileSync(path.join(worktreeRoot, 'config/tag.example.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(worktreeRoot, 'README.md'), 'utf8');
  const readmeUrls = [...readme.matchAll(/"url":\s*"([^"]+)"/g)].map(m => m[1]);
  const urls = [...catalog.map(entry => entry.url), ...readmeUrls];
  const narrowed = urls.filter(url => ['imdb', 'steam', 'royalroad'].includes(SiteRegistry.siteOfUrl(url)));
  check('T6b0 订阅目录里 IMDB / Steam / RoyalRoad 三站都有订阅（防本断言空转）',
    ['imdb', 'steam', 'royalroad'].every(site => narrowed.some(url => SiteRegistry.siteOfUrl(url) === site))
      && readmeUrls.length >= 2,
    `narrowed=${narrowed.length} readme=${readmeUrls.length}`);
  const missed = urls.filter(url => !injected(url));
  check('T6b 订阅目录与 README 示例的每个订阅 URL 都被 manifest matches 命中',
    urls.length > 0 && missed.length === 0, JSON.stringify(missed));
}

// ---------- T6c 路径收窄站点（IMDB / Steam / RoyalRoad / Higgsfield）的非订阅页不注入；自测匹配器语义 ----------
for (const [url, expected] of [
  ['https://www.imdb.com/find/?q=drama', true],
  ['https://m.imdb.com/search/title/?genres=short', true],
  ['https://store.steampowered.com/tags/zh-cn/%E5%85%A8%E5%8A%A8%E6%80%81%E5%BD%B1%E5%83%8F/', true],
  ['https://www.royalroad.com/fictions/best-rated', true],
  ['https://www.imdb.com/', false],
  ['https://www.imdb.com/title/tt0111161/', false],
  ['https://www.imdb.com/chart/top/', false],
  ['https://store.steampowered.com/', false],
  ['https://store.steampowered.com/app/570/', false],
  ['https://www.royalroad.com/home', false],
  ['https://www.royalroad.com/fiction/12345/some-title', false],
  // Higgsfield（v1.7.2）：整站是 AI 生成工具，只注入订阅页；?list= 连查询串一起匹配
  ['https://higgsfield.ai/community/originals?list=first_look', true],
  ['https://higgsfield.ai/community/originals', true],
  ['https://higgsfield.ai/', false],
  ['https://higgsfield.ai/ai/video', false],
  ['https://higgsfield.ai/community/projects', false],
  ['https://higgsfield.ai/original-series/mork/episode-1', false],
  ['https://www.higgsfield.ai/community/originals?list=first_look', false],
  // 匹配器自身语义：查询串参与路径匹配、裸域命中 *.、scheme 只认 http(s)
  ['https://www.flickreels.net/?list=hot_picks', true],
  ['https://imdb.com/search/title/', true],
  ['ftp://www.imdb.com/search/title/', false]
]) {
  check(`T6c ${url} ${expected ? '注入' : '不注入'}`, injected(url) === expected, `got=${injected(url)}`);
}

// ---------- T6d 强制注入闸门 isInjectableUrl：点边界匹配，不继承 siteOfHostname 的裸 endsWith 怪癖 ----------
for (const [url, expected] of [
  ['https://www.imdb.com/search/title/', true],
  ['https://imdb.com/find?q=x', true],
  ['https://m.imdb.com/x', true],
  ['https://notimdb.com/x', false],                  // siteOfUrl 仍判 imdb（T2 怪癖），注入闸门不放行
  ['https://fakeimdb.com.evil.test/x', false],
  ['https://store.steampowered.com/category/x', true],
  ['https://evil.store.steampowered.com/x', false],  // exact 条目不认子域
  ['https://www.dramaboxdb.com/x', true],
  ['https://mydramabox.com/x', false],
  ['ftp://www.imdb.com/x', false],
  ['not a url', false]
]) {
  check(`T6d isInjectableUrl ${url} → ${expected}`, SiteRegistry.isInjectableUrl(url) === expected,
    `got=${SiteRegistry.isInjectableUrl(url)}`);
}
check('T6d notimdb.com 站点归属怪癖保真', SiteRegistry.siteOfUrl('https://notimdb.com/x') === 'imdb', '');
{
  const catalog = JSON.parse(fs.readFileSync(path.join(worktreeRoot, 'config/tag.example.json'), 'utf8'));
  const blocked = catalog.map(entry => entry.url).filter(url => !SiteRegistry.isInjectableUrl(url));
  check('T6d 订阅目录的每个 URL 都能走强制注入兜底', catalog.length > 0 && blocked.length === 0, blocked.join(', '));
}

// ---------- T8 订阅目录守卫（审查 missing-guard-tests） ----------
// manifest matches 是 '*.host' 形态，裸域与 www 都会命中，T6b 守不住 README 强调的域名形态：
// 这几站跳转后 location.href 与订阅串不等 → 静默零抓取，npm test 却全过、要到用户那边才暴露
{
  const catalog = JSON.parse(fs.readFileSync(path.join(worktreeRoot, 'config/tag.example.json'), 'utf8'));
  const unmapped = catalog.filter(entry => !SiteRegistry.siteOfUrl(entry.url)).map(entry => entry.url);
  check('T8a 订阅目录每条都能映射到站点', catalog.length > 0 && unmapped.length === 0, JSON.stringify(unmapped));

  // 照抄 README「各站的域名形态并不一致」那段：带 www. 的四站与必须裸域的三站（站点 301 方向各不相同）
  const HOST_FORM = { flickreels: 'www', goodshort: 'www', shortmax: 'www', dramabox: 'www', shortical: 'bare', pinedrama: 'bare', higgsfield: 'bare' };
  const wrongForm = catalog.filter(entry => {
    const form = HOST_FORM[SiteRegistry.siteOfUrl(entry.url)];
    if (!form) return false;
    const www = new URL(entry.url).hostname.startsWith('www.');
    return form === 'www' ? !www : www;
  }).map(entry => entry.url);
  const covered = Object.keys(HOST_FORM).filter(site => catalog.some(entry => SiteRegistry.siteOfUrl(entry.url) === site));
  check('T8b 域名形态：FlickReels / GoodShort / ShortMax / DramaBox 带 www.，Shortical / PinesDramas / Higgsfield 不带',
    wrongForm.length === 0 && covered.length === Object.keys(HOST_FORM).length,
    JSON.stringify({ wrongForm, covered }));

  const byKey = new Map();
  const dups = [];
  for (const entry of catalog) {
    const key = UrlMatch.normalizeListUrl(entry.url);
    if (byKey.has(key)) dups.push([byKey.get(key), entry.url]);
    else byKey.set(key, entry.url);
  }
  check('T8c 按 UrlMatch.normalizeListUrl（尾斜杠归一）不重复', dups.length === 0, JSON.stringify(dups));

  const badTags = catalog.filter(entry => !Array.isArray(entry.tags) || entry.tags.length < 1 || entry.tags.length > 3
    || entry.tags.some(tag => typeof tag !== 'string' || !tag.trim())).map(entry => [entry.url, entry.tags]);
  check('T8d 每条 tags 是 1~3 个非空字符串', badTags.length === 0, JSON.stringify(badTags));
  check('T8e SubscriptionConfig.normalizeUrlTags 不丢任何一条（形状合法、无隐性重复）',
    SubscriptionConfig.normalizeUrlTags(catalog).length === catalog.length,
    `${SubscriptionConfig.normalizeUrlTags(catalog).length} / ${catalog.length}`);

  // 每条订阅作为页面地址时命中的就是它自己（matchSubscription 精确轮），不被别的订阅抢走
  const urlTags = SubscriptionConfig.normalizeUrlTags(catalog);
  const stolen = urlTags.filter(sub => UrlMatch.matchSubscription(sub.urlPattern, urlTags) !== sub).map(sub => sub.urlPattern);
  check('T8f 每条订阅页都命中自己那条订阅', stolen.length === 0, JSON.stringify(stolen));

  const pkg = JSON.parse(fs.readFileSync(path.join(worktreeRoot, 'package.json'), 'utf8'));
  check('T8g manifest.json 与 package.json 版本号一致', typeof manifest.version === 'string' && manifest.version === pkg.version,
    JSON.stringify({ manifest: manifest.version, package: pkg.version }));
}

// ---------- T5 Node 侧消费契约（lark 经 require 间接取数） ----------
const Lark = require(path.join(worktreeRoot, 'src/shared/lark.js'));
// 转手导出的 Lark.SOURCE_NAMES 已删（v1.7.0）；buildPayload 的 source_name 仍取自注册表
check('T5 lark 不再转手导出 SOURCE_NAMES，source_name 照旧取自注册表',
  !('SOURCE_NAMES' in Lark) && Lark.buildPayload({ source: 'dramabox', title: 't' }).source_name === SiteRegistry.SOURCE_NAMES.dramabox,
  JSON.stringify(Lark.buildPayload({ source: 'dramabox', title: 't' }).source_name));

// ---------- T9 siteOfDrama 的接线：共享页 / 弹窗标签与同步服务分站点告警都走注册表那一份 ----------
{
  const renderSrc = fs.readFileSync(path.join(worktreeRoot, 'src/shared/timeline-render.js'), 'utf8');
  const serverSrcT9 = fs.readFileSync(path.join(worktreeRoot, 'server/sync-server.js'), 'utf8');
  check('T9 timeline-render 的 dramaSource 与同步服务都委托 SiteRegistry.siteOfDrama（不再各写一份）',
    /SiteRegistry\.siteOfDrama\(/.test(renderSrc) && !/function dramaSource\(/.test(renderSrc)
      && /SiteRegistry\.siteOfDrama\(/.test(serverSrcT9) && !/function siteOfDrama\(/.test(serverSrcT9), '');
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
