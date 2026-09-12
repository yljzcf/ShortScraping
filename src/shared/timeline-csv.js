/**
 * 时间线 CSV 序列化（单一真源，2026-08-01 自 sync-server.js 抽出）：
 * 列序、转义规则（双引号翻倍/换行折空格/数组英文逗号连接）、BOM+CRLF、
 * itemId||id 去重与 normalizeDrama 15 字段白名单在此收敛——
 * 同步服务写 db/timeline.csv 与设置页「导出 CSV」共用，两端产物必然一致。
 *
 * 加载方式：设置页 <script> 标签 / 后台 importScripts（挂 globalThis.TimelineCsv），
 * 同步服务 require（module.exports）。纯函数层，无 fs / chrome.* 依赖。
 */
(function (global) {
  'use strict';

  const CSV_BOM = '﻿';
  const CSV_NEWLINE = '\r\n';

  const CSV_COLUMNS = [
    'id',
    'itemId',
    'title',
    'titleZh',
    'tags',
    'description',
    'descriptionZh',
    'source',
    'status',
    'url',
    'sourceListUrl',
    'poster',
    'scrapedAt',
    'translatedAt',
    'genres'
  ];

  // 逐条导入时不再重建（上限 10 万条）：标量字段＝除数组列以外的全部列 + 旧 imdbId
  const SCALAR_IMPORT_FIELDS = CSV_COLUMNS
    .filter(key => key !== 'tags' && key !== 'genres')
    .concat('imdbId');

  function csvEscape(value) {
    if (value === null || value === undefined) return '';
    // 数组用英文逗号连接（v1.5.13 由竖线改，与 Lark payload 自 2026-07-25 的约定一致，
    // 表格软件/Base 把文本列转多选时默认也按逗号切）：单元格本就带引号包裹，逗号
    // 不会把它拆成两列。已知残留风险——标签值本身若含英文逗号会在 Base 里被错切成
    // 两个标签，全量 3454 条实测零命中，payload 侧暴露同样风险已久，两边保持一致。
    let text = Array.isArray(value) ? value.join(',') : String(value);
    // CSV 引号只隔离列，不阻止表格公式；为不可信文本添加文本前缀。
    // 只覆盖 OWASP 明列的 = + - @ 与前导 Tab/CR/LF：没有表格软件在导入时把全角
    // ＝＋－＠ 当公式起始，给它们加前缀只会让以「－」「＋」开头的合法中文文案多出撇号。
    if (/^\s*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  }

  function normalizeDrama(drama) {
    return {
      id: drama.id || '',
      // 旧字段名兼容读取：更名前的 timeline.json 快照/旧版扩展推送仍带 imdbId
      itemId: drama.itemId || drama.imdbId || '',
      title: drama.title || '',
      titleZh: drama.titleZh || '',
      tags: Array.isArray(drama.tags) ? drama.tags : [],
      description: drama.description || '',
      descriptionZh: drama.descriptionZh || '',
      source: drama.source || '',
      status: drama.status || '',
      url: drama.url || '',
      sourceListUrl: drama.sourceListUrl || '',
      poster: drama.poster || '',
      scrapedAt: drama.scrapedAt || '',
      translatedAt: drama.translatedAt || '',
      genres: Array.isArray(drama.genres) ? drama.genres : []
    };
  }

  const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;

  function isHttpUrl(value) {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch (error) {
      return false;
    }
  }

  function cleanTextList(values) {
    return [...new Set(values.map(value => value.trim()).filter(Boolean))];
  }

  /** 导入入口严格校验；CSV 的字段投影不承担数据有效性判断。 */
  function validateImportDrama(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const input = { ...raw };
    for (const key of ['id', 'itemId', 'imdbId']) {
      if (typeof input[key] === 'number' && Number.isSafeInteger(input[key]) && input[key] > 0) input[key] = String(input[key]);
    }
    for (const key of SCALAR_IMPORT_FIELDS) {
      if (input[key] != null && typeof input[key] !== 'string') return null;
    }
    for (const key of ['tags', 'genres']) {
      if (input[key] != null && (!Array.isArray(input[key]) || input[key].some(v => typeof v !== 'string'))) return null;
    }
    const result = normalizeDrama(input);
    result.itemId = result.itemId.trim();
    if (!result.itemId) return null;
    // 时间戳只认带时区的 ISO-8601：Date.parse 会把 '2026/09/05' 与无偏移的
    // '2026-09-05T01:00:00' 按宿主本地时区解释再固化，同一份备份在不同时区的
    // 机器上导入出不同时刻，卡片落到错误的日期分组
    for (const key of ['scrapedAt', 'translatedAt']) {
      if (result[key]) {
        if (!ISO_TIMESTAMP.test(result[key])) return null;
        result[key] = new Date(result[key]).toISOString();
      }
    }
    // 结构性链接非法即判无效；封面只丢字段不丢记录——渲染端本就有默认海报兜底
    // （timeline-render 的 poster || defaultPoster 与 onerror 两道），为一个没取到
    // 绝对地址的封面丢掉整条剧集数据不划算
    for (const key of ['url', 'sourceListUrl']) {
      if (result[key] && !isHttpUrl(result[key])) return null;
    }
    if (result.poster && !isHttpUrl(result.poster)) result.poster = '';
    // 与采集侧 cleanGenres 同语义（trim/去空/去重）：导入曾是唯一未清洗的写入口，
    // 空串元素会在卡片 footer 渲染出空标签、在 CSV 里留下空的竖线分段
    result.tags = cleanTextList(result.tags);
    result.genres = cleanTextList(result.genres);
    return result;
  }

  function serializeTimelineCsv(rows) {
    const body = [CSV_COLUMNS.join(','), ...rows].join(CSV_NEWLINE);
    return CSV_BOM + body + CSV_NEWLINE;
  }

  /**
   * 条目数组 → 完整 CSV 文本：normalizeDrama 白名单重建 + itemId||id 去重
   * （先到先得）+ 逐列转义。返回 { content, count }，count 为数据行数。
   */
  function buildTimelineCsv(dramas) {
    const seen = new Set();
    const rows = [];

    for (const drama of dramas || []) {
      const normalized = normalizeDrama(drama);
      const key = normalized.itemId || normalized.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);

      rows.push(CSV_COLUMNS.map(column => csvEscape(normalized[column])).join(','));
    }

    return { content: serializeTimelineCsv(rows), count: rows.length };
  }

  const api = { CSV_COLUMNS, csvEscape, normalizeDrama, validateImportDrama, buildTimelineCsv };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.TimelineCsv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
