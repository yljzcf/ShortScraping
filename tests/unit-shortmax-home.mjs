import './bootstrap.cjs';
// ShortMax（shorttv.live）适配器单测（v1.6.9）：加载真实 content.js（先 eval site-registry）。
//
// 本站两个要害：
//  1) **首页板块 hydrate 后是按视口裁剪的轮播**——799px 视口下 Most Popular 只剩 5 张卡，
//     而服务端 HTML 里恒为 8 张。适配器因此走「同源重取 HTML + DOMParser」而不是实时 DOM，
//     S 组在实时 document 里埋一份**只有 2 张卡**的陷阱，断言取到的是重取那份的全部 8 张。
//  2) 列表**无简介、无 genres**，两者只有 /drama/ 详情页有 → 详情失败一律**跳过该卡**
//     （理由同 AppleTV：存量回填只补 genres 不补简介，存下无简介的卡就永远自愈不了）。
//
// /fandom 沿用既有 fandom 范式：临时键 smf-+slug → 文章页找回主站 /episode/<slug>-<id>-1
// → 改写成 sm+id 与首页条目全局去重；映射不到的不入库、下轮重试。
//
// 用法：node tests/unit-shortmax-home.mjs
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
const ORIGIN = 'https://www.shorttv.live';
const CDN = 'https://akamai-static.shorttv.live/images/cover/2026/08/21';
const SUFFIX = '?process=mediagate&x-oss-process=m_fill,w_293,h_390';
const DETAIL_SUFFIX = '?process=mediagate&x-oss-process=m_fill,w_390,h_520';

// 真实卡片：封面链接指向 /episode/<slug>-<id>-1，标题链接指向 /drama/<slug>-<id>；
// img 的 data-src 是无参原图、src 带站内缩放参数
const dramaCard = ({ id, title, slug, cover = `${CDN}/${id}.jpg`, episode = true } = {}) => el('div', { class: 'drama-card' }, [
  episode ? el('a', { href: `/episode/${slug}-${id}-1`, class: 'card-image' }, [
    el('img', { alt: title, 'data-src': cover, src: cover + SUFFIX, loading: 'lazy' })
  ]) : el('div', { class: 'card-image' }, [el('img', { alt: title, 'data-src': cover, src: cover + SUFFIX })]),
  el('a', { href: `/drama/${slug}-${id}`, class: 'card-title-layout' }, [el('p', { class: 'card-title' }, [], title)]),
  el('span', {}, [], '')
]);

const homeSection = (title, cards) => el('section', { class: 'section' }, [
  el('div', { class: 'section-header' }, [
    el('h2', { class: 'section-title' }, [], title),
    el('div', { class: 'navigation-buttons' }, [el('button', { class: 'nav-button' }, [], '')])
  ]),
  el('div', { class: 'home-container' }, [el('div', { class: 'drama-cards' }, cards)])
]);

const homeDoc = (sections) => el('html', {}, [el('body', {}, [el('div', { class: 'container' }, sections)])]);

const CARDS = [
  { id: '33511', title: 'My Catfish Victim Is Actually My Bestie’s Brother', slug: 'my-catfish-victim' },
  { id: '33375', title: 'Loved Twice by the Hockey Star', slug: 'loved-twice-by-the-hockey-star' },
  { id: '32161', title: 'TOO LATE TO WIN ME BACK MR. BILLIONAIR', slug: 'too-late-to-win-me-back-mr-billionair' }
];
const defaultHome = () => homeDoc([
  homeSection('Most Popular 🔥', CARDS.map(dramaCard)),
  homeSection('War God ⚔️', [dramaCard({ id: '31462', title: '别的板块', slug: 'other-section' })])
]);

// 详情页：meta 简介 + 移动/桌面两份重复标签 + h1 权威剧名 + preload 竖版封面
const detailDoc = ({ heading = 'Ashes and Thorns', description = 'After their fates are reset, two sisters embark on different journeys.',
  genres = ['Ancient', 'Reversal of Fortune'], poster = `${CDN}/hero.jpg` } = {}) => el('html', {}, [
  el('head', {}, [
    description ? el('meta', { name: 'description', content: description }) : null,
    el('meta', { property: 'og:image', content: 'https://akamai-static.shorttv.live/og/banner-1200x630.jpg' }),
    poster ? el('link', { rel: 'preload', as: 'image', href: poster + DETAIL_SUFFIX, fetchpriority: 'high' }) : null
  ].filter(Boolean)),
  el('body', {}, [
    el('h1', {}, [], heading),
    // 站点把同一批标签在移动端与桌面端各渲染一份 → cleanGenres 必须去重
    el('div', { class: 'tags' }, genres.map(g => el('a', { href: `/genres/${g}-200053`, class: 'tag' }, [], g))),
    el('div', { class: 'tags' }, genres.map(g => el('a', { href: `/genres/${g}-200053`, class: 'tag' }, [], g))),
    el('div', { class: 'description-clamp' }, [], description || '')
  ])
]);

const fandomCard = ({ slug, title, description, tag = 'Drama Synopsis' }) => el('div', { class: 'fandom-card' }, [
  el('div', { class: 'fandom-card-image' }, [
    // 这条指向 /fandom/tags/… 的分类链接必须被排掉，否则临时键会变成 'tags'
    el('a', { href: `/fandom/tags/${tag.toLowerCase().replace(/\s+/g, '-')}?fandomId=45`, class: 'fandom-card-tag' }, [el('p', {}, [], tag)]),
    el('a', { href: `/fandom/${slug}` }, [el('img', { alt: title, src: 'https://shortweb-banner.shorttv.live/x?auth_key=1789649509-0-0-abc&x-oss-process=m_fit,h_448' })])
  ]),
  el('a', { href: `/fandom/${slug}` }, [el('h3', { class: 'fandom-card-title' }, [], title)]),
  el('div', { class: 'fandom-card-content' }, [el('p', { class: 'fandom-card-description' }, [], description)])
]);

const fandomListDoc = (cards) => el('html', {}, [el('body', {}, [el('div', { class: 'fandom-list' }, cards)])]);

// 文章页：回主站的链接是**绝对**地址（真机形态）
const articleDoc = ({ heading = 'SSS-Rank: Full Guide & Streaming Options', episodeUrl = `${ORIGIN}/episode/sss-rank-32605-1` } = {}) =>
  el('html', {}, [el('body', {}, [
    el('h1', {}, [], heading),
    el('nav', {}, [el('a', { href: '/dramas' }, [], 'Dramas'), el('a', { href: '/fandom' }, [], 'Fandom')]),
    el('article', {}, [el('p', {}, [], 'As a popular rise-to-power short drama, this guide covers where to watch.')]),
    episodeUrl ? el('a', { href: episodeUrl, class: 'watch-now' }, [], 'Watch Now') : null
  ].filter(Boolean))]);

const HOME = `${ORIGIN}/?list=most_popular`;
const FANDOM = `${ORIGIN}/fandom`;
const SUB_HOME = { urlPattern: HOME, tags: ['ShortMax', 'Pop'] };
const SUB_FANDOM = { urlPattern: FANDOM, tags: ['ShortMax', 'fandom'] };
const loc = href => { const u = new URL(href); return { href, hostname: u.hostname, pathname: u.pathname, search: u.search, origin: u.origin }; };

/**
 * fetch 返回的「html」就是被请求的 URL 本身，DOMParser 再按这个 URL 查表拿预建的元素树。
 * 这样既不用写 HTML 解析器，又能顺带断言「请求了哪些地址、请求了几次」。
 */
async function runScenario({ href = HOME, subscriptions = [SUB_HOME, SUB_FANDOM], docs = {}, liveDocument, dramas = [], failUrls = [] } = {}) {
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
  globalThis.document = liveDocument || documentFrom(el('html'));
  globalThis.DOMParser = class {
    parseFromString(html) {
      const tree = docs[html];
      return documentFrom(tree || el('html'));
    }
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

const detailUrlOf = ({ slug, id }) => `${ORIGIN}/drama/${slug}-${id}`;
const homeDocs = (overrides = {}) => ({
  [HOME]: defaultHome(),
  ...Object.fromEntries(CARDS.map(c => [detailUrlOf(c), detailDoc({ heading: c.title, description: `Synopsis of ${c.title}.` })])),
  ...overrides
});

// ---------- S 数据源：重取 HTML，不读被视口裁剪的实时 DOM ----------
{
  // 实时 document 里只放 2 张卡（模拟窄视口裁剪），重取的那份有 3 张
  const trap = documentFrom(homeDoc([homeSection('Most Popular 🔥', CARDS.slice(0, 2).map(dramaCard))]));
  const { saved, fetchCalls } = await runScenario({ docs: homeDocs(), liveDocument: trap });
  check('S1 取的是重取 HTML 里的全部条目，不是实时 DOM 里被裁剪的那几张',
    eq(saved.map(d => d.itemId), ['sm33511', 'sm33375', 'sm32161']), show(saved.map(d => d.itemId)));
  check('S2 首次请求就是当前页地址（同源，不经后台代理）', fetchCalls[0] === HOME, show(fetchCalls[0]));
}
{
  const { saved, response } = await runScenario({ docs: {}, failUrls: [HOME] });
  check('S3 重取失败 → 零入库且不报错', response?.success === true && saved.length === 0, show(saved.length));
}

// ---------- F 首页字段映射 ----------
{
  const { saved, fetchCalls } = await runScenario({ docs: homeDocs() });
  const d = saved[0] || {};
  check('F1 itemId=sm+数字 id，id 形态 shortmax_<itemId>_<index>',
    d.itemId === 'sm33511' && d.id === 'shortmax_sm33511_0', show([d.itemId, d.id]));
  check('F2 标题取 .card-title', d.title === CARDS[0].title, show(d.title));
  check('F3 封面取 data-src 原图基址 + 站内缩放后缀',
    d.poster === `${CDN}/33511.jpg${SUFFIX}`, show(d.poster));
  check('F4 url 存第一集播放页（/episode/…-1，绝对地址）',
    d.url === `${ORIGIN}/episode/my-catfish-victim-33511-1`, show(d.url));
  check('F5 简介来自详情页 meta[name=description]', d.description === `Synopsis of ${CARDS[0].title}.`, show(d.description));
  check('F6 genres 来自详情页 .tags a.tag 且去重（站点移动/桌面各渲染一份）',
    eq(d.genres, ['Ancient', 'Reversal of Fortune']), show(d.genres));
  check('F7 source/status/译文占位/标签/归属 canonical',
    d.source === 'shortmax' && d.status === 'new' && d.titleZh === '' && d.descriptionZh === ''
    && eq(d.tags, ['ShortMax', 'Pop']) && d.sourceListUrl === HOME,
    show([d.source, d.status, d.tags, d.sourceListUrl]));
  check('F8 scrapedAt 合法、translatedAt 为 null',
    Number.isFinite(Date.parse(d.scrapedAt)) && d.translatedAt === null, show([d.scrapedAt, d.translatedAt]));
  check('F9 详情地址由播放页地址推得（/episode/→/drama/ 且去掉尾部集号）',
    fetchCalls.includes(`${ORIGIN}/drama/my-catfish-victim-33511`), show(fetchCalls));
  check('F10 共 1 次列表 + 每卡 1 次详情', fetchCalls.length === 1 + CARDS.length, show(fetchCalls.length));
}
{
  // 首页已有标题时不被详情页 h1 顶掉（两者本应一致，但列表才是板块的权威文案）
  const docs = homeDocs({ [detailUrlOf(CARDS[0])]: detailDoc({ heading: '详情页的另一个写法', description: 'desc' }) });
  const { saved } = await runScenario({ docs });
  check('F11 首页条目不拿详情页 h1 覆盖列表标题', saved[0]?.title === CARDS[0].title, show(saved[0]?.title));
}
{
  // 列表缺封面时用详情页 preload，并归一成站内缩放形态（详情页给的是 390×520）
  const noCover = homeDoc([homeSection('Most Popular 🔥', [
    el('div', { class: 'drama-card' }, [
      el('a', { href: '/episode/no-cover-40001-1', class: 'card-image' }, []),
      el('a', { href: '/drama/no-cover-40001', class: 'card-title-layout' }, [el('p', { class: 'card-title' }, [], '没有封面')])
    ])
  ])]);
  const { saved } = await runScenario({
    docs: { [HOME]: noCover, [`${ORIGIN}/drama/no-cover-40001`]: detailDoc({ poster: `${CDN}/fallback.jpg` }) }
  });
  check('F12 列表缺封面 → 用详情页 preload 并归一成站内缩放形态',
    saved[0]?.poster === `${CDN}/fallback.jpg${SUFFIX}`, show(saved[0]?.poster));
}

// ---------- D 详情失败一律跳过该卡 ----------
{
  const { saved, response } = await runScenario({ docs: homeDocs(), failUrls: [detailUrlOf(CARDS[1])] });
  check('D1 详情 HTTP 失败 → 跳过该卡、其余照常',
    response?.success === true && eq(saved.map(d => d.itemId), ['sm33511', 'sm32161']), show(saved.map(d => d.itemId)));
}
{
  const docs = homeDocs({ [detailUrlOf(CARDS[1])]: detailDoc({ description: '' }) });
  const { saved } = await runScenario({ docs });
  check('D2 详情页无 meta 简介 → 跳过该卡（不留无简介的残卡）',
    eq(saved.map(d => d.itemId), ['sm33511', 'sm32161']), show(saved.map(d => d.itemId)));
}
{
  // 列表项没有 /episode/ 链接 → url 为空 → 推不出详情地址 → 跳过
  const noEpisode = homeDoc([homeSection('Most Popular 🔥', [dramaCard({ ...CARDS[0], episode: false })])]);
  const { saved } = await runScenario({ docs: { [HOME]: noEpisode } });
  check('D3 拿不到播放页地址 → 推不出详情页 → 跳过该卡', saved.length === 0, show(saved.length));
}

// ---------- I id 守卫与板块选择 ----------
{
  const odd = homeDoc([homeSection('Most Popular 🔥', [
    el('div', { class: 'drama-card' }, [el('a', { href: '/drama/no-number', class: 'card-title-layout' }, [el('p', { class: 'card-title' }, [], '无数字尾段')])]),
    el('div', { class: 'drama-card' }, [el('a', { href: '/drama/short-12', class: 'card-title-layout' }, [el('p', { class: 'card-title' }, [], 'id 太短')])]),
    dramaCard(CARDS[0])
  ])]);
  const { saved } = await runScenario({ docs: { [HOME]: odd, [detailUrlOf(CARDS[0])]: detailDoc({ description: 'ok' }) } });
  check('I1 只有 3 位以上数字尾段入库，前缀 sm', eq(saved.map(d => d.itemId), ['sm33511']), show(saved.map(d => d.itemId)));
}
{
  const { saved } = await runScenario({
    href: `${ORIGIN}/?list=war_god`,
    subscriptions: [{ urlPattern: `${ORIGIN}/?list=war_god`, tags: ['ShortMax', 'WarGod'] }],
    docs: { [`${ORIGIN}/?list=war_god`]: defaultHome(), [`${ORIGIN}/drama/other-section-31462`]: detailDoc({ description: 'war' }) }
  });
  check('L1 ?list= 按板块标题归一化匹配（emoji 整段折掉，日后加板块零代码）',
    eq(saved.map(d => d.itemId), ['sm31462']), show(saved.map(d => d.itemId)));
}
{
  const { saved } = await runScenario({
    href: `${ORIGIN}/`,
    subscriptions: [{ urlPattern: `${ORIGIN}/`, tags: ['ShortMax', 'Pop'] }],
    docs: { [`${ORIGIN}/`]: defaultHome(), ...Object.fromEntries(CARDS.map(c => [detailUrlOf(c), detailDoc({ description: 'd' })])) }
  });
  check('L2 无 ?list= 时默认 most_popular', eq(saved.map(d => d.itemId), ['sm33511', 'sm33375', 'sm32161']), show(saved.map(d => d.itemId)));
}
{
  const { saved, response } = await runScenario({ docs: { [HOME]: homeDoc([homeSection('Dragon Clan', CARDS.map(dramaCard))]) } });
  check('L3 板块找不到 → 零入库且不报错', response?.success === true && saved.length === 0, show(saved.length));
}

// ---------- K /fandom：映射回主站去重 ----------
const FANDOM_SLUG = 'sss-rank-full-guide-628';
const fandomDocs = (overrides = {}) => ({
  [FANDOM]: fandomListDoc([fandomCard({ slug: FANDOM_SLUG, title: 'SSS-Rank: Full Guide & Streaming Options', description: '文章摘要。' })]),
  [`${ORIGIN}/fandom/${FANDOM_SLUG}`]: articleDoc(),
  [`${ORIGIN}/drama/sss-rank-32605`]: detailDoc({ heading: 'SSS-Rank: The Slum-Born Thunder God', description: 'Nate Ryder lives at the bottom of society.', genres: ['Rise to Power'], poster: `${CDN}/sss.jpg` }),
  ...overrides
});
{
  const { saved, fetchCalls } = await runScenario({ href: FANDOM, docs: fandomDocs() });
  const d = saved[0] || {};
  check('K1 文章映射回主站后 itemId 改写成 sm+id（临时键 smf- 不入库）',
    d.itemId === 'sm32605', show(saved.map(x => x.itemId)));
  check('K2 url 换成主站第一集播放页', d.url === `${ORIGIN}/episode/sss-rank-32605-1`, show(d.url));
  check('K3 标题以主站 h1 为准（文章标题是 SEO 句式）',
    d.title === 'SSS-Rank: The Slum-Born Thunder God', show(d.title));
  check('K4 简介与 genres 来自主站详情页', d.description === 'Nate Ryder lives at the bottom of society.' && eq(d.genres, ['Rise to Power']),
    show([d.description, d.genres]));
  check('K5 封面用主站竖版图，不用 fandom 卡那张带 auth_key 的横幅',
    d.poster === `${CDN}/sss.jpg${SUFFIX}`, show(d.poster));
  check('K6 标签为 fandom 订阅自己的', eq(d.tags, ['ShortMax', 'fandom']) && d.sourceListUrl === FANDOM, show([d.tags, d.sourceListUrl]));
  check('K7 请求次数＝列表 1 + 文章 1 + 主站详情 1', fetchCalls.length === 3, show(fetchCalls));
}
{
  const { saved, response } = await runScenario({
    href: FANDOM,
    docs: fandomDocs({ [`${ORIGIN}/fandom/${FANDOM_SLUG}`]: articleDoc({ episodeUrl: null }) })
  });
  check('K8 文章无回主站链接 → 不入库（临时键被闸门拦下，下轮重试）',
    response?.success === true && saved.length === 0, show(saved.map(d => d.itemId)));
}
{
  const { saved } = await runScenario({ href: FANDOM, docs: fandomDocs(), failUrls: [`${ORIGIN}/fandom/${FANDOM_SLUG}`] });
  check('K9 文章页取不到 → 不入库（仍是临时键）', saved.length === 0, show(saved.map(d => d.itemId)));
}
{
  const { saved } = await runScenario({ href: FANDOM, docs: fandomDocs(), failUrls: [`${ORIGIN}/drama/sss-rank-32605`] });
  check('K10 映射成功但主站详情失败 → 跳过该卡（不留无简介的残卡）', saved.length === 0, show(saved.map(d => d.itemId)));
}
{
  // fandom 条目的去重只能发生在**保存点**：进 scrapePage 时它还是 smf- 临时键、
  // 与库里的 sm32605 对不上，映射完才撞号 → saveDrama 照发，由后台按 itemId 兜底拒收
  // （与 MyDrama / ReelShort fandom 逐字同一语义）。要守的是「库里仍只有一条、
  // 标签仍是先到先得的那份、原记录一个字节没动」。
  const existing = { itemId: 'sm32605', title: 'SSS-Rank: The Slum-Born Thunder God', source: 'shortmax', tags: ['ShortMax', 'Pop'], genres: ['Rise to Power'], scrapedAt: '2026-09-01T00:00:00.000Z' };
  const { saved, saveCalls } = await runScenario({ href: FANDOM, docs: fandomDocs(), dramas: [existing] });
  check('K11 与首页条目全局去重：库里仍只有一条，标签与原记录先到先得',
    saved.length === 1 && eq(saved[0], existing), show({ n: saved.length, entry: saved[0] }));
  check('K11b 去重发生在保存点：映射后才撞号，saveDrama 照发但被拒收',
    saveCalls.length === 1 && saveCalls[0].itemId === 'sm32605' && eq(saveCalls[0].tags, ['ShortMax', 'fandom']),
    show(saveCalls.map(s => [s.itemId, s.tags])));
}
{
  // 同一卡上另有指向 /fandom/tags/… 的分类链接；取错会让临时键变成 'tags'
  const { fetchCalls } = await runScenario({ href: FANDOM, docs: fandomDocs() });
  check('K12 排掉 /fandom/tags/ 分类链接（取的是文章地址）',
    fetchCalls.includes(`${ORIGIN}/fandom/${FANDOM_SLUG}`) && !fetchCalls.some(u => u.includes('/fandom/tags/')), show(fetchCalls));
}
{
  const two = fandomListDoc([
    fandomCard({ slug: 'a-guide-601', title: 'A', description: 'a' }),
    fandomCard({ slug: 'b-guide-602', title: 'B', description: 'b' })
  ]);
  const article = articleDoc({ episodeUrl: `${ORIGIN}/episode/same-drama-32605-1` });
  const { saved } = await runScenario({
    href: FANDOM,
    docs: {
      [FANDOM]: two,
      [`${ORIGIN}/fandom/a-guide-601`]: article,
      [`${ORIGIN}/fandom/b-guide-602`]: article,
      [`${ORIGIN}/drama/same-drama-32605`]: detailDoc({ heading: 'Same Drama', description: 'one story' })
    }
  });
  check('K13 同批两篇文章指向同一部剧 → 只入库一条', eq(saved.map(d => d.itemId), ['sm32605']), show(saved.map(d => d.itemId)));
}

// ---------- P 路径闸门 ----------
for (const [name, href] of [
  ['P1 剧目详情页不抓', `${ORIGIN}/drama/ashes-and-thorns-30991`],
  ['P2 fandom 文章页不抓（只认 /fandom 本身）', `${ORIGIN}/fandom/sss-rank-full-guide-628`],
  ['P3 播放页不抓', `${ORIGIN}/episode/sss-rank-32605-1`],
  ['P4 类型页不抓', `${ORIGIN}/genres/ancient-200053`]
]) {
  const { saved, fetchCalls } = await runScenario({
    href,
    subscriptions: [{ urlPattern: href, tags: ['ShortMax', 'X'] }],
    docs: { [href]: defaultHome() }
  });
  check(`${name} → 零入库零请求`, saved.length === 0 && fetchCalls.length === 0, show({ saved: saved.length, fetchCalls }));
}
{
  // 首页订阅是 /fandom 订阅的前缀：精确等值轮必须先命中各自那条
  const { saved } = await runScenario({ href: FANDOM, docs: fandomDocs() });
  check('P5 /fandom 命中自己的订阅而不是首页订阅（首页 URL 是它的前缀）',
    eq(saved[0]?.tags, ['ShortMax', 'fandom']), show(saved[0]?.tags));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
