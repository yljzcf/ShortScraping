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
    lanUrls: [],
    syncServerDir: null
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
    reconcileTranslateState();

    // 监听 storage 变化，实现动态更新
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== 'local') return;

      // 翻译按钮状态机独立分支，不触碰下面的卡片渲染逻辑
      if (changes.translateRunState) {
        handleTranslateRunStateChange(changes.translateRunState.newValue);
      }

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
      translateAll: document.getElementById('btnTranslateAll'),
      settings: document.getElementById('btnSettings'),
      goScrape: document.getElementById('btnGoScrape')
    };

    elements.states = {
      empty: document.getElementById('emptyState'),
      loading: document.getElementById('loadingState')
    };

    elements.toastBar = document.getElementById('toastBar');

    elements.syncService = {
      container: document.getElementById('syncServiceStatus'),
      text: document.getElementById('syncServiceText'),
      folderBtn: document.getElementById('btnSyncFolder'),
      startBtn: document.getElementById('btnSyncStart')
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
    elements.buttons.translateAll.addEventListener('click', translateAllData);
    elements.buttons.settings.addEventListener('click', openSettings);
    elements.syncService.container.addEventListener('click', checkSyncServiceStatus);
    elements.syncService.folderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onSyncFolderClick();
    });
    elements.syncService.startBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onSyncStartClick();
    });
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
        cacheSyncServerDir(result);
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
   * 缓存同步服务脚本目录：优先服务端新字段 serverDir，旧版服务从 csvPath
   * （<项目>/db/timeline.csv）推导。落库后即使服务已关闭，📁 也能给出路径
   * （扩展无法感知自己的磁盘路径，只能从服务端学来）。
   */
  function cacheSyncServerDir(health) {
    let dir = (typeof health?.serverDir === 'string' && health.serverDir) ? health.serverDir : null;

    if (!dir && typeof health?.csvPath === 'string' && health.csvPath) {
      const sep = health.csvPath.includes('\\') ? '\\' : '/';
      const parts = health.csvPath.split(/[\\/]/);
      if (parts.length >= 3) {
        dir = parts.slice(0, -2).concat('server').join(sep);
      }
    }

    if (dir && dir !== state.syncServerDir) {
      state.syncServerDir = dir;
      chrome.storage.local.set({ syncServerDir: dir }).catch(() => {});
    }
  }

  async function getSyncServerDir() {
    if (state.syncServerDir) return state.syncServerDir;
    const { syncServerDir } = await chrome.storage.local.get('syncServerDir');
    state.syncServerDir = syncServerDir || null;
    return state.syncServerDir;
  }

  function isWindowsPlatform() {
    return /Win/i.test(navigator.platform || '');
  }

  /**
   * 触发 shortscraping:// 自定义协议（需用户运行过 server/setup-launcher.bat
   * 注册）。外部协议导航不会真正离开页面：已注册时 Chrome 弹确认框（可勾选
   * 一律允许），未注册时静默无反应——因此配套提示条给出降级指引。
   */
  function triggerLauncherProtocol(action) {
    try {
      window.location.href = `shortscraping://${action}`;
    } catch (e) {
      console.warn('[ShortScraping] 协议触发失败:', e);
    }
  }

  /**
   * 📁：尝试经已注册协议打开 server 文件夹；同时复制路径作为全平台降级
   * （扩展无法直接开资源管理器，也无法探知协议是否已注册）。
   */
  async function onSyncFolderClick() {
    triggerLauncherProtocol('open-folder');

    const dir = await getSyncServerDir();
    if (!dir) {
      showToast('尚未获取到路径：请先启动一次同步服务（运行 npm run sync）', { type: 'error', duration: 4000 });
      return;
    }

    await copyTextToClipboard(dir);
    showToast(
      isWindowsPlatform()
        ? '路径已复制：未自动打开时 Win+E 粘贴，或运行 setup-launcher.bat 注册一键打开'
        : '路径已复制：在 Finder 按 ⌘⇧G 粘贴打开（一键集成仅支持 Windows）',
      { duration: 4000 }
    );
  }

  /**
   * ▶ 一键启动：经协议拉起 start-sync.bat，随后轮询 /health 等服务上线。
   * 未注册协议时协议触发静默无反应，轮询超时后给出降级指引。
   */
  async function onSyncStartClick() {
    const btn = elements.syncService.startBtn;
    if (btn.disabled) return;
    btn.disabled = true;

    triggerLauncherProtocol('start-sync');
    showToast('已尝试启动同步服务，正在检测…', { duration: 13000 });

    try {
      const ok = await waitForSyncServiceUp(8, 1500);
      if (ok) {
        showToast('同步服务已启动 ✓', { type: 'success' });
      } else {
        showToast(
          isWindowsPlatform()
            ? '未检测到服务：请运行 server/start-sync.bat（一键启动需先运行 setup-launcher.bat 注册）'
            : '未检测到服务：请在项目目录运行 npm run sync（一键启动仅支持 Windows）',
          { type: 'error', duration: 5000 }
        );
      }
    } finally {
      btn.disabled = false;
    }
  }

  async function waitForSyncServiceUp(attempts, intervalMs) {
    for (let i = 0; i < attempts; i++) {
      await new Promise(r => setTimeout(r, intervalMs));
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1200);
        const response = await fetch(SYNC_HEALTH_URL, { cache: 'no-store', signal: controller.signal });
        clearTimeout(timer);
        if (response.ok && (await response.json())?.ok) {
          await checkSyncServiceStatus();
          return true;
        }
      } catch (e) {
        // 服务尚未起来，继续轮询
      }
    }
    return false;
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
      container.title = '同步服务未启动：运行 npm run sync（Windows 可双击 start-sync.bat）后点击重新检测';
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
   * 复制文本到剪贴板。无用户激活/文档失焦时 writeText 可能既不成功也不
   * 拒绝地挂起，600ms 超时即退回隐藏输入框方案。
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
      input.select();
      document.execCommand('copy');
      input.remove();
    }
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
    await copyTextToClipboard(url);

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
    // ▶ 启动按钮只在确认服务未开启时出现
    elements.syncService.startBtn.classList.toggle('hidden', status !== 'off');

    if (status === 'on') {
      container.classList.add('is-on');
      container.title = '本地 CSV 同步服务已开启，点击可重新检测';
      text.textContent = '同步服务：已开启';
      return;
    }

    if (status === 'off') {
      container.classList.add('is-off');
      container.title = '本地 CSV 同步服务未开启，请运行 npm run sync（Windows 可双击 start-sync.bat）；点击可重新检测';
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
      const result = await chrome.storage.local.get(['dramas', 'urlTags', 'lastScrape', 'lastTranslate', 'syncServerDir']);

      state.urlTags = result.urlTags || [];
      state.dramas = filterDramasByConfiguredUrls(result.dramas || []);
      state.lastScrape = result.lastScrape;
      state.lastTranslate = result.lastTranslate;
      state.syncServerDir = result.syncServerDir || state.syncServerDir;

      renderTimeline();
      updateStats();
    } catch (e) {
      console.error('[ShortScraping] 加载数据失败:', e);
    } finally {
      showLoading(false);
    }
  }

  /**
   * 状态栏下方的临时提示条。重复调用清旧计时器换新文案（last-write-wins）。
   */
  let toastTimer = null;

  function showToast(message, { type = 'info', duration = 3000 } = {}) {
    const bar = elements.toastBar;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }

    bar.textContent = message;
    bar.classList.remove('hidden', 'is-info', 'is-success', 'is-error');
    bar.classList.add(`is-${type}`);

    toastTimer = setTimeout(() => {
      toastTimer = null;
      bar.classList.add('hidden');
    }, duration);
  }

  /**
   * 把单站点抓取 summary 转成提示条文案。
   */
  function toastScrapeSummary(summary) {
    const results = summary?.results || [];
    const failedCount = results.filter(r => !r.success).length;
    const newCount = summary?.totalNewCount || 0;

    if (results.length > 0 && failedCount === results.length) {
      const reason = results[0]?.error || '未知错误';
      showToast(`刷新失败：${reason}`, { type: 'error' });
      return;
    }

    if (failedCount > 0) {
      showToast(`本次刷新新增 ${newCount} 条，${failedCount} 个来源失败`, { type: newCount > 0 ? 'success' : 'error' });
      return;
    }

    showToast(
      newCount > 0 ? `本次刷新新增 ${newCount} 条内容` : '本次刷新无新增内容',
      { type: newCount > 0 ? 'success' : 'info' }
    );
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
      toastScrapeSummary(response.summary);
    } catch (e) {
      console.error('[ShortScraping] 站点刷新失败:', e);
      showToast(`刷新失败：${e.message}`, { type: 'error' });
    } finally {
      tab.classList.remove('is-refreshing');
    }
  }

  /**
   * 全部翻译按钮状态机。任务跑在后台 SW（弹窗关闭也继续），按钮不再依赖
   * 可能挂几十分钟的 sendMessage 往返，而是由 SW 持久化的 translateRunState
   * 驱动：点击只做触发与传输错误反馈，进度/终态经 storage.onChanged 到达，
   * 弹窗重开时经 getTranslateState 对账（后台在翻则恢复 ⏳）。
   */
  const translateUi = {
    manualPending: false,  // 本弹窗发起过手动翻译，终态时显示 ✅/❌ 反馈
    sawRunning: false,     // 本弹窗见过 running:true，终态需 1.5s 宽限吸收轮间隙
    graceTimer: null,
    terminalTimer: null
  };

  function clearTranslateTimers() {
    if (translateUi.graceTimer) {
      clearTimeout(translateUi.graceTimer);
      translateUi.graceTimer = null;
    }
    if (translateUi.terminalTimer) {
      clearTimeout(translateUi.terminalTimer);
      translateUi.terminalTimer = null;
    }
  }

  function setTranslateBusy(state) {
    const btn = elements.buttons.translateAll;
    btn.disabled = true;
    btn.textContent = '⏳';
    btn.title = typeof state?.processedCount === 'number'
      ? `翻译中：已处理 ${state.processedCount}/${state.pendingCount}，成功 ${state.translatedCount}`
      : '翻译中…';
  }

  function resetTranslateButton() {
    const btn = elements.buttons.translateAll;
    btn.textContent = '🌐';
    btn.disabled = false;
    btn.title = '全部翻译：检查所有待翻译条目并开始翻译';
  }

  /**
   * 弹窗打开时向 SW 对账一次（顺带唤醒 SW，触发其孤儿状态清理）。
   * 只对「正在翻译」起反应；陈旧终态忽略，不补显示结果。
   */
  async function reconcileTranslateState() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getTranslateState' });
      if (response?.running) {
        translateUi.sawRunning = true;
        setTranslateBusy(response.state);
      }
    } catch (e) {
      // SW 不可达的罕见情况：保持默认空闲态
    }
  }

  /**
   * translateRunState 变化驱动按钮。抓取后翻译线轮与轮之间有 1s 间隙
   * （running false→true 翻转），见过 running 的终态延迟 1.5s 生效吸收之；
   * 手动空轮从未 running，立即反馈「没有待翻译条目」。
   */
  function handleTranslateRunStateChange(state) {
    if (!state) return;

    if (state.running) {
      clearTranslateTimers();
      translateUi.sawRunning = true;
      setTranslateBusy(state);
      return;
    }

    clearTranslateTimers();
    if (translateUi.sawRunning) {
      translateUi.graceTimer = setTimeout(() => {
        translateUi.graceTimer = null;
        showTranslateTerminal(state);
      }, 1500);
    } else {
      showTranslateTerminal(state);
    }
  }

  function showTranslateTerminal(state) {
    translateUi.sawRunning = false;

    if (!translateUi.manualPending) {
      // 旁观的定时/抓取后翻译轮结束：静默复位，不抢反馈
      resetTranslateButton();
      return;
    }

    translateUi.manualPending = false;
    const btn = elements.buttons.translateAll;
    const summary = state.summary || {};

    if (summary.error) {
      btn.textContent = '❌';
      btn.title = `全部翻译失败：${summary.error}，可点击重试`;
    } else if ((summary.pendingCount || 0) === 0) {
      btn.textContent = '✅';
      btn.title = '全部翻译：当前没有待翻译条目';
    } else {
      btn.textContent = '✅';
      btn.title = `全部翻译：本轮检查到 ${summary.pendingCount} 条待翻译，成功翻译 ${summary.translatedCount || 0} 条`;
    }

    translateUi.terminalTimer = setTimeout(() => {
      translateUi.terminalTimer = null;
      resetTranslateButton();
    }, 2000);
  }

  async function translateAllData() {
    translateUi.manualPending = true;
    clearTranslateTimers();
    setTranslateBusy(null);

    try {
      console.log('[ShortScraping] 手动触发全部翻译');
      const response = await chrome.runtime.sendMessage({ action: 'triggerTranslate' });

      if (!response?.success) {
        throw new Error(response?.error || '后台翻译失败');
      }
      // 立即 ack；进度与终态由 handleTranslateRunStateChange 驱动
    } catch (e) {
      console.error('[ShortScraping] 全部翻译失败:', e);
      translateUi.manualPending = false;
      const btn = elements.buttons.translateAll;
      btn.textContent = '❌';
      btn.title = `全部翻译失败：${e.message}，可点击重试`;
      translateUi.terminalTimer = setTimeout(() => {
        translateUi.terminalTimer = null;
        resetTranslateButton();
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
