/**
 * 站点折叠标签条：弹窗与局域网共享页共用的头部实现（v1.5.11）。
 *
 * 背景：9 个站点图标平铺已超出 520px 弹窗宽度，改为按 SiteRegistry.SITE_GROUPS
 * 折叠成手风琴——同一时间只展开一组，收起组压成一枚「‹ 代表 logo ›」胶囊。
 *
 * v1.6.9：短剧组增至 8 个站点后，光展开组本身就要 402px，而标签条可用宽度只有
 * 416px（520 − 32 头部内边距 − 72 头部按钮区，实测），加上两枚收起胶囊共需 504px。
 * 展开组改为横向可滚，操作方式是**按住即拖**（2026-09-17 用户定：不加滚轮横滚
 * JS、不显滚动条、不加左右箭头——箭头会再吃掉约 40px，而横向宽度正是稀缺资源）。
 * 拖动判据与「原地点一下仍是选站」的边界由下面三个纯函数定义，零 DOM 可单测。
 *
 * 核心不变量：**展开的组恒等于当前活动站点所在的组**。因此本模块不接受
 * expandedGroup 参数，展开态一律由 activeSource 推导；调用方也只需持久化
 * activeSource 一个字段，不会出现两个字段互相矛盾的状态。
 *
 * 纯函数（latestUpdateBySite / pickRepresentative / resolveActiveSource /
 * resolveLayout）与 DOM 渲染（render）分离，前者由 tests/unit-site-tabs.mjs
 * 零 DOM 覆盖。
 *
 * 加载方式：弹窗、共享页 <script> 标签（挂 globalThis.SiteTabs，须在
 * site-registry.js 之后）/ 测试经 require（module.exports）。
 */
(function (global) {
  'use strict';

  // 依赖解析与 lark.js 同范式：Node 侧自己 require，浏览器侧取已加载的全局
  const Registry = (typeof module !== 'undefined' && module.exports)
    ? require('./site-registry.js')
    : global.SiteRegistry;

  /**
   * 每个站点最近一次有新内容的时间（取该站全部条目 scrapedAt 的最大值）。
   * 缺 scrapedAt 或时间戳非法的条目跳过，不参与比较。
   */
  function latestUpdateBySite(dramas) {
    const latest = {};
    for (const drama of dramas || []) {
      if (!drama || !drama.scrapedAt) continue;
      const ms = Date.parse(drama.scrapedAt);
      if (!Number.isFinite(ms)) continue;
      const site = drama.source;
      if (!(site in latest) || ms > latest[site]) latest[site] = ms;
    }
    return latest;
  }

  /**
   * 组内当前可见（＝已订阅）的站点，**按最近有更新降序**排（2026-09-12 用户定）：
   * 展开一组时最新有动静的站点排最前。无更新记录的站点一律排在有记录的之后；
   * 并列（含全都无记录）时保持 SITE_GROUPS 里的组内顺序——sort 在 ES2019+ 稳定。
   * 排完序后 sites[0] 即「组内最近有更新的站点」，代表站点直接取它。
   */
  function visibleSitesOfGroup(groupEntry, visibleSites, latestBySite) {
    const sites = visibleSites
      ? groupEntry.sites.filter(site => visibleSites.has(site))
      : groupEntry.sites.slice();

    const latest = latestBySite || {};
    const at = site => (typeof latest[site] === 'number' ? latest[site] : -Infinity);
    return sites.sort((a, b) => at(b) - at(a));
  }

  /**
   * 组的代表站点（收起胶囊上显示的、点开后会被选中的那个）：
   * 设置里固定的 > 组内最近有更新的（＝排序后的首个）。
   * 固定到一个未订阅站点时按「自动」处理，不特殊报错。
   */
  function pickRepresentative(groupEntry, opts) {
    const options = opts || {};
    const sites = visibleSitesOfGroup(groupEntry, options.visibleSites, options.latestBySite);
    if (sites.length === 0) return null;

    const pinned = (options.pins || {})[groupEntry.group];
    if (pinned && sites.includes(pinned)) return pinned;

    return sites[0];
  }

  /**
   * 决定当前活动站点：记忆值仍可见就沿用（展开组随之推导），否则回退到
   * 默认组的代表站点；默认组无可见站点再顺延到第一个有可见站点的组。
   * 全都没有（零订阅）返回 null——调用方据此显示空状态、不渲染任何图标。
   */
  function resolveActiveSource(opts) {
    const options = opts || {};
    const visibleSites = options.visibleSites;
    const isVisible = site => !!site && (!visibleSites || visibleSites.has(site));

    if (isVisible(options.activeSource) && Registry.groupOfSite(options.activeSource)) {
      return options.activeSource;
    }

    const ordered = Registry.SITE_GROUPS.slice().sort((a, b) => {
      // 默认组优先，其余保持 SITE_GROUPS 顺序
      const rank = entry => (entry.group === Registry.DEFAULT_GROUP ? 0 : 1);
      return rank(a) - rank(b);
    });

    for (const groupEntry of ordered) {
      const representative = pickRepresentative(groupEntry, options);
      if (representative) return representative;
    }
    return null;
  }

  /**
   * 头部布局：每组一条 { group, name, sites, collapsed, representative }，
   * sites 已按「最近有更新」降序排（展开时最新有动静的站点在最前）。
   * 规则：
   *   · 组内 0 个可见站点 → 整组不出现（与既有「未订阅站点不出图标」一致）；
   *   · 组内可见站点 ≤1 → 不折叠，直接平铺（否则看一个站点要点两次）；
   *   · 其余组只有「含 activeSource 的那一组」展开，余者收起。
   */
  function resolveLayout(opts) {
    const options = opts || {};
    const activeSource = resolveActiveSource(options);
    const activeGroup = activeSource ? Registry.groupOfSite(activeSource) : null;

    const groups = [];
    for (const groupEntry of Registry.SITE_GROUPS) {
      const sites = visibleSitesOfGroup(groupEntry, options.visibleSites, options.latestBySite);
      if (sites.length === 0) continue;
      groups.push({
        group: groupEntry.group,
        name: groupEntry.name,
        sites,
        collapsed: sites.length > 1 && groupEntry.group !== activeGroup,
        representative: pickRepresentative(groupEntry, options)
      });
    }

    return { activeSource, activeGroup, groups };
  }

  /* ——— 展开组横向拖动（v1.6.9）———————————————————————————————
   * 三个纯函数就是全部判据，render 只负责把 pointer 事件喂进来、把 scrollLeft 写回去。
   * 阈值语义：位移**首次**超过 threshold 就锁定为「这是一次拖动」，之后即使手指
   * 回到原点也不再退回点击（moved 单向置位）——否则「拖出去又拖回来」松手会误切站点。
   */
  const DRAG_THRESHOLD_PX = 5;

  function beginDrag(clientX, scrollLeft) {
    return { active: true, moved: false, startX: clientX, startScroll: scrollLeft, scrollLeft };
  }

  function moveDrag(state, clientX, threshold) {
    if (!state || !state.active) return state;
    const limit = typeof threshold === 'number' ? threshold : DRAG_THRESHOLD_PX;
    const dx = clientX - state.startX;
    return Object.assign({}, state, {
      moved: state.moved || Math.abs(dx) >= limit,
      scrollLeft: state.startScroll - dx
    });
  }

  /** 松手：moved 为真则这一下不是点击，调用方要吞掉随后那个 click。 */
  function endDrag(state) {
    return { active: false, suppressClick: !!(state && state.moved) };
  }

  /**
   * 把某一项滚进可视区所需的 scrollLeft（纯横向，不用 scrollIntoView——那个会连带
   * 把整个弹窗竖向滚动）。已在视区内则原样返回当前值，不做无谓跳动。
   */
  function scrollLeftForVisible(itemLeft, itemWidth, viewLeft, viewWidth) {
    if (itemLeft < viewLeft) return itemLeft;
    if (itemLeft + itemWidth > viewLeft + viewWidth) return itemLeft + itemWidth - viewWidth;
    return viewLeft;
  }

  function createSiteTab(site, opts) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'category-tab';
    button.dataset.source = site;
    button.setAttribute('role', 'tab');

    const name = Registry.SOURCE_NAMES[site] || site;
    const active = site === opts.activeSource;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.setAttribute('aria-label', name);
    // 激活态再次点击＝只抓该站点的订阅（仅弹窗传 onRefreshSite）
    button.title = active && opts.onRefreshSite ? `${name}：再次点击只刷新该站点` : name;

    // 抓取进行中的转圈是数据驱动的：抓取期间卡片陆续入库会触发整条标签栏重建，
    // 只靠 DOM 上的 class 会被重建抹掉
    if (site === opts.refreshingSite) button.classList.add('is-refreshing');

    const img = document.createElement('img');
    img.src = `${opts.assetsBase}/site-${site}.png`;
    img.alt = '';
    button.appendChild(img);

    button.addEventListener('click', () => {
      if (site === opts.activeSource && opts.onRefreshSite) {
        opts.onRefreshSite(site);
        return;
      }
      if (opts.onSelectSite) opts.onSelectSite(site);
    });

    return button;
  }

  function createChevron(name) {
    const span = document.createElement('span');
    span.className = 'tab-group-chevron';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = name === 'left' ? '‹' : '›';
    return span;
  }

  /** 收起胶囊：「‹ 代表 logo ›」。箭头纯装饰，整个胶囊是一个按钮。 */
  function createGroupChip(groupLayout, opts) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab-group-chip';
    button.dataset.group = groupLayout.group;
    // 点它即展开并选中代表站点，语义上仍是一个（未选中的）tab，
    // 这样容器的 role="tablist" 不会被非 tab 子元素破坏
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', 'false');
    button.setAttribute('aria-expanded', 'false');

    const label = `${groupLayout.name}（${groupLayout.sites.length} 个站点）`;
    button.setAttribute('aria-label', `${label}，点击展开`);
    button.title = `${label} · 点击展开`;

    button.appendChild(createChevron('left'));

    const img = document.createElement('img');
    img.src = `${opts.assetsBase}/site-${groupLayout.representative}.png`;
    img.alt = '';
    button.appendChild(img);

    button.appendChild(createChevron('right'));

    button.addEventListener('click', () => {
      if (opts.onExpandGroup) opts.onExpandGroup(groupLayout.group, groupLayout.representative);
    });

    return button;
  }

  /**
   * 整条标签条重建。容器为 .category-tabs，内部结构完全由本函数产出，
   * 调用方不再手写任何 <button>（顺序与分组都只来自注册表）。
   *
   * opts: assetsBase / onSelectSite(site) / onExpandGroup(group, representative) /
   *       onRefreshSite(site)（弹窗独有，共享页不传） /
   *       refreshingSite（正在抓取的站点，图标转圈）
   */
  function render(container, layout, opts) {
    const options = Object.assign({ assetsBase: '../../assets/icons' }, opts, {
      activeSource: layout.activeSource
    });

    // 重建前记下展开组的横向位置：抓取期间卡片陆续入库会触发整条标签栏重建，
    // 不记就会一直弹回最左（与时间线滚动位置那次是同一类失败）。只在
    // 「组没换、活动站点也没换」时还原——用户切了站点就该把新站点滚进视区。
    const previousOpen = container.querySelector('.tab-group.is-open');
    const previousActive = container.querySelector('.category-tab.active');
    const previous = previousOpen ? {
      group: previousOpen.dataset.group,
      scrollLeft: previousOpen.scrollLeft,
      activeSource: previousActive ? previousActive.dataset.source : null
    } : null;

    container.innerHTML = '';

    let openGroupEl = null;
    for (const groupLayout of layout.groups) {
      if (groupLayout.collapsed) {
        container.appendChild(createGroupChip(groupLayout, options));
        continue;
      }

      const group = document.createElement('div');
      // 单站点组不套展开容器：它本来就是一个图标，加衬底反而像"展开了一组"
      const expandable = groupLayout.sites.length > 1;
      group.className = expandable ? 'tab-group is-open' : 'tab-group';
      group.dataset.group = groupLayout.group;
      // 纯视觉包装，不参与无障碍树——组内的 tab 仍视作 tablist 的直接子元素
      group.setAttribute('role', 'presentation');
      if (expandable) group.title = `${groupLayout.name}（${groupLayout.sites.length} 个站点）`;

      for (const site of groupLayout.sites) {
        group.appendChild(createSiteTab(site, options));
      }
      container.appendChild(group);
      if (expandable) openGroupEl = group;
    }

    if (openGroupEl) {
      attachDragScroll(openGroupEl);
      restoreScroll(openGroupEl, previous, layout.activeSource);
    }
  }

  /** 还原横向位置；条件不满足则把活动站点滚进视区（首次渲染、切组、切站都走这条）。 */
  function restoreScroll(groupEl, previous, activeSource) {
    if (previous && previous.group === groupEl.dataset.group && previous.activeSource === activeSource) {
      groupEl.scrollLeft = previous.scrollLeft;
      return;
    }
    const activeTab = groupEl.querySelector('.category-tab.active');
    if (!activeTab) return;
    groupEl.scrollLeft = scrollLeftForVisible(
      activeTab.offsetLeft, activeTab.offsetWidth, groupEl.scrollLeft, groupEl.clientWidth
    );
  }

  /**
   * 按住即拖。用 setPointerCapture 让手滑出标签栏也照常跟手；捕获阶段拦 click，
   * 拖动松手那一下不算选站（原地按一下 moved 仍为 false，照常选站/再点刷新）。
   */
  function attachDragScroll(groupEl) {
    let state = null;
    let suppressClick = false;

    groupEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      suppressClick = false;                       // 上一次拖动若在组外松手就没 click 可吞，这里兜底清掉
      state = beginDrag(event.clientX, groupEl.scrollLeft);
      if (typeof groupEl.setPointerCapture === 'function') groupEl.setPointerCapture(event.pointerId);
    });

    groupEl.addEventListener('pointermove', (event) => {
      if (!state || !state.active) return;
      state = moveDrag(state, event.clientX);
      if (!state.moved) return;
      groupEl.classList.add('is-dragging');
      groupEl.scrollLeft = state.scrollLeft;
      event.preventDefault();                      // 拖动期间不选中图标/不触发原生图片拖拽
    });

    const finish = (event) => {
      if (!state) return;
      suppressClick = endDrag(state).suppressClick;
      state = null;
      groupEl.classList.remove('is-dragging');
      if (event && event.pointerId != null && typeof groupEl.releasePointerCapture === 'function'
        && typeof groupEl.hasPointerCapture === 'function' && groupEl.hasPointerCapture(event.pointerId)) {
        groupEl.releasePointerCapture(event.pointerId);
      }
    };
    groupEl.addEventListener('pointerup', finish);
    groupEl.addEventListener('pointercancel', finish);

    groupEl.addEventListener('click', (event) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.stopPropagation();
      event.preventDefault();
    }, true);

    // 图标是 <img>，不拦的话按住拖会变成浏览器原生的「拖拽图片」
    groupEl.addEventListener('dragstart', event => event.preventDefault());
  }

  const api = {
    latestUpdateBySite,
    visibleSitesOfGroup,
    pickRepresentative,
    resolveActiveSource,
    resolveLayout,
    render,
    DRAG_THRESHOLD_PX,
    beginDrag,
    moveDrag,
    endDrag,
    scrollLeftForVisible
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.SiteTabs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
