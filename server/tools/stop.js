/**
 * ShortScraping Sync — 跨平台停止助手
 *
 * 通过本机 HTTP 优雅停止同步服务，无平台分支（Windows / macOS / Linux 通用）：
 *   1) GET /health 确认服务是否在运行；
 *   2) 在运行则 POST /shutdown 请服务自行退出（该接口仅本机可调用）；
 *   3) 轮询 /health 直到端口关闭，确认已停止。
 * 只会停掉本服务自身，不扫描端口、不误杀其他进程。
 *
 * 用法：node server/tools/stop.js
 */

const http = require('http');

const PORT = Number(process.env.PORT) || 31919;
const HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 2000;

function request(method, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path: requestPath, method, timeout: REQUEST_TIMEOUT_MS },
      res => {
        let data = '';
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

async function main() {
  const state = await probe();

  if (state === 'down') {
    console.log(`[ShortScraping Sync] 服务未运行（端口 ${PORT} 未监听）。`);
    process.exit(0);
  }

  if (state === 'foreign') {
    console.log(`[ShortScraping Sync] 端口 ${PORT} 被其他服务占用，未执行停止。`);
    process.exit(0);
  }

  if (state === 'unknown') {
    console.log(`[ShortScraping Sync] 无法确认服务状态（端口 ${PORT} 无正常响应），未执行停止。`);
    process.exit(0);
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
      process.exit(0);
    }
  }

  console.log(`[ShortScraping Sync] 已发送停止请求，但服务仍在端口 ${PORT} 响应。`);
  process.exit(1);
}

main();
