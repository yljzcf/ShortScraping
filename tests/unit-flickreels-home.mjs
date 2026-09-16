import './bootstrap.cjs';
// FlickReels 首页板块适配器单测（v1.6.5）：零网络加载真实 content.js（先 eval site-registry）。
// fixture 由测试内的最小 devalue flatten 生成——形状对齐 Nuxt 3 真实 __NUXT_DATA__：双层
// ShallowReactive 包装、原始值按值共用下标、-1 undefined / -2 数组空洞 / -3 NaN 哨兵、
// ["Date", iso] 内联、父节点先占位再递归。
// 覆盖：载荷解码（包装/哨兵/共享引用/未知形态/坏数据）、板块选择（?list= 归一化）、id 守卫、
// 字段映射、slug 表驱动（逐条对照 2026-09-16 实测 200 的真实 URL）、预告跳过、去重/回填、
// 路径闸门、订阅匹配。全程零网络：fetch 一律抛错。
// 用法：node tests/unit-flickreels-home.mjs
import fs from 'node:fs';

const contentSrc = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
(0, eval)(fs.readFileSync(new URL('../src/shared/site-registry.js', import.meta.url), 'utf8'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = v => JSON.stringify(v);

// 压掉内容脚本日志噪音
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

// ---------- fixture：最小 devalue flatten（只为造载荷，形状对齐真实 __NUXT_DATA__） ----------
class Wrapped { constructor(type, inner) { this.type = type; this.inner = inner; } }
const wrap = (type, inner) => new Wrapped(type, inner);
function flatten(root) {
  const values = [];
  const prim = new Map();
  const put = v => values.push(v) - 1;
  const visit = v => {
    if (v === undefined) return -1;
    if (typeof v === 'number' && Number.isNaN(v)) return -3;
    if (v === null || typeof v !== 'object') {
      if (!prim.has(v)) prim.set(v, put(v));
      return prim.get(v);
    }
    if (v instanceof Date) return put(['Date', v.toISOString()]);
    const i = put(null);                       // 父节点先占位，下标顺序与 devalue 一致
    if (v instanceof Wrapped) values[i] = [v.type, visit(v.inner)];
    else if (Array.isArray(v)) {
      const arr = [];
      for (let k = 0; k < v.length; k++) arr.push(k in v ? visit(v[k]) : -2);
      values[i] = arr;
    } else {
      const o = {};
      for (const k of Object.keys(v)) o[k] = visit(v[k]);
      values[i] = o;
    }
    return i;
  };
  visit(root);
  return values;
}

const COVER = 'https://zshipubcf.farsunpteltd.com/playlet/1782901183_eBpQFwxmRR.jpg';
const SUFFIX = '?x-oss-process=image/resize,w_600,image/format,webp';
const tagObj = (name, i) => ({ id: String(1800 + i), name, base_id: '200', category: '剧情', sort: String(i) });
const playlet = ({ id, title, cover = COVER, introduce = 'Full introduce text.', tags = ['Age Gap', 'Marriage Before Love'],
  has_collection = false, is_playlet_trailer = false, upload_num = 40 }) => ({
  playlet_id: id, title, cover, upload_num, introduce,
  tag_list: tags.map((name, i) => (name === null ? null : tagObj(name, i))),
  has_collection, sort: 0, is_playlet_trailer
});
const section = (title, items, id = '9236') => ({
  column_config: {
    id, navigation_id: '6', style: '6', title, show_type: '11', show_num: String(items.length), column_type: '4',
    show_column_name: '11', algorithm_model: '9', card_config: '', recommend_rule: '0', background_url: '',
    background_color: '', playlet_select_type: '1', custom_style_config: '{}', hot_playlet_count_config: ''
  },
  playlet_total: items.length,
  playlet_list: items
});
const HOT = '🔥🔥🔥Hot Picks ';
const STAR = '7-Day Star🥇🥈🥉';
// 真实根形状：["ShallowReactive",1] → {data,state,once,_errors,serverRendered,path,pinia}，data 再套一层 ShallowReactive；
// state 里顺带放 Date 与稀疏数组，证明这些形态不干扰取数
const nuxtRoot = (sections, { dataKey = 'home-playletList', extraData = {}, state = {} } = {}) => wrap('ShallowReactive', {
  data: wrap('ShallowReactive', { 'language-list': [{ code_name: 'en', name: 'English' }], [dataKey]: sections, ...extraData }),
  state: { '$scolor-mode': { preference: 'dark' }, when: new Date('2026-09-16T00:00:00Z'), sparse: [1, , 2], ...state },
  once: [], _errors: { [dataKey]: null }, serverRendered: true, path: '/', pinia: { app: { channel_name: null } }
});
const nuxtDoc = (values, attrs = {}) => baseDocument({
  querySelector: sel => sel === 'script#__NUXT_DATA__'
    ? { textContent: typeof values === 'string' ? values : JSON.stringify(values), getAttribute: name => attrs[name] ?? null }
    : null
});
const homeDoc = (sections, opts) => nuxtDoc(flatten(nuxtRoot(sections, opts)));
const twoSections = (hot, star) => [section('Roll image', [playlet({ id: 8894, title: 'Roll One' })], '9278'), section(HOT, hot), section(STAR, star, '9238')];

const loc = (href) => { const u = new URL(href); return { href, hostname: u.hostname, pathname: u.pathname, search: u.search, origin: u.origin }; };
const HOME = 'https://www.flickreels.net/';
const SUB_HOT = { urlPattern: `${HOME}?list=hot_picks`, tags: ['FlickReels', 'HotPicks'] };
const SUB_STAR = { urlPattern: `${HOME}?list=7_day_star`, tags: ['FlickReels', '7DayStar'] };
const SUB_HOME = { urlPattern: HOME, tags: ['FlickReels', 'Home'] };   // 无 ?list 的默认板块场景专用
const SUBS = [SUB_HOT, SUB_STAR];

let fetchCalls = 0;
// 场景执行器：装桩 → eval 真实 content.js → 派发 'scrape' → 返回 { saved, saveCalls, proxyCalls, response }
async function runScenario({ location, subscriptions = SUBS, document, dramas = [] }) {
  const store = { dramas: structuredClone(dramas) };
  const saveCalls = [];
  const proxyCalls = [];
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
  globalThis.window = { location };
  globalThis.document = document;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('FlickReels 适配器不应发起任何网络请求'); };
  globalThis.DOMParser = class { parseFromString() { return baseDocument(); } };

  (0, eval)(contentSrc);
  const response = await new Promise(resolve => {
    for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
  });
  return { saved: store.dramas, saveCalls, proxyCalls, response };
}
const hotScenario = (hot, star = [playlet({ id: 9709, title: 'Star One' })], extra = {}) =>
  runScenario({ location: loc(`${HOME}?list=hot_picks`), document: homeDoc(twoSections(hot, star), extra.rootOpts), ...extra });

// ---------- P：载荷解码 ----------
{
  const { saved, response } = await hotScenario([
    playlet({ id: 8098, title: '  Only Her: Pregnant with My Ex\'s Mafia Father  ', tags: ['Age Gap', 'One-night stand'] }),
    playlet({ id: 7822, title: 'Sold to the Mafia Boss for One Night', tags: ['Redemption', 'Age Gap'] })
  ]);
  check('P1 双层 ShallowReactive 包装拆包后板块条目入库', response?.success === true && eq(saved.map(d => d.itemId), ['fr8098', 'fr7822']),
    show({ response, ids: saved.map(d => d.itemId) }));
  check('P2 两条目共用的标签字符串（同一下标）互不串',
    eq(saved[0]?.genres, ['Age Gap', 'One-night stand']) && eq(saved[1]?.genres, ['Redemption', 'Age Gap']),
    show(saved.map(d => d.genres)));

  // F 组字段映射直接复用本场景的第一条
  const d = saved[0] || {};
  check('F1 itemId=fr+playlet_id，id 形态 flickreels_<itemId>_<index>', d.itemId === 'fr8098' && d.id === 'flickreels_fr8098_0', show([d.itemId, d.id]));
  check('F2 标题去首尾空白', d.title === 'Only Her: Pregnant with My Ex\'s Mafia Father', show(d.title));
  check('F3 封面存站内卡片同款 OSS 缩放形态', d.poster === COVER + SUFFIX, show(d.poster));
  check('F5 简介取 introduce 全文', d.description === 'Full introduce text.', show(d.description));
  check('F6 source/status/译文占位/标签/归属 canonical',
    d.source === 'flickreels' && d.status === 'new' && d.titleZh === '' && d.descriptionZh === ''
    && eq(d.tags, ['FlickReels', 'HotPicks']) && d.sourceListUrl === SUB_HOT.urlPattern,
    show([d.source, d.status, d.titleZh, d.descriptionZh, d.tags, d.sourceListUrl]));
  check('F7 scrapedAt 为合法时间、translatedAt 为 null', Number.isFinite(Date.parse(d.scrapedAt)) && d.translatedAt === null, show([d.scrapedAt, d.translatedAt]));
  check('F8 has_collection=false → /episode-1 播放页（www 域）',
    d.url === 'https://www.flickreels.net/playlist/only-her-pregnant-with-my-exs-mafia-father/8098/episode-1', show(d.url));
}
{
  const sections = twoSections([playlet({ id: 1 , title: 'Wrapped' })], []);
  sections[1].playlet_list = wrap('Ref', sections[1].playlet_list);
  const { saved } = await runScenario({ location: loc(`${HOME}?list=hot_picks`), document: homeDoc(sections) });
  check('P1b playlet_list 额外套 Ref 包装仍能定位', eq(saved.map(d => d.itemId), ['fr1']), show(saved.map(d => d.itemId)));
}
{
  const item = playlet({ id: 3, title: 'Holes', upload_num: NaN });
  item.introduce = undefined;   // 构造后再置空：走解构默认值会把 undefined 替换成默认简介
  item.tag_list = [tagObj(' Age Gap ', 0), , tagObj('Age Gap', 1), null, tagObj('', 2), tagObj('Family', 3)];  // 空洞 + null + 重复 + 空名
  const { saved, response } = await hotScenario([item]);
  check('P3 undefined 哨兵→空串、数组空洞/null/空名被清洗、NaN 不抛',
    response?.success === true && saved.length === 1 && saved[0].description === '' && eq(saved[0].genres, ['Age Gap', 'Family']),
    show({ response, saved }));
  check('F4 genres 不含中文内部分类 category', !(saved[0]?.genres || []).includes('剧情'), show(saved[0]?.genres));
}
{
  const { saved, response } = await hotScenario([playlet({ id: 4, title: 'Fancy' })], undefined,
    { rootOpts: { state: { weird: wrap('FancyNewType', { a: 1 }), emptyRef: wrap('EmptyRef', '_') } } });
  check('P5 未知特殊形态 / EmptyRef 不抛、照常入库', response?.success === true && eq(saved.map(d => d.itemId), ['fr4']), show({ response, saved: saved.map(d => d.itemId) }));
}
{
  const cases = [
    ['P6 无 __NUXT_DATA__ 脚本', baseDocument()],
    ['P7 脚本文本是坏 JSON', nuxtDoc('[["ShallowReactive",1],{"data":')],
    ['P7b 脚本文本为空（载荷外置 data-src）', nuxtDoc('', { 'data-src': '/_payload.json' })],
    ['P7c 根不是数组', nuxtDoc('{"data":{}}')]
  ];
  for (const [name, document] of cases) {
    const { saved, response } = await runScenario({ location: loc(`${HOME}?list=hot_picks`), document });
    check(`${name} → 0 条且响应成功不抛错`, saved.length === 0 && response?.success === true, show(response));
  }
}
{
  const values = flatten(wrap('ShallowReactive', { data: wrap('ShallowReactive', { other: { foo: 'bar' }, list: [1, 2] }), state: {} }));
  const { saved, response } = await runScenario({ location: loc(`${HOME}?list=hot_picks`), document: nuxtDoc(values) });
  check('P8 data 里没有板块形状的数组 → 0 条不抛', saved.length === 0 && response?.success === true, show(response));
}
{
  const { saved } = await hotScenario([playlet({ id: 5, title: 'Renamed Key' })], undefined, { rootOpts: { dataKey: 'index-playletList' } });
  check('P9 板块数组按形状定位、不写死 useAsyncData 键名', eq(saved.map(d => d.itemId), ['fr5']), show(saved.map(d => d.itemId)));
}

// ---------- S：板块选择（?list= 归一化） ----------
const HOT_ITEMS = [playlet({ id: 8098, title: 'Hot A' }), playlet({ id: 7822, title: 'Hot B' })];
const STAR_ITEMS = [playlet({ id: 9709, title: 'Star A' })];
{
  const { saved } = await runScenario({ location: loc(`${HOME}?list=7_day_star`), document: homeDoc(twoSections(HOT_ITEMS, STAR_ITEMS)) });
  check('S1 ?list=7_day_star 只取 7-Day Star 板块（emoji 归一化后匹配）', eq(saved.map(d => d.itemId), ['fr9709']), show(saved.map(d => d.itemId)));
  check('U1 标签取所属订阅（7DayStar）', eq(saved[0]?.tags, ['FlickReels', '7DayStar']) && saved[0]?.sourceListUrl === SUB_STAR.urlPattern, show([saved[0]?.tags, saved[0]?.sourceListUrl]));
}
{
  const { saved } = await runScenario({ location: loc(HOME), subscriptions: [SUB_HOME], document: homeDoc(twoSections(HOT_ITEMS, STAR_ITEMS)) });
  check('S2 无 ?list 默认 hot_picks', eq(saved.map(d => d.itemId), ['fr8098', 'fr7822']), show(saved.map(d => d.itemId)));
}
{
  const { saved } = await runScenario({ location: loc(`${HOME}?list=Hot%20Picks!`), subscriptions: [SUB_HOME], document: homeDoc(twoSections(HOT_ITEMS, STAR_ITEMS)) });
  check('S3 非法 ?list 值回落默认 hot_picks', eq(saved.map(d => d.itemId), ['fr8098', 'fr7822']), show(saved.map(d => d.itemId)));
}
{
  const { saved, response } = await runScenario({ location: loc(`${HOME}?list=no_such`), subscriptions: [SUB_HOME], document: homeDoc(twoSections(HOT_ITEMS, STAR_ITEMS)) });
  check('S4 未知板块 → 0 条不抛', saved.length === 0 && response?.success === true, show(response));
}
{
  const { saved } = await runScenario({ location: loc(`${HOME}?list=roll_image`), subscriptions: [SUB_HOME], document: homeDoc(twoSections(HOT_ITEMS, STAR_ITEMS)) });
  check('S5 其它板块按同一约定可订（roll_image）', eq(saved.map(d => d.itemId), ['fr8894']), show(saved.map(d => d.itemId)));
}

// ---------- I：id 守卫 ----------
{
  const { saved } = await hotScenario([
    playlet({ id: 'abc', title: 'Bad' }), playlet({ id: undefined, title: 'Missing' }), playlet({ id: 12.5, title: 'Float' }),
    playlet({ id: '8098', title: 'String Id' })
  ]);
  check('I1 非数字 / 缺失 / 小数 playlet_id 跳过，字符串数字照常', eq(saved.map(d => d.itemId), ['fr8098']), show(saved.map(d => d.itemId)));
}

// ---------- F：封面与合集后缀 ----------
{
  const { saved } = await hotScenario([
    playlet({ id: 10, title: 'No Cover', cover: '' }),
    playlet({ id: 11, title: 'Has Query', cover: 'https://cdn.example/x.jpg?v=1' }),
    playlet({ id: 12, title: 'Collection', has_collection: true })
  ]);
  const by = Object.fromEntries(saved.map(d => [d.itemId, d]));
  check('F3b 封面为空 → poster 空串', by.fr10?.poster === '', show(by.fr10?.poster));
  check('F3c 封面自带查询串时不追加 OSS 参数', by.fr11?.poster === 'https://cdn.example/x.jpg?v=1', show(by.fr11?.poster));
  check('F9 has_collection=true → /full-movie', by.fr12?.url === 'https://www.flickreels.net/playlist/collection/12/full-movie', show(by.fr12?.url));
}

// ---------- L：slug 表驱动（逐条对照 2026-09-16 实测 200 的真实 URL） ----------
{
  const table = [
    ['Tame Me,My Lord', 'tame-memy-lord'],
    ["Fate's Sweet Embrace(Dubbed)", 'fates-sweet-embrace-dubbed'],
    ['He Lost Her for Good After the Fake Turned Real（Dubbed）', 'he-lost-her-for-good-after-the-fake-turned-real-dubbed'],
    ["Bride Swap：The Marquis' Reborn Bride", 'bride-swapthe-marquis-reborn-bride'],
    ['Mancini’s Forbidden Bride', 'mancinis-forbidden-bride'],
    ['Love at 50: From Janitor to Billionaire’s Wife', 'love-at-50-from-janitor-to-billionaires-wife'],
    ['From One Night to Mrs.Billionaire', 'from-one-night-to-mrsbillionaire'],
    ['Reborn at 18: The Great-Grandma Takes Charge Season 2(Dubbed)', 'reborn-at-18-the-great-grandma-takes-charge-season-2-dubbed'],
    ['A / B & C', 'a-b-c'],
    ['  Lead  Trail  ', 'lead-trail'],
    ['[Bracket] {Brace}', 'bracket-brace']
  ];
  const items = table.map(([title], i) => playlet({ id: 100 + i, title }));
  const { saved } = await hotScenario(items);
  const by = Object.fromEntries(saved.map(d => [d.itemId, d.url]));
  table.forEach(([title, slug], i) => {
    const expected = `https://www.flickreels.net/playlist/${slug}/${100 + i}/episode-1`;
    check(`L${i + 1} slug ${show(title)} → ${slug}`, by[`fr${100 + i}`] === expected, show(by[`fr${100 + i}`]));
  });
}
{
  const { saved } = await hotScenario([playlet({ id: 3090, title: 'Captain, Your Fiancée Married Someone Else' })]);
  const url = saved[0]?.url || '';
  check('L12 非 ASCII 字母保留并百分号编码（不是 slugifyTitle 的 fianc-e）',
    url === 'https://www.flickreels.net/playlist/captain-your-fianc%C3%A9e-married-someone-else/3090/episode-1' && !url.includes('fianc-e'), show(url));
}
{
  const { saved, response } = await hotScenario([playlet({ id: 200, title: '!!!' }), playlet({ id: 201, title: 'Fine' })]);
  check('L13 造不出 slug 的标题跳过（站点必 404），其余照常入库', response?.success === true && eq(saved.map(d => d.itemId), ['fr201']), show(saved.map(d => d.itemId)));
}

// ---------- T：预告条目跳过 ----------
{
  const { saved, response } = await hotScenario([playlet({ id: 300, title: 'Trailer Only', is_playlet_trailer: true })]);
  check('T1 仅预告条目 → 0 条', response?.success === true && saved.length === 0, show(saved));
}
{
  const { saved, saveCalls } = await hotScenario([
    playlet({ id: 301, title: 'Trailer', is_playlet_trailer: true }), playlet({ id: 302, title: 'Released' })
  ]);
  check('T2 混合时只存非预告，预告不产生 saveDrama', eq(saved.map(d => d.itemId), ['fr302']) && saveCalls.length === 1, show(saveCalls.map(d => d.itemId)));
}

// ---------- R：去重 / 回填 ----------
{
  const existing = { id: 'flickreels_fr8098_0', itemId: 'fr8098', title: 'Hot A', source: 'flickreels', tags: ['FlickReels', 'HotPicks'], genres: ['Age Gap'], sourceListUrl: SUB_HOT.urlPattern, status: 'trans' };
  const { saveCalls } = await runScenario({ location: loc(`${HOME}?list=7_day_star`), document: homeDoc(twoSections(HOT_ITEMS, [playlet({ id: 8098, title: 'Hot A' })])), dramas: [existing] });
  check('R1 两板块重叠条目先到先得：已入库（有 genres）→ 零 saveDrama、不追加标签', saveCalls.length === 0, show(saveCalls));
}
{
  const existing = { id: 'flickreels_fr8098_0', itemId: 'fr8098', title: 'Hot A', source: 'flickreels', tags: ['FlickReels', 'HotPicks'], genres: [], sourceListUrl: SUB_HOT.urlPattern, status: 'new' };
  const { saveCalls, proxyCalls } = await hotScenario([playlet({ id: 8098, title: 'Hot A', tags: ['Age Gap', 'Family'] })], [], { dramas: [existing] });
  check('R2 库中缺 genres 的存量 → 恰 1 次回填（列表数据自带，零代理零 fetch）',
    saveCalls.length === 1 && eq(saveCalls[0]?.genres, ['Age Gap', 'Family']) && proxyCalls.length === 0, show({ saveCalls: saveCalls.map(d => d.genres), proxyCalls }));
}

// ---------- M：路径闸门 ----------
{
  const doc = homeDoc(twoSections(HOT_ITEMS, STAR_ITEMS));
  for (const path of ['/ja/', '/tc/', '/playlist/hot-a/8098/episode-1']) {
    const href = `https://www.flickreels.net${path}`;
    const { saved, response } = await runScenario({ location: loc(href), subscriptions: [{ urlPattern: href, tags: ['FlickReels', 'X'] }], document: doc });
    check(`M 非首页路径 ${path} 即使被订阅也 0 条`, saved.length === 0 && response?.success === true, show(response));
  }
  const { saved } = await runScenario({ location: loc(`${HOME}?foo=bar`), subscriptions: [SUB_HOME], document: doc });
  check('M4 首页带无关 query 照常（默认 hot_picks）', eq(saved.map(d => d.itemId), ['fr8098', 'fr7822']), show(saved.map(d => d.itemId)));
}

// ---------- U：订阅匹配约定 ----------
{
  const { saved, response } = await runScenario({ location: loc(HOME), subscriptions: SUBS, document: homeDoc(twoSections(HOT_ITEMS, STAR_ITEMS)) });
  check('U2 页面无 query 而订阅只有带 ?list= 的两条 → 不在订阅、0 条（订阅必须带 www 与 query）', saved.length === 0 && response?.success === true, show(response));
}
check('Z 全程零 fetch（列表数据自带全文简介与标签，无详情请求）', fetchCalls === 0, `fetchCalls=${fetchCalls}`);

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
