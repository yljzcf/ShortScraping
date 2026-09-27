import './bootstrap.cjs';
// 群机器人重试队列的耐久性（v1.7.0 审查 M4）。
//
// 起因：processBotRetryQueueOnce 逐条重推最多 50 张卡、每张要发好几次请求，期间 SW 里没有扩展 API
// 调用（30s 空闲即可能被回收），而队列落账与闹钟重排都只在循环末尾：SW 中途被回收时已推成功的卡还在
// 队里、一次性闹钟又已随触发删掉——要么没人再处理，要么下次重试整队重推，群里出现重复卡片。
// 现在：开跑先预排闹钟、整轮保活，每条推完立刻落账（成功摘掉、失败原位次数 +1）。
//
//   K1-K4（bg1，推到第 2 张时请求挂住＝模拟 SW 在这里被回收）：跑期间闹钟已排上、第 1 张已出队、
//        保活在跳；期间闹钟再触发的一轮被挡下、补排闹钟、不多发。
//   K5-K6（bg2，用 bg1 此刻的 storage 冷启动＝SW 重生后闹钟到点）：只推剩下的两张，第 1 张全程只推一次；
//        收尾队列清空、闹钟清掉、保活停掉。
//   K7（bg3）：失败即时落账——第 1 张失败后次数 +1 立刻写回，不等整轮结束。
// 用法：node tests/unit-lark-bot-retry.mjs
import { background } from './background-fixture.mjs';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);

let unhandled = 0;
process.on('unhandledRejection', (e) => { unhandled++; console.error('UNHANDLED:', e?.message || e); });

const BOT_HOOK = 'https://open.larksuite.com/open-apis/bot/v2/hook/unit-retry';
const RETRY_ALARM = 'larkBotRetry';
// 开机回读 config/lark.json：夹具默认回 {}＝机器人未就绪，syncBotWatermark 会把 larkBotState（含重试队列）清空。
// 两个 SW 实例都回同一份已启用的配置，模拟真实用户的 lark.json
const LARK = { webhookUrl: '', botWebhookUrl: BOT_HOOK, botEnabled: true, requestTimeoutSec: 5 };
const drama = id => ({
  id, itemId: id, title: `T-${id}`, titleZh: `中·${id}`, description: 'd', descriptionZh: '中文简介',
  status: 'trans', source: 'imdb', sourceListUrl: 'https://www.imdb.com/search/title/', tags: ['IMDB'],
  scrapedAt: '2026-09-05T01:00:00.000Z', translatedAt: '2026-09-05T01:05:00.000Z'
});

/** 按卡片标题决定 webhook 应答：'ok' | 'fail' | 'hang'（永不应答＝SW 在这里被回收）。 */
function botFetch(plan, posts) {
  return (url, options) => {
    const u = String(url);
    if (u.endsWith('/config/lark.json')) return Promise.resolve({ ok: true, async json() { return LARK; } });
    if (u !== BOT_HOOK) return undefined;
    const body = String(options?.body || '');
    const id = (body.match(/中·(k\d)/) || [])[1] || '?';
    posts.push(id);
    const behavior = plan[id] || 'ok';
    if (behavior === 'hang') return new Promise(() => {});
    if (behavior === 'fail') return Promise.resolve(new Response('upstream error', { status: 500 }));
    return Promise.resolve(new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
}

const queueOf = bg => (bg.data.larkBotState?.retryQueue || []).map(e => `${e.dramaId}:${e.attempts}`).join(',');
const keepAlivePending = bg => bg.timers.pending().some(t => t.delay === 20000);
/** 分步推进可控时钟（推送节流 250ms 一档），让在飞的推送链一步步走完。 */
async function drive(bg, steps = 8, ms = 300) {
  for (let i = 0; i < steps; i++) await bg.timers.advance(ms);
}

// ---------- bg1：推到 k2 时请求挂住（SW 在这里被回收） ----------
const posts1 = [];
const bg1 = await background({ timers: 'manual', fetch: botFetch({ k2: 'hang' }, posts1) });
await bg1.resetDramasCache();
bg1.seedDramas([drama('k1'), drama('k2'), drama('k3')]);
bg1.storage.seed({
  larkConfig: LARK,
  larkBotState: { enabledAt: '2026-09-05T00:00:00.000Z', retryQueue: [{ dramaId: 'k1', attempts: 1 }, { dramaId: 'k2', attempts: 2 }, { dramaId: 'k3', attempts: 1 }] }
});
bg1.alarms.clear();
bg1.context.processBotRetryQueue();   // 模拟 larkBotRetry 闹钟到点（一次性闹钟已随触发删掉）
await drive(bg1);

check('K1 开跑即预排 1 分钟后的重试闹钟（跑的这几分钟里不是「一个闹钟都没有」）',
  bg1.alarms.get(RETRY_ALARM)?.delayInMinutes === 1, show([...bg1.alarms.keys()]));
check('K2 逐条落账：k1 推成功后立刻出队，k2（请求挂住中）与 k3 原样留在队里',
  posts1.join(',') === 'k1,k2' && queueOf(bg1) === 'k2:2,k3:1', show({ posts: posts1, queue: queueOf(bg1) }));
check('K3 整轮开着 SW 保活（请求期间没有扩展 API 调用，靠它撑过 30s 空闲回收）', keepAlivePending(bg1),
  show(bg1.timers.pending()));
bg1.alarms.clear();
await bg1.context.processBotRetryQueue();   // 期间闹钟又到点：第二轮必须被挡下
check('K4 处理中再触发的一轮被挡下：不多发请求、补排闹钟',
  posts1.length === 2 && bg1.alarms.get(RETRY_ALARM)?.delayInMinutes === 1, show({ posts: posts1, alarms: [...bg1.alarms.keys()] }));

// ---------- bg2：SW 重生，用 bg1 此刻的 storage 冷启动，闹钟到点接着处理 ----------
const posts2 = [];
const bg2 = await background({ timers: 'manual', data: structuredClone(bg1.data), fetch: botFetch({}, posts2) });
bg2.alarms.clear();
const run2 = bg2.context.processBotRetryQueue();
await drive(bg2);
await run2;
check('K5 重生后的一轮只推剩下的 k2、k3；k1 两个实例合计只推一次（不重复进群）',
  posts2.join(',') === 'k2,k3' && [...posts1, ...posts2].filter(id => id === 'k1').length === 1,
  show({ bg1: posts1, bg2: posts2 }));
check('K6 收尾：队列清空、重试闹钟清掉、保活停掉',
  queueOf(bg2) === '' && !bg2.alarms.has(RETRY_ALARM) && !keepAlivePending(bg2),
  show({ queue: queueOf(bg2), alarms: [...bg2.alarms.keys()], pending: bg2.timers.pending() }));

// ---------- bg3：失败即时落账 ----------
const posts3 = [];
const bg3 = await background({ timers: 'manual', fetch: botFetch({ k2: 'fail', k3: 'hang' }, posts3) });
await bg3.resetDramasCache();
bg3.seedDramas([drama('k2'), drama('k3')]);
bg3.storage.seed({
  larkConfig: LARK,
  larkBotState: { enabledAt: '2026-09-05T00:00:00.000Z', retryQueue: [{ dramaId: 'k2', attempts: 2 }, { dramaId: 'k3', attempts: 1 }] }
});
bg3.context.processBotRetryQueue();
await drive(bg3);
check('K7 推失败的条目次数 +1 立刻写回（k3 还挂着，整轮远没结束）',
  posts3.join(',') === 'k2,k3' && queueOf(bg3) === 'k2:3,k3:1', show({ posts: posts3, queue: queueOf(bg3) }));

check('Z 全程无未处理的 Promise 拒绝', unhandled === 0, `unhandled=${unhandled}`);

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
