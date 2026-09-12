import './bootstrap.cjs';
// A5 回归测试：一次性存量迁移加完成标记短路，SW 唤醒零全表扫描。
// chrome 桩带 get 调用记录仪；「二次唤醒」用再次调用 loadConfigFromJsonFiles 模拟
// （SW 唤醒的迁移路径全在该函数内，unit-maint-batch1 同范式）。
// 用法：node tests/unit-migrate-skip.mjs（改造前跑应在 T2 低读断言上 RED=每轮 4+ 次全表读）
import fs from 'node:fs';

// ---------- chrome 桩（get 记录仪 + set 失败注入） ----------
const rawStore = {};
let getLog = [];            // 每次 get 的 keys（展平为数组）
let failNextSet = false;

function pickKeys(keys) {
  const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? rawStore);
  const out = {};
  for (const k of wanted) if (k in rawStore) out[k] = structuredClone(rawStore[k]);
  return out;
}

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        getLog.push(typeof keys === 'string' ? [keys] : Array.isArray(keys) ? [...keys] : Object.keys(keys ?? {}));
        await Promise.resolve();
        return pickKeys(keys);
      },
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
    onMessage: { addListener() {} },
    sendMessage() { return Promise.resolve(undefined); }
  },
  alarms: { async get() { return undefined; }, async clear() { return true; }, create() {}, onAlarm: { addListener() {} } },
  tabs: { create() {}, remove() {}, onUpdated: { addListener() {}, removeListener() {} } },
  notifications: { create() {} },
  scripting: { async executeScript() { return []; } }
};
globalThis.importScripts = () => {};

const SUB = 'https://unit.test/list';
let tagJson = [{ url: SUB, tags: ['T'] }];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('tag.json')) return { ok: true, json: async () => structuredClone(tagJson) };
  throw new TypeError('unit stub: no network'); // cron/trans/lark 走默认回退
};
globalThis.Translator = { async translateTitleAndDesc() { return { title: '', desc: '' }; } };

const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

// ---------- 加载真实生产代码 ----------
for (const rel of ['../src/shared/url-match.js', '../src/shared/site-registry.js', '../src/shared/timeline-csv.js', '../src/shared/schedule-config.js', '../src/shared/lark.js']) {
  (0, eval)(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
}
// 直改 rawStore.dramas 前须让队列内存缓存失效（模拟 SW 冷启动首读）。缓存变量
// 是 background.js 那次 eval 的私有词法环境成员、外部触不到，借用生产自身语义：
// 注入一次 set 失败，writeDramasInQueue 的 catch 置缓存 null（失败不落 rawStore）。
// eval 前调用为 no-op（clearAllDramas 尚未定义）。
const resetDramasCache = async () => {
  if (typeof globalThis.clearAllDramas !== 'function') return;
  failNextSet = true;
  await globalThis.clearAllDramas().catch(() => {});
  failNextSet = false;
};
const seedLegacy = async () => {
  await resetDramasCache();
  rawStore.dramas = [
    { id: 'id-1', imdbId: 'tt0001', title: 'Old Field', tags: ['T'], source: 'unittest', status: 'trans', sourceListUrl: SUB },
    { id: 'id-2', itemId: 'rr123', title: 'RR Tag', tags: ['RR'], company: 'Some Author', source: 'royalroad', status: 'trans', sourceListUrl: SUB },
    { id: 'id-3', itemId: 'mdf-orphan-slug', title: 'Unmapped Fandom', tags: ['T'], source: 'mydrama', status: 'new', sourceListUrl: SUB },
    { id: 'id-4', itemId: 'ns001', title: 'Normal', tags: ['T'], company: '', source: 'netshort', status: 'trans', sourceListUrl: SUB }
  ];
  delete rawStore.legacyDramaMigrated;
  delete rawStore.rsEpisodeUrlMigrated;
  delete rawStore.companyFieldDropped;
  rawStore.urlTags = [{ urlPattern: SUB, tags: ['T'] }];
};
await seedLegacy();
(0, eval)(fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700); // 等顶层首轮 loadConfigFromJsonFiles 落定

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const dramasReadCount = () => getLog.filter(keys => keys.includes('dramas')).length;

// ---------- T1 首轮：三迁移生效 + 双标记落库 ----------
{
  const dramas = rawStore.dramas || [];
  const byId = Object.fromEntries(dramas.map(d => [d.id, d]));
  check('T1a imdbId 字段已更名 itemId', byId['id-1'] && !('imdbId' in byId['id-1']) && byId['id-1'].itemId === 'tt0001', JSON.stringify(byId['id-1']));
  check('T1b RR 标签已改 RoyalRoad', byId['id-2']?.tags?.includes('RoyalRoad') && !byId['id-2']?.tags?.includes('RR'), JSON.stringify(byId['id-2']?.tags));
  check('T1c mdf- 未映射条目已清理', !byId['id-3'] && dramas.length === 3, `len=${dramas.length}`);
  check('T1d legacyDramaMigrated 已置位', rawStore.legacyDramaMigrated === true, String(rawStore.legacyDramaMigrated));
  check('T1e rsEpisodeUrlMigrated 已置位（无候选也收口）', rawStore.rsEpisodeUrlMigrated === true, String(rawStore.rsEpisodeUrlMigrated));
  // v1.5.13：company 彻底移除。挂在独立标记上——legacyDramaMigrated 在存量机器上早已
  // 置位，挂进 runLegacyDramaMigrations 的话这条迁移永远不会执行
  check('T1f company 字段已从存量记录摘除（含空串值）',
    dramas.every(d => !('company' in d)), JSON.stringify(dramas.map(d => d.company)));
  check('T1g companyFieldDropped 已置位', rawStore.companyFieldDropped === true, String(rawStore.companyFieldDropped));
}

// ---------- T2 二次唤醒：dramas 全表读恰 1 次（仅 prune，不可标记项） ----------
{
  getLog = [];
  await loadConfigFromJsonFiles(); // eslint-disable-line no-undef
  const reads = dramasReadCount();
  // 缓存热态（同 SW 会话内二次唤醒等价路径）为 0 次；缓存冷态（真实 SW 重启）为 1 次（仅 prune）
  check('T2a 二次唤醒 dramas 全表读 ≤1 次（旧代码 4+ 次）', reads <= 1, `reads=${reads} log=${JSON.stringify(getLog)}`);
  const rsGets = getLog.filter(keys => keys.includes('rsEpisodeUrlMigrated'));
  check('T2b rs 标记读取不连带 dramas', rsGets.length === 1 && rsGets[0].length === 1, JSON.stringify(rsGets));
  check('T2c 数据未被误动', (rawStore.dramas || []).length === 3, `len=${rawStore.dramas?.length}`);
}

// ---------- T3 set 失败：标记不置位，下轮重试成功 ----------
{
  await seedLegacy();
  failNextSet = true; // 首个写（config 种子 set）失败，迁移线不达
  let threw = false;
  await loadConfigFromJsonFiles().catch(() => { threw = true; }); // eslint-disable-line no-undef
  check('T3a 迁移失败向上传播', threw === true, '');
  check('T3b 失败后标记未置位', rawStore.legacyDramaMigrated === undefined, String(rawStore.legacyDramaMigrated));
  await loadConfigFromJsonFiles(); // eslint-disable-line no-undef
  check('T3c 下轮重试完成迁移并置标记', rawStore.legacyDramaMigrated === true && !('imdbId' in ((rawStore.dramas || [])[0] || {})), JSON.stringify(rawStore.dramas?.[0]));
}

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
