/**
 * 站点折叠标签条：弹窗与局域网共享页共用的头部实现（v1.5.11）。
 *
 * 背景：9 个站点图标平铺已超出 520px 弹窗宽度，改为按 SiteRegistry.SITE_GROUPS
 * 折叠成手风琴——同一时间只展开一组，收起组压成一枚「‹ 代表 logo ›」胶囊。
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

    container.innerHTML = '';

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
    }
  }

  const api = {
    latestUpdateBySite,
    visibleSitesOfGroup,
    pickRepresentative,
    resolveActiveSource,
    resolveLayout,
    render
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.SiteTabs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
