import './bootstrap.cjs';
// Higgsfield（higgsfield.ai/community/originals）适配器单测（v1.7.2）：加载真实 content.js（先 eval site-registry）。
//
// 规则目录只订**整页**一条（不带 ?list=）：页上三个板块合起来正好是全部已上线作品（W 组，2026-09-27 用户定：
// 三个板块标签相同，拆三条订阅没有区分意义）；?list=<板块> 单订某个板块的能力保留（L 组）。
//
// 本站的要害有四条，各对应一组断言：
// 1. **不读 DOM**：板块是横向虚拟列表（16 部的板块 DOM 里只渲染 4~8 张），适配器改调页面自己用的
//    那个接口，一次拿全部作品。假 document 的 querySelector 一律抛错——哪天有人改回读 DOM 当场 RED（G3）。
// 2. **三个板块的切分规则照抄站点前端**（L 组）：Choice / First Look 各认自己的分类、两者可重叠；
//    On Our Radar 是「前两个分类都不含」的剩余项——带 on-our-radar 分类但已在精选 / First Look 里的
//    作品**不算**，没有任何分类的作品反而算。所以三者的并集＝全部已上线作品＝整页（W2 直接对账）。
//    coming soon 整页与三个板块都不收。
// 3. **封面存站点缩放代理小图、推送侧换同一代理的 1080 宽档**（F4 组；不解包成 CloudFront 原图，那边有最大近 10MB 的 png）：content.js 的 higgsfieldThumb
//    与 lark.js 的 posterForPayload 成对，这里拿真实 lark.js 做往返。
// 4. **作品地址是播放页形态** /original-series/<slug>/<首集 slug>（/original-series/<slug> 本身是 404），
//    没有分集的条目没有播放页 → 跳过（I 组）。
//
// 夹具取自 2026-09-27 接口实测载荷（字段名与形态保真，简介截短）。每存一张卡 content.js 会 sleep 200ms，
// 故夹具只放 10 条。
// 用法：node tests/unit-higgsfield-originals.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { scrapeContextReply } from './content-fixture.mjs';

const require = createRequire(import.meta.url);
const Lark = require('../src/shared/lark.js');
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

// ---------- fixture：接口条目的真实形状 ----------
const API = 'https://fnf-api-gw.higgsfield.ai/fnf-series/series?order=curated&limit=100&offset=0';
const CDN = 'https://du4zrvwy3vtek.cloudfront.net/series';
const CAT = {
  choice: { display_order: 0, id: 'ea5e2640-d43a-4470-bd82-e027891d4112', name: 'Higgsfield Choice', slug: 'higgsfield-choice' },
  first: { display_order: 1, id: '9d807d72-6bd5-4f89-9b9a-c048f3905fa6', name: 'First Look', slug: 'first-look' },
  radar: { display_order: 3, id: '3530d6b1-129a-46fa-9403-c2f30b2bd165', name: 'On Our Radar', slug: 'on-our-radar' },
  soon: { display_order: 150, id: '88021516-449b-4cf0-9cc6-8aa40a9d2364', name: 'Coming Soon', slug: 'coming-soon' }
};

const series = ({
  id, slug, name, cats = [], state = 'released',
  portrait = `${CDN}/${id}/portrait/p-${slug}_optimized.webp`,
  landscape = `${CDN}/${id}/landscape/l-${slug}_optimized.webp`,
  short = `Short blurb of ${slug}.`,
  full = `Full description of ${slug}. It is longer than the short blurb.`,
  episodes = [{ slug: 'full-film', title: name, episode_number: 1 }]
}) => ({
  id, slug, name, short_description: short, author_type: 'higgsfield_team', is_series: episodes.length > 1, state,
  portrait_url: portrait, landscape_url: landscape, background_url: null, logo_url: null, trailer_url: null,
  portrait: { original: { url: portrait } }, landscape: { original: { url: landscape } },
  is_hero: false, hero_order: null, display_order: 0, project_url: null, project_banner_images: [],
  categories: cats, cast: [], tags: [], vote_count: 1, subscriber_count: 0, engagement_score: 0.9,
  is_vote_triggered: false, is_notify_triggered: false,
  created_at: '2026-09-25T13:34:35.486063+00:00', updated_at: '2026-09-27T08:56:07.106945+00:00',
  full_description: full,
  episodes: episodes.map((e, i) => ({ id: `ep-${slug}-${i}`, series_id: id, is_locked: false, is_adults_only: false, ...e })),
  duration_seconds: 271, project_publication_id: null,
  engagement: { comment_count: 10, like_count: 48, view_count: 6360 }
});

// A–G 各代表一种板块归属；H 是 coming soon；I/J 是两类坏条目（都挂在精选里，考的是适配器自己的闸门）
const A = series({
  id: 'b7ab12d0-769e-4420-91d8-f59f9c13c9a1', slug: 'passport-rush', name: 'Passport Rush', cats: [CAT.choice],
  portrait: `${CDN}/b7ab12d0-769e-4420-91d8-f59f9c13c9a1/portrait/585ed38b-328b-4075-b006-70c6a2e7f172_optimized.webp`,
  short: 'Minutes from boarding, a young woman realizes her passport is across town.',
  full: 'Minutes from boarding, a young woman realizes her passport is across town. Ahead: a mad dash through an absurd apocalypse to make her flight.'
});
// 精选与 First Look 重叠
const B = series({
  id: 'af6e1e33-b457-4e3f-92c2-5b2259320a00', slug: 'hell-grind', name: 'HELL GRIND', cats: [CAT.choice, CAT.first],
  episodes: [{ slug: 'episode-1', title: 'Episode 1', episode_number: 1 }]
});
// 精选 + on-our-radar 分类：On Our Radar 板块**不收**它（剩余项语义）；名字带尾空格、海报没有优化档（png 原图）、5 集
const C = series({
  id: 'f11e4476-a1ff-49a9-93a8-e2fd334785e3', slug: 'mork', name: 'MORK ', cats: [CAT.choice, CAT.radar],
  portrait: `${CDN}/f11e4476-a1ff-49a9-93a8-e2fd334785e3/portrait/35395ccb-8ab9-4bca-926c-939e56601a83.png`,
  episodes: [1, 2, 3, 4, 5].map(n => ({ slug: `episode-${n}`, title: n === 1 ? 'Episide 1' : `Episode ${n}`, episode_number: n }))
});
// First Look + on-our-radar 分类：同样不进 On Our Radar
const D = series({
  id: '9c99cbba-4dc3-43bf-aa06-465163f15898', slug: 'tails-of-steel', name: 'TAILS OF STEEL', cats: [CAT.first, CAT.radar],
  episodes: [{ slug: 'episode-1', title: 'Episode 1', episode_number: 1 }]
});
// 只有 on-our-radar 分类
const E = series({
  id: 'e94db9f1-156e-4df5-8601-96190bdbd53e', slug: 'peter-pan', name: 'PETER PAN', cats: [CAT.radar],
  episodes: [{ slug: 'episode-1', title: 'Episode 1', episode_number: 1 }]
});
// 没有任何分类（新上线还没归类）→ On Our Radar；简介带硬换行
const F = series({
  id: '9b62e542-4592-4049-8292-717737c4e3fb', slug: 'vengeance-is-mine', name: 'Vengeance is mine', cats: [],
  full: 'A sleepy Texas town in the nineteenth century.\nA stranger walks in and starts killing,\ncalmly and without a word of explanation.\n'
});
// 没有任何分类；full_description 缺失 → 退 short；没有竖版海报 → 退横版
const G = series({
  id: '0D9D7A26-233A-40B5-BCE3-69128CDE625D', slug: 'cully-hill-boys', name: 'The Cully Hill Boys', cats: [],
  portrait: '', full: null,
  short: 'The Cully Hill Boys is an action-comedy that follows three underachieving London rappers.'
});
// coming soon：实测这类条目没有分集，这里刻意给一条预告分集，让 state 过滤单独受考（否则「没分集就跳过」那道闸会替它挡掉）
const H = series({
  id: 'a657c4dd-bb0a-4a6f-a2e2-2fbb3acce0fd', slug: 'golden-hour', name: 'GOLDEN HOUR', cats: [CAT.soon],
  state: 'coming_soon', episodes: [{ slug: 'teaser', title: 'Teaser', episode_number: 1 }]
});
const I = series({ id: 'not-a-uuid', slug: 'bad-id', name: 'Bad Id', cats: [CAT.choice] });
const J = series({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', slug: 'no-episodes', name: 'No Episodes', cats: [CAT.choice], episodes: [] });

const ALL = [A, B, C, D, E, F, G, H, I, J];
const hf = x => `hf${x.id.toLowerCase()}`;

const PAGE = 'https://higgsfield.ai/community/originals';
const CHOICE = `${PAGE}?list=higgsfield_choice`;
const FIRST = `${PAGE}?list=first_look`;
const RADAR = `${PAGE}?list=on_our_radar`;
const TAGS = ['Higgsfield', 'originals'];
const SUBS = [PAGE, CHOICE, FIRST, RADAR].map(urlPattern => ({ urlPattern, tags: TAGS }));

const loc = href => { const u = new URL(href); return { href, hostname: u.hostname, pathname: u.pathname, search: u.search, origin: u.origin }; };
const fakeElement = () => ({ style: {}, disabled: false, innerHTML: '', addEventListener() {}, querySelector() { return null; } });

/**
 * 假 document 只给浮动按钮用的那三样。querySelector / querySelectorAll 记账后抛错：适配器不许读 DOM
 * （虚拟列表只渲染可见的几张卡），读了就当场 RED，而不是悄悄返回 null 蒙混过关。
 */
function makeDocument(domReads) {
  const deny = (sel) => { domReads.push(sel); throw new Error(`Higgsfield 适配器不应读 DOM: ${sel}`); };
  return {
    getElementById() { return null; },
    createElement() { return fakeElement(); },
    querySelector: deny,
    querySelectorAll: deny,
    body: { appendChild() {} }
  };
}

const jsonResponse = body => ({ ok: true, status: 200, url: API, text: async () => JSON.stringify(body) });

async function runScenario({ href = PAGE, subscriptions = SUBS, items = ALL, apiImpl, dramas = [] } = {}) {
  const store = { dramas: structuredClone(dramas) };
  const saveCalls = [];
  const proxyCalls = [];
  const fetchCalls = [];
  const domReads = [];
  const listeners = [];

  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      async sendMessage(message) {
        await Promise.resolve();
        if (message?.action === 'getScrapeContext') return scrapeContextReply(store.dramas, subscriptions);
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
  globalThis.document = makeDocument(domReads);
  globalThis.DOMParser = class { parseFromString() { throw new Error('Higgsfield 适配器不应解析 HTML'); } };
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, headers: init && init.headers });
    if (apiImpl) return apiImpl(url, init);
    if (url !== API) return { ok: false, status: 404, text: async () => '' };
    return jsonResponse({ items: structuredClone(items), total: items.length });
  };

  (0, eval)(contentSrc);
  const response = await new Promise(resolve => {
    for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
  });
  return { saved: store.dramas, saveCalls, proxyCalls, fetchCalls, domReads, response };
}

// ---------- W 整页（规则目录里那一条）：全部已上线作品 ----------
const whole = await runScenario({ href: PAGE });
check('W1 整页订阅（不带 ?list=）＝全部已上线作品，按接口顺序；coming soon 不收、坏 id 与没分集的跳过',
  eq(whole.saved.map(d => d.itemId), [A, B, C, D, E, F, G].map(hf)), show(whole.saved.map(d => d.itemId)));
check('W1b 列表条数＝全部已上线条目（含随后被闸掉的坏条目），整页只在接口失败时才会抓到 0 条',
  whole.response?.success === true && whole.response?.subscribed === true && whole.response?.listCount === 9
    && whole.response?.newCount === 7,
  show(whole.response));

// ---------- L 三个板块的切分（照抄站点前端；单订某个板块用） ----------
const choice = await runScenario({ href: CHOICE });
check('L1 higgsfield_choice：分类含 higgsfield-choice 的已上线作品，按接口顺序',
  eq(choice.saved.map(d => d.itemId), [A, B, C].map(hf)), show(choice.saved.map(d => d.itemId)));
check('L1b 列表条数含随后被闸掉的坏条目（坏 id、没分集），0 条告警只在板块真空时触发',
  choice.response?.success === true && choice.response?.subscribed === true && choice.response?.listCount === 5
    && choice.response?.newCount === 3,
  show(choice.response));

const first = await runScenario({ href: FIRST });
check('L2 first_look：分类含 first-look，与精选重叠的作品同样在列（HELL GRIND）',
  eq(first.saved.map(d => d.itemId), [B, D].map(hf)), show(first.saved.map(d => d.itemId)));

const radar = await runScenario({ href: RADAR });
check('L3 on_our_radar 是剩余项：只带 on-our-radar 分类的与完全没分类的都收，已在精选 / First Look 里的不收，coming soon 不收',
  eq(radar.saved.map(d => d.itemId), [E, F, G].map(hf)), show(radar.saved.map(d => d.itemId)));
{
  const union = [...new Set([choice, first, radar].flatMap(run => run.saved.map(d => d.itemId)))].sort();
  check('W2 三个板块的并集恰好等于整页（On Our Radar 是剩余项，合并成一条订阅不漏不多）',
    eq(union, whole.saved.map(d => d.itemId).sort()), show({ union, whole: whole.saved.map(d => d.itemId) }));
}
{
  const url = `${PAGE}?list=Higgsfield%20Choice`;
  const { saved } = await runScenario({ href: url, subscriptions: [{ urlPattern: url, tags: TAGS }] });
  check('L5 ?list= 按板块标题归一化（Higgsfield Choice → higgsfield_choice）',
    eq(saved.map(d => d.itemId), [A, B, C].map(hf)), show(saved.map(d => d.itemId)));
}
for (const [name, list] of [
  ['L6 未知板块（coming_soon 不是板块）', 'coming_soon'],
  ['L7 归一化后为空的 ?list=', '%21%21']
]) {
  const url = `${PAGE}?list=${list}`;
  const { saved, fetchCalls, response } = await runScenario({ href: url, subscriptions: [{ urlPattern: url, tags: TAGS }] });
  check(`${name} → 零入库、不发请求、不退回默认板块`,
    response?.success === true && saved.length === 0 && fetchCalls.length === 0, show({ saved: saved.length, fetchCalls }));
}
{
  const { saved, response } = await runScenario({ href: RADAR, items: [A, B, D, H] });
  check('L8 所有已上线作品都归进前两个板块时 On Our Radar 为空，listCount=0（后台据此提示抓到 0 条）',
    response?.success === true && response?.listCount === 0 && saved.length === 0, show(response));
}

// ---------- F 字段映射 ----------
{
  const a = choice.saved.find(d => d.itemId === hf(A));
  const c = choice.saved.find(d => d.itemId === hf(C));
  const f = radar.saved.find(d => d.itemId === hf(F));
  const g = radar.saved.find(d => d.itemId === hf(G));
  check('F1 itemId＝hf+小写 UUID，id＝higgsfield_<itemId>_<序号>',
    !!a && a.itemId === 'hfb7ab12d0-769e-4420-91d8-f59f9c13c9a1' && a.id === `higgsfield_${a.itemId}_0`
      && !!g && g.itemId === 'hf0d9d7a26-233a-40b5-bce3-69128cde625d',
    show({ a: a && [a.itemId, a.id], g: g && g.itemId }));
  check('F2 标题折叠空白并 trim（站点数据里有 "MORK " 这种尾空格）',
    !!a && a.title === 'Passport Rush' && !!c && c.title === 'MORK', show({ a: a?.title, c: c?.title }));
  check('F3 简介取 full_description（比 short 长）', !!a && a.description === A.full_description, show(a?.description));
  check('F3b 简介里的硬换行折成空格', !!f && f.description ===
    'A sleepy Texas town in the nineteenth century. A stranger walks in and starts killing, calmly and without a word of explanation.',
    show(f?.description));
  check('F3c full_description 缺失时退 short_description', !!g && g.description === G.short_description, show(g?.description));

  const thumb = raw => `https://images.higgs.ai/?default=1&output=webp&url=${encodeURIComponent(raw)}&w=384&q=85`;
  check('F4 封面存站点缩放代理的 384 宽小图（竖版海报）', !!a && a.poster === thumb(A.portrait_url), show(a?.poster));
  check('F4b 没有优化档的 png 原图同样走缩放代理（弹窗不去拉最大近 10MB 的原图）',
    !!c && c.poster === thumb(C.portrait_url), show(c?.poster));
  check('F4c 没有竖版海报时退横版', !!g && g.poster === thumb(G.landscape_url), show(g?.poster));
  const big = raw => `https://images.higgs.ai/?default=1&output=webp&w=1080&q=85&url=${raw}`;
  check('F4d 推送侧 posterForPayload 换成同一代理的 1080 宽档、内层是原封面地址（与 lark.js 成对）',
    !!a && !!c && Lark.posterForPayload(a.poster) === big(A.portrait_url) && Lark.posterForPayload(c.poster) === big(C.portrait_url),
    show({ a: a && Lark.posterForPayload(a.poster), c: c && Lark.posterForPayload(c.poster) }));

  check('F5 url 是播放页 /original-series/<slug>/<首集 slug>（剧集落在第 1 集）',
    !!a && a.url === 'https://higgsfield.ai/original-series/passport-rush/full-film'
      && !!c && c.url === 'https://higgsfield.ai/original-series/mork/episode-1',
    show({ a: a?.url, c: c?.url }));
  check('F6 接口没有内容类型字段，genres 留空（categories 只是板块名，不当 genres）',
    choice.saved.every(d => eq(d.genres, [])) && radar.saved.every(d => eq(d.genres, [])),
    show(choice.saved.map(d => d.genres)));
  check('F7 骨架默认值：source / status / 中文位 / tags / sourceListUrl＝订阅 URL',
    choice.saved.every(d => d.source === 'higgsfield' && d.status === 'new' && d.titleZh === '' && d.descriptionZh === ''
      && eq(d.tags, TAGS) && d.sourceListUrl === CHOICE)
      && radar.saved.every(d => d.sourceListUrl === RADAR) && whole.saved.every(d => d.sourceListUrl === PAGE),
    show(choice.saved.map(d => [d.source, d.status, d.tags, d.sourceListUrl])));
  check('F8 scrapedAt 可解析、translatedAt 为 null',
    choice.saved.every(d => !Number.isNaN(Date.parse(d.scrapedAt)) && d.translatedAt === null), '');
}

// ---------- I 适配器自己的闸门 ----------
{
  const titles = choice.saveCalls.map(d => d.title);
  check('I1 id 不是 UUID 的条目跳过', !titles.includes('Bad Id'), show(titles));
  check('I2 没有分集（没有播放页）的条目跳过', !titles.includes('No Episodes'), show(titles));
  check('I3 coming soon 整页与三个板块都不收',
    ![whole, choice, first, radar].some(run => run.saveCalls.some(d => d.title === 'GOLDEN HOUR')), '');
}

// ---------- D 全局去重 ----------
{
  const existing = { ...structuredClone(choice.saved[0]), genres: [] };
  const { saveCalls, response } = await runScenario({ href: CHOICE, dramas: [existing] });
  check('D1 已入库的作品不再提交，只存新的',
    response?.newCount === 2 && eq(saveCalls.map(d => d.itemId), [B, C].map(hf)), show({ response, ids: saveCalls.map(d => d.itemId) }));
}

// ---------- N 接口失败面：一律零入库、不报错、下轮重试 ----------
for (const [name, apiImpl] of [
  ['N1 HTTP 500', async () => ({ ok: false, status: 500, text: async () => 'oops' })],
  ['N2 网络错误', async () => { throw new TypeError('Failed to fetch'); }],
  ['N3 响应不是 JSON', async () => ({ ok: true, status: 200, text: async () => '<html>challenge</html>' })],
  ['N4 items 不是数组', async () => jsonResponse({ items: 'nope', total: 0 })],
  ['N5 响应是 null', async () => jsonResponse(null)]
]) {
  const { saved, saveCalls, response } = await runScenario({ apiImpl });
  check(`${name} → 零入库且不报错`,
    response?.success === true && saved.length === 0 && saveCalls.length === 0,
    show({ response, saved: saved.length }));
}
{
  const { saved } = await runScenario({ items: [null, 'x', 42, A] });
  check('N6 items 里的非对象元素被过滤，正常条目照常入库',
    eq(saved.map(d => d.itemId), [hf(A)]), show(saved.map(d => d.itemId)));
}

// ---------- G 取数方式 ----------
check('G1 每轮只请求一次，正是页面自己用的那个接口',
  [whole, choice, radar].every(run => eq(run.fetchCalls.map(c => c.url), [API])), show(whole.fetchCalls));
check('G2 不带自定义请求头（简单请求，免 CORS 预检）',
  [whole, choice].every(run => run.fetchCalls.every(c => c.headers === undefined)), show(whole.fetchCalls));
check('G3 全程不读 DOM、不走后台代理',
  [whole, choice, first, radar].every(run => run.domReads.length === 0 && run.proxyCalls.length === 0),
  show([whole, choice, first, radar].map(run => ({ dom: run.domReads, proxy: run.proxyCalls }))));

// ---------- P 路径与域名闸门 ----------
{
  const outcomes = [];
  for (const [url, expected] of [
    ['https://higgsfield.ai/community/originals?list=first_look', true],
    ['https://higgsfield.ai/community/projects', false],
    ['https://higgsfield.ai/community/originals/extra', false],
    ['https://higgsfield.ai/original-series/mork/episode-1', false],
    ['https://higgsfield.ai/', false],
    // www 会 301 到裸域；万一停在 www 上，站点归属（exact）就不认
    ['https://www.higgsfield.ai/community/originals?list=first_look', false]
  ]) {
    const { saved, fetchCalls } = await runScenario({ href: url, subscriptions: [{ urlPattern: url, tags: TAGS }] });
    outcomes.push([url, saved.length > 0, expected, fetchCalls.length]);
  }
  check('P1 只认裸域的 /community/originals（订阅了别的路径也不抓、不发请求）',
    outcomes.every(([, got, expected, calls]) => got === expected && (expected || calls === 0)),
    show(outcomes.filter(([, got, expected, calls]) => got !== expected || (!expected && calls !== 0))));
}

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
