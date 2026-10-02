/**
 * 站点注册表：全部站点元数据的单一真源（收敛自四处 hostname if 链、
 * 两处显示名映射、站点→主域反向映射与设置页订阅分组常量，2026-08-01；
 * 反向映射 hostBySource 已无消费方，v1.7.0 删除）。
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
 *   仍只按 host，后台 scripting.executeScript 强制注入兜底路径也不受 matches 限制
 *   （但兜底只对 isInjectableUrl 命中的页面放行，点边界匹配，见 background.js scrapeLoadedTab）。
 *   path 可写成数组，一条 host 条目展开成多项 matches（Steam 的 /category/ 与 /tags/
 *   两种内容中心入口）。收窄时须与 content.js 对应 adapter.matches 认的路径一致，
 *   订阅 URL 带的查询串也要能被匹配到（Chrome 匹配模式的路径段连查询串一起匹配）——
 *   unit-site-registry T6b 拿 tag.example.json 的全部订阅 URL 逐条核对。
 *
 * 一个 site 键可以有多条 host 条目（v1.6.11 起，DramaBox 的 dramabox.com 与
 * dramaboxdb.com 是同一片库的两套人工编排视图，favicon 都逐字节相同，拆两个标签
 * 肉眼无法区分）。约定与派生规则：
 *   - 同键的各条 name 必须一致（unit-site-registry 有守卫），否则显示名取决于遍历顺序；
 *   - CATEGORY_SOURCES 去重——它是「站点键全集」，不去重会渲染出两个一样的标签，
 *     并让 SITE_GROUPS 展平排列与 ADAPTERS 键集两条断言同时 RED；
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
  // IMDB / Steam / RoyalRoad 三站的订阅页路径固定，path 收窄到 adapter.matches 认的入口
  // （2026-09-25 审查 manifest-overbroad-injection：整站 /* 让用户在这三站浏览的每个页面
  // 都被注入三个脚本和 CSS，却只有订阅页用得上）
  const SITES = [
    { site: 'imdb', name: 'IMDB', host: 'imdb.com', match: 'suffix', path: ['/search/title*', '/find*'] },
    { site: 'netflix', name: 'Netflix', host: 'netflix.com', match: 'suffix', path: '/tudum/top10*' },
    { site: 'appletv', name: 'AppleTV', host: 'tv.apple.com', match: 'exact', path: '/us/collection/most-popular-now/*' },
    // Higgsfield（v1.7.2）：整站是用户可能天天在用的 AI 生成工具，只注入订阅页 /community/originals
    // （理由同上面的 manifest-overbroad-injection）；末尾的 * 连查询串一起匹配，?list=<板块> 照样命中。
    // exact：www 会 301 到裸域，订阅页只在裸域上
    { site: 'higgsfield', name: 'Higgsfield', host: 'higgsfield.ai', match: 'exact', path: '/community/originals*' },
    { site: 'steam', name: 'Steam', host: 'store.steampowered.com', match: 'exact', path: ['/category/*', '/tags/*'] },
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
    { site: 'royalroad', name: 'RoyalRoad', host: 'royalroad.com', match: 'suffix', path: '/fictions/*' },
    // 同 FlickReels：首页订阅带 ?list=，Chrome 匹配模式的路径段连查询串一起匹配，
    // '/' 匹配不到 '/?list=…'，故 path 留默认 /*（非订阅页由 adapter.matches 闸住）
    { site: 'pinedrama', name: 'PinesDramas', host: 'pinedrama.com', match: 'suffix' }
  ];

  // 弹窗/共享页头部的折叠分组（2026-09-12 用户定）。数组顺序即展示顺序：
  // 短剧组排最前且默认展开，另两组收起成「‹ 代表 logo ›」胶囊，同一时间只展开一组。
  // 组内顺序沿用 SITES 的相对顺序。展平后必须与 CATEGORY_SOURCES 互为排列
  // （无重无漏），由 tests/unit-site-tabs.mjs 守住——新增站点忘了归组会直接 RED。
  // 注意 SITES 顺序本身不受此影响：manifest 推导、siteOfHostname 匹配优先级
  // 仍按 SITES，分组只管头部与设置页的展示序。
  const SITE_GROUPS = [
    { group: 'shortdrama', name: '短剧', sites: ['mydrama', 'reelshort', 'dramashorts', 'netshort', 'flickreels', 'goodshort', 'shortical', 'shortmax', 'dramabox'] },
    // Higgsfield 是 Higgsfield Studio 自制的 AI 原创影视（短片、多集剧、长片），2026-09-27 默认归入本组
    { group: 'video', name: '影视', sites: ['imdb', 'netflix', 'appletv', 'higgsfield'] },
    // PinesDramas 同时有网文与短剧两类内容，整站按 2026-09-18 用户指定归入本组
    { group: 'game', name: '游戏 · 网文', sites: ['steam', 'royalroad', 'pinedrama'] }
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
  for (const entry of SITES) {
    SOURCE_NAMES[entry.site] = entry.name;
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
   * 卡片归哪个站点（弹窗 / 共享页的站点标签、同步服务的分站点骤降告警同一口径）：source 在站点全集里就用它，
   * 否则归 IMDB——source 字段出现之前只有 IMDB 一个站。此前 timeline-render 的 dramaSource 与 sync-server 的
   * siteOfDrama 各写一份（v1.7.0 收拢到这里）。
   */
  function siteOfDrama(drama) {
    const source = drama && drama.source;
    return CATEGORY_SOURCES.includes(source) ? source : 'imdb';
  }

  // 点边界 host 匹配（suffix 条目＝裸域或其子域），注入闸门与平台链接校验共用
  function hostMatches(entry, hostname) {
    return entry.match === 'exact'
      ? hostname === entry.host
      : hostname === entry.host || hostname.endsWith(`.${entry.host}`);
  }

  /**
   * 强制注入兜底的放行判定：与 manifest matches 同一口径的点边界匹配（suffix 条目＝裸域或其子域），
   * 不沿用 siteOfHostname 的裸 endsWith——那条怪癖只关乎站点归属显示，放到注入闸门上
   * notimdb.com 这类站外域名就能借全站 host 权限被塞进 content.js。
   */
  function isInjectableUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const hostname = parsed.hostname;
    return SITES.some(entry => hostMatches(entry, hostname));
  }

  /* ——— IMDb 条目「搜平台」（v1.7.3）————————————————————————————————————————
   * IMDb 只是片目库、没有播放页；订阅的 IMDb「平台榜」是按出品公司筛选的搜索页
   * （companies=co…），所以一部 IMDb 条目属于哪个短剧平台由它的 sourceListUrl 就能确定。
   * 弹窗 / 共享页的封面菜单与飞书卡片的「搜 X」按钮按这里的表反查平台；在平台上怎么找、
   * 怎么判定唯一同名见 src/shared/platform-link.js。 */

  // IMDb 出品公司 → 站点键。DramaWave（co1124838）只有 App、网页端不能播放，刻意不收：
  // 它的卡保持点封面直开 IMDb。新平台榜要支持「搜平台」时在这里加一行
  const IMDB_COMPANY_SITES = Object.freeze({
    co1116954: 'mydrama',
    co1016895: 'reelshort',
    co1116348: 'dramashorts',
    co1104898: 'netshort',
    co1149472: 'flickreels',
    co1045147: 'goodshort',
    co1167893: 'shortical',
    co1065580: 'shortmax',
    co1028734: 'dramabox'
  });

  // 平台站内搜索结果页（用户可见的落地页，后台也按同一地址取数判定）。2026-09-28 逐站实测；
  // MyDrama / Shortical / NetShort 网页端没有按片名的搜索网址，不在表内。
  // ShortMax 的关键词是路径段（/search/<词>），其余是查询参数
  const PLATFORM_SEARCH_PAGES = Object.freeze({
    reelshort: q => `https://www.reelshort.com/search?keywords=${encodeURIComponent(q)}`,
    dramashorts: q => `https://dramashorts.io/search?q=${encodeURIComponent(q)}`,
    flickreels: q => `https://www.flickreels.net/search?drama=${encodeURIComponent(q)}`,
    goodshort: q => `https://www.goodshort.com/results?q=${encodeURIComponent(q)}`,
    shortmax: q => `https://www.shorttv.live/search/${encodeURIComponent(q)}`,
    dramabox: q => `https://www.dramabox.com/search?searchValue=${encodeURIComponent(q)}`
  });

  /** IMDb 条目属于哪个短剧平台（站点键）；不是 IMDb 条目、micro-drama 这类非平台榜、DramaWave 返回 null。 */
  function imdbPlatformOf(drama) {
    if (!drama || siteOfDrama(drama) !== 'imdb' || typeof drama.sourceListUrl !== 'string') return null;
    let companies;
    try {
      companies = new URL(drama.sourceListUrl).searchParams.get('companies');
    } catch (e) {
      return null;
    }
    // companies 可以逗号多值，取第一个认得的；hasOwnProperty 挡住 constructor 这类原型链键
    for (const id of String(companies || '').split(',')) {
      const key = id.trim();
      if (Object.prototype.hasOwnProperty.call(IMDB_COMPANY_SITES, key)) return IMDB_COMPANY_SITES[key];
    }
    return null;
  }

  /**
   * 在平台上搜的关键词：去掉片名末尾的括号注释（IMDb 常把另一语种的片名括在后面，如
   * 「A Marriage on Fire (Un Matrimonio al Rojo Vivo)」），去完为空就用原片名。
   */
  function platformSearchQuery(title) {
    const raw = String(title || '').trim();
    const stripped = raw.replace(/\s*[(（[【][^()（）[\]【】]*[)）\]】]\s*$/, '').trim();
    return stripped || raw;
  }

  /** 平台站内搜索结果页地址；该平台网页端没有搜索页或片名为空时返回 null。 */
  function platformSearchUrl(site, title) {
    const query = platformSearchQuery(title);
    const build = Object.prototype.hasOwnProperty.call(PLATFORM_SEARCH_PAGES, site) ? PLATFORM_SEARCH_PAGES[site] : null;
    return build && query ? build(query) : null;
  }

  /**
   * url 是否为该站点自己的 https 页面（点边界匹配，DramaBox 两个域名都算）。条目上记下的 playUrl
   * 与从平台页面解析出的地址，打开 / 渲染前都过这一道，防串站与 javascript: 之类的异常值。
   */
  function isPlatformUrl(site, url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return false;
    }
    if (parsed.protocol !== 'https:') return false;
    return SITES.some(entry => entry.site === site && hostMatches(entry, parsed.hostname));
  }

  /**
   * manifest content_scripts.matches 的推导式。注册表是站点归属的单一真源，
   * 生成脚本（scripts/update-site-matches.mjs）与回归断言都从这里取，
   * 避免「两处各自从注册表推一遍」导致改一处漏一处。
   */
  function contentScriptMatches() {
    return SITES.flatMap(entry => {
      const origin = `*://${entry.match === 'exact' ? '' : '*.'}${entry.host}`;
      return [].concat(entry.path || '/*').map(path => `${origin}${path}`);
    });
  }

  const api = {
    SITES, SITE_GROUPS, DEFAULT_GROUP, CATEGORY_SOURCES, SOURCE_NAMES,
    groupOfSite, siteOfHostname, siteOfUrl, siteOfDrama, isInjectableUrl, contentScriptMatches,
    IMDB_COMPANY_SITES, PLATFORM_SEARCH_PAGES, imdbPlatformOf, platformSearchQuery, platformSearchUrl, isPlatformUrl
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.SiteRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
