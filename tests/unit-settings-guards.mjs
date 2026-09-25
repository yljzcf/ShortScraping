import './bootstrap.cjs';
// 设置页数据护栏单测（2026-09-25 审计批次 A；unit-unsubscribe-guard 同一范式：正则截取
// settings.js 里的真实函数源码 + 直接 eval 捕获本地桩）。订阅保存那条线在
// unit-unsubscribe-guard，这里管其余三件：
//   S1-S3 翻译 / Lark / 定时任务的 storage 优先保存：同一次写乐观置 configAheadOfFile[key]，
//         写回文件成功才清、失败保留（后台见标记不拿旧文件覆盖 storage，改推回服务端）；
//         失败提示不再说「下次唤醒会回读旧配置」；
//   S4    「从配置文件重载」＝以文件为准，同一次写清掉对应标记；tag.json 读失败时 tag 标记保留；
//   S5-S7 自动清理回收站 pruneTrash：空时按钮隐藏；导出文件是「导入恢复」原样能吃的
//         shortscraping-backup 形态（真跑一遍 handleImportFile 验证）；onChanged 跟随刷新。
// 用法：node tests/unit-settings-guards.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TranslateConfig = require(path.join(root, 'src/shared/translate-config.js'));
const ScheduleConfig = require(path.join(root, 'src/shared/schedule-config.js'));
const Lark = require(path.join(root, 'src/shared/lark.js'));
const SubscriptionConfig = require(path.join(root, 'src/shared/subscription-config.js'));
const TimelineCsv = require(path.join(root, 'src/shared/timeline-csv.js'));

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
const constValue = (name) => src.match(new RegExp(`const ${name} = '([^']+)';`))?.[1];
// eslint-disable-next-line no-unused-vars
const CONFIG_AHEAD_KEY = constValue('CONFIG_AHEAD_KEY');
// eslint-disable-next-line no-unused-vars
const PRUNE_TRASH_KEY = constValue('PRUNE_TRASH_KEY');
check('S0 两个共享键名与三方契约一致',
  CONFIG_AHEAD_KEY === 'configAheadOfFile' && PRUNE_TRASH_KEY === 'pruneTrash', `${CONFIG_AHEAD_KEY} ${PRUNE_TRASH_KEY}`);

// ---------- 桩 ----------
let trace;
let store;
let storageWrites;
let statusMessages;
let syncResults;   // { trans, lark, cron }：各 trySync* 的返回
let fileContents;  // fetchJsonFile 的返回，按文件名
let sentMessages;
let downloads;
let state;

function reset({ ahead, sync = {}, files = {}, stored = {} } = {}) {
  trace = [];
  store = structuredClone(stored);
  if (ahead) store[CONFIG_AHEAD_KEY] = structuredClone(ahead);
  storageWrites = [];
  statusMessages = [];
  syncResults = { trans: { ok: true }, lark: { ok: true }, cron: { ok: true }, ...sync };
  fileContents = files;
  sentMessages = [];
  downloads = [];
  state = { urlTags: [], translateConfig: {}, larkConfig: {}, scheduleConfig: {} };
}

globalThis.TranslateConfig = TranslateConfig;
globalThis.ScheduleConfig = ScheduleConfig;
globalThis.Lark = Lark;
globalThis.SubscriptionConfig = SubscriptionConfig;
globalThis.Blob = class Blob {
  constructor(parts, options) { this.text = parts.join(''); this.type = options?.type || ''; }
};
let onChangedListener = null;
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '9.9.9-test' }),
    async sendMessage(message) {
      sentMessages.push(message);
      if (message.action === 'updateAlarms') return { success: true };
      if (message.action === 'importDramas') {
        return { success: true, added: message.dramas.length, duplicates: 0, outOfScope: 0, invalid: 0 };
      }
      return undefined;
    }
  },
  storage: {
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        trace.push(`get:${list.join(',')}`);
        return Object.fromEntries(list.filter(key => key in store).map(key => [key, structuredClone(store[key])]));
      },
      async set(obj) {
        trace.push(`set:${Object.keys(obj).join(',')}`);
        storageWrites.push(structuredClone(obj));
        Object.assign(store, structuredClone(obj));
      }
    },
    onChanged: { addListener(fn) { onChangedListener = fn; } }
  }
};

/* eslint-disable no-unused-vars */
const DEFAULT_TRANSLATE_CONFIG = TranslateConfig.DEFAULT_CONFIG;
const showStatus = (text, ok) => { statusMessages.push({ text, ok }); };
const renderTranslateForm = () => {};
const renderLarkForm = () => {};
const renderScheduleForm = () => {};
const renderSubscriptions = () => {};
const renderConfigSummary = () => {};
const renderAll = () => {};
const updateSchedulePreviews = () => {};
const getScheduleText = () => 'schedule';
const getLarkText = () => 'lark';
const readTranslateConfigFromForm = () => ({ ...TranslateConfig.DEFAULT_CONFIG, translateMode: 'ai', aiApiKey: 'sk-test' });
const readLarkConfigFromForm = () => ({ ...Lark.DEFAULT_CONFIG, botEnabled: false });
const readScheduleConfigFromForm = () => ({ ...ScheduleConfig.DEFAULT_CONFIG, scheduleMode: 'interval', scrapeInterval: 3, translateInterval: 1 });
const trySyncTransConfig = async () => { trace.push('syncTrans'); return syncResults.trans; };
const trySyncLarkConfig = async () => { trace.push('syncLark'); return syncResults.lark; };
const trySyncCronConfig = async () => { trace.push('syncCron'); return syncResults.cron; };
const fetchJsonFile = async (fileName, fallback) => (fileName in fileContents ? structuredClone(fileContents[fileName]) : fallback);
const normalizeUrlTags = rawTags => SubscriptionConfig.normalizeUrlTags(rawTags);
const triggerDownload = (filename, blob) => { trace.push('download'); downloads.push({ filename, blob }); };
const formatStamp = () => '20260925-0900';
let externalUrlTagsCalls = [];
const handleExternalUrlTagsChange = (value) => { externalUrlTagsCalls.push(value); };
const trashButton = { hidden: true, disabled: true, textContent: '' };
const elements = { archive: { exportPruneTrash: trashButton } };

const normalizeTranslateConfig = eval(`(${grab('function normalizeTranslateConfig')})`);
const isConfigObject = eval(`(${grab('function isConfigObject')})`);
const configAheadPatch = eval(`(${grab('async function configAheadPatch')})`);
const clearConfigAhead = eval(`(${grab('async function clearConfigAhead')})`);
const downloadBackupFile = eval(`(${grab('function downloadBackupFile')})`);
const summarizePruneTrash = eval(`(${grab('function summarizePruneTrash')})`);
const renderPruneTrashButton = eval(`(${grab('function renderPruneTrashButton')})`);
const refreshPruneTrashButton = eval(`(${grab('async function refreshPruneTrashButton')})`);
const handleExportPruneTrash = eval(`(${grab('async function handleExportPruneTrash')})`);
const handleImportFile = eval(`(${grab('async function handleImportFile')})`);
const bindStorageEvents = eval(`(${grab('function bindStorageEvents')})`);
const saveTranslateConfig = eval(`(${grab('async function saveTranslateConfig')})`);
const saveLarkConfig = eval(`(${grab('async function saveLarkConfig')})`);
const saveScheduleConfig = eval(`(${grab('async function saveScheduleConfig')})`);
const reloadTranslateFromFile = eval(`(${grab('async function reloadTranslateFromFile')})`);
const reloadLarkFromFile = eval(`(${grab('async function reloadLarkFromFile')})`);
const reloadScheduleFromFile = eval(`(${grab('async function reloadScheduleFromFile')})`);
const reloadSubscriptionsFromFile = eval(`(${grab('async function reloadSubscriptionsFromFile')})`);
const applyConfig = eval(`(${grab('async function applyConfig')})`);
const reloadConfig = eval(`(${grab('async function reloadConfig')})`);
/* eslint-enable no-unused-vars */

const configWrite = (configKey) => storageWrites.find(write => configKey in write);
const lastStatus = () => statusMessages.at(-1) || {};

// ---------- S1-S3：storage 优先的三类配置 ----------
for (const { key, configKey, save, label } of [
  { key: 'trans', configKey: 'translateConfig', save: () => saveTranslateConfig(), label: '翻译' },
  { key: 'lark', configKey: 'larkConfig', save: () => saveLarkConfig(), label: 'Lark' },
  { key: 'cron', configKey: 'scheduleConfig', save: () => saveScheduleConfig(), label: '定时任务' }
]) {
  const other = key === 'trans' ? 'tag' : 'trans';
  const syncStep = { trans: 'syncTrans', lark: 'syncLark', cron: 'syncCron' }[key];

  reset({ ahead: { [other]: true }, sync: { [key]: { ok: false, error: '服务未启动' } } });
  await save();
  const write = configWrite(configKey);
  check(`S1a ${label}写回失败：领先标记与配置在同一次 set 里置位`,
    write?.[CONFIG_AHEAD_KEY]?.[key] === true, JSON.stringify(storageWrites));
  check(`S1b ${label}写回失败：标记保留、其它键的标记不被冲掉`,
    deepEq(store[CONFIG_AHEAD_KEY], { [other]: true, [key]: true }), JSON.stringify(store[CONFIG_AHEAD_KEY]));
  check(`S1c ${label}写回失败提示「本地保留、自动写回」，不再说回读旧配置`,
    lastStatus().ok === false && lastStatus().text.includes('自动写回') && !lastStatus().text.includes('回读'), lastStatus().text);

  reset({ ahead: { [other]: true } });
  await save();
  const setIndex = trace.findIndex(step => step.startsWith('set:') && step.includes(configKey));
  check(`S2a ${label}写回成功：置位早于 POST`, setIndex >= 0 && setIndex < trace.indexOf(syncStep), trace.join('>'));
  check(`S2b ${label}写回成功：本键标记被清、其它键保留`,
    deepEq(store[CONFIG_AHEAD_KEY], { [other]: true }), JSON.stringify(store[CONFIG_AHEAD_KEY]));
  check(`S2c ${label}写回成功提示成功`, lastStatus().ok === true, lastStatus().text);
}

// 非法 cron 依旧拒绝保存：不置标记、不写 storage
{
  reset();
  const invalid = eval(`(${grab('async function saveScheduleConfig')
    .replace('readScheduleConfigFromForm()', "({ scheduleMode: 'cron', scrapeCron: 'not a cron', translateCron: '0 * * * *' })")})`);
  await invalid();
  check('S3 非法配置拒绝保存时零写入（不留领先标记）', storageWrites.length === 0 && lastStatus().ok === false,
    JSON.stringify(storageWrites));
}

// ---------- S4：从配置文件重载＝以文件为准，同一次写清对应标记 ----------
{
  const allAhead = { tag: true, trans: true, lark: true, cron: true };
  const files = {
    'config/tag.json': [{ url: 'https://a.test/list', tags: ['A'] }],
    'config/trans.json': TranslateConfig.DEFAULT_CONFIG,
    'config/lark.json': Lark.DEFAULT_CONFIG,
    'config/cron.json': ScheduleConfig.DEFAULT_CONFIG
  };
  for (const [key, run, configKey] of [
    ['trans', reloadTranslateFromFile, 'translateConfig'],
    ['lark', reloadLarkFromFile, 'larkConfig'],
    ['cron', reloadScheduleFromFile, 'scheduleConfig'],
    ['tag', reloadSubscriptionsFromFile, 'urlTags']
  ]) {
    reset({ ahead: allAhead, files });
    await run();
    const write = configWrite(configKey);
    const expected = { ...allAhead };
    delete expected[key];
    check(`S4a 单项重载 ${key}：同一次写清掉本键标记、其余不动`,
      write && deepEq(write[CONFIG_AHEAD_KEY], expected), JSON.stringify(storageWrites));
  }

  reset({ ahead: allAhead, files: { ...files, 'config/tag.json': null } });
  await reloadSubscriptionsFromFile();
  check('S4b tag.json 读取失败：不写 storage，tag 标记保留', storageWrites.length === 0 && store[CONFIG_AHEAD_KEY].tag === true,
    JSON.stringify(storageWrites));

  reset({ ahead: allAhead, files });
  await reloadConfig();
  check('S4c「重新读取配置」全部取自文件：四个标记同一次写全清',
    deepEq(configWrite('urlTags')?.[CONFIG_AHEAD_KEY], {}), JSON.stringify(storageWrites));

  reset({ ahead: allAhead, files: { ...files, 'config/tag.json': null }, stored: { urlTags: [{ urlPattern: 'https://a.test/list', tags: ['A'] }] } });
  await reloadConfig();
  check('S4d「重新读取配置」tag.json 读失败（订阅沿用 storage）：只保留 tag 标记',
    deepEq(configWrite('urlTags')?.[CONFIG_AHEAD_KEY], { tag: true }), JSON.stringify(storageWrites));

  // A4 同口径：「重新读取配置」时 trans/lark/cron 读取或解析失败，沿用 storage 现值、保留其标记，
  // 不回落默认值（此前 trans.json 写坏一点「重新读取」就把 AI 模式与 Key 换成 MyMemory 默认）
  const localTrans = TranslateConfig.normalizeConfig({ translateMode: 'ai', aiApiKey: 'sk-local', aiModel: 'm' });
  const localLark = Lark.normalizeConfig({ botEnabled: true, botWebhookUrl: 'https://open.larksuite.com/open-apis/bot/v2/hook/local' });
  reset({
    ahead: allAhead,
    files: { ...files, 'config/trans.json': null, 'config/lark.json': [1, 2] },
    stored: { translateConfig: localTrans, larkConfig: localLark }
  });
  await reloadConfig();
  const reloadWrite = configWrite('translateConfig') || {};
  check('S4e「重新读取配置」trans/lark 读失败：沿用 storage 现值，不回落默认值',
    deepEq(reloadWrite.translateConfig, localTrans) && deepEq(reloadWrite.larkConfig, localLark), JSON.stringify(reloadWrite));
  check('S4f「重新读取配置」读失败的项保留领先标记，读成功的照常清',
    deepEq(reloadWrite[CONFIG_AHEAD_KEY], { trans: true, lark: true }), JSON.stringify(reloadWrite[CONFIG_AHEAD_KEY]));
  check('S4g「重新读取配置」读失败时提示点名文件且不报成功',
    lastStatus().ok === false && lastStatus().text.includes('trans.json') && lastStatus().text.includes('lark.json'), lastStatus().text);

  for (const [key, run, file] of [
    ['trans', reloadTranslateFromFile, 'config/trans.json'],
    ['lark', reloadLarkFromFile, 'config/lark.json'],
    ['cron', reloadScheduleFromFile, 'config/cron.json']
  ]) {
    reset({ ahead: allAhead, files: { ...files, [file]: null } });
    await run();
    check(`S4h 单项重载 ${key} 读取失败：零写入、标记保留、提示失败`,
      storageWrites.length === 0 && store[CONFIG_AHEAD_KEY][key] === true && lastStatus().ok === false && lastStatus().text.includes(file),
      JSON.stringify({ storageWrites, status: lastStatus() }));
  }
}

// ---------- S5：回收站按钮随内容显隐 ----------
const SUB = 'https://unit.test/list';
const trashDrama = (id, extra = {}) => ({
  id: `id-${id}`, itemId: id, title: `T-${id}`, source: 'imdb', status: 'new',
  sourceListUrl: SUB, scrapedAt: '2026-09-20T00:00:00.000Z', ...extra
});
const trash = [
  { at: '2026-09-21T00:00:00.000Z', reason: 'tag.json 回读', urls: [SUB], dramas: [trashDrama('tt1'), trashDrama('tt2', { titleZh: '旧译' })] },
  { at: '2026-09-22T00:00:00.000Z', reason: 'empty', urls: [], dramas: [] },
  { at: '2026-09-23T00:00:00.000Z', reason: '退订', urls: [SUB], dramas: [trashDrama('tt2', { titleZh: '新译', status: 'trans' }), trashDrama('tt3')] }
];

reset();
renderPruneTrashButton(undefined);
check('S5a 回收站缺席：按钮隐藏且禁用', trashButton.hidden === true && trashButton.disabled === true, JSON.stringify(trashButton));
renderPruneTrashButton([{ at: 'x', reason: 'y', urls: [], dramas: [] }]);
check('S5b 只有空批：仍隐藏', trashButton.hidden === true, JSON.stringify(trashButton));
reset({ stored: { [PRUNE_TRASH_KEY]: trash } });
await refreshPruneTrashButton();
check('S5c 有内容：显示「N 批 / M 条」（空批不计）',
  trashButton.hidden === false && trashButton.disabled === false && trashButton.textContent.includes('2 批 / 4 条'),
  JSON.stringify(trashButton));

// ---------- S6：导出＝导入恢复原样能吃的备份 ----------
reset({ stored: { [PRUNE_TRASH_KEY]: trash } });
await handleExportPruneTrash();
const exported = JSON.parse(downloads[0]?.blob?.text || '{}');
check('S6a 导出一份文件，文件名带 prune-trash 与时间戳',
  downloads.length === 1 && /^shortscraping-prune-trash-20260925-0900\.json$/.test(downloads[0].filename), downloads[0]?.filename);
check('S6b 与退订备份同一 shortscraping-backup 形态',
  exported.format === 'shortscraping-backup' && exported.backupVersion === 1 && exported.reason === 'prune-trash'
    && exported.count === 4 && Array.isArray(exported.dramas), JSON.stringify(Object.keys(exported)));
check('S6c 新批在前（同一条被清两次，导入先到先得留下最近那份）',
  deepEq(exported.dramas.map(d => `${d.itemId}:${d.titleZh || ''}`), ['tt2:新译', 'tt3:', 'tt1:', 'tt2:旧译']),
  JSON.stringify(exported.dramas.map(d => d.itemId)));
check('S6d 批次说明只含元数据（at/reason/urls/count），不重复塞条目',
  deepEq(exported.batches, [
    { at: trash[0].at, reason: trash[0].reason, urls: trash[0].urls, count: 2 },
    { at: trash[2].at, reason: trash[2].reason, urls: trash[2].urls, count: 2 }
  ]), JSON.stringify(exported.batches));
check('S6e 每条都过得了导入校验', exported.dramas.every(d => TimelineCsv.validateImportDrama(d) !== null), '');
check('S6f 不改动回收站本身（只读导出）', deepEq(store[PRUNE_TRASH_KEY], trash) && storageWrites.length === 0, JSON.stringify(storageWrites));

// 真跑一遍设置页的「导入 JSON 恢复」：它发给后台的条目必须就是导出的那批
{
  const text = downloads[0].blob.text;
  const event = { target: { value: 'C:\\fakepath\\x.json', files: [{ size: text.length, text: async () => text }] } };
  sentMessages = [];
  await handleImportFile(event);
  const importMsg = sentMessages.find(m => m.action === 'importDramas');
  check('S6g「导入恢复」原样接受导出文件并把全部条目交给后台',
    importMsg && deepEq(importMsg.dramas, exported.dramas) && lastStatus().ok === true, JSON.stringify(lastStatus()));
}

reset({ stored: { [PRUNE_TRASH_KEY]: [] } });
await handleExportPruneTrash();
check('S6h 回收站为空：不下载、给出提示', downloads.length === 0 && lastStatus().ok === false, JSON.stringify(statusMessages));

// ---------- S7：storage.onChanged 路由 ----------
reset();
externalUrlTagsCalls = [];
bindStorageEvents();
check('S7a 已挂 onChanged 监听', typeof onChangedListener === 'function', '');
onChangedListener({ [PRUNE_TRASH_KEY]: { newValue: trash } }, 'local');
check('S7b 后台写入回收站后按钮跟随刷新', trashButton.hidden === false && trashButton.textContent.includes('2 批 / 4 条'),
  JSON.stringify(trashButton));
onChangedListener({ [PRUNE_TRASH_KEY]: { newValue: undefined } }, 'local');
check('S7c 回收站被清空后按钮隐藏', trashButton.hidden === true, JSON.stringify(trashButton));
onChangedListener({ urlTags: { newValue: [{ urlPattern: SUB, tags: ['X'] }] } }, 'local');
check('S7d urlTags 变更交给 handleExternalUrlTagsChange', externalUrlTagsCalls.length === 1
  && externalUrlTagsCalls[0][0].urlPattern === SUB, JSON.stringify(externalUrlTagsCalls));
onChangedListener({ urlTags: { newValue: [] } }, 'sync');
check('S7e 非 local 区域的变更忽略', externalUrlTagsCalls.length === 1, JSON.stringify(externalUrlTagsCalls));

// ---------- S8：页面接线（按钮存在于「导出与恢复」、初始即隐藏） ----------
{
  const html = fs.readFileSync(path.join(root, 'src/settings/settings.html'), 'utf8');
  const button = html.match(/<button[^>]*id="btnExportPruneTrash"[^>]*>/)?.[0] || '';
  const importIndex = html.indexOf('id="btnImportJson"');
  const buttonIndex = html.indexOf('id="btnExportPruneTrash"');
  const sectionEnd = html.indexOf('</div>', importIndex);
  check('S8a 回收站按钮与「导入 JSON 恢复」同一组，初始 hidden', button.includes(' hidden')
    && importIndex > 0 && buttonIndex > importIndex && buttonIndex < sectionEnd, button);
  check('S8b init 读取回收站并挂 onChanged', /refreshPruneTrashButton\(\);/.test(grab('function init'))
    && /bindStorageEvents\(\);/.test(grab('function init')), '');
  check('S8c 按钮点击绑定到导出', /bindClick\(elements\.archive\.exportPruneTrash, handleExportPruneTrash\)/.test(src), '');
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
