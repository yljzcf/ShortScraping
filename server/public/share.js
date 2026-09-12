/**
 * ShortScraping 局域网共享页脚本
 *
 * 只读浏览：首次拉取 /api/timeline 渲染，之后由 /api/events（SSE）通知刷新；
 * 页面回到前台时补拉一次，兜底断线期间漏掉的更新。渲染复用共享模块
 * TimelineRender（readOnly 模式，无任何操作按钮；封面点击在新标签页打开原站）。
 */
(function () {
  'use strict';

  const state = {
    dramas: [],
    activeSource: null,
    version: -1
  };

  const elements = {};

  function init() {
    elements.container = document.querySelector('.timeline-container');
    elements.empty = document.getElementById('emptyState');
    elements.statusText = document.getElementById('statusText');
    elements.statsTotal = document.getElementById('statsTotal');
    elements.statsLastUpdate = document.getElementById('statsLastUpdate');
    elements.liveDot = document.getElementById('liveDot');
    // 标签条内容由 SiteTabs 动态渲染（分组折叠），这里只缓存容器
    elements.categoryTabs = document.getElementById('categoryTabs');

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) loadTimeline();
    });

    loadTimeline();
    connectEvents();
  }

  async function loadTimeline() {
    try {
      const response = await fetch('/api/timeline', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || '接口返回失败');

      state.version = data.version;
      state.dramas = Array.isArray(data.dramas) ? data.dramas : [];
      render();
    } catch (e) {
      console.error('[ShortScraping Share] 数据加载失败:', e);
      elements.statusText.textContent = '数据加载失败，等待自动重试';
    }
  }

  function setActiveSource(source) {
    if (!TimelineRender.CATEGORY_SOURCES.includes(source)) return;
    state.activeSource = source;
    render();
  }

  function render() {
    // 分组折叠标签条：同一时间只展开一组，收起组压成「‹ 代表 logo ›」胶囊。
    // 共享页读不到扩展存储，所以没有「固定 logo」，代表站点恒按「最近有更新」；
    // 也不做展开状态记忆（刷新即回到默认短剧组）。站点显隐同样不做过滤，
    // 九站全列（与改造前一致，共享页没有订阅信息）。
    const layout = SiteTabs.resolveLayout({
      activeSource: state.activeSource,
      latestBySite: SiteTabs.latestUpdateBySite(state.dramas)
    });
    state.activeSource = layout.activeSource;

    SiteTabs.render(elements.categoryTabs, layout, {
      assetsBase: '/assets/icons',
      onSelectSite: setActiveSource,
      onExpandGroup: (group, representative) => setActiveSource(representative)
    });

    const visible = state.dramas.filter(d => TimelineRender.dramaSource(d) === state.activeSource);
    const hasData = TimelineRender.renderTimeline(elements.container, visible, {
      source: state.activeSource,
      readOnly: true,
      assetsBase: '/assets/icons',
      onOpenUrl: (url) => window.open(url, '_blank', 'noopener')
    });
    elements.empty.classList.toggle('hidden', hasData);
    updateStats(visible);
  }

  function updateStats(visible) {
    const total = visible.length;
    const translated = visible.filter(d => d.status === 'trans').length;
    const pending = total - translated;

    elements.statsTotal.textContent = `${total} 部`;

    let lastScrapeMs = 0;
    for (const drama of visible) {
      const ms = drama.scrapedAt ? new Date(drama.scrapedAt).getTime() : 0;
      if (ms > lastScrapeMs) lastScrapeMs = ms;
    }
    elements.statsLastUpdate.textContent = lastScrapeMs
      ? `抓取于 ${TimelineRender.formatRelativeTime(new Date(lastScrapeMs).toISOString())}`
      : '未抓取';

    elements.statusText.textContent = total === 0
      ? '暂无数据'
      : pending > 0
        ? `${translated} 已翻译, ${pending} 待翻译`
        : '全部已翻译';
  }

  function connectEvents() {
    const source = new EventSource('/api/events');

    source.addEventListener('update', (event) => {
      try {
        const payload = JSON.parse(event.data || '{}');
        if (payload.version !== state.version) loadTimeline();
      } catch (e) {
        loadTimeline();
      }
    });

    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false); // EventSource 会按 retry 自动重连
  }

  function setLive(on) {
    elements.liveDot.classList.toggle('is-on', on);
    elements.liveDot.classList.toggle('is-off', !on);
    const text = on ? '实时同步已连接' : '连接中断，自动重连中…';
    elements.liveDot.title = text;
    elements.liveDot.setAttribute('aria-label', text); // 状态点无文本内容，屏读靠 aria-label
  }

  document.addEventListener('DOMContentLoaded', init);
})();
