/**
 * 多维表格自动同步（v1.8.3）：把「已翻译、表里还没有」的条目追加进用户配置的飞书 / Lark 多维表格。
 *
 * 调用方是同步服务（server/sync-server.js）：每次扩展 POST /sync 后在后台跑一轮；设置页「测试连接」
 * 也经同步服务走同一套函数（只读不写），测试路径＝真实路径。
 *
 * 只追加、不更新、不删除：已进表的条目之后在库里变了（补了类型、改了译文）不回写；
 * 用户在表里手动删掉的行也不会被加回来（同步服务另记一份已写入的 uid）。
 *
 * 写法要点（Bitable OpenAPI v1）：
 * - 每列按表里的**实际字段类型**填值（文本 / 单选 / 多选 / 日期 / 超链接），表里没有的列跳过；
 *   附件、公式等其余类型一律不写（海报附件交给表里的「链接转附件」自动化）。
 * - 去重以 uid 列为准：每轮先读表里已有的 uid，再与同步服务记下的已写入集合合并。
 * - 两种身份（v1.8.3 用户定：默认 lark-cli，应用凭据可选）：
 *   - 没填 App ID / Secret：经本机已登录的 lark-cli（`lark-cli api <方法> <路径> --as user`）调接口，用的是
 *     用户本人的登录身份，不用另建应用；进程由同步服务起（runCli 注入），本模块不碰 child_process。
 *   - 两个都填：用自建应用的 tenant_access_token 直连 OpenAPI，域名按表格链接选：
 *     *.larksuite.com → open.larksuite.com，其余 → open.feishu.cn。
 *
 * 分层：纯函数（parseBitableUrl / buildRecordFields / selectPending）三端可用；效果层（带 fetch 的）
 * 只给同步服务用，fetch 可注入（测试）。UMD 外壳与其他 shared 模块一致。
 */
(function (global) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const Lark = isNode ? require('./lark.js') : global.Lark;
  const FetchUtil = isNode ? require('./fetch-util.js') : global.FetchUtil;
  const SOURCE_NAMES = isNode ? require('./site-registry.js').SOURCE_NAMES : global.SiteRegistry.SOURCE_NAMES;

  const BATCH_SIZE = 500; // batch_create 单次上限
  const PAGE_SIZE = 500; // 列记录单页上限

  // Bitable v1 字段类型码（只列会写的几种）
  const FIELD_TYPE = Object.freeze({ TEXT: 1, NUMBER: 2, SINGLE_SELECT: 3, MULTI_SELECT: 4, DATETIME: 5, URL: 15 });

  /**
   * 表格链接 → { apiBase, kind: 'base'|'wiki', token, tableId }；认不出返回 null。
   * 认 /base/<token> 与 /wiki/<token> 两种（wiki 里的多维表格要再换一次真正的 app_token），
   * 表 ID 取查询参数 table。
   */
  function parseBitableUrl(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl || '').trim());
    } catch (e) {
      return null;
    }
    if (!/^https?:$/.test(url.protocol)) return null;
    const match = url.pathname.match(/^\/(base|wiki)\/([A-Za-z0-9]+)/);
    const tableId = url.searchParams.get('table') || '';
    if (!match || !/^tbl[A-Za-z0-9]+$/.test(tableId)) return null;
    const host = url.hostname.toLowerCase();
    const apiBase = /(^|\.)larksuite\.com$/.test(host) ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
    return { apiBase, kind: match[1], token: match[2], tableId };
  }

  /** 用哪种身份：App ID / Secret 都填＝应用身份，否则走本机 lark-cli 的登录身份 */
  function authMode(rawConfig) {
    const config = Lark.normalizeConfig(rawConfig);
    return config.bitableAppId && config.bitableAppSecret ? 'app' : 'cli';
  }

  /** 就绪闸门：开关打开、链接认得出、uid 列没被关掉；凭据可以都不填（走 lark-cli），但不能只填一半 */
  function bitableReadiness(rawConfig) {
    const config = Lark.normalizeConfig(rawConfig);
    const missing = [];
    if (!config.bitableEnabled) missing.push('bitableEnabled');
    if (!parseBitableUrl(config.bitableUrl)) missing.push('bitableUrl');
    if (config.bitableAppId && !config.bitableAppSecret) missing.push('bitableAppSecret');
    if (!config.bitableAppId && config.bitableAppSecret) missing.push('bitableAppId');
    if (!config.bitableFields.uid) missing.push('bitableFields.uid');
    return { ok: missing.length === 0, missing };
  }

  const text = value => (typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim());
  const list = value => (Array.isArray(value) ? value : []).map(text).filter(Boolean);

  /** 条目在各映射键上的原始值（未按字段类型格式化）。contentTagsFor：genres → 中文内容标签，可缺省 */
  function rawValues(drama, contentTagsFor) {
    const d = drama || {};
    return {
      uid: text(d.itemId) || text(d.id),
      title: text(d.title),
      description: text(d.description),
      genres: list(d.genres),
      titleZh: text(d.titleZh),
      descriptionZh: text(d.descriptionZh),
      platform: SOURCE_NAMES[d.source] || text(d.source),
      tags: list(d.tags),
      contentTags: typeof contentTagsFor === 'function' ? list(contentTagsFor(list(d.genres))) : [],
      poster: text(Lark.posterForPayload(d.poster)),
      url: text(d.url),
      scrapedAt: text(d.scrapedAt),
      playUrl: text(d.playUrl)
    };
  }

  /** 按字段类型格式化一个值；返回 undefined 表示不写这一格 */
  function formatValue(value, type) {
    const isList = Array.isArray(value);
    if (isList ? value.length === 0 : !value) return undefined;
    switch (type) {
      case FIELD_TYPE.TEXT:
        return isList ? value.join(',') : value;
      case FIELD_TYPE.SINGLE_SELECT:
        return isList ? value[0] : value;
      case FIELD_TYPE.MULTI_SELECT:
        return isList ? value : String(value).split(',').map(s => s.trim()).filter(Boolean);
      case FIELD_TYPE.DATETIME: {
        const ms = Date.parse(isList ? value[0] : value);
        return Number.isFinite(ms) ? ms : undefined;
      }
      case FIELD_TYPE.URL: {
        const link = isList ? value[0] : value;
        return /^https?:\/\//i.test(link) ? { text: link, link } : undefined;
      }
      default:
        return undefined; // 附件、数字、公式等不写
    }
  }

  /**
   * 一条记录的 fields 对象。fieldTypes：Map(列名 → 类型码)，只写表里存在且类型支持的列。
   */
  function buildRecordFields(drama, { fields, fieldTypes, contentTagsFor } = {}) {
    const mapping = Lark.normalizeBitableFields(fields);
    const values = rawValues(drama, contentTagsFor);
    const out = {};
    for (const [key, column] of Object.entries(mapping)) {
      if (!column || !fieldTypes.has(column)) continue;
      const formatted = formatValue(values[key], fieldTypes.get(column));
      if (formatted !== undefined) out[column] = formatted;
    }
    return out;
  }

  /** 待追加的条目：已翻译（status=trans）、有 uid、表里没有、也没写过；同一 uid 只取第一条 */
  function selectPending(dramas, { existingUids = new Set(), syncedIds = new Set() } = {}) {
    const seen = new Set();
    const out = [];
    for (const drama of Array.isArray(dramas) ? dramas : []) {
      if (!drama || drama.status !== 'trans') continue;
      const uid = text(drama.itemId) || text(drama.id);
      if (!uid || seen.has(uid) || existingUids.has(uid) || syncedIds.has(uid)) continue;
      seen.add(uid);
      out.push(drama);
    }
    return out;
  }

  // —— 效果层 ——————————————————————————————————————————————

  class BitableError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'BitableError';
      this.code = code;
    }
  }

  /** 调一次 OpenAPI：非 2xx 或业务 code≠0 都抛 BitableError（带飞书返回的 code / msg） */
  async function callApi(ctx, method, apiPath, { query, body, token } = {}) {
    const url = new URL(ctx.apiBase + apiPath);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await ctx.fetchWithDeadline(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }, { timeoutMs: ctx.timeoutMs, timeoutMessage: `飞书接口 ${ctx.timeoutMs / 1000} 秒内无响应（${apiPath}）` });
    let json = null;
    try {
      json = await response.json();
    } catch (e) {
      throw new BitableError(`飞书接口返回的不是 JSON（HTTP ${response.status}，${apiPath}）`);
    }
    if (!response.ok || !json || json.code !== 0) {
      const code = json && json.code;
      throw new BitableError(`${json && json.msg ? json.msg : `HTTP ${response.status}`}（code ${code ?? '?'}，${apiPath}）`, code);
    }
    return json.data || {};
  }

  // tenant_access_token 缓存：按 域名 + appId 区分，提前 5 分钟过期
  let tokenCache = null;
  function __resetTokenCache() { tokenCache = null; }

  async function getToken(ctx) {
    const now = Date.now();
    const key = `${ctx.apiBase}|${ctx.appId}`;
    if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > now) return tokenCache.token;
    const response = await ctx.fetchWithDeadline(`${ctx.apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: ctx.appId, app_secret: ctx.appSecret })
    }, { timeoutMs: ctx.timeoutMs, timeoutMessage: `换取应用令牌 ${ctx.timeoutMs / 1000} 秒内无响应` });
    let json = null;
    try { json = await response.json(); } catch (e) { /* 下面统一报 */ }
    if (!response.ok || !json || json.code !== 0 || !json.tenant_access_token) {
      throw new BitableError(`换取应用令牌失败：${json && json.msg ? json.msg : `HTTP ${response.status}`}（检查 App ID / Secret）`, json && json.code);
    }
    const ttl = Number(json.expire) > 600 ? Number(json.expire) - 300 : 600;
    tokenCache = { key, token: json.tenant_access_token, expiresAt: now + ttl * 1000 };
    return tokenCache.token;
  }

  /**
   * 由配置组一个调用上下文。返回 null＝链接认不出。
   * - runCli(args, { input, timeoutMs }) → { code, stdout, stderr }：lark-cli 身份要用，由同步服务注入；
   * - fetchImpl / apiBaseOverride：应用身份用，仅供测试（fetch 桩、本机假接口）。
   */
  function createContext(rawConfig, { fetchImpl, apiBaseOverride, runCli } = {}) {
    const config = Lark.normalizeConfig(rawConfig);
    const target = parseBitableUrl(config.bitableUrl);
    if (!target) return null;
    const fetchWithDeadline = fetchImpl
      ? (url, init) => fetchImpl(url, init)
      : (url, init, opts) => FetchUtil.fetchWithDeadline(url, init, opts);
    const timeoutMs = config.requestTimeoutSec * 1000;
    return {
      config,
      target,
      mode: authMode(config),
      apiBase: apiBaseOverride || target.apiBase,
      appId: config.bitableAppId,
      appSecret: config.bitableAppSecret,
      timeoutMs,
      // lark-cli 每次调用都要起进程、500 条一批的写入体也大，给足时间
      cliTimeoutMs: Math.max(60000, timeoutMs),
      fetchWithDeadline,
      runCli
    };
  }

  /** lark-cli 的输出：成功在 stdout、失败在 stderr，都是一段 JSON；前面可能夹着进度行，取第一个 { 到最后一个 } */
  function parseCliJson(output) {
    const raw = String(output || '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (e) {
      return null;
    }
  }

  /** 经 lark-cli 调一次接口（用户身份）；失败抛 BitableError，登录失效时给出重新登录的命令 */
  async function callCli(ctx, method, apiPath, { query, body } = {}) {
    if (typeof ctx.runCli !== 'function') {
      throw new BitableError('这里调不了 lark-cli（只有同步服务能用这种身份）；要么交给同步服务，要么填 App ID / Secret');
    }
    const args = ['api', method, apiPath, '--as', 'user', '--format', 'json'];
    if (query && Object.keys(query).length) args.push('--params', JSON.stringify(query));
    let input;
    if (body !== undefined) {
      args.push('--data', '-');
      input = JSON.stringify(body);
    }
    let result;
    try {
      result = await ctx.runCli(args, { input, timeoutMs: ctx.cliTimeoutMs });
    } catch (e) {
      throw new BitableError(`调用 lark-cli 失败：${e.message}`);
    }
    const parsed = parseCliJson(result.stdout) || parseCliJson(result.stderr);
    if (parsed && parsed.ok === true) return parsed.data || {};
    const error = parsed && parsed.error;
    if (error) {
      const relogin = error.type === 'authorization'
        ? '——lark-cli 登录已失效或缺权限，请在终端运行 lark-cli auth login --domain all 重新登录'
        : '';
      throw new BitableError(`${error.message || error.type || '未知错误'}（code ${error.code ?? '?'}，${apiPath}）${relogin}`, error.code);
    }
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 200);
    throw new BitableError(`lark-cli 没有返回可识别的结果（退出码 ${result.code}）${detail ? `：${detail}` : ''}`);
  }

  /** 按身份调一次接口，返回 data */
  async function request(ctx, method, apiPath, options = {}) {
    if (ctx.mode === 'cli') return callCli(ctx, method, apiPath, options);
    const token = await getToken(ctx);
    return callApi(ctx, method, apiPath, { ...options, token });
  }

  /** wiki 链接要先换成多维表格自己的 app_token；base 链接直接用 */
  async function resolveAppToken(ctx) {
    if (ctx.target.kind === 'base') return ctx.target.token;
    const data = await request(ctx, 'GET', '/open-apis/wiki/v2/spaces/get_node', { query: { token: ctx.target.token } });
    const node = data.node || {};
    if (node.obj_type !== 'bitable' || !node.obj_token) {
      throw new BitableError(`这个知识库页面不是多维表格（obj_type=${node.obj_type || '?'}）`);
    }
    return node.obj_token;
  }

  async function listFieldTypes(ctx, appToken) {
    const types = new Map();
    let pageToken = '';
    do {
      const query = { page_size: '100' };
      if (pageToken) query.page_token = pageToken;
      const data = await request(ctx, 'GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${ctx.target.tableId}/fields`, { query });
      for (const item of data.items || []) types.set(item.field_name, item.type);
      pageToken = data.has_more ? data.page_token : '';
    } while (pageToken);
    return types;
  }

  /** 文本字段在返回里可能是字符串，也可能是富文本段数组 [{text}] */
  function cellText(value) {
    if (Array.isArray(value)) return value.map(seg => (seg && typeof seg === 'object' ? seg.text || '' : String(seg))).join('').trim();
    if (value && typeof value === 'object') return text(value.text || value.link);
    return text(value);
  }

  async function listExistingUids(ctx, appToken, uidColumn) {
    const uids = new Set();
    let total = 0;
    let pageToken = '';
    do {
      const query = { page_size: String(PAGE_SIZE), field_names: JSON.stringify([uidColumn]) };
      if (pageToken) query.page_token = pageToken;
      const data = await request(ctx, 'GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${ctx.target.tableId}/records`, { query });
      for (const item of data.items || []) {
        total++;
        const uid = cellText(item.fields && item.fields[uidColumn]);
        if (uid) uids.add(uid);
      }
      pageToken = data.has_more ? data.page_token : '';
    } while (pageToken);
    return { uids, total };
  }

  async function batchCreate(ctx, appToken, records) {
    let created = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      const data = await request(ctx, 'POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${ctx.target.tableId}/records/batch_create`, {
        body: { records: chunk.map(fields => ({ fields })) }
      });
      created += Array.isArray(data.records) ? data.records.length : chunk.length;
    }
    return created;
  }

  /** 映射里开着、但表里找不到的列名 */
  function missingColumns(fields, fieldTypes) {
    return Object.values(Lark.normalizeBitableFields(fields)).filter(column => column && !fieldTypes.has(column));
  }

  /**
   * 读表现状：令牌、app_token、列类型、已有 uid。测试连接与真实同步共用。
   */
  async function inspect(ctx) {
    const appToken = await resolveAppToken(ctx);
    const fieldTypes = await listFieldTypes(ctx, appToken);
    const uidColumn = ctx.config.bitableFields.uid;
    if (!fieldTypes.has(uidColumn)) {
      throw new BitableError(`表里没有去重用的「${uidColumn}」列（可在 config/lark.json 的 bitableFields.uid 改列名）`);
    }
    const { uids, total } = await listExistingUids(ctx, appToken, uidColumn);
    return { appToken, fieldTypes, existingUids: uids, rowCount: total, missing: missingColumns(ctx.config.bitableFields, fieldTypes) };
  }

  /**
   * 测试连接（只读）：返回表的行数、缺的列、按当前时间线会追加多少条。
   */
  async function testConnection(ctx, { dramas = [], syncedIds = new Set() } = {}) {
    const info = await inspect(ctx);
    const pending = selectPending(dramas, { existingUids: info.existingUids, syncedIds });
    return { mode: ctx.mode, appToken: info.appToken, rowCount: info.rowCount, missingColumns: info.missing, pendingCount: pending.length };
  }

  /**
   * 跑一轮同步：追加待写条目，返回 { added, addedIds, rowCount, missingColumns, appToken }。
   * 失败直接抛（调用方记日志、留到下一轮）；已经成功写入的批次照常计入 addedIds。
   */
  async function syncOnce(ctx, { dramas = [], syncedIds = new Set(), contentTagsFor } = {}) {
    const info = await inspect(ctx);
    const pending = selectPending(dramas, { existingUids: info.existingUids, syncedIds });
    const addedIds = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const chunk = pending.slice(i, i + BATCH_SIZE);
      const records = chunk.map(drama => buildRecordFields(drama, {
        fields: ctx.config.bitableFields, fieldTypes: info.fieldTypes, contentTagsFor
      }));
      await batchCreate(ctx, info.appToken, records);
      for (const drama of chunk) addedIds.push(text(drama.itemId) || text(drama.id));
    }
    return {
      added: addedIds.length,
      addedIds,
      // 表里本来就有的 uid 也一并交给调用方记进「已写入」，用户之后手删的行不会被加回来
      existingIds: [...info.existingUids],
      rowCount: info.rowCount + addedIds.length,
      missingColumns: info.missing,
      appToken: info.appToken
    };
  }

  const api = {
    FIELD_TYPE,
    BATCH_SIZE,
    BitableError,
    parseBitableUrl,
    authMode,
    bitableReadiness,
    parseCliJson,
    buildRecordFields,
    selectPending,
    missingColumns,
    createContext,
    testConnection,
    syncOnce,
    __resetTokenCache
  };

  if (isNode) {
    module.exports = api;
  }
  global.LarkBitable = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
