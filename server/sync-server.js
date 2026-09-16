/**
 * ShortScraping Local Sync & LAN Share Server
 *
 * Chrome 扩展无法直接写入项目目录文件，因此由本地 Node 服务接收扩展数据，
 * 将时间线内容实时同步到 db/timeline.csv，并向局域网提供只读时间线页面。
 *
 * 启动：node server/sync-server.js [--local-only]
 *   默认监听 0.0.0.0，局域网设备可通过 http://<本机IP>:31919/ 访问只读共享页；
 *   --local-only 退回仅本机 127.0.0.1。测试可用环境变量 PORT 覆盖端口。
 *
 * 安全边界：写入接口（POST /sync、POST /config/*）仅接受本机回环地址调用，
 * 局域网设备只能访问只读页面与只读数据接口；trans.json（含 API Key）与
 * lark.json（webhook 地址即写权限凭据）均无任何读取接口。
 */

const http = require('http');
const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const UrlMatch = require('../src/shared/url-match.js');
const SubscriptionConfig = require('../src/shared/subscription-config.js');
const Lark = require('../src/shared/lark.js');
const TimelineCsv = require('../src/shared/timeline-csv.js');
const ScheduleConfig = require('../src/shared/schedule-config.js');
const TranslateConfig = require('../src/shared/translate-config.js');

const PORT = Number(process.env.PORT) || 31919;
const LOCAL_ONLY = process.argv.includes('--local-only');
// 域名形态的 Host 默认拒绝（DNS rebinding 只能经域名发起）；确需用主机名访问
// 共享页时显式放行：node server/sync-server.js --allow-host=mypc.local
const ALLOWED_HOSTS = new Set(process.argv
  .filter(arg => arg.startsWith('--allow-host='))
  .map(arg => arg.slice('--allow-host='.length).trim().toLowerCase())
  .filter(Boolean));
const PROJECT_DIR = path.join(__dirname, '..');
const DB_DIR = path.join(PROJECT_DIR, 'db');
const CONFIG_DIR = path.join(PROJECT_DIR, 'config');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SHARED_DIR = path.join(PROJECT_DIR, 'src', 'shared');
const ICONS_DIR = path.join(PROJECT_DIR, 'assets', 'icons');
const CSV_PATH = path.join(DB_DIR, 'timeline.csv');
const TIMELINE_JSON_PATH = path.join(DB_DIR, 'timeline.json');
const TAG_CONFIG_PATH = path.join(CONFIG_DIR, 'tag.json');
const TRANS_CONFIG_PATH = path.join(CONFIG_DIR, 'trans.json');
const LARK_CONFIG_PATH = path.join(CONFIG_DIR, 'lark.json');
const CRON_CONFIG_PATH = path.join(CONFIG_DIR, 'cron.json');
const SYNC_ORIGIN_PATH = path.join(CONFIG_DIR, 'sync-origin.json');
// —— 局域网共享状态：最新时间线快照（内存 + db/timeline.json 持久化） ——
let latestDramas = [];
let latestSerialized = '[]';
let dataVersion = 0;
let updatedAt = null;
const sseClients = new Set();

function ensureDb() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, TimelineCsv.buildTimelineCsv([]).content, 'utf8');
  }
}

// 原子落盘单一真源：先写同目录 .tmp 再 rename，进程中断不会留下半截文件。
// CSV、局域网快照与四个配置文件共用，改写入策略（重试、fsync、临时名）只改这里。
function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// CSV 列序/转义/去重/normalizeDrama 单一真源在 src/shared/timeline-csv.js
// （与设置页「导出 CSV」共用）；本函数只负责落盘
function writeTimelineCsv(dramas) {
  const { content, count } = TimelineCsv.buildTimelineCsv(dramas);
  writeFileAtomic(CSV_PATH, content);
  return count;
}

// 订阅规范化单一真源在 src/shared/subscription-config.js（v1.6.5 收敛，与扩展端同一份语义）；
// 这里只做文件形态投影 { url, tags }
function normalizeTagConfig(rawTags) {
  return SubscriptionConfig.toTagFileEntries(rawTags);
}

/** 写入前的强校验：设置页只会发合法条目，坏数据一律拒绝落盘（绝不静默收窄）。 */
function assertTagConfig(rawTags) {
  if (!Array.isArray(rawTags)) throw new Error('网页订阅必须是数组');
  const tags = normalizeTagConfig(rawTags);
  if (tags.length !== rawTags.length) throw new Error('网页订阅包含无效或重复条目');
  return tags;
}

function writeTagConfig(rawTags) {
  const tags = assertTagConfig(rawTags);
  writeJsonAtomic(TAG_CONFIG_PATH, tags);
  return tags.length;
}

function writeTransConfig(rawConfig) {
  const config = TranslateConfig.normalizeConfig(rawConfig);

  writeJsonAtomic(TRANS_CONFIG_PATH, config);
  return config;
}

function writeLarkConfig(rawConfig) {
  const config = Lark.normalizeConfig(rawConfig);

  writeJsonAtomic(LARK_CONFIG_PATH, config);
  return config;
}

// 拒绝坏配置范式（同 /config/tag）：cron 表达式校验不过直接抛（→500），
// 文件不动——非法调度落盘会让扩展 SW 每次唤醒都读到坏配置
function writeCronConfig(rawConfig) {
  const { ok, errors, config } = ScheduleConfig.validateConfig(rawConfig);
  if (!ok) {
    const detail = Object.entries(errors).map(([key, msg]) => `${key}: ${msg}`).join('；');
    throw new Error(`Cron 配置无效——${detail}`);
  }

  writeJsonAtomic(CRON_CONFIG_PATH, config);
  return config;
}

let missingTagConfigWarned = false;

/**
 * 读取订阅配置，三态而非二态（2026-09-11 复查）：
 *   1) 文件不存在＝尚未在设置页保存过订阅的引导态 → 按零订阅处理、只提示一次，
 *      不能变成每次推送都 500 的错误态（新 clone 必然没有这个 gitignored 文件）；
 *   2) 读不动 / JSON 损坏 / 根不是数组 / 整份条目全部失效 → 抛错，由调用方拒绝
 *      本次同步并保住已有 CSV 与共享快照——这是「坏配置不清空数据」的底线；
 *   3) 个别条目无效或重复 → 告警后丢弃该条，与扩展端 normalizeUrlTags 口径一致，
 *      不因一条手写错误让整份文件失效、把 /sync 变成永久 500。
 */
function readTagConfig() {
  let text;
  try {
    text = fs.readFileSync(TAG_CONFIG_PATH, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`读取 tag.json 失败，保留现有数据：${error.message}`);
    if (!missingTagConfigWarned) {
      missingTagConfigWarned = true;
      console.warn(`[ShortScraping Sync] 未找到 ${TAG_CONFIG_PATH}，按零订阅处理；在设置页保存一次网页订阅即可生成`);
    }
    return [];
  }
  missingTagConfigWarned = false;

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`读取 tag.json 失败，保留现有数据：${error.message}`);
  }
  if (!Array.isArray(raw)) throw new Error('读取 tag.json 失败，保留现有数据：网页订阅必须是数组');

  const tags = normalizeTagConfig(raw);
  if (raw.length > 0 && tags.length === 0) {
    throw new Error('读取 tag.json 失败，保留现有数据：全部订阅条目无效或重复');
  }
  if (tags.length !== raw.length) {
    console.warn(`[ShortScraping Sync] tag.json 有 ${raw.length - tags.length} 条订阅无效或重复，已跳过（扩展端同样忽略它们）`);
  }
  return tags;
}

function filterDramasByTagConfig(dramas) {
  const urlTags = readTagConfig();
  const configuredUrls = urlTags.map(item => item.url);
  if (configuredUrls.length === 0) return [];

  // 与扩展端同规则：尾斜杠归一后的精确等值（src/shared/url-match.js 三端共用）
  const configuredSet = UrlMatch.buildConfiguredUrlSet(configuredUrls);
  return (dramas || []).filter(drama => UrlMatch.isUrlCovered(drama.sourceListUrl, configuredSet));
}

// —— 局域网共享：快照持久化、SSE 广播与地址枚举 ——

function loadSnapshot() {
  try {
    if (!fs.existsSync(TIMELINE_JSON_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(TIMELINE_JSON_PATH, 'utf8'));
    latestDramas = Array.isArray(raw.dramas) ? raw.dramas : [];
    latestSerialized = JSON.stringify(latestDramas);
    dataVersion = Number.isInteger(raw.version) ? raw.version : 0;
    updatedAt = raw.updatedAt || null;
    console.log(`[ShortScraping Sync] 已恢复时间线快照：${latestDramas.length} 条（version ${dataVersion}）`);
  } catch (error) {
    console.warn('[ShortScraping Sync] 读取时间线快照失败，将等待扩展下一次推送:', error.message);
  }
}

function saveSnapshot() {
  writeFileAtomic(TIMELINE_JSON_PATH, JSON.stringify({ version: dataVersion, updatedAt, dramas: latestDramas }));
}

function broadcastUpdate() {
  const payload = `event: update\ndata: ${JSON.stringify({ version: dataVersion })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (error) {
      sseClients.delete(client);
    }
  }
}

// 局域网地址优先级：家用网段 192.168.* 最常见，排最前便于弹窗默认展示
function lanScore(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}

function getLanUrls() {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  ips.sort((a, b) => lanScore(a) - lanScore(b));
  return ips.map(ip => `http://${ip}:${PORT}`);
}

function isLocalRequest(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Host 校验按「类型」而不是枚举本机地址：DNS rebinding 的前提是攻击者控制一个
 * 域名，IP 字面量与 localhost 不可能被 rebinding。枚举 os.networkInterfaces()
 * 会把局域网共享页的主机名/mDNS/VPN 名/端口转发访问全部误杀（还要每请求一次系统调用），
 * 而这些正是「同网设备只读浏览」邀请的用法。
 */
function isAllowedHost(hostHeader) {
  const header = (hostHeader || '').trim().toLowerCase();
  if (!header) return false;
  // IPv6 字面量形如 [::1]:31919；IPv4/主机名形如 127.0.0.1:31919
  const hostname = (header.startsWith('[') ? header.slice(0, header.indexOf(']') + 1) : header.split(':')[0])
    .replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  return ALLOWED_HOSTS.has(hostname) || ALLOWED_HOSTS.has(header);
}

const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;
let pinnedWriteOrigin = null;

function loadPinnedWriteOrigin() {
  try {
    const raw = JSON.parse(fs.readFileSync(SYNC_ORIGIN_PATH, 'utf8'));
    if (EXTENSION_ORIGIN_PATTERN.test(raw && raw.origin)) pinnedWriteOrigin = raw.origin;
  } catch (error) {
    // 尚未固定：等第一次扩展写入时建立
  }
}

/**
 * 写接口来源判定。chrome-extension:// 正则只能证明「是某个扩展」——同一 profile 下
 * 任何持 localhost 主机权限的扩展都能冒名清空数据，因此只认「首次写入时固定下来的
 * 那一个」。未打包扩展的 ID 由加载路径派生、每台机器不同，服务端无从预知，
 * 故用首见即固定（config/sync-origin.json，已 gitignore）；换目录重载扩展导致
 * ID 变化时，删掉该文件即可重新固定。Node 管理工具不带 Origin，照常放行。
 */
function checkWriteOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) {
    // 浏览器发起的请求一定带 Origin 或 Sec-Fetch-*；两者皆无才视为本机 Node 工具
    return req.headers['sec-fetch-site'] === undefined;
  }
  if (!EXTENSION_ORIGIN_PATTERN.test(origin)) return false;
  if (!pinnedWriteOrigin) {
    pinnedWriteOrigin = origin;
    try {
      writeJsonAtomic(SYNC_ORIGIN_PATH, { origin, pinnedAt: new Date().toISOString() });
    } catch (error) {
      console.warn('[ShortScraping Sync] 写入来源固定失败（本次运行内仍生效）:', error.message);
    }
    console.log(`[ShortScraping Sync] 已固定写入来源扩展：${origin}；换目录重载扩展后如被拒，删除 ${SYNC_ORIGIN_PATH} 重新固定`);
    return true;
  }
  if (origin !== pinnedWriteOrigin) {
    console.warn(`[ShortScraping Sync] 拒绝非固定扩展的写入请求：${origin}`);
    return false;
  }
  return true;
}

// —— 静态文件（显式白名单，防路径穿越） ——

const STATIC_ROUTES = {
  '/': { file: path.join(PUBLIC_DIR, 'share.html'), type: 'text/html; charset=utf-8' },
  '/public/share.css': { file: path.join(PUBLIC_DIR, 'share.css'), type: 'text/css; charset=utf-8' },
  '/public/share.js': { file: path.join(PUBLIC_DIR, 'share.js'), type: 'text/javascript; charset=utf-8' },
  '/shared/timeline-render.js': { file: path.join(SHARED_DIR, 'timeline-render.js'), type: 'text/javascript; charset=utf-8' },
  '/shared/site-registry.js': { file: path.join(SHARED_DIR, 'site-registry.js'), type: 'text/javascript; charset=utf-8' },
  '/shared/site-tabs.js': { file: path.join(SHARED_DIR, 'site-tabs.js'), type: 'text/javascript; charset=utf-8' },
  // timeline-render 的标题文案单一真源（v1.6.2）；漏了这条共享页直接白屏
  '/shared/translate-config.js': { file: path.join(SHARED_DIR, 'translate-config.js'), type: 'text/javascript; charset=utf-8' }
};

const ICON_TYPES = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveFile(res, filePath, contentType, cacheSeconds) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      return sendJson(res, 404, { ok: false, error: 'Not Found' });
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheSeconds > 0 ? `max-age=${cacheSeconds}` : 'no-cache'
    });
    res.end(content);
  });
}

function sendJson(res, statusCode, body) {
  // 不设置 CORS 头：合法消费方要么同源（局域网共享页），要么是带 host_permissions
  // 的扩展页面（不受 CORS 限制）；任意网页试图跨源读取时间线数据会被浏览器拦截。
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 20 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  let pathname;
  try {
    if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new Error('invalid target');
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (_) {
    return sendJson(res, 400, { ok: false, error: '无效请求路径' });
  }

  if (!isAllowedHost(req.headers.host)) {
    return sendJson(res, 403, { ok: false, error: '不允许的主机名' });
  }

  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  // 写入接口仅限本机：局域网设备只读
  if (req.method === 'POST' && !isLocalRequest(req)) {
    return sendJson(res, 403, { ok: false, error: '写入接口仅限本机调用' });
  }

  if (req.method === 'POST') {
    if (!checkWriteOrigin(req)) {
      return sendJson(res, 403, { ok: false, error: '写入请求来源不受信任' });
    }
    // 所有写接口都要求 application/json：非简单请求必须先过预检，
    // 无主机权限的扩展连「发出去就生效」的副作用请求都构造不出来。
    if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      return sendJson(res, 415, { ok: false, error: '请使用 application/json' });
    }
  }

  if (req.method === 'GET' && pathname === '/health') {
    const body = {
      ok: true,
      localOnly: LOCAL_ONLY,
      lanUrls: LOCAL_ONLY ? [] : getLanUrls(),
      version: dataVersion
    };
    // 本机磁盘路径只发给本机调用方（弹窗 📁 与设置页展示依赖），
    // 不向局域网设备/任意网页暴露本机目录布局
    if (isLocalRequest(req)) {
      body.csvPath = CSV_PATH;
      body.serverDir = __dirname;
    }
    return sendJson(res, 200, body);
  }

  // 停止服务：仅本机可调用（已受上方 POST 回环护栏保护），供 stop.js / 停止脚本优雅关停
  if (req.method === 'POST' && pathname === '/shutdown') {
    sendJson(res, 200, { ok: true, message: 'shutting down' });
    console.log('[ShortScraping Sync] 收到停止请求，正在关闭服务...');
    // 主动断开 SSE 长连接，否则 server.close 会一直等待其结束
    for (const client of sseClients) {
      try { client.end(); } catch (error) { /* 忽略断开异常 */ }
    }
    sseClients.clear();
    server.close(() => process.exit(0));
    // 兜底：即使仍有未结束的连接，也在短暂延迟后强制退出
    setTimeout(() => process.exit(0), 500).unref();
    return;
  }

  if (req.method === 'GET' && pathname === '/api/timeline') {
    return sendJson(res, 200, { ok: true, version: dataVersion, updatedAt, dramas: latestDramas });
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('retry: 3000\n\n');
    res.write(`event: update\ndata: ${JSON.stringify({ version: dataVersion })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'GET' && STATIC_ROUTES[pathname]) {
    const route = STATIC_ROUTES[pathname];
    return serveFile(res, route.file, route.type, 0);
  }

  if (req.method === 'GET' && pathname.startsWith('/assets/icons/')) {
    const name = pathname.slice('/assets/icons/'.length);
    const ext = path.extname(name).toLowerCase();
    if (!/^[\w.-]+$/.test(name) || !ICON_TYPES[ext]) {
      return sendJson(res, 404, { ok: false, error: 'Not Found' });
    }
    return serveFile(res, path.join(ICONS_DIR, name), ICON_TYPES[ext], 3600);
  }

  if (req.method === 'POST' && pathname === '/sync') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      if (!payload || !Array.isArray(payload.dramas) || payload.dramas.some(d => !d || typeof d !== 'object' || Array.isArray(d))) {
        return sendJson(res, 400, { ok: false, error: '缺少有效的 dramas 数组' });
      }
      const dramas = payload.dramas;
      const configured = filterDramasByTagConfig(dramas);
      // 合法空推送或订阅已取消导致清空时留痕；配置读取失败已在过滤阶段拒绝。
      if (configured.length === 0 && latestDramas.length > 0) {
        console.warn(
          `[ShortScraping Sync] 警告：收到空时间线推送（原始 ${dramas.length} 条 / 过滤后 0 条），` +
          `现有快照 ${latestDramas.length} 条即将被清空——若非主动清空订阅，请检查扩展数据与 config/tag.json`
        );
      }
      // 同内容跳过 CSV 重写：扩展 SW 每次唤醒都预热推送，绝大多数与上次内容一致，
      // 无谓的磁盘重写全部拦在这里；existsSync 守卫保住「CSV 被手删后下次推送自愈」的行为
      const serialized = JSON.stringify(configured);
      let count;
      if (serialized === latestSerialized && fs.existsSync(CSV_PATH)) {
        count = new Set(latestDramas.map(d => d.itemId || d.id)).size;
      } else {
        count = writeTimelineCsv(configured);
      }

      // 更新局域网共享快照并广播给已连接页面；内容未变化时不 bump 版本
      // 不广播——扩展 SW 每次唤醒都会预热推送，避免共享页无谓重渲染
      if (serialized !== latestSerialized) {
        latestSerialized = serialized;
        latestDramas = configured;
        dataVersion += 1;
        updatedAt = new Date().toISOString();
        saveSnapshot();
        broadcastUpdate();
      }

      return sendJson(res, 200, { ok: true, count, csvPath: CSV_PATH });
    } catch (error) {
      console.error('[ShortScraping Sync] 同步失败:', error);
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && pathname === '/config/tag') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const rawTags = payload?.urlTags;
      const count = writeTagConfig(rawTags);
      return sendJson(res, 200, { ok: true, count, configPath: TAG_CONFIG_PATH });
    } catch (error) {
      console.error('[ShortScraping Sync] 写入网页订阅配置失败:', error);
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && pathname === '/config/trans') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const config = writeTransConfig(payload.translateConfig || {});
      return sendJson(res, 200, { ok: true, config, configPath: TRANS_CONFIG_PATH });
    } catch (error) {
      console.error('[ShortScraping Sync] 写入翻译接口配置失败:', error);
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && pathname === '/config/lark') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const config = writeLarkConfig(payload.larkConfig || {});
      return sendJson(res, 200, { ok: true, config, configPath: LARK_CONFIG_PATH });
    } catch (error) {
      console.error('[ShortScraping Sync] 写入 Lark 推送配置失败:', error);
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && pathname === '/config/cron') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const config = writeCronConfig(payload.scheduleConfig || {});
      return sendJson(res, 200, { ok: true, config, configPath: CRON_CONFIG_PATH });
    } catch (error) {
      console.error('[ShortScraping Sync] 写入定时任务配置失败:', error);
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  sendJson(res, 404, { ok: false, error: 'Not Found' });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error('[ShortScraping Sync] 请求处理失败:', error.message);
    if (!res.headersSent && !res.destroyed) sendJson(res, 500, { ok: false, error: '请求处理失败' });
    else res.destroy();
  });
});

ensureDb();
loadSnapshot();
loadPinnedWriteOrigin();

// SSE 心跳：防止空闲长连接被中间设备掐断
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(': ping\n\n');
    } catch (error) {
      sseClients.delete(client);
    }
  }
}, 30000);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[ShortScraping Sync] 端口 ${PORT} 已被占用（可能同步服务已在运行）。`);
    console.error('[ShortScraping Sync] 如需停止，请运行 npm run stop（macOS 可双击 stop-sync.command）。');
    process.exit(1);
  }
  console.error('[ShortScraping Sync] 服务发生错误：', error);
  process.exit(1);
});

server.listen(PORT, LOCAL_ONLY ? '127.0.0.1' : '0.0.0.0', () => {
  console.log(`[ShortScraping Sync] 服务已启动：http://127.0.0.1:${PORT}${LOCAL_ONLY ? '（仅本机模式）' : ''}`);
  console.log(`[ShortScraping Sync] CSV 输出：${CSV_PATH}`);
  if (!LOCAL_ONLY) {
    const lanUrls = getLanUrls();
    if (lanUrls.length > 0) {
      console.log(`[ShortScraping Sync] 局域网共享页：${lanUrls.join('  ')}`);
      console.log('[ShortScraping Sync] 首次启动如系统弹出防火墙授权提示，请允许 Node 访问局域网（专用网络）。');
    }
  }
});
