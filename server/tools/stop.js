/**
 * ShortScraping Sync — 跨平台停止 / 重启助手
 *
 * 停止（默认）：通过本机 HTTP 优雅停止同步服务，无平台分支（Windows / macOS / Linux 通用）：
 *   1) GET /health 确认服务是否在运行；
 *   2) 在运行则 POST /shutdown 请服务自行退出（该接口仅本机可调用）；
 *   3) 轮询 /health 直到端口关闭，确认已停止。
 * 只会停掉本服务自身，不扫描端口、不误杀其他进程。
 *
 * 重启（--restart，npm run restart 与 restart-sync.command 共用这一份判断）：
 *   - macOS 已设置开机自启（LaunchAgent 已加载）：停掉端口上的实例后 launchctl kickstart -k，
 *     服务仍归 launchd 托管。若照旧「停止 + 前台启动」，launchd 实例以 0 退出不会被拉回，
 *     服务就变成随终端存亡的前台进程；
 *   - 其余情况：停止后在当前终端前台启动 sync-server.js（Ctrl+C 停止），--restart 之后的参数原样转给它。
 *
 * 用法：node server/tools/stop.js [--restart [服务参数...]]
 * 环境变量：SHORTSCRAPING_PORT 指定端口（与 sync-server.js 同名；不读通用的 PORT，免得继承别的项目的设置）；
 *   SHORTSCRAPING_NO_LAUNCHD=1 跳过 launchd 探测（测试用，免得碰到本机真实的自启服务；
 *   会传给前台启动的服务，它启动时的同款探测一并跳过，见 sync-server.js exitIfLaunchdAgentLoaded）
 */

const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_PORT = 31919;
const PORT = Number(process.env.SHORTSCRAPING_PORT) || DEFAULT_PORT;
const HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 2000;
const LAUNCHD_LABEL = 'com.shortscraping.sync'; // 与 setup-autostart.command、sync-server.js 保持一致
const LAUNCHD_LOG = path.join(os.homedir(), 'Library', 'Logs', 'ShortScraping', 'sync.log');
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const SERVER_SCRIPT = path.join(PROJECT_DIR, 'server', 'sync-server.js');

function request(method, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST, port: PORT, path: requestPath, method, timeout: REQUEST_TIMEOUT_MS,
        // 写接口统一要求 application/json：不留「简单请求免预检」的副作用通道
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {}
      },
      res => {
        let data = '';
        res.setEncoding('utf8'); // 跨块的多字节字符由内置解码器拼好，不会被拆成乱码
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 探测端口状态：
 *   'ours'    —— 本服务在运行（/health 返回 { ok: true }）
 *   'foreign' —— 端口被其他服务占用（有响应但不是我们的）
 *   'down'    —— 端口未监听（连接被拒）
 *   'unknown' —— 无法确认（超时等）
 */
async function probe() {
  try {
    const res = await request('GET', '/health');
    try {
      const parsed = JSON.parse(res.body || '{}');
      return parsed && parsed.ok === true ? 'ours' : 'foreign';
    } catch (_) {
      return 'foreign';
    }
  } catch (error) {
    if (error && error.code === 'ECONNREFUSED') return 'down';
    return 'unknown';
  }
}

/** 停掉端口上的本服务。返回初始探测状态，以及端口是否已确认空出 */
async function stopService() {
  const state = await probe();

  if (state === 'down') {
    console.log(`[ShortScraping Sync] 服务未运行（端口 ${PORT} 未监听）。`);
    return { state, freed: true };
  }

  if (state === 'foreign') {
    console.log(`[ShortScraping Sync] 端口 ${PORT} 被其他服务占用，未执行停止。`);
    return { state, freed: false };
  }

  if (state === 'unknown') {
    console.log(`[ShortScraping Sync] 无法确认服务状态（端口 ${PORT} 无正常响应），未执行停止。`);
    return { state, freed: false };
  }

  // state === 'ours'：请服务自行优雅退出
  try {
    await request('POST', '/shutdown');
  } catch (_) {
    // 服务可能在响应前就断开连接，继续轮询确认即可
  }

  for (let i = 0; i < 10; i += 1) {
    await delay(300);
    if ((await probe()) === 'down') {
      console.log('[ShortScraping Sync] 服务已停止。');
      return { state, freed: true };
    }
  }

  console.log(`[ShortScraping Sync] 已发送停止请求，但服务仍在端口 ${PORT} 响应。`);
  return { state, freed: false };
}

/** macOS 已设置开机自启时返回 LaunchAgent 的 launchctl 目标，否则 null */
function launchdTarget() {
  // plist 不带 SHORTSCRAPING_PORT，托管实例固定在默认端口；指定了别的端口说明要操作的是另一个前台实例
  if (process.platform !== 'darwin' || PORT !== DEFAULT_PORT || process.env.SHORTSCRAPING_NO_LAUNCHD === '1') {
    return null;
  }
  const target = `gui/${process.getuid()}/${LAUNCHD_LABEL}`;
  const result = spawnSync('launchctl', ['print', target], { stdio: 'ignore' });
  return result.status === 0 ? target : null;
}

async function restartViaLaunchd(target, serverArgs) {
  if (serverArgs.length > 0) {
    console.log(`[ShortScraping Sync] 开机自启模式按 plist 启动，忽略参数：${serverArgs.join(' ')}`);
  }
  // 端口上可能是脱离托管的前台实例（如旧版 npm run restart 起的）：不先停掉它，kickstart
  // 起来的实例撞端口后直接让位退出（sync-server 在 launchd 下以 0 退出），端口上留着的仍是
  // 旧实例，重启等于没做。托管实例被 /shutdown 以 0 退出后不会被自动拉回，交给下面的 kickstart 统一拉起
  const { freed } = await stopService();
  if (!freed) {
    console.log('[ShortScraping Sync] 端口未空出，未重启后台服务。');
    return 1;
  }

  const kick = spawnSync('launchctl', ['kickstart', '-k', target], { stdio: 'inherit' });
  if (kick.status !== 0) {
    console.log(`[ShortScraping Sync] launchctl kickstart 失败（${kick.error ? kick.error.message : `退出码 ${kick.status}`}）。`);
    return 1;
  }

  // 升级后新代码可能起不来：等到 /health 应答再报成功，否则指给用户去看日志
  for (let i = 0; i < 20; i += 1) {
    await delay(500);
    if ((await probe()) === 'ours') {
      console.log('[ShortScraping Sync] 已重启后台同步服务（开机自启）。');
      return 0;
    }
  }
  console.log(`[ShortScraping Sync] 已请求 launchd 重启，但 10 秒内未检测到服务，日志：${LAUNCHD_LOG}`);
  return 1;
}

/** 前台启动服务并等它结束：输出直接进当前终端，退出码 / 信号原样带回给 npm 与终端 */
function runForeground(serverArgs) {
  const child = spawn(process.execPath, [SERVER_SCRIPT, ...serverArgs], { cwd: PROJECT_DIR, stdio: 'inherit' });
  // 本进程只是壳：收到的信号转给服务。npm 被单独 kill 时只把信号转给本进程，不转发的话
  // 本进程一死服务就成了孤儿，继续占着端口
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const forward = signal => { child.kill(signal); };
  for (const signal of signals) process.on(signal, forward);

  child.on('error', error => {
    console.error(`[ShortScraping Sync] 启动失败：${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    for (const s of signals) process.off(s, forward);
    if (signal) {
      process.exitCode = 1; // 兜底：万一该信号的默认动作不是终止
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (PORT !== DEFAULT_PORT) {
    // 端口来自环境变量而非参数，终端里看不出来：说清楚这次操作的不是扩展连的那个服务
    console.log(`[ShortScraping Sync] 注意：按环境变量 SHORTSCRAPING_PORT 操作端口 ${PORT}（非默认 ${DEFAULT_PORT}），`
      + '扩展连接的默认端口服务与开机自启的后台服务不受影响。');
  }

  if (args[0] !== '--restart') {
    const { state, freed } = await stopService();
    // 端口被他人占用 / 状态未知时沿用 0：仅是「未执行停止」，不算停止失败
    process.exit(freed || state !== 'ours' ? 0 : 1);
  }

  const serverArgs = args.slice(1);
  const target = launchdTarget();
  if (target) {
    process.exit(await restartViaLaunchd(target, serverArgs));
  }

  const { freed } = await stopService();
  if (!freed) {
    // 端口没空出来就起新实例只会撞上 EADDRINUSE
    console.log('[ShortScraping Sync] 端口未空出，未启动新实例。');
    process.exit(1);
  }
  runForeground(serverArgs);
}

main();
