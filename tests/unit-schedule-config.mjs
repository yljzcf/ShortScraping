import './bootstrap.cjs';
import { startIsolatedServer } from './server-fixture.mjs';
// B4 回归测试：schedule-config.js 三端归一（require 直载）+ /config/cron 写回端点
// （tmpdir 隔离服务，随机端口）。cron 解析语义与 background 原实现全等由
// unit-maint-batch1（A-1/A-10 用例）复跑守护。
// 用法：node tests/unit-schedule-config.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SC = require(path.join(worktreeRoot, 'src/shared/schedule-config.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ---------- T1 合法表达式解析与下一次执行（固定 fromDate 已知答案） ----------
const FROM = new Date('2026-08-01T10:20:30');
const nextOf = (expr) => new Date(SC.getNextCronRun(expr, FROM));
check('T1a 45 * * * * → 同小时 45 分', nextOf('45 * * * *').getTime() === new Date('2026-08-01T10:45:00').getTime(), String(nextOf('45 * * * *')));
check('T1b */15 分步长 → 10:30', nextOf('*/15 * * * *').getTime() === new Date('2026-08-01T10:30:00').getTime(), String(nextOf('*/15 * * * *')));
check('T1c 工作日 9-18/3 点 → 下个周一 9 点（8/1 是周六）', nextOf('0 9-18/3 * * 1-5').getTime() === new Date('2026-08-03T09:00:00').getTime(), String(nextOf('0 9-18/3 * * 1-5')));
check('T1d 每月 1,15 号 → 8/15', nextOf('0 0 1,15 * *').getTime() === new Date('2026-08-15T00:00:00').getTime(), String(nextOf('0 0 1,15 * *')));
check('T1e 星期 7 归一为周日 → 8/2', nextOf('0 12 * * 7').getTime() === new Date('2026-08-02T12:00:00').getTime(), String(nextOf('0 12 * * 7')));
// T1f 闰日跨过一个以上平年：旧的 366 天查找窗口会抛「无法计算下一次 Cron 执行时间」，
// 与解析期「2/29 合法」的放行自相矛盾（validateConfig 拒绝保存、手改进 cron.json 则后台静默降级为间隔）
let leapNext = null;
try { leapNext = new Date(SC.getNextCronRun('0 0 29 2 *', new Date('2026-09-25T10:00:00'))); } catch (e) { leapNext = e.message; }
check('T1f 0 0 29 2 * 从 2026-09-25 起算 → 2028-02-29',
  leapNext instanceof Date && leapNext.getTime() === new Date('2028-02-29T00:00:00').getTime(), String(leapNext));

// ---------- T2 非法表达式解析期报错 ----------
const throws = (expr) => { try { SC.parseSimpleCron(expr); return false; } catch { return true; } };
check('T2a 4 段拒绝', throws('* * * *'), '');
check('T2b 分钟越界拒绝', throws('60 * * * *'), '');
check('T2c 步长 0 拒绝', throws('*/0 * * * *'), '');
check('T2d 日期×月份永不匹配拒绝（0 0 31 2 *）', throws('0 0 31 2 *'), '');
check('T2e 闰年 2/29 合法', !throws('0 0 29 2 *'), '');
// T2f-T2l 旧实现用 Number() 解析数字片段，写错的表达式被静默改义：'45,' 成 {45,0}、'-5' 成 0-5、
// '1-2-3' 成 1-2、'5/15' 只取 5、'0x1f' 成 31、'1e1' 成 10
check('T2f 多余逗号 / 空列表项拒绝（45, 与 1,,2）', throws('45, * * * *') && throws('1,,2 * * * *') && throws(',5 * * * *'), '');
check('T2g 半开区间拒绝（-5 与 5-）', throws('-5 * * * *') && throws('5- * * * *'), '');
check('T2h 多段区间拒绝（1-2-3）', throws('1-2-3 * * * *'), '');
check('T2i 十六进制 / 指数写法拒绝（0x1f、1e1、*/1e1）', throws('0x1f * * * *') && throws('1e1 * * * *') && throws('*/1e1 * * * *'), '');
let singleStepMsg = '';
try { SC.parseSimpleCron('5/15 * * * *'); } catch (e) { singleStepMsg = e.message; }
check('T2j 单值带步长（5/15）拒绝并提示区间写法 5-59/15', singleStepMsg.includes('5-59/15'), singleStepMsg);
check('T2k 合法写法不受收紧影响（前导零 / 区间步长 / 列表 / */n）',
  !throws('05 * * * *') && !throws('0-59/5 * * * *') && !throws('0 9-18/3 * * 1-5') && !throws('0 0 1,15 * *') && !throws('15 */2 * * *'), '');
check('T2l 收紧后 validateConfig 同样拒收（设置页 / 同步服务写回走这条）',
  SC.validateConfig({ scheduleMode: 'cron', scrapeCron: '45, * * * *', translateCron: '50 * * * *' }).ok === false, '');

// ---------- T3 normalizeConfig 回落与 validateConfig 分支 ----------
const norm = SC.normalizeConfig({ scheduleMode: 'weird', scrapeInterval: -1, translateCron: '  50 * * * *  ' });
check('T3a mode 怪值回落 interval、负数回落默认、cron 串 trim',
  norm.scheduleMode === 'interval' && norm.scrapeInterval === 6 && norm.translateCron === '50 * * * *', JSON.stringify(norm));
const vCronBad = SC.validateConfig({ scheduleMode: 'cron', scrapeCron: '61 * * * *', translateCron: '50 * * * *' });
check('T3b cron 模式坏表达式按字段报错', vCronBad.ok === false && /分钟/.test(vCronBad.errors.scrapeCron) && !vCronBad.errors.translateCron, JSON.stringify(vCronBad.errors));
const vCronOk = SC.validateConfig({ scheduleMode: 'cron', scrapeCron: '45 * * * *', translateCron: '50 * * * *' });
check('T3c cron 模式合法通过', vCronOk.ok === true, '');
const vInterval = SC.validateConfig({ scheduleMode: 'interval', scrapeCron: 'garbage' });
check('T3d interval 模式不校验 cron 串（宽松保留）', vInterval.ok === true, JSON.stringify(vInterval.errors));
check('T3e DEFAULT_CONFIG 与旧 background/settings 副本同值',
  JSON.stringify(SC.DEFAULT_CONFIG) === JSON.stringify({ scheduleMode: 'interval', scrapeInterval: 6, translateInterval: 1, scrapeCron: '45 * * * *', translateCron: '50 * * * *' }), '');

// ---------- T4 /config/cron 端点（隔离服务） ----------
{
  // 只要 cron 端点：不写 tag.json；与迁移前一样只等启动行，不额外探 /health
  const server = await startIsolatedServer({ prefix: 'shortscraping-cron-', config: {}, probeHealth: false });
  const cronPath = server.tree.p('config/cron.json');
  try {
    const post = async (scheduleConfig) => server.post('/config/cron', { scheduleConfig });

    const good = await post({ scheduleMode: 'cron', scrapeCron: '10 3 * * *', translateCron: '20 3 * * *', scrapeInterval: 6, translateInterval: 1 });
    const written = JSON.parse(fs.readFileSync(cronPath, 'utf8'));
    check('T4a 合法配置 200 且落盘匹配', good.status === 200 && good.body.ok === true && written.scrapeCron === '10 3 * * *', JSON.stringify(written));

    const bad = await post({ scheduleMode: 'cron', scrapeCron: '61 * * * *', translateCron: '20 3 * * *' });
    const stillWritten = JSON.parse(fs.readFileSync(cronPath, 'utf8'));
    check('T4b 非法 cron 500 且文件未变', bad.status === 500 && bad.body.ok === false && /分钟/.test(bad.body.error) && stillWritten.scrapeCron === '10 3 * * *', JSON.stringify(bad.body));

    const res = await server.request('/config/cron', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
    check('T4c 非 JSON 体 500', res.status === 500, String(res.status));
  } finally {
    await server.stop();
  }
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
