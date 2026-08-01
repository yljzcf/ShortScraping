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
    requestTimeoutSec: 15
  };

  // 站点显示名单一真源在 site-registry.js；导出契约 Lark.SOURCE_NAMES 保留（sync-server 消费）
  const SOURCE_NAMES = (typeof module !== 'undefined' && module.exports)
    ? require('./site-registry.js').SOURCE_NAMES
    : global.SiteRegistry.SOURCE_NAMES;

  function normalizeConfig(rawConfig) {
    const config = { ...DEFAULT_CONFIG, ...(rawConfig || {}) };
    const timeout = Number(config.requestTimeoutSec);

    return {
      webhookUrl: String(config.webhookUrl || '').trim(),
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
      url: asText(d.url),
      poster: posterForPayload(d.poster),
      scraped_at: asText(d.scrapedAt),
      pushed_at: new Date().toISOString()
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

  const api = {
    DEFAULT_CONFIG,
    SOURCE_NAMES,
    normalizeConfig,
    configReadiness,
    buildPayload,
    fetchWithTimeout,
    pushDrama
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.Lark = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
