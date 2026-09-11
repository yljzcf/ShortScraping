import './bootstrap.cjs';
// fandom 未映射条目不入库（scrapePage 闸门）单测：加载真实 content.js（零网络），
// 走 reelshort /fandom/ 完整 'scrape' 消息路径。两篇文章：一篇带 /movie/ 回链
// （应改写为 rs+book_id，并二次请求 /movie/ 页取 chapter_id、url 为 /episodes/
// 第一集播放页入库，genres 取同一请求的 tag_list——v1.5.3），一篇无回链
// （itemId 停留 rsf- 临时键，应被闸门跳过、不入库）。
// /movie/ 页 fixture 内嵌（原 tmp/rs-movie.html 真实存档已丢失，2026-08-02 按
// 其关键结构重建；fixture 一律内嵌，不再依赖外部文件）。
// 用法：node tests/unit-fandom-unmapped-skip.mjs
import fs from 'node:fs';

const FANDOM_URL = 'https://www.reelshort.com/fandom/';
const BOOK_ID = 'abcdefabcdefabcdefabcdef';
const MOVIE_DETAIL = {
  props: { pageProps: { data: {
    book_id: BOOK_ID,
    book_title: 'Mapped Drama',
    special_desc: 'In the divine realm, a mapped drama fixture synopsis for the fandom mapping path.',
    start_play: { chapter_id: 'roevwnpo9t' },
    online_base: [{ chapter_id: 'roevwnpo9t' }],
    tag_list: [
      { id: 't1', category_id: '1010', text: 'Fantasy' },
      { id: 't2', category_id: '1022', text: 'Secret Identity' }
    ]
  } } }
};
const MOVIE_HTML = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(MOVIE_DETAIL)}</script></head><body></body></html>`;
const ARTICLES = [
  { slug: 'mapped-article', title: 'Mapped Article', marker: 'MAPPED' },
  { slug: 'unmapped-article', title: 'Unmapped Article', marker: 'UNMAPPED' }
];

// ---------- chrome / window / document / fetch / DOMParser 桩 ----------
const rawStore = { dramas: [] };
const listeners = [];

globalThis.chrome = {
  storage: {
    local: {
      async get() {
        await Promise.resolve();
        return {
          dramas: structuredClone(rawStore.dramas),
          urlTags: [{ urlPattern: FANDOM_URL, tags: ['ReelShort', 'fandom'] }]
        };
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
  location: { href: FANDOM_URL, hostname: 'www.reelshort.com', pathname: '/fandom/', search: '', origin: 'https://www.reelshort.com' }
};

const fakeArticle = (a) => ({
  querySelector(sel) {
    if (sel === '.entry-title a') {
      const href = `https://www.reelshort.com/fandom/${a.slug}/`;
      return { textContent: a.title, href, getAttribute: (n) => (n === 'href' ? href : null) };
    }
    if (sel === '.entry-content p') {
      return { textContent: 'A long enough excerpt paragraph for the fixture fandom article body goes right here […]' };
    }
    return null;
  }
});

const fakeElement = () => ({ style: {}, disabled: false, innerHTML: '', addEventListener() {}, querySelector() { return null; } });
globalThis.document = {
  getElementById() { return null; },
  createElement() { return fakeElement(); },
  querySelector() { return null; },
  querySelectorAll(sel) {
    return sel === 'article.post' ? ARTICLES.map(fakeArticle) : [];
  },
  body: { appendChild() {} }
};

globalThis.DOMParser = class {
  parseFromString(html) {
    return {
      querySelector(sel) {
        if (sel === 'script#__NEXT_DATA__') {
          const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
          return m ? { textContent: m[1] } : null;
        }
        if (sel.includes('/movie/')) {
          return html.includes('MAPPED-YES')
            ? { getAttribute: () => `/movie/mapped-drama-${BOOK_ID}` }
            : null;
        }
        if (sel === 'h1.entry-title' || sel === 'h1') return { textContent: 'Mapped Drama' };
        return null;
      },
      querySelectorAll() { return []; },
      body: { querySelectorAll() { return []; } }
    };
  }
};

globalThis.fetch = async (url) => {
  // 映射成功后适配器会二次请求 /movie/ 页取 chapter_id：回真实 movie 页 HTML
  if (url.includes('/movie/')) return { ok: true, url, text: async () => MOVIE_HTML };
  const marker = url.includes('unmapped-article') ? 'MAPPED-NO' : 'MAPPED-YES';
  return { ok: true, url, text: async () => `<html>${marker}</html>` };
};

// 压掉内容脚本日志噪音
const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

// ---------- 加载真实生产代码并触发抓取 ----------
// site-registry 是 content.js 的前置依赖（manifest 注入序同款），先行加载
(0, eval)(fs.readFileSync(new URL('../src/shared/site-registry.js', import.meta.url), 'utf8'));
const contentSrc = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
(0, eval)(contentSrc);

const resp = await new Promise(resolve => {
  for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
});

console.log = origLog; console.warn = origWarn; console.error = origError;

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const saved = rawStore.dramas;

check('F1 只入库 1 条（映射成功的那篇）', resp?.success === true && saved.length === 1,
  JSON.stringify({ success: resp?.success, len: saved.length }));
check('F2 映射条目：去重键 rs+book_id、url 为 /episodes/ 第一集播放页',
  saved[0]?.itemId === `rs${BOOK_ID}` && saved[0]?.url === `https://www.reelshort.com/episodes/episode-1-mapped-drama-${BOOK_ID}-roevwnpo9t`,
  JSON.stringify({ itemId: saved[0]?.itemId, url: saved[0]?.url }));
check('F3 未映射条目被闸门跳过（库中无 rsf- 临时键）',
  !saved.some(d => String(d.itemId).startsWith('rsf-')),
  JSON.stringify(saved.map(d => d.itemId)));
check('F4 映射条目 genres 取 /movie/ 页 tag_list（v1.5.3，与取 chapter_id 同一请求）',
  JSON.stringify(saved[0]?.genres) === JSON.stringify(['Fantasy', 'Secret Identity']),
  JSON.stringify(saved[0]?.genres));

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
process.exit(results.every(r => r.pass) ? 0 : 1);
