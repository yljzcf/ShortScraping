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
  deepEq(SiteRegistry.CATEGORY_SOURCES, ['imdb', 'netflix', 'appletv', 'steam', 'mydrama', 'reelshort', 'dramashorts', 'netshort', 'royalroad']),
  JSON.stringify(SiteRegistry.CATEGORY_SOURCES));
check('T1b SOURCE_NAMES 字面量（含键序）',
  deepEq(SiteRegistry.SOURCE_NAMES, { imdb: 'IMDB', netflix: 'Netflix', appletv: 'AppleTV', steam: 'Steam', mydrama: 'MyDrama', reelshort: 'ReelShort', dramashorts: 'DramaShorts', netshort: 'NetShort', royalroad: 'RoyalRoad' }),
  JSON.stringify(SiteRegistry.SOURCE_NAMES));
check('T1c hostBySource 字面量（含键序）',
  deepEq(SiteRegistry.hostBySource, { imdb: 'imdb.com', netflix: 'netflix.com', appletv: 'tv.apple.com', steam: 'store.steampowered.com', mydrama: 'my-drama.com', reelshort: 'reelshort.com', dramashorts: 'dramashorts.io', netshort: 'netshort.com', royalroad: 'royalroad.com' }),
  JSON.stringify(SiteRegistry.hostBySource));

// settings.js 派生的订阅分组与旧字面量 deep-equal（label===tag、icon 按 site 命名）
const derivedGroups = SiteRegistry.CATEGORY_SOURCES.map(site => ({
  site, label: SiteRegistry.SOURCE_NAMES[site], tag: SiteRegistry.SOURCE_NAMES[site], icon: `assets/icons/site-${site}.png`
}));
const legacyGroups = [
  { site: 'imdb', label: 'IMDB', tag: 'IMDB', icon: 'assets/icons/site-imdb.png' },
  { site: 'netflix', label: 'Netflix', tag: 'Netflix', icon: 'assets/icons/site-netflix.png' },
  { site: 'appletv', label: 'AppleTV', tag: 'AppleTV', icon: 'assets/icons/site-appletv.png' },
  { site: 'steam', label: 'Steam', tag: 'Steam', icon: 'assets/icons/site-steam.png' },
  { site: 'mydrama', label: 'MyDrama', tag: 'MyDrama', icon: 'assets/icons/site-mydrama.png' },
  { site: 'reelshort', label: 'ReelShort', tag: 'ReelShort', icon: 'assets/icons/site-reelshort.png' },
  { site: 'dramashorts', label: 'DramaShorts', tag: 'DramaShorts', icon: 'assets/icons/site-dramashorts.png' },
  { site: 'netshort', label: 'NetShort', tag: 'NetShort', icon: 'assets/icons/site-netshort.png' },
  { site: 'royalroad', label: 'RoyalRoad', tag: 'RoyalRoad', icon: 'assets/icons/site-royalroad.png' }
];
check('T1d 设置页订阅分组派生结果与旧字面量全等', deepEq(derivedGroups, legacyGroups), JSON.stringify(derivedGroups));

// ---------- T2 匹配行为矩阵（含历史怪癖保真） ----------
const cases = [
  ['https://www.imdb.com/chart/tv/', 'imdb'],
  ['https://store.steampowered.com/category/casual', 'steam'],
  ['https://www.royalroad.com/fictions/trending', 'royalroad'],
  ['https://my-drama.com/?list=best_choices', 'mydrama'],
  ['https://www.reelshort.com/', 'reelshort'],
  ['https://dramashorts.io/top-movies', 'dramashorts'],
  ['https://www.netshort.com/?list=trending_now', 'netshort'],
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
check('T4a manifest content_scripts js 数组前置 site-registry',
  deepEq(manifest.content_scripts[0].js, ['src/shared/site-registry.js', 'src/content/content.js']),
  JSON.stringify(manifest.content_scripts[0].js));
const bgSrc = fs.readFileSync(path.join(worktreeRoot, 'src/background/background.js'), 'utf8');
check('T4b 强制注入 files 数组含 site-registry',
  /files:\s*\['src\/shared\/site-registry\.js',\s*'src\/content\/content\.js'\]/.test(bgSrc), '');
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

// ---------- T6 manifest matches 推导：可选 path 字段限定注入路径 ----------
// Netflix 只注入 /tudum/top10*；AppleTV 只注入两个榜单 collection 页所在路径，
// 且 exact 语义下无 *. 前缀（不波及 apple.com 其它子域）。
check('T6 contentScriptMatches 按站点顺序：host 通配七项 + Netflix/AppleTV 路径限定项',
  deepEq(SiteRegistry.contentScriptMatches(), [
    '*://*.imdb.com/*', '*://*.netflix.com/tudum/top10*', '*://tv.apple.com/us/collection/most-popular-now/*',
    '*://store.steampowered.com/*', '*://*.my-drama.com/*',
    '*://*.reelshort.com/*', '*://*.dramashorts.io/*', '*://*.netshort.com/*', '*://*.royalroad.com/*'
  ]),
  JSON.stringify(SiteRegistry.contentScriptMatches()));

// ---------- T5 Node 侧消费契约（lark 经 require 间接取数） ----------
const Lark = require(path.join(worktreeRoot, 'src/shared/lark.js'));
check('T5 Lark.SOURCE_NAMES 契约保留且同源', deepEq(Lark.SOURCE_NAMES, SiteRegistry.SOURCE_NAMES), '');

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
