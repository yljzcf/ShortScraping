import './bootstrap.cjs';
// 同步服务 POST /restart 回归测试（v1.6.13，弹窗 🔄）。
//   respawn 模式（前台 / Windows）：旧实例派生脱离的新实例后以 0 退出，新实例等端口空出后接管；
//   launchd 模式（macOS 开机自启）：以 75 退出交给 launchd 拉起，自身不派生（否则会和 launchd 抢端口）。
//   respawn 的新实例转入后台，stdout/stderr 写进日志文件（此前是 stdio:'ignore'，启动报错全丢）；
//   日志打不开 / 派生失败时回 500、旧实例不退出；launchd 拉起却撞上前台实例占端口时以 0 退出，免得崩溃循环；
//   已设开机自启（LaunchAgent 已加载）时 npm run sync 提示改用 npm run restart 后退出，不另起前台实例（仅 darwin）。
// 隔离方式沿用 unit-server-safety：复制到 os.tmpdir() 隔离树、随机端口，不碰真实 31919 与 db/；
// SHORTSCRAPING_LOG_FILE 指到隔离树，不写用户的 ~/Library/Logs。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
const logFile = path.join(directory, 'logs/sync.log'); // 目录故意不预建：服务端要自己 mkdir -p

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function start(extraEnv) {
  const env = { ...process.env, PORT: String(port), XPC_SERVICE_NAME: '', SHORTSCRAPING_LOG_FILE: logFile, ...extraEnv };
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
  // —— 日志打不开：拒绝重启（500）、旧实例留着——否则端口上一个服务都没有，弹窗却收到「重启中」 ——
  // tag.json 是普通文件，拿它当目录必然 ENOTDIR/EEXIST
  const unloggable = start({ SHORTSCRAPING_LOG_FILE: path.join(directory, 'config/tag.json/sync.log') });
  children.push(unloggable);
  await waitFor(async () => (await health())?.pid === unloggable.pid, 5000, `日志不可写实例启动\n${unloggable.output}`);
  const refused = await post('/restart');
  assert.equal(refused.status, 500);
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.error, /派生新实例失败/);
  await sleep(700); // 超过 shutdownServer 的 500ms 兜底强退
  assert.equal(unloggable.exitCode, null);
  assert.equal((await health())?.pid, unloggable.pid);
  const unloggableExit = once(unloggable, 'exit');
  assert.equal((await post('/shutdown')).status, 200);
  await unloggableExit;

  // —— respawn 模式：新进程接管同一端口，旧进程正常退出，新实例的输出进日志文件 ——
  const first = start();
  children.push(first);
  const before = await waitFor(health, 5000, `首个实例启动\n${first.output}`);
  assert.equal(before.pid, first.pid);
  const exited = once(first, 'close'); // 等 stdio 收尾，旧进程最后一行输出才完整
  const restart = await post('/restart');
  assert.equal(restart.status, 200);
  assert.equal(restart.body.mode, 'respawn');
  assert.equal(restart.body.logPath, logFile);
  assert.equal((await exited)[0], 0);
  assert.match(first.output, /服务转入后台继续运行，日志：/); // 旧窗口最后一行告诉用户去哪看、怎么停
  const after = await waitFor(async () => {
    const h = await health();
    return h && h.pid !== before.pid ? h : null;
  }, 8000, '新实例接管端口');
  respawnedPid = after.pid;
  assert.ok(after.ok);
  const log = await waitFor(() => {
    const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    return text.includes('服务已启动') ? text : null;
  }, 3000, '新实例启动行写进日志');
  assert.match(log, new RegExp(`由 🔄 重启派生新实例（接替 pid ${before.pid}）`));
  assert.ok(log.indexOf('由 🔄 重启派生') < log.indexOf('服务已启动')); // 交接记录在前，新实例输出紧随其后
  assert.match(log, new RegExp(`服务已启动：${base}（仅本机模式）`)); // argv（--local-only）原样传给新实例
  const snapshot = JSON.parse(fs.readFileSync(path.join(directory, 'config/tag.json'), 'utf8'));
  assert.equal(snapshot.length, 1); // 配置原样保留，新实例照常读取
  assert.equal((await post('/shutdown')).status, 200);
  await waitFor(() => !alive(respawnedPid), 5000, '新实例停止');
  respawnedPid = null;
  assert.match(fs.readFileSync(logFile, 'utf8'), /收到停止请求/); // 后台实例的运行日志同样落盘

  // —— launchd 模式：非零退出交还 launchd，自己不派生新实例 ——
  const managed = start({ XPC_SERVICE_NAME: 'com.shortscraping.sync' });
  children.push(managed);
  await waitFor(async () => (await health())?.pid === managed.pid, 5000, `launchd 模式实例启动\n${managed.output}`);
  const managedExit = once(managed, 'exit');
  const logBeforeManaged = fs.readFileSync(logFile, 'utf8');
  const managedRestart = await post('/restart');
  assert.equal(managedRestart.body.mode, 'launchd');
  assert.equal(managedRestart.body.logPath, logFile); // 与 launchd 的 StandardOutPath 同一文件
  assert.equal((await managedExit)[0], 75);
  await sleep(1500);
  assert.equal(await health(), null); // 没有自行派生：端口留给 launchd（旧进程已退出，连接随之断开）
  assert.equal(fs.readFileSync(logFile, 'utf8'), logBeforeManaged); // launchd 自己重定向输出，服务不另写

  // —— launchd 拉起时端口已被前台实例占用：以 0 退出（非 launchd 仍为 1），不触发 KeepAlive 崩溃循环 ——
  const foreground = start();
  children.push(foreground);
  await waitFor(async () => (await health())?.pid === foreground.pid, 5000, `前台实例启动\n${foreground.output}`);
  const clash = start({ XPC_SERVICE_NAME: 'com.shortscraping.sync' });
  children.push(clash);
  const [clashCode] = await once(clash, 'exit');
  assert.equal(clashCode, 0, clash.output);
  const plainClash = start();
  children.push(plainClash);
  const [plainClashCode] = await once(plainClash, 'exit');
  assert.equal(plainClashCode, 1, plainClash.output);
  assert.equal((await health())?.pid, foreground.pid); // 前台实例不受影响
  const foregroundExit = once(foreground, 'exit');
  assert.equal((await post('/shutdown')).status, 200);
  await foregroundExit;

  // —— 已设开机自启时拒绝另起前台实例：只在 darwin + 默认端口下探测 launchctl ——
  // 探测目标是默认端口，也就是本机真实的 31919：launchctl 换成 PATH 前置的假脚本（不碰本机真实的
  // LaunchAgent），再预加载把 listen 换成直接以 42 退出——守卫失效也绝不会真去监听
  if (process.platform === 'darwin') {
    const fakeBin = path.join(directory, 'fake-bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'launchctl'),
      '#!/bin/sh\n[ "$1" = print ] && [ "${2##*/}" = com.shortscraping.sync ] && exit 0\nexit 1\n', { mode: 0o755 });
    const noListen = path.join(directory, 'no-listen.cjs');
    fs.writeFileSync(noListen, "require('net').Server.prototype.listen = function () { process.exit(42); };\n");
    const guardEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, XPC_SERVICE_NAME: '', SHORTSCRAPING_LOG_FILE: logFile };
    for (const key of ['PORT', 'SHORTSCRAPING_WAIT_PORT', 'SHORTSCRAPING_NO_LAUNCHD']) delete guardEnv[key];
    const runGuarded = extra => spawnSync(process.execPath, ['-r', noListen, 'server/sync-server.js', '--local-only'], {
      cwd: directory, env: { ...guardEnv, ...extra }, encoding: 'utf8', timeout: 10000
    });
    const refusedStart = runGuarded({});
    assert.equal(refusedStart.status, 1, refusedStart.stdout + refusedStart.stderr);
    assert.match(refusedStart.stderr, /已设置 macOS 开机自启/);
    assert.match(refusedStart.stderr, /npm run restart/);
    assert.match(refusedStart.stderr, /SHORTSCRAPING_NO_LAUNCHD=1/); // 前台调试的逃生口写在提示里
    // 放行：前台调试开关、🔄 接替实例、launchd 自己拉起的实例、与 plist 不相撞的自定义端口——都走到 listen 被预加载拦下
    for (const extra of [{ SHORTSCRAPING_NO_LAUNCHD: '1' }, { SHORTSCRAPING_WAIT_PORT: '1' },
      { XPC_SERVICE_NAME: 'com.shortscraping.sync' }, { PORT: String(port) }]) {
      const passed = runGuarded(extra);
      assert.equal(passed.status, 42, `${JSON.stringify(extra)}\n${passed.stdout}${passed.stderr}`);
    }
    fs.rmSync(path.join(fakeBin, 'launchctl'));
    fs.writeFileSync(path.join(fakeBin, 'launchctl'), '#!/bin/sh\nexit 113\n', { mode: 0o755 }); // agent 未加载
    assert.equal(runGuarded({}).status, 42);
  }

  console.log('Server restart (respawn + launchd + log file + port clash + autostart guard) checks passed');
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
