import './bootstrap.cjs';
// 后台 migrateReelshortEpisodeUrls 单测（buildurl 范式：正则截取 background.js 里
// 真实函数源码 + 直接 eval 捕获本地桩）。覆盖在线升级路径：候选条目请求 /movie/ 页
// 取 chapter_id → url 改写为 /episodes/ 第一集播放页；请求失败退全集页兜底；
// 非 ReelShort 条目不动；一次性标记写入后二跑零请求。
// /movie/ 页 fixture 内嵌（原 tmp/rs-movie.html 真实存档已丢失，2026-08-02 按
// 其关键结构重建；fixture 一律内嵌，不再依赖外部文件）。
// 用法：node tests/unit-rs-migrate.mjs
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8');
const fnSrc = src.match(/async function migrateReelshortEpisodeUrls[\s\S]*?\n\}/)[0];
const MOVIE_DETAIL = {
  props: { pageProps: { data: {
    book_id: '6a31351edd8a999e1e0f891c',
    book_title: 'The Sylvan Crest Swap',
    special_desc: 'In the divine realm, a swapped heir claws her way back to the crest her family lost.',
    start_play: { chapter_id: 'roevwnpo9t' },
    online_base: [{ chapter_id: 'roevwnpo9t' }]
  } } }
};
const MOVIE_HTML = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(MOVIE_DETAIL)}</script></head><body></body></html>`;

const store = {
  dramas: [
    { itemId: 'rs6a31351edd8a999e1e0f891c', title: 'Sylvan',
      url: 'https://www.reelshort.com/full-episodes/the-sylvan-crest-swap-6a31351edd8a999e1e0f891c' },
    { itemId: 'rsffffffffffffffffffffffff', title: 'Gone Drama',
      url: 'https://www.reelshort.com/full-episodes/gone-drama-ffffffffffffffffffffffff' },
    { itemId: 'ds12345678-1234-4123-8123-123456789012', title: 'DS Untouched',
      url: 'https://dramashorts.io/shorts/12345678-1234-4123-8123-123456789012' }
  ]
};
let fetchCalls = 0;

globalThis.chrome = {
  storage: { local: {
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of wanted) if (store[k] !== undefined) out[k] = structuredClone(store[k]);
      return out;
    },
    async set(obj) { Object.assign(store, structuredClone(obj)); }
  } }
};
globalThis.fetch = async (url) => {
  fetchCalls++;
  if (url.includes('ffffffffffffffffffffffff')) throw new Error('404 故障注入');
  return { ok: true, url, text: async () => MOVIE_HTML };
};
// 队列桩（v1.5.1 后真实函数在队列内经 getDramasInQueue/writeDramasInQueue 读写）
// eslint-disable-next-line no-unused-vars
const enqueueDramaWrite = (label, fn) => fn();
// eslint-disable-next-line no-unused-vars
const getDramasInQueue = async () => structuredClone(store.dramas);
// eslint-disable-next-line no-unused-vars
const writeDramasInQueue = async (next, extras = {}) => {
  store.dramas = structuredClone(next);
  Object.assign(store, structuredClone(extras));
};

const origWarn = console.warn, origLog = console.log;
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };

const migrateReelshortEpisodeUrls = eval(`(${fnSrc.replace('async function migrateReelshortEpisodeUrls', 'async function')})`);
await migrateReelshortEpisodeUrls();
const firstRunFetches = fetchCalls;
await migrateReelshortEpisodeUrls();

console.warn = origWarn; console.log = origLog;

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const byId = id => store.dramas.find(d => d.itemId === id);

check('M1 候选条目升级为 /episodes/ 第一集播放页（真实 chapter_id）',
  byId('rs6a31351edd8a999e1e0f891c')?.url === 'https://www.reelshort.com/episodes/episode-1-the-sylvan-crest-swap-6a31351edd8a999e1e0f891c-roevwnpo9t',
  `url=${byId('rs6a31351edd8a999e1e0f891c')?.url}`);
check('M2 请求失败条目保留 /full-episodes/ 全集页兜底',
  byId('rsffffffffffffffffffffffff')?.url === 'https://www.reelshort.com/full-episodes/gone-drama-ffffffffffffffffffffffff',
  `url=${byId('rsffffffffffffffffffffffff')?.url}`);
check('M3 非 ReelShort 条目不动',
  byId('ds12345678-1234-4123-8123-123456789012')?.url === 'https://dramashorts.io/shorts/12345678-1234-4123-8123-123456789012',
  `url=${byId('ds12345678-1234-4123-8123-123456789012')?.url}`);
check('M4 一次性标记已写入', store.rsEpisodeUrlMigrated === true, `flag=${store.rsEpisodeUrlMigrated}`);
check('M5 首轮恰好 2 次请求（仅候选），二跑零请求',
  firstRunFetches === 2 && fetchCalls === 2, `first=${firstRunFetches} total=${fetchCalls}`);

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
process.exit(results.every(r => r.pass) ? 0 : 1);
