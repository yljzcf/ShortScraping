import './bootstrap.cjs';
// CSV 冷启动指纹回归测试（v1.6.22：cold-start-full-read-csv-warmup）。
// 背景：SW 每次被回收再唤醒，顶层都无条件排一次预热推送——整表读一遍 dramas、整表 POST 一遍，而绝大多数
// 唤醒时同步服务上本来就是这一版。现在整表写同一次 set 连带换 dramasStamp = { rev, pending }，推送成功且
// 服务端回了 contentHash 时记 csvLastPush = { rev, tagsKey, serverHash }；唤醒时只读小键 + 问一次 /health，
// 全部对得上才跳过。原则：只有每一项都确认一致才跳过，任何一项缺失 / 对不上 / 出错都照旧推。
//   W 组：整表写与 dramasStamp 同一次 set、每写换 rev、pending 数 new；冷读与 dramas / dramasMeta 同一次 get
//   C 组：冷启动——全部一致时 0 次 POST、0 次读 dramas；rev / tagsKey / hash / csvInSync / allowEmptySync /
//        /health 抛错 / 超时 / 非 2xx / 旧版服务没有 contentHash / 没有 csvLastPush / 没有 dramasStamp，任一项都推；
//        /health 带 3 秒期限
//   P 组：csvLastPush 只在 200 且带 contentHash 时记；推送途中又有写入时记的是被推出去的那一版 rev；
//        表还没有指纹时推送成功后补记（期间有写入就不补）；服务端回的 contentHash 不是这份推送体的指纹
//        （它按自己的 tag.json 滤掉了一部分）时不记、连旧记录一起作废
//   U 组：onInstalled reason==='update' 清掉 csvLastPush / dramasStamp 并强推
//   T 组：翻译扫描冷缓存且 pending===0 时不读表；pending>0 / 没有指纹 / 布局标记超前 / 本生命周期已碰过表时照常读
//   M 组：弹窗补喂带 contentHash 时先比对，一致不推；对不上强推（清签名）；不带时维持强推
// 全部走 background-fixture 的 manual 计时器，同步服务是 fetch 桩，不连任何真实端口。
// 用法：node tests/unit-csv-coldstart.mjs
import { createHash } from 'node:crypto';
import { background, card, PAGE_SENDER } from './background-fixture.mjs';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

const SYNC_URL = 'http://127.0.0.1:31919/sync';
const HEALTH_URL = 'http://127.0.0.1:31919/health';
// 已翻译完的卡：启动期「非中文译名退回 new」这类迁移不会动它，翻译扫描也不会把它当待翻译
const done = (itemId, extra = {}) => card(itemId, { status: 'trans', titleZh: '中文片名', ...extra });
const DRAMAS = [done('tt0001'), done('tt0002')];

// 探针：跑一遍真实初始化，拿到「一次性迁移都已完成」的标记集合与订阅指纹——种进后续夹具后，冷唤醒的初始化
// 本身零次读 dramas，读表次数就只反映预热推送 / 翻译扫描。从生产代码现取，日后加迁移不必改这里
const probe = await background({ dramas: DRAMAS });
const FLAGS = Object.fromEntries(Object.entries(probe.data).filter(([key, value]) => value === true || key === 'pruneFingerprint'));
const TAGS_KEY = probe.run(`configuredUrlFingerprint(${JSON.stringify(probe.data.urlTags)})`);
const STAMP = { rev: 'rev-1', pending: 0 };
const LAST_PUSH = { rev: 'rev-1', tagsKey: TAGS_KEY, serverHash: 'hash-1' };
// 同步服务的 contentHash：存下的 dramas 数组重新 JSON.stringify 后的 sha1 hex（sync-server.js sha1Hex）
const sha1 = text => createHash('sha1').update(text, 'utf8').digest('hex');
const hashOfList = list => sha1(JSON.stringify(list));
const hashOf = entry => hashOfList(entry?.body?.dramas || []);

/**
 * 夹具。server.health：'ok'（回 contentHash / csvInSync）| 'throw' | 'timeout'（TimeoutError）| 'hang'（等 signal 中止）
 * | 'http500' | 'nohash'（旧版服务）；server.hash / inSync 是 /health 回的指纹。POST /sync：mode 'auto' 立即 200，
 * 'manual' 挂到测试 settle；回包带 contentHash = server.replyHash：'auto'（缺省）按真实服务端算——server.keep 过滤后
 * 的数组的 sha1（keep 缺省全留，即服务端原样存下推送体）；给字符串就回它；null 表示旧版服务不带。
 * stamp / lastPush 传 null 表示 storage 里没有这个键。
 */
async function boot({ stamp = STAMP, lastPush = LAST_PUSH, dramas = DRAMAS, data = {}, server: serverOpts = {}, settle = true, translator = null } = {}) {
  const server = { health: 'ok', hash: 'hash-1', inSync: true, mode: 'auto', replyHash: 'auto', keep: null, posts: [], healthCalls: [], ...serverOpts };
  const seed = { ...FLAGS, ...data };
  if (stamp) seed.dramasStamp = stamp;
  if (lastPush) seed.csvLastPush = lastPush;
  const bg = await background({
    timers: 'manual',
    dramas,
    data: seed,
    settle,
    ...(translator ? { translator } : {}),
    fetch: (url, options) => {
      const u = String(url);
      if (u === HEALTH_URL) {
        server.healthCalls.push(options || {});
        if (server.health === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
        if (server.health === 'timeout') return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        if (server.health === 'hang') {
          return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
        }
        if (server.health === 'http500') return Promise.resolve({ ok: false, status: 500, async json() { return { ok: false }; } });
        const body = server.health === 'nohash' ? { ok: true } : { ok: true, contentHash: server.hash, csvInSync: server.inSync };
        return Promise.resolve({ ok: true, status: 200, async json() { return structuredClone(body); } });
      }
      if (u === SYNC_URL) {
        const entry = { body: JSON.parse(options.body), settled: false };
        server.posts.push(entry);
        const reply = (status = 200) => ({
          ok: status >= 200 && status < 300,
          status,
          async json() {
            const stored = server.keep ? entry.body.dramas.filter(server.keep) : entry.body.dramas;
            const contentHash = server.replyHash === 'auto' ? hashOfList(stored) : server.replyHash;
            return status === 200
              ? { ok: true, count: stored.length, csvPath: 'stub.csv', ...(contentHash ? { contentHash } : {}) }
              : { ok: false, code: 'EMPTY_REJECTED', error: 'stub' };
          }
        });
        if (server.mode === 'auto') { entry.settled = true; return Promise.resolve(reply()); }
        return new Promise(resolve => { entry.settle = (status = 200) => { entry.settled = true; resolve(reply(status)); }; });
      }
      return undefined; // config/*.json 走 fixture 默认桩，其余断网
    }
  });
  const ids = entry => (entry?.body?.dramas || []).map(d => d.itemId).sort().join(',');
  return { bg, server, ids, save: drama => bg.send({ action: 'saveDrama', drama }, PAGE_SENDER) };
}

/**
 * 排空启动期定时器并等在飞的推送（含推送成功后记 csvLastPush——算 sha1 走 WebCrypto，是真异步，flush 一拍
 * 未必落定）全部走完。只用于 mode 'auto'：manual 的推送要测试自己 settle
 */
async function drainSync(bg) {
  for (let i = 0; i < 20; i++) {
    await bg.timers.runAll();
    const inFlight = bg.run('csvSyncInFlight');
    if (!inFlight && bg.timers.pending().length === 0) return;
    await inFlight;
    await bg.flush();
  }
  throw new Error('drainSync：20 轮仍未排空');
}

// 调用本版本新增的后台函数：改造前的代码里没有它们，抛错时按失败记下（带原因）而不是让整个套件崩掉
const tryRun = async (bg, code) => {
  try { return await bg.run(code); } catch (e) { return `抛错：${e.message}`; }
};

/** 冷启动：夹具起来后把启动期定时器（预热推送的 500ms 防抖）全部排空，返回 POST 次数与读表次数 */
async function coldStart(options) {
  const h = await boot(options);
  await drainSync(h.bg);
  return { ...h, posts: h.server.posts.length, dramasReads: h.bg.storage.dramasReadCount() };
}

// ---------- W 组：整表写连带 dramasStamp ----------
{
  const h = await boot({ stamp: null, lastPush: null });
  await h.bg.timers.runAll();
  h.bg.log.length = 0;
  await h.save(card('tt0003', { status: 'new' }));
  const first = structuredClone(h.bg.data.dramasStamp);
  await h.save(done('tt0004'));
  const second = structuredClone(h.bg.data.dramasStamp);
  const dramaSets = h.bg.log.filter(e => e.startsWith('set:') && e.slice(4).split(',').includes('dramas'));
  check('W1a 每次整表写都在同一次 set 里带 dramasStamp（且在调用方连带键之后）',
    dramaSets.length === 2 && dramaSets.every(e => e === 'set:dramas,lastScrape,dramasStamp'), JSON.stringify(dramaSets));
  check('W1b 每写换一个 rev（UUID），pending 数表里 status===new 的条数',
    typeof first?.rev === 'string' && /^[0-9a-f-]{36}$/.test(first.rev) && typeof second?.rev === 'string' && second.rev !== first.rev
      && first.pending === 1 && second.pending === 1, JSON.stringify({ first, second }));
  check('W1c 内存副本与这一版表配对（dramasStampOf(dramasCache) 等于 storage 里的指纹）',
    JSON.stringify(await tryRun(h.bg, 'dramasStampOf(dramasCache)')) === JSON.stringify(second), JSON.stringify(await tryRun(h.bg, 'dramasStampOf(dramasCache)')));

  await h.bg.resetDramasCache();
  h.bg.storage.reads.length = 0;
  await h.bg.run("enqueueDramaWrite('W2', getDramasInQueue)");
  check('W2 缓存未命中的读：dramas / dramasMeta / dramasStamp 同一次 get，内存副本随之回填',
    h.bg.storage.reads.length === 1 && ['dramas', 'dramasMeta', 'dramasStamp'].every(k => h.bg.storage.reads[0]?.includes(k))
      && (await tryRun(h.bg, 'dramasStampOf(dramasCache)'))?.rev === second.rev, JSON.stringify(h.bg.storage.reads));
}

// ---------- C 组：冷启动预热 ----------
{
  const all = await coldStart();
  check('C0 前提：探针取到的迁移标记让冷唤醒的初始化零次读表', Object.keys(FLAGS).length >= 3 && typeof TAGS_KEY === 'string' && TAGS_KEY !== '',
    JSON.stringify({ FLAGS, TAGS_KEY }));
  check('C1a 全部一致：0 次 POST', all.posts === 0, `posts=${all.posts}`);
  check('C1b 全部一致：0 次读 dramas（只读小键）', all.dramasReads === 0, JSON.stringify(all.bg.storage.reads));
  check('C1c 只问了一次 /health，且带 signal（期限）', all.server.healthCalls.length === 1 && all.server.healthCalls[0].signal instanceof AbortSignal,
    `health=${all.server.healthCalls.length}`);
  check('C1d 指纹检查只读 dramasStamp / csvLastPush / urlTags / allowEmptySync',
    all.bg.storage.reads.some(keys => JSON.stringify(keys) === JSON.stringify(['dramasStamp', 'csvLastPush', 'urlTags', 'allowEmptySync'])),
    JSON.stringify(all.bg.storage.reads));
  check('C1e 没有待发的推送定时器', !all.bg.run('csvSyncTimer') && all.bg.run('csvSyncInFlight') === null, '');

  const cases = [
    ['C2 rev 不一致（上次推送之后表又写过）', { stamp: { rev: 'rev-2', pending: 0 } }],
    ['C3 tagsKey 不一致（订阅变了）', { lastPush: { ...LAST_PUSH, tagsKey: `${TAGS_KEY}\nhttps://other.example/list` } }],
    ['C4 服务端 contentHash 不一致（同步服务重启丢了快照 / 被别处推过）', { server: { hash: 'hash-other' } }],
    ['C5 csvInSync === false（CSV 落后于快照）', { server: { inSync: false } }],
    ['C6 带着 allowEmptySync（用户确认过的清空还等着推）', { data: { allowEmptySync: true } }],
    ['C7 /health 抛错（服务没开）', { server: { health: 'throw' } }],
    ['C8 /health 超时（TimeoutError）', { server: { health: 'timeout' } }],
    ['C9 /health 非 2xx', { server: { health: 'http500' } }],
    ['C10 旧版同步服务：/health 没有 contentHash', { server: { health: 'nohash' } }],
    ['C11 没有 csvLastPush（从没成功推过 / 版本更新刚清掉）', { lastPush: null }],
    ['C12 没有 dramasStamp（旧版本写的表）', { stamp: null }],
    ['C13 csvLastPush 缺 serverHash', { lastPush: { rev: 'rev-1', tagsKey: TAGS_KEY } }]
  ];
  for (const [name, options] of cases) {
    const r = await coldStart(options);
    check(`${name} → 照旧推送`, r.posts === 1 && r.ids(r.server.posts[0]) === 'tt0001,tt0002', `posts=${r.posts}`);
  }
  const noLocal = await coldStart({ lastPush: null });
  check('C11b 本地指纹已对不上时不去问 /health', noLocal.server.healthCalls.length === 0, `health=${noLocal.server.healthCalls.length}`);

  // /health 的期限：3 秒，到点即按「拿不到」处理
  const h = await boot();
  const realAbortSignal = h.bg.context.AbortSignal;
  const timeouts = [];
  let controller = null;
  h.bg.context.AbortSignal = { timeout(ms) { timeouts.push(ms); controller = new AbortController(); return controller.signal; } };
  h.server.health = 'hang';
  const checking = tryRun(h.bg, 'csvSyncUpToDate()');
  await h.bg.flush();
  const hungSignal = h.server.healthCalls.at(-1)?.signal;
  controller?.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  const upToDate = await checking;
  h.bg.context.AbortSignal = realAbortSignal;
  check('C14 /health 带 AbortSignal.timeout(3000)，挂住到点即判「不一致」',
    timeouts.length === 1 && timeouts[0] === 3000 && (await tryRun(h.bg, 'CSV_SYNC_HEALTH_TIMEOUT_MS')) === 3000
      && hungSignal === controller?.signal && upToDate === false, JSON.stringify({ timeouts, upToDate }));
}

// ---------- P 组：csvLastPush 的记录 ----------
{
  const h = await boot({ lastPush: null });
  await drainSync(h.bg);
  const pushedHash = hashOf(h.server.posts[0]);
  check('P1 200 且带 contentHash：记 csvLastPush = { 被推那一版的 rev, 订阅指纹, 服务端指纹 }',
    h.server.posts.length === 1 && JSON.stringify(h.bg.data.csvLastPush) === JSON.stringify({ rev: 'rev-1', tagsKey: TAGS_KEY, serverHash: pushedHash }),
    JSON.stringify(h.bg.data.csvLastPush));
  h.server.hash = pushedHash;
  check('P1b 记下之后，同一版表 + 服务端同指纹：比对通过', await tryRun(h.bg, 'csvSyncUpToDate()') === true, '');

  const old = await boot({ lastPush: null, server: { replyHash: null } });
  await drainSync(old.bg);
  check('P2 旧版同步服务（200 不带 contentHash）：不记 csvLastPush', old.server.posts.length === 1 && !('csvLastPush' in old.bg.data),
    JSON.stringify(old.bg.data.csvLastPush));

  for (const status of [409, 500]) {
    const r = await boot({ lastPush: null, server: { mode: 'manual' } });
    const pushing = r.bg.run('syncTimelineToCsv()').catch(() => {});
    await r.bg.flush();
    r.server.posts[0]?.settle(status);
    await pushing;
    check(`P3 HTTP ${status}：不记 csvLastPush`, r.server.posts.length === 1 && !('csvLastPush' in r.bg.data), JSON.stringify(r.bg.data.csvLastPush));
  }
}
{
  // 推送途中又有写入：记的是被推出去那一版的 rev，不是在飞期间新写的那一版
  const h = await boot({ lastPush: null, server: { mode: 'manual' } });
  await h.bg.timers.runAll(); // 启动期预热推送挂在 manual 上（在飞）
  const inFlight = h.server.posts[0];
  const pushedRev = h.bg.data.dramasStamp?.rev;
  await h.save(done('tt0009'));
  const newerRev = h.bg.data.dramasStamp?.rev;
  inFlight?.settle();
  await h.bg.run('csvSyncInFlight');
  await h.bg.flush();
  check('P4a 前提：推送在飞期间写入换了 rev，推出去的内容不含新卡',
    h.server.posts.length === 1 && pushedRev === 'rev-1' && newerRev && newerRev !== pushedRev && h.ids(inFlight) === 'tt0001,tt0002',
    JSON.stringify({ posts: h.server.posts.length, pushedRev, newerRev, ids: h.ids(inFlight) }));
  check('P4b csvLastPush.rev 是被推出去的那一版', h.bg.data.csvLastPush?.rev === pushedRev && h.bg.data.csvLastPush?.serverHash === hashOf(inFlight),
    JSON.stringify(h.bg.data.csvLastPush));
  h.server.hash = hashOf(inFlight);
  check('P4c 于是下次冷启动比对不通过（新卡还没推上去）', await tryRun(h.bg, 'csvSyncUpToDate()') === false, '');
}
{
  // 表还没有指纹（升级后首推）：推送成功后在写队列里补记，与 csvLastPush 同一次 set
  const h = await boot({ stamp: null, lastPush: null, dramas: [...DRAMAS, card('tt0005', { status: 'new', sourceListUrl: 'https://other.example/list' })] });
  h.bg.log.length = 0;
  await drainSync(h.bg);
  const stamp = h.bg.data.dramasStamp;
  check('P5a 没有指纹时推送成功：补记 dramasStamp（pending 数全表 new）与 csvLastPush，同一次 set',
    h.server.posts.length === 1 && typeof stamp?.rev === 'string' && stamp.pending === 1 && h.bg.data.csvLastPush?.rev === stamp.rev
      && h.bg.log.includes('set:dramasStamp,csvLastPush'), JSON.stringify({ stamp, last: h.bg.data.csvLastPush, log: h.bg.log }));
  h.server.hash = h.bg.data.csvLastPush?.serverHash;
  check('P5b 补记之后下次冷启动比对通过', await tryRun(h.bg, 'csvSyncUpToDate()') === true, '');

  const w = await boot({ stamp: null, lastPush: null, server: { mode: 'manual' } });
  await w.bg.timers.runAll();
  await w.save(done('tt0009'));
  const writtenRev = w.bg.data.dramasStamp?.rev;
  w.server.posts[0]?.settle();
  await w.bg.run('csvSyncInFlight');
  await w.bg.flush();
  check('P5c 没有指纹、推送途中又有写入：不补记（csvLastPush 不写，指纹保持那次写带出的）',
    !('csvLastPush' in w.bg.data) && typeof writtenRev === 'string' && w.bg.data.dramasStamp?.rev === writtenRev,
    JSON.stringify({ last: w.bg.data.csvLastPush, stamp: w.bg.data.dramasStamp, writtenRev }));
}

{
  // 服务端按它自己的 config/tag.json 再滤一遍：两边订阅对不上（设置页写回 tag.json 失败留下 configAheadOfFile、
  // 手改过 tag.json）时它存下的比推上去的少，回的 contentHash 不是这份推送体的指纹。那样的指纹记下来，
  // tag.json 追平之后表没变、订阅没变、服务端指纹也没变，冷启动会跳过本该补上被滤掉那部分的推送
  const h = await boot({ server: { hash: 'hash-other', keep: d => d.itemId === 'tt0001' } });
  await drainSync(h.bg);
  const filteredHash = hashOfList(h.server.posts[0]?.body?.dramas.filter(d => d.itemId === 'tt0001') || []);
  check('P6a 前提：冷启动因服务端指纹不同照推，推的是整份时间线',
    h.server.posts.length === 1 && h.ids(h.server.posts[0]) === 'tt0001,tt0002', `posts=${h.server.posts.length}`);
  check('P6b 服务端回的 contentHash 与推送体对不上：不记 csvLastPush，旧记录（rev-1）一并作废',
    !('csvLastPush' in h.bg.data) && h.bg.log.includes('remove:csvLastPush'), JSON.stringify({ last: h.bg.data.csvLastPush }));
  h.server.hash = filteredHash; // 服务端此刻存的正是滤过的那份
  check('P6c 于是之后的冷启动比对不通过（照旧推，而不是认定服务端已是这一版）', await tryRun(h.bg, 'csvSyncUpToDate()') === false, '');

  // tag.json 追平：服务端原样存下整份，下一次推送成功后照常记指纹
  h.server.keep = null;
  h.bg.run('lastCsvSyncSerialized = null');
  await h.bg.run('syncTimelineToCsv()');
  const fullHash = hashOf(h.server.posts[1]);
  check('P6d 服务端原样存下推送体：记 csvLastPush，serverHash 就是这份推送体的指纹',
    h.server.posts.length === 2 && h.bg.data.csvLastPush?.rev === 'rev-1' && h.bg.data.csvLastPush?.serverHash === fullHash && fullHash !== filteredHash,
    JSON.stringify(h.bg.data.csvLastPush));

  // 表还没有指纹时同理：对不上就不补记 dramasStamp，也不记 csvLastPush
  const noStamp = await boot({ stamp: null, lastPush: null, server: { keep: d => d.itemId === 'tt0001' } });
  await drainSync(noStamp.bg);
  check('P6e 没有指纹 + 服务端滤掉了一部分：不补记指纹、不记 csvLastPush',
    noStamp.server.posts.length === 1 && !('csvLastPush' in noStamp.bg.data) && !('dramasStamp' in noStamp.bg.data),
    JSON.stringify({ stamp: noStamp.bg.data.dramasStamp, last: noStamp.bg.data.csvLastPush }));
}

// ---------- U 组：版本更新 ----------
{
  const h = await boot();
  await h.bg.timers.runAll();
  const skippedBefore = h.server.posts.length === 0;
  await h.bg.listeners.installed({ reason: 'update' });
  const removed = !('csvLastPush' in h.bg.data) && !('dramasStamp' in h.bg.data);
  await drainSync(h.bg);
  check('U1a 前提：指纹一致，冷启动没有推', skippedBefore, '');
  check('U1b update 清掉 csvLastPush 与 dramasStamp', removed && h.bg.log.includes('remove:csvLastPush,dramasStamp'), h.bg.log.join(' | '));
  check('U1c update 之后强推一次', h.server.posts.length === 1 && h.ids(h.server.posts[0]) === 'tt0001,tt0002', `posts=${h.server.posts.length}`);
  check('U1d 强推成功后补记出新指纹（rev 不再是更新前的旧值）',
    typeof h.bg.data.dramasStamp?.rev === 'string' && h.bg.data.dramasStamp.rev !== 'rev-1' && h.bg.data.csvLastPush?.rev === h.bg.data.dramasStamp.rev,
    JSON.stringify({ stamp: h.bg.data.dramasStamp, last: h.bg.data.csvLastPush }));

  // SW 为分发 onInstalled 而启动：顶层初始化与预热比对都还在飞时就派发
  const early = await boot({ settle: false });
  await early.bg.listeners.installed({ reason: 'update' });
  await early.bg.flush();
  await drainSync(early.bg);
  check('U2 初始化未落定时派发 update：同样清指纹并强推', early.server.posts.length === 1 && early.bg.data.dramasStamp?.rev !== 'rev-1',
    JSON.stringify({ posts: early.server.posts.length, stamp: early.bg.data.dramasStamp }));
}

// ---------- T 组：翻译扫描冷缓存 ----------
{
  const h = await boot();
  const summary = await h.bg.run('performTranslate()');
  check('T1 冷唤醒翻译扫描、指纹 pending===0：不读表，按空扫描收工',
    h.bg.storage.dramasReadCount() === 0 && summary?.pendingCount === 0 && !summary?.error && h.bg.run('dramasCache') === null,
    JSON.stringify({ reads: h.bg.storage.reads, summary }));

  const viaAlarm = await boot();
  await viaAlarm.bg.listeners.alarm({ name: 'translate-task' });
  check('T1b 经 translate-task 闹钟唤醒同样不读表', viaAlarm.bg.storage.dramasReadCount() === 0, JSON.stringify(viaAlarm.bg.storage.reads));

  // pending>0：订阅外的 new 也算进 pending（口径比扫描宽），照常读表，扫描按订阅过滤后为空
  const pending = await boot({ stamp: { rev: 'rev-1', pending: 1 }, dramas: [...DRAMAS, card('tt0005', { status: 'new', sourceListUrl: 'https://other.example/list' })] });
  const s2 = await pending.bg.run('performTranslate()');
  check('T2 pending>0：照常读表', pending.bg.storage.dramasReadCount() === 1 && s2?.pendingCount === 0, JSON.stringify({ reads: pending.bg.storage.dramasReadCount(), s2 }));

  const noStamp = await boot({ stamp: null });
  await noStamp.bg.run('performTranslate()');
  check('T3 没有指纹：照常读表', noStamp.bg.storage.dramasReadCount() === 1, String(noStamp.bg.storage.dramasReadCount()));

  const ahead = await boot({ data: { dramasMeta: { layout: 2 } } });
  const s4 = await ahead.bg.run('performTranslate({ source: "manual" })');
  check('T4 布局标记超前（更新版本升级过）：不走捷径，照只读护栏报错',
    ahead.bg.storage.dramasReadCount() === 1 && /更新版本/.test(s4?.error || ''), JSON.stringify(s4));

  const warm = await boot();
  await warm.bg.run("enqueueDramaWrite('T5', getDramasInQueue)");
  warm.bg.run('dramasCache = null');
  warm.bg.storage.reads.length = 0;
  await warm.bg.run('performTranslate()');
  check('T5 本生命周期已碰过表（缓存因写失败等清空）：不走捷径，重读一次表', warm.bg.storage.dramasReadCount() === 1,
    String(warm.bg.storage.dramasReadCount()));

  const manual = await boot();
  const s6 = await manual.bg.run('performTranslate({ source: "manual" })');
  check('T6 手动触发走捷径同样写终态（弹窗按钮收得到收尾信号）',
    manual.bg.storage.dramasReadCount() === 0 && s6?.pendingCount === 0 && manual.bg.data.translateRunState?.running === false,
    JSON.stringify(manual.bg.data.translateRunState));
}

// ---------- M 组：弹窗补喂 ----------
{
  const h = await boot();
  await h.bg.timers.runAll();
  const healthBefore = h.server.healthCalls.length;
  const reply = await h.bg.send({ action: 'warmupCsvSync', contentHash: 'hash-1', csvInSync: true });
  await h.bg.timers.runAll();
  check('M1 带 contentHash 且全部一致：不推，也不另问 /health（用弹窗刚读到的结果）',
    reply?.success === true && reply.pushed === false && h.server.posts.length === 0 && h.server.healthCalls.length === healthBefore,
    JSON.stringify({ reply, posts: h.server.posts.length }));

  // 先推一次让内存签名命中，再证明「对不上」时是强推（清签名），不会被签名跳过
  h.bg.run('lastCsvSyncSerialized = null');
  await h.bg.run('syncTimelineToCsv()');
  const afterFirst = h.server.posts.length;
  const mismatch = await h.bg.send({ action: 'warmupCsvSync', contentHash: 'hash-lost', csvInSync: true });
  await h.bg.timers.runAll();
  check('M2 带 contentHash 但与上次推送记下的不一致：清签名强推（同内容也重推）',
    afterFirst === 1 && mismatch?.pushed === true && h.server.posts.length === 2, JSON.stringify({ afterFirst, mismatch, posts: h.server.posts.length }));

  const hash = h.bg.data.csvLastPush?.serverHash;
  const notInSync = await h.bg.send({ action: 'warmupCsvSync', contentHash: hash, csvInSync: false });
  await h.bg.timers.runAll();
  check('M3 contentHash 一致但 csvInSync=false：照旧强推', notInSync?.pushed === true && h.server.posts.length === 3,
    JSON.stringify({ notInSync, posts: h.server.posts.length }));

  const legacy = await h.bg.send({ action: 'warmupCsvSync' });
  await h.bg.timers.runAll();
  check('M4 不带 contentHash（旧版服务 / 旧版弹窗）：维持强推', legacy?.success === true && h.server.posts.length === 4, `posts=${h.server.posts.length}`);
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
