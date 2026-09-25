import './bootstrap.cjs';
// 同步服务 POST /restart 回归测试（v1.6.13，弹窗 🔄）。
//   respawn 模式（前台 / Windows）：旧实例派生脱离的新实例后以 0 退出，新实例等端口空出后接管；
//   launchd 模式（macOS 开机自启）：以 75 退出交给 launchd 拉起，自身不派生（否则会和 launchd 抢端口）。
// 隔离方式沿用 unit-server-safety：复制到 os.tmpdir() 隔离树、随机端口，不碰真实 31919 与 db/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { SUB } from './background-fixture.mjs';
import { freePort } from './free-port.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shortscraping-restart-'));
for (const rel of ['server', 'src/shared', 'config', 'db']) fs.mkdirSync(path.join(directory, rel), { recursive: true });
fs.copyFileSync(path.join(root, 'server/sync-server.js'), path.join(directory, 'server/sync-server.js'));
for (const file of fs.readdirSync(path.join(root, 'src/shared'))) fs.copyFileSync(path.join(root, 'src/shared', file), path.join(directory, 'src/shared', file));
fs.writeFileSync(path.join(directory, 'config/tag.json'), JSON.stringify([{ url: SUB, tags: ['IMDB'] }]));

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function start(extraEnv) {
  const env = { ...process.env, PORT: String(port), XPC_SERVICE_NAME: '', ...extraEnv };
  const child = spawn(process.execPath, ['server/sync-server.js', '--local-only'], {
    cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.output = '';
  child.stdout.on('data', chunk => { child.output += chunk; });
  child.stderr.on('data', chunk => { child.output += chunk; });
  return child;
}

async function health() {
  try {
    const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(100);
  }
}

// 按进程判活而不是看 /health 无响应：fetch 复用的 keep-alive 连接在 server.close() 之后
// 仍会被退出中的旧进程应答，/health 会在 null 与旧进程之间来回跳
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function post(route) {
  const response = await fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000)
  });
  return { status: response.status, body: await response.json() };
}

const children = [];
let respawnedPid = null;
try {
  // —— respawn 模式：新进程接管同一端口，旧进程正常退出 ——
  const first = start();
  children.push(first);
  const before = await waitFor(health, 5000, `首个实例启动\n${first.output}`);
  assert.equal(before.pid, first.pid);
  const exited = once(first, 'exit');
  const restart = await post('/restart');
  assert.equal(restart.status, 200);
  assert.equal(restart.body.mode, 'respawn');
  assert.equal((await exited)[0], 0);
  const after = await waitFor(async () => {
    const h = await health();
    return h && h.pid !== before.pid ? h : null;
  }, 8000, '新实例接管端口');
  respawnedPid = after.pid;
  assert.ok(after.ok);
  const snapshot = JSON.parse(fs.readFileSync(path.join(directory, 'config/tag.json'), 'utf8'));
  assert.equal(snapshot.length, 1); // 配置原样保留，新实例照常读取
  assert.equal((await post('/shutdown')).status, 200);
  await waitFor(() => !alive(respawnedPid), 5000, '新实例停止');
  respawnedPid = null;

  // —— launchd 模式：非零退出交还 launchd，自己不派生新实例 ——
  const managed = start({ XPC_SERVICE_NAME: 'com.shortscraping.sync' });
  children.push(managed);
  await waitFor(async () => (await health())?.pid === managed.pid, 5000, `launchd 模式实例启动\n${managed.output}`);
  const managedExit = once(managed, 'exit');
  const managedRestart = await post('/restart');
  assert.equal(managedRestart.body.mode, 'launchd');
  assert.equal((await managedExit)[0], 75);
  await sleep(1500);
  assert.equal(await health(), null); // 没有自行派生：端口留给 launchd（旧进程已退出，连接随之断开）

  console.log('Server restart (respawn + launchd) checks passed');
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
  }
  if (respawnedPid) {
    try { process.kill(respawnedPid); } catch (_) { /* 已退出 */ }
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
