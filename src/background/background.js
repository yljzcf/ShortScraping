/**
 * ShortScraping Background Service Worker
 * 定时任务调度：抓取线 + 翻译线
 */

importScripts('../shared/url-match.js');
importScripts('../shared/subscription-config.js'); // 订阅规范化单一真源（与设置页/同步服务共用）
importScripts('../shared/site-registry.js'); // 须先于 lark.js（其 SOURCE_NAMES 取自本模块）
importScripts('../shared/timeline-csv.js');
importScripts('../shared/schedule-config.js'); // cron 解析/校验/默认值单一真源
importScripts('../shared/translate-config.js');
importScripts('../shared/translator.js');
importScripts('../shared/lark.js');

// 翻译接口默认配置。实际配置来自 config/trans.json。
const DEFAULT_TRANSLATE_CONFIG = TranslateConfig.DEFAULT_CONFIG;

// 运行状态。抓取走串行队列：手动单站刷新与定时全量并发触发时排队执行，
// 避免双开同一 URL 的标签页；activeScrapeCount 覆盖「排队+运行中」的整个
// 区间，抓取后翻译线据此判断抓取是否仍在进行（此前用布尔，两次抓取并行时
// 先结束的一方会提前放行空扫描计数，导致后结束批次的新卡本轮不被翻译）。
let scrapeQueue = Promise.resolve();
let activeScrapeCount = 0;
let postScrapeTranslateTimer = null;
let postScrapeTranslateRunning = false;
let csvSyncTimer = null;
// 上次成功推送的时间线序列化内容（SW 内存签名，刻意不持久化——SW 回收后首推
// 即同步服务重启场景的天然恢复机制）。同内容跳过 POST，省去约 1.5MB 冗余传输
let lastCsvSyncSerialized = null;

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
// 本文件的 setTimeout 延时（本常量与 CSV 500ms 防抖）均远小于 MV3 SW 的
// ~30s 空闲回收阈值；极端情况下 SW 连同定时器被杀时，SW 下次唤醒的顶层
// scheduleCsvSync 与 translate-task alarm 会兜底。评估后不迁移 chrome.alarms
// （其最小粒度 30s，反而更差）。
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
// 读写零 get（抓 N 条从 N 次约 1.5MB 的全表反序列化降为 1 次）。一致性前提：
// dramas 的全部写路径都收口在 enqueueDramaWrite 队列内（全仓已核实八处），且
// 缓存数组视为只读——写一律 copy-on-write 构造新数组。SW 回收即缓存消失。
let dramasCache = null;

/** 仅队列内调用：读当前 dramas 表，缓存命中零 get。 */
async function getDramasInQueue() {
  if (dramasCache === null) {
    const { dramas = [] } = await chrome.storage.local.get('dramas');
    dramasCache = dramas;
  }
  return dramasCache;
}

/**
 * 仅队列内调用：写 dramas 表（连带键经 extra 同次 set）。set 成功后缓存指向
 * 新数组；失败则缓存失效重读并向上抛——防「缓存已新、storage 仍旧」的分歧驻留。
 */
async function writeDramasInQueue(next, extra = {}) {
  try {
    await chrome.storage.local.set({ dramas: next, ...extra });
    dramasCache = next;
  } catch (e) {
    dramasCache = null;
    throw e;
  }
}

/**
 * 队列外只读快照（翻译线扫描/CSV 同步/Lark 推送用）：缓存非 null 直接返回引用，
 * 调用方不得改动；缓存为空时直读 storage 且不回填——await 期间队列可能已提交
 * 新值，旧读回填会把缓存拽回过去。
 */
async function getDramasSnapshot() {
  if (dramasCache !== null) return dramasCache;
  const { dramas = [] } = await chrome.storage.local.get('dramas');
  return dramas;
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
 * 初始化
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  await loadConfigFromJsonFiles();

  if (details.reason === 'install') {
    await clearAllDramas();

    // 打开设置页面
    chrome.tabs.create({ url: chrome.runtime.getURL('src/settings/settings.html') });
  }

  // 设置定时任务
  await setupAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadConfigFromJsonFiles();
  await setupAlarms();
});

// service worker 被唤醒时也恢复一次配置，确保 JSON 是配置源。
loadConfigFromJsonFiles().then(setupAlarms).catch(error => {
  console.error('[ShortScraping] 从 JSON 恢复配置失败:', error);
});

// SW 每次启动预热一次共享快照：扩展重载/同步服务重启后局域网共享页
// 立即有数据，无需等下一次抓取；服务端对相同内容不会广播刷新。
scheduleCsvSync();

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
 */
async function loadConfigFromJsonFiles() {
  const [tagConfigRaw, scheduleConfigRaw, translateConfigRaw, larkConfigRaw] = await Promise.all([
    fetchJsonFile('config/tag.json', null),
    fetchJsonFile('config/cron.json', ScheduleConfig.DEFAULT_CONFIG),
    fetchJsonFile('config/trans.json', DEFAULT_TRANSLATE_CONFIG),
    fetchJsonFile('config/lark.json', Lark.DEFAULT_CONFIG)
  ]);

  const scheduleConfig = ScheduleConfig.normalizeConfig(scheduleConfigRaw);
  const translateConfig = TranslateConfig.normalizeConfig(translateConfigRaw);
  const larkConfig = Lark.normalizeConfig(larkConfigRaw);

  // tag.json 读取失败（fetch 异常 / JSON 损坏 / 结构不是数组）≠ 用户清空订阅：
  // 保留 storage 里上一次的订阅并跳过 prune，避免把全部历史误清成空库。
  // 只有成功读到数组（含合法的空数组）才允许覆盖订阅并清理界外历史。
  let urlTags;
  if (Array.isArray(tagConfigRaw)) {
    urlTags = normalizeUrlTags(tagConfigRaw);
    await chrome.storage.local.set({
      urlTags,
      scheduleConfig,
      translateConfig,
      larkConfig
    });
    await runGuarded('订阅外历史清理', () => pruneDramasOutsideConfiguredUrls(urlTags));
  } else {
    const stored = await chrome.storage.local.get('urlTags');
    urlTags = Array.isArray(stored.urlTags) ? stored.urlTags : [];
    console.warn('[ShortScraping] tag.json 读取失败，保留上次订阅配置并跳过历史清理');
    await chrome.storage.local.set({ scheduleConfig, translateConfig, larkConfig });
  }

  // 水位线同步与一次性迁移各自兜底：任一抛错只记日志、下轮唤醒重试（各自的完成标记未置位）。
  // 它们的失败不能向上冒泡——setupAlarms 挂在本函数之后（顶层 .then 与 onInstalled/onStartup
  // 两条路都是先 load 再 setup），某迁移确定性抛错＝看门狗与定时任务一起装不上、用户以为在跑
  // 其实全停（2026-09-17 审计 H1）。配置种子 set 失败仍照旧向上传播：那是「配置没恢复成」。
  await runGuarded('群机器人水位线同步', () => syncBotWatermark(larkConfig));
  for (const [label, step] of [
    ['itemId/标签/未映射 fandom 迁移', runLegacyDramaMigrations],
    ['company 字段移除', dropCompanyField],
    ['半成品翻译复位', resetPartialTranslations],
    ['非中文译名复位', resetNonChineseTitleZh],
    ['ReelShort 播放页 URL 迁移', migrateReelshortEpisodeUrls],
    ['Shortical 规范 id 迁移', migrateShorticalCanonicalIds]
  ]) {
    await runGuarded(label, step);
  }

  console.log(`[ShortScraping] 已从 JSON 恢复配置：${urlTags.length} 个 URL，翻译模式=${translateConfig.translateMode}`);

  return { urlTags, scheduleConfig, translateConfig };
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
    console.warn(`[ShortScraping] 读取 ${fileName} 失败，使用默认配置:`, e.message);
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
    pruneDramasOutsideConfiguredUrls(changes.urlTags.newValue || []).catch(error => {
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
 */
function performScrape(options = {}) {
  activeScrapeCount++;
  schedulePostScrapeTranslateLoop();

  const run = scrapeQueue.then(() => performScrapeOnce(options));
  scrapeQueue = run.then(() => {}, () => {});
  return run.finally(() => {
    activeScrapeCount--;
  });
}

async function performScrapeOnce({ site = null } = {}) {
  console.log(site ? `[ShortScraping] 开始站点抓取: ${site}` : '[ShortScraping] 开始全量抓取...');

  try {
    const { urlTags = [] } = await chrome.storage.local.get('urlTags');
    let scrapeUrls = getConfiguredScrapeUrls(urlTags);
    if (site) {
      scrapeUrls = scrapeUrls.filter(url => siteOfUrl(url) === site);
    }

    if (scrapeUrls.length === 0) {
      console.log('[ShortScraping] 未配置抓取 URL，跳过抓取');
      return { urlCount: 0, totalNewCount: 0, results: [] };
    }

    // 订阅 URL 首轮只入库不推送：开轮时库里零条的订阅 URL 挂「进行中」，收轮时基线定在完成时刻。
    // 经队列读表顺带把缓存预热给随后的入库写，不多付一次全表读
    try {
      const populated = new Set(
        (await enqueueDramaWrite('订阅首轮判定', getDramasInQueue))
          .map(d => UrlMatch.normalizeListUrl(d.sourceListUrl))
          .filter(Boolean)
      );
      await markUrlBaselines(scrapeUrls.filter(url => !populated.has(UrlMatch.normalizeListUrl(url))));
    } catch (e) {
      console.warn('[ShortScraping] 订阅首轮基线标记失败（不影响抓取）:', e?.message || e);
    }

    let totalNewCount = 0;
    const results = [];

    for (const url of scrapeUrls) {
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

    await chrome.storage.local.set({
      lastScrape: new Date().toISOString()
    });

    // 抓取刚结束队列缓存必热：按最新订阅强制过一遍订阅外清理（零 storage 读），关掉
    // 「退订时抓取仍在飞、迟到的 saveDrama 把界外卡写回」的竞态——SW 唤醒的清理受
    // 指纹闸门约束，不会再兜这一手。重读 urlTags 而非用开轮时的快照，退订正是发生在
    // 这段时间里。失败只记日志，不影响本轮抓取结果。
    const { urlTags: latestUrlTags = [] } = await chrome.storage.local.get('urlTags');
    await pruneDramasOutsideConfiguredUrls(latestUrlTags, { force: true }).catch(e =>
      console.warn('[ShortScraping] 抓取后订阅外清理失败:', e?.message || e));

    if (totalNewCount > 0) {
      showNotification(`发现 ${totalNewCount} 部新短剧！`);
    }

    return { urlCount: scrapeUrls.length, totalNewCount, results };
  } catch (e) {
    console.error('[ShortScraping] 抓取失败:', e);
    throw e;
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

  return Array.from(new Set(urls));
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
 */
function pruneDramasOutsideConfiguredUrls(urlTags, { force = false } = {}) {
  return enqueueDramaWrite('清理非订阅来源', async () => {
    const fingerprint = configuredUrlFingerprint(urlTags);
    const { pruneFingerprint } = await chrome.storage.local.get('pruneFingerprint');
    if (!force && pruneFingerprint === fingerprint) return;

    const dramas = await getDramasInQueue();
    const filtered = filterDramasByConfiguredUrls(dramas, urlTags);

    if (filtered.length !== dramas.length) {
      await writeDramasInQueue(filtered, { pruneFingerprint: fingerprint });
      console.log(`[ShortScraping] 已清理 ${dramas.length - filtered.length} 条非订阅来源历史记录`);
    } else if (pruneFingerprint !== fingerprint) {
      await chrome.storage.local.set({ pruneFingerprint: fingerprint });
    }
  });
}

/**
 * 去重键字段更名迁移（2026-07-25）：历史条目 imdbId → itemId，值不变。
 * imdbId 这个名字今后仅指 IMDB 站点条目的 tt 值本身，不再指代全站点去重键。
 * 幂等：无旧字段时零写入；必须先于其它按 itemId 读数的迁移/清理执行。
 */
function migrateItemIdField() {
  return enqueueDramaWrite('去重键字段更名', async () => {
    const dramas = await getDramasInQueue();
    let changedCount = 0;

    const migrated = dramas.map(drama => {
      if (!drama || !('imdbId' in drama)) return drama;
      changedCount++;
      const { imdbId, ...rest } = drama;
      return { ...rest, itemId: rest.itemId || imdbId };
    });

    if (changedCount > 0) {
      await writeDramasInQueue(migrated);
      console.log(`[ShortScraping] 已迁移 ${changedCount} 条历史记录的去重键字段 imdbId -> itemId`);
    }
  });
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
async function dropCompanyField() {
  const { companyFieldDropped } = await chrome.storage.local.get('companyFieldDropped');
  if (companyFieldDropped) return;

  await enqueueDramaWrite('移除 company 字段', async () => {
    const dramas = await getDramasInQueue();
    let changedCount = 0;

    const cleaned = dramas.map(drama => {
      if (!drama || !('company' in drama)) return drama;
      changedCount++;
      const { company, ...rest } = drama;
      return rest;
    });

    if (changedCount > 0) {
      await writeDramasInQueue(cleaned);
      console.log(`[ShortScraping] 已从 ${changedCount} 条历史记录中移除 company 字段`);
    }
  });

  await chrome.storage.local.set({ companyFieldDropped: true });
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
async function resetPartialTranslations() {
  const { partialTranslationReset } = await chrome.storage.local.get('partialTranslationReset');
  if (partialTranslationReset) return;

  await enqueueDramaWrite('半成品翻译复位', async () => {
    const dramas = await getDramasInQueue();
    let changedCount = 0;

    const reset = dramas.map(drama => {
      if (!drama || drama.status !== 'trans') return drama;
      const needTitle = Boolean(String(drama.title || '').trim()) && !String(drama.titleZh || '').trim();
      const needDesc = Boolean(String(drama.description || '').trim()) && !String(drama.descriptionZh || '').trim();
      if (!needTitle && !needDesc) return drama;
      changedCount++;
      const { translateAttempts, ...rest } = drama;
      return { ...rest, status: 'new' };
    });

    if (changedCount > 0) {
      await writeDramasInQueue(reset);
      console.log(`[ShortScraping] 已把 ${changedCount} 条半成品翻译退回待翻译队列`);
    }
  });

  await chrome.storage.local.set({ partialTranslationReset: true });
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
async function resetNonChineseTitleZh() {
  const { nonChineseTitleZhReset } = await chrome.storage.local.get('nonChineseTitleZhReset');
  if (nonChineseTitleZhReset) return;

  await enqueueDramaWrite('非中文译名复位', async () => {
    const dramas = await getDramasInQueue();
    let changedCount = 0;

    const reset = dramas.map(drama => {
      if (!drama) return drama;
      const titleZh = String(drama.titleZh || '').trim();
      if (!titleZh || TranslateConfig.hasChineseChars(titleZh)) return drama;
      changedCount++;
      const { translateAttempts, ...rest } = drama;
      return { ...rest, titleZh: '', status: 'new' };
    });

    if (changedCount > 0) {
      await writeDramasInQueue(reset);
      console.log(`[ShortScraping] 已把 ${changedCount} 条非中文译名退回待翻译队列`);
    }
  });

  await chrome.storage.local.set({ nonChineseTitleZhReset: true });
}

/**
 * 存量数据显示标签迁移：历史条目 tags 中的 "RR" 统一改为 "RoyalRoad"。
 * 只碰 tags 显示标签，不碰去重键 itemId 的 rr 前缀。
 * 幂等：无变化时零写入；写回经 storage.onChanged 自动触发 CSV 同步。
 */
function migrateLegacyTags() {
  return enqueueDramaWrite('标签迁移', async () => {
    const dramas = await getDramasInQueue();
    let changedCount = 0;

    const migrated = dramas.map(drama => {
      if (!Array.isArray(drama.tags) || !drama.tags.includes('RR')) return drama;
      changedCount++;
      const tags = Array.from(new Set(drama.tags.map(tag => (tag === 'RR' ? 'RoyalRoad' : tag))));
      return { ...drama, tags };
    });

    if (changedCount > 0) {
      await writeDramasInQueue(migrated);
      console.log(`[ShortScraping] 已迁移 ${changedCount} 条历史记录的显示标签 RR -> RoyalRoad`);
    }
  });
}

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
      const response = await fetch(movieUrl, { headers: { 'Accept': 'text/html' } });
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
 * 解析逻辑与 content.js 的 readShorticalCanonicalSlugs 一致——SW 侧重写一份，同
 * migrateReelshortEpisodeUrls 在 SW 内重写 __NEXT_DATA__ 抽取的先例：为一条一次性迁移
 * 新立共享模块要同时改 manifest / importScripts / 各 HTML 顺序 / STATIC_ROUTES 四处，不划算。
 */
async function fetchShorticalCanonicalSlugs() {
  const response = await fetch('https://shortical.com/sitemaps/series.xml', { headers: { 'Accept': 'application/xml' } });
  if (!response.ok) throw new Error(`Shortical sitemap HTTP ${response.status}`);
  const xml = await response.text();
  const map = new Map();
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const slug = (match[1].match(/\/drama\/([^/?#]+)/) || [])[1] || '';
    if (!/-\d+$/.test(slug)) continue;
    const base = slug.replace(/-\d+$/, '');
    if (!map.has(base)) map.set(base, slug);   // 先到先得（实测 142 条基名零碰撞）
  }
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
 * 前缀集合必须与 content.js scrapePage 的未映射闸门同步（v1.6.9 加 ShortMax 的 smf-）。
 * 幂等：无匹配时零写入；写回经 storage.onChanged 自动触发 CSV 同步。
 */
const UNMAPPED_FANDOM_PREFIXES = ['mdf-', 'rsf-', 'smf-'];

function pruneUnmappedFandomEntries() {
  return enqueueDramaWrite('fandom 未映射清理', async () => {
    const dramas = await getDramasInQueue();
    const kept = dramas.filter(drama => {
      const key = String(drama.itemId || '');
      return !UNMAPPED_FANDOM_PREFIXES.some(prefix => key.startsWith(prefix));
    });

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
 * 在后台打开一个非活动标签页抓取，完成后关闭。
 */
async function scrapeUrlInTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });

  try {
    try {
      await waitForTabComplete(tab.id);
      // 给内容脚本一点注入和页面渲染时间
      await new Promise(resolve => setTimeout(resolve, 1500));
      return await chrome.tabs.sendMessage(tab.id, { action: 'scrape' });
    } catch (e) {
      // 快路径失败的两种实测场景，统一走「强制注入 + 轮询」兜底：
      // 1) 重媒体页（如 reelshort 首页视频横幅）在后台节流标签页里媒体加载不完，
      //    load 永不触发（status 恒 loading），冷缓存时 DOMContentLoaded（即
      //    document_end 注入时机）可晚于 147s → waitForTabComplete 超时；
      // 2) 扩展刚加载完的最初几秒，内容脚本注册未传播到新 renderer，页面正常
      //    complete 但接收端不存在 → 首次 sendMessage 失败。
      // scripting.executeScript 只要文档已提交即可注入（不等 DCL），
      // content.js 自带防重注入护栏，与 manifest 注入并存安全。
      console.warn(`[ShortScraping] ${e.message}，强制注入后轮询触发抓取: ${url}`);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        // 与 manifest content_scripts 的 js 数组保持一致：共享模块先于 content.js
        // （漏一个共享模块＝content.js 在兜底注入路径上直接 ReferenceError，
        //  而这条路径正是后台节流标签页的常态入口。unit-site-registry T4a/T4b 守着）
        files: ['src/shared/site-registry.js', 'src/shared/translate-config.js', 'src/content/content.js']
      }).catch(err => console.warn(`[ShortScraping] 强制注入失败（继续轮询）: ${err.message}`));
      return await sendScrapeWhenReady(tab.id);
    }
  } finally {
    if (tab.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

/**
 * 轮询向标签页发送抓取消息，直到 content script 就绪（接收端存在）或次数用尽。
 * 仅在 waitForTabComplete 超时后作为兜底路径使用。预算 40×3s=120s：后台节流
 * 标签页冷缓存加载 reelshort 这类重页时，DOMContentLoaded（即 document_end
 * 注入时机）实测可晚于 90s。
 */
async function sendScrapeWhenReady(tabId, attempts = 40, intervalMs = 3000) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, { action: 'scrape' });
    } catch (e) {
      if (i === attempts - 1) throw e;
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
  });
  return translateRun;
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

  try {
    const { translateConfig, urlTags = [] } = await chrome.storage.local.get(['translateConfig', 'urlTags']);
    const dramas = await getDramasSnapshot(); // 翻译线每轮扫描，缓存命中零全表读
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

    // 加载翻译模块
    await loadTranslator();

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

    // 回填一条翻译结果并计进度：按 drama.id 精确定位，不依赖数组顺序（批量保对应的锚点）
    //
    // 完成判据（「该翻的都翻出来了」）在 updateSingleDramaTranslation 队列内按合并后的
    // 记录统一计算：只回一半的留 status='new' 下轮补另一半（updated=false），不再像
    // 此前那样一律标 trans 把半成品永久定格。
    const applyOne = async (drama, result) => {
      const hasTranslation = Boolean(result?.title || result?.desc);
      if (hasTranslation) {
        const updated = await updateSingleDramaTranslation(drama.id, result, { fillOnly: true });
        progressedCount++;
        if (updated) {
          translatedCount++;
          // 触发点①：翻完一条即推（队列外，失败只记日志）。读回落库后的那条，
          // 卡片里才有刚写进去的译文。
          const saved = (await getDramasSnapshot()).find(d => d.id === drama.id);
          await maybeBotPush(saved);
        } else {
          console.warn(`[ShortScraping] 翻译只补到一半，保持待翻译状态下轮重试: ${drama.title}`);
        }
      } else {
        console.warn(`[ShortScraping] 翻译结果为空，保持待翻译状态: ${drama.title}`);
      }
      processedCount++;
    };

    const mode = config.translateMode;

    if (mode === 'ai') {
      // AI 模式：按内容长度动态打包（1–10 条/批），一次请求译多条，明显减少请求数
      const maxItems = Math.min(10, Math.max(1, Number(config.batchSize) || 10));
      const batches = buildTranslateBatches(newDramas, maxItems);
      console.log(`[ShortScraping] AI 批量翻译：${newDramas.length} 条分 ${batches.length} 批（每批≤${maxItems}）`);

      for (const chunk of batches) {
        let results;
        try {
          results = await Translator.translateBatchAI(chunk.map(d => ({ title: d.title, desc: d.description })));
        } catch (e) {
          console.warn('[ShortScraping] 批量翻译异常:', e);
          lastError = e?.message || String(e);
          results = chunk.map(() => ({ title: '', desc: '' }));
        }

        // 按批内下标 j 取 results[j]（translateBatchAI 保证等长、同序，缺失填空串）
        for (let j = 0; j < chunk.length; j++) {
          await applyOne(chunk[j], results[j] || { title: '', desc: '' });
        }

        // 一批一次心跳；不 await，同上下文 storage 写按序落库
        heartbeat();

        // 批间延迟避免接口限流
        await new Promise(r => setTimeout(r, config.delayMs ?? 200));
      }
    } else {
      // API 模式（MyMemory 等）无批量端点，保持逐条翻译
      for (const drama of newDramas) {
        let result = { title: '', desc: '' };
        try {
          result = await Translator.translateTitleAndDesc(drama.title, drama.description);
        } catch (e) {
          console.warn(`[ShortScraping] 翻译失败: ${drama.title}`, e);
        }
        await applyOne(drama, result);
        heartbeat();
        await new Promise(r => setTimeout(r, config.delayMs ?? 200));
      }
    }

    await chrome.storage.local.set({
      lastTranslate: new Date().toISOString()
    });

    console.log(`[ShortScraping] 翻译完成: ${translatedCount}/${newDramas.length}`);

    if (translatedCount > 0) {
      showNotification(`已翻译 ${translatedCount} 部短剧`);
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
 * 三个写入口（批量线 / translateSingle / applyTranslation）共用这一份判据，不由调用方各算。
 * 返回值＝是否收口为 trans（半成品返回 false；卡片不存在也返回 false）。
 */
function updateSingleDramaTranslation(dramaId, result, options = {}) {
  return enqueueDramaWrite('翻译更新', async () => {
    const dramas = await getDramasInQueue();
    const index = dramas.findIndex(d => d.id === dramaId);

    if (index === -1) return false;

    const current = dramas[index];
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

    // copy-on-write：缓存数组只读，不就地突变（快照读者可能正持有旧引用）
    const next = dramas.slice();
    const record = { ...current, titleZh, descriptionZh, status: done ? 'trans' : 'new' };
    if (done) {
      record.translatedAt = new Date().toISOString();
      delete record.translateAttempts;
    } else {
      record.translateAttempts = attempts;
    }
    next[index] = record;

    await writeDramasInQueue(next);
    return done;
  });
}

/**
 * 弹窗单卡 🌍 翻译（translateSingle 消息）：请求在 SW 内发起——弹窗一关页面即销毁，
 * 页内 fetch 随之中断，与 larkPush 走后台同理。消息只带 dramaId、按 id 从 storage
 * 取卡，不信任调用方传对象。落库复用 updateSingleDramaTranslation：不传 fillOnly
 * （重译的语义就是要覆盖），完成判据与批量线同口径——该翻的没翻全保持 status='new'、
 * translateAttempts 累加、达上限收口。空结果 / 接口异常一律 success:false 回传文案，
 * 卡片原样不动（与批量线「没回内容不写记录」一致）。
 */
async function handleTranslateSingle(dramaId) {
  const drama = (await getDramasSnapshot()).find(d => d.id === dramaId);
  if (!drama) {
    return { success: false, error: '未找到该卡片数据' };
  }

  try {
    await loadTranslator();
    const result = await Translator.translateTitleAndDesc(drama.title, drama.description);
    if (!result?.title && !result?.desc) {
      return { success: false, error: '翻译结果为空，请检查翻译接口配置或控制台错误' };
    }

    const done = await updateSingleDramaTranslation(dramaId, result);
    console.log(`[ShortScraping] 单卡翻译${done ? '完成' : '只补到一半'}: ${drama.title}`);
    return { success: true, complete: done };
  } catch (e) {
    console.warn('[ShortScraping] 单卡翻译失败:', e.message);
    return { success: false, error: e.message };
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
      const incoming = Array.isArray(drama.genres)
        ? [...new Set(drama.genres.map(v => String(v || '').trim()).filter(Boolean))]
        : [];
      const current = existing[index];
      const currentHas = Array.isArray(current.genres) && current.genres.length > 0;
      if (incoming.length > 0 && !currentHas) {
        const next = existing.slice();   // copy-on-write：队列缓存数组只读
        next[index] = { ...current, genres: incoming };
        await writeDramasInQueue(next);
      }
      return false;
    }

    await writeDramasInQueue([drama, ...existing], { lastScrape: new Date().toISOString() });
    return true;
  });
}

/**
 * 清空 dramas 表（仅安装初始化使用；弹窗「清除数据」入口已移除）。
 */
function clearAllDramas() {
  return enqueueDramaWrite('清空数据', () => writeDramasInQueue([], {
    lastScrape: null,
    lastTranslate: null
  }));
}

/**
 * 数据存档·导入恢复（设置页 importDramas 消息）：按 itemId 合并去重——已存在
 * 即跳过、不覆盖不做字段级补全（库内 new 条目翻译线会自愈补译；覆盖方向不可判定）。
 * 订阅范围外的条目在入口过滤并计入 outOfScope：SW 每次唤醒的
 * pruneDramasOutsideConfiguredUrls 会把界外条目静默删除，放进去也活不过下轮。
 * 合并后整表按 scrapedAt 降序重排（缺失排尾）——时间线渲染按数组序分组，
 * 单纯头插会让老条目挂在顶部日期组之后错乱；对头插维持的现库近似 no-op。
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
      added.push(normalized);
    }

    if (added.length > 0) {
      const merged = existing.concat(added);
      merged.sort((a, b) => {
        const ta = a.scrapedAt || '';
        const tb = b.scrapedAt || '';
        return tb < ta ? -1 : tb > ta ? 1 : 0; // ISO 串字典序＝时间序，降序，空串排尾
      });
      await writeDramasInQueue(merged);
    }

    return { added: added.length, duplicates, outOfScope, invalid, total: rawDramas.length };
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
      await writeDramasInQueue(kept); // 删除经 onChanged 自动触发 CSV 同步
    }

    return dryRun
      ? { matched, perSite, total: dramas.length, previewToken: currentToken }
      : { removed: matched, perSite, total: kept.length };
  });
}

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

  try {
    console.log('[ShortScraping] 抓取后翻译线启动');

    while (emptyScans < 3 && rounds < maxRounds) {
      rounds++;
      const result = await performTranslate();

      if (result?.pendingCount === 0) {
        if (activeScrapeCount > 0) {
          console.log('[ShortScraping] 当前无待翻译卡片，但抓取仍在进行，空扫描不计数');
        } else {
          emptyScans++;
          console.log(`[ShortScraping] 第 ${emptyScans}/3 次扫描无待翻译卡片`);
        }
      } else {
        emptyScans = 0;
        console.log(`[ShortScraping] 第 ${rounds} 轮翻译：待翻译 ${result?.pendingCount ?? '未知'}，完成 ${result?.translatedCount ?? 0}`);

        // 如果有待翻译但本轮一个都没翻成，仍按用户要求继续下一轮扫描；
        // maxRounds 会防止接口持续失败时无限循环。
      }

      if (emptyScans < 3) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (rounds >= maxRounds) {
      console.warn('[ShortScraping] 抓取后翻译线达到最大轮数，已停止');
    } else {
      console.log('[ShortScraping] 抓取后翻译线结束');
    }
  } finally {
    postScrapeTranslateRunning = false;
  }
}

/**
 * 加载翻译模块
 */
async function loadTranslator() {
  // Translator 模块已通过 manifest 导入
  if (typeof Translator === 'undefined') {
    console.error('[ShortScraping] Translator 模块未加载');
    throw new Error('Translator not loaded');
  }
}

/**
 * 将时间线数据同步到本地 CSV 服务。浏览器扩展无法直接写项目目录，
 * 因此需要运行 `node server/sync-server.js` 负责写入 db/timeline.csv。
 */
function scheduleCsvSync() {
  if (csvSyncTimer) clearTimeout(csvSyncTimer);
  csvSyncTimer = setTimeout(() => {
    csvSyncTimer = null;
    syncTimelineToCsv().catch(error => {
      console.warn('[ShortScraping] CSV 同步失败，请确认本地同步服务已启动:', error.message);
    });
  }, 500);
}

async function syncTimelineToCsv() {
  const { urlTags = [] } = await chrome.storage.local.get('urlTags');
  const dramas = await getDramasSnapshot();
  const configuredDramas = filterDramasByConfiguredUrls(dramas, urlTags);

  const serialized = JSON.stringify(configuredDramas);
  if (serialized === lastCsvSyncSerialized) {
    console.log('[ShortScraping] CSV 同步跳过：内容与上次成功推送一致');
    return;
  }

  const response = await fetch(CSV_SYNC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 字符串拼接复用 serialized，免对约 1.5MB 的数组做第二次 stringify
    body: `{"dramas":${serialized},"syncedAt":${JSON.stringify(new Date().toISOString())}}`
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  // 仅成功后记录签名——失败不记，下次触发照常重试
  lastCsvSyncSerialized = serialized;
  const result = await response.json();
  console.log(`[ShortScraping] CSV 同步完成：${result.count} 条 -> ${result.csvPath}`);
}

/* —— Lark 群机器人：有新内容即时推一张卡到群（v1.5.14） ——————————————
 *
 * 与 Base 工作流那条并存、互不影响：机器人免费无月度额度，管「实时知道」；
 * 工作流按「1 条记录＝1 次运行」计费，管「写进表」。
 *
 * 两个触发点互斥，所以**不需要持久的「已推送」标记**（沿用单卡推送的 YAGNI 边界）：
 *   ① 翻译线把一条从 new 补成 trans（走 AI 翻译的站点）；
 *   ② 抓取入库时该卡已是 trans（平台自带中文齐全，压根不进翻译线）。
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

async function processBotRetryQueue() {
  const state = await readBotState();
  const queue = Array.isArray(state.retryQueue) ? [...state.retryQueue] : [];
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

  await writeBotRetryQueue(remaining);
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

async function fetchDetailHtmlForContent(url) {
  const rule = typeof url === 'string' ? DETAIL_HTML_PROXY_RULES.find(r => r.pattern.test(url)) : null;
  if (!rule) {
    return { success: false, error: 'URL 不在代理白名单内' };
  }
  try {
    const response = await fetch(url, { headers: rule.headers });
    if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
    return { success: true, html: await response.text() };
  } catch (e) {
    return { success: false, error: e.message };
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
 * 监听消息
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'warmupCsvSync') {
    // 弹窗检测到同步服务健康时的补喂：服务启动晚于 SW 预热推送时，
    // 快照会一直空着，打开弹窗即可把当前时间线重新推给服务。
    // 必须先清内容签名强制推送——「服务重启丢快照 + SW 在世签名命中」
    // 的组合会让补喂被签名跳过、共享页永久空白
    lastCsvSyncSerialized = null;
    scheduleCsvSync();
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
    performScrape({ site: request.site }).then((summary) => {
      sendResponse({ success: true, summary });
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

  if (request.action === 'applyTranslation') {
    updateSingleDramaTranslation(request.dramaId, request.result).then((updated) => {
      sendResponse({ success: true, updated });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'importDramas') {
    importDramaRecords(request.dramas).then((result) => {
      sendResponse({ success: true, ...result });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'pruneDramas') {
    pruneDramaRecords(request).then((result) => {
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
