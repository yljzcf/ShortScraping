/**
 * 订阅 URL 归属判定（弹窗 / 后台 / 同步服务三端共用）。
 *
 * 语义：卡片的 sourceListUrl 与订阅 URL 做「尾斜杠归一后的精确等值」。
 * 旧的 startsWith 前缀匹配会让互为前缀的订阅互相串扰——例如退订
 * my-drama.com/?list=best_choices 后，其历史卡片因前缀命中 my-drama.com/
 * 而清不掉、且挂错归属，故废弃（2026-07-15）。
 *
 * 精确等值成立的前提：content.js 抓取时把命中的订阅 URL 本身写进
 * sourceListUrl（而非 location.href）；尾斜杠归一只为兼容手写配置的斜杠差异。
 * 「这页归哪条订阅」由 matchSubscription 判定（内容脚本用），与上面的归属过滤共用
 * 同一个 normalizeListUrl，两边口径不再各写一份。
 *
 * 加载方式：后台 importScripts / 弹窗 <script> 标签 / 内容脚本（manifest content_scripts
 * 与后台强制注入，排在 content.js 之前）都挂 globalThis.UrlMatch，同步服务 require（module.exports）。
 */
(function (global) {
  'use strict';

  function normalizeListUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function buildConfiguredUrlSet(configuredUrls) {
    const set = new Set();
    for (const url of configuredUrls || []) {
      const normalized = normalizeListUrl(url);
      if (normalized) set.add(normalized);
    }
    return set;
  }

  function isUrlCovered(sourceListUrl, configuredUrlSet) {
    if (!sourceListUrl) return false;
    return configuredUrlSet.has(normalizeListUrl(sourceListUrl));
  }

  /** ?list= 板块参数（全项目的板块约定参数）；没有该参数或 URL 解析不了都是 null。 */
  function listParamOf(url) {
    try {
      return new URL(url).searchParams.get('list');
    } catch (e) {
      return null;
    }
  }

  /**
   * 当前页 URL 命中的订阅项（urlTags 里的原对象），无匹配返回 null。内容脚本据此取标签，
   * 并把命中项的 urlPattern 写进新卡的 sourceListUrl。
   *
   * 两轮都先做 normalizeListUrl（尾斜杠归一）：
   * ① 精确轮：归一后相等。订阅带斜杠、页面不带（站点 301 去掉斜杠）或反过来都能命中——
   *   以前这一轮直接 ===，只有页面比订阅串长时才能靠前缀轮兜住，反过来整条订阅静默停抓
   *   （审查 content-subscription-matcher-divergent）。
   * ② 前缀轮（容忍跳转后 href 多出来的 query / hash）：页面须以归一后的订阅开头，且多出来的
   *   尾巴只能是补一个斜杠、追加 query 或 hash——订阅本身带 query 时只能再续 &… 或 #…；
   *   不许新增路径段、不许把参数值续长。另外两边的 ?list= 必须相等。取最长匹配
   *   （Netflix 六个榜单页互为前缀，带 query 的 href 按配置顺序取首个会误标到 /tudum/top10）。
   *   以前是裸 startsWith：只订 my-drama.com/ 时在 /?list=best_choices 上点按钮，那个板块的卡
   *   会带着首页订阅的标签与 sourceListUrl 入库，归属合法、订阅外清理也清不掉；只订
   *   /tudum/top10 时 /tudum/top10/tv 同理；订阅 ?flavor=a 还会命中 ?flavor=ab
   *   （审查 subscription-prefix-misattribution）。
   * 两轮分开：互为前缀的订阅（fandom 首页与 fandom/?list=trending）不受配置顺序影响。
   */
  function matchSubscription(pageUrl, urlTags) {
    const url = normalizeListUrl(pageUrl);
    if (!url || !Array.isArray(urlTags)) return null;
    const entries = urlTags.filter(config => config && config.urlPattern && Array.isArray(config.tags));

    for (const config of entries) {
      if (normalizeListUrl(config.urlPattern) === url) return config;
    }

    const pageList = listParamOf(url);
    let longest = null;
    let longestLength = 0;
    for (const config of entries) {
      const pattern = normalizeListUrl(config.urlPattern);
      if (!pattern || !url.startsWith(pattern)) continue;
      const rest = url.slice(pattern.length);
      const tailOk = pattern.includes('?') ? /^([&#].*)?$/.test(rest) : /^\/?([?#].*)?$/.test(rest);
      if (!tailOk || listParamOf(pattern) !== pageList) continue;
      if (pattern.length > longestLength) {
        longest = config;
        longestLength = pattern.length;
      }
    }
    return longest;
  }

  const api = { normalizeListUrl, buildConfiguredUrlSet, isUrlCovered, matchSubscription };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.UrlMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
