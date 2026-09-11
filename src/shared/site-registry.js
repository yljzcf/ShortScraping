/**
 * 站点注册表：全部站点元数据的单一真源（收敛自四处 hostname if 链、
 * 两处显示名映射、hostBySource 反向映射与设置页订阅分组常量，2026-08-01）。
 *
 * 新增站点只改本文件的 SITES 一处；顺序即弹窗/共享页分类图标与设置页分组的展示序。
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

  const SITES = [
    { site: 'imdb', name: 'IMDB', host: 'imdb.com', match: 'suffix' },
    { site: 'steam', name: 'Steam', host: 'store.steampowered.com', match: 'exact' },
    { site: 'royalroad', name: 'RoyalRoad', host: 'royalroad.com', match: 'suffix' },
    { site: 'mydrama', name: 'MyDrama', host: 'my-drama.com', match: 'suffix' },
    { site: 'reelshort', name: 'ReelShort', host: 'reelshort.com', match: 'suffix' },
    { site: 'dramashorts', name: 'DramaShorts', host: 'dramashorts.io', match: 'suffix' },
    { site: 'netshort', name: 'NetShort', host: 'netshort.com', match: 'suffix' },
    { site: 'netflix', name: 'Netflix', host: 'netflix.com', match: 'suffix', path: '/tudum/top10*' }
  ];

  const CATEGORY_SOURCES = SITES.map(entry => entry.site);

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

  const api = { SITES, CATEGORY_SOURCES, SOURCE_NAMES, hostBySource, siteOfHostname, siteOfUrl, contentScriptMatches };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.SiteRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
