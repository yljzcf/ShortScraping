import './bootstrap.cjs';
// IMDb 条目「搜平台」的后台接线（v1.7.3，真实 background.js 跑在 background-fixture 里）：
//   H 弹窗封面菜单「搜 X」（openPlatformPage）：唯一同名 → 开播放页并记下 playUrl；多部 / 没搜到 /
//     查找失败 → 开搜索结果页、不记；网页端没有搜索页的平台没找到 → notFound、不开页；ShortMax /
//     NetShort 不联网只看库内同名卡；记下过的直开零请求；请求不带 cookie、固定英文；同卡连点单飞；
//     站点地图缓存；只读护栏下照开不写。
//   S 内容脚本入库带来的 playUrl 一律丢弃（被攻破的页面不能给卡片塞跳转地址）。
//   B 飞书群卡片「搜 X」：推送前解析、唯一同名直达并记下、查不到退回搜索页链接或不带按钮，
//     任何失败都照常推送；重试沿用记下的地址；测试发送与真实推送同口径。
// 纯逻辑（解析器 / 判定 / 菜单项 / 卡片排版）见 unit-platform-link.mjs。
// 用法：node tests/unit-platform-open.mjs
import { background, card } from './background-fixture.mjs';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);

let unhandled = 0;
process.on('unhandledRejection', (e) => { unhandled++; console.error('UNHANDLED:', e?.message || e); });

const SUBS = {
  reelshort: 'https://www.imdb.com/search/title/?companies=co1016895',
  mydrama: 'https://www.imdb.com/search/title/?companies=co1116954',
  netshort: 'https://www.imdb.com/search/title/?companies=co1104898',
  shortmax: 'https://www.imdb.com/search/title/?companies=co1065580',
  dramabox: 'https://www.imdb.com/search/title/?companies=co1028734',
  goodshort: 'https://www.imdb.com/search/title/?companies=co1045147',
  dramawave: 'https://www.imdb.com/search/title/?companies=co1124838',
  micro: 'https://www.imdb.com/search/title/?interests=in0000310',
  nsList: 'https://netshort.com/?list=trending_now',
  smList: 'https://www.shorttv.live/?list=most_popular',
  netflix: 'https://www.netflix.com/tudum/top10'
};
const TAG_FILE = Object.entries(SUBS).map(([key, url]) => ({ url, tags: ['IMDB', key] }));
const URL_TAGS = TAG_FILE.map(({ url, tags }) => ({ urlPattern: url, tags }));
const BOT_HOOK = 'https://open.larksuite.com/open-apis/bot/v2/hook/unit-platform';
const LARK = { webhookUrl: '', botWebhookUrl: BOT_HOOK, botEnabled: true, requestTimeoutSec: 5 };
const PLATFORM_HOST = /reelshort\.com|dramabox\.com|goodshort\.com|dramashorts\.io|flickreels\.net|my-drama\.com|shortical\.com|shorttv\.live|netshort\.com/;

const imdbCard = (itemId, platform, title, extra = {}) => card(itemId, {
  title, sourceListUrl: SUBS[platform], url: `https://www.imdb.com/title/${itemId}/`, tags: ['IMDB', platform],
  status: 'trans', titleZh: `中·${itemId}`, descriptionZh: '中文简介', translatedAt: '2026-09-05T01:05:00.000Z', ...extra
});
const nextData = props => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: props } })}</script></html>`;
const RS_ID = '69c0a33b8189b0616e0020e1';
const RS_PLAY = `https://www.reelshort.com/episodes/episode-1-silicon-god-strikes-back-${RS_ID}-4s1macr7e0`;
const rsSearch = title => `https://www.reelshort.com/search?keywords=${encodeURIComponent(title)}`;
const rsPage = books => `<a href="/movie/silicon-god-strikes-back-${RS_ID}">x</a>` + nextData({ books });
const RS_BOOK = { book_id: RS_ID, book_title: 'Silicon God Strikes Back', start_play: { chapter_id: '4s1macr7e0' } };
const MD_SITEMAP = 'https://my-drama.com/sitemap-series.xml';
const MD_XML = '<urlset><url><loc>https://my-drama.com/series/his-dark-kiss-b6973579-f9b6-429c-8cc5-bad184a58236</loc></url>'
  + '<url><loc>https://my-drama.com/series/claimed-by-the-crown-432a3003-9b2c-496e-9205-8ada4d497ff5</loc></url></urlset>';

/**
 * 起一个后台实例。pages：平台地址 → HTML 字符串 | HTTP 状态码 | Error | () => Promise<Response>。
 * 只记平台请求（requests），其余外网照夹具默认拒掉；botPosts 记群机器人收到的卡片。
 */
async function makeBg({ dramas = [], pages = {}, data = {}, timers = 'noop', bot = null } = {}) {
  const requests = [];
  const botPosts = [];
  const bg = await background({
    timers,
    dramas,
    data: { urlTags: URL_TAGS, ...(bot ? { larkConfig: LARK, larkBotState: { enabledAt: '2026-09-05T00:00:00.000Z' } } : {}), ...data },
    fetch: (url, options) => {
      const u = String(url);
      if (u.endsWith('/config/tag.json')) return Promise.resolve({ ok: true, async json() { return TAG_FILE; } });
      if (u.endsWith('/config/lark.json')) return Promise.resolve({ ok: true, async json() { return bot ? LARK : {}; } });
      if (u === BOT_HOOK) {
        botPosts.push(JSON.parse(options?.body || '{}'));
        const status = typeof bot === 'function' ? bot(botPosts.length) : 200;
        return Promise.resolve(new Response(JSON.stringify(status === 200 ? { code: 0, msg: 'success' } : { code: 1 }), { status }));
      }
      if (!PLATFORM_HOST.test(u)) return undefined;
      requests.push({ url: u, options });
      const page = pages[u];
      if (page === undefined) return Promise.reject(new Error(`unexpected ${u}`));
      if (typeof page === 'function') return page();
      if (page instanceof Error) return Promise.reject(page);
      if (typeof page === 'number') return Promise.resolve(new Response('blocked', { status: page }));
      return Promise.resolve(new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }));
    }
  });
  const tabs = () => bg.log.filter(e => e.startsWith('tab:')).map(e => e.slice(4));
  const stored = id => bg.dramas().find(d => d.id === id)?.playUrl;
  const open = dramaId => bg.send({ action: 'openPlatformPage', dramaId });
  return { bg, requests, botPosts, tabs, stored, open };
}
const buttonsOf = post => (post?.card?.body?.elements || []).filter(e => e.tag === 'column_set').flatMap(set => set.columns.map(col => col.elements[0]))
  .map(btn => ({ text: btn.text.content, url: btn.behaviors[0].default_url }));
async function drive(bg, steps = 12, ms = 1000) {
  for (let i = 0; i < steps; i++) await bg.timers.advance(ms);
}

// ---------- H 弹窗「搜 X」 ----------
{
  const h = await makeBg({ dramas: [imdbCard('tt1', 'reelshort', 'Silicon God Strikes Back', { playUrl: RS_PLAY })] });
  const resp = await h.open('id_tt1');
  check('H1 记下过播放页：直接开、零平台请求', resp?.success && resp.kind === 'play' && show(h.tabs()) === show([RS_PLAY]) && h.requests.length === 0,
    show({ resp, tabs: h.tabs(), requests: h.requests.length }));
}
{
  const title = 'Silicon God Strikes Back';
  const h = await makeBg({ dramas: [imdbCard('tt1', 'reelshort', title)], pages: { [rsSearch(title)]: rsPage([RS_BOOK, { book_id: '6a629f5ea1c787017500913a', book_title: 'Take Me Back' }]) } });
  const resp = await h.open('id_tt1');
  await h.bg.flush();
  const tabAt = h.bg.log.indexOf(`tab:${RS_PLAY}`);
  const writeAt = h.bg.log.findIndex((e, i) => i > tabAt && e.startsWith('set:') && e.includes('dramas'));
  check('H2 唯一同名：开第一集播放页，并把 playUrl 记到条目上（先开页后回写）',
    resp?.success && resp.kind === 'play' && show(h.tabs()) === show([RS_PLAY]) && h.stored('id_tt1') === RS_PLAY && tabAt !== -1 && writeAt > tabAt,
    show({ resp, tabs: h.tabs(), stored: h.stored('id_tt1'), log: h.bg.log.slice(-4) }));
  check('H3 请求不带 cookie、固定英文', h.requests[0]?.options?.credentials === 'omit'
    && h.requests[0]?.options?.headers?.['Accept-Language'] === 'en-US,en;q=0.9', show(h.requests[0]?.options));
  const again = await h.open('id_tt1');
  check('H4 再点一次：用记下的地址，不再请求', again?.success && h.requests.length === 1 && h.tabs().length === 2, show({ again, requests: h.requests.length }));
}
{
  const title = 'Brothers in Arms';
  const three = [1, 2, 3].map(i => ({ book_id: `${'a'.repeat(23)}${i}`, book_title: title, first_chapter_id: `c${i}` }));
  const h = await makeBg({ dramas: [imdbCard('tt2', 'reelshort', title)], pages: { [rsSearch(title)]: nextData({ books: three }) } });
  const resp = await h.open('id_tt2');
  check('H5 多部同名：开平台搜索结果页、不记', resp?.success && resp.kind === 'search' && show(h.tabs()) === show([rsSearch(title)]) && h.stored('id_tt2') === undefined,
    show({ resp, tabs: h.tabs() }));
}
{
  const cases = [
    ['H6a 没搜到', nextData({ books: [] })],
    ['H6b 网络错误', new Error('boom')],
    ['H6c HTTP 403（被拦）', 403],
    ['H6d 验证码页（认不出页面）', '<html>Just a moment...</html>']
  ];
  for (const [name, page] of cases) {
    const title = 'Mafia Princess Returns';
    const h = await makeBg({ dramas: [imdbCard('tt3', 'reelshort', title)], pages: { [rsSearch(title)]: page } });
    const resp = await h.open('id_tt3');
    check(`${name} → 开搜索结果页、不记`, resp?.success && resp.kind === 'search' && show(h.tabs()) === show([rsSearch(title)]) && h.stored('id_tt3') === undefined,
      show({ resp, tabs: h.tabs() }));
  }
}
{
  const h = await makeBg({
    dramas: [imdbCard('tt4', 'mydrama', 'His Dark Kiss'), imdbCard('tt5', 'mydrama', 'Claimed by the Crown'), imdbCard('tt6', 'mydrama', 'Club of Desire')],
    pages: { [MD_SITEMAP]: MD_XML }
  });
  const first = await h.open('id_tt4');
  const second = await h.open('id_tt5');
  check('H7 MyDrama 站点地图：唯一同名直达 /video/<UUID>；第二部复用缓存的站点地图（只请求一次）',
    first?.kind === 'play' && second?.kind === 'play'
    && show(h.tabs()) === show(['https://my-drama.com/video/b6973579-f9b6-429c-8cc5-bad184a58236', 'https://my-drama.com/video/432a3003-9b2c-496e-9205-8ada4d497ff5'])
    && h.requests.length === 1, show({ tabs: h.tabs(), requests: h.requests.map(r => r.url) }));
  const missing = await h.open('id_tt6');
  check('H8 MyDrama 没找到：回 notFound（带平台名 / 片名 / 原因），不开页、不写',
    missing?.success === false && missing.notFound === true && missing.name === 'MyDrama' && missing.title === 'Club of Desire'
    && missing.reason === 'none' && h.tabs().length === 2 && h.stored('id_tt6') === undefined, show(missing));
}
{
  const h = await makeBg({ dramas: [imdbCard('tt7', 'mydrama', 'His Dark Kiss')], pages: { [MD_SITEMAP]: 503 } });
  const resp = await h.open('id_tt7');
  check('H8b MyDrama 站点地图取不到：notFound，原因 error', resp?.notFound === true && resp.reason === 'error' && h.tabs().length === 0, show(resp));
}
{
  const twin = card('ns1', { source: 'netshort', title: 'Racing Back to Your Heart', sourceListUrl: SUBS.nsList, url: 'https://netshort.com/episode/racing-back-to-your-heart-2098290708771815426' });
  const dup = [card('ns2', { source: 'netshort', title: 'Twin Name', sourceListUrl: SUBS.nsList, url: 'https://netshort.com/episode/twin-name-1' }),
    card('ns3', { source: 'netshort', title: 'Twin Name', sourceListUrl: SUBS.nsList, url: 'https://netshort.com/episode/twin-name-2' })];
  const h = await makeBg({ dramas: [imdbCard('tt8', 'netshort', 'Racing Back to Your Heart'), imdbCard('tt9', 'netshort', 'Nowhere'), imdbCard('tt10', 'netshort', 'Twin Name'), twin, ...dup] });
  const hit = await h.open('id_tt8');
  const miss = await h.open('id_tt9');
  const amb = await h.open('id_tt10');
  check('H9 NetShort：库里平台自己抓到的唯一同名卡 → 直达并记下',
    hit?.kind === 'play' && h.tabs()[0] === twin.url && h.stored('id_tt8') === twin.url, show({ hit, tabs: h.tabs() }));
  check('H9b NetShort：没有同名卡 → notFound(none)；两张同名 → notFound(ambiguous)；全程零请求',
    miss?.notFound && miss.reason === 'none' && amb?.notFound && amb.reason === 'ambiguous' && h.requests.length === 0 && h.tabs().length === 1,
    show({ miss, amb, requests: h.requests.length }));
}
{
  const twin = card('sm1', { source: 'shortmax', title: 'The Dragon God Wakes for His Daughter', sourceListUrl: SUBS.smList, url: 'https://www.shorttv.live/episode/the-dragon-god-wakes-for-his-daughter-41973-1' });
  const h = await makeBg({ dramas: [imdbCard('tt11', 'shortmax', 'The Dragon God Wakes for His Daughter'), imdbCard('tt12', 'shortmax', 'Big Shot'), twin] });
  const hit = await h.open('id_tt11');
  const miss = await h.open('id_tt12');
  check('H10 ShortMax：从不联网；有同名卡直达，没有就开 ShortMax 搜索页',
    hit?.kind === 'play' && miss?.kind === 'search' && show(h.tabs()) === show([twin.url, 'https://www.shorttv.live/search/Big%20Shot']) && h.requests.length === 0,
    show({ tabs: h.tabs(), requests: h.requests.length }));
}
{
  const dbUrl = 'https://www.dramabox.com/search?searchValue=How%20to%20Tame%20the%20Tycoon';
  const gsUrl = 'https://www.goodshort.com/results?q=Turns%20Out%20My%20Dad%20Is%20a%20Billionaire';
  const h = await makeBg({
    dramas: [imdbCard('tt13', 'dramabox', 'How to Tame the Tycoon'), imdbCard('tt14', 'goodshort', 'Turns Out My Dad Is a Billionaire')],
    pages: {
      [dbUrl]: nextData({ isEmpty: false, bookList: [{ bookId: '42000008769', bookName: 'How to Tame the Tycoon', bookNameEn: 'How-to-Tame-the-Tycoon' }] }),
      [gsUrl]: '<script>window.__INITIAL_STATE__={}</script><a href="/drama/turns-out-my-dad-is-a-billionaire-31001404018">t</a>'
        + '<a href="/episode/turns-out-my-dad-is-a-billionaire-31001404018/001-19152941">Play</a>'
    }
  });
  await h.open('id_tt13');
  await h.open('id_tt14');
  check('H11 DramaBox / GoodShort：按搜索页解析直达（DramaBox 统一 dramabox.com，GoodShort 第 1 集播放页）',
    show(h.tabs()) === show(['https://www.dramabox.com/drama/42000008769/How-to-Tame-the-Tycoon',
      'https://www.goodshort.com/episode/turns-out-my-dad-is-a-billionaire-31001404018/001-19152941']), show(h.tabs()));
}
{
  const title = 'Silicon God Strikes Back';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await makeBg({ dramas: [imdbCard('tt15', 'reelshort', title)], pages: { [rsSearch(title)]: () => gate.then(() => new Response(rsPage([RS_BOOK]), { status: 200 })) } });
  const both = Promise.all([h.open('id_tt15'), h.open('id_tt15')]);
  await h.bg.flush();
  release();
  const [a, b] = await both;
  check('H12 同一张卡连点：只请求一次、只开一个标签页，两次都回同一结果',
    a?.success && b?.success && h.requests.length === 1 && h.tabs().length === 1, show({ a, b, requests: h.requests.length, tabs: h.tabs() }));
}
{
  const title = 'Silicon God Strikes Back';
  const h = await makeBg({ dramas: [imdbCard('tt16', 'reelshort', title)], data: { dramasMeta: { layout: 2 } }, pages: { [rsSearch(title)]: rsPage([RS_BOOK]) } });
  const writesBefore = h.bg.log.filter(e => e.startsWith('set:') && e.includes('dramas')).length;
  const resp = await h.open('id_tt16');
  await h.bg.flush();
  const writesAfter = h.bg.log.filter(e => e.startsWith('set:') && e.includes('dramas')).length;
  check('H13 只读护栏下（数据已被更新版本升级）：照样开页，不回写', resp?.success && show(h.tabs()) === show([RS_PLAY]) && writesAfter === writesBefore && h.stored('id_tt16') === undefined,
    show({ resp, writesBefore, writesAfter }));
}
{
  const h = await makeBg({ dramas: [imdbCard('tt17', 'micro', 'X'), imdbCard('tt18', 'dramawave', 'Y')] });
  const unknown = await h.open('id_nope');
  const micro = await h.open('id_tt17');
  const wave = await h.open('id_tt18');
  check('H14 卡不存在 / micro-drama / DramaWave：回错误、不开页、零请求',
    unknown?.success === false && /未找到/.test(unknown.error) && micro?.success === false && /不属于/.test(micro.error)
    && wave?.success === false && h.tabs().length === 0 && h.requests.length === 0, show({ unknown, micro, wave }));
}

// ---------- S 内容脚本入库带来的 playUrl 丢弃 ----------
{
  const h = await makeBg();
  const sender = { id: 'fixture', url: SUBS.reelshort, tab: { id: 9, url: SUBS.reelshort } };
  const planted = { ...imdbCard('tt19', 'reelshort', 'Planted'), status: 'new', playUrl: 'https://www.reelshort.com/episodes/evil' };
  const resp = await h.bg.send({ action: 'saveDrama', drama: planted }, sender);
  const saved = h.bg.dramas().find(d => d.itemId === 'tt19');
  check('S1 入库时丢掉调用方带来的 playUrl（只有后台查到唯一同名剧才写）', resp?.success && saved && !('playUrl' in saved), show({ resp, saved }));
}

// ---------- B 飞书群卡片「搜 X」 ----------
{
  const title = 'Silicon God Strikes Back';
  const h = await makeBg({ timers: 'manual', bot: true, dramas: [imdbCard('tt20', 'reelshort', title)], pages: { [rsSearch(title)]: rsPage([RS_BOOK]) } });
  const run = h.bg.context.maybeBotPush(h.bg.dramas()[0]);
  await drive(h.bg);
  const pushed = await run;
  check('B1 ReelShort 唯一同名：卡片「搜 ReelShort」在「去瞅瞅」左边、直达播放页，并记下 playUrl',
    pushed === true && show(buttonsOf(h.botPosts[0])) === show([{ text: '搜 ReelShort', url: RS_PLAY }, { text: '去瞅瞅', url: 'https://www.imdb.com/title/tt20/' }])
    && h.stored('id_tt20') === RS_PLAY, show({ pushed, buttons: buttonsOf(h.botPosts[0]) }));
}
{
  const gsTitle = 'Hidden Heiress vs Real Heiress';
  const gsUrl = `https://www.goodshort.com/results?q=${encodeURIComponent(gsTitle)}`;
  const h = await makeBg({
    timers: 'manual', bot: true,
    dramas: [imdbCard('tt21', 'goodshort', gsTitle), imdbCard('tt22', 'mydrama', 'His Dark Kiss'),
      card('nf1', { source: 'netflix', status: 'trans', sourceListUrl: SUBS.netflix, url: 'https://www.netflix.com/title/81234567', titleZh: '中·nf1', descriptionZh: '简介' })],
    pages: { [gsUrl]: '<script>window.__INITIAL_STATE__={}</script><a href="/drama/the-heiress-who-forgot-to-die-31001000001">t</a>', [MD_SITEMAP]: () => new Promise(() => {}) }
  });
  const byId = id => h.bg.dramas().find(d => d.id === id);
  const [gs, md, nf] = ['id_tt21', 'id_tt22', 'id_nf1'].map(byId);
  const runs = [h.bg.context.maybeBotPush(gs)];
  await drive(h.bg);
  runs.push(h.bg.context.maybeBotPush(md));
  await drive(h.bg);
  runs.push(h.bg.context.maybeBotPush(nf));
  await drive(h.bg);
  const pushed = await Promise.all(runs);
  const [gsCard, mdCard, nfCard] = h.botPosts;
  check('B2 GoodShort（用户选了推送时也搜）：去搜了，没有同名 → 按钮给搜索结果页',
    h.requests.some(r => r.url === gsUrl) && show(buttonsOf(gsCard)[0]) === show({ text: '搜 GoodShort', url: gsUrl }), show(buttonsOf(gsCard)));
  check('B3 MyDrama 站点地图挂住：6 秒后放弃，卡照常推出、不带「搜」按钮',
    pushed.every(Boolean) && show(buttonsOf(mdCard).map(b => b.text)) === show(['去瞅瞅']), show({ pushed, buttons: buttonsOf(mdCard) }));
  check('B4 非 IMDb 卡：不查平台、卡片只有「去瞅瞅」',
    show(buttonsOf(nfCard).map(b => b.text)) === show(['去瞅瞅']) && h.requests.every(r => !/netflix/.test(r.url)) && h.requests.length === 2,
    show({ buttons: buttonsOf(nfCard), requests: h.requests.map(r => r.url) }));
}
{
  const title = 'Silicon God Strikes Back';
  const h = await makeBg({ timers: 'manual', bot: n => (n === 1 ? 500 : 200), dramas: [imdbCard('tt23', 'reelshort', title)], pages: { [rsSearch(title)]: rsPage([RS_BOOK]) } });
  const run = h.bg.context.maybeBotPush(h.bg.dramas()[0]);
  await drive(h.bg);
  await run;
  const retry = h.bg.context.processBotRetryQueue();
  await drive(h.bg);
  await retry;
  check('B5 首推失败进重试：重试的卡照样带「搜 ReelShort」，用的是记下的地址（平台只请求过一次）',
    h.botPosts.length === 2 && buttonsOf(h.botPosts[1])[0]?.url === RS_PLAY && h.requests.length === 1,
    show({ posts: h.botPosts.length, retryButtons: buttonsOf(h.botPosts[1]), requests: h.requests.length }));
}
{
  const title = 'Silicon God Strikes Back';
  const h = await makeBg({ timers: 'manual', bot: true, dramas: [imdbCard('tt24', 'reelshort', title, { playUrl: RS_PLAY })] });
  const sent = h.bg.send({ action: 'larkBotTestSend', config: LARK });
  await drive(h.bg);
  const resp = await sent;
  check('B6 设置页「发送机器人测试」与真实推送同口径：最新一条是 IMDb 平台卡就带「搜 X」',
    resp?.success && buttonsOf(h.botPosts[0])[0]?.text === '搜 ReelShort', show({ resp, buttons: buttonsOf(h.botPosts[0]) }));
}

check('Z 全程无未处理的 Promise 拒绝', unhandled === 0, `unhandled=${unhandled}`);

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
