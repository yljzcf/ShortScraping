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
// 用法：node tests/unit-unsubscribe-guard.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SubscriptionConfig = require(path.join(root, 'src/shared/subscription-config.js'));

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
let storedDramas;

function reset({ urlTags, dramas, confirm: reply = true, sync = { ok: true } }) {
  trace = [];
  state = { urlTags: SubscriptionConfig.normalizeUrlTags(urlTags) };
  confirmReply = reply;
  confirmTexts = [];
  downloads = [];
  storageWrites = [];
  statusMessages = [];
  syncTagResult = sync;
  syncTagCalls = [];
  storedDramas = dramas;
}

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
const trySyncTagConfig = async (tags) => {
  trace.push('syncTag');
  syncTagCalls.push(SubscriptionConfig.normalizeUrlTags(tags).map(t => t.urlPattern));
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
        trace.push(`get:${Array.isArray(keys) ? keys.join(',') : keys}`);
        return (keys === 'dramas' || (Array.isArray(keys) && keys.includes('dramas')))
          ? { dramas: structuredClone(storedDramas) }
          : {};
      },
      async set(obj) {
        trace.push('set');
        storageWrites.push(structuredClone(obj));
      }
    }
  }
};

// eslint-disable-next-line no-unused-vars
const buildUnsubscribeConfirmText = eval(`(${confirmTextSrc})`);
// eslint-disable-next-line no-unused-vars
const exportDoomedDramas = eval(`(${exportDoomedSrc})`);
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
check('G1b 纯新增仍写 storage 并回写 tag.json', storageWrites.length === 1 && syncTagCalls.length === 1, trace.join('>'));
check('G1c 纯新增沿用 storage 优先（set 早于 syncTag）',
  trace.indexOf('set') < trace.indexOf('syncTag'), trace.join('>'));

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
  confirmTexts.length === 0 && downloads.length === 0 && storageWrites.length === 1, trace.join('>'));

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
