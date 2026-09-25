import './bootstrap.cjs';
// 设置页「导出到多维表格 → 复制为表格格式」端到端单测（2026-09-25 审计 B6
// lark-export-watermark-gap + clipboard-failure-swallowed）。unit-settings-guards 同一范式：
// 正则截取 settings.js 里的真实函数源码 + 直接 eval 捕获本地桩（chrome.storage / 剪贴板 /
// 可控时钟）。水位线推进规则本身的穷举在 unit-lark-table W 组，这里只守设置页这一侧的接线：
//   K1-K3 copyTextToClipboard：两条路都失败时必须抛错（此前吞掉 execCommand 的 false，
//         「复制成功才推进水位线」的保护是死代码）；
//   K4    剪贴板失败 → 水位线原样不动、提示失败；
//   K5-K6 新水位线取在读 storage 之前再退安全余量：读库时正在落库的卡下次照常导出；
//   K7    余量窗口里已导出的条目下次不重导（Base 不去重）；
//   K8    只勾部分站点复制不推进全局水位线，其余站点的区间条目不丢；
//   K9    复制后提示其中多少条尚未翻译完；
//   K10-K11 撤销 = 重来上一批；旧版两字段状态照常读入。
// 用法：node tests/unit-lark-export-copy.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
require(path.join(root, 'src/shared/site-registry.js'));   // 挂 globalThis.SiteRegistry
const Lark = require(path.join(root, 'src/shared/lark.js'));
globalThis.Lark = Lark;

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const src = fs.readFileSync(path.join(root, 'src/settings/settings.js'), 'utf8');
function grab(head) {
  const found = src.match(new RegExp(`${head}[\\s\\S]*?\\n  \\}`));
  if (!found) check(`M0 能截取 ${head} 源码`, false, '源码里找不到');
  return found ? found[0] : 'function () { throw new Error("missing"); }';
}
const grabLine = (head) => src.match(new RegExp(`${head}[^\\n]*`))?.[0] || '';

// ---------- 桩 ----------
const RealDate = Date;
let clock = RealDate.parse('2026-09-25T10:00:00.000Z');
class FakeDate extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(clock); }
  static now() { return clock; }
}
globalThis.Date = FakeDate;
const iso = (ms) => new RealDate(ms).toISOString();
const MIN = 60 * 1000;

let store;
let statusMessages;
let clipboardMode;   // ok | fallbackOk | bothFail
let clipboardText;
let execCalls;
let attached;
let onDramasRead;    // 读完 dramas 快照「之后」才执行：模拟与复制并发落库的卡
const READ_LATENCY_MS = 1500;

function reset(stored = {}) {
  store = structuredClone(stored);
  statusMessages = [];
  clipboardMode = 'ok';
  clipboardText = null;
  execCalls = 0;
  attached = new Set();
  onDramasRead = null;
  selectedSites = [];
  elements.archive.larkExportSinceDate.value = '';
  elements.archive.larkExportHint.textContent = '';
  elements.archive.larkExportUndo.disabled = true;
}

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const snapshot = Object.fromEntries(list.filter(key => key in store).map(key => [key, structuredClone(store[key])]));
        if (list.includes('dramas')) {
          clock += READ_LATENCY_MS;
          const hook = onDramasRead;
          onDramasRead = null;
          if (hook) hook();
        }
        return snapshot;
      },
      async set(obj) { Object.assign(store, structuredClone(obj)); }
    }
  }
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    clipboard: {
      async writeText(text) {
        if (clipboardMode === 'ok') { clipboardText = text; return; }
        throw new Error('Document is not focused.');
      }
    }
  }
});
let lastTextarea = null;
globalThis.document = {
  createElement() {
    const node = { value: '', select() {}, remove() { attached.delete(node); } };
    return node;
  },
  body: { appendChild(node) { attached.add(node); lastTextarea = node; } },
  execCommand(command) {
    execCalls++;
    if (command === 'copy' && clipboardMode === 'fallbackOk') { clipboardText = lastTextarea.value; return true; }
    return false;
  }
};

let selectedSites = [];
const elements = {
  archive: {
    larkExportSiteList: { querySelectorAll: () => selectedSites.map(value => ({ value })) },
    larkExportSinceDate: { value: '' },
    larkExportHint: { textContent: '' },
    larkExportUndo: { disabled: true }
  }
};
/* eslint-disable no-unused-vars */
const showStatus = (text, ok) => { statusMessages.push({ text, ok }); };
const LARK_EXPORT_STATE_KEY = src.match(/const LARK_EXPORT_STATE_KEY = '([^']+)';/)?.[1];
const LARK_EXPORT_SAFETY_MARGIN_MS = eval(grabLine('const LARK_EXPORT_SAFETY_MARGIN_MS = ').replace(/^const \w+ = /, '').replace(/;$/, '') || '0');
const isLarkExportMarkEmpty = eval(grabLine('const isLarkExportMarkEmpty = ').replace(/^const \w+ = /, '').replace(/;$/, '') || 'undefined');
const formatLocalStamp = eval(`(${grab('function formatLocalStamp')})`);
const copyTextToClipboard = eval(`(${grab('async function copyTextToClipboard')})`);
const readLarkExportState = eval(`(${grab('async function readLarkExportState')})`);
const describeLarkExportMark = eval(`(${grab('function describeLarkExportMark')})`);
const refreshLarkExportHint = eval(`(${grab('async function refreshLarkExportHint')})`);
const handleLarkExportCopy = eval(`(${grab('async function handleLarkExportCopy')})`);
const handleLarkExportUndo = eval(`(${grab('async function handleLarkExportUndo')})`);
/* eslint-enable no-unused-vars */

check('K0 状态键名不变、安全余量为 2 分钟', LARK_EXPORT_STATE_KEY === 'larkExportState'
  && LARK_EXPORT_SAFETY_MARGIN_MS === 2 * MIN, `${LARK_EXPORT_STATE_KEY} ${LARK_EXPORT_SAFETY_MARGIN_MS}`);

const SUB = 'https://unit.test/list';
const drama = (itemId, source, savedAtMs, extra = {}) => ({
  id: `id-${itemId}`, itemId, title: itemId, source, status: 'trans', sourceListUrl: SUB,
  scrapedAt: iso(savedAtMs - 5000), savedAt: iso(savedAtMs), ...extra
});
const lastStatus = () => statusMessages.at(-1) || {};
const pastedKeys = () => (clipboardText || '').split('\n').filter(Boolean).map(line => line.split('\t')[1]).sort().join(',');
const exportState = () => store[LARK_EXPORT_STATE_KEY];
async function copyAt(ms, { sites = [], date = '' } = {}) {
  clock = ms;
  selectedSites = sites;
  elements.archive.larkExportSinceDate.value = date;
  clipboardText = null;
  await handleLarkExportCopy();
}

// ---------- K1-K3：剪贴板 ----------
{
  reset();
  clipboardMode = 'bothFail';
  let error = null;
  try { await copyTextToClipboard('x'); } catch (e) { error = e; }
  check('K1 writeText 与 execCommand 都失败时抛错（不再吞掉 execCommand 的 false）',
    error instanceof Error && execCalls === 1, `error=${error?.message} exec=${execCalls}`);
  check('K1b 兜底 textarea 用完即移除（失败分支也一样）', attached.size === 0, `attached=${attached.size}`);

  reset();
  clipboardMode = 'fallbackOk';
  error = null;
  try { await copyTextToClipboard('fallback-text'); } catch (e) { error = e; }
  check('K2 writeText 失败、execCommand 成功 → 正常返回', !error && clipboardText === 'fallback-text' && attached.size === 0,
    `error=${error?.message} text=${clipboardText}`);

  reset();
  error = null;
  try { await copyTextToClipboard('direct'); } catch (e) { error = e; }
  check('K3 writeText 成功 → 不走 execCommand', !error && clipboardText === 'direct' && execCalls === 0, '');
}

// ---------- K4：剪贴板失败不推进水位线 ----------
{
  const before = { lastCopiedAt: iso(clock - 60 * MIN), previousCopiedAt: '' };
  reset({ dramas: [drama('tt-1', 'imdb', clock - 10 * MIN)], [LARK_EXPORT_STATE_KEY]: before });
  clipboardMode = 'bothFail';
  await copyAt(clock);
  check('K4 剪贴板写入失败：水位线原样不动', deepEq(exportState(), before), JSON.stringify(exportState()));
  check('K4b 剪贴板写入失败：提示失败而不是「已复制」',
    lastStatus().ok === false && lastStatus().text.includes('写入剪贴板失败'), lastStatus().text);
}

// ---------- K5-K6：水位线取在读库之前再退安全余量 ----------
{
  const click = RealDate.parse('2026-09-25T12:00:00.000Z');
  reset({ dramas: [drama('tt-a', 'imdb', click - 30 * MIN)] });
  // 与复制并发：后台在读库期间给新卡打了 savedAt，整表写 storage 落在快照之后
  const racing = drama('st-race', 'steam', click + 500);
  onDramasRead = () => { store.dramas = [racing, ...store.dramas]; };
  await copyAt(click);
  check('K5 本次快照不含并发落库的卡', pastedKeys() === 'tt-a', pastedKeys());
  check('K5b 新水位线＝点击时刻（读库之前）再退 2 分钟',
    exportState()?.lastCopiedAt === iso(click - 2 * MIN), `${exportState()?.lastCopiedAt} vs ${iso(click - 2 * MIN)}`);
  await copyAt(click + 10 * MIN);
  check('K6 读库时正在落库的卡下一次照常导出（不被水位线永久挡住）', pastedKeys() === 'st-race',
    `${pastedKeys()} | ${lastStatus().text}`);
}

// ---------- K7：余量窗口的重叠不重导 ----------
{
  const click = RealDate.parse('2026-09-25T14:00:00.000Z');
  reset({ dramas: [drama('st-w', 'steam', click - 30 * 1000), drama('tt-old', 'imdb', click - 60 * MIN)] });
  await copyAt(click);
  const first = pastedKeys();
  await copyAt(click + 20 * 1000);
  check('K7 紧接着再复制：余量窗口里上一批已导出的条目不重导',
    first === 'st-w,tt-old' && clipboardText === null && lastStatus().ok === false && lastStatus().text.includes('没有新入库'),
    `first=${first} second=${pastedKeys()} ${lastStatus().text}`);
}

// ---------- K8：只勾部分站点复制，不丢其余站点 ----------
{
  const mon = RealDate.parse('2026-09-21T10:00:00.000Z');
  const tue = RealDate.parse('2026-09-22T10:00:00.000Z');
  const wed = RealDate.parse('2026-09-23T10:00:00.000Z');
  const thu = RealDate.parse('2026-09-24T10:00:00.000Z');
  reset({ dramas: [drama('st-1', 'steam', tue), drama('tt-1', 'imdb', tue)],
    [LARK_EXPORT_STATE_KEY]: { lastCopiedAt: iso(mon), previousCopiedAt: '' } });
  await copyAt(wed, { sites: ['steam'] });
  check('K8a 只勾 Steam：只复制 Steam', pastedKeys() === 'st-1', pastedKeys());
  check('K8b 只勾 Steam：全局水位线不动', exportState()?.lastCopiedAt === iso(mon), JSON.stringify(exportState()));
  check('K8c 提示里点名分站水位线', elements.archive.larkExportHint.textContent.includes('单独复制过')
    && elements.archive.larkExportHint.textContent.includes(SiteRegistry.SOURCE_NAMES.steam),
  elements.archive.larkExportHint.textContent);
  await copyAt(thu);
  check('K8d 随后不勾站点复制：Imdb 那段区间的条目仍导出、Steam 不重导', pastedKeys() === 'tt-1',
    `${pastedKeys()} | ${lastStatus().text}`);
}

// ---------- K9：未翻译提示 ----------
{
  const click = RealDate.parse('2026-09-25T16:00:00.000Z');
  reset({ dramas: [drama('tt-n1', 'imdb', click - 10 * MIN, { status: 'new' }),
    drama('tt-n2', 'imdb', click - 10 * MIN, { status: 'new', titleZh: '半成品' }),
    drama('tt-t', 'imdb', click - 10 * MIN)] });
  await copyAt(click);
  check('K9 复制成功后提示其中多少条尚未翻译完、不会自动补发',
    lastStatus().ok === true && lastStatus().text.includes('已复制 3 条') && lastStatus().text.includes('其中 2 条尚未翻译完')
    && lastStatus().text.includes('不会自动补发'), lastStatus().text);
  reset({ dramas: [drama('tt-t', 'imdb', click - 10 * MIN)] });
  await copyAt(click);
  check('K9b 全部已翻译：不提未翻译', lastStatus().ok === true && !lastStatus().text.includes('尚未翻译'), lastStatus().text);
}

// ---------- K10：撤销＝重来上一批 ----------
{
  const t0 = RealDate.parse('2026-09-25T18:00:00.000Z');
  reset({ dramas: [drama('st-u', 'steam', t0 - 60 * MIN), drama('tt-u', 'imdb', t0 - 60 * MIN)],
    [LARK_EXPORT_STATE_KEY]: { lastCopiedAt: iso(t0 - 3 * 60 * MIN), previousCopiedAt: '' } });
  await copyAt(t0, { sites: ['steam'] });
  const batch = pastedKeys();
  check('K10a 复制后撤销按钮可用', elements.archive.larkExportUndo.disabled === false, '');
  clock = t0 + 5 * MIN;
  await handleLarkExportUndo();
  check('K10b 撤销提示「重来上一批」', lastStatus().ok === true && lastStatus().text.includes('重来上一批'), lastStatus().text);
  await copyAt(t0 + 6 * MIN, { sites: ['steam'] });
  check('K10c 撤销后再复制＝上一批', batch === 'st-u' && pastedKeys() === batch, `batch=${batch} again=${pastedKeys()}`);
}

// ---------- K11：旧版两字段状态 ----------
{
  const last = RealDate.parse('2026-09-20T10:00:00.000Z');
  const prev = RealDate.parse('2026-09-19T10:00:00.000Z');
  reset({ dramas: [drama('tt-p', 'imdb', RealDate.parse('2026-09-19T20:00:00.000Z'))],
    [LARK_EXPORT_STATE_KEY]: { lastCopiedAt: iso(last), previousCopiedAt: iso(prev) } });
  await refreshLarkExportHint();
  check('K11a 旧状态：提示显示上次复制、撤销可用',
    elements.archive.larkExportHint.textContent.includes('上次复制') && elements.archive.larkExportUndo.disabled === false,
    elements.archive.larkExportHint.textContent);
  await handleLarkExportUndo();
  check('K11b 旧状态撤销：退回到 previousCopiedAt', exportState()?.lastCopiedAt === iso(prev), JSON.stringify(exportState()));
  await copyAt(RealDate.parse('2026-09-25T20:00:00.000Z'));
  check('K11c 退回后复制带出上一段区间的条目', pastedKeys() === 'tt-p', pastedKeys());
}

globalThis.Date = RealDate;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
