import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(directory).filter(name => /^unit-.*\.mjs$/.test(name)).sort();

// POSIX 上每个套件自成进程组组长（detached）：超时时按组杀，连同它派生的 sync-server 孙进程。
// 只杀套件本身的话，孙进程成了孤儿继续占着随机端口（SSE 心跳让它一直活着），
// 孙进程若继承了套件的 stdio，这里还会一直等不到 close。
// Windows 的 detached 意味着新控制台且没有进程组信号，改用 taskkill /T 按父子关系整棵杀
const GROUP_KILL = process.platform !== 'win32';
let running = null;

function killSuite(child, signal) {
  if (!GROUP_KILL) {
    const result = spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    if (result.error || result.status !== 0) child.kill();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (_) {
    // ESRCH：整组都已退出，没有要杀的了
  }
}

// 套件不在终端的前台进程组里了，Ctrl+C 等信号不会再直接送到它：转给当前套件整组，
// 再按原信号结束本进程（退出状态与以前被信号终止时一致）
if (GROUP_KILL) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      if (running) killSuite(running, signal);
      process.kill(process.pid, signal);
    });
  }
}

let failed = 0;
for (const file of files) {
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(directory, file)], {
      cwd: path.dirname(directory), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: GROUP_KILL
    });
    running = child;
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => killSuite(child, 'SIGKILL'), 60000);
    child.on('error', error => { clearTimeout(timer); resolve({ code: 1, output: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  running = null;
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${file}`);
  if (result.code !== 0) { failed++; console.log(result.output); }
}
console.log(`${files.length - failed}/${files.length} suites passed`);
process.exitCode = failed ? 1 : 0;
