/** 翻译配置默认值与归一化：后台、设置页、翻译器、同步服务共用。 */
(function (global) {
  'use strict';
  const DEFAULT_CONFIG = Object.freeze({
    translateMode: 'api',
    apiEndpoint: 'https://api.mymemory.translated.net/get',
    aiEndpoint: '', aiApiKey: '', aiModel: 'gpt-3.5-turbo',
    aiPrefixPrompt: '你是一位资深的影视爱好者，也观看过大量快节奏的短剧、短视频。请把片名和内容简介翻译为最有网感的中文表达。',
    batchSize: 10, delayMs: 200, requestTimeoutSec: 10
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
  const api = { DEFAULT_CONFIG, normalizeConfig };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TranslateConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
