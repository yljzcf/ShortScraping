import './bootstrap.cjs';
// Netflix Tudum Top 10 适配器单测：零网络加载真实 content.js（先 eval site-registry），
// fixture 由 JS 生成——把 Apollo 归一化缓存对象序列化成 Netflix 页面的内联脚本形态
//   netflix.reactContext.models.graphql = JSON.parse('<JS 单引号字面量>');
// 覆盖：JS 字面量反转义（\\ \' \uXXXX \xHH 与裸 "）、节选择（card-list 优先 / table 回退 /
// 都无不抛错）、字段映射、videoId 守卫、美国榜 weeklyViews 为 null、订阅精确等值与最长前缀、
// 去重跳过、adapter.matches 路径闸门。
// 用法：node tests/unit-netflix-top10.mjs
import fs from 'node:fs';

const contentSrc = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
(0, eval)(fs.readFileSync(new URL('../src/shared/site-registry.js', import.meta.url), 'utf8'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

// ---------- fixture 生成 ----------
// 把 JSON 文本编成 Netflix 内联脚本用的 JS 单引号字面量：反斜杠与单引号转义、< > 编成
// \u003c \u003e（实测形态）；hexSpaces 再把空格编成 \x20（标题页实测形态），四类转义全覆盖。
function toJsSingleQuoted(jsonText, { hexSpaces = false } = {}) {
  let out = jsonText.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  if (hexSpaces) out = out.replace(/ /g, '\\x20');
  return out;
}
const graphqlScript = (data, opts) =>
  `netflix.reactContext.models.graphql = JSON.parse('${toJsSingleQuoted(JSON.stringify({ data }), opts)}');`;
// 页面上另一段含 reactContext 但无 graphql 的脚本（实测 39KB 的 netflix.reactContext = {...}），当干扰项
const DECOY_SCRIPT = "window.netflix = window.netflix || {};\n        netflix.reactContext = {\"models\":{\"requestHeaders\":{\"data\":{}}}};";

const sized = (url) => url
  ? { __typename: 'Top10PulseImage', 'urlsSized({"sizes":{"height":675,"width":1200}})': [{ __typename: 'PulseImageSizeResult', url }] }
  : { __typename: 'Top10PulseImage' };

function top10Item(sectionId, {
  videoId, title, synopsis = 'syn', rank = 1, category = 'ENGLISH_MOVIES', views = 1000,
  storyArt = 'https://dnm.nflximg.net/story.jpg', sdpArt = 'https://dnm.nflximg.net/sdp.jpg',
  parentShow = null, number = null, slug = null
}) {
  return {
    __typename: 'PulseTop10ItemEntity',
    id: `top10-${sectionId}-${videoId}`,
    top10: { __typename: 'Top10Data', weekEndDate: '2026-09-06', category, weeklyRank: rank, weeklyHoursViewed: 1, runtime: 1.5, weeklyViews: views, cumulativeWeeksInTop10: 2, videoId },
    artwork: { __typename: 'Top10PulseImages', logoArt: sized('https://dnm.nflximg.net/logo.png'), sdpArt: sized(sdpArt), storyArt: sized(storyArt) },
    displayVideo: { __typename: 'PulseDisplayVideo', titlePageSlug: slug, video: { __typename: parentShow ? 'Season' : 'Movie', unifiedEntityId: `Video:${videoId}`, videoId } },
    top10Video: { __typename: 'Top10PulseVideo', maturityRating: 'R', number, parentShow: parentShow ? { __typename: 'Top10PulseVideo', title: parentShow } : null, releaseYear: 2026, shortSynopsis: synopsis, title, videoId }
  };
}

function buildData({ cardItems = null, tableItems = null } = {}) {
  const data = {
    ROOT_QUERY: { __typename: 'Query' },
    'PulsePage:x': { __typename: 'PulsePage', kind: 'TOP10', slug: '/top10' }
  };
  const addSection = (guid, sectionId, items, title) => {
    const refs = items.map(i => `PulseTop10ItemEntity:${i.id}`);
    data[`PulseEntitiesSection:${sectionId}-${refs.join('')}`] = {
      __typename: 'PulseEntitiesSection', id: sectionId, guid,
      header: { __typename: 'PulseSectionGenericHeader', sectionTitle: title, eyebrowHeading: '8/31/26 - 9/6/26' },
      entities: refs.map(r => ({ __ref: r }))
    };
    for (const i of items) data[`PulseTop10ItemEntity:${i.id}`] = i;
  };
  if (cardItems) addSection('top-10-card-list', 'CARD', cardItems, 'Global Top 10 Movies');
  if (tableItems) addSection('top-10-table', 'TABLE', tableItems, 'Top 10 Movies Overview');
  return data;
}

const scriptsDoc = (scripts) => baseDocument({
  querySelectorAll: (sel) => sel === 'script' ? scripts.map(textContent => ({ textContent })) : []
});
const loc = (href) => {
  const u = new URL(href);
  return { href, hostname: u.hostname, pathname: u.pathname, search: u.search, origin: u.origin };
};

// ---------- 详情页 fixture：根 netflix.reactContext 对象字面量（\xHH 转义）内的 nmTitleGQL ----------
// 模拟 Netflix 序列化：空格、斜杠、撇号、< > 编成 \xHH（JSON 不认 \x，解析前须归一为 \u00HH）
const toJsObjectLiteral = (jsonText) =>
  jsonText.replace(/[ \/'<>]/g, ch => '\\x' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
function titlePageHtml({ genres = ['Thrillers', 'Mysteries', 'Dramas'], synopsis = 'Detail synopsis / not used', videoId = 81278442, withGraphqlData = false, brokenRoot = false } = {}) {
  const root = {
    title: 'Netflix', clPageName: 'nonmemberTitle',
    models: {
      requestHeaders: { data: {} },
      nmTitleGQL: { data: {
        isPlayableOnAdsPlan: true,
        artwork: { billboard: { small: 'https://occ.nflxso.net/dnm/x.jpg' } },
        copy: { title: "Detail Title Shouldn't Win", synopsis },
        genreInfo: { coreGenre: { name: genres.map(name => ({ name })) } },
        metaData: { type: 'Movie', videoId, topLevelVideoId: videoId }
      }, type: 'ok' }
    }
  };
  // 真实页面把部分字符写成 JSON 合法的 \uXXXX（与 \xHH 并存），插一个 ’ 验证 \u 序列原样保留
  let literal = toJsObjectLiteral(JSON.stringify(root)).replace('Detail\\x20Title', 'Detail\\x20\\u2019Title');
  if (brokenRoot) literal = literal.slice(0, -5);
  const rootScript = `window.netflix = window.netflix || {};\n        netflix.reactContext = ${literal};`;
  const graphqlScript = withGraphqlData
    ? `netflix.reactContext.models.graphql = JSON.parse('{"data":{"Movie:x":{"__typename":"Movie","videoId":${videoId}}}}');`
    : `netflix.reactContext.models.graphql = JSON.parse('{"data":{}}');`;
  return `<!doctype html><html lang="en-US"><head><script>${rootScript}</script><script>${graphqlScript}</script></head><body></body></html>`;
}
// DOMParser 桩：从 HTML 字符串抠出 <script> 文本（与内容脚本 doc.querySelectorAll('script') 读法一致）
class ScriptDomParser {
  parseFromString(html) {
    const scripts = [...String(html).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => ({ textContent: m[1] }));
    return baseDocument({ querySelectorAll: (sel) => sel === 'script' ? scripts : [] });
  }
}
const okProxy = (opts) => () => ({ success: true, html: titlePageHtml(opts) });

// 场景执行器：装桩 → eval 真实 content.js → 派发 'scrape' →
// 返回 { saved, saveCalls, proxyCalls（fetchDetailHtml 后台代理请求的 url）, response }
// 详情代理默认返回失败（success:false）——榜单字段类断言与详情无关
async function runScenario({ location, subscriptions, document, dramas = [], proxy, domParser }) {
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
        if (message?.action === 'fetchDetailHtml') {
          proxyCalls.push(message.url);
          return proxy ? proxy(message.url) : { success: false };
        }
        return { success: true };
      }
    }
  };
  globalThis.window = { location };
  globalThis.document = document;
  // 详情一律经后台代理（无 cookie、可控 Accept-Language），内容脚本自身绝不直连 fetch
  globalThis.fetch = async () => { throw new Error('Netflix 适配器不应直连 fetch（详情须走后台代理）'); };
  globalThis.DOMParser = domParser || class { parseFromString() { return baseDocument(); } };

  (0, eval)(contentSrc);
  const response = await new Promise(resolve => {
    for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
  });
  return { saved: store.dramas, saveCalls, proxyCalls, response };
}

const SUB_MOVIES = { urlPattern: 'https://www.netflix.com/tudum/top10', tags: ['Netflix', 'Movie', 'Global'] };
const SUB_TV = { urlPattern: 'https://www.netflix.com/tudum/top10/tv', tags: ['Netflix', 'TV', 'Global'] };
const SUB_US_MOVIES = { urlPattern: 'https://www.netflix.com/tudum/top10/united-states', tags: ['Netflix', 'Movie', 'US'] };

// ---------- D：JS 单引号字面量反转义 ----------
const TRICKY_TITLE = `Bob's <Odd> "Show": Season 2`;
const TRICKY_SYN = 'Path a\\b and 100% ünïcode — done.';
{
  const data = buildData({ cardItems: [top10Item('CARD', { videoId: 81278442, title: TRICKY_TITLE, synopsis: TRICKY_SYN })] });
  const { saved } = await runScenario({
    location: loc('https://www.netflix.com/tudum/top10'), subscriptions: [SUB_MOVIES],
    document: scriptsDoc([DECOY_SCRIPT, graphqlScript(data, { hexSpaces: true })])
  });
  check('D1 反转义 \\\\ \\\' \\uXXXX \\xHH 与裸 " 后标题/简介逐字还原（含干扰脚本）',
    saved.length === 1 && saved[0].title === TRICKY_TITLE && saved[0].description === TRICKY_SYN,
    JSON.stringify(saved.map(d => [d.title, d.description])));
}

// ---------- S：节选择 ----------
{
  const data = buildData({
    cardItems: [top10Item('CARD', { videoId: 11111, title: 'Card One' })],
    tableItems: [top10Item('TABLE', { videoId: 22222, title: 'Table Two' })]
  });
  const { saved } = await runScenario({ location: loc('https://www.netflix.com/tudum/top10'), subscriptions: [SUB_MOVIES], document: scriptsDoc([graphqlScript(data)]) });
  check('S1 card-list 与 table 并存时只取 card-list', eq(saved.map(d => d.itemId), ['nf11111']), JSON.stringify(saved.map(d => d.itemId)));
}
{
  const data = buildData({ tableItems: [top10Item('TABLE', { videoId: 22222, title: 'Table Two' })] });
  const { saved } = await runScenario({ location: loc('https://www.netflix.com/tudum/top10'), subscriptions: [SUB_MOVIES], document: scriptsDoc([graphqlScript(data)]) });
  check('S2 无 card-list 时回退 table', eq(saved.map(d => d.itemId), ['nf22222']), JSON.stringify(saved.map(d => d.itemId)));
}
{
  const { saved: s1, response: r1 } = await runScenario({ location: loc('https://www.netflix.com/tudum/top10'), subscriptions: [SUB_MOVIES], document: scriptsDoc([graphqlScript(buildData())]) });
  const { saved: s2, response: r2 } = await runScenario({ location: loc('https://www.netflix.com/tudum/top10'), subscriptions: [SUB_MOVIES], document: scriptsDoc([DECOY_SCRIPT]) });
  check('S3 无榜单节 / 无 graphql 脚本 → 0 条且响应成功不抛错',
    s1.length === 0 && s2.length === 0 && r1?.success === true && r2?.success === true,
    JSON.stringify({ s1: s1.length, s2: s2.length, r1, r2 }));
}

// ---------- F：字段映射 ----------
{
  const data = buildData({ cardItems: [top10Item('CARD', { videoId: 81278442, title: 'The Whisper Man', synopsis: 'When his young son vanishes…', slug: '/the-whisper-man' })] });
  const { saved } = await runScenario({ location: loc('https://www.netflix.com/tudum/top10'), subscriptions: [SUB_MOVIES], document: scriptsDoc([graphqlScript(data)]) });
  const d = saved[0] || {};
  check('F1 itemId=nf+videoId、id=netflix_<itemId>_<index>', d.itemId === 'nf81278442' && d.id === 'netflix_nf81278442_0', JSON.stringify([d.itemId, d.id]));
  check('F1 title/description 取 top10Video', d.title === 'The Whisper Man' && d.description === 'When his young son vanishes…', JSON.stringify([d.title, d.description]));
  check('F1 poster 取 storyArt', d.poster === 'https://dnm.nflximg.net/story.jpg', d.poster);
  check('F1 url 仅凭 videoId 构造 /title/ 页（不用可为 null 的 titlePageSlug）', d.url === 'https://www.netflix.com/title/81278442', d.url);
  check('F1 source/status/genres/titleZh 约定', d.source === 'netflix' && d.status === 'new' && eq(d.genres, []) && d.titleZh === '' && d.descriptionZh === '',
    JSON.stringify([d.source, d.status, d.genres, d.titleZh, d.descriptionZh]));
  check('F1 tags 三个原样保留、sourceListUrl 归一为订阅 URL', eq(d.tags, ['Netflix', 'Movie', 'Global']) && d.sourceListUrl === SUB_MOVIES.urlPattern, JSON.stringify([d.tags, d.sourceListUrl]));
  check('F1 scrapedAt 为 ISO 时间、translatedAt 为 null', !Number.isNaN(Date.parse(d.scrapedAt)) && d.translatedAt === null, JSON.stringify([d.scrapedAt, d.translatedAt]));
}
{
  const data = buildData({ cardItems: [
    top10Item('CARD', { videoId: 81716977, title: 'The Gentlemen: Season 2', parentShow: 'The Gentlemen', number: 2, category: 'ENGLISH_SERIES' }),
    top10Item('CARD', { videoId: 81437052, title: '', parentShow: 'The Gentlemen', number: 1, category: 'ENGLISH_SERIES' }),
    top10Item('CARD', { videoId: 33333, title: 'No Story', storyArt: null })
  ] });
  const { saved } = await runScenario({ location: loc('https://www.netflix.com/tudum/top10/tv'), subscriptions: [SUB_TV], document: scriptsDoc([graphqlScript(data)]) });
  const byId = Object.fromEntries(saved.map(d => [d.itemId, d]));
  check('F2 剧集标题保留站点自带季名', byId.nf81716977?.title === 'The Gentlemen: Season 2', byId.nf81716977?.title);
  check('F3 title 缺失回退 parentShow + 季号', byId.nf81437052?.title === 'The Gentlemen: Season 1', byId.nf81437052?.title);
  check('F4 缺 storyArt 退 sdpArt', byId.nf33333?.poster === 'https://dnm.nflximg.net/sdp.jpg', byId.nf33333?.poster);
}

// ---------- G：守卫 ----------
{
  const bad1 = top10Item('CARD', { videoId: 44444, title: 'Good' });
  const bad2 = top10Item('CARD', { videoId: 'abc', title: 'Bad id' });
  const bad3 = top10Item('CARD', { videoId: 55555, title: 'No videoId' });
  delete bad3.top10.videoId;
  const usItem = top10Item('CARD', { videoId: 66666, title: 'US Only', category: 'MOVIES', views: null });
  const data = buildData({ cardItems: [bad1, bad2, bad3, usItem] });
  const { saved } = await runScenario({ location: loc('https://www.netflix.com/tudum/top10/united-states'), subscriptions: [SUB_US_MOVIES], document: scriptsDoc([graphqlScript(data)]) });
  check('G1 videoId 非数字/缺失的条目跳过，其余照常入库', eq(saved.map(d => d.itemId), ['nf44444', 'nf66666']), JSON.stringify(saved.map(d => d.itemId)));
  check('G2 美国榜 weeklyViews 为 null 不影响入库且标签为 US 榜', saved.find(d => d.itemId === 'nf66666') && eq(saved.find(d => d.itemId === 'nf66666').tags, ['Netflix', 'Movie', 'US']), '');
}

// ---------- U：订阅匹配（6 条 Netflix 订阅互为前缀） ----------
{
  const data = buildData({ cardItems: [top10Item('CARD', { videoId: 77777, title: 'TV Item', category: 'ENGLISH_SERIES' })] });
  const { saved } = await runScenario({ location: loc('https://www.netflix.com/tudum/top10/tv'), subscriptions: [SUB_MOVIES, SUB_TV], document: scriptsDoc([graphqlScript(data)]) });
  check('U1 /tudum/top10 与 /tudum/top10/tv 同配时，tv 页精确等值命中 tv 标签', eq(saved[0]?.tags, SUB_TV.tags) && saved[0]?.sourceListUrl === SUB_TV.urlPattern, JSON.stringify([saved[0]?.tags, saved[0]?.sourceListUrl]));
}
{
  const data = buildData({ cardItems: [top10Item('CARD', { videoId: 77777, title: 'TV Item', category: 'ENGLISH_SERIES' })] });
  const { saved } = await runScenario({ location: loc('https://www.netflix.com/tudum/top10/tv?x=1'), subscriptions: [SUB_MOVIES, SUB_TV], document: scriptsDoc([graphqlScript(data)]) });
  check('U2 带 query 的 href 走前缀轮时命中最长前缀（tv）而非配置顺序首个（top10）', eq(saved[0]?.tags, SUB_TV.tags) && saved[0]?.sourceListUrl === SUB_TV.urlPattern, JSON.stringify([saved[0]?.tags, saved[0]?.sourceListUrl]));
}
{
  const data = buildData({ cardItems: [top10Item('CARD', { videoId: 88888, title: 'Movie Item' })] });
  const { saved } = await runScenario({ location: loc('https://www.netflix.com/tudum/top10'), subscriptions: [SUB_TV, SUB_MOVIES], document: scriptsDoc([graphqlScript(data)]) });
  check('U3 top10 页在 tv 订阅排前时仍精确命中 top10 标签', eq(saved[0]?.tags, SUB_MOVIES.tags), JSON.stringify(saved[0]?.tags));
}

// ---------- R：去重 ----------
{
  const data = buildData({ cardItems: [top10Item('CARD', { videoId: 81278442, title: 'The Whisper Man' })] });
  const existing = { id: 'netflix_nf81278442_0', itemId: 'nf81278442', title: 'The Whisper Man', tags: ['Netflix', 'Movie', 'Global'], genres: ['Dramas'], source: 'netflix', status: 'new' };
  const { saveCalls, proxyCalls } = await runScenario({ location: loc('https://www.netflix.com/tudum/top10/united-states'), subscriptions: [SUB_US_MOVIES], document: scriptsDoc([graphqlScript(data)]), dramas: [existing], proxy: okProxy() });
  check('R1 库中已有 nf<videoId> 且已带 genres（全球榜先到）→ 美国榜复现零 saveDrama 零代理（先到先得、不追加标签）', saveCalls.length === 0 && proxyCalls.length === 0, JSON.stringify({ saveCalls, proxyCalls }));
}

// ---------- D2-D5：详情页 genres（经后台代理取 /title/ 页根 reactContext 的 nmTitleGQL.coreGenre） ----------
const NF_TITLE_URL = 'https://www.netflix.com/title/81278442';
{
  const data = buildData({ cardItems: [top10Item('CARD', { videoId: 81278442, title: 'The Whisper Man', synopsis: 'List synopsis wins' })] });
  const { saved, proxyCalls } = await runScenario({
    location: loc('https://www.netflix.com/tudum/top10'), subscriptions: [SUB_MOVIES], document: scriptsDoc([graphqlScript(data)]),
    proxy: okProxy(), domParser: ScriptDomParser
  });
  const d = saved[0] || {};
  check('D2 详情代理返回 nmTitleGQL → genres 取 coreGenre 英文名', eq(d.genres, ['Thrillers', 'Mysteries', 'Dramas']), JSON.stringify(d.genres));
  check('D2b 详情只补 genres：标题/简介仍以榜单为准、url 不变', d.title === 'The Whisper Man' && d.description === 'List synopsis wins' && d.url === NF_TITLE_URL, JSON.stringify([d.title, d.description, d.url]));
  check('D2c 恰一次代理请求且目标为库内 /title/ 直链形态', eq(proxyCalls, [NF_TITLE_URL]), JSON.stringify(proxyCalls));
}
{
  const data = buildData({ cardItems: [top10Item('CARD', { videoId: 81278442, title: 'The Whisper Man' })] });
  const { saved } = await runScenario({
    location: loc('https://www.netflix.com/tudum/top10'), subscriptions: [SUB_MOVIES], document: scriptsDoc([graphqlScript(data)]),
    proxy: () => ({ success: false, error: 'HTTP 503' }), domParser: ScriptDomParser
  });
  check('D3 详情代理失败 → 卡片照常入库、genres 空数组（下轮榜单复现时回填）', saved.length === 1 && eq(saved[0].genres, []), JSON.stringify(saved.map(d => d.genres)));
}
{
  const data = buildData({ cardItems: [top10Item('CARD', { videoId: 81278442, title: 'The Whisper Man' })] });
  const { saved } = await runScenario({
    location: loc('https://www.netflix.com/tudum/top10'), subscriptions: [SUB_MOVIES], document: scriptsDoc([graphqlScript(data)]),
    proxy: okProxy({ genres: ["Kids' TV", ' Comedies ', 'Comedies', ''], withGraphqlData: true }), domParser: ScriptDomParser
  });
  check('D4 根字面量含 \\x27 撇号与 \\u 序列、graphql 变体有数据时仍取 coreGenre，并经 cleanGenres 清洗',
    eq(saved[0]?.genres, ["Kids' TV", 'Comedies']), JSON.stringify(saved[0]?.genres));
}
{
  const data = buildData({ cardItems: [top10Item('CARD', { videoId: 81278442, title: 'The Whisper Man' })] });
  const { saved, response } = await runScenario({
    location: loc('https://www.netflix.com/tudum/top10'), subscriptions: [SUB_MOVIES], document: scriptsDoc([graphqlScript(data)]),
    proxy: okProxy({ brokenRoot: true }), domParser: ScriptDomParser
  });
  check('D5 根字面量损坏 → 不抛错、卡片入库、genres 空数组', response?.success === true && saved.length === 1 && eq(saved[0].genres, []), JSON.stringify(saved.map(d => d.genres)));
}

// ---------- B：存量回填（榜单复现 + 库中无 genres → 经详情代理补采，只提交 genres） ----------
{
  const data = buildData({ cardItems: [top10Item('CARD', { videoId: 81278442, title: 'The Whisper Man' })] });
  const existing = { id: 'netflix_nf81278442_0', itemId: 'nf81278442', title: 'The Whisper Man', tags: ['Netflix', 'Movie', 'Global'], genres: [], source: 'netflix', status: 'new' };
  const { saveCalls, proxyCalls } = await runScenario({
    location: loc('https://www.netflix.com/tudum/top10'), subscriptions: [SUB_MOVIES], document: scriptsDoc([graphqlScript(data)]),
    dramas: [existing], proxy: okProxy(), domParser: ScriptDomParser
  });
  check('B1 存量无 genres 复现 → 恰 1 次代理 + 1 次 saveDrama 提交带 genres 的同 itemId',
    eq(proxyCalls, [NF_TITLE_URL]) && saveCalls.length === 1 && saveCalls[0].itemId === 'nf81278442' && eq(saveCalls[0].genres, ['Thrillers', 'Mysteries', 'Dramas']),
    JSON.stringify({ proxyCalls, saveCalls: saveCalls.map(d => [d.itemId, d.genres]) }));
}
{
  const data = buildData({ cardItems: [top10Item('CARD', { videoId: 81278442, title: 'The Whisper Man' })] });
  const existing = { id: 'netflix_nf81278442_0', itemId: 'nf81278442', title: 'The Whisper Man', tags: ['Netflix', 'Movie', 'Global'], genres: [], source: 'netflix', status: 'new' };
  const { saveCalls, proxyCalls } = await runScenario({
    location: loc('https://www.netflix.com/tudum/top10'), subscriptions: [SUB_MOVIES], document: scriptsDoc([graphqlScript(data)]),
    dramas: [existing], proxy: () => ({ success: false }), domParser: ScriptDomParser
  });
  check('B2 存量回填时代理失败 → 零 saveDrama（不落空标记，下轮再试）', proxyCalls.length === 1 && saveCalls.length === 0, JSON.stringify({ proxyCalls, saveCalls }));
}

// ---------- M：adapter.matches 路径闸门 ----------
{
  const data = buildData({ cardItems: [top10Item('CARD', { videoId: 99999, title: 'Elsewhere' })] });
  const sub = { urlPattern: 'https://www.netflix.com/browse', tags: ['Netflix', 'x'] };
  const { saved } = await runScenario({ location: loc('https://www.netflix.com/browse'), subscriptions: [sub], document: scriptsDoc([graphqlScript(data)]) });
  check('M1 非 /tudum/top10 路径即使被订阅也不抓取', saved.length === 0, JSON.stringify(saved.map(d => d.itemId)));
}

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
