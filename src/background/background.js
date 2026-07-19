/**
 * ShortScraping Background Service Worker
 * 定时任务调度：抓取线 + 翻译线
 */

importScripts('../shared/url-match.js');
importScripts('../shared/translator.js');

// 定时任务默认配置。实际配置来自 config/cron.json。
const DEFAULT_SCHEDULE_CONFIG = {
  scheduleMode: 'interval',
  scrapeInterval: 6,
  translateInterval: 1,
  scrapeCron: '45 * * * *',
  translateCron: '50 * * * *'
};

// 翻译接口默认配置。实际配置来自 config/trans.json。
const DEFAULT_TRANSLATE_CONFIG = {
  translateMode: 'api',
  apiEndpoint: 'https://api.mymemory.translated.net/get',
  aiEndpoint: '',
  aiApiKey: '',
  aiModel: 'gpt-3.5-turbo',
  aiPrefixPrompt: '你是一位资深的影视爱好者，也观看过大量快节奏的短剧、短视频。请把片名和内容简介翻译为最有网感的中文表达。',
  batchSize: 10,
  delayMs: 200,
  requestTimeoutSec: 10
};

// 运行状态。抓取走串行队列：手动单站刷新与定时全量并发触发时排队执行，
// 避免双开同一 URL 的标签页；activeScrapeCount 覆盖「排队+运行中」的整个
// 区间，抓取后翻译线据此判断抓取是否仍在进行（此前用布尔，两次抓取并行时
// 先结束的一方会提前放行空扫描计数，导致后结束批次的新卡本轮不被翻译）。
let scrapeQueue = Promise.resolve();
let activeScrapeCount = 0;
let postScrapeTranslateTimer = null;
let postScrapeTranslateRunning = false;
let csvSyncTimer = null;

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
 * 从扩展 config 目录的 tag.json / cron.json / trans.json 恢复配置。
 */
async function loadConfigFromJsonFiles() {
  const [tagConfigRaw, scheduleConfigRaw, translateConfigRaw] = await Promise.all([
    fetchJsonFile('config/tag.json', null),
    fetchJsonFile('config/cron.json', DEFAULT_SCHEDULE_CONFIG),
    fetchJsonFile('config/trans.json', DEFAULT_TRANSLATE_CONFIG)
  ]);

  const scheduleConfig = { ...DEFAULT_SCHEDULE_CONFIG, ...scheduleConfigRaw };
  const translateConfig = { ...DEFAULT_TRANSLATE_CONFIG, ...translateConfigRaw };

  // tag.json 读取失败（fetch 异常 / JSON 损坏 / 结构不是数组）≠ 用户清空订阅：
  // 保留 storage 里上一次的订阅并跳过 prune，避免把全部历史误清成空库。
  // 只有成功读到数组（含合法的空数组）才允许覆盖订阅并清理界外历史。
  let urlTags;
  if (Array.isArray(tagConfigRaw)) {
    urlTags = normalizeUrlTags(tagConfigRaw);
    await chrome.storage.local.set({
      urlTags,
      scheduleConfig,
      translateConfig
    });
    await pruneDramasOutsideConfiguredUrls(urlTags);
  } else {
    const stored = await chrome.storage.local.get('urlTags');
    urlTags = Array.isArray(stored.urlTags) ? stored.urlTags : [];
    console.warn('[ShortScraping] tag.json 读取失败，保留上次订阅配置并跳过历史清理');
    await chrome.storage.local.set({ scheduleConfig, translateConfig });
  }

  await migrateLegacyTags();
  await migrateReelshortEpisodeUrls();
  await pruneUnmappedFandomEntries();

  console.log(`[ShortScraping] 已从 JSON 恢复配置：${urlTags.length} 个 URL，翻译模式=${translateConfig.translateMode}`);

  return { urlTags, scheduleConfig, translateConfig };
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

function normalizeUrlTags(rawTags) {
  if (!Array.isArray(rawTags)) return [];

  return rawTags
    .map(item => ({
      urlPattern: item.urlPattern || item.url,
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 3) : []
    }))
    .filter(item => item.urlPattern && item.tags.length > 0);
}

/**
 * 设置定时任务
 */
async function setupAlarms(options = {}) {
  const { force = false } = options;

  // 看门狗最先安装：即使后面的任务配置损坏，自愈通道也必须先就位。
  await ensureAlarm(WATCHDOG_ALARM_NAME, { periodInMinutes: WATCHDOG_INTERVAL_MINUTES });

  const { scheduleConfig } = await chrome.storage.local.get('scheduleConfig');
  const config = { ...DEFAULT_SCHEDULE_CONFIG, ...scheduleConfig };
  const scheduleMode = config.scheduleMode === 'cron' ? 'cron' : 'interval';

  // 逐任务独立安装：单个任务失败不连累其余任务
  for (const name of Object.keys(SCHEDULE_TASKS)) {
    try {
      await setupTaskAlarm(name, config, scheduleMode, force);
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

async function setupTaskAlarm(name, config, scheduleMode, force = false) {
  const task = SCHEDULE_TASKS[name];
  if (!task) return;

  if (scheduleMode === 'cron') {
    const cronExpression = config[task.cronKey];
    try {
      const nextRunAt = getNextCronRun(cronExpression);
      const nextRunLabel = new Date(nextRunAt).toLocaleString('zh-CN');

      await ensureCronAlarm(name, cronExpression, nextRunAt, force);

      console.log(`[ShortScraping] ${task.label} Cron 下一次执行: ${nextRunLabel} (${cronExpression})`);
      return;
    } catch (e) {
      // 非法/永不匹配的 cron 不能让任务静默消失：降级为间隔调度兜底
      console.error(`[ShortScraping] ${task.label} Cron 表达式无效（${cronExpression}），已降级为间隔调度:`, e?.message || e);
    }
  }

  const intervalHours = Number(config[task.intervalKey]) || DEFAULT_SCHEDULE_CONFIG[task.intervalKey];
  await ensureAlarm(name, {
    periodInMinutes: intervalHours * 60
  }, force);
}

async function ensureAlarm(name, alarmInfo, force = false) {
  const existing = await chrome.alarms.get(name);

  if (!force && existing && isSameAlarm(existing, alarmInfo)) {
    return;
  }

  await chrome.alarms.clear(name);
  chrome.alarms.create(name, alarmInfo);
}

async function ensureCronAlarm(name, cronExpression, nextRunAt, force = false) {
  const existing = await chrome.alarms.get(name);

  if (!force && existing && isFutureCronRunStillValid(existing.scheduledTime, cronExpression)) {
    return;
  }

  await chrome.alarms.clear(name);
  chrome.alarms.create(name, { when: nextRunAt });
}

function isFutureCronRunStillValid(scheduledTime, cronExpression) {
  if (typeof scheduledTime !== 'number' || scheduledTime <= Date.now()) {
    return false;
  }

  return matchesCron(new Date(scheduledTime), parseSimpleCron(cronExpression));
}

function isSameAlarm(existing, alarmInfo) {
  if (typeof alarmInfo.periodInMinutes === 'number') {
    return Math.abs((existing.periodInMinutes || 0) - alarmInfo.periodInMinutes) < 0.001;
  }

  if (typeof alarmInfo.when === 'number') {
    // Chrome 保存的 scheduledTime 与计算值可能有毫秒级差异，1 秒以内视为同一个计划。
    return Math.abs((existing.scheduledTime || 0) - alarmInfo.when) < 1000;
  }

  return false;
}

function getNextCronRun(expression, fromDate = new Date()) {
  const cron = parseSimpleCron(expression);
  const candidate = new Date(fromDate.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // 最多向后查找 366 天，避免非法表达式造成无限循环。
  const maxAttempts = 366 * 24 * 60;
  for (let i = 0; i < maxAttempts; i++) {
    if (matchesCron(candidate, cron)) {
      return candidate.getTime();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`无法计算下一次 Cron 执行时间: ${expression}`);
}

function parseSimpleCron(expression) {
  if (typeof expression !== 'string') {
    throw new Error('Cron 表达式必须是字符串');
  }

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron 表达式需要 5 段: ${expression}`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const cron = {
    minute: parseCronField(minute, 0, 59, '分钟'),
    hour: parseCronField(hour, 0, 23, '小时'),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31, '日期'),
    month: parseCronField(month, 1, 12, '月份'),
    dayOfWeek: parseCronField(dayOfWeek, 0, 7, '星期')
  };

  // 日期×月份组合可行性：星期不受限时，纯日期约束必须能落在所选月份里
  // （如 "0 0 31 2 *" 永不匹配；若不在解析期拦截，getNextCronRun 要空转
  // 366 天×1440 分钟才报错，且每次 SW 唤醒都重来一遍）。
  // 2 月按 29 天算：29 号在闰年合法，具体是否可达交给 getNextCronRun 判定。
  if (!cron.dayOfMonth.any && cron.dayOfWeek.any) {
    const MAX_DAY_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const months = cron.month.any ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [...cron.month.values];
    const feasible = months.some(m => [...cron.dayOfMonth.values].some(d => d <= MAX_DAY_IN_MONTH[m - 1]));
    if (!feasible) {
      throw new Error(`日期与月份组合永不匹配: ${expression}`);
    }
  }

  return cron;
}

function parseCronField(field, min, max, label) {
  if (field === '*') return { any: true, values: new Set() };

  const values = new Set();
  for (const part of field.split(',')) {
    const stepSegments = part.split('/');
    if (stepSegments.length > 2) {
      throw new Error(`${label}字段格式错误: ${field}`);
    }

    const base = stepSegments[0];
    const step = stepSegments.length === 2 ? Number(stepSegments[1]) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`${label}字段步长错误: ${field}`);
    }

    let rangeStart;
    let rangeEnd;
    if (base === '*') {
      rangeStart = min;
      rangeEnd = max;
    } else if (base.includes('-')) {
      const [startText, endText] = base.split('-');
      rangeStart = Number(startText);
      rangeEnd = Number(endText);
    } else {
      rangeStart = Number(base);
      rangeEnd = Number(base);
    }

    if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
      throw new Error(`${label}字段超出范围: ${field}`);
    }

    for (let value = rangeStart; value <= rangeEnd; value += step) {
      values.add(label === '星期' && value === 7 ? 0 : value);
    }
  }

  return { any: false, values };
}

function matchesCron(date, cron) {
  const dayOfMonthMatches = matchesCronField(date.getDate(), cron.dayOfMonth);
  const dayOfWeekMatches = matchesCronField(date.getDay(), cron.dayOfWeek);

  let dayMatches;
  if (cron.dayOfMonth.any && cron.dayOfWeek.any) {
    dayMatches = true;
  } else if (cron.dayOfMonth.any) {
    dayMatches = dayOfWeekMatches;
  } else if (cron.dayOfWeek.any) {
    dayMatches = dayOfMonthMatches;
  } else {
    // 与常见 cron 语义保持一致：日期和星期同时受限时，任一字段匹配即可。
    dayMatches = dayOfMonthMatches || dayOfWeekMatches;
  }

  return matchesCronField(date.getMinutes(), cron.minute)
    && matchesCronField(date.getHours(), cron.hour)
    && matchesCronField(date.getMonth() + 1, cron.month)
    && dayMatches;
}

function matchesCronField(value, field) {
  return field.any || field.values.has(value);
}

async function rescheduleCronTask(name) {
  const { scheduleConfig } = await chrome.storage.local.get('scheduleConfig');
  const config = { ...DEFAULT_SCHEDULE_CONFIG, ...scheduleConfig };

  if (config.scheduleMode !== 'cron') return;

  await setupTaskAlarm(name, config, 'cron', true);
}

/**
 * 监听闹钟
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log(`[ShortScraping] 闹钟触发: ${alarm.name}`);

  if (alarm.name === WATCHDOG_ALARM_NAME) {
    // 看门狗：SW 被唤醒后强制重建所有 cron alarm，修复 SW 意外退出导致续排丢失的问题。
    await setupAlarms({ force: true }).catch(e =>
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

    let totalNewCount = 0;
    const results = [];

    for (const url of scrapeUrls) {
      try {
        const response = await scrapeUrlInTab(url);
        if (response?.success) {
          const newCount = (response.data || []).filter(d => d.status === 'new').length;
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

    await chrome.storage.local.set({
      lastScrape: new Date().toISOString()
    });

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
 * 按域名判断订阅 URL 所属站点，与 content.js 的 detectSite 同规则。
 */
function siteOfUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.endsWith('imdb.com')) return 'imdb';
    if (hostname === 'store.steampowered.com') return 'steam';
    if (hostname.endsWith('royalroad.com')) return 'royalroad';
    if (hostname.endsWith('my-drama.com')) return 'mydrama';
    if (hostname.endsWith('reelshort.com')) return 'reelshort';
    if (hostname.endsWith('dramashorts.io')) return 'dramashorts';
    if (hostname.endsWith('netshort.com')) return 'netshort';
  } catch (e) {
    // 无效 URL 视为不属于任何站点
  }
  return null;
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

function pruneDramasOutsideConfiguredUrls(urlTags) {
  return enqueueDramaWrite('清理非订阅来源', async () => {
    const { dramas = [] } = await chrome.storage.local.get('dramas');
    const filtered = filterDramasByConfiguredUrls(dramas, urlTags);

    if (filtered.length !== dramas.length) {
      await chrome.storage.local.set({ dramas: filtered });
      console.log(`[ShortScraping] 已清理 ${dramas.length - filtered.length} 条非订阅来源历史记录`);
    }
  });
}

/**
 * 存量数据显示标签迁移：历史条目 tags 中的 "RR" 统一改为 "RoyalRoad"。
 * 只碰 tags 显示标签，不碰去重键 imdbId 的 rr 前缀。
 * 幂等：无变化时零写入；写回经 storage.onChanged 自动触发 CSV 同步。
 */
function migrateLegacyTags() {
  return enqueueDramaWrite('标签迁移', async () => {
    const { dramas = [] } = await chrome.storage.local.get('dramas');
    let changedCount = 0;

    const migrated = dramas.map(drama => {
      if (!Array.isArray(drama.tags) || !drama.tags.includes('RR')) return drama;
      changedCount++;
      const tags = Array.from(new Set(drama.tags.map(tag => (tag === 'RR' ? 'RoyalRoad' : tag))));
      return { ...drama, tags };
    });

    if (changedCount > 0) {
      await chrome.storage.local.set({ dramas: migrated });
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
  const { rsEpisodeUrlMigrated, dramas = [] } = await chrome.storage.local.get(['rsEpisodeUrlMigrated', 'dramas']);
  if (rsEpisodeUrlMigrated) return;

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
    if (nextUrl !== drama.url) urlById.set(drama.imdbId, nextUrl);
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  return enqueueDramaWrite('ReelShort 播放页迁移', async () => {
    const { dramas: current = [] } = await chrome.storage.local.get('dramas');
    let changedCount = 0;
    const migrated = current.map(drama => {
      const nextUrl = urlById.get(drama.imdbId);
      if (!nextUrl || drama.url === nextUrl) return drama;
      changedCount++;
      return { ...drama, url: nextUrl };
    });
    const payload = changedCount > 0
      ? { dramas: migrated, rsEpisodeUrlMigrated: true }
      : { rsEpisodeUrlMigrated: true };
    await chrome.storage.local.set(payload);
    console.log(`[ShortScraping] ReelShort 播放页迁移完成：改写 ${changedCount} 条（候选 ${candidates.length}）`);
  });
}

/**
 * 清理 fandom 未映射条目（imdbId 为 mdf-/rsf- 临时键；带连字符，与 md+UUID、
 * rs+hex 的正式键无歧义）：v1.4.8 起内容脚本对映射失败的 fandom 条目不再入库
 * （scrapePage 未映射闸门，下轮抓取自动重试），存量由此处一并清除。
 * 幂等：无匹配时零写入；写回经 storage.onChanged 自动触发 CSV 同步。
 */
function pruneUnmappedFandomEntries() {
  return enqueueDramaWrite('fandom 未映射清理', async () => {
    const { dramas = [] } = await chrome.storage.local.get('dramas');
    const kept = dramas.filter(drama => {
      const key = String(drama.imdbId || '');
      return !key.startsWith('mdf-') && !key.startsWith('rsf-');
    });

    if (kept.length !== dramas.length) {
      await chrome.storage.local.set({ dramas: kept });
      console.log(`[ShortScraping] 已清理 ${dramas.length - kept.length} 条 fandom 未映射条目`);
    }
  });
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
        files: ['src/content/content.js']
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
  let runStartedAt = null;
  let runError = null;
  let stateWritten = false;
  let lastError = null;

  try {
    const { dramas = [], translateConfig, urlTags = [] } = await chrome.storage.local.get(['dramas', 'translateConfig', 'urlTags']);
    const config = { ...DEFAULT_TRANSLATE_CONFIG, ...translateConfig };
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
    const applyOne = async (drama, result) => {
      const hasTranslation = Boolean(result?.title || result?.desc);
      if (hasTranslation) {
        const updated = await updateSingleDramaTranslation(drama.id, result);
        if (updated) translatedCount++;
      } else {
        console.warn(`[ShortScraping] 翻译结果为空，保持待翻译状态: ${drama.title}`);
      }
      processedCount++;
    };

    const mode = config.translateMode || config.mode || 'api';

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

    // 有待翻译却一条都没翻成＝接口/配置有问题：把错误写进 summary，
    // 弹窗据此显示 ❌ 而不是误导性的 ✅「成功翻译 0 条」。
    if (translatedCount === 0 && pendingCount > 0) {
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

/**
 * 更新单条翻译结果。读改写在单写者队列内执行，不会覆盖并行提交的新卡片。
 */
function updateSingleDramaTranslation(dramaId, result) {
  return enqueueDramaWrite('翻译更新', async () => {
    const { dramas = [] } = await chrome.storage.local.get('dramas');
    const index = dramas.findIndex(d => d.id === dramaId);

    if (index === -1) return false;

    dramas[index] = {
      ...dramas[index],
      titleZh: result.title || dramas[index].titleZh,
      descriptionZh: result.desc || dramas[index].descriptionZh,
      status: 'trans',
      translatedAt: new Date().toISOString()
    };

    await chrome.storage.local.set({ dramas });
    return true;
  });
}

/**
 * 保存一张新卡（内容脚本经 saveDrama 消息提交）。去重键 imdbId 的权威判定
 * 在队列内完成，两个标签页并发抓到同一条也只会入库一次。
 */
function saveDramaRecord(drama) {
  return enqueueDramaWrite('保存新卡', async () => {
    const { dramas: existing = [] } = await chrome.storage.local.get('dramas');

    if (existing.some(d => d.imdbId === drama.imdbId)) {
      return false;
    }

    await chrome.storage.local.set({
      dramas: [drama, ...existing],
      lastScrape: new Date().toISOString()
    });

    return true;
  });
}

/**
 * 清空 dramas 表（仅安装初始化使用；弹窗「清除数据」入口已移除）。
 */
function clearAllDramas() {
  return enqueueDramaWrite('清空数据', () => chrome.storage.local.set({
    dramas: [],
    lastScrape: null,
    lastTranslate: null
  }));
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
  const { dramas = [], urlTags = [] } = await chrome.storage.local.get(['dramas', 'urlTags']);
  const configuredDramas = filterDramasByConfiguredUrls(dramas, urlTags);

  const response = await fetch(CSV_SYNC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dramas: configuredDramas, syncedAt: new Date().toISOString() })
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const result = await response.json();
  console.log(`[ShortScraping] CSV 同步完成：${result.count} 条 -> ${result.csvPath}`);
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
    // 快照会一直空着，打开弹窗即可把当前时间线重新推给服务
    scheduleCsvSync();
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'updateAlarms') {
    setupAlarms({ force: Boolean(request.force) }).then(() => {
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
    }).catch((error) => {
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
});

console.log('[ShortScraping] 后台服务已启动');
