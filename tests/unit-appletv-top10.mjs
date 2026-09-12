import './bootstrap.cjs';
// Apple TV Top 10 适配器单测（v1.5.10）：零网络加载真实 content.js（先 eval site-registry），
// fixture 由 JS 对象生成——序列化进 Apple 页面的 <script type="application/json"
// id="serialized-server-data">（纯 JSON，不像 Netflix 那样再包一层 JS 字符串字面量）。
// 覆盖：榜单/详情都经后台代理取 HTML（内容脚本绝不直连 fetch，也不读实时 DOM——真机实测
// 该脚本 hydrate 后会被删出 DOM）、按「有 shelves」挑 intent、字段映射、umc id 守卫、
// caption 兜底与详情官方 genres 覆盖、详情失败跳过该卡、存量 genres 回填的代理次数、
// 两条订阅精确等值、adapter.matches 路径闸门。
// 用法：node tests/unit-appletv-top10.mjs
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

// ---------- fixture ----------
const ART = (hash = '71MOIRL0meBFMCDlwISAkg', code = 'nr') =>
  `https://is1-ssl.mzstatic.com/image/thumb/${hash}/{w}x{h}${code}.{f}`;

// 实测：Apple 直出的 JSON 里 < 为 0 个、& 原样不转义，故 indexOf('</script>') 定终点安全；
// escapeLt 模拟保守转义形态（<），验证两种写法都解得开。
function serializedScript(payload, { escapeLt = false, broken = false, omit = false } = {}) {
  if (omit) return '';
  let json = JSON.stringify(payload);
  if (escapeLt) json = json.replace(/</g, '\\u003c');
  if (broken) json = json.slice(0, -12);
  return `<script type="application/json" id="serialized-server-data">${json}</script>`;
}
const pageHtml = (body) =>
  `<!doctype html><html lang="en-US"><head><script type="application/ld+json">{"@type":"WebSite"}</script></head><body>${body}</body></html>`;

const UTS_CONFIG = { intent: { $kind: 'UtsConfigureIntent' }, data: { configureParams: { developerToken: 'eyJ0' }, configuration: {}, configuredTime: 1 } };

function chartItem({ id, title, type = 'Show', caption = 'Comedy', ordinal = '1', slug = 'x', art = ART(), query = '?ctx_agid=502c9996' }) {
  const kindPath = type === 'Movie' ? 'movie' : 'show';
  const url = `https://tv.apple.com/us/${kindPath}/${slug}/${id}${query}`;
  return {
    $kind: 'OrdinalChartLockup', id, ariaLabel: title,
    contextAction: { $kind: 'ContextAction', title, type, secondaryActions: ['AddToUpNext'], url },
    artwork: art ? { template: art, backgroundColor: 'rgb(29,26,28)', width: 1680, height: 3636 } : null,
    segue: { $kind: 'flowAction', destination: { id, storefront: 'us', $kind: 'ShowPageIntent' }, url },
    type, title, playAction: null, ordinal, caption,
    contentLogo: { template: ART('logo', 'bb'), width: 5937, height: 892 }
  };
}

const collectionHtml = (items, { shelfId = 'uts.col.ChartsShows.tvs.sbd.4000', ...opts } = {}) => pageHtml(serializedScript({
  data: [UTS_CONFIG, {
    intent: { $kind: 'CollectionPageIntent' },
    data: {
      canonicalURL: `https://tv.apple.com/us/collection/most-popular-now/${shelfId}`,
      seoData: { pageTitle: 'Most Popular Now - Apple TV' },
      shelves: [{ $type: 'lockup', id: shelfId, itemKind: 'lockup', title: 'Most Popular Now', items }]
    }
  }],
  userTokenHash: 'hash'
}, opts));

// 详情页：About 节的 AboutReviewCard 才是简介与官方多值 genres 的权威源；
// 前面的 CanonicalHeader/lockup 节是干扰项（其 description 同文但 genres 是长名，不采）。
const detailHtml = ({ title = 'Ted Lasso', genres = ['Comedy', 'Sports'], description = 'An American football coach…', intentKind = 'ShowPageIntent', withAbout = true, ...opts } = {}) => pageHtml(serializedScript({
  data: [UTS_CONFIG, {
    intent: { $kind: intentKind },
    data: {
      canonicalURL: 'https://tv.apple.com/us/show/x/umc.cmc.x',
      seoData: { pageTitle: `Watch ${title} - Show - Apple TV` },
      shelves: [
        { $type: 'CanonicalHeader', id: 'canonical-header', itemKind: 'lockup', items: [{ $kind: 'SuperheroLockup', title, description, primaryMetadata: ['TV Show', ...genres] }] },
        { $type: 'lockup', id: 'uts.col.Trailers', itemKind: 'lockup', items: [] },
        ...(withAbout ? [{
          $type: 'About', id: 'uts.marker.About', itemKind: 'informationGroup',
          items: [
            { $kind: 'AboutReviewCard', id: 'AboutReviewCard#1', title, genres, description },
            { $kind: 'AboutCommonSenseCard', id: 'AboutCommonSenseCard#1', recommendedAge: 14 }
          ]
        }] : []),
        { $type: 'Info', id: 'uts.marker.Info', itemKind: 'info', items: [] }
      ]
    }
  }]
}, opts));

const loc = (href) => {
  const u = new URL(href);
  return { href, hostname: u.hostname, pathname: u.pathname, search: u.search, origin: u.origin };
};

// 场景执行器：装桩 → eval 真实 content.js → 派发 'scrape'
// proxy(url) 返回 { success, html }；未给则一律失败（success:false）
async function runScenario({ location, subscriptions, dramas = [], proxy }) {
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
  globalThis.document = baseDocument();
  // 榜单与详情一律经后台代理，内容脚本自身绝不直连 fetch
  globalThis.fetch = async () => { throw new Error('Apple 适配器不应直连 fetch（榜单与详情都须走后台代理）'); };
  globalThis.DOMParser = class { parseFromString() { return baseDocument(); } };

  (0, eval)(contentSrc);
  const response = await new Promise(resolve => {
    for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
  });
  return { saved: store.dramas, saveCalls, proxyCalls, response };
}

const LIST_SHOWS = 'https://tv.apple.com/us/collection/most-popular-now/uts.col.ChartsShows.tvs.sbd.4000';
const LIST_MOVIES = 'https://tv.apple.com/us/collection/most-popular-now/uts.col.ChartsMovies.tvs.sbd.4000';
const SUB_TV = { urlPattern: LIST_SHOWS, tags: ['Apple', 'TV', 'US'] };
const SUB_MOVIE = { urlPattern: LIST_MOVIES, tags: ['Apple', 'Movie', 'US'] };

// 榜单代理成功 + 详情代理按 url 分派
const proxyOf = (listHtml, detail = {}) => (url) => {
  if (url.includes('/collection/')) return { success: true, html: listHtml };
  return detail.html ? { success: true, html: detail.html } : { success: false };
};

// ---------- F：字段映射 ----------
{
  const items = [chartItem({ id: 'umc.cmc.vtoh0mn0xn7t3c643xqonfzy', title: 'Ted Lasso', slug: 'ted-lasso' })];
  const { saved, proxyCalls } = await runScenario({
    location: loc(LIST_SHOWS), subscriptions: [SUB_TV],
    proxy: proxyOf(collectionHtml(items), { html: detailHtml({ title: 'Ted Lasso', genres: ['Comedy', 'Sports'], description: 'Jason Sudeikis is Ted Lasso…' }) })
  });
  const d = saved[0] || {};
  check('F1 itemId=at+umc.cmc.…、id=appletv_<itemId>_<index>',
    d.itemId === 'atumc.cmc.vtoh0mn0xn7t3c643xqonfzy' && d.id === 'appletv_atumc.cmc.vtoh0mn0xn7t3c643xqonfzy_0', JSON.stringify([d.itemId, d.id]));
  check('F1 title 取榜单、description 取详情 About 节', d.title === 'Ted Lasso' && d.description === 'Jason Sudeikis is Ted Lasso…', JSON.stringify([d.title, d.description]));
  check('F1 poster 按模板替换为 400x600 2:3 竖版（裁切码原样保留）',
    d.poster === 'https://is1-ssl.mzstatic.com/image/thumb/71MOIRL0meBFMCDlwISAkg/400x600nr.jpg', d.poster);
  check('F1 url 取 contextAction.url 并剥掉 ?ctx_agid（代理白名单只认无 query 形态）',
    d.url === 'https://tv.apple.com/us/show/ted-lasso/umc.cmc.vtoh0mn0xn7t3c643xqonfzy', d.url);
  check('F1 genres 由详情官方多值覆盖榜单 caption', eq(d.genres, ['Comedy', 'Sports']), JSON.stringify(d.genres));
  check('F1 source/status/titleZh 约定',
    d.source === 'appletv' && d.status === 'new' && d.titleZh === '' && d.descriptionZh === '',
    JSON.stringify([d.source, d.status, d.titleZh, d.descriptionZh]));
  check('F1 tags 三个原样保留、sourceListUrl 归一为订阅 URL', eq(d.tags, ['Apple', 'TV', 'US']) && d.sourceListUrl === LIST_SHOWS, JSON.stringify([d.tags, d.sourceListUrl]));
  check('F1 scrapedAt 为 ISO 时间、translatedAt 为 null', !Number.isNaN(Date.parse(d.scrapedAt)) && d.translatedAt === null, JSON.stringify([d.scrapedAt, d.translatedAt]));
  check('F1 代理调用＝1 次榜单 + 1 次详情（且详情 URL 无 query）',
    eq(proxyCalls, [LIST_SHOWS, 'https://tv.apple.com/us/show/ted-lasso/umc.cmc.vtoh0mn0xn7t3c643xqonfzy']), JSON.stringify(proxyCalls));
}

// ---------- M：电影榜（不同 intent 名、不同路径段） ----------
{
  const items = [chartItem({ id: 'umc.cmc.26o403koqo2klixc0jtqy6tmc', title: 'The Gorge', type: 'Movie', caption: 'Thriller', slug: 'the-gorge' })];
  const { saved } = await runScenario({
    location: loc(LIST_MOVIES), subscriptions: [SUB_TV, SUB_MOVIE],
    proxy: proxyOf(collectionHtml(items, { shelfId: 'uts.col.ChartsMovies.tvs.sbd.4000' }),
      { html: detailHtml({ title: 'The Gorge', genres: ['Thriller', 'Action', 'Sci-Fi'], description: 'Two highly trained operatives…', intentKind: 'MoviePageIntent' }) })
  });
  const d = saved[0] || {};
  check('M1 电影详情用 MoviePageIntent 也能解（按「有 shelves」挑而非 intent 白名单）',
    eq(d.genres, ['Thriller', 'Action', 'Sci-Fi']) && d.description === 'Two highly trained operatives…', JSON.stringify([d.genres, d.description]));
  check('M2 /movie/ 详情 URL 与电影榜订阅标签', d.url === 'https://tv.apple.com/us/movie/the-gorge/umc.cmc.26o403koqo2klixc0jtqy6tmc' && eq(d.tags, ['Apple', 'Movie', 'US']),
    JSON.stringify([d.url, d.tags]));
}

// ---------- E：转义与特殊字符 ----------
{
  const items = [
    chartItem({ id: 'umc.cmc.74o37kzay0yuuub8iumddjsg', title: 'Your Friends & Neighbors', slug: 'your-friends--neighbors' }),
    chartItem({ id: 'umc.cmc.1zzly0vah46bnvnwf0qkrjhh2', title: 'Widow’s <Bay>', slug: 'widows-bay' })
  ];
  const { saved } = await runScenario({
    location: loc(LIST_SHOWS), subscriptions: [SUB_TV],
    proxy: (url) => url.includes('/collection/')
      ? { success: true, html: collectionHtml(items, { escapeLt: true }) }
      : { success: true, html: detailHtml({ description: 'desc & <more>', genres: ['Drama'], escapeLt: true }) }
  });
  check('E1 裸 & 与 \\u003c 转义的标题/简介都逐字还原',
    saved.length === 2 && saved[0].title === 'Your Friends & Neighbors' && saved[1].title === 'Widow’s <Bay>' && saved[1].description === 'desc & <more>',
    JSON.stringify(saved.map(d => [d.title, d.description])));
  check('E2 双连字符 slug 的详情 URL 原样构造',
    saved[0].url === 'https://tv.apple.com/us/show/your-friends--neighbors/umc.cmc.74o37kzay0yuuub8iumddjsg', saved[0].url);
}

// ---------- S：serialized-server-data 健壮性 ----------
{
  const scenarios = [
    ['缺脚本', pageHtml('')],
    ['坏 JSON', pageHtml(serializedScript({ data: [] }, { broken: true }))],
    ['无 shelves 的 data', pageHtml(serializedScript({ data: [UTS_CONFIG] }))],
    ['shelves 为空数组', pageHtml(serializedScript({ data: [UTS_CONFIG, { intent: { $kind: 'CollectionPageIntent' }, data: { shelves: [] } }] }))],
    ['榜单代理失败', null]
  ];
  const outcomes = [];
  for (const [, html] of scenarios) {
    const { saved, response } = await runScenario({
      location: loc(LIST_SHOWS), subscriptions: [SUB_TV],
      proxy: html ? (() => ({ success: true, html })) : undefined
    });
    outcomes.push({ n: saved.length, ok: response?.success === true });
  }
  check('S1 缺脚本/坏 JSON/无 shelves/空 shelves/代理失败 → 均 0 条且响应成功不抛错',
    outcomes.every(o => o.n === 0 && o.ok), JSON.stringify(outcomes));
}

// ---------- G：id 与封面守卫 ----------
{
  const items = [
    chartItem({ id: 'umc.cmc.ok1', title: 'Good' }),
    chartItem({ id: 'tt1234567', title: 'IMDB 形态' }),
    chartItem({ id: 'umc.cmc.', title: '空尾巴' }),
    chartItem({ id: 'umc.cpc.person1', title: '人物 id' }),
    chartItem({ id: 'umc.cmc.NOUPPER', title: '大写不收' }),
    chartItem({ id: 'umc.cmc.noart', title: '无封面', art: null })
  ];
  const { saved } = await runScenario({
    location: loc(LIST_SHOWS), subscriptions: [SUB_TV],
    proxy: proxyOf(collectionHtml(items), { html: detailHtml({ genres: ['Drama'], description: 'd' }) })
  });
  check('G1 只收 umc.cmc.<小写字母数字> 形态的 id',
    eq(saved.map(d => d.itemId), ['atumc.cmc.ok1', 'atumc.cmc.noart']), JSON.stringify(saved.map(d => d.itemId)));
  check('G2 artwork 缺失 → poster 空串（渲染端有默认海报兜底），不丢卡',
    saved[1]?.poster === '', JSON.stringify(saved[1]?.poster));
}

// ---------- D：详情失败＝跳过该卡（简介只有详情页这一个来源，存下就再也补不上） ----------
{
  const items = [chartItem({ id: 'umc.cmc.a1', title: 'A' }), chartItem({ id: 'umc.cmc.b2', title: 'B' })];
  const cases = [
    ['详情代理失败', (url) => url.includes('/collection/') ? { success: true, html: collectionHtml(items) } : { success: false }],
    ['详情无 About 节', proxyOf(collectionHtml(items), { html: detailHtml({ withAbout: false }) })],
    ['详情简介为空串', proxyOf(collectionHtml(items), { html: detailHtml({ description: '   ' }) })],
    ['详情页坏 JSON', proxyOf(collectionHtml(items), { html: detailHtml({ broken: true }) })]
  ];
  const outcomes = [];
  for (const [, proxy] of cases) {
    const { saved, response } = await runScenario({ location: loc(LIST_SHOWS), subscriptions: [SUB_TV], proxy });
    outcomes.push({ n: saved.length, ok: response?.success === true });
  }
  check('D1 详情失败/无 About/空简介/坏 JSON → 一律跳过该卡（0 条），响应成功、下轮重试',
    outcomes.every(o => o.n === 0 && o.ok), JSON.stringify(outcomes));
}
{
  // 详情有 About 但 genres 为空 → 简介仍然入库，genres 退回榜单 caption
  const items = [chartItem({ id: 'umc.cmc.c3', title: 'C', caption: 'Sci-Fi' })];
  const { saved } = await runScenario({
    location: loc(LIST_SHOWS), subscriptions: [SUB_TV],
    proxy: proxyOf(collectionHtml(items), { html: detailHtml({ genres: [], description: '有简介无类型' }) })
  });
  check('D2 详情 genres 为空 → 保留榜单 caption 作兜底、简介照常入库',
    saved.length === 1 && eq(saved[0].genres, ['Sci-Fi']) && saved[0].description === '有简介无类型',
    JSON.stringify(saved.map(d => [d.genres, d.description])));
}

// ---------- R：去重与存量 genres 回填 ----------
{
  const items = [chartItem({ id: 'umc.cmc.dup', title: 'Dup' })];
  const existing = [{ itemId: 'atumc.cmc.dup', title: 'Dup', genres: ['Comedy'], description: '旧简介', source: 'appletv' }];
  const { saved, saveCalls, proxyCalls } = await runScenario({
    location: loc(LIST_SHOWS), subscriptions: [SUB_TV], dramas: existing,
    proxy: proxyOf(collectionHtml(items), { html: detailHtml({ genres: ['Drama'], description: '新简介' }) })
  });
  check('R1 去重命中且已有 genres → 零新增、零 saveDrama、详情零代理请求（只有榜单那一次）',
    saved.length === 1 && saveCalls.length === 0 && eq(proxyCalls, [LIST_SHOWS]), JSON.stringify({ n: saved.length, saveCalls: saveCalls.length, proxyCalls }));
}
{
  const items = [chartItem({ id: 'umc.cmc.dup', title: 'Dup' })];
  const existing = [{ itemId: 'atumc.cmc.dup', title: 'Dup', genres: [], description: '旧简介', source: 'appletv' }];
  const { saveCalls, proxyCalls } = await runScenario({
    location: loc(LIST_SHOWS), subscriptions: [SUB_TV], dramas: existing,
    proxy: proxyOf(collectionHtml(items), { html: detailHtml({ genres: ['Drama', 'Crime'], description: '新简介' }) })
  });
  check('R2 去重命中但缺 genres → 恰一次详情代理，提交官方 genres',
    proxyCalls.length === 2 && saveCalls.length === 1 && eq(saveCalls[0]?.genres, ['Drama', 'Crime']),
    JSON.stringify({ proxyCalls, genres: saveCalls[0]?.genres }));
}

// ---------- U：订阅匹配与路径闸门 ----------
{
  const items = [chartItem({ id: 'umc.cmc.sub1', title: 'S' })];
  const { saved } = await runScenario({
    location: loc(LIST_MOVIES), subscriptions: [SUB_TV, SUB_MOVIE],
    proxy: proxyOf(collectionHtml(items, { shelfId: 'uts.col.ChartsMovies.tvs.sbd.4000' }), { html: detailHtml({ genres: ['Action'], description: 'd' }) })
  });
  check('U1 两条榜单 URL 互不为前缀，精确等值各命中各自标签',
    saved.length === 1 && eq(saved[0].tags, ['Apple', 'Movie', 'US']), JSON.stringify(saved.map(d => d.tags)));
}
{
  const items = [chartItem({ id: 'umc.cmc.gate', title: 'G' })];
  const offPath = [
    'https://tv.apple.com/',
    'https://tv.apple.com/us/show/ted-lasso/umc.cmc.x',
    'https://tv.apple.com/us/collection/most-popular-now/uts.col.Editorial.tvs.sbd.4000',
    'https://tv.apple.com/gb/collection/most-popular-now/uts.col.ChartsShows.tvs.sbd.4000'
  ];
  const outcomes = [];
  for (const href of offPath) {
    const { saved, response } = await runScenario({
      location: loc(href), subscriptions: [{ urlPattern: href, tags: ['Apple', 'TV', 'US'] }],
      proxy: proxyOf(collectionHtml(items), { html: detailHtml({ genres: ['Drama'], description: 'd' }) })
    });
    outcomes.push({ href, n: saved.length, ok: response?.success === true });
  }
  check('U2 首页/详情页/非榜单 collection/非 us 区 → adapter.matches 不命中，0 条不抛错',
    outcomes.every(o => o.n === 0 && o.ok), JSON.stringify(outcomes));
}
{
  const items = [chartItem({ id: 'umc.cmc.nosub', title: 'N' })];
  const { saved, proxyCalls } = await runScenario({
    location: loc(LIST_SHOWS), subscriptions: [SUB_MOVIE],
    proxy: proxyOf(collectionHtml(items), { html: detailHtml({ genres: ['Drama'], description: 'd' }) })
  });
  check('U3 当前榜单不在订阅内 → 0 条且零代理请求（订阅判定先于取数）',
    saved.length === 0 && proxyCalls.length === 0, JSON.stringify({ n: saved.length, proxyCalls }));
}

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
