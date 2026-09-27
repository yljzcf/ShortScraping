import './bootstrap.cjs';
// 订阅规范化单一真源回归测试（v1.6.5）：src/shared/subscription-config.js 三端共用。
// 此前 background.js / settings.js / sync-server.js 各写一份且语义漂移（后台不 trim、
// 不校 http、不去重），同一份 tag.json 两条路径得到两种标签。N 组固化统一语义，
// W 组是接线探针——三端都必须委托共享模块，测试夹具预载也不能漏。
// 用法：node tests/unit-subscription-config.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = v => JSON.stringify(v);

let SC = null;
try {
  SC = require(path.join(root, 'src/shared/subscription-config.js'));
} catch (e) {
  check('M0 共享模块可加载', false, e.message);
}

// ---------- N 组：规范化语义 ----------
if (SC) {
  const norm = SC.normalizeUrlTags;
  const one = (input) => norm([input]);

  check('N1 url 与标签首尾空白被 trim',
    deepEq(one({ url: '  https://a.test/x  ', tags: [' A ', 'B '] }), [{ urlPattern: 'https://a.test/x', tags: ['A', 'B'] }]),
    show(one({ url: '  https://a.test/x  ', tags: [' A ', 'B '] })));

  const nonHttp = norm([{ url: 'ftp://a.test', tags: ['A'] }, { url: 'a.test/list', tags: ['A'] }, { url: 'HTTPS://ok.test', tags: ['A'] }]);
  check('N2 非 http(s) 条目丢弃（协议不分大小写）',
    deepEq(nonHttp, [{ urlPattern: 'HTTPS://ok.test', tags: ['A'] }]), show(nonHttp));

  const dup = norm([{ url: 'https://a.test', tags: ['first'] }, { urlPattern: 'https://a.test', tags: ['second'] }]);
  check('N3 同 URL 去重先到先得', deepEq(dup, [{ urlPattern: 'https://a.test', tags: ['first'] }]), show(dup));

  check('N4 标签最多保留 3 个', deepEq(one({ url: 'https://a.test', tags: ['1', '2', '3', '4'] })[0].tags, ['1', '2', '3']),
    show(one({ url: 'https://a.test', tags: ['1', '2', '3', '4'] })));

  check('N5 字符串标签按英文/全角逗号切分', deepEq(one({ url: 'https://a.test', tags: 'A, B，C' })[0].tags, ['A', 'B', 'C']),
    show(one({ url: 'https://a.test', tags: 'A, B，C' })));

  const dirty = norm([null, 'x', 42, ['https://a.test'], { url: 'https://a.test', tags: ['A'] }]);
  check('N6 null / 原始值 / 数组条目跳过不抛', deepEq(dirty, [{ urlPattern: 'https://a.test', tags: ['A'] }]), show(dirty));

  check('N7 urlPattern 优先于 url',
    deepEq(one({ urlPattern: 'https://p.test', url: 'https://u.test', tags: ['A'] }), [{ urlPattern: 'https://p.test', tags: ['A'] }]), '');

  const zeroTags = norm([{ url: 'https://a.test', tags: ['', '  '] }, { url: 'https://b.test' }, { url: 'https://c.test', tags: 42 }]);
  check('N8 零标签条目丢弃（空白标签不算；非数组非字符串的 tags 视为空）',
    deepEq(zeroTags, []), show(zeroTags));

  check('N9 非数组输入返回空数组', deepEq(norm(null), []) && deepEq(norm({}), []) && deepEq(norm('x'), []) && deepEq(norm(undefined), []), '');

  const fileEntries = SC.toTagFileEntries([{ urlPattern: ' https://a.test ', tags: [' A '] }, { url: 'bad', tags: ['A'] }]);
  check('N10 toTagFileEntries 输出文件形态 {url, tags} 且同样规范化',
    deepEq(fileEntries, [{ url: 'https://a.test', tags: ['A'] }]), show(fileEntries));

  check('N11 输出条目只有 urlPattern/tags 两个键（多余键不透传）',
    deepEq(Object.keys(one({ url: 'https://a.test', tags: ['A'], extra: 1 })[0]), ['urlPattern', 'tags']), '');

  // 无效条目不占去重名额：首条零标签被丢后，同 URL 的后一条合法条目仍应保留（与设置页/同步服务旧语义一致）
  const invalidFirst = norm([{ url: 'https://a.test', tags: [] }, { url: 'https://a.test', tags: ['ok'] }]);
  check('N12 被丢弃的无效条目不占去重名额', deepEq(invalidFirst, [{ urlPattern: 'https://a.test', tags: ['ok'] }]), show(invalidFirst));

  // urltags-dedupe-raw（batch F）：去重键曾是 trim 后的原串，而归属判定（UrlMatch）按尾斜杠归一——
  // 手写 tag.json 同时写 '…/x' 与 '…/x/' 时两条都保留，同一页每轮被抓两次
  const slashDup = norm([{ url: 'https://a.test/x', tags: ['first'] }, { url: 'https://a.test/x/', tags: ['second'] }]);
  check('N13 仅尾斜杠之差按同一订阅去重，保留先出现的原串写法',
    deepEq(slashDup, [{ urlPattern: 'https://a.test/x', tags: ['first'] }]), show(slashDup));
  const slashFirst = norm([{ url: 'https://a.test/x/', tags: ['first'] }, { url: 'https://a.test/x', tags: ['second'] }]);
  check('N13b 先出现的是带斜杠写法时保留带斜杠的原串',
    deepEq(slashFirst, [{ urlPattern: 'https://a.test/x/', tags: ['first'] }]), show(slashFirst));

  check('N14 字符串标签去重（A, A ,B → A,B）', deepEq(one({ url: 'https://a.test', tags: 'A, A ,B' })[0]?.tags, ['A', 'B']),
    show(one({ url: 'https://a.test', tags: 'A, A ,B' })));
  check('N15 先去重后截断（[A,A,B,C] → [A,B,C]，重复项不占名额）',
    deepEq(one({ url: 'https://a.test', tags: ['A', 'A', 'B', 'C'] })[0]?.tags, ['A', 'B', 'C']),
    show(one({ url: 'https://a.test', tags: ['A', 'A', 'B', 'C'] })));
}

// ---------- R 组：退订差集与受影响条数（v1.6.7）----------
// 背景：2026-09-17 用户取消 Steam 订阅后 1847 条历史被静默删除。设置页要在写 storage
// 之前算出「将删掉几条」并弹确认，判定口径必须与后台 filterDramasByConfiguredUrls
// 逐字一致（尾斜杠归一后的**精确等值**，不是 startsWith），否则提示的条数与实际删的对不上。
if (SC) {
  const removed = SC.removedSubscriptionUrls;
  // v1.7.0 删掉了只剩测试在用的 countDramasUnderUrls 导出：条数就是 dramasUnderUrls 的长度
  const countUnder = (dramas, urls) => SC.dramasUnderUrls(dramas, urls).length;

  const prev = [{ urlPattern: 'https://a.test/x', tags: ['A'] }, { urlPattern: 'https://b.test/y', tags: ['B'] }];

  check('R1 无删除时返回空数组', deepEq(removed(prev, prev), []), show(removed(prev, prev)));

  check('R2 部分退订只返回被去掉的那条',
    deepEq(removed(prev, [prev[0]]), ['https://b.test/y']), show(removed(prev, [prev[0]])));

  check('R3 全部退订返回全部', deepEq(removed(prev, []), ['https://a.test/x', 'https://b.test/y']), show(removed(prev, [])));

  check('R4 新增订阅不算删除', deepEq(removed([prev[0]], prev), []), show(removed([prev[0]], prev)));

  // 尾斜杠只是手写配置的书写差异，不该被当成「退订了旧的又订了新的」
  check('R5 仅尾斜杠差异不算删除',
    deepEq(removed([{ urlPattern: 'https://a.test/x/', tags: ['A'] }], [{ urlPattern: 'https://a.test/x', tags: ['A'] }]), []), '');

  check('R6 非数组输入不抛', deepEq(removed(null, undefined), []) && deepEq(removed('x', 42), []), '');

  // 标签改了、URL 没变 —— 是编辑不是退订，历史不该被算进删除数
  check('R7 只改标签不算删除',
    deepEq(removed(prev, [{ urlPattern: 'https://a.test/x', tags: ['改了'] }, prev[1]]), []), '');

  const dramas = [
    { id: '1', sourceListUrl: 'https://a.test/x' },
    { id: '2', sourceListUrl: 'https://b.test/y' },
    { id: '3', sourceListUrl: 'https://b.test/y/' },   // 尾斜杠形态同样命中
    { id: '4', sourceListUrl: 'https://c.test/z' },
    { id: '5' },                                        // 缺 sourceListUrl，永不命中
    { id: '6', sourceListUrl: '' }
  ];

  check('R8 受影响条数按精确等值统计（含尾斜杠归一）',
    countUnder(dramas, ['https://b.test/y']) === 2, String(countUnder(dramas, ['https://b.test/y'])));

  check('R9 缺 sourceListUrl / 空串的条目不计入',
    countUnder(dramas, ['']) === 0 && countUnder(dramas, [undefined]) === 0, '');

  check('R10 空删除列表返回 0', countUnder(dramas, []) === 0 && countUnder(dramas, null) === 0, '');

  // 前缀串扰回归点：退订 b.test/y 不得把 b.test/yy 的历史一起算进去
  const prefixDramas = [{ id: '1', sourceListUrl: 'https://b.test/y' }, { id: '2', sourceListUrl: 'https://b.test/yy' }];
  check('R11 互为前缀的订阅不串扰（精确等值而非 startsWith）',
    countUnder(prefixDramas, ['https://b.test/y']) === 1, String(countUnder(prefixDramas, ['https://b.test/y'])));

  check('R12 dramas 非数组不抛', countUnder(null, ['https://a.test/x']) === 0 && countUnder('x', ['https://a.test/x']) === 0, '');

  // 备份文件要正好是「将被删的那批」，故取数组的那支才是实现，count 只是它的长度
  const picked = SC.dramasUnderUrls(dramas, ['https://b.test/y']);
  check('R13 dramasUnderUrls 返回命中的原始条目',
    deepEq(picked.map(d => d.id), ['2', '3']), show(picked.map(d => d.id)));
  check('R14 无人使用的导出已删（countDramasUnderUrls / MAX_TAGS），dramasUnderUrls 仍在',
    !('countDramasUnderUrls' in SC) && !('MAX_TAGS' in SC) && typeof SC.dramasUnderUrls === 'function', show(Object.keys(SC)));
}

// ---------- C 组：要抓的订阅 URL 清单 configuredScrapeUrls（v1.7.0 收拢后台与弹窗两份） ----------
// 后台原实现：取 urlPattern、只认 http(s)、按尾斜杠归一去重保留首次原串；弹窗那份按原串去重、还认 url 字段。
// 统一成前者（外加 url 回退），且清单为坏数据时抛错而不是当成「零订阅」（订阅外清理会据此清库）
if (SC) {
  const urls = SC.configuredScrapeUrls;
  check('C1 取 urlPattern，缺省退回 url；只认完整 http(s)',
    deepEq(urls([{ urlPattern: 'https://a.test/x' }, { url: 'http://b.test/y' }, { urlPattern: 'ftp://c.test' }, { urlPattern: 'imdb' }]),
      ['https://a.test/x', 'http://b.test/y']), show(urls([{ urlPattern: 'https://a.test/x' }, { url: 'http://b.test/y' }])));
  check('C2 按尾斜杠归一去重、保留先出现的原串', deepEq(urls([{ urlPattern: 'https://a.test/x/' }, { urlPattern: 'https://a.test/x' }, { urlPattern: 'https://b.test' }]),
    ['https://a.test/x/', 'https://b.test']), show(urls([{ urlPattern: 'https://a.test/x/' }, { urlPattern: 'https://a.test/x' }])));
  check('C3 null / 原始值 / 非字符串 url 的条目跳过不抛', deepEq(urls([null, 'x', 42, { urlPattern: 123 }, { urlPattern: 'https://ok.test' }]), ['https://ok.test']), '');
  check('C4 null / undefined 得空数组', deepEq(urls(null), []) && deepEq(urls(undefined), []), '');
  let threw = null;
  try { urls({ urlPattern: 'https://a.test' }); } catch (e) { threw = e; }
  check('C5 真值却不是数组 → 抛错（不能当成「零订阅」让订阅外清理清库）', threw instanceof TypeError, String(threw));
  // 与收拢前后台的算法逐条比对（目录里全部订阅 + 手造的尾斜杠 / 非 http 条目）
  const legacyBackground = (urlTags) => {
    const list = (urlTags || []).map(item => item.urlPattern).filter(pattern => /^https?:\/\//i.test(pattern));
    const seen = new Set();
    return list.filter(url => { const key = String(url).trim().replace(/\/+$/, ''); if (seen.has(key)) return false; seen.add(key); return true; });
  };
  const catalog = SC.normalizeUrlTags(JSON.parse(fs.readFileSync(path.join(root, 'config/tag.example.json'), 'utf8')));
  const mixed = [...catalog, { urlPattern: catalog[0].urlPattern + '/' }, { urlPattern: 'not-a-url' }];
  check('C6 对正常数据与收拢前的后台算法逐条一致（订阅外清理的指纹不变，升级不触发额外清理）',
    deepEq(urls(mixed), legacyBackground(mixed)) && urls(catalog).length === catalog.length, `${urls(mixed).length} vs ${legacyBackground(mixed).length}`);
}

// ---------- D 组：抓取时实际打开的地址 withReleaseWindow（v1.7.0 IMDb 滚动日期窗口） ----------
// 订阅 URL 不带日期（它是历史归属的身份），打开页面前才在末尾补 release_date；内容脚本靠 url-match 前缀轮认回订阅
if (SC) {
  const UrlMatch = require(path.join(root, 'src/shared/url-match.js'));
  const win = SC.withReleaseWindow;
  const now = new Date(2026, 8, 27, 10, 30);   // 本地 2026-09-27
  const sub = 'https://www.imdb.com/search/title/?companies=co1028734';
  check('D1 IMDb 搜索页订阅末尾补 &release_date=<今天−N 天>,（180 天 → 2026-03-31）',
    win(sub, 180, now) === `${sub}&release_date=2026-03-31,`, win(sub, 180, now));
  check('D2 补过参数的页面仍命中原订阅（前缀轮），归属写回不带日期的订阅 URL',
    UrlMatch.matchSubscription(win(sub, 180, now), [{ urlPattern: sub, tags: ['IMDB'] }])?.urlPattern === sub, '');
  check('D3 按日历日倒推：跨月 / 跨年 / 闰年二月', win(sub, 30, new Date(2026, 2, 1)).endsWith('release_date=2026-01-30,')
    && win(sub, 1, new Date(2027, 0, 1)).endsWith('release_date=2026-12-31,')
    && win(sub, 1, new Date(2028, 2, 1)).endsWith('release_date=2028-02-29,'), '');
  check('D4 订阅自己写了 release_date 的原样不动（尊重显式日期）',
    win('https://www.imdb.com/search/title/?release_date=2026-01-01,&genres=short', 180, now) === 'https://www.imdb.com/search/title/?release_date=2026-01-01,&genres=short', '');
  check('D5 0（不限）/ 非整数 / 负数 / 缺省：原样', [0, 1.5, -3, undefined, null, 'x'].every(days => win(sub, days, now) === sub), '');
  check('D6 非 IMDb、IMDb 非搜索页、带 #片段、坏 URL：原样', win('https://www.reelshort.com/', 180, now) === 'https://www.reelshort.com/'
    && win('https://www.imdb.com/chart/moviemeter/', 180, now) === 'https://www.imdb.com/chart/moviemeter/'
    && win(`${sub}#x`, 180, now) === `${sub}#x` && win('not a url', 180, now) === 'not a url'
    && win('https://notimdb.com/search/title/?x=1', 180, now) === 'https://notimdb.com/search/title/?x=1', '');
  check('D7 没有查询串的搜索页用 ? 起头，同样命中原订阅',
    win('https://www.imdb.com/search/title/', 7, now) === 'https://www.imdb.com/search/title/?release_date=2026-09-20,'
      && UrlMatch.matchSubscription(win('https://www.imdb.com/search/title/', 7, now), [{ urlPattern: 'https://www.imdb.com/search/title/', tags: ['I'] }]) !== null, '');
}

// ---------- W 组：接线探针（三端 + 夹具） ----------
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const bg = read('src/background/background.js');
check('W1 后台 importScripts 含 subscription-config', bg.includes("importScripts('../shared/subscription-config.js')"), '');
check('W2 后台 normalizeUrlTags 委托共享模块', bg.includes('return SubscriptionConfig.normalizeUrlTags(rawTags);'), '');
check('W3 后台不再保留私有的 tags.slice(0, 3) 实现', !bg.includes('item.tags.slice(0, 3)'), '');

const settings = read('src/settings/settings.js');
check('W4 设置页 normalizeUrlTags 委托共享模块', settings.includes('return SubscriptionConfig.normalizeUrlTags(rawTags);'), '');
check('W5 设置页删除了只服务于旧实现的 parseTags', !settings.includes('function parseTags('), '');

const settingsHtml = read('src/settings/settings.html');
const cfgAt = settingsHtml.indexOf('src="../shared/subscription-config.js"');
const jsAt = settingsHtml.indexOf('src="settings.js"');
check('W6 settings.html 在 settings.js 之前引入 subscription-config', cfgAt >= 0 && jsAt > cfgAt, `cfg=${cfgAt} js=${jsAt}`);

const server = read('server/sync-server.js');
check('W7 同步服务 require 共享模块', server.includes("require('../src/shared/subscription-config.js')"), '');
check('W8 同步服务 normalizeTagConfig 委托共享模块', server.includes('return SubscriptionConfig.toTagFileEntries(rawTags);'), '');

check('W9 bootstrap.cjs 预载共享模块（noop importScripts 桩的套件依赖它）',
  read('tests/bootstrap.cjs').includes("require('../src/shared/subscription-config.js')"), '');

// R 组的两个函数把归属判定委托给 url-match.js，三端的加载序都得跟上（v1.6.7）
const urlMatchAt = settingsHtml.indexOf('src="../shared/url-match.js"');
check('W10 settings.html 在 subscription-config 之前引入 url-match',
  urlMatchAt >= 0 && cfgAt > urlMatchAt, `urlMatch=${urlMatchAt} cfg=${cfgAt}`);

const bgUrlMatchAt = bg.indexOf("importScripts('../shared/url-match.js')");
const bgCfgAt = bg.indexOf("importScripts('../shared/subscription-config.js')");
check('W11 后台 importScripts 里 url-match 先于 subscription-config',
  bgUrlMatchAt >= 0 && bgCfgAt > bgUrlMatchAt, `urlMatch=${bgUrlMatchAt} cfg=${bgCfgAt}`);

check('W12 bootstrap.cjs 预载 url-match（subscription-config 的新依赖）',
  read('tests/bootstrap.cjs').includes("require('../src/shared/url-match.js')"), '');

check('W13 设置页归属归一委托 UrlMatch（不再自带 normalizeUrlForMatch 实现）',
  !settings.includes('function normalizeUrlForMatch('), '');

check('W14 后台订阅 URL 清单与归属过滤都委托共享模块（不再各写一份）',
  bg.includes('return SubscriptionConfig.configuredScrapeUrls(urlTags);')
    && bg.includes('return SubscriptionConfig.dramasUnderUrls(dramas, getConfiguredScrapeUrls(urlTags));'), '');
const popup = read('src/popup/popup.js');
check('W15 弹窗订阅 URL 清单委托共享模块（去重口径与后台一致）', popup.includes('return SubscriptionConfig.configuredScrapeUrls(state.urlTags);'), '');

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
