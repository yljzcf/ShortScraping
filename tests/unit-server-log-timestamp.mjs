import './bootstrap.cjs';
import { startIsolatedServer } from './server-fixture.mjs';
// 同步服务日志带本地时间（v1.7.4）。
//
// 起因（2026-10-02 体检）：launchd 与 🔄 接替实例都把 stdout / stderr 追加进 ~/Library/Logs/ShortScraping/sync.log，
// 可每行都没有时间，重启、骤降告警是哪天几点发生的、谁先谁后都看不出来。现在 console.log / info / warn / error
// 每行前面加 [YYYY-MM-DD HH:mm:ss]（本地时间），原有文案一字不改。
//
//   S1 启动行带时间前缀，前缀后面仍是原样的「[ShortScraping Sync] 服务已启动：…」
//   S2 stdout 与 stderr 的每一行都带前缀（非默认端口的启动告警走 console.warn）
//   S3 前缀是本地时间，与此刻相差不超过 2 分钟
//
// 隔离方式：tests/server-fixture.mjs（os.tmpdir() 隔离树 + 随机端口，绝不碰 31919 与真实 db/）。
// 用法：node tests/unit-server-log-timestamp.mjs

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);

const STAMP = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\] /;
const server = await startIsolatedServer({ prefix: 'shortscraping-logstamp-' });
try {
  const lines = server.output.split(/\r?\n/).filter(line => line.trim());
  const started = lines.find(line => line.includes('服务已启动：'));
  check('S1 启动行带时间前缀，后面仍是原样文案',
    Boolean(started) && new RegExp(`${STAMP.source}\\[ShortScraping Sync\\] 服务已启动：${server.base.replace(/[.]/g, '\\.')}`).test(started),
    show(started));
  const bare = lines.filter(line => !STAMP.test(line));
  check('S2 输出的每一行都带时间前缀（含 console.warn 的启动告警）',
    lines.length >= 2 && bare.length === 0 && lines.some(line => line.includes('31919')), show({ bare, lines }));
  const match = STAMP.exec(started || '');
  const stampedAt = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])).getTime()
    : NaN;
  check('S3 前缀是本地时间，与此刻相差不超过 2 分钟', Math.abs(Date.now() - stampedAt) < 120000, show({ started, stampedAt }));
} finally {
  await server.stop();
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
