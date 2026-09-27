/**
 * 订阅配置规范化（后台 / 设置页 / 同步服务三端共用，v1.6.5 收敛）。
 *
 * 此前三处各写一份且语义已漂移：后台加载 tag.json 时不 trim 标签、不校 http、不去重，
 * 设置页保存与同步服务落盘都做——同一份文件走两条路径得到两种标签，直接印到卡片上。
 * 这里取最严的那份为唯一语义：
 *   - 条目须为普通对象；url 取 urlPattern（优先）或 url，trim 后必须是 http(s)；
 *   - tags 接受数组或以英文/全角逗号分隔的字符串，逐个 trim、去空、去重后最多 MAX_TAGS 个；
 *   - 零标签的条目丢弃；同一 urlPattern 只保留先出现的合法条目（先到先得，
 *     被丢弃的无效条目不占名额——与设置页/同步服务的旧实现「先过滤再去重」一致）。
 *     「同一」按 UrlMatch 的尾斜杠归一判定，保留先出现的原串写法。
 * 扩展内部形态 { urlPattern, tags }（storage.urlTags）；文件形态 { url, tags }
 * （config/tag.json）由 toTagFileEntries 投影。两者都只输出这两个键，多余字段不透传。
 *
 * v1.6.7 追加退订侧的两个纯函数（removedSubscriptionUrls / dramasUnderUrls）：
 * 设置页要在写 storage **之前**算出「这次退订会删掉几条历史」并弹确认，判定口径
 * 必须与后台 filterDramasByConfiguredUrls 逐字一致，故同样委托 url-match.js。
 * v1.7.0 把「要抓的订阅 URL 清单」（configuredScrapeUrls）也收进来：后台与弹窗此前各写一份，
 * 去重口径还不一样（后台按尾斜杠归一，弹窗按原串）。
 * v1.7.0 加「抓取时实际打开的地址」（withReleaseWindow）：IMDb 订阅 URL 不再写死起始日期，
 * 滚动日期窗口在打开页面前补到地址末尾，后台抓取与弹窗「去抓取」共用。
 *
 * 加载方式：后台 importScripts / 设置页与弹窗 <script>（挂 globalThis.SubscriptionConfig）/
 * 同步服务 require（module.exports）。**须在 url-match.js 之后加载**。
 */
(function (global) {
  'use strict';

  // 依赖解析与 lark.js / site-tabs.js 同范式：Node 侧自己 require，浏览器侧取已加载的全局
  const UrlMatch = (typeof module !== 'undefined' && module.exports)
    ? require('./url-match.js')
    : global.UrlMatch;

  const MAX_TAGS = 3;

  function normalizeTags(value) {
    let list;
    if (Array.isArray(value)) list = value;
    else if (typeof value === 'string') list = value.split(/[,，]/);
    else list = [];
    // 先去重再截断：'A, A ,B' 旧实现得 ['A','A','B']，卡片上印出重复标签，还挤掉第三个名额
    const unique = [...new Set(list
      .map(tag => (tag === null || tag === undefined ? '' : String(tag)).trim())
      .filter(Boolean))];
    return unique.slice(0, MAX_TAGS);
  }

  function normalizeUrlTags(rawTags) {
    if (!Array.isArray(rawTags)) return [];

    const seen = new Set();
    const out = [];
    for (const item of rawTags) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const urlPattern = String(item.urlPattern || item.url || '').trim();
      // 去重键与归属判定同口径（尾斜杠归一）：旧实现按原串比，手写 tag.json 里 '…/x' 与
      // '…/x/' 并存时两条都保留，同一页每轮开两个标签页抓两次，卡上印哪套标签看谁先命中
      const key = UrlMatch.normalizeListUrl(urlPattern);
      if (!/^https?:\/\//i.test(urlPattern) || seen.has(key)) continue;
      const tags = normalizeTags(item.tags);
      if (tags.length === 0) continue;
      seen.add(key);
      out.push({ urlPattern, tags });
    }
    return out;
  }

  function toTagFileEntries(rawTags) {
    return normalizeUrlTags(rawTags).map(({ urlPattern, tags }) => ({ url: urlPattern, tags }));
  }

  /**
   * 要抓的订阅 URL 清单（后台抓取 / 订阅外清理 / 导入范围判定与弹窗共用）：取 urlPattern（缺省退回 url），
   * 只认完整的 http(s) URL，按尾斜杠归一去重、保留先出现的原串。新写入的 urlTags 已不会并存两种写法，
   * 这里兜住旧版本写进 storage 的 '…/x' 与 '…/x/'——按原串去重时同一页每轮要开两个标签页抓两遍
   * （审查 urltags-dedupe-raw）。
   * urlTags 为 null / undefined 得 []；是真值却不是数组则抛错：宁可这一轮清理失败，也不能把坏数据当成
   * 「零订阅」，让订阅外清理把整库挪进回收站（与收拢前后台 `(urlTags || []).map` 自然抛错同口径）。
   */
  function configuredScrapeUrls(urlTags) {
    if (!urlTags) return [];
    if (!Array.isArray(urlTags)) throw new TypeError('订阅配置 urlTags 不是数组');
    const seen = new Set();
    const out = [];
    for (const item of urlTags) {
      const url = item && typeof item === 'object' ? (item.urlPattern || item.url) : undefined;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
      const key = UrlMatch.normalizeListUrl(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
    }
    return out;
  }

  /**
   * 抓取时实际打开的地址（v1.7.0）：IMDb 搜索页的订阅不再把发行日期写死在 URL 里——以前的
   * `release_date=2026-01-01,` 起点固定，池子一年年越来越宽，只读前 50 条时新片被老片挤出去。现在订阅 URL
   * 不带日期（它是历史归属的身份，改了就等于退订），打开页面前才在末尾补滚动窗口 `&release_date=<今天−N 天>,`。
   * 内容脚本照样认得出这页：url-match.js 的前缀轮容忍订阅 URL 尾部多出来的 `&…`，归属仍写订阅 URL 本身。
   * 只处理 imdb.com 的 /search/title 页、订阅自己没写 release_date、也没带 #片段的；windowDays 不是正整数
   * （含 0＝不限日期）原样返回。日期按本机时区的日历日倒推，跨月跨年与夏令时都由 Date 构造器处理。
   */
  function withReleaseWindow(url, windowDays, now = new Date()) {
    const days = Number(windowDays);
    if (typeof url !== 'string' || !Number.isInteger(days) || days <= 0 || url.includes('#')) return url;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return url;
    }
    const isImdbSearch = (parsed.hostname === 'imdb.com' || parsed.hostname.endsWith('.imdb.com'))
      && parsed.pathname.startsWith('/search/title');
    if (!isImdbSearch || parsed.searchParams.has('release_date')) return url;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
    const pad = n => String(n).padStart(2, '0');
    const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    return `${url}${url.includes('?') ? '&' : '?'}release_date=${date},`;
  }

  /**
   * 保存订阅时「这次取消掉了哪些订阅 URL」。返回**旧配置里的原始写法**（未归一），
   * 供确认框原样展示；比对本身走 UrlMatch 的尾斜杠归一，故仅尾斜杠差异不算退订。
   * 只改标签不改 URL 也不算退订——那是编辑，历史不该被牵连。
   */
  function removedSubscriptionUrls(prevUrlTags, nextUrlTags) {
    const nextSet = UrlMatch.buildConfiguredUrlSet(
      (Array.isArray(nextUrlTags) ? nextUrlTags : []).map(item => item && (item.urlPattern || item.url))
    );
    const out = [];
    const seen = new Set();
    for (const item of (Array.isArray(prevUrlTags) ? prevUrlTags : [])) {
      const raw = item && (item.urlPattern || item.url);
      const normalized = UrlMatch.normalizeListUrl(raw);
      if (!normalized || nextSet.has(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(String(raw));
    }
    return out;
  }

  /**
   * 落在给定订阅 URL 下的条目。判定复用 UrlMatch（尾斜杠归一后的**精确等值**），
   * 与后台 filterDramasByConfiguredUrls 同口径——确认框提示的条数必须等于实际会被
   * 清掉的条数、备份文件必须正好是那批条目，否则提示与备份都成了假情报。
   * 缺 sourceListUrl 的条目永不命中。
   */
  function dramasUnderUrls(dramas, urls) {
    const set = UrlMatch.buildConfiguredUrlSet(urls);
    if (set.size === 0) return [];
    return (Array.isArray(dramas) ? dramas : [])
      .filter(drama => drama && UrlMatch.isUrlCovered(drama.sourceListUrl, set));
  }

  const api = {
    normalizeUrlTags, toTagFileEntries, configuredScrapeUrls, withReleaseWindow,
    removedSubscriptionUrls, dramasUnderUrls
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.SubscriptionConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
