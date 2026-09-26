/**
 * ShortScraping Translator Module
 * 封装翻译逻辑，支持 API 和 AI 两种模式
 *
 * 只在后台 service worker 里运行（background.js importScripts）：弹窗关掉页面即销毁、
 * 页内 fetch 随之中断，所以单卡 🌍 也经 translateSingle 消息走后台。外壳按 lark.js 的
 * UMD 写法，Node 里也能 require，便于测试直接加载真实模块。
 *
 * 配置由调用方注入（各函数的尾参 config，后台 readTranslateConfig 读取），本模块不碰任何
 * 扩展 API：此前每次调用各读一次 storage，一轮翻译按开头快照选定 AI / API 模式后，
 * 中途改配置会让 translateBatchAI 落进它自己的非 AI 分支，与后台这一轮的分支对不上；
 * 回调形式的 storage.get 还让测试桩得专门垫一层。放尾部是为了不动位置参数——替换
 * Translator 的测试桩都按 (title, desc) / (items) 取参。
 */
(function (global) {
  'use strict';

  // 配置归一化（默认值、旧 mode 字段兼容、数值兜底）的单一真源是 translate-config.js，
  // 后台 importScripts 已把它排在本模块之前
  const TranslateConfig = (typeof module !== 'undefined' && module.exports)
    ? require('./translate-config.js')
    : global.TranslateConfig;

  // 批量翻译的输入/输出契约（由代码固定，拼在用户风格提示词之后）。
  // 对应关系的命根子：要求模型按输入 id 一一回填，绝不靠返回顺序。
  const BATCH_CONTRACT =
    '\n\n下面是一个 JSON 数组，每个元素形如 {"id":<编号>,"title":<英文片名>,"desc":<英文简介>}。' +
    '请逐条把片名和简介翻译为中文，并严格按输入的 id 一一对应，返回一个同样长度的 JSON 数组，' +
    '每个元素形如 {"id":<与输入相同的编号>,"片名":<中文片名>,"简介":<中文简介>}。' +
    '务必覆盖输入中的每一个 id，不得遗漏、增加、合并或改变 id；只输出该 JSON 数组本身，不要任何解释或代码块标记。' +
    '\n\n需要翻译的内容：\n';

  /**
   * 归一化调用方注入的配置。缺参直接抛错而不是落回默认值：默认是 API 模式（MyMemory），
   * 漏传会把片名悄悄发给用户没选的第三方接口，比报错更糟。normalizeConfig 幂等，
   * 后台已归一化过的配置再过一遍不变。
   */
  function resolveConfig(rawConfig) {
    if (!rawConfig || typeof rawConfig !== 'object') {
      throw new TypeError('Translator 缺少翻译配置参数（由后台 readTranslateConfig 读取后传入）');
    }
    return TranslateConfig.normalizeConfig(rawConfig);
  }

  /**
   * 翻译标题和简介（AI 模式，带前置提示词）
   */
  async function translateTitleAndDesc(title, description, rawConfig) {
    const config = resolveConfig(rawConfig);
    console.log(`[ShortScraping] 翻译模式: ${config.translateMode}`);

    if (config.translateMode === 'ai') {
      return await translateWithAI(title, description, config);
    } else {
      // API 模式分别翻译。某个字段的请求在传输层失败时该字段仍回空串（调用方契约不变），
      // 另把原因带在 transportError 上：后台翻译线据此把「接口故障」（不计重试次数，接口
      // 恢复后照常翻）与「服务答了但没给出译文」（如片名「1923」译文与原文相同被滤掉，
      // 计次数、达上限收口）分开——两者此前都是空串，分不出来
      let transportError = '';
      const translateField = async (text) => {
        try {
          return await translateWithAPI(text, config);
        } catch (e) {
          console.warn('[ShortScraping] API 翻译失败:', e.message);
          transportError = transportError || e.message;
          return '';
        }
      };
      const titleZh = await translateField(title);
      const descZh = description ? await translateField(description) : '';
      return transportError
        ? { title: titleZh, desc: descZh, transportError }
        : { title: titleZh, desc: descZh };
    }
  }

  /**
   * API 模式翻译（MyMemory 等免费 API）。
   * 错误语义：传输层失败（超时 / 网络 / HTTP 非 200 / 响应非 JSON / responseStatus 非 200
   * 或额度告警）抛异常；服务正常应答但没有可用译文（缺字段、译文与原文相同）返回空串。
   */
  async function translateWithAPI(text, config, targetLang = 'zh-CN') {
    // 用 URL/searchParams 拼参数：endpoint 可能自带查询串（MyMemory 文档建议加 de=邮箱提高免费
    // 额度），旧写法 `${endpoint}?q=…` 会拼出第二个 '?'，q 被吞进 de 的值里，所有翻译都失败。
    // endpoint 不是合法 URL 时 new URL 抛错，与 fetch 抛错同样归为传输层失败
    const url = new URL(config.apiEndpoint);
    url.searchParams.set('q', text);
    url.searchParams.set('langpair', `en|${targetLang}`);
    const response = await fetchWithTimeout(url.toString(), {}, config.requestTimeoutSec);

    if (!response.ok) throw new Error(`翻译接口 HTTP ${response.status}`);

    const data = await response.json().catch(() => {
      throw new Error('翻译接口响应不是合法 JSON');
    });
    const translated = data.responseData?.translatedText || '';

    // MyMemory 额度用尽、参数不合法时仍回 HTTP 200，错误落在 responseStatus（可能是字符串）
    // 或直接把 MYMEMORY WARNING 告警塞进译文字段：都算接口故障，不是这条内容的问题
    if (Number(data.responseStatus) !== 200 || translated.includes('MYMEMORY')) {
      throw new Error(`翻译接口返回 ${data.responseStatus}${data.responseDetails ? `：${data.responseDetails}` : ''}`);
    }

    // 过滤无效翻译（与原文相同）
    return translated && translated !== text ? translated : '';
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

      const model = config.aiModel;
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
  async function fetchWithTimeout(url, options = {}, timeoutSec = 10) {
    const controller = new AbortController();
    const timeoutMs = Math.max(5, Number(timeoutSec) || 10) * 1000;
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
   * items: [{title, desc}]；返回「等长、同序」的 [{title, desc}]，缺失填空串。
   * 对应关系靠批内 id：请求带 id、解析按 id 回填，绝不依赖返回顺序。
   * 调用方负责分批（每批条数/字符预算），本函数只把收到的这一批用一次请求译出来。
   * 非 AI 模式退化为逐条 translateTitleAndDesc，保证调用方总能拿到对齐结果。
   * config：调用方注入的翻译配置（同 translateTitleAndDesc 的尾参）。
   *
   * 错误语义：传输层失败（未配置端点密钥 / 超时 / HTTP 非 200 / 响应非 JSON / 缺 choices）
   * 抛异常，调用方据此向用户报告失败原因（HTTP 非 200 带 error.status）；模型返回内容
   * 解析不出（格式跑偏）仍返回空串数组，由后台翻译线按「应答了却没给出译文」处理。
   */
  async function translateBatchAI(items, rawConfig) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return [];

    const config = resolveConfig(rawConfig);

    if (config.translateMode !== 'ai') {
      const results = [];
      for (const it of list) {
        try {
          // 同一份配置传下去：逐条调用不再各自重读，整批只按一种模式翻
          results.push(await translateTitleAndDesc(it.title, it.desc, config));
        } catch (e) {
          results.push({ title: '', desc: '' });
        }
      }
      return results;
    }

    if (!config.aiEndpoint || !config.aiApiKey) {
      throw new Error('AI 翻译未配置端点或密钥');
    }

    // 批内 id 从 1 开始；调用方按下标 i 取 results[i]，本函数按 id=i+1 回填
    const payload = list.map((it, i) => ({ id: i + 1, title: it.title || '', desc: it.desc || '' }));
    const userMessage = `${config.aiPrefixPrompt}${BATCH_CONTRACT}${JSON.stringify(payload)}`;
    const messages = [{ role: 'user', content: userMessage }];
    const model = config.aiModel;

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
      // 带上状态码：后台翻译线据此区分「这批内容被拒收」（400 内容审核 / 413 超长 / 422，
      // 拆单条重试可隔离毒条目）与「通道故障」（鉴权 / 额度 / 限流 / 5xx，不计重试次数）
      const error = new Error(`AI 接口 HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json().catch(() => {
      throw new Error('AI 接口响应不是合法 JSON');
    });
    // 有的中转服务出错时仍回 HTTP 200、正文是 {"error":…}：没有 choices 就不是模型的应答，
    // 按传输层失败处理（后台不计重试次数），否则会被当成「模型答了但没给译文」计次收口
    if (!Array.isArray(data?.choices)) {
      throw new Error(`AI 接口响应缺少 choices${data?.error?.message ? `：${data.error.message}` : ''}`);
    }
    const content = data.choices[0]?.message?.content?.trim() || '';
    const byId = parseAIBatchResponse(content);

    // 按 id 回填；缺失 id 的条目留空串，后台翻译线按「应答了却没给出这条的译文」处理（计次、达上限收口）
    return list.map((_, i) => byId.get(i + 1) || { title: '', desc: '' });
  }

  /**
   * 解析 AI 批量返回的 JSON 数组，返回 Map<id, {title, desc}>。
   * 解析失败或非数组返回空 Map（整批按「应答了却没给出译文」处理，后台同轮拆单条重试，见 translateBatchAI）。
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

  // 只导出实际有调用方的方法（后台单卡 🌍 / 批量与逐条翻译）
  const api = {
    translateTitleAndDesc,
    translateBatchAI
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.Translator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
