import './bootstrap.cjs';
// genres 采集单测：加载真实 content.js（零网络、fixture 全部内嵌——tmp/rs-movie.html
// 丢失的教训），按站点分场景走完整 'scrape' 消息路径。覆盖：
//   ReelShort 详情 tag_list 覆盖列表 theme / 详情失败退 theme
//   DramaShorts genre.title 单值 / 无 genre 空数组
//   NetShort labelList 清洗（trim/去空/去重）
//   Steam appdetails 英文 genres（坏条目滤除）
//   IMDB JSON-LD genre 单字符串归一 + 坏 JSON 块跳过
//   MyDrama 详情页 JSON-LD @graph 内 genre 英文数组（简介剥模板/trans 判定不受影响）
// 每个场景重建 window/document/fetch/DOMParser 并重新 eval content.js
// （全新 window 使防重注入护栏放行，互不串扰）。
// 用法：node tests/unit-genres.mjs
import fs from 'node:fs';

const contentSrc = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const registrySrc = fs.readFileSync(new URL('../src/shared/site-registry.js', import.meta.url), 'utf8');
(0, eval)(registrySrc);

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

// 场景执行器：装桩 → eval 真实 content.js → 派发 'scrape' →
// 返回 { saved: 保存的卡集, saveCalls: 全部 saveDrama 消息（含去重命中的回填提交）,
//        proxyCalls: 全部 fetchDetailHtml 后台代理消息的 url（v1.5.5 fandom 补采） }
async function runScenario({ location, subscription, document, fetch, domParser, dramas = [], proxy }) {
  const store = { dramas: structuredClone(dramas) };
  const saveCalls = [];
  const proxyCalls = [];
  const listeners = [];
  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          await Promise.resolve();
          return { dramas: structuredClone(store.dramas), urlTags: [subscription] };
        }
      }
    },
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
  globalThis.fetch = fetch || (async () => ({ ok: false }));
  globalThis.DOMParser = domParser || class { parseFromString() { return baseDocument(); } };

  (0, eval)(contentSrc);
  await new Promise(resolve => {
    for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
  });
  return { saved: store.dramas, saveCalls, proxyCalls };
}

// ---------- 场景 1：ReelShort 主站（tag_list 覆盖 theme / 详情失败退 theme） ----------
const RS_A = 'a'.repeat(24), RS_B = 'b'.repeat(24);
const rsHome = {
  props: { pageProps: { fallback: { '/api/ms/hall/webInfo': { bookShelfList: [
    { bookshelf_name: 'New Release' },
    { bookshelf_name: 'TOP', books: [
      { book_id: RS_A, book_title: 'Book A', book_pic: 'pa', special_desc: 'da', theme: ['Playing Dumb'] },
      { book_id: RS_B, book_title: 'Book B', book_pic: 'pb', special_desc: 'db', theme: ['Amnesia'] }
    ] }
  ] } } } }
};
const rsMovieA = {
  props: { pageProps: { data: {
    book_title: 'Book A', special_desc: 'full desc A', start_play: { chapter_id: 'ch99' },
    tag_list: [
      { id: '1', category_id: '1010', text: 'Fantasy' },
      { id: '2', category_id: '1010', text: 'Romance' },
      { id: '3', category_id: '1022', text: 'High-Stakes' },
      { id: '4', category_id: '1022', text: '' }
    ]
  } } }
};
const nextDataDoc = (json) => baseDocument({
  querySelector: (sel) => sel === 'script#__NEXT_DATA__' ? { textContent: JSON.stringify(json) } : null
});
const { saved: rsSaved } = await runScenario({
  location: { href: 'https://www.reelshort.com/', hostname: 'www.reelshort.com', pathname: '/', search: '' },
  subscription: { urlPattern: 'https://www.reelshort.com/', tags: ['ReelShort', 'TOP'] },
  document: nextDataDoc(rsHome),
  fetch: async (url) => {
    if (url.includes(`/movie/book-a-${RS_A}`)) {
      return { ok: true, url, text: async () => 'RS-MOVIE-A' };
    }
    return { ok: false, url }; // Book B 详情失败
  },
  domParser: class {
    parseFromString(html) {
      return html === 'RS-MOVIE-A'
        ? nextDataDoc(rsMovieA)
        : baseDocument();
    }
  }
});
const rsA = rsSaved.find(d => d.itemId === `rs${RS_A}`);
const rsB = rsSaved.find(d => d.itemId === `rs${RS_B}`);
check('R1 ReelShort 详情 tag_list 覆盖列表 theme（空 text 滤除）',
  eq(rsA?.genres, ['Fantasy', 'Romance', 'High-Stakes']), JSON.stringify(rsA?.genres));
check('R2 ReelShort 详情失败保留列表 theme', eq(rsB?.genres, ['Amnesia']), JSON.stringify(rsB?.genres));

// ---------- 场景 2：DramaShorts（genre.title 单值 / 无 genre 空数组） ----------
const DS_1 = '17467b20-ab19-4f60-bb48-50ae41d2dd7f', DS_2 = '27467b20-ab19-4f60-bb48-50ae41d2dd7f';
const { saved: dsSaved } = await runScenario({
  location: { href: 'https://dramashorts.io/top-movies', hostname: 'dramashorts.io', pathname: '/top-movies', search: '' },
  subscription: { urlPattern: 'https://dramashorts.io/top-movies', tags: ['DramaShorts', 'Top'] },
  document: nextDataDoc({ props: { pageProps: { movies: [
    { id: DS_1, title: 'DS One', description: 'd1', images: { cover: 'https://cdn/x.jpg' },
      genre: { id: 'g1', title: 'Billionaire/CEO' }, attributes: ['exclusive'] },
    { id: DS_2, title: 'DS Two', description: 'd2', images: {}, genre: null }
  ] } } })
});
check('D1 DramaShorts genre.title 单值（attributes 运营标记不混入）',
  eq(dsSaved.find(d => d.itemId === `ds${DS_1}`)?.genres, ['Billionaire/CEO']),
  JSON.stringify(dsSaved.map(d => d.genres)));
check('D2 DramaShorts 无 genre 存空数组',
  eq(dsSaved.find(d => d.itemId === `ds${DS_2}`)?.genres, []), '');

// ---------- 场景 3：NetShort（labelList 清洗：trim/去空/去重） ----------
const NS_ID = '2064230228554887169';
const nsGroups = [{ groupName: 'Trending Now', data: [{
  shortPlayId: NS_ID, shortPlayName: 'NS One', shortPlayNameUrl: `/episode/ns-one-${NS_ID}`,
  shortPlayCover: 'c', shotIntroduce: 'i', shortPlayLabels: null,
  labelList: [{ labelName: ' Mystery ' }, { labelName: 'Sweet Romance' }, { labelName: 'Mystery' }, { labelName: '' }, null]
}] }];
const nsFlight = `{"videoListGroup":${JSON.stringify(nsGroups)}}`;
const { saved: nsSaved } = await runScenario({
  location: { href: 'https://netshort.com/', hostname: 'netshort.com', pathname: '/', search: '' },
  subscription: { urlPattern: 'https://netshort.com/', tags: ['NetShort', 'Trending'] },
  document: baseDocument({
    querySelectorAll: (sel) => sel === 'script'
      ? [{ textContent: `self.__next_f.push(${JSON.stringify([1, nsFlight])})` }]
      : []
  })
});
check('N1 NetShort labelList 清洗（trim/去空/去重）',
  eq(nsSaved[0]?.genres, ['Mystery', 'Sweet Romance']), JSON.stringify(nsSaved[0]?.genres));

// ---------- 场景 3b：Netflix Tudum Top 10（内联 graphql 脚本；列表无类型数据，genres 恒空数组） ----------
const NF_ID = 81278442;
const nfItem = {
  __typename: 'PulseTop10ItemEntity', id: `top10-S-${NF_ID}`,
  top10: { videoId: NF_ID, weeklyRank: 1, category: 'ENGLISH_MOVIES' },
  artwork: { storyArt: { 'urlsSized({"sizes":{"height":675,"width":1200}})': [{ url: 'https://dnm.nflximg.net/s.jpg' }] } },
  top10Video: { title: 'The Whisper Man', shortSynopsis: 'syn' }
};
const nfData = {
  [`PulseTop10ItemEntity:${nfItem.id}`]: nfItem,
  'PulseEntitiesSection:S': { __typename: 'PulseEntitiesSection', guid: 'top-10-card-list', entities: [{ __ref: `PulseTop10ItemEntity:${nfItem.id}` }] }
};
const nfLiteral = JSON.stringify({ data: nfData }).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const { saved: nfSaved } = await runScenario({
  location: { href: 'https://www.netflix.com/tudum/top10', hostname: 'www.netflix.com', pathname: '/tudum/top10', search: '' },
  subscription: { urlPattern: 'https://www.netflix.com/tudum/top10', tags: ['Netflix', 'Movie', 'Global'] },
  document: baseDocument({
    querySelectorAll: (sel) => sel === 'script'
      ? [{ textContent: `netflix.reactContext.models.graphql = JSON.parse('${nfLiteral}');` }]
      : []
  })
});
check('N2 Netflix 榜单无类型字段、详情代理失败（默认桩）→ 卡片入库且 genres 空数组（下轮回填）',
  nfSaved.length === 1 && eq(nfSaved[0]?.genres, []), JSON.stringify(nfSaved.map(d => [d.itemId, d.genres])));

// N3：详情代理返回 /title/ 页——根 netflix.reactContext 对象字面量（空格编成 \x20）内
// models.nmTitleGQL.data.genreInfo.coreGenre.name[].name 即 Netflix 自身英文类型，经 cleanGenres 清洗
const nfRootLiteral = JSON.stringify({ models: { nmTitleGQL: { data: { genreInfo: { coreGenre: { name: [
  { name: 'Thrillers' }, { name: ' Mysteries ' }, { name: 'Dramas' }, { name: 'Dramas' }, { name: '' }
] } } } } } }).replace(/ /g, '\\x20');
const nfTitleHtml = `<html><head><script>window.netflix = window.netflix || {};\nnetflix.reactContext = ${nfRootLiteral};</script>` +
  `<script>netflix.reactContext.models.graphql = JSON.parse('{"data":{}}');</script></head></html>`;
const { saved: nfSaved3, proxyCalls: nfProxy3 } = await runScenario({
  location: { href: 'https://www.netflix.com/tudum/top10', hostname: 'www.netflix.com', pathname: '/tudum/top10', search: '' },
  subscription: { urlPattern: 'https://www.netflix.com/tudum/top10', tags: ['Netflix', 'Movie', 'Global'] },
  document: baseDocument({
    querySelectorAll: (sel) => sel === 'script'
      ? [{ textContent: `netflix.reactContext.models.graphql = JSON.parse('${nfLiteral}');` }]
      : []
  }),
  proxy: () => ({ success: true, html: nfTitleHtml }),
  domParser: class {
    parseFromString(html) {
      const scripts = [...String(html).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => ({ textContent: m[1] }));
      return baseDocument({ querySelectorAll: (sel) => sel === 'script' ? scripts : [] });
    }
  }
});
check('N3 Netflix 详情代理返回 nmTitleGQL → coreGenre 英文类型清洗入库（trim/去空/去重），代理目标为 /title/ 直链',
  eq(nfSaved3[0]?.genres, ['Thrillers', 'Mysteries', 'Dramas']) && eq(nfProxy3, ['https://www.netflix.com/title/81278442']),
  JSON.stringify({ genres: nfSaved3[0]?.genres, proxy: nfProxy3 }));

// ---------- 场景 4：Steam（appdetails 英文 genres，坏条目滤除；中文档不碰 genres） ----------
const STEAM_URL = 'https://store.steampowered.com/category/visual_novel?flavor=contenthub_newandtrending';
const { saved: steamSaved } = await runScenario({
  location: { href: STEAM_URL, hostname: 'store.steampowered.com', pathname: '/category/visual_novel', search: '?flavor=contenthub_newandtrending' },
  subscription: { urlPattern: STEAM_URL, tags: ['Steam', '视觉小说'] },
  document: baseDocument(),
  fetch: async (url) => {
    if (url.includes('ajaxgetsaledynamicappquery')) {
      return { ok: true, url, json: async () => ({ appids: [111222] }) };
    }
    if (url.includes('appdetails?appids=111222&l=english')) {
      return { ok: true, url, json: async () => ({ 111222: { success: true, data: {
        name: 'Steam Game', short_description: 'sd', developers: ['Dev'],
        genres: [{ id: '1', description: 'Action' }, { id: '25', description: 'Adventure' }, { description: '' }, null]
      } } }) };
    }
    return { ok: true, url, json: async () => ({ 111222: { success: false } }) }; // schinese 无数据
  }
});
check('S1 Steam appdetails genres（坏条目滤除）',
  eq(steamSaved[0]?.genres, ['Action', 'Adventure']), JSON.stringify(steamSaved[0]?.genres));

// ---------- 场景 5：IMDB（JSON-LD 单字符串归一 + 坏 JSON 块跳过） ----------
const imdbLink = {
  textContent: '1. Test Movie',
  getAttribute: (n) => n === 'href' ? '/title/tt1234567/' : null
};
const imdbItem = {
  querySelector: (sel) => sel === 'a[href*="/title/tt"]' ? imdbLink : null,
  querySelectorAll: (sel) => sel === 'a[href*="/title/tt"]' ? [imdbLink] : []
};
const IMDB_URL = 'https://www.imdb.com/search/title/?release_date=2026-01-01,&genres=Drama';
const { saved: imdbSaved } = await runScenario({
  location: { href: IMDB_URL, hostname: 'www.imdb.com', pathname: '/search/title/', search: '?release_date=2026-01-01,&genres=Drama' },
  subscription: { urlPattern: IMDB_URL, tags: ['IMDB', 'drama'] },
  document: baseDocument({
    querySelectorAll: (sel) => sel === '.ipc-metadata-list-summary-item' ? [imdbItem] : []
  }),
  fetch: async (url) => ({ ok: true, url, text: async () => 'IMDB-DETAIL' }),
  domParser: class {
    parseFromString(html) {
      if (html !== 'IMDB-DETAIL') return baseDocument();
      return baseDocument({
        querySelectorAll: (sel) => sel === 'script[type="application/ld+json"]'
          ? [{ textContent: '{bad json' }, { textContent: JSON.stringify({ '@type': 'Movie', genre: 'Drama' }) }]
          : []
      });
    }
  }
});
check('I1 IMDB JSON-LD 单字符串归一成数组（坏块跳过）',
  eq(imdbSaved[0]?.genres, ['Drama']), JSON.stringify(imdbSaved[0]?.genres));

// ---------- 场景 6：NetShort 存量回填（缺 genres 才提交，已有的零消息） ----------
const NS_ID2 = '3064230228554887169';
const nsGroups2 = [{ groupName: 'Trending Now', data: [
  nsGroups[0].data[0],
  { shortPlayId: NS_ID2, shortPlayName: 'NS Two', shortPlayNameUrl: `/episode/ns-two-${NS_ID2}`,
    shortPlayCover: 'c2', shotIntroduce: 'i2', labelList: [{ labelName: 'Revenge' }] }
] }];
const nsFlight2 = `{"videoListGroup":${JSON.stringify(nsGroups2)}}`;
const backfillNs = await runScenario({
  location: { href: 'https://netshort.com/', hostname: 'netshort.com', pathname: '/', search: '' },
  subscription: { urlPattern: 'https://netshort.com/', tags: ['NetShort', 'Trending'] },
  dramas: [
    { id: 'old-1', itemId: `ns${NS_ID}`, title: 'NS One', tags: ['NetShort'], source: 'netshort', status: 'trans' },
    { id: 'old-2', itemId: `ns${NS_ID2}`, title: 'NS Two', tags: ['NetShort'], source: 'netshort', status: 'trans', genres: ['Already'] }
  ],
  document: baseDocument({
    querySelectorAll: (sel) => sel === 'script'
      ? [{ textContent: `self.__next_f.push(${JSON.stringify([1, nsFlight2])})` }]
      : []
  })
});
check('B1 回填只提交缺 genres 的存量条目（已有的零消息）',
  backfillNs.saveCalls.length === 1 && backfillNs.saveCalls[0]?.itemId === `ns${NS_ID}`,
  JSON.stringify(backfillNs.saveCalls.map(d => d.itemId)));
check('B2 回填消息携带列表级 genres',
  eq(backfillNs.saveCalls[0]?.genres, ['Mystery', 'Sweet Romance']),
  JSON.stringify(backfillNs.saveCalls[0]?.genres));

// ---------- 场景 7：ReelShort 存量回填走详情取全量 tag_list（非 theme），已有 genres 条目零详情请求 ----------
let rsMovieFetches = 0;
const backfillRs = await runScenario({
  location: { href: 'https://www.reelshort.com/', hostname: 'www.reelshort.com', pathname: '/', search: '' },
  subscription: { urlPattern: 'https://www.reelshort.com/', tags: ['ReelShort', 'TOP'] },
  dramas: [
    { id: 'old-a', itemId: `rs${RS_A}`, title: 'Book A', tags: ['ReelShort'], source: 'reelshort', status: 'trans', genres: [] },
    { id: 'old-b', itemId: `rs${RS_B}`, title: 'Book B', tags: ['ReelShort'], source: 'reelshort', status: 'trans', genres: ['Old'] }
  ],
  document: nextDataDoc(rsHome),
  fetch: async (url) => {
    if (url.includes('/movie/')) {
      rsMovieFetches++;
      if (url.includes(`book-a-${RS_A}`)) return { ok: true, url, text: async () => 'RS-MOVIE-A' };
    }
    return { ok: false, url };
  },
  domParser: class {
    parseFromString(html) {
      return html === 'RS-MOVIE-A' ? nextDataDoc(rsMovieA) : baseDocument();
    }
  }
});
check('B3 ReelShort 回填经详情取全量 tag_list（非列表 theme）',
  backfillRs.saveCalls.length === 1 && eq(backfillRs.saveCalls[0]?.genres, ['Fantasy', 'Romance', 'High-Stakes']),
  JSON.stringify(backfillRs.saveCalls.map(d => d.genres)));
check('B4 已有 genres 的存量条目零详情请求', rsMovieFetches === 1, `movieFetches=${rsMovieFetches}`);

// ---------- 场景 8：My Drama 主站（详情页 JSON-LD @graph 提取 genre；模板剥离与 trans 不受影响） ----------
const MD_UUID = 'a36a7fe3-0e89-45ff-a409-f75093c5144f';
const MD_UUID2 = 'b47b8fe4-1f9a-46ff-b51a-086194d6255f';
const MD_GENRES = ['Betrayal', 'Dark Romance', 'Mystery', 'Revenge', 'Runaway Bride'];
const MD_POSTER = 'https://static.my-drama.com/convert/Wild%20silence/en/2026-03-06%2009:00:05/cover.webp';
// 列表条目桩：条目自身即 a[href]（extractId 走 item.matches 分支）
const mdItem = (uuid, poster, zhTitle) => ({
  matches: (sel) => sel === 'a[href]',
  getAttribute: (n) => n === 'href' ? `https://my-drama.com/video/${uuid}?from=cover` : null,
  querySelector: (sel) => {
    if (sel === 'img[src*="/convert/"]') return { src: poster };
    if (sel === 'h3') return { textContent: zhTitle };
    return null; // 无悬停 <p> 简介，走详情页补
  }
});
// 详情页桩：og 元信息 + 单个 ld+json 块（@graph 数组，genre 不在首节点——覆盖图谱遍历）
const mdDetailDoc = () => baseDocument({
  querySelector: (sel) => {
    if (sel === 'meta[property="og:description"]') return { getAttribute: (n) => n === 'content'
      ? '荒野的沉默 - 集数 78 - 在 My Drama 流媒体平台观看. 一个求死的女人被狂野沉默的男人所救。' : null };
    if (sel === 'meta[property="og:image"]') return { getAttribute: (n) => n === 'content' ? MD_POSTER : null };
    return null;
  },
  querySelectorAll: (sel) => sel === 'script[type="application/ld+json"]'
    ? [{ textContent: JSON.stringify({ '@context': 'https://schema.org', '@graph': [
        { '@type': 'BreadcrumbList', itemListElement: [] },
        { '@type': 'VideoObject', name: 'Wild Silence', genre: MD_GENRES }
      ] }) }]
    : []
});
const mdLocation = { href: 'https://my-drama.com/', hostname: 'my-drama.com', pathname: '/', search: '', origin: 'https://my-drama.com' };
const mdSubscription = { urlPattern: 'https://my-drama.com/', tags: ['MyDrama', '最流行'] };
const { saved: mdSaved } = await runScenario({
  location: mdLocation,
  subscription: mdSubscription,
  document: baseDocument({
    querySelectorAll: (sel) => sel === '#most_trending [data-testid="series-section-item"]'
      ? [mdItem(MD_UUID, MD_POSTER, '荒野的沉默')] : []
  }),
  fetch: async (url) => url.includes(`/video/${MD_UUID}`)
    ? { ok: true, url, text: async () => 'MD-DETAIL-A' }
    : { ok: false, url },
  domParser: class {
    parseFromString(html) { return html === 'MD-DETAIL-A' ? mdDetailDoc() : baseDocument(); }
  }
});
const mdA = mdSaved.find(d => d.itemId === `md${MD_UUID}`);
check('M1 MyDrama 详情页 JSON-LD @graph 提取 genres（英文原值）',
  eq(mdA?.genres, MD_GENRES), JSON.stringify(mdA?.genres));
check('M2 MyDrama 简介剥模板与 trans 判定不受 genres 提取影响',
  mdA?.title === 'Wild silence' && mdA?.titleZh === '荒野的沉默'
    && (mdA?.descriptionZh || '').startsWith('一个求死的女人') && mdA?.status === 'trans',
  JSON.stringify({ title: mdA?.title, status: mdA?.status, zh: (mdA?.descriptionZh || '').slice(0, 10) }));

// ---------- 场景 9：My Drama 存量回填（缺 genres 经详情提交，已有 genres 零详情请求） ----------
let mdDetailFetches = 0;
const backfillMd = await runScenario({
  location: mdLocation,
  subscription: mdSubscription,
  dramas: [
    { id: 'old-md-a', itemId: `md${MD_UUID}`, title: 'Wild silence', tags: ['MyDrama'], source: 'mydrama', status: 'trans' },
    { id: 'old-md-b', itemId: `md${MD_UUID2}`, title: 'Other Drama', tags: ['MyDrama'], source: 'mydrama', status: 'trans', genres: ['Old'] }
  ],
  document: baseDocument({
    querySelectorAll: (sel) => sel === '#most_trending [data-testid="series-section-item"]'
      ? [mdItem(MD_UUID, MD_POSTER, '荒野的沉默'), mdItem(MD_UUID2, '', '别的剧')] : []
  }),
  fetch: async (url) => {
    if (url.includes('/video/')) {
      mdDetailFetches++;
      if (url.includes(MD_UUID)) return { ok: true, url, text: async () => 'MD-DETAIL-A' };
    }
    return { ok: false, url };
  },
  domParser: class {
    parseFromString(html) { return html === 'MD-DETAIL-A' ? mdDetailDoc() : baseDocument(); }
  }
});
check('M3 MyDrama 存量回填经详情提交 genres',
  backfillMd.saveCalls.length === 1 && backfillMd.saveCalls[0]?.itemId === `md${MD_UUID}`
    && eq(backfillMd.saveCalls[0]?.genres, MD_GENRES),
  JSON.stringify(backfillMd.saveCalls.map(d => ({ itemId: d.itemId, genres: d.genres }))));
check('M4 已有 genres 的 MyDrama 存量条目零详情请求', mdDetailFetches === 1, `detailFetches=${mdDetailFetches}`);

// ---------- 场景 10（v1.5.5）：fandom 首见条目映射当时经后台代理补采 genres ----------
// fandom 子域 content script 直连主站被页面 CORS 拦（/video/ 响应无 ACAO 头），
// 改发 fetchDetailHtml 消息由后台 SW 代理取播放页 HTML、本地 DOMParser 解析 JSON-LD。
const fandomLocation = { href: 'https://fandom.my-drama.com/', hostname: 'fandom.my-drama.com', pathname: '/', search: '', origin: 'https://fandom.my-drama.com' };
const fandomSubscription = { urlPattern: 'https://fandom.my-drama.com/', tags: ['MyDrama', 'fandom'] };
const fandomAnchor = (slug, title) => ({
  textContent: title,
  href: `https://fandom.my-drama.com/${slug}/`,
  getAttribute: (n) => n === 'href' ? `https://fandom.my-drama.com/${slug}/` : null
});
const fandomPost = (slug, title) => {
  const a = fandomAnchor(slug, title);
  return {
    matches: () => false,
    querySelector: (sel) => {
      if (sel === '.wp-block-post-title a' || sel === '.wp-block-post-title a, a[href]' || sel === 'a[href]') return a;
      if (sel === '.wp-block-post-featured-image img') return { currentSrc: 'https://fandom.my-drama.com/wp/cover.jpg', src: '' };
      return null;
    }
  };
};
// 文章页桩：回主站链接 + h1 + 正文长段落（fandom 简介语义），og:image 兜底
const fandomArticleDoc = (uuid) => baseDocument({
  querySelector: (sel) => {
    if (sel === 'a[href*="my-drama.com/video/"]') return { getAttribute: (n) => n === 'href' ? `https://my-drama.com/video/${uuid}` : null };
    if (sel === 'h1') return { textContent: 'Wild Silence' };
    if (sel === 'meta[property="og:image"]') return { getAttribute: (n) => n === 'content' ? 'https://fandom.my-drama.com/og.jpg' : null };
    if (sel === '.entry-content') return { querySelectorAll: (s) => s === 'p' ? [{ textContent: 'W'.repeat(120) }] : [] };
    return null;
  }
});
const fandomFetch = async (url) => {
  if (url === 'https://fandom.my-drama.com/wild-silence/') return { ok: true, url, text: async () => 'FANDOM-ARTICLE-A' };
  if (url === 'https://fandom.my-drama.com/other-drama/') return { ok: true, url, text: async () => 'FANDOM-ARTICLE-B' };
  return { ok: false, url };
};
class FandomDomParser {
  parseFromString(html) {
    if (html === 'FANDOM-ARTICLE-A') return fandomArticleDoc(MD_UUID);
    if (html === 'FANDOM-ARTICLE-B') return fandomArticleDoc(MD_UUID2);
    if (html === 'MD-DETAIL-A') return mdDetailDoc();
    return baseDocument(); // MD-SHELL 等空壳：无 ld+json 块
  }
}
const fandomM5 = await runScenario({
  location: fandomLocation,
  subscription: fandomSubscription,
  document: baseDocument({ querySelectorAll: (sel) => sel === 'li.wp-block-post' ? [fandomPost('wild-silence', 'Wild Silence')] : [] }),
  fetch: fandomFetch,
  domParser: FandomDomParser,
  proxy: (url) => url === `https://my-drama.com/video/${MD_UUID}` ? { success: true, html: 'MD-DETAIL-A' } : { success: false }
});
const fandomA = fandomM5.saved.find(d => d.itemId === `md${MD_UUID}`);
check('M5 fandom 映射当时经后台代理补采 genres（英文原值随新卡入库）',
  eq(fandomA?.genres, MD_GENRES) && fandomM5.proxyCalls.length === 1,
  JSON.stringify({ genres: fandomA?.genres, proxyCalls: fandomM5.proxyCalls }));
check('M5b fandom 文章语义不变（h1 标题 / 正文简介 / 主站播放页 url）',
  fandomA?.title === 'Wild Silence' && fandomA?.url === `https://my-drama.com/video/${MD_UUID}`
    && (fandomA?.description || '').length > 80,
  JSON.stringify({ title: fandomA?.title, url: fandomA?.url, descLen: (fandomA?.description || '').length }));

// ---------- 场景 11（v1.5.5）：存量已有 genres → 零代理请求；重复消息不带脏值 ----------
const fandomM6 = await runScenario({
  location: fandomLocation,
  subscription: fandomSubscription,
  dramas: [{ id: 'old-f', itemId: `md${MD_UUID}`, title: 'Wild Silence', tags: ['MyDrama'], source: 'mydrama', status: 'trans', genres: ['Old'] }],
  document: baseDocument({ querySelectorAll: (sel) => sel === 'li.wp-block-post' ? [fandomPost('wild-silence', 'Wild Silence')] : [] }),
  fetch: fandomFetch,
  domParser: FandomDomParser
});
check('M6 存量已有 genres 的 fandom 条目零代理请求', fandomM6.proxyCalls.length === 0,
  JSON.stringify(fandomM6.proxyCalls));
check('M6b 重复条目 saveDrama 消息 genres 为空数组（不带脏值）',
  fandomM6.saveCalls.length === 1 && eq(fandomM6.saveCalls[0]?.genres, []),
  JSON.stringify(fandomM6.saveCalls.map(d => d.genres)));

// ---------- 场景 12（v1.5.5）：代理失败 / 空壳页 → 条目照常入库、genres 空、不抛错 ----------
const fandomM7 = await runScenario({
  location: fandomLocation,
  subscription: fandomSubscription,
  document: baseDocument({ querySelectorAll: (sel) => sel === 'li.wp-block-post'
    ? [fandomPost('wild-silence', 'Wild Silence'), fandomPost('other-drama', 'Other Drama')] : [] }),
  fetch: fandomFetch,
  domParser: FandomDomParser,
  // A：代理直接失败；B：代理"成功"但回的是风控空壳页（无 JSON-LD）
  proxy: (url) => url === `https://my-drama.com/video/${MD_UUID2}` ? { success: true, html: 'MD-SHELL' } : { success: false }
});
check('M7 代理失败/空壳页 → 两条目照常入库、genres 空',
  fandomM7.saved.length === 2 && fandomM7.saved.every(d => eq(d.genres, [])) && fandomM7.proxyCalls.length === 2,
  JSON.stringify({ saved: fandomM7.saved.map(d => ({ id: d.itemId, g: d.genres })), proxyCalls: fandomM7.proxyCalls.length }));

// ---------- 场景 13（v1.5.5）：fandom 菜单直链主站条目——存量回填跨域改走代理（此前 CORS 静默失败） ----------
let videoDirectFetches = 0;
const menuAnchor = fandomAnchor('ignored', '⬤ Wild Silence');
menuAnchor.href = `https://my-drama.com/video/${MD_UUID}`;
menuAnchor.getAttribute = (n) => n === 'href' ? `https://my-drama.com/video/${MD_UUID}` : null;
const menuItem = {
  matches: () => false,
  querySelector: (sel) => (sel === '.wp-block-post-title a, a[href]' || sel === 'a[href]') ? menuAnchor : null
};
const fandomM8 = await runScenario({
  location: { href: 'https://fandom.my-drama.com/?list=trending', hostname: 'fandom.my-drama.com', pathname: '/', search: '?list=trending', origin: 'https://fandom.my-drama.com' },
  subscription: { urlPattern: 'https://fandom.my-drama.com/?list=trending', tags: ['MyDrama', 'fandom', 'Trending'] },
  dramas: [{ id: 'old-m8', itemId: `md${MD_UUID}`, title: 'Wild Silence', tags: ['MyDrama'], source: 'mydrama', status: 'trans' }],
  document: baseDocument({
    querySelectorAll: (sel) => sel === '#modal-2-content .wp-block-navigation-submenu' ? [{
      querySelector: (s) => s === '.wp-block-navigation-item__label' ? { textContent: 'Most Trending' } : null,
      querySelectorAll: (s) => s === '.wp-block-navigation__submenu-container .wp-block-navigation-link' ? [menuItem] : []
    }] : []
  }),
  fetch: async (url) => { if (String(url).includes('/video/')) videoDirectFetches++; return { ok: false, url }; },
  domParser: FandomDomParser,
  proxy: (url) => url === `https://my-drama.com/video/${MD_UUID}` ? { success: true, html: 'MD-DETAIL-A' } : { success: false }
});
check('M8 fandom 页存量回填跨域改走代理并提交 genres（菜单直链条目修复）',
  fandomM8.saveCalls.length === 1 && eq(fandomM8.saveCalls[0]?.genres, MD_GENRES) && fandomM8.proxyCalls.length === 1,
  JSON.stringify({ calls: fandomM8.saveCalls.map(d => ({ id: d.itemId, g: d.genres })), proxy: fandomM8.proxyCalls }));
check('M8b 跨域场景零直连 fetch（同源直连由 M1/M3 守护）', videoDirectFetches === 0, `videoDirectFetches=${videoDirectFetches}`);

// ---------- 汇总断言：所有入库卡都带 genres 数组字段 ----------
const all = [...rsSaved, ...dsSaved, ...nsSaved, ...nfSaved, ...nfSaved3, ...steamSaved, ...imdbSaved, ...mdSaved, ...fandomM5.saved, ...fandomM7.saved];
check('G1 全部入库卡带 genres 数组字段', all.length >= 8 && all.every(d => Array.isArray(d.genres)),
  JSON.stringify({ count: all.length }));

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
