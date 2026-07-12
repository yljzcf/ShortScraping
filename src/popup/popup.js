/**
 * ShortScraping Popup Script
 * 渐进式加载：先显示英文卡片，翻译后更新中文
 */

(function() {
  'use strict';

  const SYNC_HEALTH_URL = 'http://127.0.0.1:31919/health';
  const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/yljzcf/ShortScraping/master/manifest.json';

  // 状态
  let state = {
    dramas: [],
    urlTags: [],
    lastScrape: null,
    lastTranslate: null,
    isLoading: false,
    activeSource: null,
    lanUrls: []
  };

  // DOM 元素
  const elements = {};

  /**
   * 初始化
   */
  function init() {
    cacheElements();
    bindEvents();
    loadData();
    checkSyncServiceStatus();
    checkVersionStatus();

    // 监听 storage 变化，实现动态更新
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== 'local') return;

      if (changes.urlTags) {
        state.urlTags = changes.urlTags.newValue || [];
      }

      if (changes.dramas) {
        state.dramas = filterDramasByConfiguredUrls(changes.dramas.newValue || []);
      } else if (changes.urlTags) {
        loadData();
        return;
      }

      if (changes.dramas || changes.urlTags) {
        renderTimeline();
        updateStats();
      }
    });
  }

  /**
   * 缓存元素
   */
  function cacheElements() {
    elements.containers = {
      timeline: document.querySelector('.timeline-container')
    };

    elements.buttons = {
      refresh: document.getElementById('btnRefresh'),
      translateAll: document.getElementById('btnTranslateAll'),
      settings: document.getElementById('btnSettings'),
      goScrape: document.getElementById('btnGoScrape')
    };

    elements.states = {
      empty: document.getElementById('emptyState'),
      loading: document.getElementById('loadingState')
    };

    elements.syncService = {
      container: document.getElementById('syncServiceStatus'),
      text: document.getElementById('syncServiceText')
    };

    elements.versionStatus = {
      container: document.getElementById('versionStatus'),
      text: document.getElementById('versionStatusText')
    };

    elements.stats = {
      total: document.getElementById('statsTotal'),
      lastUpdate: document.getElementById('statsLastUpdate'),
      status: document.getElementById('statusText')
    };

    elements.lanShare = {
      container: document.getElementById('lanShare'),
      text: document.getElementById('lanShareText'),
      qrBtn: document.getElementById('btnLanQr'),
      popover: document.getElementById('lanQrPopover'),
      qrCanvas: document.getElementById('lanQrCanvas'),
      qrUrl: document.getElementById('lanQrUrl')
    };

    elements.categoryTabs = Array.from(document.querySelectorAll('.category-tab'));
  }

  /**
   * 绑定事件
   */
  function bindEvents() {
    elements.buttons.refresh.addEventListener('click', refreshData);
    elements.buttons.translateAll.addEventListener('click', translateAllData);
    elements.buttons.settings.addEventListener('click', openSettings);
    elements.syncService.container.addEventListener('click', checkSyncServiceStatus);
    elements.versionStatus.container.addEventListener('click', checkVersionStatus);
    elements.lanShare.container.addEventListener('click', onLanShareClick);
    elements.lanShare.qrBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLanQrPopover();
    });
    // 点浮层与局域网区块之外的任意位置关闭二维码
    document.addEventListener('click', (e) => {
      const { popover, container } = elements.lanShare;
      if (!popover.classList.contains('hidden') &&
          !popover.contains(e.target) &&
          !container.contains(e.target)) {
        popover.classList.add('hidden');
      }
    });

    elements.categoryTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const source = tab.dataset.source;
        if (source === state.activeSource) {
          refreshActiveSource(tab);
        } else {
          setActiveCategory(source);
        }
      });
    });

    elements.buttons.goScrape.addEventListener('click', () => {
      const urls = getConfiguredScrapeUrls();
      const hostBySource = { imdb: 'imdb.com', steam: 'store.steampowered.com', royalroad: 'royalroad.com', mydrama: 'my-drama.com', reelshort: 'reelshort.com', dramashorts: 'dramashorts.io' };
      const host = hostBySource[state.activeSource] || 'imdb.com';
      const target = urls.find(u => u.includes(host)) || urls[0];
      if (target) {
        chrome.tabs.create({ url: target });
        return;
      }

      openSettings();
    });
  }

  /**
   * 检查本地 CSV 同步服务状态。
   */
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
      updateSyncServiceStatus(result?.ok ? 'on' : 'off');
      updateLanShare(result?.ok ? (Array.isArray(result.lanUrls) ? result.lanUrls : []) : null);
      if (result?.ok) {
        // 服务健康即让后台预热一次共享快照：服务比扩展后启动时，
        // SW 启动时的预热推送已丢失，靠弹窗打开补喂（服务端同内容不广播）
        chrome.runtime.sendMessage({ action: 'warmupCsvSync' }).catch(() => {});
      }
    } catch (e) {
      updateSyncServiceStatus('off');
      updateLanShare(null);
    }
  }

  /**
   * 更新底栏局域网共享区块。
   * lanUrls 为 null：同步服务未启动；空数组：服务在但无局域网地址
   * （--local-only 模式或旧版服务）；非空：展示首个地址，其余进悬停提示。
   */
  function updateLanShare(lanUrls) {
    const { container, text, qrBtn, popover } = elements.lanShare;
    container.classList.remove('is-on', 'is-off');
    state.lanUrls = Array.isArray(lanUrls) ? lanUrls : [];

    if (lanUrls === null) {
      container.classList.add('is-off');
      container.title = '同步服务未启动：运行 server/start-sync.bat 后点击重新检测';
      text.textContent = '未启动';
      qrBtn.classList.add('hidden');
      popover.classList.add('hidden');
      return;
    }

    if (state.lanUrls.length === 0) {
      container.classList.add('is-off');
      container.title = '同步服务未返回局域网地址（--local-only 模式或旧版服务）；重启最新版同步服务后点击重新检测';
      text.textContent = '不可用';
      qrBtn.classList.add('hidden');
      popover.classList.add('hidden');
      return;
    }

    const primary = state.lanUrls[0];
    container.classList.add('is-on');
    const extra = state.lanUrls.length > 1
      ? `\n其他候选：${state.lanUrls.slice(1).join('、')}`
      : '';
    container.title = `局域网共享链接：点击复制 ${primary}${extra}`;
    text.textContent = primary.replace(/^https?:\/\//, '');
    qrBtn.classList.remove('hidden');
  }

  /**
   * 点击局域网区块：有链接则复制，无链接则触发重新检测。
   */
  async function onLanShareClick() {
    if (state.lanUrls.length === 0) {
      checkSyncServiceStatus();
      return;
    }

    const url = state.lanUrls[0];
    try {
      // 无用户激活/文档失焦时 writeText 可能既不成功也不拒绝地挂起，超时即走兜底
      await Promise.race([
        navigator.clipboard.writeText(url),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 600))
      ]);
    } catch (e) {
      // 剪贴板 API 被拒或超时，退回隐藏输入框方案
      const input = document.createElement('textarea');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }

    const restore = url.replace(/^https?:\/\//, '');
    elements.lanShare.text.textContent = '已复制 ✓';
    setTimeout(() => {
      elements.lanShare.text.textContent = restore;
    }, 1200);
  }

  function toggleLanQrPopover() {
    const { popover, qrCanvas, qrUrl } = elements.lanShare;
    if (!popover.classList.contains('hidden')) {
      popover.classList.add('hidden');
      return;
    }
    if (state.lanUrls.length === 0) return;

    const url = state.lanUrls[0];
    try {
      QrCode.drawToCanvas(qrCanvas, url, 4, 4);
      qrUrl.textContent = url;
      popover.classList.remove('hidden');
    } catch (e) {
      console.error('[ShortScraping] 二维码生成失败:', e);
    }
  }

  function updateSyncServiceStatus(status) {
    const container = elements.syncService.container;
    const text = elements.syncService.text;

    container.classList.remove('is-on', 'is-off');

    if (status === 'on') {
      container.classList.add('is-on');
      container.title = '本地 CSV 同步服务已开启，点击可重新检测';
      text.textContent = '同步服务：已开启';
      return;
    }

    if (status === 'off') {
      container.classList.add('is-off');
      container.title = '本地 CSV 同步服务未开启，请运行 server/start-sync.bat；点击可重新检测';
      text.textContent = '同步服务：已关闭';
      return;
    }

    container.title = '正在检测本地 CSV 同步服务';
    text.textContent = '同步服务：检测中';
  }

  /**
   * 检查远端（GitHub master）是否发布了新版本。
   */
  async function checkVersionStatus() {
    updateVersionStatus('checking');

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);

      const response = await fetch(REMOTE_MANIFEST_URL, {
        cache: 'no-store',
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const remoteVersion = String((await response.json())?.version || '').trim();
      if (!remoteVersion) {
        throw new Error('远端 manifest 缺少 version');
      }

      const hasUpgrade = compareVersions(remoteVersion, getLocalVersion()) > 0;
      updateVersionStatus(hasUpgrade ? 'upgrade' : 'latest', remoteVersion);
    } catch (e) {
      updateVersionStatus('fail');
    }
  }

  function getLocalVersion() {
    return chrome.runtime.getManifest().version;
  }

  /**
   * 按点分数字段比较版本号，返回正数表示 a 比 b 新。
   */
  function compareVersions(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  function updateVersionStatus(status, remoteVersion) {
    const container = elements.versionStatus.container;
    const text = elements.versionStatus.text;
    const local = getLocalVersion();

    container.classList.remove('is-latest', 'is-upgrade', 'is-fail');

    if (status === 'latest') {
      container.classList.add('is-latest');
      container.title = `当前 v${local} 已是最新（远端 v${remoteVersion}）；点击重新检查`;
      text.textContent = `v${local} · 已是最新`;
      return;
    }

    if (status === 'upgrade') {
      container.classList.add('is-upgrade');
      container.title = `远端已发布 v${remoteVersion}：git pull 更新代码后在 chrome://extensions 重载扩展；点击重新检查`;
      text.textContent = `v${local} → v${remoteVersion} 可更新`;
      return;
    }

    if (status === 'fail') {
      container.classList.add('is-fail');
      container.title = '远端版本检查失败（网络或 GitHub 不可达），点击重试';
      text.textContent = `v${local} · 检查失败`;
      return;
    }

    container.title = '正在检查远端版本';
    text.textContent = `v${local} · 检查中`;
  }

  /**
   * 加载数据
   */
  async function loadData() {
    showLoading(true);

    try {
      const result = await chrome.storage.local.get(['dramas', 'urlTags', 'lastScrape', 'lastTranslate']);

      state.urlTags = result.urlTags || [];
      state.dramas = filterDramasByConfiguredUrls(result.dramas || []);
      state.lastScrape = result.lastScrape;
      state.lastTranslate = result.lastTranslate;

      renderTimeline();
      updateStats();
    } catch (e) {
      console.error('[ShortScraping] 加载数据失败:', e);
    } finally {
      showLoading(false);
    }
  }

  /**
   * 刷新数据：触发后台抓取设置中的全部 URL
   */
  async function refreshData() {
    elements.buttons.refresh.style.animation = 'spin 1s linear infinite';
    elements.buttons.refresh.disabled = true;

    try {
      console.log('[ShortScraping] 手动触发后台全量抓取');
      const response = await chrome.runtime.sendMessage({ action: 'triggerScrape' });

      if (!response?.success) {
        throw new Error(response?.error || '后台抓取失败');
      }

      console.log('[ShortScraping] 后台抓取完成:', response.summary);
      await loadData();
    } catch (e) {
      console.error('[ShortScraping] 刷新失败:', e);
    } finally {
      elements.buttons.refresh.disabled = false;
      elements.buttons.refresh.style.animation = '';
    }
  }

  /**
   * 再次点击已激活的站点标签：只抓取该站点的订阅 URL
   */
  async function refreshActiveSource(tab) {
    const source = state.activeSource;
    if (!source || tab.classList.contains('is-refreshing')) return;

    tab.classList.add('is-refreshing');

    try {
      console.log(`[ShortScraping] 手动触发站点抓取: ${source}`);
      const response = await chrome.runtime.sendMessage({ action: 'triggerScrape', site: source });

      if (!response?.success) {
        throw new Error(response?.error || '后台抓取失败');
      }

      console.log('[ShortScraping] 站点抓取完成:', response.summary);
      await loadData();
    } catch (e) {
      console.error('[ShortScraping] 站点刷新失败:', e);
    } finally {
      tab.classList.remove('is-refreshing');
    }
  }

  /**
   * 全部翻译：让后台检查所有待翻译条目（status=new 且属订阅来源）并执行一轮翻译。
   * 任务跑在后台 SW，弹窗关闭也会继续；每条译文经单写者队列落库后由
   * storage.onChanged 实时刷新卡片，翻译过程肉眼可见。
   */
  async function translateAllData() {
    const btn = elements.buttons.translateAll;
    btn.disabled = true;
    btn.textContent = '⏳';

    try {
      console.log('[ShortScraping] 手动触发全部翻译');
      const response = await chrome.runtime.sendMessage({ action: 'triggerTranslate' });

      if (!response?.success) {
        throw new Error(response?.error || '后台翻译失败');
      }
      if (response.summary?.error) {
        throw new Error(response.summary.error);
      }

      const { pendingCount = 0, translatedCount = 0 } = response.summary || {};
      btn.title = pendingCount > 0
        ? `全部翻译：本轮检查到 ${pendingCount} 条待翻译，已翻译 ${translatedCount} 条`
        : '全部翻译：当前没有待翻译条目';
      console.log('[ShortScraping] 全部翻译完成:', response.summary);
      btn.textContent = '✅';
    } catch (e) {
      console.error('[ShortScraping] 全部翻译失败:', e);
      btn.title = `全部翻译失败：${e.message}，可点击重试`;
      btn.textContent = '❌';
    } finally {
      setTimeout(() => {
        btn.textContent = '🌐';
        btn.disabled = false;
      }, 2000);
    }
  }

  /**
   * 打开设置
   */
  function openSettings() {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/settings/settings.html') });
  }

  /**
   * 翻译单张卡片
   */
  async function translateSingleCard(dramaId, btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳';

    try {
      // 找到对应的数据
      const drama = state.dramas.find(d => d.id === dramaId);
      if (!drama) {
        throw new Error('未找到该卡片数据');
      }

      // 调用翻译
      if (typeof Translator === 'undefined' || typeof Translator.translateTitleAndDesc !== 'function') {
        throw new Error('翻译模块未正确加载，请刷新扩展后重试');
      }

      console.log('[ShortScraping] 开始翻译:', drama.title);
      const result = await Translator.translateTitleAndDesc(drama.title, drama.description);
      console.log('[ShortScraping] 翻译结果:', result);

      if (!result?.title && !result?.desc) {
        throw new Error('翻译结果为空，请检查翻译接口配置或控制台错误');
      }

      // 写入结果：经后台单写者队列，避免与并行的抓取/翻译写互相覆盖
      const applied = await chrome.runtime.sendMessage({ action: 'applyTranslation', dramaId, result });
      if (!applied?.success) {
        throw new Error(applied?.error || '后台写入翻译结果失败');
      }
      // UI 会通过 storage.onChanged 自动更新

      btn.innerHTML = '✅';
      setTimeout(() => {
        btn.innerHTML = '🌍';
        btn.disabled = false;
      }, 2000);

    } catch (e) {
      console.error('[ShortScraping] 翻译失败:', e);
      btn.innerHTML = '❌';
      setTimeout(() => {
        btn.innerHTML = '🌍';
        btn.disabled = false;
      }, 2000);
    }
  }

  /**
   * 渲染时间线：站点筛选与空状态切换归弹窗管，分组/卡片渲染走共享模块
   * TimelineRender（src/shared/timeline-render.js，与局域网共享页共用同一份文件）。
   */
  function getVisibleDramas() {
    const src = state.activeSource || 'imdb';
    return state.dramas.filter(d => TimelineRender.dramaSource(d) === src);
  }

  function updateCategoryTabs() {
    elements.categoryTabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.source === state.activeSource);
    });
  }

  function setActiveCategory(source) {
    if (!TimelineRender.CATEGORY_SOURCES.includes(source)) return;
    state.activeSource = source;
    updateCategoryTabs();
    renderTimeline();
    updateStats();
  }

  function renderTimeline() {
    if (!state.activeSource) state.activeSource = TimelineRender.pickDefaultSource(state.dramas);
    updateCategoryTabs();

    const hasData = TimelineRender.renderTimeline(elements.containers.timeline, getVisibleDramas(), {
      source: state.activeSource,
      readOnly: false,
      assetsBase: '../../assets/icons',
      onTranslate: translateSingleCard
    });
    elements.states.empty.classList.toggle('hidden', hasData);
  }

  function getConfiguredScrapeUrls() {
    const urls = (state.urlTags || [])
      .map(item => item.urlPattern || item.url)
      .filter(pattern => /^https?:\/\//i.test(pattern));

    return Array.from(new Set(urls));
  }

  function filterDramasByConfiguredUrls(dramas) {
    const configuredUrls = getConfiguredScrapeUrls();
    if (configuredUrls.length === 0) return [];

    return (dramas || []).filter(drama => {
      if (!drama.sourceListUrl) return false;
      return configuredUrls.some(url => drama.sourceListUrl === url || drama.sourceListUrl.startsWith(url));
    });
  }

  /**
   * 更新统计
   */
  function updateStats() {
    const visible = getVisibleDramas();
    const total = visible.length;
    const translated = visible.filter(d => d.status === 'trans').length;
    const pending = total - translated;

    elements.stats.total.textContent = `${total} 部`;
    elements.stats.lastUpdate.textContent = state.lastScrape
      ? `抓取于 ${TimelineRender.formatRelativeTime(state.lastScrape)}`
      : '未抓取';
    elements.stats.status.textContent = pending > 0
      ? `${translated} 已翻译, ${pending} 待翻译`
      : '全部已翻译';
  }

  /**
   * 显示/隐藏加载状态
   */
  function showLoading(show) {
    state.isLoading = show;
    elements.states.loading.classList.toggle('hidden', !show);
  }

  // 初始化
  document.addEventListener('DOMContentLoaded', init);
})();
