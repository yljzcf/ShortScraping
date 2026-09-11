import './bootstrap.cjs';
// 维护批次 4 之 A-8 回归：IMDB / RoyalRoad 标题解析失败时跳过，不产残卡。
// unit-scrape-inflight 范式：window/document/chrome 桩 + eval 真实 content.js，
// 经 'scrape' 消息驱动完整管线；location/document 在两轮之间切换站点。
// 用法：node tests/unit-maint-residual.mjs（v1.4.4 跑应 RED——坏项以标题=ID 入库）
import fs from 'node:fs';

const IMDB_URL = 'https://www.imdb.com/search/title/?release_date=2026-01-01,&genres=short';
const RR_URL = 'https://www.royalroad.com/fictions/trending';

// ---------- 可切换的站点场景 ----------
let currentListSelector = '';
let currentItems = [];

// IMDB：good 有编号标题链接；bad 只有 tt 链接、无任何标题来源
const imdbLink = (href, text) => ({ textContent: text, getAttribute: () => href, href });
const imdbGood = {
  querySelector: sel => (sel === 'a[href*="/title/tt"]' ? imdbLink('/title/tt0000001/', '1. Good Title') : null),
  querySelectorAll: sel => (sel === 'a[href*="/title/tt"]' ? [imdbLink('/title/tt0000001/', '1. Good Title')] : [])
};
const imdbBad = {
  querySelector: sel => (sel === 'a[href*="/title/tt"]' ? imdbLink('/title/tt0000002/', '') : null),
  querySelectorAll: sel => (sel === 'a[href*="/title/tt"]' ? [imdbLink('/title/tt0000002/', '')] : [])
};

// RoyalRoad：good 有 .fiction-title a；bad 只有 /fiction/ id 链接
const rrGood = {
  querySelector: sel => {
    if (sel === 'a[href*="/fiction/"]') return { getAttribute: () => '/fiction/12345/good-fic' };
    if (sel === '.fiction-title a') return { textContent: 'Good Fic', href: 'https://www.royalroad.com/fiction/12345/good-fic' };
    if (sel === 'div[id^="description-"]') return { querySelectorAll: () => [], textContent: 'A story.' };
    return null;
  },
  // v1.5.3 起列表提取会查 a.fiction-tag 采 genres——桩必须带 querySelectorAll
  querySelectorAll: sel => (sel === 'a.fiction-tag'
    ? [{ textContent: ' Fantasy ' }, { textContent: 'Romance' }]
    : [])
};
const rrBad = {
  querySelector: sel => (sel === 'a[href*="/fiction/"]' ? { getAttribute: () => '/fiction/67890/broken' } : null),
  querySelectorAll: () => []
};

// ---------- chrome / window / document 桩 ----------
const rawStore = { dramas: [] };
const listeners = [];
let activeUrlTags = [];

globalThis.chrome = {
  storage: {
    local: {
      async get() {
        await Promise.resolve();
        return { dramas: structuredClone(rawStore.dramas), urlTags: structuredClone(activeUrlTags) };
      }
    }
  },
  runtime: {
    onMessage: { addListener(fn) { listeners.push(fn); } },
    async sendMessage(message) {
      await Promise.resolve();
      if (message?.action === 'saveDrama') {
        const dup = rawStore.dramas.some(d => d.itemId === message.drama.itemId);
        if (!dup) rawStore.dramas.push(structuredClone(message.drama));
        return { success: true, saved: !dup };
      }
      return { success: true };
    }
  }
};

globalThis.window = {
  location: { href: IMDB_URL, hostname: 'www.imdb.com', pathname: '/search/title/', search: '', origin: 'https://www.imdb.com' }
};

const fakeElement = () => ({ style: {}, disabled: false, innerHTML: '', addEventListener() {}, querySelector() { return null; } });
globalThis.document = {
  getElementById() { return null; },
  createElement() { return fakeElement(); },
  querySelector() { return null; },
  querySelectorAll(sel) { return sel === currentListSelector ? currentItems : []; },
  body: { appendChild() {} }
};

// 详情请求一律失败：IMDB/RR 详情失败都保留列表页数据（return drama），
// 正好绕开 Node 无 DOMParser 的限制，只考核列表解析与残卡跳过逻辑
globalThis.fetch = async () => ({ ok: false, status: 500 });

const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

// ---------- 加载真实生产代码 ----------
// site-registry 是 content.js 的前置依赖（manifest 注入序同款），先行加载
(0, eval)(fs.readFileSync(new URL('../src/shared/site-registry.js', import.meta.url), 'utf8'));
(0, eval)(fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8'));
if (listeners.length !== 1) { origLog(`FAIL 期望 1 个监听器，实际 ${listeners.length}`); process.exit(1); }

function sendScrape() {
  return new Promise(resolve => { for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve); });
}
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ---------- T1 IMDB：good 入库、bad（无标题）跳过 ----------
{
  activeUrlTags = [{ urlPattern: IMDB_URL, tags: ['IMDB'] }];
  currentListSelector = '.ipc-metadata-list-summary-item';
  currentItems = [imdbGood, imdbBad];

  const resp = await sendScrape();
  const ids = rawStore.dramas.map(d => d.itemId).sort();
  const good = rawStore.dramas.find(d => d.itemId === 'tt0000001');
  check('T1a IMDB 正常项入库且标题正确', good?.title === 'Good Title', JSON.stringify(good));
  check('T1b IMDB 无标题项被跳过（不产生标题=ID 的残卡）', !ids.includes('tt0000002'),
    JSON.stringify(rawStore.dramas.map(d => ({ id: d.itemId, title: d.title }))));
  check('T1c 响应只报告成功项', resp?.success === true && (resp.data || []).length === 1, JSON.stringify(resp?.data?.length));
}

// ---------- T2 RoyalRoad：good 入库、bad（无标题）跳过 ----------
{
  activeUrlTags = [{ urlPattern: RR_URL, tags: ['RoyalRoad'] }];
  globalThis.window.location = { href: RR_URL, hostname: 'www.royalroad.com', pathname: '/fictions/trending', search: '', origin: 'https://www.royalroad.com' };
  currentListSelector = '.fiction-list-item';
  currentItems = [rrGood, rrBad];

  const resp = await sendScrape();
  const ids = rawStore.dramas.map(d => d.itemId).sort();
  const good = rawStore.dramas.find(d => d.itemId === 'rr12345');
  check('T2a RR 正常项入库且标题/简介/genres 正确',
    good?.title === 'Good Fic' && good?.description === 'A story.'
      && JSON.stringify(good?.genres) === JSON.stringify(['Fantasy', 'Romance']),
    JSON.stringify(good));
  check('T2b RR 无标题项被跳过', !ids.includes('rr67890'),
    JSON.stringify(rawStore.dramas.map(d => ({ id: d.itemId, title: d.title }))));
  check('T2c sourceListUrl 已 canonical 化为订阅 URL', good?.sourceListUrl === RR_URL, good?.sourceListUrl);
}

let failed = 0;
for (const r of results) { if (!r.pass) failed++; origLog(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  ← ${r.detail}`}`); }
origLog(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
