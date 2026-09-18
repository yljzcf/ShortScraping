import './bootstrap.cjs';
// DramaBox 板块列表页适配器单测（v1.6.11）：零网络加载真实 content.js（先 eval site-registry）。
//
// 本站的要害有三条，各对应一组断言：
// 1. **一个适配器覆盖两个域名，但两站路由名不同**——dramabox.com 是 /more/<position>，
//    dramaboxdb.com 是 /channel/<position>，交叉使用站点自己就 404。两站是同一套 Next.js
//    代码的两次构建，故 pageProps 里用的是**同一个 moreData 键**（N 组 + G 组路径闸门）。
// 2. **取数点在 DOM 的 script#__NEXT_DATA__**，hydrate 后仍在——所以既不需要同源重取
//    （GoodShort/ShortMax 那条路）也不需要详情请求（列表 introduction 与详情页逐字相同）。
//    N1 直接断言**全程零 fetch、零后台代理**，这是「零详情请求」唯一的回归护栏。
// 3. **url 恒指向 dramabox.com，即使条目是从 dramaboxdb 抓到的**（2026-09-18 用户定
//    「优先 dramabox.com」，实测 28/28 dramaboxdb 独有作品在 dramabox.com 上都可达）。
//    U2 是本套最易回归的一条。
//
// 另覆盖：字段映射（标题 trim、genres 两源合并去重、刻意不采 typeOneName）、bookId 守卫、
// 坏数据面、跨域名全局去重、四条订阅精确等值。
// 用法：node tests/unit-dramabox-sections.mjs
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

// ---------- fixture：真实条目形状（字段与键序取自 /more/must-sees 实测载荷） ----------
const COVER_BASE = 'https://thwztchapter.dramaboxdb.com/data/cppartner/4x2/42x0/420x0/42000024547/42000024547.jpg';
const THUMB = '@w=240&h=400';

const item = ({
  id = '42000024547',
  name = 'My Billionaire Patient Is My Baby Daddy',
  intro = 'Ella is tricked by her divorce-seeking husband into sleeping with a stranger.',
  cover = COVER_BASE + THUMB,
  slug = 'My-Billionaire-Patient-Is-My-Baby-Daddy',
  tags = ['Billionaire', 'Hidden Identity'],
  typeTwoNames = ['Romance'],
  typeOneName = 'F-Drama',
  extra = {}
} = {}) => ({
  name, actionType: 'BOOK', action: id, ratings: 8.4,
  bookId: id, originalBookId: id, bookName: name, author: 'Webfic',
  introduction: intro, cover,
  tags, labels: tags, viewCount: 15897,
  typeOneNames: [typeOneName], typeTwoNames,
  typeTwoList: typeTwoNames.map((n, i) => ({ id: 161 + i, oneTypeId: 23, name: n, replaceName: n.toLowerCase() })),
  top: 0, replacedBookName: slug, typeOneName, typeTwoName: typeTwoNames[0],
  firstChapterId: 701484819, chapterCount: 45,
  bookNameEn: slug, bookNameLower: slug.toLowerCase(),
  viewCountDisplay: '15.9K', lastUpdateTimeDisplay: 'Completed',
  ...extra
});

// 真实根形状：板块名回的是**中文**（必看好剧/当前热播，页面靠 i18n 映射成 Must-sees/Trending），
// 但每个板块各是独立 URL，适配器压根不读板块名——所以这里给中文名正是保真。
const nextDataOf = (items, { page = '/more/[position]', position = 'must-sees', positionName = '必看好剧', pages = 5 } = {}) => ({
  props: {
    pageProps: {
      moreData: { id: 1264, name: positionName, style: 'SMALL_CARD_LIST', items, more: false },
      pageNo: 1, positionName, pages, locale: 'en',
      _nextI18Next: { initialLocale: 'en', ns: ['common'] }
    }
  },
  page, query: { position }, buildId: 'dramabox_prod_20260908',
  isFallback: false, locale: 'en', locales: ['en', 'zhHans'], defaultLocale: 'en'
});

// 假 document：只实现 readNextData 真正用到的那一个选择器。**刻意不做通配**——
// 选择器写错时必须 RED，不能悄悄退化成「什么都匹配得到所以通过」（同 dom-fixture.mjs 的取舍）
const documentWithNextData = (text) => ({
  getElementById() { return null; },
  createElement() { return fakeElement(); },
  querySelector(sel) {
    if (sel === 'script#__NEXT_DATA__') return text === null ? null : { textContent: text };
    return null;
  },
  querySelectorAll() { return []; },
  body: { appendChild() {} }
});

const MS = 'https://www.dramabox.com/more/must-sees';
const TR = 'https://www.dramabox.com/more/trending';
const DB_MS = 'https://www.dramaboxdb.com/channel/must-sees';
const DB_TR = 'https://www.dramaboxdb.com/channel/trending';
const SUBS = [
  { urlPattern: MS, tags: ['DramaBox', 'MustSee'] },
  { urlPattern: TR, tags: ['DramaBox', 'Trending'] },
  { urlPattern: DB_MS, tags: ['DramaBox', 'MustSee'] },
  { urlPattern: DB_TR, tags: ['DramaBox', 'Trending'] }
];
const loc = href => { const u = new URL(href); return { href, hostname: u.hostname, pathname: u.pathname, search: u.search, origin: u.origin }; };

async function runScenario({ href = MS, subscriptions = SUBS, nextData, document, dramas = [] } = {}) {
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
  globalThis.document = document || documentWithNextData(
    nextData === undefined ? JSON.stringify(nextDataOf([item({})])) : nextData);
  globalThis.DOMParser = class { parseFromString() { return documentWithNextData(null); } };
  globalThis.fetch = async (url) => { fetchCalls.push(url); return { ok: true, status: 200, url, text: async () => '' }; };

  (0, eval)(contentSrc);
  const response = await new Promise(resolve => {
    for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
  });
  return { saved: store.dramas, saveCalls, proxyCalls, fetchCalls, response };
}

// ---------- N 取数点：DOM 里的 __NEXT_DATA__，全程零网络 ----------
{
  const { saved, response, fetchCalls, proxyCalls } = await runScenario({});
  check('N1 从 DOM 的 script#__NEXT_DATA__ 取数并入库',
    response?.success === true && eq(saved.map(d => d.itemId), ['db42000024547']), show(saved.map(d => d.itemId)));
  check('N1b 全程零 fetch、零后台代理（不需同源重取，也不需详情请求）',
    fetchCalls.length === 0 && proxyCalls.length === 0, show({ fetchCalls, proxyCalls }));
}
{
  // dramaboxdb 的 /channel/ 页用的是同一个 moreData 键（同一套代码的两次构建）
  const { saved, fetchCalls } = await runScenario({
    href: DB_MS,
    nextData: JSON.stringify(nextDataOf([item({ id: '42000021919', name: 'Shifter Academy', slug: 'Shifter-Academy' })],
      { page: '/channel/[position]', position: 'must-sees', pages: 6 }))
  });
  check('N2 dramaboxdb 的 /channel/ 页同一个 moreData 键，同样零网络',
    eq(saved.map(d => d.itemId), ['db42000021919']) && fetchCalls.length === 0, show(saved.map(d => d.itemId)));
}
for (const [name, nextData] of [
  ['N3 script#__NEXT_DATA__ 不存在', null],
  ['N4 载荷是坏 JSON', '{"props":{'],
  ['N5 moreData 缺失', JSON.stringify({ props: { pageProps: { pageNo: 1 } } })],
  ['N6 moreData.items 非数组', JSON.stringify({ props: { pageProps: { moreData: { items: 'nope' } } } })],
  ['N7 pageProps 整个缺失', JSON.stringify({ props: {} })]
]) {
  const { saved, response, saveCalls } = await runScenario({ nextData });
  check(`${name} → 零入库且不报错`,
    response?.success === true && saved.length === 0 && saveCalls.length === 0,
    show({ response, saved: saved.length, saveCalls: saveCalls.length }));
}
{
  const { saved } = await runScenario({
    nextData: JSON.stringify(nextDataOf([null, 'x', 42, item({})]))
  });
  check('N8 items 里的非对象元素被过滤，正常条目照常入库',
    eq(saved.map(d => d.itemId), ['db42000024547']), show(saved.map(d => d.itemId)));
}

// ---------- F 字段映射 ----------
{
  // 站点数据真有这两种脏值：标题带首尾空格（实测 72 条里 4 条）、标签带前导空格（' Thrilling Combat'）
  const { saved } = await runScenario({
    nextData: JSON.stringify(nextDataOf([item({
      name: 'Shifter Academy: Taming Three Wild Mates ',
      tags: ['Fantasy', ' Thrilling Combat', 'Revenge'],
      typeTwoNames: ['Fantasy', 'Revenge']
    })]))
  });
  const card = saved[0];
  check('F1 标题 trim 掉首尾空格', card?.title === 'Shifter Academy: Taming Three Wild Mates', show(card?.title));
  check('F2 genres 合并 typeTwoNames + tags 并去重、trim（保持出现顺序）',
    eq(card?.genres, ['Fantasy', 'Revenge', 'Thrilling Combat']), show(card?.genres));
  check('F3 genres 不含 typeOneName（F-Drama 是受众划分不是内容类型）',
    !card?.genres.includes('F-Drama'), show(card?.genres));
}
{
  const intro = 'Molly’s sister swiped her boyfriend—and her inheritance. ';
  const { saved } = await runScenario({ nextData: JSON.stringify(nextDataOf([item({ intro })])) });
  const card = saved[0];
  check('F4 简介取列表 introduction 并 trim（与详情页逐字相同，不再请求详情）',
    card?.description === intro.trim(), show(card?.description));
  check('F5 封面原样存站点给的缩略图形态（@w=240&h=400；推送侧才剥参数取原图）',
    card?.poster === COVER_BASE + THUMB, show(card?.poster));
  check('F6 source/status/译文位与站点无平台中文的约定一致',
    card?.source === 'dramabox' && card?.status === 'new' && card?.titleZh === '' && card?.descriptionZh === '' &&
    card?.translatedAt === null,
    show({ source: card?.source, status: card?.status, titleZh: card?.titleZh, translatedAt: card?.translatedAt }));
  check('F7 不采 viewCount / chapterCount / ratings / typeOneName（对齐 Netflix 名次不入库的裁定）',
    !('viewCount' in card) && !('chapterCount' in card) && !('ratings' in card) && !('typeOneName' in card) &&
    !('company' in card),
    show(Object.keys(card || {})));
  check('F8 sourceListUrl 记的是板块页地址（首轮基线与订阅归属都靠它）',
    card?.sourceListUrl === MS, show(card?.sourceListUrl));
}
{
  const { saved } = await runScenario({
    nextData: JSON.stringify(nextDataOf([item({ tags: [], typeTwoNames: [] })]))
  });
  check('F9 两个标签源都空 → genres 为空数组（不塞 typeOneName 兜底）',
    eq(saved[0]?.genres, []), show(saved[0]?.genres));
}

// ---------- U 作品地址：恒指向 dramabox.com ----------
{
  const { saved } = await runScenario({});
  check('U1 url = www.dramabox.com/drama/<bookId>/<slug>',
    saved[0]?.url === 'https://www.dramabox.com/drama/42000024547/My-Billionaire-Patient-Is-My-Baby-Daddy',
    show(saved[0]?.url));
}
{
  // 本套最易回归的一条：从 dramaboxdb 抓到的条目，url 仍须是 dramabox.com 的 /drama/ 形态
  // （dramaboxdb 自己用的是 /movie/，交叉使用 404；实测 28/28 独有作品在 dramabox.com 上可达）
  const { saved } = await runScenario({
    href: DB_TR,
    nextData: JSON.stringify(nextDataOf([item({ id: '42000015757', name: 'Only From dramaboxdb', slug: 'Only-From-dramaboxdb' })],
      { page: '/channel/[position]', position: 'trending', positionName: '当前热播', pages: 4 }))
  });
  check('U2 从 dramaboxdb 抓到的条目 url 仍指向 dramabox.com（不是 dramaboxdb 的 /movie/）',
    saved[0]?.url === 'https://www.dramabox.com/drama/42000015757/Only-From-dramaboxdb',
    show(saved[0]?.url));
}
{
  // 站点自己的 href 就是 %EF%BC%9A 形态（全角冒号），不编码会得到一个非法地址
  const { saved } = await runScenario({
    nextData: JSON.stringify(nextDataOf([item({ id: '42000018529', name: 'Tempest：The Last Mecha', slug: 'Tempest：The-Last-Mecha' })]))
  });
  check('U3 slug 里的全角冒号编码成 %EF%BC%9A',
    saved[0]?.url === 'https://www.dramabox.com/drama/42000018529/Tempest%EF%BC%9AThe-Last-Mecha',
    show(saved[0]?.url));
}
{
  const { saved } = await runScenario({
    nextData: JSON.stringify(nextDataOf([item({ extra: { replacedBookName: '' } })]))
  });
  check('U4 slug 缺失 → 退裸 bookId 形态（站点 301 到规范地址）',
    saved[0]?.url === 'https://www.dramabox.com/drama/42000024547', show(saved[0]?.url));
}

// ---------- I bookId 守卫 ----------
{
  const bad = [
    ['非数字', 'abc42000024547'],
    ['位数不足', '12345678'],
    ['空串', ''],
    ['带空格的脏值', '4200002 4547']
  ];
  const outcomes = [];
  for (const [label, id] of bad) {
    const { saved, saveCalls } = await runScenario({
      nextData: JSON.stringify(nextDataOf([item({ extra: { bookId: id } })]))
    });
    outcomes.push([label, saved.length, saveCalls.length]);
  }
  check('I1 bookId 形状不合 → 整条跳过、零 saveDrama',
    outcomes.every(([, saved, calls]) => saved === 0 && calls === 0), show(outcomes));
}
{
  const { saved } = await runScenario({
    nextData: JSON.stringify(nextDataOf([item({ extra: { bookId: '410001057640' } })]))
  });
  check('I2 12 位 bookId 也放行（守卫是 9~13 位，不写死 11）',
    eq(saved.map(d => d.itemId), ['db410001057640']), show(saved.map(d => d.itemId)));
}

// ---------- D 跨域名全局去重 ----------
{
  // 两站板块重叠 10 处（实测）：同一 bookId 先被 dramabox 抓到，再从 dramaboxdb 抓到时
  // 只能命中去重、不得再存一张卡，也不得改标签（先到先得）
  const existing = {
    itemId: 'db42000021919', source: 'dramabox', title: 'Shifter Academy',
    tags: ['DramaBox', 'Trending'], genres: ['Paranormal', 'Romance'],
    url: 'https://www.dramabox.com/drama/42000021919/Shifter-Academy', scrapedAt: '2026-09-18T00:00:00.000Z'
  };
  const { saved, saveCalls, response } = await runScenario({
    href: DB_MS,
    dramas: [existing],
    nextData: JSON.stringify(nextDataOf([item({ id: '42000021919', name: 'Shifter Academy', slug: 'Shifter-Academy', typeTwoNames: ['Paranormal'], tags: ['Romance'] })],
      { page: '/channel/[position]' }))
  });
  check('D1 同一 bookId 跨两站只留一张卡（先到先得，标签不被后抓的订阅改写）',
    saved.length === 1 && eq(saved[0].tags, ['DramaBox', 'Trending']) && eq(response?.data, []),
    show({ n: saved.length, tags: saved[0]?.tags, data: response?.data?.length }));
  check('D1b 已有 genres 的去重命中 → 零 saveDrama（回填闸门）',
    saveCalls.length === 0, show(saveCalls.length));
}
{
  // 去重命中但库里那条还没有 genres → 只补 genres 一个键（列表就是权威源，仍不请求详情）
  const existing = {
    itemId: 'db42000021919', source: 'dramabox', title: 'Shifter Academy', tags: ['DramaBox', 'Trending'],
    genres: [], url: 'https://www.dramabox.com/drama/42000021919/Shifter-Academy', scrapedAt: '2026-09-18T00:00:00.000Z'
  };
  const { saveCalls, fetchCalls, proxyCalls } = await runScenario({
    href: DB_MS,
    dramas: [existing],
    nextData: JSON.stringify(nextDataOf([item({ id: '42000021919', typeTwoNames: ['Paranormal'], tags: ['Romance'] })],
      { page: '/channel/[position]' }))
  });
  check('D2 存量无 genres → 从列表补一份，且仍零网络（不是 genresFromDetail）',
    saveCalls.length === 1 && eq(saveCalls[0]?.genres, ['Paranormal', 'Romance']) &&
    fetchCalls.length === 0 && proxyCalls.length === 0,
    show({ genres: saveCalls[0]?.genres, fetchCalls, proxyCalls }));
}

// ---------- G 订阅与路径闸门 ----------
{
  const { saved } = await runScenario({ href: DB_TR, nextData: JSON.stringify(nextDataOf([item({})], { page: '/channel/[position]' })) });
  check('G1 四条订阅精确等值：dramaboxdb 的 trending 拿到自己的标签',
    eq(saved[0]?.tags, ['DramaBox', 'Trending']) && saved[0]?.sourceListUrl === DB_TR,
    show([saved[0]?.tags, saved[0]?.sourceListUrl]));
}
{
  const { saved, fetchCalls } = await runScenario({
    href: MS, subscriptions: [{ urlPattern: TR, tags: ['DramaBox', 'Trending'] }]
  });
  check('G2 未订阅的板块页不抓（订阅轮在适配器之前）',
    saved.length === 0 && fetchCalls.length === 0, show({ saved: saved.length, fetchCalls }));
}
{
  // 交叉路由（/channel/ @ dramabox.com、/more/ @ dramaboxdb.com）站点自己就是 404，适配器同样不认
  const matches = [
    ['https://www.dramabox.com/more/must-sees', true],
    ['https://www.dramabox.com/more/trending/', true],
    ['https://dramabox.com/more/must-sees', true],
    ['https://www.dramaboxdb.com/channel/must-sees', true],
    ['https://www.dramaboxdb.com/channel/hidden-gems', true],   // 未订阅的板块也认路由，加板块＝只改规则目录
    ['https://www.dramabox.com/channel/must-sees', false],      // 交叉路由：站点 404
    ['https://www.dramaboxdb.com/more/must-sees', false],       // 交叉路由：站点 404
    ['https://www.dramabox.com/', false],
    ['https://www.dramabox.com/more/', false],
    ['https://www.dramabox.com/more/a/b', false],
    ['https://www.dramabox.com/drama/42000024547/X', false],
    ['https://www.dramaboxdb.com/movie/42000021919/x', false]
  ];
  const outcomes = [];
  for (const [url, expected] of matches) {
    const { saved } = await runScenario({
      href: url,
      subscriptions: [{ urlPattern: url, tags: ['DramaBox', 'X'] }],
      nextData: JSON.stringify(nextDataOf([item({})], { page: '/more/[position]' }))
    });
    outcomes.push([url, saved.length > 0, expected]);
  }
  check('G3 路径闸门逐条：dramabox 只认 /more/<单段>、dramaboxdb 只认 /channel/<单段>',
    outcomes.every(([, got, expected]) => got === expected), show(outcomes.filter(([, g, e]) => g !== e)));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
