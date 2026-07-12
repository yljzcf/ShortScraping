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
 * 局域网设备只能访问只读页面与只读数据接口；trans.json（含 API Key）无读取接口。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 31919;
const LOCAL_ONLY = process.argv.includes('--local-only');
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
const CSV_BOM = '﻿';
const CSV_NEWLINE = '\r\n';

const CSV_COLUMNS = [
  'id',
  'imdbId',
  'title',
  'titleZh',
  'tags',
  'description',
  'descriptionZh',
  'company',
  'source',
  'status',
  'url',
  'sourceListUrl',
  'poster',
  'scrapedAt',
  'translatedAt'
];

// —— 局域网共享状态：最新时间线快照（内存 + db/timeline.json 持久化） ——
let latestDramas = [];
let latestSerialized = '[]';
let dataVersion = 0;
let updatedAt = null;
const sseClients = new Set();

function serializeTimelineCsv(rows) {
  const body = [CSV_COLUMNS.join(','), ...rows].join(CSV_NEWLINE);
  return CSV_BOM + body + CSV_NEWLINE;
}

function ensureDb() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, serializeTimelineCsv([]), 'utf8');
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join('|') : String(value);
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

function normalizeDrama(drama) {
  return {
    id: drama.id || '',
    imdbId: drama.imdbId || '',
    title: drama.title || '',
    titleZh: drama.titleZh || '',
    tags: Array.isArray(drama.tags) ? drama.tags : [],
    description: drama.description || '',
    descriptionZh: drama.descriptionZh || '',
    company: drama.company || '',
    source: drama.source || '',
    status: drama.status || '',
    url: drama.url || '',
    sourceListUrl: drama.sourceListUrl || '',
    poster: drama.poster || '',
    scrapedAt: drama.scrapedAt || '',
    translatedAt: drama.translatedAt || ''
  };
}

function writeTimelineCsv(dramas) {
  ensureDb();

  const seen = new Set();
  const rows = [];

  for (const drama of dramas || []) {
    const normalized = normalizeDrama(drama);
    const key = normalized.imdbId || normalized.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);

    rows.push(CSV_COLUMNS.map(column => csvEscape(normalized[column])).join(','));
  }

  const content = serializeTimelineCsv(rows);
  fs.writeFileSync(CSV_PATH, content, 'utf8');
  return rows.length;
}

function normalizeTagConfig(rawTags) {
  if (!Array.isArray(rawTags)) return [];

  const seen = new Set();
  return rawTags
    .map(item => ({
      url: String(item.url || item.urlPattern || '').trim(),
      tags: Array.isArray(item.tags)
        ? item.tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 3)
        : []
    }))
    .filter(item => /^https?:\/\//i.test(item.url) && item.tags.length > 0)
    .filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
}

function writeTagConfig(rawTags) {
  const tags = normalizeTagConfig(rawTags);
  if (tags.length === 0) {
    throw new Error('没有可写入的有效网页订阅');
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TAG_CONFIG_PATH, `${JSON.stringify(tags, null, 2)}\n`, 'utf8');
  return tags.length;
}

function normalizeTransConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const translateMode = config.translateMode === 'ai' ? 'ai' : 'api';

  return {
    translateMode,
    apiEndpoint: String(config.apiEndpoint || 'https://api.mymemory.translated.net/get').trim(),
    aiEndpoint: String(config.aiEndpoint || '').trim(),
    aiApiKey: String(config.aiApiKey || '').trim(),
    aiModel: String(config.aiModel || 'gpt-3.5-turbo').trim(),
    aiPrefixPrompt: String(config.aiPrefixPrompt || '').trim(),
    batchSize: toPositiveInteger(config.batchSize, 5),
    delayMs: toNonNegativeInteger(config.delayMs, 200),
    requestTimeoutSec: toPositiveInteger(config.requestTimeoutSec, 10)
  };
}

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function toNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function writeTransConfig(rawConfig) {
  const config = normalizeTransConfig(rawConfig);

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TRANS_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config;
}

function readTagConfig() {
  if (!fs.existsSync(TAG_CONFIG_PATH)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(TAG_CONFIG_PATH, 'utf8'));
    return normalizeTagConfig(raw);
  } catch (error) {
    console.warn('[ShortScraping Sync] 读取 tag.json 失败，将跳过未匹配订阅的数据:', error.message);
    return [];
  }
}

function filterDramasByTagConfig(dramas) {
  const urlTags = readTagConfig();
  const configuredUrls = urlTags.map(item => item.url);
  if (configuredUrls.length === 0) return [];

  return (dramas || []).filter(drama => {
    if (!drama.sourceListUrl) return false;
    return configuredUrls.some(url => drama.sourceListUrl === url || drama.sourceListUrl.startsWith(url));
  });
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
  ensureDb();
  const tmpPath = `${TIMELINE_JSON_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({ version: dataVersion, updatedAt, dramas: latestDramas }), 'utf8');
  fs.renameSync(tmpPath, TIMELINE_JSON_PATH);
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

// —— 静态文件（显式白名单，防路径穿越） ——

const STATIC_ROUTES = {
  '/': { file: path.join(PUBLIC_DIR, 'share.html'), type: 'text/html; charset=utf-8' },
  '/public/share.css': { file: path.join(PUBLIC_DIR, 'share.css'), type: 'text/css; charset=utf-8' },
  '/public/share.js': { file: path.join(PUBLIC_DIR, 'share.js'), type: 'text/javascript; charset=utf-8' },
  '/shared/timeline-render.js': { file: path.join(SHARED_DIR, 'timeline-render.js'), type: 'text/javascript; charset=utf-8' }
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
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type'
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

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  // 写入接口仅限本机：局域网设备只读
  if (req.method === 'POST' && !isLocalRequest(req)) {
    return sendJson(res, 403, { ok: false, error: '写入接口仅限本机调用' });
  }

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      csvPath: CSV_PATH,
      // 弹窗 📁 依赖：扩展无法感知自己的磁盘路径，从这里学到脚本目录并缓存
      serverDir: __dirname,
      localOnly: LOCAL_ONLY,
      lanUrls: LOCAL_ONLY ? [] : getLanUrls(),
      version: dataVersion
    });
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
      const dramas = Array.isArray(payload.dramas) ? payload.dramas : [];
      const configured = filterDramasByTagConfig(dramas);
      const count = writeTimelineCsv(configured);

      // 更新局域网共享快照并广播给已连接页面；内容未变化时不 bump 版本
      // 不广播——扩展 SW 每次唤醒都会预热推送，避免共享页无谓重渲染
      const serialized = JSON.stringify(configured);
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
      const rawTags = Array.isArray(payload.urlTags) ? payload.urlTags : [];
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

  sendJson(res, 404, { ok: false, error: 'Not Found' });
});

ensureDb();
loadSnapshot();

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
