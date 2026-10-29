/**
 * 弹窗搜索（v1.8.2）的匹配判据：纯函数，不碰 DOM / chrome.*，弹窗与单测共用。
 *
 * - 可搜字段：title / titleZh / description / descriptionZh / tags / genres，外加 genres 经
 *   中文类型标签体系对照出的中文标签与它们的搜索同义词（v1.8.13 起取代 v1.8.2 的 GENRE_ZH 对照：
 *   中文搜「复仇」命中 Revenge、搜「总裁」命中 Billionaire）。同义词只用于匹配，卡片上不显示。
 * - 归一：NFKC（全角字母数字、全角空格转半角）+ 小写；查询按空白切词、全部命中（AND）。
 * - 子串匹配：「道总」命中「霸道总裁」。只有 1~3 个字母的纯英文词按整词匹配（v1.8.13）：
 *   BL、GL、CEO 不再命中 Billionaire、Global 里的那一截。各字段之间用不可见分隔符拼接，
 *   词不会跨字段拼凑命中。卡片标亮（timeline-render）用同一份 termPattern / termMatches。
 * - 排序不在这里管：结果交给 TimelineRender.renderTimeline 按入库日期分组。
 */
(function (global) {
  'use strict';

  // 中文类型标签体系：弹窗里须先于本文件加载，Node（单测）里直接 require
  const GenreTaxonomy = (typeof module !== 'undefined' && module.exports)
    ? require('./genre-taxonomy.js')
    : global.GenreTaxonomy;

  // 字段之间的分隔符：不可见、查询里打不出来，词不会跨字段拼出命中
  const SEP = '\u0001';

  // 按整词匹配的搜索词：1~3 个字母的纯英文（归一后），子串匹配会命中大量长词里的那一截
  const WHOLE_WORD = /^[a-z]{1,3}$/;

  function normalize(text) {
    return String(text == null ? '' : text).normalize('NFKC').toLowerCase();
  }

  const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** 一个（已归一的）搜索词的正则源码：短英文词带词边界，其余按字面子串。卡片标亮也用它。 */
  function termPattern(term) {
    const escaped = escapeRegExp(String(term));
    return WHOLE_WORD.test(term) ? `\\b${escaped}\\b` : escaped;
  }

  /** text 须已归一（normalize）。 */
  function termMatches(term, text) {
    return WHOLE_WORD.test(term) ? new RegExp(termPattern(term)).test(text) : text.includes(term);
  }

  /** 查询 → 归一后的词表（按空白切、去空、去重）；空查询得 []。 */
  function parseQuery(query) {
    return [...new Set(normalize(query).split(/\s+/).filter(Boolean))];
  }

  function stringList(value) {
    return Array.isArray(value) ? value.map(v => String(v == null ? '' : v).trim()).filter(Boolean) : [];
  }

  /** 一部剧可被搜到的全部文本（已归一，字段间用 SEP 隔开）。 */
  function haystackOf(drama) {
    const genres = stringList(drama.genres);
    const zhTags = GenreTaxonomy ? GenreTaxonomy.zhTagsOf(genres) : [];
    const synonyms = zhTags.flatMap(tag => GenreTaxonomy.synonymsOf(tag));
    return normalize([
      drama.title, drama.titleZh, drama.description, drama.descriptionZh,
      ...stringList(drama.tags), ...genres, ...zhTags, ...synonyms
    ].filter(v => v != null && v !== '').join(SEP));
  }

  /** terms 为 parseQuery 的结果；空词表不算命中（没有查询就没有结果）。 */
  function matchDrama(drama, terms) {
    if (!drama || typeof drama !== 'object' || !terms || terms.length === 0) return false;
    const haystack = haystackOf(drama);
    return terms.every(term => termMatches(term, haystack));
  }

  /** 从 dramas 里挑出命中 query 的条目，保持原顺序；空查询得 []。 */
  function searchDramas(dramas, query) {
    const terms = parseQuery(query);
    if (terms.length === 0 || !Array.isArray(dramas)) return [];
    return dramas.filter(drama => matchDrama(drama, terms));
  }

  const api = { normalize, parseQuery, termPattern, termMatches, matchDrama, searchDramas };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DramaSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
