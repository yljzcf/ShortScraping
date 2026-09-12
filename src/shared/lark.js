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
    // 飞书开放平台自建应用凭据，**只用于上传封面拿 img_key，不是第二条推送通道**。
    // 推送目标由上面的 botWebhookUrl 决定（本项目用户填的是 Lark 国际版群机器人）：
    // img_key 跨云可用——飞书租户上传的图推到 Lark 群里能正常渲染（2026-09-12 实测）。
    // 两个字段即开关：都填才带图，缺一就发无图卡。
    feishuAppId: '',
    feishuAppSecret: '',
    requestTimeoutSec: 15
  };

  const FEISHU_TOKEN_API = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
  const FEISHU_IMAGE_API = 'https://open.feishu.cn/open-apis/im/v1/images';

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
      feishuAppId: String(config.feishuAppId || '').trim(),
      feishuAppSecret: String(config.feishuAppSecret || '').trim(),
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

  // 图床就绪闸门：两个凭据都填才带封面图。刻意不另设勾选框——botEnabled 已是推送总开关，
  // 再加一个会让「关的是图还是推送」变模糊；字段本身即开关。
  function imageReadiness(rawConfig) {
    const config = normalizeConfig(rawConfig);
    const missing = [];
    if (!config.feishuAppId) missing.push('feishuAppId');
    if (!config.feishuAppSecret) missing.push('feishuAppSecret');
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
   * **图片只能经 img_key 进卡，URL 进不去**：2026-09-12 实测拿外链 URL 当 img_key
   * 会被整条拒收——`ErrCode: 11310; the card contains images but no imagekey is
   * passed in`。当晚翻案了一半：11310 的语义是「你没给真 img_key」而不是「机器人
   * 不许放图」，用自建应用上传拿到的 img_key 塞进来能正常渲染，且**跨云可用**
   * （飞书租户上传 → Lark 国际版群里照样显示）。故 buildBotCard 接受可选 imgKey：
   * 拿到了就带图（版式 V1：图在最上、满宽原样，不裁不缩——2026-09-12 用户三选一后定），
   * 拿不到就照旧发无图卡。unit-lark-bot C8/I 组守着。
   */
  const BOT_SUMMARY_LIMIT = 240;

  function clipText(value, limit) {
    const text = asText(value).replace(/\s+/g, ' ');
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  function buildBotCard(drama, options) {
    const d = drama || {};
    const imgKey = asText(options && options.imgKey);
    const title = asText(d.title);
    const titleZh = asText(d.titleZh);
    const tags = (Array.isArray(d.tags) ? d.tags : []).map(asText).filter(Boolean);
    const genres = (Array.isArray(d.genres) ? d.genres : []).map(asText).filter(Boolean);
    // 只出一段简介，中文优先（2026-09-12 用户定：去掉原先那段斜体英文原文）。
    // 中文缺失时回退英文而不是留空——机器人只在翻译完成后才推，理论上都有中文，
    // 但半成品收口（MAX_PARTIAL_TRANSLATE_ATTEMPTS 用尽）的卡可能没有，不能给张空卡。
    const summary = asText(d.descriptionZh) ? clipText(d.descriptionZh, BOT_SUMMARY_LIMIT)
      : clipText(d.description, BOT_SUMMARY_LIMIT);
    const url = asText(d.url);

    // 标题栏＝中文译名（英文原名）；缺哪边就只留另一边
    const heading = titleZh && title ? `${titleZh}（${title}）` : (titleZh || title || '（无标题）');

    const elements = [];
    // 封面真图排最前、满宽原样（不给 size/scale_type——那会把竖版海报裁掉大半）
    if (imgKey) elements.push({ tag: 'img', img_key: imgKey, alt: { tag: 'plain_text', content: '封面' } });
    if (summary) elements.push({ tag: 'markdown', content: summary });

    // 来源与类别合成一块：独立元素天然与上文隔开一行，两行本身要贴在一起
    // （tags 自带平台名，不再另外拼 SOURCE_NAMES，否则「NetShort · NetShort」重复）
    // 闭合的 ** 后面**必须留一个空格**：v2 的 markdown 走严格 CommonMark，而
    // `**来源：**RoyalRoad` 里闭合 ** 前是标点「：」、后面紧跟字母，右侧界定符
    // 判定不通过 → 不当作加粗结束 → 星号原样漏在卡片上（v1 的 lark_md 是飞书
    // 自家宽松解析器，同样写法没问题，切 v2 后才暴露）。unit-lark-bot C6f 守着。
    const meta = [];
    if (tags.length) meta.push(`**来源：** ${tags.join(' / ')}`);
    if (genres.length) meta.push(`**类别：** ${genres.join(' / ')}`);
    if (meta.length) elements.push({ tag: 'markdown', content: meta.join('\n') });

    // 按钮靠右只有这一种走法（2026-09-12 逐个实测）：v1 的 column 不收 action
    // （`action components are not allowed in the column`）、v2 的 button 不认
    // `horizontal_align`（`unknown property`），只有 **v2 的 column_set 带
    // horizontal_align:'right'、里面直接放 button** 被接受。别再试别的。
    if (/^https?:\/\//i.test(url)) {
      elements.push({
        tag: 'column_set',
        horizontal_align: 'right',
        flex_mode: 'none',
        columns: [{
          tag: 'column',
          width: 'auto',
          vertical_align: 'top',
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '去瞅瞅' },
            behaviors: [{ type: 'open_url', default_url: url }],
            type: 'primary'
          }]
        }]
      });
    }

    return {
      msg_type: 'interactive',
      card: {
        // schema 2.0 是当前最新（实测 2.1 / 3.0 均回 `unknown schema`）。
        // 切它唯一的理由就是上面那个靠右按钮——v1 做不到。结构随之全变：
        // 顶层 elements → body.elements、div+text.lark_md → markdown、
        // action+actions[] → 直接 button + behaviors。
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { template: 'blue', title: { tag: 'plain_text', content: heading } },
        body: { elements }
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

  /* ——— 封面图上传（飞书自建应用当图床） —————————————————————————
   * 卡片里的图必须是 img_key，只能经开放平台上传接口拿。本层把「拉封面 → 上传」
   * 封装成一个**绝不抛异常**的函数：任何一步失败都返回 null，调用方降级发无图卡。
   * 推送本身比封面重要得多，图挂了不能把整条推送带走。
   *
   * token 缓存刻意只放模块内存、不落 chrome.storage：本文件至今零 chrome API
   * 依赖（纯函数 + fetch 两层，四端共用），为省一次约 200ms 的请求去破这个边界
   * 不划算；SW 重启后重取一次即可，token 接口限额宽松。
   */
  let tokenCache = null;   // { appId, token, expiresAt }

  function __resetTokenCache() {
    tokenCache = null;
  }

  async function readJsonBody(response) {
    const text = await response.text().catch(() => '');
    try {
      return text ? JSON.parse(text) : null;
    } catch (e) {
      return null;   // 非 JSON 响应交给调用方按 HTTP 状态判定
    }
  }

  async function getTenantAccessToken(config) {
    const now = Date.now();
    if (tokenCache && tokenCache.appId === config.feishuAppId && tokenCache.expiresAt > now) {
      return tokenCache.token;
    }

    const response = await fetchWithTimeout(FEISHU_TOKEN_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.feishuAppId, app_secret: config.feishuAppSecret })
    }, config.requestTimeoutSec);

    const body = await readJsonBody(response);
    if (!response.ok || extractErrorDetail(body) || !body || !body.tenant_access_token) return null;

    // 提前 5 分钟过期，避免卡在边界上拿到刚失效的 token
    const ttl = Math.max(60, Number(body.expire) || 7200) - 300;
    tokenCache = { appId: config.feishuAppId, token: body.tenant_access_token, expiresAt: now + ttl * 1000 };
    return tokenCache.token;
  }

  /**
   * 拉封面并上传到飞书，返回 image_key；任一步失败返回 null（不抛）。
   * 封面取 drama.poster **原值**（榜单页缩略图，56KB 级），不走 posterForPayload
   * ——那个是为多维表格「链接转附件」放大到 1.5MB 的形态，卡片显示用不着。
   */
  async function uploadCoverImage(rawConfig, posterUrl) {
    const config = normalizeConfig(rawConfig);
    if (!imageReadiness(config).ok) return null;
    if (!/^https?:\/\//i.test(asText(posterUrl))) return null;

    try {
      const token = await getTenantAccessToken(config);
      if (!token) return null;

      const imageResponse = await fetchWithTimeout(posterUrl, {}, config.requestTimeoutSec);
      if (!imageResponse.ok) return null;

      const form = new FormData();
      form.append('image_type', 'message');
      form.append('image', await imageResponse.blob(), 'cover.jpg');

      // 不手动设 Content-Type：multipart 的 boundary 要由 fetch 自己生成
      const response = await fetchWithTimeout(FEISHU_IMAGE_API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      }, config.requestTimeoutSec);

      const body = await readJsonBody(response);
      if (!response.ok || extractErrorDetail(body)) return null;
      return (body && body.data && body.data.image_key) || null;
    } catch (e) {
      return null;   // 网络异常/超时同样降级，不向上抛
    }
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

    // 封面上传对调用方不可见：拿到 img_key 就带图，拿不到就发无图卡
    const imgKey = await uploadCoverImage(config, drama && drama.poster);

    const response = await fetchWithTimeout(config.botWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBotCard(drama, { imgKey }))
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
    imageReadiness,
    posterForPayload,
    buildPayload,
    buildBotCard,
    uploadCoverImage,
    pushBotCard,
    __resetTokenCache,
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
