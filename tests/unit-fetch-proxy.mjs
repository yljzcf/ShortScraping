import './bootstrap.cjs';
// 后台 fetchDetailHtml 代理消息单测（v1.5.5，tmp/ 不入库）：
// fandom 子域 content script 受页面 CORS 拦、拿不到主站播放页，由后台 SW 代理取 HTML。
// 本测验证：白名单只放 https://my-drama.com/video/<严格36位UUID> 规范形态（无 query），
// 域/协议/路径/参数越界一律拒且零网络请求；网络失败与非 2xx 均回 success:false 不抛错。
// 用法：node tests/unit-fetch-proxy.mjs
import fs from 'node:fs';

// ---------- chrome 桩（对齐 unit-dramas-race 范式，去掉本测不需要的暂停机关） ----------
const rawStore = {};
const listeners = { runtimeMessage: [] };

function pickKeys(keys) {
  const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? rawStore);
  const out = {};
  for (const k of wanted) if (k in rawStore) out[k] = structuredClone(rawStore[k]);
  return out;
}

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) { await Promise.resolve(); return pickKeys(keys); },
      async set(obj) { await Promise.resolve(); for (const [k, v] of Object.entries(obj)) rawStore[k] = structuredClone(v); }
    },
    onChanged: { addListener() {} }
  },
  runtime: {
    getURL: p => `chrome-extension://unit-test/${p}`,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { listeners.runtimeMessage.push(fn); } },
    sendMessage(message, callback) {
      const deliver = new Promise((resolve) => {
        let settled = false;
        const sendResponse = (resp) => { if (!settled) { settled = true; resolve(resp); } };
        let keepOpen = false;
        for (const fn of listeners.runtimeMessage) {
          if (fn(message, { id: 'unit-test' }, sendResponse) === true) keepOpen = true;
        }
        if (!keepOpen && !settled) { settled = true; resolve(undefined); }
      });
      if (typeof callback === 'function') { deliver.then(callback); return; }
      return deliver;
    }
  },
  alarms: {
    async get() { return undefined; },
    async clear() { return true; },
    create() {},
    onAlarm: { addListener() {} }
  },
  tabs: { create() {}, onUpdated: { addListener() {}, removeListener() {} } },
  notifications: { create() {} },
  scripting: { async executeScript() { return []; } }
};

// fetch 桩：记录调用，按测试用例切换行为
const fetchCalls = [];
let fetchBehavior = async () => ({ ok: true, status: 200, text: async () => '<html>FULL-PAGE</html>' });
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url: String(url), options });
  return fetchBehavior(url, options);
};
globalThis.importScripts = () => {};

// 压掉后台脚本自身的日志噪音（含顶层初始化对共享模块缺席的 console.error 抱怨——
// importScripts 为 noop 桩，本测只关心 fetchDetailHtml 消息路径，与共享模块无关）
const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

const bgSrc = fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8');
(0, eval)(bgSrc);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(150); // 等后台顶层初始化落定
fetchCalls.length = 0; // 丢弃初始化期的 fetch（远端版本检查等）

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const ask = (url) => chrome.runtime.sendMessage({ action: 'fetchDetailHtml', url });

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

console.log = origLog; console.warn = origWarn;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
