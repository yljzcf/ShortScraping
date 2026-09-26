import './bootstrap.cjs';
// 同步服务 POST /restart 回归测试（v1.6.13，弹窗 🔄）。
//   respawn 模式（前台 / Windows）：旧实例派生脱离的新实例后以 0 退出，新实例等端口空出后接管；
//   launchd 模式（macOS 开机自启）：以 75 退出交给 launchd 拉起，自身不派生（否则会和 launchd 抢端口）。
//   respawn 的新实例转入后台，stdout/stderr 写进日志文件（此前是 stdio:'ignore'，启动报错全丢）；
//   日志打不开 / 派生失败时回 500、旧实例不退出；launchd 拉起却撞上前台实例占端口时以 0 退出，免得崩溃循环；
//   已设开机自启（LaunchAgent 已加载）时 npm run sync 提示改用 npm run restart 后退出，不另起前台实例（仅 darwin）；
//   端口只认 SHORTSCRAPING_PORT：shell 里的通用 PORT 不再把服务带到扩展连不上的端口、也绕不过上面的守卫。
// 隔离方式：tests/server-fixture.mjs 的 os.tmpdir() 隔离树、随机端口，不碰真实 31919 与 db/；
// SHORTSCRAPING_LOG_FILE 指到隔离树（夹具默认），不写用户的 ~/Library/Logs。
// 多实例轮流占同一端口，所以只用夹具的 tree / launch / 探针，不用 startIsolatedServer。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import {
  SERVER_ARGS, PROBE_EXIT, freePort, makeIsolatedTree, launch, health as healthAt, waitFor, alive, httpClient, terminate, probeStartup
} from './server-fixture.mjs';

const tree = makeIsolatedTree({ prefix: 'shortscraping-restart-' }); // config/tag.json 用夹具默认的 SUB → IMDB
const directory = tree.dir;
const logFile = tree.logFile; // 隔离树里的 logs/sync.log，目录故意不预建：服务端要自己 mkdir -p

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 夹具钉死 SHORTSCRAPING_PORT、XPC_SERVICE_NAME=''、SHORTSCRAPING_LOG_FILE；extraEnv 按用例覆盖
const start = extraEnv => launch(tree, SERVER_ARGS, { port, env: extraEnv });
const health = () => healthAt(base);
const client = httpClient(base);
const post = route => client.post(route, {});

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

  // —— 端口只认专用的 SHORTSCRAPING_PORT：shell 里给别的项目 export 的通用 PORT 不再被继承 ——
  // 夹具的启动探针把 listen 换成「打印端口后以 42 退出」：落到默认端口的那一例也绝不会真去监听本机 31919
  const listenPort = extra => {
    const run = probeStartup(tree, {
      env: { SHORTSCRAPING_NO_LAUNCHD: '1', ...extra }, unset: ['PORT', 'SHORTSCRAPING_PORT', 'SHORTSCRAPING_WAIT_PORT']
    });
    assert.equal(run.status, PROBE_EXIT, run.stdout + run.stderr);
    return run.port;
  };
  assert.equal(listenPort({ PORT: String(port) }), 31919); // 旧实现会跑到 PORT 指定的端口，扩展连不上
  assert.equal(listenPort({ SHORTSCRAPING_PORT: String(port) }), port);
  assert.equal(listenPort({ PORT: '3000', SHORTSCRAPING_PORT: String(port) }), port);
  // 非默认端口启动时告警：扩展只连 31919（上面各实例都跑在随机端口，启动输出里都该有这一行）
  assert.match(first.output, /当前监听非默认端口 \d+（来自环境变量 SHORTSCRAPING_PORT），扩展只连 31919/);

  // —— 已设开机自启时拒绝另起前台实例：只在 darwin + 默认端口下探测 launchctl ——
  // 探测目标是默认端口，也就是本机真实的 31919：launchctl 换成 PATH 前置的假脚本（不碰本机真实的
  // LaunchAgent），再用夹具的启动探针拦下 listen（以 42 退出）——守卫失效也绝不会真去监听
  if (process.platform === 'darwin') {
    const fakeBin = path.join(directory, 'fake-bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'launchctl'),
      '#!/bin/sh\n[ "$1" = print ] && [ "${2##*/}" = com.shortscraping.sync ] && exit 0\nexit 1\n', { mode: 0o755 });
    // 外层环境若带着 SHORTSCRAPING_NO_LAUNCHD 也一并删：这里测的正是没有逃生口时的守卫
    const runGuarded = extra => probeStartup(tree, {
      env: { PATH: `${fakeBin}:${process.env.PATH}`, ...extra },
      unset: ['PORT', 'SHORTSCRAPING_PORT', 'SHORTSCRAPING_WAIT_PORT', 'SHORTSCRAPING_NO_LAUNCHD']
    });
    const refusedStart = runGuarded({});
    assert.equal(refusedStart.status, 1, refusedStart.stdout + refusedStart.stderr);
    assert.match(refusedStart.stderr, /已设置 macOS 开机自启/);
    assert.match(refusedStart.stderr, /npm run restart/);
    assert.match(refusedStart.stderr, /SHORTSCRAPING_NO_LAUNCHD=1/); // 前台调试的逃生口写在提示里
    // 放行：前台调试开关、🔄 接替实例、launchd 自己拉起的实例、与 plist 不相撞的自定义端口——都走到 listen 被预加载拦下
    for (const extra of [{ SHORTSCRAPING_NO_LAUNCHD: '1' }, { SHORTSCRAPING_WAIT_PORT: '1' },
      { XPC_SERVICE_NAME: 'com.shortscraping.sync' }, { SHORTSCRAPING_PORT: String(port) }]) {
      const passed = runGuarded(extra);
      assert.equal(passed.status, 42, `${JSON.stringify(extra)}\n${passed.stdout}${passed.stderr}`);
    }
    // 通用 PORT 不再算「自定义端口」：服务仍落在默认端口、与后台服务相撞，照样拒绝另起前台实例
    const genericPort = runGuarded({ PORT: String(port) });
    assert.equal(genericPort.status, 1, genericPort.stdout + genericPort.stderr);
    assert.match(genericPort.stderr, /已设置 macOS 开机自启/);
    fs.rmSync(path.join(fakeBin, 'launchctl'));
    fs.writeFileSync(path.join(fakeBin, 'launchctl'), '#!/bin/sh\nexit 113\n', { mode: 0o755 }); // agent 未加载
    assert.equal(runGuarded({}).status, 42);
  }

  console.log('Server restart (respawn + launchd + log file + port clash + autostart guard) checks passed');
} finally {
  for (const child of children) await terminate(child);
  // 🔄 派生的新实例已脱离、不是本进程的子进程：按 pid 收尾
  if (respawnedPid) {
    try { process.kill(respawnedPid); } catch (_) { /* 已退出 */ }
  }
  tree.cleanup();
}
