/**
 * 带期限的 fetch（后台 SW / 设置页 / Node 共用，v1.7.0 审查 H1）。
 *
 * 期限**连正文一起算**。translator.js / lark.js 原先各写一份 fetchWithTimeout，fetch() 一交出响应头
 * 就 clearTimeout，之后的 response.json() / blob() 没有期限：DeepSeek 这类接口高负载时先回 200 头、
 * 再迟迟不发正文，翻译轮开着 SW 保活（background.js startSwKeepAlive），一批卡住整轮就永久挂住——
 * 弹窗一直「翻译中」、CSV 推送一直被忙碌节流，直到重载扩展。设置页写回配置的 trySyncConfig 干脆没有期限，
 * 服务接了连接却不应答时「保存」一直转。
 *
 * 做法与 content.js fetchWithTimeout 同一套（内容脚本那份早就是对的）：期限内把正文读成 ArrayBuffer，
 * 再让返回的 response 的 text()/json()/blob()/arrayBuffer() 交出这份缓存，调用方原有写法
 * （ok/status/headers + text()/json()/blob()）一行不用改。期限用 Promise.race 兜底，底层即使不理会
 * abort 信号也按时返回。
 *
 * 错误口径：
 *   - 到点（响应头没来或正文没读完）：abort 底层请求，以 TimeoutError 拒绝，message 用调用方给的
 *     timeoutMessage（各调用点沿用原文案）；
 *   - 响应头之前的网络错误：原样抛出，不包装；
 *   - 正文读到一半出错（非超时）：本函数不抛，留到调用方调 text()/json()/blob() 时再抛——各调用点
 *     现有的 .catch（lark 的 text().catch(() => '')、translator 的「响应不是合法 JSON」）照旧生效；
 *   - 既没有 arrayBuffer 也没有 text 的对象（只实现 json()/blob() 的测试桩）原样交回、不预读。
 * 调用方自带 init.signal 时两路联动：外部先 abort 就按外部给的原因拒绝。
 *
 * 内容脚本不加载本模块：它的 fetchWithTimeout 语义相同，迁过来要改 manifest content_scripts 与后台强制
 * 注入清单、连带一串守卫测试，只为省二十几行，不划算（见 content.js 该函数注释）。
 * 加载方式：后台 importScripts（须先于 translator.js / lark.js）/ 设置页 <script>（先于 lark.js）/
 * Node require（module.exports）。本模块不碰任何扩展 API。
 */
(function (global) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 25000;

  function timeoutError(message) {
    const error = new Error(message);
    error.name = 'TimeoutError';
    return error;
  }

  /**
   * 把期限内读好的正文挂回 response。body 为 { buffer } 或 { text }；failure 为正文读取时的异常，
   * 留到调用方真正取正文时再抛。text 按 UTF-8 解码并去 BOM，与 Response.text() 一致。
   */
  function attachBody(response, { buffer = null, text = null, failure = null }) {
    let decoded = text;
    const readText = () => {
      if (failure) throw failure;
      if (decoded === null) decoded = new TextDecoder('utf-8').decode(buffer);
      return decoded;
    };
    response.text = async () => readText();
    response.json = async () => JSON.parse(readText());
    if (buffer !== null || failure) {
      response.arrayBuffer = async () => {
        if (failure) throw failure;
        return buffer.slice(0);
      };
      response.blob = async () => {
        if (failure) throw failure;
        const type = (response.headers && typeof response.headers.get === 'function' && response.headers.get('content-type')) || '';
        return new Blob([buffer], { type });
      };
    }
    return response;
  }

  async function preReadBody(response) {
    if (!response || typeof response !== 'object') return response;
    if (typeof response.arrayBuffer === 'function') {
      try {
        return attachBody(response, { buffer: await response.arrayBuffer() });
      } catch (e) {
        return attachBody(response, { failure: e });
      }
    }
    if (typeof response.text === 'function') {
      try {
        return attachBody(response, { text: String(await response.text()) });
      } catch (e) {
        return attachBody(response, { failure: e });
      }
    }
    return response;
  }

  /**
   * @param {string} url
   * @param {RequestInit} init  原样传给 fetch；带 signal 时与期限联动
   * @param {{ timeoutMs?: number, timeoutMessage?: string }} options
   * @returns {Promise<Response>} 正文已在期限内读完的 response
   */
  async function fetchWithDeadline(url, init = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, timeoutMessage } = {}) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    const message = timeoutMessage || `请求超时（${Math.round(ms / 1000)} 秒内未读完响应）`;
    const external = init && init.signal;
    const controller = new AbortController();
    let timer = null;
    let onExternalAbort = null;

    const stopped = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = timeoutError(message);
        reject(error);
        controller.abort(error);
      }, ms);
      if (external) {
        onExternalAbort = () => {
          reject(external.reason);
          controller.abort(external.reason);
        };
        if (external.aborted) onExternalAbort();
        else external.addEventListener('abort', onExternalAbort, { once: true });
      }
    });

    const request = (async () => {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return preReadBody(response);
    })();

    try {
      return await Promise.race([request, stopped]);
    } finally {
      clearTimeout(timer);
      if (external && onExternalAbort) external.removeEventListener('abort', onExternalAbort);
    }
  }

  const api = { fetchWithDeadline };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.FetchUtil = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
