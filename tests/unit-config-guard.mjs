import './bootstrap.cjs';
// 批次 A 数据安全护栏（2026-09-25 审计）的后台侧回归：
//   A2/A4 配置回读：configAheadOfFile 标记的配置不被旧文件覆盖、改为推回同步服务并在成功后摘标记；
//         cron/trans/lark.json 读取或解析失败时保留 storage 旧值（storage 也没有才用默认值）；
//   A2    订阅外清理删除前先把整批条目落进 storage.pruneTrash（最新在尾、最多 3 批）；
//   A1    空时间线只在 allowEmptySync 标记下推送（带 allowEmpty），409 不重试，非空推送成功后摘标记。
// 全部走 background-fixture 的 vm 桩：配置文件与同步服务都是 fetch 桩，不连任何真实端口。
// 用法：node tests/unit-config-guard.mjs
import { background, card, SUB, PAGE_SENDER } from './background-fixture.mjs';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const SUB2 = 'https://store.steampowered.com/category/unit';
const SERVER = 'http://127.0.0.1:31919/';
const LOCAL_LARK = { botEnabled: true, botWebhookUrl: 'https://open.larksuite.com/open-apis/bot/v2/hook/local' };
const BOT_STATE = { enabledAt: '2026-09-01T00:00:00.000Z', retryQueue: [{ id: 'id_tt0001', attempts: 1 }] };

/**
 * files：文件名 → 内容对象 | 'SYNTAX'（JSON 损坏）| 404；server(key|'sync', body) → { status, body }。
 * 没配 server 时同步服务一律连不上（与服务未启动同形）。
 */
async function makeBg({ files = {}, server = null } = {}) {
  const bg = await background();
  const posts = [];
  const warnings = [];
  bg.context.console.warn = (...args) => warnings.push(args.map(String).join(' '));
  bg.context.chrome.storage.local.remove = async keys => {
    for (const key of typeof keys === 'string' ? [keys] : keys) delete bg.data[key];
  };
  bg.files = { 'tag.json': [{ url: SUB, tags: ['IMDB'] }], 'cron.json': {}, 'trans.json': {}, 'lark.json': {}, ...files };
  bg.server = server;
  bg.context.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('chrome-extension://fixture/config/')) {
      const content = bg.files[u.slice('chrome-extension://fixture/config/'.length)];
      if (content === 404 || content === undefined) return { ok: false, status: 404, async json() { throw new SyntaxError('404 page'); } };
      if (content === 'SYNTAX') return { ok: true, status: 200, async json() { throw new SyntaxError('Unexpected token } in JSON at position 42'); } };
      return { ok: true, status: 200, async json() { return structuredClone(content); } };
    }
    if (u.startsWith(SERVER)) {
      const key = u.slice(SERVER.length).replace(/^config\//, '');
      const body = JSON.parse(init.body);
      posts.push({ key, body });
      if (!bg.server) throw new TypeError('Failed to fetch');
      const reply = await bg.server(key, body);
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, async json() { return reply.body; } };
    }
    throw new Error('External network disabled in test');
  };
  bg.posts = posts;
  bg.warnings = warnings;
  bg.reload = () => bg.run('loadConfigFromJsonFiles()');
  bg.seed = (...dramas) => { bg.data.dramas = dramas; bg.run('dramasCache = null'); };
  bg.ids = () => (bg.data.dramas || []).map(d => d.itemId).sort().join(',');
  bg.normalized = (name, raw) => JSON.parse(JSON.stringify(bg.run(`${name}.normalizeConfig(${JSON.stringify(raw)})`)));
  return bg;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ok = { status: 200, body: { ok: true } };

// ---------- C1 本地领先于文件：四个配置都不被旧文件覆盖，推回服务端，成功后摘标记 ----------
{
  const bg = await makeBg({ server: async () => ok });
  const localTags = [{ urlPattern: SUB, tags: ['IMDB'] }, { urlPattern: SUB2, tags: ['Steam'] }];
  const localTrans = bg.normalized('TranslateConfig', { translateMode: 'ai', aiApiKey: 'sk-local', aiModel: 'local-model' });
  const localCron = bg.normalized('ScheduleConfig', { scheduleMode: 'interval', scrapeInterval: 3, translateInterval: 2 });
  const localLark = bg.normalized('Lark', LOCAL_LARK);
  Object.assign(bg.data, {
    urlTags: localTags, translateConfig: localTrans, scheduleConfig: localCron, larkConfig: localLark,
    larkBotState: BOT_STATE, configAheadOfFile: { tag: true, cron: true, trans: true, lark: true }
  });
  bg.seed(card('tt0001'), card('st0001', { source: 'steam', sourceListUrl: SUB2 }));
  // 文件是旧的：只有 IMDB 订阅、翻译 api、默认 cron、机器人关
  await bg.reload();
  check('C1a 标记的 urlTags 不被旧 tag.json 覆盖', same(bg.data.urlTags, localTags), JSON.stringify(bg.data.urlTags));
  check('C1b 不按旧文件订阅清理：新订阅下的历史保留', bg.ids() === 'st0001,tt0001', bg.ids());
  check('C1c 翻译/定时/Lark 配置保留本地值', same(bg.data.translateConfig, localTrans) && same(bg.data.scheduleConfig, localCron) && same(bg.data.larkConfig, localLark),
    JSON.stringify([bg.data.translateConfig.translateMode, bg.data.scheduleConfig.scrapeInterval, bg.data.larkConfig.botEnabled]));
  check('C1d 机器人水位线与重试队列未被清空', same(bg.data.larkBotState, BOT_STATE), JSON.stringify(bg.data.larkBotState));
  const byKey = Object.fromEntries(bg.posts.map(p => [p.key, p.body]));
  check('C1e 四个配置都推回同步服务，请求体与设置页 trySyncConfig 同形',
    bg.posts.length === 4 && same(byKey.tag, { urlTags: localTags }) && same(byKey.trans, { translateConfig: localTrans })
    && same(byKey.cron, { scheduleConfig: localCron }) && same(byKey.lark, { larkConfig: localLark }), JSON.stringify(bg.posts));
  check('C1f 写回成功后四个标记都摘掉', same(bg.data.configAheadOfFile, {}), JSON.stringify(bg.data.configAheadOfFile));
  check('C1g 无删除即不产生回收站批次', bg.data.pruneTrash === undefined, JSON.stringify(bg.data.pruneTrash));
}

// ---------- C2 写回仍失败：本地值与标记都保留，下次唤醒重试 ----------
{
  const bg = await makeBg(); // 同步服务连不上
  const localTrans = bg.normalized('TranslateConfig', { translateMode: 'ai', aiApiKey: 'sk-local' });
  Object.assign(bg.data, { translateConfig: localTrans, configAheadOfFile: { trans: true } });
  await bg.reload();
  check('C2a 服务不可用：保留本地翻译配置', same(bg.data.translateConfig, localTrans), JSON.stringify(bg.data.translateConfig));
  check('C2b 尝试过写回且标记保留', bg.posts.length === 1 && bg.posts[0].key === 'trans' && same(bg.data.configAheadOfFile, { trans: true }),
    JSON.stringify({ posts: bg.posts, flag: bg.data.configAheadOfFile }));
  bg.server = async () => ({ status: 400, body: { ok: false, error: '缺少有效的 translateConfig 对象，未写入' } });
  await bg.reload();
  check('C2c 服务端拒绝（400）同样不摘标记', same(bg.data.configAheadOfFile, { trans: true }), JSON.stringify(bg.data.configAheadOfFile));
}

// ---------- C3 只标记部分键：未标记的照常由文件覆盖；写回期间本地值又变 → 不摘该键 ----------
{
  const bg = await makeBg({ files: { 'trans.json': { translateMode: 'ai', aiApiKey: 'sk-file' } } });
  const localCron = bg.normalized('ScheduleConfig', { scheduleMode: 'interval', scrapeInterval: 5, translateInterval: 5 });
  const newerCron = bg.normalized('ScheduleConfig', { scheduleMode: 'interval', scrapeInterval: 7, translateInterval: 7 });
  Object.assign(bg.data, {
    scheduleConfig: localCron, translateConfig: bg.normalized('TranslateConfig', {}), configAheadOfFile: { cron: true, lark: false }
  });
  // 写回在飞时设置页又存了新的定时配置（写回也失败、重新置了标记）
  bg.server = async () => { bg.data.scheduleConfig = newerCron; return ok; };
  await bg.reload();
  check('C3a 未标记的 trans 照常由文件覆盖 storage', bg.data.translateConfig.aiApiKey === 'sk-file', JSON.stringify(bg.data.translateConfig));
  check('C3b 标记为 false 的键不算领先（lark 不写回）', bg.posts.length === 1 && bg.posts[0].key === 'cron', JSON.stringify(bg.posts));
  check('C3c 写回期间本地值已变 → cron 标记不摘', bg.data.configAheadOfFile.cron === true && same(bg.data.scheduleConfig, newerCron),
    JSON.stringify({ flag: bg.data.configAheadOfFile, cron: bg.data.scheduleConfig }));
}

// ---------- C3d/C3e 写回在飞时设置页按「文件优先」退订并清了标记：迟到的旧值 POST 可能已把
// tag.json 盖回旧订阅，必须重新置位，下次唤醒按 storage 现值再推，文件才会追平 ----------
{
  const bg = await makeBg();
  const oldTags = [{ urlPattern: SUB, tags: ['IMDB'] }, { urlPattern: SUB2, tags: ['Steam'] }];
  const newTags = [{ urlPattern: SUB, tags: ['IMDB'] }];
  Object.assign(bg.data, { urlTags: oldTags, configAheadOfFile: { tag: true } });
  bg.server = async key => {
    if (key === 'tag') { bg.data.urlTags = newTags; bg.data.configAheadOfFile = {}; }
    return ok;
  };
  await bg.reload();
  check('C3d 写回期间本地已退订且标记被清 → 重新置位 tag 标记', bg.data.configAheadOfFile?.tag === true && same(bg.data.urlTags, newTags),
    JSON.stringify({ flag: bg.data.configAheadOfFile, urlTags: bg.data.urlTags }));
  bg.posts.length = 0;
  bg.server = async () => ok;
  await bg.reload();
  check('C3e 下次唤醒推回 storage 现值（已退订）并摘标记，旧文件不会复活订阅',
    bg.posts.length === 1 && same(bg.posts[0].body, { urlTags: newTags }) && same(bg.data.configAheadOfFile, {}) && same(bg.data.urlTags, newTags),
    JSON.stringify({ posts: bg.posts, flag: bg.data.configAheadOfFile }));
}

// ---------- C5 标记在但本地值结构坏：不推坏值（服务端只会 400、标记永远摘不掉），交给文件 ----------
{
  const bg = await makeBg({ server: async () => ok, files: { 'trans.json': { translateMode: 'api', apiEndpoint: 'https://api.example/get' } } });
  Object.assign(bg.data, { translateConfig: null, configAheadOfFile: { trans: true } });
  await bg.reload();
  check('C5 标记在但本地值不是对象：不写回，由文件接管', bg.posts.length === 0 && bg.data.translateConfig?.translateMode === 'api',
    JSON.stringify({ posts: bg.posts, trans: bg.data.translateConfig }));
}

// ---------- C4 cron/trans/lark.json 读取或解析失败：保留 storage 旧值，告警点名文件 ----------
{
  const bg = await makeBg({ files: { 'trans.json': 'SYNTAX', 'lark.json': 'SYNTAX', 'cron.json': 404 } });
  const localTrans = bg.normalized('TranslateConfig', { translateMode: 'ai', aiApiKey: 'sk-local' });
  const localCron = bg.normalized('ScheduleConfig', { scheduleMode: 'cron', scrapeCron: '15 */2 * * *', translateCron: '45 * * * *' });
  const localLark = bg.normalized('Lark', LOCAL_LARK);
  Object.assign(bg.data, { translateConfig: localTrans, scheduleConfig: localCron, larkConfig: localLark, larkBotState: BOT_STATE });
  await bg.reload();
  check('C4a trans.json 损坏：AI 模式与 Key 保留，不回落 MyMemory', same(bg.data.translateConfig, localTrans), JSON.stringify(bg.data.translateConfig));
  check('C4b cron.json 缺失：定时配置保留', same(bg.data.scheduleConfig, localCron), JSON.stringify(bg.data.scheduleConfig));
  check('C4c lark.json 损坏：机器人配置保留、larkBotState 未被清空',
    same(bg.data.larkConfig, localLark) && same(bg.data.larkBotState, BOT_STATE), JSON.stringify([bg.data.larkConfig, bg.data.larkBotState]));
  check('C4d 告警点名三个出错的文件',
    ['config/trans.json', 'config/lark.json', 'config/cron.json'].every(f => bg.warnings.some(w => w.includes(f) && w.includes('保留'))),
    JSON.stringify(bg.warnings));
  check('C4e 读取失败不写回服务端', bg.posts.length === 0, JSON.stringify(bg.posts));

  // storage 里也没有 → 才用默认值（并落库，供 setupAlarms 等读者使用）
  delete bg.data.translateConfig;
  delete bg.data.scheduleConfig;
  await bg.reload();
  check('C4f storage 也没有时种默认值', same(bg.data.translateConfig, bg.normalized('TranslateConfig', {}))
    && same(bg.data.scheduleConfig, bg.normalized('ScheduleConfig', {})), JSON.stringify([bg.data.translateConfig, bg.data.scheduleConfig]));

  // 文件修好 → 读成功照常覆盖 storage（既有语义）
  bg.files['trans.json'] = { translateMode: 'api', apiEndpoint: 'https://api.example/get' };
  await bg.reload();
  check('C4g 读成功照常以文件覆盖 storage', bg.data.translateConfig.translateMode === 'api' && bg.data.translateConfig.apiEndpoint === 'https://api.example/get',
    JSON.stringify(bg.data.translateConfig));
  bg.files['cron.json'] = [1, 2];
  bg.data.scheduleConfig = localCron;
  await bg.reload();
  check('C4h cron.json 结构不是对象按读取失败处理', same(bg.data.scheduleConfig, localCron), JSON.stringify(bg.data.scheduleConfig));
}

// ---------- P1-P4 回收站 pruneTrash ----------
{
  const bg = await makeBg();
  const OUT = 'https://other.example/x';
  // P1 SW 唤醒回读 tag.json 少了一条订阅 → 删前落回收站
  bg.data.urlTags = [{ urlPattern: SUB, tags: ['IMDB'] }, { urlPattern: SUB2, tags: ['Steam'] }];
  delete bg.data.pruneFingerprint;
  bg.seed(card('tt0001'), card('st0001', { source: 'steam', sourceListUrl: SUB2 }), card('st0002', { source: 'steam', sourceListUrl: SUB2 }));
  await bg.reload();
  const trash = bg.data.pruneTrash || [];
  const entry = trash[0] || {};
  check('P1a 回读清理照常删掉界外历史', bg.ids() === 'tt0001', bg.ids());
  check('P1b 回收站记一批：时间、原因、来源 URL、整批条目', trash.length === 1
    && !Number.isNaN(Date.parse(entry.at)) && new Date(entry.at).toISOString() === entry.at
    && typeof entry.reason === 'string' && entry.reason.includes('tag.json')
    && same(entry.urls, [SUB2]) && same((entry.dramas || []).map(d => d.itemId).sort(), ['st0001', 'st0002']),
    JSON.stringify(trash));
  check('P1c 回收站里是完整条目（可直接导入恢复）', same(entry.dramas?.find(d => d.itemId === 'st0001'), card('st0001', { source: 'steam', sourceListUrl: SUB2 })),
    JSON.stringify(entry.dramas?.[0]));

  // P3 无删除 → 不追加
  await bg.run(`pruneDramasOutsideConfiguredUrls(${JSON.stringify(bg.data.urlTags)}, { force: true })`);
  check('P3 未删任何条目不追加回收站批次', (bg.data.pruneTrash || []).length === 1, String((bg.data.pruneTrash || []).length));

  // P2 上限 3 批、最新在尾（抓取结束的强制清理与 onChanged 路径同样落回收站）
  for (let i = 1; i <= 3; i++) {
    bg.seed(card('tt0001'), card(`out${i}`, { sourceListUrl: OUT }));
    bg.setTime(Date.parse(`2026-09-05T0${i}:00:00Z`));
    await bg.run(`pruneDramasOutsideConfiguredUrls(${JSON.stringify(bg.data.urlTags)}, { force: true, reason: 'r${i}' })`);
  }
  const capped = bg.data.pruneTrash || [];
  check('P2a 回收站最多保留 3 批，丢最旧', capped.length === 3 && same(capped.map(e => e.reason), ['r1', 'r2', 'r3']), JSON.stringify(capped.map(e => e.reason)));
  check('P2b 最新一批在尾且内容对应', same(capped.at(-1)?.dramas?.map(d => d.itemId), ['out3']) && same(capped.at(-1)?.urls, [OUT])
    && capped[0].at < capped.at(-1).at, JSON.stringify(capped.at(-1)));
  bg.seed(card('tt0001'), card('out4', { sourceListUrl: OUT }));
  bg.listeners.changed({ urlTags: { newValue: [{ urlPattern: SUB, tags: ['IMDB'] }, { urlPattern: 'https://new.example/', tags: ['N'] }] } }, 'local');
  await bg.run('dramaWriteQueue');
  const afterChanged = bg.data.pruneTrash || [];
  check('P2c onChanged(urlTags) 路径同样落回收站', afterChanged.length === 3 && same(afterChanged.at(-1)?.dramas?.map(d => d.itemId), ['out4'])
    && afterChanged[0].reason === 'r2', JSON.stringify(afterChanged.map(e => e.reason)));

  // P4 回收站写失败 → 本轮不删
  const origSet = bg.context.chrome.storage.local.set;
  bg.context.chrome.storage.local.set = async function (values) {
    if ('pruneTrash' in values) throw new Error('unit stub: 回收站写入失败');
    return origSet.call(this, values);
  };
  bg.seed(card('tt0001'), card('out5', { sourceListUrl: OUT }));
  let rejected = false;
  await bg.run(`pruneDramasOutsideConfiguredUrls(${JSON.stringify(bg.data.urlTags)}, { force: true })`).catch(() => { rejected = true; });
  bg.context.chrome.storage.local.set = origSet;
  check('P4 回收站写失败时不删历史并向上报错', rejected && bg.ids() === 'out5,tt0001', `rejected=${rejected} ids=${bg.ids()}`);

  // P5 删除那次写失败 → 回收站也不变（二者同一次 set）：否则每次重试都多进一批「没删成」的
  // 重复条目，把回收站里真正删过的旧批挤出去
  const trashBefore = JSON.stringify(bg.data.pruneTrash);
  bg.context.chrome.storage.local.set = async function (values) {
    if ('dramas' in values) throw new Error('unit stub: dramas 写入失败');
    return origSet.call(this, values);
  };
  rejected = false;
  for (let i = 0; i < 2; i++) {
    await bg.run(`pruneDramasOutsideConfiguredUrls(${JSON.stringify(bg.data.urlTags)}, { force: true })`).catch(() => { rejected = true; });
  }
  bg.context.chrome.storage.local.set = origSet;
  check('P5 删除写失败（重试两次）：回收站不多出没删成的批次、历史保留', rejected && JSON.stringify(bg.data.pruneTrash) === trashBefore
    && bg.ids() === 'out5,tt0001', `rejected=${rejected} trash=${(bg.data.pruneTrash || []).map(e => e.reason)} ids=${bg.ids()}`);
}

// ---------- S1-S7 空时间线推送护栏（A1 客户端） ----------
{
  const syncPosts = bg => bg.posts.filter(p => p.key === 'sync');
  const resetSync = bg => bg.run('lastCsvSyncSerialized = null; csvSyncTimer = null');

  // S1 空库、无标记：不推送（新 profile / 重装扩展冷启动）
  const bg = await makeBg({ server: async () => ({ status: 200, body: { ok: true, count: 0, csvPath: 'stub.csv' } }) });
  bg.seed();
  resetSync(bg);
  await bg.run('syncTimelineToCsv()');
  await bg.run('syncTimelineToCsv()');
  check('S1a 空库无标记：不 POST /sync', syncPosts(bg).length === 0, JSON.stringify(bg.posts));
  check('S1b 跳过只告警一次', bg.warnings.filter(w => w.includes('CSV 同步跳过')).length === 1, JSON.stringify(bg.warnings));

  // S7 安装路径清库不写标记，随后照样不推
  bg.seed(card('tt0001'));
  await bg.run('clearAllDramas()');
  resetSync(bg);
  await bg.run('syncTimelineToCsv()');
  check('S7 install 路径 clearAllDramas 不写 allowEmptySync、不推空', bg.data.allowEmptySync === undefined && syncPosts(bg).length === 0,
    JSON.stringify({ flag: bg.data.allowEmptySync, posts: bg.posts }));

  // S2 带标记：推空并声明 allowEmpty；推空成功后标记保留
  bg.data.allowEmptySync = true;
  await bg.run('syncTimelineToCsv()');
  const emptyPost = syncPosts(bg)[0]?.body;
  check('S2a 有标记：推送 { dramas: [], allowEmpty: true }', syncPosts(bg).length === 1 && same(emptyPost?.dramas, []) && emptyPost?.allowEmpty === true,
    JSON.stringify(emptyPost));
  check('S2b 推空成功后标记保留（仍是用户要的空库）', bg.data.allowEmptySync === true, String(bg.data.allowEmptySync));

  // S3 非空推送成功 → 摘标记；非空推送不带 allowEmpty
  bg.seed(card('tt0001'));
  resetSync(bg);
  await bg.run('syncTimelineToCsv()');
  const fullPost = syncPosts(bg).at(-1)?.body;
  check('S3a 非空推送不带 allowEmpty', fullPost?.dramas?.length === 1 && !('allowEmpty' in fullPost), JSON.stringify(fullPost));
  check('S3b 非空推送成功后删除 allowEmptySync', !('allowEmptySync' in bg.data), String(bg.data.allowEmptySync));

  // S3c 推送在飞期间 dramas 又变（防抖同步待发）→ 不删，交给下一次判定
  bg.data.allowEmptySync = true;
  bg.seed(card('tt0002'));
  bg.run('lastCsvSyncSerialized = null');
  bg.server = async () => { bg.run('csvSyncTimer = 1'); return { status: 200, body: { ok: true, count: 1, csvPath: 'stub.csv' } }; };
  await bg.run('syncTimelineToCsv()');
  check('S3c 推送期间有待发同步时不删标记', bg.data.allowEmptySync === true, String(bg.data.allowEmptySync));

  // S3d 推送期间新一次同步已被安排且定时器已触发（与本次并行在飞）→ 同样不删：那次可能正是
  // 用户确认的清空，失败时残留标记要留给下次唤醒重推
  bg.seed(card('tt0003'));
  bg.run('lastCsvSyncSerialized = null; csvSyncTimer = null');
  bg.server = async () => { bg.run('csvSyncScheduleSeq++'); return { status: 200, body: { ok: true, count: 1, csvPath: 'stub.csv' } }; };
  await bg.run('syncTimelineToCsv()');
  check('S3d 推送期间已有新一次同步发出时不删标记', bg.data.allowEmptySync === true, String(bg.data.allowEmptySync));
  bg.run('csvSyncTimer = null');

  // S4 409：不抛、不重试同一份内容
  bg.server = async () => ({ status: 409, body: { ok: false, code: 'EMPTY_REJECTED', error: '拒绝用空时间线覆盖现有 3 条（未带 allowEmpty）' } });
  bg.seed();
  resetSync(bg);
  const before = syncPosts(bg).length;
  let threw = null;
  await bg.run('syncTimelineToCsv()').catch(e => { threw = e; });
  await bg.run('syncTimelineToCsv()').catch(e => { threw = e; });
  check('S4a 409 不抛异常', threw === null, String(threw?.message));
  check('S4b 409 后同内容不再重推', syncPosts(bg).length === before + 1, `posts=${syncPosts(bg).length - before}`);
  check('S4c 409 告警带服务端错误码', bg.warnings.some(w => w.includes('EMPTY_REJECTED')), JSON.stringify(bg.warnings));
}

// ---------- S5/S6 设置页「按条件清理」：清空时间线才写 allowEmptySync ----------
{
  const bg = await makeBg();
  const send = request => new Promise(resolve => bg.listeners.message(request, PAGE_SENDER, resolve));
  const prune = async sites => {
    const preview = await send({ action: 'pruneDramas', sites, dryRun: true });
    return send({ action: 'pruneDramas', sites, previewToken: preview.previewToken });
  };
  bg.data.urlTags = [{ urlPattern: SUB, tags: ['IMDB'] }, { urlPattern: SUB2, tags: ['Steam'] }];
  bg.seed(card('tt0001'), card('st0001', { source: 'steam', sourceListUrl: SUB2 }));
  const partial = await prune(['imdb']);
  check('S5 清理后时间线仍非空：不写 allowEmptySync', partial.success === true && partial.removed === 1 && bg.data.allowEmptySync === undefined,
    JSON.stringify({ partial, flag: bg.data.allowEmptySync }));
  const all = await prune(['steam']);
  check('S6 清理清空了时间线：与删除同次写 allowEmptySync', all.success === true && all.removed === 1 && bg.ids() === '' && bg.data.allowEmptySync === true,
    JSON.stringify({ all, flag: bg.data.allowEmptySync }));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
