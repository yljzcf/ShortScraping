/**
 * 订阅配置规范化（后台 / 设置页 / 同步服务三端共用，v1.6.5 收敛）。
 *
 * 此前三处各写一份且语义已漂移：后台加载 tag.json 时不 trim 标签、不校 http、不去重，
 * 设置页保存与同步服务落盘都做——同一份文件走两条路径得到两种标签，直接印到卡片上。
 * 这里取最严的那份为唯一语义：
 *   - 条目须为普通对象；url 取 urlPattern（优先）或 url，trim 后必须是 http(s)；
 *   - tags 接受数组或以英文/全角逗号分隔的字符串，逐个 trim、去空、最多 MAX_TAGS 个；
 *   - 零标签的条目丢弃；同一 urlPattern 只保留先出现的合法条目（先到先得，
 *     被丢弃的无效条目不占名额——与设置页/同步服务的旧实现「先过滤再去重」一致）。
 * 扩展内部形态 { urlPattern, tags }（storage.urlTags）；文件形态 { url, tags }
 * （config/tag.json）由 toTagFileEntries 投影。两者都只输出这两个键，多余字段不透传。
 *
 * v1.6.7 追加退订侧的两个纯函数（removedSubscriptionUrls / countDramasUnderUrls）：
 * 设置页要在写 storage **之前**算出「这次退订会删掉几条历史」并弹确认，判定口径
 * 必须与后台 filterDramasByConfiguredUrls 逐字一致，故同样委托 url-match.js。
 *
 * 加载方式：后台 importScripts / 设置页 <script>（挂 globalThis.SubscriptionConfig）/
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
    return list
      .map(tag => (tag === null || tag === undefined ? '' : String(tag)).trim())
      .filter(Boolean)
      .slice(0, MAX_TAGS);
  }

  function normalizeUrlTags(rawTags) {
    if (!Array.isArray(rawTags)) return [];

    const seen = new Set();
    const out = [];
    for (const item of rawTags) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const urlPattern = String(item.urlPattern || item.url || '').trim();
      if (!/^https?:\/\//i.test(urlPattern) || seen.has(urlPattern)) continue;
      const tags = normalizeTags(item.tags);
      if (tags.length === 0) continue;
      seen.add(urlPattern);
      out.push({ urlPattern, tags });
    }
    return out;
  }

  function toTagFileEntries(rawTags) {
    return normalizeUrlTags(rawTags).map(({ urlPattern, tags }) => ({ url: urlPattern, tags }));
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

  function countDramasUnderUrls(dramas, urls) {
    return dramasUnderUrls(dramas, urls).length;
  }

  const api = {
    MAX_TAGS, normalizeUrlTags, toTagFileEntries,
    removedSubscriptionUrls, dramasUnderUrls, countDramasUnderUrls
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.SubscriptionConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
