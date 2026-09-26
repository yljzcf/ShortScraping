/**
 * ShortScraping Background Service Worker
 * 定时任务调度：抓取线 + 翻译线
 */

importScripts('../shared/url-match.js');
importScripts('../shared/subscription-config.js'); // 订阅规范化单一真源（与设置页/同步服务共用）
importScripts('../shared/site-registry.js'); // 须先于 lark.js（其 SOURCE_NAMES 取自本模块）
importScripts('../shared/scrape-rules.js'); // 与 content.js 共用的采集口径（fandom 临时键前缀 / genres 清洗 / Shortical sitemap 解析）
importScripts('../shared/timeline-csv.js');
importScripts('../shared/schedule-config.js'); // cron 解析/校验/默认值单一真源
importScripts('../shared/translate-config.js');
importScripts('../shared/translator.js');
importScripts('../shared/lark.js');

// 运行状态。抓取走串行队列：手动单站刷新与定时全量并发触发时排队执行，
// 避免双开同一 URL 的标签页；activeScrapeCount 覆盖「排队+运行中」的整个
// 区间，抓取后翻译线据此判断抓取是否仍在进行（此前用布尔，两次抓取并行时
// 先结束的一方会提前放行空扫描计数，导致后结束批次的新卡本轮不被翻译）。
let scrapeQueue = Promise.resolve();
let activeScrapeCount = 0;
// 全量轮合并（审查 scrape-queue-no-coalesce / manual-refresh-queued-behind-full-scrape）：
// pendingFullScrape 是已排队、尚未开跑的那次全量轮（performScrape 返回的 promise），开跑即
// 置回 null——同一时刻至多「一轮在跑 + 一轮排队」，间隔短于单轮耗时时不再无界堆积。
// fullScrapeProgress 是正在跑的全量轮的站点进度：pendingSites 为本轮还没开抓任何 URL 的
// 站点（null＝已开跑但订阅清单还没读出，视同全部站点都还在前头），供弹窗单站刷新判断能否并进本轮
let pendingFullScrape = null;
let fullScrapeProgress = null;
let postScrapeTranslateTimer = null;
let postScrapeTranslateRunning = false;
let csvSyncTimer = null;
// 上次成功推送的时间线序列化内容（SW 内存签名，刻意不持久化——SW 回收后首推
// 即同步服务重启场景的天然恢复机制）。同内容跳过 POST，省去数 MB 的冗余传输。
// 跨 SW 生命周期的「服务端已有这一版」由持久化的冷启动指纹另行判定（csvLastPush，见 csvSyncUpToDate）：
// 它比对的是服务端此刻的 contentHash，同步服务重启丢了快照时对不上，照样会推
let lastCsvSyncSerialized = null;
// 推送单飞（审查 sync-no-ordering）：csvSyncInFlight 是在飞那次推送（runCsvSync 包出来的
// promise）。此前防抖只管「何时发」不管「在不在飞」：一次数 MB 的推送还没回，新变化 500ms 后
// 又发一次，两个 POST 并行、到达服务端的先后不定，旧内容可能后到、把新内容盖回去。在飞期间
// 到点的定时器只置 csvSyncRerun，在飞那次结束后补排一次——补跑时读的是最新缓存，最后落到
// 服务端的必是最新内容。csvSyncLastRunAt：最近一次推送开跑的时刻，忙碌期节流按它算间隔
let csvSyncInFlight = null;
let csvSyncRerun = false;
let csvSyncLastRunAt = 0;

// 翻译轮 in-flight 共享：同一时刻只跑一轮，手动/定时/抓取后翻译线的并发调用
// join 同一 promise，消灭重复翻译同一批条目。
let translateRun = null;
// 手动触发 join 到进行中的自动空扫描轮时的等待者标记：空轮本不写终态
// （避免自动线收尾期反复触发 onChanged），但有手动等待者时必须写终态，
// 否则弹窗按钮永远收不到收尾信号，⏳ 卡到重开弹窗。
let translateManualWaiter = false;
// 最近写出的 translateRunState 内存镜像：getTranslateState 从这里同步应答，
// 不读 storage，避免拿到孤儿清理尚未落库前的僵尸 running:true。
let translateRunStateMirror = null;

const CSV_SYNC_ENDPOINT = 'http://127.0.0.1:31919/sync';
// 旧版同步服务（v1.6.18 及以前）请求体上限 20MB、超限直接断开连接：浏览器的 fetch 网络错误
// 不带原因，扩展这头看到的 TypeError 与「服务没启动」一模一样。推送体到了这个量级又连不上时，
// 报错里点明「多半是超限被断开」（审查 body-limit-ceiling）；新版超限回 413，走 HTTP 分支
const CSV_SYNC_LEGACY_BODY_LIMIT_BYTES = 20 * 1024 * 1024;
// 空时间线跳过推送的告警每个 SW 生命周期只打一次：空库状态下每次 dramas 变化都会走到护栏
let emptySyncSkipWarned = false;
// scheduleCsvSync 的调用序号：一次推送结束时序号没变＝推送期间没有新的同步被安排，
// 这时才可摘 allowEmptySync（见 syncTimelineToCsv 末尾）
let csvSyncScheduleSeq = 0;
// 空闲时的尾随防抖：dramas 连写（导入、批量清理）合并成一次推送
const CSV_SYNC_DEBOUNCE_MS = 500;
// 忙碌期（抓取或翻译轮进行中）两次推送开跑的最小间隔：每存一张卡、每回填一条译文 dramas 都变
// 一次，照 500ms 防抖推，一轮抓取就是几十次整表 POST、服务端几十次整份重写 json + CSV；
// 单纯拉长防抖又会在持续写入时一直推不出去。改成前沿节流：空闲后的第一次变化仍 500ms 推出，
// 之后至少隔这么久再推；忙碌结束时收尾强推（flushCsvSyncAfterBusy），共享页与 CSV 最多落后这么久
const CSV_SYNC_BUSY_WINDOW_MS = 8000;
// 单次推送的超时：单飞之下一个挂住的请求会堵住之后所有推送，直到 SW 被回收
const CSV_SYNC_TIMEOUT_MS = 60000;
// 冷启动指纹比对问的 /health（本机块带 contentHash / csvInSync）与它的期限：服务没开或挂住时最多拖 3 秒，
// 超时即按「拿不到」处理、照旧推送
const CSV_SYNC_HEALTH_ENDPOINT = 'http://127.0.0.1:31919/health';
const CSV_SYNC_HEALTH_TIMEOUT_MS = 3000;

// 四个配置文件 ↔ storage 键 ↔ 同步服务写回端点 POST /config/<key>。请求体 { <storage 键>: 值 }
// 与设置页 trySyncConfig 同形；configAheadOfFile（设置页写了 storage 但写回文件失败的标记）
// 的键名即这里的 key。
const CONFIG_FILES = {
  tag: { file: 'config/tag.json', storageKey: 'urlTags' },
  cron: { file: 'config/cron.json', storageKey: 'scheduleConfig' },
  trans: { file: 'config/trans.json', storageKey: 'translateConfig' },
  lark: { file: 'config/lark.json', storageKey: 'larkConfig' }
};
const CONFIG_SYNC_BASE_URL = 'http://127.0.0.1:31919/config/';
// 写回挂在 SW 唤醒路径上，服务没开时不能拖住后续迁移与闹钟安装
const CONFIG_WRITE_BACK_TIMEOUT_MS = 3000;

// 订阅外清理的回收站（storage.pruneTrash）只留最近几批：一批可能是整库，攒多了占空间
const PRUNE_TRASH_MAX_BATCHES = 3;

// 本文件的 setTimeout 延时（本常量与 CSV 500ms 防抖 / 8s 忙碌节流）均远小于 MV3 SW 的
// ~30s 空闲回收阈值；极端情况下 SW 连同定时器被杀时，SW 下次唤醒的顶层
// warmupCsvSyncIfStale（没推出去的那次写已换了 dramasStamp.rev，指纹必然对不上、照推）与
// translate-task alarm 会兜底。评估后不迁移 chrome.alarms（其最小粒度 30s，反而更差）。
const POST_SCRAPE_TRANSLATE_DELAY_MS = 10000;

// dramas 表全局单写者队列：内容脚本/弹窗的写请求经消息转到这里，与后台
// 翻译线、清理迁移共用同一条 Promise 链严格串行。此前内容脚本与翻译线各自
// 「get 全表 → 内存改 → set 全表」，一方的 set 落在另一方 get/set 窗口内时
// 整表写回会覆盖丢卡（实测抓取报 80 条、storage 仅 79 条）。
let dramaWriteQueue = Promise.resolve();

function enqueueDramaWrite(label, operation) {
  const run = dramaWriteQueue.then(operation);
  dramaWriteQueue = run.then(
    () => {},
    (e) => console.warn(`[ShortScraping] dramas 写操作失败（${label}）:`, e?.message || e)
  );
  return run;
}

// SW 生命周期内的 dramas 表内存缓存：首个队列操作 get 一次后回填，后续队列内
// 读写零 get（抓 N 条从 N 次数 MB 的全表反序列化降为 1 次）。一致性前提：
// dramas 的全部写路径都收口在 enqueueDramaWrite 队列内（逐个 grep enqueueDramaWrite 核对，
// 此处不记数——增删写路径后数字即过期），且
// 缓存数组视为只读——写一律 copy-on-write 构造新数组。SW 回收即缓存消失。
let dramasCache = null;
// 本生命周期里缓存是否填过（读表回填或写成功）：翻译扫描的指纹捷径只给「SW 冷启动、还没碰过表」的那一刻用
// （见 noPendingTranslationsByStamp）。填过之后缓存只会因写失败而清空，届时照常重读一次表，不走捷径
let dramasCacheFilledOnce = false;

// 前向兼容护栏（为日后按站点分片存储预留，本版本不分片）：更新版本改用分片布局时会写
// dramasMeta = { layout: 2, … }，旧键 dramas 冻结、不再更新。从那样的版本回退到本版本时，
// 若照常在冻结快照上跑：冻结后才翻完的卡在快照里还是 new，会被重新 AI 翻译（花钱）；冻结后
// 才抓到的卡本版本不认识，会重新入库、重新推群（maybeBotPush 不按 id 去重）。所以读到
// layout 高于本版本认识的布局就进入只读：writeDramasInQueue 拒写，CSV 推送、翻译扫描与抓取轮（开轮读表后、
// 开订阅页前）直接返回并告警一次，弹窗状态栏提示升级（popup.js 同一判据）。没有 dramasMeta 时行为不变。
// 布局标记在每次 dramas 缓存未命中的读（getDramasInQueue / getDramasSnapshot）时一并读取更新
const DRAMAS_LAYOUT_SUPPORTED = 1;
let dramasLayoutAhead = null; // null＝没有更新版本的布局标记；否则为读到的 dramasMeta
const dramasReadOnlyWarned = new Set();

function noteDramasLayout(meta) {
  const layout = Number(meta?.layout);
  dramasLayoutAhead = Number.isFinite(layout) && layout > DRAMAS_LAYOUT_SUPPORTED ? meta : null;
}

function dramasReadOnlyMessage() {
  return `本地数据已由更新版本的扩展升级为新的存储布局（dramasMeta.layout=${dramasLayoutAhead?.layout}），`
    + '当前版本只读、不再写入、推送与翻译，请升级扩展';
}

/** 只读模式下各路径（CSV 推送 / 翻译扫描）各告警一次：推送每次 dramas 变化都会走到，翻译线每秒扫一轮 */
function warnDramasReadOnlyOnce(what) {
  if (dramasReadOnlyWarned.has(what)) return;
  dramasReadOnlyWarned.add(what);
  console.warn(`[ShortScraping] ${what}跳过：${dramasReadOnlyMessage()}`);
}

// 冷启动指纹（v1.6.22）：每次整表写在同一次 set 里连带写 dramasStamp = { rev, pending }——rev 每写一次换一个
// （crypto.randomUUID），标识「这一版表内容」；pending＝表里 status==='new' 的条数。推送成功且服务端回了
// contentHash 时，把被推出去那一版的 rev 连同订阅指纹、服务端指纹记进 csvLastPush（见 recordCsvLastPush）。
// SW 冷唤醒只读这几个小键 + 问一次 /health 就能判断「同步服务上是不是正是本地这一版」，对得上才跳过预热推送
// （csvSyncUpToDate），不必为此整表读；翻译扫描在冷缓存时也凭 pending===0 直接收工、不读表。
// 内存副本按数组引用挂在 WeakMap 上：表的每一版（dramasCache 指向的数组）各自带着自己的 stamp，推送读到
// 哪个数组就取哪个数组的 rev——推送途中又有写入时缓存换成新数组，已取到的那一对不受影响
const dramasStamps = new WeakMap();

function validDramasStamp(stamp) {
  return Boolean(stamp) && typeof stamp === 'object' && typeof stamp.rev === 'string' && stamp.rev !== ''
    && Number.isInteger(stamp.pending) && stamp.pending >= 0;
}

/** 表的某一版对应的 stamp（内存副本）；没有（旧版本写的表 / 版本更新刚清掉）时为 null */
function dramasStampOf(dramas) {
  return (dramas && typeof dramas === 'object' && dramasStamps.get(dramas)) || null;
}

function newDramasStamp(dramas) {
  let pending = 0;
  for (const drama of Array.isArray(dramas) ? dramas : []) {
    if (drama?.status === 'new') pending++;
  }
  const rev = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return { rev, pending };
}

/** 缓存未命中时读 dramas 表，连带读布局标记与指纹（同一次 get，不多一次读；同一次读出来的表与指纹必然配对） */
async function readDramasFromStorage() {
  const { dramas = [], dramasMeta, dramasStamp } = await chrome.storage.local.get(['dramas', 'dramasMeta', 'dramasStamp']);
  noteDramasLayout(dramasMeta);
  if (validDramasStamp(dramasStamp) && dramas && typeof dramas === 'object') dramasStamps.set(dramas, dramasStamp);
  return dramas;
}

/** 仅队列内调用：读当前 dramas 表，缓存命中零 get。 */
async function getDramasInQueue() {
  if (dramasCache === null) {
    dramasCache = await readDramasFromStorage();
    dramasCacheFilledOnce = true;
  }
  return dramasCache;
}

// dramas 整表写的耗时埋点（只打日志、不落 storage）：每次 set 计时，抓取轮与翻译轮收尾各打一行
// 汇总（次数 / 平均 / 最长）。整表写的开销随表线性增长，这行日志是日后评估要不要按站点分片的
// 前后对比依据。一轮开始时 beginDramasWriteStats 登记一个收集器，期间的每次写记进所有在册的
// 收集器——抓取轮与抓取后翻译线并行时，同一次写会同时算进两边（分不清是谁引起的，按「轮内发生」算）
const dramasWriteCollectors = new Set();
const writeClockMs = () => (typeof performance !== 'undefined' && performance?.now ? performance.now() : Date.now());

function beginDramasWriteStats() {
  const stats = { count: 0, totalMs: 0, maxMs: 0 };
  dramasWriteCollectors.add(stats);
  return stats;
}

function endDramasWriteStats(stats, label) {
  dramasWriteCollectors.delete(stats);
  if (!stats || stats.count === 0) return; // 空轮（翻译线空扫描每秒一轮）不刷日志
  const avg = stats.totalMs / stats.count;
  console.log(`[ShortScraping] ${label} dramas 整表写入 ${stats.count} 次，平均 ${avg.toFixed(1)}ms，最长 ${stats.maxMs.toFixed(1)}ms（表 ${dramasCache?.length ?? '?'} 条）`);
}

function recordDramasWrite(ms) {
  for (const stats of dramasWriteCollectors) {
    stats.count++;
    stats.totalMs += ms;
    if (ms > stats.maxMs) stats.maxMs = ms;
  }
}

/**
 * 仅队列内调用：写 dramas 表（连带键经 extra 同次 set）。set 成功后缓存指向
 * 新数组；失败则缓存失效重读并向上抛——防「缓存已新、storage 仍旧」的分歧驻留。
 * 只读模式（见前向兼容护栏）直接拒写。缓存为空＝本生命周期还没读过表（清库这类不读先写的
 * 路径），先补读一次布局标记再判，免得绕过护栏。
 * 同一次 set 换一个新的 dramasStamp（见冷启动指纹），放在 extra 之后，调用方的连带键盖不掉它。
 */
async function writeDramasInQueue(next, extra = {}) {
  if (dramasCache === null) {
    const { dramasMeta } = await chrome.storage.local.get('dramasMeta');
    noteDramasLayout(dramasMeta);
  }
  if (dramasLayoutAhead) throw new Error(dramasReadOnlyMessage());
  const stamp = newDramasStamp(next);
  const startedAt = writeClockMs();
  try {
    await chrome.storage.local.set({ dramas: next, ...extra, dramasStamp: stamp });
    dramasCache = next;
    dramasCacheFilledOnce = true;
    if (next && typeof next === 'object') dramasStamps.set(next, stamp);
  } catch (e) {
    dramasCache = null;
    throw e;
  } finally {
    recordDramasWrite(writeClockMs() - startedAt);
  }
}

/**
 * 队列外只读快照（Lark 推送 / 单卡 🌍 / 回填后读回等用；翻译扫描与 CSV 同步改走
 * readDramasThroughQueue）：缓存非 null 直接返回引用，
 * 调用方不得改动；缓存为空时直读 storage 且不回填——await 期间队列可能已提交
 * 新值，旧读回填会把缓存拽回过去。
 */
async function getDramasSnapshot() {
  if (dramasCache !== null) return dramasCache;
  return readDramasFromStorage();
}

/**
 * 队列外读表且回填缓存：缓存命中直接返回引用（只读约定同 getDramasSnapshot）；未命中时排进
 * 写队列读一次，由 getDramasInQueue 回填——排在已入队的写之后，读到的是已提交的最新表，不会
 * 把缓存拽回过去（同 scrapeContextForContent）。SW 冷唤醒时翻译扫描、CSV 同步此前各自整表读一遍
 * （getDramasSnapshot 不回填），现在合计只读一次。
 * **只许在队列回调之外调用**：队列回调里 await 它等的是自己所在的队列，死锁。
 */
async function readDramasThroughQueue(label) {
  if (dramasCache !== null) return dramasCache;
  return enqueueDramaWrite(label, getDramasInQueue);
}

const SCHEDULE_TASKS = {
  'scrape-task': {
    intervalKey: 'scrapeInterval',
    cronKey: 'scrapeCron',
    label: '抓取'
  },
  'translate-task': {
    intervalKey: 'translateInterval',
    cronKey: 'translateCron',
    label: '翻译'
  }
};

// 看门狗：周期性唤醒 SW，确保 cron 一次性 alarm 在 SW 意外退出后能被恢复。
const WATCHDOG_ALARM_NAME = 'watchdog';
const WATCHDOG_INTERVAL_MINUTES = 60;

/**
 * 把 storage.local 收成只对扩展页面与 SW 开放（审查 storage-secrets-exposed-to-content）。
 * 内容脚本已不读写 storage（抓取上下文经 getScrapeContext 消息向后台要），而 local 区里放着
 * AI Key、飞书 AppSecret 与 webhook：第三方站点的渲染进程一旦被攻破，直连 storage 能读走密钥、
 * 改写 translateConfig.aiEndpoint 让下一轮翻译把 Bearer Key 发出去、或 set({ dramas: [] }) 清库——
 * 正是 onMessage 发送方闸门要挡的动作，直连 storage 能绕过它。
 * 部分 Chrome 版本只允许对 session 区设访问级别，对 local 区会同步抛错或返回 rejected promise：
 * 两种都只记一条日志，**绝不能挡住后面的初始化**（届时只剩消息层闸门这一道防线）。
 */
function restrictStorageToTrustedContexts() {
  const warn = e => console.warn('[ShortScraping] storage.local 访问级别收窄未生效（内容脚本仍可直连 storage）:', e?.message || e);
  try {
    const pending = chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    if (pending && typeof pending.catch === 'function') pending.catch(warn);
  } catch (e) {
    warn(e);
  }
}
restrictStorageToTrustedContexts();

/**
 * 初始化：service worker 每次启动（含为分发 onInstalled / onStartup 而启动的那一次）在顶层
 * 恢复一次配置并装定时任务，确保 JSON 是配置源（configAheadOfFile 标记的项例外：本地领先于
 * 文件，改为推回文件，见 loadConfigFromJsonFiles）。两个监听器不再各跑一遍 load + setup：
 * 此前扩展升级 / 浏览器启动时同一实例里两条迁移链并发，标记未置位时 ReelShort / Shortical
 * 迁移的网络阶段各跑一遍（审查 double-init-on-install-startup）。本 promise 不会 reject。
 *
 * setupAlarms 经 beforeMigrations 钩子在配置种子落库之后、迁移链之前执行，不再排在整条
 * 迁移链之后：链里有联网迁移（ReelShort 逐条请求 / Shortical sitemap），请求挂住时 SW 可能
 * 被空闲回收，每次唤醒从头再卡一遍，看门狗与定时任务永远轮不到安装——碰上扩展更新后闹钟
 * 丢失，定时抓取/翻译全停（审查 setupalarms-gated-by-network-migrations）。
 */
const initPromise = loadConfigFromJsonFiles({ beforeMigrations: setupAlarms }).catch(async error => {
  console.error('[ShortScraping] 从 JSON 恢复配置失败:', error);
  // 配置种子 set 失败时钩子还没跑到：兜一次，看门狗不能跟着装不上（ensureAlarm 幂等，
  // 钩子已跑过时再装一遍也不会推迟任何任务）
  await setupAlarms().catch(e =>
    console.error('[ShortScraping] 定时任务安装失败（看门狗或下次唤醒重建）:', e?.message || e));
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'update') {
    // 版本变了（含重载未打包扩展、回退后再升级）：冷启动指纹作废并强推一次，见 resetCsvSyncFingerprint
    await resetCsvSyncFingerprint();
    return;
  }
  if (details.reason !== 'install') return;
  // 排在顶层初始化之后：清库不能与同一实例里的订阅外清理 / 迁移交错写 dramas
  await initPromise;
  await clearAllDramas();

  // 打开设置页面
  chrome.tabs.create({ url: chrome.runtime.getURL('src/settings/settings.html') });
});

// 监听器本身要留着：浏览器启动时靠它把 SW 拉起来，顶层初始化才会执行
chrome.runtime.onStartup.addListener(() => initPromise);

// SW 每次启动预热一次共享快照：扩展重载/同步服务重启后局域网共享页
// 立即有数据，无需等下一次抓取；服务端对相同内容不会广播刷新。
// 本地时间线为空且无 allowEmptySync 时不推（空库护栏，见 syncTimelineToCsv）。
// v1.6.22 起先比对冷启动指纹：同步服务上已确认正是本地这一版时跳过——SW 每次被回收再唤醒都要整表读
// 一遍、整表 POST 一遍，而绝大多数唤醒时两边本来就一致。任何一项对不上或拿不到都照旧推（csvSyncUpToDate）
warmupCsvSyncIfStale();

// SW 重启孤儿清理：storage 里 running:true 但本实例没有在跑的轮，说明上一
// 实例连同其翻译轮已死（顶层代码只在新实例启动时求值一次），把状态归位，
// 避免弹窗按持久化状态永远显示「翻译中」。
cleanupOrphanTranslateRunState();

/**
 * translateRunState 的唯一写入口。独立 key 直接 set，不进 dramas 写队列
 * （单写者 + 无读改写，不存在竞态）；镜像同步更新供 getTranslateState 应答。
 */
function writeTranslateRunState(state) {
  translateRunStateMirror = state;
  return chrome.storage.local.set({ translateRunState: state }).catch(error => {
    console.warn('[ShortScraping] 翻译运行状态写入失败:', error?.message || error);
  });
}

async function cleanupOrphanTranslateRunState() {
  try {
    const { translateRunState } = await chrome.storage.local.get('translateRunState');
    if (!translateRunState?.running || translateRun) return;

    console.warn('[ShortScraping] 检测到上一实例遗留的翻译运行状态，已重置');
    const now = Date.now();
    await writeTranslateRunState({
      running: false,
      startedAt: translateRunState.startedAt || null,
      updatedAt: now,
      finishedAt: now,
      pendingCount: translateRunState.pendingCount || 0,
      processedCount: translateRunState.processedCount || 0,
      translatedCount: translateRunState.translatedCount || 0,
      summary: {
        pendingCount: translateRunState.pendingCount || 0,
        processedCount: translateRunState.processedCount || 0,
        translatedCount: translateRunState.translatedCount || 0,
        error: '后台重启，翻译中断'
      }
    });
  } catch (error) {
    console.warn('[ShortScraping] 翻译孤儿状态清理失败:', error?.message || error);
  }
}

/**
 * 从扩展 config 目录的 tag.json / cron.json / trans.json / lark.json 恢复配置。
 * options.beforeMigrations：配置种子落库后、订阅外清理与迁移链之前执行的钩子（顶层
 * initPromise 传 setupAlarms，见其注释）；失败只记日志、不挡后面的迁移。不传则不执行。
 */
async function loadConfigFromJsonFiles({ beforeMigrations = null } = {}) {
  const [tagConfigRaw, scheduleConfigRaw, translateConfigRaw, larkConfigRaw, stored] = await Promise.all([
    fetchJsonFile(CONFIG_FILES.tag.file, null),
    fetchJsonFile(CONFIG_FILES.cron.file, null),
    fetchJsonFile(CONFIG_FILES.trans.file, null),
    fetchJsonFile(CONFIG_FILES.lark.file, null),
    chrome.storage.local.get([...Object.values(CONFIG_FILES).map(c => c.storageKey), 'configAheadOfFile'])
  ]);

  const ahead = isPlainObject(stored.configAheadOfFile) ? stored.configAheadOfFile : {};
  const updates = {};    // 本轮要从文件写进 storage 的配置（一次 set 落库）
  const aheadKeys = [];  // 本地领先于文件、要推回文件的配置

  // 每个配置三选一（null 是「读取/解析失败」的哨兵，四个文件同一口径）：
  //   ① configAheadOfFile[key]：设置页写了 storage 但写回文件失败，文件是旧的——不许它覆盖
  //      storage（tag 则不按文件订阅清理历史：服务没开时新增订阅、抓了卡，旧文件回滚后会把
  //      新订阅下的历史静默删光），改为把 storage 推回文件，成功后摘标记；
  //   ② 文件读成功 → 文件是配置源，覆盖 storage（既有语义）；
  //   ③ 读取/解析失败 ≠ 用户改了配置：保留 storage 上次的值，storage 也没有时才用默认值。
  //      此前 cron/trans/lark 失败即回落默认值并覆盖 storage——trans.json 多个逗号就静默切回
  //      MyMemory，lark.json 写坏则机器人被关、larkBotState 连同重试队列被清空。
  const pick = (key, raw, isValid, normalize, seedDefault) => {
    const { file, storageKey } = CONFIG_FILES[key];
    const storedValue = stored[storageKey];
    // 本地值结构也得像样才算「领先」：坏值推回去只会被服务端 400，标记永远摘不掉，
    // 文件也永远进不来——这种情况按未标记处理，让文件接管
    if (ahead[key] === true && isValid(storedValue)) {
      aheadKeys.push(key);
      console.warn(`[ShortScraping] ${file} 落后于扩展本地配置（上次写回失败），保留本地配置并尝试写回`);
      return { value: normalize(storedValue), fromFile: false };
    }
    if (isValid(raw)) {
      const value = normalize(raw);
      updates[storageKey] = value;
      return { value, fromFile: true };
    }
    if (storedValue !== undefined) {
      console.warn(`[ShortScraping] ${file} 读取或解析失败，保留扩展里上次的配置${key === 'tag' ? '并跳过历史清理' : ''}`);
      return { value: normalize(storedValue), fromFile: false };
    }
    console.warn(`[ShortScraping] ${file} 读取或解析失败，扩展里也没有旧配置，使用默认配置`);
    const value = normalize(undefined);
    if (seedDefault) updates[storageKey] = value;
    return { value, fromFile: false };
  };

  // tag.json 结构不是数组也算读取失败（≠ 用户清空订阅）；只有成功读到数组（含合法的空数组）
  // 才允许覆盖订阅并清理界外历史。storage 也没有订阅时不种 []：那会经 onChanged 触发清库
  const tag = pick('tag', tagConfigRaw, Array.isArray, normalizeUrlTags, false);
  const urlTags = tag.value;
  const scheduleConfig = pick('cron', scheduleConfigRaw, isPlainObject, ScheduleConfig.normalizeConfig, true).value;
  const translateConfig = pick('trans', translateConfigRaw, isPlainObject, TranslateConfig.normalizeConfig, true).value;
  const larkConfig = pick('lark', larkConfigRaw, isPlainObject, Lark.normalizeConfig, true).value;

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
  // 排在种子 set 之后：setupAlarms 读的 scheduleConfig 须是刚从 cron.json 恢复的值
  if (beforeMigrations) {
    try {
      await beforeMigrations();
    } catch (error) {
      console.error('[ShortScraping] 定时任务安装失败（看门狗或下次唤醒重建，迁移照常进行）:', error?.message || error);
    }
  }
  if (tag.fromFile) {
    await runGuarded('订阅外历史清理', () =>
      pruneDramasOutsideConfiguredUrls(urlTags, { reason: 'SW 唤醒回读 config/tag.json' }));
  }
  // 写回与下面的迁移并行（服务没开时最多等 3s），函数返回前收口，失败只记日志、标记保留
  const writeBackRun = aheadKeys.length > 0
    ? runGuarded('本地领先配置写回文件', () => writeBackAheadConfigs(aheadKeys, stored))
    : null;

  // 水位线同步与一次性迁移各自兜底：任一抛错只记日志、下轮唤醒重试（各自的完成标记未置位）。
  // 它们的失败不能向上冒泡（2026-09-17 审计 H1：当时 setupAlarms 挂在本函数之后，某迁移确定性
  // 抛错＝看门狗与定时任务一起装不上）。setupAlarms 现已提前到上面的钩子，这里的兜底仍保留：
  // 后面的迁移不能被前面某一条连坐。配置种子 set 失败仍照旧向上传播：那是「配置没恢复成」。
  await runGuarded('群机器人水位线同步', () => syncBotWatermark(larkConfig));
  for (const [label, step] of [
    ['itemId/标签/未映射 fandom 迁移', runLegacyDramaMigrations],
    ['company 字段移除', dropCompanyField],
    ['半成品翻译复位', resetPartialTranslations],
    ['非中文译名复位', resetNonChineseTitleZh],
    ['乱码译文复位', resetGarbledTranslations],
    ['ReelShort 播放页 URL 迁移', migrateReelshortEpisodeUrls],
    ['Shortical 规范 id 迁移', migrateShorticalCanonicalIds]
  ]) {
    await runGuarded(label, step);
  }
  await writeBackRun;

  console.log(`[ShortScraping] 已从 JSON 恢复配置：${urlTags.length} 个 URL，翻译模式=${translateConfig.translateMode}`);

  return { urlTags, scheduleConfig, translateConfig };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把「本地领先于文件」的配置推回同步服务（POST /config/<key>，请求体与设置页 trySyncConfig
 * 同形），逐个成功才摘 configAheadOfFile[key]。摘标记前重读 storage：写回在飞期间设置页可能
 * 又存了新值，本地值已变的键不摘、反而重新置位——设置页的退订是「先写文件、同次 set 清标记」，
 * 这边迟到的旧值 POST 可能正好把它刚写好的 tag.json 盖回旧订阅；标记若随之消失，下次唤醒
 * 旧文件就会复活已退订的订阅。置位后下次唤醒按 storage 的现值再推一次，文件终会追平。
 */
async function writeBackAheadConfigs(keys, stored) {
  const done = [];
  await Promise.all(keys.map(async key => {
    const { file, storageKey } = CONFIG_FILES[key];
    try {
      await postConfigToSyncServer(key, { [storageKey]: stored[storageKey] });
      done.push(key);
      console.log(`[ShortScraping] 已把扩展本地配置写回 ${file}`);
    } catch (e) {
      console.warn(`[ShortScraping] 写回 ${file} 仍失败（保留本地领先标记，下次唤醒重试）:`, e?.message || e);
    }
  }));
  if (done.length === 0) return;

  const latest = await chrome.storage.local.get(['configAheadOfFile', ...done.map(key => CONFIG_FILES[key].storageKey)]);
  const next = { ...(isPlainObject(latest.configAheadOfFile) ? latest.configAheadOfFile : {}) };
  let changed = false;
  for (const key of done) {
    const { storageKey } = CONFIG_FILES[key];
    if (JSON.stringify(latest[storageKey]) !== JSON.stringify(stored[storageKey])) {
      if (next[key] !== true) { next[key] = true; changed = true; }
      continue;
    }
    if (!(key in next)) continue;
    delete next[key];
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ configAheadOfFile: next });
}

async function postConfigToSyncServer(key, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG_WRITE_BACK_TIMEOUT_MS);
  try {
    const response = await fetch(`${CONFIG_SYNC_BASE_URL}${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!result?.ok) throw new Error(result?.error || '同步服务返回失败');
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`同步服务 ${CONFIG_WRITE_BACK_TIMEOUT_MS / 1000}s 内无响应`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 旁路步骤的统一兜底：失败只 warn，不向上冒泡（见 loadConfigFromJsonFiles 内注释）。 */
async function runGuarded(label, step) {
  try {
    await step();
  } catch (error) {
    console.warn(`[ShortScraping] ${label}失败（下轮唤醒重试，不影响配置恢复与定时任务）:`, error?.message || error);
  }
}

async function fetchJsonFile(fileName, fallback) {
  try {
    const response = await fetch(chrome.runtime.getURL(fileName), { cache: 'no-store' });
    if (!response.ok) throw new Error(`${fileName} HTTP ${response.status}`);
    return await response.json();
  } catch (e) {
    // 取舍（保留旧值 / 用默认值）由调用方按 fallback 哨兵决定，这里只记原因
    console.warn(`[ShortScraping] 读取 ${fileName} 失败:`, e.message);
    return fallback;
  }
}

/**
 * 订阅规范化单一真源在 src/shared/subscription-config.js（v1.6.5 收敛）：此前这里
 * 不 trim 标签、不校 http、不去重，与设置页保存路径语义漂移——同一份 tag.json 经 SW
 * 启动加载与经设置页保存会得到两种标签。本地名保留为一行委托（同 siteOfUrl 先例）。
 */
function normalizeUrlTags(rawTags) {
  return SubscriptionConfig.normalizeUrlTags(rawTags);
}

/**
 * 设置定时任务
 */
async function setupAlarms() {
  // 看门狗最先安装：即使后面的任务配置损坏，自愈通道也必须先就位。
  await ensureAlarm(WATCHDOG_ALARM_NAME, { periodInMinutes: WATCHDOG_INTERVAL_MINUTES });

  const { scheduleConfig } = await chrome.storage.local.get('scheduleConfig');
  const config = ScheduleConfig.normalizeConfig(scheduleConfig);
  const scheduleMode = config.scheduleMode === 'cron' ? 'cron' : 'interval';

  // 逐任务独立安装：单个任务失败不连累其余任务
  for (const name of Object.keys(SCHEDULE_TASKS)) {
    try {
      await setupTaskAlarm(name, config, scheduleMode);
    } catch (e) {
      console.error(`[ShortScraping] ${name} 定时任务安装失败:`, e?.message || e);
    }
  }

  if (scheduleMode === 'cron') {
    console.log(`[ShortScraping] Cron 定时任务已设置: 抓取=${config.scrapeCron}, 翻译=${config.translateCron}`);
  } else {
    console.log(`[ShortScraping] 间隔定时任务已设置: 抓取=${config.scrapeInterval}h, 翻译=${config.translateInterval}h`);
  }
}

async function setupTaskAlarm(name, config, scheduleMode) {
  const task = SCHEDULE_TASKS[name];
  if (!task) return;

  if (scheduleMode === 'cron') {
    const cronExpression = config[task.cronKey];
    try {
      const nextRunAt = ScheduleConfig.getNextCronRun(cronExpression);
      const nextRunLabel = new Date(nextRunAt).toLocaleString('zh-CN');

      // cron 任务是一次性 alarm；形状与时间的比较统一收在 isSameAlarm 里
      await ensureAlarm(name, { when: nextRunAt });

      console.log(`[ShortScraping] ${task.label} Cron 下一次执行: ${nextRunLabel} (${cronExpression})`);
      return;
    } catch (e) {
      // 非法/永不匹配的 cron 不能让任务静默消失：降级为间隔调度兜底
      console.error(`[ShortScraping] ${task.label} Cron 表达式无效（${cronExpression}），已降级为间隔调度:`, e?.message || e);
    }
  }

  const intervalHours = Number(config[task.intervalKey]) || ScheduleConfig.DEFAULT_CONFIG[task.intervalKey];
  await ensureAlarm(name, {
    periodInMinutes: intervalHours * 60
  });
}

/**
 * alarm 安装的唯一入口：与目标计划一致就原样保留，否则清掉重建。
 * 没有 force 旁路——强制重建会把周期任务的下一次执行重新推到「此刻 + 整个周期」，
 * 用户每保存一次设置就饿死一轮抓取（2026-09-05 审查里的看门狗 P1 即此机制）。
 */
async function ensureAlarm(name, alarmInfo) {
  const existing = await chrome.alarms.get(name);

  if (existing && isSameAlarm(existing, alarmInfo)) {
    return;
  }

  await chrome.alarms.clear(name);
  chrome.alarms.create(name, alarmInfo);
}

function isSameAlarm(existing, alarmInfo) {
  if (typeof alarmInfo.periodInMinutes === 'number') {
    // 一次性 alarm 的 periodInMinutes 缺席（|| 0），与任何正周期都不相等 → 重建
    return Math.abs((existing.periodInMinutes || 0) - alarmInfo.periodInMinutes) < 0.001;
  }

  if (typeof alarmInfo.when === 'number') {
    // 形状必须先一致：周期 alarm 的 scheduledTime 偶然落在 cron 槽位上时，
    // 若把它当成合法的一次性 cron alarm 留下，中间所有 cron 槽位都会被跳过
    // （interval→cron 切换走非 force 路径时必现，'*/10 * * * *' 命中率 6/60）。
    if (typeof existing.periodInMinutes === 'number') return false;
    // Chrome 保存的 scheduledTime 与计算值可能有毫秒级差异，1 秒以内视为同一个计划。
    return Math.abs((existing.scheduledTime || 0) - alarmInfo.when) < 1000;
  }

  return false;
}

async function rescheduleCronTask(name) {
  const { scheduleConfig } = await chrome.storage.local.get('scheduleConfig');
  const config = ScheduleConfig.normalizeConfig(scheduleConfig);

  if (config.scheduleMode !== 'cron') return;

  await setupTaskAlarm(name, config, 'cron');
}

/**
 * 监听闹钟
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log(`[ShortScraping] 闹钟触发: ${alarm.name}`);

  // 机器人重试队列：与抓取/翻译无关，处理完直接返回，别落进下面的 cron 续排分支
  if (alarm.name === BOT_RETRY_ALARM_NAME) {
    await processBotRetryQueue().catch(e =>
      console.warn('[ShortScraping] 群机器人重试队列处理失败:', e?.message || e));
    return;
  }

  if (alarm.name === WATCHDOG_ALARM_NAME) {
    // 补回缺失/过期/形状不符的 alarm，保留健康任务的原定执行时间，避免间隔任务被推迟。
    await setupAlarms().catch(e =>
      console.error('[ShortScraping] 看门狗重建定时任务失败:', e?.message || e));
    return;
  }

  try {
    if (alarm.name === 'scrape-task') {
      await performScrape();
    } else if (alarm.name === 'translate-task') {
      await performTranslate();
    }
  } finally {
    await rescheduleCronTask(alarm.name).catch(e =>
      console.error(`[ShortScraping] ${alarm.name} 续排失败:`, e?.message || e));
  }
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'local') return;

  if (changes.urlTags) {
    pruneDramasOutsideConfiguredUrls(changes.urlTags.newValue || [], { reason: '订阅变更（storage.urlTags）' }).catch(error => {
      console.warn('[ShortScraping] 清理非订阅来源历史记录失败:', error.message);
    });
  }

  if (changes.dramas) {
    scheduleCsvSync();
  }

  // 设置页一保存就把机器人水位线定在「此刻」，而不是等第一条卡来触发——
  // 否则开启后的第一条新卡会因为 scrapedAt 早于水位线被跳过
  if (changes.larkConfig) {
    syncBotWatermark(Lark.normalizeConfig(changes.larkConfig.newValue)).catch(error => {
      console.warn('[ShortScraping] 群机器人水位线更新失败:', error.message);
    });
  }
});

/**
 * 执行抓取任务（对外入口）。site 给定时只抓该站点的订阅 URL。
 * 所有调用（定时全量 / 手动单站）经同一条串行队列执行，每个调用者拿到
 * 自己那次抓取的结果；排队期间即计入 activeScrapeCount 并预约翻译线。
 * 全量调用在已有一轮全量排队（尚未开跑）时直接拿那一轮的 promise，不再追加：
 * 它开跑时才读订阅，与再排一轮抓的是同一批 URL。
 */
function performScrape(options = {}) {
  const isFull = !options.site;
  if (isFull && pendingFullScrape) {
    console.log('[ShortScraping] 已有一轮全量抓取在排队，本次调用并入该轮');
    return pendingFullScrape;
  }

  activeScrapeCount++;
  schedulePostScrapeTranslateLoop();

  let tracked = null;
  const run = scrapeQueue.then(() => {
    if (!isFull) return performScrapeOnce(options);
    if (pendingFullScrape === tracked) pendingFullScrape = null;
    const progress = { pendingSites: null };
    fullScrapeProgress = progress;
    return performScrapeOnce(options, progress).finally(() => {
      if (fullScrapeProgress === progress) fullScrapeProgress = null;
    });
  });
  scrapeQueue = run.then(() => {}, () => {});
  tracked = run.finally(() => {
    activeScrapeCount--;
    // 最后一个抓取收尾时翻译线若已提前退出，再安排一次（见 resumePostScrapeTranslateLoop）
    resumePostScrapeTranslateLoop();
    // 抓取期间 CSV 推送走 8 秒节流，收尾时把攒着的那次提前到 500ms 后推出（还有抓取或翻译轮在跑就不动）
    flushCsvSyncAfterBusy();
  });
  if (isFull) pendingFullScrape = tracked;
  return tracked;
}

/**
 * 弹窗单站刷新能否并进全量轮：有全量轮在排队（开跑时才读订阅，必然涵盖该站），或正在跑的
 * 全量轮还没开抓该站的任何 URL。已开抓（哪怕只抓了该站的第一个 URL）或本轮清单里没有该站
 * 时返回 false，照旧排一次单站抓取——半截抓过的站并进来，用户要的「刚刚刷新」就落空了。
 */
function fullScrapeWillCoverSite(site) {
  if (!site) return false;
  if (pendingFullScrape) return true;
  if (!fullScrapeProgress) return false;
  const { pendingSites } = fullScrapeProgress;
  return pendingSites === null || pendingSites.has(site);
}

async function performScrapeOnce({ site = null } = {}, progress = null) {
  console.log(site ? `[ShortScraping] 开始站点抓取: ${site}` : '[ShortScraping] 开始全量抓取...');
  const writeStats = beginDramasWriteStats();

  try {
    const { urlTags = [] } = await chrome.storage.local.get('urlTags');
    let scrapeUrls = getConfiguredScrapeUrls(urlTags);
    if (site) {
      scrapeUrls = scrapeUrls.filter(url => siteOfUrl(url) === site);
    }
    // 全量轮：本轮清单里的站点都还在前头，循环开抓某站第一个 URL 时摘掉（见 fullScrapeWillCoverSite）
    if (progress) progress.pendingSites = new Set(scrapeUrls.map(siteOfUrl));

    if (scrapeUrls.length === 0) {
      console.log('[ShortScraping] 未配置抓取 URL，跳过抓取');
      return { urlCount: 0, totalNewCount: 0, results: [] };
    }

    // 订阅 URL 首轮只入库不推送：开轮时库里零条的订阅 URL 挂「进行中」，收轮时基线定在完成时刻。
    // 经队列读表顺带把缓存预热给随后的入库写，不多付一次全表读
    try {
      const existing = await enqueueDramaWrite('订阅首轮判定', getDramasInQueue);
      // 只读模式（见下）本轮不开抓：标了「进行中」也等不到收轮，不标
      if (!dramasLayoutAhead) {
        const populated = new Set(existing.map(d => UrlMatch.normalizeListUrl(d.sourceListUrl)).filter(Boolean));
        await markUrlBaselines(scrapeUrls.filter(url => !populated.has(UrlMatch.normalizeListUrl(url))));
      }
    } catch (e) {
      console.warn('[ShortScraping] 订阅首轮基线标记失败（不影响抓取）:', e?.message || e);
    }

    // 前向兼容护栏：上面这次读表在缓存未命中时已连带读了布局标记（缓存热着时标记早在填缓存时读过）。
    // 只读模式下入库必被拒，不再逐个打开订阅页、请求详情页——每个标签页白跑一遍、每张新卡被拒一次，
    // 每轮重来。不抛错：定时轮的闹钟监听器不接 rejection，只留一条告警；弹窗手动刷新由 triggerScrape
    // 按 readOnly 回报错
    if (dramasLayoutAhead) {
      warnDramasReadOnlyOnce('抓取');
      return { urlCount: 0, totalNewCount: 0, results: [], readOnly: true, error: dramasReadOnlyMessage() };
    }

    let totalNewCount = 0;
    const results = [];

    for (const url of scrapeUrls) {
      progress?.pendingSites.delete(siteOfUrl(url));
      try {
        const response = await scrapeUrlInTab(url);
        if (response?.success) {
          const newCount = (response.data || []).length;
          totalNewCount += newCount;
          results.push({ url, success: true, newCount });
          console.log(`[ShortScraping] 抓取完成: ${url}，新增 ${newCount} 部`);
        } else {
          results.push({ url, success: false, error: response?.error || '未知错误' });
        }
      } catch (e) {
        results.push({ url, success: false, error: e.message });
        console.error(`[ShortScraping] 抓取 URL 失败: ${url}`, e);
      }
    }

    // 收轮：本轮 URL 里「进行中」的机器人基线定在此刻，此后抓到的才算「有更新」
    await finalizeUrlBaselines(scrapeUrls).catch(e =>
      console.warn('[ShortScraping] 订阅首轮基线收口失败（下轮重试）:', e?.message || e));

    // 一个都没抓成（断网 / 站点改版）不刷新 lastScrape：否则定时抓取已经停摆，弹窗底栏还是
    // 「抓取于几分钟前」（审查 lastscrape-set-on-total-failure）。另记 lastScrapeFailure 供弹窗
    // 提示「最近一轮全部失败」；有成功的轮次在同一次 set 里把它清掉
    const finishedAt = new Date().toISOString();
    if (results.some(r => r.success)) {
      await chrome.storage.local.set({ lastScrape: finishedAt, lastScrapeFailure: null });
    } else {
      console.warn(`[ShortScraping] 本轮 ${scrapeUrls.length} 个 URL 全部抓取失败，不更新上次抓取时间`);
      await chrome.storage.local.set({
        lastScrapeFailure: {
          at: finishedAt,
          failed: results.length,
          total: scrapeUrls.length,
          error: String(results[0]?.error || '未知错误')
        }
      });
    }

    // 抓取刚结束队列缓存必热：按最新订阅强制过一遍订阅外清理（零 storage 读），关掉
    // 「退订时抓取仍在飞、迟到的 saveDrama 把界外卡写回」的竞态——SW 唤醒的清理受
    // 指纹闸门约束，不会再兜这一手。重读 urlTags 而非用开轮时的快照，退订正是发生在
    // 这段时间里。失败只记日志，不影响本轮抓取结果。
    const { urlTags: latestUrlTags = [] } = await chrome.storage.local.get('urlTags');
    await pruneDramasOutsideConfiguredUrls(latestUrlTags, { force: true, reason: '抓取结束强制清理' }).catch(e =>
      console.warn('[ShortScraping] 抓取后订阅外清理失败:', e?.message || e));

    if (totalNewCount > 0) {
      showNotification(`发现 ${totalNewCount} 部新短剧！`);
    }

    return { urlCount: scrapeUrls.length, totalNewCount, results };
  } catch (e) {
    console.error('[ShortScraping] 抓取失败:', e);
    throw e;
  } finally {
    endDramasWriteStats(writeStats, site ? `站点抓取（${site}）` : '全量抓取');
  }
}

/**
 * 按域名判断订阅 URL 所属站点。规则单一真源在 src/shared/site-registry.js。
 */
function siteOfUrl(url) {
  return SiteRegistry.siteOfUrl(url);
}

/**
 * 从设置中读取可抓取 URL。只抓取完整 URL，标签关键词不会被当作 URL。
 */
function getConfiguredScrapeUrls(urlTags) {
  const urls = (urlTags || [])
    .map(item => item.urlPattern)
    .filter(pattern => /^https?:\/\//i.test(pattern));

  // 去重按尾斜杠归一（与 SubscriptionConfig.normalizeUrlTags、归属判定同口径），保留先出现的
  // 原串：新写入的 urlTags 已不会并存两种写法，这里兜住旧版本写进 storage 的 '…/x' 与 '…/x/'——
  // 按原串去重时同一页每轮要开两个标签页抓两遍（审查 urltags-dedupe-raw）
  const seen = new Set();
  return urls.filter(url => {
    const key = UrlMatch.normalizeListUrl(url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function filterDramasByConfiguredUrls(dramas, urlTags) {
  const configuredUrls = getConfiguredScrapeUrls(urlTags);
  if (configuredUrls.length === 0) return [];

  // 归属判定＝尾斜杠归一后的精确等值（UrlMatch，三端共用）。旧的 startsWith
  // 前缀匹配会让互为前缀的订阅串扰：退订 my-drama.com/?list=… 后，其历史
  // 卡片因前缀命中 my-drama.com/ 而清不掉且挂错归属。
  const configuredSet = UrlMatch.buildConfiguredUrlSet(configuredUrls);
  return (dramas || []).filter(drama => UrlMatch.isUrlCovered(drama.sourceListUrl, configuredSet));
}

/**
 * 订阅 URL 集合指纹：尾斜杠归一 + 排序（与 filterDramasByConfiguredUrls 同口径），
 * 持久化在 storage 的 pruneFingerprint 键。SW 每次唤醒都会跑一遍订阅外清理，没有
 * 闸门时每次冷启动都把约 5MB 的 dramas 全表反序列化一遍（v1.6.5 审计）；集合没变
 * 就跳过，读一个小键代替读全表。
 */
function configuredUrlFingerprint(urlTags) {
  return [...UrlMatch.buildConfiguredUrlSet(getConfiguredScrapeUrls(urlTags))].sort().join('\n');
}

/**
 * 清理订阅范围外的历史记录。默认受指纹闸门约束：集合与上次清理完成时相同即跳过、
 * 零全表读（SW 唤醒与 storage.onChanged 两条路都走这里，顺带消灭了「set urlTags 触发
 * onChanged + 显式调用」的双清理）。force 供抓取结束时调用——退订时抓取仍在飞、迟到的
 * saveDrama 会把界外卡写回，而那一刻队列缓存必热，强制过一遍零 storage 读。
 * 指纹只在本轮清理完成后落库；写入失败向上抛、指纹不更新，下轮照常重试。
 * 被删条目与删除同次写进 storage.pruneTrash（回收站），见 nextPruneTrash。
 */
function pruneDramasOutsideConfiguredUrls(urlTags, { force = false, reason = '订阅外清理' } = {}) {
  return enqueueDramaWrite('清理非订阅来源', async () => {
    const fingerprint = configuredUrlFingerprint(urlTags);
    const { pruneFingerprint } = await chrome.storage.local.get('pruneFingerprint');
    if (!force && pruneFingerprint === fingerprint) return;

    const dramas = await getDramasInQueue();
    const filtered = filterDramasByConfiguredUrls(dramas, urlTags);

    if (filtered.length !== dramas.length) {
      const keptSet = new Set(filtered);
      const pruneTrash = await nextPruneTrash(reason, dramas.filter(drama => !keptSet.has(drama)));
      // 回收站与删除同一次 set：要么都落库、要么都不落。分两次写时删除那次失败会留下一批
      // 「没删成却进了回收站」的条目，下轮重试再进一次，重复批把回收站里真正删过的旧批挤掉
      await writeDramasInQueue(filtered, { pruneFingerprint: fingerprint, pruneTrash });
      console.log(`[ShortScraping] 已清理 ${dramas.length - filtered.length} 条非订阅来源历史记录`);
    } else if (pruneFingerprint !== fingerprint) {
      await chrome.storage.local.set({ pruneFingerprint: fingerprint });
    }
  });
}

/**
 * 订阅外清理的回收站：本清理有三条入口（SW 唤醒回读 tag.json / urlTags 的 onChanged /
 * 抓取结束的强制清理），只有设置页退订那一条路径有确认框和导出备份。手改 tag.json 的笔误、
 * 服务没开时新增订阅被旧文件回滚，都会走到这里静默删掉整条订阅的历史（与 2026-09-17 事故
 * 同类）。所以把整批条目追加进 storage.pruneTrash（最新在尾、最多 PRUNE_TRASH_MAX_BATCHES
 * 批），设置页「数据存档」可导出成导入恢复认的 JSON。返回追加后的新数组，由调用方与删除
 * 同一次 set 落库：写失败即整次失败、本轮不删——宁可不清理，也不在没有留底的情况下删历史。
 */
async function nextPruneTrash(reason, removed) {
  const { pruneTrash } = await chrome.storage.local.get('pruneTrash');
  const urls = [...new Set(removed.map(drama => drama && drama.sourceListUrl).filter(Boolean).map(String))];
  const entry = { at: new Date().toISOString(), reason, urls, dramas: removed };
  return [...(Array.isArray(pruneTrash) ? pruneTrash : []), entry].slice(-PRUNE_TRASH_MAX_BATCHES);
}

/**
 * 存量迁移的逐条改写骨架：在 dramas 写队列内对每条跑 mapDrama（返回原对象＝不动，
 * 返回新对象＝改了），有改动才整表写回并打 describe(改动条数) 的日志；无改动零写入。
 */
function mapDramasInQueue(label, mapDrama, describe) {
  return enqueueDramaWrite(label, async () => {
    const dramas = await getDramasInQueue();
    const next = dramas.map(drama => mapDrama(drama));
    const changedCount = next.filter((drama, i) => drama !== dramas[i]).length;

    if (changedCount > 0) {
      await writeDramasInQueue(next);
      console.log(`[ShortScraping] ${describe(changedCount)}`);
    }
  });
}

/**
 * 挂独立完成标记的一次性逐条迁移：标记置位即跳过（标记单独读，不连带 dramas）；
 * 改写经 mapDramasInQueue 落库成功后才置标记——写表失败向上抛（runGuarded 兜住），
 * 标记不置位，下轮唤醒重试。
 */
async function runOnceDramaMigration(flag, label, mapDrama, describe) {
  const { [flag]: done } = await chrome.storage.local.get(flag);
  if (done) return;

  await mapDramasInQueue(label, mapDrama, describe);

  await chrome.storage.local.set({ [flag]: true });
}

/**
 * 去重键字段更名迁移（2026-07-25）：历史条目 imdbId → itemId，值不变。
 * imdbId 这个名字今后仅指 IMDB 站点条目的 tt 值本身，不再指代全站点去重键。
 * 幂等：无旧字段时零写入；必须先于其它按 itemId 读数的迁移/清理执行。
 */
function migrateItemIdField() {
  return mapDramasInQueue('去重键字段更名', drama => {
    if (!drama || !('imdbId' in drama)) return drama;
    const { imdbId, ...rest } = drama;
    return { ...rest, itemId: rest.itemId || imdbId };
  }, count => `已迁移 ${count} 条历史记录的去重键字段 imdbId -> itemId`);
}

/**
 * 存量 company 字段清理（v1.5.13）：该字段已从数据模型彻底移除——不再采集
 * （Steam 开发商 / RoyalRoad 作者名 / IMDB 出品方三处采集逻辑已删）、不进 CSV 列、
 * 本就不在 Lark payload 里，v1.5.3 起也不上卡片，留着纯属死数据。
 *
 * **刻意不挂进 runLegacyDramaMigrations**：那个入口被 legacyDramaMigrated 标记闸住，
 * 存量用户机器上早已置位，挂进去永远不会执行。按 rsEpisodeUrlMigrated 的先例用
 * 独立标记 companyFieldDropped。
 *
 * 幂等：无该键时零写入；写回经 storage.onChanged 自动触发一次 CSV 全量重写
 * （同步服务按 dramas 载荷签名判重，字段被摘掉即签名必变，新列序才落得了盘）。
 */
function dropCompanyField() {
  return runOnceDramaMigration('companyFieldDropped', '移除 company 字段', drama => {
    if (!drama || !('company' in drama)) return drama;
    const { company, ...rest } = drama;
    return rest;
  }, count => `已从 ${count} 条历史记录中移除 company 字段`);
}

/**
 * 存量「半成品翻译」复位（v1.5.14）：把标着 trans 却缺了该有译文的条目退回
 * status='new'，让翻译线重新补齐。命中条件＝原文非空而对应译文为空。
 *
 * 成因见 updateSingleDramaTranslation 的注释（回填判据曾是「任一非空即标完成」）
 * 与 Steam 适配器的官方中文分支。全库实测 683 条：660 条缺中文标题、23 条缺中文简介。
 *
 * 复位是安全的：翻译线走 fillOnly，只补空缺，已有的官方译名/既有译文不会被冲掉。
 * 独立标记 companyFieldDropped 同款理由——runLegacyDramaMigrations 早已置位。
 */
function resetPartialTranslations() {
  return runOnceDramaMigration('partialTranslationReset', '半成品翻译复位', drama => {
    if (!drama || drama.status !== 'trans') return drama;
    const needTitle = Boolean(String(drama.title || '').trim()) && !String(drama.titleZh || '').trim();
    const needDesc = Boolean(String(drama.description || '').trim()) && !String(drama.descriptionZh || '').trim();
    if (!needTitle && !needDesc) return drama;
    const { translateAttempts, ...rest } = drama;
    return { ...rest, status: 'new' };
  }, count => `已把 ${count} 条半成品翻译退回待翻译队列`);
}

/**
 * 存量「非中文译名」复位（v1.6.2）：把 titleZh 里压根没有汉字的条目清空译名、
 * 退回 status='new'，让翻译线用英文原名重新翻。
 *
 * 成因见 TranslateConfig.hasChineseChars 的注释——Steam 中文档在开发商没做
 * 简体中文本地化时返回的是**开发商母语**的名字，而适配器原判据只查「与英文
 * 不同」。2026-09-14 全库实测 24 条（22 Steam + 2 IMDB），全部已是 status='trans'：
 * 再抓取也不会自愈（去重命中分支只合并缺失的 genres），必须由本迁移兜。
 *
 * 复位是安全的：翻译线走 fillOnly，只补空缺，官方中文简介不会被冲掉；顺带清掉
 * translateAttempts，让复位后的条目重新拿满重试额度。
 * 独立标记理由同 companyFieldDropped——runLegacyDramaMigrations 早已置位。
 */
function resetNonChineseTitleZh() {
  return runOnceDramaMigration('nonChineseTitleZhReset', '非中文译名复位', resetNonChineseTitle,
    count => `已把 ${count} 条非中文译名退回待翻译队列`);
}

/**
 * 逐条：titleZh 非空却不含汉字 → 清空译名、退回 new、清重试计数；返回原对象表示无需改动。
 * 迁移与导入共用（同 clearGarbledTranslations）：现有全部采集路径写 titleZh 前都过
 * hasChineseChars（内容脚本各适配器、后台 keepChineseTranslation），库外不会再有合法的
 * 非汉字 titleZh，旧备份里的只能是修复前的旧形态。
 */
function resetNonChineseTitle(drama) {
  if (!drama) return drama;
  const titleZh = String(drama.titleZh || '').trim();
  if (!titleZh || TranslateConfig.hasChineseChars(titleZh)) return drama;
  const { translateAttempts, ...rest } = drama;
  return { ...rest, titleZh: '', status: 'new' };
}

/**
 * 乱码译文清理（v1.6.13）：titleZh / descriptionZh 含 U+FFFD 的清空该字段并退回
 * status='new'，交翻译线用英文原文重译；另一个完好的译文字段保留（fillOnly 只补空缺）。
 * 返回原对象表示无需改动。
 *
 * 成因：同步服务 readBody 曾逐块解码请求体，跨块的汉字被写成 `\uFFFD`，坏字进了
 * db/timeline.*；从这份文件「导入恢复」就把坏字带进扩展库（2026-09-25 实测 11 条）。
 * 服务端已修，存量与旧备份仍会带进来，所以迁移与导入两处都要过这一道。
 */
function clearGarbledTranslations(drama) {
  if (!drama) return drama;
  const garbled = ['titleZh', 'descriptionZh'].filter(key => String(drama[key] || '').includes('\uFFFD'));
  if (garbled.length === 0) return drama;
  const { translateAttempts, ...rest } = drama;
  for (const key of garbled) rest[key] = '';
  return { ...rest, status: 'new' };
}

/**
 * 原文字段（title / description / tags / genres）是否含 U+FFFD。同一个 readBody 缺陷
 * 也会写坏这几处的多字节字符（’ — é、中文标签），但原文无从重建：清空只会连剩下的完好
 * 部分一起丢掉，再抓到同一 itemId 也只回填缺失的 genres（saveDramaRecord 去重分支），
 * 不会覆盖。所以只在导入时计数告警，原样保留。
 */
function hasGarbledSourceFields(drama) {
  return [drama.title, drama.description, ...(drama.tags || []), ...(drama.genres || [])]
    .some(value => String(value || '').includes('\uFFFD'));
}

function resetGarbledTranslations() {
  return runOnceDramaMigration('garbledTranslationReset', '乱码译文复位', clearGarbledTranslations,
    count => `已把 ${count} 条乱码译文退回待翻译队列`);
}

/**
 * 存量数据显示标签迁移：历史条目 tags 中的 "RR" 统一改为 "RoyalRoad"。
 * 只碰 tags 显示标签，不碰去重键 itemId 的 rr 前缀。
 * 幂等：无变化时零写入；写回经 storage.onChanged 自动触发 CSV 同步。
 */
function migrateLegacyTags() {
  return mapDramasInQueue('标签迁移', renameLegacyRrTag,
    count => `已迁移 ${count} 条历史记录的显示标签 RR -> RoyalRoad`);
}

/** 逐条：tags 里的 'RR' 改 'RoyalRoad'（去重）；返回原对象表示无需改动。迁移与导入共用。 */
function renameLegacyRrTag(drama) {
  if (!drama || !Array.isArray(drama.tags) || !drama.tags.includes('RR')) return drama;
  const tags = Array.from(new Set(drama.tags.map(tag => (tag === 'RR' ? 'RoyalRoad' : tag))));
  return { ...drama, tags };
}

// 联网迁移（ReelShort 详情页 / Shortical sitemap）单次请求的期限：小于 SW 的 30s 空闲回收
// 阈值——请求挂住期间不调任何扩展 API，SW 可能被回收，下次唤醒又从头卡一遍。超时即抛：
// ReelShort 那条退全集页兜底，Shortical 由 runGuarded 兜住、标记不置位、下轮重试
const MIGRATION_FETCH_TIMEOUT_MS = 20000;

/**
 * 存量 ReelShort 条目 url 一次性迁移到第一集播放页
 * /episodes/episode-1-<slug>-<book_id>-<chapter_id>：章节尾缀必须带（缺失/错误
 * 404），无法凭 book_id 构造，需逐条请求 /movie/ 详情页从 __NEXT_DATA__ 取
 * start_play.chapter_id（online_base[0] 兜底；SW 无 DOMParser，正则截取 JSON）。
 * 请求失败的条目退 /full-episodes/ 全集页兜底。完成后写 rsEpisodeUrlMigrated
 * 标记，此后每次 SW 唤醒零成本跳过——不重试失败条目，避免下架剧每次唤醒都白请求。
 * 网络阶段在单写队列之外进行，只把最终改写入队（不长时间占锁）。
 */
async function migrateReelshortEpisodeUrls() {
  // 标记单独先读：置位后直接返回，不再连带反序列化整张 dramas 表（SW 每次唤醒都走这里）
  const { rsEpisodeUrlMigrated } = await chrome.storage.local.get('rsEpisodeUrlMigrated');
  if (rsEpisodeUrlMigrated) return;
  const { dramas = [] } = await chrome.storage.local.get('dramas');

  const candidates = dramas.filter(drama =>
    typeof drama.url === 'string' && /^https:\/\/www\.reelshort\.com\/(movie|full-episodes)\//.test(drama.url));

  const urlById = new Map();
  for (const drama of candidates) {
    const movieUrl = drama.url.replace('/full-episodes/', '/movie/');
    let nextUrl = movieUrl.replace('/movie/', '/full-episodes/');
    try {
      const response = await fetch(movieUrl, {
        headers: { 'Accept': 'text/html' }, signal: AbortSignal.timeout(MIGRATION_FETCH_TIMEOUT_MS)
      });
      if (response.ok) {
        const html = await response.text();
        const jsonText = (html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) || [])[1];
        const detail = jsonText ? JSON.parse(jsonText)?.props?.pageProps?.data : null;
        const chapterId = String(detail?.start_play?.chapter_id || detail?.online_base?.[0]?.chapter_id || '').trim();
        const canonical = (response.url || movieUrl).split('?')[0];
        const slugId = (canonical.match(/\/movie\/([^/?#]+)/) || [])[1];
        if (chapterId && slugId) nextUrl = `https://www.reelshort.com/episodes/episode-1-${slugId}-${chapterId}`;
      }
    } catch (e) {
      console.warn(`[ShortScraping] ReelShort 播放页迁移请求失败（退全集页兜底）: ${drama.title}`, e.message);
    }
    if (nextUrl !== drama.url) urlById.set(drama.itemId, nextUrl);
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  return enqueueDramaWrite('ReelShort 播放页迁移', async () => {
    const current = await getDramasInQueue();
    let changedCount = 0;
    const migrated = current.map(drama => {
      const nextUrl = urlById.get(drama.itemId);
      if (!nextUrl || drama.url === nextUrl) return drama;
      changedCount++;
      return { ...drama, url: nextUrl };
    });
    if (changedCount > 0) {
      await writeDramasInQueue(migrated, { rsEpisodeUrlMigrated: true });
    } else {
      // flag-only 写不碰 dramas，保持直写、不动缓存
      await chrome.storage.local.set({ rsEpisodeUrlMigrated: true });
    }
    console.log(`[ShortScraping] ReelShort 播放页迁移完成：改写 ${changedCount} 条（候选 ${candidates.length}）`);
  });
}

/**
 * 取 Shortical 规范 slug 表（`slug 基名 → 规范 slug`，基名＝去掉尾部 `-<数字>`）。
 * 解析与 content.js 的 readShorticalCanonicalSlugs 共用 ScrapeRules.parseShorticalSitemap
 * （src/shared/scrape-rules.js）；这里只管取数与失败即抛（runGuarded 兜住、下轮重试）。
 */
async function fetchShorticalCanonicalSlugs() {
  const response = await fetch('https://shortical.com/sitemaps/series.xml', {
    headers: { 'Accept': 'application/xml' }, signal: AbortSignal.timeout(MIGRATION_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Shortical sitemap HTTP ${response.status}`);
  const map = ScrapeRules.parseShorticalSitemap(await response.text());
  // 站点对未命中路径一律回 200＋9KB 空壳，「拿到响应」不等于「拿到 sitemap」
  if (!map.size) throw new Error('Shortical sitemap 里没有 /drama/ 条目');
  return map;
}

/**
 * 存量 Shortical 条目一次性改写到规范 id/url（v1.6.10，2026-09-18 线上实证）。
 *
 * 首页卡片 href 尾段的数字**不是**规范 series id：站点两套 id 并行，详情页只认静态发布
 * 产物那套（SPA 取 `/_seo/drama/<id>.json`，拿不到就渲染 404）。实测库里 18 条有 14 条
 * 封面链接是 404，且同一部剧因 id 漂移被反复当新卡入库（7 对重复）。**再抓取不会自愈**
 * ——新 id 只会再添一条，老条目永远留着，所以必须由本迁移兜。
 *
 * 规范 itemId 撞上另一条时按**先到先得**丢弃较晚的那条（时间线按 scrapedAt 降序存放，
 * 「先到」不是数组里的第一个，必须按时间挑），仅在保留条目 genres 为空时并入被丢弃条目的
 * genres——与 saveDramaRecord 去重命中分支逐字同语义。解析不到规范 slug 的条目原样保留、
 * 不删也不重试（同 rsEpisodeUrlMigrated「不重试失败条目」）。
 *
 * 独立标记 shorticalCanonicalIdsMigrated，理由同 companyFieldDropped——
 * runLegacyDramaMigrations 在存量机器上早已置位，挂进去永远不会执行。
 * 网络阶段在单写队列之外进行，只把最终改写入队。
 */
async function migrateShorticalCanonicalIds() {
  // 标记单独先读：置位后直接返回，不连带反序列化整张 dramas 表（SW 每次唤醒都走这里）
  const { shorticalCanonicalIdsMigrated } = await chrome.storage.local.get('shorticalCanonicalIdsMigrated');
  if (shorticalCanonicalIdsMigrated) return;
  const { dramas = [] } = await chrome.storage.local.get('dramas');
  // 没有 Shortical 条目就直接收口：绝大多数用户走这条路，零网络请求
  if (!dramas.some(drama => drama && drama.source === 'shortical')) {
    await chrome.storage.local.set({ shorticalCanonicalIdsMigrated: true });
    return;
  }

  // 取不到规范表就抛：runGuarded 兜住、标记不置位、下轮唤醒重试。
  // **绝不退回 href 那个号**——那正是本缺陷本身
  const canonical = await fetchShorticalCanonicalSlugs();

  return enqueueDramaWrite('Shortical 规范 id 迁移', async () => {
    const current = await getDramasInQueue();
    const target = new Map();     // 下标 → { itemId, url }
    const groups = new Map();     // 规范 itemId → 下标数组
    let unresolved = 0;

    current.forEach((drama, index) => {
      if (!drama || drama.source !== 'shortical') return;
      const slug = (String(drama.url || '').match(/\/drama\/([^/?#]+)/) || [])[1] || '';
      const canonicalSlug = slug ? canonical.get(slug.replace(/-\d+$/, '')) : '';
      const id = canonicalSlug ? (canonicalSlug.match(/-(\d+)$/) || [])[1] : '';
      if (!id) { unresolved++; return; }
      const itemId = `sc${id}`;
      target.set(index, { itemId, url: `https://shortical.com/drama/${canonicalSlug}` });
      if (!groups.has(itemId)) groups.set(itemId, []);
      groups.get(itemId).push(index);
    });

    const at = value => { const ms = Date.parse(value || ''); return Number.isFinite(ms) ? ms : Infinity; };
    const dropped = new Set();
    const genresFrom = new Map();   // 保留下标 → 被丢弃条目的 genres（仅保留条目为空时启用）
    for (const indexes of groups.values()) {
      if (indexes.length < 2) continue;
      const keep = indexes.reduce((a, b) => (at(current[b].scrapedAt) < at(current[a].scrapedAt) ? b : a));
      for (const index of indexes) {
        if (index === keep) continue;
        dropped.add(index);
        const spare = Array.isArray(current[index].genres) ? current[index].genres : [];
        if (spare.length && !(genresFrom.get(keep) || []).length) genresFrom.set(keep, spare);
      }
    }

    let rewritten = 0;
    const migrated = [];
    current.forEach((drama, index) => {
      if (dropped.has(index)) return;
      const next = target.get(index);
      if (!next) { migrated.push(drama); return; }
      const spare = genresFrom.get(index) || [];
      const fillGenres = spare.length > 0 && !(Array.isArray(drama.genres) && drama.genres.length > 0);
      if (drama.itemId === next.itemId && drama.url === next.url && !fillGenres) { migrated.push(drama); return; }
      rewritten++;
      migrated.push(fillGenres ? { ...drama, ...next, genres: [...spare] } : { ...drama, ...next });
    });

    if (rewritten > 0 || dropped.size > 0) {
      await writeDramasInQueue(migrated, { shorticalCanonicalIdsMigrated: true });
    } else {
      // flag-only 写不碰 dramas，保持直写、不动缓存
      await chrome.storage.local.set({ shorticalCanonicalIdsMigrated: true });
    }
    console.log(`[ShortScraping] Shortical 规范 id 迁移完成：改写 ${rewritten} 条、合并重复 ${dropped.size} 条、解析不到 ${unresolved} 条`);
  });
}

/**
 * 清理 fandom 未映射条目（itemId 为 mdf-/rsf-/smf- 临时键；带连字符，与 md+UUID、
 * rs+hex、sm+数字 的正式键无歧义）：v1.4.8 起内容脚本对映射失败的 fandom 条目不再入库
 * （scrapePage 未映射闸门，下轮抓取自动重试），存量由此处一并清除。
 * 前缀集合与 content.js scrapePage 的未映射闸门共用 ScrapeRules.isUnmappedFandomKey
 * （src/shared/scrape-rules.js，v1.6.9 加 ShortMax 的 smf-）。
 * 幂等：无匹配时零写入；写回经 storage.onChanged 自动触发 CSV 同步。
 */
function pruneUnmappedFandomEntries() {
  return enqueueDramaWrite('fandom 未映射清理', async () => {
    const dramas = await getDramasInQueue();
    const kept = dramas.filter(drama => !ScrapeRules.isUnmappedFandomKey(drama.itemId));

    if (kept.length !== dramas.length) {
      await writeDramasInQueue(kept);
      console.log(`[ShortScraping] 已清理 ${dramas.length - kept.length} 条 fandom 未映射条目`);
    }
  });
}

/**
 * 一次性存量迁移统一入口：完成标记 legacyDramaMigrated 置位后，SW 每次唤醒
 * 零全表读（此前三个函数各自 get 整张 dramas 表、幂等零写但反序列化成本每次都付）。
 * 三个迁移全部成功才置标记，任一失败留待下次唤醒重试。
 * 顺序约束：itemId 更名必须最先（后两者按 itemId 读数）；fandom 清理与 rs 播放页
 * 迁移互不相交（rs 候选按 /movie|full-episodes/ url 过滤，rsf- 临时键条目的 url
 * 是 fandom 文章页），本入口排在 rs 迁移之前属安全重排。
 * 已知行为差（接受）：标记置位后，未来手写 'RR' 标签的新卡不再被改名——
 * migrateLegacyTags 本义即存量迁移，现有抓取路径不会再产生旧形态。
 */
async function runLegacyDramaMigrations() {
  const { legacyDramaMigrated } = await chrome.storage.local.get('legacyDramaMigrated');
  if (legacyDramaMigrated) return;

  await migrateItemIdField();
  await migrateLegacyTags();
  await pruneUnmappedFandomEntries();
  await chrome.storage.local.set({ legacyDramaMigrated: true });
  console.log('[ShortScraping] 一次性存量迁移全部完成，已置完成标记');
}

/**
 * 单页抓取的整页期限。后台等内容脚本的 'scrape' 回复本身不设期限：页面里一个请求挂住
 * （回了响应头、正文迟迟不发完），sendMessage 就永远等不到回复，标签页关不掉，串行的
 * scrapeQueue 后面所有定时 / 手动抓取跟着堵死（审查 no-fetch-timeout-hangs-scrape-queue）。
 * 内容脚本已给每个 fetch 设 25 秒期限，这里再兜一层整页的：正常一页连同详情补抓多在
 * 一两分钟内完成（兜底路径最长 30s 加载等待 + 120s 轮询），5 分钟只拦真正挂死的。
 */
const SCRAPE_PAGE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 在后台打开一个非活动标签页抓取，完成后关闭。超过整页期限按失败抛出（performScrapeOnce
 * 记入该 URL 的失败结果、继续下一个 URL），finally 照常关标签页——内容脚本随页面一起销毁。
 */
async function scrapeUrlInTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  // 超时后败下阵的那条抓取链还在后台跑：标签页关掉后它别再起「强制注入 + 轮询」对着已关的页空转 2 分钟
  const page = { closed: false };
  let timer = null;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`整页抓取超时（${SCRAPE_PAGE_TIMEOUT_MS / 60000} 分钟内未完成），已关闭标签页`));
    }, SCRAPE_PAGE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([scrapeLoadedTab(tab.id, url, page), expired]);
  } finally {
    clearTimeout(timer);
    page.closed = true;
    if (tab.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

async function scrapeLoadedTab(tabId, url, page) {
  try {
    await waitForTabComplete(tabId);
    // 给内容脚本一点注入和页面渲染时间
    await new Promise(resolve => setTimeout(resolve, 1500));
    return await chrome.tabs.sendMessage(tabId, { action: 'scrape' });
  } catch (e) {
    if (page.closed) throw e;
    // 快路径失败的两种实测场景，统一走「强制注入 + 轮询」兜底：
    // 1) 重媒体页（如 reelshort 首页视频横幅）在后台节流标签页里媒体加载不完，
    //    load 永不触发（status 恒 loading），冷缓存时 DOMContentLoaded（即
    //    document_end 注入时机）可晚于 147s → waitForTabComplete 超时；
    // 2) 扩展刚加载完的最初几秒，内容脚本注册未传播到新 renderer，页面正常
    //    complete 但接收端不存在 → 首次 sendMessage 失败。
    // scripting.executeScript 只要文档已提交即可注入（不等 DCL），
    // content.js 自带防重注入护栏，与 manifest 注入并存安全。
    // 兜底只对注册表站点放行：订阅 URL 手改成站外域名、或订阅页跳到了站外（地区跳转 /
    // 同意页）时，manifest 本就不注入，这里也不能借全站 host 权限把 content.js 塞进
    // 任意站点（2026-09-25 审查 host-permissions-overbroad）。订阅 URL 与标签页当前 URL 都要命中
    const pageUrl = await currentTabUrl(tabId, url);
    if (!SiteRegistry.isInjectableUrl(url) || !SiteRegistry.isInjectableUrl(pageUrl)) {
      throw new Error(`${e.message}；页面不属于已支持的站点，不做强制注入: ${pageUrl || url}`);
    }
    console.warn(`[ShortScraping] ${e.message}，强制注入后轮询触发抓取: ${url}`);
    await chrome.scripting.executeScript({
      target: { tabId },
      // 与 manifest content_scripts 的 js 数组保持一致：共享模块先于 content.js
      // （漏一个共享模块＝content.js 在兜底注入路径上直接 ReferenceError，
      //  而这条路径正是后台节流标签页的常态入口。unit-site-registry T4a/T4b 守着）
      files: ['src/shared/site-registry.js', 'src/shared/translate-config.js', 'src/shared/scrape-rules.js', 'src/shared/url-match.js', 'src/content/content.js']
    }).catch(err => console.warn(`[ShortScraping] 强制注入失败（继续轮询）: ${err.message}`));
    return await sendScrapeWhenReady(tabId, 40, 3000, page);
  }
}

/**
 * 取标签页当前 URL，供兜底注入前核对站点归属（订阅页可能已跳转到别的域名）。
 * 读 tab.url 不需要 tabs 权限：http(s) 页面有 host 权限即可见；读到空串（非 http(s)
 * 页面）按不属于任何站点处理。tabs.get 本身失败（标签页已被关掉）时退回订阅 URL
 * 判定——此时注入与轮询本来也会失败，交给后面的正常报错路径。
 */
async function currentTabUrl(tabId, fallbackUrl) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab ? (tab.url || tab.pendingUrl || '') : fallbackUrl;
  } catch (e) {
    return fallbackUrl;
  }
}

/**
 * 轮询向标签页发送抓取消息，直到 content script 就绪（接收端存在）或次数用尽。
 * 仅在 waitForTabComplete 超时后作为兜底路径使用。预算 40×3s=120s：后台节流
 * 标签页冷缓存加载 reelshort 这类重页时，DOMContentLoaded（即 document_end
 * 注入时机）实测可晚于 90s。
 */
async function sendScrapeWhenReady(tabId, attempts = 40, intervalMs = 3000, page = null) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, { action: 'scrape' });
    } catch (e) {
      if (i === attempts - 1 || page?.closed) throw e;
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('标签页加载超时'));
    }, 30000);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * 执行翻译任务。同一时刻只跑一轮：已有轮在跑时直接返回其 promise（join），
 * 后来者的 source 被忽略——可 join 的轮必然非空，终态一定会写。
 * 契约：返回的 promise 从不 reject，错误经 summary.error 传递。
 */
function performTranslate({ source = 'auto' } = {}) {
  if (translateRun) {
    // 手动触发 join 到进行中的轮（可能是不写终态的自动空扫描轮）：
    // 打上等待者标记，让该轮（或紧随其后的下一轮）finally 补写终态。
    if (source === 'manual') translateManualWaiter = true;
    return translateRun;
  }

  // 在第一个 await 之前同步赋值，同 tick 的并发调用不会穿过 null 检查
  translateRun = performTranslateOnce(source).finally(() => {
    translateRun = null;
    // 翻译轮期间 CSV 推送走 8 秒节流，轮末把攒着的那次提前到 500ms 后推出（抓取仍在跑就不动）
    flushCsvSyncAfterBusy();
  });
  return translateRun;
}

// 同一轮内连续这么多次翻译请求失败就提前结束本轮（密钥过期 / 端点挂了 / 额度用尽）：
// 此前每批失败后只等 delayMs 就发下一批，库里 3000 条 new 时每轮白发 300 个必败请求
const TRANSLATE_ABORT_AFTER_FAILURES = 3;

// 服务端审过内容才拒收的状态码（内容审核 data_inspection_failed / 超长 / 不可处理）：
// 错在这条内容本身。其余传输失败（网络 / 超时 / 鉴权 / 额度 / 限流 / 5xx）算通道故障。
const ITEM_LEVEL_TRANSLATE_HTTP_STATUSES = new Set([400, 413, 422]);

function isItemLevelTranslateError(error) {
  return ITEM_LEVEL_TRANSLATE_HTTP_STATUSES.has(Number(error?.status));
}

// 翻译请求期间的 SW 保活间隔：小于 30s 空闲回收阈值
const SW_KEEPALIVE_INTERVAL_MS = 20000;

/**
 * 长请求期间保活 SW，返回停止函数（调用方 finally 里调）。AI 一批实测 9.5~34s、上限 60s
 * （translate-config.js requestTimeoutSec），请求期间 SW 里没有任何扩展 API 调用或事件，心跳
 * 每批结束才写一次；独立的 translate-task 轮 / 手动 🌐 / 单卡 🌍 没有抓取标签页的消息陪跑，
 * 一批超过 30s 就可能被空闲回收：这批作废、整轮中断（审查 sw-long-fetch-termination）。
 * 调一次扩展 API 会重置空闲计时（Chrome 文档给的做法），getPlatformInfo 最轻。
 * 用 setTimeout 递归而非 setInterval：tests/background-fixture.mjs 只桩了 setTimeout。
 */
function startSwKeepAlive() {
  let timer = null;
  let stopped = false;
  const schedule = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      try {
        Promise.resolve(chrome.runtime.getPlatformInfo?.()).catch(() => {});
      } catch (_) {
        // 保活是尽力而为，任何异常都不能打断翻译
      }
      schedule();
    }, SW_KEEPALIVE_INTERVAL_MS);
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * 译文语言守卫：不含汉字的片名/简介译文按空处理（判据复用 TranslateConfig.hasChineseChars，
 * 与 resetNonChineseTitleZh 同口径）。模型把输入原样回显（{"title":"Revenge Bride",…}）时，
 * pickTitleDesc 会回退到 title/desc 键把英文收下，此前照单全收、标 trans 永久定格。
 * 「NBA 2K27」这类合法的无汉字译名随之变成空结果：按失败计次、达上限收口，卡片显示
 * 英文原名，与译名本来的样子一致。其余字段（transportError 等）丢弃，调用方先读再洗。
 */
function keepChineseTranslation(result) {
  const title = String(result?.title || '');
  const desc = String(result?.desc || '');
  return {
    title: TranslateConfig.hasChineseChars(title) ? title : '',
    desc: TranslateConfig.hasChineseChars(desc) ? desc : ''
  };
}

/**
 * 按内容长度把待翻译卡片贪心打包成批（AI 批量翻译用）：
 * 每批最多 maxItems 条，且 title+desc 累计字符超预算就封批；单条超长自成一批。
 * → 短简介多装、长简介少装，天然得到 1..maxItems 条/批，避免长文撑爆单次请求。
 */
function buildTranslateBatches(dramas, maxItems) {
  const CHAR_BUDGET = 4000;
  const batches = [];
  let cur = [];
  let curChars = 0;

  for (const d of dramas) {
    const len = (d.title || '').length + (d.description || '').length;
    if (cur.length > 0 && (cur.length >= maxItems || curChars + len > CHAR_BUDGET)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(d);
    curChars += len;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/**
 * 读取并归一化翻译配置，供调用 Translator 时作尾参注入（translator.js 不再自己读 storage）。
 * 翻译轮每批开头读一次、单卡 🌍 每次读一次：改了密钥 / 端点 / 模型 / 提示词，下一批即生效，
 * 与 translator 此前每次调用自读 storage 的新鲜度一致。
 */
async function readTranslateConfig() {
  const { translateConfig } = await chrome.storage.local.get('translateConfig');
  return TranslateConfig.normalizeConfig(translateConfig);
}

/**
 * 冷缓存下翻译扫描的捷径判据（见冷启动指纹）：只读 dramasStamp / dramasMeta 两个小键，指纹在且
 * pending===0 才返回 true——pending 数的是全表 status==='new'，比翻译扫描「订阅内且 new」的口径更宽，
 * 为 0 时扫描必然为空。只给 SW 冷启动后还没碰过表的那一刻用（dramasCacheFilledOnce），且排进写队列读：
 * 排在已入队的写（如唤醒时的迁移把译文退回 new）之后，读到的是已提交的最新指纹。**只许在队列回调之外调用**。
 * 没有指纹（旧版本写的表 / 版本更新刚清掉）、布局标记显示本地数据已由更新版本升级、缓存已被填上、
 * 或读取出错，一律返回 false，照常读表。
 */
async function noPendingTranslationsByStamp() {
  if (dramasCache !== null || dramasCacheFilledOnce) return false;
  return enqueueDramaWrite('翻译扫描读指纹', async () => {
    if (dramasCache !== null) return false;
    const { dramasStamp, dramasMeta } = await chrome.storage.local.get(['dramasStamp', 'dramasMeta']);
    const layout = Number(dramasMeta?.layout);
    const layoutAhead = Number.isFinite(layout) && layout > DRAMAS_LAYOUT_SUPPORTED;
    return !layoutAhead && validDramasStamp(dramasStamp) && dramasStamp.pending === 0;
  }).catch(() => false);
}

/**
 * 翻译轮实现。运行状态持久化到 translateRunState（弹窗按钮由它驱动）：
 * 非空轮 running:true → 每条进度（兼 SW 保活心跳）→ finally 终态；
 * 空扫描仅手动触发时写一次终态（弹窗等着收尾信号），
 * 定时/抓取后翻译线的空扫描静默，避免收尾期反复触发 onChanged 造成闪烁。
 */
async function performTranslateOnce(source) {
  console.log('[ShortScraping] 开始翻译检查...');

  let pendingCount = 0;
  let processedCount = 0;
  let translatedCount = 0;
  // 「本轮有没有写进任何译文」与「完成了几条」是两件事：半成品（只补到一半、
  // 保持 new 下轮重试）不计完成，但它证明接口是通的，不该触发下面的配置报错
  let progressedCount = 0;
  let runStartedAt = null;
  let runError = null;
  let stateWritten = false;
  let lastError = null;
  let stopKeepAlive = null;
  const writeStats = beginDramasWriteStats();

  try {
    // 冷缓存且指纹说表里没有 new（pending===0）：本轮必是空扫描，直接收工、不为它整表读（见冷启动指纹）。
    // 布局标记显示本地数据已是更新版本的布局时不走捷径，照下面的只读护栏报错
    if (await noPendingTranslationsByStamp()) {
      console.log('[ShortScraping] 没有需要翻译的内容（指纹 pending=0，未读表）');
      return { pendingCount: 0, translatedCount: 0 };
    }
    const { translateConfig, urlTags = [] } = await chrome.storage.local.get(['translateConfig', 'urlTags']);
    // 翻译线每轮扫描：缓存命中零全表读；SW 冷唤醒（缓存为空）时经队列读一次并回填缓存，
    // 随后的 CSV 同步与本轮回填译文都不必再整表读
    const dramas = await readDramasThroughQueue('翻译扫描读表');
    // 前向兼容护栏：本地数据已是更新版本的布局，冻结快照里的 new 可能早被新版本翻过，再翻只是白花钱。
    // 带 error 返回：手动触发时弹窗收到终态报错；自动线按空扫描收尾
    if (dramasLayoutAhead) {
      warnDramasReadOnlyOnce('翻译扫描');
      runError = dramasReadOnlyMessage();
      return { pendingCount: 0, translatedCount: 0, error: runError };
    }
    const config = TranslateConfig.normalizeConfig(translateConfig);
    const configuredDramas = filterDramasByConfiguredUrls(dramas, urlTags);
    const newDramas = configuredDramas.filter(d => d.status === 'new');
    pendingCount = newDramas.length;

    if (newDramas.length === 0) {
      console.log('[ShortScraping] 没有需要翻译的内容');
      return { pendingCount: 0, translatedCount: 0 };
    }

    console.log(`[ShortScraping] 发现 ${newDramas.length} 条待翻译`);

    runStartedAt = Date.now();
    stateWritten = true;
    await writeTranslateRunState({
      running: true,
      startedAt: runStartedAt,
      updatedAt: runStartedAt,
      pendingCount,
      processedCount: 0,
      translatedCount: 0
    });
    // 只保活非空轮（空扫描不发请求）；finally 停止
    stopKeepAlive = startSwKeepAlive();

    // 翻译每条记录。注意：抓取线可能正在并行写入新卡片，
    // 所以不能在这里把开头读取到的 dramas 快照整体写回，否则会覆盖抓取线新增内容。
    const heartbeat = () => writeTranslateRunState({
      running: true,
      startedAt: runStartedAt,
      updatedAt: Date.now(),
      pendingCount,
      processedCount,
      translatedCount
    });

    // 请求失败的归因与熔断。「失败」＝某条的最后一次尝试没拿到任何译文。取舍：只有错在
    // 这条自己才计 translateAttempts，全局问题一律不计（接口恢复 / 配置改对后照常翻）：
    //   · 通道故障（网络 / 超时 / 鉴权 / 额度 / 限流 / 5xx、API 模式的 transportError）从不计。
    //     抓取后翻译线约 1 秒一轮，若照计，几秒的断网就能把整库待翻译卡烧满额度、以未翻译
    //     状态收口 trans（单卡 🌍 同理不计，见 handleTranslateSingle / unit-translate-single S7b、S8b）；
    //   · 条目级拒收（ITEM_LEVEL_TRANSLATE_HTTP_STATUSES，只认只含这一条的请求）与「应答了
    //     却没给出这条的译文」先暂记、轮末定夺：本轮有别的条目翻成功（接口和模型都正常）→
    //     落账；一条都没翻成时，只剩一两条的（库里落单的毒条目 / 片名「1923」）落账，更多就
    //     更像提示词或模型的全局问题，作废；
    //   · 连败熔断：同轮连续 TRANSLATE_ABORT_AFTER_FAILURES 次失败（传输失败，或整批失败后
    //     拆出的单条仍没译文）即结束本轮；本轮还一条都没翻成时，这条连败链上暂记的作废（密钥
    //     失效之外，模型名填错这类全局 400、提示词让模型整体答非所问，也长这样）。会被拆单条
    //     重试的整批失败不计入连败；
    //   · 本轮已有条目翻成功（progressedCount>0，接口、模型、提示词都正常）之后：拆出的单条
    //     「应答了却没给出译文」只能是这条自己的问题，直接暂记、不计入连败；请求级失败（单条
    //     400 等）仍计入连败以兜住中途变成全局 400 的请求风暴，但熔断时链上暂记的照常落账。
    //     旧卡排在库尾，几条毒条目会自成一批：若照样连败 3 次就熔断作废，它们每轮都在熔断里
    //     作废、永远收不了口，每轮还报错停掉抓取后翻译线。
    let failStreak = 0;
    let streakFailures = []; // 当前连败链上暂记的失败：链被翻成功的条目打断才转入 failures，熔断时本轮无进展则作废
    const failures = [];     // 与连败链无关（或已被打断确认）的暂记失败，轮末统一定夺
    let aborted = false;

    // 记一次失败（不写库）。attributable：错在这条自己，暂记待轮末定夺；streak：计入连败
    const noteFailure = (dramasInRequest, { attributable, streak }) => {
      processedCount += dramasInRequest.length;
      if (attributable) (streak ? streakFailures : failures).push(...dramasInRequest);
      if (!streak) return;
      failStreak++;
      if (failStreak >= TRANSLATE_ABORT_AFTER_FAILURES) {
        aborted = true;
        if (progressedCount > 0) failures.push(...streakFailures);
        streakFailures = [];
        console.warn(`[ShortScraping] 连续 ${failStreak} 次翻译请求失败（密钥失效或接口不可用？），本轮提前结束: ${lastError || '模型未给出译文'}`);
      }
    };

    const requestFailed = (error, dramasInRequest) => {
      lastError = error?.message || String(error);
      const attributable = dramasInRequest.length === 1 && isItemLevelTranslateError(error);
      if (!attributable) console.warn(`[ShortScraping] 翻译请求失败（通道故障，不计重试次数）: ${lastError}`);
      noteFailure(dramasInRequest, { attributable, streak: true });
    };

    // 回填一条翻译结果并计进度：按 drama.id 精确定位，不依赖数组顺序（批量保对应的锚点）
    //
    // 完成判据（「该翻的都翻出来了」）在写队列内按合并后的记录统一计算（mergeTranslation，
    // 逐条 / 整批两条落库路径共用）：只回一半的留 status='new' 下轮补另一半（updated=false），
    // 不再像此前那样一律标 trans 把半成品永久定格。
    //
    // 调用前提：这条的请求拿到了应答。空结果＝服务答了却没给出这条的译文（漏 id / 回显
    // 英文被语言守卫洗掉 / 译文与原文相同被滤掉），暂记为失败；有译文则打断连败链。
    //
    // commit：落库这一步，返回 { done, becameTrans }。缺省逐条落库（拆单重试 / API 模式）；AI 成功批传入
    // 整批落库的那一份（updateBatchDramaTranslations，见下方批量分支），记账、计数与推群照旧逐条走
    const hasTranslation = result => Boolean(result?.title || result?.desc);
    const applyOne = async (drama, result, commit = () => updateSingleDramaTranslation(drama.id, result, { fillOnly: true })) => {
      if (!hasTranslation(result)) {
        noteFailure([drama], { attributable: true, streak: false });
        return;
      }
      failStreak = 0;
      failures.push(...streakFailures);
      streakFailures = [];

      const { done: updated, becameTrans } = await commit();
      progressedCount++;
      if (updated) {
        translatedCount++;
        // 触发点①：翻完一条即推（队列外，失败只记日志）。读回落库后的那条，
        // 卡片里才有刚写进去的译文。只在本次把它翻成 trans 时推：请求在飞期间 🌍 抢先
        // 翻完（已由触发点③推过），这里 fillOnly 落库照样算完成，但不再推第二次
        if (becameTrans) {
          const saved = (await getDramasSnapshot()).find(d => d.id === drama.id);
          await maybeBotPush(saved);
        }
      } else {
        console.warn(`[ShortScraping] 翻译只补到一半，保持待翻译状态下轮重试: ${drama.title}`);
      }
      processedCount++;
    };

    // 失败落账：在写队列内也累加 translateAttempts，达 MAX_PARTIAL_TRANSLATE_ATTEMPTS 与
    // 半成品同口径收口（status='trans'、写 translatedAt、清计数，已有的译文保留），离开待翻译
    // 集合，翻译线才能等到 pendingCount 归零收尾。此前空结果 / 整批失败都不计次：毒条目
    // 连同同批邻居永久卡在 new，每次抓取后翻译线都白跑满轮。收口的卡照常过触发点①（与
    // 半成品收口一致，否则它永远不会被推群），但不计入 translatedCount——它一个字都没翻出来。
    const recordTranslateFailure = async (drama) => {
      const { done, becameTrans } = await updateSingleDramaTranslation(drama.id, { title: '', desc: '' }, { fillOnly: true });
      if (done) {
        console.warn(`[ShortScraping] 连续 ${MAX_PARTIAL_TRANSLATE_ATTEMPTS} 次没拿到译文，收口不再重试: ${drama.title}`);
        if (becameTrans) {
          const saved = (await getDramasSnapshot()).find(d => d.id === drama.id);
          await maybeBotPush(saved);
        }
      } else {
        console.warn(`[ShortScraping] 翻译结果为空，保持待翻译状态下轮重试: ${drama.title}`);
      }
    };

    const pause = () => new Promise(r => setTimeout(r, config.delayMs ?? 200));
    const toItem = d => ({ title: d.title, desc: d.description });

    const mode = config.translateMode;

    // 每批开头重读一次配置、作尾参传给 Translator（见 readTranslateConfig）。读到的模式与本轮
    // 开头选定的不同就提前结束本轮：分批、拆单重试、传输失败的归因都按本轮模式搭好了，剩下的
    // 留给下一轮按新模式重扫。此前 translator 每次调用自读 storage，中途改成 API 模式时，AI
    // 分支里的 translateBatchAI 会落进它自己的逐条分支，与这一轮的分支对不上
    let modeChanged = false;
    const readBatchConfig = async () => {
      const latest = await readTranslateConfig();
      if (latest.translateMode === mode) return latest;
      modeChanged = true;
      console.warn(`[ShortScraping] 翻译模式在本轮中途改成了 ${latest.translateMode}，本轮提前结束，剩下的下一轮按新模式翻译`);
      return null;
    };

    if (mode === 'ai') {
      // AI 模式：按内容长度动态打包（1–10 条/批），一次请求译多条，明显减少请求数
      const maxItems = Math.min(10, Math.max(1, Number(config.batchSize) || 10));
      const batches = buildTranslateBatches(newDramas, maxItems);
      console.log(`[ShortScraping] AI 批量翻译：${newDramas.length} 条分 ${batches.length} 批（每批≤${maxItems}）`);

      for (const chunk of batches) {
        if (aborted) break;
        const batchConfig = await readBatchConfig();
        if (!batchConfig) break;
        let results = null;
        let batchError = null;
        try {
          results = (await Translator.translateBatchAI(chunk.map(toItem), batchConfig)).map(keepChineseTranslation);
        } catch (e) {
          batchError = e;
        }

        // 整批失败（请求抛错，或应答了但一条都没给出）且不止一条：同轮拆成单条各重试一次。
        // 一条触发内容审核的简介（HTTP 400）或让模型整批拒答的条目，不再拖着同批最多 9 个
        // 邻居每轮陪跑——分批按数组顺序确定，不拆的话它们下轮还会被分在一起
        const wholeBatchFailed = batchError || results.every(r => !r.title && !r.desc);
        if (chunk.length > 1 && wholeBatchFailed) {
          if (batchError) lastError = batchError.message || String(batchError);
          console.warn(`[ShortScraping] 批量翻译整批${batchError ? `失败（${lastError}）` : '无译文'}，拆成 ${chunk.length} 条逐条重试`);
          for (const drama of chunk) {
            if (aborted) break;
            try {
              const [single] = await Translator.translateBatchAI([toItem(drama)], batchConfig);
              const result = keepChineseTranslation(single);
              if (result.title || result.desc) {
                await applyOne(drama, result);
              } else {
                // 本轮已有进展＝提示词与模型正常，单条仍没译文只能怪这条自己：不计入连败（见上方取舍）
                noteFailure([drama], { attributable: true, streak: progressedCount === 0 });
              }
            } catch (e) {
              requestFailed(e, [drama]);
            }
            heartbeat();
            await pause();
          }
          continue;
        }

        if (batchError) {
          console.warn('[ShortScraping] 批量翻译异常:', batchError);
          requestFailed(batchError, chunk);
        } else {
          // 按批内下标 j 取 results[j]（translateBatchAI 保证等长、同序，缺失填空串）。
          // 拿到译文的条目合成一次队列操作整批落库（一次整表写，而不是每条一次），仍按批内顺序逐条走
          // applyOne：失败暂记、连败链打断、计数与触发点①推群的先后都与逐条落库时一致。整批写在第一条
          // 有译文的条目走到落库那一步时才发出——与逐条写时第一次落库同一时点（排在它前面的空结果已照旧
          // 暂记），写失败就在这里抛出，同逐条写时第一条就写失败；后面各条直接取这一次的结果
          const batchResults = chunk.map((_, j) => results[j] || { title: '', desc: '' });
          const slotOf = new Map();
          const entries = [];
          chunk.forEach((drama, j) => {
            if (!hasTranslation(batchResults[j])) return;
            slotOf.set(j, entries.length);
            entries.push({ dramaId: drama.id, result: batchResults[j] });
          });
          let batchWrite = null;
          const commitFromBatch = j => async () => {
            if (!batchWrite) batchWrite = updateBatchDramaTranslations(entries, { fillOnly: true });
            return (await batchWrite)[slotOf.get(j)];
          };
          for (let j = 0; j < chunk.length; j++) {
            await applyOne(chunk[j], batchResults[j], commitFromBatch(j));
          }
        }

        // 一批一次心跳；不 await，同上下文 storage 写按序落库
        heartbeat();

        // 批间延迟避免接口限流
        await pause();
      }
    } else {
      // API 模式（MyMemory 等）无批量端点，保持逐条翻译
      for (const drama of newDramas) {
        if (aborted) break;
        const batchConfig = await readBatchConfig(); // 逐条翻译，一条即一批
        if (!batchConfig) break;
        let raw;
        try {
          raw = await Translator.translateTitleAndDesc(drama.title, drama.description, batchConfig);
        } catch (e) {
          console.warn(`[ShortScraping] 翻译失败: ${drama.title}`, e);
          raw = { title: '', desc: '', transportError: e?.message || String(e) };
        }
        const result = keepChineseTranslation(raw);
        if (!result.title && !result.desc && raw?.transportError) {
          // 一个字段都没拿到且请求在传输层失败：通道故障，不计次数
          requestFailed(new Error(raw.transportError), [drama]);
        } else {
          await applyOne(drama, result);
        }
        heartbeat();
        await pause();
      }
    }

    // 轮末定夺暂记的失败（见上方「请求失败的归因与熔断」）
    if (!aborted) failures.push(...streakFailures);
    if (progressedCount > 0 || failures.length < TRANSLATE_ABORT_AFTER_FAILURES) {
      for (const drama of failures) await recordTranslateFailure(drama);
    } else {
      console.warn(`[ShortScraping] 本轮一条都没翻成、却有 ${failures.length} 条没拿到译文，更像接口或提示词的全局问题，不计重试次数`);
    }

    console.log(`[ShortScraping] 翻译完成: ${translatedCount}/${newDramas.length}`);

    if (translatedCount > 0) {
      showNotification(`已翻译 ${translatedCount} 部短剧`);
    }

    // 熔断提前结束：哪怕前面几批翻成了，剩下的也没翻，照样报错；aborted 供抓取后翻译线
    // 停线（接口不可用时每秒再起一轮只会重复撞墙）
    if (aborted) {
      runError = `连续 ${TRANSLATE_ABORT_AFTER_FAILURES} 次翻译请求失败，本轮提前结束：${lastError || '模型未给出译文'}`;
      return { pendingCount, translatedCount, error: runError, aborted: true };
    }

    // 第一批开头就读到模式变了、一条都还没试：不是接口或配置出错，不报下面的「检查配置」，
    // 待翻译的留给下一轮（抓取后翻译线照常起下一轮）
    if (modeChanged && processedCount === 0) {
      return { pendingCount, translatedCount };
    }

    // 有待翻译却一条译文都没写进去＝接口/配置有问题：把错误写进 summary，
    // 弹窗据此显示 ❌ 而不是误导性的 ✅「成功翻译 0 条」。判据用 progressedCount
    // 而非 translatedCount——只补到一半也说明接口是通的，报「检查配置」会误导。
    if (progressedCount === 0 && pendingCount > 0) {
      runError = lastError || '本轮没有任何条目翻译成功，请检查 config/trans.json 的接口配置';
      return { pendingCount, translatedCount, error: runError };
    }

    return { pendingCount, translatedCount };
  } catch (e) {
    console.error('[ShortScraping] 翻译任务失败:', e);
    runError = e.message;
    return { pendingCount: pendingCount || null, translatedCount, error: e.message };
  } finally {
    stopKeepAlive?.();
    endDramasWriteStats(writeStats, '翻译轮');
    // 终态写进 finally，封死中途意外 throw 留下孤儿 running:true 的口。
    // translateManualWaiter：手动触发 join 到本轮（自动空扫描不写终态）时，
    // 也必须写终态给弹窗收尾；标记消费后复位。
    if (stateWritten || source === 'manual' || translateManualWaiter) {
      const now = Date.now();
      writeTranslateRunState({
        running: false,
        startedAt: runStartedAt,
        updatedAt: now,
        finishedAt: now,
        pendingCount,
        processedCount,
        translatedCount,
        summary: {
          pendingCount,
          processedCount,
          translatedCount,
          ...(runError ? { error: runError } : {})
        }
      });
    }
    translateManualWaiter = false;
  }
}

// 半成品重试上限：模型偶发只回简介不回片名，留 status='new' 下轮补；连续这么多轮
// 仍补不齐就收口，避免个别条目每轮白烧一次 API（v1.5.14）
const MAX_PARTIAL_TRANSLATE_ATTEMPTS = 3;

/**
 * 更新单条翻译结果。读改写在单写者队列内执行，不会覆盖并行提交的新卡片。
 *
 * options.fillOnly（批量翻译线用）：只补空缺，绝不覆盖既有译文——保护 Steam
 * 官方中文这类平台自带译名，也让「半成品下轮补另一半」不会把上轮成果冲掉。
 * 弹窗单卡 🌍 重译（translateSingle）不传该选项，仍是新结果优先（重译的语义就是要覆盖）。
 *
 * 完成判据＝「该翻的都翻出来了」，在队列内按**合并后的记录**统一计算：标题非空须有
 * titleZh，简介非空须有 descriptionZh（既有值也算数）。没翻全的半成品**保持 status='new'**
 * 让下一轮继续补、translateAttempts 累加，达上限才收口。此前无论多残缺都直接标 trans，
 * 导致「有简介无标题」的条目被永久定格、再也不进翻译队列（全库实测 660 条这样卡死）。
 * 三个写入口（批量线逐条 / 批量线整批 / translateSingle）共用 mergeTranslation 这一份判据，不由调用方各算。
 * 返回 { done, becameTrans }：done＝是否收口为 trans（半成品 / 卡片不存在为 false）；
 * becameTrans＝本次写入把它从非 trans 翻成 trans——群机器人只在这一刻推（见 Lark 群机器人段
 * 头注释）。在队列内按当前记录判定，批量线与 🌍 同时翻同一张卡时只有先落库的那一方为 true。
 */
function updateSingleDramaTranslation(dramaId, result, options = {}) {
  return enqueueDramaWrite('翻译更新', async () => {
    const dramas = await getDramasInQueue();
    const index = dramas.findIndex(d => d.id === dramaId);

    if (index === -1) return { done: false, becameTrans: false };

    const { record, done, becameTrans } = mergeTranslation(dramas[index], result, options);
    // copy-on-write：缓存数组只读，不就地突变（快照读者可能正持有旧引用）
    const next = dramas.slice();
    next[index] = record;

    await writeDramasInQueue(next);
    return { done, becameTrans };
  });
}

/**
 * 一条翻译结果合并进一条记录（纯函数：不读写 storage、不碰队列，不改动 current）。字段规则见
 * updateSingleDramaTranslation 的注释：fillOnly 只补空缺；完成判据按合并后的记录算；没翻全的
 * 保持 new、translateAttempts 累加，达 MAX_PARTIAL_TRANSLATE_ATTEMPTS 收口 trans；收口写
 * translatedAt、清计数。options.now（ISO 串）给整批共用一个落库时刻，缺省取当前时间。
 * 返回 { record, done, becameTrans }，record 是新对象。
 */
function mergeTranslation(current, result, options = {}) {
  const titleZh = options.fillOnly
    ? (current.titleZh || result.title || '')
    : (result.title || current.titleZh);
  const descriptionZh = options.fillOnly
    ? (current.descriptionZh || result.desc || '')
    : (result.desc || current.descriptionZh);

  const needTitle = Boolean(String(current.title || '').trim());
  const needDesc = Boolean(String(current.description || '').trim());
  const complete = (!needTitle || Boolean(titleZh)) && (!needDesc || Boolean(descriptionZh));
  const attempts = complete ? 0 : (Number(current.translateAttempts) || 0) + 1;
  const done = complete || attempts >= MAX_PARTIAL_TRANSLATE_ATTEMPTS;

  const record = { ...current, titleZh, descriptionZh, status: done ? 'trans' : 'new' };
  if (done) {
    record.translatedAt = options.now || new Date().toISOString();
    delete record.translateAttempts;
  } else {
    record.translateAttempts = attempts;
  }
  return { record, done, becameTrans: done && current.status !== 'trans' };
}

/**
 * AI 成功批的整批回填（v1.6.22）：一批里拿到译文的条目在**一次**队列操作里逐条 mergeTranslation、
 * 只写一次整表（一次 set、换一个 dramasStamp）。此前每条各排一次队列、各写一次整表，一批最多 10 次
 * 数 MB 的 set，每次还各触发一轮 onChanged → CSV 调度。
 * entries：[{ dramaId, result }]，按批内顺序；返回等长数组，每项同 updateSingleDramaTranslation 的
 * { done, becameTrans }（卡片不存在为 false/false）。与逐条写逐项等价：各条按顺序合并在上一条合并后的
 * 表上（同一 id 出现两次时第二次看到第一次的结果），becameTrans 同样在队列内按当前记录判定——🌍 抢先
 * 落库的卡这里 fillOnly 照样算完成，但 becameTrans 为 false。一条都没找到（卡已被删）时不写。
 * 记账、计数、推群不在这里：调用方拿返回值按批内顺序逐条走原来的流程（见 performTranslateOnce）。
 */
function updateBatchDramaTranslations(entries, options = {}) {
  return enqueueDramaWrite('翻译整批更新', async () => {
    const dramas = await getDramasInQueue();
    const indexById = new Map();
    dramas.forEach((d, i) => { if (!indexById.has(d.id)) indexById.set(d.id, i); }); // 同 findIndex：取第一条
    const mergeOptions = { ...options, now: new Date().toISOString() };
    let next = null;
    const outcomes = entries.map(({ dramaId, result }) => {
      const index = indexById.get(dramaId);
      if (index === undefined) return { done: false, becameTrans: false };
      if (!next) next = dramas.slice(); // copy-on-write，同 updateSingleDramaTranslation
      const { record, done, becameTrans } = mergeTranslation(next[index], result, mergeOptions);
      next[index] = record;
      return { done, becameTrans };
    });
    if (next) await writeDramasInQueue(next);
    return outcomes;
  });
}

/**
 * 弹窗单卡 🌍 翻译（translateSingle 消息）：请求在 SW 内发起——弹窗一关页面即销毁，
 * 页内 fetch 随之中断，与 larkPush 走后台同理。消息只带 dramaId、按 id 从 storage
 * 取卡，不信任调用方传对象。落库复用 updateSingleDramaTranslation：不传 fillOnly
 * （重译的语义就是要覆盖），完成判据与批量线同口径——该翻的没翻全保持 status='new'、
 * translateAttempts 累加、达上限收口。空结果 / 接口异常一律 success:false 回传文案，
 * 卡片原样不动（与批量线「没回内容不写记录」一致）。
 *
 * 触发点③：本次把卡从 new 翻成 trans（becameTrans）时推群——新卡被 🌍 抢在批量线之前翻完后，
 * 批量线扫不到它，此前这张卡永远不会推。重译本来就是 trans 的卡不推。推送不 await：
 * 弹窗 ⏳ 不等飞书应答（与触发点② saveDrama 同款旁路），maybeBotPush 自身不会 reject。
 */
async function handleTranslateSingle(dramaId) {
  const drama = (await getDramasSnapshot()).find(d => d.id === dramaId);
  if (!drama) {
    return { success: false, error: '未找到该卡片数据' };
  }
  // 前向兼容护栏：只读模式下回填必被拒写，先拦下，别白发一次付费翻译请求
  if (dramasLayoutAhead) {
    return { success: false, error: dramasReadOnlyMessage() };
  }

  // 单卡请求最长也要等满 requestTimeoutSec（默认 60s），同批量线一样保活
  const stopKeepAlive = startSwKeepAlive();
  try {
    // 配置每次现读（translator 不再自己读 storage）：设置页刚改的密钥 / 模式，下一次 🌍 即生效
    const config = await readTranslateConfig();
    // 语言守卫与批量线同口径：模型回显英文不得覆盖既有中文译名
    const result = keepChineseTranslation(await Translator.translateTitleAndDesc(drama.title, drama.description, config));
    if (!result.title && !result.desc) {
      return { success: false, error: '翻译结果为空，请检查翻译接口配置或控制台错误' };
    }

    const { done, becameTrans } = await updateSingleDramaTranslation(dramaId, result);
    console.log(`[ShortScraping] 单卡翻译${done ? '完成' : '只补到一半'}: ${drama.title}`);
    if (becameTrans) {
      getDramasSnapshot()
        .then(dramas => maybeBotPush(dramas.find(d => d.id === dramaId)))
        .catch(e => console.warn('[ShortScraping] 群机器人推送流程异常（不影响翻译）:', e?.message || e));
    }
    return { success: true, complete: done };
  } catch (e) {
    console.warn('[ShortScraping] 单卡翻译失败:', e.message);
    return { success: false, error: e.message };
  } finally {
    stopKeepAlive();
  }
}

/**
 * 保存一张新卡（内容脚本经 saveDrama 消息提交）。去重键 itemId 的权威判定
 * 在队列内完成，两个标签页并发抓到同一条也只会入库一次。
 */
function saveDramaRecord(drama) {
  return enqueueDramaWrite('保存新卡', async () => {
    const existing = await getDramasInQueue();

    const index = existing.findIndex(d => d.itemId === drama.itemId);
    if (index !== -1) {
      // genres 回填（v1.5.3）：仅「库中缺、本次有」才补写这一个键，其余字段一律
      // 不动（先到先得/翻译状态/scrapedAt 语义不变）；写时不带 lastScrape（回填
      // 不是新卡）。权威判定在队列内：并发第二个到达者在此看到已有 → 不写，幂等。
      // 清洗与采集侧同口径（ScrapeRules.cleanGenres：trim/去空/去重，非数组当空）
      const incoming = ScrapeRules.cleanGenres(drama.genres);
      const current = existing[index];
      const currentHas = Array.isArray(current.genres) && current.genres.length > 0;
      if (incoming.length > 0 && !currentHas) {
        const next = existing.slice();   // copy-on-write：队列缓存数组只读
        next[index] = { ...current, genres: incoming };
        await writeDramasInQueue(next);
      }
      return false;
    }

    // savedAt＝入库时刻，只在这里（新卡首次入库）写，库里已有的卡不动、导入恢复也不写：
    // 多维表格增量导出按 savedAt || scrapedAt 比水位线（Lark.exportStamp）。scrapedAt 是内容
    // 脚本提取列表时定的，要等详情补抓完才入库，复制恰好落在这几秒里的卡会被水位线永久挡掉。
    // 调用方传来的 savedAt 一律覆盖（内容脚本不写该字段，不信任外来值）
    const savedAt = new Date().toISOString();
    await writeDramasInQueue([{ ...drama, savedAt }, ...existing], { lastScrape: savedAt });
    return true;
  });
}

/**
 * 清空 dramas 表（仅安装初始化使用；弹窗「清除数据」入口已移除）。
 * 刻意不写 allowEmptySync：重装 / 新 profile 时同步服务上那份时间线正是要保护的对象，
 * 空库推送护栏见 syncTimelineToCsv。
 */
function clearAllDramas() {
  return enqueueDramaWrite('清空数据', () => writeDramasInQueue([], { lastScrape: null }));
}

/**
 * 数据存档·导入恢复（设置页 importDramas 消息）：按 itemId 合并去重——已存在
 * 即跳过、不覆盖不做字段级补全（库内 new 条目翻译线会自愈补译；覆盖方向不可判定）。
 * 订阅范围外的条目在入口过滤并计入 outOfScope：SW 每次唤醒的
 * pruneDramasOutsideConfiguredUrls 会把界外条目静默删除，放进去也活不过下轮。
 * 合并后整表按 scrapedAt 降序重排（缺失排尾）——时间线渲染按数组序分组，
 * 单纯头插会让老条目挂在顶部日期组之后错乱；对头插维持的现库近似 no-op。
 *
 * 一次性迁移都挂着完成标记，导入时不会重跑，旧备份会把修复前的旧形态原样带回来、且永远
 * 不再被修（审查 import-bypasses-oneshot-migrations）。所以导入时补上能逐条安全判定的几道：
 * fandom 未映射临时键跳过（计入 invalid）、'RR' 标签改名、非中文译名与乱码译文退回重译；
 * 要联网的 Shortical 规范 id 迁移则在导入了 Shortical 条目时清掉完成标记，下次唤醒重跑
 * （按最早 scrapedAt 合并重复，幂等；setupAlarms 已排在迁移链之前、sitemap 请求有期限）。
 * 刻意不做：半成品 trans 复位（分不清是旧形态还是连续失败的合法收口，重置会多烧 API、
 * 收口时还会再推群）；ReelShort 标记重置（/movie/ 链接可用，重跑要逐条联网）。
 */
function importDramaRecords(rawDramas) {
  if (!Array.isArray(rawDramas)) {
    return Promise.reject(new Error('备份文件内容不是条目数组'));
  }
  if (rawDramas.length > 100000) {
    return Promise.reject(new Error(`条目数超出上限（${rawDramas.length} > 100000）`));
  }

  // 纯校验不依赖库内数据，先做完再进写队列：上限 10 万条的类型/日期/链接检查
  // 独占 dramas 写队列，会让同期的抓取保存与翻译回写一直排队等待
  const candidates = [];
  let invalid = 0;
  for (const raw of rawDramas) {
    const normalized = TimelineCsv.validateImportDrama(raw);
    if (!normalized || (normalized.source && !SiteRegistry.CATEGORY_SOURCES.includes(normalized.source))) { invalid++; continue; }
    // fandom 映射失败的临时键（mdf-/rsf-/smf-）：v1.4.8 起不入库、存量已由迁移清掉
    if (ScrapeRules.isUnmappedFandomKey(normalized.itemId)) { invalid++; continue; }
    normalized.source ||= 'imdb'; // source 字段出现前只有 IMDB，缺失即按历史归属
    candidates.push(normalized);
  }

  return enqueueDramaWrite('导入恢复', async () => {
    const existing = await getDramasInQueue();
    const { urlTags = [] } = await chrome.storage.local.get('urlTags');
    const configuredSet = UrlMatch.buildConfiguredUrlSet(getConfiguredScrapeUrls(urlTags));

    const seenItemIds = new Set(existing.map(d => d.itemId));
    const seenIds = new Set(existing.map(d => d.id));
    const added = [];
    const garbledSourceIds = [];
    let outOfScope = 0;
    let duplicates = 0;

    for (const normalized of candidates) {
      if (!UrlMatch.isUrlCovered(normalized.sourceListUrl, configuredSet)) { outOfScope++; continue; }
      if (seenItemIds.has(normalized.itemId)) { duplicates++; continue; } // 含备份文件内自重

      // status 白名单：非 new/trans 的怪值按「有中文标题＝已翻译」推断
      if (normalized.status !== 'new' && normalized.status !== 'trans') {
        normalized.status = normalized.titleZh ? 'trans' : 'new';
      }
      // id 缺失或与现表撞车时改写（id 是卡片操作句柄，不能重复）
      if (!normalized.id || seenIds.has(normalized.id)) {
        const baseId = `import_${normalized.itemId}`;
        normalized.id = baseId;
        for (let suffix = 1; seenIds.has(normalized.id); suffix++) normalized.id = `${baseId}_${suffix}`;
      }
      seenItemIds.add(normalized.itemId);
      seenIds.add(normalized.id);
      if (hasGarbledSourceFields(normalized)) garbledSourceIds.push(normalized.itemId);
      // 与对应一次性迁移共用逐条函数：旧标签改名、非中文 / 乱码译文退回重译
      added.push(clearGarbledTranslations(resetNonChineseTitle(renameLegacyRrTag(normalized))));
    }

    if (garbledSourceIds.length > 0) {
      console.warn(`[ShortScraping] 导入的 ${garbledSourceIds.length} 条原文含乱码字符（U+FFFD），已原样保留:`,
        garbledSourceIds.slice(0, 20).join(', ') + (garbledSourceIds.length > 20 ? ' …' : ''));
    }

    if (added.length > 0) {
      const merged = existing.concat(added);
      merged.sort((a, b) => {
        const ta = a.scrapedAt || '';
        const tb = b.scrapedAt || '';
        return tb < ta ? -1 : tb > ta ? 1 : 0; // ISO 串字典序＝时间序，降序，空串排尾
      });
      // 旧备份里的 Shortical 条目可能还是 href 号那套非规范 id（与库里的规范 id 不相等，会作为
      // 新卡加入）：与写表同一次 set 清掉完成标记，下次唤醒重跑规范 id 迁移
      const extra = added.some(drama => drama.source === 'shortical') ? { shorticalCanonicalIdsMigrated: false } : {};
      await writeDramasInQueue(merged, extra);
    }

    return {
      added: added.length, duplicates, outOfScope, invalid, total: rawDramas.length,
      garbledSourceCount: garbledSourceIds.length
    };
  });
}

/**
 * 数据存档·按条件清理（设置页 pruneDramas 消息）：站点多选 + 可选「早于某时刻」。
 * dryRun 与真删共用谓词并进入队列，预览令牌绑定条件及命中集合；范围变化拒绝删除。
 * 无 scrapedAt 的条目在带日期条件时保守不命中（只按站点清理时照常命中）。
 */
function pruneDramaRecords({ sites, beforeIso, dryRun = false, previewToken } = {}) {
  if (!Array.isArray(sites) || sites.length === 0) {
    return Promise.reject(new Error('未指定要清理的站点'));
  }
  const invalidSite = sites.find(site => !SiteRegistry.CATEGORY_SOURCES.includes(site));
  if (invalidSite) {
    return Promise.reject(new Error(`未知站点：${invalidSite}`));
  }
  const beforeMs = beforeIso ? Date.parse(beforeIso) : null;
  if (beforeIso && Number.isNaN(beforeMs)) {
    return Promise.reject(new Error(`无法解析日期：${beforeIso}`));
  }

  const siteSet = new Set(sites);
  const matches = (drama) => {
    if (!siteSet.has(drama.source)) return false;
    if (beforeMs === null) return true;
    if (!drama.scrapedAt) return false;
    return Date.parse(drama.scrapedAt) < beforeMs;
  };

  return enqueueDramaWrite(dryRun ? '清理预览' : '条件清理', async () => {
    const dramas = await getDramasInQueue();
    const perSite = {};
    let matched = 0;
    const kept = [];
    const matchedKeys = [];

    for (const drama of dramas) {
      if (matches(drama)) {
        matched++;
        matchedKeys.push(JSON.stringify([drama.id, drama.itemId, drama.source, drama.scrapedAt]));
        perSite[drama.source] = (perSite[drama.source] || 0) + 1;
      } else {
        kept.push(drama);
      }
    }

    // 无服务端临时状态：绑定条件与命中集合，SW 重启仍可验证；同数量换卡也会失效。
    const signature = JSON.stringify([[...siteSet].sort(), beforeMs, matchedKeys.sort()]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature));
    const currentToken = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (!dryRun && previewToken !== currentToken) throw new Error('清理范围已变化或尚未预览，请重新预览后确认');
    if (!dryRun && matched > 0) {
      // 用户在设置页预览并确认过的清理若清空了要推送的时间线，与删除同次 set 写入
      // allowEmptySync，随后的 CSV 同步才会带 allowEmpty 把空时间线推给服务端（见 syncTimelineToCsv）
      const { urlTags = [] } = await chrome.storage.local.get('urlTags');
      const emptiesTimeline = filterDramasByConfiguredUrls(kept, urlTags).length === 0;
      await writeDramasInQueue(kept, emptiesTimeline ? { allowEmptySync: true } : {}); // 删除经 onChanged 自动触发 CSV 同步
    }

    return dryRun
      ? { matched, perSite, total: dramas.length, previewToken: currentToken }
      : { removed: matched, perSite, total: kept.length };
  });
}

// 抓取后翻译线的墙钟上限。抓取进行中的空转轮不计入 maxRounds（见 runPostScrapeTranslateLoop），
// 这里兜住「某个抓取挂住、activeScrapeCount 迟迟不归零」时线也会收尾；定得宽，正常的
// 全量抓取（几十个订阅 URL，每个几秒到几十秒）远到不了
const POST_SCRAPE_TRANSLATE_MAX_MS = 2 * 60 * 60 * 1000;

/**
 * 抓取任务开始后，延迟 10 秒启动一轮翻译工作线。
 * 抓取线仍在继续时，翻译线会并行扫描已新增的 new 卡片。
 */
function schedulePostScrapeTranslateLoop() {
  if (postScrapeTranslateRunning || postScrapeTranslateTimer) {
    console.log('[ShortScraping] 抓取后翻译线已在等待或运行，跳过重复启动');
    return;
  }

  console.log('[ShortScraping] 已安排抓取后翻译线：10 秒后启动');
  postScrapeTranslateTimer = setTimeout(async () => {
    postScrapeTranslateTimer = null;
    await runPostScrapeTranslateLoop();
  }, POST_SCRAPE_TRANSLATE_DELAY_MS);
}

async function runPostScrapeTranslateLoop() {
  if (postScrapeTranslateRunning) return;

  postScrapeTranslateRunning = true;
  let emptyScans = 0;
  let rounds = 0;
  const maxRounds = 30; // 安全阈值，避免接口持续失败导致无限循环
  const startedAt = Date.now();
  let stopReason = '';

  try {
    console.log('[ShortScraping] 抓取后翻译线启动');

    while (emptyScans < 3 && rounds < maxRounds) {
      const result = await performTranslate();

      if (result?.pendingCount === 0) {
        if (activeScrapeCount > 0) {
          // 抓取仍在进行、暂无待翻译：空转轮既不计空扫描，也不计 maxRounds。此前照计
          // 轮数，约 30 秒就耗尽 30 轮退出，抓取后半程入库的卡要等整点 translate-task
          console.log('[ShortScraping] 当前无待翻译卡片，但抓取仍在进行，空扫描不计数');
        } else {
          rounds++;
          emptyScans++;
          console.log(`[ShortScraping] 第 ${emptyScans}/3 次扫描无待翻译卡片`);
        }
      } else {
        rounds++;
        emptyScans = 0;
        console.log(`[ShortScraping] 第 ${rounds} 轮翻译：待翻译 ${result?.pendingCount ?? '未知'}，完成 ${result?.translatedCount ?? 0}`);

        // 如果有待翻译但本轮一个都没翻成，仍按用户要求继续下一轮扫描；
        // maxRounds 会防止接口持续失败时无限循环。本轮连败熔断（接口不可用）则直接停线：
        // 每秒再起一轮只会重复撞墙，抓取收尾时 resumePostScrapeTranslateLoop 会再给一次机会
        if (result?.aborted) {
          stopReason = 'aborted';
          break;
        }
      }

      if (Date.now() - startedAt >= POST_SCRAPE_TRANSLATE_MAX_MS) {
        stopReason = 'timeout';
        break;
      }

      if (emptyScans < 3) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (stopReason === 'aborted') {
      console.warn('[ShortScraping] 翻译接口连续失败，抓取后翻译线提前结束');
    } else if (stopReason === 'timeout') {
      console.warn('[ShortScraping] 抓取后翻译线运行超过墙钟上限，已停止');
    } else if (rounds >= maxRounds) {
      console.warn('[ShortScraping] 抓取后翻译线达到最大轮数，已停止');
    } else {
      console.log('[ShortScraping] 抓取后翻译线结束');
    }
  } finally {
    postScrapeTranslateRunning = false;
  }
}

/**
 * 抓取收尾钩子：performScrape 的 finally 在 activeScrapeCount-- 之后调用。最后一个抓取
 * 结束时，若抓取后翻译线已提前退出（maxRounds / 墙钟上限 / 接口熔断），再安排一次，让
 * 抓取后半程入库的卡不必等整点 translate-task。线还在跑或在等就不动——它看到计数归零后
 * 自会按空扫描收尾；还有抓取在排队也不动，等最后一个。
 */
function resumePostScrapeTranslateLoop() {
  if (activeScrapeCount > 0) return;
  if (postScrapeTranslateRunning || postScrapeTranslateTimer) return;
  console.log('[ShortScraping] 抓取已全部结束而抓取后翻译线已退出，再安排一次收尾扫描');
  schedulePostScrapeTranslateLoop();
}

/**
 * 将时间线数据同步到本地 CSV 服务。浏览器扩展无法直接写项目目录，
 * 因此需要运行 `node server/sync-server.js` 负责写入 db/timeline.csv。
 */
function scheduleCsvSync() {
  csvSyncScheduleSeq++;
  // 忙碌期（抓取或翻译轮进行中）前沿节流：已有待发的推送就不重置它——照防抖那样每次变化都
  // 往后推，抓取洪峰期会一直推不出去；没有待发的，距上次推送开跑不足 CSV_SYNC_BUSY_WINDOW_MS
  // 就等到满，否则（空闲后的第一次变化）照常 500ms 推出。空闲时保持 500ms 尾随防抖
  const busy = isCsvSyncBusy();
  if (busy && csvSyncTimer) return;
  if (csvSyncTimer) clearTimeout(csvSyncTimer);
  // 上限夹在一个窗口内：系统时钟回拨（手动改时间、NTP 校正）时 csvSyncLastRunAt 落在「未来」，
  // 算出的等待会长达回拨量，而忙碌期又不重置已排的定时器——整段抓取期间一次都推不出去
  const delay = busy
    ? Math.min(CSV_SYNC_BUSY_WINDOW_MS,
      Math.max(CSV_SYNC_DEBOUNCE_MS, csvSyncLastRunAt + CSV_SYNC_BUSY_WINDOW_MS - Date.now()))
    : CSV_SYNC_DEBOUNCE_MS;
  csvSyncTimer = setTimeout(() => {
    csvSyncTimer = null;
    runCsvSync();
  }, delay);
}

/** 抓取（含排队中）或翻译轮进行中：dramas 会持续变化，推送走节流 */
function isCsvSyncBusy() {
  return activeScrapeCount > 0 || translateRun !== null;
}

/**
 * 定时器回调层的单飞：已有推送在飞就只记「还要再推一次」，在飞那次结束后补排（此时读的是
 * 最新缓存）。守卫刻意不放进 syncTimelineToCsv——测试直接调用它断言单次推送的语义。
 * 报错文案按失败形态在 syncTimelineToCsv 里定：连不上才提示确认服务已启动，服务端
 * 回了错误（如 413 超限）就打印它给的原因——/health 正常时再叫人去启动服务只会误导。
 */
function runCsvSync() {
  if (csvSyncInFlight) {
    csvSyncRerun = true;
    return csvSyncInFlight;
  }
  csvSyncLastRunAt = Date.now();
  csvSyncInFlight = syncTimelineToCsv()
    .catch(error => {
      console.warn('[ShortScraping] CSV 同步失败:', error.message);
    })
    .finally(() => {
      csvSyncInFlight = null;
      if (csvSyncRerun) {
        csvSyncRerun = false;
        scheduleCsvSync(); // 仍在忙碌期就照节流间隔排，空闲了 500ms 后推
      }
    });
  return csvSyncInFlight;
}

/**
 * 忙碌期结束时的收尾强推：最后一个抓取收尾（performScrape 的 activeScrapeCount-- 之后）、
 * 翻译轮结束（translateRun 置回 null 之后）各调一次。节流窗口里攒着的待发推送不必等满
 * 8 秒，改成 500ms 后推出；推送在飞、又有待补跑的，由 runCsvSync 收尾时按空闲口径补排。
 * 还在忙（另一条线没结束）或没有待发的就不动。
 */
function flushCsvSyncAfterBusy() {
  if (isCsvSyncBusy() || !csvSyncTimer) return;
  scheduleCsvSync();
}

function formatSyncBodySize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** fetch 本身抛错（连不上 / 连接被断开）时的报错 */
function csvSyncNetworkError(error, body) {
  const bytes = new TextEncoder().encode(body).length;
  const reason = error?.message || String(error);
  // AbortSignal.timeout 到点：服务连上了却迟迟不应答（卡在写盘 / 进程挂住）。不叫人去启动服务——
  // 它多半正在运行；本次不记签名，下次数据变化或打开弹窗时照常重推
  if (error?.name === 'TimeoutError') {
    return new Error(`同步服务 ${Math.round(CSV_SYNC_TIMEOUT_MS / 1000)} 秒内没有应答（本次推送约 ${formatSyncBodySize(bytes)}），`
      + '已放弃本次推送，下次数据变化或打开弹窗时重推；若反复超时，请检查同步服务日志或重启同步服务');
  }
  if (bytes >= CSV_SYNC_LEGACY_BODY_LIMIT_BYTES) {
    return new Error(`连接同步服务失败（${reason}）。本次推送约 ${formatSyncBodySize(bytes)}，已超过旧版同步服务 20MB 的请求体上限：`
      + '服务若已在运行（弹窗显示在线），多半是超限被断开连接，请更新并重启同步服务；否则请确认本地同步服务已启动');
  }
  return new Error(`无法连接本地同步服务（${reason}），请确认服务已启动`);
}

/** 服务端回了非 2xx：带上它给的原因（sendJson 的 { error }），413 另点明推送体积 */
function csvSyncHttpError(status, result, body) {
  const detail = result?.error ? `：${result.error}` : '';
  if (status === 413) {
    const bytes = new TextEncoder().encode(body).length;
    return new Error(`同步服务拒收（HTTP 413，本次推送约 ${formatSyncBodySize(bytes)}，超过服务端请求体上限）${detail}`);
  }
  return new Error(`同步服务返回 HTTP ${status}${detail}`);
}

async function syncTimelineToCsv() {
  const scheduleSeq = csvSyncScheduleSeq;
  const { urlTags = [], allowEmptySync } = await chrome.storage.local.get(['urlTags', 'allowEmptySync']);
  // 经队列读表：缓存为空（SW 冷唤醒）时这次读顺带回填缓存，翻译扫描不必再整表读一遍
  const dramas = await readDramasThroughQueue('CSV 同步读表');
  // 与本次要序列化的这一版表配对的指纹 rev（按数组引用取，见冷启动指纹）：推送途中又有写入时缓存换成了
  // 新数组，这里取到的仍是被推出去的那一版，csvLastPush 不会把没推上去的新版本记成「服务端已有」
  const pushedRev = dramasStampOf(dramas)?.rev ?? null;
  // 前向兼容护栏：本地数据已是更新版本的布局，冻结的旧表不能再推给服务端（会把新版本推上去的更新内容盖回去）
  if (dramasLayoutAhead) {
    warnDramasReadOnlyOnce('CSV 同步');
    return;
  }
  const configuredDramas = filterDramasByConfiguredUrls(dramas, urlTags);
  const isEmpty = configuredDramas.length === 0;

  // 空库护栏：新 profile / 重装扩展后 storage 为空，SW 启动的顶层预热推送会把 [] 推给同步
  // 服务，连同局域网共享页一起清空 db/timeline.*——用户想从 db/timeline.json 导入恢复时文件
  // 已经空了。空时间线只在用户于扩展页确认过会清空库的操作（退订、按条件清理）留下
  // allowEmptySync 标记时才推，并带 allowEmpty 让服务端放行（服务端对未声明的空推送回 409）。
  // 跳过时不记签名：标记随后落库并再次触发同步时必须照常推送。
  if (isEmpty && allowEmptySync !== true) {
    if (!emptySyncSkipWarned) {
      emptySyncSkipWarned = true;
      console.warn('[ShortScraping] CSV 同步跳过：本地时间线为空且没有「用户主动清空」标记，不覆盖同步服务上的数据');
    }
    return;
  }

  const serialized = JSON.stringify(configuredDramas);
  if (serialized === lastCsvSyncSerialized) {
    console.log('[ShortScraping] CSV 同步跳过：内容与上次成功推送一致');
    return;
  }

  // 字符串拼接复用 serialized，免对数 MB 的数组做第二次 stringify
  const body = `{"dramas":${serialized}${isEmpty ? ',"allowEmpty":true' : ''},"syncedAt":${JSON.stringify(new Date().toISOString())}}`;
  let response;
  try {
    response = await fetch(CSV_SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // 单飞之下必须有超时：一个挂住的请求会堵住之后所有推送（见 runCsvSync）。超时抛
      // TimeoutError，走下面 catch 的专门文案，签名不记、下次照常重推
      signal: AbortSignal.timeout(CSV_SYNC_TIMEOUT_MS)
    });
  } catch (error) {
    throw csvSyncNetworkError(error, body);
  }

  if (response.status === 409) {
    // 服务端拒绝覆盖（如 EMPTY_REJECTED）且什么都没写：同内容重推只会再被拒，记下签名
    // 不再重试这份内容；内容一变（或弹窗补喂清签名）照常推送
    lastCsvSyncSerialized = serialized;
    const result = await response.json().catch(() => null);
    console.warn(`[ShortScraping] CSV 同步被同步服务拒绝（${result?.code || 'HTTP 409'}）：${result?.error || ''}`);
    return;
  }

  if (!response.ok) {
    const result = await Promise.resolve().then(() => response.json()).catch(() => null);
    throw csvSyncHttpError(response.status, result, body);
  }

  // 仅成功后记录签名——失败不记，下次触发照常重试
  lastCsvSyncSerialized = serialized;
  const result = await response.json();
  console.log(`[ShortScraping] CSV 同步完成：${result.count} 条 -> ${result.csvPath}`);
  // 冷启动指纹：只在 200 且服务端回了 contentHash（v1.6.21 起的同步服务）、且它正是这份推送体的指纹时记；
  // 409 / 其余状态码 / 旧版服务 / 服务端另行过滤掉了一部分都不记
  if (response.status === 200) await recordCsvLastPush(dramas, pushedRev, urlTags, result?.contentHash, serialized);

  // 非空推送成功＝库回到有内容的常态，一次性的清空授权作废，免得日后某条非用户操作的路径
  // （如 tag.json 回读清库）借着残留标记把空时间线推上去。推送在飞期间 dramas 又变了
  // （防抖 / 节流同步待发，或到点时撞上本次在飞、记了待补跑）时不删，交给那一次判定：它可能
  // 正是用户这次确认的清空——那次若失败，残留标记还要留给下次唤醒的重推
  if (!isEmpty && allowEmptySync !== undefined && !csvSyncTimer && !csvSyncRerun && scheduleSeq === csvSyncScheduleSeq) {
    await chrome.storage.local.remove('allowEmptySync');
  }
}

/**
 * 推送成功后记冷启动指纹 csvLastPush = { rev, tagsKey, serverHash }：rev 是被推出去那一版表的
 * dramasStamp.rev，tagsKey 是这次过滤用的订阅指纹（configuredUrlFingerprint，与订阅外清理同口径），
 * serverHash 是服务端这次回的 contentHash。服务端没回 contentHash（旧版同步服务）就不记。
 * serverHash 必须正是这份推送体 serialized 的指纹（与服务端同算法，见 sha1HexOf）才记：服务端存快照前还要按
 * 它自己的 config/tag.json 再过滤一遍，两边订阅对不上时（设置页写回 tag.json 失败留下 configAheadOfFile、
 * 手改过 tag.json）它存下的比推上去的少。那样记下的指纹日后照样「对得上」——tag.json 追平之后本该重推补上
 * 被滤掉的卡，冷启动却会跳过。对不上时连旧记录一并作废，下次冷启动照旧推。
 * 表还没有指纹（升级后首推、版本更新刚清掉）时在写队列里补记一个：只有缓存仍是这次推出去的数组、它也还
 * 没有指纹（＝推送以来没有任何写入，storage 里的表正是被推出去的这一版）才补，与 csvLastPush 同一次 set；
 * 期间有写入就不补，交给那次写带出的指纹与随后的推送。记录失败只告警：推送本身已经成功，
 * 下次冷启动无非照旧再推一次。
 */
async function recordCsvLastPush(dramas, rev, urlTags, serverHash, serialized) {
  if (typeof serverHash !== 'string' || serverHash === '') return;
  const tagsKey = configuredUrlFingerprint(urlTags);
  try {
    if (typeof serialized !== 'string' || await sha1HexOf(serialized) !== serverHash) {
      console.warn('[ShortScraping] 同步服务存下的时间线与本次推送不一致（服务端 config/tag.json 与扩展订阅不同步？），不记推送指纹，下次唤醒照旧推送');
      await chrome.storage.local.remove('csvLastPush');
      return;
    }
    if (rev) {
      await chrome.storage.local.set({ csvLastPush: { rev, tagsKey, serverHash } });
      return;
    }
    await enqueueDramaWrite('补记时间线指纹', async () => {
      if (dramasCache !== dramas || dramasStampOf(dramas)) return;
      const stamp = newDramasStamp(dramas);
      await chrome.storage.local.set({ dramasStamp: stamp, csvLastPush: { rev: stamp.rev, tagsKey, serverHash } });
      dramasStamps.set(dramas, stamp);
    });
  } catch (e) {
    console.warn('[ShortScraping] 记录 CSV 推送指纹失败（下次冷启动照旧推送）:', e?.message || e);
  }
}

/**
 * 与同步服务 contentHash 同一算法：JSON 串按 UTF-8 编码后的 sha1，小写 hex（sync-server.js 的 sha1Hex）。
 * 服务端对原样存下的推送体重新 JSON.stringify，与这边的 serialized 逐字相同，指纹因而可比（服务端一侧的
 * 「contentHash＝sha1(快照序列化)」由 unit-server-timeline-cache H1a 钉住）。算法日后若改，这里对不上只会
 * 让指纹一直记不下、退回每次唤醒都推，不会误跳过
 */
async function sha1HexOf(text) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 冷启动指纹比对：同步服务上是否正是本地这一版时间线。只读小键 dramasStamp / csvLastPush / urlTags /
 * allowEmptySync，**从不读 dramas**；本地这几项都对得上才去问 /health（3 秒期限）。以下全部成立才返回 true：
 *   · dramasStamp.rev === csvLastPush.rev（上次成功推送之后表没有再写过）；
 *   · csvLastPush.tagsKey 等于现在的订阅指纹（订阅变了，推送体的过滤口径跟着变）；
 *   · /health 的 contentHash === csvLastPush.serverHash（服务端此刻的内容就是我们推上去的那份，
 *     同步服务重启丢了快照、或被别的版本推过都对不上）；
 *   · /health 的 csvInSync === true（CSV 已知与快照一致，否则推一次让服务端重写 CSV）；
 *   · 没有 allowEmptySync（用户确认过的清空还等着推）。
 * 任何一项缺失、对不上、请求失败或超时都返回 false——宁可多推一次，不可误判一致而不推。
 * health 给定时（弹窗刚读到的 /health 结果）直接用它，不再自己请求。
 */
async function csvSyncUpToDate({ health = null } = {}) {
  try {
    const { dramasStamp, csvLastPush, urlTags = [], allowEmptySync } = await chrome.storage.local.get(['dramasStamp', 'csvLastPush', 'urlTags', 'allowEmptySync']);
    if (allowEmptySync !== undefined) return false;
    if (!validDramasStamp(dramasStamp) || !csvLastPush || typeof csvLastPush !== 'object') return false;
    if (csvLastPush.rev !== dramasStamp.rev) return false;
    if (typeof csvLastPush.tagsKey !== 'string' || csvLastPush.tagsKey !== configuredUrlFingerprint(urlTags)) return false;
    if (typeof csvLastPush.serverHash !== 'string' || csvLastPush.serverHash === '') return false;
    const status = health || await fetchCsvSyncHealth();
    return status?.csvInSync === true && status.contentHash === csvLastPush.serverHash;
  } catch (e) {
    return false;
  }
}

/** 读一次同步服务 /health（3 秒期限，连正文一起算）；非 2xx 为 null，连不上 / 超时向上抛（由调用方按「拿不到」处理） */
async function fetchCsvSyncHealth() {
  const response = await fetch(CSV_SYNC_HEALTH_ENDPOINT, {
    cache: 'no-store',
    signal: AbortSignal.timeout(CSV_SYNC_HEALTH_TIMEOUT_MS)
  });
  if (!response.ok) return null;
  return response.json();
}

/**
 * SW 唤醒的预热推送：冷启动指纹确认同步服务上已是本地这一版就跳过，否则照旧排一次推送（空库护栏、
 * 内容签名等仍由 syncTimelineToCsv 把关）。返回是否排了推送。不会 reject。
 */
async function warmupCsvSyncIfStale(options) {
  if (await csvSyncUpToDate(options)) {
    console.log('[ShortScraping] 跳过预热推送：同步服务上已是本地这一版时间线（冷启动指纹一致）');
    return false;
  }
  scheduleCsvSync();
  return true;
}

/**
 * 扩展版本变了（onInstalled reason==='update'：升级、重载未打包扩展、回退后再升级都算）：清掉冷启动指纹
 * （csvLastPush、dramasStamp），然后强推一次。旧版本不认识 dramasStamp，回退期间它写表不会换 rev，
 * 留下的指纹会与没变的 csvLastPush「对得上」——冷启动误判一致而不推，翻译扫描误信 pending===0 而不读表。
 * 版本一变就作废，比拿 getBytesInUse 之类的旁证猜「表有没有被别的版本写过」可靠。
 * 在写队列里清：与同一实例里迁移 / 订阅外清理的写串行，内存里当前那一版表的指纹一并作废（之后首次成功
 * 推送时由 recordCsvLastPush 补记）。清除失败也照样强推。
 */
async function resetCsvSyncFingerprint() {
  await enqueueDramaWrite('版本更新作废推送指纹', async () => {
    await chrome.storage.local.remove(['csvLastPush', 'dramasStamp']);
    if (dramasCache !== null) dramasStamps.delete(dramasCache);
  }).catch(() => {}); // 失败已由 enqueueDramaWrite 记日志
  lastCsvSyncSerialized = null;
  scheduleCsvSync();
}

/* —— Lark 群机器人：有新内容即时推一张卡到群（v1.5.14） ——————————————
 *
 * 与 Base 工作流那条并存、互不影响：机器人免费无月度额度，管「实时知道」；
 * 工作流按「1 条记录＝1 次运行」计费，管「写进表」。
 *
 * 触发点（每个都只在「这一次写入把卡变成 trans」时推）：
 *   ① 翻译线把一条从 new 补成 trans（走 AI 翻译的站点；含连续失败收口为 trans）；
 *   ② 抓取入库时该卡已是 trans（平台自带中文齐全，压根不进翻译线）；
 *   ③ 弹窗单卡 🌍 把一条从 new 翻成 trans（handleTranslateSingle）。
 * ①③ 的判据 becameTrans 在 dramas 写队列内按当前记录算（mergeTranslation：逐条走
 * updateSingleDramaTranslation，① 的 AI 成功批走 updateBatchDramaTranslations），
 * 两条线同时翻同一张卡时只有先落库的一方推；② 只推新入库的卡（去重命中不推）。
 * 所以**不设持久的「已推送」标记**。剩下的重复面只有 trans→new 复位后重译再推：存量机器上
 * 几个一次性复位迁移早已跑完，眼下只剩导入恢复——导入跳过库里已有的 itemId，只有「删掉后
 * 再导入、且备份里的译文被判乱码 / 非中文而退回 new」的卡会再推一次，收益低，暂不做标记。
 *
 * **启用水位线是必需品不是优化**：库里几千条存量会陆续走完翻译线（尤其
 * resetPartialTranslations 刚退回队列的那批），没有水位线一开机器人就在群里
 * 刷屏。只推 scrapedAt 晚于「启用时刻」的卡；关闭开关即清水位线，下次开启重新计时。
 */
/**
 * 同步启用水位线。返回带 enabledAt 的整份 larkBotState（maybeBotPush 顺带用它过订阅基线，
 * 省一次 storage 读）；开关未就绪返回 null，并按旧语义清空状态（水位线连同基线、重试队列作废）。
 */
async function syncBotWatermark(config) {
  const ready = Lark.botReadiness(config).ok;
  const state = await updateBotState((current) => {
    if (!ready) return current.enabledAt ? {} : current;
    if (current.enabledAt) return current;
    const enabledAt = new Date().toISOString();
    console.log(`[ShortScraping] 群机器人已启用，水位线 ${enabledAt}（更早抓到的存量不推送）`);
    return { ...current, enabledAt };
  });
  return ready ? state : null;
}

/* —— 发送节流与失败重试（v1.6.0） ————————————————————————————
 *
 * 节流：飞书自定义机器人限流「单租户单机器人 100 次/分钟、5 次/秒」，超限回 11232。
 * 每分钟那条安全（实测一批翻译 9.5~34 秒 ≈ 35 条/分钟），但**翻译线一批 10 条跑完
 * 一起回填**，10 次推送会在同一个循环里连发，很容易打满「5 次/秒」。250ms 间隔
 * ＝ ≤4 次/秒，成本可忽略。
 *
 * 重试：推翻 v1.5.14「失败只记日志、不重试不排队」的边界（2026-09-12 用户要求）。
 * **不能用 setTimeout**——MV3 的 SW 空闲约 30 秒即被回收，跨 1 分钟的定时器活不到；
 * 唯一可靠做法是 chrome.alarms（允许的最小间隔正好 1 分钟）+ storage 持久队列。
 * 队列只存 id 与已失败次数（对齐 handleLarkPush 只传 id 的惯例），重试时按 id
 * 重新读卡；条目已被清理就丢弃。队列空必须清掉闹钟，否则扩展永远每分钟醒一次。
 */
const BOT_RETRY_ALARM_NAME = 'larkBotRetry';
const MAX_BOT_RETRIES = 3;              // 首发失败后最多再试 3 次（共 4 次请求）
const BOT_RETRY_QUEUE_LIMIT = 50;       // 防 webhook 失效时队列无限膨胀
const BOT_PUSH_MIN_INTERVAL_MS = 250;
let lastBotPushAt = 0;

async function throttleBotPush() {
  const wait = BOT_PUSH_MIN_INTERVAL_MS - (Date.now() - lastBotPushAt);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastBotPushAt = Date.now();
}

async function readBotState() {
  const { larkBotState } = await chrome.storage.local.get('larkBotState');
  return larkBotState && typeof larkBotState === 'object' ? larkBotState : {};
}

/**
 * larkBotState 的唯一写入口：读→改→写串成一条 promise 链。翻译线的推送/入队与抓取收轮的
 * 基线收口按设计并行，裸的 get→展开→set 交错一次就丢一次更新（最可能丢 retryQueue）。
 * mutate 返回同一引用＝无变化不写；mutate 内不得再调本函数（会等自己、死锁）。
 */
let botStateQueue = Promise.resolve();
function updateBotState(mutate) {
  const run = botStateQueue.then(async () => {
    const state = await readBotState();
    const next = await mutate(state);
    if (next && next !== state) await chrome.storage.local.set({ larkBotState: next });
    return next || state;
  });
  botStateQueue = run.catch(() => {});
  return run;
}

async function writeBotRetryQueue(queue) {
  await updateBotState(state => ({ ...state, retryQueue: queue }));
  if (queue.length) chrome.alarms.create(BOT_RETRY_ALARM_NAME, { delayInMinutes: 1 });
  else await chrome.alarms.clear(BOT_RETRY_ALARM_NAME);
}

/* —— 订阅 URL 首轮抓取只入库不推送（v1.6.7，2026-09-17 用户定；取代 v1.6.6 的站点级规则，不叠加） ——
 *
 * 刚订阅的 URL 第一轮会一次抓进几十条（FlickReels 首轮 24 条；IMDB 新加 9 条出品公司筛选约 300 条），
 * 它们是存量底座不是「新动态」，全推进群里就是刷屏。粒度必须是订阅 URL 而非站点：IMDB 库里已有
 * 482 条，按站点判「新站」永远判不出来；新站点只是「该站所有 URL 都零条」的特例，一条规则覆盖两种情形。
 * 做法：开轮时库里零条的订阅 URL 视为首轮，本轮期间该 URL 基线挂 'pending' 一律不推（翻译线在开轮
 * 10s 后就并行跑，首批卡可能在收轮前翻完），收轮时把基线定在完成时刻，此后只推 scrapedAt 晚于基线的卡。
 * 存 larkBotState.urlBaseline[UrlMatch.normalizeListUrl(url)]（尾斜杠归一，与订阅归属判定同口径），
 * 与全局水位线 enabledAt 并列、互不影响。卡片按 sourceListUrl 归属（content.js 写入的就是订阅 URL
 * 本身）；无 sourceListUrl 的卡不受基线约束。标记/收口都只碰本轮 URL（弹窗单站刷新传的是过滤后的列表）。
 * SW 中途被回收会留下 'pending'：下一轮含该 URL 的收轮时统一收口为时间戳（那一轮的卡也随之不推，接受）。
 * 已知边界（接受）：某 URL 长期零条（条目全与其它订阅重叠、去重命中不入库）时每轮都算首轮，它的第一条
 * 真正新卡会被吞一次；换成「有过基线就不再标」则首轮整页加载失败时下一轮会把底座全推出去，刷屏比漏一条更糟。
 * 退订 URL 的基线条目不清理（每条约 100 字节，重订阅时零条即重标覆盖）。
 * v1.6.6 的 larkBotState.siteBaseline[site] 是遗留死数据：首次收轮时折进同站所有已订阅、尚无基线的 URL
 * （保住 FlickReels 首轮尚未翻完的卡不被补推）后删除该键，一次性。
 */
const baselineKey = url => UrlMatch.normalizeListUrl(url);

async function markUrlBaselines(urls) {
  if (!urls.length) return;
  await updateBotState((state) => {
    const urlBaseline = { ...(state.urlBaseline || {}) };
    for (const url of urls) urlBaseline[baselineKey(url)] = 'pending';
    return { ...state, urlBaseline };
  });
  console.log(`[ShortScraping] 订阅首轮抓取只入库不推送: ${urls.join(', ')}`);
}

async function finalizeUrlBaselines(urls) {
  const completedAt = new Date().toISOString();
  let settled = [];
  await updateBotState(async (state) => {
    const { siteBaseline: legacy, ...rest } = state;
    const urlBaseline = { ...(rest.urlBaseline || {}) };

    // v1.6.6 遗留的站点基线（一次性）：折进同站所有已订阅、尚无基线的 URL 后删除该键。
    // 折全部订阅而非只本轮——弹窗单站刷新只带一个站的 URL，不能让别站的遗留基线白白丢掉。
    if (legacy) {
      const { urlTags = [] } = await chrome.storage.local.get('urlTags');
      for (const url of getConfiguredScrapeUrls(urlTags)) {
        const inherited = legacy[siteOfUrl(url)];
        if (inherited && !urlBaseline[baselineKey(url)]) urlBaseline[baselineKey(url)] = inherited;
      }
      console.log(`[ShortScraping] v1.6.6 站点基线已折进订阅基线并移除: ${Object.keys(legacy).join(', ')}`);
    }

    settled = urls.filter(url => urlBaseline[baselineKey(url)] === 'pending');
    if (!settled.length && !legacy) return state;   // 同一引用＝不写
    for (const url of settled) urlBaseline[baselineKey(url)] = completedAt;
    return { ...rest, urlBaseline };
  });
  if (settled.length) {
    console.log(`[ShortScraping] 群机器人订阅基线定在首轮抓取完成时刻 ${completedAt}: ${settled.join(', ')}`);
  }
}

/** 该订阅 URL 首轮进行中，或卡片不晚于其首轮完成时刻 → 不推。无基线 / 无 sourceListUrl 的卡照常。 */
function isBeforeUrlBaseline(drama, state) {
  const key = baselineKey(drama.sourceListUrl);
  const baseline = key && state && state.urlBaseline ? state.urlBaseline[key] : null;
  if (!baseline) return false;
  return baseline === 'pending' || !drama.scrapedAt || drama.scrapedAt <= baseline;
}

async function enqueueBotRetry(dramaId, attempts) {
  await updateBotState((state) => {
    const queue = (Array.isArray(state.retryQueue) ? state.retryQueue : [])
      .filter(entry => entry && entry.dramaId !== dramaId);
    queue.push({ dramaId, attempts });
    while (queue.length > BOT_RETRY_QUEUE_LIMIT) queue.shift();   // 超限丢最老的
    return { ...state, retryQueue: queue };
  });
  chrome.alarms.create(BOT_RETRY_ALARM_NAME, { delayInMinutes: 1 });   // 入队后队列必非空
}

/**
 * 重试队列处理（闹钟 larkBotRetry 触发）。逐条推送要跑好几分钟（每条请求超时 15s，最多 50 条），
 * 这期间翻译线的 maybeBotPush 照常失败入队、并新建 1 分钟后的闹钟。所以：
 * - 收尾写回在 updateBotState 内对**当前**队列做合并，不拿开轮快照整体覆盖：只摘掉本轮处理过的条目
 *   （dramaId + 开轮时的 attempts 认领），处理期间新入队的原样保留；闹钟按合并后的队列建或清。
 *   此前整体写回 remaining，期间入队的卡连同闹钟一起丢（审查 bot-retry-queue-overwrite）。
 * - 内存标记 botRetryProcessing 挡住并发的第二轮：期间入队建的闹钟到点时本轮往往还没跑完，
 *   第二轮读到的仍是未写回的整队，已推成功的卡会被再推一遍。被挡的一轮直接返回即可——
 *   本轮收尾时队列非空就会重建闹钟。标记只在内存：SW 被回收时处理也随之中断，不会误挡。
 */
let botRetryProcessing = false;

async function processBotRetryQueue() {
  if (botRetryProcessing) {
    console.log('[ShortScraping] 群机器人重试队列正在处理，本次触发跳过（收尾时按队列重建闹钟）');
    return;
  }
  botRetryProcessing = true;
  try {
    await processBotRetryQueueOnce();
  } finally {
    botRetryProcessing = false;
  }
}

async function processBotRetryQueueOnce() {
  // 快照经 updateBotState 链读（mutate 返回同一引用＝不写）：排在它前面、尚未落盘的入队也算进本轮
  const state = await updateBotState(current => current);
  const queue = Array.isArray(state.retryQueue) ? state.retryQueue.filter(Boolean) : [];
  if (!queue.length) {
    await chrome.alarms.clear(BOT_RETRY_ALARM_NAME);
    return;
  }

  const { larkConfig } = await chrome.storage.local.get('larkConfig');
  const config = Lark.normalizeConfig(larkConfig);
  // 开关已关或地址已清：整队作废，别留着每分钟醒一次
  if (!Lark.botReadiness(config).ok) {
    await writeBotRetryQueue([]);
    return;
  }

  const dramas = await getDramasSnapshot();
  const remaining = [];
  for (const entry of queue) {
    const drama = dramas.find(d => d.id === entry.dramaId || d.itemId === entry.dramaId);
    if (!drama) continue;   // 已被「按条件清理」删掉 → 丢弃，不白发请求
    try {
      await throttleBotPush();
      await Lark.pushBotCard(config, drama);
      console.log(`[ShortScraping] 群机器人重试成功: ${drama.titleZh || drama.title}`);
    } catch (e) {
      const attempts = (Number(entry.attempts) || 1) + 1;
      if (attempts > MAX_BOT_RETRIES) {
        console.warn(`[ShortScraping] 群机器人推送放弃（已试 ${attempts} 次）: ${entry.dramaId} - ${e.message}`);
        continue;
      }
      remaining.push({ dramaId: entry.dramaId, attempts });
    }
  }

  // 认领键＝dramaId + 开轮时的 attempts。处理期间同一张卡被 enqueueBotRetry 重新入队时
  // attempts 回到 1，与开轮值不同即算新条目保留，并顶掉本轮给它留的旧重试（与 enqueueBotRetry
  // 「同 id 只留最新一条」同口径）。已知边界（接受）：开轮值恰好也是 1 时两者无法区分，新条目
  // 被当作本轮处理过的摘掉——本轮推成功则那张卡已送达，推失败则 remaining 里仍留着它的重试。
  const claimKey = entry => `${entry.dramaId}\u0000${Number(entry.attempts) || 1}`;
  const claimed = new Set(queue.map(claimKey));
  const merged = await updateBotState((current) => {
    const arrived = (Array.isArray(current.retryQueue) ? current.retryQueue : [])
      .filter(entry => entry && !claimed.has(claimKey(entry)));
    const arrivedIds = new Set(arrived.map(entry => entry.dramaId));
    // 本轮剩下的条目入队更早，排在前面；超限丢最老的（与 enqueueBotRetry 同口径）
    const retryQueue = remaining.filter(entry => !arrivedIds.has(entry.dramaId)).concat(arrived);
    while (retryQueue.length > BOT_RETRY_QUEUE_LIMIT) retryQueue.shift();
    return { ...current, retryQueue };
  });
  if (merged.retryQueue.length) chrome.alarms.create(BOT_RETRY_ALARM_NAME, { delayInMinutes: 1 });
  else await chrome.alarms.clear(BOT_RETRY_ALARM_NAME);
}

/**
 * 条件满足才推一张卡。任何失败只记日志——推送是旁路，绝不能影响翻译/入库落库；
 * 推送请求本身失败则进重试队列（图片上传失败不算，那条路降级发无图卡）。
 */
async function maybeBotPush(drama) {
  try {
    if (!drama || drama.status !== 'trans') return false;

    const { larkConfig } = await chrome.storage.local.get('larkConfig');
    const config = Lark.normalizeConfig(larkConfig);
    if (!Lark.botReadiness(config).ok) return false;

    const state = await syncBotWatermark(config);
    if (!state || !state.enabledAt) return false;
    // 无 scrapedAt 的条目保守不推（判不出是存量还是新卡）
    if (!drama.scrapedAt || drama.scrapedAt < state.enabledAt) return false;
    // 订阅 URL 首轮只入库不推送（见 markUrlBaselines）
    if (isBeforeUrlBaseline(drama, state)) return false;

    try {
      await throttleBotPush();
      await Lark.pushBotCard(config, drama);
    } catch (e) {
      console.warn('[ShortScraping] 群机器人推送失败（不影响入库）:', e.message);
      if (drama.id) await enqueueBotRetry(drama.id, 1);
      return false;
    }
    console.log(`[ShortScraping] 群机器人已推送: ${drama.titleZh || drama.title}`);
    return true;
  } catch (e) {
    console.warn('[ShortScraping] 群机器人推送流程异常（不影响入库）:', e.message);
    return false;
  }
}

// —— Lark 推送：多维表格工作流 webhook 触发器（实现见 src/shared/lark.js） ——

// 时间线为空时「发送测试」用的内置样例（无封面/链接，顺带验证空值降级路径）
const SAMPLE_LARK_DRAMA = {
  id: 'lark-test-sample',
  title: 'Lark Push Test',
  titleZh: 'Lark 推送测试',
  description: 'This is a test message sent from the ShortScraping extension.',
  descriptionZh: '这是一条来自 ShortScraping 扩展的测试消息，用于让飞书工作流捕获参数结构。',
  source: 'reelshort',
  tags: ['测试'],
  genres: ['Romance', 'Revenge'],   // 非空样例：让飞书触发器捕获时看得见该参数
  url: '',
  poster: '',
  scrapedAt: ''
};

/**
 * 弹窗卡片按钮：按 id 从 storage 取卡再推送（与 translateSingle 同款只传 id，
 * 不信任调用方传对象）。配置永远读 storage，是唯一事实源。
 */
async function handleLarkPush(dramaId) {
  const { larkConfig } = await chrome.storage.local.get('larkConfig');
  const config = Lark.normalizeConfig(larkConfig);
  if (!Lark.configReadiness(config).ok) {
    return { success: false, notConfigured: true, error: 'Lark 推送未配置 webhook 地址' };
  }

  const dramas = await getDramasSnapshot();
  const drama = dramas.find(d => d.id === dramaId);
  if (!drama) {
    return { success: false, error: '未找到该卡片数据' };
  }

  try {
    await Lark.pushDrama(config, drama);
    console.log(`[ShortScraping] Lark 推送成功: ${drama.title}`);
    return { success: true };
  } catch (e) {
    console.warn('[ShortScraping] Lark 推送失败:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * 设置页「发送测试」：可带表单草稿 config（normalize 后使用、不落库），
 * 让用户保存前即可验证。样例数据取时间线最新一条，为空用内置样例。
 */
async function handleLarkTestSend(draftConfig) {
  let config;
  if (draftConfig && typeof draftConfig === 'object') {
    config = Lark.normalizeConfig(draftConfig);
  } else {
    const { larkConfig } = await chrome.storage.local.get('larkConfig');
    config = Lark.normalizeConfig(larkConfig);
  }

  if (!Lark.configReadiness(config).ok) {
    return { success: false, notConfigured: true, error: '请先填写 webhook 地址' };
  }

  const dramas = await getDramasSnapshot();
  const drama = dramas[0] || SAMPLE_LARK_DRAMA;

  try {
    await Lark.pushDrama(config, drama);
    console.log(`[ShortScraping] Lark 测试发送成功: ${drama.title}`);
    return { success: true, sampleTitle: drama.title };
  } catch (e) {
    console.warn('[ShortScraping] Lark 测试发送失败:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * 设置页「发送机器人测试」：表单草稿不落库，发时间线最新一条／内置样例。
 * 与 handleLarkTestSend 同款姿势，只是走机器人卡片那条通道。
 */
async function handleLarkBotTestSend(draftConfig) {
  const config = draftConfig && typeof draftConfig === 'object'
    ? Lark.normalizeConfig(draftConfig)
    : Lark.normalizeConfig((await chrome.storage.local.get('larkConfig')).larkConfig);

  if (!Lark.botReadiness(config).ok) {
    return { success: false, notConfigured: true, error: '请先填写群机器人 webhook 地址并启用' };
  }

  const dramas = await getDramasSnapshot();
  const drama = dramas[0] || SAMPLE_LARK_DRAMA;

  try {
    await Lark.pushBotCard(config, drama);
    console.log(`[ShortScraping] 群机器人测试发送成功: ${drama.title}`);
    return { success: true, sampleTitle: drama.titleZh || drama.title };
  } catch (e) {
    console.warn('[ShortScraping] 群机器人测试发送失败:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * 内容脚本详情页 HTML 代理（v1.5.5）：fandom 子域上的 content script fetch 主站
 * 播放页被页面 CORS 拦（/video/ 响应无 ACAO 头），SW fetch 对 host_permissions
 * 主机免页面 CORS，代取 HTML 后交回内容脚本用 DOMParser 解析（SW 无 DOM 能力）。
 * 白名单按规则表放行、逐条带各自请求头（最小暴露面；无重试、无缓存、不落任何状态）：
 * - mydrama 播放页规范形态（严格 36 位 UUID、无 query，与库内 url 存储形态一致），
 *   只带 Accept: text/html——详情的本地化标题/简介语义依赖浏览器语言，不加 Accept-Language；
 * - Netflix /title/<videoId>（v1.5.9，只为补 genres）：Tudum 页同源直连会带用户 Netflix 登录
 *   cookie（登录态页面形态不同），SW fetch 无 cookie；并强制 Accept-Language 英文——页内
 *   coreGenre 类型名随请求头本地化（zh-CN 会得到「惊悚/悬疑/剧情片」，genres 约定存英文原值）。
 * - Apple TV（v1.5.10）两条：榜单 collection 页与 /us/show|movie/ 详情页。**榜单也走代理**
 *   （其余站点只有详情走）——Apple 的 SSR 数据脚本 hydrate 后会从 DOM 删除，内容脚本
 *   等到抓取时点已读不到，只能重新取 HTML；顺带避开用户 Apple TV+ 登录态 cookie。
 *   详情规则对 slug 放宽（your-friends--neighbors 这类双连字符要过），但不收 query。
 */
const DETAIL_HTML_PROXY_RULES = [
  {
    pattern: /^https:\/\/my-drama\.com\/video\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    headers: { 'Accept': 'text/html' }
  },
  {
    pattern: /^https:\/\/www\.netflix\.com\/title\/\d{5,}$/,
    headers: { 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }
  },
  {
    pattern: /^https:\/\/tv\.apple\.com\/us\/collection\/[^/?#]+\/uts\.col\.Charts(Shows|Movies)\.tvs\.sbd\.\d+$/,
    headers: { 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }
  },
  {
    pattern: /^https:\/\/tv\.apple\.com\/us\/(show|movie)\/[^/?#]+\/umc\.cmc\.[a-z0-9]+$/,
    headers: { 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }
  }
];

// 代理请求期限，与内容脚本 fetchWithTimeout 同为 25 秒、**正文读完才算完**：内容脚本等代理回复
// 不设期限，这里挂住＝那一页的抓取跟着挂住（审查 no-fetch-timeout-hangs-scrape-queue）。
// 期限用 Promise.race 兜底，底层 fetch 即使不理会 abort 信号也按时回 success:false
const DETAIL_HTML_PROXY_TIMEOUT_MS = 25000;

async function fetchDetailHtmlForContent(url) {
  const rule = typeof url === 'string' ? DETAIL_HTML_PROXY_RULES.find(r => r.pattern.test(url)) : null;
  if (!rule) {
    return { success: false, error: 'URL 不在代理白名单内' };
  }
  const controller = new AbortController();
  let timer = null;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`请求超时（${DETAIL_HTML_PROXY_TIMEOUT_MS / 1000} 秒内未读完响应）`));
    }, DETAIL_HTML_PROXY_TIMEOUT_MS);
  });
  const request = (async () => {
    const response = await fetch(url, { headers: rule.headers, signal: controller.signal });
    if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
    return { success: true, html: await response.text() };
  })();
  try {
    return await Promise.race([request, expired]);
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 显示通知
 */
function showNotification(message) {
  chrome.notifications.create(`dramamo-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'assets/icons/icon128.png',
    title: 'ShortScraping',
    message: message,
    priority: 1
  });
}

/**
 * 内容脚本开轮要的抓取上下文（审查 storage-secrets-exposed-to-content / full-table-read-per-scrape）：
 * 订阅配置 + 库中已有条目的精简列表 known = [[itemId, 是否已有 genres], ...]。内容脚本只拿它建
 * 去重集合与「要不要回填 genres」的判断，所以不给整条记录（简介、译文都不出后台）；几千条也只有
 * 一两百 KB，而以前每个抓取标签页都要把整张 dramas（约 5MB）跨进程反序列化一遍。
 * dramas 走写队列读（命中 dramasCache 时零 get），排在已入队的写之后，看到的是已提交的最新表。
 *
 * known 只给发送方标签页所在站点的条目：内容脚本按 location.hostname 选适配器（与
 * SiteRegistry.siteOfUrl 同一判据），只拿本站列表项的 itemId 去查 known，别站条目用不上，每个
 * 标签页白跨进程传一遍全库。本站条目按 source 或 sourceListUrl 所属站点任一命中即给（取并集，
 * 宁多勿漏——漏了只会多请求一次详情、再被后台 saveDramaRecord 的全局 itemId 去重挡下）。
 * 取不到站点（标签页 URL 缺失 / 不在注册表）时照旧给全部。
 */
async function scrapeContextForContent(sender) {
  const dramas = await enqueueDramaWrite('抓取上下文', getDramasInQueue);
  const { urlTags } = await chrome.storage.local.get('urlTags');
  const site = siteOfUrl(sender?.tab?.url || sender?.url || '');
  const known = [];
  for (const drama of Array.isArray(dramas) ? dramas : []) {
    if (!drama || !drama.itemId) continue;
    if (site && drama.source !== site && siteOfUrl(drama.sourceListUrl) !== site) continue;
    known.push([drama.itemId, Array.isArray(drama.genres) && drama.genres.length > 0]);
  }
  return { success: true, urlTags: Array.isArray(urlTags) ? urlTags : [], known };
}

/**
 * 内容脚本可发的消息白名单：content.js 只发这三种（取抓取上下文、抓取入库、详情页代理取 HTML）。
 * 新增内容脚本消息时须同步加到这里，否则会被下面的发送方闸门拒掉。
 */
const CONTENT_SCRIPT_ACTIONS = new Set(['getScrapeContext', 'saveDrama', 'fetchDetailHtml']);

/**
 * 发送方是否为本扩展自己的页面（弹窗 / 设置页）。判据是来源 URL 落在本扩展源下；
 * 不能只看 sender.tab——设置页以标签页打开（options_ui.open_in_tab），它发来的消息
 * 同样带 sender.tab。其余发送方（运行在第三方站点里的内容脚本，以及缺 url 的
 * 任何来源）一律按内容脚本对待，只放行 CONTENT_SCRIPT_ACTIONS。
 */
function isExtensionPageSender(sender) {
  return Boolean(sender) && sender.id === chrome.runtime.id
    && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

/**
 * 监听消息
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 发送方闸门（2026-09-25 审查 bg-onmessage-no-sender-check）：清库、导入、Lark 推送 /
  // 测试发送（会把调用方给的 webhook 当真配置用）这类特权动作只接受扩展页面。内容脚本
  // 跑在第三方站点的渲染进程里，那里一旦被攻破，不能借后台的全站 host 权限与已固定的
  // 扩展 Origin 代发请求或清空时间线
  if (!isExtensionPageSender(sender) && !CONTENT_SCRIPT_ACTIONS.has(request?.action)) {
    console.warn(`[ShortScraping] 已拒绝非扩展页面发来的消息: ${request?.action}（来源 ${sender?.url || '未知'}）`);
    sendResponse({ success: false, error: '该操作只接受扩展页面（弹窗 / 设置页）发起' });
    return false;
  }

  if (request.action === 'warmupCsvSync') {
    // 弹窗检测到同步服务健康时的补喂：服务启动晚于 SW 预热推送时，
    // 快照会一直空着，打开弹窗即可把当前时间线重新推给服务。
    // 必须先清内容签名强制推送——「服务重启丢快照 + SW 在世签名命中」
    // 的组合会让补喂被签名跳过、共享页永久空白
    const forcePush = () => {
      lastCsvSyncSerialized = null;
      scheduleCsvSync();
    };
    // v1.6.22：弹窗带来了它刚读到的 /health 指纹（contentHash / csvInSync，v1.6.21 起的同步服务才有）时先比对
    // 冷启动指纹，服务上已确认是本地这一版就不推；对不上照旧强推。没带（旧版服务 / 旧版弹窗）维持强推
    if (typeof request.contentHash === 'string' && request.contentHash !== '') {
      const health = { contentHash: request.contentHash, csvInSync: request.csvInSync === true };
      csvSyncUpToDate({ health }).then(upToDate => {
        if (upToDate) console.log('[ShortScraping] 弹窗补喂跳过：同步服务上已是本地这一版时间线（指纹一致）');
        else forcePush();
        sendResponse({ success: true, pushed: !upToDate });
      });
      return true;
    }
    forcePush();
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'updateAlarms') {
    setupAlarms().then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'triggerScrape') {
    // 全量轮在跑或排队、且还没开抓该站：并进那一轮，立即回 merged，不再排到整轮后面重抓
    // 一遍（弹窗原先要转圈到全量轮结束再加本站重抓）。新卡随全量轮入库，弹窗经 onChanged 自动出现
    if (fullScrapeWillCoverSite(request.site)) {
      console.log(`[ShortScraping] 站点刷新并入进行中的全量抓取: ${request.site}`);
      sendResponse({ success: true, merged: true });
      return false;
    }
    performScrape({ site: request.site }).then((summary) => {
      // 只读模式（前向兼容护栏）本轮没开抓：按失败回，弹窗 toast 显示升级提示而不是「新增 0 部」
      sendResponse(summary?.readOnly ? { success: false, error: summary.error } : { success: true, summary });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'triggerTranslate') {
    // 立即 ack、不 await 整轮：按钮状态由持久化的 translateRunState 驱动，
    // 不再依赖可能挂几十分钟的 sendResponse 往返（弹窗关闭也不再报 port closed）
    performTranslate({ source: 'manual' });
    sendResponse({ success: true, started: true });
    return false;
  }

  if (request.action === 'getTranslateState') {
    // 从内存应答：translateRun 存在但镜像还没写 running:true 时（预扫描阶段
    // 或自动线空扫描），按未运行报告——真在跑的轮随后必有 onChanged 纠正，
    // 而自动空扫描不写终态，若此处报 running 弹窗将永远等不到收尾信号
    sendResponse({
      running: Boolean(translateRun) && Boolean(translateRunStateMirror?.running),
      state: translateRunStateMirror
    });
    return false;
  }

  if (request.action === 'getScrapeContext') {
    scrapeContextForContent(sender).then(sendResponse).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'saveDrama') {
    saveDramaRecord(request.drama).then((saved) => {
      sendResponse({ success: true, saved });
      // 触发点②：平台自带中文齐全的新卡入库即 trans，压根不进翻译线，
      // 只能在这里推。去重命中（saved=false）不推，避免每轮重复。
      if (saved) maybeBotPush(request.drama);
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'fetchDetailHtml') {
    // fetchDetailHtmlForContent 全路径返回对象、不 reject，无需 catch
    fetchDetailHtmlForContent(request.url).then(sendResponse);
    return true;
  }

  if (request.action === 'translateSingle') {
    handleTranslateSingle(request.dramaId).then(sendResponse).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'importDramas') {
    // 经 Promise.resolve().then 调用：importDramaRecords 的逐条校验是同步执行的，任一条抛错
    // （如日历非法的时间戳）会在 return true 之前冒出监听器，sendResponse 永远不回、设置页
    // 卡在「后台无响应」。包一层后同步异常也转成 reject，走下面的 catch 回 success:false
    Promise.resolve().then(() => importDramaRecords(request.dramas)).then((result) => {
      sendResponse({ success: true, ...result });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'pruneDramas') {
    // 同 importDramas：参数校验里的同步异常也必须回 sendResponse
    Promise.resolve().then(() => pruneDramaRecords(request)).then((result) => {
      sendResponse({ success: true, ...result });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'larkPush') {
    handleLarkPush(request.dramaId).then(sendResponse).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'larkBotTestSend') {
    handleLarkBotTestSend(request.config).then(sendResponse).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'larkTestSend') {
    handleLarkTestSend(request.config).then(sendResponse).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
});

console.log('[ShortScraping] 后台服务已启动');
