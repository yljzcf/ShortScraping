import './bootstrap.cjs';
// PinesDramas（pinedrama.com）四板块适配器单测（v1.6.12）：加载真实 content.js（先 eval site-registry）。
//
// 站点是 Next.js App Router，RSC flight 里是**渲染后的 JSX 元素树**而不是干净数据载荷，
// 所以只能读 DOM；四个板块 SSR 直出、hydrate 后仍在、与视口无关（375px 下条目数不变），
// 故读**实时 DOM**（同 DramaBox 范式），不走 fetchServerHtml。因为吃的是真选择器，
// 这里用 dom-fixture 搭真元素树（正则抠串的桩会把「选择器写错」这个最常见的失败方式
// 排除在考核之外）。
//
// 四个板块分别落在两个页面上，靠 ?list=<归一化标题> 选中；站点的板块标题**混用 h2/h3**
// （Popular Novels 是 h2、Editor's Pick 是 h3），只查 h2 会漏。三个易回归点各有专门用例：
//  1) slug 取 /novels/ 之后的**第一段**——卡上的「Read Now」指向 /novels/<slug>/chapter-1，
//     取末段会得到 'chapter-1'（真机实测已踩到）；
//  2) 站点把当前页的 ?list= **原样拼进每个卡片的 href**，不剥就会污染 slug；
//  3) 从标题向上爬找板块容器要有「容器内只能有一个标题」的闸门，否则会把下一个板块吃进来。
//
// 列表卡片**简介覆盖不全**（Popular Novels / Popular Short Dramas 压根没有简介，另两个板块
// 的短 blurb 与详情页 Summary 是两段不同文案），故 22 条一律取详情页，且详情失败**跳过该卡**
// （理由同 AppleTV/ShortMax：存量回填只补 genres 不补简介，存下无简介的卡就永远自愈不了）。
//
// 用法：node tests/unit-pinedrama-sections.mjs
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

// ---------- fixture ----------
const ORIGIN = 'https://pinedrama.com';
const CDN = 'https://v.pinedrama.com/b1265344voduse1318177724';
// 站点卡片同款缩略图尾缀（200×270 ≈7.8KB；剥掉即原图 960×1478 ≈213KB）
const THUMB = '!15491.webp';
const cover = hash => `${CDN}/${hash}/${hash}.webp${THUMB}`;

const NOVELS = `${ORIGIN}/novels?list=recommended_webnovels_for_you`;
const NOVELS_DRAMAS = `${ORIGIN}/novels?list=popular_short_dramas`;
const HOME_POP = `${ORIGIN}/?list=popular_novels`;
const HOME_PICK = `${ORIGIN}/?list=editor_s_pick`;

const SUBS = [
  { urlPattern: NOVELS, tags: ['Pines', 'novel', 'recommend'] },
  { urlPattern: NOVELS_DRAMAS, tags: ['Pines', 'drama', 'Pop'] },
  { urlPattern: HOME_POP, tags: ['Pines', 'novel', 'Pop'] },
  { urlPattern: HOME_PICK, tags: ['Pines', 'novel', 'Pick'] }
];

const REC = [
  { slug: 'the-dragon-kings-discarded-flame', title: "The Dragon King's Discarded Flame", hash: 'fHZHnKAU5IUA' },
  { slug: 'the-ghost-chefs-revenge', title: "The Ghost Chef's Revenge", hash: 'aB3kZzQ1PpQA' }
];
const POP_NOVELS = [
  { slug: 'the-ceos-midnight-savior', title: "The CEO's Midnight Savior", hash: 'vJq5RLc9BRQA' },
  { slug: 'the-high-weavers-revenge', title: "The High Weaver's Revenge", hash: 'kL8mNoP2XyZA' }
];
const PICKS = [
  { slug: 'poisoned-crown-awakened-wolf', title: 'Poisoned Crown, Awakened Wolf', hash: 'vYLCFnkwCaoA' }
];
const DRAMAS = [
  { slug: 'free-my-heart-mr-ceo', title: 'Free My Heart, Mr. CEO', hash: 'OVbk6a8l4IAA' },
  { slug: 'my-hotel-my-rules', title: 'My Hotel, My Rules', hash: 'QqW9rTy4UuIA' }
];

/**
 * 「Recommended」板式：封面在 <a> **里面**，另有标题链接、分类链接与一个指向
 * /novels/<slug>/chapter-1 的「Read Now」按钮（slug 取末段就会得到 chapter-1）。
 * list 参数原样拼在每个 href 上——站点真机行为。
 */
const recCard = ({ slug, title, hash }, q = '') => el('div', { class: 'card-rec' }, [
  el('a', { href: `${ORIGIN}/novels/${slug}${q}`, 'aria-label': title }, [
    el('img', { alt: title, src: cover(hash), width: '96', height: '128' })
  ]),
  el('div', {}, [
    el('div', {}, [
      el('a', { href: `${ORIGIN}/novels/${slug}${q}`, 'aria-label': title, class: 'line-clamp-1' }, [], title),
      el('div', { class: 'line-clamp-2' }, [], `列表短 blurb：${title}`)
    ]),
    el('div', {}, [
      el('div', {}, [el('a', { href: `${ORIGIN}/novels/category/fantasy${q}` }, [], 'Fantasy')]),
      el('a', { href: `${ORIGIN}/novels/${slug}/chapter-1${q}`, 'aria-label': title }, [], 'Read Now')
    ])
  ])
]);

/**
 * 「Popular Novels / Popular Short Dramas」板式：**封面是 <a> 的兄弟节点**（不在链接里），
 * 卡上无简介、只有一个分类标签与评分。取封面必须从链接向上爬，且不许爬进别的卡。
 */
const posterSiblingCard = ({ slug, title, hash }, kind = 'novels', q = '') => el('div', { class: 'card-col' }, [
  el('div', { class: 'card-media' }, [
    el('img', { alt: title, src: cover(hash), width: '190', height: '254' }),
    el('a', { href: `${ORIGIN}/${kind}/${slug}${q}`, 'aria-label': title, class: 'line-clamp-2' }, [], title),
    el('div', { class: 'rating' }, [el('div', {}, [], '6.6')])
  ]),
  el('div', {}, [el('a', { href: `${ORIGIN}/${kind === 'dramas' ? 'genres' : 'novels/category'}/billionaire${q}` }, [], 'Billionaire')])
]);

/** 「Editor's Pick」板式：封面在 <a> 里，分类链接排在标题**前面**，卡上带 blurb 与底部按钮。 */
const pickCard = ({ slug, title, hash }, q = '') => el('div', { class: 'card-pick' }, [
  el('a', { href: `${ORIGIN}/novels/${slug}${q}`, 'aria-label': title }, [
    el('img', { alt: title, src: cover(hash), width: '176', height: '240' })
  ]),
  el('div', {}, [
    el('div', {}, [
      el('a', { href: `${ORIGIN}/novels/category/fantasy${q}` }, [], 'Fantasy'),
      el('a', { href: `${ORIGIN}/novels/${slug}${q}`, 'aria-label': title, class: 'line-clamp-1' }, [], title),
      el('div', { class: 'line-clamp-3' }, [], `列表短 blurb：${title}`)
    ]),
    el('a', { href: `${ORIGIN}/novels/${slug}${q}`, 'aria-label': title, class: 'read-btn' }, [], '')
  ])
]);

/** 板块容器：标题与副标题在一个包裹里，卡片在另一个包裹里（真机 max-w-7xl 那层）。 */
const section = (headTag, heading, cards, subtitle = '说明文案') => el('div', { class: 'max-w-7xl' }, [
  el('div', { class: 'head-wrap' }, [
    el(headTag, { class: 'section-title' }, [], heading),
    el('div', { class: 'subtitle' }, [], subtitle)
  ]),
  el('div', { class: 'row-wrap' }, [el('div', { class: 'row' }, cards)])
]);

/** Popular Short Dramas 的标题真机上包在一个 <a href="/genres"> 里，多一层要爬。 */
const dramaSection = (cards, q = '') => el('div', { class: 'section-box' }, [
  el('div', { class: 'head-wrap' }, [
    el('a', { href: `${ORIGIN}/genres`, 'aria-label': 'Popular Short Dramas' }, [
      el('h2', {}, [], 'Popular Short Dramas')
    ]),
    el('div', { class: 'subtitle' }, [], 'The most-watched short drama series right now')
  ]),
  el('div', { class: 'row-wrap' }, [el('div', { class: 'row' }, cards)])
]);

const page = (sections) => el('html', {}, [el('body', {}, [el('main', {}, sections)])]);

const novelsPage = (q = '') => page([
  section('h2', 'Recommended WebNovels For You', REC.map(c => recCard(c, q))),
  section('h2', 'Latest WebNovel Releases', [posterSiblingCard({ slug: 'another-one', title: '别的板块', hash: 'ZzZzZzZzZzZA' }, 'novels', q)]),
  dramaSection(DRAMAS.map(c => posterSiblingCard(c, 'dramas', q)), q)
]);

const homePage = (q = '') => page([
  section('h2', 'Popular Novels', POP_NOVELS.map(c => posterSiblingCard(c, 'novels', q))),
  section('h3', 'Newly Updated Web Novels', [posterSiblingCard({ slug: 'newly-updated-one', title: '别的板块', hash: 'YyYyYyYyYyYA' }, 'novels', q)]),
  section('h3', "Editor's Pick", PICKS.map(c => pickCard(c, q)))
]);

// ---------- 详情页 ----------
/** 小说详情：<h2>{标题} Summary</h2> + 正文块（另有空的渐变遮罩与「Read More」兄弟节点）。 */
const novelDetail = ({ title, summary, genres = ['Billionaire', 'Romance'] }) => el('html', {}, [el('body', {}, [
  el('div', { class: 'hero' }, [
    el('h1', {}, [], title),
    el('div', { class: 'meta' }, genres.map(g => el('a', { href: `${ORIGIN}/novels/category/${g.toLowerCase()}` }, [], g)))
  ]),
  el('div', { class: 'summary-box' }, [
    el('h2', {}, [], `${title} Summary`),
    el('div', { class: 'body-wrap' }, [
      summary ? el('div', { class: 'line-clamp-4' }, [], summary) : null,
      el('div', { class: 'gradient' }, [], ''),
      el('div', { class: 'more-row' }, [el('div', {}, [], 'Read More')])
    ].filter(Boolean))
  ]),
  // 页面下方的相关推荐：同样有 /novels/category/ 链接，不能被 genres 吃进来
  el('div', { class: 'related' }, [
    el('h2', {}, [], 'Popular Billionaire WebNovels'),
    el('a', { href: `${ORIGIN}/novels/category/horror` }, [], 'Horror'),
    el('a', { href: `${ORIGIN}/novels/category/mafia` }, [], 'Mafia')
  ])
])]);

/** 短剧详情：无 Summary 标题，简介是 hero 块里的一个叶子 div；genres 在 h1 同级。 */
const dramaDetail = ({ title, summary, genres = ['Billionaire', 'CEO', 'Romance'] }) => el('html', {}, [el('body', {}, [
  el('div', { class: 'hero-outer' }, [
    el('div', { class: 'hero-mid' }, [
      el('div', { class: 'hero-inner' }, [
        el('h1', {}, [], title),
        el('div', { class: 'tag-row' }, genres.map(g => el('a', { href: `${ORIGIN}/genres/${g.toLowerCase()}` }, [], g)))
      ]),
      summary ? el('div', { class: 'line-clamp-5' }, [], summary) : null
    ].filter(Boolean))
  ]),
  el('div', { class: 'related' }, [
    el('h3', {}, [], 'You May Also Like'),
    el('a', { href: `${ORIGIN}/genres/revenge` }, [], 'Revenge')
  ])
])]);

const SUMMARY = slug => `这是 ${slug} 的详情页完整梗概，比列表上的短 blurb 长得多，用来验证简介取的是详情页那一份而不是列表那一份。`;

const detailDocs = () => {
  const out = {};
  for (const c of [...REC, ...POP_NOVELS, ...PICKS]) {
    out[`${ORIGIN}/novels/${c.slug}`] = novelDetail({ title: c.title, summary: SUMMARY(c.slug) });
  }
  for (const c of DRAMAS) {
    out[`${ORIGIN}/dramas/${c.slug}`] = dramaDetail({ title: c.title, summary: SUMMARY(c.slug) });
  }
  return out;
};

const loc = href => { const u = new URL(href); return { href, hostname: u.hostname, pathname: u.pathname, search: u.search, origin: u.origin }; };

/**
 * fetch 返回的「html」就是被请求的 URL 本身，DOMParser 再按这个 URL 查表拿预建的元素树
 * （同 unit-shortmax-home 的手法）：既不用写 HTML 解析器，又能顺带断言请求了哪些地址、几次。
 */
async function runScenario({ href = NOVELS, subscriptions = SUBS, live, docs = detailDocs(), dramas = [], failUrls = [] } = {}) {
  const store = { dramas: structuredClone(dramas) };
  const saveCalls = [];
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
        return { success: true };
      }
    }
  };
  globalThis.window = { location: loc(href) };
  globalThis.document = documentFrom(live || novelsPage(new URL(href).search));
  globalThis.DOMParser = class {
    parseFromString(html) { return documentFrom(docs[html] || el('html')); }
  };
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    if (failUrls.includes(url)) return { ok: false, status: 500, text: async () => '' };
    if (!(url in docs)) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, url, text: async () => url };
  };

  (0, eval)(contentSrc);
  const response = await new Promise(resolve => {
    for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
  });
  return { saved: store.dramas, saveCalls, fetchCalls, response };
}

// ---------- L 板块定位 ----------
{
  const { saved } = await runScenario({ href: NOVELS, live: novelsPage('?list=recommended_webnovels_for_you') });
  check('L1 ?list=recommended_webnovels_for_you 命中 Recommended 板块',
    eq(saved.map(d => d.itemId), REC.map(c => `pdn${c.slug}`)), show(saved.map(d => d.itemId)));
}
{
  const { saved } = await runScenario({ href: NOVELS_DRAMAS, live: novelsPage('?list=popular_short_dramas') });
  check('L2 ?list=popular_short_dramas 命中短剧板块（标题包在 <a> 里，多爬一层）',
    eq(saved.map(d => d.itemId), DRAMAS.map(c => `pdd${c.slug}`)), show(saved.map(d => d.itemId)));
}
{
  const { saved } = await runScenario({ href: HOME_POP, live: homePage('?list=popular_novels') });
  check('L3 ?list=popular_novels 命中首页 h2 板块',
    eq(saved.map(d => d.itemId), POP_NOVELS.map(c => `pdn${c.slug}`)), show(saved.map(d => d.itemId)));
}
{
  const { saved } = await runScenario({ href: HOME_PICK, live: homePage('?list=editor_s_pick') });
  check("L4 ?list=editor_s_pick 命中首页 h3 板块（标题混用 h2/h3，只查 h2 会漏）",
    eq(saved.map(d => d.itemId), PICKS.map(c => `pdn${c.slug}`)), show(saved.map(d => d.itemId)));
}
{
  const href = `${ORIGIN}/novels`;
  const { saved } = await runScenario({ href, subscriptions: [{ urlPattern: href, tags: ['Pines', 'novel'] }], live: novelsPage('') });
  check('L5 /novels 无 ?list= 时缺省 Recommended 板块',
    eq(saved.map(d => d.itemId), REC.map(c => `pdn${c.slug}`)), show(saved.map(d => d.itemId)));
}
{
  const href = `${ORIGIN}/`;
  const { saved } = await runScenario({ href, subscriptions: [{ urlPattern: href, tags: ['Pines', 'novel'] }], live: homePage('') });
  check('L6 首页无 ?list= 时缺省 Popular Novels 板块',
    eq(saved.map(d => d.itemId), POP_NOVELS.map(c => `pdn${c.slug}`)), show(saved.map(d => d.itemId)));
}
{
  const href = `${ORIGIN}/novels?list=no_such_section`;
  const { saved, response, fetchCalls } = await runScenario({
    href, subscriptions: [{ urlPattern: href, tags: ['Pines', 'novel'] }], live: novelsPage('?list=no_such_section')
  });
  check('L7 板块找不到 → 零入库、零详情请求、不报错',
    response?.success === true && saved.length === 0 && fetchCalls.length === 0, show([saved.length, fetchCalls.length]));
}
{
  // 板块容器里混进第二个标题＝爬过头，会把下一个板块的卡吃进来 → 宁可不抓
  const bad = page([el('div', { class: 'max-w-7xl' }, [
    el('div', { class: 'head-wrap' }, [el('h2', {}, [], 'Popular Novels')]),
    el('div', {}, [
      el('h2', {}, [], 'Newly Updated Web Novels'),
      ...POP_NOVELS.map(c => posterSiblingCard(c, 'novels'))
    ])
  ])]);
  const { saved } = await runScenario({ href: HOME_POP, live: bad });
  check('L8 爬到的容器里有第二个标题 → 判为越界，不抓（防吃进下一个板块）',
    saved.length === 0, show(saved.map(d => d.itemId)));
}

// ---------- F 字段映射 ----------
{
  const { saved, fetchCalls } = await runScenario({ href: NOVELS, live: novelsPage('?list=recommended_webnovels_for_you') });
  const d = saved[0] || {};
  const c = REC[0];
  check('F1 itemId=pdn+slug，id 形态 pinedrama_<itemId>_<index>',
    d.itemId === `pdn${c.slug}` && d.id === `pinedrama_pdn${c.slug}_0`, show([d.itemId, d.id]));
  check('F2 标题取 aria-label', d.title === c.title, show(d.title));
  check('F3 封面存站点卡片同款缩略图原值（含 !NNNNN.webp 尾缀）',
    d.poster === cover(c.hash), show(d.poster));
  check('F4 url 指向 /novels/<slug>（剥掉 href 上的 ?list=）',
    d.url === `${ORIGIN}/novels/${c.slug}`, show(d.url));
  check('F5 简介取详情页 Summary，不是列表那段短 blurb',
    d.description === SUMMARY(c.slug), show(d.description));
  check('F6 genres 取详情页 h1 同级的分类链接（不含页面下方相关推荐的分类）',
    eq(d.genres, ['Billionaire', 'Romance']), show(d.genres));
  check('F7 source/status/译文占位/标签/归属 canonical',
    d.source === 'pinedrama' && d.status === 'new' && d.titleZh === '' && d.descriptionZh === ''
    && eq(d.tags, ['Pines', 'novel', 'recommend']) && d.sourceListUrl === NOVELS,
    show([d.source, d.status, d.tags, d.sourceListUrl]));
  check('F8 scrapedAt 合法、translatedAt 为 null',
    Number.isFinite(Date.parse(d.scrapedAt)) && d.translatedAt === null, show([d.scrapedAt, d.translatedAt]));
  check('F9 每卡恰一次详情请求、无列表请求（实时 DOM，零同源重取）',
    fetchCalls.length === REC.length && eq(fetchCalls, REC.map(x => `${ORIGIN}/novels/${x.slug}`)), show(fetchCalls));
}
{
  const { saved } = await runScenario({ href: NOVELS_DRAMAS, live: novelsPage('?list=popular_short_dramas') });
  const d = saved[0] || {};
  const c = DRAMAS[0];
  check('F10 短剧卡：itemId=pdd+slug、url 走 /dramas/ 路径',
    d.itemId === `pdd${c.slug}` && d.url === `${ORIGIN}/dramas/${c.slug}`, show([d.itemId, d.url]));
  check('F11 短剧卡封面是 <a> 的兄弟节点，仍能取到（向上爬但不越卡）',
    d.poster === cover(c.hash), show(d.poster));
  check('F12 短剧简介取详情页 hero 里的正文块（无 Summary 标题）',
    d.description === SUMMARY(c.slug), show(d.description));
  check('F13 短剧 genres 取 /genres/ 链接且只取 h1 同级那批',
    eq(d.genres, ['Billionaire', 'CEO', 'Romance']), show(d.genres));
}
{
  const { saved } = await runScenario({ href: HOME_PICK, live: homePage('?list=editor_s_pick') });
  const d = saved[0] || {};
  check("F14 Editor's Pick 卡：分类链接排在标题前也不会被当成作品链接",
    d.itemId === `pdn${PICKS[0].slug}` && d.title === PICKS[0].title, show([d.itemId, d.title]));
  check("F15 Editor's Pick 封面取卡内 img", d.poster === cover(PICKS[0].hash), show(d.poster));
}

// ---------- S slug 解析（最易回归的两条） ----------
{
  const { saved } = await runScenario({ href: NOVELS, live: novelsPage('?list=recommended_webnovels_for_you') });
  const ids = saved.map(d => d.itemId);
  check('S1 /novels/<slug>/chapter-1 的「Read Now」不得产出 pdnchapter-1',
    !ids.includes('pdnchapter-1') && ids.length === REC.length, show(ids));
  check('S2 /novels/category/<name> 分类链接不得被当成作品',
    !ids.some(id => id.includes('category') || id.includes('fantasy')), show(ids));
}
{
  const q = '?list=recommended_webnovels_for_you';
  const { saved } = await runScenario({ href: NOVELS, live: novelsPage(q) });
  check('S3 href 上被站点原样拼接的 ?list= 必须剥掉（否则 slug 带查询串）',
    saved.every(d => !d.itemId.includes('?') && !d.url.includes('?')), show(saved.map(d => [d.itemId, d.url])));
}
{
  const weird = page([section('h2', 'Popular Novels', [
    // 大写与下划线都不是站点 slug 的合法形态，守卫应拦掉
    posterSiblingCard({ slug: 'Not_A_Slug', title: '坏 slug', hash: 'BadBadBadBaA' }, 'novels'),
    posterSiblingCard(POP_NOVELS[0], 'novels')
  ])]);
  const { saved } = await runScenario({ href: HOME_POP, live: weird });
  check('S4 非法 slug 跳过该条、不影响同板块其它条目',
    eq(saved.map(d => d.itemId), [`pdn${POP_NOVELS[0].slug}`]), show(saved.map(d => d.itemId)));
}
{
  // 同名 slug 分属两套命名空间（/novels/x 与 /dramas/x 站点自己就互为 404），键必须分开
  const both = page([section('h2', 'Popular Novels', [
    posterSiblingCard({ slug: 'same-name', title: '小说版', hash: 'AaAaAaAaAaAA' }, 'novels'),
    posterSiblingCard({ slug: 'same-name', title: '短剧版', hash: 'BbBbBbBbBbBA' }, 'dramas')
  ])]);
  const docs = {
    ...detailDocs(),
    [`${ORIGIN}/novels/same-name`]: novelDetail({ title: '小说版', summary: SUMMARY('novel') }),
    [`${ORIGIN}/dramas/same-name`]: dramaDetail({ title: '短剧版', summary: SUMMARY('drama') })
  };
  const { saved } = await runScenario({ href: HOME_POP, live: both, docs });
  check('S5 同名 slug 的小说与短剧互不撞键（pdn / pdd 分开）',
    eq(saved.map(d => d.itemId), ['pdnsame-name', 'pddsame-name']), show(saved.map(d => d.itemId)));
}

// ---------- D 详情失败面 ----------
{
  const docs = detailDocs();
  delete docs[`${ORIGIN}/novels/${REC[0].slug}`];
  const { saved } = await runScenario({ href: NOVELS, live: novelsPage('?list=recommended_webnovels_for_you'), docs });
  check('D1 详情 404 → 跳过该卡（不留无简介的卡），同板块其它卡照常入库',
    eq(saved.map(d => d.itemId), [`pdn${REC[1].slug}`]), show(saved.map(d => d.itemId)));
}
{
  const { saved } = await runScenario({
    href: NOVELS, live: novelsPage('?list=recommended_webnovels_for_you'),
    failUrls: [`${ORIGIN}/novels/${REC[0].slug}`]
  });
  check('D2 详情 HTTP 失败 → 同样跳过该卡',
    eq(saved.map(d => d.itemId), [`pdn${REC[1].slug}`]), show(saved.map(d => d.itemId)));
}
{
  // 简介块为空时，块内最长的叶子文本就是移动端那行「Read More」——没有最小长度闸门
  // 就会把它当简介存进库（这正是实现里 PINEDRAMA_MIN_SUMMARY 的存在理由）
  const docs = detailDocs();
  docs[`${ORIGIN}/novels/${REC[0].slug}`] = novelDetail({ title: REC[0].title, summary: '' });
  const { saved } = await runScenario({ href: NOVELS, live: novelsPage('?list=recommended_webnovels_for_you'), docs });
  check('D3 详情页有结构但简介为空 → 跳过该卡，不得把「Read More」当简介存下',
    eq(saved.map(d => d.itemId), [`pdn${REC[1].slug}`])
    && !saved.some(d => /Read More/.test(d.description || '')), show(saved.map(d => [d.itemId, d.description])));
}
{
  const docs = detailDocs();
  docs[`${ORIGIN}/novels/${REC[0].slug}`] = novelDetail({ title: REC[0].title, summary: SUMMARY(REC[0].slug), genres: [] });
  const { saved } = await runScenario({ href: NOVELS, live: novelsPage('?list=recommended_webnovels_for_you'), docs });
  check('D4 详情有简介但无分类 → 仍入库，genres 留空数组（下轮回填自愈）',
    saved[0]?.itemId === `pdn${REC[0].slug}` && eq(saved[0]?.genres, []), show([saved[0]?.itemId, saved[0]?.genres]));
}
{
  const docs = detailDocs();
  docs[`${ORIGIN}/novels/${REC[0].slug}`] = novelDetail({
    title: REC[0].title, summary: SUMMARY(REC[0].slug), genres: ['Billionaire', ' Billionaire ', 'Romance', '']
  });
  const { saved } = await runScenario({ href: NOVELS, live: novelsPage('?list=recommended_webnovels_for_you'), docs });
  check('D5 genres 经 cleanGenres 去空去重 trim',
    eq(saved[0]?.genres, ['Billionaire', 'Romance']), show(saved[0]?.genres));
}

// ---------- B 存量回填 ----------
{
  const c = REC[0];
  const existing = [{ itemId: `pdn${c.slug}`, title: c.title, source: 'pinedrama', genres: [], scrapedAt: '2026-09-17T00:00:00.000Z' }];
  const { saveCalls, fetchCalls } = await runScenario({
    href: NOVELS, live: novelsPage('?list=recommended_webnovels_for_you'), dramas: existing
  });
  const backfill = saveCalls.find(d => d.itemId === `pdn${c.slug}`);
  check('B1 存量无 genres → 经详情回填并提交，恰一次详情请求',
    !!backfill && eq(backfill.genres, ['Billionaire', 'Romance'])
    && fetchCalls.filter(u => u === `${ORIGIN}/novels/${c.slug}`).length === 1, show([backfill?.genres, fetchCalls]));
}
{
  const c = REC[0];
  const existing = [{ itemId: `pdn${c.slug}`, title: c.title, source: 'pinedrama', genres: ['Fantasy'], scrapedAt: '2026-09-17T00:00:00.000Z' }];
  const { fetchCalls } = await runScenario({
    href: NOVELS, live: novelsPage('?list=recommended_webnovels_for_you'), dramas: existing
  });
  check('B2 存量已有 genres → 零详情请求（不白烧带宽）',
    !fetchCalls.includes(`${ORIGIN}/novels/${c.slug}`), show(fetchCalls));
}

// ---------- P 路径闸门与订阅匹配 ----------
{
  // 同时含两个缺省板块的页面：无论 pathname 推出哪个缺省值都能抓到东西，
  // 于是「抓到 0 条」只可能是路径闸门拦下的（行为断言，不去戳内部符号）
  const bothDefaults = page([
    section('h2', 'Recommended WebNovels For You', REC.map(c => recCard(c))),
    section('h2', 'Popular Novels', POP_NOVELS.map(c => posterSiblingCard(c, 'novels')))
  ]);
  const cases = [
    [`${ORIGIN}/`, true, '首页'],
    [`${ORIGIN}/?list=popular_novels`, true, '首页带 ?list='],
    [`${ORIGIN}/novels`, true, '/novels'],
    [`${ORIGIN}/novels/`, true, '/novels 尾斜杠'],
    [`${ORIGIN}/novels?list=recommended_webnovels_for_you`, true, '/novels 带 ?list='],
    [`${ORIGIN}/novels/the-ceos-midnight-savior`, false, '作品详情页'],
    [`${ORIGIN}/novels/category/fantasy`, false, '分类页'],
    [`${ORIGIN}/dramas`, false, '/dramas 列表页（不在订阅范围）'],
    [`${ORIGIN}/genres`, false, '/genres'],
    ['https://notpinedrama.example/novels', false, '别的域名']
  ];
  const outcomes = [];
  for (const [url, want, label] of cases) {
    const { saved } = await runScenario({
      href: url, subscriptions: [{ urlPattern: url, tags: ['Pines', 'X'] }], live: bothDefaults
    });
    outcomes.push([label, saved.length > 0, want]);
  }
  check('P1 路径闸门只放行两个订阅页',
    outcomes.every(([, got, want]) => got === want), show(outcomes.filter(([, g, w]) => g !== w)));
}
{
  const { saved } = await runScenario({
    href: `${ORIGIN}/novels?list=recommended_webnovels_for_you`,
    subscriptions: SUBS, live: novelsPage('?list=recommended_webnovels_for_you')
  });
  check('P2 四条订阅互不为前缀干扰，精确等值命中各自标签',
    eq(saved[0]?.tags, ['Pines', 'novel', 'recommend']), show(saved[0]?.tags));
}
{
  const { saved, response } = await runScenario({
    href: `${ORIGIN}/novels?list=recommended_webnovels_for_you`,
    subscriptions: [{ urlPattern: 'https://www.pinedrama.com/novels?list=recommended_webnovels_for_you', tags: ['Pines'] }],
    live: novelsPage('?list=recommended_webnovels_for_you')
  });
  check('P3 订阅误写 www（站点 301 到裸域）→ 零抓取（与规则目录里的裸域形态成对）',
    response?.success === true && saved.length === 0, show(saved.length));
}

// ---------- 汇总 ----------
console.log = origLog;
const failed = results.filter(r => !r.pass);
for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : ` → ${r.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
