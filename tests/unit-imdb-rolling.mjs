import './bootstrap.cjs';
// IMDb 订阅切换为滚动日期窗口（v1.7.0，2026-09-27 用户定）。
//
// 以前 IMDb 订阅把起始日期写死在 URL 里（release_date=2026-01-01,），只读前 50 条时新片被越积越多的老片挤出去。
// 订阅 URL 又是历史归属的身份，直接改 tag.json＝退订、名下历史全删。v1.7.0 起订阅 URL 不带日期、打开页面前按
// 设置的天数补 release_date；存量经一次性切换迁过来：
//   ① 迁移（runPendingDramaMigrations 首条）：去掉写死的日期、名下条目 sourceListUrl 同一次写入改写；退订
//      genres=short 并删其名下条目（进回收站）；订阅本地领先，随即写回 config/tag.json；
//   ② 唤醒收尾：先抓一轮 IMDb（窗口天数首次生效＝整轮只入库不推送），
//   ③ 再读各订阅不限日期与补了窗口的两页列表 ID，窗口外、库里又没有的只记 ID 进已知片单（db/known-items.json 另存一份）。
//
//   S  完整切换：迁移落库形态、首轮全失败停在原地、下次唤醒接着走完、切换后的新片照常推、再唤醒不重跑
//   F  写回失败的安全性：旧 tag.json 还在盘上时下次唤醒不许回滚订阅、不许删历史
//   N  没有旧形态的 IMDb 订阅：不迁移、直接标完成
//   B  基线细节：不限日期那页为空按没读成、全没读成留待重来、窗口设 0 时无窗口外老片可记
//   W  改天数后的第一轮 IMDb 不推群（记在 larkBotState.imdbWindowDays，有 IMDb 页真正抓成才记）；
//      没真正抓成的页（失败 / 页面上没找到列表）各自保持只入库不推送，直到它第一次真正抓成
//   K  已知片单：抓取上下文下发、入库兜底拒收、与同步服务对齐（恢复 / 404 / 服务没开 / 补推）
// 用法：node tests/unit-imdb-rolling.mjs
import { background, card } from './background-fixture.mjs';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);

const T0 = Date.parse('2026-09-05T00:00:00Z'); // background-fixture 的起始时钟
const HOOK = 'https://open.larksuite.com/open-apis/bot/v2/hook/imdb-rolling';
const SYNC = 'http://127.0.0.1:31919';
const BASE = 'https://www.imdb.com/search/title/?';
const LEGACY = filter => `${BASE}release_date=2026-01-01,&${filter}`;
const ROLLING = filter => `${BASE}${filter}`;
const NETFLIX = 'https://www.netflix.com/tudum/top10';
const CO1 = 'companies=co1028734';
const CO2 = 'companies=co1116954';
const SHORT = 'genres=short';
// 其余一次性迁移都标成已完成：本套件只看 IMDb 切换这一条的写入
const DONE_FLAGS = {
  companyFieldDropped: true, partialTranslationReset: true, nonChineseTitleZhReset: true,
  garbledTranslationReset: true, shorticalCanonicalIdsMigrated: true
};
const CONTENT_SENDER = { id: 'fixture', url: `${BASE}${CO1}`, tab: { id: 9, url: `${BASE}${CO1}` } };

// 与 SubscriptionConfig.withReleaseWindow 同算法（本机时区的「今天」往前推 days 天）
const windowDate = (days, nowMs) => {
  const now = new Date(nowMs);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
};
const windowed = (url, days, nowMs) => `${url}&release_date=${windowDate(days, nowMs)},`;
const subOf = url => url.replace(/&release_date=[^&]*$/, '');
const fileTags = entries => entries.map(([url, tags]) => ({ url, tags }));
const storageTags = entries => entries.map(([urlPattern, tags]) => ({ urlPattern, tags }));
const LEGACY_ENTRIES = [
  [LEGACY(CO1), ['IMDB', 'DramaBox']],
  [LEGACY(CO2), ['IMDB', 'ReelShort']],
  [LEGACY(SHORT), ['IMDB', 'Short']],
  [NETFLIX, ['Netflix']]
];
const ROLLING_ENTRIES = [
  [ROLLING(CO1), ['IMDB', 'DramaBox']],
  [ROLLING(CO2), ['IMDB', 'ReelShort']],
  [NETFLIX, ['Netflix']]
];

/**
 * 一台假机器：config/*.json、同步服务（/config/tag、/known-items）、群机器人 webhook 与各列表页。
 * pages[订阅 URL] = { windowed: 补了窗口那页的条目 ID, wide: 不限日期那页的条目 ID }；
 * 'scrape' 按页面条目经 saveDrama 消息入库（内容脚本的做法），failDetail 里的 ID 模拟详情没取到、不入库；
 * mode='down' 时所有页面失败，failUrls 里的订阅只让这几页失败。
 */
function machine({ tagFile, pages = {}, serverKnown = null, syncDown = false, cron = {}, lark = { botWebhookUrl: HOOK, botEnabled: true, requestTimeoutSec: 5 } } = {}) {
  const m = {
    tagFile, pages, serverKnown, syncDown, cron, lark,
    mode: 'ok', failDetail: new Set(), failUrls: new Set(), botPosts: [], syncCalls: [], opened: []
  };
  m.fetch = (url, options = {}) => {
    const u = String(url);
    // 配置文件是配置源：唤醒时 cron.json / lark.json 覆盖 storage 里的同名配置
    if (u.endsWith('/config/tag.json')) return { ok: true, async json() { return structuredClone(m.tagFile); } };
    if (u.endsWith('/config/cron.json')) return { ok: true, async json() { return structuredClone(m.cron); } };
    if (u.endsWith('/config/lark.json')) return { ok: true, async json() { return structuredClone(m.lark); } };
    if (u === HOOK) {
      m.botPosts.push(JSON.parse(options.body || '{}'));
      return { ok: true, status: 200, async text() { return JSON.stringify({ code: 0, msg: 'success' }); } };
    }
    if (!u.startsWith(SYNC)) return undefined;
    const method = options.method || 'GET';
    const route = u.slice(SYNC.length);
    const body = options.body ? JSON.parse(options.body) : null;
    m.syncCalls.push({ method, route, body });
    if (m.syncDown) return Promise.reject(new TypeError('Failed to fetch'));
    const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, async json() { return json; } });
    if (method === 'POST' && route === '/config/tag') {
      m.tagFile = body.urlTags.map(t => ({ url: t.urlPattern, tags: t.tags }));
      return reply(200, { ok: true });
    }
    if (route === '/known-items') {
      if (method === 'GET') return m.serverKnown === null ? reply(404, { ok: false, error: '没有这个接口' }) : reply(200, { ok: true, items: m.serverKnown });
      m.serverKnown = body.items;
      return reply(200, { ok: true, count: body.items.length });
    }
    return reply(200, { ok: true });
  };
  m.scrape = async (bg, url, message = { action: 'scrape' }) => {
    m.opened.push({ url, action: message.action });
    if (m.mode === 'down' || m.failUrls.has(subOf(url))) return { success: false, error: '整页抓取超时' };
    const page = m.pages[subOf(url)];
    if (!page) return message.action === 'collectListIds' ? { success: true, ids: [], listCount: 0 } : { success: true, newCount: 0, subscribed: true, listCount: 1 };
    const ids = url === subOf(url) ? page.wide : page.windowed;
    if (message.action === 'collectListIds') return { success: true, ids: [...ids], listCount: ids.length };
    const nowIso = new Date(bg.run('Date.now()')).toISOString();
    let newCount = 0;
    for (const id of ids) {
      if (m.failDetail.has(id)) continue;
      const drama = card(id, { sourceListUrl: subOf(url), status: 'trans', titleZh: `中·${id}`, descriptionZh: '简介', translatedAt: nowIso, scrapedAt: nowIso });
      const reply = await bg.send({ action: 'saveDrama', drama }, CONTENT_SENDER);
      if (reply?.saved) newCount++;
    }
    return { success: true, newCount, subscribed: true, listCount: ids.length };
  };
  return m;
}

/** 按 m 起一个 SW（顶层初始化连同唤醒收尾），等 done(bg) 成立后再多让几拍；最多 300 轮。 */
async function boot(m, { data = {}, dramas = [], done = () => false } = {}) {
  const bg = await background({ settle: false, dramas, data: { ...DONE_FLAGS, ...data }, fetch: m.fetch });
  // 顶层代码刚跑完、初始化还在飞：此刻换掉开标签页抓取，唤醒收尾用的就是替身
  bg.context.scrapeUrlInTab = (url, message) => m.scrape(bg, url, message);
  await settle(bg, done);
  return bg;
}
async function settle(bg, done = () => false, max = 300) {
  for (let i = 0; i < max && !done(bg); i++) await bg.flush();
  for (let i = 0; i < 5; i++) await bg.flush();
}
const idsOf = list => (list || []).map(d => d.id ?? d.itemId).sort();
const itemIds = bg => bg.dramas().map(d => d.itemId).sort();
const byItem = (bg, id) => bg.dramas().find(d => d.itemId === id);
const opens = (m, action) => m.opened.filter(o => o.action === action).map(o => o.url);
const phaseOf = bg => bg.data.imdbRollingSwitch?.phase;
const baselineOf = (bg, url) => bg.data.larkBotState?.urlBaseline?.[url];

// ================= S 完整切换 =================
{
  const lib = [
    card('tt0000001', { sourceListUrl: LEGACY(CO1) }),
    card('tt0000002', { sourceListUrl: LEGACY(CO1) }),
    card('tt0000003', { sourceListUrl: LEGACY(CO2) }),
    card('tt0000004', { sourceListUrl: LEGACY(SHORT) }),
    card('tt0000005', { sourceListUrl: LEGACY(SHORT) }),
    card('nf-1', { source: 'netflix', sourceListUrl: NETFLIX, tags: ['Netflix'] })
  ];
  const m = machine({
    tagFile: fileTags(LEGACY_ENTRIES),
    pages: {
      // tt0000004 原先只在 short 名下：切换删掉它，首轮在 co1 窗口内那页又抓回来（接回别的榜上的 short 条目）
      [ROLLING(CO1)]: { windowed: ['tt0000001', 'tt101', 'tt0000004'], wide: ['tt0000001', 'tt0000002', 'tt101', 'tt0000004', 'tt900', 'tt901'] },
      // tt202 在窗口内、首轮详情没取到：基线不许把它记进片单，下一轮照常入库
      [ROLLING(CO2)]: { windowed: ['tt0000003', 'tt201', 'tt202'], wide: ['tt0000003', 'tt201', 'tt202', 'tt901', 'tt902'] }
    }
  });
  m.mode = 'down';
  m.failDetail.add('tt202');
  const bg = await boot(m, {
    data: { urlTags: storageTags(LEGACY_ENTRIES) },
    dramas: lib,
    done: b => opens(m, 'scrape').length >= 2 && b.run('activeScrapeCount') === 0
  });

  // ---- ① 迁移落库形态 ----
  check('S1a 订阅：两条 IMDb 去掉写死的日期（标签不变、顺序不变），genres=short 退订，其余站点原样',
    show(bg.data.urlTags) === show(storageTags(ROLLING_ENTRIES)), show(bg.data.urlTags));
  const moved = ['tt0000001', 'tt0000002'].every(id => byItem(bg, id)?.sourceListUrl === ROLLING(CO1))
    && byItem(bg, 'tt0000003')?.sourceListUrl === ROLLING(CO2) && byItem(bg, 'nf-1')?.sourceListUrl === NETFLIX;
  check('S1b 名下条目归属随订阅改写（其余字段不动），short 名下的删掉，别站条目不动',
    moved && show(itemIds(bg)) === show(['nf-1', 'tt0000001', 'tt0000002', 'tt0000003'])
      && byItem(bg, 'tt0000001')?.scrapedAt === lib[0].scrapedAt && byItem(bg, 'tt0000001')?.status === 'new',
    show(bg.dramas().map(d => [d.itemId, d.sourceListUrl])));
  const trash = (bg.data.pruneTrash || []).at(-1);
  check('S1c 删掉的 short 条目进自动清理回收站（原因点名 genres=short，保留原归属）',
    /genres=short/.test(trash?.reason || '') && show(idsOf(trash?.dramas.map(d => ({ id: d.itemId })))) === show(['tt0000004', 'tt0000005'])
      && show(trash?.urls) === show([LEGACY(SHORT)]), show(trash));
  check('S1d 订阅 / 条目归属 / 清理指纹 / 本地领先标记 / 切换标记 / 回收站同一次 set（要么全落库、要么全不落）',
    bg.log.includes('set:dramas,urlTags,pruneFingerprint,configAheadOfFile,imdbRollingSwitch,pruneTrash,dramasStamp')
      && bg.data.pruneFingerprint === bg.context.configuredUrlFingerprint(bg.data.urlTags), show(bg.log.filter(l => l.startsWith('set:'))));
  const tagPost = m.syncCalls.find(c => c.method === 'POST' && c.route === '/config/tag');
  check('S1e 随即把新订阅写回 config/tag.json，成功后摘掉本地领先标记',
    show(tagPost?.body?.urlTags) === show(storageTags(ROLLING_ENTRIES)) && bg.data.configAheadOfFile?.tag !== true
      && show(m.tagFile) === show(fileTags(ROLLING_ENTRIES)), show({ tagPost, ahead: bg.data.configAheadOfFile }));
  check('S1f 切换标记 phase=firstRound，记下改名 2 条、删除 2 条',
    phaseOf(bg) === 'firstRound' && bg.data.imdbRollingSwitch.renamed === 2 && bg.data.imdbRollingSwitch.removed === 2,
    show(bg.data.imdbRollingSwitch));

  // ---- ② 首轮一个页面都没抓成：停在原地 ----
  check('S2a 唤醒收尾抓了一轮 IMDb：只开 IMDb 订阅、按 180 天补日期（别站不抓）',
    show(opens(m, 'scrape')) === show([windowed(ROLLING(CO1), 180, T0), windowed(ROLLING(CO2), 180, T0)]), show(m.opened));
  check('S2b 首轮全失败：phase 仍是 firstRound，不读基线列表', phaseOf(bg) === 'firstRound' && opens(m, 'collectListIds').length === 0,
    show({ phase: phaseOf(bg), opened: m.opened }));
  check('S2c 首轮全失败不记窗口天数（下一轮 IMDb 仍整轮静音）', bg.data.larkBotState?.imdbWindowDays === undefined,
    show(bg.data.larkBotState));
  check('S2e 没抓成的页不收口：两条 IMDb 订阅的推送基线仍是「进行中」',
    [ROLLING(CO1), ROLLING(CO2)].every(url => baselineOf(bg, url) === 'pending'), show(bg.data.larkBotState?.urlBaseline));
  check('S2d 唤醒时片单与同步服务对齐：服务端没有（404）记成空片单，此后不再每次问',
    show(bg.data.knownItems) === '[]' && m.syncCalls.some(c => c.method === 'GET' && c.route === '/known-items'), show(bg.data.knownItems));

  // ---- 下次唤醒接着走：首轮 → 基线 → 完成 ----
  m.mode = 'ok';
  m.opened.length = 0;
  bg.setTime(T0 + 60_000);
  await bg.run('resumeImdbRollingSwitch()');
  await settle(bg);
  const t1 = T0 + 60_000;
  check('S3a 先抓一轮 IMDb（补窗口），再逐条读不限日期与补了窗口的两页列表 ID',
    show(m.opened) === show([
      { url: windowed(ROLLING(CO1), 180, t1), action: 'scrape' },
      { url: windowed(ROLLING(CO2), 180, t1), action: 'scrape' },
      { url: ROLLING(CO1), action: 'collectListIds' },
      { url: windowed(ROLLING(CO1), 180, t1), action: 'collectListIds' },
      { url: ROLLING(CO2), action: 'collectListIds' },
      { url: windowed(ROLLING(CO2), 180, t1), action: 'collectListIds' }
    ]), show(m.opened));
  check('S3b 首轮窗口内的新片完整入库，归属记订阅 URL 本身（不带补上的日期）；被删的 short 条目在别的榜上的接回来',
    ['tt101', 'tt0000004'].every(id => byItem(bg, id)?.sourceListUrl === ROLLING(CO1)) && byItem(bg, 'tt201')?.sourceListUrl === ROLLING(CO2)
      && !byItem(bg, 'tt202'), show(bg.dramas().map(d => [d.itemId, d.sourceListUrl])));
  check('S3c 首轮入库的卡一张都不推群（平台自带中文、入库即 trans，照样静音）', m.botPosts.length === 0, show(m.botPosts));
  check('S3d 两条 IMDb 订阅的推送基线收口在首轮完成时刻，窗口天数记为 180',
    [ROLLING(CO1), ROLLING(CO2)].every(url => baselineOf(bg, url) === new Date(t1).toISOString())
      && bg.data.larkBotState?.imdbWindowDays === 180, show(bg.data.larkBotState));
  const known = bg.data.knownItems || [];
  check('S3e 片单只记不限日期前 50 里、窗口外、库里没有的（窗口内首轮没入成库的 tt202 不记）',
    show(known.map(k => k.id).sort()) === show(['tt900', 'tt901', 'tt902'])
      && known.every(k => k.site === 'imdb' && k.at === new Date(t1).toISOString() && /切换基线/.test(k.reason)), show(known));
  const knownPost = m.syncCalls.filter(c => c.method === 'POST' && c.route === '/known-items').at(-1);
  check('S3f 片单整份推给同步服务（db/known-items.json），推成不留补推标记',
    show(knownPost?.body?.items) === show(known) && bg.data.knownItemsServerStale === undefined, show(knownPost));
  check('S3g phase=done，记下新增片单条数', phaseOf(bg) === 'done' && bg.data.imdbRollingSwitch.knownAdded === 3
    && bg.data.imdbRollingSwitch.firstRoundAt && bg.data.imdbRollingSwitch.doneAt, show(bg.data.imdbRollingSwitch));

  // ---- 切换之后：新片照常推，片单里的挡住 ----
  bg.setTime(T0 + 3_600_000);
  const later = new Date(T0 + 3_600_000).toISOString();
  const fresh = card('tt300', { sourceListUrl: ROLLING(CO1), status: 'trans', titleZh: '切换后的新片', descriptionZh: '简介', translatedAt: later, scrapedAt: later });
  const freshReply = await bg.send({ action: 'saveDrama', drama: fresh }, CONTENT_SENDER);
  await settle(bg);
  check('S4a 切换之后新上榜的片照常入库并推群', freshReply?.saved === true && m.botPosts.length === 1
    && show(m.botPosts[0]).includes('切换后的新片'), show({ freshReply, posts: m.botPosts.length }));
  const blocked = await bg.send({ action: 'saveDrama', drama: card('tt900', { sourceListUrl: ROLLING(CO1), status: 'trans', titleZh: '老片', descriptionZh: '简介', scrapedAt: later }) }, CONTENT_SENDER);
  await settle(bg);
  check('S4b 片单里的 ID 入库被拒（不入库也不推）', blocked?.saved === false && !byItem(bg, 'tt900') && m.botPosts.length === 1,
    show({ blocked, posts: m.botPosts.length }));
  const ctx = await bg.context.scrapeContextForContent({ tab: { url: windowed(ROLLING(CO2), 180, T0 + 3_600_000) } });
  check('S4c 窗口内首轮没入成库的 tt202 不在下发的「已存在」清单里（片单记下的 tt901 / tt902 在）',
    !ctx.known.some(([id]) => id === 'tt202') && ['tt901', 'tt902'].every(id => ctx.known.some(([k]) => k === id)), show(ctx.known));
  m.failDetail.clear();
  // 群机器人发送节流 250ms 靠 setTimeout 等（夹具的定时器不执行）：时钟往前拨，免得第二次推送卡在节流上
  bg.setTime(T0 + 3_700_000);
  await bg.run("performScrapeOnce({ site: 'imdb' })");
  await settle(bg);
  check('S4d 详情恢复后 tt202 入库，且不是首轮（照常推群）', byItem(bg, 'tt202')?.sourceListUrl === ROLLING(CO2) && m.botPosts.length === 2,
    show({ tt202: byItem(bg, 'tt202')?.sourceListUrl, posts: m.botPosts.length }));

  // ---- 再唤醒：不重跑 ----
  const snapshot = structuredClone(bg.data);
  m.opened.length = 0;
  m.syncCalls.length = 0;
  const bg2 = await boot(m, { data: snapshot });
  check('S5a 再唤醒：不再迁移、不开任何页面、不写表', m.opened.length === 0
    && !bg2.log.some(l => l.startsWith('set:dramas')), show({ opened: m.opened, sets: bg2.log.filter(l => l.startsWith('set:')) }));
  check('S5b 订阅、条目与片单原样；本地已有片单就不再问同步服务', show(bg2.data.urlTags) === show(storageTags(ROLLING_ENTRIES))
    && show(itemIds(bg2)) === show(itemIds(bg)) && show(bg2.data.knownItems) === show(known)
    && !m.syncCalls.some(c => c.route === '/known-items'), show(m.syncCalls));
}

// ================= F 写回失败：旧 tag.json 还在盘上 =================
{
  const lib = [
    card('tt0000001', { sourceListUrl: LEGACY(CO1) }),
    card('tt0000003', { sourceListUrl: LEGACY(CO2) }),
    card('tt0000004', { sourceListUrl: LEGACY(SHORT) })
  ];
  const m = machine({
    tagFile: fileTags(LEGACY_ENTRIES), syncDown: true,
    pages: {
      [ROLLING(CO1)]: { windowed: ['tt0000001', 'tt101'], wide: ['tt0000001', 'tt101', 'tt900'] },
      [ROLLING(CO2)]: { windowed: ['tt0000003'], wide: ['tt0000003', 'tt901'] }
    }
  });
  const bg = await boot(m, { data: { urlTags: storageTags(LEGACY_ENTRIES) }, dramas: lib, done: b => b.data.imdbRollingSwitch?.phase === 'done' });
  check('F1a 同步服务没开：切换照常走完，订阅本地领先标记保留（config/tag.json 还是旧的）',
    phaseOf(bg) === 'done' && bg.data.configAheadOfFile?.tag === true && show(m.tagFile) === show(fileTags(LEGACY_ENTRIES)),
    show({ phase: phaseOf(bg), ahead: bg.data.configAheadOfFile }));
  check('F1b 片单推不上去：本地照记，留补推标记', show((bg.data.knownItems || []).map(k => k.id).sort()) === show(['tt900', 'tt901'])
    && bg.data.knownItemsServerStale === true, show({ known: bg.data.knownItems, stale: bg.data.knownItemsServerStale }));

  // 服务起来了，盘上仍是旧的 tag.json（带写死日期、还有 short）
  const before = itemIds(bg);
  m.syncDown = false;
  m.opened.length = 0;
  m.syncCalls.length = 0;
  const bg2 = await boot(m, { data: structuredClone(bg.data), done: b => b.data.configAheadOfFile?.tag !== true && b.data.knownItemsServerStale === undefined });
  check('F2a 下次唤醒：旧 tag.json 不许覆盖本地订阅，也不许按它清理历史（一条不少）',
    show(bg2.data.urlTags) === show(storageTags(ROLLING_ENTRIES)) && show(itemIds(bg2)) === show(before), show({ tags: bg2.data.urlTags, ids: itemIds(bg2) }));
  check('F2b 改为把本地订阅写回文件，成功后摘标记', show(m.tagFile) === show(fileTags(ROLLING_ENTRIES)) && bg2.data.configAheadOfFile?.tag !== true,
    show({ file: m.tagFile, ahead: bg2.data.configAheadOfFile }));
  const pushed = m.syncCalls.find(c => c.method === 'POST' && c.route === '/known-items');
  check('F2c 片单补推整份、摘掉补推标记；切换不重跑', show(pushed?.body?.items) === show(bg.data.knownItems)
    && bg2.data.knownItemsServerStale === undefined && m.opened.length === 0, show({ pushed, opened: m.opened }));
}

// ================= N 没有旧形态的 IMDb 订阅 =================
{
  const own = `${BASE}release_date=2025-06-01,&genres=Drama`; // 用户自己写的别的日期条件：不是 v1.7.0 以前的统一起点
  const entries = [[ROLLING(CO1), ['IMDB']], [own, ['IMDB', 'Drama']], [NETFLIX, ['Netflix']]];
  const m = machine({ tagFile: fileTags(entries) });
  const lib = [card('tt1', { sourceListUrl: ROLLING(CO1) }), card('tt2', { sourceListUrl: own })];
  const bg = await boot(m, { data: { urlTags: storageTags(entries) }, dramas: lib });
  check('N1 不带写死日期（含用户自己写的其它日期条件）：订阅与条目原样，切换直接标完成（skipped）、不开任何页面',
    show(bg.data.urlTags) === show(storageTags(entries)) && byItem(bg, 'tt2')?.sourceListUrl === own
      && phaseOf(bg) === 'done' && bg.data.imdbRollingSwitch.skipped === true && m.opened.length === 0
      && !bg.log.some(l => l.startsWith('set:dramas')), show({ state: bg.data.imdbRollingSwitch, opened: m.opened }));
}

// ================= B 基线细节 =================
{
  const entries = [[ROLLING(CO1), ['IMDB']], [ROLLING(CO2), ['IMDB']]];
  const lib = [card('tt1', { sourceListUrl: ROLLING(CO1) }), card('tt2', { sourceListUrl: ROLLING(CO2) })];

  // B1 co1 不限日期那页为空（没加载完整）：整条跳过，只记 co2 的
  const m1 = machine({
    tagFile: fileTags(entries),
    pages: { [ROLLING(CO1)]: { windowed: [], wide: [] }, [ROLLING(CO2)]: { windowed: ['tt2'], wide: ['tt2', 'tt800'] } }
  });
  const bg1 = await boot(m1, { data: { urlTags: storageTags(entries), imdbRollingSwitch: { phase: 'baseline' }, knownItems: [] }, dramas: lib,
    done: b => b.data.imdbRollingSwitch?.phase === 'done' });
  check('B1 phase=baseline 唤醒只读基线（不再抓首轮）；不限日期那页为空按没读成、整条跳过',
    opens(m1, 'scrape').length === 0 && show((bg1.data.knownItems || []).map(k => k.id)) === show(['tt800']) && phaseOf(bg1) === 'done',
    show({ opened: m1.opened, known: bg1.data.knownItems }));

  // B2 一条都没读成：抛错，phase 停在 baseline，下次唤醒重来
  const m2 = machine({ tagFile: fileTags(entries), pages: { [ROLLING(CO1)]: { windowed: [], wide: ['tt1', 'tt801'] } } });
  m2.mode = 'down';
  const bg2 = await boot(m2, { data: { urlTags: storageTags(entries), imdbRollingSwitch: { phase: 'baseline' }, knownItems: [] }, dramas: lib,
    done: b => opens(m2, 'collectListIds').length >= 2 });
  check('B2a 基线一条都没读成：phase 停在 baseline、片单不动', phaseOf(bg2) === 'baseline' && show(bg2.data.knownItems) === '[]',
    show({ state: bg2.data.imdbRollingSwitch, known: bg2.data.knownItems }));
  m2.mode = 'ok';
  await bg2.run('resumeImdbRollingSwitch()');
  await settle(bg2);
  check('B2b 下次重来读成：记下窗口外的 tt801，phase=done', show((bg2.data.knownItems || []).map(k => k.id)) === show(['tt801'])
    && phaseOf(bg2) === 'done', show(bg2.data.knownItems));

  // B3 窗口设 0（不限日期）：两页是同一页，没有窗口外的老片可记
  const m3 = machine({
    tagFile: fileTags(entries), cron: { scheduleMode: 'interval', scrapeInterval: 6, translateInterval: 1, imdbWindowDays: 0 },
    pages: { [ROLLING(CO1)]: { windowed: ['tt1', 'tt802'], wide: ['tt1', 'tt802'] }, [ROLLING(CO2)]: { windowed: ['tt2'], wide: ['tt2'] } }
  });
  const bg3 = await boot(m3, {
    data: { urlTags: storageTags(entries), imdbRollingSwitch: { phase: 'baseline' }, knownItems: [] },
    dramas: lib, done: b => b.data.imdbRollingSwitch?.phase === 'done'
  });
  check('B3 窗口为 0：每条订阅只读一页、片单不记任何 ID，phase=done（knownAdded 0）',
    show(opens(m3, 'collectListIds')) === show([ROLLING(CO1), ROLLING(CO2)]) && show(bg3.data.knownItems) === '[]'
      && bg3.data.imdbRollingSwitch?.knownAdded === 0, show({ opened: m3.opened, state: bg3.data.imdbRollingSwitch }));
}

// ================= R 切换首轮只拿到空列表 =================
{
  const entries = [[LEGACY(CO1), ['IMDB']], [LEGACY(CO2), ['IMDB']]];
  // 两页都「抓成」了，但页面上一条列表项都没有（站点改版 / 没加载完整）：不算真正抓成，不往基线走
  const m = machine({ tagFile: fileTags(entries), pages: { [ROLLING(CO1)]: { windowed: [], wide: [] }, [ROLLING(CO2)]: { windowed: [], wide: [] } } });
  const bg = await boot(m, { data: { urlTags: storageTags(entries) }, dramas: [card('tt1', { sourceListUrl: LEGACY(CO1) }), card('tt2', { sourceListUrl: LEGACY(CO2) })],
    done: b => opens(m, 'scrape').length >= 2 && b.run('activeScrapeCount') === 0 });
  check('R1 切换首轮两页都只拿到空列表：phase 仍是 firstRound、不读基线列表，两条订阅保持「进行中」',
    phaseOf(bg) === 'firstRound' && opens(m, 'collectListIds').length === 0
      && [ROLLING(CO1), ROLLING(CO2)].every(url => baselineOf(bg, url) === 'pending'), show({ state: bg.data.imdbRollingSwitch, opened: m.opened, baselines: bg.data.larkBotState?.urlBaseline }));
}

// ================= W 改天数后的第一轮 IMDb 不推群 =================
{
  const entries = [[ROLLING(CO1), ['IMDB']], [ROLLING(CO2), ['IMDB']], [NETFLIX, ['Netflix']]];
  const lib = [card('tt1', { sourceListUrl: ROLLING(CO1) }), card('tt2', { sourceListUrl: ROLLING(CO2) }),
    card('nf-1', { source: 'netflix', sourceListUrl: NETFLIX, tags: ['Netflix'] })];
  const m = machine({ tagFile: fileTags(entries), lark: {} });
  const bg = await boot(m, {
    data: {
      urlTags: storageTags(entries), imdbRollingSwitch: { phase: 'done' }, knownItems: [],
      larkBotState: { imdbWindowDays: 180 }
    },
    dramas: lib
  });
  const setDays = days => { bg.data.scheduleConfig = { ...bg.data.scheduleConfig, imdbWindowDays: days }; };
  const imdbBaselines = () => [ROLLING(CO1), ROLLING(CO2)].map(url => baselineOf(bg, url));

  // W0 天数没变（180）：IMDb 照常推，不设基线
  m.opened.length = 0;
  await bg.run('performScrapeOnce()');
  check('W0 天数与上次生效的一致：不静音（IMDb 订阅不设基线），打开的地址按 180 天补日期、别站原样',
    imdbBaselines().every(b => b === undefined) && show(m.opened.map(o => o.url)) === show([windowed(ROLLING(CO1), 180, T0), windowed(ROLLING(CO2), 180, T0), NETFLIX]),
    show({ baselines: imdbBaselines(), opened: m.opened }));

  // W1 改成 90 天：这一轮 IMDb 整轮静音、记下 90；别站不连坐
  setDays(90);
  bg.setTime(T0 + 60_000);
  m.opened.length = 0;
  await bg.run('performScrapeOnce()');
  check('W1a 改成 90 天后的第一轮：按 90 天补日期', show(opens(m, 'scrape').slice(0, 2)) === show([windowed(ROLLING(CO1), 90, T0 + 60_000), windowed(ROLLING(CO2), 90, T0 + 60_000)]),
    show(m.opened));
  check('W1b 该轮 IMDb 订阅基线收口在收轮时刻（整轮只入库不推送），别站订阅不设基线，记下 90',
    imdbBaselines().every(b => b === new Date(T0 + 60_000).toISOString()) && baselineOf(bg, NETFLIX) === undefined
      && bg.data.larkBotState.imdbWindowDays === 90, show(bg.data.larkBotState));

  // W2 天数不变的下一轮：不再静音（基线不前移）
  bg.setTime(T0 + 120_000);
  await bg.run('performScrapeOnce()');
  check('W2 天数没再变：下一轮不再静音（基线不前移）', imdbBaselines().every(b => b === new Date(T0 + 60_000).toISOString()),
    show(bg.data.larkBotState.urlBaseline));

  // W3 IMDb 页全失败：不记天数，下一轮仍静音
  setDays(30);
  m.mode = 'down';
  bg.setTime(T0 + 180_000);
  await bg.run('performScrapeOnce()');
  check('W3a 改成 30 天但 IMDb 页全失败：不记天数（仍是 90）', bg.data.larkBotState.imdbWindowDays === 90, show(bg.data.larkBotState));
  m.mode = 'ok';
  bg.setTime(T0 + 240_000);
  await bg.run('performScrapeOnce()');
  check('W3b 下一轮抓成：仍按窗口变化静音，基线收口在这一轮、记下 30',
    imdbBaselines().every(b => b === new Date(T0 + 240_000).toISOString()) && bg.data.larkBotState.imdbWindowDays === 30,
    show(bg.data.larkBotState));

  // W4 只抓别站的轮次不碰 IMDb 的记录
  setDays(0);
  bg.setTime(T0 + 300_000);
  await bg.run("performScrapeOnce({ site: 'netflix' })");
  check('W4 只抓 Netflix 的一轮：不判也不记 IMDb 窗口（天数改了也留到下一轮 IMDb）',
    bg.data.larkBotState.imdbWindowDays === 30 && imdbBaselines().every(b => b === new Date(T0 + 240_000).toISOString()),
    show(bg.data.larkBotState));

  // W5 改成 0（不限日期）：打开订阅 URL 本身，同样算窗口变化
  m.opened.length = 0;
  bg.setTime(T0 + 360_000);
  await bg.run("performScrapeOnce({ site: 'imdb' })");
  check('W5 改成 0：打开订阅 URL 本身（不补日期），这一轮同样静音、记下 0',
    show(m.opened.map(o => o.url)) === show([ROLLING(CO1), ROLLING(CO2)]) && bg.data.larkBotState.imdbWindowDays === 0
      && imdbBaselines().every(b => b === new Date(T0 + 360_000).toISOString()), show({ opened: m.opened, state: bg.data.larkBotState }));

  // W6 改天数那一轮 co1 没抓成：co1 保持「进行中」（下一轮照样不推），co2 照常收口；天数照记
  setDays(120);
  m.failUrls.add(ROLLING(CO1));
  bg.setTime(T0 + 420_000);
  await bg.run("performScrapeOnce({ site: 'imdb' })");
  check('W6a 改成 120 天那一轮 co1 失败：co1 保持「进行中」、co2 收口在这一轮，记下 120',
    baselineOf(bg, ROLLING(CO1)) === 'pending' && baselineOf(bg, ROLLING(CO2)) === new Date(T0 + 420_000).toISOString()
      && bg.data.larkBotState.imdbWindowDays === 120, show(bg.data.larkBotState));
  m.failUrls.clear();
  bg.setTime(T0 + 480_000);
  await bg.run("performScrapeOnce({ site: 'imdb' })");
  check('W6b 下一轮（天数没变、不再整轮静音）co1 第一次真正抓成：这一轮才给 co1 收口，co2 的基线不动',
    baselineOf(bg, ROLLING(CO1)) === new Date(T0 + 480_000).toISOString() && baselineOf(bg, ROLLING(CO2)) === new Date(T0 + 420_000).toISOString(),
    show(bg.data.larkBotState.urlBaseline));

  // W7 页面上没找到列表（抓到 0 条告警）同样不收口
  setDays(60);
  m.pages[ROLLING(CO2)] = { windowed: [], wide: [] };
  bg.setTime(T0 + 540_000);
  await bg.run("performScrapeOnce({ site: 'imdb' })");
  check('W7 改成 60 天那一轮 co2 页面上没找到列表：co2 保持「进行中」，co1 照常收口',
    baselineOf(bg, ROLLING(CO2)) === 'pending' && baselineOf(bg, ROLLING(CO1)) === new Date(T0 + 540_000).toISOString(),
    show(bg.data.larkBotState.urlBaseline));
}

// ================= K 已知片单 =================
{
  const entries = [[ROLLING(CO1), ['IMDB']], [NETFLIX, ['Netflix']]];
  const known = [
    { id: 'tt900', site: 'imdb', at: '2026-09-27T00:00:00.000Z', reason: 'IMDb 切换基线' },
    { id: 'x-any', at: '2026-09-27T00:00:00.000Z', reason: '没写站点' }
  ];

  // K1 本地从没有过片单，服务端有：恢复
  const m1 = machine({ tagFile: fileTags(entries), serverKnown: known });
  const bg1 = await boot(m1, { data: { urlTags: storageTags(entries), imdbRollingSwitch: { phase: 'done' } }, done: b => Array.isArray(b.data.knownItems) });
  check('K1 本地从没有过片单（新装 / 重装）：唤醒从同步服务恢复，不回推', show(bg1.data.knownItems) === show(known)
    && !m1.syncCalls.some(c => c.method === 'POST' && c.route === '/known-items'), show({ known: bg1.data.knownItems, calls: m1.syncCalls }));

  // K2 抓取上下文与入库兜底
  const imdbCtx = await bg1.context.scrapeContextForContent({ tab: { url: `${BASE}${CO1}&release_date=2026-03-31,` } });
  const nfCtx = await bg1.context.scrapeContextForContent({ tab: { url: NETFLIX } });
  const has = (ctx, id) => ctx.known.some(([k, v]) => k === id && v === true);
  check('K2a 抓取上下文把片单按「已存在、已有 genres」下发（内容脚本直接跳过、不回填）；按站点给，没写站点的都给',
    has(imdbCtx, 'tt900') && has(imdbCtx, 'x-any') && !has(nfCtx, 'tt900') && has(nfCtx, 'x-any'),
    show({ imdb: imdbCtx.known, netflix: nfCtx.known }));
  const rejected = await bg1.context.saveDramaRecord(card('tt900', { sourceListUrl: ROLLING(CO1) }));
  const accepted = await bg1.context.saveDramaRecord(card('tt901', { sourceListUrl: ROLLING(CO1) }));
  check('K2b 入库兜底：片单里的 ID 拒收，别的照常入库', rejected === false && accepted === true && show(itemIds(bg1)) === show(['tt901']),
    show({ rejected, accepted, ids: itemIds(bg1) }));

  // K3 服务没开：不记空片单，下次唤醒再问
  const m3 = machine({ tagFile: fileTags(entries), serverKnown: known, syncDown: true });
  const bg3 = await boot(m3, { data: { urlTags: storageTags(entries), imdbRollingSwitch: { phase: 'done' } },
    done: b => m3.syncCalls.some(c => c.route === '/known-items') });
  check('K3a 同步服务没开：片单键保持缺省（不当成「服务端没有」）', bg3.data.knownItems === undefined, show(bg3.data.knownItems));
  m3.syncDown = false;
  const bg3b = await boot(m3, { data: structuredClone(bg3.data), done: b => Array.isArray(b.data.knownItems) });
  check('K3b 服务起来后的下次唤醒照常恢复', show(bg3b.data.knownItems) === show(known), show(bg3b.data.knownItems));

  // K4 追加时推不上去：留补推标记，下次唤醒整份补推
  const m4 = machine({ tagFile: fileTags(entries), serverKnown: [], syncDown: true });
  const bg4 = await boot(m4, { data: { urlTags: storageTags(entries), imdbRollingSwitch: { phase: 'done' }, knownItems: [known[0]] } });
  const merged = await bg4.context.addKnownItems([{ id: 'tt902', site: 'imdb', at: 'x', reason: 'r' }, { id: 'tt900', site: 'imdb', at: 'y', reason: '重复' }]);
  check('K4a 追加按 id 去重（先记下的保留原时间与原因），推不上去就留补推标记',
    show(merged.map(k => [k.id, k.at])) === show([['tt900', known[0].at], ['tt902', 'x']]) && bg4.data.knownItemsServerStale === true,
    show({ merged, stale: bg4.data.knownItemsServerStale }));
  m4.syncDown = false;
  m4.syncCalls.length = 0;
  const bg4b = await boot(m4, { data: structuredClone(bg4.data), done: b => b.data.knownItemsServerStale === undefined });
  check('K4b 下次唤醒补推整份片单并摘标记（不再 GET）', show(m4.serverKnown) === show(merged) && bg4b.data.knownItemsServerStale === undefined
    && !m4.syncCalls.some(c => c.method === 'GET'), show({ server: m4.serverKnown, calls: m4.syncCalls }));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
