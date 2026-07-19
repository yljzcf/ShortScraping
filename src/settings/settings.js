/**
 * ShortScraping Settings Script
 * 配置源：config/tag.json / config/cron.json / config/trans.json
 */

(function() {
  'use strict';

  const SYNC_HEALTH_URL = 'http://127.0.0.1:31919/health';
  const TAG_CONFIG_SYNC_URL = 'http://127.0.0.1:31919/config/tag';
  const TRANS_CONFIG_SYNC_URL = 'http://127.0.0.1:31919/config/trans';
  const SUBSCRIPTION_CATALOG_FILE = 'config/tag.example.json';

  // tag = 该站点在订阅 tags 里的站点自身标签，页面上隐藏不显示（仅展示层，保存数据不变）
  const SUBSCRIPTION_SITE_GROUPS = [
    { site: 'imdb', label: 'IMDB', tag: 'IMDB', icon: 'assets/icons/site-imdb.png' },
    { site: 'steam', label: 'Steam', tag: 'Steam', icon: 'assets/icons/site-steam.png' },
    { site: 'royalroad', label: 'RoyalRoad', tag: 'RoyalRoad', icon: 'assets/icons/site-royalroad.png' },
    { site: 'mydrama', label: 'My Drama', tag: 'MyDrama', icon: 'assets/icons/site-mydrama.png' },
    { site: 'reelshort', label: 'ReelShort', tag: 'ReelShort', icon: 'assets/icons/site-reelshort.png' },
    { site: 'dramashorts', label: 'DramaShorts', tag: 'DramaShorts', icon: 'assets/icons/site-dramashorts.png' },
    { site: 'netshort', label: 'NetShort', tag: 'NetShort', icon: 'assets/icons/site-netshort.png' }
  ];

  const DEFAULT_SCHEDULE_CONFIG = {
    scheduleMode: 'interval',
    scrapeInterval: 6,
    translateInterval: 1,
    scrapeCron: '45 * * * *',
    translateCron: '50 * * * *'
  };

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

  const state = {
    urlTags: [],
    subscriptionCatalog: [],
    legacyUrlTags: [],
    scheduleConfig: { ...DEFAULT_SCHEDULE_CONFIG },
    translateConfig: { ...DEFAULT_TRANSLATE_CONFIG },
    activeTab: 'config'
  };

  const elements = {};

  function init() {
    cacheElements();
    bindEvents();
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
      checkSync: document.getElementById('btnCheckSync')
    };

    elements.configSummary = document.getElementById('configSummary');
    elements.scheduleSummary = document.getElementById('scheduleSummary');
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
    elements.syncService = {
      container: document.getElementById('syncServiceStatus'),
      text: document.getElementById('syncServiceText'),
      archiveInfo: document.getElementById('archiveInfo')
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
    bindClick(elements.buttons.checkSync, checkSyncServiceStatus);

    // 翻译模式切换时只显示当前模式的配置区（隐藏区块的值保留，切回即恢复）
    if (elements.translateForm?.mode) {
      elements.translateForm.mode.addEventListener('change', updateTranslateModeVisibility);
    }
  }

  function bindClick(element, handler) {
    if (element) element.addEventListener('click', handler);
  }

  async function loadCurrentConfig() {
    try {
      const [subscriptionCatalog, result] = await Promise.all([
        loadSubscriptionCatalog(),
        chrome.storage.local.get(['urlTags', 'scheduleConfig', 'translateConfig'])
      ]);
      state.subscriptionCatalog = subscriptionCatalog;
      let urlTags = normalizeUrlTags(result.urlTags || []);
      let scheduleConfig = normalizeScheduleConfig(result.scheduleConfig || {});
      let translateConfig = normalizeTranslateConfig(result.translateConfig || {});

      const shouldReadTags = urlTags.length === 0;
      const shouldReadSchedule = Object.keys(result.scheduleConfig || {}).length === 0;
      const shouldReadTranslate = Object.keys(result.translateConfig || {}).length === 0;

      if (shouldReadTags || shouldReadSchedule || shouldReadTranslate) {
        const [tagConfig, scheduleConfigRaw, translateConfigRaw] = await Promise.all([
          shouldReadTags ? fetchJsonFile('config/tag.json', []) : Promise.resolve(urlTags),
          shouldReadSchedule ? fetchJsonFile('config/cron.json', DEFAULT_SCHEDULE_CONFIG) : Promise.resolve(scheduleConfig),
          shouldReadTranslate ? fetchJsonFile('config/trans.json', DEFAULT_TRANSLATE_CONFIG) : Promise.resolve(translateConfig)
        ]);

        urlTags = normalizeUrlTags(tagConfig);
        scheduleConfig = normalizeScheduleConfig(scheduleConfigRaw);
        translateConfig = normalizeTranslateConfig(translateConfigRaw);
      }

      state.urlTags = urlTags;
      state.scheduleConfig = scheduleConfig;
      state.translateConfig = translateConfig;
      renderAll();
    } catch (e) {
      console.error('[ShortScraping] 加载当前配置失败:', e);
      showStatus(`加载配置失败：${e.message}`, false);
      renderAll();
    }
  }

  async function reloadConfig() {
    try {
      const [tagConfigRaw, scheduleConfigRaw, translateConfigRaw] = await Promise.all([
        fetchJsonFile('config/tag.json', null),
        fetchJsonFile('config/cron.json', DEFAULT_SCHEDULE_CONFIG),
        fetchJsonFile('config/trans.json', DEFAULT_TRANSLATE_CONFIG)
      ]);

      // tag.json 读取失败 ≠ 清空订阅：沿用 storage 现有订阅，避免触发后台误清全部历史
      let urlTags;
      let tagNote = '';
      if (Array.isArray(tagConfigRaw)) {
        urlTags = normalizeUrlTags(tagConfigRaw);
      } else {
        const stored = await chrome.storage.local.get('urlTags');
        urlTags = normalizeUrlTags(stored.urlTags || []);
        tagNote = '；tag.json 读取失败，订阅沿用当前配置';
      }

      const scheduleConfig = normalizeScheduleConfig(scheduleConfigRaw);
      const translateConfig = normalizeTranslateConfig(translateConfigRaw);
      await applyConfig(urlTags, scheduleConfig, translateConfig);

      showStatus(`已读取配置：${urlTags.length} 个 URL，${getScheduleText(scheduleConfig)}，翻译模式=${translateConfig.translateMode}${tagNote}`, !tagNote);
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
      await chrome.storage.local.set({ urlTags: state.urlTags });
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
      const translateConfig = normalizeTranslateConfig(await fetchJsonFile('config/trans.json', DEFAULT_TRANSLATE_CONFIG));
      state.translateConfig = translateConfig;
      await chrome.storage.local.set({ translateConfig });
      renderTranslateForm();
      renderConfigSummary();
      showStatus(`已从 config/trans.json 读取翻译接口配置，当前模式=${translateConfig.translateMode}`, true);
    } catch (e) {
      console.error('[ShortScraping] 读取翻译接口配置失败:', e);
      showStatus(`读取翻译接口配置失败：${e.message}`, false);
    }
  }

  async function applyConfig(urlTags, scheduleConfig, translateConfig) {
    state.urlTags = normalizeUrlTags(urlTags);
    state.scheduleConfig = normalizeScheduleConfig(scheduleConfig);
    state.translateConfig = normalizeTranslateConfig(translateConfig);

    await chrome.storage.local.set({
      urlTags: state.urlTags,
      scheduleConfig: state.scheduleConfig,
      translateConfig: state.translateConfig
    });

    const response = await chrome.runtime.sendMessage({ action: 'updateAlarms', force: true });
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
    state.activeTab = tabName;

    elements.tabs.forEach(button => {
      button.classList.toggle('active', button.dataset.tab === tabName);
    });

    elements.panels.forEach(panel => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });
  }

  function renderAll() {
    renderConfigSummary();
    renderScheduleSummary();
    renderSubscriptions();
    renderTranslateForm();
  }

  function renderConfigSummary() {
    elements.configSummary.innerHTML = '';

    const cards = [
      { label: '网页订阅', value: `${state.urlTags.length} 个 URL` },
      { label: '定时任务', value: getScheduleText(state.scheduleConfig) },
      { label: '翻译接口', value: getTranslateText(state.translateConfig) }
    ];

    cards.forEach(card => {
      elements.configSummary.appendChild(createSummaryCard(card.label, card.value));
    });
  }

  function renderScheduleSummary() {
    elements.scheduleSummary.innerHTML = '';

    const config = state.scheduleConfig || {};
    const cards = [
      { label: '配置文件', value: 'config/cron.json' },
      { label: '调度模式', value: config.scheduleMode === 'cron' ? 'Cron' : '间隔执行' },
      { label: '抓取计划', value: config.scheduleMode === 'cron' ? (config.scrapeCron || '未配置') : `${config.scrapeInterval || 6} 小时` },
      { label: '翻译计划', value: config.scheduleMode === 'cron' ? (config.translateCron || '未配置') : `${config.translateInterval || 1} 小时` }
    ];

    cards.forEach(card => {
      elements.scheduleSummary.appendChild(createSummaryCard(card.label, card.value));
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
    const checkedUrlSet = new Set(state.urlTags.map(item => normalizeUrlForMatch(item.urlPattern)));
    const catalogUrlSet = new Set(catalog.map(item => normalizeUrlForMatch(item.urlPattern)));
    state.legacyUrlTags = state.urlTags.filter(item => !catalogUrlSet.has(normalizeUrlForMatch(item.urlPattern)));

    SUBSCRIPTION_SITE_GROUPS.forEach(group => {
      const entries = catalog
        .map((item, index) => ({ item, index }))
        .filter(entry => siteOfUrl(entry.item.urlPattern) === group.site);
      appendSubscriptionGroup(group.label, group.icon, entries, 'catalog', checkedUrlSet, group.tag);
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
    checkbox.checked = checkedUrlSet.has(normalizeUrlForMatch(item.urlPattern));
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
   * 按域名判断订阅 URL 所属站点，与 background.js 的 siteOfUrl、content.js 的 detectSite 同规则。
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
      // 无效 URL 归入「其他」分组
    }
    return null;
  }

  function normalizeUrlForMatch(url) {
    // 尾斜杠归一：历史 tag.json 中 my-drama.com 等无尾斜杠形态也要匹配到目录规则
    return String(url || '').trim().replace(/\/+$/, '');
  }

  async function saveSubscriptions() {
    try {
      const normalized = normalizeUrlTags(readSubscriptionsFromDom());
      if (normalized.length === 0) {
        throw new Error('至少需要勾选 1 条订阅');
      }

      state.urlTags = normalized;
      await chrome.storage.local.set({ urlTags: state.urlTags });
      renderSubscriptions();
      renderConfigSummary();

      const syncResult = await trySyncTagConfig(state.urlTags);
      if (syncResult.ok) {
        showStatus(`已保存 ${state.urlTags.length} 条网页订阅，并写回 config/tag.json`, true);
      } else {
        showStatus(`已保存到扩展本地配置；写回 config/tag.json 失败：${syncResult.error}`, false);
      }
    } catch (e) {
      console.error('[ShortScraping] 保存网页订阅失败:', e);
      showStatus(`保存失败：${e.message}`, false);
    }
  }

  async function saveTranslateConfig() {
    try {
      const translateConfig = normalizeTranslateConfig(readTranslateConfigFromForm());
      state.translateConfig = translateConfig;
      await chrome.storage.local.set({ translateConfig });
      renderTranslateForm();
      renderConfigSummary();

      const syncResult = await trySyncTransConfig(translateConfig);
      if (syncResult.ok) {
        showStatus('已保存翻译接口配置，并写回 config/trans.json', true);
      } else {
        showStatus(`已保存到扩展本地配置；写回 config/trans.json 失败：${syncResult.error}`, false);
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

  async function trySyncTagConfig(urlTags) {
    try {
      const response = await fetch(TAG_CONFIG_SYNC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urlTags })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();
      if (!result?.ok) {
        throw new Error(result?.error || '同步服务返回失败');
      }

      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function trySyncTransConfig(translateConfig) {
    try {
      const response = await fetch(TRANS_CONFIG_SYNC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ translateConfig })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();
      if (!result?.ok) {
        throw new Error(result?.error || '同步服务返回失败');
      }

      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
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
      archiveInfo.textContent = '请运行 npm run sync（Windows 可双击 start-sync.bat）后再使用文件写回能力。';
      return;
    }

    text.textContent = '同步服务：检测中';
    archiveInfo.textContent = '正在检测本地同步服务...';
  }

  function normalizeUrlTags(rawTags) {
    if (!Array.isArray(rawTags)) return [];

    const seen = new Set();
    return rawTags
      .map(item => ({
        urlPattern: String(item.urlPattern || item.url || '').trim(),
        tags: parseTags(Array.isArray(item.tags) ? item.tags.join(',') : item.tags)
      }))
      .filter(item => item.urlPattern && /^https?:\/\//i.test(item.urlPattern) && item.tags.length > 0)
      .filter(item => {
        if (seen.has(item.urlPattern)) return false;
        seen.add(item.urlPattern);
        return true;
      });
  }

  function normalizeScheduleConfig(rawConfig) {
    const config = { ...DEFAULT_SCHEDULE_CONFIG, ...(rawConfig || {}) };
    const scheduleMode = config.scheduleMode === 'cron' ? 'cron' : 'interval';

    return {
      scheduleMode,
      scrapeInterval: toPositiveNumber(config.scrapeInterval, DEFAULT_SCHEDULE_CONFIG.scrapeInterval),
      translateInterval: toPositiveNumber(config.translateInterval, DEFAULT_SCHEDULE_CONFIG.translateInterval),
      scrapeCron: String(config.scrapeCron || DEFAULT_SCHEDULE_CONFIG.scrapeCron).trim(),
      translateCron: String(config.translateCron || DEFAULT_SCHEDULE_CONFIG.translateCron).trim()
    };
  }

  function normalizeTranslateConfig(rawConfig) {
    const config = { ...DEFAULT_TRANSLATE_CONFIG, ...(rawConfig || {}) };
    const translateMode = config.translateMode === 'ai' ? 'ai' : 'api';

    return {
      translateMode,
      apiEndpoint: String(config.apiEndpoint || DEFAULT_TRANSLATE_CONFIG.apiEndpoint).trim(),
      aiEndpoint: String(config.aiEndpoint || '').trim(),
      aiApiKey: String(config.aiApiKey || '').trim(),
      aiModel: String(config.aiModel || DEFAULT_TRANSLATE_CONFIG.aiModel).trim(),
      aiPrefixPrompt: String(config.aiPrefixPrompt || DEFAULT_TRANSLATE_CONFIG.aiPrefixPrompt).trim(),
      batchSize: toPositiveInteger(config.batchSize, DEFAULT_TRANSLATE_CONFIG.batchSize),
      delayMs: toNonNegativeInteger(config.delayMs, DEFAULT_TRANSLATE_CONFIG.delayMs),
      requestTimeoutSec: toPositiveInteger(config.requestTimeoutSec, DEFAULT_TRANSLATE_CONFIG.requestTimeoutSec)
    };
  }

  function parseTags(value) {
    if (Array.isArray(value)) {
      return value.map(tag => String(tag).trim()).filter(Boolean).slice(0, 3);
    }

    return String(value || '')
      .split(/[,，]/)
      .map(tag => tag.trim())
      .filter(Boolean)
      .slice(0, 3);
  }

  function toPositiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function toPositiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
  }

  function toNonNegativeInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : fallback;
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
