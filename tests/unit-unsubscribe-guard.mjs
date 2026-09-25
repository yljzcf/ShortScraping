import './bootstrap.cjs';
// 设置页退订闸门单测（buildurl 范式：正则截取 settings.js 里真实的 saveSubscriptions
// 源码 + 直接 eval 捕获本地桩）。
//
// 背景（2026-09-17 事故）：用户取消 Steam 订阅后 1847 条历史被静默删除，无提示无备份。
// 改前的 clearingAll 只护住「取消全部」一种情形；取消**部分**订阅既不提示也不备份，
// 且走 storage 优先——写 storage 触发 onChanged 立刻清库，若随后 config/tag.json
// 写回失败，下次 SW 唤醒从文件复活订阅，得到「历史没了、订阅回来了」。
//
// 本套件钉死三件事：① 有删除必先确认；② 备份下载严格早于任何 storage 写；
// ③ 有删除一律文件优先（tag.json 写失败就整体放弃，绝不先动 storage）。
// 2026-09-25 审计补三件：
// A1 退订确认后的那次 storage 写同时带 allowEmptySync:true（后台默认拒推空时间线）；
// A2 纯新增/改标签（storage 优先）同一次写乐观置 configAheadOfFile.tag，写回成功再清，
//    失败则保留——后台见标记不再拿旧 tag.json 回滚订阅、连带删新订阅下的历史；
// A3 差集基准是 storage 里此刻的订阅而不是页面快照 state.urlTags；别处改了订阅，
//    列表跟着刷新，本页有未保存勾选时明确提示。
// 批次 F（unsubscribe-backup-unverified）：备份下载只是发起、确认不了成败，确认框与成功提示要
//    告诉用户这批条目还在「自动清理回收站」可补导（G3j/G3k）；零历史与纯新增不提（G1d/G5d）。
// 用法：node tests/unit-unsubscribe-guard.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SubscriptionConfig = require(path.join(root, 'src/shared/subscription-config.js'));
const UrlMatch = require(path.join(root, 'src/shared/url-match.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const src = fs.readFileSync(path.join(root, 'src/settings/settings.js'), 'utf8');
function grab(head) {
  const found = src.match(new RegExp(`${head}[\\s\\S]*?\\n  \\}`));
  if (!found) {
    console.log(`FAIL  M0 无法截取 ${head} 源码`);
    process.exit(1);
  }
  return found[0];
}
// 确认文案与备份 payload 都用真实实现，不另写桩——桩会让「文案改了测试还绿」
const fnSrc = grab('async function saveSubscriptions');
const confirmTextSrc = grab('function buildUnsubscribeConfirmText');
const exportDoomedSrc = grab('function exportDoomedDramas');
const downloadBackupSrc = grab('function downloadBackupFile');
const configAheadPatchSrc = grab('async function configAheadPatch');
const clearConfigAheadSrc = grab('async function clearConfigAhead');
const externalChangeSrc = grab('function handleExternalUrlTagsChange');
const urlKeySrc = grab('function subscriptionUrlKey');
const aheadKeyMatch = src.match(/const CONFIG_AHEAD_KEY = '([^']+)';/);
// eslint-disable-next-line no-unused-vars
const CONFIG_AHEAD_KEY = aheadKeyMatch?.[1];

// ---------- 桩：被 saveSubscriptions 引用的全部外部名字 ----------
const SUB_A = 'https://a.test/list';
const SUB_B = 'https://b.test/list';

let trace;        // 调用序，断言「下载早于 storage 写」的唯一依据
let state;
let confirmReply;
let confirmTexts;
let downloads;
let storageWrites;
let statusMessages;
let syncTagResult;
let syncTagCalls;
let store;        // chrome.storage.local 的全部内容（get 按键取、set 合并）

// urlTags＝页面快照 state.urlTags；stored＝storage 里此刻的订阅（缺省与快照一致，
// 不同即模拟「别的标签页/后台已改过订阅」的过期页面）；ahead＝预置的领先标记
function reset({ urlTags, stored = urlTags, dramas, confirm: reply = true, sync = { ok: true }, ahead }) {
  trace = [];
  state = { urlTags: SubscriptionConfig.normalizeUrlTags(urlTags) };
  confirmReply = reply;
  confirmTexts = [];
  downloads = [];
  storageWrites = [];
  statusMessages = [];
  syncTagResult = sync;
  syncTagCalls = [];
  store = { urlTags: SubscriptionConfig.normalizeUrlTags(stored), dramas: structuredClone(dramas) };
  if (ahead) store[CONFIG_AHEAD_KEY] = structuredClone(ahead);
}
const urlTagWrites = () => storageWrites.filter(write => 'urlTags' in write);

// eslint-disable-next-line no-unused-vars
const normalizeUrlTags = rawTags => SubscriptionConfig.normalizeUrlTags(rawTags);
// 读 DOM 的那一段由测试直接给结果：本套件测的是闸门逻辑，不是勾选框渲染
let domSubscriptions = [];
// eslint-disable-next-line no-unused-vars
const readSubscriptionsFromDom = () => domSubscriptions;
// eslint-disable-next-line no-unused-vars
const renderSubscriptions = () => { trace.push('render'); };
// eslint-disable-next-line no-unused-vars
const renderConfigSummary = () => {};
// eslint-disable-next-line no-unused-vars
const showStatus = (text, ok) => { statusMessages.push({ text, ok }); };
// eslint-disable-next-line no-unused-vars
const trySyncConfig = async (route, body) => {
  // 写回统一走 trySyncConfig(route, body)（2026-09-25 审计 E 合并）；这里只该出现 tag 路由
  if (route !== '/config/tag' || !Array.isArray(body?.urlTags)) throw new Error(`意外的写回 ${route}`);
  trace.push('syncTag');
  syncTagCalls.push(SubscriptionConfig.normalizeUrlTags(body.urlTags).map(t => t.urlPattern));
  return syncTagResult;
};
// eslint-disable-next-line no-unused-vars
const triggerDownload = (filename, blob) => {
  trace.push('download');
  downloads.push({ filename, blob });
};
// eslint-disable-next-line no-unused-vars
const formatStamp = () => '20260917-1200';

globalThis.SubscriptionConfig = SubscriptionConfig;
globalThis.UrlMatch = UrlMatch;
globalThis.window = {
  confirm(text) { trace.push('confirm'); confirmTexts.push(text); return confirmReply; }
};
globalThis.Blob = class Blob {
  constructor(parts, options) { this.text = parts.join(''); this.type = options?.type || ''; }
};
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '1.6.7-test' }) },
  storage: {
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        trace.push(`get:${list.join(',')}`);
        return Object.fromEntries(list.filter(key => key in store).map(key => [key, structuredClone(store[key])]));
      },
      async set(obj) {
        trace.push('set');
        storageWrites.push(structuredClone(obj));
        Object.assign(store, structuredClone(obj));
      }
    }
  }
};

// eslint-disable-next-line no-unused-vars
const buildUnsubscribeConfirmText = eval(`(${confirmTextSrc})`);
// eslint-disable-next-line no-unused-vars
const exportDoomedDramas = eval(`(${exportDoomedSrc})`);
// eslint-disable-next-line no-unused-vars
const downloadBackupFile = eval(`(${downloadBackupSrc})`);
// eslint-disable-next-line no-unused-vars
const configAheadPatch = eval(`(${configAheadPatchSrc})`);
// eslint-disable-next-line no-unused-vars
const clearConfigAhead = eval(`(${clearConfigAheadSrc})`);
// eslint-disable-next-line no-unused-vars
const subscriptionUrlKey = eval(`(${urlKeySrc})`);
const handleExternalUrlTagsChange = eval(`(${externalChangeSrc})`);
const saveSubscriptions = eval(`(${fnSrc.replace('async function saveSubscriptions', 'async function')})`);

const dramasFixture = [
  { id: 'a1', itemId: 'a1', title: 'A-1', sourceListUrl: SUB_A },
  { id: 'a2', itemId: 'a2', title: 'A-2', sourceListUrl: SUB_A },
  { id: 'b1', itemId: 'b1', title: 'B-1', sourceListUrl: SUB_B },
  { id: 'b2', itemId: 'b2', title: 'B-2', sourceListUrl: `${SUB_B}/` }, // 尾斜杠形态也归 B
  { id: 'b3', itemId: 'b3', title: 'B-3', sourceListUrl: SUB_B }
];
const bothSubs = [{ urlPattern: SUB_A, tags: ['A'] }, { urlPattern: SUB_B, tags: ['B'] }];
const onlyA = [{ urlPattern: SUB_A, tags: ['A'] }];

// ---------- G1：没有删除时行为不变（零确认、零下载，storage 优先） ----------
reset({ urlTags: onlyA, dramas: dramasFixture });
domSubscriptions = bothSubs;              // 新增 B，纯新增
await saveSubscriptions();
check('G1a 纯新增不弹确认、不下载', !trace.includes('confirm') && downloads.length === 0, trace.join('>'));
check('G1b 纯新增仍写 storage 并回写 tag.json', urlTagWrites().length === 1 && syncTagCalls.length === 1, trace.join('>'));
check('G1c 纯新增沿用 storage 优先（set 早于 syncTag）',
  trace.indexOf('set') < trace.indexOf('syncTag'), trace.join('>'));
check('G1d 纯新增的成功提示不提备份/回收站（没有下载）',
  statusMessages.at(-1)?.ok === true && !/备份|回收站/.test(statusMessages.at(-1).text), statusMessages.at(-1)?.text);

// ---------- G2：有删除 + 用户点取消 → 什么都不做 ----------
reset({ urlTags: bothSubs, dramas: dramasFixture, confirm: false });
domSubscriptions = onlyA;                 // 退订 B
await saveSubscriptions();
check('G2a 退订会弹确认', confirmTexts.length === 1, trace.join('>'));
check('G2b 用户取消后零 storage 写', storageWrites.length === 0, trace.join('>'));
check('G2c 用户取消后零下载', downloads.length === 0, trace.join('>'));
check('G2d 用户取消后不写 tag.json', syncTagCalls.length === 0, trace.join('>'));

// ---------- G3：有删除 + 确认 → 备份严格早于 storage 写 ----------
reset({ urlTags: bothSubs, dramas: dramasFixture });
domSubscriptions = onlyA;
await saveSubscriptions();
check('G3a 确认后下载了备份', downloads.length === 1, trace.join('>'));
check('G3b 下载严格早于 storage 写',
  trace.indexOf('download') >= 0 && trace.indexOf('download') < trace.indexOf('set'), trace.join('>'));
check('G3c 确认早于下载',
  trace.indexOf('confirm') < trace.indexOf('download'), trace.join('>'));

const payload = JSON.parse(downloads[0]?.blob?.text || '{}');
check('G3d 备份是 shortscraping-backup 形态（导入恢复能直接吃）',
  payload.format === 'shortscraping-backup' && payload.backupVersion === 1 && Array.isArray(payload.dramas),
  JSON.stringify(Object.keys(payload)));
check('G3e 备份只含将被删的那 3 条（尾斜杠形态同样命中）',
  deepEq((payload.dramas || []).map(d => d.id), ['b1', 'b2', 'b3']),
  JSON.stringify((payload.dramas || []).map(d => d.id)));
check('G3f 备份文件名带 unsubscribed 与时间戳',
  /^shortscraping-unsubscribed-20260917-1200\.json$/.test(downloads[0]?.filename || ''), downloads[0]?.filename);
check('G3g 确认文案给出订阅条数与历史条数',
  confirmTexts[0].includes('1 条订阅') && confirmTexts[0].includes('3 条'), confirmTexts[0]);
check('G3h 确认文案点明不可恢复', confirmTexts[0].includes('不可恢复'), confirmTexts[0]);
check('G3i 最终只留 A 订阅', deepEq(state.urlTags.map(t => t.urlPattern), [SUB_A]),
  JSON.stringify(state.urlTags.map(t => t.urlPattern)));
// 下载只是发起（a.click() 拿不到另存为被取消 / 被拦的结果），没有 downloads 权限也确认不了；
// 兜底是后台清理前写的回收站（2026-09-25 审计 unsubscribe-backup-unverified）。文案要把这条退路
// 告诉用户，否则点了「取消另存为」会以为数据已经没了。批数与后台常量逐字对齐，防以后改了一边
const bgSrc = fs.readFileSync(path.join(root, 'src/background/background.js'), 'utf8');
const trashBatches = bgSrc.match(/const PRUNE_TRASH_MAX_BATCHES = (\d+);/)?.[1];
check('G3j 有历史的确认文案点明：下载被取消/拦截时仍可从「自动清理回收站」补导，批数与后台一致',
  Boolean(trashBatches) && confirmTexts[0].includes('自动清理回收站') && confirmTexts[0].includes(`保留最近 ${trashBatches} 批`)
    && confirmTexts[0].includes('取消或拦截'), `${trashBatches} | ${confirmTexts[0]}`);
check('G3k 退订成功提示说明备份已触发下载、没保存上可导出回收站',
  statusMessages.at(-1)?.ok === true && statusMessages.at(-1).text.includes('备份文件已触发下载')
    && statusMessages.at(-1).text.includes('回收站'), statusMessages.at(-1)?.text);

// ---------- G4：有删除一律文件优先——tag.json 写失败就整体放弃 ----------
reset({ urlTags: bothSubs, dramas: dramasFixture, sync: { ok: false, error: '服务未启动' } });
domSubscriptions = onlyA;
await saveSubscriptions();
check('G4a 退订时 syncTag 早于 set（文件优先）',
  trace.indexOf('syncTag') >= 0 && (trace.indexOf('set') === -1 || trace.indexOf('syncTag') < trace.indexOf('set')),
  trace.join('>'));
check('G4b tag.json 写失败则不动 storage', storageWrites.length === 0, trace.join('>'));
check('G4c tag.json 写失败给出失败提示', statusMessages.at(-1)?.ok === false, JSON.stringify(statusMessages));
check('G4d 写失败时 state.urlTags 未被改动',
  deepEq(state.urlTags.map(t => t.urlPattern), [SUB_A, SUB_B]),
  JSON.stringify(state.urlTags.map(t => t.urlPattern)));

// ---------- G5：退订但该订阅下没有历史 → 仍确认，但不产生空备份 ----------
reset({ urlTags: bothSubs, dramas: dramasFixture.filter(d => d.sourceListUrl === SUB_A) });
domSubscriptions = onlyA;
await saveSubscriptions();
check('G5a 零历史仍弹确认', confirmTexts.length === 1, trace.join('>'));
check('G5b 零历史不下载空备份', downloads.length === 0, trace.join('>'));
check('G5c 零历史文案不提备份', !confirmTexts[0].includes('备份'), confirmTexts[0]);
check('G5d 零历史退订的成功提示也不提备份/回收站', statusMessages.at(-1)?.ok === true
  && !/备份|回收站/.test(statusMessages.at(-1).text), statusMessages.at(-1)?.text);

// ---------- G6：取消全部订阅仍按原语义（clearingAll 只是 removed 的特例） ----------
reset({ urlTags: bothSubs, dramas: dramasFixture });
domSubscriptions = [];
await saveSubscriptions();
check('G6a 全退订弹确认并备份全部 5 条',
  confirmTexts.length === 1 && deepEq(JSON.parse(downloads[0].blob.text).dramas.map(d => d.id), ['a1', 'a2', 'b1', 'b2', 'b3']),
  trace.join('>'));
check('G6b 全退订文件优先', trace.indexOf('syncTag') < trace.indexOf('set'), trace.join('>'));
check('G6c 全退订最终清空订阅', deepEq(state.urlTags, []), JSON.stringify(state.urlTags));

// ---------- G7：只改标签不算退订 ----------
reset({ urlTags: bothSubs, dramas: dramasFixture });
domSubscriptions = [{ urlPattern: SUB_A, tags: ['改了'] }, { urlPattern: SUB_B, tags: ['B'] }];
await saveSubscriptions();
check('G7 改标签不触发确认与备份',
  confirmTexts.length === 0 && downloads.length === 0 && urlTagWrites().length === 1, trace.join('>'));
check('G7b 改标签不放行空时间线推送', storageWrites.every(write => !('allowEmptySync' in write)), JSON.stringify(storageWrites));

// ---------- A3：过期页面——差集基准必须是 storage 里此刻的订阅 ----------
const SUB_C = 'https://c.test/list';
// 页面快照只有 A；别的标签页已加了 B 并抓进 3 条历史。用户在本页（B 未勾）为了加 C 点保存：
// 拿快照算差集 removed=[]，会不确认不备份直接写 {A,C}，后台随即删光 B 的历史
reset({ urlTags: onlyA, stored: bothSubs, dramas: dramasFixture });
domSubscriptions = [{ urlPattern: SUB_A, tags: ['A'] }, { urlPattern: SUB_C, tags: ['C'] }];
await saveSubscriptions();
check('G8a 过期页面保存：以 storage 为基准识别出退订 B 并弹确认',
  confirmTexts.length === 1 && confirmTexts[0].includes(SUB_B) && confirmTexts[0].includes('3 条'), trace.join('>'));
check('G8b 过期页面保存：B 下 3 条历史先备份',
  deepEq(JSON.parse(downloads[0]?.blob?.text || '{}').dramas?.map(d => d.id), ['b1', 'b2', 'b3']), trace.join('>'));
check('G8c 基准读取早于确认', trace.indexOf('get:urlTags') >= 0 && trace.indexOf('get:urlTags') < trace.indexOf('confirm'),
  trace.join('>'));
check('G8d 按退订走文件优先', trace.indexOf('syncTag') < trace.indexOf('set'), trace.join('>'));

reset({ urlTags: onlyA, stored: bothSubs, dramas: dramasFixture, confirm: false });
domSubscriptions = [{ urlPattern: SUB_A, tags: ['A'] }, { urlPattern: SUB_C, tags: ['C'] }];
await saveSubscriptions();
check('G8e 过期页面保存：用户取消即零写入', storageWrites.length === 0 && syncTagCalls.length === 0, trace.join('>'));

// 反向：快照多、storage 少（别处已退订 B、其历史已删）。基准＝storage ∪ 快照，只会多确认不会
// 少确认：眼前这页 B 未勾，照样按退订走确认 + 文件优先，只是提示零历史、不产生空备份
reset({ urlTags: bothSubs, stored: onlyA, dramas: dramasFixture.filter(d => d.sourceListUrl === SUB_A) });
domSubscriptions = [{ urlPattern: SUB_A, tags: ['A'] }, { urlPattern: SUB_C, tags: ['C'] }];
await saveSubscriptions();
check('G8f 快照里有、storage 已无的订阅被勾掉：仍确认（零历史不备份）且文件优先',
  confirmTexts.length === 1 && confirmTexts[0].includes('暂无历史') && downloads.length === 0
    && trace.indexOf('syncTag') < trace.indexOf('set'), trace.join('>'));

// storage 缺席（页面按 tag.json 兜底渲染）时快照仍兜住退订
reset({ urlTags: bothSubs, stored: [], dramas: dramasFixture });
domSubscriptions = onlyA;
await saveSubscriptions();
check('G8g storage 无订阅时以快照兜底识别退订并备份',
  confirmTexts.length === 1 && deepEq(JSON.parse(downloads[0]?.blob?.text || '{}').dramas?.map(d => d.id), ['b1', 'b2', 'b3']),
  trace.join('>'));

// ---------- A1：退订确认后的那次写放行空时间线推送 ----------
reset({ urlTags: bothSubs, dramas: dramasFixture });
domSubscriptions = onlyA;
await saveSubscriptions();
check('G9a 部分退订：urlTags 与 allowEmptySync:true 在同一次 set 里',
  urlTagWrites().length === 1 && urlTagWrites()[0].allowEmptySync === true, JSON.stringify(storageWrites));

reset({ urlTags: bothSubs, dramas: dramasFixture });
domSubscriptions = [];
await saveSubscriptions();
check('G9b 全退订：同一次 set 带 allowEmptySync:true 且订阅清空',
  urlTagWrites().length === 1 && urlTagWrites()[0].allowEmptySync === true && deepEq(urlTagWrites()[0].urlTags, []),
  JSON.stringify(storageWrites));

reset({ urlTags: onlyA, dramas: dramasFixture });
domSubscriptions = bothSubs;
await saveSubscriptions();
check('G9c 纯新增不放行空时间线推送', storageWrites.every(write => !('allowEmptySync' in write)), JSON.stringify(storageWrites));

reset({ urlTags: bothSubs, dramas: dramasFixture, sync: { ok: false, error: '服务未启动' } });
domSubscriptions = [];
await saveSubscriptions();
check('G9d 退订写文件失败：不写 allowEmptySync', !('allowEmptySync' in store), JSON.stringify(store));

// ---------- A2：storage 优先的保存带领先标记，写回成功才清 ----------
reset({ urlTags: onlyA, dramas: dramasFixture, sync: { ok: false, error: '服务未启动' }, ahead: { trans: true } });
domSubscriptions = bothSubs;
await saveSubscriptions();
check('G10a 纯新增写回失败：标记与 urlTags 在同一次 set 里置位',
  urlTagWrites().length === 1 && urlTagWrites()[0][CONFIG_AHEAD_KEY]?.tag === true, JSON.stringify(storageWrites));
check('G10b 纯新增写回失败：tag 标记保留、其它标记不被冲掉',
  deepEq(store[CONFIG_AHEAD_KEY], { trans: true, tag: true }), JSON.stringify(store[CONFIG_AHEAD_KEY]));
check('G10c 失败提示改为「本地保留、自动写回」，不再说会回读旧订阅',
  statusMessages.at(-1)?.ok === false && statusMessages.at(-1).text.includes('自动写回')
    && !statusMessages.at(-1).text.includes('回读'), statusMessages.at(-1)?.text);

reset({ urlTags: onlyA, dramas: dramasFixture, ahead: { trans: true, tag: true } });
domSubscriptions = bothSubs;
await saveSubscriptions();
check('G10d 纯新增写回成功：先乐观置位（早于 POST），成功后清掉 tag、保留 trans',
  urlTagWrites()[0]?.[CONFIG_AHEAD_KEY]?.tag === true && trace.indexOf('set') < trace.indexOf('syncTag')
    && deepEq(store[CONFIG_AHEAD_KEY], { trans: true }), `${trace.join('>')} ${JSON.stringify(store[CONFIG_AHEAD_KEY])}`);

reset({ urlTags: bothSubs, dramas: dramasFixture, ahead: { tag: true, lark: true } });
domSubscriptions = onlyA;
await saveSubscriptions();
check('G10e 退订（文件已先写成）：同一次 set 清掉 tag 标记、保留 lark',
  urlTagWrites().length === 1 && deepEq(urlTagWrites()[0][CONFIG_AHEAD_KEY], { lark: true }), JSON.stringify(storageWrites));

reset({ urlTags: bothSubs, dramas: dramasFixture, sync: { ok: false, error: '服务未启动' }, ahead: { tag: true } });
domSubscriptions = onlyA;
await saveSubscriptions();
check('G10f 退订写文件失败：标记原样不动', deepEq(store[CONFIG_AHEAD_KEY], { tag: true }) && storageWrites.length === 0,
  JSON.stringify(store[CONFIG_AHEAD_KEY]));
check('G10g 退订失败提示点明要先写成配置文件、需启动同步服务',
  statusMessages.at(-1)?.text.includes('启动同步服务') && statusMessages.at(-1).text.includes('必须先写成配置文件'),
  statusMessages.at(-1)?.text);

// ---------- A3：别处改了订阅 → 列表刷新；有未保存勾选时提示 ----------
reset({ urlTags: bothSubs, dramas: [] });
domSubscriptions = bothSubs;
handleExternalUrlTagsChange(structuredClone(state.urlTags));
check('G11a 本页自己写入的回声事件等值短路（不重渲染、不提示）',
  !trace.includes('render') && statusMessages.length === 0, trace.join('>'));

reset({ urlTags: onlyA, dramas: [] });
domSubscriptions = onlyA;
handleExternalUrlTagsChange(bothSubs);
check('G11b 无未保存改动：state 刷新为 storage 新值并重渲染、不打扰',
  deepEq(state.urlTags.map(t => t.urlPattern), [SUB_A, SUB_B]) && trace.includes('render') && statusMessages.length === 0,
  `${trace.join('>')} ${JSON.stringify(statusMessages)}`);

reset({ urlTags: onlyA, dramas: [] });
domSubscriptions = [{ urlPattern: SUB_A, tags: ['A'] }, { urlPattern: SUB_C, tags: ['C'] }]; // 本页勾了 C 未保存
handleExternalUrlTagsChange(bothSubs);
check('G11c 有未保存勾选：刷新并明确提示「已在别处变更」',
  deepEq(state.urlTags.map(t => t.urlPattern), [SUB_A, SUB_B]) && trace.includes('render')
    && statusMessages.at(-1)?.ok === false && statusMessages.at(-1).text.includes('别处'),
  `${trace.join('>')} ${JSON.stringify(statusMessages)}`);

reset({ urlTags: bothSubs, dramas: [] });
domSubscriptions = bothSubs;
handleExternalUrlTagsChange(undefined);
check('G11d 订阅键被移除按空订阅刷新', deepEq(state.urlTags, []) && trace.includes('render'), trace.join('>'));

// 接线：页面必须真的挂了 onChanged，且 urlTags 变更路由到上面的处理函数
check('G12 init 挂 storage.onChanged，urlTags 变更交给 handleExternalUrlTagsChange',
  /bindStorageEvents\(\);/.test(grab('function init')) && /chrome\.storage\.onChanged\.addListener/.test(grab('function bindStorageEvents'))
    && /changes\.urlTags\) handleExternalUrlTagsChange\(changes\.urlTags\.newValue\)/.test(grab('function bindStorageEvents')), '');

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
