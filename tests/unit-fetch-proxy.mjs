import './bootstrap.cjs';
// 后台 fetchDetailHtml 代理消息单测（v1.5.5，tmp/ 不入库）：
// fandom 子域 content script 受页面 CORS 拦、拿不到主站播放页，由后台 SW 代理取 HTML。
// 本测验证：白名单只放 https://my-drama.com/video/<严格36位UUID> 规范形态（无 query），
// 域/协议/路径/参数越界一律拒且零网络请求；网络失败与非 2xx 均回 success:false 不抛错。
// 用法：node tests/unit-fetch-proxy.mjs
import fs from 'node:fs';
import { background } from './background-fixture.mjs';

// ---------- 后台夹具（v1.6.20 起走共用 background-fixture，不再手搓 chrome 桩） ----------
// 发送方按真实内容脚本构造（fandom 子域页面、带 tab）：fetchDetailHtml 在后台
// onMessage 的内容脚本白名单里，发送方闸门不应拦它。id 取夹具的扩展 id（本扩展自己的内容脚本）
const CONTENT_SENDER = { id: 'fixture', url: 'https://fandom.my-drama.com/', tab: { id: 7 }, frameId: 0 };

// fetch 桩：记录调用，按测试用例切换行为（后台所有请求都经它，初始化期的也不例外）
const fetchCalls = [];
let fetchBehavior = async () => ({ ok: true, status: 200, text: async () => '<html>FULL-PAGE</html>' });

// timers:'real'：P12 要让代理期限的计时器真跑（只把 25s 那一档缩成 30ms）；tick:1 保持手搓桩
// 「让出一拍再读写」的时序
const bg = await background({
  timers: 'real',
  storage: { tick: 1 },
  fetch: async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    return fetchBehavior(url, options);
  }
});
const bgSrc = fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(150); // 等后台顶层初始化落定
fetchCalls.length = 0; // 丢弃初始化期的 fetch（远端版本检查等）

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const ask = (url) => bg.send({ action: 'fetchDetailHtml', url }, CONTENT_SENDER);

const GOOD = 'https://my-drama.com/video/a36a7fe3-0e89-45ff-a409-f75093c5144f';

// P1 合法 URL：透传 html，且请求带 Accept: text/html
{
  fetchCalls.length = 0;
  const resp = await ask(GOOD);
  check('P1 合法播放页 URL → success + html 透传',
    resp?.success === true && resp?.html === '<html>FULL-PAGE</html>',
    JSON.stringify(resp));
  check('P1b 代理请求带 Accept: text/html（命中完整页的关键头）',
    fetchCalls.length === 1 && fetchCalls[0].url === GOOD && fetchCalls[0].options?.headers?.Accept === 'text/html',
    JSON.stringify(fetchCalls));
}

// P2-P4 白名单拒绝面：域 / 协议 / 路径与参数形态，全部零网络
{
  const badUrls = [
    'https://evil.com/video/a36a7fe3-0e89-45ff-a409-f75093c5144f',           // 其他域
    'https://fandom.my-drama.com/video/a36a7fe3-0e89-45ff-a409-f75093c5144f', // 子域不放（子域页面本就同源可自取）
    'http://my-drama.com/video/a36a7fe3-0e89-45ff-a409-f75093c5144f',        // http 降级
    'https://my-drama.com/video/not-a-uuid',                                  // 非 UUID
    `${GOOD}?from=proxy`,                                                     // 带 query（库内 url 均为剥参规范形态）
    'https://my-drama.com/profile/a36a7fe3-0e89-45ff-a409-f75093c5144f',      // 非 /video/ 路径
    'https://my-drama.com.evil.com/video/a36a7fe3-0e89-45ff-a409-f75093c5144f', // 前缀伪装域
    12345, null, undefined                                                    // 非字符串
  ];
  fetchCalls.length = 0;
  const rejections = [];
  for (const u of badUrls) rejections.push(await ask(u));
  check('P2 白名单拒绝面全拒（域/子域/协议/路径/query/伪装域/非字符串）',
    rejections.every(r => r && r.success === false),
    JSON.stringify(rejections));
  check('P3 拒绝路径零网络请求', fetchCalls.length === 0, `fetchCalls=${fetchCalls.length}`);
}

// P5 网络异常 → success:false 不抛错
{
  fetchBehavior = async () => { throw new TypeError('unit stub: network down'); };
  const resp = await ask(GOOD);
  check('P5 网络异常 → success:false 不抛错', resp?.success === false, JSON.stringify(resp));
}

// P6 非 2xx → success:false
{
  fetchBehavior = async () => ({ ok: false, status: 404, text: async () => '' });
  const resp = await ask(GOOD);
  check('P6 非 2xx 响应 → success:false', resp?.success === false, JSON.stringify(resp));
}

// P7 Netflix 详情页规则（v1.5.9）：/title/<videoId> 合法 URL 透传 html，请求头强制英文
//（coreGenre 类型名随 Accept-Language 本地化，zh-CN 会得到中文）
const NF_GOOD = 'https://www.netflix.com/title/81278442';
{
  fetchBehavior = async () => ({ ok: true, status: 200, text: async () => '<html>NF-TITLE</html>' });
  fetchCalls.length = 0;
  const resp = await ask(NF_GOOD);
  const headers = fetchCalls[0]?.options?.headers || {};
  check('P7 Netflix /title/<videoId> → success + html 透传',
    resp?.success === true && resp?.html === '<html>NF-TITLE</html>', JSON.stringify(resp));
  check('P7b Netflix 代理请求带 Accept: text/html 且 Accept-Language 以 en 开头',
    fetchCalls.length === 1 && fetchCalls[0].url === NF_GOOD && headers.Accept === 'text/html' && /^en/.test(String(headers['Accept-Language'])),
    JSON.stringify(fetchCalls));
}

// P8 Netflix 白名单拒绝面：协议 / 非数字 id / 非 title 路径 / 无 www / 伪装域 / query / 短 id，全部零网络
{
  fetchCalls.length = 0;
  const bad = [
    'http://www.netflix.com/title/81278442',
    'https://www.netflix.com/title/abc',
    'https://www.netflix.com/tudum/top10',
    'https://netflix.com/title/81278442',
    'https://www.netflix.com.evil.com/title/81278442',
    `${NF_GOOD}?trkid=1`,
    'https://www.netflix.com/title/8127'
  ];
  const rejections = [];
  for (const u of bad) rejections.push(await ask(u));
  check('P8 Netflix 拒绝面全拒', rejections.every(r => r && r.success === false), JSON.stringify(rejections));
  check('P8b Netflix 拒绝路径零网络请求', fetchCalls.length === 0, `fetchCalls=${fetchCalls.length}`);
}

// P9 my-drama 规则不带 Accept-Language（MyDrama 详情的本地化标题/简介语义依赖浏览器语言，勿动）
{
  fetchCalls.length = 0;
  await ask(GOOD);
  check('P9 my-drama 代理请求不带 Accept-Language',
    fetchCalls.length === 1 && !('Accept-Language' in (fetchCalls[0].options?.headers || {})),
    JSON.stringify(fetchCalls[0]?.options));
}

// P10 Apple TV 两条规则（v1.5.10）：榜单 collection 页与 /us/show|movie/ 详情页都放行、都强制英文
//（Apple 页面恒英文，显式钉死；榜单也走代理是因为 SSR 数据脚本 hydrate 后会被删出 DOM）
const ATV_LIST = 'https://tv.apple.com/us/collection/most-popular-now/uts.col.ChartsShows.tvs.sbd.4000';
const ATV_SHOW = 'https://tv.apple.com/us/show/your-friends--neighbors/umc.cmc.74o37kzay0yuuub8iumddjsg';
const ATV_MOVIE = 'https://tv.apple.com/us/movie/the-gorge/umc.cmc.26o403koqo2klixc0jtqy6tmc';
{
  fetchBehavior = async () => ({ ok: true, status: 200, text: async () => '<html>ATV</html>' });
  for (const [label, url] of [['榜单页', ATV_LIST], ['剧集详情', ATV_SHOW], ['电影详情', ATV_MOVIE]]) {
    fetchCalls.length = 0;
    const resp = await ask(url);
    const headers = fetchCalls[0]?.options?.headers || {};
    check(`P10 Apple ${label} → success + html 透传，且请求头 Accept: text/html + 英文 Accept-Language`,
      resp?.success === true && resp?.html === '<html>ATV</html>'
      && fetchCalls.length === 1 && fetchCalls[0].url === url
      && headers.Accept === 'text/html' && /^en/.test(String(headers['Accept-Language'])),
      JSON.stringify({ resp, calls: fetchCalls }));
  }
}

// P11 Apple 拒绝面：协议 / 非 us 区 / 其他 apple 子域 / 非榜单 collection / query / 非 umc id /
//     播放与浏览路径 / 伪装域，全部零网络
{
  fetchCalls.length = 0;
  const bad = [
    'http://tv.apple.com/us/collection/most-popular-now/uts.col.ChartsShows.tvs.sbd.4000',
    'https://tv.apple.com/gb/collection/most-popular-now/uts.col.ChartsShows.tvs.sbd.4000',
    'https://www.apple.com/us/show/ted-lasso/umc.cmc.vtoh0mn0xn7t3c643xqonfzy',
    'https://tv.apple.com/us/collection/most-popular-now/uts.col.Editorial.tvs.sbd.4000',
    `${ATV_LIST}?ctx_cvs=uts.tcvs.tv-plus-canvas`,
    `${ATV_SHOW}?ctx_agid=502c9996`,
    'https://tv.apple.com/us/show/ted-lasso/umc.cmc.',
    'https://tv.apple.com/us/show/ted-lasso/tt0123456',
    'https://tv.apple.com/us/episode/pilot/umc.cmc.abc123',
    'https://tv.apple.com/',
    'https://tv.apple.com.evil.com/us/show/x/umc.cmc.abc123'
  ];
  const rejections = [];
  for (const u of bad) rejections.push(await ask(u));
  check('P11 Apple 拒绝面全拒', rejections.every(r => r && r.success === false), JSON.stringify(rejections));
  check('P11b Apple 拒绝路径零网络请求', fetchCalls.length === 0, `fetchCalls=${fetchCalls.length}`);
}

// P12 代理请求期限（审查 no-fetch-timeout-hangs-scrape-queue）：内容脚本等代理回复不设期限，
//     这里挂住＝那一页的抓取跟着挂住。期限 25 秒、正文读完才算完；超时 abort 底层请求并回
//     success:false。测试里只把这一个延时缩成 30ms 真定时器
{
  // 期限值从源码读：钉住声明处的字面量
  const proxyTimeoutMs = Number(bgSrc.match(/const DETAIL_HTML_PROXY_TIMEOUT_MS = (\d+);/)?.[1]);
  check('P12a 代理期限为 25 秒（与内容脚本 fetchWithTimeout 同口径）', proxyTimeoutMs === 25000, String(proxyTimeoutMs));
  // 后台跑在夹具的 vm 上下文里，按名解析的是上下文全局的 setTimeout：只替换那一份
  const realSetTimeout = bg.context.setTimeout;
  bg.context.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 25000 ? 30 : ms, ...args);
  const within = (promise, ms = 1500) => Promise.race([promise, sleep(ms).then(() => 'hung')]);
  try {
    // 响应头回了、正文永远不发完
    let signal = null;
    fetchBehavior = async (_url, options) => {
      signal = options?.signal || null;
      return { ok: true, status: 200, text: () => new Promise(() => {}) };
    };
    const bodyHang = await within(ask(GOOD));
    check('P12b 正文迟迟不发完 → 按时回 success:false（带超时原因）',
      bodyHang?.success === false && /超时/.test(bodyHang?.error || ''), JSON.stringify(bodyHang));
    check('P12c 请求带 abort 信号，超时即中止底层请求', Boolean(signal) && signal.aborted === true,
      `signal=${Boolean(signal)} aborted=${signal?.aborted}`);

    // 连接挂住、fetch 本身不理会 abort 信号也不 resolve
    fetchBehavior = () => new Promise(() => {});
    const connectHang = await within(ask(GOOD));
    check('P12d fetch 本身挂住且不理会 abort → 仍按时回 success:false',
      connectHang?.success === false && /超时/.test(connectHang?.error || ''), JSON.stringify(connectHang));

    // 期限内正常返回不受影响
    fetchBehavior = async () => ({ ok: true, status: 200, text: async () => '<html>IN-TIME</html>' });
    const inTime = await within(ask(GOOD));
    check('P12e 期限内读完的响应照常透传', inTime?.success === true && inTime?.html === '<html>IN-TIME</html>', JSON.stringify(inTime));
  } finally {
    bg.context.setTimeout = realSetTimeout;
  }
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
