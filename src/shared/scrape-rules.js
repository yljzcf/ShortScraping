/**
 * 采集口径的单一真源：内容脚本（content.js）与后台 SW（background.js）共用。
 *
 * 收拢自两边各写一份、全靠注释提醒「手工同步」的三处（2026-09-25 审查
 * cross-file-sync-constants）：
 *   - fandom 未映射临时键前缀：内容侧的未映射闸门（不入库）与后台的存量清理认同一套；
 *   - cleanGenres：采集侧的类型标签清洗，后台 genres 回填合并用同一口径；
 *   - Shortical sitemap 解析：内容侧取规范 slug 与后台一次性迁移共用。
 * 只放纯函数与常量，不碰 chrome.* / DOM / 网络。
 *
 * 加载方式：内容脚本经 manifest content_scripts 的 js 数组、后台强制注入经
 * scripting.executeScript 的 files 数组（两份清单逐字一致，unit-site-registry T4a/T4b 守着），
 * 都排在 content.js 之前；后台 SW 经 importScripts；Node 测试经 require（tests/bootstrap.cjs）。
 */
(function (global) {
  'use strict';

  /**
   * fandom 条目映射不到主站时用的临时去重键前缀：MyDrama mdf- / ReelShort rsf- / ShortMax smf-。
   * 都带连字符，与 md+UUID、rs+hex、sm+数字 的正式键无歧义。新增 fandom 入口只改这里。
   */
  const UNMAPPED_FANDOM_PREFIXES = Object.freeze(['mdf-', 'rsf-', 'smf-']);

  /** itemId 还是 fandom 临时键（＝没映射到主站、给不了播放页）。 */
  function isUnmappedFandomKey(itemId) {
    const key = String(itemId || '');
    return UNMAPPED_FANDOM_PREFIXES.some(prefix => key.startsWith(prefix));
  }

  /**
   * 类型标签清洗（多适配器共用）：trim、去空、按原值去重；非数组一律当空。
   * 存站点原始英文值，不做翻译（2026-08-02 用户定）。
   */
  function cleanGenres(list) {
    return [...new Set((Array.isArray(list) ? list : []).map(v => String(v || '').trim()).filter(Boolean))];
  }

  /**
   * 解析 Shortical 的 sitemaps/series.xml，得到 `slug 基名 → 规范 slug` 表（基名＝去掉尾部
   * `-<数字>`；查表时同样按基名查）。只收 /drama/<slug>-<数字> 形态的 <loc>，同一基名先到先得
   * （实测 142 条基名零碰撞）。
   * 站点对未命中路径一律回 200＋9KB 空壳，所以返回空表＝没拿到 sitemap，由调用方按失败处理。
   */
  function parseShorticalSitemap(xml) {
    const map = new Map();
    for (const match of String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const slug = (match[1].match(/\/drama\/([^/?#]+)/) || [])[1] || '';
      if (!/-\d+$/.test(slug)) continue;
      const base = slug.replace(/-\d+$/, '');
      if (!map.has(base)) map.set(base, slug);
    }
    return map;
  }

  const api = { UNMAPPED_FANDOM_PREFIXES, isUnmappedFandomKey, cleanGenres, parseShorticalSitemap };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.ScrapeRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
