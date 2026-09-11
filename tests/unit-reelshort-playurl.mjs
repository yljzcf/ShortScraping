import './bootstrap.cjs';
// ReelShort 条目 url 存播放页（/full-episodes/）单测：加载真实 content.js（零网络），
// 走完整 'scrape' 消息路径，用内嵌 /movie/ 页 fixture 驱动详情（原 tmp/rs-movie.html
// 真实存档已丢失，2026-08-02 按其关键结构重建内嵌——fixture 一律内嵌，不再依赖外部文件）。
// 断言：详情请求发往 /movie/（简介源不变）、成功后 url 为 /episodes/episode-1 第一集
// 播放页（chapter_id 取 __NEXT_DATA__ 的 start_play）、简介取自 /movie/ 页真实剧情
// （非 full-episodes 的 SEO 模板）、详情失败退构造的 /full-episodes/ 全集页兜底、
// genres 取详情 tag_list（v1.5.3）。
// 用法：node tests/unit-reelshort-playurl.mjs
import fs from 'node:fs';

const HOME_URL = 'https://www.reelshort.com/';
const BOOK_A = {
  book_id: '6a31351edd8a999e1e0f891c',
  book_title: 'Sylvan Crest',            // 故意与站点规范 slug 不同，逼出 response.url 覆盖路径
  special_desc: 'truncated A',
  book_pic: 'https://cdn.test/a.jpg'
};
const BOOK_B = {
  book_id: 'ffffffffffffffffffffffff',
  book_title: 'Broken Detail',
  special_desc: 'truncated B',
  book_pic: 'https://cdn.test/b.jpg'
};
const HOME_NEXT_DATA = {
  props: { pageProps: { fallback: { '/api/ms/hall/webInfo': { bookShelfList: [
    { bookshelf_name: 'Banner' },
    { bookshelf_name: 'TOP', books: [BOOK_A, BOOK_B] }
  ] } } } }
};
// 内嵌 /movie/ 页 fixture：__NEXT_DATA__ 直出 pageProps.data（start_play.chapter_id
// 与简介开头为断言锚点，与原真实存档一致；tag_list 为 v1.5.3 genres 断言用）
const MOVIE_DETAIL = {
  props: { pageProps: { data: {
    book_id: '6a31351edd8a999e1e0f891c',
    book_title: 'The Sylvan Crest Swap',
    special_desc: 'In the divine realm, a swapped heir claws her way back to the crest her family lost, one rite at a time.',
    book_pic: 'https://cdn.test/canonical-a.jpg',
    start_play: { chapter_id: 'roevwnpo9t' },
    online_base: [{ chapter_id: 'roevwnpo9t' }],
    tag_list: [
      { id: 't1', category_id: '1010', text: 'Fantasy' },
      { id: 't2', category_id: '1022', text: 'Secret Identity' }
    ]
  } } }
};
const MOVIE_HTML = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(MOVIE_DETAIL)}</script></head><body></body></html>`;
const CANONICAL_MOVIE = 'https://www.reelshort.com/movie/the-sylvan-crest-swap-6a31351edd8a999e1e0f891c';

// ---------- chrome / window / document / fetch / DOMParser 桩 ----------
const rawStore = { dramas: [] };
const listeners = [];
const fetchedUrls = [];

globalThis.chrome = {
  storage: {
    local: {
      async get() {
        await Promise.resolve();
        return {
          dramas: structuredClone(rawStore.dramas),
          urlTags: [{ urlPattern: HOME_URL, tags: ['ReelShort', 'TOP'] }]
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
  location: { href: HOME_URL, hostname: 'www.reelshort.com', pathname: '/', search: '', origin: 'https://www.reelshort.com' }
};

const fakeElement = () => ({ style: {}, disabled: false, innerHTML: '', addEventListener() {}, querySelector() { return null; } });
globalThis.document = {
  getElementById() { return null; },
  createElement() { return fakeElement(); },
  querySelector(sel) {
    return sel === 'script#__NEXT_DATA__' ? { textContent: JSON.stringify(HOME_NEXT_DATA) } : null;
  },
  querySelectorAll() { return []; },
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
        return null;
      },
      querySelectorAll() { return []; }
    };
  }
};

globalThis.fetch = async (url) => {
  fetchedUrls.push(url);
  if (url.includes(BOOK_B.book_id)) throw new Error('detail 故障注入');
  return { ok: true, url: CANONICAL_MOVIE, text: async () => MOVIE_HTML };
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
const byId = id => rawStore.dramas.find(d => d.itemId === id);
const a = byId(`rs${BOOK_A.book_id}`);
const b = byId(`rs${BOOK_B.book_id}`);

check('U0 抓取成功且入库 2 条', resp?.success === true && rawStore.dramas.length === 2,
  JSON.stringify({ success: resp?.success, len: rawStore.dramas.length }));
check('U1 详情请求发往 /movie/ 剧目页（简介源不变）',
  fetchedUrls.length === 2 && fetchedUrls.every(u => u.startsWith('https://www.reelshort.com/movie/')),
  JSON.stringify(fetchedUrls));
check('U2 详情成功：url 为 /episodes/episode-1 第一集播放页（真实 chapter_id）',
  a?.url === 'https://www.reelshort.com/episodes/episode-1-the-sylvan-crest-swap-6a31351edd8a999e1e0f891c-roevwnpo9t',
  `url=${a?.url}`);
check('U3 简介取自 /movie/ 页真实剧情（非 SEO 模板）',
  (a?.description || '').startsWith('In the divine realm') && !(a?.description || '').includes('include 41 episodes'),
  `desc=${(a?.description || '').slice(0, 60)}`);
check('U4 详情失败：退构造的 /full-episodes/ 全集页 url 与截断简介',
  b?.url === 'https://www.reelshort.com/full-episodes/broken-detail-ffffffffffffffffffffffff' && b?.description === 'truncated B',
  JSON.stringify({ url: b?.url, desc: b?.description }));
check('U5 genres 取详情 tag_list（v1.5.3）',
  JSON.stringify(a?.genres) === JSON.stringify(['Fantasy', 'Secret Identity']),
  JSON.stringify(a?.genres));
check('U6 详情失败条目 genres 保持列表级值（无 theme 即空数组）',
  Array.isArray(b?.genres) && b.genres.length === 0, JSON.stringify(b?.genres));

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
process.exit(results.every(r => r.pass) ? 0 : 1);
