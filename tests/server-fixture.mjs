import './bootstrap.cjs';
// 服务端套件共用的隔离服务夹具（v1.6.20）。
// 此前 6 个服务端套件各抄一份「mkdtemp → 复制 sync-server.js 与 src/shared → 写 config →
// 随机端口 spawn → 等启动行 → kill + rm」，护栏各写各的：c6-sync / sync-backup / safety / cron
// 连 XPC_SERVICE_NAME 与 SHORTSCRAPING_LOG_FILE 都从外层继承（🔄 一旦被触发就写用户的 ~/Library/Logs）。
// 收拢到这里，护栏只写一处：
//   - 端口绝不是 31919（2026-07-15 事故预防纪律：测试不碰本机真实服务）；
//   - 隔离树必须在 os.tmpdir() 下，收尾的递归删除也只删这里建的目录（bootstrap.cjs 另有兜底）；
//   - 环境变量固定 SHORTSCRAPING_NO_LAUNCHD=1、XPC_SERVICE_NAME=''，日志写进隔离树。
// 棘轮 unit-test-infra-guard：除本文件外，任何测试不得再自己 spawn sync-server.js。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-port.mjs';
import { card, SUB } from './background-fixture.mjs';

// 服务端套件推的是扩展存下来的卡片形态：沿用后台夹具的 card / SUB，两边口径不漂移
export { card, SUB, freePort };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REAL_PORT = 31919;
export const SERVER_ARGS = Object.freeze(['server/sync-server.js', '--local-only']);
export const DEFAULT_TAGS = Object.freeze([{ url: SUB, tags: ['IMDB'] }]);
// 启动探针的预加载以此码退出（见 probeStartup）
export const PROBE_EXIT = 42;
const SYNCED_AT = '2026-08-01T00:00:00.000Z';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 套件中途抛错、没走到 finally 时的兜底：进程退出前把仍在跑的子进程全部 SIGKILL，不留孤儿占随机端口
// （run.mjs 按进程组杀只管超时这一种情况）。🔄 派生的脱离实例不是这里的子进程，由套件按 pid 收尾
const live = new Set();
process.on('exit', () => {
  for (const child of live) {
    try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
  }
});

function assertTestPort(port) {
  const value = Number(port);
  assert.ok(Number.isInteger(value) && value > 0 && value < 65536, `测试端口无效：${port}`);
  assert.notEqual(value, REAL_PORT, '测试绝不能用本机真实端口 31919');
  return value;
}

// os.tmpdir() 在 macOS 上是 /var/folders/… 的符号链接，真实路径在 /private 下：两种写法都认
function assertInsideTmp(dir) {
  const resolved = path.resolve(dir);
  const inside = [path.resolve(os.tmpdir()), fs.realpathSync(os.tmpdir())].some(root => {
    const relative = path.relative(root, resolved);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  assert.ok(inside, `隔离树必须在 os.tmpdir() 下：${resolved}`);
}

// 种子文件：字符串原样写（坏 JSON、BOM 等用例要逐字节控制），其余按 JSON 写
function writeSeeds(dir, sub, seeds) {
  for (const [name, value] of Object.entries(seeds || {})) {
    const file = path.join(dir, sub, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
}

/**
 * 在 os.tmpdir() 下建一棵能直接跑 sync-server.js 的隔离树。
 * files：额外复制的仓库相对路径（如 server/tools/stop.js）；config / db：{文件名: 内容} 的种子，
 * config 缺省只写 tag.json（DEFAULT_TAGS），传 {} 则连 tag.json 都不写。
 */
export function makeIsolatedTree({ prefix = 'shortscraping-', files = [], config = { 'tag.json': DEFAULT_TAGS }, db = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  assertInsideTmp(dir);
  for (const rel of ['server', 'src/shared', 'config', 'db']) fs.mkdirSync(path.join(dir, rel), { recursive: true });
  const copy = rel => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  };
  copy('server/sync-server.js');
  for (const rel of files) copy(rel);
  // 整目录复制 src/shared：新增共享模块时不必再逐个套件维护复制清单
  for (const name of fs.readdirSync(path.join(ROOT, 'src/shared'))) copy(`src/shared/${name}`);
  writeSeeds(dir, 'config', config);
  writeSeeds(dir, 'db', db);
  const tree = {
    dir,
    // logs/ 故意不预建：服务端要自己 mkdir -p（unit-server-restart 验这一点）
    logFile: path.join(dir, 'logs/sync.log'),
    p: rel => path.join(dir, rel),
    read: rel => fs.readFileSync(path.join(dir, rel), 'utf8'),
    readJson: rel => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')),
    cleanup() {
      assertInsideTmp(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  return tree;
}

/**
 * 子进程环境：继承外层，再钉死端口与自启相关的变量；extra 最后合入（按用例改 XPC_SERVICE_NAME、日志路径等）。
 * 合入后仍校验端口：extra 也不能把服务带到 31919。
 */
export function serverEnv(port, extra = {}) {
  const env = { ...process.env, SHORTSCRAPING_PORT: String(port), SHORTSCRAPING_NO_LAUNCHD: '1', XPC_SERVICE_NAME: '' };
  // 🔄 接替实例的内部标记不能从外层 shell 漏进来：端口占用会变成 10 秒重试，自启守卫也被跳过
  delete env.SHORTSCRAPING_WAIT_PORT;
  Object.assign(env, extra);
  assertTestPort(env.SHORTSCRAPING_PORT);
  return env;
}

/**
 * 在隔离树里起一个 node 子进程（默认 sync-server.js --local-only；stop-restart 用来跑 server/tools/stop.js）。
 * 返回的 child 挂着 port / base、合并后的 output（stdout+stderr 按到达顺序）、clearOutput()、exited（once 'exit'）。
 */
export function launch(tree, args = SERVER_ARGS, { port, env = {} } = {}) {
  assertInsideTmp(tree.dir);
  const childEnv = serverEnv(port, { SHORTSCRAPING_LOG_FILE: tree.logFile, ...env });
  const child = spawn(process.execPath, args, {
    cwd: tree.dir, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.port = Number(childEnv.SHORTSCRAPING_PORT);
  child.base = `http://127.0.0.1:${child.port}`;
  child.output = '';
  child.clearOutput = () => { child.output = ''; };
  // setEncoding 走 StringDecoder：多字节汉字跨 chunk 时不会被逐块 toString 拆成 �
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => { child.output += chunk; });
  }
  child.exited = once(child, 'exit');
  child.exited.catch(() => {}); // spawn 失败时 once 会 reject：没人 await 也不该变成未处理的 rejection
  live.add(child);
  child.once('exit', () => live.delete(child));
  return child;
}

/** 等启动行出现（probeHealth 时再要 /health 返回 2xx）；子进程先退出则带着它的输出抛错。 */
export async function waitStarted(child, { timeoutMs = 10000, probeHealth = false } = {}) {
  const line = `服务已启动：${child.base}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`隔离服务退出（${child.exitCode ?? child.signalCode}）：${child.output}`);
    }
    if (child.output.includes(line) && (!probeHealth || await healthOk(child.base))) return;
    if (Date.now() > deadline) throw new Error(`隔离服务 ${timeoutMs}ms 内未就绪：${child.output}`);
    await sleep(25);
  }
}

export async function waitFor(predicate, timeoutMs, label) {
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
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

/** /health 的 JSON（不看状态码），连不上 / 超时返回 null。 */
export async function health(base, timeoutMs = 1000) {
  try {
    const response = await fetch(base + '/health', { signal: AbortSignal.timeout(timeoutMs) });
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function healthOk(base) {
  try {
    return (await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })).ok;
  } catch (_) {
    return false; // 未就绪，继续等
  }
}

/** 结束子进程并等它真正退出；SIGTERM 超时不退再 SIGKILL，收尾不会挂住。已退出的直接返回。 */
export async function terminate(child, { timeoutMs = 5000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').catch(() => {});
  child.kill();
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
  }, timeoutMs);
  await exited;
  clearTimeout(timer);
}

/**
 * HTTP 小客户端。post 发 JSON 体，Content-Type 默认 application/json，headers 同名键覆盖
 * （Origin / Content-Type / Sec-Fetch-Site 等写入护栏用例原样透传）；request 给原样字符串体或要读原始 Response 的用例。
 * 每个请求默认 3 秒超时：服务挂住时报错而不是等到 run.mjs 60 秒整组 SIGKILL。
 */
export function httpClient(base, { timeoutMs = 3000 } = {}) {
  const request = (route, { method = 'GET', headers = {}, body, timeoutMs: ms = timeoutMs } = {}) =>
    fetch(base + route, { method, headers, body, signal: AbortSignal.timeout(ms) });
  const client = {
    base,
    request,
    async post(route, payload, headers = {}, options = {}) {
      const response = await request(route, {
        ...options, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload)
      });
      return { status: response.status, body: await response.json() };
    },
    async getJson(route, options) {
      return (await request(route, options)).json();
    },
    // extra 合入请求体（allowEmpty 等）；返回体上挂 status，409 与 200 的区分要看它
    async postSync(dramas, extra = {}) {
      const response = await request('/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dramas, syncedAt: SYNCED_AT, ...extra })
      });
      return { status: response.status, ...(await response.json()) };
    },
    timeline: () => client.getJson('/api/timeline'),
    health: ms => health(base, ms)
  };
  return client;
}

/**
 * 一步到位：随机端口 + 隔离树 + 启动 + 等就绪。返回值带 httpClient 的全部方法，外加
 * proc / output（跟随当前实例）、clearOutput()、restart(whileStopped)、stop()。
 * 启动失败时自己收尾（杀进程、删树）再抛：调用方还没拿到句柄，finally 管不到。
 */
export async function startIsolatedServer({ args = SERVER_ARGS, env = {}, probeHealth = true, timeoutMs, ...treeOptions } = {}) {
  const port = assertTestPort(await freePort());
  const tree = makeIsolatedTree(treeOptions);
  const base = `http://127.0.0.1:${port}`;
  let proc = null;
  const boot = async () => {
    proc = launch(tree, args, { port, env });
    await waitStarted(proc, { timeoutMs, probeHealth });
  };
  const server = {
    ...httpClient(base),
    port,
    base,
    tree,
    get proc() { return proc; },
    get output() { return proc ? proc.output : ''; },
    clearOutput() { proc?.clearOutput(); },
    // 同一棵树、同一端口停了再起（「重启后」的行为）；whileStopped 在停机期间改盘，新实例输出从空开始
    async restart(whileStopped) {
      await terminate(proc);
      if (whileStopped) await whileStopped();
      await boot();
    },
    async stop() {
      await terminate(proc);
      tree.cleanup();
    }
  };
  try {
    await boot();
  } catch (error) {
    await server.stop();
    throw error;
  }
  return server;
}

/**
 * 启动探针：只走 sync-server.js 的启动路径、绝不真监听。预加载把 net.Server.prototype.listen
 * 换成「打印 LISTEN:<端口> 后以 PROBE_EXIT 退出」，所以落到默认端口 31919 的用例也碰不到本机真实服务。
 * 端口解析 / 自启守卫这类用例要删掉夹具钉死的变量（unset），故不走 serverEnv。
 */
export function probeStartup(tree, { env = {}, unset = [], args = SERVER_ARGS, timeoutMs = 10000 } = {}) {
  assertInsideTmp(tree.dir);
  const preload = tree.p('probe-listen.cjs');
  if (!fs.existsSync(preload)) {
    fs.writeFileSync(preload, `require('net').Server.prototype.listen = function (p) { console.log('LISTEN:' + p); process.exit(${PROBE_EXIT}); };\n`);
  }
  const baseEnv = { ...process.env, XPC_SERVICE_NAME: '', SHORTSCRAPING_LOG_FILE: tree.logFile };
  for (const key of unset) delete baseEnv[key];
  const run = spawnSync(process.execPath, ['-r', preload, ...args], {
    cwd: tree.dir, env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: timeoutMs
  });
  const listened = /LISTEN:(\d+)/.exec(run.stdout || '');
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, port: listened ? Number(listened[1]) : null };
}
