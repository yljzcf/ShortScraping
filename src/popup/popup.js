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
    activeSource: null
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
      clear: document.getElementById('btnClear'),
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

    elements.categoryTabs = Array.from(document.querySelectorAll('.category-tab'));
  }

  /**
   * 绑定事件
   */
  function bindEvents() {
    elements.buttons.refresh.addEventListener('click', refreshData);
    elements.buttons.clear.addEventListener('click', clearData);
    elements.buttons.settings.addEventListener('click', openSettings);
    elements.syncService.container.addEventListener('click', checkSyncServiceStatus);
    elements.versionStatus.container.addEventListener('click', checkVersionStatus);

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
    } catch (e) {
      updateSyncServiceStatus('off');
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
   * 清除数据
   */
  function clearData() {
    if (!confirm('确定要清除所有数据吗？此操作不可撤销。')) {
      return;
    }

    chrome.runtime.sendMessage({ action: 'clearDramas' }, () => {
      state.dramas = [];
      renderTimeline();
      updateStats();
    });
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
   * 渲染时间线
   */
  // 分类标签：按 source（imdb / steam / royalroad / mydrama / reelshort / dramashorts）筛选时间线
  const CATEGORY_SOURCES = ['imdb', 'steam', 'royalroad', 'mydrama', 'reelshort', 'dramashorts'];

  function dramaSource(drama) {
    return CATEGORY_SOURCES.includes(drama.source) ? drama.source : 'imdb';
  }

  function pickDefaultSource() {
    return CATEGORY_SOURCES.find(src => state.dramas.some(d => dramaSource(d) === src)) || 'imdb';
  }

  function getVisibleDramas() {
    const src = state.activeSource || 'imdb';
    return state.dramas.filter(d => dramaSource(d) === src);
  }

  function updateCategoryTabs() {
    elements.categoryTabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.source === state.activeSource);
    });
  }

  function setActiveCategory(source) {
    if (!CATEGORY_SOURCES.includes(source)) return;
    state.activeSource = source;
    updateCategoryTabs();
    renderTimeline();
    updateStats();
  }

  function renderTimeline() {
    if (!state.activeSource) state.activeSource = pickDefaultSource();
    updateCategoryTabs();

    const container = elements.containers.timeline;
    container.dataset.source = state.activeSource;
    container.innerHTML = '';

    const visible = getVisibleDramas();
    const hasData = visible.length > 0;
    elements.states.empty.classList.toggle('hidden', hasData);

    if (!hasData) return;

    // 按日期分组
    const grouped = groupByDate(visible);

    Object.entries(grouped).forEach(([date, groupData]) => {
      const group = document.createElement('div');
      group.className = 'timeline-date-group';

      const dateHeader = document.createElement('div');
      dateHeader.className = 'timeline-date-header';
      dateHeader.textContent = date;
      group.appendChild(dateHeader);

      // 遍历时间组
      groupData.timeGroups.forEach(tg => {
        // 时间标签（±1min 内的卡片共享一个时间）
        if (tg.timeStr) {
          const timeEl = document.createElement('div');
          timeEl.className = 'timeline-time';
          timeEl.textContent = tg.timeStr;
          group.appendChild(timeEl);
        }

        // 该时间组内的所有卡片；奇数张时首卡标记 card-full，
        // Steam 双列下横跨整行，避免出现单卡独占一行的空缺
        const oddCount = tg.dramas.length % 2 === 1;
        tg.dramas.forEach((drama, index) => {
          const card = createDramaCard(drama);
          if (oddCount && index === 0) card.classList.add('card-full');
          group.appendChild(card);
        });
      });

      container.appendChild(group);
    });

    // 卡片进入 DOM 后按实际渲染行数微调简介排版
    container.querySelectorAll('.drama-card').forEach(adjustCardDescription);
  }

  /**
   * 创建剧集卡片
   */
  function createDramaCard(drama) {
    const card = document.createElement('div');
    card.className = `drama-card ${drama.status === 'new' ? 'status-new' : ''} ${drama.source === 'steam' ? 'card-landscape' : ''}`;
    card.dataset.id = drama.id;

    // 标题：中文（英文）或 英文；trim 防止仅含空白的字段渲染出空行
    const titleZh = (drama.titleZh || '').trim();
    const titleDisplay = titleZh
      ? `${titleZh}（${drama.title}）`
      : drama.title;

    // 简介
    const descZh = (drama.descriptionZh || '').trim();
    const descEn = (drama.description || '').trim();

    card.innerHTML = `
      ${drama.status === 'new' ? '<div class="status-badge">待翻译</div>' : ''}
      <button class="btn-translate" title="翻译此卡片" data-id="${escapeAttribute(drama.id)}">🌍</button>
      <div class="card-content">
        <div class="card-top">
          <img class="card-poster" src="${escapeAttribute(drama.poster || '../../assets/icons/default-poster.svg')}" alt="${escapeAttribute(drama.title)}">
          <div class="card-main">
            <div class="card-title">
              <div class="card-title-text" title="${escapeAttribute(titleDisplay)}">${escapeHtml(titleDisplay)}</div>
            </div>
            <div class="card-description">
              ${descZh ? `<div class="card-desc-zh${descEn ? '' : ' desc-zh-only'}">${escapeHtml(descZh)}</div>` : ''}
              ${descEn ? `<div class="card-desc-en${descZh ? '' : ' desc-en-only'}">${escapeHtml(descEn)}</div>` : ''}
              ${!descZh && !descEn ? '<div class="card-desc-empty">暂无简介</div>' : ''}
            </div>
          </div>
        </div>
        <div class="card-footer">
          <div class="card-tags-left">
            ${getDisplayTags(drama).map(tag => `<span class="tag tag-source">${escapeHtml(tag)}</span>`).join('')}
          </div>
          ${drama.company ? `<div class="card-tags-right"><span class="tag tag-company">${escapeHtml(truncate(drama.company, 20))}</span></div>` : ''}
        </div>
      </div>
    `;

    // 绑定翻译按钮事件
    const translateBtn = card.querySelector('.btn-translate');
    translateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      translateSingleCard(drama.id, translateBtn);
    });

    // 封面方向：横版（宽>高）置于文字上方整行铺开，竖版保持左侧；按图片实际尺寸判定。
    // source 作初始猜测避免布局闪动，加载后用真实尺寸校正。
    const posterImg = card.querySelector('.card-poster');
    if (posterImg) {
      // 扩展页 CSP 禁止内联 onerror 属性，海报加载失败的默认图回退用监听器实现；
      // once 兼防默认图自身也加载失败时的换源死循环
      posterImg.addEventListener('error', () => {
        posterImg.src = '../../assets/icons/default-poster.svg';
      }, { once: true });
      const applyOrientation = () => {
        if (posterImg.naturalWidth && posterImg.naturalHeight) {
          card.classList.toggle('card-landscape', posterImg.naturalWidth > posterImg.naturalHeight);
          // 竖版空间预算取决于海报实际高度，横竖翻转又会改文字列宽，加载后必须重排
          adjustCardDescription(card);
        }
      };
      if (posterImg.complete) applyOrientation();
      else posterImg.addEventListener('load', applyOrientation);
    }

    return card;
  }

  /**
   * 简介动态排版（仅中英双语卡片，单语卡片沿用静态规则）：
   * - 中文实际超过 3 行：放宽为 4 行中文 + 2 行英文；
   * - 中文有富余空间不足时：英文行数补齐剩余空间；
   * - 中英文全文放完仍有大段空白：整体放大字号（desc-large，14px 3中+2英）。
   * 竖版卡（海报在左）以「简介顶部到海报底边 + 内容区 gap」为固定预算分配整行，
   * 上半区高度钉死为海报高，文字只填充原有空隙、分割线绝不因文字增行下移；
   * 横版卡（封面在上，Steam 等高双列）无海报边界，按行数规则分配（合计 7 行封顶）。
   * 行数按 scrollHeight / line-height 测量（line-clamp 不影响 scrollHeight），
   * 必须在卡片进入可见 DOM 后调用；测得 0 行（容器不可见）时保持默认样式。
   */
  function adjustCardDescription(card) {
    const zhEl = card.querySelector('.card-desc-zh');
    const enEl = card.querySelector('.card-desc-en');
    if (!zhEl || !enEl) return;

    const box = card.querySelector('.card-description');
    const cardTop = card.querySelector('.card-top');
    box.classList.remove('desc-large');
    zhEl.style.removeProperty('-webkit-line-clamp');
    enEl.style.removeProperty('-webkit-line-clamp');
    if (cardTop) cardTop.style.removeProperty('height');

    const countLines = el => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      return lineHeight > 0 ? Math.round(el.scrollHeight / lineHeight) : 0;
    };

    const zhLines = countLines(zhEl);
    const enLines = countLines(enEl);
    if (zhLines === 0 || enLines === 0) return;

    const poster = card.querySelector('.card-poster');
    if (!card.classList.contains('card-landscape') && cardTop && poster && poster.offsetHeight > 40) {
      const zhLh = parseFloat(getComputedStyle(zhEl).lineHeight);
      const enLh = parseFloat(getComputedStyle(enEl).lineHeight);
      const zhGap = parseFloat(getComputedStyle(zhEl).marginBottom) || 0;
      const contentGap = parseFloat(getComputedStyle(cardTop.parentElement).rowGap) || 0;
      // 文字可下溢到海报底边之下、吃掉内容区 gap，与分割线保持 footer margin 的间距
      const budget = poster.getBoundingClientRect().bottom - box.getBoundingClientRect().top + contentGap;
      const fits = (zh, en) => zh * zhLh + zhGap + en * enLh <= budget + 0.5;

      let zhShow = zhLines > 3 && fits(4, 2) ? 4 : Math.min(zhLines, 3);
      while (zhShow > 1 && !fits(zhShow, 1)) zhShow--;
      const enShow = Math.max(1, Math.floor((budget - zhShow * zhLh - zhGap) / enLh));

      const sparse = zhLines <= zhShow && enLines <= enShow &&
        budget - (zhLines * zhLh + zhGap + enLines * enLh) >= enLh;
      if (sparse) {
        box.classList.add('desc-large');
      } else {
        if (zhShow !== 3) zhEl.style.setProperty('-webkit-line-clamp', String(zhShow));
        if (enShow !== 2) enEl.style.setProperty('-webkit-line-clamp', String(enShow));
      }
      // 上半区高度钉死为海报高：文字增行只填充空隙，分割线不动
      cardTop.style.height = `${poster.offsetHeight}px`;
      return;
    }

    if (zhLines > 3) {
      zhEl.style.setProperty('-webkit-line-clamp', '4');
    } else if (zhLines + enLines < 7) {
      box.classList.add('desc-large');
    } else if (zhLines < 3) {
      enEl.style.setProperty('-webkit-line-clamp', String(7 - zhLines));
    }
  }

  /**
   * 获取卡片显示标签。兼容旧数据没有 tags 字段的情况。
   */
  function getDisplayTags(drama) {
    if (Array.isArray(drama.tags) && drama.tags.length > 0) {
      return drama.tags.slice(0, 3);
    }

    const sourceNames = { imdb: 'IMDB', steam: 'Steam', royalroad: 'RoyalRoad', mydrama: 'MyDrama', reelshort: 'ReelShort', dramashorts: 'DramaShorts' };
    const tags = [sourceNames[drama.source] || 'IMDB'];

    if (drama.genre) {
      tags.push(String(drama.genre).toLowerCase());
    } else if (drama.sourceListUrl) {
      const genreMatch = drama.sourceListUrl.match(/genres=([^&,]+)/i);
      if (genreMatch) {
        tags.push(decodeURIComponent(genreMatch[1]).toLowerCase());
      }
    }

    return tags.slice(0, 3);
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
      ? `抓取于 ${formatRelativeTime(state.lastScrape)}`
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

  /**
   * 按日期和时间分组（±1min 合并）
   */
  function groupByDate(dramas) {
    const groups = {};

    dramas.forEach(drama => {
      if (!drama.scrapedAt) {
        const date = '未知日期';
        if (!groups[date]) groups[date] = { timeGroups: [] };
        groups[date].timeGroups.push({ time: null, dramas: [drama] });
        return;
      }

      const dateObj = new Date(drama.scrapedAt);
      const date = dateObj.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      if (!groups[date]) {
        groups[date] = { timeGroups: [] };
      }

      // 查找是否有 ±1min 内的时间组
      const timeMs = dateObj.getTime();
      let found = false;

      for (const tg of groups[date].timeGroups) {
        if (tg.time && Math.abs(tg.time - timeMs) < 60000) {
          tg.dramas.push(drama);
          found = true;
          break;
        }
      }

      if (!found) {
        groups[date].timeGroups.push({
          time: timeMs,
          timeStr: formatTime(drama.scrapedAt),
          dramas: [drama]
        });
      }
    });

    return groups;
  }

  /**
   * 格式化时间
   */
  function formatTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  /**
   * 格式化相对时间
   */
  function formatRelativeTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    return `${days} 天前`;
  }

  /**
   * 截断文本
   */
  function truncate(text, maxLen) {
    if (!text) return '';
    return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
  }

  /**
   * 转义 HTML
   */
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // escapeHtml 不转义双引号，插入 HTML 属性值的内容（抓取的标题/海报 URL 等）必须用这个
  function escapeAttribute(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
  }

  // 初始化
  document.addEventListener('DOMContentLoaded', init);
})();
