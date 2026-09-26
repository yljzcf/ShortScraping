import './bootstrap.cjs';
// 局域网共享页 server/public/share.js 的拉取调度回归测试（v1.6.21，share.js 的第一个单测）。
//
// 背景：旧写法打开页面就整表拉两次——init 拉一次，SSE 连上即发的首帧因 state.version 仍是 -1 又拉一次；
// 拉取没有在途守卫，拉取期间每来一帧 SSE 就再并发一次整表请求；每次响应都整表 JSON 解析、整页重渲染。
// 现在三个入口（打开页面、SSE 版本通告、回到前台）都经 requestTimeline：
//   P1 打开页面只拉 1 次：首帧撞上在途的首次拉取、或拉完才到，都不再重拉；请求带 cache:'no-cache'。
//   P2 在途期间连来两帧新版本：只补拉 1 次；补拉拿到的就是通告版本时不再追加。
//   P3 响应 ETag 与上次渲染的相同（浏览器 304 转成的缓存体）：不解析 JSON、不重渲染，丢弃响应体。
//   P4 回到前台：空闲时拉 1 次、在途时复用；hidden 时不拉。SSE 通告已渲染的版本不拉，坏帧按未知版本拉。
//   P5 在途拉取失败：通告过的新版本在拉完后补拉 1 次，页面恢复；失败后同一 ETag 的响应也重渲染（状态栏换回统计）。
//   P6 SSE 被拦（EventSource 从不出帧）时首次拉取照样发生。
// 页面在 vm 里跑真实的 share.js；DOM 用 tests/dom-fixture.mjs 的元素树（share.js 的 querySelector /
// getElementById 真走选择器），fetch、EventSource、TimelineRender、SiteTabs 为桩。
// 用法：node tests/unit-share-page.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { el } from './dom-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARE_JS = fs.readFileSync(path.join(ROOT, 'server/public/share.js'), 'utf8');

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
// 让 fetch 桩兑现后的 await 链（requestTimeline → loadTimeline → response.json → render）走完
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

// share.html 的骨架（只留 share.js 用到的节点）。dom-fixture 的元素只读，share.js 还要写 textContent、
// 切 classList、setAttribute：按需补在实例上
function shareDocument() {
  const root = el('body', {}, [
    el('div', { class: 'app' }, [
      el('header', { class: 'header' }, [
        el('div', { class: 'category-tabs', id: 'categoryTabs' }),
        el('div', { class: 'header-actions' }, [el('span', { class: 'live-dot', id: 'liveDot' })])
      ]),
      el('main', { class: 'content' }, [
        el('div', { class: 'timeline-container' }),
        el('div', { id: 'emptyState', class: 'empty-state hidden' })
      ]),
      el('footer', { class: 'footer' }, [
        el('span', { id: 'statusText' }, [], '连接中…'),
        el('span', { id: 'statsTotal' }, [], '0 部'),
        el('span', { id: 'statsLastUpdate' }, [], '未更新')
      ])
    ])
  ]);
  for (const node of [root, ...root.descendants()]) {
    Object.defineProperty(node, 'textContent', { value: node.ownText, writable: true });
    node.setAttribute = (name, value) => { node.attrs[name] = String(value); };
    node.classList = {
      contains: name => String(node.attrs.class || '').split(/\s+/).includes(name),
      toggle(name, force) {
        const set = new Set(String(node.attrs.class || '').split(/\s+/).filter(Boolean));
        const on = force === undefined ? !set.has(name) : !!force;
        if (on) set.add(name); else set.delete(name);
        node.attrs.class = [...set].join(' ');
        return on;
      }
    };
  }
  const listeners = {};
  return {
    hidden: false,
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type) { for (const fn of listeners[type] || []) fn({ type }); },
    querySelector: selector => root.querySelector(selector),
    getElementById: id => root.querySelector(`[id="${id}"]`)
  };
}

/** 打开一页：跑 share.js、派发 DOMContentLoaded。返回可观测的桩与操纵手柄。 */
function openPage({ eventSource = true } = {}) {
  const page = { fetches: [], sources: [], renders: [], jsonCalls: 0, cancels: 0, errors: [] };
  const document = shareDocument();
  page.document = document;

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      page.sources.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(data) {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      for (const fn of this.listeners.update || []) fn({ data: text });
    }
  }

  const context = vm.createContext({
    document,
    window: { open() {} },
    console: { log() {}, warn() {}, error: (...args) => page.errors.push(args.map(String).join(' ')) },
    fetch: (url, init) => new Promise((resolve, reject) => page.fetches.push({ url, init, resolve, reject })),
    EventSource: eventSource ? FakeEventSource : class { addEventListener() {} },
    TimelineRender: {
      CATEGORY_SOURCES: ['imdb', 'reelshort'],
      dramaSource: drama => (drama.source === 'reelshort' ? 'reelshort' : 'imdb'),
      renderTimeline: (container, visible, opts) => { page.renders.push({ count: visible.length, source: opts.source }); return visible.length > 0; },
      formatRelativeTime: () => '刚刚'
    },
    SiteTabs: {
      resolveLayout: ({ activeSource }) => ({ activeSource: activeSource || 'imdb' }),
      latestUpdateBySite: () => ({}),
      render() {}
    }
  });
  vm.runInContext(SHARE_JS, context, { filename: 'server/public/share.js' });
  document.fire('DOMContentLoaded');

  page.sse = () => page.sources[page.sources.length - 1];
  // 兑现第 i 次 fetch：version / etag / 条数可控；ETag 为 null 时不带该头
  page.respond = async (i, { version, etag = `W/"${'a'.repeat(16)}-${version}"`, rows = 1 }) => {
    const dramas = Array.from({ length: rows }, (_, n) => ({ id: `id${n}`, itemId: `tt${n}`, source: 'imdb', status: 'new', scrapedAt: '' }));
    page.fetches[i].resolve({
      ok: true,
      status: 200,
      headers: { get: name => (name.toLowerCase() === 'etag' ? etag : null) },
      json: async () => { page.jsonCalls++; return { ok: true, version, updatedAt: null, dramas }; },
      body: { cancel: async () => { page.cancels++; } }
    });
    await settle();
  };
  page.fail = async (i) => {
    page.fetches[i].reject(new TypeError('Failed to fetch'));
    await settle();
  };
  page.statusText = () => document.getElementById('statusText').textContent;
  return page;
}

// ---------- P1 打开页面只拉 1 次 ----------
{
  const page = openPage();
  const beforeFrame = page.fetches.length;
  page.sse().emit({ version: 3 });                 // 首帧撞上在途的首次拉取
  await settle();
  const whileInFlight = page.fetches.length;
  await page.respond(0, { version: 3 });
  check('P1a 打开页面（首帧在首次拉取途中到达）全程只拉 1 次', beforeFrame === 1 && whileInFlight === 1 && page.fetches.length === 1,
    JSON.stringify({ beforeFrame, whileInFlight, total: page.fetches.length }));
  check('P1b 拉的是 /api/timeline，带 cache:\'no-cache\'（条件请求，服务端可回 304）',
    page.fetches[0].url === '/api/timeline' && page.fetches[0].init?.cache === 'no-cache', JSON.stringify(page.fetches[0].init));
  check('P1c 渲染 1 次，SSE 连接照常建立', page.renders.length === 1 && page.sources.length === 1 && page.sse().url === '/api/events',
    JSON.stringify(page.renders));

  const late = openPage();
  await late.respond(0, { version: 5 });
  late.sse().emit({ version: 5 });                 // 首帧在首次拉取完成之后才到
  await settle();
  check('P1d 首帧在首次拉取完成后才到、版本相同：不再重拉', late.fetches.length === 1 && late.renders.length === 1,
    JSON.stringify({ fetches: late.fetches.length, renders: late.renders.length }));
}

// ---------- P2 在途期间连来两帧：只补拉 1 次 ----------
{
  const page = openPage();
  page.sse().emit({ version: 7 });
  page.sse().emit({ version: 8 });                 // 首次拉取途中又来两帧，且都比它拿到的新
  await settle();
  const whileInFlight = page.fetches.length;
  await page.respond(0, { version: 6 });
  const afterFirst = page.fetches.length;
  await page.respond(1, { version: 8 });
  check('P2a 首次拉取途中来两帧新版本：途中不并发，拉完只补拉 1 次', whileInFlight === 1 && afterFirst === 2 && page.fetches.length === 2,
    JSON.stringify({ whileInFlight, afterFirst, total: page.fetches.length }));
  check('P2b 补拉拿到通告的版本后不再追加，两次各渲染一次', page.renders.length === 2, JSON.stringify(page.renders));

  // 空闲后来一帧开拉，途中再来两帧：同样只补拉 1 次
  page.sse().emit({ version: 9 });
  await settle();
  page.sse().emit({ version: 10 });
  page.sse().emit({ version: 11 });
  await settle();
  const midway = page.fetches.length;
  await page.respond(2, { version: 9 });
  await page.respond(3, { version: 11 });
  check('P2c 空闲时收到新版本立即拉；途中再来两帧只补拉 1 次', midway === 3 && page.fetches.length === 4 && page.renders.length === 4,
    JSON.stringify({ midway, total: page.fetches.length, renders: page.renders.length }));
}

// ---------- P3 ETag 相同：不解析、不重渲染 ----------
{
  const page = openPage();
  const etag = `W/"${'b'.repeat(16)}-4"`;
  await page.respond(0, { version: 4, etag, rows: 3 });
  const jsonAfterFirst = page.jsonCalls;
  page.sse().emit({ version: 5 });                 // 版本通告变了，但响应还是同一份内容（如代理缓存 / 浏览器 304）
  await settle();
  await page.respond(1, { version: 4, etag, rows: 3 });
  check('P3a 响应 ETag 与上次渲染的相同：不解析 JSON、不重渲染', page.fetches.length === 2 && page.renders.length === 1
    && page.jsonCalls === jsonAfterFirst && jsonAfterFirst === 1, JSON.stringify({ renders: page.renders.length, json: page.jsonCalls }));
  check('P3b 未读的响应体被丢弃（不留着整表下载）', page.cancels === 1, String(page.cancels));

  page.document.fire('visibilitychange');          // hidden 缺省 false＝回到前台
  await settle();
  await page.respond(2, { version: 4, etag, rows: 3 });
  check('P3c 回到前台的补拉命中同一 ETag：照样不重渲染', page.fetches.length === 3 && page.renders.length === 1 && page.jsonCalls === 1,
    JSON.stringify({ fetches: page.fetches.length, renders: page.renders.length }));

  const changed = `W/"${'c'.repeat(16)}-6"`;
  page.sse().emit({ version: 6 });
  await settle();
  await page.respond(3, { version: 6, etag: changed, rows: 4 });
  check('P3d ETag 变了照常解析并渲染', page.renders.length === 2 && page.renders[1].count === 4 && page.jsonCalls === 2,
    JSON.stringify(page.renders));

  const noEtag = openPage();
  await noEtag.respond(0, { version: 1, etag: null });
  noEtag.document.fire('visibilitychange');
  await settle();
  await noEtag.respond(1, { version: 1, etag: null });
  check('P3e 响应没有 ETag（旧服务端）时不跳过，照旧渲染', noEtag.renders.length === 2, String(noEtag.renders.length));
}

// ---------- P4 回到前台与 SSE 的其他分支 ----------
{
  const page = openPage();
  page.document.fire('visibilitychange');          // 首次拉取还在途：复用它
  await settle();
  const joined = page.fetches.length;
  await page.respond(0, { version: 2 });
  check('P4a 回到前台时已有拉取在途：复用，不另发请求', joined === 1 && page.fetches.length === 1, String(page.fetches.length));

  page.document.hidden = true;
  page.document.fire('visibilitychange');
  await settle();
  check('P4b 切到后台（hidden）不拉', page.fetches.length === 1, String(page.fetches.length));

  page.document.hidden = false;
  page.document.fire('visibilitychange');
  await settle();
  check('P4c 回到前台且空闲：拉 1 次', page.fetches.length === 2, String(page.fetches.length));
  await page.respond(1, { version: 2 });

  page.sse().emit({ version: 2 });                 // 断线重连后的首帧：就是已渲染的版本
  await settle();
  check('P4d SSE 通告已渲染的版本：不拉', page.fetches.length === 2, String(page.fetches.length));

  page.sse().emit('not json');
  await settle();
  check('P4e 坏帧（版本未知）：按可能有更新拉 1 次', page.fetches.length === 3, String(page.fetches.length));
  page.sse().emit({ version: 2 });                 // 坏帧触发的拉取在途时，又来一帧已渲染的版本
  await settle();
  await page.respond(2, { version: 2, etag: `W/"${'a'.repeat(16)}-2"` });
  check('P4f 在途期间通告的版本与拉完渲染的一致：不补拉', page.fetches.length === 3, String(page.fetches.length));
}

// ---------- P5 在途拉取失败 ----------
{
  const page = openPage();
  page.sse().emit({ version: 3 });
  await settle();
  await page.fail(0);
  const afterFail = page.fetches.length;
  check('P5a 首次拉取失败：状态栏提示，途中通告过的版本拉完后补拉 1 次', afterFail === 2 && /数据加载失败/.test(page.statusText()),
    JSON.stringify({ afterFail, status: page.statusText() }));
  await page.respond(1, { version: 3 });
  check('P5b 补拉成功后页面恢复渲染，不再追加', page.fetches.length === 2 && page.renders.length === 1, String(page.renders.length));

  const lonely = openPage();
  await lonely.fail(0);
  check('P5c 失败且途中无通告：不自己死循环重试（等 SSE / 回到前台）', lonely.fetches.length === 1, String(lonely.fetches.length));

  // 已渲染过的页面某次补拉失败（状态栏换成失败提示），下一次拿回的还是同一份内容：要重渲染把统计文案换回来
  page.document.fire('visibilitychange');
  await settle();
  await page.fail(2);
  const failedText = page.statusText();
  page.document.fire('visibilitychange');
  await settle();
  await page.respond(3, { version: 3, etag: `W/"${'a'.repeat(16)}-3"` });
  check('P5d 失败之后同一 ETag 的响应照样重渲染，状态栏回到统计文案',
    /数据加载失败/.test(failedText) && page.renders.length === 2 && !/数据加载失败/.test(page.statusText()),
    JSON.stringify({ failedText, renders: page.renders.length, now: page.statusText() }));
}

// ---------- P6 SSE 被拦 ----------
{
  const page = openPage({ eventSource: false });
  await page.respond(0, { version: 1 });
  check('P6 EventSource 从不出帧（代理拦掉 SSE）：首次拉取照样发生并渲染', page.fetches.length === 1 && page.renders.length === 1,
    JSON.stringify({ fetches: page.fetches.length, renders: page.renders.length }));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
