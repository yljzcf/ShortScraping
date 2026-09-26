import './bootstrap.cjs';
// A5 回归测试：一次性存量迁移加完成标记短路，SW 唤醒零全表扫描。
// chrome 桩带 get 调用记录仪；「二次唤醒」用再次调用 loadConfigFromJsonFiles 模拟
// （SW 唤醒的迁移路径全在该函数内，unit-maint-batch1 同范式）。
// 用法：node tests/unit-migrate-skip.mjs（改造前跑应在 T2 低读断言上 RED=每轮 4+ 次全表读）
import fs from 'node:fs';
import { createChromeStorage } from './storage-stub.mjs';

// ---------- chrome 桩（storage 走共用 storage-stub：get 记录仪 reads + set 失败注入 failNextSet） ----------
// 后台在本进程全局作用域 eval（不进 background-fixture：它预置了迁移完成标记，而 T1 要的正是
// 「标记全无时顶层首轮」的迁移）。tick:1 保持手搓桩「让出一拍再读写」的时序；onChanged 从不派发
const store = createChromeStorage({}, { tick: 1, dispatchChanges: false });

globalThis.chrome = {
  storage: { local: store.local, onChanged: store.onChanged },
  runtime: {
    getURL: p => `chrome-extension://unit-test/${p}`,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} },
    sendMessage() { return Promise.resolve(undefined); }
  },
  alarms: { async get() { return undefined; }, async clear() { return true; }, create() {}, onAlarm: { addListener() {} } },
  tabs: { create() {}, remove() {}, onUpdated: { addListener() {}, removeListener() {} } },
  notifications: { create() {} },
  scripting: { async executeScript() { return []; } }
};
globalThis.importScripts = () => {};

const SUB = 'https://unit.test/list';
let tagJson = [{ url: SUB, tags: ['T'] }];
// Shortical 规范 slug 表（T5 用）：首页 href 尾段那个号不是规范 series id，
// 详情页只认静态发布产物那套 —— 见 migrateShorticalCanonicalIds
let shorticalSitemap = ['bound-by-fire-163', 'off-limits-177', 'room-service-193'];
let shorticalSitemapFails = false;
let shorticalSitemapCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('tag.json')) return { ok: true, json: async () => structuredClone(tagJson) };
  if (u.includes('/sitemaps/series.xml')) {
    shorticalSitemapCalls++;
    if (shorticalSitemapFails) return { ok: false, status: 503, text: async () => '' };
    return {
      ok: true,
      status: 200,
      text: async () => `<urlset>${shorticalSitemap.map(s => `<loc>https://shortical.com/drama/${s}</loc>`).join('')}</urlset>`
    };
  }
  throw new TypeError('unit stub: no network'); // cron/trans/lark 走默认回退
};
globalThis.Translator = { async translateTitleAndDesc() { return { title: '', desc: '' }; } };

const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

// ---------- 加载真实生产代码 ----------
for (const rel of ['../src/shared/url-match.js', '../src/shared/site-registry.js', '../src/shared/timeline-csv.js', '../src/shared/schedule-config.js', '../src/shared/lark.js']) {
  (0, eval)(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
}
// 直改 storage 里的 dramas 表前须让队列内存缓存失效（模拟 SW 冷启动首读）。缓存变量
// 是 background.js 那次 eval 的私有词法环境成员、外部触不到，借用生产自身语义：
// 注入一次 set 失败，writeDramasInQueue 的 catch 置缓存 null（失败不落盘）。
// eval 前调用为 no-op（clearAllDramas 尚未定义）。那次 set 万一没走到，收尾撤掉钩子，免得误伤后面的写。
const resetDramasCache = async () => {
  if (typeof globalThis.clearAllDramas !== 'function') return;
  let armed = true;
  store.failNextSet(() => armed);
  await globalThis.clearAllDramas().catch(() => {});
  armed = false;
};
// 种入条数（条数断言一律由它推导，加夹具时不必再逐处改数字）
const SEEDED = 12;
const seedLegacy = async () => {
  await resetDramasCache();
  store.seedDramas([
    { id: 'id-1', imdbId: 'tt0001', title: 'Old Field', tags: ['T'], source: 'unittest', status: 'trans', sourceListUrl: SUB },
    { id: 'id-2', itemId: 'rr123', title: 'RR Tag', tags: ['RR'], company: 'Some Author', source: 'royalroad', status: 'trans', sourceListUrl: SUB },
    { id: 'id-3', itemId: 'mdf-orphan-slug', title: 'Unmapped Fandom', tags: ['T'], source: 'mydrama', status: 'new', sourceListUrl: SUB },
    { id: 'id-4', itemId: 'ns001', title: 'Normal', tags: ['T'], company: '', source: 'netshort', status: 'trans', sourceListUrl: SUB },
    // v1.5.14 半成品翻译复位的三个面：缺中文标题 / 缺中文简介 / 齐全（不该动）
    { id: 'id-5', itemId: 'st001', title: 'No Title Zh', description: 'en desc', titleZh: '', descriptionZh: '中文简介',
      tags: ['T'], source: 'steam', status: 'trans', translatedAt: '2026-08-01T00:00:00.000Z', sourceListUrl: SUB },
    { id: 'id-6', itemId: 'st002', title: 'No Desc Zh', description: 'en desc', titleZh: '官方中文名', descriptionZh: '',
      tags: ['T'], source: 'steam', status: 'trans', translatedAt: '2026-08-01T00:00:00.000Z', sourceListUrl: SUB },
    { id: 'id-7', itemId: 'st003', title: 'Complete', description: 'en desc', titleZh: '完整中文名', descriptionZh: '完整中文简介',
      tags: ['T'], source: 'steam', status: 'trans', translatedAt: '2026-08-01T00:00:00.000Z', sourceListUrl: SUB },
    // v1.6.2 非中文译名复位的两个面：韩语（Steam 中文档返回开发商母语）与拉丁系外语。
    // 两条都「译文齐全」，故 resetPartialTranslations 不会碰，必须由新迁移兜住
    { id: 'id-8', itemId: 'st004', title: 'Escape! House of Bonds', description: 'en desc',
      titleZh: '탈출! 인연의 집', descriptionZh: '中文简介', translateAttempts: 2,
      tags: ['T'], source: 'steam', status: 'trans', translatedAt: '2026-08-01T00:00:00.000Z', sourceListUrl: SUB },
    { id: 'id-9', itemId: 'st005', title: 'The Mansion of Campanillas', description: 'en desc',
      titleZh: 'La mansión de Campanillas', descriptionZh: '中文简介',
      tags: ['T'], source: 'steam', status: 'trans', translatedAt: '2026-08-01T00:00:00.000Z', sourceListUrl: SUB },
    // v1.6.13 乱码译文复位：旧同步服务逐块解码写出的 U+FFFD 经导入进了扩展库。
    // 译名/简介都齐全且含汉字，前两道复位都不会碰
    { id: 'id-10', itemId: 'rr176669', title: 'Second Life', description: 'en desc',
      titleZh: '第二人生', descriptionZh: '眼看就要随\uFFFD\uFFFD咽气', translateAttempts: 1,
      tags: ['T'], source: 'royalroad', status: 'trans', translatedAt: '2026-08-01T00:00:00.000Z', sourceListUrl: SUB },
    { id: 'id-11', itemId: 'ns2092788755268141057', title: 'Top Chef', description: 'en desc',
      titleZh: '顶级\uFFFD\uFFFD\uFFFD会主厨', descriptionZh: '中文简介',
      tags: ['T'], source: 'netshort', status: 'trans', translatedAt: '2026-08-01T00:00:00.000Z', sourceListUrl: SUB },
    // 同一缺陷写坏的是原文（英文简介的 ’、中文标签）：原文无从重建，迁移不得清空，译文完好也不退回
    { id: 'id-12', itemId: 'ns2092788755268141058', title: 'Caf\uFFFD Love', description: 'She didn\uFFFD\uFFFDt know',
      titleZh: '咖啡之恋', descriptionZh: '她并不知道', tags: ['T', '视觉\uFFFD\uFFFD'],
      source: 'netshort', status: 'trans', translatedAt: '2026-08-01T00:00:00.000Z', sourceListUrl: SUB }
  ]);
  delete store.data.legacyDramaMigrated;
  delete store.data.rsEpisodeUrlMigrated;
  delete store.data.companyFieldDropped;
  delete store.data.partialTranslationReset;
  delete store.data.nonChineseTitleZhReset;
  delete store.data.garbledTranslationReset;
  delete store.data.shorticalCanonicalIdsMigrated;
  store.data.urlTags = [{ urlPattern: SUB, tags: ['T'] }];
};
await seedLegacy();
(0, eval)(fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700); // 等顶层首轮 loadConfigFromJsonFiles 落定

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const dramasReadCount = () => store.dramasReadCount();
// 请求过该键的 get（get(null) 读全部键，也算；本套件的断言要求「只读标记本身」，那种读法照样不过）
const readsOf = key => store.reads.filter(keys => keys === null || keys.includes(key));

// ---------- T1 首轮：三迁移生效 + 双标记落库 ----------
{
  const dramas = store.dramas() || [];
  const byId = Object.fromEntries(dramas.map(d => [d.id, d]));
  check('T1a imdbId 字段已更名 itemId', byId['id-1'] && !('imdbId' in byId['id-1']) && byId['id-1'].itemId === 'tt0001', JSON.stringify(byId['id-1']));
  check('T1b RR 标签已改 RoyalRoad', byId['id-2']?.tags?.includes('RoyalRoad') && !byId['id-2']?.tags?.includes('RR'), JSON.stringify(byId['id-2']?.tags));
  check('T1c mdf- 未映射条目已清理', !byId['id-3'] && dramas.length === SEEDED - 1, `len=${dramas.length}`);
  check('T1d legacyDramaMigrated 已置位', store.data.legacyDramaMigrated === true, String(store.data.legacyDramaMigrated));
  check('T1e rsEpisodeUrlMigrated 已置位（无候选也收口）', store.data.rsEpisodeUrlMigrated === true, String(store.data.rsEpisodeUrlMigrated));
  // v1.5.13：company 彻底移除。挂在独立标记上——legacyDramaMigrated 在存量机器上早已
  // 置位，挂进 runLegacyDramaMigrations 的话这条迁移永远不会执行
  check('T1f company 字段已从存量记录摘除（含空串值）',
    dramas.every(d => !('company' in d)), JSON.stringify(dramas.map(d => d.company)));
  check('T1g companyFieldDropped 已置位', store.data.companyFieldDropped === true, String(store.data.companyFieldDropped));
  // v1.5.14：半成品翻译退回队列。缺中文标题与缺中文简介都要复位，齐全的不许动
  check('T1h 缺中文标题的半成品已退回 new', byId['id-5']?.status === 'new', JSON.stringify(byId['id-5']));
  check('T1i 缺中文简介的半成品已退回 new（官方译名保留）',
    byId['id-6']?.status === 'new' && byId['id-6']?.titleZh === '官方中文名', JSON.stringify(byId['id-6']));
  check('T1j 译文齐全的条目不被误动',
    byId['id-7']?.status === 'trans' && byId['id-7']?.translatedAt === '2026-08-01T00:00:00.000Z',
    JSON.stringify(byId['id-7']));
  check('T1k partialTranslationReset 已置位', store.data.partialTranslationReset === true,
    String(store.data.partialTranslationReset));
  // v1.6.2：非中文译名退回队列。判据与适配器守卫同一个 hasChineseChars
  check('T1l 韩语译名已清空并退回 new（简介保留、重试计数清零）',
    byId['id-8']?.status === 'new' && byId['id-8']?.titleZh === ''
    && byId['id-8']?.descriptionZh === '中文简介' && !('translateAttempts' in (byId['id-8'] || {})),
    JSON.stringify(byId['id-8']));
  check('T1m 拉丁系外语译名同样复位（语种黑名单抓不到）',
    byId['id-9']?.status === 'new' && byId['id-9']?.titleZh === '', JSON.stringify(byId['id-9']));
  check('T1n 正常中文译名不被误动',
    byId['id-7']?.titleZh === '完整中文名' && byId['id-7']?.status === 'trans', JSON.stringify(byId['id-7']));
  check('T1o nonChineseTitleZhReset 已置位', store.data.nonChineseTitleZhReset === true,
    String(store.data.nonChineseTitleZhReset));
  check('T1p 乱码简介已清空并退回 new（完好译名保留、重试计数清零）',
    byId['id-10']?.status === 'new' && byId['id-10']?.descriptionZh === '' && byId['id-10']?.titleZh === '第二人生'
    && !('translateAttempts' in (byId['id-10'] || {})), JSON.stringify(byId['id-10']));
  check('T1q 乱码译名已清空并退回 new（完好简介保留）',
    byId['id-11']?.status === 'new' && byId['id-11']?.titleZh === '' && byId['id-11']?.descriptionZh === '中文简介',
    JSON.stringify(byId['id-11']));
  check('T1r garbledTranslationReset 已置位', store.data.garbledTranslationReset === true,
    String(store.data.garbledTranslationReset));
  check('T1s 原文/标签含乱码而译文完好 → 原样保留（不清空原文、不退回 new）',
    byId['id-12']?.status === 'trans' && byId['id-12']?.title === 'Caf\uFFFD Love'
    && byId['id-12']?.description === 'She didn\uFFFD\uFFFDt know' && byId['id-12']?.titleZh === '咖啡之恋'
    && JSON.stringify(byId['id-12']?.tags) === JSON.stringify(['T', '视觉\uFFFD\uFFFD']),
    JSON.stringify(byId['id-12']));
}

// ---------- T2 二次唤醒：dramas 全表读恰 1 次（仅 prune，不可标记项） ----------
{
  store.reads.length = 0;
  await loadConfigFromJsonFiles(); // eslint-disable-line no-undef
  const reads = dramasReadCount();
  // 缓存热态（同 SW 会话内二次唤醒等价路径）为 0 次；缓存冷态（真实 SW 重启）为 1 次（仅 prune）
  check('T2a 二次唤醒 dramas 全表读 ≤1 次（旧代码 4+ 次）', reads <= 1, `reads=${reads} log=${JSON.stringify(store.reads)}`);
  const rsGets = readsOf('rsEpisodeUrlMigrated');
  check('T2b rs 标记读取不连带 dramas', rsGets.length === 1 && rsGets[0]?.length === 1, JSON.stringify(rsGets));
  check('T2c 数据未被误动', (store.dramas() || []).length === SEEDED - 1, `len=${store.dramas()?.length}`);
  // 四个逐条复位迁移共用 runOnceDramaMigration：标记各读一次、只读标记本身，置位后零写入
  const ONCE_FLAGS = ['companyFieldDropped', 'partialTranslationReset', 'nonChineseTitleZhReset', 'garbledTranslationReset'];
  const flagGets = ONCE_FLAGS.map(flag => readsOf(flag));
  check('T2d 逐条复位迁移的标记各单独读一次、不连带 dramas',
    flagGets.every(gets => gets.length === 1 && gets[0]?.length === 1), JSON.stringify(flagGets));
}

// ---------- T3 set 失败：标记不置位，下轮重试成功 ----------
{
  await seedLegacy();
  store.failNextSet(); // 首个写（config 种子 set）失败，迁移线不达
  let threw = false;
  await loadConfigFromJsonFiles().catch(() => { threw = true; }); // eslint-disable-line no-undef
  check('T3a 迁移失败向上传播', threw === true, '');
  check('T3b 失败后标记未置位', store.data.legacyDramaMigrated === undefined, String(store.data.legacyDramaMigrated));
  await loadConfigFromJsonFiles(); // eslint-disable-line no-undef
  check('T3c 下轮重试完成迁移并置标记', store.data.legacyDramaMigrated === true && !('imdbId' in ((store.dramas() || [])[0] || {})), JSON.stringify(store.dramas()?.[0]));
}

// ---------- T4 迁移/清理抛错不得阻断配置恢复（v1.6.7，2026-09-17 审计 H1） ----------
// loadConfigFromJsonFiles 是 SW 每次唤醒的入口，setupAlarms 挂在它后面（顶层 initPromise 先 load
// 再 setup，onInstalled/onStartup 只等它落定）。此前水位线同步与五个迁移全是裸 await：
// 某迁移确定性抛错＝看门狗与定时任务永远装不上，用户以为在跑、其实全停。
// 注意 T3 的语义不变：config 种子 set 失败仍向上传播（那是「配置没恢复成」，不是迁移问题）。
{
  await seedLegacy();
  const origReset = globalThis.resetNonChineseTitleZh;
  globalThis.resetNonChineseTitleZh = async () => { throw new Error('unit stub: 迁移炸了'); };
  let result = null, threw = false;
  await loadConfigFromJsonFiles().then(r => { result = r; }, () => { threw = true; }); // eslint-disable-line no-undef
  globalThis.resetNonChineseTitleZh = origReset;
  check('T4a 单个迁移抛错时 loadConfigFromJsonFiles 仍正常完成（不掐掉 setupAlarms）',
    !threw && Array.isArray(result?.urlTags), `threw=${threw} result=${JSON.stringify(result)}`);
  check('T4b 排在它后面的迁移照常完成并置标（不是整条链一起死）',
    store.data.rsEpisodeUrlMigrated === true, String(store.data.rsEpisodeUrlMigrated));
  check('T4c 抛错的迁移标记未置位（下轮唤醒重试）',
    store.data.nonChineseTitleZhReset === undefined, String(store.data.nonChineseTitleZhReset));

  const origPrune = globalThis.pruneDramasOutsideConfiguredUrls;
  globalThis.pruneDramasOutsideConfiguredUrls = async () => { throw new Error('unit stub: 清理炸了'); };
  threw = false;
  await loadConfigFromJsonFiles().catch(() => { threw = true; }); // eslint-disable-line no-undef
  globalThis.pruneDramasOutsideConfiguredUrls = origPrune;
  check('T4d 订阅外清理抛错同样不阻断配置恢复', threw === false, `threw=${threw}`);
}

// ---------- T5 Shortical 规范 id 迁移（v1.6.10，2026-09-18） ----------
// 首页 href 尾段的数字不是规范 series id（站点两套 id，详情页只认静态发布产物那套），
// 所以存量既有 404 链接、又因 id 漂移把同一部剧反复当新卡入库。**再抓取不会自愈**——
// 新 id 只会再添一条。规范源是公开 sitemap。
{
  const seedShortical = async (dramas) => {
    await resetDramasCache();
    store.seedDramas(dramas);
    delete store.data.shorticalCanonicalIdsMigrated;
    store.data.urlTags = [{ urlPattern: SUB, tags: ['T'] }];
    shorticalSitemapCalls = 0;
  };
  const sc = (over) => ({ source: 'shortical', status: 'new', tags: ['T'], sourceListUrl: SUB, genres: [], ...over });
  // 时间线按 scrapedAt 降序存放 → 同一部剧的两条里「先到」的是排在后面那条
  const FULL = () => [
    sc({ id: 'sc-late', itemId: 'sc2201', title: 'Bound by Fire', url: 'https://shortical.com/drama/bound-by-fire-2201',
      genres: ['Second Chance'], scrapedAt: '2026-09-18T01:48:00.000Z' }),
    sc({ id: 'sc-early', itemId: 'sc2200', title: 'Bound by Fire', url: 'https://shortical.com/drama/bound-by-fire-2200',
      scrapedAt: '2026-09-17T16:29:00.000Z' }),
    sc({ id: 'sc-ok', itemId: 'sc177', title: 'Off Limits', url: 'https://shortical.com/drama/off-limits-177',
      genres: ['Romance'], scrapedAt: '2026-09-17T16:00:00.000Z' }),
    sc({ id: 'sc-miss', itemId: 'sc2999', title: '静态产物没收录', url: 'https://shortical.com/drama/not-published-yet-2999',
      scrapedAt: '2026-09-17T15:00:00.000Z' }),
    { id: 'other', itemId: 'ns001', title: 'NetShort', source: 'netshort', status: 'trans', tags: ['T'],
      url: 'https://netshort.com/episode/x-1', genres: ['Romance'], scrapedAt: '2026-09-17T14:00:00.000Z', sourceListUrl: SUB }
  ];

  await seedShortical(FULL());
  await loadConfigFromJsonFiles(); // eslint-disable-line no-undef
  {
    const dramas = store.dramas() || [];
    const byId = Object.fromEntries(dramas.map(d => [d.id, d]));
    check('T5a 高号条目改写成 sitemap 的规范 itemId 与 url（点封面不再落 404）',
      byId['sc-early']?.itemId === 'sc163'
      && byId['sc-early']?.url === 'https://shortical.com/drama/bound-by-fire-163',
      JSON.stringify([byId['sc-early']?.itemId, byId['sc-early']?.url]));
    check('T5b 同一部剧的重复按先到先得只留 scrapedAt 更早的那条',
      !byId['sc-late'] && !!byId['sc-early'] && dramas.filter(d => d.itemId === 'sc163').length === 1,
      JSON.stringify(dramas.map(d => [d.id, d.itemId])));
    check('T5c 被丢弃条目的 genres 并入保留条目（仅保留条目为空时）',
      JSON.stringify(byId['sc-early']?.genres) === JSON.stringify(['Second Chance']),
      JSON.stringify(byId['sc-early']?.genres));
    check('T5d 已是规范形态的条目不被误动（同一对象、genres 不被覆盖）',
      byId['sc-ok']?.itemId === 'sc177' && byId['sc-ok']?.url === 'https://shortical.com/drama/off-limits-177'
      && JSON.stringify(byId['sc-ok']?.genres) === JSON.stringify(['Romance']), JSON.stringify(byId['sc-ok']));
    check('T5e sitemap 解析不到的条目原样保留、不删（不重试）',
      byId['sc-miss']?.itemId === 'sc2999' && byId['sc-miss']?.url === 'https://shortical.com/drama/not-published-yet-2999',
      JSON.stringify(byId['sc-miss']));
    check('T5f 非 Shortical 条目一律不碰', byId['other']?.itemId === 'ns001', JSON.stringify(byId['other']));
    check('T5g shorticalCanonicalIdsMigrated 已置位', store.data.shorticalCanonicalIdsMigrated === true,
      String(store.data.shorticalCanonicalIdsMigrated));
    check('T5h 迁移期间 sitemap 只取一次', shorticalSitemapCalls === 1, String(shorticalSitemapCalls));
  }
  {
    // 二次唤醒：标记置位后零成本跳过
    store.reads.length = 0;
    shorticalSitemapCalls = 0;
    const before = JSON.stringify(store.dramas());
    await loadConfigFromJsonFiles(); // eslint-disable-line no-undef
    const flagGets = readsOf('shorticalCanonicalIdsMigrated');
    check('T5i 二次唤醒标记读取不连带 dramas、零网络、数据不动',
      flagGets.length === 1 && flagGets[0]?.length === 1 && shorticalSitemapCalls === 0
      && JSON.stringify(store.dramas()) === before,
      JSON.stringify({ flagGets, calls: shorticalSitemapCalls }));
  }
  {
    // sitemap 取不到：标记不置位、数据一个字节不动，下轮唤醒重试（绝不退回 href 那个号）
    await seedShortical(FULL());
    shorticalSitemapFails = true;
    const before = JSON.stringify(store.dramas());
    let threw = false;
    await loadConfigFromJsonFiles().catch(() => { threw = true; }); // eslint-disable-line no-undef
    shorticalSitemapFails = false;
    check('T5j sitemap 取不到 → 不阻断配置恢复、标记不置位、数据不动',
      threw === false && store.data.shorticalCanonicalIdsMigrated === undefined
      && JSON.stringify(store.dramas()) === before,
      JSON.stringify({ threw, flag: store.data.shorticalCanonicalIdsMigrated }));
    await loadConfigFromJsonFiles(); // eslint-disable-line no-undef
    check('T5k 下轮重试完成迁移并置标',
      store.data.shorticalCanonicalIdsMigrated === true
      && (store.dramas() || []).some(d => d.itemId === 'sc163'),
      JSON.stringify((store.dramas() || []).map(d => d.itemId)));
  }
  {
    // 库里没有 Shortical 条目（绝大多数用户）：直接收口，零网络请求
    await seedShortical([{ id: 'only', itemId: 'ns001', title: 'NetShort', source: 'netshort', status: 'trans',
      tags: ['T'], url: 'https://netshort.com/episode/x-1', genres: [], scrapedAt: '2026-09-17T14:00:00.000Z', sourceListUrl: SUB }]);
    await loadConfigFromJsonFiles(); // eslint-disable-line no-undef
    check('T5l 无 Shortical 条目时零网络请求直接置标',
      store.data.shorticalCanonicalIdsMigrated === true && shorticalSitemapCalls === 0,
      JSON.stringify({ flag: store.data.shorticalCanonicalIdsMigrated, calls: shorticalSitemapCalls }));
  }
}

// ---------- T6 beforeMigrations 钩子（审查 setupalarms-gated-by-network-migrations） ----------
// 顶层 initPromise 经它把 setupAlarms 提到迁移链之前：联网迁移挂住时定时任务照样装得上。
// 放在最后：T6c 的 sitemap 请求永不 resolve，那次 loadConfigFromJsonFiles 永远挂着。
{
  // T6a/b 钩子抛错不挡迁移；种子配置在钩子执行前已落库（setupAlarms 读的是刚恢复的 scheduleConfig）
  await seedLegacy();
  delete store.data.scheduleConfig;
  let seededAtHook = null;
  let result = null, threw = false;
  await loadConfigFromJsonFiles({ // eslint-disable-line no-undef
    beforeMigrations: async () => {
      seededAtHook = store.data.scheduleConfig !== undefined;
      throw new Error('unit stub: 定时任务安装炸了');
    }
  }).then(r => { result = r; }, () => { threw = true; });
  check('T6a 钩子执行时配置种子已落库', seededAtHook === true, String(seededAtHook));
  check('T6b 钩子抛错不阻断配置恢复与后面的迁移',
    !threw && Array.isArray(result?.urlTags) && store.data.legacyDramaMigrated === true && store.data.rsEpisodeUrlMigrated === true,
    JSON.stringify({ threw, legacy: store.data.legacyDramaMigrated, rs: store.data.rsEpisodeUrlMigrated }));

  // T6c 联网迁移挂住：钩子已先跑完，不被 sitemap 请求拦住；请求带超时 signal
  await resetDramasCache();
  store.seedDramas([{ id: 'sc-hang', itemId: 'sc2200', title: 'Bound by Fire', source: 'shortical', status: 'new',
    tags: ['T'], sourceListUrl: SUB, url: 'https://shortical.com/drama/bound-by-fire-2200', scrapedAt: '2026-09-17T16:29:00.000Z' }]);
  delete store.data.shorticalCanonicalIdsMigrated;
  const origFetch = globalThis.fetch;
  let sitemapSignal = null;
  let sitemapRequested = false;
  globalThis.fetch = (url, options) => {
    if (!String(url).includes('/sitemaps/series.xml')) return origFetch(url, options);
    sitemapRequested = true;
    sitemapSignal = options?.signal;
    return new Promise(() => {}); // 请求挂住，永不 resolve
  };
  let hookRanBeforeSitemap = null;
  loadConfigFromJsonFiles({ beforeMigrations: async () => { hookRanBeforeSitemap = !sitemapRequested; } }); // eslint-disable-line no-undef
  await sleep(200);
  check('T6c sitemap 请求挂住时钩子（setupAlarms）已先于它执行完',
    hookRanBeforeSitemap === true && sitemapRequested && store.data.shorticalCanonicalIdsMigrated === undefined,
    JSON.stringify({ hookRanBeforeSitemap, sitemapRequested }));
  check('T6d sitemap 请求带超时 signal（小于 SW 30s 空闲阈值，超时即抛、下轮重试）',
    sitemapSignal instanceof AbortSignal && sitemapSignal.aborted === false, String(sitemapSignal));
}

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
