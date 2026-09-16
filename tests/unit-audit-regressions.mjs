import './bootstrap.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { background, card } from './background-fixture.mjs';
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
  const resp = await new Promise(resolve => bg.listeners.message({ action: 'updateAlarms', force: true }, {}, resolve));
  assert.equal(resp.success, true);
  assert.equal(bg.alarms.get('scrape-task').scheduledTime, before);
  bg.data.scheduleConfig = { scheduleMode: 'interval', scrapeInterval: 2, translateInterval: 1 };
  await new Promise(resolve => bg.listeners.message({ action: 'updateAlarms' }, {}, resolve));
  assert.equal(bg.alarms.get('scrape-task').periodInMinutes, 120);
}

// 取消全部订阅：同步服务不可用时不得改动 storage——否则后台立刻清空整库，
// 而 config/tag.json 仍是旧订阅，下次 SW 唤醒又把订阅复活。
{
  const settingsFixture = (deps) => {
    const context = vm.createContext({
      SiteRegistry: Registry, TranslateConfig: Config, ScheduleConfig: { DEFAULT_CONFIG: {} }, Lark: { DEFAULT_CONFIG: {} },
    SubscriptionConfig: require('../src/shared/subscription-config.js'),
      document: { addEventListener() {} }, window: { confirm: () => true },
      chrome: { storage: { local: { set: deps.set } }, runtime: { sendMessage: async () => ({ success: true }) } },
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

console.log('Audit regression scenarios passed');
