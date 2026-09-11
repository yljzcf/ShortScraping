import './bootstrap.cjs';
// dramas 表并发写竞态回归测试（确定性交错，非碰运气）。
// 复现 2026-07-09 DramaShorts e2e 丢卡：翻译线「get 全表 → 改 → set 全表」窗口内，
// 内容脚本 saveSingleDrama 写入的新卡被整表写回覆盖。
// 用法：node tests/unit-dramas-race.mjs
//   修复前（内容脚本直写 storage、后台无单写者队列）：T1-T5 应大面积 FAIL（RED）
//   修复后（所有 dramas 写操作收敛后台队列串行）：全部 PASS（GREEN）
import fs from 'node:fs';

// ---------- chrome 桩 ----------
const rawStore = {};
const listeners = { runtimeMessage: [] };
let pauseState = null; // { promise, release, reachedResolve, reached }
let failNextSet = false; // 注入一次 set 失败（配合缓存失效重置，见 resetDramasCache）

function armPauseOnNextSet() {
  let release, reachedResolve;
  const promise = new Promise(r => { release = r; });
  const reached = new Promise(r => { reachedResolve = r; });
  pauseState = { promise, reachedResolve };
  return { reached, release };
}

function pickKeys(keys) {
  const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? rawStore);
  const out = {};
  for (const k of wanted) if (k in rawStore) out[k] = structuredClone(rawStore[k]);
  return out;
}

const chromeStub = {
  storage: {
    local: {
      async get(keys) {
        await Promise.resolve();
        return pickKeys(keys);
      },
      async set(obj) {
        if (failNextSet) { failNextSet = false; throw new Error('unit stub: 注入的 set 失败'); }
        if (pauseState) {
          const p = pauseState;
          pauseState = null;
          p.reachedResolve();
          await p.promise; // 卡在「读改写」的写回一步，模拟并行窗口
        }
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
    // 模拟 Chrome 消息管道：投递给后台 onMessage 监听器，支持异步 sendResponse
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

globalThis.chrome = chromeStub;
globalThis.importScripts = () => {};
globalThis.fetch = async () => { throw new TypeError('unit stub: no network'); };

// 压掉后台脚本自身的日志噪音，只留测试输出
const origLog = console.log, origWarn = console.warn;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };

// ---------- 加载真实生产代码 ----------
// background.js：间接 eval 在全局作用域执行，顶层函数声明成为 globalThis 属性
const bgSrc = fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8');
(0, eval)(bgSrc);

// content.js 的 saveSingleDrama：按 unit-buildurl.mjs 范式提取函数源码
const contentSrc = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const saveFnSrc = contentSrc.match(/async function saveSingleDrama\(drama\) \{[\s\S]*?\n  \}/)?.[0];
if (!saveFnSrc) { origLog('FAIL  无法从 content.js 提取 saveSingleDrama'); process.exit(1); }
const contentSaveSingleDrama = (0, eval)(`(${saveFnSrc.replace('async function saveSingleDrama', 'async function')})`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(150); // 等后台顶层初始化（配置回退 + prune/migrate 空跑）落定

const mk = (n, itemId) => ({
  id: `id-${n}`, itemId, title: `Title ${n}`, description: `desc ${n}`,
  status: 'new', source: 'unittest', sourceListUrl: 'https://unit.test/list'
});
// v1.5.1 起后台队列持有 dramas 内存缓存（生产写路径全收口队列内）。测试直改
// rawStore.dramas 等价于「SW 冷启动前 storage 被外部改写」，须先让缓存失效模拟
// 冷启动首读。缓存变量是 background.js 那次 eval 的私有词法环境成员、外部触不到，
// 故借用生产自身语义：注入一次 set 失败，writeDramasInQueue 的 catch 会置缓存为
// null（clearAllDramas 走该路径，失败不落 rawStore）。调用后再直改 rawStore。
const resetDramasCache = async () => {
  failNextSet = true;
  await clearAllDramas().catch(() => {}); // eslint-disable-line no-undef
};
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ---------- T1 后台提供 saveDrama 消息接口（含权威去重） ----------
{
  await resetDramasCache(); rawStore.dramas = [];
  const first = await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama: mk('x', 'tt0100') });
  const dup = await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama: mk('x2', 'tt0100') });
  check('T1a saveDrama 首次保存成功', first?.success === true && first?.saved === true, JSON.stringify(first));
  check('T1b saveDrama 重复 itemId 拒绝', dup?.success === true && dup?.saved === false, JSON.stringify(dup));
  check('T1c 表内恰好 1 条', (rawStore.dramas || []).length === 1, `len=${(rawStore.dramas || []).length}`);
  check('T1d 保存后 lastScrape 已更新', typeof rawStore.lastScrape === 'string', String(rawStore.lastScrape));
}

// ---------- T2 核心竞态：翻译线 get/set 窗口内保存的新卡不得丢失 ----------
{
  await resetDramasCache(); rawStore.dramas = [mk('A', 'tt0001')];
  const { reached, release } = armPauseOnNextSet();
  const p1 = updateSingleDramaTranslation('id-A', { title: '甲', desc: '甲简介' }); // eslint-disable-line no-undef
  await reached;                                   // 翻译线已完成 get、卡在 set
  const p2 = contentSaveSingleDrama(mk('B', 'tt0002')); // 内容脚本此刻保存新卡
  await sleep(80);
  release();                                       // 翻译线写回
  const [updated, saved] = await Promise.all([p1, p2.catch(e => `threw:${e.message}`)]);
  const dramas = rawStore.dramas || [];
  const cardA = dramas.find(d => d.itemId === 'tt0001');
  check('T2a 竞态窗口内保存的新卡未丢失', dramas.some(d => d.itemId === 'tt0002'), `dramas=${dramas.map(d => d.itemId).join(',')}`);
  check('T2b 翻译结果同时生效', updated === true && cardA?.titleZh === '甲' && cardA?.status === 'trans', JSON.stringify({ updated, cardA }));
  check('T2c 两卡俱在', dramas.length === 2, `len=${dramas.length} saved=${JSON.stringify(saved)}`);
}

// ---------- T3 并发双保存同 itemId：只入一条，且只有一次 saved=true ----------
{
  await resetDramasCache(); rawStore.dramas = [];
  const { release } = armPauseOnNextSet();
  const p1 = contentSaveSingleDrama(mk('C1', 'tt0003'));
  const p2 = contentSaveSingleDrama(mk('C2', 'tt0003'));
  await sleep(80);
  release();
  const flags = await Promise.all([p1, p2].map(p => p.catch(e => `threw:${e.message}`)));
  const count = (rawStore.dramas || []).filter(d => d.itemId === 'tt0003').length;
  check('T3a 同 itemId 并发保存只入一条', count === 1, `count=${count}`);
  check('T3b 恰好一次 saved=true', flags.filter(f => f === true).length === 1 && flags.filter(f => f === false).length === 1, JSON.stringify(flags));
}

// ---------- T4 弹窗单卡翻译走后台 applyTranslation 接口 ----------
{
  await resetDramasCache(); rawStore.dramas = [mk('D', 'tt0004')];
  const resp = await chromeStub.runtime.sendMessage({ action: 'applyTranslation', dramaId: 'id-D', result: { title: '丁', desc: '丁简介' } });
  const cardD = (rawStore.dramas || []).find(d => d.itemId === 'tt0004');
  check('T4a applyTranslation 接口存在且成功', resp?.success === true && resp?.updated === true, JSON.stringify(resp));
  check('T4b 翻译字段落库', cardD?.titleZh === '丁' && cardD?.descriptionZh === '丁简介' && cardD?.status === 'trans', JSON.stringify(cardD));
}

// ---------- T5 清空路径：弹窗消息接口已移除（v1.3.3 改「全部翻译」），安装初始化函数仍走队列 ----------
{
  await resetDramasCache(); rawStore.dramas = [mk('E', 'tt0005')];
  rawStore.lastScrape = '2026-07-09T00:00:00.000Z';
  const resp = await chromeStub.runtime.sendMessage({ action: 'clearDramas' });
  check('T5a clearDramas 消息接口已移除', resp === undefined, JSON.stringify(resp));
  await clearAllDramas(); // eslint-disable-line no-undef -- 安装初始化路径保留
  check('T5b clearAllDramas 清空且时间戳复位', Array.isArray(rawStore.dramas) && rawStore.dramas.length === 0 && rawStore.lastScrape === null, JSON.stringify({ dramas: rawStore.dramas, lastScrape: rawStore.lastScrape }));
}

// ---------- T6 genres 回填合并（v1.5.3）：去重命中只补缺失的 genres、其余字段不动 ----------
{
  await resetDramasCache(); rawStore.dramas = [mk('F', 'tt0006')];
  rawStore.lastScrape = '2026-01-01T00:00:00.000Z';
  const before = structuredClone(rawStore.dramas[0]);
  const resp = await chromeStub.runtime.sendMessage({ action: 'saveDrama',
    drama: { ...mk('F2', 'tt0006'), title: 'HIJACK', status: 'trans', genres: [' Romance ', '', 'Romance', 'Mystery'] } });
  const card = (rawStore.dramas || []).find(d => d.itemId === 'tt0006');
  check('T6a 回填响应仍 saved=false（非新增）', resp?.success === true && resp?.saved === false, JSON.stringify(resp));
  check('T6b genres 已补写（trim/去空/去重）', JSON.stringify(card?.genres) === JSON.stringify(['Romance', 'Mystery']), JSON.stringify(card?.genres));
  check('T6c 其余字段逐键不动（先到先得语义）',
    card?.id === before.id && card?.title === before.title && card?.status === before.status && card?.description === before.description,
    JSON.stringify(card));
  check('T6d 回填不刷新 lastScrape', rawStore.lastScrape === '2026-01-01T00:00:00.000Z', String(rawStore.lastScrape));
  const snapshot = JSON.stringify(rawStore.dramas);
  const again = await chromeStub.runtime.sendMessage({ action: 'saveDrama', drama: { ...mk('F3', 'tt0006'), genres: ['Other'] } });
  check('T6e 已有 genres 二次提交零改动（幂等）', again?.saved === false && JSON.stringify(rawStore.dramas) === snapshot, JSON.stringify(rawStore.dramas));
}

console.log = origLog; console.warn = origWarn;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
