/**
 * ShortScraping Translator Module
 * 封装翻译逻辑，支持 API 和 AI 两种模式
 */

globalThis.Translator = (() => {
  // 默认翻译 API
  const DEFAULT_API = 'https://api.mymemory.translated.net/get';

  /**
   * 获取翻译配置
   */
  async function getConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get('translateConfig', (result) => {
        resolve(normalizeConfig(result.translateConfig || {}));
      });
    });
  }

  /**
   * 统一新旧配置字段，避免 settings.js 与 translator.js 字段名不一致
   */
  function normalizeConfig(rawConfig) {
    return {
      mode: rawConfig.translateMode || rawConfig.mode || 'api',
      apiEndpoint: rawConfig.apiEndpoint || DEFAULT_API,
      aiEndpoint: rawConfig.aiEndpoint || '',
      aiApiKey: rawConfig.aiApiKey || '',
      aiModel: rawConfig.aiModel || 'gpt-3.5-turbo',
      aiPrefixPrompt: rawConfig.aiPrefixPrompt || '你是一位资深的影视爱好者，也观看过大量快节奏的短剧、短视频。请帮我将以下片名和内容简介翻译为最有网感的中文表达。输出格式为json结构，{"片名":"xxx","简介":"xxx"}。需要你翻译的内容为：',
      batchSize: Number(rawConfig.batchSize) || 5,
      delayMs: Number(rawConfig.delayMs) || 200,
      requestTimeoutSec: Number(rawConfig.requestTimeoutSec) || 10
    };
  }

  /**
   * 翻译单条文本（API 模式）
   */
  async function translate(text, targetLang = 'zh-CN') {
    if (!text || text.length < 3) return '';

    const config = await getConfig();

    if (config.mode === 'ai') {
      // AI 模式不支持单文本翻译，使用 translateTitleAndDesc
      console.warn('[ShortScraping] AI 模式请使用 translateTitleAndDesc');
      return '';
    } else {
      return await translateWithAPI(text, config, targetLang);
    }
  }

  /**
   * 翻译标题和简介（AI 模式，带前置提示词）
   */
  async function translateTitleAndDesc(title, description) {
    const config = await getConfig();
    console.log(`[ShortScraping] 翻译模式: ${config.mode}`);

    if (config.mode === 'ai') {
      return await translateWithAI(title, description, config);
    } else {
      // API 模式分别翻译
      const titleZh = await translateWithAPI(title, config);
      const descZh = description ? await translateWithAPI(description, config) : '';
      return { title: titleZh, desc: descZh };
    }
  }

  /**
   * API 模式翻译（MyMemory 等免费 API）
   */
  async function translateWithAPI(text, config, targetLang = 'zh-CN') {
    try {
      const url = `${config.apiEndpoint}?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`;
      const response = await fetchWithTimeout(url, {}, config.requestTimeoutSec);

      if (!response.ok) return '';

      const data = await response.json();

      if (data.responseStatus === 200 && data.responseData?.translatedText) {
        const translated = data.responseData.translatedText;
        // 过滤无效翻译
        if (translated && translated !== text && !translated.includes('MYMEMORY')) {
          return translated;
        }
      }

      return '';
    } catch (e) {
      console.warn('[ShortScraping] API 翻译失败:', e.message);
      return '';
    }
  }

  /**
   * AI 模式翻译（带前置提示词，返回 JSON）
   */
  async function translateWithAI(title, description, config) {
    if (!config.aiEndpoint || !config.aiApiKey) {
      console.warn('[ShortScraping] AI 翻译未配置端点或密钥');
      return { title: '', desc: '' };
    }

    try {
      // 构建 JSON 输入结构
      const inputJson = JSON.stringify({
        title: title,
        desc: description || ''
      });

      // 构建用户消息：前置提示词 + JSON 结构
      const userMessage = `${config.aiPrefixPrompt}\n\n${inputJson}`;

      const messages = [
        {
          role: 'user',
          content: userMessage
        }
      ];

      const model = config.aiModel || 'gpt-3.5-turbo';
      console.log(`[ShortScraping] 使用模型: ${model}`);
      console.log(`[ShortScraping] 发送消息: ${userMessage.substring(0, 100)}...`);

      const startAt = performance.now();
      const response = await fetchWithTimeout(config.aiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.aiApiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.3
        })
      }, config.requestTimeoutSec);
      console.log(`[ShortScraping] AI 请求耗时: ${Math.round(performance.now() - startAt)}ms`);

      if (!response.ok) {
        console.warn('[ShortScraping] AI 请求失败:', response.status);
        return { title: '', desc: '' };
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim() || '';
      console.log(`[ShortScraping] AI 返回: ${content}`);

      // 解析 JSON 返回
      return parseAIResponse(content);

    } catch (e) {
      console.warn('[ShortScraping] AI 翻译失败:', e.message);
      return { title: '', desc: '' };
    }
  }

  /**
   * 带超时的 fetch，避免第三方接口长时间挂起导致按钮卡住。
   */
  async function fetchWithTimeout(url, options = {}, timeoutSec = 20) {
    const controller = new AbortController();
    const timeoutMs = Math.max(5, Number(timeoutSec) || 20) * 1000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}秒）`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 解析 AI 返回的 JSON
   */
  function parseAIResponse(content) {
    try {
      // 清理内容：移除控制字符和多余空白
      let jsonStr = content
        .replace(/[\x00-\x1F\x7F]/g, '') // 移除控制字符
        .trim();

      // 如果内容包含 markdown 代码块，提取 JSON
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      // 尝试找到 JSON 对象
      const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        jsonStr = objectMatch[0];
      }

      const result = JSON.parse(jsonStr);

      // 支持多种键名格式，并清理结果
      const title = cleanText(result['片名'] || result.title || result.Title || '');
      const desc = cleanText(result['简介'] || result.desc || result.description || result.Desc || '');

      return { title, desc };
    } catch (e) {
      console.warn('[ShortScraping] JSON 解析失败，尝试提取文本:', e.message);

      // 如果 JSON 解析失败，尝试从文本中提取
      const titleMatch = content.match(/["'](?:片名|title)["']\s*:\s*["']([^"']+)["']/i);
      const descMatch = content.match(/["'](?:简介|desc|description)["']\s*:\s*["']([^"']+)["']/i);

      return {
        title: titleMatch ? cleanText(titleMatch[1]) : '',
        desc: descMatch ? cleanText(descMatch[1]) : ''
      };
    }
  }

  /**
   * 清理文本：移除控制字符、HTML 实体等
   */
  function cleanText(text) {
    if (!text) return '';
    return text
      .replace(/[\x00-\x1F\x7F]/g, '') // 移除控制字符
      .replace(/&#x[0-9A-Fa-f]+;/g, '') // 移除 HTML 实体
      .replace(/&#[0-9]+;/g, '')         // 移除数字 HTML 实体
      .replace(/\r\n/g, '\n')            // 统一换行符
      .replace(/\r/g, '\n')              // 统一换行符
      .trim();
  }

  /**
   * 批量翻译（用于定时任务）
   */
  async function translateBatch(items, onProgress) {
    const config = await getConfig();
    const results = [];

    for (let i = 0; i < items.length; i += config.batchSize) {
      const batch = items.slice(i, i + config.batchSize);

      for (const item of batch) {
        try {
          const result = await translateTitleAndDesc(item.title, item.description);
          if (result.title || result.desc) {
            results.push({
              ...item,
              titleZh: result.title,
              descriptionZh: result.desc
            });
          }
        } catch (e) {
          console.warn(`[ShortScraping] 翻译失败: ${item.title}`, e);
        }
      }

      // 进度回调
      if (onProgress) {
        onProgress(Math.min(i + config.batchSize, items.length), items.length);
      }

      // 延迟
      if (i + config.batchSize < items.length) {
        await new Promise(r => setTimeout(r, config.delayMs));
      }
    }

    return results;
  }

  return {
    translate,
    translateTitleAndDesc,
    translateBatch,
    getConfig
  };
})();
