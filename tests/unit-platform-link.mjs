import './bootstrap.cjs';
// IMDb 条目「搜平台」（v1.7.3）的纯逻辑：平台反查 / 搜索页地址 / 地址校验（site-registry.js）、
// 片名比对与唯一同名判定、各站解析器（platform-link.js）、封面菜单项（timeline-render.js）、
// 飞书卡片「搜 X」按钮与拒收重发（lark.js）。后台的查找 / 开页 / 推送接线见 unit-platform-open.mjs。
// 用法：node tests/unit-platform-link.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SiteRegistry = require(path.join(root, 'src/shared/site-registry.js'));
const PlatformLink = require(path.join(root, 'src/shared/platform-link.js'));
const Lark = require(path.join(root, 'src/shared/lark.js'));
(0, eval)(fs.readFileSync(path.join(root, 'src/shared/timeline-render.js'), 'utf8'));
const TimelineRender = globalThis.TimelineRender;

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const imdb = (company, extra = {}) => ({
  id: `imdb_tt1_${company}`, itemId: 'tt1', source: 'imdb', title: 'Silicon God Strikes Back',
  url: 'https://www.imdb.com/title/tt1/', tags: ['IMDB', 'X'],
  sourceListUrl: `https://www.imdb.com/search/title/?companies=${company}`, ...extra
});

// ---------- R 平台反查 / 搜索页 / 地址校验 ----------
{
  const expected = {
    co1116954: 'mydrama', co1016895: 'reelshort', co1116348: 'dramashorts', co1104898: 'netshort',
    co1149472: 'flickreels', co1045147: 'goodshort', co1167893: 'shortical', co1065580: 'shortmax', co1028734: 'dramabox'
  };
  const got = Object.fromEntries(Object.keys(expected).map(co => [co, SiteRegistry.imdbPlatformOf(imdb(co))]));
  check('R1 九个平台榜的出品公司都反查到对应站点', same(got, expected), JSON.stringify(got));
  check('R1b 反查到的站点都在站点全集里', Object.values(expected).every(site => SiteRegistry.CATEGORY_SOURCES.includes(site)));
  check('R2 DramaWave（只有 App）不反查', SiteRegistry.imdbPlatformOf(imdb('co1124838')) === null);
  check('R3 micro-drama 等非平台榜、类型榜不反查',
    SiteRegistry.imdbPlatformOf(imdb('x', { sourceListUrl: 'https://www.imdb.com/search/title/?interests=in0000310' })) === null
    && SiteRegistry.imdbPlatformOf(imdb('x', { sourceListUrl: 'https://www.imdb.com/search/title/?genres=Drama' })) === null);
  check('R4 非 IMDb 条目 / 缺 sourceListUrl / 非法地址一律 null',
    SiteRegistry.imdbPlatformOf(imdb('co1016895', { source: 'reelshort' })) === null
    && SiteRegistry.imdbPlatformOf(imdb('co1016895', { sourceListUrl: undefined })) === null
    && SiteRegistry.imdbPlatformOf(imdb('co1016895', { sourceListUrl: 'not a url' })) === null
    && SiteRegistry.imdbPlatformOf(null) === null);
  check('R5 companies 多值取第一个认得的；原型链键不当平台',
    SiteRegistry.imdbPlatformOf(imdb('co9999999,co1028734')) === 'dramabox'
    && SiteRegistry.imdbPlatformOf(imdb('constructor')) === null
    && SiteRegistry.imdbPlatformOf(imdb('__proto__')) === null);
  check('R5b 旧式带日期的订阅地址同样认（参数顺序无关）',
    SiteRegistry.imdbPlatformOf(imdb('x', { sourceListUrl: 'https://www.imdb.com/search/title/?release_date=2026-01-01,&companies=co1016895' })) === 'reelshort');

  check('R6 搜索页：各站地址形态与编码（& ? # 撇号 / 非 ASCII）',
    SiteRegistry.platformSearchUrl('reelshort', "Love & War? #1 Don't") === 'https://www.reelshort.com/search?keywords=Love%20%26%20War%3F%20%231%20Don\'t'
    && SiteRegistry.platformSearchUrl('dramabox', 'Fiancé') === 'https://www.dramabox.com/search?searchValue=Fianc%C3%A9'
    && SiteRegistry.platformSearchUrl('goodshort', 'A/B') === 'https://www.goodshort.com/results?q=A%2FB'
    && SiteRegistry.platformSearchUrl('dramashorts', 'x y') === 'https://dramashorts.io/search?q=x%20y'
    && SiteRegistry.platformSearchUrl('flickreels', 'x y') === 'https://www.flickreels.net/search?drama=x%20y'
    && SiteRegistry.platformSearchUrl('shortmax', 'Big Shot/2') === 'https://www.shorttv.live/search/Big%20Shot%2F2',
    SiteRegistry.platformSearchUrl('reelshort', "Love & War? #1 Don't"));
  check('R7 网页端没有搜索页的平台与空片名给 null',
    ['mydrama', 'shortical', 'netshort', 'imdb', 'constructor'].every(site => SiteRegistry.platformSearchUrl(site, 'x') === null)
    && SiteRegistry.platformSearchUrl('reelshort', '   ') === null);
  check('R8 搜索词去掉末尾括号注释（全角 / 方括号同样），去完为空用原片名',
    SiteRegistry.platformSearchQuery('A Marriage on Fire (Un Matrimonio al Rojo Vivo)') === 'A Marriage on Fire'
    && SiteRegistry.platformSearchQuery('标题（配音版）') === '标题'
    && SiteRegistry.platformSearchQuery('Gilded Cage [Dubbed]') === 'Gilded Cage'
    && SiteRegistry.platformSearchQuery('(Untitled)') === '(Untitled)'
    && SiteRegistry.platformSearchQuery('Love (2024) Returns') === 'Love (2024) Returns');

  const valid = (site, url) => SiteRegistry.isPlatformUrl(site, url);
  check('R9 地址校验：本站 https 页面（www / 裸域 / DramaBox 两个域名）',
    valid('reelshort', 'https://www.reelshort.com/episodes/x') && valid('reelshort', 'https://reelshort.com/x')
    && valid('dramabox', 'https://www.dramabox.com/drama/1') && valid('dramabox', 'https://www.dramaboxdb.com/drama/1')
    && valid('shortmax', 'https://www.shorttv.live/episode/x-1-1') && valid('mydrama', 'https://my-drama.com/video/x'));
  check('R10 地址校验：http、串站、后缀伪装、javascript:、非法值一律拒',
    !valid('reelshort', 'http://www.reelshort.com/x') && !valid('reelshort', 'https://www.dramabox.com/x')
    && !valid('reelshort', 'https://evilreelshort.com/x') && !valid('reelshort', 'https://reelshort.com.evil.com/x')
    && !valid('reelshort', 'javascript:alert(1)') && !valid('reelshort', '') && !valid('reelshort', null)
    && !valid('nosuchsite', 'https://www.reelshort.com/x'));
  check('R11 注入闸门抽出 hostMatches 后行为不变',
    SiteRegistry.isInjectableUrl('https://www.imdb.com/search/title/') && !SiteRegistry.isInjectableUrl('https://notimdb.com/')
    && SiteRegistry.isInjectableUrl('http://my-drama.com/') && !SiteRegistry.isInjectableUrl('ftp://www.imdb.com/'));
}

// ---------- T 片名比对与判定 ----------
{
  const { squashTitle, decide } = PlatformLink;
  const eq = (a, b) => decide(a, [{ key: b, url: 'https://x/1' }]).kind === 'play';
  check('T1 squashTitle：弯直引号 / 标点 / 空格 / 大小写 / 重音一律抹平',
    squashTitle('I Don’t Need No Alpha Brothers') === squashTitle("I Don't Need No Alpha Brothers")
    && squashTitle('Fake Queen Bee, I\'m the true Heiress!') === squashTitle("Fake Queen Bee, I'm the True Heiress!")
    && squashTitle('Fiancé') === 'fiance');
  check('T2 IMDb 片名与站上写法的实测差异都判同名',
    eq('When the Blackout Comes', 'When The Black Out Comes')
    && eq('Dumping My Mr April Fools', 'Dumping My Mr.April Fools')
    && eq("I Don't Need No Alpha Brothers", 'i-don-t-need-no-alpha-brothers')
    && eq('Sexy Professor or Secret Husband?', 'Sexy Professor Or Secret Husband')
    && eq('My Beggar Fiancé', 'my-beggar-fianc%C3%A9'.replace(/%C3%A9/, 'é')));
  check('T3 & 既认 and 也认直接丢掉（片名 vs slug）',
    eq('Torn Between the Boss & the Daddy', 'Torn Between the Boss and the Daddy')
    && eq('Torn Between the Boss & the Daddy', 'torn-between-the-boss-the-daddy'));
  check('T4 片名末尾的括号注释去掉后也比对',
    eq('A Marriage on Fire (Un Matrimonio al Rojo Vivo)', 'A Marriage on Fire'));
  check('T5 真不同名不判同名（多一个词 / 续集号 / 配音版）',
    !eq('Mafia Daddy', 'Mafia Daddy Next Door') && !eq('Take Back My Billionaire', 'Take Back My Billionaire 2')
    && !eq('The Wife Who Changed the Story', 'eng-dub-the-wife-who-changed-the-story'));
  check('T6 中日韩等非拉丁片名比对键为空，永不命中',
    squashTitle('芯片之神') === '' && decide('芯片之神', [{ key: '芯片之神', url: 'https://x/1' }]).kind === 'none');

  const three = [1, 2, 3].map(i => ({ key: 'Brothers in Arms', url: `https://x/${i}` }));
  check('T7 唯一同名 → play（取它的地址）',
    same(decide('Brothers in Arms', [{ key: 'Other', url: 'https://x/0' }, three[1]]), { kind: 'play', url: 'https://x/2' }));
  check('T8 多部同名 → ambiguous（不替用户挑）', same(decide('Brothers in Arms', three), { kind: 'ambiguous', count: 3 }));
  check('T9 没有同名 / 候选为空或非数组 → none',
    decide('X', [{ key: 'Y', url: 'https://x/1' }]).kind === 'none' && decide('X', []).kind === 'none' && decide('X', null).kind === 'none');
  check('T10 唯一同名但拼不出地址 / 地址不过校验 → none（宁可落搜索页）',
    decide('X', [{ key: 'X', url: null }]).kind === 'none'
    && decide('X', [{ key: 'X', url: 'https://evil/1' }], url => url.startsWith('https://ok/')).kind === 'none'
    && decide('X', [{ key: 'X', url: 'https://ok/1' }], url => url.startsWith('https://ok/')).kind === 'play');

  const dramas = [
    { source: 'netshort', title: 'Racing Back to Your Heart', url: 'https://netshort.com/episode/racing-back-to-your-heart-1' },
    { source: 'netshort', title: 'Other', url: 'https://netshort.com/episode/other-2' },
    { source: 'imdb', title: 'Racing Back to Your Heart', url: 'https://www.imdb.com/title/tt9/' },
    { source: 'netshort', title: 'Racing Back to Your Heart', url: 'https://evil.example/x' }
  ];
  const local = PlatformLink.localCandidates('netshort', dramas, url => SiteRegistry.isPlatformUrl('netshort', url));
  check('T11 库内候选只收同平台、地址属于该平台的卡',
    same(local.map(c => c.url), ['https://netshort.com/episode/racing-back-to-your-heart-1', 'https://netshort.com/episode/other-2']),
    JSON.stringify(local));
  check('T12 lookupOf：七家联网（搜索页 / 站点地图），ShortMax / NetShort / 未知平台不联网',
    ['reelshort', 'dramabox', 'goodshort', 'dramashorts', 'flickreels'].every(site => PlatformLink.lookupOf(site)?.kind === 'search')
    && ['mydrama', 'shortical'].every(site => PlatformLink.lookupOf(site)?.kind === 'sitemap')
    && ['shortmax', 'netshort', 'imdb', 'constructor'].every(site => PlatformLink.lookupOf(site) === null));
}

// ---------- P 各站解析器（最小夹具，结构照 2026-09-28 实测页面） ----------
const nextData = props => `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: props } })}</script></body></html>`;
{
  const html = `<a href="/movie/silicon-god-strikes-back-69c0a33b8189b0616e0020e1">x</a>`
    + nextData({ books: [
      { book_id: '69c0a33b8189b0616e0020e1', book_title: 'Silicon God Strikes Back', start_play: { chapter_id: '4s1macr7e0' }, first_chapter_id: 'zzz' },
      { book_id: '6a629f5ea1c787017500913a', book_title: "Keeping the Cowboy's Baby", first_chapter_id: '2ifrck6osb' },
      { book_id: '6a4ff019ce4e4e0aef058c23', book_title: 'No Chapter' },
      { book_id: 'not-hex', book_title: 'Bad Id', first_chapter_id: 'x' }
    ] });
  const got = PlatformLink.parseReelshortSearch(html);
  check('P1 ReelShort：slug 取页内 /movie/ 链接，拼第一集播放页（start_play 优先）',
    got[0].url === 'https://www.reelshort.com/episodes/episode-1-silicon-god-strikes-back-69c0a33b8189b0616e0020e1-4s1macr7e0', got[0].url);
  check('P1b ReelShort：页内没链接时按片名拼 slug；first_chapter_id 兜底',
    got[1].url === 'https://www.reelshort.com/episodes/episode-1-keeping-the-cowboy-s-baby-6a629f5ea1c787017500913a-2ifrck6osb', got[1].url);
  check('P1c ReelShort：没有章节号退剧目页；book_id 非法的候选照样计数但没有地址',
    got[2].url === 'https://www.reelshort.com/movie/no-chapter-6a4ff019ce4e4e0aef058c23' && got[3].key === 'Bad Id' && got[3].url === null,
    JSON.stringify(got.slice(2)));
  check('P1d ReelShort：页面认不出（无 __NEXT_DATA__ / 缺 books / JSON 坏）返回 null',
    PlatformLink.parseReelshortSearch('<html>captcha</html>') === null
    && PlatformLink.parseReelshortSearch(nextData({})) === null
    && PlatformLink.parseReelshortSearch('<script id="__NEXT_DATA__">{bad</script>') === null);

  const db = PlatformLink.parseDramaboxSearch(nextData({ isEmpty: false, bookList: [
    { bookId: '42000008769', bookName: 'How to Tame the Tycoon', bookNameEn: 'How-to-Tame-the-Tycoon', replacedBookName: null },
    { bookId: '41000105415', bookName: 'Tempest：The Last Mecha', replacedBookName: 'Tempest：The-Last-Mecha' },
    { bookId: 'abc', bookName: 'Bad' }
  ] }));
  check('P2 DramaBox：地址与抓取卡同形态（dramabox.com/drama/<bookId>/<编码 slug>）',
    db[0].url === 'https://www.dramabox.com/drama/42000008769/How-to-Tame-the-Tycoon'
    && db[1].url === 'https://www.dramabox.com/drama/41000105415/Tempest%EF%BC%9AThe-Last-Mecha' && db[2].url === null,
    JSON.stringify(db));
  check('P2b DramaBox：isEmpty（没搜到、列表是推荐位）按空结果；认不出返回 null',
    same(PlatformLink.parseDramaboxSearch(nextData({ isEmpty: true, bookList: [{ bookId: '1', bookName: 'x' }] })), [])
    && PlatformLink.parseDramaboxSearch('<html></html>') === null);

  const gsHtml = '<script>window.__INITIAL_STATE__={}</script>'
    + '<a href="/drama/dumping-my-mr-april-fools-31001774810"><img></a><a href="/drama/dumping-my-mr-april-fools-31001774810">t</a>'
    + '<a href="/episode/dumping-my-mr-april-fools-31001774810/001-66343105">Play</a>'
    + '<a href="/drama/eng-dub-the-wife-who-changed-the-story-31001212898">t</a>';
  const gs = PlatformLink.parseGoodshortSearch(gsHtml);
  check('P3 GoodShort：同一部按 id 去重，地址优先第 1 集播放页，没有就用剧集页',
    same(gs, [
      { key: 'dumping-my-mr-april-fools', url: 'https://www.goodshort.com/episode/dumping-my-mr-april-fools-31001774810/001-66343105' },
      { key: 'eng-dub-the-wife-who-changed-the-story', url: 'https://www.goodshort.com/drama/eng-dub-the-wife-who-changed-the-story-31001212898' }
    ]), JSON.stringify(gs));
  check('P3b GoodShort：没有 __INITIAL_STATE__（拦截页）返回 null', PlatformLink.parseGoodshortSearch('<a href="/drama/x-1234567">') === null);

  const ds = PlatformLink.parseDramashortsSearch(nextData({ searchMovies: [
    { id: 'db64c65e-a7c5-4005-8282-886fe2f5bf45', title: 'The Billionaire’s Vow' }, { id: 'nope', title: 'Bad' }
  ] }));
  check('P4 DramaShorts：/shorts/<UUID>，非 UUID 没有地址',
    ds[0].url === 'https://dramashorts.io/shorts/db64c65e-a7c5-4005-8282-886fe2f5bf45' && ds[1].url === null
    && PlatformLink.decide("The Billionaire's Vow", ds).kind === 'play', JSON.stringify(ds));

  const fr = PlatformLink.parseFlickreelsSearch('<script id="__NUXT_DATA__">[]</script>'
    + '<a href="/playlist/when-love-returns/4365/episode-1">a</a><a href="/playlist/when-love-returns/4365/episode-1">b</a>'
    + '<a href="/playlist/when-love-returns/7667/episode-1">c</a><a href="/playlist/tame-memy-lord/12/full-movie">d</a>');
  check('P5 FlickReels：按 id 去重，同名两部各算一个候选 → ambiguous；full-movie 形态照收',
    fr.length === 3 && PlatformLink.decide('When Love Returns', fr).kind === 'ambiguous'
    && same(PlatformLink.decide('Tame Me, My Lord', fr), { kind: 'play', url: 'https://www.flickreels.net/playlist/tame-memy-lord/12/full-movie' }),
    JSON.stringify(fr));
  check('P5b FlickReels：非 Nuxt 页面返回 null', PlatformLink.parseFlickreelsSearch('<a href="/playlist/x/1/episode-1">') === null);

  const md = PlatformLink.parseMydramaSitemap('<?xml version="1.0"?><urlset>'
    + '<url><loc>https://my-drama.com/all-series</loc></url>'
    + '<url><loc>https://my-drama.com/series/his-dark-kiss-b6973579-f9b6-429c-8cc5-bad184a58236</loc></url>'
    + '<url><loc> https://my-drama.com/series/mothers-heart-never-lies-E0D3581E-154D-4AEE-A8D0-F0D645B3E90E </loc></url>'
    + '<url><loc>https://my-drama.com/de/series/sein-dunkler-kuss-b6973579-f9b6-429c-8cc5-bad184a58236</loc></url>'
    + '</urlset>');
  check('P6 MyDrama 站点地图：/series/<slug>-<UUID> → 播放页 /video/<UUID>（小写），只收根语种',
    same(md, [
      { key: 'his-dark-kiss', url: 'https://my-drama.com/video/b6973579-f9b6-429c-8cc5-bad184a58236' },
      { key: 'mothers-heart-never-lies', url: 'https://my-drama.com/video/e0d3581e-154d-4aee-a8d0-f0d645b3e90e' }
    ]) && PlatformLink.decide("Mother's Heart Never Lies", md).kind === 'play', JSON.stringify(md));
  check('P6b MyDrama：不是 urlset（错误页 / sitemap 索引）返回 null',
    PlatformLink.parseMydramaSitemap('<sitemapindex></sitemapindex>') === null && PlatformLink.parseMydramaSitemap('') === null);

  const sc = PlatformLink.parseShorticalSitemap('<urlset><url><loc>https://shortical.com/drama/against-all-odds-175</loc></url>'
    + '<url><loc>https://shortical.com/drama/my-bestie-is-the-superstar-queen-174</loc></url>'
    + '<url><loc>https://shortical.com/drama/no-id</loc></url></urlset>');
  check('P7 Shortical 站点地图：规范 slug 与抓取侧同一份解析',
    same(sc, [
      { key: 'against-all-odds', url: 'https://shortical.com/drama/against-all-odds-175' },
      { key: 'my-bestie-is-the-superstar-queen', url: 'https://shortical.com/drama/my-bestie-is-the-superstar-queen-174' }
    ]) && PlatformLink.parseShorticalSitemap('<html>404</html>') === null, JSON.stringify(sc));
}

// ---------- M 封面菜单项（弹窗 / 共享页两种模式） ----------
{
  const open = () => {};
  const popupOpts = { onOpenUrl: open, onOpenPlatform: () => Promise.resolve() };
  const shareOpts = { onOpenUrl: open };
  const rs = imdb('co1016895');
  check('M1 弹窗：已知平台的 IMDb 卡给「IMDB 影片页 / 搜 ReelShort（交给后台）」',
    same(TimelineRender.posterMenuItems(rs, popupOpts), [
      { label: 'IMDB 影片页', url: 'https://www.imdb.com/title/tt1/' }, { label: '搜 ReelShort', platform: true }
    ]), JSON.stringify(TimelineRender.posterMenuItems(rs, popupOpts)));
  check('M2 弹窗：MyDrama / NetShort 也给菜单（没找到时弹窗提示）',
    TimelineRender.posterMenuItems(imdb('co1116954'), popupOpts)?.[1]?.label === '搜 MyDrama'
    && TimelineRender.posterMenuItems(imdb('co1104898'), popupOpts)?.[1]?.platform === true);
  check('M3 共享页：没记下播放页时「搜 X」直接开平台搜索页',
    same(TimelineRender.posterMenuItems(rs, shareOpts)?.[1], { label: '搜 ReelShort', url: 'https://www.reelshort.com/search?keywords=Silicon%20God%20Strikes%20Back' }));
  check('M4 共享页：记下过播放页就直达；记下的地址不属于该平台则不用',
    TimelineRender.posterMenuItems(imdb('co1016895', { playUrl: 'https://www.reelshort.com/episodes/episode-1-x-1-2' }), shareOpts)?.[1]?.url === 'https://www.reelshort.com/episodes/episode-1-x-1-2'
    && TimelineRender.posterMenuItems(imdb('co1016895', { playUrl: 'https://evil.example/x' }), shareOpts)?.[1]?.url.startsWith('https://www.reelshort.com/search?'));
  check('M5 共享页：无搜索页平台没记下播放页 → 不弹菜单；记下了 → 弹',
    TimelineRender.posterMenuItems(imdb('co1116954'), shareOpts) === null
    && TimelineRender.posterMenuItems(imdb('co1116954', { playUrl: 'https://my-drama.com/video/b6973579-f9b6-429c-8cc5-bad184a58236' }), shareOpts)?.[1]?.url === 'https://my-drama.com/video/b6973579-f9b6-429c-8cc5-bad184a58236');
  check('M6 平台未知（micro-drama / DramaWave）、非 IMDb 卡、缺原站链接、没注入 onOpenUrl → 不弹菜单',
    TimelineRender.posterMenuItems(imdb('x', { sourceListUrl: 'https://www.imdb.com/search/title/?interests=in0000310' }), popupOpts) === null
    && TimelineRender.posterMenuItems(imdb('co1124838'), popupOpts) === null
    && TimelineRender.posterMenuItems({ ...rs, source: 'reelshort' }, popupOpts) === null
    && TimelineRender.posterMenuItems({ ...rs, url: 'javascript:alert(1)' }, popupOpts) === null
    && TimelineRender.posterMenuItems(rs, { onOpenPlatform: () => {} }) === null);
  check('M7 closePosterMenu 没开菜单时调用无副作用', (() => { TimelineRender.closePosterMenu(); return true; })());
}

// ---------- L 飞书卡片「搜 X」按钮 ----------
{
  const drama = { title: 'Silicon God Strikes Back', titleZh: '芯片之神强势归来', url: 'https://www.imdb.com/title/tt1/', tags: ['IMDB', 'ReelShort'] };
  const link = { name: 'ReelShort', url: 'https://www.reelshort.com/episodes/episode-1-x-1-2' };
  const els = card => card.card.body.elements;
  const buttons = card => (els(card).at(-1)?.columns || []).map(col => col.elements[0]);

  const plain = Lark.buildBotCard(drama, {});
  check('L1 不带 platformLink：与以前逐字一致（只有「去瞅瞅」一列）',
    buttons(plain).length === 1 && buttons(plain)[0].text.content === '去瞅瞅' && buttons(plain)[0].type === 'primary');
  const both = Lark.buildBotCard(drama, { platformLink: link });
  const set = els(both).at(-1);
  check('L2 带 platformLink：同一个靠右 column_set，「搜 ReelShort」在「去瞅瞅」左边',
    set.tag === 'column_set' && set.horizontal_align === 'right' && set.columns.length === 2
    && buttons(both)[0].text.content === '搜 ReelShort' && buttons(both)[0].type === 'default'
    && buttons(both)[0].behaviors[0].default_url === link.url
    && buttons(both)[1].text.content === '去瞅瞅' && buttons(both)[1].behaviors[0].default_url === drama.url,
    JSON.stringify(set));
  check('L3 两列都是 auto 宽、按钮上不带 horizontal_align（飞书会整卡拒收）',
    set.columns.every(col => col.width === 'auto' && col.tag === 'column') && buttons(both).every(btn => !('horizontal_align' in btn)));
  check('L4 platformLink 地址非 http(s) 或缺平台名 → 忽略，回到单按钮',
    buttons(Lark.buildBotCard(drama, { platformLink: { name: 'ReelShort', url: 'javascript:alert(1)' } })).length === 1
    && buttons(Lark.buildBotCard(drama, { platformLink: { name: '', url: link.url } })).length === 1);
  check('L5 没有 IMDb 链接时只剩「搜 X」', same(buttons(Lark.buildBotCard({ ...drama, url: '' }, { platformLink: link })).map(b => b.text.content), ['搜 ReelShort']));
  const order = els(Lark.buildBotCard({ ...drama, descriptionZh: '简介' }, { platformLink: link, imgKey: 'img_1' })).map(e => e.tag);
  check('L6 带封面时顺序仍是 简介 / 来源 / 按钮 / 封面', same(order, ['markdown', 'markdown', 'column_set', 'img']), JSON.stringify(order));

  // pushBotCard：带按钮的卡被业务错误拒收 → 去掉按钮重发一次；超时 / 限流 / 不带按钮时不重发
  const HOOK = 'https://open.larksuite.com/open-apis/bot/v2/hook/unit-test';
  const config = { botWebhookUrl: HOOK, botEnabled: true };
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  console.warn = (...args) => { if (!String(args[0]).includes('[ShortScraping]')) realWarn(...args); };
  const posts = [];
  const respond = replies => {
    posts.length = 0;
    globalThis.fetch = async (url, options) => {
      const reply = replies[Math.min(posts.length, replies.length - 1)];
      posts.push(JSON.parse(options.body));
      if (reply === 'hang') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      return new Response(JSON.stringify(reply.body), { status: reply.status || 200, headers: { 'content-type': 'application/json' } });
    };
  };
  const ok = { body: { code: 0, msg: 'success' } };
  try {
    respond([{ body: { code: 200621, msg: 'unknown property' } }, ok]);
    const result = await Lark.pushBotCard(config, drama, { platformLink: link });
    check('L7 带按钮的卡被拒收（code≠0）→ 去掉按钮重发一次、成功',
      result.success === true && posts.length === 2 && buttons(posts[0]).length === 2 && buttons(posts[1]).length === 1,
      JSON.stringify(posts.map(p => buttons(p).length)));

    respond([{ status: 400, body: { code: 11246, msg: 'bad card' } }, ok]);
    await Lark.pushBotCard(config, drama, { platformLink: link });
    check('L8 HTTP 400 拒收同样重发一次', posts.length === 2);

    respond([{ body: { code: 9499, msg: 'too many requests' } }, ok]);
    let limited = null;
    try { await Lark.pushBotCard(config, drama, { platformLink: link }); } catch (e) { limited = e; }
    check('L9 频率限流（9499）不重发、照常抛给重试队列', limited && posts.length === 1, String(limited?.message));

    respond(['hang', ok]);
    let timedOut = null;
    try { await Lark.pushBotCard(config, drama, { platformLink: link }); } catch (e) { timedOut = e; }
    check('L10 超时 / 网络错误不重发（第一张可能已送达）', timedOut && posts.length === 1, String(timedOut?.message));

    respond([{ body: { code: 200621, msg: 'x' } }, ok]);
    let plainRejected = null;
    try { await Lark.pushBotCard(config, drama); } catch (e) { plainRejected = e; }
    check('L11 不带按钮的卡被拒收照旧抛错、不重发', plainRejected && posts.length === 1);

    respond([ok]);
    await Lark.pushBotCard(config, drama, { platformLink: link });
    check('L12 正常送达只发一次，卡上两个按钮', posts.length === 1 && buttons(posts[0]).length === 2);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
