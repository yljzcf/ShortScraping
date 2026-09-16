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
 * 加载方式：后台 importScripts / 设置页 <script>（挂 globalThis.SubscriptionConfig）/
 * 同步服务 require（module.exports）。
 */
(function (global) {
  'use strict';

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

  const api = { MAX_TAGS, normalizeUrlTags, toTagFileEntries };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.SubscriptionConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
