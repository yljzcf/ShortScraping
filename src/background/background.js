/**
 * ShortScraping Background Service Worker
 * 定时任务调度：抓取线 + 翻译线
 */

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
  aiPrefixPrompt: '你是一位资深的影视爱好者，也观看过大量快节奏的短剧、短视频。请帮我将以下片名和内容简介翻译为最有网感的中文表达。输出格式为json结构，{"片名":"xxx","简介":"xxx"}。需要你翻译的内容为：',
  batchSize: 5,
  delayMs: 200,
  requestTimeoutSec: 10
};

// 运行状态
let scrapeInProgress = false;
let postScrapeTranslateTimer = null;
let postScrapeTranslateRunning = false;
let csvSyncTimer = null;

const CSV_SYNC_ENDPOINT = 'http://127.0.0.1:31919/sync';
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

/**
 * 从扩展 config 目录的 tag.json / cron.json / trans.json 恢复配置。
 */
async function loadConfigFromJsonFiles() {
  const [tagConfig, scheduleConfigRaw, translateConfigRaw] = await Promise.all([
    fetchJsonFile('config/tag.json', []),
    fetchJsonFile('config/cron.json', DEFAULT_SCHEDULE_CONFIG),
    fetchJsonFile('config/trans.json', DEFAULT_TRANSLATE_CONFIG)
  ]);

  const urlTags = normalizeUrlTags(tagConfig);
  const scheduleConfig = { ...DEFAULT_SCHEDULE_CONFIG, ...scheduleConfigRaw };
  const translateConfig = { ...DEFAULT_TRANSLATE_CONFIG, ...translateConfigRaw };

  await chrome.storage.local.set({
    urlTags,
    scheduleConfig,
    translateConfig
  });

  await pruneDramasOutsideConfiguredUrls(urlTags);
  await migrateLegacyTags();

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
  const { scheduleConfig } = await chrome.storage.local.get('scheduleConfig');
  const config = { ...DEFAULT_SCHEDULE_CONFIG, ...scheduleConfig };
  const scheduleMode = config.scheduleMode === 'cron' ? 'cron' : 'interval';

  await setupTaskAlarm('scrape-task', config, scheduleMode, force);
  await setupTaskAlarm('translate-task', config, scheduleMode, force);
  await ensureAlarm(WATCHDOG_ALARM_NAME, { periodInMinutes: WATCHDOG_INTERVAL_MINUTES });

  await chrome.storage.local.set({
    alarmScheduleSignature: getScheduleSignature(config)
  });

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
    const nextRunAt = getNextCronRun(cronExpression);
    const nextRunLabel = new Date(nextRunAt).toLocaleString('zh-CN');

    await ensureCronAlarm(name, cronExpression, nextRunAt, force);

    console.log(`[ShortScraping] ${task.label} Cron 下一次执行: ${nextRunLabel} (${cronExpression})`);
    return;
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

function getScheduleSignature(config) {
  const scheduleMode = config.scheduleMode === 'cron' ? 'cron' : 'interval';
  if (scheduleMode === 'cron') {
    return JSON.stringify({
      scheduleMode,
      scrapeCron: config.scrapeCron,
      translateCron: config.translateCron
    });
  }

  return JSON.stringify({
    scheduleMode,
    scrapeInterval: config.scrapeInterval,
    translateInterval: config.translateInterval
  });
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
  return {
    minute: parseCronField(minute, 0, 59, '分钟'),
    hour: parseCronField(hour, 0, 23, '小时'),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31, '日期'),
    month: parseCronField(month, 1, 12, '月份'),
    dayOfWeek: parseCronField(dayOfWeek, 0, 7, '星期')
  };
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
    await setupAlarms({ force: true });
    return;
  }

  try {
    if (alarm.name === 'scrape-task') {
      await performScrape();
    } else if (alarm.name === 'translate-task') {
      await performTranslate();
    }
  } finally {
    await rescheduleCronTask(alarm.name);
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
 * 执行抓取任务。site 给定时（imdb / steam / royalroad）只抓该站点的订阅 URL。
 */
async function performScrape({ site = null } = {}) {
  console.log(site ? `[ShortScraping] 开始站点抓取: ${site}` : '[ShortScraping] 开始全量抓取...');
  scrapeInProgress = true;
  schedulePostScrapeTranslateLoop();

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
  } finally {
    scrapeInProgress = false;
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

  return (dramas || []).filter(drama => {
    if (!drama.sourceListUrl) return false;
    return configuredUrls.some(url => drama.sourceListUrl === url || drama.sourceListUrl.startsWith(url));
  });
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
 * 等待标签页加载完成。
 */
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
 * 执行翻译任务
 */
async function performTranslate() {
  console.log('[ShortScraping] 开始翻译检查...');

  try {
    const { dramas = [], translateConfig, urlTags = [] } = await chrome.storage.local.get(['dramas', 'translateConfig', 'urlTags']);
    const config = { ...DEFAULT_TRANSLATE_CONFIG, ...translateConfig };
    const configuredDramas = filterDramasByConfiguredUrls(dramas, urlTags);
    const newDramas = configuredDramas.filter(d => d.status === 'new');

    if (newDramas.length === 0) {
      console.log('[ShortScraping] 没有需要翻译的内容');
      return { pendingCount: 0, translatedCount: 0 };
    }

    console.log(`[ShortScraping] 发现 ${newDramas.length} 条待翻译`);

    // 加载翻译模块
    await loadTranslator();

    // 翻译每条记录。注意：抓取线可能正在并行写入新卡片，
    // 所以不能在这里把开头读取到的 dramas 快照整体写回，否则会覆盖抓取线新增内容。
    let translatedCount = 0;

    for (const drama of newDramas) {
      try {
        const result = await Translator.translateTitleAndDesc(drama.title, drama.description);
        const hasTranslation = Boolean(result?.title || result?.desc);

        if (!hasTranslation) {
          console.warn(`[ShortScraping] 翻译结果为空，保持待翻译状态: ${drama.title}`);
          continue;
        }

        const updated = await updateSingleDramaTranslation(drama.id, result);
        if (updated) translatedCount++;

        // 延迟避免 API 限制
        await new Promise(r => setTimeout(r, config.delayMs || 300));
      } catch (e) {
        console.warn(`[ShortScraping] 翻译失败: ${drama.title}`, e);
      }
    }

    await chrome.storage.local.set({
      lastTranslate: new Date().toISOString()
    });

    console.log(`[ShortScraping] 翻译完成: ${translatedCount}/${newDramas.length}`);

    if (translatedCount > 0) {
      showNotification(`已翻译 ${translatedCount} 部短剧`);
    }

    return { pendingCount: newDramas.length, translatedCount };
  } catch (e) {
    console.error('[ShortScraping] 翻译任务失败:', e);
    return { pendingCount: null, translatedCount: 0, error: e.message };
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
        if (scrapeInProgress) {
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
    performTranslate().then((summary) => {
      sendResponse({ success: true, summary });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
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

  if (request.action === 'getConfig') {
    chrome.storage.local.get(['scheduleConfig', 'translateConfig'], (result) => {
      sendResponse({
        scheduleConfig: { ...DEFAULT_SCHEDULE_CONFIG, ...result.scheduleConfig },
        translateConfig: { ...DEFAULT_TRANSLATE_CONFIG, ...result.translateConfig }
      });
    });
    return true;
  }
});

console.log('[ShortScraping] 后台服务已启动');
