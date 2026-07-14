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
 *
 * 加载方式：后台 importScripts / 弹窗 <script> 标签（挂 globalThis.UrlMatch），
 * 同步服务 require（module.exports）。
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

  const api = { normalizeListUrl, buildConfiguredUrlSet, isUrlCovered };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.UrlMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
