import './bootstrap.cjs';
// server/tools/stop.js --restart 回归测试（npm run restart 与 restart-sync.command 共用这一入口）。
// 只测非 launchd 分支：SHORTSCRAPING_NO_LAUNCHD=1 加随机端口双保险，绝不碰本机真实的开机自启服务。
//   R1 端口上有旧实例：停掉后前台起新实例（pid 不同），--restart 之后的参数转给服务，服务退出码原样带回；
//   R2 端口空闲：直接前台启动；包装进程被单独 SIGTERM 时转给服务，不留孤儿占端口（仅 POSIX）；
//   R3 端口被别的服务占着：以 1 退出、不启动新实例（旧版 `stop.js && sync-server.js` 会照样启动，必然撞 EADDRINUSE）。
// 隔离方式：tests/server-fixture.mjs 的 os.tmpdir() 隔离树（多带一份 server/tools/stop.js），不碰真实 31919 与 db/。
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  SERVER_ARGS, freePort, makeIsolatedTree, launch as launchIn, health as healthAt, waitFor, alive, httpClient, terminate
} from './server-fixture.mjs';

const tree = makeIsolatedTree({ prefix: 'shortscraping-stop-restart-', files: ['server/tools/stop.js'] });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
// 夹具钉死 SHORTSCRAPING_PORT=targetPort、SHORTSCRAPING_NO_LAUNCHD=1、XPC_SERVICE_NAME=''，日志写进隔离树；
// child 上挂 output 与 exited。按进程判活用夹具的 alive：退出中的旧进程仍可能经 keep-alive 连接应答 /health
const launch = (args, targetPort = port) => launchIn(tree, args, { port: targetPort });
const health = () => healthAt(base);
const client = httpClient(base);

const children = [];
const serverPids = new Set();
let foreign = null;
try {
  // —— R1：替换正在运行的实例 ——
  const first = launch(SERVER_ARGS);
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
  const stopped = await client.request('/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
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
    await client.request('/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
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
  for (const child of children) await terminate(child);
  // stop.js 派生的服务是包装进程的子进程、不在夹具的登记里：按 pid 收尾
  for (const pid of serverPids) {
    try { process.kill(pid); } catch (_) { /* 已退出 */ }
  }
  if (foreign) await new Promise(resolve => foreign.close(resolve));
  tree.cleanup();
}
