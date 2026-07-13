/**
 * ShortScraping Translator Module
 * 封装翻译逻辑，支持 API 和 AI 两种模式
 */

globalThis.Translator = (() => {
  // 默认翻译 API
  const DEFAULT_API = 'https://api.mymemory.translated.net/get';

  // 批量翻译的输入/输出契约（由代码固定，拼在用户风格提示词之后）。
  // 对应关系的命根子：要求模型按输入 id 一一回填，绝不靠返回顺序。
  const BATCH_CONTRACT =
    '\n\n下面是一个 JSON 数组，每个元素形如 {"id":<编号>,"title":<英文片名>,"desc":<英文简介>}。' +
    '请逐条把片名和简介翻译为中文，并严格按输入的 id 一一对应，返回一个同样长度的 JSON 数组，' +
    '每个元素形如 {"id":<与输入相同的编号>,"片名":<中文片名>,"简介":<中文简介>}。' +
    '务必覆盖输入中的每一个 id，不得遗漏、增加、合并或改变 id；只输出该 JSON 数组本身，不要任何解释或代码块标记。' +
    '\n\n需要翻译的内容：\n';

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
      aiPrefixPrompt: rawConfig.aiPrefixPrompt || '你是一位资深的影视爱好者，也观看过大量快节奏的短剧、短视频。请把片名和内容简介翻译为最有网感的中文表达。',
      batchSize: Number(rawConfig.batchSize) || 10,
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
      return pickTitleDesc(result);
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
   * 从 AI 返回对象里取片名/简介，兼容多种键名并清理。单条与批量解析共用。
   */
  function pickTitleDesc(obj) {
    if (!obj || typeof obj !== 'object') return { title: '', desc: '' };
    return {
      title: cleanText(obj['片名'] || obj.title || obj.Title || ''),
      desc: cleanText(obj['简介'] || obj.desc || obj.description || obj.Desc || '')
    };
  }

  /**
   * 批量翻译（AI 模式，一次请求译多条）。
   * items: [{title, desc}]；返回「等长、同序」的 [{title, desc}]，失败/缺失填空串。
   * 对应关系靠批内 id：请求带 id、解析按 id 回填，绝不依赖返回顺序。
   * 调用方负责分批（每批条数/字符预算），本函数只把收到的这一批用一次请求译出来。
   * 非 AI 模式退化为逐条 translateTitleAndDesc，保证调用方总能拿到对齐结果。
   */
  async function translateBatchAI(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return [];

    const config = await getConfig();

    if (config.mode !== 'ai') {
      const results = [];
      for (const it of list) {
        try {
          results.push(await translateTitleAndDesc(it.title, it.desc));
        } catch (e) {
          results.push({ title: '', desc: '' });
        }
      }
      return results;
    }

    if (!config.aiEndpoint || !config.aiApiKey) {
      console.warn('[ShortScraping] AI 翻译未配置端点或密钥');
      return list.map(() => ({ title: '', desc: '' }));
    }

    try {
      // 批内 id 从 1 开始；调用方按下标 i 取 results[i]，本函数按 id=i+1 回填
      const payload = list.map((it, i) => ({ id: i + 1, title: it.title || '', desc: it.desc || '' }));
      const userMessage = `${config.aiPrefixPrompt}${BATCH_CONTRACT}${JSON.stringify(payload)}`;
      const messages = [{ role: 'user', content: userMessage }];
      const model = config.aiModel || 'gpt-3.5-turbo';

      console.log(`[ShortScraping] 批量翻译 ${list.length} 条，模型: ${model}`);
      const startAt = performance.now();
      const response = await fetchWithTimeout(config.aiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.aiApiKey}`
        },
        body: JSON.stringify({ model, messages, temperature: 0.3 })
      }, config.requestTimeoutSec);
      console.log(`[ShortScraping] 批量 AI 请求耗时: ${Math.round(performance.now() - startAt)}ms`);

      if (!response.ok) {
        console.warn('[ShortScraping] 批量 AI 请求失败:', response.status);
        return list.map(() => ({ title: '', desc: '' }));
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim() || '';
      const byId = parseAIBatchResponse(content);

      // 按 id 回填；缺失 id 的条目留空串，调用方据此保留 status:'new' 下轮重试
      return list.map((_, i) => byId.get(i + 1) || { title: '', desc: '' });
    } catch (e) {
      console.warn('[ShortScraping] 批量 AI 翻译失败:', e.message);
      return list.map(() => ({ title: '', desc: '' }));
    }
  }

  /**
   * 解析 AI 批量返回的 JSON 数组，返回 Map<id, {title, desc}>。
   * 解析失败或非数组返回空 Map（整批留待下一轮重试）。
   */
  function parseAIBatchResponse(content) {
    const map = new Map();
    try {
      let jsonStr = content.replace(/[\x00-\x1F\x7F]/g, '').trim();

      const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced) jsonStr = fenced[1].trim();

      const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
      if (arrMatch) jsonStr = arrMatch[0];

      const arr = JSON.parse(jsonStr);
      if (!Array.isArray(arr)) return map;

      arr.forEach(item => {
        const id = Number(item && item.id);
        if (!Number.isInteger(id)) return;
        map.set(id, pickTitleDesc(item));
      });
    } catch (e) {
      console.warn('[ShortScraping] 批量 JSON 解析失败:', e.message);
    }
    return map;
  }

  return {
    translate,
    translateTitleAndDesc,
    translateBatchAI,
    getConfig
  };
})();
