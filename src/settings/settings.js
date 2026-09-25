/**
 * ShortScraping Settings Script
 * 配置源：config/tag.json / config/cron.json / config/trans.json / config/lark.json
 */

(function() {
  'use strict';

  const SYNC_BASE_URL = 'http://127.0.0.1:31919';
  const SYNC_HEALTH_URL = `${SYNC_BASE_URL}/health`;
  const SUBSCRIPTION_CATALOG_FILE = 'config/tag.example.json';
  // 「本地配置领先于文件」标记 { tag?, trans?, lark?, cron? }，与后台 loadConfigFromJsonFiles 共用（见 configAheadPatch）
  const CONFIG_AHEAD_KEY = 'configAheadOfFile';
  // 后台订阅外清理的回收站 [{ at, reason, urls, dramas }]（新批在末尾、最多 3 批），由后台写入，这里只读与导出
  const PRUNE_TRASH_KEY = 'pruneTrash';

  // tag = 该站点在订阅 tags 里的站点自身标签，页面上隐藏不显示（仅展示层，保存数据不变）。
  // 站点清单/显示名从 site-registry.js 派生（label 与 tag 历来同值，icon 按 site 命名）；
  // v1.5.11 起顺序按 SITE_GROUPS（短剧组在最前），与弹窗头部的分组顺序一致
  const SUBSCRIPTION_SITE_GROUPS = SiteRegistry.SITE_GROUPS.flatMap(group => group.sites).map(site => ({
    site,
    label: SiteRegistry.SOURCE_NAMES[site],
    tag: SiteRegistry.SOURCE_NAMES[site],
    icon: `assets/icons/site-${site}.png`
  }));

  const DEFAULT_TRANSLATE_CONFIG = TranslateConfig.DEFAULT_CONFIG;

  const state = {
    urlTags: [],
    subscriptionCatalog: [],
    legacyUrlTags: [],
    // 分组代表图标的固定项 { [group]: site }；缺席＝自动（该组最近有更新的站点）
    groupPins: {},
    scheduleConfig: { ...ScheduleConfig.DEFAULT_CONFIG },
    translateConfig: { ...DEFAULT_TRANSLATE_CONFIG },
    larkConfig: { ...Lark.DEFAULT_CONFIG }
  };

  const elements = {};

  function init() {
    cacheElements();
    bindEvents();
    renderPruneSites();
    renderLarkExportSites();
    refreshLarkExportHint();
    refreshPruneTrashButton();
    bindStorageEvents();
    loadCurrentConfig();
    checkSyncServiceStatus();
  }

  function cacheElements() {
    elements.tabs = Array.from(document.querySelectorAll('.tab-btn'));
    elements.panels = Array.from(document.querySelectorAll('.tab-panel'));

    elements.buttons = {
      reloadTop: document.getElementById('btnReloadTop'),
      reload: document.getElementById('btnReload'),
      openTag: document.getElementById('btnOpenTag'),
      openSchedule: document.getElementById('btnOpenSchedule'),
      openTrans: document.getElementById('btnOpenTrans'),
      reloadSubscriptions: document.getElementById('btnReloadSubscriptions'),
      saveSubscriptions: document.getElementById('btnSaveSubscriptions'),
      openTagFromSubscriptions: document.getElementById('btnOpenTagFromSubscriptions'),
      openScheduleFromSchedule: document.getElementById('btnOpenScheduleFromSchedule'),
      reloadTranslate: document.getElementById('btnReloadTranslate'),
      saveTranslate: document.getElementById('btnSaveTranslate'),
      openTransFromTranslate: document.getElementById('btnOpenTransFromTranslate'),
      openLark: document.getElementById('btnOpenLark'),
      reloadLark: document.getElementById('btnReloadLark'),
      saveLark: document.getElementById('btnSaveLark'),
      openLarkFromLark: document.getElementById('btnOpenLarkFromLark'),
      larkTestSend: document.getElementById('btnLarkTestSend'),
      larkBotTestSend: document.getElementById('btnLarkBotTestSend'),
      checkSync: document.getElementById('btnCheckSync')
    };

    elements.configSummary = document.getElementById('configSummary');
    elements.groupPinRows = document.getElementById('groupPinRows');
    elements.subscriptionList = document.getElementById('subscriptionList');
    elements.subscriptionEmpty = document.getElementById('subscriptionEmpty');
    elements.subscriptionCount = document.getElementById('subscriptionCount');
    elements.status = document.getElementById('statusMsg');
    elements.translateForm = {
      mode: document.getElementById('translateMode'),
      apiSection: document.getElementById('apiModeSection'),
      aiSection: document.getElementById('aiModeSection'),
      apiEndpoint: document.getElementById('apiEndpoint'),
      aiEndpoint: document.getElementById('aiEndpoint'),
      aiApiKey: document.getElementById('aiApiKey'),
      aiModel: document.getElementById('aiModel'),
      aiPrefixPrompt: document.getElementById('aiPrefixPrompt'),
      batchSize: document.getElementById('batchSize'),
      delayMs: document.getElementById('delayMs'),
      requestTimeoutSec: document.getElementById('requestTimeoutSec')
    };
    elements.larkForm = {
      webhookUrl: document.getElementById('larkWebhookUrl'),
      requestTimeoutSec: document.getElementById('larkRequestTimeoutSec'),
      botWebhookUrl: document.getElementById('larkBotWebhookUrl'),
      botEnabled: document.getElementById('larkBotEnabled'),
      botHint: document.getElementById('larkBotHint'),
      feishuAppId: document.getElementById('larkFeishuAppId'),
      feishuAppSecret: document.getElementById('larkFeishuAppSecret')
    };
    elements.scheduleForm = {
      mode: document.getElementById('scheduleModeSelect'),
      intervalSection: document.getElementById('intervalModeSection'),
      cronSection: document.getElementById('cronModeSection'),
      scrapeInterval: document.getElementById('scrapeIntervalInput'),
      translateInterval: document.getElementById('translateIntervalInput'),
      intervalPreview: document.getElementById('intervalPreview'),
      scrapeCron: document.getElementById('scrapeCronInput'),
      translateCron: document.getElementById('translateCronInput'),
      scrapeCronPreview: document.getElementById('scrapeCronPreview'),
      translateCronPreview: document.getElementById('translateCronPreview'),
      save: document.getElementById('btnSaveSchedule'),
      reload: document.getElementById('btnReloadSchedule')
    };
    elements.syncService = {
      container: document.getElementById('syncServiceStatus'),
      text: document.getElementById('syncServiceText'),
      archiveInfo: document.getElementById('archiveInfo')
    };
    elements.archive = {
      exportJson: document.getElementById('btnExportJson'),
      exportCsv: document.getElementById('btnExportCsv'),
      importJson: document.getElementById('btnImportJson'),
      importFile: document.getElementById('importFileInput'),
      exportPruneTrash: document.getElementById('btnExportPruneTrash'),
      pruneSiteList: document.getElementById('pruneSiteList'),
      pruneBeforeDate: document.getElementById('pruneBeforeDate'),
      prunePreview: document.getElementById('btnPrunePreview'),
      pruneConfirm: document.getElementById('btnPruneConfirm'),
      pruneResult: document.getElementById('pruneResult'),
      larkExportSiteList: document.getElementById('larkExportSiteList'),
      larkExportSinceDate: document.getElementById('larkExportSinceDate'),
      larkExportCopy: document.getElementById('btnLarkExportCopy'),
      larkExportUndo: document.getElementById('btnLarkExportUndo'),
      larkExportHint: document.getElementById('larkExportHint')
    };
  }

  function bindEvents() {
    elements.tabs.forEach(button => {
      button.addEventListener('click', () => switchTab(button.dataset.tab));
    });

    bindClick(elements.buttons.reloadTop, reloadConfig);
    bindClick(elements.buttons.reload, reloadConfig);
    bindClick(elements.buttons.openTag, () => openConfigFile('config/tag.json'));
    bindClick(elements.buttons.openSchedule, () => openConfigFile('config/cron.json'));
    bindClick(elements.buttons.openTrans, () => openConfigFile('config/trans.json'));
    bindClick(elements.buttons.reloadSubscriptions, reloadSubscriptionsFromFile);
    bindClick(elements.buttons.saveSubscriptions, saveSubscriptions);
    bindClick(elements.buttons.openTagFromSubscriptions, () => openConfigFile('config/tag.json'));
    bindClick(elements.buttons.openScheduleFromSchedule, () => openConfigFile('config/cron.json'));
    bindClick(elements.buttons.reloadTranslate, reloadTranslateFromFile);
    bindClick(elements.buttons.saveTranslate, saveTranslateConfig);
    bindClick(elements.buttons.openTransFromTranslate, () => openConfigFile('config/trans.json'));
    bindClick(elements.buttons.openLark, () => openConfigFile('config/lark.json'));
    bindClick(elements.buttons.reloadLark, reloadLarkFromFile);
    bindClick(elements.buttons.saveLark, saveLarkConfig);
    bindClick(elements.buttons.openLarkFromLark, () => openConfigFile('config/lark.json'));
    bindClick(elements.buttons.larkTestSend, handleLarkTestSend);
    bindClick(elements.buttons.larkBotTestSend, handleLarkBotTestSend);
    if (elements.larkForm?.botEnabled) {
      elements.larkForm.botEnabled.addEventListener('change', refreshBotHint);
    }
    bindClick(elements.buttons.checkSync, checkSyncServiceStatus);

    // 数据存档：导出/导入/两段式清理
    bindClick(elements.archive.exportJson, handleExportJson);
    bindClick(elements.archive.exportCsv, handleExportCsv);
    bindClick(elements.archive.importJson, () => elements.archive.importFile.click());
    if (elements.archive.importFile) {
      elements.archive.importFile.addEventListener('change', handleImportFile);
    }
    bindClick(elements.archive.exportPruneTrash, handleExportPruneTrash);
    bindClick(elements.archive.prunePreview, handlePrunePreview);
    bindClick(elements.archive.pruneConfirm, handlePruneConfirm);
    // 清理条件任何变更即作废已确认的预览（防「预览 A 条件、删除 B 条件」）
    if (elements.archive.pruneSiteList) {
      elements.archive.pruneSiteList.addEventListener('change', resetPruneConfirm);
    }
    if (elements.archive.pruneBeforeDate) {
      elements.archive.pruneBeforeDate.addEventListener('input', resetPruneConfirm);
    }
    bindClick(elements.archive.larkExportCopy, handleLarkExportCopy);
    bindClick(elements.archive.larkExportUndo, handleLarkExportUndo);

    // 翻译模式切换时只显示当前模式的配置区（隐藏区块的值保留，切回即恢复）
    if (elements.translateForm?.mode) {
      elements.translateForm.mode.addEventListener('change', updateTranslateModeVisibility);
    }

    // 定时任务编辑器：模式显隐 + 实时预览（250ms 去抖）+ 保存/重载
    bindClick(elements.scheduleForm.save, saveScheduleConfig);
    bindClick(elements.scheduleForm.reload, reloadScheduleFromFile);
    if (elements.scheduleForm.mode) {
      elements.scheduleForm.mode.addEventListener('change', () => {
        updateScheduleModeVisibility();
        updateSchedulePreviews();
      });
    }
    for (const key of ['scrapeCron', 'translateCron', 'scrapeInterval', 'translateInterval']) {
      const input = elements.scheduleForm[key];
      if (input) input.addEventListener('input', scheduleCronPreviewUpdate);
    }
  }

  function bindClick(element, handler) {
    if (element) element.addEventListener('click', handler);
  }

  // 订阅会在别处被改：另一个设置标签页（弹窗 ⚙️ 每次新开一页）、后台按 tag.json 回读。
  // 这页不跟着刷新，用户就会在过期的列表上勾选保存（审计 A3）；回收站按钮同理跟随后台写入。
  function bindStorageEvents() {
    if (!chrome.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes.urlTags) handleExternalUrlTagsChange(changes.urlTags.newValue);
      if (changes[PRUNE_TRASH_KEY]) renderPruneTrashButton(changes[PRUNE_TRASH_KEY].newValue);
    });
  }

  // —— 配置「本地领先于文件」标记（审计 A2）——
  // SW 每次唤醒都用 config/*.json 覆盖 storage（JSON 是配置源）。同步服务没开时保存，storage
  // 已是新值、文件还是旧值：不做标记，下次唤醒就被旧文件静默回滚——订阅回滚还会连带清掉这段
  // 时间新订阅下抓到的历史。带标记时后台不再拿文件覆盖该项，改为把 storage 的值推回服务端写
  // 文件，成功后自行清标记。
  // 标记与配置在**同一次** storage.set 里乐观置位、写回成功再清：若等 POST 失败才补标记，这次
  // storage 写本身就可能唤醒休眠的 SW，SW 顶层赶在补标记之前读到旧文件，把新值覆盖回去。
  async function configAheadPatch(changes) {
    const stored = await chrome.storage.local.get(CONFIG_AHEAD_KEY);
    const current = stored?.[CONFIG_AHEAD_KEY];
    const flags = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
    for (const [key, ahead] of Object.entries(changes)) {
      if (ahead) flags[key] = true;
      else delete flags[key];
    }
    return { [CONFIG_AHEAD_KEY]: flags };
  }

  /** 配置文件读到的是不是一个普通对象（cron/trans/lark 三份的合法外形；null 为读取失败哨兵）。 */
  function isConfigObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  /** 写回文件成功后清标记。失败只记日志、不影响保存结果：残留标记无害，后台下次唤醒会再推一次同样的值并自清。 */
  async function clearConfigAhead(key) {
    try {
      await chrome.storage.local.set(await configAheadPatch({ [key]: false }));
    } catch (e) {
      console.warn(`[ShortScraping] 清除 ${key} 配置领先标记失败:`, e.message);
    }
  }

  async function loadCurrentConfig() {
    try {
      const [subscriptionCatalog, result] = await Promise.all([
        loadSubscriptionCatalog(),
        chrome.storage.local.get(['urlTags', 'scheduleConfig', 'translateConfig', 'larkConfig', 'siteTabPrefs'])
      ]);
      state.subscriptionCatalog = subscriptionCatalog;
      // 纯本地 UI 偏好，无配置文件兜底，缺席即全「自动」
      state.groupPins = (result.siteTabPrefs || {}).pins || {};
      let urlTags = normalizeUrlTags(result.urlTags || []);
      let scheduleConfig = ScheduleConfig.normalizeConfig(result.scheduleConfig || {});
      let translateConfig = normalizeTranslateConfig(result.translateConfig || {});
      let larkConfig = Lark.normalizeConfig(result.larkConfig || {});

      const shouldReadTags = urlTags.length === 0;
      const shouldReadSchedule = Object.keys(result.scheduleConfig || {}).length === 0;
      const shouldReadTranslate = Object.keys(result.translateConfig || {}).length === 0;
      const shouldReadLark = Object.keys(result.larkConfig || {}).length === 0;

      if (shouldReadTags || shouldReadSchedule || shouldReadTranslate || shouldReadLark) {
        const [tagConfig, scheduleConfigRaw, translateConfigRaw, larkConfigRaw] = await Promise.all([
          shouldReadTags ? fetchJsonFile('config/tag.json', []) : Promise.resolve(urlTags),
          shouldReadSchedule ? fetchJsonFile('config/cron.json', ScheduleConfig.DEFAULT_CONFIG) : Promise.resolve(scheduleConfig),
          shouldReadTranslate ? fetchJsonFile('config/trans.json', DEFAULT_TRANSLATE_CONFIG) : Promise.resolve(translateConfig),
          shouldReadLark ? fetchJsonFile('config/lark.json', Lark.DEFAULT_CONFIG) : Promise.resolve(larkConfig)
        ]);

        urlTags = normalizeUrlTags(tagConfig);
        scheduleConfig = ScheduleConfig.normalizeConfig(scheduleConfigRaw);
        translateConfig = normalizeTranslateConfig(translateConfigRaw);
        larkConfig = Lark.normalizeConfig(larkConfigRaw);
      }

      state.urlTags = urlTags;
      state.scheduleConfig = scheduleConfig;
      state.translateConfig = translateConfig;
      state.larkConfig = larkConfig;
      renderAll();
    } catch (e) {
      console.error('[ShortScraping] 加载当前配置失败:', e);
      showStatus(`加载配置失败：${e.message}`, false);
      renderAll();
    }
  }

  async function reloadConfig() {
    try {
      const [tagConfigRaw, scheduleConfigRaw, translateConfigRaw, larkConfigRaw, stored] = await Promise.all([
        fetchJsonFile('config/tag.json', null),
        fetchJsonFile('config/cron.json', null),
        fetchJsonFile('config/trans.json', null),
        fetchJsonFile('config/lark.json', null),
        chrome.storage.local.get(['urlTags', 'scheduleConfig', 'translateConfig', 'larkConfig'])
      ]);

      // 读取/解析失败（null 哨兵）≠ 用户改了配置，与后台 loadConfigFromJsonFiles 同口径：失败项
      // 沿用 storage 现值、不回落默认值——tag.json 读失败回落空订阅会让后台误清全部历史，
      // trans.json 多个逗号会清掉 AI Key，lark.json 写坏会关掉机器人
      const failedFiles = [];
      const fromFileOr = (file, raw, isValid, storedValue) => {
        if (isValid(raw)) return raw;
        failedFiles.push(file);
        return storedValue;
      };
      const urlTags = normalizeUrlTags(fromFileOr('tag', tagConfigRaw, Array.isArray, stored.urlTags) || []);
      const scheduleConfig = ScheduleConfig.normalizeConfig(fromFileOr('cron', scheduleConfigRaw, isConfigObject, stored.scheduleConfig));
      const translateConfig = normalizeTranslateConfig(fromFileOr('trans', translateConfigRaw, isConfigObject, stored.translateConfig));
      const larkConfig = Lark.normalizeConfig(fromFileOr('lark', larkConfigRaw, isConfigObject, stored.larkConfig));
      const failNote = failedFiles.length > 0
        ? `；${failedFiles.map(key => `${key}.json`).join('、')} 读取失败，沿用当前配置`
        : '';
      // 用户显式以文件为准：取自文件的项清掉领先标记（否则后台会把旧的本地值推回去盖掉
      // 文件）；读取失败的项沿用的是 storage，其领先标记原样保留
      const fromFile = ['tag', 'cron', 'trans', 'lark'].filter(key => !failedFiles.includes(key));
      await applyConfig(urlTags, scheduleConfig, translateConfig, larkConfig, fromFile);

      showStatus(`已读取配置：${urlTags.length} 个 URL，${getScheduleText(scheduleConfig)}，翻译模式=${translateConfig.translateMode}，Lark=${getLarkText(larkConfig)}${failNote}`, !failNote);
    } catch (e) {
      console.error('[ShortScraping] 读取配置失败:', e);
      showStatus(`读取配置失败：${e.message}`, false);
    }
  }

  async function reloadSubscriptionsFromFile() {
    try {
      const tagConfigRaw = await fetchJsonFile('config/tag.json', null);
      if (!Array.isArray(tagConfigRaw)) {
        // 读取失败不写回空订阅，否则后台会按“零订阅”清空全部历史
        showStatus('读取 config/tag.json 失败，已保留当前订阅（未做修改）', false);
        return;
      }
      state.urlTags = normalizeUrlTags(tagConfigRaw);
      // 以文件为准＝本地不再领先：同一次写清掉 tag 标记（见 configAheadPatch）
      await chrome.storage.local.set({ urlTags: state.urlTags, ...await configAheadPatch({ tag: false }) });
      renderSubscriptions();
      renderConfigSummary();
      showStatus(`已从 config/tag.json 读取 ${state.urlTags.length} 条网页订阅`, true);
    } catch (e) {
      console.error('[ShortScraping] 读取网页订阅失败:', e);
      showStatus(`读取网页订阅失败：${e.message}`, false);
    }
  }

  async function reloadTranslateFromFile() {
    try {
      const raw = await fetchJsonFile('config/trans.json', null);
      if (!isConfigObject(raw)) {
        // 读取失败不回落默认值：那会清掉本地的 AI 模式与 Key（同 reloadSubscriptionsFromFile）
        showStatus('读取 config/trans.json 失败，已保留当前翻译接口配置（未做修改）', false);
        return;
      }
      const translateConfig = normalizeTranslateConfig(raw);
      state.translateConfig = translateConfig;
      await chrome.storage.local.set({ translateConfig, ...await configAheadPatch({ trans: false }) });
      renderTranslateForm();
      renderConfigSummary();
      showStatus(`已从 config/trans.json 读取翻译接口配置，当前模式=${translateConfig.translateMode}`, true);
    } catch (e) {
      console.error('[ShortScraping] 读取翻译接口配置失败:', e);
      showStatus(`读取翻译接口配置失败：${e.message}`, false);
    }
  }

  async function reloadLarkFromFile() {
    try {
      const raw = await fetchJsonFile('config/lark.json', null);
      if (!isConfigObject(raw)) {
        // 读取失败不回落默认值：那会关掉群机器人、清空 webhook
        showStatus('读取 config/lark.json 失败，已保留当前 Lark 推送配置（未做修改）', false);
        return;
      }
      const larkConfig = Lark.normalizeConfig(raw);
      state.larkConfig = larkConfig;
      await chrome.storage.local.set({ larkConfig, ...await configAheadPatch({ lark: false }) });
      renderLarkForm();
      renderConfigSummary();
      showStatus(`已从 config/lark.json 读取 Lark 推送配置：${getLarkText(larkConfig)}`, true);
    } catch (e) {
      console.error('[ShortScraping] 读取 Lark 推送配置失败:', e);
      showStatus(`读取 Lark 推送配置失败：${e.message}`, false);
    }
  }

  async function applyConfig(urlTags, scheduleConfig, translateConfig, larkConfig, fromFileKeys = []) {
    state.urlTags = normalizeUrlTags(urlTags);
    state.scheduleConfig = ScheduleConfig.normalizeConfig(scheduleConfig);
    state.translateConfig = normalizeTranslateConfig(translateConfig);
    state.larkConfig = Lark.normalizeConfig(larkConfig);

    await chrome.storage.local.set({
      urlTags: state.urlTags,
      scheduleConfig: state.scheduleConfig,
      translateConfig: state.translateConfig,
      larkConfig: state.larkConfig,
      ...await configAheadPatch(Object.fromEntries(fromFileKeys.map(key => [key, false])))
    });

    const response = await chrome.runtime.sendMessage({ action: 'updateAlarms' });
    if (!response?.success) {
      throw new Error(response?.error || '定时任务更新失败');
    }

    renderAll();
  }

  async function fetchJsonFile(fileName, fallback) {
    try {
      const response = await fetch(chrome.runtime.getURL(fileName), { cache: 'no-store' });
      if (!response.ok) throw new Error(`${fileName} HTTP ${response.status}`);
      return await response.json();
    } catch (e) {
      if (typeof fallback !== 'undefined') {
        console.warn(`[ShortScraping] 读取 ${fileName} 失败，使用默认值:`, e.message);
        return fallback;
      }
      throw e;
    }
  }

  async function loadSubscriptionCatalog() {
    return normalizeUrlTags(await fetchJsonFile(SUBSCRIPTION_CATALOG_FILE, []));
  }

  function switchTab(tabName) {
    elements.tabs.forEach(button => {
      button.classList.toggle('active', button.dataset.tab === tabName);
    });

    elements.panels.forEach(panel => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });
  }

  function renderAll() {
    renderConfigSummary();
    renderScheduleForm();
    renderGroupPins();
    renderSubscriptions();
    renderTranslateForm();
    renderLarkForm();
  }

  // —— 分组代表图标（v1.5.11）：纯本地 UI 偏好，只写 storage 不落配置文件，
  //    弹窗经 storage.onChanged 即时生效；与 activeSource 共用 siteTabPrefs 键 ——

  function renderGroupPins() {
    const container = elements.groupPinRows;
    if (!container) return;
    container.innerHTML = '';

    SiteRegistry.SITE_GROUPS.forEach(groupEntry => {
      const row = document.createElement('div');
      row.className = 'group-pin-row';

      const name = document.createElement('span');
      name.className = 'group-pin-name';
      name.textContent = groupEntry.name;
      row.appendChild(name);

      const pinned = state.groupPins[groupEntry.group] || '';
      row.appendChild(createGroupPinOption(groupEntry.group, '', '自动', '', pinned === ''));
      groupEntry.sites.forEach(site => {
        row.appendChild(createGroupPinOption(
          groupEntry.group, site, SiteRegistry.SOURCE_NAMES[site],
          `assets/icons/site-${site}.png`, pinned === site
        ));
      });

      container.appendChild(row);
    });
  }

  function createGroupPinOption(group, site, label, icon, checked) {
    const option = document.createElement('label');
    option.className = `group-pin-option${checked ? ' is-pinned' : ''}`;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `group-pin-${group}`;
    radio.value = site;
    radio.checked = checked;
    radio.addEventListener('change', () => { if (radio.checked) saveGroupPin(group, site); });
    option.appendChild(radio);

    if (icon) {
      const img = document.createElement('img');
      img.src = chrome.runtime.getURL(icon);
      img.alt = '';
      option.appendChild(img);
    }

    option.appendChild(document.createTextNode(label));
    return option;
  }

  async function saveGroupPin(group, site) {
    const pins = Object.assign({}, state.groupPins);
    if (site) pins[group] = site;
    else delete pins[group];
    state.groupPins = pins;

    try {
      // 读改写：activeSource 由弹窗写入同一个键，别把它冲掉
      const result = await chrome.storage.local.get(['siteTabPrefs']);
      const prefs = result.siteTabPrefs || {};
      await chrome.storage.local.set({ siteTabPrefs: Object.assign({}, prefs, { pins }) });
      renderGroupPins();
      showStatus(site ? `已固定「${SiteRegistry.SOURCE_NAMES[site]}」为该分组图标` : '该分组图标已改为自动', true);
    } catch (e) {
      console.error('[ShortScraping] 保存分组图标失败:', e);
      showStatus(`保存分组图标失败：${e.message}`, false);
    }
  }

  // —— 定时任务编辑器（B-8）：校验与预览全部本地完成（schedule-config.js 已进设置页） ——

  function renderScheduleForm() {
    const form = elements.scheduleForm;
    if (!form?.mode) return;
    const config = state.scheduleConfig || ScheduleConfig.DEFAULT_CONFIG;
    form.mode.value = config.scheduleMode;
    form.scrapeInterval.value = config.scrapeInterval;
    form.translateInterval.value = config.translateInterval;
    form.scrapeCron.value = config.scrapeCron;
    form.translateCron.value = config.translateCron;
    updateScheduleModeVisibility();
    updateSchedulePreviews();
  }

  function updateScheduleModeVisibility() {
    const form = elements.scheduleForm;
    if (!form?.mode) return;
    const isCron = form.mode.value === 'cron';
    if (form.intervalSection) form.intervalSection.style.display = isCron ? 'none' : '';
    if (form.cronSection) form.cronSection.style.display = isCron ? '' : 'none';
  }

  let cronPreviewTimer = null;
  function scheduleCronPreviewUpdate() {
    if (cronPreviewTimer) clearTimeout(cronPreviewTimer);
    cronPreviewTimer = setTimeout(() => {
      cronPreviewTimer = null;
      updateSchedulePreviews();
    }, 250);
  }

  function updateSchedulePreviews() {
    const form = elements.scheduleForm;
    if (!form?.mode) return;

    if (form.mode.value === 'cron') {
      for (const key of ['scrapeCron', 'translateCron']) {
        const preview = form[`${key}Preview`];
        if (!preview) continue;
        const expression = form[key].value.trim();
        try {
          const nextAt = ScheduleConfig.getNextCronRun(expression);
          preview.textContent = `下一次执行：${new Date(nextAt).toLocaleString('zh-CN')}`;
          preview.classList.remove('is-invalid');
        } catch (e) {
          preview.textContent = `表达式无效：${e.message}`;
          preview.classList.add('is-invalid');
        }
      }
    } else if (form.intervalPreview) {
      const scrape = Number(form.scrapeInterval.value);
      const translate = Number(form.translateInterval.value);
      form.intervalPreview.textContent = (scrape > 0 && translate > 0)
        ? `保存后约 ${scrape} 小时后首次抓取、${translate} 小时后首次翻译，此后按各自间隔循环`
        : '间隔必须大于 0';
      form.intervalPreview.classList.toggle('is-invalid', !(scrape > 0 && translate > 0));
    }
  }

  function readScheduleConfigFromForm() {
    const form = elements.scheduleForm;
    return {
      scheduleMode: form.mode.value,
      scrapeInterval: Number(form.scrapeInterval.value),
      translateInterval: Number(form.translateInterval.value),
      scrapeCron: form.scrapeCron.value.trim(),
      translateCron: form.translateCron.value.trim()
    };
  }

  async function saveScheduleConfig() {
    // 强校验：非法配置拒绝保存（不写 storage 不 POST），与 /config/tag 的拒绝范式一致
    const raw = readScheduleConfigFromForm();
    const { ok, errors, config } = ScheduleConfig.validateConfig(raw);
    if (!ok) {
      const first = Object.values(errors)[0];
      showStatus(`保存失败：${first}`, false);
      updateSchedulePreviews();
      return;
    }

    state.scheduleConfig = config;
    // 乐观置 cron 领先标记、写回成功再清（见 configAheadPatch）
    await chrome.storage.local.set({ scheduleConfig: config, ...await configAheadPatch({ cron: true }) });
    renderScheduleForm();
    renderConfigSummary();

    // trans/lark 没有的一步：让后台立即按新配置重排 alarm。失败不回滚 storage——
    // 新配置已落库，下次 SW 唤醒的顶层 setupAlarms 会自愈
    let alarmNote = '';
    try {
      const response = await chrome.runtime.sendMessage({ action: 'updateAlarms' });
      if (!response?.success) throw new Error(response?.error || '后台无响应');
    } catch (e) {
      alarmNote = `（定时任务即时重排失败：${e.message}，扩展下次唤醒会自动生效）`;
    }

    const sync = await trySyncConfig('/config/cron', { scheduleConfig: config });
    if (sync.ok) {
      await clearConfigAhead('cron');
      showStatus(`已保存定时任务配置并写回 config/cron.json${alarmNote}`, true);
    } else {
      // 领先标记已随配置落库：后台唤醒时不再拿旧 cron.json 覆盖，而是把本地配置推回去写文件
      showStatus(`已保存到扩展本地配置并更新定时任务${alarmNote}；写回 config/cron.json 失败：${sync.error}——本地配置会保留，并在同步服务启动后（扩展下次唤醒时）自动写回文件`, false);
    }
  }

  async function reloadScheduleFromFile() {
    try {
      const raw = await fetchJsonFile('config/cron.json', null);
      if (!isConfigObject(raw)) {
        // 读取失败不回落默认值：那会把自定义的调度悄悄换成默认间隔
        showStatus('读取 config/cron.json 失败，已保留当前定时任务配置（未做修改）', false);
        return;
      }
      const scheduleConfig = ScheduleConfig.normalizeConfig(raw);
      state.scheduleConfig = scheduleConfig;
      await chrome.storage.local.set({ scheduleConfig, ...await configAheadPatch({ cron: false }) });
      renderScheduleForm();
      renderConfigSummary();
      // 重载的配置同样要让 alarm 立即生效（镜像 reloadTranslateFromFile 多这一步）
      await chrome.runtime.sendMessage({ action: 'updateAlarms' }).catch(() => {});
      showStatus(`已从 config/cron.json 读取定时任务配置：${getScheduleText(scheduleConfig)}`, true);
    } catch (e) {
      console.error('[ShortScraping] 读取定时任务配置失败:', e);
      showStatus(`读取定时任务配置失败：${e.message}`, false);
    }
  }

  function renderConfigSummary() {
    elements.configSummary.innerHTML = '';

    const cards = [
      { label: '网页订阅', value: `${state.urlTags.length} 个 URL` },
      { label: '定时任务', value: getScheduleText(state.scheduleConfig) },
      { label: '翻译接口', value: getTranslateText(state.translateConfig) },
      { label: 'Lark 推送', value: getLarkText(state.larkConfig) }
    ];

    cards.forEach(card => {
      elements.configSummary.appendChild(createSummaryCard(card.label, card.value));
    });
  }


  function updateTranslateModeVisibility() {
    const form = elements.translateForm;
    if (!form?.mode) return;

    const isAi = form.mode.value === 'ai';
    if (form.apiSection) form.apiSection.style.display = isAi ? 'none' : '';
    if (form.aiSection) form.aiSection.style.display = isAi ? '' : 'none';
  }

  function renderTranslateForm() {
    const form = elements.translateForm;
    if (!form?.mode) return;

    const config = normalizeTranslateConfig(state.translateConfig);
    form.mode.value = config.translateMode;
    updateTranslateModeVisibility();
    form.apiEndpoint.value = config.apiEndpoint;
    form.aiEndpoint.value = config.aiEndpoint;
    form.aiApiKey.value = config.aiApiKey;
    form.aiModel.value = config.aiModel;
    form.aiPrefixPrompt.value = config.aiPrefixPrompt;
    form.batchSize.value = String(config.batchSize);
    form.delayMs.value = String(config.delayMs);
    form.requestTimeoutSec.value = String(config.requestTimeoutSec);
  }

  function renderLarkForm() {
    const form = elements.larkForm;
    if (!form?.webhookUrl) return;

    const config = Lark.normalizeConfig(state.larkConfig);
    form.webhookUrl.value = config.webhookUrl;
    form.requestTimeoutSec.value = String(config.requestTimeoutSec);
    if (form.botWebhookUrl) form.botWebhookUrl.value = config.botWebhookUrl;
    if (form.botEnabled) form.botEnabled.checked = config.botEnabled;
    if (form.feishuAppId) form.feishuAppId.value = config.feishuAppId;
    if (form.feishuAppSecret) form.feishuAppSecret.value = config.feishuAppSecret;
    refreshBotHint();
  }

  function readLarkConfigFromForm() {
    const form = elements.larkForm;
    return {
      webhookUrl: form.webhookUrl.value.trim(),
      requestTimeoutSec: Number(form.requestTimeoutSec.value),
      botWebhookUrl: form.botWebhookUrl ? form.botWebhookUrl.value.trim() : '',
      botEnabled: form.botEnabled ? form.botEnabled.checked : false,
      // 飞书自建应用凭据：只用于上传封面拿 img_key，不是第二条推送通道
      feishuAppId: form.feishuAppId ? form.feishuAppId.value.trim() : '',
      feishuAppSecret: form.feishuAppSecret ? form.feishuAppSecret.value.trim() : ''
    };
  }

  /** 回显当前水位线：让用户一眼看出「从什么时候起的新内容才会被推」。 */
  async function refreshBotHint() {
    const hint = elements.larkForm?.botHint;
    if (!hint) return;
    const enabled = elements.larkForm.botEnabled?.checked;
    if (!enabled) {
      hint.textContent = '当前未开启；开启并保存后，从那一刻起新抓到的条目会在翻译完成时自动推送。';
      return;
    }
    const { larkBotState } = await chrome.storage.local.get('larkBotState');
    const at = larkBotState?.enabledAt;
    hint.textContent = at
      ? `已启用，水位线 ${formatLocalStamp(at)}——只推这之后抓到的条目。`
      : '已勾选，保存后由后台记下水位线（下次后台唤醒时生效）。';
  }

  function createSummaryCard(label, value) {
    const card = document.createElement('div');
    card.className = 'summary-card';
    card.innerHTML = `
      <div class="summary-label">${escapeHtml(label)}</div>
      <div class="summary-value">${escapeHtml(value)}</div>
    `;
    return card;
  }

  function renderSubscriptions() {
    elements.subscriptionList.innerHTML = '';

    const catalog = state.subscriptionCatalog;
    const checkedUrlSet = new Set(state.urlTags.map(item => UrlMatch.normalizeListUrl(item.urlPattern)));
    const catalogUrlSet = new Set(catalog.map(item => UrlMatch.normalizeListUrl(item.urlPattern)));
    state.legacyUrlTags = state.urlTags.filter(item => !catalogUrlSet.has(UrlMatch.normalizeListUrl(item.urlPattern)));

    // 按弹窗头部的同一套分组走：每组先插一条分割标题，组内再逐站点列规则
    SiteRegistry.SITE_GROUPS.forEach(groupEntry => {
      const sections = groupEntry.sites.map(site => ({
        group: SUBSCRIPTION_SITE_GROUPS.find(g => g.site === site),
        entries: catalog
          .map((item, index) => ({ item, index }))
          .filter(entry => siteOfUrl(entry.item.urlPattern) === site)
      })).filter(section => section.entries.length > 0);

      if (sections.length === 0) return;
      appendSubscriptionDivider(groupEntry.name);
      sections.forEach(({ group, entries }) => {
        appendSubscriptionGroup(group.label, group.icon, entries, 'catalog', checkedUrlSet, group.tag);
      });
    });

    const knownSites = new Set(SUBSCRIPTION_SITE_GROUPS.map(group => group.site));
    const otherEntries = catalog
      .map((item, index) => ({ item, index }))
      .filter(entry => !knownSites.has(siteOfUrl(entry.item.urlPattern)));
    appendSubscriptionGroup('其他', '', otherEntries, 'catalog', checkedUrlSet, '');

    const legacyEntries = state.legacyUrlTags.map((item, index) => ({ item, index }));
    appendSubscriptionGroup('自定义（不在规则目录中）', '', legacyEntries, 'legacy', checkedUrlSet, '');

    elements.subscriptionEmpty.style.display =
      catalog.length === 0 && state.legacyUrlTags.length === 0 ? 'block' : 'none';
    updateSubscriptionCount();
  }

  /** 分组分割标题（短剧 / 影视 / 游戏·网文），与弹窗头部的折叠分组同一套定义。 */
  function appendSubscriptionDivider(name) {
    const divider = document.createElement('div');
    divider.className = 'subscription-divider';
    divider.textContent = name;
    elements.subscriptionList.appendChild(divider);
  }

  function appendSubscriptionGroup(label, icon, entries, kind, checkedUrlSet, hiddenTag) {
    if (entries.length === 0) return;

    const group = document.createElement('div');
    group.className = 'subscription-group';

    const header = document.createElement('div');
    header.className = 'subscription-group-header';
    if (icon) {
      const img = document.createElement('img');
      img.src = chrome.runtime.getURL(icon);
      img.alt = '';
      header.appendChild(img);
    }
    const title = document.createElement('span');
    title.textContent = label;
    header.appendChild(title);

    const selectAll = document.createElement('label');
    selectAll.className = 'subscription-select-all';
    const selectAllBox = document.createElement('input');
    selectAllBox.type = 'checkbox';
    selectAll.appendChild(selectAllBox);
    selectAll.appendChild(document.createTextNode('全选'));
    header.appendChild(selectAll);
    group.appendChild(header);

    const options = document.createElement('div');
    options.className = 'subscription-options';
    entries.forEach(entry => {
      options.appendChild(createSubscriptionOption(entry.item, entry.index, kind, checkedUrlSet, hiddenTag));
    });
    group.appendChild(options);

    // 组内条目勾选框都带 data-kind，全选框没有，靠这个区分两类
    const itemBoxes = () => Array.from(options.querySelectorAll('input[type="checkbox"][data-kind]'));
    const syncSelectAll = () => {
      const boxes = itemBoxes();
      const checkedCount = boxes.filter(box => box.checked).length;
      selectAllBox.checked = boxes.length > 0 && checkedCount === boxes.length;
      selectAllBox.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
    };
    group.addEventListener('change', event => {
      if (event.target === selectAllBox) {
        itemBoxes().forEach(box => { box.checked = selectAllBox.checked; });
        selectAllBox.indeterminate = false;
      } else {
        syncSelectAll();
      }
      updateSubscriptionCount();
    });
    syncSelectAll();

    elements.subscriptionList.appendChild(group);
  }

  function createSubscriptionOption(item, index, kind, checkedUrlSet, hiddenTag) {
    const option = document.createElement('label');
    option.className = 'subscription-option';
    option.title = item.urlPattern;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.kind = kind;
    checkbox.dataset.index = String(index);
    checkbox.checked = checkedUrlSet.has(UrlMatch.normalizeListUrl(item.urlPattern));
    option.appendChild(checkbox);

    const tags = document.createElement('div');
    tags.className = 'subscription-option-tags';
    // 站点自身标签仅在页面隐藏；保存时 tags 取自目录/legacy 源数组，数据不变。
    // 若过滤后无可见标签（单标签规则），回退显示全部，避免空卡片。
    const allTags = item.tags || [];
    const visibleTags = allTags.filter(tag => tag !== hiddenTag);
    (visibleTags.length ? visibleTags : allTags).forEach(tag => {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.textContent = tag;
      tags.appendChild(pill);
    });
    option.appendChild(tags);

    return option;
  }

  function updateSubscriptionCount() {
    if (!elements.subscriptionCount) return;
    const boxes = Array.from(elements.subscriptionList.querySelectorAll('input[type="checkbox"][data-kind]'));
    const checkedCount = boxes.filter(box => box.checked).length;
    elements.subscriptionCount.textContent = boxes.length
      ? `已勾选 ${checkedCount} / 共 ${boxes.length} 条规则，保存后生效。`
      : '';
  }

  /**
   * 按域名判断订阅 URL 所属站点。规则单一真源在 src/shared/site-registry.js；
   * 返回 null 的 URL 归入「其他」分组。
   */
  function siteOfUrl(url) {
    return SiteRegistry.siteOfUrl(url);
  }

  // 尾斜杠归一（历史 tag.json 中 my-drama.com 等无尾斜杠形态也要匹配到目录规则）
  // 已收敛到 src/shared/url-match.js 的 normalizeListUrl，调用点直接用它（v1.6.7）

  async function saveSubscriptions() {
    try {
      const normalized = normalizeUrlTags(readSubscriptionsFromDom());
      // 差集基准必须含 storage 里此刻的订阅，不能只看 state.urlTags（页面加载时的快照）：
      // 另一个设置标签页或后台回读 tag.json 可能已改过订阅，只拿旧快照算差集，别处新增的
      // 订阅就被当成「没变」，不确认不备份直接覆盖，后台随即删光它名下的历史（审计 A3）。
      // 再并上快照：只会多确认、不会少确认——storage 缺席（页面按文件兜底渲染）或别处刚
      // 退订时，眼前这页勾掉的订阅照样走确认与文件优先（removedSubscriptionUrls 按归一 URL 去重）
      const { urlTags: storedUrlTags } = await chrome.storage.local.get('urlTags');
      const baseline = [...normalizeUrlTags(storedUrlTags || []), ...state.urlTags];
      // 退订＝删历史：确认与备份必须发生在动 storage 之前
      // （2026-09-17 事故：取消 4 条 Steam 订阅，1847 条历史被静默删除）。
      // 此前只有「取消全部」走这条路，取消部分订阅同样删历史却一声不吭。
      // 后台清理前虽会留一份回收站（仅最近 3 批），确认与定向备份仍是第一道闸。
      const removed = SubscriptionConfig.removedSubscriptionUrls(baseline, normalized);
      if (removed.length > 0) {
        const { dramas = [] } = await chrome.storage.local.get('dramas');
        const doomed = SubscriptionConfig.dramasUnderUrls(dramas, removed);
        if (!window.confirm(buildUnsubscribeConfirmText(removed, doomed.length))) return;
        // 备份严格先于 storage 写：写 storage 会经 onChanged 立刻触发后台清理，
        // 之后再想导出就晚了。unit-unsubscribe-guard G3b 钉住这个次序。
        if (doomed.length > 0) exportDoomedDramas(doomed);
      }

      // 退订仍「文件优先」：写 storage 会经 onChanged 立刻让后台清掉对应历史，不可逆，
      // 所以必须等配置源 config/tag.json 落盘才动 storage——只靠本地领先标记兜着的话，
      // 标记一旦丢失，旧文件会在下次唤醒复活订阅，得到「历史没了、订阅回来了」。
      // 纯新增/改标签走 storage 优先，但它并非「最多回滚、不会删历史」：旧文件回滚订阅会
      // 连带清掉这段时间新订阅下抓到的历史（审计 A2）。因此同一次 set 里乐观置
      // configAheadOfFile.tag，后台见标记就不拿文件覆盖，改为把本地订阅推回服务端写文件。
      const preflight = removed.length > 0 ? await trySyncConfig('/config/tag', { urlTags: normalized }) : null;
      if (preflight && !preflight.ok) {
        showStatus(`未取消订阅：写回 config/tag.json 失败（${preflight.error}）——取消订阅会删除历史，必须先写成配置文件，否则历史清掉后订阅仍可能在扩展下次唤醒时从旧文件回读恢复；请启动同步服务后重试`, false);
        return;
      }

      state.urlTags = normalized;
      // 退订分支：文件已写成，同一次 set 清 tag 标记，并放行一次空时间线推送——退订后库
      // 变空是用户刚确认过的结果；后台默认拒推空库（防新 profile 冷启动把 db/timeline.*
      // 清空，审计 A1），不带 allowEmptySync，这次清空就到不了 CSV 与共享页
      const patch = removed.length > 0
        ? { ...await configAheadPatch({ tag: false }), allowEmptySync: true }
        : await configAheadPatch({ tag: true });
      await chrome.storage.local.set({ urlTags: state.urlTags, ...patch });
      renderSubscriptions();
      renderConfigSummary();

      const syncResult = preflight || await trySyncConfig('/config/tag', { urlTags: state.urlTags });
      if (syncResult.ok) {
        if (!preflight) await clearConfigAhead('tag');
        showStatus(`已保存 ${state.urlTags.length} 条网页订阅，并写回 config/tag.json`, true);
      } else {
        showStatus(`已保存到扩展本地配置；写回 config/tag.json 失败：${syncResult.error}——本地订阅会保留，并在同步服务启动后（扩展下次唤醒时）自动写回文件`, false);
      }
    } catch (e) {
      console.error('[ShortScraping] 保存网页订阅失败:', e);
      showStatus(`保存失败：${e.message}`, false);
    }
  }

  /**
   * 订阅在别处被改（storage.onChanged）：一律以 storage 为准刷新列表。这是最简单且安全的
   * 做法——saveSubscriptions 本就以 storage 为差集基准，界面与基准一致，确认框列出的才是
   * 用户眼前看到的差异。本页若有未保存的勾选，不做合并（拿旧基准上的增删去套新基准，容易把
   * 别处刚加的订阅算成「本页要删」），而是丢弃并明确提示，让用户在最新列表上重勾，不静默吞掉。
   * 本页自己保存/重载时 state.urlTags 先于 storage 写入更新，回声事件在这里等值短路。
   */
  function handleExternalUrlTagsChange(newValue) {
    const fresh = normalizeUrlTags(newValue || []);
    if (JSON.stringify(fresh) === JSON.stringify(state.urlTags)) return;
    // 必须在改 state 之前读 DOM：勾选框的 data-index 指向的是当前这版 legacyUrlTags
    const hadUnsavedEdits = subscriptionUrlKey(readSubscriptionsFromDom()) !== subscriptionUrlKey(state.urlTags);
    state.urlTags = fresh;
    renderSubscriptions();
    renderConfigSummary();
    if (hadUnsavedEdits) {
      showStatus('订阅已在别处变更，列表已刷新为最新配置；本页未保存的勾选已丢弃，请重新勾选后再保存', false);
    }
  }

  /** 勾选框只改变订阅成员（标签随目录固定），比较未保存改动时只看归一后的 URL 集合。 */
  function subscriptionUrlKey(urlTags) {
    return [...new Set(urlTags.map(item => UrlMatch.normalizeListUrl(item.urlPattern)))].sort().join('\n');
  }

  /** 退订确认文案。零历史时不提备份——那一支不会产生文件，提了就是假承诺。 */
  function buildUnsubscribeConfirmText(removedUrls, doomedCount) {
    const LIST_LIMIT = 5;
    const shown = removedUrls.slice(0, LIST_LIMIT).map(url => `　· ${url}`).join('\n');
    const more = removedUrls.length > LIST_LIMIT ? `\n　…… 等共 ${removedUrls.length} 条` : '';
    const head = `本次将取消 ${removedUrls.length} 条订阅：\n${shown}${more}\n`;
    if (doomedCount === 0) return `${head}\n其下暂无历史记录，不会删除任何数据。\n\n是否继续？`;
    return `${head}\n其下的 ${doomedCount} 条历史记录会被一并删除，且不可恢复。\n`
      + `继续前会自动下载这 ${doomedCount} 条的 JSON 备份文件；日后如需还原，`
      + `要先把订阅重新加回来，再用下方「导入恢复」写回。\n\n是否继续？`;
  }

  /**
   * 把即将被清理的条目落成一份备份文件。**只备将被删的那批**，不是全量——
   * 导入是增量合并（重复会跳过），全量每次退订都下几 MB 没必要。
   */
  function exportDoomedDramas(doomed) {
    downloadBackupFile(doomed, { reason: 'unsubscribe', filePrefix: 'shortscraping-unsubscribed' });
  }

  /**
   * 落一份部分条目的备份文件（退订前备份、自动清理回收站共用）。payload 沿用 handleExportJson
   * 的 shortscraping-backup 形态，「导入恢复」原样能吃；extra 只放说明性字段，导入端不读。
   */
  function downloadBackupFile(dramas, { reason, filePrefix, extra = {} }) {
    const payload = {
      format: 'shortscraping-backup',
      backupVersion: 1,
      extensionVersion: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      reason,
      ...extra,
      count: dramas.length,
      dramas
    };
    triggerDownload(`${filePrefix}-${formatStamp()}.json`,
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  }

  async function saveTranslateConfig() {
    try {
      const translateConfig = normalizeTranslateConfig(readTranslateConfigFromForm());
      state.translateConfig = translateConfig;
      // 乐观置 trans 领先标记、写回成功再清（见 configAheadPatch）：不带标记时服务未启动的
      // 保存会在下次唤醒被旧 trans.json 静默回滚，AI Key/模式悄悄变回旧值
      await chrome.storage.local.set({ translateConfig, ...await configAheadPatch({ trans: true }) });
      renderTranslateForm();
      renderConfigSummary();

      const syncResult = await trySyncConfig('/config/trans', { translateConfig });
      if (syncResult.ok) {
        await clearConfigAhead('trans');
        showStatus('已保存翻译接口配置，并写回 config/trans.json', true);
      } else {
        showStatus(`已保存到扩展本地配置；写回 config/trans.json 失败：${syncResult.error}——本地配置会保留，并在同步服务启动后（扩展下次唤醒时）自动写回文件`, false);
      }
    } catch (e) {
      console.error('[ShortScraping] 保存翻译接口配置失败:', e);
      showStatus(`保存翻译接口失败：${e.message}`, false);
    }
  }

  function readSubscriptionsFromDom() {
    return Array.from(elements.subscriptionList.querySelectorAll('input[type="checkbox"][data-kind]'))
      .filter(box => box.checked)
      .map(box => {
        const source = box.dataset.kind === 'legacy' ? state.legacyUrlTags : state.subscriptionCatalog;
        const item = source[Number(box.dataset.index)];
        return item ? { urlPattern: item.urlPattern, tags: [...item.tags] } : null;
      })
      .filter(Boolean);
  }

  function readTranslateConfigFromForm() {
    const form = elements.translateForm;
    return {
      translateMode: form.mode.value,
      apiEndpoint: form.apiEndpoint.value.trim(),
      aiEndpoint: form.aiEndpoint.value.trim(),
      aiApiKey: form.aiApiKey.value.trim(),
      aiModel: form.aiModel.value.trim(),
      aiPrefixPrompt: form.aiPrefixPrompt.value.trim(),
      batchSize: Number(form.batchSize.value),
      delayMs: Number(form.delayMs.value),
      requestTimeoutSec: Number(form.requestTimeoutSec.value)
    };
  }

  async function saveLarkConfig() {
    try {
      const larkConfig = Lark.normalizeConfig(readLarkConfigFromForm());
      state.larkConfig = larkConfig;
      // 乐观置 lark 领先标记、写回成功再清（见 configAheadPatch）：不带标记时关机器人这类
      // 操作会在下次唤醒被旧 lark.json 悄悄撤销
      await chrome.storage.local.set({ larkConfig, ...await configAheadPatch({ lark: true }) });
      renderLarkForm();
      renderConfigSummary();

      const syncResult = await trySyncConfig('/config/lark', { larkConfig });
      if (syncResult.ok) {
        await clearConfigAhead('lark');
        showStatus('已保存 Lark 推送配置，并写回 config/lark.json', true);
      } else {
        showStatus(`已保存到扩展本地配置；写回 config/lark.json 失败：${syncResult.error}——本地配置会保留，并在同步服务启动后（扩展下次唤醒时）自动写回文件`, false);
      }
    } catch (e) {
      console.error('[ShortScraping] 保存 Lark 推送配置失败:', e);
      showStatus(`保存 Lark 推送配置失败：${e.message}`, false);
    }
  }

  /**
   * 发送测试：用当前表单草稿（不落库）经后台真实推送一条样例数据，
   * 让飞书触发器捕获参数结构。测试路径与卡片按钮共用后台同一实现。
   */
  async function handleLarkBotTestSend() {
    const draft = Lark.normalizeConfig(readLarkConfigFromForm());
    // 测试只要地址合法即可，不强制先勾开关——让用户能「先试通再开自动推送」
    if (!/^https?:\/\//i.test(draft.botWebhookUrl)) {
      showStatus('请先填写群机器人 Webhook 地址（http/https）', false);
      return;
    }

    const btn = elements.buttons.larkBotTestSend;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '发送中…';

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'larkBotTestSend',
        config: { ...draft, botEnabled: true }
      });
      if (!response?.success) throw new Error(response?.error || '后台推送失败');
      showStatus(`测试卡片已发到群（${response.sampleTitle || '内置样例'}）`, true);
    } catch (e) {
      showStatus(`群机器人测试失败：${e.message}`, false);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  async function handleLarkTestSend() {
    const draft = Lark.normalizeConfig(readLarkConfigFromForm());
    if (!Lark.configReadiness(draft).ok) {
      showStatus('请先填写 Webhook 地址（http/https）', false);
      return;
    }

    const btn = elements.buttons.larkTestSend;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '发送中…';

    try {
      const response = await chrome.runtime.sendMessage({ action: 'larkTestSend', config: draft });
      if (!response?.success) {
        throw new Error(response?.error || '后台推送失败');
      }
      showStatus(`测试数据已发送（${response.sampleTitle || '内置样例'}）：请到飞书工作流的触发器里确认参数已捕获`, true);
    } catch (e) {
      console.error('[ShortScraping] Lark 发送测试失败:', e);
      showStatus(`发送测试失败：${e.message}`, false);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  /**
   * 把配置写回同步服务（POST /config/tag|trans|lark|cron，body 为 { <键>: 配置 }），四个保存入口共用。
   * 先读响应体再判状态：服务端拒绝写入时回非 2xx + { ok:false, error:'具体原因' }（如「Cron 配置无效——…」
   * 「网页订阅包含无效或重复条目」），原先先抛 HTTP 码，用户只看到「HTTP 500」；非 JSON 的错误响应仍报 HTTP 码。
   * 不抛错：失败以 { ok:false, error } 返回，由调用方拼各自的提示文案。
   */
  async function trySyncConfig(route, body) {
    try {
      const response = await fetch(SYNC_BASE_URL + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      let result = null;
      try {
        result = await response.json();
      } catch (e) {
        if (response.ok) throw e;
      }

      if (!response.ok) {
        throw new Error(result?.error || `HTTP ${response.status}`);
      }
      if (!result?.ok) {
        throw new Error(result?.error || '同步服务返回失败');
      }

      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // —— 数据存档：导出 / 导入恢复 / 按条件清理（B-7） ——

  function formatStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  function triggerDownload(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 导出直读 storage（单次快照读无并发风险，弹窗同款姿势），不经后台
  async function handleExportJson() {
    const { dramas = [] } = await chrome.storage.local.get('dramas');
    if (dramas.length === 0) {
      showStatus('时间线为空，没有可导出的条目', false);
      return;
    }
    const payload = {
      format: 'shortscraping-backup',
      backupVersion: 1,
      extensionVersion: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      count: dramas.length,
      dramas
    };
    triggerDownload(`shortscraping-backup-${formatStamp()}.json`,
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    showStatus(`已导出 ${dramas.length} 条到 JSON 备份`, true);
  }

  async function handleExportCsv() {
    const { dramas = [] } = await chrome.storage.local.get('dramas');
    if (dramas.length === 0) {
      showStatus('时间线为空，没有可导出的条目', false);
      return;
    }
    const { content, count } = TimelineCsv.buildTimelineCsv(dramas);
    triggerDownload(`shortscraping-timeline-${formatStamp()}.csv`,
      new Blob([content], { type: 'text/csv;charset=utf-8' }));
    showStatus(`已导出 ${count} 条到 CSV（仅供查看，恢复请用 JSON 备份）`, true);
  }

  async function handleImportFile(event) {
    const file = event.target.files?.[0];
    event.target.value = ''; // 允许连续选择同名文件
    if (!file) return;

    if (file.size > 50 * 1024 * 1024) {
      showStatus('备份文件超过 50MB 上限', false);
      return;
    }

    let dramas;
    try {
      const payload = JSON.parse(await file.text());
      dramas = Array.isArray(payload) ? payload : payload?.dramas; // 兼容手工剥壳的裸数组
      if (!Array.isArray(dramas)) throw new Error('缺少 dramas 数组');
    } catch (e) {
      showStatus(`文件不是 ShortScraping 备份：${e.message}`, false);
      return;
    }

    const resp = await chrome.runtime.sendMessage({ action: 'importDramas', dramas });
    if (!resp?.success) {
      showStatus(`导入失败：${resp?.error || '后台无响应'}`, false);
      return;
    }
    // 原文乱码无法自动修复，再抓取命中去重也不会覆盖已有条目，如实告知而不是许诺自愈
    const garbledNote = resp.garbledSourceCount > 0
      ? `；其中 ${resp.garbledSourceCount} 条原文含乱码字符（旧版同步服务导致），已原样导入，重新抓取不会覆盖`
      : '';
    showStatus(`导入完成：新增 ${resp.added} 条；跳过重复 ${resp.duplicates} 条、订阅范围外 ${resp.outOfScope} 条、无效 ${resp.invalid} 条${garbledNote}`, true);
  }

  // —— 自动清理回收站（审计 A2）：后台订阅外清理（退订、按 tag.json 回读订阅等所有路径）
  //    删条目前先把这批存进 pruneTrash，这里只负责导出成「导入恢复」能吃的备份 ——

  function summarizePruneTrash(trash) {
    const batches = Array.isArray(trash)
      ? trash.filter(entry => entry && Array.isArray(entry.dramas) && entry.dramas.length > 0)
      : [];
    return { batches, count: batches.reduce((sum, entry) => sum + entry.dramas.length, 0) };
  }

  /** 回收站为空时整颗按钮隐藏：空导出只会产出一个没用的文件。 */
  function renderPruneTrashButton(trash) {
    const button = elements.archive?.exportPruneTrash;
    if (!button) return;
    const { batches, count } = summarizePruneTrash(trash);
    button.hidden = count === 0;
    button.disabled = count === 0;
    button.textContent = `导出自动清理回收站（${batches.length} 批 / ${count} 条）`;
  }

  async function refreshPruneTrashButton() {
    try {
      const stored = await chrome.storage.local.get(PRUNE_TRASH_KEY);
      renderPruneTrashButton(stored?.[PRUNE_TRASH_KEY]);
    } catch (e) {
      console.warn('[ShortScraping] 读取自动清理回收站失败:', e.message);
    }
  }

  async function handleExportPruneTrash() {
    const stored = await chrome.storage.local.get(PRUNE_TRASH_KEY);
    const trash = stored?.[PRUNE_TRASH_KEY];
    renderPruneTrashButton(trash);
    const { batches, count } = summarizePruneTrash(trash);
    if (count === 0) {
      showStatus('自动清理回收站为空，没有可导出的条目', false);
      return;
    }
    // 新批在前：同一条被清过两次时，导入按先到先得去重，留下的是最近那份（可能已补上译文）
    const dramas = batches.slice().reverse().flatMap(entry => entry.dramas);
    downloadBackupFile(dramas, {
      reason: 'prune-trash',
      filePrefix: 'shortscraping-prune-trash',
      extra: {
        batches: batches.map(entry => ({
          at: entry.at, reason: entry.reason, urls: entry.urls, count: entry.dramas.length
        }))
      }
    });
    showStatus(`已导出回收站 ${batches.length} 批共 ${count} 条；恢复前先把对应订阅加回来，再用「导入 JSON 恢复」写回`, true);
  }

  function renderPruneSites() {
    const container = elements.archive.pruneSiteList;
    if (!container) return;
    container.innerHTML = '';
    for (const site of SiteRegistry.CATEGORY_SOURCES) {
      const label = document.createElement('label');
      label.className = 'subscription-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = site;
      checkbox.dataset.pruneSite = site;
      const text = document.createElement('span');
      text.textContent = SiteRegistry.SOURCE_NAMES[site];
      label.appendChild(checkbox);
      label.appendChild(text);
      container.appendChild(label);
    }
  }

  function readPruneCriteria() {
    const sites = Array.from(elements.archive.pruneSiteList.querySelectorAll('input:checked'))
      .map(input => input.value);
    const dateValue = elements.archive.pruneBeforeDate.value; // yyyy-mm-dd
    // 语义＝早于该日本地 0 点
    const beforeIso = dateValue ? new Date(`${dateValue}T00:00:00`).toISOString() : undefined;
    return { sites, beforeIso };
  }

  let pruneRequestVersion = 0;
  let prunePreviewToken = null;

  function resetPruneConfirm() {
    pruneRequestVersion++;
    prunePreviewToken = null;
    elements.archive.pruneConfirm.disabled = true;
    elements.archive.pruneConfirm.textContent = '确认删除';
    elements.archive.pruneResult.textContent = '';
  }

  async function handlePrunePreview() {
    resetPruneConfirm();
    const requestVersion = pruneRequestVersion;
    const { sites, beforeIso } = readPruneCriteria();
    if (sites.length === 0) {
      showStatus('请先勾选要清理的站点', false);
      return;
    }
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ action: 'pruneDramas', sites, beforeIso, dryRun: true });
    } catch (e) { resp = { success: false, error: e.message }; }
    if (requestVersion !== pruneRequestVersion) return;
    if (!resp?.success) {
      showStatus(`预览失败：${resp?.error || '后台无响应'}`, false);
      return;
    }
    const perSite = Object.entries(resp.perSite || {})
      .map(([site, n]) => `${SiteRegistry.SOURCE_NAMES[site] || site} ${n}`)
      .join('、');
    elements.archive.pruneResult.textContent =
      `命中 ${resp.matched} 条（库内共 ${resp.total} 条）${perSite ? `：${perSite}` : ''}`;
    prunePreviewToken = resp.previewToken;
    elements.archive.pruneConfirm.disabled = resp.matched === 0 || !prunePreviewToken;
    elements.archive.pruneConfirm.textContent = resp.matched > 0 ? `确认删除 ${resp.matched} 条` : '确认删除';
  }

  async function handlePruneConfirm() {
    const { sites, beforeIso } = readPruneCriteria();
    if (sites.length === 0 || !prunePreviewToken) return;
    const previewToken = prunePreviewToken;
    resetPruneConfirm();
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ action: 'pruneDramas', sites, beforeIso, previewToken });
    } catch (e) { resp = { success: false, error: e.message }; }
    if (!resp?.success) {
      showStatus(`清理失败：${resp?.error || '后台无响应'}`, false);
      return;
    }
    resetPruneConfirm();
    showStatus(`已清理 ${resp.removed} 条，时间线与 CSV 将自动同步`, true);
  }

  // —— 导出到多维表格：增量复制成 TSV，切到 Base 粘贴追加 ——
  //
  // 为什么不走 webhook 批量推：触发器按「1 条记录＝1 次工作流运行」计费，
  // 每月约 1400 条的增量远超免费额度。
  //
  // 水位线存的是「上次复制的精确时刻」而不是日期：按日期取整会让当天 0 点到
  // 复制时刻之间入库的条目下次被重复导出（Base 侧不去重，重复即多出行）。
  // 比较的是入库时刻 savedAt（旧条目退回 scrapedAt），只勾部分站点复制时各站分记水位线，
  // 状态形态与推进规则见 lark.js 的 nextExportState。
  // 日期框留空＝用水位线，填了＝显式覆盖（也是重导历史区间的入口）。
  const LARK_EXPORT_STATE_KEY = 'larkExportState';
  // 水位线取在读库之前再退这么多：后台先给新卡打 savedAt、再整表写 storage，读快照恰好
  // 夹在两步之间的卡不在这次快照里，savedAt 却略早于读库时刻。余量窗口里已导出的条目
  // 记进 overlapKeys，下次不重导
  const LARK_EXPORT_SAFETY_MARGIN_MS = 2 * 60 * 1000;

  /**
   * 与 popup.js 的 copyTextToClipboard 同款（见 src/popup/popup.js）：无用户激活时
   * navigator.clipboard.writeText 会无声挂起而不是拒绝，必须靠超时竞速兜到
   * execCommand 分支。两页不共享模块，此处照搬而非新起一个共享模块。
   * 两条路都失败时抛错：execCommand 失败不抛、只回 false，吞掉它调用方就以为已复制，
   * 照样推进水位线，这批条目下次不再导出。
   */
  async function copyTextToClipboard(text) {
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 600))
      ]);
    } catch (e) {
      const input = document.createElement('textarea');
      input.value = text;
      document.body.appendChild(input);
      let copied = false;
      try {
        input.select();
        copied = document.execCommand('copy');
      } finally {
        input.remove();
      }
      if (!copied) throw new Error(`浏览器拒绝写入剪贴板（${e.message}）`);
    }
  }

  function renderLarkExportSites() {
    const container = elements.archive.larkExportSiteList;
    if (!container) return;
    container.innerHTML = '';
    for (const site of SiteRegistry.CATEGORY_SOURCES) {
      const label = document.createElement('label');
      label.className = 'subscription-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = site;
      const text = document.createElement('span');
      text.textContent = SiteRegistry.SOURCE_NAMES[site];
      label.appendChild(checkbox);
      label.appendChild(text);
      container.appendChild(label);
    }
  }

  async function readLarkExportState() {
    const stored = await chrome.storage.local.get(LARK_EXPORT_STATE_KEY);
    return Lark.normalizeExportState(stored?.[LARK_EXPORT_STATE_KEY]);
  }

  /** 水位线的人话：「全部站点 …；单独复制过 Steam …」，从未复制过返回空串。 */
  function describeLarkExportMark(mark) {
    const parts = [];
    if (mark.lastCopiedAt) parts.push(`全部站点 ${formatLocalStamp(mark.lastCopiedAt)}`);
    const siteParts = Object.entries(mark.sites)
      .map(([site, at]) => `${SiteRegistry.SOURCE_NAMES[site] || site} ${formatLocalStamp(at)}`);
    if (siteParts.length) parts.push(`单独复制过 ${siteParts.join('、')}`);
    return parts.join('；');
  }

  const isLarkExportMarkEmpty = (mark) => !mark.lastCopiedAt && Object.keys(mark.sites).length === 0;

  function formatLocalStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function refreshLarkExportHint() {
    const hint = elements.archive.larkExportHint;
    if (!hint) return;
    const exportState = await readLarkExportState();
    const described = describeLarkExportMark(exportState);
    hint.textContent = described
      ? `上次复制：${described}——留空日期即各站只导各自上次复制之后入库的条目${exportState.lastCopiedAt ? '' : '（没复制过的站点导出全部）'}。`
      : '还没复制过：留空日期＝导出全部条目（首次建表建议走 npm run export-lark 出文件）。';
    if (elements.archive.larkExportUndo) {
      elements.archive.larkExportUndo.disabled = isLarkExportMarkEmpty(exportState) && isLarkExportMarkEmpty(exportState.previous);
    }
  }

  async function handleLarkExportCopy() {
    // 新水位线取在读 storage 之前（再退安全余量）：复制期间才入库的卡不在这次快照里，
    // 取在读库之后会把它们永久挡在水位线外
    const copiedAt = new Date(Date.now() - LARK_EXPORT_SAFETY_MARGIN_MS).toISOString();
    const sites = Array.from(elements.archive.larkExportSiteList.querySelectorAll('input:checked'))
      .map(input => input.value);
    const dateValue = elements.archive.larkExportSinceDate.value; // yyyy-mm-dd
    const exportState = await readLarkExportState();
    // 日期框语义＝该日本地 0 点起（与「按条件清理」同口径），对所选站点一律生效、不排除重叠；
    // 留空退回各站水位线
    const since = dateValue ? new Date(`${dateValue}T00:00:00`).toISOString() : '';

    const { dramas = [] } = await chrome.storage.local.get('dramas');
    const rows = Lark.buildTableRows(dramas, since
      ? { since, sources: sites }
      : { since: exportState.lastCopiedAt, sinceBySource: exportState.sites, excludeKeys: exportState.overlapKeys, sources: sites });
    if (rows.length === 0) {
      const scope = sites.length ? '所选站点' : '';
      if (since) showStatus(`${formatLocalStamp(since)} 之后${scope}没有条目`, false);
      else if (!isLarkExportMarkEmpty(exportState)) showStatus(`上次复制之后${scope}没有新入库的条目`, false);
      else showStatus(`${scope || '时间线为空，'}没有可导出的条目`, false);
      return;
    }

    try {
      await copyTextToClipboard(Lark.toTsv(rows));
    } catch (e) {
      showStatus(`写入剪贴板失败：${e.message}——可改用 npm run export-lark 出文件`, false);
      return;
    }

    // 水位线只在复制确实成功后推进：失败时推进会让这批条目永远漏出去
    await chrome.storage.local.set({
      [LARK_EXPORT_STATE_KEY]: Lark.nextExportState(exportState, { dramas, rows, sites, copiedAt, since })
    });
    await refreshLarkExportHint();

    const notes = [];
    // 译文晚到不补发：翻译完成不改入库时刻，这批行下次不会再被复制出来
    const untranslated = rows.filter(row => row.status !== 'trans').length;
    if (untranslated) notes.push(`其中 ${untranslated} 条尚未翻译完，中文列为空或不全，译文完成后不会自动补发`);
    const stuck = rows.filter(row => row.poster && /[,%]/.test(row.poster)).length;
    if (stuck) notes.push(`其中 ${stuck} 条封面链接含逗号或百分号编码，转不了附件`);
    showStatus(`已复制 ${rows.length} 条到剪贴板，切到多维表格选中表末空行首格粘贴${notes.length ? `（${notes.join('；')}）` : ''}`, true);
  }

  async function handleLarkExportUndo() {
    const exportState = await readLarkExportState();
    if (isLarkExportMarkEmpty(exportState) && isLarkExportMarkEmpty(exportState.previous)) return;
    const { previous } = exportState;
    await chrome.storage.local.set({
      [LARK_EXPORT_STATE_KEY]: { ...previous, previous: { lastCopiedAt: '', sites: {}, overlapKeys: [] } }
    });
    await refreshLarkExportHint();
    showStatus(isLarkExportMarkEmpty(previous)
      ? '已清空上次复制时间，再点「复制」会导出全部条目'
      : `已退回到 ${describeLarkExportMark(previous)}，再点「复制」会重来上一批`, true);
  }

  async function checkSyncServiceStatus() {
    updateSyncServiceStatus('checking');

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);

      const response = await fetch(SYNC_HEALTH_URL, {
        cache: 'no-store',
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();
      updateSyncServiceStatus(result?.ok ? 'on' : 'off', result);
    } catch (e) {
      updateSyncServiceStatus('off');
    }
  }

  function updateSyncServiceStatus(status, result = {}) {
    const container = elements.syncService.container;
    const text = elements.syncService.text;
    const archiveInfo = elements.syncService.archiveInfo;

    container.classList.remove('is-on', 'is-off');

    if (status === 'on') {
      container.classList.add('is-on');
      text.textContent = '同步服务：已开启';
      archiveInfo.textContent = result.csvPath ? `CSV 输出路径：${result.csvPath}` : '同步服务已开启，可以写入 CSV 和配置文件。';
      return;
    }

    if (status === 'off') {
      container.classList.add('is-off');
      text.textContent = '同步服务：已关闭';
      archiveInfo.textContent = '请运行 npm run sync（Windows 可双击 start-sync.bat，macOS 可双击 start-sync.command）后再使用文件写回能力。';
      return;
    }

    text.textContent = '同步服务：检测中';
    archiveInfo.textContent = '正在检测本地同步服务...';
  }

  // 订阅规范化单一真源在 src/shared/subscription-config.js（v1.6.5 收敛，三端共用）
  function normalizeUrlTags(rawTags) {
    return SubscriptionConfig.normalizeUrlTags(rawTags);
  }

  function normalizeTranslateConfig(rawConfig) {
    return TranslateConfig.normalizeConfig(rawConfig);
  }

  function getScheduleText(config) {
    if (config.scheduleMode === 'cron') {
      return `Cron：抓取 ${config.scrapeCron || '未配置'}，翻译 ${config.translateCron || '未配置'}`;
    }

    return `间隔：抓取 ${config.scrapeInterval || 6}h，翻译 ${config.translateInterval || 1}h`;
  }

  function getTranslateText(config) {
    if (config.translateMode === 'ai') {
      return `AI：${config.aiModel || '未配置模型'}`;
    }

    return 'API：MyMemory/兼容接口';
  }

  function getLarkText(config) {
    return Lark.configReadiness(config).ok ? '已配置 Webhook' : '未配置';
  }

  function openConfigFile(fileName) {
    chrome.tabs.create({ url: chrome.runtime.getURL(fileName) });
  }

  function showStatus(message, success = false) {
    elements.status.textContent = message;
    elements.status.className = `status show ${success ? 'success' : 'error'}`;

    setTimeout(() => {
      elements.status.className = 'status';
    }, 4500);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
