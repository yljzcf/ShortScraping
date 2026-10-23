import './bootstrap.cjs';
// My Drama 主站首页（2026-10 改版）单测（v1.8.6）：加载真实 content.js（先 eval site-registry）。
//
// 改版后板块 id 全换了（most_trending / best_choices 没了），卡片也不再是统一的
// [data-testid="series-section-item"]：每个板块一种 testid，卡片本身就是指向 /video/<UUID> 的链接，
// 卡上没有 h3 和简介，片名只在 img alt / aria-label 里。适配器改为「板块内按 /video/ 链接取、按 UUID
// 去重」，吃的是真选择器，所以照 PinesDramas 套件用 dom-fixture 搭真元素树。结构取自 2026-10-23
// 实测的 en-US 首页 SSR。易回归点各有专门用例：
//  1) Top Picks 的 aria-label 带「1. 」名次前缀——片名要取 img alt；
//  2) 「独家」轮播为无缝循环把每张卡复制了三份——只入库一次、序号连续、详情只请求一次；
//  3) banner 幻灯片里封面、标题和「开始观看」按钮是兄弟节点，按钮里没有图——要从按钮往上取到
//     幻灯片容器拿封面和片名；另一套桌面版 hero 的重复链接靠去重收拢；
//  4) 封面目录名把撇号、冒号写成 _sq_ / _cl_，也和官方名有出入——以详情页 JSON-LD 的剧名为准；
//     浏览器拿到的完整页 og:title 带「 - Episode 1 | My Drama」，只能剥后缀兜底；
//  5) 中文页链接带 /zh/ 前缀和 ?from=home——去重键与 url 仍是规范形态。
//
// 用法：node tests/unit-mydrama-home.mjs
import fs from 'node:fs';
import { el, documentFrom } from './dom-fixture.mjs';
import { scrapeContextReply } from './content-fixture.mjs';

const contentSrc = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
(0, eval)(fs.readFileSync(new URL('../src/shared/site-registry.js', import.meta.url), 'utf8'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = v => JSON.stringify(v);

const origLog = console.log, origWarn = console.warn, origError = console.error;
const warnings = [];
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (String(a[0]).includes('[ShortScraping]')) warnings.push(a.join(' ')); else origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

// ---------- fixture ----------
const ORIGIN = 'https://my-drama.com';
const HOME = `${ORIGIN}/`;
const BANNER = `${ORIGIN}/?list=banner`;
const EXCLUSIVES = `${ORIGIN}/?list=my_drama_exclusives`;

/** dir 是封面路径里的目录名（站点原样编码：空格 %20、撇号 _sq_、冒号 _cl_）。 */
const TOP = [
  { uuid: '252854bb-f5a6-4194-98ea-e9f240c42d7c', title: "They Shouldn't Have Saved Me", dir: 'They%20Shouldn_sq_t%20Have%20Saved%20Me', zh: '他们不该救我' },
  { uuid: 'a7b69808-5d5b-4f8d-a862-13fba7529e9d', title: 'My Secret Deal with the Bad Boy Captain', dir: 'My%20Secret%20Deal%20with%20the%20Bad%20Boy%20Captain', zh: '我和坏男孩队长的秘密交易' },
  { uuid: '88feb688-8346-4c6b-ac11-29dfc7a82401', title: "Good Girl's Darkest Sin", dir: 'Good%20Girl_sq_s%20Darkest%20Sin', zh: '好女孩最黑暗的罪' }
];
const EXCL = [
  { uuid: '4a3c19e3-0a3f-415f-88d0-fe623e843313', title: 'Mr. Denver', dir: 'Mr.%20Denver' },
  // 目录名少了 The：官方名以详情页 og:title 为准
  { uuid: '3fe37c96-b433-4070-b75c-6f9ee2859bab', title: 'The Club of Desire', dir: 'Club%20of%20Desire' },
  { uuid: 'c2e6a1f0-7b3d-4e2a-9f10-5d8c3b7a6e41', title: 'Secret Society: Till Blood Do Us Part', dir: 'Secret%20Society_cl_%20Till%20Blood%20Do%20Us%20Part' }
];
const SLIDES = [
  { uuid: '32dd52b1-1264-49b0-9d9b-e5a9b340c62b', title: 'Mrs. Blaire', dir: 'Mrs.%20Blaire', chips: ['Secret Heiress', 'Contract Marriage'] },
  { uuid: 'e0d3581e-154d-4aee-a8d0-f0d645b3e90e', title: "Mother's Heart Never Lies", dir: 'Mother_sq_s%20Heart%20Never%20Lies', chips: ['Secret Child', 'Thriller'] },
  { uuid: '08922822-6fb2-4a24-93a8-8d8fd2f0f8a4', title: 'Blades of Love: Falling for My Stepbrother', dir: 'Blades%20of%20Love_cl_%20Falling%20for%20My%20Stepbrother', chips: ['Sports Romance'] }
];
// 只出现在「继续观看」板块里的片：默认板块不许把它吃进来
const OTHER = { uuid: '6d25b4d3-d35e-44b9-9530-3f318e68c83e', title: 'Echo Protocol', dir: 'Echo%20Protocol' };
const ALL = [...TOP, ...EXCL, ...SLIDES, OTHER];

const cover = (dir, lang = 'en', width = 570) =>
  `https://static.my-drama.com/convert/${dir}/${lang}/2026-09-29%2011:56:58/cover.webp?format=webp&width=${width}`;
const href = (uuid, prefix = '') => `${prefix}/video/${uuid}?from=home`;
const playUrl = uuid => `${ORIGIN}/video/${uuid}`;

/** Top Picks：链接包着封面，aria-label 带名次前缀，另有一个名次数字。 */
const topCard = (s, i, { prefix = '', alt = s.title, label = `${i + 1}. ${s.title}`, lang = 'en' } = {}) =>
  el('a', { 'aria-label': label, 'data-testid': 'main-screen-top-ranked-item', 'data-variant': 'portrait', href: href(s.uuid, prefix) }, [
    el('span', {}, [el('img', { src: cover(s.dir, lang), alt })]),
    el('span', { 'aria-hidden': 'true' }, [el('span', {}, [], String(i + 1))])
  ]);

/** 「独家」轮播：卡片 + 循环副本（同样的链接与封面，换了 testid）。 */
const glowCard = (s, testid, attrs = {}) =>
  el('a', { 'aria-label': s.title, 'data-testid': testid, 'data-rail-tile': '', href: href(s.uuid), ...attrs }, [
    el('img', { src: cover(s.dir, 'en', 675), alt: s.title }),
    el('span', { 'data-testid': 'main-screen-glow-rail-logo-badge' })
  ]);

/** banner 幻灯片：封面图、chips、h1 标题与「开始观看」按钮是兄弟节点，按钮里没有图。 */
const heroSlide = s => el('div', { 'data-testid': 'main-screen-hero-slide' }, [
  el('div', {}, [el('img', { src: cover(s.dir, 'en', 1500), alt: s.title })]),
  el('span', { 'aria-hidden': 'true' }),
  el('div', {}, [
    el('ul', {}, s.chips.map(c => el('li', { 'data-testid': 'main-screen-hero-chip' }, [], c))),
    el('div', {}, [el('h1', {}, [], s.title)]),
    el('a', { 'data-testid': 'main-screen-hero-cta', href: `/video/${s.uuid}` }, [], 'Start Watching')
  ])
]);

/** 桌面版 hero：一排只有图的帧，再加当前片的标题链接与按钮（链接与移动版重复）。 */
const desktopHero = slides => el('div', { 'data-testid': 'main-screen-desktop-hero' }, [
  el('div', {}, slides.map(s => el('div', { 'data-testid': 'main-screen-desktop-hero-frame' }, [
    el('img', { src: cover(s.dir, 'en', 1500), alt: s.title })
  ]))),
  el('a', { 'data-testid': 'main-screen-desktop-hero-title', href: `/video/${slides[0].uuid}` }, [], slides[0].title),
  el('a', { 'data-testid': 'main-screen-desktop-hero-cta', href: `/video/${slides[0].uuid}` }, [], 'Start Watching')
]);

const section = (id, children) => el('section', { id, 'data-testid': 'main-screen-section' }, children);

const homePage = ({ top = TOP.map((s, i) => topCard(s, i)), excl = EXCL } = {}) => el('html', {}, [el('body', {}, [
  el('header', { 'data-testid': 'main-screen-header' }, [el('a', { href: '/' }, [], 'My Drama')]),
  el('main', { 'data-testid': 'main-screen-container' }, [
    section('banner', [
      el('div', { 'data-testid': 'main-screen-hero' }, SLIDES.map(heroSlide)),
      desktopHero(SLIDES)
    ]),
    section('premium_banner', []),
    section('continue_watching', [el('a', { href: href(OTHER.uuid) }, [el('img', { src: cover(OTHER.dir), alt: OTHER.title })])]),
    section('my_drama_exclusives', [el('div', { 'data-testid': 'main-screen-glow-rail' }, [
      ...excl.map(s => glowCard(s, 'main-screen-glow-rail-card')),
      ...excl.map(s => glowCard(s, 'main-screen-rail-loop-copy', { 'aria-hidden': 'true' })),
      ...excl.map(s => glowCard(s, 'main-screen-rail-loop-copy', { 'aria-hidden': 'true' }))
    ])]),
    section('top_picks_in_country', [el('div', { 'data-testid': 'main-screen-top-ranked' }, top)])
  ])
])]);

// ---------- 详情页（播放页）：og 元信息 + JSON-LD @graph ----------
// 缺省是浏览器（带 cookie）拿到的完整页：og:title / og:description 带「 - Episode 1」与站点模板，
// 剧名只在 TVEpisode.partOfSeries 里是干净的。不带 cookie 的请求拿到的精简页 og:title 才是纯剧名——
// v1.8.6 初版只按精简页验证，真机入库的剧名全带上了「 - Episode 1 | My Drama」。
const GENRES = uuid => ['Thriller', `G-${uuid.slice(0, 4)}`];
const detailDoc = (s, {
  series = s.title,
  ogTitle = `${s.title} - Episode 1 | My Drama`,
  ogImage = `https://dj0vkl2i4vsbo.cloudfront.net/convert/${s.dir}/en/2026-09-14%2010:23:04/1.0000000.webp`
} = {}) =>
  el('html', {}, [el('head', {}, [
    el('title', {}, [], `${s.title} - Episode 1 | My Drama`),
    ogTitle !== null ? el('meta', { property: 'og:title', content: ogTitle }) : null,
    el('meta', { property: 'og:description', content: `${s.title} - Episode 1 - to watch on My Drama streaming platform. Synopsis of ${s.title}.` }),
    el('meta', { property: 'og:image', content: ogImage }),
    el('script', { type: 'application/ld+json' }, [], JSON.stringify({ '@context': 'https://schema.org', '@graph': [
      { '@type': 'VideoObject', name: `${s.title} — Episode 1`, genre: GENRES(s.uuid) },
      { '@type': 'TVEpisode', name: 'Episode 1', episodeNumber: 1,
        ...(series !== null ? { partOfSeries: { '@type': 'TVSeries', name: series } } : {}) },
      { '@type': 'WebPage', name: `${s.title} - Episode 1 | My Drama` },
      { '@type': 'WebSite', name: 'My Drama' }
    ] }))
  ].filter(Boolean))]);
const detailDocs = (overrides = {}) => Object.fromEntries(ALL.map(s => [playUrl(s.uuid), overrides[s.uuid] || detailDoc(s)]));

const loc = h => { const u = new URL(h); return { href: h, hostname: u.hostname, pathname: u.pathname, search: u.search, origin: u.origin }; };

/**
 * fetch 返回的「html」就是被请求的 URL 本身，DOMParser 再按这个 URL 查表拿预建的元素树
 * （同 unit-pinedrama-sections 的手法），顺带记下请求了哪些地址、带了什么头。
 */
async function runScenario({ href: pageHref = HOME, subscription = pageHref, live = homePage(), docs = detailDocs(), failUrls = [] } = {}) {
  const store = { dramas: [] };
  const fetchCalls = [];
  const listeners = [];

  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      async sendMessage(message) {
        await Promise.resolve();
        if (message?.action === 'getScrapeContext') return scrapeContextReply(store.dramas, [{ urlPattern: subscription, tags: ['MyDrama', 'T'] }]);
        if (message?.action === 'saveDrama') {
          const dup = store.dramas.some(d => d.itemId === message.drama.itemId);
          if (!dup) store.dramas.push(structuredClone(message.drama));
          return { success: true, saved: !dup };
        }
        return { success: true };
      }
    }
  };
  globalThis.window = { location: loc(pageHref) };
  globalThis.document = documentFrom(live);
  globalThis.DOMParser = class {
    parseFromString(html) { return documentFrom(docs[html] || el('html')); }
  };
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, headers: { ...(options?.headers || {}) } });
    if (failUrls.includes(url) || !(url in docs)) return { ok: false, status: 500, text: async () => '' };
    return { ok: true, status: 200, url, text: async () => url };
  };

  (0, eval)(contentSrc);
  const response = await new Promise(resolve => {
    for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
  });
  return { saved: store.dramas, fetched: fetchCalls.map(c => c.url), fetchCalls, response };
}

const ids = list => list.map(s => `md${s.uuid}`);

// ---------- D 默认板块：Top Picks ----------
{
  const { saved, fetched, response } = await runScenario();
  check('D1 无 ?list= → 抓 Top Picks，按名次顺序，不吃别的板块（banner / 继续观看 / 独家）',
    response?.success === true && eq(saved.map(d => d.itemId), ids(TOP)), show(saved.map(d => d.itemId)));
  check('D2 片名取 img alt，不带「1. 」名次前缀；撇号原样',
    eq(saved.map(d => d.title), TOP.map(s => s.title)), show(saved.map(d => d.title)));
  check('D3 url 是规范播放页、序号连续（id 尾号 0..n-1）',
    eq(saved.map(d => d.url), TOP.map(s => playUrl(s.uuid))) && eq(saved.map(d => d.id.split('_').pop()), ['0', '1', '2']),
    show(saved.map(d => [d.url, d.id])));
  check('D4 简介与 genres 来自详情页（og:description / JSON-LD），封面保留列表的 /convert/ 竖版海报',
    saved.every((d, i) => d.description === `Synopsis of ${TOP[i].title}.` && eq(d.genres, GENRES(TOP[i].uuid)) && d.poster === cover(TOP[i].dir)),
    show(saved.map(d => [d.description, d.genres, d.poster])));
  check('D5 详情每部只请求一次、发往规范播放页',
    eq(fetched, TOP.map(s => playUrl(s.uuid))), show(fetched));
}

// ---------- E 「独家」轮播：循环副本去重 ----------
{
  const { saved, fetched, response } = await runScenario({ href: EXCLUSIVES });
  check('E1 ?list=my_drama_exclusives：三份循环副本只入库一次、按原顺序，回报的列表条数是 3 不是 9',
    eq(saved.map(d => d.itemId), ids(EXCL)) && eq(saved.map(d => d.id.split('_').pop()), ['0', '1', '2']) && response?.listCount === 3,
    show({ ids: saved.map(d => d.id), listCount: response?.listCount }));
  check('E2 详情每部只请求一次（副本不重复请求）', eq(fetched, EXCL.map(s => playUrl(s.uuid))), show(fetched));
  check('E3 片名是官方名（The Club of Desire、冒号原样）',
    eq(saved.map(d => d.title), EXCL.map(s => s.title)), show(saved.map(d => d.title)));
}

// ---------- B banner：按钮里没有图，从按钮往上取幻灯片容器 ----------
{
  const { saved, fetched, response } = await runScenario({ href: BANNER });
  check('B1 ?list=banner：三张幻灯片各入库一次，桌面版 hero 的重复链接被去重（列表条数 3）',
    eq(saved.map(d => d.itemId), ids(SLIDES)) && response?.listCount === 3,
    show({ ids: saved.map(d => d.itemId), listCount: response?.listCount }));
  check('B2 封面与片名取自幻灯片（按钮本身没有图）',
    saved.every((d, i) => d.poster === cover(SLIDES[i].dir, 'en', 1500) && d.title === SLIDES[i].title),
    show(saved.map(d => [d.title, d.poster])));
  check('B3 详情每部只请求一次', eq(fetched, SLIDES.map(s => playUrl(s.uuid))), show(fetched));
}

// ---------- T 片名来源与兜底 ----------
{
  // 卡上没有 alt / aria-label、详情页取不到：片名从封面目录名还原，_sq_ / _cl_ 换回撇号与冒号
  const bare = [TOP[0], TOP[2]].map((s, i) => topCard(s, i, { alt: '', label: '' }));
  const { saved } = await runScenario({ live: homePage({ top: bare }), failUrls: [playUrl(TOP[0].uuid), playUrl(TOP[2].uuid)] });
  check('T1 无 alt、详情失败 → 片名从封面目录名还原（_sq_ → 撇号）',
    eq(saved.map(d => d.title), [TOP[0].title, TOP[2].title]), show(saved.map(d => d.title)));
}
{
  // 卡上没有片名、详情页 JSON-LD 有剧名：目录名 Club of Desire 被官方剧名 The Club of Desire 取代
  const bareExcl = el('html', {}, [el('body', {}, [section('my_drama_exclusives', [
    el('a', { 'data-testid': 'main-screen-glow-rail-card', href: href(EXCL[1].uuid) }, [el('img', { src: cover(EXCL[1].dir, 'en', 675) })])
  ])])]);
  const { saved } = await runScenario({ href: EXCLUSIVES, live: bareExcl });
  check('T2 详情页剧名覆盖封面目录名还原的名字（Club of Desire → The Club of Desire），不带「 - Episode 1 | My Drama」',
    saved[0]?.title === 'The Club of Desire', show(saved.map(d => d.title)));

  // 同上，但页面没有 og:title：剧名只能来自 JSON-LD 的 partOfSeries
  const docs = detailDocs({ [EXCL[1].uuid]: detailDoc(EXCL[1], { ogTitle: null }) });
  const noOg = await runScenario({ href: EXCLUSIVES, live: bareExcl, docs });
  check('T6 无 og:title 时剧名取 JSON-LD 的 partOfSeries', noOg.saved[0]?.title === 'The Club of Desire', show(noOg.saved.map(d => d.title)));
}
{
  // 没有 partOfSeries：退回 og:title，剥掉「 - Episode 1 | My Drama」
  const s = TOP[0];
  const docs = detailDocs({ [s.uuid]: detailDoc(s, { series: null }) });
  const { saved } = await runScenario({ live: homePage({ top: [topCard(s, 0, { alt: '', label: '' })] }), docs });
  check('T7 无 partOfSeries → og:title 剥后缀兜底', saved[0]?.title === s.title, show(saved.map(d => d.title)));
}
{
  // 精简页（不带 cookie 的请求）：og:title 本身就是纯剧名，照样不出错
  const s = EXCL[2];
  const docs = detailDocs({ [s.uuid]: detailDoc(s, { ogTitle: s.title }) });
  const { saved } = await runScenario({ href: EXCLUSIVES, live: homePage({ excl: [s] }), docs });
  check('T8 精简页（og:title 是纯剧名）→ 剧名不变', saved[0]?.title === s.title, show(saved.map(d => d.title)));
}
{
  // 详情页既没有剧名也没有 og:title、og:image 是 /backfill_covers/ 路径（还原不出名字）：列表片名保持不变
  const s = TOP[1];
  const docs = detailDocs({ [s.uuid]: detailDoc(s, { series: null, ogTitle: null, ogImage: 'https://dj0vkl2i4vsbo.cloudfront.net/backfill_covers/Some+Other+Name/EN.webp' }) });
  const { saved } = await runScenario({ live: homePage({ top: [topCard(s, 0)] }), docs });
  check('T3 无剧名、无 og:title、og:image 是 backfill_covers → 列表片名不被改写，封面仍是列表的 /convert/',
    saved[0]?.title === s.title && saved[0]?.poster === cover(s.dir), show(saved.map(d => [d.title, d.poster])));
}
{
  // 中文页（扩展固定英文，规则没装上时才会遇到）：链接带 /zh/ 前缀，alt 是平台中文名
  const zhTop = TOP.map((s, i) => topCard(s, i, { prefix: '/zh', alt: s.zh, label: `${i + 1}. ${s.zh}`, lang: 'zh' }));
  const { saved, fetched } = await runScenario({ live: homePage({ top: zhTop }) });
  check('T4 中文页 /zh/video/<UUID>?from=home → 去重键 md+UUID、url 与详情请求都是规范播放页',
    eq(saved.map(d => d.itemId), ids(TOP)) && eq(saved.map(d => d.url), TOP.map(s => playUrl(s.uuid))) && eq(fetched, TOP.map(s => playUrl(s.uuid))),
    show({ ids: saved.map(d => d.itemId), fetched }));
  check('T5 中文片名进 titleZh，title 是英文官方名',
    eq(saved.map(d => [d.title, d.titleZh]), TOP.map(s => [s.title, s.zh])), show(saved.map(d => [d.title, d.titleZh])));
}

// ---------- L 板块定位 ----------
{
  const mark = warnings.length;
  const pageHref = `${ORIGIN}/?list=best_choices`;
  const { saved, fetched, response } = await runScenario({ href: pageHref });
  check('L1 改版后不存在的板块（?list=best_choices）→ 零入库、零详情请求、不报错',
    response?.success === true && saved.length === 0 && fetched.length === 0, show([saved.length, fetched]));
  check('L2 同上：告警点名缺的板块', warnings.slice(mark).some(w => w.includes('#best_choices') && w.includes('改版')), show(warnings.slice(mark)));
}
{
  // 数字开头的板块 id：以前拼成 #7days 选择器会抛 SyntaxError，现在用 getElementById
  const live = el('html', {}, [el('body', {}, [section('7days', [topCard(TOP[0], 0)])])]);
  const { saved, response } = await runScenario({ href: `${ORIGIN}/?list=7days`, live });
  check('L3 数字开头的板块 id 照常定位', response?.success === true && eq(saved.map(d => d.itemId), ids([TOP[0]])), show(saved.map(d => d.itemId)));
}
{
  const { fetchCalls } = await runScenario({ live: homePage({ top: [topCard(TOP[0], 0)] }) });
  check('L4 同源取播放页带英文 Accept-Language（v1.7.4 固定英文）',
    fetchCalls[0]?.headers['Accept-Language'] === 'en-US,en;q=0.9', show(fetchCalls));
}

// ---------- 汇总 ----------
console.log = origLog;
const failed = results.filter(r => !r.pass);
for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : ` → ${r.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
