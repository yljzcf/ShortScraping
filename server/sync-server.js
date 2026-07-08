/**
 * ShortScraping Local CSV Sync Server
 *
 * Chrome 扩展无法直接写入项目目录文件，因此由本地 Node 服务接收扩展数据，
 * 并将时间线内容实时同步到 db/timeline.csv。
 *
 * 启动：node server/sync-server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 31919;
const PROJECT_DIR = path.join(__dirname, '..');
const DB_DIR = path.join(PROJECT_DIR, 'db');
const CONFIG_DIR = path.join(PROJECT_DIR, 'config');
const CSV_PATH = path.join(DB_DIR, 'timeline.csv');
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
  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, csvPath: CSV_PATH });
  }

  if (req.method === 'POST' && req.url === '/sync') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const dramas = Array.isArray(payload.dramas) ? payload.dramas : [];
      const count = writeTimelineCsv(filterDramasByTagConfig(dramas));
      return sendJson(res, 200, { ok: true, count, csvPath: CSV_PATH });
    } catch (error) {
      console.error('[ShortScraping Sync] 同步失败:', error);
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && req.url === '/config/tag') {
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

  if (req.method === 'POST' && req.url === '/config/trans') {
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
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ShortScraping Sync] 服务已启动：http://127.0.0.1:${PORT}`);
  console.log(`[ShortScraping Sync] CSV 输出：${CSV_PATH}`);
});
