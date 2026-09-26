import './bootstrap.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { ROOT as root, SERVER_ARGS, card, SUB, freePort, makeIsolatedTree, launch, waitStarted, httpClient, terminate } from './server-fixture.mjs';

// 隔离树与子进程走 tests/server-fixture.mjs（端口护栏、环境变量、tmpdir 校验只写一处）；
// Host 头、畸形路径与半截请求体这些用例要逐字节控制请求，仍用本文件自己的原始 http.request
const require = createRequire(import.meta.url);
const TranslateConfig = require('../src/shared/translate-config.js');
const Lark = require('../src/shared/lark.js');
const ScheduleConfig = require('../src/shared/schedule-config.js');
const tags = [{ url: SUB, tags: ['IMDB'] }];
const tree = makeIsolatedTree({ prefix: 'shortscraping-safety-', config: { 'tag.json': tags } });
const directory = tree.dir;
const tagFile = path.join(directory, 'config/tag.json');
const port = await freePort();
const child = launch(tree, SERVER_ARGS, { port });
const base = child.base;
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
// JSON 体、Content-Type 默认 application/json 且可被 headers 覆盖、3 秒超时，返回 {status, body}
const { post } = httpClient(base);
try {
  await waitStarted(child, { timeoutMs: 5000 });
  // Both the extension's JSON request and the local Node tools remain supported.
  assert.equal((await post('/config/tag', { urlTags: tags }, { Origin: extensionOrigin })).status, 200);
  assert.equal((await post('/config/trans', { translateConfig: { delayMs: 0 } }, { Origin: extensionOrigin })).status, 200);
  const savedConfig = JSON.parse(fs.readFileSync(path.join(directory, 'config/trans.json'), 'utf8'));
  assert.equal(savedConfig.delayMs, 0);
  // trans.json / lark.json hold plaintext keys: a freshly created one is owner-only (Windows has no POSIX modes).
  const fileMode = rel => fs.statSync(path.join(directory, rel)).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(fileMode('config/trans.json'), 0o600);
  assert.equal((await post('/sync', { dramas: [card('tt1')] })).body.count, 1);
  const csv = fs.readFileSync(path.join(directory, 'db/timeline.csv'), 'utf8');
  const snapshot = fs.readFileSync(path.join(directory, 'db/timeline.json'), 'utf8');

  // The first extension write pins that origin; any other extension is refused afterwards.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'config/sync-origin.json'), 'utf8')).origin, extensionOrigin);
  for (const origin of ['https://audit.invalid', 'null', base, 'chrome-extension://bad', `chrome-extension://${'b'.repeat(32)}`]) {
    for (const route of ['/config/trans', '/config/tag', '/sync', '/shutdown', '/restart']) {
      assert.equal((await post(route, {}, { Origin: origin, 'Content-Type': 'text/plain' })).status, 403);
    }
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'config/trans.json'), 'utf8')), savedConfig);
  assert.equal((await post('/sync', { dramas: [] }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('/sync', { dramas: [] }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/sync', {})).status, 400);
  assert.equal((await post('/sync', { dramas: [null] })).status, 400);
  assert.equal((await post('/config/tag', {})).status, 500);
  // An empty push may only replace a non-empty shared snapshot when the extension declares allowEmpty
  // (a user-confirmed clear); otherwise a fresh profile's warm-up push of [] would wipe db/timeline.*.
  const emptyPush = await post('/sync', { dramas: [] });
  assert.equal(emptyPush.status, 409);
  assert.equal(emptyPush.body.code, 'EMPTY_REJECTED');
  assert.equal(fs.readFileSync(path.join(directory, 'db/timeline.csv'), 'utf8'), csv);
  assert.equal(fs.readFileSync(path.join(directory, 'db/timeline.json'), 'utf8'), snapshot);

  // Config write-backs need the matching key holding a plain object. A missing, null, array or misspelled
  // key used to be normalized into defaults and atomically overwrite the file, silently wiping the API key,
  // webhooks and App Secret (no history backup; the next SW wake copies the wiped file into storage).
  // Valid payloads keep writing exactly the normalized config.
  const configCases = [
    ['/config/trans', 'translateConfig', 'config/trans.json',
      { translateMode: 'ai', aiEndpoint: 'https://ai.invalid/v1', aiApiKey: 'sk-audit', delayMs: 0 }, TranslateConfig.normalizeConfig],
    ['/config/lark', 'larkConfig', 'config/lark.json',
      { webhookUrl: 'https://open.feishu.cn/audit-flow', botWebhookUrl: 'https://open.feishu.cn/audit-bot', botEnabled: true,
        feishuAppId: 'cli_audit', feishuAppSecret: 'secret-audit' }, Lark.normalizeConfig],
    ['/config/cron', 'scheduleConfig', 'config/cron.json',
      { scheduleMode: 'cron', scrapeInterval: 6, translateInterval: 1, scrapeCron: '10 3 * * *', translateCron: '20 3 * * *' },
      raw => ScheduleConfig.validateConfig(raw).config]
  ];
  // Files saved at 0644 by older versions (and a 0644 .tmp left by an interrupted save, which
  // writeFileSync's mode would not touch) must come out 0600 on the next save; other config keeps
  // the umask default, measured with a probe file because the child inherits this process's umask.
  const probe = path.join(directory, 'config/mode-probe');
  fs.writeFileSync(probe, '');
  const defaultMode = fs.statSync(probe).mode & 0o777;
  fs.unlinkSync(probe);
  const SECRET_FILES = new Set(['config/trans.json', 'config/lark.json']);
  fs.chmodSync(path.join(directory, 'config/trans.json'), 0o644);
  fs.writeFileSync(path.join(directory, 'config/lark.json.tmp'), 'stale');
  fs.chmodSync(path.join(directory, 'config/lark.json.tmp'), 0o644);
  for (const [route, key, rel, valid, normalize] of configCases) {
    const file = path.join(directory, rel);
    const saved = await post(route, { [key]: valid });
    assert.equal(saved.status, 200, `${route} ${JSON.stringify(saved.body)}`);
    assert.deepEqual(saved.body.config, normalize(valid));
    const written = fs.readFileSync(file, 'utf8');
    assert.equal(written, `${JSON.stringify(normalize(valid), null, 2)}\n`);
    if (process.platform !== 'win32') {
      assert.equal(fileMode(rel), SECRET_FILES.has(rel) ? 0o600 : defaultMode, `${rel} mode ${fileMode(rel).toString(8)}`);
    }
    for (const bad of [{}, { [key]: null }, { [key]: [] }, { [key]: 'x' }, { [key]: 0 }, { [`${key}s`]: valid }, null]) {
      const refused = await post(route, bad);
      assert.equal(refused.status, 400, `${route} ${JSON.stringify(bad)}`);
      assert.equal(refused.body.ok, false);
      assert.equal(fs.readFileSync(file, 'utf8'), written, `${route} ${JSON.stringify(bad)} must not touch ${rel}`);
    }
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  }

  // Invalid hostnames cannot expose data; malformed URL input gets 400 and leaves service alive.
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', headers: { Host: `audit.invalid:${port}` } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  // Any IP literal is accepted: LAN devices reach the share page by address, not by name.
  const lanHostStatus = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', headers: { Host: `10.0.0.5:${port}` } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(lanHostStatus, 200);
  const invalidStatus = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '//[', method: 'GET' }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(invalidStatus, 400);
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal(child.exitCode, null);

  // Missing, malformed and invalid config never become an implicit clear operation.
  for (const broken of ['{broken', '{}', '[null]', '[{"url":"bad","tags":["x"]}]']) {
    fs.writeFileSync(tagFile, broken);
    assert.equal((await post('/sync', { dramas: [card('tt1')] })).status, 500);
    assert.equal(fs.readFileSync(path.join(directory, 'db/timeline.csv'), 'utf8'), csv);
    assert.equal(fs.readFileSync(path.join(directory, 'db/timeline.json'), 'utf8'), snapshot);
  }
  // A single malformed entry only skips itself; the extension ignores those entries too.
  fs.writeFileSync(tagFile, JSON.stringify([{ url: 'bad', tags: ['x'] }, ...tags]));
  assert.equal((await post('/sync', { dramas: [card('tt1')] })).body.count, 1);
  assert.equal(fs.readFileSync(path.join(directory, 'db/timeline.json'), 'utf8'), snapshot);
  // A hand-edited tag.json saved as "UTF-8 with BOM" (PowerShell 5.1, Notepad) reads fine in the
  // extension (fetch().json() strips the BOM), so the server must accept it too instead of 500 forever.
  fs.writeFileSync(tagFile, '\uFEFF' + JSON.stringify(tags, null, 2));
  const bomSync = await post('/sync', { dramas: [card('tt1'), card('tt2')] });
  assert.equal(bomSync.status, 200, JSON.stringify(bomSync.body));
  assert.equal(bomSync.body.count, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'db/timeline.json'), 'utf8')).dramas.length, 2);
  // A missing file means "no subscriptions saved yet", not an error that blocks every push.
  fs.unlinkSync(tagFile);
  const missing = await post('/sync', { dramas: [card('tt1')] });
  assert.equal(missing.status, 200);
  assert.equal(missing.body.count, 0);
  assert.equal((await post('/config/tag', { urlTags: [] })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(tagFile, 'utf8')), []);
  assert.equal((await post('/sync', { dramas: [card('tt1')] })).body.count, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'db/timeline.json'), 'utf8')).dramas.length, 0);
  assert.equal(fs.existsSync(tagFile + '.tmp'), false);

  // A large Chinese body arrives in many TCP chunks; a 3-byte character split across two chunks
  // must still decode intact (2026-09-25: per-chunk decoding wrote `\uFFFD\uFFFD` into db/timeline.*).
  fs.writeFileSync(tagFile, JSON.stringify(tags));
  const zhDramas = Array.from({ length: 40 }, (_, i) => card(`tt9${i}`, {
    titleZh: `中文标题${i}`, descriptionZh: '短剧简介：她在民政局被前任抛弃，三年后带娃归来。'.repeat(120) + i
  }));
  assert.equal((await post('/sync', { dramas: zhDramas })).body.count, zhDramas.length);
  const zhSnapshot = fs.readFileSync(path.join(directory, 'db/timeline.json'), 'utf8');
  assert.ok(Buffer.byteLength(JSON.stringify(zhDramas)) > 300 * 1024);
  assert.equal(zhSnapshot.includes('\uFFFD'), false);
  assert.deepEqual(JSON.parse(zhSnapshot).dramas.map(d => d.descriptionZh), zhDramas.map(d => d.descriptionZh));
  assert.equal(fs.readFileSync(path.join(directory, 'db/timeline.csv'), 'utf8').includes('\uFFFD'), false);

  // Same-content pushes skip the CSV rewrite but must report the same count as the push that wrote it
  // (2026-09-25 audit E): the route used to recount with `itemId || id`, while the CSV dedupes on
  // TimelineCsv's key (itemId, legacy imdbId, then id; keyless entries produce no row).
  const mixedKeys = [
    card('tt1'),
    { ...card('tt2'), itemId: undefined, imdbId: 'tt2' }, // legacy field name only
    card('tt2', { id: 'id_tt2b' }),                       // same item under the new field name
    { ...card('tt3'), id: '', itemId: '' },               // no key at all: never becomes a CSV row
    card('tt1')
  ];
  const firstMixed = await post('/sync', { dramas: mixedKeys });
  assert.equal(firstMixed.body.count, 2, JSON.stringify(firstMixed.body));
  const csvLines = fs.readFileSync(path.join(directory, 'db/timeline.csv'), 'utf8').trim().split('\r\n');
  assert.equal(csvLines.length - 1, 2);
  const csvMtime = fs.statSync(path.join(directory, 'db/timeline.csv')).mtimeMs;
  const sameMixed = await post('/sync', { dramas: mixedKeys });
  assert.equal(sameMixed.body.count, firstMixed.body.count, JSON.stringify(sameMixed.body));
  assert.equal(fs.statSync(path.join(directory, 'db/timeline.csv')).mtimeMs, csvMtime); // really took the no-rewrite branch

  // Oversized bodies get a readable 413 instead of a destroyed socket (the old 20MB cap called req.destroy(),
  // so the route's error response never left and the extension only saw "fetch failed" -> "is the service
  // running?"), and the cap has headroom for the whole-table push that grows every month.
  const MAX_BODY = 64 * 1024 * 1024;
  const rawPost = (route, send) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: send.headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        req.destroy(); // a declared-but-unsent body would otherwise keep the socket open
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error(`${route} got no response`)));
    // errors after the response resolved (writes still queued when we destroy the request) are no-ops;
    // before it, a reset/EPIPE is exactly the old destroy-the-socket behaviour and must fail the test
    req.on('error', reject);
    Promise.resolve(send.body(req)).catch(reject);
  });
  const timelineBefore = [fs.readFileSync(path.join(directory, 'db/timeline.csv'), 'utf8'), fs.readFileSync(path.join(directory, 'db/timeline.json'), 'utf8')];
  // (a) The extension's fetch always declares Content-Length: refused up front, without reading the body.
  const declared = await rawPost('/sync', {
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_BODY + 1) },
    body: req => req.write('{"dramas":[')
  });
  assert.equal(declared.status, 413, JSON.stringify(declared.body));
  assert.equal(declared.body.code, 'BODY_TOO_LARGE');
  assert.match(declared.body.error, /64MB 上限/);
  // (b) A chunked body with no length crosses the cap mid-stream: still a 413 the client can read.
  const block = Buffer.alloc(1024 * 1024, 0x20);
  const streamed = await rawPost('/sync', {
    headers: { 'Content-Type': 'application/json' },
    body: async req => {
      req.write('{"dramas":[]');
      for (let i = 0; i < MAX_BODY / block.length + 1; i++) {
        if (!req.write(block)) await once(req, 'drain');
      }
      req.end('}');
    }
  });
  assert.equal(streamed.status, 413, JSON.stringify(streamed.body));
  assert.equal(streamed.body.code, 'BODY_TOO_LARGE');
  assert.deepEqual([fs.readFileSync(path.join(directory, 'db/timeline.csv'), 'utf8'), fs.readFileSync(path.join(directory, 'db/timeline.json'), 'utf8')], timelineBefore);
  // (c) Bodies above the old 20MB cap are accepted now (shared readBody, so a padded config write proves it).
  const cronConfig = { scheduleMode: 'cron', scrapeInterval: 6, translateInterval: 1, scrapeCron: '10 3 * * *', translateCron: '20 3 * * *' };
  const padded = await fetch(base + '/config/cron', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scheduleConfig: cronConfig, pad: 'x'.repeat(21 * 1024 * 1024) }), signal: AbortSignal.timeout(10000)
  });
  assert.equal(padded.status, 200, await padded.clone().text());
  assert.deepEqual((await padded.json()).config, ScheduleConfig.validateConfig(cronConfig).config);
  // The service is still healthy and keeps accepting normal pushes afterwards.
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await post('/sync', { dramas: mixedKeys })).body.count, 2);
  assert.equal(child.exitCode, null);
  // A test port is not the extension's port: say so at startup.
  assert.match(child.output, new RegExp(`当前监听非默认端口 ${port}（来自环境变量 SHORTSCRAPING_PORT），扩展只连 31919`));

  // The share page's card/tab styles are shared with the popup and served from src/shared.
  const sharedCss = await fetch(base + '/shared/timeline-cards.css');
  assert.equal(sharedCss.status, 200);
  assert.equal(sharedCss.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(await sharedCss.text(), fs.readFileSync(path.join(root, 'src/shared/timeline-cards.css'), 'utf8'));

  const exited = once(child, 'exit');
  const stopped = await post('/shutdown', {});
  assert.equal(stopped.status, 200);
  assert.equal((await exited)[0], 0);
  console.log('Server origin, host, request, persistence and shutdown checks passed');
} finally {
  await terminate(child);
  tree.cleanup();
}
