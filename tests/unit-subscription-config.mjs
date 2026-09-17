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
}

// ---------- R 组：退订差集与受影响条数（v1.6.7）----------
// 背景：2026-09-17 用户取消 Steam 订阅后 1847 条历史被静默删除。设置页要在写 storage
// 之前算出「将删掉几条」并弹确认，判定口径必须与后台 filterDramasByConfiguredUrls
// 逐字一致（尾斜杠归一后的**精确等值**，不是 startsWith），否则提示的条数与实际删的对不上。
if (SC) {
  const removed = SC.removedSubscriptionUrls;
  const countUnder = SC.countDramasUnderUrls;

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
  check('R14 countDramasUnderUrls 恒等于 dramasUnderUrls 的长度',
    countUnder(dramas, ['https://b.test/y', 'https://c.test/z']) === SC.dramasUnderUrls(dramas, ['https://b.test/y', 'https://c.test/z']).length, '');
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

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
