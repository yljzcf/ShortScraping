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
//   S10   提示条 last-write-wins：新消息清掉旧计时器，错误提示停留更久（settings-status-timer）；
//   S11   无障碍：label 都关联到控件、分页是 tablist/tab/tabpanel 且 switchTab 同步 aria-selected、
//         #statusMsg 是 role=status（settings-a11y-labels）；
//   S12   fetchJsonFile 失败一律回落 fallback（原 throw 分支是死代码：调用点全都传了 fallback）。
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
let syncResults;   // { trans, lark, cron }：trySyncConfig 按路由给的返回
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
// 写回统一走 trySyncConfig(route, body)（2026-09-25 审计 E 由四个 trySync*Config 合并）；
// 桩按路由分派，并校验 body 用的是服务端认的那个键
const SYNC_ROUTES = {
  '/config/trans': ['trans', 'translateConfig', 'syncTrans'],
  '/config/lark': ['lark', 'larkConfig', 'syncLark'],
  '/config/cron': ['cron', 'scheduleConfig', 'syncCron']
};
const trySyncConfig = async (route, body) => {
  const [key, bodyKey, step] = SYNC_ROUTES[route] || [];
  if (!key || !body || typeof body[bodyKey] !== 'object') throw new Error(`意外的写回 ${route} ${JSON.stringify(body)}`);
  trace.push(step);
  return syncResults[key];
};
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

// ---------- S9：真实的 trySyncConfig（四个保存入口共用的写回 helper，2026-09-25 审计 E） ----------
// 服务端拒绝写入回非 2xx + { ok:false, error }：原先先抛 HTTP 码，具体原因被丢掉
{
  // eslint-disable-next-line no-unused-vars
  const SYNC_BASE_URL = constValue('SYNC_BASE_URL');
  const SYNC_CONFIG_TIMEOUT_MS = Number(src.match(/const SYNC_CONFIG_TIMEOUT_MS = (\d+);/)?.[1]);
  const realTrySyncConfig = eval(`(${grab('async function trySyncConfig')})`);
  const requests = [];
  const respond = (status, body) => async (url, init) => {
    requests.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => { if (body === undefined) throw new SyntaxError('Unexpected token < in JSON'); return structuredClone(body); }
    };
  };
  const run = async (fetchImpl) => {
    const saved = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try { return await realTrySyncConfig('/config/cron', { scheduleConfig: { scheduleMode: 'interval' } }); } finally { globalThis.fetch = saved; }
  };

  check('S9a 同步服务地址常量', SYNC_BASE_URL === 'http://127.0.0.1:31919', String(SYNC_BASE_URL));
  const ok = await run(respond(200, { ok: true }));
  const sent = requests.at(-1);
  check('S9b 成功：POST 到 <base>/config/cron，application/json，body 原样序列化',
    ok.ok === true && sent.url === 'http://127.0.0.1:31919/config/cron' && sent.init.method === 'POST'
    && sent.init.headers['Content-Type'] === 'application/json'
    && sent.init.body === JSON.stringify({ scheduleConfig: { scheduleMode: 'interval' } }), JSON.stringify({ ok, sent }));
  const refused = await run(respond(500, { ok: false, error: 'Cron 配置无效——scrapeCron: 字段数不对' }));
  check('S9c 500 + JSON 错误：带出服务端给的原因（不再只有「HTTP 500」）',
    refused.ok === false && refused.error === 'Cron 配置无效——scrapeCron: 字段数不对', JSON.stringify(refused));
  const opaque = await run(respond(502));
  check('S9d 非 2xx 且不是 JSON：退回 HTTP 状态码', opaque.ok === false && opaque.error === 'HTTP 502', JSON.stringify(opaque));
  const noReason = await run(respond(403, { ok: false }));
  check('S9e 非 2xx 的 JSON 不带 error：仍报 HTTP 状态码', noReason.error === 'HTTP 403', JSON.stringify(noReason));
  const soft = await run(respond(200, { ok: false }));
  check('S9f 2xx 但 ok 不为 true：报「同步服务返回失败」', soft.ok === false && soft.error === '同步服务返回失败', JSON.stringify(soft));
  const garbled = await run(respond(200));
  check('S9g 2xx 却不是 JSON：照旧报解析错误', garbled.ok === false && /JSON/.test(garbled.error), JSON.stringify(garbled));
  const offline = await run(async () => { throw new TypeError('Failed to fetch'); });
  check('S9h 连不上：不抛错，以 { ok:false, error } 返回', offline.ok === false && offline.error === 'Failed to fetch', JSON.stringify(offline));
  check('S9i 四个保存入口都走 trySyncConfig，旧的 trySync*Config 已删除',
    ['/config/tag', '/config/trans', '/config/lark', '/config/cron'].every(route => src.includes(`trySyncConfig('${route}'`))
    && !/trySync(Tag|Trans|Lark|Cron)Config/.test(src), '');

  // v1.7.0：写回有期限且连正文一起算（以前没有期限，服务接了连接却不应答时「保存」一直转，
  // 退订前的文件写回预检同样卡死）。期限缩到 30ms 重新求值同一份函数源码
  check('S9j0 写回期限常量为正数（秒级）', SYNC_CONFIG_TIMEOUT_MS >= 1000 && SYNC_CONFIG_TIMEOUT_MS <= 30000, String(SYNC_CONFIG_TIMEOUT_MS));
  {
    // eslint-disable-next-line no-unused-vars, no-shadow
    const SYNC_CONFIG_TIMEOUT_MS = 30;
    const quickTrySyncConfig = eval(`(${grab('async function trySyncConfig')})`);
    const runQuick = async (fetchImpl) => {
      const saved = globalThis.fetch;
      globalThis.fetch = fetchImpl;
      try { return await quickTrySyncConfig('/config/tag', { urlTags: [] }); } finally { globalThis.fetch = saved; }
    };
    const stalledBody = await runQuick(async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) }));
    check('S9j 响应头来了、正文迟迟不发完：到期返回 { ok:false }（不再无限挂起）',
      stalledBody.ok === false && /秒内无响应/.test(stalledBody.error), JSON.stringify(stalledBody));
    const noHeaders = await runQuick(() => new Promise(() => {}));
    check('S9k 连响应头都不来：同样到期返回 { ok:false }',
      noHeaders.ok === false && /秒内无响应/.test(noHeaders.error), JSON.stringify(noHeaders));
  }
  check('S9l trySyncConfig 与 checkSyncServiceStatus 都走 FetchUtil.fetchWithDeadline（不再手写 AbortController）',
    /FetchUtil\.fetchWithDeadline\(/.test(grab('async function trySyncConfig'))
    && /FetchUtil\.fetchWithDeadline\(/.test(grab('async function checkSyncServiceStatus'))
    && !/new AbortController/.test(grab('async function checkSyncServiceStatus')), '');
}

// ---------- S10-S12：vm 跑真实 settings.js（只把 DOMContentLoaded 注册行换成导出内部函数） ----------
async function settingsVm({ fetchImpl } = {}) {
  const vm = await import('node:vm');
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const context = vm.createContext({
    SiteRegistry: require(path.join(root, 'src/shared/site-registry.js')),
    TranslateConfig, ScheduleConfig, Lark, SubscriptionConfig,
    UrlMatch: require(path.join(root, 'src/shared/url-match.js')),
    console: { log() {}, warn() {}, error() {} },
    document: { addEventListener() {} },
    chrome: { runtime: { getURL: p => `chrome-extension://unit-test/${p}` } },
    fetch: fetchImpl || (async () => { throw new TypeError('Failed to fetch'); }),
    setTimeout(fn, ms = 0) { const id = ++seq; timers.set(id, { due: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    AbortController, TextDecoder, Blob
  });
  // 与 settings.html 同序：fetch-util 先于 settings.js，且在本 vm 里求值（用 vm 的 fetch 与虚拟时钟）
  vm.runInContext(fs.readFileSync(path.join(root, 'src/shared/fetch-util.js'), 'utf8'), context);
  const marker = "document.addEventListener('DOMContentLoaded', init);";
  if (!src.includes(marker)) throw new Error('settings.js 的 DOMContentLoaded 注册行已变，夹具需同步');
  vm.runInContext(src.replace(marker, 'globalThis.fixture = { elements, showStatus, switchTab, fetchJsonFile };'), context);
  /** 虚拟时钟推进到 t，按到期先后触发。 */
  const advanceTo = (t) => {
    for (;;) {
      let next = null;
      for (const entry of timers) if (entry[1].due <= t && (!next || entry[1].due < next[1].due)) next = entry;
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].due;
      next[1].fn();
    }
    now = t;
  };
  return { fx: context.fixture, advanceTo };
}

{
  const { fx, advanceTo } = await settingsVm();
  const status = { textContent: '', className: 'status' };
  fx.elements.status = status;
  const shown = () => status.className.includes('show');

  fx.showStatus('读取配置失败：config/trans.json 解析失败', false);
  advanceTo(3000);
  fx.showStatus('已保存翻译接口配置，并写回 config/trans.json', true);
  advanceTo(4600);   // 第一条的 4.5s（旧实现唯一的时长）已过
  check('S10a 4.5 秒内连发两条：后一条不被前一条的计时器提前收掉（last-write-wins）',
    shown() && status.textContent.includes('已保存翻译接口配置') && status.className.includes('success'), status.className);
  advanceTo(3000 + 4500);
  check('S10b 成功提示按自己的时长（4.5 秒）收起', !shown(), status.className);

  fx.showStatus('未取消订阅：写回 config/tag.json 失败（服务未启动）', false);
  advanceTo(7500 + 6000);
  check('S10c 错误提示停留更久（6 秒时仍在，给长原因留出读完的时间）', shown() && status.className.includes('error'), status.className);
  advanceTo(7500 + 8000);
  check('S10d 错误提示最终也会收起', !shown(), status.className);
}

// ---------- S11 无障碍 ----------
{
  const html = fs.readFileSync(path.join(root, 'src/settings/settings.html'), 'utf8');
  const labels = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)];
  const controlIds = new Set([...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map(m => m[1]));
  const orphan = labels.filter(([, attrs, inner]) => {
    const target = attrs.match(/\bfor="([^"]+)"/)?.[1];
    if (target) return !controlIds.has(target);
    return !/<(?:input|select|textarea)\b/.test(inner);   // 包裹式写法
  }).map(([whole]) => whole.replace(/\s+/g, ' ').slice(0, 60));
  check('S11a 每个 <label> 都关联到控件（for 指向存在的 input/select/textarea，或包裹控件）',
    labels.length >= 20 && orphan.length === 0, `labels=${labels.length} orphan=${JSON.stringify(orphan)}`);
  for (const id of ['aiApiKey', 'larkFeishuAppSecret', 'larkWebhookUrl', 'larkBotWebhookUrl', 'translateMode']) {
    check(`S11b 敏感/关键输入框 #${id} 有 label[for]`, html.includes(`<label for="${id}">`), '');
  }

  const nav = html.match(/<nav\b[^>]*class="tabs"[^>]*>([\s\S]*?)<\/nav>/);
  const buttons = [...(nav?.[1] || '').matchAll(/<button\b([^>]*)>/g)].map(m => m[1]);
  const attr = (attrs, name) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
  const badTabs = buttons.filter(a => {
    const tab = attr(a, 'data-tab');
    const panel = html.match(new RegExp(`<section\\b[^>]*\\bid="tab-${tab}"[^>]*>`))?.[0] || '';
    return attr(a, 'role') !== 'tab' || attr(a, 'aria-controls') !== `tab-${tab}`
      || !/\brole="tabpanel"/.test(panel) || attr(panel, 'aria-labelledby') !== attr(a, 'id')
      || attr(a, 'aria-selected') !== String(/\bactive\b/.test(attr(a, 'class')));
  });
  check('S11c nav 是 role=tablist；每个分页按钮 role=tab、aria-controls 指向 role=tabpanel 的面板、初始 aria-selected 与 active 一致',
    /role="tablist"/.test(nav?.[0] || '') && buttons.length === 6 && badTabs.length === 0, JSON.stringify(badTabs));
  const statusDiv = html.match(/<div\b[^>]*id="statusMsg"[^>]*>/)?.[0] || '';
  check('S11d #statusMsg 是 role=status + aria-live=polite（读屏播报保存结果）',
    /role="status"/.test(statusDiv) && /aria-live="polite"/.test(statusDiv), statusDiv);

  const { fx } = await settingsVm();
  const fakeButton = tab => {
    const attrs = {};
    const classes = new Set();
    return {
      dataset: { tab }, attrs,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      classList: { toggle: (n, on) => { if (on) classes.add(n); else classes.delete(n); } },
      classes
    };
  };
  fx.elements.tabs = ['config', 'lark', 'archive'].map(fakeButton);
  fx.elements.panels = ['config', 'lark', 'archive'].map(t => ({ id: `tab-${t}`, classList: fakeButton(t).classList }));
  fx.switchTab('lark');
  check('S11e switchTab 同步 aria-selected（只有当前分页为 true）',
    JSON.stringify(fx.elements.tabs.map(b => b.attrs['aria-selected'])) === '["false","true","false"]'
    && fx.elements.tabs[1].classes.has('active'), JSON.stringify(fx.elements.tabs.map(b => b.attrs)));
}

// ---------- S12 fetchJsonFile ----------
{
  const { fx } = await settingsVm({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  let outcome;
  try { outcome = { value: await fx.fetchJsonFile('config/nope.json') }; } catch (e) { outcome = { error: e.message }; }
  check('S12a 读取失败一律回落 fallback（未传即 undefined），不再有抛错分支', 'value' in outcome && outcome.value === undefined,
    JSON.stringify(outcome));
  check('S12b 读取失败且传了 null：返回 null（「重新读取」据此判定该文件失败）', await fx.fetchJsonFile('config/nope.json', null) === null, '');
  const calls = [...src.matchAll(/fetchJsonFile\(([^)]*)\)/g)].map(m => m[1]).filter(args => !/^fileName/.test(args));
  check('S12c 调用点都显式传了 fallback', calls.length >= 9 && calls.every(args => args.split(',').length === 2), JSON.stringify(calls));
}

// ---------- S13 摘要卡用 textContent 组装（v1.7.0）：设置页唯一的 innerHTML 拼接点删掉后，不再需要私有的 escapeHtml ----------
check('S13 createSummaryCard 用 textContent、设置页不再留 escapeHtml',
  /textContent/.test(grab('function createSummaryCard')) && !/innerHTML/.test(grab('function createSummaryCard'))
    && !/function escapeHtml\(/.test(src) && !/escapeHtml\(/.test(src), '');

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
