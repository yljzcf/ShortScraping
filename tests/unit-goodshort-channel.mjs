import './bootstrap.cjs';
// GoodShort 板块页适配器单测（v1.6.9）：零网络加载真实 content.js（先 eval site-registry）。
//
// 本站的要害是**数据源不在 DOM 里**：内联 `window.__INITIAL_STATE__={…}` 的那个 script
// 执行完就把自己从 DOM 删掉（`parentNode.removeChild(s)`，真机实测 document_end 时
// querySelector 与 outerHTML 都查不到），页面 window 上的值又在隔离世界之外 →
// 适配器只能同源重取一次原始 HTML 文本来解析。S 组就钉这条：document 里放一份**假**
// 载荷，断言适配器取的是 fetch 回来的那份而不是 DOM 里的。
//
// 覆盖：自删脚本语义、字符串感知的花括号匹配（简介里带 {}/引号/转义引号）、
// ChannelModule 缺失/坏 JSON/非数组、id 守卫、字段映射、封面后缀、genres 两源合并去重、
// 路径闸门、三条订阅精确等值、去重命中零写、取数失败不入库。
// 用法：node tests/unit-goodshort-channel.mjs
import fs from 'node:fs';

const contentSrc = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
(0, eval)(fs.readFileSync(new URL('../src/shared/site-registry.js', import.meta.url), 'utf8'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = v => JSON.stringify(v);

const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

const fakeElement = () => ({ style: {}, disabled: false, innerHTML: '', addEventListener() {}, querySelector() { return null; } });
const baseDocument = (overrides = {}) => ({
  getElementById() { return null; },
  createElement() { return fakeElement(); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: { appendChild() {} },
  ...overrides
});

// ---------- fixture ----------
const COVER = 'https://acf.goodshort.com/videobook/202609/cover-WL7xIOUEJP.jpg';
const SUFFIX = '?w=293&h=412';

const book = ({ id = '31001740161', name = 'Not His ATM', intro = 'Plain introduction.', cover = COVER,
  resource = 'not-his-atm-31001740161', genreList = ['Romance'], tagsList = ['Werewolf', 'Regret'] } = {}) => ({
  name, actionType: 'BOOK', action: id, ratings: 0, bookName: name,
  bookResourceUrl: resource, seoBookName: name, author: 'nana',
  introduction: intro, cover, labelsResourceUrls: [], viewCount: 291322,
  writeStatus: 'COMPLETE', lastUpdateTime: '2026-09-03 21:04:24',
  typeTwoIds: [], typeOneIds: [], top: 0, sourceId: id, chapterCount: 55, language: 'ENGLISH',
  tagsList: tagsList.map((n, i) => ({ id: 600 + i, name: n, resourceUrl: `${n}-playlets-videos` })),
  genreList: genreList.map((n, i) => ({ id: 137 + i, name: n, resourceUrl: `${n}-137-playlets` })),
  inLibrary: false, labelsResourceUrl: '', viewCountDisplay: '291.3K',
  chapterResourceUrl: '', lastUpdateTimeDisplay: '2026-09-03', bookId: id
});

// 真实根形状：几十个与抓取无关的顶层键 + ChannelModule。站点用 / 转义斜杠，
// 且整段后面紧跟自删 IIFE——两者都必须不影响解析
const stateOf = (books, { channel = 'Most Trending', extra = {} } = {}) => ({
  showAdd2ScreenFlag: true, hostName: 'GoodShort', host: 'https://www.goodshort.com',
  isMobile: false, IsLogined: false, apiStatus: -1,
  HomeModule: { bookList: [], language: 'en' },
  ChannelModule: { channelBooks: books, total: books.length, pageSize: 20, channelName: channel },
  ...extra,
  route: { path: '/channel/Most-Trending', query: {}, params: {} }
});

// 站点的真实包裹形态：赋值 + 自删 IIFE + 后续 script
const pageWith = (literal) => [
  '<html><head><title>Most Trending - GoodShort</title></head><body>',
  '<div id="app"><div class="book"><img src="/default-book-cover.png"></div></div>',
  `<script>window.__INITIAL_STATE__=${literal};(function(){var s;(s=document.currentScript||document.scripts[document.scripts.length-1]).parentNode.removeChild(s);}());</script>`,
  '<script src="/dist/entry.js"></script></body></html>'
].join('');
const pageOf = (books, opts) => pageWith(JSON.stringify(stateOf(books, opts)).replace(/\//g, '\\u002F'));

const CHANNEL = 'https://www.goodshort.com/channel/Most-Trending';
const SUBS = [
  { urlPattern: CHANNEL, tags: ['GoodShort', 'Trending'] },
  { urlPattern: 'https://www.goodshort.com/channel/Top-in-GoodShort', tags: ['GoodShort', 'Top'] },
  { urlPattern: 'https://www.goodshort.com/channel/Hot-List', tags: ['GoodShort', 'Hot'] }
];
const loc = href => { const u = new URL(href); return { href, hostname: u.hostname, pathname: u.pathname, search: u.search, origin: u.origin }; };

async function runScenario({ href = CHANNEL, subscriptions = SUBS, html, document, dramas = [], fetchImpl } = {}) {
  const store = { dramas: structuredClone(dramas) };
  const saveCalls = [];
  const proxyCalls = [];
  const fetchCalls = [];
  const listeners = [];

  globalThis.chrome = {
    storage: { local: { async get() { await Promise.resolve(); return { dramas: structuredClone(store.dramas), urlTags: subscriptions }; } } },
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      async sendMessage(message) {
        await Promise.resolve();
        if (message?.action === 'saveDrama') {
          saveCalls.push(structuredClone(message.drama));
          const dup = store.dramas.some(d => d.itemId === message.drama.itemId);
          if (!dup) store.dramas.push(structuredClone(message.drama));
          return { success: true, saved: !dup };
        }
        if (message?.action === 'fetchDetailHtml') { proxyCalls.push(message.url); return { success: false }; }
        return { success: true };
      }
    }
  };
  globalThis.window = { location: loc(href) };
  globalThis.document = document || baseDocument();
  globalThis.DOMParser = class { parseFromString() { return baseDocument(); } };
  globalThis.fetch = fetchImpl || (async (url) => {
    fetchCalls.push(url);
    return { ok: true, status: 200, url, text: async () => html };
  });

  (0, eval)(contentSrc);
  const response = await new Promise(resolve => {
    for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
  });
  return { saved: store.dramas, saveCalls, proxyCalls, fetchCalls, response };
}

// ---------- S 数据源：自删脚本 → 只能同源重取 HTML ----------
{
  // DOM 里塞一份**假**载荷：适配器若走了 DOM 就会存到 'DOM 陷阱' 这条
  const trap = pageWith(JSON.stringify(stateOf([book({ id: '31009999999', name: 'DOM 陷阱', resource: 'trap-31009999999' })])));
  const domWithTrap = baseDocument({
    querySelector: sel => (sel === 'script' ? { textContent: trap } : null),
    querySelectorAll: sel => (sel === 'script' ? [{ textContent: trap }] : [])
  });
  const { saved, fetchCalls } = await runScenario({
    html: pageOf([book({ id: '31001740161', name: 'Not His ATM', resource: 'not-his-atm-31001740161' })]),
    document: domWithTrap
  });
  check('S1 取的是同源重取的 HTML，不是 DOM 里的脚本',
    eq(saved.map(d => d.itemId), ['gs31001740161']) && saved[0]?.title === 'Not His ATM', show(saved.map(d => d.title)));
  check('S2 重取的就是当前页地址（同源，不经后台代理）',
    eq(fetchCalls, [CHANNEL]), show(fetchCalls));
}

// ---------- P 解析：字符串感知的花括号匹配 ----------
{
  // 简介里同时带花括号、裸双引号与转义引号——纯计数或纯正则都会在这里截错
  const nasty = 'She said "it{s over}" and left; the \\"deal\\" was {done}.';
  const literal = JSON.stringify(stateOf([book({ intro: nasty })]));
  const { saved, response } = await runScenario({ html: pageWith(literal) });
  check('P1 简介里的 {} 与引号不影响截取',
    response?.success === true && saved[0]?.description === nasty, show(saved[0]?.description));
  check('P1b 截出的载荷完整（尾部自删 IIFE 没被吃进来）', saved.length === 1, show(saved.length));
}
{
  const { saved } = await runScenario({ html: pageOf([book({ intro: 'Ends with an ellipsis…' })]) });
  check('P2 \\u002F 转义的斜杠照常解出', saved[0]?.description === 'Ends with an ellipsis…', show(saved[0]?.description));
}
for (const [name, html] of [
  ['P3 没有 __INITIAL_STATE__ 标记', '<html><body>nothing here</body></html>'],
  ['P4 花括号不配对（截断的页面）', '<script>window.__INITIAL_STATE__={"ChannelModule":{"channelBooks":[</script>'],
  ['P5 载荷不是合法 JSON', '<script>window.__INITIAL_STATE__={ChannelModule:{channelBooks:[]}};</script>'],
  ['P6 ChannelModule 缺失', pageWith(JSON.stringify({ HomeModule: { bookList: [] } }))],
  ['P7 channelBooks 非数组', pageWith(JSON.stringify({ ChannelModule: { channelBooks: null } }))]
]) {
  const { saved, response, saveCalls } = await runScenario({ html });
  check(`${name} → 零入库且不报错`, response?.success === true && saved.length === 0 && saveCalls.length === 0,
    show({ response, saved: saved.length, saveCalls: saveCalls.length }));
}
{
  const { saved, response } = await runScenario({ html: null, fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) });
  check('P8 重取 HTTP 失败 → 零入库（下轮重试）', response?.success === true && saved.length === 0, show(saved.length));
}
{
  const { saved, response } = await runScenario({ html: null, fetchImpl: async () => { throw new Error('offline'); } });
  check('P9 重取抛异常 → 零入库且不炸整轮', response?.success === true && saved.length === 0, show(saved.length));
}

// ---------- I id 守卫 ----------
{
  const { saved } = await runScenario({
    html: pageOf([
      book({ id: '12345', name: '太短', resource: 'too-short-12345' }),           // < 6 位
      book({ id: '', name: '空 id', resource: 'empty' }),
      book({ id: 'abc31001740161', name: '非数字', resource: 'nan' }),
      book({ id: '31001730620', name: '正常', resource: 'ok-31001730620' })
    ])
  });
  check('I1 只有 6 位以上纯数字 sourceId 入库，前缀 gs',
    eq(saved.map(d => d.itemId), ['gs31001730620']), show(saved.map(d => d.itemId)));
}

// ---------- F 字段映射 ----------
{
  const { saved } = await runScenario({
    html: pageOf([book({
      id: '31001719124', name: '  I Walked Away You Wasted Away  ',
      intro: '  She gave seven years to her mafia CEO husband.  ',
      resource: 'i-walked-away-you-wasted-away-31001719124',
      genreList: ['Romance'], tagsList: ['Regret', 'Marriage', 'Regret']
    })])
  });
  const d = saved[0] || {};
  check('F1 itemId=gs+sourceId，id 形态 goodshort_<itemId>_<index>',
    d.itemId === 'gs31001719124' && d.id === 'goodshort_gs31001719124_0', show([d.itemId, d.id]));
  check('F2 标题与简介去首尾空白',
    d.title === 'I Walked Away You Wasted Away' && d.description === 'She gave seven years to her mafia CEO husband.',
    show([d.title, d.description]));
  check('F3 封面存站内缩略图形态（?w=293&h=412）', d.poster === COVER + SUFFIX, show(d.poster));
  check('F4 url 为 /drama/<bookResourceUrl>（带 www，裸域会 301）',
    d.url === 'https://www.goodshort.com/drama/i-walked-away-you-wasted-away-31001719124', show(d.url));
  check('F5 genres＝genreList 在前 + tagsList 在后，去重',
    eq(d.genres, ['Romance', 'Regret', 'Marriage']), show(d.genres));
  check('F6 source/status/译文占位/标签/归属 canonical',
    d.source === 'goodshort' && d.status === 'new' && d.titleZh === '' && d.descriptionZh === ''
    && eq(d.tags, ['GoodShort', 'Trending']) && d.sourceListUrl === CHANNEL,
    show([d.source, d.status, d.tags, d.sourceListUrl]));
  check('F7 scrapedAt 合法、translatedAt 为 null',
    Number.isFinite(Date.parse(d.scrapedAt)) && d.translatedAt === null, show([d.scrapedAt, d.translatedAt]));
  check('F8 无 company/year 残留字段（v1.5.13 起已移除）',
    !('company' in d) && !('year' in d), show(Object.keys(d)));
}
{
  const { saved } = await runScenario({ html: pageOf([book({ cover: '', resource: '' })]) });
  check('F9 缺封面/缺 resource 时对应字段为空串而不是 undefined',
    saved[0]?.poster === '' && saved[0]?.url === '', show([saved[0]?.poster, saved[0]?.url]));
}
{
  const withQuery = `${COVER}?spm=abc`;
  const { saved } = await runScenario({ html: pageOf([book({ cover: withQuery })]) });
  check('F10 封面自带查询串时不再追加缩放参数', saved[0]?.poster === withQuery, show(saved[0]?.poster));
}

// ---------- D 去重与零详情请求 ----------
{
  const existing = {
    itemId: 'gs31001740161', title: 'Not His ATM', source: 'goodshort',
    genres: ['Romance'], scrapedAt: '2026-09-01T00:00:00.000Z'
  };
  const { saveCalls, fetchCalls, proxyCalls } = await runScenario({
    html: pageOf([book({ id: '31001740161', resource: 'not-his-atm-31001740161' })]),
    dramas: [existing]
  });
  check('D1 已存在且已有 genres → 零 saveDrama', saveCalls.length === 0, show(saveCalls.length));
  check('D2 全程只有一次列表请求、零后台代理（简介与 genres 都在列表里）',
    fetchCalls.length === 1 && proxyCalls.length === 0, show({ fetchCalls, proxyCalls }));
}
{
  const existing = { itemId: 'gs31001740161', title: 'Not His ATM', source: 'goodshort', genres: [], scrapedAt: '2026-09-01T00:00:00.000Z' };
  const { saveCalls, fetchCalls } = await runScenario({
    html: pageOf([book({ id: '31001740161', resource: 'not-his-atm-31001740161', genreList: ['Romance'], tagsList: ['Mafia'] })]),
    dramas: [existing]
  });
  check('D3 存量缺 genres → 用列表值回填，且不额外发请求',
    saveCalls.length === 1 && eq(saveCalls[0]?.genres, ['Romance', 'Mafia']) && fetchCalls.length === 1,
    show({ saveCalls: saveCalls.map(s => s.genres), fetchCalls }));
}

// ---------- G 路径闸门与订阅匹配 ----------
{
  const { saved, fetchCalls } = await runScenario({
    href: 'https://www.goodshort.com/drama/i-walked-away-31001719124',
    subscriptions: [{ urlPattern: 'https://www.goodshort.com/', tags: ['GoodShort', 'X'] }],
    html: pageOf([book({})])
  });
  check('G1 详情页不抓（adapter.matches 只认 /channel/<板块>）',
    saved.length === 0 && fetchCalls.length === 0, show({ saved: saved.length, fetchCalls }));
}
{
  const { saved } = await runScenario({
    href: 'https://www.goodshort.com/channel/Hot-List',
    html: pageOf([book({ id: '31001045490', resource: 'kidnapped-by-the-mafia-31001045490' })], { channel: 'Hot List' })
  });
  check('G2 三条 channel 订阅各自精确命中（Hot-List 拿到自己的标签）',
    eq(saved[0]?.tags, ['GoodShort', 'Hot']) && saved[0]?.sourceListUrl === 'https://www.goodshort.com/channel/Hot-List',
    show([saved[0]?.tags, saved[0]?.sourceListUrl]));
}
{
  const { saved, fetchCalls } = await runScenario({
    href: CHANNEL,
    subscriptions: [{ urlPattern: 'https://www.goodshort.com/channel/Top-in-GoodShort', tags: ['GoodShort', 'Top'] }],
    html: pageOf([book({})])
  });
  check('G3 未订阅的板块页不抓（订阅轮在适配器之前）',
    saved.length === 0 && fetchCalls.length === 0, show({ saved: saved.length, fetchCalls }));
}
{
  const matches = [
    ['https://www.goodshort.com/channel/Most-Trending', true],
    ['https://www.goodshort.com/channel/Hot-List/', true],
    ['https://goodshort.com/channel/Most-Trending', true],
    ['https://www.goodshort.com/', false],
    ['https://www.goodshort.com/channel/', false],
    ['https://www.goodshort.com/channel/a/b', false],
    ['https://www.goodshort.com/dramas/playlets', false]
  ];
  // 走 siteOfUrl + 真实 adapter 的 matches：借一次场景把闸门行为逐条验出来
  const outcomes = [];
  for (const [url, expected] of matches) {
    const { saved } = await runScenario({
      href: url,
      subscriptions: [{ urlPattern: url, tags: ['GoodShort', 'X'] }],
      html: pageOf([book({ id: '31001740161', resource: 'x-31001740161' })])
    });
    outcomes.push([url, saved.length > 0, expected]);
  }
  check('G4 路径闸门逐条：只有 /channel/<单段> 会抓',
    outcomes.every(([, got, expected]) => got === expected), show(outcomes));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
