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
 * 加载方式：后台 importScripts / 弹窗、设置页、共享页 <script> 标签
 * （挂 globalThis.SiteRegistry）/ 同步服务 require（module.exports）/
 * 内容脚本经 manifest content_scripts js 数组前置注入。
 */
(function (global) {
  'use strict';

  // 顺序即展示序（2026-09-11 用户定：Netflix 紧随 IMDB 排第二，RoyalRoad 移到末位；
  // 2026-09-12 用户定：AppleTV 紧随 Netflix 排第三）
  const SITES = [
    { site: 'imdb', name: 'IMDB', host: 'imdb.com', match: 'suffix' },
    { site: 'netflix', name: 'Netflix', host: 'netflix.com', match: 'suffix', path: '/tudum/top10*' },
    { site: 'appletv', name: 'AppleTV', host: 'tv.apple.com', match: 'exact', path: '/us/collection/most-popular-now/*' },
    { site: 'steam', name: 'Steam', host: 'store.steampowered.com', match: 'exact' },
    { site: 'mydrama', name: 'MyDrama', host: 'my-drama.com', match: 'suffix' },
    { site: 'reelshort', name: 'ReelShort', host: 'reelshort.com', match: 'suffix' },
    { site: 'dramashorts', name: 'DramaShorts', host: 'dramashorts.io', match: 'suffix' },
    { site: 'netshort', name: 'NetShort', host: 'netshort.com', match: 'suffix' },
    { site: 'royalroad', name: 'RoyalRoad', host: 'royalroad.com', match: 'suffix' }
  ];

  // 弹窗/共享页头部的折叠分组（2026-09-12 用户定）。数组顺序即展示顺序：
  // 短剧组排最前且默认展开，另两组收起成「‹ 代表 logo ›」胶囊，同一时间只展开一组。
  // 组内顺序沿用 SITES 的相对顺序。展平后必须与 CATEGORY_SOURCES 互为排列
  // （无重无漏），由 tests/unit-site-tabs.mjs 守住——新增站点忘了归组会直接 RED。
  // 注意 SITES 顺序本身不受此影响：manifest 推导、siteOfHostname 匹配优先级
  // 仍按 SITES，分组只管头部与设置页的展示序。
  const SITE_GROUPS = [
    { group: 'shortdrama', name: '短剧', sites: ['mydrama', 'reelshort', 'dramashorts', 'netshort'] },
    { group: 'video', name: '影视', sites: ['imdb', 'netflix', 'appletv'] },
    { group: 'game', name: '游戏 · 网文', sites: ['steam', 'royalroad'] }
  ];

  // 零状态时默认展开的组
  const DEFAULT_GROUP = 'shortdrama';

  const CATEGORY_SOURCES = SITES.map(entry => entry.site);

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
    hostBySource[entry.site] = entry.host;
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
