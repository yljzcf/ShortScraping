/**
 * ShortScraping 局域网共享页脚本
 *
 * 只读浏览：首次拉取 /api/timeline 渲染，之后由 /api/events（SSE）通知刷新；
 * 页面回到前台时补拉一次，兜底断线期间漏掉的更新。渲染复用共享模块
 * TimelineRender（readOnly 模式，无任何操作按钮；封面点击在新标签页打开原站）。
 *
 * 三个入口（打开页面、SSE 版本通告、回到前台）都经 requestTimeline 拉取（v1.6.21）：
 * 同一时间只有一个拉取在途；在途期间 SSE 通告的新版本只记一笔，拉完若已渲染的还不是那个版本
 * 才补拉一次。旧写法打开页面就整表拉两次——init 拉一次，SSE 连上即发的首帧因 version 仍是 -1
 * 又拉一次（整表数 MB）。请求带 cache:'no-cache' 走条件请求，服务端内容未变回 304；
 * 响应 ETag 与上次渲染的相同时连 JSON 都不解析、不重渲染。
 */
(function () {
  'use strict';

  const state = {
    dramas: [],
    activeSource: null,
    version: -1,
    etag: null // 上次渲染所用响应的 ETag（服务端 W/"<内容指纹>-<版本>"）
  };

  // 拉取调度：inFlight 为在途拉取（含随后的补拉）；stale / staleVersion 记下在途期间 SSE 通告的
  // 最新版本（null＝帧解析失败、版本未知，拉完必补拉）
  const loader = { inFlight: null, stale: false, staleVersion: null };

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

    // 回到前台：断线期间可能漏了 SSE 通告，版本未知，空闲就拉一次（多半是 304）；在途则复用那次拉取
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) requestTimeline();
    });

    // 首次拉取不等 SSE 首帧：代理 / 企业网关拦掉 SSE 长连接时页面照样有数据
    requestTimeline();
    connectEvents();
  }

  /** 拉取入口：空闲就开拉；已有拉取在途则直接复用它（在途拉取本就是最新的请求）。 */
  function requestTimeline() {
    if (loader.inFlight) return loader.inFlight;
    loader.inFlight = (async () => {
      try {
        for (;;) {
          loader.stale = false;
          await loadTimeline();
          // 在途期间没有新通告，或通告的版本正是刚渲染的这版：不补拉
          if (!loader.stale || loader.staleVersion === state.version) break;
        }
      } finally {
        loader.inFlight = null;
      }
    })();
    return loader.inFlight;
  }

  /** SSE 通告了版本（null＝未知）：在途时只记下，拉完再比；空闲时与已渲染版本不同才拉。 */
  function onVersionAnnounced(version) {
    if (loader.inFlight) {
      loader.stale = true;
      loader.staleVersion = version;
      return;
    }
    if (version === null || version !== state.version) requestTimeline();
  }

  async function loadTimeline() {
    try {
      // no-cache：浏览器带 If-None-Match 回源校验，内容没变服务端只回 304（fetch 看到的仍是 200 + 缓存体）
      const response = await fetch('/api/timeline', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const etag = response.headers.get('ETag');
      if (etag && etag === state.etag) {
        // 与已渲染的是同一份内容：整表 JSON 不解析、不重渲染，未读的响应体直接丢弃
        if (response.body) response.body.cancel().catch(() => {});
        return;
      }
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || '接口返回失败');

      state.version = data.version;
      state.dramas = Array.isArray(data.dramas) ? data.dramas : [];
      state.etag = etag;
      render();
    } catch (e) {
      console.error('[ShortScraping Share] 数据加载失败:', e);
      elements.statusText.textContent = '数据加载失败，等待自动重试';
      // 状态栏已换成失败提示：下一次成功即使 ETag 没变也要重渲染一次，把统计文案换回来
      state.etag = null;
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
    // 也不做展开状态记忆（刷新即回到默认短剧组）。站点显隐同样不做过滤：
    // site-registry 登记的站点全部列出（共享页没有订阅信息，不传 visibleSites）。
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

    // 连上即发的首帧与 init 的首次拉取撞车时：拉取在途只记下版本，拉完发现已渲染的就是它，不再重拉
    source.addEventListener('update', (event) => {
      let version = null;
      try {
        const payload = JSON.parse(event.data || '{}');
        if (Number.isInteger(payload.version)) version = payload.version;
      } catch (e) {
        // 帧坏了：版本未知，按「可能有更新」处理
      }
      onVersionAnnounced(version);
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
