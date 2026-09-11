import './bootstrap.cjs';
// B2 回归测试：importDramas 合并导入与 pruneDramas 条件清理（单写者队列内执行）。
// 用法：node tests/unit-archive-actions.mjs（B2 实现前跑应无此消息接口 RED）
import fs from 'node:fs';

const rawStore = {};
const listeners = { runtimeMessage: [] };
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
  alarms: { async get() { return undefined; }, async clear() { return true; }, create() {}, onAlarm: { addListener() {} } },
  tabs: { create() {}, remove() {}, onUpdated: { addListener() {}, removeListener() {} } },
  notifications: { create() {} },
  scripting: { async executeScript() { return []; } }
};
globalThis.importScripts = () => {};

const SUB = 'https://unit.test/list';
globalThis.fetch = async (url) => {
  if (String(url).includes('tag.json')) return { ok: true, json: async () => [{ url: SUB, tags: ['T'] }] };
  throw new TypeError('unit stub: no network');
};
globalThis.Translator = { async translateTitleAndDesc() { return { title: '', desc: '' }; } };

const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

for (const rel of ['../src/shared/url-match.js', '../src/shared/site-registry.js', '../src/shared/timeline-csv.js', '../src/shared/schedule-config.js', '../src/shared/lark.js']) {
  (0, eval)(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
}
rawStore.dramas = [];
rawStore.urlTags = [{ urlPattern: SUB, tags: ['T'] }];
(0, eval)(fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700);

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const send = (msg) => chrome.runtime.sendMessage(msg);
const iso = (d) => `2026-07-${String(d).padStart(2, '0')}T12:00:00.000Z`;
const mk = (n, over = {}) => ({
  id: `id-${n}`, itemId: `tt${String(n).padStart(4, '0')}`, title: `Title ${n}`,
  status: 'trans', titleZh: `中${n}`, source: 'imdb', sourceListUrl: SUB, tags: ['T'],
  scrapedAt: iso(10), ...over
});

// 现库 2 条（经生产路径灌入）
await send({ action: 'saveDrama', drama: mk(1, { scrapedAt: iso(20) }) });
await send({ action: 'saveDrama', drama: mk(2, { scrapedAt: iso(15), source: 'steam' }) });

// ---------- T1 导入：新增/重复/订阅外/缺 itemId 四分类 ----------
{
  const payload = [
    mk(3, { scrapedAt: iso(18) }),                                   // 新增
    mk(1),                                                            // 与现库重复
    mk(4, { sourceListUrl: 'https://other.example/x' }),              // 订阅外
    { id: 'id-x', title: 'No ItemId', sourceListUrl: SUB },           // 缺 itemId
    mk(5, { scrapedAt: iso(25), status: 'weird', titleZh: '' }),      // status 怪值+无译文 → new
    mk(5),                                                            // 文件内自重
    mk(6, { id: 'id-1', scrapedAt: '', status: '', titleZh: '有译文' }) // id 撞车+无时间+status 空但有译文 → trans
  ];
  const r = await send({ action: 'importDramas', dramas: payload });
  check('T1a 四分类计数正确', r.success === true && r.added === 3 && r.duplicates === 2 && r.outOfScope === 1 && r.invalid === 1 && r.total === 7, JSON.stringify(r));
  const dramas = rawStore.dramas;
  check('T1b 库内条数 2+3', dramas.length === 5, `len=${dramas.length}`);
  const t5 = dramas.find(d => d.itemId === 'tt0005');
  const t6 = dramas.find(d => d.itemId === 'tt0006');
  check('T1c status 推断：怪值无译文→new / 空值有译文→trans', t5?.status === 'new' && t6?.status === 'trans', JSON.stringify({ t5: t5?.status, t6: t6?.status }));
  check('T1d id 撞车改写 import_ 前缀', t6?.id === 'import_tt0006', t6?.id);
  const order = dramas.map(d => d.itemId);
  check('T1e 合并后按 scrapedAt 降序、缺失排尾',
    JSON.stringify(order) === JSON.stringify(['tt0005', 'tt0001', 'tt0003', 'tt0002', 'tt0006']), JSON.stringify(order));
  check('T1f 白名单重建（无越权字段）', !('evil' in (dramas.find(d => d.itemId === 'tt0003') || {})), '');
}

// ---------- T2 清理：dryRun 与真删同谓词 ----------
{
  const preview = await send({ action: 'pruneDramas', sites: ['imdb'], beforeIso: iso(19), dryRun: true });
  // imdb 卡：tt0005(25 日)、tt0001(20 日)、tt0003(18 日)、tt0006(无时间保守不命中) → 早于 19 日的只有 tt0003
  check('T2a dryRun 命中数与分站计数', preview.success === true && preview.matched === 1 && preview.perSite.imdb === 1, JSON.stringify(preview));
  check('T2b dryRun 不动数据', rawStore.dramas.length === 5, `len=${rawStore.dramas.length}`);
  const real = await send({ action: 'pruneDramas', sites: ['imdb'], beforeIso: iso(19), previewToken: preview.previewToken });
  check('T2c 真删数＝预览数', real.success === true && real.removed === 1 && rawStore.dramas.length === 4, JSON.stringify(real));
  check('T2d 无 scrapedAt 条目带日期条件时保守保留', rawStore.dramas.some(d => d.itemId === 'tt0006'), '');
}

// ---------- T3 清理：仅站点（无日期）与入参校验 ----------
{
  const steamPreview = await send({ action: 'pruneDramas', sites: ['steam'], dryRun: true });
  const bySite = await send({ action: 'pruneDramas', sites: ['steam'], previewToken: steamPreview.previewToken });
  check('T3a 仅站点条件清理（含无 scrapedAt 也命中语义的对照）', bySite.removed === 1 && !rawStore.dramas.some(d => d.source === 'steam'), JSON.stringify(bySite));
  const empty = await send({ action: 'pruneDramas', sites: [] });
  check('T3b 空 sites 拒绝', empty.success === false && /未指定/.test(empty.error), JSON.stringify(empty));
  const bad = await send({ action: 'pruneDramas', sites: ['unknown-site'] });
  check('T3c 未知站点拒绝', bad.success === false && /未知站点/.test(bad.error), JSON.stringify(bad));
  const badDate = await send({ action: 'pruneDramas', sites: ['imdb'], beforeIso: 'not-a-date' });
  check('T3d 非法日期拒绝', badDate.success === false && /无法解析/.test(badDate.error), JSON.stringify(badDate));
  const badImport = await send({ action: 'importDramas', dramas: 'not-array' });
  check('T3e 非数组导入拒绝', badImport.success === false, JSON.stringify(badImport));
}

// ---------- T4 导入与 saveDrama 并发交错不丢卡（同队列串行） ----------
{
  const before = rawStore.dramas.length;
  const pImport = send({ action: 'importDramas', dramas: [mk(7, { scrapedAt: iso(1) }), mk(8, { scrapedAt: iso(2) })] });
  const pSave = send({ action: 'saveDrama', drama: mk(9, { scrapedAt: iso(3) }) });
  const [ri, rs] = await Promise.all([pImport, pSave]);
  check('T4 交错执行不丢卡', ri.added === 2 && rs.saved === true && rawStore.dramas.length === before + 3, `len=${rawStore.dramas.length}`);
}

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
