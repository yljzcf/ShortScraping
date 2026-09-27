import './bootstrap.cjs';
// 后台权限面收口回归测试（2026-09-25 审查批次 D）：
//   M 组：chrome.runtime.onMessage 按发送方分流（bg-onmessage-no-sender-check / onmessage-no-sender-check）。
//     扩展页面＝sender.id 是本扩展且 sender.url 落在 chrome.runtime.getURL('') 之下——设置页以标签页
//     打开，同样带 sender.tab，不能只凭 sender.tab 判定。其余发送方一律按内容脚本对待，只放行
//     getScrapeContext / saveDrama / fetchDetailHtml；清库、导入、Lark 推送与测试发送、触发抓取 / 翻译等特权动作
//     回 success:false 且不产生任何副作用。
//   C 组 / M2c-M2e：内容脚本不再直连 storage（storage-secrets-exposed-to-content / full-table-read-per-scrape）——
//     抓取上下文经 getScrapeContext 向后台要，只给 itemId 与「是否已有 genres」；后台顶层尝试把
//     storage.local 收成 TRUSTED_CONTEXTS，该 API 不支持 / 同步抛错 / 异步拒绝都不能挡住初始化。
//     M2f（v1.6.21）：known 只给发送方标签页所在站点的条目，取不到站点时照旧给全部。
//   D 组：死代码 applyTranslation 处理器与 loadTranslator 已删除（applytranslation-dead-handler）。
//   F 组：scrapeUrlInTab 快路径失败后的「强制注入 + 轮询」兜底只对注册表站点放行
//     （host-permissions-overbroad）：订阅 URL 或标签页当前 URL 不属于 SiteRegistry 时报错、不注入。
// 驱动真实 background.js（tests/background-fixture.mjs），发送方按 Chrome 实际给出的形态构造。
// 用法：node tests/unit-message-sender.mjs（修复前 M1/M5/D/F2/F3/F5 应 RED）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { background, card } from './background-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const sleep = ms => new Promise(r => realSetTimeout(r, ms));
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

const EXT_ID = 'fixture';                        // 与 background-fixture 的 getURL 前缀一致
const EXT_BASE = `chrome-extension://${EXT_ID}/`;
const SENDERS = {
  popup: { id: EXT_ID, url: `${EXT_BASE}src/popup/popup.html`, origin: `chrome-extension://${EXT_ID}` },
  // 设置页 options_ui.open_in_tab：Chrome 给出的 sender 带 tab
  settingsTab: { id: EXT_ID, url: `${EXT_BASE}src/settings/settings.html`, tab: { id: 42 }, frameId: 0 },
  content: { id: EXT_ID, url: 'https://www.imdb.com/search/title/?genres=short', tab: { id: 7 }, frameId: 0, origin: 'https://www.imdb.com' }
};

// seed：初始 storage（dramas 要在 SW 启动前就位——启动时的队列读会把它装进 dramasCache，事后直改 bg.data 不进缓存）
async function setup(seed = {}) {
  const bg = await background({ data: seed });
  bg.context.chrome.runtime.id = EXT_ID;
  const warnings = [];
  bg.context.console = { log() {}, error() {}, warn: (...args) => warnings.push(args.join(' ')) };
  const fetchCalls = [];
  bg.context.fetch = async (url) => {
    fetchCalls.push(String(url));
    if (/^https:\/\/www\.netflix\.com\/title\//.test(String(url))) {
      return { ok: true, status: 200, async text() { return '<html>detail</html>'; } };
    }
    throw new Error('External network disabled in test');
  };
  // 返回 { sync, resp }：sync 为监听器的同步返回值，resp 为 sendResponse 收到的应答（未应答为 undefined）
  const send = (request, sender) => new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let sync;
    const sendResponse = resp => realSetTimeout(() => done({ sync, resp }), 0);
    sync = bg.listeners.message(request, sender, sendResponse);
    // 未保留异步通道且没应答：Chrome 会关端口，这里等一拍后按「无应答」收尾
    if (sync !== true) realSetTimeout(() => done({ sync, resp: undefined }), 20);
    else realSetTimeout(() => done({ sync, resp: undefined }), 2000);
  });
  return { bg, send, warnings, fetchCalls };
}

const REFUSED = /扩展页面/;
const PRIVILEGED = [
  { action: 'importDramas', dramas: [card('tt900')] },
  { action: 'pruneDramas', sites: ['imdb'], dryRun: true },
  { action: 'larkPush', dramaId: 'id_tt1' },
  { action: 'larkBotTestSend', config: { botWebhookUrl: 'https://attacker.example/hook', botEnabled: true } },
  { action: 'larkTestSend', config: { webhookUrl: 'http://127.0.0.1:31919/config/trans' } },
  { action: 'triggerScrape' },
  { action: 'triggerTranslate' },
  { action: 'translateSingle', dramaId: 'id_tt1' },
  { action: 'updateAlarms', force: true },
  { action: 'warmupCsvSync' },
  { action: 'getTranslateState' },
  { action: 'applyTranslation', dramaId: 'id_tt1', result: { title: '篡改', desc: '篡改' } },
  { action: 'noSuchAction' }
];

// ---------- M1 内容脚本发特权动作：一律拒绝、同步应答、零副作用 ----------
{
  const { bg, send, warnings, fetchCalls } = await setup();
  bg.data.dramas = [card('tt1')];
  const before = JSON.stringify(bg.data.dramas);
  const alarmsBefore = JSON.stringify([...bg.alarms.keys()]);
  const refused = [];
  for (const request of PRIVILEGED) {
    const { sync, resp } = await send(request, SENDERS.content);
    if (sync === false && resp?.success === false && REFUSED.test(resp?.error || '')) refused.push(request.action);
  }
  await sleep(30);
  check('M1a 内容脚本发来的每个非白名单动作都回 success:false（且不保留异步通道）',
    refused.length === PRIVILEGED.length, JSON.stringify(PRIVILEGED.map(r => r.action).filter(a => !refused.includes(a))));
  check('M1b 被拒后时间线原样（导入没进、清理没删、译文没被改写）',
    JSON.stringify(bg.data.dramas) === before, JSON.stringify(bg.data.dramas));
  check('M1c 被拒后没有任何外发请求（Lark webhook / 本地服务都不碰）',
    fetchCalls.length === 0, JSON.stringify(fetchCalls));
  check('M1d 被拒后定时任务未被重建', JSON.stringify([...bg.alarms.keys()]) === alarmsBefore, JSON.stringify([...bg.alarms.keys()]));
  check('M1e 每次拒绝都留一条 console.warn（点名动作与来源）',
    warnings.filter(w => w.includes('https://www.imdb.com/')).length === PRIVILEGED.length
      && warnings.some(w => w.includes('pruneDramas')),
    JSON.stringify(warnings));
}

// ---------- M2 内容脚本的白名单动作照常放行 ----------
{
  const { bg, send, fetchCalls } = await setup();
  const saved = await send({ action: 'saveDrama', drama: card('tt2') }, SENDERS.content);
  check('M2a 内容脚本 saveDrama 照常入库', saved.resp?.success === true && saved.resp?.saved === true
    && bg.data.dramas.some(d => d.itemId === 'tt2'), JSON.stringify(saved));
  const detail = await send({ action: 'fetchDetailHtml', url: 'https://www.netflix.com/title/81234567' }, SENDERS.content);
  check('M2b 内容脚本 fetchDetailHtml 照常经后台代理取 HTML',
    detail.resp?.success === true && detail.resp?.html === '<html>detail</html>'
      && fetchCalls.includes('https://www.netflix.com/title/81234567'), JSON.stringify(detail));
}

// ---------- M2c-M2e 抓取上下文：精简、不带密钥、排在写队列里 ----------
{
  const { bg, send } = await setup({
    dramas: [
      card('tt10', { genres: ['Drama'], description: '一段很长的简介', descriptionZh: '中文译文' }),
      card('tt11'),
      card('tt12', { genres: [] }),
      { id: 'no-item-id', title: '缺 itemId 的坏行', sourceListUrl: 'https://www.imdb.com/search/title/' }
    ],
    translateConfig: { aiApiKey: 'sk-unit-secret', aiEndpoint: 'https://ai.example/v1' },
    larkConfig: { feishuAppSecret: 'lark-unit-secret', botWebhookUrl: 'https://open.feishu.cn/hook/unit' }
  });
  const ctx = await send({ action: 'getScrapeContext' }, SENDERS.content);
  check('M2c 内容脚本 getScrapeContext → { success, urlTags, known: [[itemId, 是否已有 genres]] }（异步应答）',
    ctx.sync === true && ctx.resp?.success === true
      && JSON.stringify(Object.keys(ctx.resp).sort()) === JSON.stringify(['known', 'success', 'urlTags'])
      && JSON.stringify(ctx.resp.known) === JSON.stringify([['tt10', true], ['tt11', false], ['tt12', false]])
      && JSON.stringify(ctx.resp.urlTags) === JSON.stringify(bg.data.urlTags),
    JSON.stringify(ctx));
  const body = JSON.stringify(ctx.resp);
  check('M2d 应答不带整条记录（标题 / 简介 / 译文）也不带任何配置密钥',
    !['Fixture', '一段很长的简介', '中文译文', 'sk-unit-secret', 'lark-unit-secret', 'open.feishu.cn', 'ai.example'].some(t => body.includes(t)), body);
}
{
  // 读表排在写队列里：与一条 saveDrama 同时到达时，上下文里已经有那张新卡
  const { send } = await setup({ dramas: [card('tt20')] });
  const saving = send({ action: 'saveDrama', drama: card('tt21', { genres: ['Romance'] }) }, SENDERS.content);
  const reading = send({ action: 'getScrapeContext' }, SENDERS.content);
  const [saved, ctx] = await Promise.all([saving, reading]);
  check('M2e 上下文走写队列：并发的 saveDrama 先提交，known 里已含新卡',
    saved.resp?.saved === true && JSON.stringify([...(ctx.resp?.known || [])].sort()) === JSON.stringify([['tt20', false], ['tt21', true]]),
    JSON.stringify({ saved: saved.resp, known: ctx.resp?.known }));
}

{
  // M2f（v1.6.21）known 只给发送方标签页所在站点的条目：内容脚本只拿本站列表项的 itemId 查 known。
  // 本站按 source 或 sourceListUrl 所属站点任一命中；取不到站点时照旧给全部
  const RS = 'https://www.reelshort.com/';
  const { bg, send } = await setup();
  // SW 启动之后再种表：启动时 tag.json 回读只订了 IMDB，订阅外清理会先把 ReelShort 条目清掉
  bg.seedDramas([
    card('tt30'),
    card('tt31', { source: undefined }), // 缺 source：按 sourceListUrl 归 imdb
    card('rs32', { source: 'reelshort', sourceListUrl: RS }),
    card('rs33', { source: 'reelshort', sourceListUrl: 'https://unknown.example/legacy' }) // 按 source 归 reelshort
  ]);
  const knownIds = async sender => ((await send({ action: 'getScrapeContext' }, sender)).resp?.known || []).map(e => e[0]).sort().join(',');
  const imdbTab = await knownIds({ ...SENDERS.content, tab: { id: 7, url: 'https://www.imdb.com/search/title/?genres=short' } });
  const rsTab = await knownIds({ id: EXT_ID, url: `${RS}?list=hot`, tab: { id: 8, url: `${RS}?list=hot` }, frameId: 0 });
  const urlOnly = await knownIds({ id: EXT_ID, url: `${RS}?list=hot`, tab: { id: 9 }, frameId: 0 }); // 没给 tab.url：退回 sender.url
  const unknown = await knownIds({ id: EXT_ID, url: 'https://unknown.example/list', tab: { id: 10, url: 'https://unknown.example/list' }, frameId: 0 });
  check('M2f 抓取上下文的 known 只给发送方所在站点（source 或 sourceListUrl 命中），取不到站点时给全部',
    imdbTab === 'tt30,tt31' && rsTab === 'rs32,rs33' && urlOnly === 'rs32,rs33' && unknown === 'rs32,rs33,tt30,tt31',
    JSON.stringify({ imdbTab, rsTab, urlOnly, unknown }));
}

// ---------- C storage.local 访问级别收窄：尽力而为，绝不挡初始化 ----------
{
  const bgSrc = fs.readFileSync(path.join(root, 'src/background/background.js'), 'utf8');
  const callAt = bgSrc.indexOf('\nrestrictStorageToTrustedContexts();');
  const initAt = bgSrc.indexOf('const initPromise = ');
  check('C1 后台顶层、initPromise 之前调用 restrictStorageToTrustedContexts()',
    callAt >= 0 && initAt >= 0 && callAt < initAt, JSON.stringify({ callAt, initAt }));
  const { bg } = await setup();
  const defined = bg.run('typeof restrictStorageToTrustedContexts') === 'function';
  check('C1b restrictStorageToTrustedContexts 已定义', defined, bg.run('typeof restrictStorageToTrustedContexts'));
  if (defined) {
  const calls = [];
  const warnings = [];
  bg.context.console = { log() {}, error() {}, warn: (...args) => warnings.push(args.join(' ')) };
  const local = bg.context.chrome.storage.local;
  local.setAccessLevel = (arg) => { calls.push(arg); return Promise.resolve(); };
  bg.run('restrictStorageToTrustedContexts()');
  check('C2 支持时以 { accessLevel: TRUSTED_CONTEXTS } 调 storage.local.setAccessLevel',
    JSON.stringify(calls) === JSON.stringify([{ accessLevel: 'TRUSTED_CONTEXTS' }]), JSON.stringify(calls));
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  local.setAccessLevel = () => { throw new Error('This StorageArea does not support setting access level'); };
  let syncThrew = false;
  try { bg.run('restrictStorageToTrustedContexts()'); } catch (e) { syncThrew = true; }
  local.setAccessLevel = () => Promise.reject(new Error('Access level can only be set on session storage'));
  bg.run('restrictStorageToTrustedContexts()');
  delete local.setAccessLevel;
  let missingThrew = false;
  try { bg.run('restrictStorageToTrustedContexts()'); } catch (e) { missingThrew = true; }
  await sleep(20);
  process.off('unhandledRejection', onUnhandled);
  check('C3 同步抛错 / 异步拒绝 / API 不存在：都不抛出、无未处理拒绝，前两种各留一条告警',
    !syncThrew && !missingThrew && unhandled === 0 && warnings.filter(w => w.includes('访问级别')).length === 2,
    JSON.stringify({ syncThrew, missingThrew, unhandled, warnings }));
  }
}

// ---------- M3 弹窗（无 tab）与设置页（带 tab）都是扩展页面，特权动作照常执行 ----------
{
  const { bg, send } = await setup();
  const imported = await send({ action: 'importDramas', dramas: [card('tt3')] }, SENDERS.popup);
  check('M3a 弹窗 / 扩展页面 importDramas 照常导入', imported.resp?.success === true
    && bg.data.dramas.some(d => d.itemId === 'tt3'), JSON.stringify(imported));
  const preview = await send({ action: 'pruneDramas', sites: ['imdb'], dryRun: true }, SENDERS.settingsTab);
  check('M3b 设置页（带 sender.tab）pruneDramas 预览照常返回 previewToken',
    preview.resp?.success === true && typeof preview.resp?.previewToken === 'string' && preview.resp?.matched === 1,
    JSON.stringify(preview));
  const alarms = await send({ action: 'updateAlarms', force: true }, SENDERS.settingsTab);
  check('M3c 设置页 updateAlarms 照常应答', alarms.resp?.success === true, JSON.stringify(alarms));
  const state = await send({ action: 'getTranslateState' }, SENDERS.popup);
  check('M3d 弹窗 getTranslateState 照常应答（形状不变）', state.resp && typeof state.resp.running === 'boolean', JSON.stringify(state));
  const warm = await send({ action: 'warmupCsvSync' }, SENDERS.popup);
  check('M3e 弹窗 warmupCsvSync 照常应答', warm.resp?.success === true, JSON.stringify(warm));
}

// ---------- M4 扩展页面发白名单动作同样放行 ----------
{
  const { bg, send } = await setup();
  const saved = await send({ action: 'saveDrama', drama: card('tt4') }, SENDERS.popup);
  check('M4 扩展页面 saveDrama 放行', saved.resp?.success === true && bg.data.dramas.some(d => d.itemId === 'tt4'), JSON.stringify(saved));
}

// ---------- M5 冒充扩展页面的发送方都按内容脚本处理 ----------
{
  const { bg, send } = await setup();
  bg.data.dramas = [card('tt5')];
  const forged = {
    '他人扩展 id': { id: 'other-extension', url: `${EXT_BASE}src/popup/popup.html` },
    '前缀相近的扩展源': { id: EXT_ID, url: 'chrome-extension://fixture-evil/src/popup/popup.html', tab: { id: 3 } },
    '网页 URL 里夹带扩展源': { id: EXT_ID, url: `https://evil.example/${EXT_BASE}`, tab: { id: 3 } },
    '缺 url': { id: EXT_ID },
    '空发送方': {},
    'undefined 发送方': undefined
  };
  const leaked = [];
  for (const [label, sender] of Object.entries(forged)) {
    const { resp } = await send({ action: 'pruneDramas', sites: ['imdb'], dryRun: true }, sender);
    if (!(resp?.success === false && REFUSED.test(resp?.error || ''))) leaked.push({ label, resp });
  }
  check('M5 伪造 / 残缺发送方一律按内容脚本拒绝特权动作', leaked.length === 0, JSON.stringify(leaked));
}

// ---------- M6 白名单与 content.js 实际发送的动作一致 ----------
{
  const { bg } = await setup();
  const contentSrc = fs.readFileSync(path.join(root, 'src/content/content.js'), 'utf8');
  const sent = [...contentSrc.matchAll(/chrome\.runtime\.sendMessage\(\{\s*action:\s*'([^']+)'/g)].map(m => m[1]);
  const allow = bg.run("typeof CONTENT_SCRIPT_ACTIONS === 'undefined' ? [] : [...CONTENT_SCRIPT_ACTIONS]");
  check('M6 content.js 发送的每个动作都在 CONTENT_SCRIPT_ACTIONS 里，白名单也不多放',
    sent.length > 0 && JSON.stringify([...new Set(sent)].sort()) === JSON.stringify([...allow].sort()),
    JSON.stringify({ sent, allow }));
}

// ---------- D 死代码已删除 ----------
{
  const { bg, send } = await setup();
  bg.data.dramas = [card('tt6', { status: 'new' })];
  const before = JSON.stringify(bg.data.dramas);
  const r = await send({ action: 'applyTranslation', dramaId: 'id_tt6', result: { title: '篡改', desc: '篡改' } }, SENDERS.popup);
  await sleep(30);
  check('D1 扩展页面发 applyTranslation 也不再有处理器（无应答、卡片不动）',
    r.resp === undefined && r.sync !== true && JSON.stringify(bg.data.dramas) === before, JSON.stringify({ r, dramas: bg.data.dramas }));
  check('D2 loadTranslator 已删除', bg.run('typeof loadTranslator') === 'undefined', bg.run('typeof loadTranslator'));
}

// ---------- F 兜底强制注入只对注册表站点放行 ----------
// 快路径：加载完成事件照常来，但首次 sendMessage 失败（接收端不存在）→ 进兜底分支。
// 渲染等待 / 轮询间隔缩成毫秒级真定时器，整页期限放宽到 2 秒只作挂死保护
async function scrapeSetup({ tabUrl, tabsGet = 'ok' } = {}) {
  const { bg } = await setup();
  const pageTimeoutMs = bg.run('SCRAPE_PAGE_TIMEOUT_MS');
  const scaled = new Map([[pageTimeoutMs, 2000], [1500, 1], [30000, 50], [3000, 1]]);
  bg.context.setTimeout = (fn, ms, ...args) => (scaled.has(ms) ? realSetTimeout(fn, scaled.get(ms), ...args) : {});
  bg.context.clearTimeout = (t) => { if (t && typeof t.unref === 'function') realClearTimeout(t); };
  const log = { inject: [], removed: [], sends: 0 };
  let injected = false;
  bg.context.chrome.tabs = {
    async create({ url }) { log.createdUrl = url; return { id: 100 }; },
    async get(id) {
      if (tabsGet === 'throw') throw new Error(`No tab with id: ${id}.`);
      return { id, url: tabUrl ?? log.createdUrl };
    },
    async remove(id) { log.removed.push(id); },
    async sendMessage() {
      log.sends++;
      if (!injected) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { success: true, newCount: 0, subscribed: true, listCount: 0 };
    },
    onUpdated: {
      addListener(fn) { setImmediate(() => fn(100, { status: 'complete' })); },
      removeListener() {}
    }
  };
  bg.context.chrome.scripting = { async executeScript(opts) { log.inject.push(opts.target.tabId); injected = true; return []; } };
  const run = url => {
    bg.context.targetUrl = url;
    return Promise.race([
      bg.run('scrapeUrlInTab(targetUrl)').then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message })),
      sleep(3000).then(() => ({ ok: false, error: 'hung' }))
    ]);
  };
  return { bg, log, run };
}

{
  const { log, run } = await scrapeSetup();
  const out = await run('https://www.imdb.com/search/title/?genres=short');
  check('F1 注册表站点：快路径失败后照常强制注入并抓到结果', out.ok === true && out.v?.success === true
    && log.inject.length === 1 && log.removed.length === 1, JSON.stringify({ out, log }));
}
{
  const { log, run } = await scrapeSetup({ tabUrl: 'https://consent.example.com/?continue=imdb' });
  const out = await run('https://www.imdb.com/search/title/?genres=short');
  check('F2 订阅页跳到站外域名：不强制注入，报错点名「不属于已支持的站点」，标签页照常关闭',
    out.ok === false && /不属于已支持的站点/.test(out.error) && out.error.includes('consent.example.com')
      && log.inject.length === 0 && log.removed.length === 1, JSON.stringify({ out, log }));
}
{
  const { log, run } = await scrapeSetup();
  const out = await run('https://unknown.example/list');
  check('F3 订阅 URL 本身不属于注册表站点：不强制注入、报错',
    out.ok === false && /不属于已支持的站点/.test(out.error) && log.inject.length === 0, JSON.stringify({ out, log }));
}
{
  const { log, run } = await scrapeSetup({ tabsGet: 'throw' });
  const out = await run('https://www.royalroad.com/fictions/trending');
  check('F4 读不到标签页（tabs.get 失败）时按订阅 URL 判定，注册表站点照常兜底',
    out.ok === true && log.inject.length === 1, JSON.stringify({ out, log }));
}
{
  const { log, run } = await scrapeSetup({ tabUrl: '' });
  const out = await run('https://store.steampowered.com/category/visual_novel');
  check('F5 标签页 URL 不可见（非 http(s) 页面）按不属于任何站点处理：不注入',
    out.ok === false && /不属于已支持的站点/.test(out.error) && log.inject.length === 0, JSON.stringify({ out, log }));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
