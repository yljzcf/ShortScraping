import './bootstrap.cjs';
// 内容脚本健壮性单测（批次 B4 / B5）：
//   T  fetchWithTimeout：期限**连正文一起算**——响应头到了、正文永不完的桩也必须按时 reject，
//      并 abort 底层请求；正常响应 text()/json()/ok/status/url 语义不变、期限过后不误触发。
//      （审查 no-fetch-timeout-hangs-scrape-queue：一个挂住的正文会堵死整条串行抓取队列）
//   E  端到端：Steam 详情正文挂住 → 该条按「详情失败」跳过、其余照常入库，scrape 按时回复。
//   L  readListParam：?list= 归一后为空 / 不认识 → 返回空数组，不再悄悄抓默认板块记到这条订阅下
//      （审查 list-param-silent-default-fallback）。本文件覆盖 My Drama 主站与 fandom、NetShort、
//      DramaShorts；FlickReels / ShortMax / Shortical / PinesDramas 各在自己的套件里（夹具在那边）。
//   B  抓取按钮：样式只在 content.css（不写内联样式、不用 JS 模拟 :hover），文案走 textContent
//      （审查 button-style-duplicated-dead-css）。
//   S  批次 E 清理的源码守卫：卡片骨架、DOMParser、中文判据、与后台共用的采集口径各只剩一份
//      （审查 skeleton-literal-18x-dead-sourcelisturl / intra-content-duplicate-helpers / cross-file-sync-constants）。
//   U  订阅判定 UrlMatch.matchSubscription（审查 subscription-prefix-misattribution /
//      content-subscription-matcher-divergent）：两轮都尾斜杠归一、前缀轮只容忍补斜杠与追加 query/hash、
//      ?list= 必须相等；纯函数矩阵 + 端到端（只订首页时 ?list=best_choices 页零入库、尾斜杠双向命中）。
//   H  My Drama 条目本身不是锚点时 url 取规范播放页而不是首页（审查 mydrama-href-null-homepage-url）。
// 用法：node tests/unit-content-robustness.mjs
import fs from 'node:fs';
import { scrapeContextReply } from './content-fixture.mjs';

const contentSrc = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
(0, eval)(fs.readFileSync(new URL('../src/shared/site-registry.js', import.meta.url), 'utf8'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);

const origLog = console.log, origWarn = console.warn, origError = console.error;
const warnings = [];
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (String(a[0]).includes('[ShortScraping]')) warnings.push(a.join(' ')); else origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

const realSetTimeout = globalThis.setTimeout;
const sleep = ms => new Promise(r => realSetTimeout(r, ms));
/** 给 promise 套一个外部期限：修复前挂住的用例在这里判 FAIL，而不是把整个套件挂死。 */
const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => 'TIMED_OUT')]);

/** 响应头立即到达、正文永远不发完的 Response（ignoreAbort=false 时按规范随 abort 报错）。 */
function hangingBodyResponse(signal, { ignoreAbort = true } = {}) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('<html><body>半截'));
      if (!ignoreAbort && signal) signal.addEventListener('abort', () => controller.error(signal.reason));
    }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
}

// ---------- T：fetchWithTimeout（按 unit-dramas-race 范式从源码提取，在本模块作用域执行） ----------
const helperSrc = contentSrc.match(/async function fetchWithTimeout\(url, options = \{\}, timeoutMs = FETCH_TIMEOUT_MS\) \{[\s\S]*?\n  \}/)?.[0];
const FETCH_TIMEOUT_MS = 25000; // eslint-disable-line no-unused-vars -- 被提取的函数默认参数引用
let fetchImpl = null;
const fetch = (...args) => fetchImpl(...args); // eslint-disable-line no-unused-vars -- 被提取的函数经词法作用域调用
// 提取不到（helper 被删/改名）只判 T0 失败并跳过 T 组，E/L 组照跑
const fetchWithTimeout = helperSrc ? eval(`(${helperSrc.replace('async function fetchWithTimeout', 'async function')})`) : null;

check('T0 content.js 有 fetchWithTimeout，默认期限 25 秒（常量与签名默认值）',
  !!helperSrc && /const FETCH_TIMEOUT_MS = 25000;/.test(contentSrc) && helperSrc.includes('timeoutMs = FETCH_TIMEOUT_MS'), '');

if (fetchWithTimeout) {
{
  let seenSignal = null;
  fetchImpl = async (url, options) => { seenSignal = options.signal; return hangingBodyResponse(options.signal); };
  const started = Date.now();
  const outcome = await within(fetchWithTimeout('https://example.test/detail', {}, 60).then(() => 'RESOLVED', e => e), 2000);
  const elapsed = Date.now() - started;
  check('T1 正文永不完（桩不理会 abort）→ 期限内 reject，不挂住', outcome instanceof Error && elapsed < 1000,
    show({ outcome: String(outcome), elapsed }));
  check('T2 超时错误是中文且带地址（调用方 catch 直接打日志）',
    outcome instanceof Error && outcome.name === 'TimeoutError' && outcome.message.includes('请求超时')
      && outcome.message.includes('https://example.test/detail'), show(outcome && outcome.message));
  check('T3 超时同时 abort 底层请求（signal 已置位）', seenSignal && seenSignal.aborted === true, show(seenSignal && seenSignal.aborted));
}
{
  fetchImpl = async (url, options) => hangingBodyResponse(options.signal, { ignoreAbort: false });
  const outcome = await within(fetchWithTimeout('https://example.test/abortable', {}, 60).then(() => 'RESOLVED', e => e), 2000);
  check('T4 正文流随 abort 报错的规范实现 → 同样是 TimeoutError', outcome instanceof Error && outcome.name === 'TimeoutError',
    show(String(outcome)));
}
{
  fetchImpl = () => new Promise(() => {}); // 连响应头都不来
  const outcome = await within(fetchWithTimeout('https://example.test/no-headers', {}, 60).then(() => 'RESOLVED', e => e), 2000);
  check('T5 响应头迟迟不来 → 同样按时 reject', outcome instanceof Error && outcome.name === 'TimeoutError', show(String(outcome)));
}
{
  let seen = null;
  fetchImpl = async (url, options) => {
    seen = options;
    const res = new Response(JSON.stringify({ appids: [1, 2] }), { status: 200 });
    Object.defineProperty(res, 'url', { value: 'https://example.test/final?x=1' }); // 跟随跳转后的最终地址
    return res;
  };
  const res = await fetchWithTimeout('https://example.test/api', { headers: { Accept: 'application/json' }, credentials: 'include' }, 60);
  const text = await res.text();
  const json = await res.json();
  check('T6 正常响应：ok/status/url 原样，text() 与 json() 都能读（正文已在期限内缓存）',
    res.ok === true && res.status === 200 && res.url === 'https://example.test/final?x=1'
      && text === '{"appids":[1,2]}' && show(json) === '{"appids":[1,2]}', show({ ok: res.ok, status: res.status, url: res.url, text }));
  check('T7 调用方的 headers/credentials 原样透传，另加 signal',
    seen && seen.headers.Accept === 'application/json' && seen.credentials === 'include' && seen.signal instanceof AbortSignal, '');
  await sleep(120); // 越过期限：计时器已在 finally 清掉，不得事后 abort
  check('T8 成功返回后计时器已清除（越过期限也不 abort）', seen && seen.signal.aborted === false, '');
}
{
  fetchImpl = async () => new Response('missing', { status: 404 });
  const res = await fetchWithTimeout('https://example.test/404', {}, 60);
  check('T9 非 2xx 照常返回（不抛），调用方按 ok=false 走原分支', res.ok === false && res.status === 404 && await res.text() === 'missing',
    show({ ok: res.ok, status: res.status }));
}
{
  const boom = new TypeError('Failed to fetch');
  fetchImpl = async () => { throw boom; };
  const outcome = await fetchWithTimeout('https://example.test/offline', {}, 60).then(() => 'RESOLVED', e => e);
  check('T10 网络错误原样抛出（不被改写成超时）', outcome === boom, show(String(outcome)));
}
}
// 源码守卫用：去掉注释行（注释里会引用旧写法说明来由）
const codeOnly = contentSrc.split('\n').filter(line => !/^\s*(\*|\/\/)/.test(line)).join('\n');
{
  // 源码守卫：除 helper 自己那一次，content.js 里不得再有直连 fetch(
  const code = codeOnly;
  const direct = [...code.matchAll(/(?<![\w.])fetch\(/g)].length;
  // 同源取 HTML 收拢到 fetchServerHtml / fetchServerDocument 后（2026-09-25 审查 intra-content-duplicate-helpers），它们内部同样
  // 只经 fetchWithTimeout 发请求（direct === 1 保证），调用点一并计入
  const routed = [...code.matchAll(/await (?:fetchWithTimeout|fetchServerHtml|fetchServerDocument)\(/g)].length;
  check('T11 content.js 全部直连 fetch 都经 fetchWithTimeout（只剩 helper 内部一处）', direct === 1 && routed >= 12,
    show({ direct, routed }));
}

// ---------- 场景执行器：装桩 → eval 真实 content.js → 派发 'scrape' ----------
const fakeElement = () => ({ style: {}, disabled: false, innerHTML: '', addEventListener() {}, querySelector() { return null; } });
const baseDocument = (overrides = {}) => ({
  getElementById() { return null; },
  createElement() { return fakeElement(); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: { appendChild() {} },
  ...overrides
});
const loc = href => { const u = new URL(href); return { href, hostname: u.hostname, pathname: u.pathname, search: u.search, origin: u.origin }; };
// Node 没有 CSS.escape（浏览器内容脚本里恒有）：规范的最小子集
const cssEscape = value => String(value).replace(/[^A-Za-z0-9_\u0080-\uFFFF-]/g, ch => `\\${ch}`)
  .replace(/^(-?)(\d)/, (_, dash, digit) => `${dash}\\3${digit} `);

async function runScenario({ href, subscription = href, document = baseDocument(), fetch: fetchStub, domParser, deadline = 15000 }) {
  const store = { dramas: [] };
  const listeners = [];
  const queried = [];
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      async sendMessage(message) {
        await Promise.resolve();
        if (message?.action === 'getScrapeContext') return scrapeContextReply([], [{ urlPattern: subscription, tags: ['T'] }]);
        if (message?.action === 'saveDrama') {
          const dup = store.dramas.some(d => d.itemId === message.drama.itemId);
          if (!dup) store.dramas.push(structuredClone(message.drama));
          return { success: true, saved: !dup };
        }
        return { success: false };
      }
    }
  };
  globalThis.window = { location: loc(href) };
  globalThis.CSS = { escape: cssEscape };
  // 记录适配器查过哪些选择器：「没去查默认板块」本身就是断言对象
  const qsa = document.querySelectorAll;
  globalThis.document = { ...document, querySelectorAll: sel => { queried.push(sel); return qsa(sel); } };
  globalThis.fetch = fetchStub || (async () => { throw new TypeError('unit stub: no network'); });
  globalThis.DOMParser = domParser || class { parseFromString() { return baseDocument(); } };

  (0, eval)(contentSrc);
  const response = await within(new Promise(resolve => {
    for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
  }), deadline);
  return { saved: store.dramas, queried, response };
}
const warnedAbout = (from, text) => warnings.slice(from).some(w => w.includes(text));

// ---------- E：端到端，Steam 详情正文挂住不堵整页 ----------
{
  const STEAM_URL = 'https://store.steampowered.com/category/visual_novel?flavor=contenthub_newandtrending';
  // 生产期限 25 秒在单测里压到 40ms（只改这一个时长，其余计时器原样）
  globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 25000 ? 40 : ms, ...args);
  const json = obj => new Response(JSON.stringify(obj), { status: 200 });
  const { saved, response } = await runScenario({
    href: STEAM_URL,
    deadline: 3000,
    fetch: async (url, options) => {
      if (url.includes('ajaxgetsaledynamicappquery')) return json({ appids: [111, 222] });
      if (url.includes('appids=111&l=english')) return hangingBodyResponse(options && options.signal);
      if (url.includes('appids=222&l=english')) return json({ 222: { success: true, data: { name: 'Good Game', short_description: 'sd', genres: [] } } });
      return json({});   // schinese：无数据
    }
  });
  globalThis.setTimeout = realSetTimeout;
  check('E1 某条详情正文挂住 → scrape 仍按时回复（修复前永不回复、整条队列堵死）',
    response !== 'TIMED_OUT' && response?.success === true, show(response === 'TIMED_OUT' ? response : response?.success));
  check('E2 挂住的那条按「详情失败」跳过，其余照常入库', show(saved.map(d => d.itemId)) === show(['222']), show(saved.map(d => d.itemId)));
}

// ---------- L1：My Drama 主站 ----------
const MD_UUID = 'a36a7fe3-0e89-45ff-a409-f75093c5144f';
const mdItem = uuid => ({
  matches: sel => sel === 'a[href]',
  getAttribute: n => n === 'href' ? `https://my-drama.com/video/${uuid}` : null,
  querySelector: sel => sel === 'h3' ? { textContent: 'Wild silence' } : null
});
const DEFAULT_MD = '#most_trending [data-testid="series-section-item"]';
const mdDocument = baseDocument({
  querySelectorAll: sel => {
    // 模拟浏览器：数字开头的 #id 是非法选择器
    if (/^#\d/.test(sel)) throw new SyntaxError(`'${sel}' is not a valid selector`);
    if (sel === DEFAULT_MD || sel === '#\\37 days [data-testid="series-section-item"]') return [mdItem(MD_UUID)];
    return [];
  }
});
{
  const { saved, queried } = await runScenario({ href: 'https://my-drama.com/', document: mdDocument });
  check('L1a My Drama 无 ?list= → 默认 most_trending（夹具自检）', saved.length === 1 && queried.includes(DEFAULT_MD), show(queried));
}
{
  const mark = warnings.length;
  const { saved, queried, response } = await runScenario({ href: 'https://my-drama.com/?list=%21%21%21', document: mdDocument });
  check('L1b My Drama ?list=!!!（归一后为空）→ 0 条，且根本不去查默认板块',
    response?.success === true && saved.length === 0 && !queried.includes(DEFAULT_MD), show({ saved: saved.length, queried }));
  check('L1c 同上：打出点名坏值的中文告警', warnedAbout(mark, '"!!!"') && warnedAbout(mark, '不退回默认板块'), show(warnings.slice(mark)));
}
{
  const { response, queried } = await runScenario({ href: 'https://my-drama.com/?list=7days', document: mdDocument });
  check('L1d My Drama 数字开头的锚点 id 经 CSS.escape（修复前 querySelectorAll 抛 SyntaxError、整页失败）',
    response?.success === true && queried.includes('#\\37 days [data-testid="series-section-item"]'), show({ response, queried }));
}

// ---------- L2：My Drama fandom 子域 ----------
const FANDOM = 'https://fandom.my-drama.com/';
const ARTICLES = 'li.wp-block-post';
const TRENDING = '#modal-2-content .wp-block-navigation-submenu';
{
  const { queried } = await runScenario({ href: FANDOM });
  check('L2a fandom 无 ?list= → 首页文章流（夹具自检）', queried.includes(ARTICLES) && !queried.includes(TRENDING), show(queried));
}
{
  const { queried } = await runScenario({ href: `${FANDOM}?list=trending` });
  check('L2b fandom ?list=trending → Most Trending 菜单', queried.includes(TRENDING) && !queried.includes(ARTICLES), show(queried));
}
{
  const mark = warnings.length;
  const { queried, response } = await runScenario({ href: `${FANDOM}?list=trending_now` });
  check('L2c fandom ?list=trending_now 不再被 /list=trending/ 前缀误命中，也不退回文章流 → 0 条',
    response?.success === true && !queried.includes(TRENDING) && !queried.includes(ARTICLES), show(queried));
  check('L2d 同上：打出点名坏值的告警', warnedAbout(mark, 'trending_now'), show(warnings.slice(mark)));
}
{
  const { queried } = await runScenario({ href: `${FANDOM}?list=best` });
  check('L2e fandom 不认识的 ?list= 值 → 不退回首页文章流', !queried.includes(TRENDING) && !queried.includes(ARTICLES), show(queried));
}

// ---------- L3：NetShort（flight 板块按名字归一化） ----------
const nsItem = (id, title) => ({ shortPlayId: id, shortPlayName: title, shortPlayNameUrl: `/episode/x-${id}`, shortPlayCover: 'c', shotIntroduce: 'i', labelList: [] });
const nsFlight = `{"videoListGroup":${JSON.stringify([
  { groupName: 'Trending Now', data: [nsItem('1000000001', 'Trending One')] },
  { groupName: 'Exclusive Originals', data: [nsItem('2000000002', 'Original One')] }
])}}`;
const nsDocument = baseDocument({
  querySelectorAll: sel => sel === 'script' ? [{ textContent: `self.__next_f.push(${JSON.stringify([1, nsFlight])})` }] : []
});
const ids = saved => saved.map(d => d.itemId);
{
  const { saved } = await runScenario({ href: 'https://netshort.com/', document: nsDocument });
  check('L3a NetShort 无 ?list= → 默认 trending_now（夹具自检）', show(ids(saved)) === show(['ns1000000001']), show(ids(saved)));
}
{
  // 审查原场景：大写写法以前正则不过、悄悄抓 Trending Now 记到 Exclusive Originals 订阅名下
  const { saved } = await runScenario({ href: 'https://netshort.com/?list=Exclusive_Originals', document: nsDocument });
  check('L3b NetShort ?list=Exclusive_Originals 归一后命中本板块，不退回 Trending Now',
    show(ids(saved)) === show(['ns2000000002']), show(ids(saved)));
}
{
  const { saved } = await runScenario({ href: 'https://netshort.com/?list=exclusive%20originals', document: nsDocument });
  check('L3c NetShort ?list=exclusive%20originals（URL 解码后带空格）同样命中', show(ids(saved)) === show(['ns2000000002']), show(ids(saved)));
}
{
  const { saved, response } = await runScenario({ href: 'https://netshort.com/?list=%E2%9C%A8', document: nsDocument });
  check('L3d NetShort ?list 归一后为空（✨）→ 0 条，不退回默认', response?.success === true && saved.length === 0, show(ids(saved)));
}
{
  const { saved } = await runScenario({ href: 'https://netshort.com/?list=no_such', document: nsDocument });
  check('L3e NetShort 不认识的板块名 → 0 条', saved.length === 0, show(ids(saved)));
}

// ---------- L4：DramaShorts（discover 板块按 id） ----------
const dsMovie = (id, title) => ({ id, title, description: 'd', images: {}, genre: null });
const DS_TOP = '17467b20-ab19-4f60-bb48-50ae41d2dd7f', DS_POP = '27467b20-ab19-4f60-bb48-50ae41d2dd7f';
const dsDocument = baseDocument({
  querySelector: sel => sel === 'script#__NEXT_DATA__' ? { textContent: JSON.stringify({ props: { pageProps: { discover: [
    { id: 'top_trending', type: 'x', data: { title: 'Top Trending', movies: [dsMovie(DS_TOP, 'Top')] } },
    { id: 'popular_now', type: 'x', data: { title: 'Popular Now', movies: [dsMovie(DS_POP, 'Pop')] } }
  ] } } }) } : null
});
{
  const { saved } = await runScenario({ href: 'https://dramashorts.io/', document: dsDocument });
  check('L4a DramaShorts 无 ?list= → 默认 top_trending（夹具自检）', show(ids(saved)) === show([`ds${DS_TOP}`]), show(ids(saved)));
}
{
  const { saved } = await runScenario({ href: 'https://dramashorts.io/?list=Popular-Now', document: dsDocument });
  check('L4b DramaShorts ?list=Popular-Now 归一后命中 popular_now，不退回 top_trending',
    show(ids(saved)) === show([`ds${DS_POP}`]), show(ids(saved)));
}
{
  const { saved, response } = await runScenario({ href: 'https://dramashorts.io/?list=%20', document: dsDocument });
  check('L4c DramaShorts ?list 归一后为空 → 0 条，不退回默认', response?.success === true && saved.length === 0, show(ids(saved)));
}

// ---------- L5：源码守卫——旧的「正则不过就退默认」写法不得回潮 ----------
check('L5 content.js 不再有 /^[a-z0-9_-]+$/.test(list) ? list : 默认 的静默回退写法，也不再用 /[?&]list=trending/',
  !/\/\^\[a-z0-9_-\]\+\$\/\.test\(list\)/.test(codeOnly) && !/\/\[\?&\]list=trending\//.test(codeOnly), '');

// ---------- U：订阅判定（UrlMatch.matchSubscription 纯函数矩阵） ----------
{
  const { matchSubscription } = globalThis.UrlMatch;
  const sub = (urlPattern, tag = urlPattern) => ({ urlPattern, tags: [tag] });
  const hit = (page, subs) => matchSubscription(page, subs)?.urlPattern ?? null;
  const NF = 'https://www.netflix.com/tudum/top10';
  const cases = [
    ['U1 精确等值', 'https://dramashorts.io/top-movies', [sub('https://dramashorts.io/top-movies')], 'https://dramashorts.io/top-movies'],
    ['U2 订阅带尾斜杠、页面不带（站点 301 去斜杠）', 'https://www.reelshort.com/fandom', [sub('https://www.reelshort.com/fandom/')], 'https://www.reelshort.com/fandom/'],
    ['U3 订阅不带尾斜杠、页面带', 'https://www.shorttv.live/fandom/', [sub('https://www.shorttv.live/fandom')], 'https://www.shorttv.live/fandom'],
    ['U4 只订首页时 ?list=best_choices 页不命中（list 不相等）', 'https://my-drama.com/?list=best_choices', [sub('https://my-drama.com/')], null],
    ['U5 只订 /tudum/top10 时 /tudum/top10/tv 不命中（不许新增路径段）', `${NF}/tv`, [sub(NF)], null],
    ['U6 订阅 ?flavor=a 不命中 ?flavor=ab（不许把参数值续长）', 'https://store.steampowered.com/category/x?flavor=ab', [sub('https://store.steampowered.com/category/x?flavor=a')], null],
    ['U7 带 query 的页面走前缀轮取最长前缀（tv 而不是 top10）', `${NF}/tv?x=1`, [sub(NF), sub(`${NF}/tv`)], `${NF}/tv`],
    ['U8 订阅带 query 时可再续 &… 参数', 'https://my-drama.com/?list=best_choices&utm=x', [sub('https://my-drama.com/?list=best_choices')], 'https://my-drama.com/?list=best_choices'],
    ['U9 追加 hash 仍命中', 'https://dramashorts.io/top-movies#top', [sub('https://dramashorts.io/top-movies')], 'https://dramashorts.io/top-movies'],
    ['U10 首页订阅 + 追加非 list 参数仍命中', 'https://my-drama.com/?utm=x', [sub('https://my-drama.com/')], 'https://my-drama.com/'],
    ['U11 精确轮先于前缀轮、不受配置顺序影响', 'https://fandom.my-drama.com/?list=trending',
      [sub('https://fandom.my-drama.com/'), sub('https://fandom.my-drama.com/?list=trending')], 'https://fandom.my-drama.com/?list=trending'],
    ['U12 路径只是前缀的另一个词不命中（/fandomx）', 'https://www.shorttv.live/fandomx', [sub('https://www.shorttv.live/fandom')], null],
    ['U13 缺 tags / urlPattern 的坏配置跳过', 'https://dramashorts.io/top-movies', [{ urlPattern: 'https://dramashorts.io/top-movies' }, null, { tags: ['x'] }], null]
  ];
  for (const [name, page, subs, want] of cases) {
    const got = hit(page, subs);
    check(name, got === want, show({ page, got, want }));
  }
}

// ---------- U：订阅判定端到端（真实 content.js 走 'scrape'） ----------
{
  // 审查原场景：只订 my-drama.com/，用户在 /?list=best_choices 上点按钮，那个板块的卡以前会带着
  // 首页订阅的标签与 sourceListUrl 入库（订阅外清理也清不掉）
  const bestDocument = baseDocument({
    querySelectorAll: sel => (sel === '#best_choices [data-testid="series-section-item"]' || sel === DEFAULT_MD ? [mdItem(MD_UUID)] : [])
  });
  const { saved, response } = await runScenario({ href: 'https://my-drama.com/?list=best_choices', subscription: 'https://my-drama.com/', document: bestDocument });
  check('U20 只订首页时 /?list=best_choices 页 → 0 条（不再挂到首页订阅名下）',
    response?.success === true && saved.length === 0, show(saved.map(d => [d.itemId, d.sourceListUrl])));
}
{
  const TOP = 'https://dramashorts.io/top-movies';
  const topDocument = baseDocument({
    querySelector: sel => (sel === 'script#__NEXT_DATA__'
      ? { textContent: JSON.stringify({ props: { pageProps: { movies: [dsMovie(DS_TOP, 'Top')] } } }) } : null)
  });
  const a = await runScenario({ href: TOP, subscription: `${TOP}/`, document: topDocument });
  check('U21 订阅带尾斜杠、页面不带 → 照常命中，sourceListUrl 写订阅原串',
    show(ids(a.saved)) === show([`ds${DS_TOP}`]) && a.saved[0]?.sourceListUrl === `${TOP}/`, show(a.saved.map(d => [d.itemId, d.sourceListUrl])));
  const b = await runScenario({ href: `${TOP}/`, subscription: TOP, document: topDocument });
  check('U22 订阅不带尾斜杠、页面带 → 照常命中', show(ids(b.saved)) === show([`ds${DS_TOP}`]) && b.saved[0]?.sourceListUrl === TOP,
    show(b.saved.map(d => [d.itemId, d.sourceListUrl])));
}

// ---------- H：My Drama 条目本身不是锚点（链接在子 a 上）→ url 取规范播放页，不落到首页 ----------
{
  const fetched = [];
  const anchor = { getAttribute: n => (n === 'href' ? `/video/${MD_UUID}?from=list` : null) };
  const divItem = {
    matches: () => false,                       // 条目是外层 div
    getAttribute: () => null,                   // div 自己没有 href
    querySelector: sel => {
      if (sel === '.wp-block-post-title a, a[href]') return anchor;
      if (sel === 'h3') return { textContent: 'Wild silence' };
      return null;
    }
  };
  const { saved, response } = await runScenario({
    href: 'https://my-drama.com/',
    document: baseDocument({ querySelectorAll: sel => (sel === DEFAULT_MD ? [divItem] : []) }),
    fetch: async url => { fetched.push(url); return new Response('<html></html>', { status: 200 }); }
  });
  check('H1 条目是 div、链接在子 a 上 → url 是规范播放页 /video/<UUID>（不是首页）',
    response?.success === true && saved[0]?.itemId === `md${MD_UUID}` && saved[0]?.url === `https://my-drama.com/video/${MD_UUID}`,
    show(saved.map(d => [d.itemId, d.url])));
  check('H2 详情请求发往播放页，不去取首页（首页 og:description 会被当成简介）',
    show(fetched) === show([`https://my-drama.com/video/${MD_UUID}`]), show(fetched));
}
{
  // 去重键不是 md+UUID（hex 位数对、连字符位置不对）→ 推不出规范播放页，跳过该条
  const oddItem = { ...mdItem(MD_UUID), getAttribute: n => (n === 'href' ? 'https://my-drama.com/video/a36a7fe30e89-45ff-a409-f75093c5144f-' : null) };
  const { saved, response } = await runScenario({
    href: 'https://my-drama.com/', document: baseDocument({ querySelectorAll: sel => (sel === DEFAULT_MD ? [oddItem] : []) })
  });
  check('H3 去重键不是 md+UUID → 该条跳过（零入库、不报错）', response?.success === true && saved.length === 0, show(saved.map(d => d.url)));
}

// ---------- B：抓取按钮只建节点、改文案，样式全交给 content.css ----------
{
  const STEAM_URL = 'https://store.steampowered.com/category/visual_novel?flavor=contenthub_newandtrending';
  const json = obj => new Response(JSON.stringify(obj), { status: 200 });
  const appended = [];
  // 记录式按钮：内联样式的任何写入（含 cssText）、innerHTML 写入、注册的事件都留痕
  const recordingButton = () => {
    const styleWrites = [];
    const innerHtmlWrites = [];
    const handlers = {};
    return {
      style: new Proxy({}, { set(target, key, value) { styleWrites.push(String(key)); target[key] = value; return true; } }),
      set innerHTML(value) { innerHtmlWrites.push(value); },
      get innerHTML() { return ''; },
      textContent: '',
      disabled: false,
      id: '',
      addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
      querySelector() { return null; },
      styleWrites, innerHtmlWrites, handlers
    };
  };
  await runScenario({
    href: STEAM_URL,
    document: baseDocument({ createElement: recordingButton, body: { appendChild(node) { appended.push(node); } } }),
    fetch: async url => {
      if (url.includes('ajaxgetsaledynamicappquery')) return json({ appids: [333] });
      if (url.includes('appids=333&l=english')) return json({ 333: { success: true, data: { name: 'Button Game', short_description: 'sd', genres: [] } } });
      return json({});
    }
  });
  const btn = appended.find(node => node.id === 'dramamo-scrape-btn');
  check('B1 按钮已挂载，初始文案走 textContent', !!btn && btn.textContent === '🎬 抓取到 ShortScraping',
    show(btn && btn.textContent));
  check('B2 不写任何内联样式（cssText / transform 都不写，:hover/:active/:disabled 才不被压住）',
    !!btn && btn.styleWrites.length === 0, show(btn && btn.styleWrites));
  check('B3 不用 mouseenter / mouseleave 模拟 :hover，只挂 click', !!btn && show(Object.keys(btn.handlers)) === show(['click']),
    show(btn && Object.keys(btn.handlers)));
  if (btn && btn.handlers.click) {
    const clicking = btn.handlers.click[0]();
    check('B4 点击后立即禁用并显示「抓取中」', btn.disabled === true && btn.textContent === '⏳ 抓取中...',
      show({ disabled: btn.disabled, text: btn.textContent }));
    await within(clicking, 5000);
    // 'scrape' 消息那一轮已把 333 存进桩库，按钮这一轮是去重命中 → 新增 0 部；禁用要停 2 秒才复原
    check('B5 抓完显示新增数、仍保持禁用（2 秒后复原）', btn.textContent === '✅ 新增 0 部' && btn.disabled === true,
      show({ disabled: btn.disabled, text: btn.textContent }));
  }
  check('B6 全程没有写 innerHTML（文案都是纯文本）', !!btn && btn.innerHtmlWrites.length === 0, show(btn && btn.innerHtmlWrites));
  const css = fs.readFileSync(new URL('../src/content/content.css', import.meta.url), 'utf8');
  check('B7 content.css 自带按钮的基础 / :hover / :active / :disabled 规则（样式唯一来源）',
    ['#dramamo-scrape-btn {', '#dramamo-scrape-btn:hover {', '#dramamo-scrape-btn:active {', '#dramamo-scrape-btn:disabled {']
      .every(sel => css.includes(sel)), '');
}

// ---------- S：批次 E 清理的源码守卫——收拢过的东西不得各自回潮 ----------
{
  const count = re => [...codeOnly.matchAll(re)].length;
  const skeleton = {
    status: count(/status: 'new'/g),
    sourceListUrl: count(/sourceListUrl: window\.location\.href/g),
    translatedAt: count(/translatedAt: null/g)
  };
  check('S1 卡片骨架只有 createDramaCard 一份（新增适配器传字段即可，不再手抄 15 个键）',
    skeleton.status === 1 && skeleton.sourceListUrl === 1 && skeleton.translatedAt === 1 && /function createDramaCard\(/.test(codeOnly),
    show(skeleton));
  check('S2 HTML 解析只在 parseHtmlDocument 里 new DOMParser 一次', count(/new DOMParser\(\)/g) === 1,
    show(count(/new DOMParser\(\)/g)));
  check('S3 中文判定统一走 TranslateConfig.hasChineseChars，不再手写 /[一-鿿]/（少了扩展 A 区）',
    !/\[一-鿿\]/.test(codeOnly), '');
  check('S4 括号配对 / 轮询到稳定 / 文章长段落各只剩一个 helper',
    count(/function sliceBalanced\(/g) === 1 && !/function sliceBalancedObject\(/.test(codeOnly)
      && count(/function pollUntilStable\(/g) === 1 && count(/\.filter\(t => t\.length > 80\)/g) === 1, '');
  check('S5 与后台共用的采集口径不在 content.js 里另写（cleanGenres / fandom 前缀 / sitemap <loc> 解析都取自 ScrapeRules）',
    /= ScrapeRules;/.test(codeOnly) && !/function cleanGenres\(/.test(codeOnly)
      && !/\(mdf\|rsf\|smf\)/.test(codeOnly) && !/<loc>/.test(codeOnly), '');
}

await sleep(50);
check('Z 全程无未处理的 Promise 拒绝（超时竞争的落败方已被接住）', unhandled === 0, `unhandled=${unhandled}`);

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
