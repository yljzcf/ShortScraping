/**
 * 时间线 CSV 序列化（单一真源，2026-08-01 自 sync-server.js 抽出）：
 * 列序、转义规则（双引号翻倍/换行折空格/数组竖线连接）、BOM+CRLF、
 * itemId||id 去重与 normalizeDrama 16 字段白名单在此收敛——
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
    'company',
    'source',
    'status',
    'url',
    'sourceListUrl',
    'poster',
    'scrapedAt',
    'translatedAt',
    'genres'
  ];

  function csvEscape(value) {
    if (value === null || value === undefined) return '';
    let text = Array.isArray(value) ? value.join('|') : String(value);
    // CSV 引号只隔离列，不阻止表格公式；为不可信文本添加文本前缀。
    if (/^\s*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(text)) text = `'${text}`;
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
      company: drama.company || '',
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

  /** 导入入口严格校验；CSV 的字段投影不承担数据有效性判断。 */
  function validateImportDrama(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const input = { ...raw };
    for (const key of ['id', 'itemId', 'imdbId']) {
      if (typeof input[key] === 'number' && Number.isSafeInteger(input[key]) && input[key] > 0) input[key] = String(input[key]);
    }
    for (const key of CSV_COLUMNS.filter(key => key !== 'tags' && key !== 'genres').concat('imdbId')) {
      if (input[key] != null && typeof input[key] !== 'string') return null;
    }
    for (const key of ['tags', 'genres']) {
      if (input[key] != null && (!Array.isArray(input[key]) || input[key].some(v => typeof v !== 'string'))) return null;
    }
    const result = normalizeDrama(input);
    result.itemId = result.itemId.trim();
    if (!result.itemId) return null;
    for (const key of ['scrapedAt', 'translatedAt']) {
      if (result[key]) {
        const ms = Date.parse(result[key]);
        if (!Number.isFinite(ms)) return null;
        result[key] = new Date(ms).toISOString();
      }
    }
    for (const key of ['url', 'sourceListUrl', 'poster']) {
      if (result[key]) {
        try { if (!['http:', 'https:'].includes(new URL(result[key]).protocol)) return null; }
        catch (_) { return null; }
      }
    }
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
