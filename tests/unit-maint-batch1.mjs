import './bootstrap.cjs';
// 维护批次 1（P0）回归测试：unit-dramas-race 范式，chrome 桩 + eval 真实 background.js。
//   A-1 非法 cron 不得瘫痪调度：看门狗最先装、坏任务降级为间隔、好任务不受连累
//   A-2 tag.json 读取失败不得清库：失败保留订阅跳过 prune；读到合法数组才允许 prune
//   A-10 永不匹配的日期×月份组合在解析期快速报错（不空转 52.7 万次）
// 用法：node tests/unit-maint-batch1.mjs（修复前跑应 RED，修复后全 PASS）
import fs from 'node:fs';

// ---------- 未捕获 rejection 计数（A-1 的 onAlarm 加固断言用） ----------
let unhandledCount = 0;
process.on('unhandledRejection', (e) => { unhandledCount++; console.error('UNHANDLED:', e?.message || e); });

// ---------- chrome 桩 ----------
const rawStore = {};
const alarmStore = new Map();
const listeners = { runtimeMessage: [], onAlarm: [] };
let failNextSet = false; // 注入一次 set 失败（用于让队列内存缓存失效，见下）

function pickKeys(keys) {
  const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? rawStore);
  const out = {};
  for (const k of wanted) if (k in rawStore) out[k] = structuredClone(rawStore[k]);
  return out;
}

const chromeStub = {
  storage: {
    local: {
      async get(keys) { await Promise.resolve(); return pickKeys(keys); },
      async set(obj) {
        if (failNextSet) { failNextSet = false; throw new Error('unit stub: 注入的 set 失败'); }
        await Promise.resolve();
        for (const [k, v] of Object.entries(obj)) rawStore[k] = structuredClone(v);
      }
    },
    onChanged: { addListener() {} }
  },
  runtime: {
    getURL: p => `chrome-extension://unit-test/${p}`,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { listeners.runtimeMessage.push(fn); } },
    sendMessage() { return Promise.resolve(undefined); }
  },
  alarms: {
    async get(name) { return alarmStore.get(name); },
    async clear(name) { return alarmStore.delete(name); },
    create(name, info) {
      alarmStore.set(name, {
        name,
        periodInMinutes: info.periodInMinutes,
        scheduledTime: typeof info.when === 'number' ? info.when : Date.now() + (info.periodInMinutes || 0) * 60000
      });
    },
    onAlarm: { addListener(fn) { listeners.onAlarm.push(fn); } }
  },
  tabs: { create() {}, remove() {}, sendMessage() {}, onUpdated: { addListener() {}, removeListener() {} } },
  notifications: { create() {} },
  scripting: { async executeScript() { return []; } }
};

globalThis.chrome = chromeStub;
globalThis.importScripts = () => {};

// fetch 桩：按文件名分派，tagJsonBehavior 可在用例间切换
//   'throw'   -> 读取失败（网络/文件异常）
//   'invalid' -> HTTP 200 但 JSON 不是数组（结构损坏）
//   数组      -> 正常返回该数组
let tagJsonBehavior = 'throw';
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('tag.json')) {
    if (tagJsonBehavior === 'throw') throw new TypeError('unit stub: tag.json unreachable');
    if (tagJsonBehavior === 'invalid') return { ok: true, json: async () => ({ not: 'an array' }) };
    return { ok: true, json: async () => structuredClone(tagJsonBehavior) };
  }
  throw new TypeError('unit stub: no network'); // cron/trans 走默认配置回退
};
globalThis.Translator = { async translateTitleAndDesc() { return { title: '', desc: '' }; } };

const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

// ---------- 加载真实生产代码 ----------
try {
  (0, eval)(fs.readFileSync(new URL('../src/shared/url-match.js', import.meta.url), 'utf8'));
} catch { /* 旧代码树没有 url-match.js（RED 检查用） */ }
try {
  // v1.5.1 起 lark.js/timeline-render.js 的站点显示名取自 site-registry.js，须先加载
  (0, eval)(fs.readFileSync(new URL('../src/shared/site-registry.js', import.meta.url), 'utf8'));
  (0, eval)(fs.readFileSync(new URL('../src/shared/timeline-csv.js', import.meta.url), 'utf8'));
  (0, eval)(fs.readFileSync(new URL('../src/shared/schedule-config.js', import.meta.url), 'utf8'));
} catch { /* 旧代码树没有 site-registry.js */ }
try {
  // v1.5.0 起 loadConfigFromJsonFiles 依赖 Lark.normalizeConfig（lark 配置种子化），纯函数层可直接加载
  (0, eval)(fs.readFileSync(new URL('../src/shared/lark.js', import.meta.url), 'utf8'));
} catch { /* 更旧代码树没有 lark.js */ }
const bgSrc = fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8');
(0, eval)(bgSrc);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700); // 等顶层 loadConfigFromJsonFiles().then(setupAlarms) 与 CSV 预热落定

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const SUB = 'https://unit.test/list';
const mk = (n, over = {}) => ({
  id: `id-${n}`, itemId: `tt000${n}`, title: `Title ${n}`, description: '',
  status: 'trans', source: 'unittest', sourceListUrl: SUB, tags: ['T'], ...over
});

// ============ A-2：tag.json 读取失败不清库 ============
// 直改 rawStore.dramas 前先让队列内存缓存失效（v1.5.1 引入；缓存变量在 eval 私有
// 词法环境里外部触不到，借生产语义：注入一次 set 失败让 writeDramasInQueue 置空缓存）
failNextSet = true;
await clearAllDramas().catch(() => {}); // eslint-disable-line no-undef
failNextSet = false;
rawStore.urlTags = [{ urlPattern: SUB, tags: ['T'] }];
rawStore.dramas = [mk(1), mk(2), mk(3, { sourceListUrl: 'https://other.example/x' })];

// T1a 读取失败（fetch 异常）：dramas 与 urlTags 都必须原样保留
tagJsonBehavior = 'throw';
await loadConfigFromJsonFiles();
check('T1a fetch 异常时不清库（3 条全保留）', (rawStore.dramas || []).length === 3, `dramas=${rawStore.dramas?.length}`);
check('T1b fetch 异常时保留上次订阅', rawStore.urlTags?.length === 1 && rawStore.urlTags[0].urlPattern === SUB, JSON.stringify(rawStore.urlTags));

// T1c JSON 结构损坏（非数组）：同样视为读取失败
tagJsonBehavior = 'invalid';
await loadConfigFromJsonFiles();
check('T1c 非数组 JSON 视为失败不清库', (rawStore.dramas || []).length === 3, `dramas=${rawStore.dramas?.length}`);

// T1d 正常读到数组：prune 照常工作，界外历史被清理
tagJsonBehavior = [{ url: SUB, tags: ['T'] }];
await loadConfigFromJsonFiles();
const idsAfter = (rawStore.dramas || []).map(d => d.itemId).sort();
check('T1d 读取成功时 prune 生效（界外 tt0003 被清）', idsAfter.join(',') === 'tt0001,tt0002', idsAfter.join(','));

// T1e 合法空数组＝用户主动清空订阅：允许清库（既定语义不回归）
tagJsonBehavior = [];
await loadConfigFromJsonFiles();
check('T1e 合法空数组仍按零订阅清库', (rawStore.dramas || []).length === 0, `dramas=${rawStore.dramas?.length}`);

// ============ A-1：非法 cron 不瘫痪调度 ============
// T2a 抓取 cron 非法、翻译 cron 合法：看门狗在、翻译一次性 alarm 在、抓取降级为间隔
alarmStore.clear();
rawStore.scheduleConfig = { scheduleMode: 'cron', scrapeCron: 'not a cron', translateCron: '50 * * * *', scrapeInterval: 6, translateInterval: 1 };
await setupAlarms();
{
  const wd = alarmStore.get('watchdog');
  const sc = alarmStore.get('scrape-task');
  const tr = alarmStore.get('translate-task');
  check('T2a1 看门狗已安装', Boolean(wd), JSON.stringify(wd));
  check('T2a2 坏 cron 任务降级为间隔（6h 周期）', sc?.periodInMinutes === 360, JSON.stringify(sc));
  check('T2a3 好 cron 任务不受连累（一次性 alarm，分钟=50）',
    Boolean(tr) && !tr.periodInMinutes && new Date(tr.scheduledTime).getMinutes() === 50, JSON.stringify(tr));
}

// T2b 两个 cron 都非法：全部降级，无一失踪
alarmStore.clear();
rawStore.scheduleConfig = { scheduleMode: 'cron', scrapeCron: '99 * * * *', translateCron: '* * * 13 *', scrapeInterval: 6, translateInterval: 1 };
await setupAlarms();
check('T2b 双坏 cron 全部降级（watchdog+2 个周期 alarm）',
  Boolean(alarmStore.get('watchdog')) &&
  alarmStore.get('scrape-task')?.periodInMinutes === 360 &&
  alarmStore.get('translate-task')?.periodInMinutes === 60,
  JSON.stringify([...alarmStore.values()]));

// T2c 合法 cron 正常工作（回归保护）
alarmStore.clear();
rawStore.scheduleConfig = { scheduleMode: 'cron', scrapeCron: '45 * * * *', translateCron: '50 * * * *' };
await setupAlarms();
{
  const sc = alarmStore.get('scrape-task');
  check('T2c 合法 cron 建一次性 alarm（分钟=45、时间在未来）',
    Boolean(sc) && !sc.periodInMinutes && new Date(sc.scheduledTime).getMinutes() === 45 && sc.scheduledTime > Date.now(),
    JSON.stringify(sc));
}

// ============ A-10：永不匹配组合解析期快速报错 ============
{
  let threw = false, elapsed = 0;
  const t0 = performance.now();
  try { ScheduleConfig.parseSimpleCron('0 0 31 2 *'); } catch { threw = true; }
  elapsed = performance.now() - t0;
  check('T3a "0 0 31 2 *" 解析期即抛错', threw, `threw=${threw}`);
  check('T3b 报错耗时 <50ms（不空转扫描）', elapsed < 50, `${elapsed.toFixed(1)}ms`);
  let ok29 = true;
  try { ScheduleConfig.parseSimpleCron('0 0 29 2 *'); } catch { ok29 = false; }
  check('T3c "0 0 29 2 *"（闰年合法）仍可解析', ok29);
  let okDow = true;
  try { ScheduleConfig.parseSimpleCron('0 0 31 2 1'); } catch { okDow = false; }
  check('T3d 星期受限时不误拦（31/2 + 周一按 OR 语义可匹配）', okDow);
}

// ============ A-1 onAlarm 加固：坏配置下闹钟触发无未捕获 rejection ============
rawStore.scheduleConfig = { scheduleMode: 'cron', scrapeCron: 'garbage', translateCron: 'garbage' };
rawStore.urlTags = []; // 让 performScrape 走"未配置 URL"早退路径，不涉 tabs
for (const fire of listeners.onAlarm) await fire({ name: 'watchdog' });
for (const fire of listeners.onAlarm) await fire({ name: 'scrape-task' });
await sleep(200);
check('T4 坏配置下看门狗/任务闹钟触发无未捕获 rejection', unhandledCount === 0, `unhandled=${unhandledCount}`);

// ---------- 汇总 ----------
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  origLog(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  ← ${r.detail}`}`);
}
origLog(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
