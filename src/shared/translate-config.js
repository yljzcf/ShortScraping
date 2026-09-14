/**
 * 翻译域的配置与文本判据单一真源：后台、设置页、翻译器、同步服务、内容脚本、
 * 弹窗与局域网共享页共用。
 *
 * 除配置默认值/归一化外，还放两件「译名怎么算、怎么显示」的纯判据
 * （hasChineseChars / titleDisplay）——它们的调用方横跨 content.js、
 * timeline-render.js 与 lark.js 三个互不相见的模块，只有放这里才是一份。
 */
(function (global) {
  'use strict';
  const DEFAULT_CONFIG = Object.freeze({
    translateMode: 'api',
    apiEndpoint: 'https://api.mymemory.translated.net/get',
    aiEndpoint: '', aiApiKey: '', aiModel: 'gpt-3.5-turbo',
    aiPrefixPrompt: '你是一位资深的影视爱好者，也观看过大量快节奏的短剧、短视频。请把片名和内容简介翻译为最有网感的中文表达。',
    // requestTimeoutSec 是上限不是等待时长：推理型模型（deepseek-flash 等）一批
    // 要烧几千个 reasoning token，2026-09-12 实测 10 条/批耗时 9.5~34 秒、中位 17.4，
    // 旧默认值 10 秒会掐断约八成批次——整批作废下轮重试，API 白花、翻译被拖慢。
    batchSize: 10, delayMs: 200, requestTimeoutSec: 60
  });
  function normalizeConfig(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const result = { ...DEFAULT_CONFIG };
    result.translateMode = (input.translateMode || input.mode) === 'ai' ? 'ai' : 'api';
    for (const key of ['apiEndpoint', 'aiEndpoint', 'aiApiKey', 'aiModel', 'aiPrefixPrompt']) {
      if (typeof input[key] === 'string' && input[key].trim()) result[key] = input[key].trim();
    }
    for (const key of ['batchSize', 'delayMs', 'requestTimeoutSec']) {
      const value = Number(input[key]);
      if (input[key] !== null && input[key] !== '' && Number.isSafeInteger(value) && value >= (key === 'delayMs' ? 0 : 1)) result[key] = value;
    }
    return result;
  }
  /**
   * 「这串文本是不是中文」的唯一判据＝含至少一个汉字（含扩展 A 区）。
   *
   * Steam 的 appdetails?l=schinese 在开发商没做简体中文本地化时，返回的是
   * **开发商母语**的名字（2026-09-14 逐条实测：韩 탈출! 인연의 집 / 俄 Сакура /
   * 西 La mansión de Campanillas / 法 Les Ombres de Dry Creek）。适配器原先只查
   * 「与英文不同」，这些一律通过，卡片上就出现了韩语标题。
   *
   * 刻意只要求「含汉字」而不做语种黑名单：黑名单抓不到拉丁系外语（西/法/芬），
   * 且会误杀合法中文里的 の / ー / ・（伪娘与扶她の陷阱屋、人间牧场ー搜查篇ー、
   * 新約・怒首領蜂大復活）。反过来「正确的中文译名一个汉字都没有」构造不出来。
   */
  function hasChineseChars(text) {
    return /[一-鿿㐀-䶿]/.test(String(text || ''));
  }

  // 标题比对用的归一化：去空白、转小写、剥装饰性标点。只服务于「中英文名是否
  // 其实是同一个」的判断，不改变任何存储值。
  const TITLE_DECORATION = /[\s《》「」『』""''（）()[\]【】{}~!！?？.。,，:：;；·・\-—–_™®©]/g;
  function normalizeTitleForCompare(text) {
    return String(text || '').toLowerCase().replace(TITLE_DECORATION, '');
  }

  /**
   * 卡片/推送的标题文案：中英文名不同才拼成「中文（英文）」。
   *
   * 中文开发商的 Steam **英文档**名本身就是中文，AI 原样返回 → titleZh === title，
   * 旧写法渲染成「骷髅传奇（骷髅传奇）」（2026-09-14 全库实测 70 条）。归一化比对
   * 顺带盖住只差装饰性标点的形态（《NBA 2K27》/ NBA 2K27）。同名时取 titleZh，
   * 保住 Steam 官方中文的 《》 形态。
   *
   * 三个调用方共用：弹窗与共享页卡片（timeline-render）、多维表格 payload 的
   * title_display、群机器人卡片标题（lark）。
   */
  function titleDisplay(drama) {
    const titleZh = String((drama && drama.titleZh) || '').trim(); // trim 防止仅含空白的字段渲染出空行
    const title = String((drama && drama.title) || '').trim();
    if (!titleZh) return title;
    if (!title) return titleZh;
    if (normalizeTitleForCompare(titleZh) === normalizeTitleForCompare(title)) return titleZh;
    return `${titleZh}（${title}）`;
  }

  const api = { DEFAULT_CONFIG, normalizeConfig, hasChineseChars, titleDisplay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TranslateConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
