import './bootstrap.cjs';
// server/tools/stop.js --restart 回归测试（npm run restart 与 restart-sync.command 共用这一入口）。
// 只测非 launchd 分支：SHORTSCRAPING_NO_LAUNCHD=1 加随机端口双保险，绝不碰本机真实的开机自启服务。
//   R1 端口上有旧实例：停掉后前台起新实例（pid 不同），--restart 之后的参数转给服务，服务退出码原样带回；
//   R2 端口空闲：直接前台启动；包装进程被单独 SIGTERM 时转给服务，不留孤儿占端口（仅 POSIX）；
//   R3 端口被别的服务占着：以 1 退出、不启动新实例（旧版 `stop.js && sync-server.js` 会照样启动，必然撞 EADDRINUSE）。
// 隔离方式沿用 unit-server-restart：复制到 os.tmpdir() 隔离树，不碰真实 31919 与 db/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { SUB } from './background-fixture.mjs';
import { freePort } from './free-port.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shortscraping-stop-restart-'));
for (const rel of ['server/tools', 'src/shared', 'config', 'db']) fs.mkdirSync(path.join(directory, rel), { recursive: true });
fs.copyFileSync(path.join(root, 'server/sync-server.js'), path.join(directory, 'server/sync-server.js'));
fs.copyFileSync(path.join(root, 'server/tools/stop.js'), path.join(directory, 'server/tools/stop.js'));
for (const file of fs.readdirSync(path.join(root, 'src/shared'))) fs.copyFileSync(path.join(root, 'src/shared', file), path.join(directory, 'src/shared', file));
fs.writeFileSync(path.join(directory, 'config/tag.json'), JSON.stringify([{ url: SUB, tags: ['IMDB'] }]));

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const envFor = targetPort => ({
  ...process.env, SHORTSCRAPING_PORT: String(targetPort), XPC_SERVICE_NAME: '', SHORTSCRAPING_NO_LAUNCHD: '1',
  SHORTSCRAPING_LOG_FILE: path.join(directory, 'sync.log')
});

function launch(args, targetPort = port) {
  const child = spawn(process.execPath, args, {
    cwd: directory, env: envFor(targetPort), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.output = '';
  child.stdout.on('data', chunk => { child.output += chunk; });
  child.stderr.on('data', chunk => { child.output += chunk; });
  child.exited = once(child, 'exit');
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

// 按进程判活：退出中的旧进程仍可能经 keep-alive 连接应答 /health（见 unit-server-restart）
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

const children = [];
const serverPids = new Set();
let foreign = null;
try {
  // —— R1：替换正在运行的实例 ——
  const first = launch(['server/sync-server.js', '--local-only']);
  children.push(first);
  const before = await waitFor(async () => {
    const h = await health();
    return h && h.pid === first.pid ? h : null;
  }, 5000, `旧实例启动\n${first.output}`);
  const restarter = launch(['server/tools/stop.js', '--restart', '--local-only']);
  children.push(restarter);
  assert.equal((await first.exited)[0], 0); // 旧实例经 /shutdown 正常退出
  const after = await waitFor(async () => {
    const h = await health();
    return h && h.pid !== before.pid ? h : null;
  }, 8000, `新实例接管端口\n${restarter.output}`);
  serverPids.add(after.pid);
  assert.notEqual(after.pid, restarter.pid); // 服务是包装进程的子进程，包装进程留在前台等它
  assert.equal(after.localOnly, true); // --restart 之后的参数转给了服务
  assert.match(restarter.output, /服务已停止/);
  // 端口来自专用环境变量 SHORTSCRAPING_PORT（不再是通用的 PORT）：非默认端口时明说操作的不是扩展连的那个服务
  assert.match(restarter.output, new RegExp(`按环境变量 SHORTSCRAPING_PORT 操作端口 ${port}（非默认 31919）`));
  await waitFor(() => /服务已启动/.test(restarter.output), 3000, `服务输出直通前台\n${restarter.output}`);
  const stopped = await fetch(base + '/shutdown', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000)
  });
  assert.equal(stopped.status, 200);
  const [code, signal] = await restarter.exited;
  assert.deepEqual([code, signal], [0, null]); // 服务的退出码原样带回给 npm / 终端
  await waitFor(() => !alive(after.pid), 5000, '新实例停止');

  // —— R2：端口空闲时直接前台启动；包装进程被单独结束时不留孤儿 ——
  const cold = launch(['server/tools/stop.js', '--restart', '--local-only']);
  children.push(cold);
  const coldHealth = await waitFor(health, 8000, `空闲端口上前台启动\n${cold.output}`);
  serverPids.add(coldHealth.pid);
  assert.match(cold.output, /服务未运行/);
  if (process.platform !== 'win32') {
    cold.kill('SIGTERM');
    const [coldCode, coldSignal] = await cold.exited;
    assert.deepEqual([coldCode, coldSignal], [null, 'SIGTERM']); // 按服务的死因重新抛出同一信号
    await waitFor(() => !alive(coldHealth.pid), 5000, '信号转给了服务，端口随之释放');
  } else {
    await fetch(base + '/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await cold.exited)[0], 0);
  }

  // —— R3：端口被别的服务占着 ——
  const foreignPort = await freePort();
  foreign = http.createServer((req, res) => { res.writeHead(404); res.end('not here'); });
  await new Promise(resolve => foreign.listen(foreignPort, '127.0.0.1', resolve));
  const blocked = launch(['server/tools/stop.js', '--restart', '--local-only'], foreignPort);
  children.push(blocked);
  assert.equal((await blocked.exited)[0], 1);
  assert.match(blocked.output, /被其他服务占用/);
  assert.match(blocked.output, /未启动新实例/);
  assert.doesNotMatch(blocked.output, /服务已启动|EADDRINUSE|已被占用/);

  console.log('stop.js --restart (foreground replace / cold start / signal forward / foreign port) checks passed');
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await child.exited; }
  }
  for (const pid of serverPids) {
    try { process.kill(pid); } catch (_) { /* 已退出 */ }
  }
  if (foreign) await new Promise(resolve => foreign.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
}
