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
    isLoading: false,
    activeSource: null,
    // 分组代表 logo 的固定项（设置页写入）：{ [group]: site|null }
    groupPins: {},
    refreshingSite: null,
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

      // 设置页改了分组固定 logo：只重画标签条，不动卡片
      if (changes.siteTabPrefs) {
        const prefs = changes.siteTabPrefs.newValue || {};
        state.groupPins = prefs.pins || {};
        renderCategoryTabs();
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
        // 抓取洪峰期 storage 每保存一张卡变更一次，整树重渲染合并为 ≤1 次/秒
        scheduleRender();
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

    // 标签条内容由 SiteTabs 动态渲染，这里只缓存容器
    elements.categoryTabs = document.getElementById('categoryTabs');
    elements.content = document.querySelector('.content');
  }

  /**
   * 绑定事件
   */
  /**
   * div[role="button"] 的键盘可达绑定：click + Enter/Space 键激活
   * （Space 需 preventDefault 防页面滚动）。原生 button 不需要此包装。
   */
  function bindActivatable(el, handler) {
    el.addEventListener('click', handler);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handler(e);
      }
    });
  }

  function bindEvents() {
    elements.buttons.translateAll.addEventListener('click', translateAllData);
    elements.buttons.settings.addEventListener('click', openSettings);
    bindActivatable(elements.syncService.container, checkSyncServiceStatus);
    elements.syncService.folderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onSyncFolderClick();
    });
    elements.syncService.startBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onSyncStartClick();
    });
    // 箭头包装防 click 事件对象误入参数位；手动重检永远绕过缓存
    bindActivatable(elements.versionStatus.container, () => checkVersionStatus({ force: true }));
    bindActivatable(elements.lanShare.container, onLanShareClick);
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
    // Esc 关闭二维码浮层并把焦点归还开启按钮
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const { popover, qrBtn } = elements.lanShare;
      if (!popover.classList.contains('hidden')) {
        popover.classList.add('hidden');
        qrBtn.focus();
      }
    });

    elements.buttons.goScrape.addEventListener('click', () => {
      const urls = getConfiguredScrapeUrls();
      const host = SiteRegistry.hostBySource[state.activeSource] || 'imdb.com';
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
      popover.focus(); // 焦点移入 dialog，Esc 关闭时归还 qrBtn
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
  // 版本检查缓存：成功结果 6 小时内直接复用、失败 5 分钟退避（此前每次开弹窗
  // 都请求 GitHub raw）。缓存只存 remoteVersion——升级判定每次用本地版本现算，
  // 用户 git pull 重载扩展后不会被缓存里的陈旧判定误导。点击状态栏 force 绕过。
  const VERSION_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
  const VERSION_CHECK_FAIL_BACKOFF_MS = 5 * 60 * 1000;

  async function checkVersionStatus({ force = false } = {}) {
    if (!force) {
      try {
        const { versionCheck } = await chrome.storage.local.get('versionCheck');
        const now = Date.now();
        if (versionCheck?.remoteVersion && now - (versionCheck.checkedAt || 0) < VERSION_CHECK_TTL_MS) {
          const hasUpgrade = compareVersions(versionCheck.remoteVersion, getLocalVersion()) > 0;
          updateVersionStatus(hasUpgrade ? 'upgrade' : 'latest', versionCheck.remoteVersion);
          return;
        }
        if (versionCheck?.failedAt && now - versionCheck.failedAt < VERSION_CHECK_FAIL_BACKOFF_MS) {
          updateVersionStatus('fail');
          return;
        }
      } catch (e) {
        // 缓存读取失败不阻断检查，落到网络路径
      }
    }

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

      await chrome.storage.local.set({ versionCheck: { remoteVersion, checkedAt: Date.now() } }).catch(() => {});
      const hasUpgrade = compareVersions(remoteVersion, getLocalVersion()) > 0;
      updateVersionStatus(hasUpgrade ? 'upgrade' : 'latest', remoteVersion);
    } catch (e) {
      await chrome.storage.local.set({ versionCheck: { failedAt: Date.now() } }).catch(() => {});
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
      const result = await chrome.storage.local.get(['dramas', 'urlTags', 'lastScrape', 'syncServerDir', 'siteTabPrefs']);

      state.urlTags = result.urlTags || [];
      state.dramas = filterDramasByConfiguredUrls(result.dramas || []);
      state.lastScrape = result.lastScrape;
      state.syncServerDir = result.syncServerDir || state.syncServerDir;

      // 上次看的站点与分组固定项；首帧之后 activeSource 只由用户操作改写
      const prefs = result.siteTabPrefs || {};
      state.groupPins = prefs.pins || {};
      if (state.activeSource === null) state.activeSource = prefs.activeSource || null;

      renderNow(); // 弹窗打开首帧不经去抖
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
   * 再次点击已激活的站点标签：只抓取该站点的订阅 URL。
   * 转圈状态记在 state 里由标签条渲染读取——抓取期间卡片陆续入库会重建整条
   * 标签栏，直接给 DOM 节点加 class 会被下一次重建抹掉。
   */
  async function refreshActiveSource(site) {
    const source = site || state.activeSource;
    if (!source || state.refreshingSite) return;

    state.refreshingSite = source;
    renderCategoryTabs();

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
      state.refreshingSite = null;
      renderCategoryTabs();
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
   * 推送单张卡片到飞书（后台经多维表格工作流 webhook 投递）。
   * storage.onChanged 的全量重渲染会把按钮重建成未禁用态，仅 btn.disabled
   * 挡不住重复点击，larkInFlight 按 dramaId 兜底；终态回写按 data-id 重新
   * 查找节点，避免写到重渲染后已脱离 DOM 的旧节点。
   */
  const larkInFlight = new Set();
  const LARK_BUTTON_ICON = '<img src="../../assets/icons/lark.png" alt="Lark">';

  /**
   * 卡片右上角按钮（🌍 / Lark）的瞬态：⏳ 进行中、✅/❌ 终态 2 秒窗口。写入按 selector +
   * data-id 重查当前节点（找不到才退回传入的旧节点），并记进 cardButtonStates——
   * storage.onChanged 的全量重渲染会把按钮重建成默认态，而翻译成功本身就会触发一次
   * 重渲染（落库 → onChanged），不重贴的话 ✅ 只闪几十毫秒（2026-09-17 真机实测）。
   * renderTimeline 重建卡片后调 reapplyCardButtonStates 按记录重贴；复原默认态时忘掉。
   */
  const cardButtonStates = new Map();   // `${selector}|${dramaId}` → { selector, dramaId, html, disabled }

  function applyCardButtonState(selector, dramaId, fallbackBtn, html, disabled) {
    const btn = Array.from(elements.containers.timeline.querySelectorAll(selector))
      .find(node => node.dataset.id === dramaId) || fallbackBtn;
    if (!btn) return;
    btn.innerHTML = html;
    btn.disabled = disabled;
  }

  function setCardButtonState(selector, dramaId, fallbackBtn, html, disabled) {
    cardButtonStates.set(`${selector}|${dramaId}`, { selector, dramaId, html, disabled });
    applyCardButtonState(selector, dramaId, fallbackBtn, html, disabled);
  }

  function resetCardButtonState(selector, dramaId, fallbackBtn, defaultHtml) {
    cardButtonStates.delete(`${selector}|${dramaId}`);
    applyCardButtonState(selector, dramaId, fallbackBtn, defaultHtml, false);
  }

  function reapplyCardButtonStates() {
    for (const { selector, dramaId, html, disabled } of cardButtonStates.values()) {
      applyCardButtonState(selector, dramaId, null, html, disabled);
    }
  }

  function setLarkButtonState(dramaId, fallbackBtn, html, disabled) {
    setCardButtonState('.btn-lark', dramaId, fallbackBtn, html, disabled);
  }

  function resetLarkButtonState(dramaId, fallbackBtn) {
    resetCardButtonState('.btn-lark', dramaId, fallbackBtn, LARK_BUTTON_ICON);
  }

  async function pushCardToLark(dramaId, btn) {
    if (larkInFlight.has(dramaId)) {
      showToast('该卡片正在推送中', { type: 'info' });
      return;
    }

    larkInFlight.add(dramaId);
    setLarkButtonState(dramaId, btn, '⏳', true);

    try {
      const response = await chrome.runtime.sendMessage({ action: 'larkPush', dramaId });

      if (response?.notConfigured) {
        showToast('Lark 推送未配置，已打开设置页', { type: 'info' });
        resetLarkButtonState(dramaId, btn);
        openSettings();
        return;
      }

      if (!response?.success) {
        throw new Error(response?.error || '后台推送失败');
      }

      showToast('已推送到飞书工作流', { type: 'success' });
      setLarkButtonState(dramaId, btn, '✅', true);
    } catch (e) {
      console.error('[ShortScraping] Lark 推送失败:', e);
      showToast(`Lark 推送失败：${e.message}`, { type: 'error', duration: 5000 });
      setLarkButtonState(dramaId, btn, '❌', true);
    } finally {
      larkInFlight.delete(dramaId);
    }

    // ✅/❌ 展示 2 秒后复原图标；期间若同卡又发起新推送，交给新流程接管
    setTimeout(() => {
      if (!larkInFlight.has(dramaId)) {
        resetLarkButtonState(dramaId, btn);
      }
    }, 2000);
  }

  /**
   * 翻译单张卡片：只发 translateSingle 消息，翻译请求与落库都在后台完成——弹窗一关
   * 页面即销毁，页内发起的 fetch 会被掐断，与 Lark 推送走后台同理。防重与终态回写
   * 与 pushCardToLark 同款：translateInFlight 按 dramaId 兜底（瞬态重贴之外的第二道
   * 防线），终态经 setCardButtonState 按 data-id 重查节点。成功不弹 toast（卡片经
   * onChanged 自会刷新）；只翻出一半时后台保持待翻译等下轮补齐，要提示用户这不是失败。
   */
  const translateInFlight = new Set();
  const TRANSLATE_BUTTON_ICON = '🌍';

  async function translateSingleCard(dramaId, btn) {
    if (translateInFlight.has(dramaId)) {
      showToast('该卡片正在翻译中', { type: 'info' });
      return;
    }

    translateInFlight.add(dramaId);
    setCardButtonState('.btn-translate', dramaId, btn, '⏳', true);

    try {
      const response = await chrome.runtime.sendMessage({ action: 'translateSingle', dramaId });
      if (!response?.success) {
        throw new Error(response?.error || '后台翻译失败');
      }

      setCardButtonState('.btn-translate', dramaId, btn, '✅', true);
      if (response.complete === false) {
        showToast('只翻出一部分，已保存；剩余部分留待下轮自动补齐', { type: 'info', duration: 4000 });
      }
    } catch (e) {
      console.error('[ShortScraping] 翻译失败:', e);
      showToast(`翻译失败：${e.message}`, { type: 'error', duration: 5000 });
      setCardButtonState('.btn-translate', dramaId, btn, '❌', true);
    } finally {
      translateInFlight.delete(dramaId);
    }

    // ✅/❌ 展示 2 秒后复原图标；期间若同卡又发起新翻译，交给新流程接管
    setTimeout(() => {
      if (!translateInFlight.has(dramaId)) {
        resetCardButtonState('.btn-translate', dramaId, btn, TRANSLATE_BUTTON_ICON);
      }
    }, 2000);
  }

  /**
   * 渲染时间线：站点筛选与空状态切换归弹窗管，分组/卡片渲染走共享模块
   * TimelineRender（src/shared/timeline-render.js，与局域网共享页共用同一份文件）。
   */
  function getVisibleDramas() {
    if (!state.activeSource) return [];
    return state.dramas.filter(d => TimelineRender.dramaSource(d) === state.activeSource);
  }

  /**
   * 按域名判断订阅 URL 所属站点。规则单一真源在 src/shared/site-registry.js。
   */
  function siteOfUrl(url) {
    return SiteRegistry.siteOfUrl(url);
  }

  /**
   * 用户实际订阅了哪些站点（按域名归类订阅 URL）。图标栏据此显隐：
   * 只显示订阅集合内的站点，未订阅站点不出现空图标。
   */
  function getSubscribedSites() {
    const set = new Set();
    (state.urlTags || []).forEach(item => {
      const site = siteOfUrl(item.urlPattern || item.url);
      if (site) set.add(site);
    });
    return set;
  }

  /**
   * 折叠标签条的输入参数。展开的组由 activeSource 推导（SiteTabs 的核心不变量），
   * 所以这里不传也不存 expandedGroup。
   */
  function siteTabsInput() {
    return {
      visibleSites: getSubscribedSites(),
      activeSource: state.activeSource,
      pins: state.groupPins,
      // 代表 logo 的「最近有更新」口径：各站点条目 scrapedAt 的最大值
      latestBySite: SiteTabs.latestUpdateBySite(state.dramas)
    };
  }

  /**
   * 重画标签条。SiteTabs 会顺带把失效的 activeSource（站点已退订等）
   * 归正到默认短剧组的代表站点，这里把归正结果写回 state。
   */
  function renderCategoryTabs() {
    const layout = SiteTabs.resolveLayout(siteTabsInput());
    state.activeSource = layout.activeSource;

    SiteTabs.render(elements.categoryTabs, layout, {
      assetsBase: '../../assets/icons',
      onSelectSite: setActiveCategory,
      onExpandGroup: (group, representative) => setActiveCategory(representative),
      onRefreshSite: refreshActiveSource,
      refreshingSite: state.refreshingSite
    });
    return layout;
  }

  function setActiveCategory(source) {
    if (!TimelineRender.CATEGORY_SOURCES.includes(source) || source === state.activeSource) return;
    state.activeSource = source;
    persistActiveSource(source);
    renderNow(); // 手动切站点即时反馈，不经去抖（内部会重画标签条）
  }

  /**
   * 跨弹窗开关记住上次看的站点（展开组由它推导，故只存这一个字段，
   * 不会出现「展开组」与「活动站点」互相矛盾的状态）。与设置页的分组
   * 固定项共用 siteTabPrefs 键，读改写保住对方的字段。
   */
  async function persistActiveSource(source) {
    try {
      const result = await chrome.storage.local.get(['siteTabPrefs']);
      const prefs = result.siteTabPrefs || {};
      if (prefs.activeSource === source) return;
      await chrome.storage.local.set({
        siteTabPrefs: Object.assign({}, prefs, { activeSource: source })
      });
    } catch (e) {
      // 存储失败只影响下次打开的落点，不打断当前浏览
      console.warn('[ShortScraping] 记忆活动站点失败:', e);
    }
  }

  // —— 每个站点各自的滚动位置（弹窗本次打开期间有效）。滚动容器是 main.content；
  // 时间线每次重渲染都整树重建，不记的话后台抓取一来就把正在看的位置弹回顶部 ——
  const scrollBySource = new Map();
  // 当前 DOM 里渲染的是哪个站点。切站时 state.activeSource 先于渲染改掉，
  // 存位置必须认这个「已渲染」的站点，否则会把上一站的位置记到新站头上
  let renderedSource = null;

  function rememberScroll() {
    if (renderedSource && elements.content) {
      scrollBySource.set(renderedSource, elements.content.scrollTop);
    }
  }

  function restoreScroll() {
    if (!elements.content) return;
    // 内容变短时浏览器会自动夹取，无需自行 clamp
    elements.content.scrollTop = state.activeSource ? (scrollBySource.get(state.activeSource) || 0) : 0;
    renderedSource = state.activeSource;
  }

  // —— onChanged 渲染去抖：trailing 250ms 合并变更风暴；首个挂起变更起算 1s
  // 强制渲染上限，保住抓取过程中「卡片渐进出现」的产品可见性 ——
  const RENDER_DEBOUNCE_MS = 250;
  const RENDER_MAX_DELAY_MS = 1000;
  let renderDebounceTimer = null;
  let renderFirstPendingAt = null;

  function scheduleRender() {
    const now = Date.now();
    if (renderFirstPendingAt === null) renderFirstPendingAt = now;
    if (renderDebounceTimer) {
      // 达到强制上限：让已挂起的定时器到点执行，不再顺延
      if (now - renderFirstPendingAt >= RENDER_MAX_DELAY_MS) return;
      clearTimeout(renderDebounceTimer);
    }
    renderDebounceTimer = setTimeout(() => {
      renderDebounceTimer = null;
      renderFirstPendingAt = null;
      renderTimeline();
      updateStats();
    }, RENDER_DEBOUNCE_MS);
  }

  /** 立即渲染（首帧/手动切换用），并吸收所有挂起的去抖变更。 */
  function renderNow() {
    if (renderDebounceTimer) {
      clearTimeout(renderDebounceTimer);
      renderDebounceTimer = null;
    }
    renderFirstPendingAt = null;
    renderTimeline();
    updateStats();
  }

  function renderTimeline() {
    // 整树重建会丢滚动位置，重建前后自存自取（同站点重渲染也保住位置）
    rememberScroll();
    // 活动站点必须落在已订阅集合内；为空或已退订由 SiteTabs 在此归正（可能为 null）
    renderCategoryTabs();

    const hasData = TimelineRender.renderTimeline(elements.containers.timeline, getVisibleDramas(), {
      source: state.activeSource || 'imdb',
      readOnly: false,
      assetsBase: '../../assets/icons',
      onTranslate: translateSingleCard,
      onLarkPush: pushCardToLark,
      onOpenUrl: (url) => chrome.tabs.create({ url })
    });
    // 整树重建把按钮全部重建成默认态，把进行中 / 终态的瞬态按 data-id 贴回去
    reapplyCardButtonStates();
    elements.states.empty.classList.toggle('hidden', hasData);
    restoreScroll();
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

    // 与后台/同步服务同规则：尾斜杠归一后的精确等值（UrlMatch 三端共用），
    // 前缀匹配会让互为前缀的订阅串扰（退订带参订阅后历史卡片仍显示）。
    const configuredSet = UrlMatch.buildConfiguredUrlSet(configuredUrls);
    return (dramas || []).filter(drama => UrlMatch.isUrlCovered(drama.sourceListUrl, configuredSet));
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
      : (total > 0 ? '全部已翻译' : '暂无数据');
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
