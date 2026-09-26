import './bootstrap.cjs';
// 维护批次 1（P0）回归测试：共用 background-fixture 跑真实 background.js（v1.6.20 起不再手搓 chrome 桩）。
//   A-1 非法 cron 不得瘫痪调度：看门狗最先装、坏任务降级为间隔、好任务不受连累
//   A-2 tag.json 读取失败不得清库：失败保留订阅跳过 prune；读到合法数组才允许 prune
//   A-10 永不匹配的日期×月份组合在解析期快速报错（不空转 52.7 万次）
// 用法：node tests/unit-maint-batch1.mjs（修复前跑应 RED，修复后全 PASS）
import { background } from './background-fixture.mjs';

// ---------- 未捕获 rejection 计数（A-1 的 onAlarm 加固断言用；vm 上下文里的 promise 同样上报到本进程） ----------
let unhandledCount = 0;
process.on('unhandledRejection', (e) => { unhandledCount++; console.error('UNHANDLED:', e?.message || e); });

// fetch 桩：按文件名分派，tagJsonBehavior 可在用例间切换
//   'throw'   -> 读取失败（网络/文件异常）
//   'invalid' -> HTTP 200 但 JSON 不是数组（结构损坏）
//   数组      -> 正常返回该数组
let tagJsonBehavior = 'throw';

// ---------- 加载真实生产代码（夹具经 importScripts 载入全部共享模块，translator 用替身） ----------
const bg = await background({
  // 真定时器：顶层初始化与闹钟回调里的真实等待照常跑；tick:1 保持手搓桩「让出一拍再读写」的时序
  timers: 'real',
  storage: { tick: 1 },
  translator: { async translateTitleAndDesc() { return { title: '', desc: '' }; } },
  fetch: async (url) => {
    const u = String(url);
    if (u.includes('tag.json')) {
      if (tagJsonBehavior === 'throw') throw new TypeError('unit stub: tag.json unreachable');
      if (tagJsonBehavior === 'invalid') return { ok: true, json: async () => ({ not: 'an array' }) };
      return { ok: true, json: async () => structuredClone(tagJsonBehavior) };
    }
    throw new TypeError('unit stub: no network'); // cron/trans 走默认配置回退
  }
});
// 后台顶层函数声明是 vm 上下文的全局属性，直接取来调
const { loadConfigFromJsonFiles, setupAlarms, ScheduleConfig } = bg.context;
const alarmStore = bg.alarms; // 夹具的闹钟表（name → alarm）

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700); // 等顶层 loadConfigFromJsonFiles().then(setupAlarms) 与 CSV 预热落定

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const SUB = 'https://unit.test/list';
const mk = (n, over = {}) => ({
  id: `id-${n}`, itemId: `tt000${n}`, title: `Title ${n}`, description: '',
  status: 'trans', source: 'unittest', sourceListUrl: SUB, tags: ['T'], ...over
});

// ============ A-2：tag.json 读取失败不清库 ============
// 直改 storage 里的 dramas 表前先让队列内存缓存失效（v1.5.1 引入的缓存；含在飞写回之后）
await bg.resetDramasCache();
bg.storage.seed({ urlTags: [{ urlPattern: SUB, tags: ['T'] }] });
bg.seedDramas([mk(1), mk(2), mk(3, { sourceListUrl: 'https://other.example/x' })]);

// T1a 读取失败（fetch 异常）：dramas 与 urlTags 都必须原样保留
tagJsonBehavior = 'throw';
await loadConfigFromJsonFiles();
check('T1a fetch 异常时不清库（3 条全保留）', (bg.dramas() || []).length === 3, `dramas=${bg.dramas()?.length}`);
check('T1b fetch 异常时保留上次订阅', bg.data.urlTags?.length === 1 && bg.data.urlTags[0].urlPattern === SUB, JSON.stringify(bg.data.urlTags));

// T1c JSON 结构损坏（非数组）：同样视为读取失败
tagJsonBehavior = 'invalid';
await loadConfigFromJsonFiles();
check('T1c 非数组 JSON 视为失败不清库', (bg.dramas() || []).length === 3, `dramas=${bg.dramas()?.length}`);

// T1d 正常读到数组：prune 照常工作，界外历史被清理
tagJsonBehavior = [{ url: SUB, tags: ['T'] }];
await loadConfigFromJsonFiles();
const idsAfter = (bg.dramas() || []).map(d => d.itemId).sort();
check('T1d 读取成功时 prune 生效（界外 tt0003 被清）', idsAfter.join(',') === 'tt0001,tt0002', idsAfter.join(','));

// T1e 合法空数组＝用户主动清空订阅：允许清库（既定语义不回归）
tagJsonBehavior = [];
await loadConfigFromJsonFiles();
check('T1e 合法空数组仍按零订阅清库', (bg.dramas() || []).length === 0, `dramas=${bg.dramas()?.length}`);

// ============ A-1：非法 cron 不瘫痪调度 ============
// 夹具的 SW 时钟是固定时刻：对齐到真实当前时间，T2c 才能照旧拿真实 Date.now() 判「时间在未来」
bg.setTime(Date.now());
// T2a 抓取 cron 非法、翻译 cron 合法：看门狗在、翻译一次性 alarm 在、抓取降级为间隔
alarmStore.clear();
bg.storage.seed({ scheduleConfig: { scheduleMode: 'cron', scrapeCron: 'not a cron', translateCron: '50 * * * *', scrapeInterval: 6, translateInterval: 1 } });
await setupAlarms();
{
  const wd = alarmStore.get('watchdog');
  const sc = alarmStore.get('scrape-task');
  const tr = alarmStore.get('translate-task');
  check('T2a1 看门狗已安装', Boolean(wd), JSON.stringify(wd));
  check('T2a2 坏 cron 任务降级为间隔（6h 周期）', sc?.periodInMinutes === 360, JSON.stringify(sc));
  check('T2a3 好 cron 任务不受连累（一次性 alarm，分钟=50）',
    Boolean(tr) && !tr.periodInMinutes && new Date(tr.scheduledTime).getMinutes() === 50, JSON.stringify(tr));
}

// T2b 两个 cron 都非法：全部降级，无一失踪
alarmStore.clear();
bg.storage.seed({ scheduleConfig: { scheduleMode: 'cron', scrapeCron: '99 * * * *', translateCron: '* * * 13 *', scrapeInterval: 6, translateInterval: 1 } });
await setupAlarms();
check('T2b 双坏 cron 全部降级（watchdog+2 个周期 alarm）',
  Boolean(alarmStore.get('watchdog')) &&
  alarmStore.get('scrape-task')?.periodInMinutes === 360 &&
  alarmStore.get('translate-task')?.periodInMinutes === 60,
  JSON.stringify([...alarmStore.values()]));

// T2c 合法 cron 正常工作（回归保护）
alarmStore.clear();
bg.storage.seed({ scheduleConfig: { scheduleMode: 'cron', scrapeCron: '45 * * * *', translateCron: '50 * * * *' } });
await setupAlarms();
{
  const sc = alarmStore.get('scrape-task');
  check('T2c 合法 cron 建一次性 alarm（分钟=45、时间在未来）',
    Boolean(sc) && !sc.periodInMinutes && new Date(sc.scheduledTime).getMinutes() === 45 && sc.scheduledTime > Date.now(),
    JSON.stringify(sc));
}

// ============ A-10：永不匹配组合解析期快速报错 ============
{
  let threw = false, elapsed = 0;
  const t0 = performance.now();
  try { ScheduleConfig.parseSimpleCron('0 0 31 2 *'); } catch { threw = true; }
  elapsed = performance.now() - t0;
  check('T3a "0 0 31 2 *" 解析期即抛错', threw, `threw=${threw}`);
  check('T3b 报错耗时 <50ms（不空转扫描）', elapsed < 50, `${elapsed.toFixed(1)}ms`);
  let ok29 = true;
  try { ScheduleConfig.parseSimpleCron('0 0 29 2 *'); } catch { ok29 = false; }
  check('T3c "0 0 29 2 *"（闰年合法）仍可解析', ok29);
  let okDow = true;
  try { ScheduleConfig.parseSimpleCron('0 0 31 2 1'); } catch { okDow = false; }
  check('T3d 星期受限时不误拦（31/2 + 周一按 OR 语义可匹配）', okDow);
}

// ============ A-1 onAlarm 加固：坏配置下闹钟触发无未捕获 rejection ============
bg.storage.seed({ scheduleConfig: { scheduleMode: 'cron', scrapeCron: 'garbage', translateCron: 'garbage' } });
bg.storage.seed({ urlTags: [] }); // 让 performScrape 走"未配置 URL"早退路径，不涉 tabs
await bg.listeners.alarm({ name: 'watchdog' });
await bg.listeners.alarm({ name: 'scrape-task' });
await sleep(200);
check('T4 坏配置下看门狗/任务闹钟触发无未捕获 rejection', unhandledCount === 0, `unhandled=${unhandledCount}`);

// ---------- 汇总 ----------
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  ← ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
