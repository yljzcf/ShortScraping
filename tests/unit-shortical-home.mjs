import './bootstrap.cjs';
// Shortical 首页「Top Recommended」适配器单测（v1.6.9）：加载真实 content.js（先 eval site-registry）。
//
// 本站是纯前端渲染的 SPA——服务端只回 9KB 空壳，**只能读 hydrate 后的 DOM**，所以这里
// 用 dom-fixture 搭一棵真元素树、走真选择器（正则抠串的桩会把「选择器写错」这个最常见的
// 失败方式排除在考核之外）。
//
// genres 是两段式（2026-09-17 用户定「DOM 为主，token 可用时补」）：卡片上只印**一个**
// 分类，官方接口给全量但匿名调用 401、token 在页面 IndexedDB 里。G 组把这条线的每种
// 失败面都钉成「静默退回卡片上那一个」，**绝不允许整站抓取归零**；G0 另钉一条安全边界：
// 库不存在时不许 open——直接 open 会把它按版本 1 建出来且没有对象仓库，反而搞坏站点自己的鉴权。
//
// 覆盖：区块定位（?list= 归一化 / 缺省 / 找不到）、9 卡字段映射、「简介取最长 <p>」不被
// 观看量抢走、id 守卫、hydrate 轮询、genres 五种失败面、路径闸门、订阅裸域形态。
// 用法：node tests/unit-shortical-home.mjs
import fs from 'node:fs';
import { el, documentFrom } from './dom-fixture.mjs';

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

// ---------- fixture：对齐真实卡片结构 ----------
const CDN = 'https://dirjqbe1kaah2.cloudfront.net';
const VIEWS = '19.5K';

// 真实卡片：封面区（按钮包图 + 悬停面板：分类 div → 简介 p → 操作按钮）→ 标题链接 → 观看量 p
const card = ({ id, title, slug, category = 'Romance', description = 'A fierce rivalry and one unforgettable summer.',
  cover = `${CDN}/${id}/image.webp`, views = VIEWS, href } = {}) => el('div', { class: 'w-full group relative' }, [
  el('div', { class: 'relative rounded-lg overflow-hidden' }, [
    el('button', { 'aria-label': `Play ${title}` }, [el('img', { alt: title, src: cover, loading: 'lazy' })]),
    el('div', { class: 'hidden absolute inset-x-0 bottom-0' }, [
      el('div', { class: 'text-xs font-medium' }, [], category),
      el('p', { class: 'line-clamp-4' }, [], description),
      el('div', { class: 'flex items-center' }, [
        el('button', { 'aria-label': `Play ${title}` }, [], 'Play'),
        el('button', { 'aria-label': 'Add to list' }, [], '')
      ])
    ])
  ]),
  el('a', { class: 'hover:text-white', href: href ?? `/drama/${slug}-${id}` }, [], title),
  el('p', { class: 'text-xs' }, [], views)
]);

const section = (heading, cards) => el('section', { class: 'relative' }, [
  el('div', { class: 'flex items-center justify-between' }, [el('h2', { class: 'text-white font-bold' }, [], heading)]),
  el('div', { class: 'grid grid-cols-3' }, cards)
]);

const page = (sections) => el('div', { id: 'root' }, [
  el('header', {}, [el('a', { href: '/' }, [], 'Shortical')]),
  el('main', {}, sections)
]);

const DEFAULT_CARDS = [
  card({ id: '198', title: 'How to Fake Date Your Enemy', slug: 'how-to-fake-date-your-enemy', category: 'Against All Odds' }),
  card({ id: '193', title: 'Room Service', slug: 'room-service', description: 'An unexpected pregnancy binds a young woman to an icy billionaire.' }),
  card({ id: '152', title: "Foul Play With My Brother's Best Friend", slug: 'foul-play-with-my-brothers-best-friend', cover: `${CDN}/152/image3.webp` })
];

const HOME = 'https://shortical.com/';
const SUB = { urlPattern: `${HOME}?list=top_recommended`, tags: ['Shortical', 'Top'] };
const loc = href => { const u = new URL(href); return { href, hostname: u.hostname, pathname: u.pathname, search: u.search, origin: u.origin }; };

// ---------- IndexedDB 桩 ----------
const makeIndexedDb = ({ dbNames = ['firebaseLocalStorageDb'], records = null, hasStore = true, openFails = false, noDatabasesApi = false } = {}) => {
  const state = { openCalls: 0 };
  if (noDatabasesApi) return { idb: { open() { state.openCalls++; return {}; } }, state };
  const idb = {
    async databases() { return dbNames.map(name => ({ name, version: 1 })); },
    open(name) {
      state.openCalls++;
      const request = { result: null, onsuccess: null, onerror: null };
      setTimeout(() => {
        if (openFails) return request.onerror && request.onerror();
        request.result = {
          objectStoreNames: { contains: store => hasStore && store === 'firebaseLocalStorage' },
          transaction: () => ({
            objectStore: () => ({
              getAll() {
                const all = { result: null, onsuccess: null, onerror: null };
                setTimeout(() => { all.result = records || []; all.onsuccess && all.onsuccess(); }, 0);
                return all;
              }
            })
          })
        };
        request.onsuccess && request.onsuccess();
      }, 0);
      return request;
    }
  };
  return { idb, state };
};
const tokenRecords = token => [{ fbase_key: 'firebase:authUser:key:[DEFAULT]', value: { uid: 'u1', stsTokenManager: { accessToken: token } } }];

const apiRow = (id, categories) => ({ thumbnail: `${CDN}/${id}/image.webp`, series: { id: Number(id), name: 'x', description: 'y', categories } });

// sitemap 是规范 slug 的唯一权威源：首页 href 尾段的数字是**另一套 id**（站点两套并行，
// 详情页只认静态发布产物那套，详见 C 组与适配器注释）。
const sitemapXml = slugs => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${slugs.map(s => `  <url><loc>https://shortical.com/drama/${s}</loc></url>`).join('\n')}
</urlset>`;
// 默认夹具里的 href 尾段恰好就是规范 id（多数存量如此），C 组专门覆盖两者不一致的情形
const DEFAULT_SITEMAP = ['how-to-fake-date-your-enemy-198', 'room-service-193',
  'foul-play-with-my-brothers-best-friend-152', 'reordered-777', 'more-one-881', 'other-999'];

async function runScenario({ href = `${HOME}?list=top_recommended`, subscriptions = [SUB], sections = [section('Top Recommended', DEFAULT_CARDS)],
  dramas = [], indexedDb = makeIndexedDb({ records: tokenRecords('tok-1') }), apiImpl,
  sitemap = DEFAULT_SITEMAP, sitemapImpl } = {}) {
  const store = { dramas: structuredClone(dramas) };
  const saveCalls = [];
  const apiCalls = [];
  const sitemapCalls = [];
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
        return { success: true };
      }
    }
  };
  globalThis.window = { location: loc(href) };
  globalThis.document = documentFrom(page(sections));
  globalThis.DOMParser = class { parseFromString() { return documentFrom(el('html')); } };
  globalThis.indexedDB = indexedDb.idb;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/sitemaps/series.xml')) {
      sitemapCalls.push(String(url));
      return sitemapImpl
        ? await sitemapImpl(url, init)
        : { ok: true, status: 200, text: async () => sitemapXml(sitemap) };
    }
    apiCalls.push({ url, auth: init?.headers?.Authorization || null });
    return apiImpl
      ? await apiImpl(url, init)
      : { ok: true, status: 200, json: async () => [apiRow('198', ['Against All Odds', 'Forbidden Romance']), apiRow('193', ['Romance', 'Billionaire'])] };
  };

  (0, eval)(contentSrc);
  const response = await new Promise(resolve => {
    for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
  });
  return { saved: store.dramas, saveCalls, apiCalls, sitemapCalls, response, idbState: indexedDb.state };
}

// ---------- F 字段映射 ----------
{
  const { saved, response } = await runScenario();
  check('F0 区块内三张卡全部入库',
    response?.success === true && eq(saved.map(d => d.itemId), ['sc198', 'sc193', 'sc152']), show(saved.map(d => d.itemId)));

  const d = saved[0] || {};
  check('F1 itemId=sc+数字 id，id 形态 shortical_<itemId>_<index>',
    d.itemId === 'sc198' && d.id === 'shortical_sc198_0', show([d.itemId, d.id]));
  check('F2 标题取自 /drama/ 链接文本', d.title === 'How to Fake Date Your Enemy', show(d.title));
  check('F3 封面原样存（站点只有这一种尺寸形态）', d.poster === `${CDN}/198/image.webp`, show(d.poster));
  check('F4 url 用裸域（www.shortical.com 会 301 到裸域）',
    d.url === 'https://shortical.com/drama/how-to-fake-date-your-enemy-198', show(d.url));
  check('F5 source/status/译文占位/标签/归属 canonical',
    d.source === 'shortical' && d.status === 'new' && d.titleZh === '' && d.descriptionZh === ''
    && eq(d.tags, ['Shortical', 'Top']) && d.sourceListUrl === SUB.urlPattern,
    show([d.source, d.status, d.tags, d.sourceListUrl]));
  check('F6 scrapedAt 合法、translatedAt 为 null',
    Number.isFinite(Date.parse(d.scrapedAt)) && d.translatedAt === null, show([d.scrapedAt, d.translatedAt]));
  check('F7 封面不猜文件名（个别条目是 image3.webp）',
    saved[2]?.poster === `${CDN}/152/image3.webp`, show(saved[2]?.poster));
}

// ---------- V 简介取最长 <p>：卡里另有个「19.5K」观看量 p ----------
{
  const { saved } = await runScenario();
  check('V1 简介取的是长文那条，不是观看量',
    saved[0]?.description === 'A fierce rivalry and one unforgettable summer.'
    && saved[1]?.description === 'An unexpected pregnancy binds a young woman to an icy billionaire.',
    show(saved.map(d => d.description)));
  check('V1b 没有任何一条把观看量存成简介', saved.every(d => d.description !== VIEWS), show(saved.map(d => d.description)));
}
{
  // 观看量排在简介前面（站点改版换个顺序也不能翻车）
  const reordered = el('div', { class: 'w-full group relative' }, [
    el('p', {}, [], VIEWS),
    el('div', {}, [el('img', { alt: 'Reordered', src: `${CDN}/777/image.webp` }), el('div', {}, [], 'Revenge'), el('p', {}, [], 'The longer synopsis lives after the view count here.')]),
    el('a', { href: '/drama/reordered-777' }, [], 'Reordered')
  ]);
  const { saved } = await runScenario({ sections: [section('Top Recommended', [reordered])] });
  check('V2 观看量排在简介之前也不会取错',
    saved[0]?.description === 'The longer synopsis lives after the view count here.', show(saved[0]?.description));
}

// ---------- G genres 两段式 ----------
{
  const { saved, apiCalls } = await runScenario();
  check('G1 token 可用时用接口的全量分类覆盖卡片上那一个',
    eq(saved[0]?.genres, ['Against All Odds', 'Forbidden Romance']) && eq(saved[1]?.genres, ['Romance', 'Billionaire']),
    show(saved.map(d => d.genres)));
  check('G1b 接口没返回的条目保留卡片上那一个（152 不在返回里）',
    eq(saved[2]?.genres, ['Romance']), show(saved[2]?.genres));
  check('G1c 只调一次接口、带 Bearer 头',
    apiCalls.length === 1 && apiCalls[0].url === 'https://prod.shortical.com/api/v1/series/top-recommendations'
    && apiCalls[0].auth === 'Bearer tok-1', show(apiCalls));
}
{
  const { saved, apiCalls, idbState } = await runScenario({ indexedDb: makeIndexedDb({ dbNames: ['someOtherDb'] }) });
  check('G0 库不存在时绝不 open（直接 open 会把它建成空库、搞坏站点鉴权）',
    idbState.openCalls === 0, show(idbState));
  check('G2 取不到凭据 → 不调接口，genres 退回卡片上那一个',
    apiCalls.length === 0 && eq(saved[0]?.genres, ['Against All Odds']), show([apiCalls.length, saved[0]?.genres]));
}
for (const [name, scenario] of [
  ['G3 接口 401', { apiImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'Missing or invalid auth header' }) }) }],
  ['G4 接口抛异常', { apiImpl: async () => { throw new Error('network down'); } }],
  ['G5 接口返回非数组', { apiImpl: async () => ({ ok: true, status: 200, json: async () => ({ error: 'nope' }) }) }],
  ['G6 接口返回的条目缺 categories', { apiImpl: async () => ({ ok: true, status: 200, json: async () => [{ series: { id: 198 } }] }) }],
  ['G7 IndexedDB 打不开', { indexedDb: makeIndexedDb({ openFails: true }) }],
  ['G8 对象仓库不存在', { indexedDb: makeIndexedDb({ hasStore: false }) }],
  ['G9 记录里没有 accessToken', { indexedDb: makeIndexedDb({ records: [{ fbase_key: 'k', value: { uid: 'u' } }] }) }],
  ['G10 宿主没有 databases() API', { indexedDb: makeIndexedDb({ noDatabasesApi: true }) }]
]) {
  const { saved, response } = await runScenario(scenario);
  check(`${name} → 照常入库、genres 退回卡片上那一个`,
    response?.success === true && saved.length === 3 && eq(saved[0]?.genres, ['Against All Odds']),
    show({ n: saved.length, genres: saved[0]?.genres }));
}

// ---------- I id 守卫与去重 ----------
{
  const { saved } = await runScenario({
    sections: [section('Top Recommended', [
      card({ id: '0', title: '没有数字尾段', slug: 'x', href: '/drama/no-trailing-number' }),
      card({ id: '198', title: 'How to Fake Date Your Enemy', slug: 'how-to-fake-date-your-enemy' })
    ])]
  });
  check('I1 URL 尾段不是数字的卡跳过', eq(saved.map(d => d.itemId), ['sc198']), show(saved.map(d => d.itemId)));
}
{
  // 同一张卡的封面与标题各是一个 /drama/ 链接 → 不能重复入库
  const twoLinks = el('div', { class: 'w-full group relative' }, [
    el('a', { href: '/drama/room-service-193' }, [el('img', { alt: 'Room Service', src: `${CDN}/193/image.webp` })]),
    el('a', { href: '/drama/room-service-193' }, [], 'Room Service'),
    el('p', {}, [], 'An unexpected pregnancy story.')
  ]);
  const { saved } = await runScenario({ sections: [section('Top Recommended', [twoLinks])] });
  check('I2 同卡多个同 id 链接只入库一次', eq(saved.map(d => d.itemId), ['sc193']), show(saved.map(d => d.itemId)));
}
{
  const existing = { itemId: 'sc198', title: 'How to Fake Date Your Enemy', source: 'shortical', genres: ['Against All Odds', 'Forbidden Romance'], scrapedAt: '2026-09-01T00:00:00.000Z' };
  const { saveCalls } = await runScenario({ dramas: [existing] });
  check('I3 已存在且已有 genres → 该条零 saveDrama',
    !saveCalls.some(s => s.itemId === 'sc198'), show(saveCalls.map(s => s.itemId)));
}

// ---------- C 规范 slug：首页 href 尾段的数字不是规范 id ----------
// 站点两套 id 并行：首页卡片 href 来自实时接口（实测 2100–2250 区间的新号），而详情页只吃
// 静态发布产物（SPA 取 /_seo/drama/<id>.json，拿不到就渲染 404）。所以 href 那个号一大半
// 打不开，且它还被当成 itemId → 同一部剧 id 漂移、反复当新卡入库。规范源是 sitemap。
{
  const { saved, sitemapCalls } = await runScenario({
    sections: [section('Top Recommended', [card({ id: '2200', title: 'Bound by Fire', slug: 'bound-by-fire' })])],
    sitemap: ['bound-by-fire-163']
  });
  check('C1 url 与 itemId 都取 sitemap 的规范值，不用 href 尾段那个号',
    eq(saved.map(d => [d.itemId, d.url]), [['sc163', 'https://shortical.com/drama/bound-by-fire-163']]),
    show(saved.map(d => [d.itemId, d.url])));
  check('C1b sitemap 每轮只取一次', sitemapCalls.length === 1, show(sitemapCalls));
}
{
  // 实测 sc2200/sc2201、sc2227/sc2249 等 7 对重复就是这么来的
  const { saved } = await runScenario({
    sections: [section('Top Recommended', [
      card({ id: '2200', title: 'Bound by Fire', slug: 'bound-by-fire' }),
      card({ id: '2201', title: 'Bound by Fire', slug: 'bound-by-fire' })
    ])],
    sitemap: ['bound-by-fire-163']
  });
  check('C2 两个不同高号指向同一部剧 → 按规范 id 去重、只入一条',
    eq(saved.map(d => d.itemId), ['sc163']), show(saved.map(d => d.itemId)));
}
{
  const { saved, response } = await runScenario({
    sections: [section('Top Recommended', [
      card({ id: '2199', title: '静态产物还没收录', slug: 'not-published-yet' }),
      card({ id: '193', title: 'Room Service', slug: 'room-service' })
    ])],
    sitemap: ['room-service-193']
  });
  check('C3 sitemap 里没有的剧跳过该卡、其余照常入库（下轮重试）',
    response?.success === true && eq(saved.map(d => d.itemId), ['sc193']), show(saved.map(d => d.itemId)));
}
for (const [name, sitemapImpl] of [
  ['C4 sitemap HTTP 500', async () => ({ ok: false, status: 500, text: async () => '' })],
  ['C4b sitemap 抛异常', async () => { throw new Error('network down'); }],
  ['C4c sitemap 回空壳 HTML（站点对未命中路径一律 200+空壳）',
    async () => ({ ok: true, status: 200, text: async () => '<!doctype html><html><body><div id="root"></div></body></html>' })],
  ['C4d sitemap 里一条 /drama/ 都没有', async () => ({ ok: true, status: 200, text: async () => sitemapXml([]) })]
]) {
  const { saved, response } = await runScenario({ sitemapImpl });
  check(`${name} → 本轮零入库、不报错（绝不退回 href 尾段那个号）`,
    response?.success === true && saved.length === 0, show(saved.length));
}
{
  const { saved, apiCalls } = await runScenario({
    sections: [section('Top Recommended', [card({ id: '2192', title: 'Owned by the Wolf', slug: 'owned-by-the-wolf', category: 'Romance' })])],
    sitemap: ['owned-by-the-wolf-184'],
    apiImpl: async () => ({ ok: true, status: 200, json: async () => [apiRow('2192', ['Romance', 'Billionaire', 'Fantasy', 'Werewolf / shifter romance'])] })
  });
  check('C5 genres 仍按 href 尾段的号匹配接口（换成规范 id 会全线失配、静默退成单标签）',
    saved[0]?.itemId === 'sc184'
    && eq(saved[0]?.genres, ['Romance', 'Billionaire', 'Fantasy', 'Werewolf / shifter romance']),
    show([saved[0]?.itemId, saved[0]?.genres]));
  check('C5b 接口仍只调一次', apiCalls.length === 1, show(apiCalls.length));
}
{
  // sitemap 也会收录高号（实测有 the-maid-and-the-ice-prince-2120），按 slug 基名匹配对两种都成立
  const { saved } = await runScenario({
    sections: [section('Top Recommended', [card({ id: '2120', title: 'The Maid And The Ice Prince', slug: 'the-maid-and-the-ice-prince' })])],
    sitemap: ['the-maid-and-the-ice-prince-2120']
  });
  check('C6 规范 id 本身就是高号时照常入库（不是「低号才对」）',
    eq(saved.map(d => [d.itemId, d.url]), [['sc2120', 'https://shortical.com/drama/the-maid-and-the-ice-prince-2120']]),
    show(saved.map(d => [d.itemId, d.url])));
}

// ---------- L 区块定位 ----------
{
  const { saved } = await runScenario({
    href: HOME,
    subscriptions: [{ urlPattern: HOME, tags: ['Shortical', 'Top'] }],
    sections: [section('More Recommended', [card({ id: '999', title: '别的板块', slug: 'other' })]),
      section('Top Recommended', DEFAULT_CARDS)]
  });
  check('L1 无 ?list= 时默认 top_recommended，不会抓到别的板块',
    eq(saved.map(d => d.itemId), ['sc198', 'sc193', 'sc152']), show(saved.map(d => d.itemId)));
}
{
  const { saved } = await runScenario({
    href: `${HOME}?list=more_recommended`,
    subscriptions: [{ urlPattern: `${HOME}?list=more_recommended`, tags: ['Shortical', 'More'] }],
    sections: [section('Top Recommended', DEFAULT_CARDS),
      section('More Recommended', [card({ id: '881', title: '更多推荐', slug: 'more-one' })])]
  });
  check('L2 ?list= 按板块标题归一化匹配（日后加板块零代码）',
    eq(saved.map(d => d.itemId), ['sc881']), show(saved.map(d => d.itemId)));
}
{
  const { saved, response, sitemapCalls } = await runScenario({ sections: [section('Trending Now', DEFAULT_CARDS)] });
  check('L3 板块找不到 → 零入库且不报错', response?.success === true && saved.length === 0, show(saved.length));
  check('L3b 板块都没找到就不该去取 sitemap（先等区块、再取规范表）',
    sitemapCalls.length === 0, show(sitemapCalls));
}

// ---------- H hydrate 轮询：首轮空、随后才填上 ----------
{
  const filled = page([section('Top Recommended', DEFAULT_CARDS)]);
  const empty = page([section('Top Recommended', [])]);
  let polls = 0;
  const morphing = {
    getElementById() { return null; },
    createElement() { return { style: {}, disabled: false, innerHTML: '', addEventListener() {}, querySelector() { return null; } }; },
    body: { appendChild() {} },
    querySelector: sel => (polls > 2 ? filled : empty).querySelector(sel),
    querySelectorAll: sel => { polls++; return (polls > 2 ? filled : empty).querySelectorAll(sel); }
  };
  const store = { dramas: [] };
  const listeners = [];
  globalThis.chrome = {
    storage: { local: { async get() { return { dramas: [], urlTags: [SUB] }; } } },
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      async sendMessage(message) {
        if (message?.action === 'saveDrama') { store.dramas.push(message.drama); return { success: true, saved: true }; }
        return { success: true };
      }
    }
  };
  globalThis.window = { location: loc(`${HOME}?list=top_recommended`) };
  globalThis.document = morphing;
  globalThis.indexedDB = makeIndexedDb({ dbNames: [] }).idb;
  globalThis.fetch = async url => (String(url).includes('/sitemaps/series.xml')
    ? { ok: true, status: 200, text: async () => sitemapXml(DEFAULT_SITEMAP) }
    : { ok: false, status: 401, json: async () => ({}) });
  (0, eval)(contentSrc);
  await new Promise(resolve => { for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve); });
  check('H1 首轮 DOM 还空时轮询等 hydrate，填上后照常抓到',
    eq(store.dramas.map(d => d.itemId), ['sc198', 'sc193', 'sc152']), show(store.dramas.map(d => d.itemId)));
}

// ---------- P 路径闸门 ----------
{
  const { saved } = await runScenario({
    href: 'https://shortical.com/drama/room-service-193',
    subscriptions: [{ urlPattern: 'https://shortical.com/drama/room-service-193', tags: ['Shortical', 'X'] }]
  });
  check('P1 详情页不抓（adapter.matches 只认 pathname === "/"）', saved.length === 0, show(saved.length));
}
{
  const { saved } = await runScenario({
    href: 'https://shortical.com/browse',
    subscriptions: [{ urlPattern: 'https://shortical.com/browse', tags: ['Shortical', 'X'] }]
  });
  check('P2 浏览页不抓', saved.length === 0, show(saved.length));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
