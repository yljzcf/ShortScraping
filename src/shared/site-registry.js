/**
 * 站点注册表：全部站点元数据的单一真源（收敛自四处 hostname if 链、
 * 两处显示名映射、hostBySource 反向映射与设置页订阅分组常量，2026-08-01）。
 *
 * 新增站点只改本文件的 SITES 一处，并把它归入 SITE_GROUPS 的某一组
 * （分组决定弹窗/共享页头部与设置页订阅列表的展示序，v1.5.11 起）。
 *
 * host 匹配语义（与收敛前逐字保真）：
 *   suffix = hostname.endsWith(host)——裸后缀匹配，不做点边界校验
 *            （notimdb.com 会命中 imdb 属历史怪癖，保真保留，勿顺手「修正」）；
 *   exact  = hostname 全等（steam 仅认 store.steampowered.com，商店子域之外不命中）。
 * path（可选，v1.5.8）只限定 manifest content_scripts.matches 的路径段（默认 /*），
 *   用于 Netflix 这类只需注入某个栏目页的大站；站点归属判定（siteOfHostname/siteOfUrl）
 *   仍只按 host，后台 scripting.executeScript 强制注入兜底路径也不受 matches 限制。
 *
 * 一个 site 键可以有多条 host 条目（v1.6.11 起，DramaBox 的 dramabox.com 与
 * dramaboxdb.com 是同一片库的两套人工编排视图，favicon 都逐字节相同，拆两个标签
 * 肉眼无法区分）。约定与派生规则：
 *   - 同键的各条 name 必须一致（unit-site-registry 有守卫），否则显示名取决于遍历顺序；
 *   - CATEGORY_SOURCES 去重——它是「站点键全集」，不去重会渲染出两个一样的标签，
 *     并让 SITE_GROUPS 展平排列与 ADAPTERS 键集两条断言同时 RED；
 *   - hostBySource 取**首条**（弹窗「去抓取」按钮按 host 子串挑订阅 URL，取首条即主域）；
 *   - contentScriptMatches 逐条展开，两个域名都进 manifest。
 *
 * 加载方式：后台 importScripts / 弹窗、设置页、共享页 <script> 标签
 * （挂 globalThis.SiteRegistry）/ 同步服务 require（module.exports）/
 * 内容脚本经 manifest content_scripts js 数组前置注入。
 */
(function (global) {
  'use strict';

  // 顺序即展示序（2026-09-11 用户定：Netflix 紧随 IMDB 排第二，RoyalRoad 移到末位；
  // 2026-09-12 用户定：AppleTV 紧随 Netflix 排第三；2026-09-16：FlickReels 紧随 NetShort）
  const SITES = [
    { site: 'imdb', name: 'IMDB', host: 'imdb.com', match: 'suffix' },
    { site: 'netflix', name: 'Netflix', host: 'netflix.com', match: 'suffix', path: '/tudum/top10*' },
    { site: 'appletv', name: 'AppleTV', host: 'tv.apple.com', match: 'exact', path: '/us/collection/most-popular-now/*' },
    { site: 'steam', name: 'Steam', host: 'store.steampowered.com', match: 'exact' },
    { site: 'mydrama', name: 'MyDrama', host: 'my-drama.com', match: 'suffix' },
    { site: 'reelshort', name: 'ReelShort', host: 'reelshort.com', match: 'suffix' },
    { site: 'dramashorts', name: 'DramaShorts', host: 'dramashorts.io', match: 'suffix' },
    { site: 'netshort', name: 'NetShort', host: 'netshort.com', match: 'suffix' },
    // 不加 path：Chrome 匹配模式的路径段连查询串一起匹配，'/' 匹配不到首页订阅 '/?list=…'，
    // 留默认 /* 与其余短剧站一致（非首页路径由 adapter.matches 闸住，只是不挂浮动按钮）
    { site: 'flickreels', name: 'FlickReels', host: 'flickreels.net', match: 'suffix' },
    // 三站同上：首页/榜单页订阅都可能带查询串，path 一律留默认 /*
    // shortmax 的站点键取品牌名（站点 og:site_name 与用户标签都是 ShortMax），host 才是 shorttv.live
    { site: 'goodshort', name: 'GoodShort', host: 'goodshort.com', match: 'suffix' },
    { site: 'shortical', name: 'Shortical', host: 'shortical.com', match: 'suffix' },
    { site: 'shortmax', name: 'ShortMax', host: 'shorttv.live', match: 'suffix' },
    // DramaBox 一个站点键挂两个域名（v1.6.11）：同一套 Next.js 代码的两次构建、共用
    // 封面 CDN 与同一套 bookId，但两站的板块内容各自独立编排（四个目标板块 72 个位置
    // 实测只 62 部不重复），故两站都抓、合并成一个来源。两个 host 互不为后缀
    // （'www.dramaboxdb.com'.endsWith('dramabox.com') 为 false），条目顺序不影响匹配。
    { site: 'dramabox', name: 'DramaBox', host: 'dramabox.com', match: 'suffix' },
    { site: 'dramabox', name: 'DramaBox', host: 'dramaboxdb.com', match: 'suffix' },
    { site: 'royalroad', name: 'RoyalRoad', host: 'royalroad.com', match: 'suffix' }
  ];

  // 弹窗/共享页头部的折叠分组（2026-09-12 用户定）。数组顺序即展示顺序：
  // 短剧组排最前且默认展开，另两组收起成「‹ 代表 logo ›」胶囊，同一时间只展开一组。
  // 组内顺序沿用 SITES 的相对顺序。展平后必须与 CATEGORY_SOURCES 互为排列
  // （无重无漏），由 tests/unit-site-tabs.mjs 守住——新增站点忘了归组会直接 RED。
  // 注意 SITES 顺序本身不受此影响：manifest 推导、siteOfHostname 匹配优先级
  // 仍按 SITES，分组只管头部与设置页的展示序。
  const SITE_GROUPS = [
    { group: 'shortdrama', name: '短剧', sites: ['mydrama', 'reelshort', 'dramashorts', 'netshort', 'flickreels', 'goodshort', 'shortical', 'shortmax', 'dramabox'] },
    { group: 'video', name: '影视', sites: ['imdb', 'netflix', 'appletv'] },
    { group: 'game', name: '游戏 · 网文', sites: ['steam', 'royalroad'] }
  ];

  // 零状态时默认展开的组
  const DEFAULT_GROUP = 'shortdrama';

  // 站点键全集：同键多 host（DramaBox）只出现一次，见文件头注释
  const CATEGORY_SOURCES = [...new Set(SITES.map(entry => entry.site))];

  const groupBySite = {};
  for (const entry of SITE_GROUPS) {
    for (const site of entry.sites) groupBySite[site] = entry.group;
  }

  function groupOfSite(site) {
    return groupBySite[site] || null;
  }

  const SOURCE_NAMES = {};
  const hostBySource = {};
  for (const entry of SITES) {
    SOURCE_NAMES[entry.site] = entry.name;
    // 同键多 host 取首条＝主域（弹窗「去抓取」按 host 子串挑订阅 URL）
    if (!(entry.site in hostBySource)) hostBySource[entry.site] = entry.host;
  }

  function siteOfHostname(hostname) {
    if (!hostname) return null;
    for (const entry of SITES) {
      if (entry.match === 'exact' ? hostname === entry.host : hostname.endsWith(entry.host)) {
        return entry.site;
      }
    }
    return null;
  }

  function siteOfUrl(url) {
    try {
      return siteOfHostname(new URL(url).hostname);
    } catch (e) {
      // 无效 URL 视为不属于任何站点
      return null;
    }
  }

  /**
   * manifest content_scripts.matches 的推导式。注册表是站点归属的单一真源，
   * 生成脚本（scripts/update-site-matches.mjs）与回归断言都从这里取，
   * 避免「两处各自从注册表推一遍」导致改一处漏一处。
   */
  function contentScriptMatches() {
    return SITES.map(entry => `*://${entry.match === 'exact' ? '' : '*.'}${entry.host}${entry.path || '/*'}`);
  }

  const api = {
    SITES, SITE_GROUPS, DEFAULT_GROUP, CATEGORY_SOURCES, SOURCE_NAMES, hostBySource,
    groupOfSite, siteOfHostname, siteOfUrl, contentScriptMatches
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.SiteRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
