import './bootstrap.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { background, card, PAGE_SENDER } from './background-fixture.mjs';
const require = createRequire(import.meta.url);
const Csv = require('../src/shared/timeline-csv.js');
const Config = require('../src/shared/translate-config.js');

// Watching over multiple hours must not postpone either interval alarm.
{
  const bg = await background();
  const original = bg.alarms.get('scrape-task').scheduledTime;
  const translate = bg.alarms.get('translate-task').scheduledTime;
  const base = Date.parse('2026-09-05T00:00:00Z');
  for (let hour = 1; hour <= 8; hour++) {
    bg.setTime(base + hour * 3600000);
    await bg.listeners.alarm({ name: 'watchdog' });
    assert.equal(bg.alarms.get('scrape-task').scheduledTime, original);
    assert.equal(bg.alarms.get('translate-task').scheduledTime, translate);
  }
  bg.alarms.delete('scrape-task');
  await bg.listeners.alarm({ name: 'watchdog' });
  assert.equal(bg.alarms.get('scrape-task').scheduledTime, base + 14 * 3600000);
  bg.data.scheduleConfig = { scheduleMode: 'cron', scrapeCron: '45 * * * *', translateCron: '50 * * * *' };
  await bg.run('setupAlarms()');
  bg.alarms.delete('scrape-task');
  await bg.listeners.alarm({ name: 'watchdog' });
  assert.equal(new Date(bg.alarms.get('scrape-task').scheduledTime).getUTCMinutes(), 45);
}

// Reject malformed records without rejecting the rest of an otherwise valid backup.
{
  const bg = await background();
  bg.context.fixture = [card('tt1', { titleZh: {} }), card('tt2', { tags: [{}] }), card('tt3', { scrapedAt: 'broken' }), card('tt4', { url: 'javascript:alert(1)' }), card('tt5')];
  const imported = await bg.run('importDramaRecords(fixture)');
  assert.equal(imported.added, 1);
  assert.equal(imported.invalid, 4);
  assert.equal(bg.data.dramas[0].itemId, 'tt5');
  bg.context.next = [card('tt6', { id: 'import_tt8' }), card('tt7', { id: 'collision' }), card('tt8', { id: 'collision' })];
  await bg.run('importDramaRecords(next)');
  const ids = bg.data.dramas.map(d => d.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(bg.data.dramas.find(d => d.itemId === 'tt8').id, 'import_tt8_1');
}

// Garbled translations in an old backup (U+FFFD from the pre-fix sync server) go back to the queue.
{
  const bg = await background();
  const done = { status: 'trans', translateAttempts: 2 };
  bg.context.fixture = [
    card('tt1', { ...done, titleZh: '完好标题', descriptionZh: '发现\uFFFD\uFFFD的强势掌控' }),
    card('tt2', { ...done, titleZh: '顶级\uFFFD\uFFFD\uFFFD会主厨', descriptionZh: '完好简介' }),
    card('tt3', { ...done, titleZh: '完好标题', descriptionZh: '完好简介' })
  ];
  assert.equal((await bg.run('importDramaRecords(fixture)')).added, 3);
  const byItem = Object.fromEntries(bg.data.dramas.map(d => [d.itemId, d]));
  assert.deepEqual([byItem.tt1.status, byItem.tt1.titleZh, byItem.tt1.descriptionZh], ['new', '完好标题', '']);
  assert.deepEqual([byItem.tt2.status, byItem.tt2.titleZh, byItem.tt2.descriptionZh], ['new', '', '完好简介']);
  assert.equal('translateAttempts' in byItem.tt1, false);
  assert.deepEqual([byItem.tt3.status, byItem.tt3.descriptionZh], ['trans', '完好简介']);
}

// 同一 readBody 缺陷写坏的原文（title/description/tags/genres）无法重建：不清空、只计数告警。
{
  const bg = await background();
  const warnings = [];
  bg.context.console.warn = (...args) => warnings.push(args.join(' '));
  const done = { status: 'trans', titleZh: '完好标题', descriptionZh: '完好简介' };
  bg.context.fixture = [
    card('tt1', { ...done, description: 'She didn\uFFFD\uFFFDt know' }),
    card('tt2', { ...done, title: 'Caf\uFFFD Love' }),
    card('tt3', { ...done, tags: ['IMDB', '视觉\uFFFD\uFFFD'] }),
    card('tt4', { ...done, genres: ['Rom\uFFFDnce'] }),
    card('tt5', { status: 'trans', title: 'Twice\uFFFD', titleZh: '坏\uFFFD译名', descriptionZh: '完好简介' }),
    card('tt6', done),
    card('tt1', { title: 'dup\uFFFD' }),                                             // 文件内自重：跳过，不计
    card('tt7', { title: 'out\uFFFD', sourceListUrl: 'https://unsubscribed.test/' }) // 订阅范围外：不计
  ];
  const imported = await bg.run('importDramaRecords(fixture)');
  assert.equal(imported.added, 6);
  assert.equal(imported.garbledSourceCount, 5);
  const byItem = Object.fromEntries(bg.data.dramas.map(d => [d.itemId, d]));
  // 原文原样保留；译文完好的条目不因原文乱码被退回重译
  assert.equal(byItem.tt1.description, 'She didn\uFFFD\uFFFDt know');
  assert.equal(byItem.tt2.title, 'Caf\uFFFD Love');
  assert.deepEqual([...byItem.tt3.tags], ['IMDB', '视觉\uFFFD\uFFFD']);
  assert.deepEqual([...byItem.tt4.genres], ['Rom\uFFFDnce']);
  assert.deepEqual([byItem.tt1.status, byItem.tt1.titleZh, byItem.tt1.descriptionZh], ['trans', '完好标题', '完好简介']);
  // 原文与译文都坏：译文照旧退回重译，原文照旧保留，只计一次
  assert.deepEqual([byItem.tt5.status, byItem.tt5.titleZh, byItem.tt5.title], ['new', '', 'Twice\uFFFD']);
  const warning = warnings.find(w => w.includes('原文含乱码'));
  assert.ok(warning && warning.includes('5 条') && warning.includes('tt3') && !warning.includes('tt6'), String(warnings));

  // 设置页据此如实告知「重新抓取不会覆盖」：去重命中的再抓取不改已有条目的原文
  bg.context.next = card('tt2', { id: 'fresh_tt2', title: 'Café Love', genres: ['Romance'] });
  assert.equal(await bg.run('saveDramaRecord(next)'), false);
  assert.equal(bg.data.dramas.find(d => d.itemId === 'tt2').title, 'Caf\uFFFD Love');

  // 干净的导入不报数也不告警
  warnings.length = 0;
  bg.context.clean = [card('tt8')];
  assert.equal((await bg.run('importDramaRecords(clean)')).garbledSourceCount, 0);
  assert.equal(warnings.some(w => w.includes('原文含乱码')), false);
}

// 导入/清理消息分支：处理函数里的同步异常（如逐条校验遇到日历非法的时间戳抛 RangeError）
// 也必须回 sendResponse——此前异常在 return true 之前冒出监听器，设置页永远等不到应答。
{
  const bg = await background();
  const send = request => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${request.action} 未回 sendResponse`)), 1000);
    try {
      bg.listeners.message(request, PAGE_SENDER, resp => { clearTimeout(timer); resolve(resp); });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
  // 共享校验模块是否已把非法日期计入 invalid 不影响这里：直接让校验同步抛错
  const validate = bg.run('TimelineCsv.validateImportDrama');
  bg.run('TimelineCsv.validateImportDrama = () => { throw new RangeError("Invalid time value"); }');
  const resp = await send({ action: 'importDramas', dramas: [card('tt1', { scrapedAt: '2026-13-45T25:59Z' })] });
  assert.equal(resp.success, false);
  assert.match(resp.error, /Invalid time value/);
  bg.context.validate = validate;
  bg.run('TimelineCsv.validateImportDrama = validate');
  // 真实数据：无论校验模块计 invalid 还是抛错，都必须有应答
  const real = await send({ action: 'importDramas', dramas: [card('tt2', { scrapedAt: '2026-13-01T00:00Z' }), card('tt3')] });
  assert.equal(typeof real.success, 'boolean');
  // pruneDramas 同一包装：参数非法照常经 sendResponse 回 success:false
  const pruned = await send({ action: 'pruneDramas', sites: ['nope'], dryRun: true });
  assert.equal(pruned.success, false);
  assert.match(pruned.error, /未知站点/);
}

// Preview tokens bind both criteria and membership, including same-count replacements.
{
  const bg = await background();
  bg.context.fixture = [card('tt1')];
  await bg.run('importDramaRecords(fixture)');
  const preview = await bg.run("pruneDramaRecords({ sites: ['imdb'], dryRun: true })");
  bg.context.token = preview.previewToken;
  bg.context.next = card('tt2');
  await bg.run('saveDramaRecord(next)');
  await assert.rejects(bg.run("pruneDramaRecords({ sites: ['imdb'], previewToken: token })"), /重新预览/);
  assert.equal(bg.data.dramas.length, 2);
  await assert.rejects(bg.run("pruneDramaRecords({ sites: ['imdb'] })"), /重新预览/);
  await assert.rejects(bg.run("pruneDramaRecords({ sites: ['steam'], previewToken: token })"), /重新预览/);
  await bg.run('clearAllDramas()');
  await bg.run('saveDramaRecord(next)');
  await assert.rejects(bg.run("pruneDramaRecords({ sites: ['imdb'], previewToken: token })"), /重新预览/);
  const fresh = await bg.run("pruneDramaRecords({ sites: ['imdb'], dryRun: true })");
  bg.context.token = fresh.previewToken;
  const deleted = await bg.run("pruneDramaRecords({ sites: ['imdb'], previewToken: token })");
  assert.equal(deleted.removed, fresh.matched);
}

{
  const bg = await background();
  bg.context.scrapeUrlInTab = async () => ({ success: true, data: [card('tt1', { status: 'trans' }), card('tt2')] });
  assert.equal((await bg.run('performScrapeOnce()')).totalNewCount, 2);
}

for (const input of ['=1+1', '+1', '-1', '@SUM(A1)', ' =1', '\t=1', '\r=1', '\n=1']) {
  assert.ok(Csv.csvEscape(input).startsWith('"\''), input);
}
// 全角符号不是任何表格软件的公式起始：合法中文文案不该被加撇号
for (const input of ['＝1', '－1℃的恋人', 'ordinary']) {
  assert.ok(!Csv.csvEscape(input).startsWith('"\''), input);
}
assert.equal(Csv.csvEscape('ordinary "text"'), '"ordinary ""text"""');
assert.equal(Csv.validateImportDrama(card('tt1', { itemId: 123 })).itemId, '123');
assert.equal(Csv.validateImportDrama(card('tt1', { itemId: Number.MAX_SAFE_INTEGER + 1 })), null);
// 封面取不到绝对地址只丢字段、不丢整条记录；结构性链接仍然严格
assert.equal(Csv.validateImportDrama(card('tt1', { poster: '/img/a.jpg' })).poster, '');
assert.equal(Csv.validateImportDrama(card('tt1', { poster: 'data:image/gif;base64,x' })).poster, '');
assert.equal(Csv.validateImportDrama(card('tt1', { sourceListUrl: 'javascript:alert(1)' })), null);
// 时间戳必须带时区，否则会被按宿主时区平移后固化
assert.equal(Csv.validateImportDrama(card('tt1', { scrapedAt: '2026/09/05' })), null);
assert.equal(Csv.validateImportDrama(card('tt1', { scrapedAt: '2026-09-05T01:00:00' })), null);
// tags/genres 与采集侧 cleanGenres 同口径清洗
assert.deepEqual([...Csv.validateImportDrama(card('tt1', { genres: ['', ' Romance ', 'Romance'] })).genres], ['Romance']);
assert.deepEqual([...Csv.validateImportDrama(card('tt1', { tags: ['', 'IMDB '] })).tags], ['IMDB']);
assert.equal(Config.normalizeConfig({ delayMs: 0, mode: 'ai' }).delayMs, 0);
assert.equal(Config.normalizeConfig({ mode: 'ai' }).translateMode, 'ai');
// 非法值回落到默认；默认 v1.5.14 由 10 提到 60（推理模型一批实测中位 17.4 秒）
assert.equal(Config.normalizeConfig({ requestTimeoutSec: -1 }).requestTimeoutSec, 60);
assert.equal(Config.normalizeConfig({ requestTimeoutSec: 15 }).requestTimeoutSec, 15);

// The manifest deliberately limits injection but keeps user-configurable API permissions.
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const Registry = require('../src/shared/site-registry.js');
assert.deepEqual(manifest.content_scripts[0].matches, Registry.contentScriptMatches());
assert.ok(manifest.host_permissions.includes('https://*/*'));
// dramas 单键已约 5MB（3617 条，月增约 2MB）：没有 unlimitedStorage 时 storage.local 的
// 10MB 配额约 3 个月后撞墙，且写失败只会 console.warn。该权限无安装警告文案。
assert.ok(manifest.permissions.includes('unlimitedStorage'));

// A late preview response must not re-enable confirmation after the user changes criteria.
{
  const elements = { archive: { pruneConfirm: {}, pruneResult: {} } };
  let resolvePreview;
  const context = vm.createContext({
    SiteRegistry: Registry, TranslateConfig: Config, ScheduleConfig: { DEFAULT_CONFIG: {} }, Lark: { DEFAULT_CONFIG: {} },
    SubscriptionConfig: require('../src/shared/subscription-config.js'),
    document: { addEventListener() {} }, chrome: { runtime: { sendMessage: () => new Promise(resolve => { resolvePreview = resolve; }) } }
  });
  let script = fs.readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');
  script = script.replace('document.addEventListener(\'DOMContentLoaded\', init);', "globalThis.fixture = { elements, handlePrunePreview, resetPruneConfirm, setCriteria: fn => { readPruneCriteria = fn; } };");
  vm.runInContext(script, context);
  Object.assign(context.fixture.elements, elements);
  context.fixture.setCriteria(() => ({ sites: ['imdb'] }));
  const pending = context.fixture.handlePrunePreview();
  context.fixture.resetPruneConfirm();
  resolvePreview({ success: true, matched: 1, total: 1, perSite: { imdb: 1 }, previewToken: 'old' });
  await pending;
  assert.equal(elements.archive.pruneConfirm.disabled, true);
  assert.equal(elements.archive.pruneConfirm.textContent, '确认删除');
}
// 切到 cron 模式时不能把旧的周期 alarm 当成 cron 一次性任务留下（非 force 路径：
// 手改 cron.json 后重载扩展、或同步服务未启动导致的文件回退都走这里）。
{
  const bg = await background();
  const periodic = bg.alarms.get('scrape-task');
  assert.equal(periodic.periodInMinutes, 360);
  const minute = new Date(periodic.scheduledTime).getMinutes();
  bg.data.scheduleConfig = { scheduleMode: 'cron', scrapeCron: `${minute} * * * *`, translateCron: `${minute} * * * *` };
  await bg.run('setupAlarms()');
  const after = bg.alarms.get('scrape-task');
  assert.notEqual(typeof after.periodInMinutes, 'number');
  assert.equal(new Date(after.scheduledTime).getMinutes(), minute);
  assert.ok(after.scheduledTime < periodic.scheduledTime);
}

// 重排请求不得把未改动任务的下一次执行推迟满一个周期（与看门狗饥饿同一机制）。
{
  const bg = await background();
  const before = bg.alarms.get('scrape-task').scheduledTime;
  bg.setTime(Date.parse('2026-09-05T00:10:00Z'));
  const resp = await new Promise(resolve => bg.listeners.message({ action: 'updateAlarms', force: true }, PAGE_SENDER, resolve));
  assert.equal(resp.success, true);
  assert.equal(bg.alarms.get('scrape-task').scheduledTime, before);
  bg.data.scheduleConfig = { scheduleMode: 'interval', scrapeInterval: 2, translateInterval: 1 };
  await new Promise(resolve => bg.listeners.message({ action: 'updateAlarms' }, PAGE_SENDER, resolve));
  assert.equal(bg.alarms.get('scrape-task').periodInMinutes, 120);
}

// 取消全部订阅：同步服务不可用时不得改动 storage——否则后台立刻清空整库，
// 而 config/tag.json 仍是旧订阅，下次 SW 唤醒又把订阅复活。
{
  const settingsFixture = (deps) => {
    const context = vm.createContext({
      SiteRegistry: Registry, TranslateConfig: Config, ScheduleConfig: { DEFAULT_CONFIG: {} }, Lark: { DEFAULT_CONFIG: {} },
    SubscriptionConfig: require('../src/shared/subscription-config.js'),
      UrlMatch: require('../src/shared/url-match.js'),
      document: { addEventListener() {} }, window: { confirm: () => true },
      // get 是 v1.6.7 退订闸门新增的读取点（算「这次会删掉几条历史」）；
      // 本夹具只验写失败的回滚语义，给空库即可——doomed 为 0 就不会走下载分支
      chrome: {
        storage: { local: { get: async () => ({}), set: deps.set } },
        runtime: { getManifest: () => ({ version: 'fixture' }), sendMessage: async () => ({ success: true }) }
      },
      fetch: deps.fetch
    });
    let script = fs.readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');
    script = script.replace('document.addEventListener(\'DOMContentLoaded\', init);',
      "globalThis.fixture = { state, saveSubscriptions, setDom: fn => { readSubscriptionsFromDom = fn; }, setStatus: fn => { showStatus = fn; } };"
      + " renderSubscriptions = () => {}; renderConfigSummary = () => {};");
    vm.runInContext(script, context);
    return context.fixture;
  };
  const SUBSCRIPTION = { urlPattern: 'https://www.imdb.com/search/title/', tags: ['IMDB'] };

  // 写文件失败 → storage 不动、订阅不变、提示点名复活风险
  {
    const writes = [];
    const status = [];
    const fx = settingsFixture({ set: async v => { writes.push(v); }, fetch: async () => { throw new Error('Failed to fetch'); } });
    fx.state.urlTags = [SUBSCRIPTION];
    fx.setDom(() => []);
    fx.setStatus((message, ok) => status.push({ message, ok }));
    await fx.saveSubscriptions();
    assert.deepEqual(writes, []);
    assert.deepEqual(fx.state.urlTags, [SUBSCRIPTION]);
    assert.equal(status.at(-1).ok, false);
    assert.match(status.at(-1).message, /回读恢复/);
  }

  // 写文件成功 → 照常清空 storage
  {
    const writes = [];
    const fx = settingsFixture({ set: async v => { writes.push(v); }, fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }) });
    fx.state.urlTags = [SUBSCRIPTION];
    fx.setDom(() => []);
    fx.setStatus(() => {});
    await fx.saveSubscriptions();
    // vm realm 的数组原型不同，用结构断言而非 deepEqual
    assert.equal(writes.length, 1);
    assert.equal(writes[0].urlTags.length, 0);
  }
}

// 导入结果提示：原文乱码条数单独点出，且不许诺「重新抓取即可修复」（去重命中不覆盖，见上）。
{
  const importNotice = async (resp) => {
    const status = [];
    const context = vm.createContext({
      SiteRegistry: Registry, TranslateConfig: Config, ScheduleConfig: { DEFAULT_CONFIG: {} }, Lark: { DEFAULT_CONFIG: {} },
      SubscriptionConfig: require('../src/shared/subscription-config.js'),
      document: { addEventListener() {} },
      chrome: { runtime: { sendMessage: async () => resp } }
    });
    let script = fs.readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');
    script = script.replace('document.addEventListener(\'DOMContentLoaded\', init);',
      "globalThis.fixture = { handleImportFile, setStatus: fn => { showStatus = fn; } };");
    vm.runInContext(script, context);
    context.fixture.setStatus((message, ok) => status.push({ message, ok }));
    const file = { size: 10, text: async () => JSON.stringify({ dramas: [] }) };
    await context.fixture.handleImportFile({ target: { files: [file], value: 'backup.json' } });
    return status.at(-1);
  };
  const base = { success: true, added: 3, duplicates: 1, outOfScope: 0, invalid: 0, total: 4 };
  const garbled = await importNotice({ ...base, garbledSourceCount: 2 });
  assert.equal(garbled.ok, true);
  assert.match(garbled.message, /^导入完成：新增 3 条/);
  assert.match(garbled.message, /其中 2 条原文含乱码字符/);
  assert.match(garbled.message, /重新抓取不会覆盖/);
  for (const resp of [{ ...base, garbledSourceCount: 0 }, base]) { // 旧版后台不带该字段
    const clean = await importNotice(resp);
    assert.equal(clean.ok, true);
    assert.doesNotMatch(clean.message, /乱码/);
  }
}

// SW 初始化只跑一遍（审查 double-init-on-install-startup）：顶层 initPromise 负责配置恢复 + 装定时
// 任务；onInstalled / onStartup 不再各自再跑一遍——此前同一实例里两条迁移链并发，标记未置位时
// ReelShort / Shortical 迁移的网络阶段各跑一遍。settle:false＝SW 为分发事件刚启动、初始化仍在飞。
{
  const configLoads = bg => bg.log.filter(e => e === 'fetch:chrome-extension://fixture/config/tag.json').length;
  const watchdogInstalls = bg => bg.log.filter(e => e === 'alarm:watchdog').length;
  const SETTINGS_TAB = 'tab:chrome-extension://fixture/src/settings/settings.html';
  const drain = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  };

  // 普通唤醒（闹钟 / 消息把 SW 拉起，不派发生命周期事件）：配置恢复与装定时任务各一次，不开页、不清库
  {
    const bg = await background({ data: { dramas: [card('tt1')] } });
    assert.equal(configLoads(bg), 1);
    assert.equal(watchdogInstalls(bg), 1);
    assert.deepEqual(['watchdog', 'scrape-task', 'translate-task'].filter(name => bg.alarms.has(name)), ['watchdog', 'scrape-task', 'translate-task']);
    assert.equal(bg.log.some(e => e.startsWith('tab:')), false);
    assert.equal(bg.data.dramas.length, 1);
  }

  // 浏览器启动：onStartup 只等顶层初始化落定（返回时定时任务已装好），不再自跑一遍
  {
    const bg = await background({ settle: false });
    assert.equal(bg.alarms.has('watchdog'), false, '派发时顶层初始化应仍在飞');
    await bg.listeners.startup();
    assert.equal(bg.alarms.has('watchdog'), true);
    await drain();
    assert.equal(configLoads(bg), 1);
    assert.equal(watchdogInstalls(bg), 1);
  }

  // 首次安装：清库 + 打开设置页各一次，且排在顶层初始化（订阅外清理、迁移、装定时任务）之后
  {
    const bg = await background({ settle: false, data: { dramas: [card('tt1')], lastScrape: '2026-09-05T00:00:00.000Z' } });
    await bg.listeners.installed({ reason: 'install' });
    await drain();
    assert.equal(configLoads(bg), 1);
    assert.equal(watchdogInstalls(bg), 1);
    assert.deepEqual(bg.data.dramas, []);
    assert.equal(bg.data.lastScrape, null);
    assert.equal('lastTranslate' in bg.data, false, 'lastTranslate 无读取方，清库不再写它');
    // 整表写同一次 set 连带换 dramasStamp（v1.6.22 冷启动指纹），放在调用方的连带键之后
    const clearAt = bg.log.indexOf('set:dramas,lastScrape,dramasStamp');
    const lastMigrationAt = bg.log.indexOf('set:shorticalCanonicalIdsMigrated');
    const alarmsAt = bg.log.indexOf('alarm:translate-task');
    assert.ok(lastMigrationAt >= 0 && alarmsAt >= 0, bg.log.join(' | '));
    assert.ok(clearAt > lastMigrationAt, `清库须在最后一条迁移之后: ${bg.log.join(' | ')}`);
    assert.ok(clearAt > alarmsAt, `清库须在装定时任务之后: ${bg.log.join(' | ')}`);
    assert.deepEqual(bg.log.filter(e => e.startsWith('tab:')), [SETTINGS_TAB]);
    assert.ok(bg.log.indexOf(SETTINGS_TAB) > clearAt);
  }

  // 扩展升级：顶层初始化已覆盖，onInstalled 不清库、不开页、不重跑，只作废冷启动指纹（v1.6.22，
  // 强推由 unit-csv-coldstart U 组覆盖）
  {
    const bg = await background({
      settle: false,
      data: { dramas: [card('tt1')], dramasStamp: { rev: 'old', pending: 1 }, csvLastPush: { rev: 'old', tagsKey: '', serverHash: 'h' } }
    });
    await bg.listeners.installed({ reason: 'update' });
    await drain();
    assert.equal(configLoads(bg), 1);
    assert.equal(watchdogInstalls(bg), 1);
    assert.equal(bg.data.dramas.length, 1);
    assert.equal(bg.log.some(e => e.startsWith('tab:')), false);
    assert.equal('csvLastPush' in bg.data, false, bg.log.join(' | '));
    assert.notEqual(bg.data.dramasStamp?.rev, 'old', '旧指纹须作废（清掉，或已被本版本的写换成新 rev）');
  }
}

// 联网迁移挂住不得拦住定时任务安装（审查 setupalarms-gated-by-network-migrations）：此前顶层是
// 「整条迁移链跑完再 setupAlarms」，Shortical sitemap 请求挂住（无超时）时看门狗与定时任务永远
// 装不上；SW 在挂住期间被回收的话每次唤醒从头再卡一遍。现 setupAlarms 在种子 set 之后、迁移链
// 之前执行，联网迁移的请求带 20s 期限（小于 SW 30s 空闲回收阈值）。
{
  let sitemapOptions = null;
  const bg = await background({
    data: {
      dramas: [card('sc2200', { source: 'shortical', url: 'https://shortical.com/drama/bound-by-fire-2200' })]
    },
    fetch: (url, options) => {
      if (!String(url).includes('shortical.com/sitemaps/')) return undefined;
      sitemapOptions = options;
      return new Promise(() => {}); // 请求一直挂着，永不 resolve
    }
  });
  assert.ok(sitemapOptions, `应已发出 Shortical sitemap 请求: ${bg.log.join(' | ')}`);
  assert.equal(bg.data.shorticalCanonicalIdsMigrated, undefined, '迁移应仍卡在请求上');
  assert.deepEqual(['watchdog', 'scrape-task', 'translate-task'].filter(name => bg.alarms.has(name)),
    ['watchdog', 'scrape-task', 'translate-task'], `迁移挂住时定时任务仍须装好: ${bg.log.join(' | ')}`);
  assert.ok(bg.log.indexOf('alarm:watchdog') < bg.log.indexOf('fetch:https://shortical.com/sitemaps/series.xml'),
    `看门狗须先于联网迁移安装: ${bg.log.join(' | ')}`);
  assert.equal(typeof sitemapOptions.signal?.aborted, 'boolean', 'sitemap 请求须带超时 signal');
  assert.equal(sitemapOptions.signal.aborted, false);
}

// ReelShort 播放页迁移的逐条请求同样带超时 signal
{
  const signals = [];
  await background({
    data: {
      rsEpisodeUrlMigrated: undefined,
      dramas: [card('rs1', { source: 'reelshort', url: 'https://www.reelshort.com/movie/some-drama-abc123' })]
    },
    fetch: (url, options) => {
      if (!String(url).startsWith('https://www.reelshort.com/')) return undefined;
      signals.push(options?.signal);
      return new Promise(() => {});
    }
  });
  assert.equal(signals.length, 1);
  assert.equal(typeof signals[0]?.aborted, 'boolean', 'ReelShort 迁移请求须带超时 signal');
}

console.log('Audit regression scenarios passed');
