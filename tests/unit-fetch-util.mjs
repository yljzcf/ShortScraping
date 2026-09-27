import './bootstrap.cjs';
// 带期限的 fetch（src/shared/fetch-util.js，v1.7.0 审查 H1）。
//
// 起因：translator.js / lark.js 各写一份 fetchWithTimeout，fetch() 交出响应头就 clearTimeout，之后的
// response.json() / blob() 没有期限。DeepSeek 这类接口高负载时先回 200 头、再迟迟不发正文，翻译轮开着
// SW 保活，一批卡住整轮就永久挂住（弹窗一直「翻译中」、CSV 推送一直被节流），直到重载扩展；设置页的
// trySyncConfig 更是没有期限。现在三处都走 FetchUtil.fetchWithDeadline：期限连正文一起算。
//
//   U 组：模块本身（Node require、不碰 chrome、只导出 fetchWithDeadline）。
//   T 组：行为矩阵——正文卡住 / 响应头不来都按时 TimeoutError 并 abort；正常响应 text/json/blob/arrayBuffer
//        可重复读；非 2xx 不抛；网络错误原样；正文中途出错留到取正文时再抛；测试桩原样放行；外部 signal 联动。
//   W 组：接线守卫——translator / lark / 设置页不再手写 AbortController，内容脚本仍用自己那份。
//   E 组：端到端——真实 Translator / Lark 遇到卡住的正文按期失败；后台翻译轮在 requestTimeoutSec 后收尾、
//        卡片保持待翻译、保活计时器不残留（H1 的原始场景）。
// 用法：node tests/unit-fetch-util.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { background, card } from './background-fixture.mjs';

const require = createRequire(import.meta.url);
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);
const readSource = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
// 去掉注释再做源码守卫：注释里提到函数名不算用到
const codeOnly = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

let unhandled = 0;
process.on('unhandledRejection', (e) => { unhandled++; console.error('UNHANDLED:', e?.message || e); });

const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

const realSetTimeout = globalThis.setTimeout;
const sleep = ms => new Promise(r => realSetTimeout(r, ms));
/** 给 promise 套外部期限：修复前挂住的用例在这里判 FAIL，而不是把整个套件挂死。 */
const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => 'TIMED_OUT')]);

/** 响应头立即到达、正文永远不发完的 Response（ignoreAbort=false 时按规范随 abort 报错）。 */
function hangingBodyResponse(signal, { ignoreAbort = true, type = 'application/json' } = {}) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"choices":[{"mess'));
      if (!ignoreAbort && signal) signal.addEventListener('abort', () => controller.error(signal.reason));
    }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': type } });
}

/** 正文读到一半就出错的 Response（非超时的读取失败）。 */
function brokenBodyResponse(error) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"half'));
      queueMicrotask(() => controller.error(error));
    }
  });
  return new Response(body, { status: 200 });
}

/** 期间把 globalThis.fetch 换成 impl。 */
async function withFetch(impl, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = saved; }
}

/** 期间把 ≥5 秒的定时器缩成 5ms：translator 的超时下限就是 5 秒，真等太慢。 */
async function withFastTimers(fn) {
  const saved = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...args) => saved(cb, Number(ms) >= 5000 ? 5 : ms, ...args);
  try { return await fn(); } finally { globalThis.setTimeout = saved; }
}

// ============ U 组：模块本身 ============
let FetchUtil = null;
{
  let loadError = null;
  try { FetchUtil = require('../src/shared/fetch-util.js'); } catch (e) { loadError = e; }
  check('U1 Node 里 require 成功并导出 fetchWithDeadline', typeof FetchUtil?.fetchWithDeadline === 'function',
    loadError ? loadError.message : show(Object.keys(FetchUtil || {})));
  const src = readSource('../src/shared/fetch-util.js');
  check('U2 源码不含 chrome.（四端共用，不碰扩展 API）', !codeOnly(src).includes('chrome.'), '');
  check('U3 只导出 fetchWithDeadline', show(Object.keys(FetchUtil || {})) === '["fetchWithDeadline"]', show(Object.keys(FetchUtil || {})));
  check('U4 bootstrap 预载（逐个 eval lark / translator 的套件靠全局 FetchUtil）',
    readSource('./bootstrap.cjs').includes("require('../src/shared/fetch-util.js')") && globalThis.FetchUtil === FetchUtil, '');
}

// ============ T 组：行为矩阵 ============
if (FetchUtil) {
  const { fetchWithDeadline } = FetchUtil;
  const opts = (ms = 60, timeoutMessage = '请求超时（测试）') => ({ timeoutMs: ms, timeoutMessage });

  {
    let seenSignal = null;
    const started = Date.now();
    const outcome = await withFetch(async (url, init) => { seenSignal = init.signal; return hangingBodyResponse(init.signal); },
      () => within(fetchWithDeadline('https://x.test/a', {}, opts()).then(() => 'RESOLVED', e => e), 2000));
    const elapsed = Date.now() - started;
    check('T1 响应头到了、正文永不完（桩不理会 abort）→ 按时 TimeoutError，不挂住',
      outcome instanceof Error && outcome.name === 'TimeoutError' && elapsed < 1000, show({ outcome: String(outcome), elapsed }));
    check('T2 超时文案用调用方给的 timeoutMessage', outcome?.message === '请求超时（测试）', show(outcome?.message));
    check('T3 超时同时 abort 底层请求', seenSignal?.aborted === true, show(seenSignal?.aborted));
  }
  {
    const outcome = await withFetch(async (url, init) => hangingBodyResponse(init.signal, { ignoreAbort: false }),
      () => within(fetchWithDeadline('https://x.test/b', {}, opts()).then(() => 'RESOLVED', e => e), 2000));
    check('T4 正文流随 abort 报错的规范实现 → 同样是 TimeoutError（不是 AbortError）',
      outcome instanceof Error && outcome.name === 'TimeoutError', show(String(outcome)));
  }
  {
    const outcome = await withFetch(() => new Promise(() => {}),
      () => within(fetchWithDeadline('https://x.test/c', {}, opts()).then(() => 'RESOLVED', e => e), 2000));
    check('T5 连响应头都不来 → 同样按时 TimeoutError', outcome instanceof Error && outcome.name === 'TimeoutError', show(String(outcome)));
  }
  {
    const outcome = await withFetch(() => new Promise(() => {}),
      () => within(fetchWithDeadline('https://x.test/c2', {}, { timeoutMs: 40 }).then(() => 'RESOLVED', e => e), 2000));
    check('T6 不给 timeoutMessage 时默认文案含「请求超时」且不带 URL（URL 可能带密钥参数）',
      outcome?.name === 'TimeoutError' && outcome.message.includes('请求超时') && !outcome.message.includes('x.test'), show(outcome?.message));
  }
  {
    let seen = null;
    const res = await withFetch(async (url, init) => {
      seen = init;
      const r = new Response('{"k":[1,2],"s":"中文"}', { status: 201, headers: { 'Content-Type': 'image/jpeg' } });
      Object.defineProperty(r, 'url', { value: 'https://x.test/final' });
      return r;
    }, () => fetchWithDeadline('https://x.test/d', { method: 'POST', headers: { A: '1' } }, opts(80)));
    const t1 = await res.text();
    const t2 = await res.text();
    const j1 = await res.json();
    const j2 = await res.json();
    const blob = await res.blob();
    const buf = await res.arrayBuffer();
    check('T7 正常响应：ok/status/url/headers 原样，text()/json() 可重复读（正文已在期限内缓存）',
      res.ok && res.status === 201 && res.url === 'https://x.test/final' && res.headers.get('content-type') === 'image/jpeg'
        && t1 === t2 && t1 === '{"k":[1,2],"s":"中文"}' && show(j1) === show(j2) && j1.s === '中文', show({ t1, j1 }));
    check('T8 blob() 带 content-type、arrayBuffer() 字节完整（封面上传照旧可用）',
      blob instanceof Blob && blob.type === 'image/jpeg' && blob.size === Buffer.byteLength(t1) && buf.byteLength === blob.size,
      show({ type: blob?.type, size: blob?.size, bytes: buf?.byteLength }));
    check('T9 调用方的 method/headers 原样透传，另加 signal', seen?.method === 'POST' && seen?.headers?.A === '1' && seen?.signal instanceof AbortSignal, '');
    await sleep(120);
    check('T10 成功返回后计时器已清除（越过期限也不 abort）', seen?.signal?.aborted === false, '');
  }
  {
    const res = await withFetch(async () => new Response('﻿{"bom":true}', { status: 200 }),
      () => fetchWithDeadline('https://x.test/bom', {}, opts()));
    check('T11 text() 按 UTF-8 解码并去 BOM（与 Response.text() 一致），json() 随之可解析',
      (await res.json()).bom === true, '');
  }
  {
    const res = await withFetch(async () => new Response('bad gateway', { status: 502 }),
      () => fetchWithDeadline('https://x.test/e', {}, opts()));
    check('T12 非 2xx 照常返回（不抛），调用方按 ok=false 走原分支',
      res.ok === false && res.status === 502 && await res.text() === 'bad gateway', show({ status: res.status }));
  }
  {
    const boom = new TypeError('Failed to fetch');
    const outcome = await withFetch(async () => { throw boom; },
      () => fetchWithDeadline('https://x.test/f', {}, opts()).then(() => 'RESOLVED', e => e));
    check('T13 响应头之前的网络错误原样抛出（不被改写成超时）', outcome === boom, show(String(outcome)));
  }
  {
    const broken = new Error('stream broke');
    const res = await withFetch(async () => brokenBodyResponse(broken),
      () => fetchWithDeadline('https://x.test/g', {}, opts()).then(r => r, e => e));
    const textOutcome = res instanceof Error ? res : await res.text().then(() => 'RESOLVED', e => e);
    const jsonOutcome = res instanceof Error ? res : await res.json().then(() => 'RESOLVED', e => e);
    check('T14 正文中途出错（非超时）：fetchWithDeadline 照常返回，错误留到 text()/json() 时再抛（各调用点的 .catch 照旧）',
      !(res instanceof Error) && textOutcome === broken && jsonOutcome === broken, show({ res: String(res), text: String(textOutcome) }));
  }
  {
    const stub = { ok: true, status: 200, json: async () => ({ only: 'json' }) };
    const res = await withFetch(async () => stub, () => fetchWithDeadline('https://x.test/h', {}, opts()));
    check('T15 只实现 json() 的测试桩原样交回（同一对象，不预读）', res === stub && (await res.json()).only === 'json', '');
    const textStub = { ok: true, status: 200, text: async () => '{"t":1}' };
    const res2 = await withFetch(async () => textStub, () => fetchWithDeadline('https://x.test/i', {}, opts()));
    check('T16 只实现 text() 的桩在期限内预读：text() 可重复读、json() 由缓存解析',
      await res2.text() === '{"t":1}' && await res2.text() === '{"t":1}' && (await res2.json()).t === 1, '');
    const stalledTextStub = { ok: true, status: 200, text: () => new Promise(() => {}) };
    const outcome = await withFetch(async () => stalledTextStub,
      () => within(fetchWithDeadline('https://x.test/j', {}, opts()).then(() => 'RESOLVED', e => e), 2000));
    check('T17 只实现 text() 的桩正文卡住 → 同样按时 TimeoutError', outcome?.name === 'TimeoutError', show(String(outcome)));
  }
  {
    const reason = new Error('caller cancelled');
    const pre = new AbortController();
    pre.abort(reason);
    const early = await withFetch(async (url, init) => { if (init.signal.aborted) throw init.signal.reason; return new Response('x'); },
      () => within(fetchWithDeadline('https://x.test/k', { signal: pre.signal }, opts(5000)).then(() => 'RESOLVED', e => e), 2000));
    check('T18 调用方传入已 abort 的 signal → 立即按其原因拒绝', early === reason, show(String(early)));
    const later = new AbortController();
    let seenSignal = null;
    const pending = withFetch(async (url, init) => { seenSignal = init.signal; return hangingBodyResponse(init.signal); },
      () => within(fetchWithDeadline('https://x.test/l', { signal: later.signal }, opts(5000)).then(() => 'RESOLVED', e => e), 2000));
    await sleep(20);
    later.abort(reason);
    const outcome = await pending;
    check('T19 读正文途中调用方 abort → 按调用方原因拒绝，底层请求随之 abort', outcome === reason && seenSignal?.aborted === true,
      show({ outcome: String(outcome), aborted: seenSignal?.aborted }));
  }
}

// ============ W 组：接线守卫 ============
{
  const translatorSrc = codeOnly(readSource('../src/shared/translator.js'));
  const larkSrc = codeOnly(readSource('../src/shared/lark.js'));
  const settingsSrc = codeOnly(readSource('../src/settings/settings.js'));
  const contentSrc = codeOnly(readSource('../src/content/content.js'));
  check('W1 translator.js / lark.js 不再手写 AbortController，fetchWithTimeout 委托 FetchUtil.fetchWithDeadline',
    !/new AbortController/.test(translatorSrc) && !/new AbortController/.test(larkSrc)
      && /FetchUtil\.fetchWithDeadline\(/.test(translatorSrc) && /FetchUtil\.fetchWithDeadline\(/.test(larkSrc), '');
  check('W2 两个模块都按 UMD 惯例解析依赖（Node require / 浏览器全局）',
    [translatorSrc, larkSrc].every(s => s.includes("require('./fetch-util.js')") && s.includes('global.FetchUtil')), '');
  check('W3 超时文案沿用原样「请求超时（N秒）」',
    [translatorSrc, larkSrc].every(s => s.includes('timeoutMessage: `请求超时（${Math.round(timeoutMs / 1000)}秒）`')), '');
  check('W4 设置页写回与健康检查走 FetchUtil', (settingsSrc.match(/FetchUtil\.fetchWithDeadline\(/g) || []).length >= 2, '');
  check('W5 内容脚本不依赖 FetchUtil（manifest 注入清单里没有它，仍用自己的 fetchWithTimeout）',
    !/FetchUtil\./.test(contentSrc) && /async function fetchWithTimeout\(/.test(contentSrc), '');
}

// ============ E 组：端到端 ============
{
  const Translator = require('../src/shared/translator.js');
  const outcome = await withFastTimers(() => withFetch(async (url, init) => hangingBodyResponse(init.signal),
    () => within(Translator.translateBatchAI([{ title: 'A', desc: 'a' }],
      { translateMode: 'ai', aiEndpoint: 'https://ai.test/v1', aiApiKey: 'k', requestTimeoutSec: 60 }).then(() => 'RESOLVED', e => e), 3000)));
  check('E1 Translator.translateBatchAI：AI 接口正文卡住 → 抛「请求超时（60秒）」（以前永久挂住）',
    outcome instanceof Error && outcome.message === '请求超时（60秒）', show(String(outcome)));
}
{
  const Lark = require('../src/shared/lark.js');
  const drama = { id: 'x1', title: 'T', titleZh: '中', description: 'd', descriptionZh: '中文简介', tags: ['IMDB'], source: 'imdb', url: 'https://www.imdb.com/title/tt1/' };
  const outcome = await withFastTimers(() => withFetch(async (url, init) => hangingBodyResponse(init.signal),
    () => within(Lark.pushBotCard({ botWebhookUrl: 'https://bot.test/hook', botEnabled: true }, drama).then(() => 'RESOLVED', e => e), 3000)));
  check('E2 Lark.pushBotCard：机器人 webhook 正文卡住 → 抛「请求超时（15秒）」',
    outcome instanceof Error && outcome.message === '请求超时（15秒）', show(String(outcome)));

  Lark.__resetTokenCache();
  const posts = [];
  const coverDrama = { ...drama, poster: 'https://m.media-amazon.com/images/M/abc._V1_QL75_UY133_.jpg' };
  const pushed = await withFastTimers(() => withFetch(async (url, init) => {
    const u = String(url);
    if (u.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'tok', expire: 7200 });
    if (u.includes('media-amazon')) return hangingBodyResponse(init.signal, { type: 'image/jpeg' });
    if (u.includes('/im/v1/images')) return Response.json({ code: 0, data: { image_key: 'should-not-happen' } });
    posts.push(JSON.parse(init.body));
    return Response.json({ code: 0, msg: 'success' });
  }, () => within(Lark.pushBotCard({ botWebhookUrl: 'https://bot.test/hook', botEnabled: true, feishuAppId: 'a', feishuAppSecret: 's' }, coverDrama)
    .then(r => r, e => e), 3000)));
  check('E3 封面图正文卡住 → 上传降级为 null，卡片照发（无图）',
    pushed?.success === true && posts.length === 1 && !JSON.stringify(posts[0]).includes('should-not-happen'),
    show({ pushed: String(pushed?.message || pushed?.success), posts: posts.length }));
}
{
  // H1 的原始场景：后台翻译轮（真实 translator，可控时钟），AI 接口回了头、正文永不完
  const SUB = 'https://www.imdb.com/search/title/';
  const bg = await background({
    timers: 'manual',
    fetch: (url, options) => (String(url).startsWith('https://ai.test/') ? Promise.resolve(hangingBodyResponse(options?.signal)) : undefined)
  });
  // 开机回读 config/trans.json（夹具回 {}）会把配置归一成默认 API 模式：开机落定后再种 AI 配置与卡片
  await bg.resetDramasCache();
  bg.storage.seed({
    urlTags: [{ urlPattern: SUB, tags: ['IMDB'] }],
    translateConfig: { translateMode: 'ai', aiEndpoint: 'https://ai.test/v1', aiApiKey: 'k', batchSize: 10, delayMs: 0, requestTimeoutSec: 60 }
  });
  bg.seedDramas([card('tt-h1', { id: 'h1', description: 'desc', titleZh: '', descriptionZh: '' })]);
  let summary = 'PENDING';
  const run = bg.context.performTranslate({ source: 'manual' }).then(s => { summary = s; });
  for (let i = 0; i < 10 && summary === 'PENDING'; i++) await bg.timers.advance(10000);
  await within(run, 2000);
  const h1 = bg.dramas().find(d => d.id === 'h1');
  const keepAlives = bg.timers.pending().filter(t => t.delay === 20000);
  check('E4a 翻译轮在 requestTimeoutSec 后收尾（不再永久挂住），summary.error 带超时原因',
    summary !== 'PENDING' && /请求超时（60秒）/.test(String(summary?.error || '')), show(summary));
  check('E4b 超时按通道故障处理：卡片保持 new、不计 translateAttempts、不写译文',
    h1?.status === 'new' && !h1?.translateAttempts && !h1?.titleZh, show(h1 && { status: h1.status, attempts: h1.translateAttempts }));
  check('E4c 保活计时器随本轮结束清掉，translateRunState 不再是 running',
    keepAlives.length === 0 && bg.data.translateRunState?.running === false,
    show({ keepAlives, runState: bg.data.translateRunState }));
}

await sleep(50);
check('Z 全程无未处理的 Promise 拒绝（超时竞争的落败方已被接住）', unhandled === 0, `unhandled=${unhandled}`);

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
