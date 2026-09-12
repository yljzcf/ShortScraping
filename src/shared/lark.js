/**
 * ShortScraping Lark（飞书）推送模块
 *
 * 路径：多维表格工作流「接收到 webhook 时」触发器——扩展把卡片数据组装成
 * 扁平 JSON POST 到用户配置的 webhook 地址；「新增记录」「发送群消息」与
 * 消息模板全部在飞书侧工作流里配置，扩展零凭据、不感知后续动作。
 * 封面在此路径下只能以链接形式传递（外链图变飞书内真图需开放平台应用
 * 凭据上传，平台限制；将来若切自建应用路径，只需替换本文件效果层）。
 *
 * 分层纪律：
 * - 纯函数层（DEFAULT_CONFIG / normalizeConfig / configReadiness / buildPayload）
 *   三端可用：后台 importScripts / 设置页 <script> 标签 / 同步服务 require；
 * - 效果层（pushDrama 等带 fetch 的函数）只允许在后台 service worker 调用：
 *   弹窗关闭后请求仍需完成，且设置页「发送测试」也走后台消息，测试路径=真实路径。
 *
 * payload 键集合必须稳定（空值发空串、绝不省略键）：飞书触发器按首次收到的
 * 样例捕获参数结构，键忽隐忽现会导致工作流引用不到参数。
 */
(function (global) {
  'use strict';

  const DEFAULT_CONFIG = {
    webhookUrl: '',
    // 群机器人（自定义机器人 webhook）：与上面的多维表格工作流触发器是两条独立
    // 通道。机器人免费、无每月运行次数额度（只有频率限流），用于「有新内容实时
    // 知道」；工作流那条按「1 条记录＝1 次运行」计费，用于把数据写进表。
    botWebhookUrl: '',
    botEnabled: false,
    requestTimeoutSec: 15
  };

  // 站点显示名单一真源在 site-registry.js；导出契约 Lark.SOURCE_NAMES 保留（sync-server 消费）
  const SOURCE_NAMES = (typeof module !== 'undefined' && module.exports)
    ? require('./site-registry.js').SOURCE_NAMES
    : global.SiteRegistry.SOURCE_NAMES;

  // 列序/字段白名单同样不另立真源，取自 timeline-csv.js（后台 importScripts 与
  // 设置页 <script> 都已把它排在本模块之前）
  const TimelineCsv = (typeof module !== 'undefined' && module.exports)
    ? require('./timeline-csv.js')
    : global.TimelineCsv;

  function normalizeConfig(rawConfig) {
    const config = { ...DEFAULT_CONFIG, ...(rawConfig || {}) };
    const timeout = Number(config.requestTimeoutSec);

    return {
      webhookUrl: String(config.webhookUrl || '').trim(),
      botWebhookUrl: String(config.botWebhookUrl || '').trim(),
      botEnabled: Boolean(config.botEnabled),
      requestTimeoutSec: Number.isInteger(timeout) && timeout > 0 ? timeout : DEFAULT_CONFIG.requestTimeoutSec
    };
  }

  // 推送就绪闸门：webhook 地址必须是 http(s)。后台推送与设置页测试共用。
  function configReadiness(rawConfig) {
    const config = normalizeConfig(rawConfig);
    if (!/^https?:\/\//i.test(config.webhookUrl)) {
      return { ok: false, missing: ['webhookUrl'] };
    }
    return { ok: true, missing: [] };
  }

  // 机器人就绪闸门：地址合法 **且** 开关打开（自动推送要能一键停，不能只靠清地址）
  function botReadiness(rawConfig) {
    const config = normalizeConfig(rawConfig);
    const missing = [];
    if (!/^https?:\/\//i.test(config.botWebhookUrl)) missing.push('botWebhookUrl');
    if (!config.botEnabled) missing.push('botEnabled');
    return { ok: missing.length === 0, missing };
  }

  function asText(value) {
    if (typeof value === 'string') return value.trim();
    return value === null || value === undefined ? '' : String(value).trim();
  }

  /**
   * payload 专用封面形态适配（不改扩展内部数据/CSV/弹窗展示）：
   * 采集存的是榜单页自用的缩略图 URL（弹窗小卡片够用且省流量），推送时按站点
   * 改写成原图形态（2026-07-25 逐站实测）：
   * - dramashorts：_next/image 优化端点（?url=https%3A%2F%2F…）→ 原始 CDN 直链
   *   （官方捷径也解析不了其百分号编码查询串；原图约 1.5MB vs 优化图 72KB）；
   * - IMDB：去掉 _V1_ 变换链（90×133 缩略 ~4KB → 原图 ~290KB）。变换段含英文
   *   逗号（CR5,0,90,133）——正是捷径解析不了的字符；去掉后附件可正常转换。
   *   （@ 实测无害：新旧形态都含 @、仅逗号有无之差；先前「@ 是死结」为实验
   *   混淆——%40 试验行同时含逗号。真正致死字符＝英文逗号/百分号编码。）
   * - MyDrama：convert 端点去掉 width/height 尺寸参数（189×283 ~7KB → 原尺寸 ~64KB）。
   * 保持现状的站点：Steam（新游仅有带哈希路径，无哈希大图候选 404 不可安全改写；
   * header 460×215 为标准图）、RoyalRoad（covers-large 已比 covers-full 大）、
   * ReelShort（现状已是原图级 ~116KB）、NetShort（651×868 中等尺寸，tplv 模板不可去）。
   */
  function posterForPayload(poster) {
    const raw = asText(poster);
    if (/^https:\/\/dramashorts\.io\/_next\/image\?/i.test(raw)) {
      try {
        const inner = new URL(raw).searchParams.get('url') || '';
        if (/^https?:\/\//i.test(inner)) return inner;
      } catch (e) {
        // 解析失败原样透传
      }
      return raw;
    }
    if (/^https:\/\/m\.media-amazon\.com\//i.test(raw)) {
      return raw.replace(/\._V1_[^.]*\./, '._V1_.');
    }
    if (/^https:\/\/static\.my-drama\.com\/convert\//i.test(raw)) {
      try {
        const u = new URL(raw);
        u.searchParams.delete('width');
        u.searchParams.delete('height');
        // 路径段里的 %20 / %3A 换成捷径能解析的等价字符：该 CDN 对
        // `%20`↔`+`、`%3A`↔`:` 两种形态返回同一字节（2026-09-12 逐例 curl 实测
        // 200 且 size 完全一致）。%20 只能换 `+` 不能解成裸空格——裸空格的 URL
        // 直接失效。只改 pathname，不动查询串。
        u.pathname = u.pathname.replace(/%20/gi, '+').replace(/%3A/gi, ':');
        return u.toString();
      } catch (e) {
        // 解析失败原样透传
      }
    }
    return raw;
  }

  /**
   * 组装 webhook payload：扁平 JSON、全字符串值（工作流参数映射最稳）。
   * title_display / summary 是刻意的冗余列——工作流字段映射只能整参数引用，
   * 预拼好让用户免配公式。
   */
  function buildPayload(drama) {
    const d = drama || {};
    const title = asText(d.title);
    const titleZh = asText(d.titleZh);
    const description = asText(d.description);
    const descriptionZh = asText(d.descriptionZh);
    const tags = (Array.isArray(d.tags) ? d.tags : []).map(asText).filter(Boolean);
    const genres = (Array.isArray(d.genres) ? d.genres : []).map(asText).filter(Boolean);

    return {
      // 全站点统一条目 ID（值＝内部去重字段 itemId，与 CSV 的 itemId 列一致）：IMDB=tt…、
      // Steam=appId、RoyalRoad=rr…、MyDrama=md…、ReelShort=rs…、DramaShorts=ds…、NetShort=ns…
      item_id: asText(d.itemId),
      title,
      title_zh: titleZh,
      title_display: titleZh ? `${titleZh}（${title}）` : title,
      description,
      description_zh: descriptionZh,
      summary: descriptionZh || description,
      source: asText(d.source),
      source_name: SOURCE_NAMES[d.source] || asText(d.source),
      tags: tags.join(','),
      // 站点原生内容类型标签（英文原值，v1.5.3 第 15 键；已在用的工作流需重发
      // 测试样例让触发器重新捕获才能引用，不重捕获则照常运行只是用不了此参数）
      genres: genres.join(','),
      url: asText(d.url),
      poster: posterForPayload(d.poster),
      scraped_at: asText(d.scrapedAt),
      pushed_at: new Date().toISOString()
    };
  }

  /* ——— 多维表格导出投影层 ———————————————————————————————————————
   * webhook 触发器按「1 条记录＝1 次工作流运行」计费，存量 3453 条与每月约
   * 1400 条的增量都远超免费额度，故批量走「导出文件/剪贴板 → Base 导入或粘贴」。
   *
   * 与 TimelineCsv 的两处刻意分歧（勿「统一口径」改回去，unit-lark-table 守着）：
   * 1. poster 一律经 posterForPayload 改写——官方「链接转附件」捷径解析不了含
   *    英文逗号/百分号编码的 URL。2026-09-12 全量实测：不改写有 601 条转不出图，
   *    改写后只剩 5 条（1 条 netshort 与 1 条 mydrama 的逗号在 CDN 路径里、
   *    3 条 mydrama 标题带 %E2%80%99 右单引号），无解部分是站点数据本身的形态。
   * 2. 不加 CSV 公式前缀——Base 文本字段不执行公式，加前缀只会让以 - / + 开头的
   *    正常简介（全量实测 4 条）平白多出撇号。
   *
   * CSV 与 TSV 的单元格内容完全一致，只差传输形态与表头：
   * - CSV 给「导入」建表——表头即字段名，固定中文（2026-09-12 用户定）；
   * - TSV 给剪贴板粘贴追加——**不带表头**。Base 粘贴不会把首行认成字段名，
   *   带上只会在表末平白多出一行「id / itemId / title…」的垃圾记录。
   */
  const CSV_BOM = '﻿';
  const TABLE_COLUMNS = TimelineCsv.CSV_COLUMNS;
  // 与 TABLE_COLUMNS 同序一一对应；改列必须同步改这里（unit-lark-table T1b 守着）
  const TABLE_HEADERS = [
    '记录ID', '条目ID', '标题', '中文标题', '来源标签',
    '简介', '中文简介', '站点', '翻译状态',
    '条目链接', '订阅来源', '封面链接', '抓取时间', '翻译时间', '内容类型'
  ];

  /** 单元格归一：数组英文逗号连接（v1.5.13 由竖线改，与 payload 的 tags/genres 同口径）、
   *  制表符/换行折成空格（TSV 粘贴不错位的前提；CSV 侧靠引号包裹，逗号不拆列）。 */
  function tableCell(value) {
    const text = Array.isArray(value) ? value.join(',')
      : (value === null || value === undefined ? '' : String(value));
    return text.replace(/[\t\r\n]+/g, ' ');
  }

  /**
   * 条目数组 → 表格行数组（16 键，键序即 TABLE_COLUMNS）。
   * 先按 since/sources 过滤再去重：seen 只记真正产出的行，避免范围外的重复
   * 条目把范围内的同 itemId 条目挤掉。
   *
   * @param {object[]} dramas
   * @param {{since?: string, sources?: string[]}} [options] since 为 ISO 时间戳，
   *        取 `scrapedAt >= since`（含边界）；sources 为站点白名单，空/缺省＝全部。
   */
  function buildTableRows(dramas, options) {
    const opts = options || {};
    const since = asText(opts.since);
    const sources = Array.isArray(opts.sources) && opts.sources.length ? new Set(opts.sources) : null;
    const seen = new Set();
    const rows = [];

    for (const drama of dramas || []) {
      const normalized = TimelineCsv.normalizeDrama(drama);
      const key = normalized.itemId || normalized.id;
      if (!key) continue;
      if (sources && !sources.has(normalized.source)) continue;
      // 无 scrapedAt 的条目带 since 条件时保守排除（与按条件清理的日期谓词同向）
      if (since && !(normalized.scrapedAt && normalized.scrapedAt >= since)) continue;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({ ...normalized, poster: posterForPayload(normalized.poster) });
    }

    return rows;
  }

  /** 行数组 → 制表符分隔文本（剪贴板粘贴追加用：无表头、无 BOM、无引号包裹）。 */
  function toTsv(rows) {
    return (rows || [])
      .map(row => TABLE_COLUMNS.map(column => tableCell(row[column])).join('\t'))
      .join('\n');
  }

  /** 行数组 → CSV 文本（导入建表用：BOM + CRLF + 中文表头，与 TimelineCsv 同款引号转义）。 */
  function toCsv(rows) {
    const quote = (text) => `"${text.replace(/"/g, '""')}"`;
    const body = (rows || []).map(row => TABLE_COLUMNS
      .map(column => quote(tableCell(row[column]))).join(','));
    return CSV_BOM + [TABLE_HEADERS.map(quote).join(','), ...body].join('\r\n') + '\r\n';
  }

  /* ——— 群机器人卡片 ———————————————————————————————————————————
   * 自定义机器人 webhook 的消息体，与 Base 工作流那条的扁平 payload 完全不同形态。
   *
   * **绝不能放 img 元素**：飞书卡片的图片要 img_key，而 img_key 只能经开放平台
   * 上传接口获得、需自建应用凭据。2026-09-12 实测拿外链 URL 当 img_key 会被整条
   * 拒收——`ErrCode: 11310; the card contains images but no imagekey is passed in`。
   * 所以卡片只有标题/来源/类型/简介/跳转按钮，封面进不来（与 Base 表「封面只能
   * 是链接」同一个根因）。unit-lark-bot C8/C9 守着。
   */
  const BOT_SUMMARY_LIMIT = 160;

  function clipText(value, limit) {
    const text = asText(value).replace(/\s+/g, ' ');
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  function buildBotCard(drama) {
    const d = drama || {};
    const title = asText(d.title);
    const titleZh = asText(d.titleZh);
    const display = titleZh ? `${titleZh}（${title}）` : title;
    const sourceName = SOURCE_NAMES[d.source] || asText(d.source);
    const tags = (Array.isArray(d.tags) ? d.tags : []).map(asText).filter(Boolean);
    const genres = (Array.isArray(d.genres) ? d.genres : []).map(asText).filter(Boolean);
    const summary = asText(d.descriptionZh) || asText(d.description);
    const url = asText(d.url);

    const meta = [];
    if (sourceName || tags.length) {
      meta.push(`**来源**　${sourceName}${tags.length ? ` · ${tags.join(' / ')}` : ''}`);
    }
    if (genres.length) meta.push(`**类型**　${genres.join(' / ')}`);
    if (summary) meta.push(`**简介**　${clipText(summary, BOT_SUMMARY_LIMIT)}`);

    const elements = [{
      tag: 'div',
      text: { tag: 'lark_md', content: `**${display || '（无标题）'}**` }
    }];
    if (meta.length) elements.push({ tag: 'div', text: { tag: 'lark_md', content: meta.join('\n') } });
    if (/^https?:\/\//i.test(url)) {
      elements.push({
        tag: 'action',
        actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看原页' }, url, type: 'primary' }]
      });
    }

    return {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          template: 'blue',
          title: { tag: 'plain_text', content: `🎬 ${sourceName ? `${sourceName} ` : ''}新增` }
        },
        elements
      }
    };
  }

  /**
   * 带超时的 fetch（与 translator.js 同款 AbortController 模式；translator
   * 刻意只导出翻译方法，不改它）。
   */
  async function fetchWithTimeout(url, options = {}, timeoutSec = 15) {
    const controller = new AbortController();
    const timeoutMs = Math.max(5, Number(timeoutSec) || 15) * 1000;
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
   * 从飞书响应体中提取业务错误：带非 0 code/errcode 时返回错误详情，
   * 否则返回空串（视为成功）。额度用尽/触发器停用等由飞书侧返回，原样透传。
   */
  function extractErrorDetail(body) {
    if (!body || typeof body !== 'object') return '';
    const code = body.code !== undefined ? body.code : body.errcode;
    if (code === undefined || code === null || Number(code) === 0) return '';
    const msg = asText(body.msg || body.message || body.error) || '未知错误';
    return `[${code}] ${msg}`;
  }

  /**
   * 推送一条卡片到飞书工作流 webhook。成功返回 {success:true}；
   * 失败抛 Error（文案面向用户），未配置时错误对象带 notConfigured 标记。
   */
  async function pushDrama(rawConfig, drama) {
    const config = normalizeConfig(rawConfig);
    if (!configReadiness(config).ok) {
      const error = new Error('Lark 推送未配置 webhook 地址');
      error.notConfigured = true;
      throw error;
    }

    const response = await fetchWithTimeout(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(drama))
    }, config.requestTimeoutSec);

    const bodyText = await response.text().catch(() => '');
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch (e) {
      // 非 JSON 响应按 HTTP 状态判定
    }

    if (!response.ok) {
      const detail = extractErrorDetail(body) || asText(bodyText).slice(0, 120);
      throw new Error(`推送失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）`);
    }

    const detail = extractErrorDetail(body);
    if (detail) {
      throw new Error(`飞书工作流返回错误：${detail}`);
    }

    return { success: true };
  }

  /**
   * 推送一张卡片到群机器人。与 pushDrama 同为效果层、只允许在后台 SW 调用。
   * 成功返回 {success:true}；失败抛 Error（文案面向用户），未就绪时带
   * notConfigured 标记。机器人响应形如 {"StatusCode":0,"code":0,"msg":"success"}，
   * 业务错误照 extractErrorDetail 透传（如 11310 图片无 img_key、9499 频率限流）。
   */
  async function pushBotCard(rawConfig, drama) {
    const config = normalizeConfig(rawConfig);
    if (!botReadiness(config).ok) {
      const error = new Error('群机器人未配置或未启用');
      error.notConfigured = true;
      throw error;
    }

    const response = await fetchWithTimeout(config.botWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBotCard(drama))
    }, config.requestTimeoutSec);

    const bodyText = await response.text().catch(() => '');
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch (e) {
      // 非 JSON 响应按 HTTP 状态判定
    }

    if (!response.ok) {
      const detail = extractErrorDetail(body) || asText(bodyText).slice(0, 120);
      throw new Error(`群机器人推送失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）`);
    }

    const detail = extractErrorDetail(body);
    if (detail) throw new Error(`群机器人返回错误：${detail}`);

    return { success: true };
  }

  const api = {
    DEFAULT_CONFIG,
    SOURCE_NAMES,
    TABLE_COLUMNS,
    TABLE_HEADERS,
    normalizeConfig,
    configReadiness,
    botReadiness,
    posterForPayload,
    buildPayload,
    buildBotCard,
    pushBotCard,
    buildTableRows,
    toTsv,
    toCsv,
    fetchWithTimeout,
    pushDrama
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.Lark = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
