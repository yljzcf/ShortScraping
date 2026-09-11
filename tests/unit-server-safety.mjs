import './bootstrap.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { card, SUB } from './background-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shortscraping-safety-'));
for (const rel of ['server', 'src/shared', 'config', 'db']) fs.mkdirSync(path.join(directory, rel), { recursive: true });
fs.copyFileSync(path.join(root, 'server/sync-server.js'), path.join(directory, 'server/sync-server.js'));
for (const file of fs.readdirSync(path.join(root, 'src/shared'))) fs.copyFileSync(path.join(root, 'src/shared', file), path.join(directory, 'src/shared', file));
const tagFile = path.join(directory, 'config/tag.json');
const tags = [{ url: SUB, tags: ['IMDB'] }];
fs.writeFileSync(tagFile, JSON.stringify(tags));
const probe = http.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const child = spawn(process.execPath, ['server/sync-server.js', '--local-only'], {
  cwd: directory, env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
const base = `http://127.0.0.1:${port}`;
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
async function post(route, payload, headers = {}) {
  const response = await fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(3000)
  });
  return { status: response.status, body: await response.json() };
}
try {
  const deadline = Date.now() + 5000;
  while (!output.includes(`服务已启动：${base}`)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Fixture startup failed: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  // Both the extension's JSON request and the local Node tools remain supported.
  assert.equal((await post('/config/tag', { urlTags: tags }, { Origin: extensionOrigin })).status, 200);
  assert.equal((await post('/config/trans', { translateConfig: { delayMs: 0 } }, { Origin: extensionOrigin })).status, 200);
  const savedConfig = JSON.parse(fs.readFileSync(path.join(directory, 'config/trans.json'), 'utf8'));
  assert.equal(savedConfig.delayMs, 0);
  assert.equal((await post('/sync', { dramas: [card('tt1')] })).body.count, 1);
  const csv = fs.readFileSync(path.join(directory, 'db/timeline.csv'), 'utf8');
  const snapshot = fs.readFileSync(path.join(directory, 'db/timeline.json'), 'utf8');

  // The first extension write pins that origin; any other extension is refused afterwards.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'config/sync-origin.json'), 'utf8')).origin, extensionOrigin);
  for (const origin of ['https://audit.invalid', 'null', base, 'chrome-extension://bad', `chrome-extension://${'b'.repeat(32)}`]) {
    for (const route of ['/config/trans', '/config/tag', '/sync', '/shutdown']) {
      assert.equal((await post(route, {}, { Origin: origin, 'Content-Type': 'text/plain' })).status, 403);
    }
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'config/trans.json'), 'utf8')), savedConfig);
  assert.equal((await post('/sync', { dramas: [] }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('/sync', { dramas: [] }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/sync', {})).status, 400);
  assert.equal((await post('/sync', { dramas: [null] })).status, 400);
  assert.equal((await post('/config/tag', {})).status, 500);
  assert.equal(fs.readFileSync(path.join(directory, 'db/timeline.csv'), 'utf8'), csv);
  assert.equal(fs.readFileSync(path.join(directory, 'db/timeline.json'), 'utf8'), snapshot);

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

  const exited = once(child, 'exit');
  const stopped = await post('/shutdown', {});
  assert.equal(stopped.status, 200);
  assert.equal((await exited)[0], 0);
  console.log('Server origin, host, request, persistence and shutdown checks passed');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
