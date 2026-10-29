import './bootstrap.cjs';
// 多维表格自动同步（v1.8.3）的写表模块 src/shared/lark-bitable.js：纯函数与效果层（fetch 桩，不出网）。
//
//   B1 表格链接解析：Lark / 飞书域名选 OpenAPI 根地址，base / wiki 两种路径，缺 table= 或不是表格链接一律 null
//   B2 配置归一：bitable* 字段默认值、列名映射只认已知键、显式空串＝关掉这一列、坏值回默认
//   B3 就绪闸门：开关 / 链接 / uid 列逐项报缺；凭据可以都不填（走 lark-cli），只填一半报缺另一半
//   B4 按字段类型填值：文本拼逗号、单选取首个、多选数组、日期毫秒、超链接 {text,link}；表里没有的列与附件不写
//   B5 待追加挑选：只要 status=trans、按 uid 去重、跳过表里已有与已写入的
//   B6 一轮同步：令牌 → wiki 换 app_token → 读列 → 分页读 uid（富文本形态也认）→ 超 500 条分批写，Bearer 头、域名都对
//   B7 出错：业务 code≠0 带着飞书的 msg 抛 BitableError；表里没有 uid 列直接报错、不写
//   B8 令牌缓存按「域名 + appId」区分
//   B9 测试连接只读：不调 batch_create，报待追加条数与缺的列
//   B10 lark-cli 身份（默认）：拼出 `api <方法> <路径> --as user --format json [--params] [--data -]`、写入体走 stdin，
//       成功读 stdout、失败读 stderr，登录失效给重新登录命令；不换应用令牌；没注入 runCli 时说清楚怎么办
//   B11 补「IMDB跳转播放」（v1.8.10）：读 uid 时一并读这一列，库里有播放页、表里还空着的行按 record_id 补上；
//       有值的不动，列不存在 / 映射关掉 / 类型不对不补，补失败不影响追加；测试连接报要补几行
// 用法：node tests/unit-lark-bitable.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Lark = require('../src/shared/lark.js');
const B = require('../src/shared/lark-bitable.js');

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);

const LARK_WIKI = 'https://abc.usttp.larksuite.com/wiki/WikiTok123?table=tblAAA&view=vew1';
const FEISHU_BASE = 'https://x.feishu.cn/base/BaseTok456?table=tblBBB';

// B1
const lark = B.parseBitableUrl(LARK_WIKI);
const feishu = B.parseBitableUrl(FEISHU_BASE);
check('B1a Lark 知识库链接 → open.larksuite.com、kind=wiki、取 table 参数',
  show(lark) === show({ apiBase: 'https://open.larksuite.com', kind: 'wiki', token: 'WikiTok123', tableId: 'tblAAA' }), show(lark));
check('B1b 飞书 base 链接 → open.feishu.cn、kind=base',
  show(feishu) === show({ apiBase: 'https://open.feishu.cn', kind: 'base', token: 'BaseTok456', tableId: 'tblBBB' }), show(feishu));
check('B1c 认不出的一律 null：缺 table=、云文档链接、非 http、空串',
  [B.parseBitableUrl('https://x.feishu.cn/base/Tok'), B.parseBitableUrl('https://x.feishu.cn/docx/Tok?table=tblX'),
    B.parseBitableUrl('ftp://x.feishu.cn/base/Tok?table=tblX'), B.parseBitableUrl('')].every(v => v === null), '');

// B2
const defaults = Lark.normalizeConfig({});
check('B2a 默认关闭、链接与凭据为空、列名映射是完整默认值',
  defaults.bitableEnabled === false && defaults.bitableUrl === '' && defaults.bitableAppId === '' && defaults.bitableAppSecret === ''
  && show(defaults.bitableFields) === show(Lark.DEFAULT_BITABLE_FIELDS), show(defaults));
const custom = Lark.normalizeConfig({ bitableEnabled: 1, bitableUrl: '  https://x  ', bitableFields: { title: ' 英文名 ', genres: '', junk: 'x', uid: 7 } });
check('B2b 列名 trim、显式空串保留（关掉这一列）、未知键丢弃、非字符串回默认',
  custom.bitableEnabled === true && custom.bitableUrl === 'https://x' && custom.bitableFields.title === '英文名'
  && custom.bitableFields.genres === '' && !('junk' in custom.bitableFields) && custom.bitableFields.uid === 'uid', show(custom));
check('B2c bitableFields 是数组 / null 时回到默认映射',
  show(Lark.normalizeConfig({ bitableFields: ['x'] }).bitableFields) === show(Lark.DEFAULT_BITABLE_FIELDS), '');

// B3
const ready = { bitableEnabled: true, bitableUrl: LARK_WIKI, bitableAppId: 'cli_x', bitableAppSecret: 's' };
check('B3a 应用凭据齐全即就绪，走应用身份', B.bitableReadiness(ready).ok === true && B.authMode(ready) === 'app', show(B.bitableReadiness(ready)));
check('B3b 逐项报缺：开关、链接、uid 列；凭据都不填不算缺（走 lark-cli）',
  show(B.bitableReadiness({ bitableUrl: 'bad', bitableFields: { uid: '' } }).missing)
    === show(['bitableEnabled', 'bitableUrl', 'bitableFields.uid'])
  && B.bitableReadiness({ bitableEnabled: true, bitableUrl: LARK_WIKI }).ok === true
  && B.authMode({ bitableUrl: LARK_WIKI }) === 'cli', '');
check('B3c 凭据只填一半：报缺另一半，也不会悄悄退回 lark-cli',
  show(B.bitableReadiness({ ...ready, bitableAppSecret: '' }).missing) === show(['bitableAppSecret'])
  && show(B.bitableReadiness({ ...ready, bitableAppId: '' }).missing) === show(['bitableAppId']), '');

// B4
const T = B.FIELD_TYPE;
const fieldTypes = new Map([
  ['uid', T.TEXT], ['title0', T.TEXT], ['tag0', T.MULTI_SELECT], ['平台', T.SINGLE_SELECT], ['来源标签', T.TEXT],
  ['内容标签', T.MULTI_SELECT], ['抓取时间', T.DATETIME], ['跳转链接', T.URL], ['IMDB跳转播放', T.URL], ['海报', 17], ['海报链接', T.TEXT]
]);
const drama = {
  itemId: 'tt1', id: 'imdb_tt1_1', title: ' Title ', genres: ['Drama', ' Romance '], source: 'imdb', tags: ['IMDB', 'MyDrama'],
  scrapedAt: '2026-10-21T04:54:06.899Z', url: 'https://www.imdb.com/title/tt1/', playUrl: 'not-a-link',
  poster: 'https://m.media-amazon.com/images/M/abc._V1_QL75_UY133_CR5,0,90,133_.jpg', titleZh: '', status: 'trans'
};
const fields = B.buildRecordFields(drama, { fieldTypes, contentTagsFor: genres => genres.map(g => `${g}中`) });
check('B4a 各类型按表里的字段类型填值', show(fields) === show({
  uid: 'tt1',
  title0: 'Title',
  tag0: ['Drama', 'Romance'],
  平台: 'IMDB',
  来源标签: 'IMDB,MyDrama',
  内容标签: ['Drama中', 'Romance中'],
  海报链接: 'https://m.media-amazon.com/images/M/abc._V1_.jpg',
  跳转链接: { text: 'https://www.imdb.com/title/tt1/', link: 'https://www.imdb.com/title/tt1/' },
  抓取时间: Date.parse('2026-10-21T04:54:06.899Z')
}), show(fields));
check('B4b 表里没有的列（des0 / 标题…）、空值、非 http 的超链接、附件列都不写',
  !('des0' in fields) && !('标题' in fields) && !('IMDB跳转播放' in fields) && !('海报' in fields), show(Object.keys(fields)));
const closed = B.buildRecordFields(drama, { fieldTypes, fields: { genres: '' } });
check('B4c 映射里关掉的列不写；没给 contentTagsFor 时内容标签不写', !('tag0' in closed) && !('内容标签' in closed), show(closed));

// B5
const list = [
  { itemId: 'a', status: 'trans' }, { itemId: 'b', status: 'new' }, { itemId: 'a', status: 'trans' },
  { itemId: 'c', status: 'trans' }, { itemId: 'd', status: 'trans' }, { id: 'only-id', status: 'trans' }, { status: 'trans' }
];
const picked = B.selectPending(list, { existingUids: new Set(['c']), syncedIds: new Set(['d']) }).map(d => d.itemId || d.id);
check('B5 只挑已翻译的、同 uid 取第一条、跳过表里已有与已写入、没有 itemId 用 id、两者都没有跳过',
  show(picked) === show(['a', 'only-id']), show(picked));

// —— 效果层：fetch 桩 ——
function makeFetch({ existing = [], fieldsList = null, failOn = null, pageSize = 2 } = {}) {
  const calls = [];
  const created = [];
  const updated = [];
  const fieldItems = fieldsList || [...fieldTypes].map(([field_name, type]) => ({ field_name, type }));
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method || 'GET', query: Object.fromEntries(u.searchParams), auth: init.headers?.Authorization, host: u.origin, body: init.body ? JSON.parse(init.body) : undefined });
    if (failOn && u.pathname.includes(failOn)) return reply({ code: 1254045, msg: 'FieldNameNotFound' });
    if (u.pathname.endsWith('/tenant_access_token/internal')) return reply({ code: 0, tenant_access_token: `tok-${u.origin}`, expire: 7200 });
    if (u.pathname.endsWith('/wiki/v2/spaces/get_node')) return reply({ code: 0, data: { node: { obj_type: 'bitable', obj_token: 'AppTok' } } });
    if (u.pathname.endsWith('/fields')) return reply({ code: 0, data: { items: fieldItems, has_more: false } });
    if (u.pathname.endsWith('/records') && (init.method || 'GET') === 'GET') {
      const start = Number(u.searchParams.get('page_token') || 0);
      const slice = existing.slice(start, start + pageSize);
      const more = start + pageSize < existing.length;
      // 第二页起用富文本段数组形态，覆盖两种返回；existing 的元素也可以是 { uid, rid, play }（带行号与「IMDB跳转播放」）
      const items = slice.map((row, i) => {
        const { uid, rid = `r${start + i}`, play } = typeof row === 'string' ? { uid: row } : row;
        const fields = { uid: start === 0 ? uid : [{ type: 'text', text: uid }] };
        if (play !== undefined) fields['IMDB跳转播放'] = play;
        return { record_id: rid, fields };
      });
      return reply({ code: 0, data: { items, has_more: more, page_token: more ? String(start + pageSize) : '' } });
    }
    if (u.pathname.endsWith('/records/batch_update')) {
      updated.push(...JSON.parse(init.body).records);
      return reply({ code: 0, data: { records: [] } });
    }
    if (u.pathname.endsWith('/records/batch_create')) {
      const body = JSON.parse(init.body);
      created.push(body.records.length);
      return reply({ code: 0, data: { records: body.records.map((r, i) => ({ record_id: `rec${i}`, fields: r.fields })) } });
    }
    return reply({ code: 404, msg: 'not found' }, 404);
  };
  return { fetchImpl, calls, created, updated };
}

const config = { ...ready };
const many = Array.from({ length: 503 }, (_, i) => ({ itemId: `n${i}`, status: 'trans', title: `T${i}` }));
{
  B.__resetTokenCache();
  const stub = makeFetch({ existing: ['n0', 'n1', 'n2'] });
  const ctx = B.createContext(config, { fetchImpl: stub.fetchImpl });
  const result = await B.syncOnce(ctx, { dramas: many, syncedIds: new Set(['n3']) });
  const paths = stub.calls.map(c => `${c.method} ${c.path.replace('/open-apis', '')}`);
  check('B6a 顺序：令牌 → wiki 换 app_token → 读列 → 分页读 uid（2 页）→ 分批写',
    show(paths.slice(0, 5)) === show([
      'POST /auth/v3/tenant_access_token/internal', 'GET /wiki/v2/spaces/get_node',
      'GET /bitable/v1/apps/AppTok/tables/tblAAA/fields', 'GET /bitable/v1/apps/AppTok/tables/tblAAA/records',
      'GET /bitable/v1/apps/AppTok/tables/tblAAA/records'
    ]), show(paths));
  check('B6b 503 条里去掉表里已有 3 条与已写入 1 条，按 500 一批写 499 条（只一批）',
    result.added === 499 && show(stub.created) === show([499]) && !result.addedIds.includes('n0') && !result.addedIds.includes('n3'), show({ added: result.added, created: stub.created }));
  check('B6c 富文本形态的 uid 也认出来，existingIds 交回给调用方记账',
    show(result.existingIds.sort()) === show(['n0', 'n1', 'n2']), show(result.existingIds));
  check('B6d 读 uid 只要 uid 与「IMDB跳转播放」两列、每页 500；Lark 表走 open.larksuite.com，Bearer 带令牌',
    stub.calls[3].query.field_names === '["uid","IMDB跳转播放"]' && stub.calls[3].query.page_size === '500'
    && stub.calls.every(c => c.host === 'https://open.larksuite.com')
    && stub.calls.slice(1).every(c => c.auth === 'Bearer tok-https://open.larksuite.com'), show(stub.calls[3]));

  const stub2 = makeFetch({ existing: [] });
  const ctx2 = B.createContext({ ...config, bitableUrl: FEISHU_BASE }, { fetchImpl: stub2.fetchImpl });
  const r2 = await B.syncOnce(ctx2, { dramas: many });
  check('B6e 超过 500 条分两批写（500 + 3）；base 链接不调 wiki 接口、走 open.feishu.cn',
    r2.added === 503 && show(stub2.created) === show([500, 3]) && !stub2.calls.some(c => c.path.includes('/wiki/'))
    && stub2.calls.every(c => c.host === 'https://open.feishu.cn'), show(stub2.created));
}

// B7
{
  B.__resetTokenCache();
  const stub = makeFetch({ failOn: '/batch_create' });
  const ctx = B.createContext(config, { fetchImpl: stub.fetchImpl });
  let error = null;
  try { await B.syncOnce(ctx, { dramas: [{ itemId: 'x', status: 'trans' }] }); } catch (e) { error = e; }
  check('B7a 业务 code≠0：抛 BitableError，带飞书的 msg 与 code', error instanceof B.BitableError && /FieldNameNotFound/.test(error.message)
    && error.code === 1254045, error && error.message);

  const noUid = makeFetch({ fieldsList: [{ field_name: 'title0', type: 1 }] });
  let error2 = null;
  try { await B.syncOnce(B.createContext(config, { fetchImpl: noUid.fetchImpl }), { dramas: [{ itemId: 'x', status: 'trans' }] }); } catch (e) { error2 = e; }
  check('B7b 表里没有 uid 列：报错、一条都不写', /没有去重用的「uid」列/.test(error2?.message || '') && noUid.created.length === 0, error2 && error2.message);

  const badToken = async () => ({ ok: true, status: 200, json: async () => ({ code: 10014, msg: 'app secret invalid' }) });
  B.__resetTokenCache(); // 上面用例换到的令牌还在缓存里，不清就走不到换令牌那一步
  let error3 = null;
  try { await B.syncOnce(B.createContext(config, { fetchImpl: badToken }), { dramas: [] }); } catch (e) { error3 = e; }
  check('B7c 换令牌失败：报「检查 App ID / Secret」', /换取应用令牌失败：app secret invalid/.test(error3?.message || ''), error3 && error3.message);
}

// B8
{
  B.__resetTokenCache();
  const stub = makeFetch();
  const run = async cfg => B.testConnection(B.createContext(cfg, { fetchImpl: stub.fetchImpl }), { dramas: [] });
  await run(config);
  await run(config);
  await run({ ...config, bitableUrl: FEISHU_BASE });
  await run({ ...config, bitableAppId: 'cli_other' });
  const tokenCalls = stub.calls.filter(c => c.path.endsWith('/tenant_access_token/internal')).length;
  check('B8 令牌缓存：同域名同 appId 只换一次，换域名或 appId 重新换', tokenCalls === 3, String(tokenCalls));
}

// B11
{
  B.__resetTokenCache();
  const PLAY = 'https://my-drama.com/video/b6973579-f9b6-429c-8cc5-bad184a58236';
  const stub = makeFetch({
    pageSize: 3,
    existing: [
      { uid: 'f1', rid: 'recF1' },                                   // 空着、库里有播放页 → 补
      { uid: 'f2', rid: 'recF2', play: { link: 'https://x/hand', text: '手改' } },   // 有值 → 不动
      { uid: 'f3', rid: 'recF3' },                                   // 库里没有播放页 → 不动
      { uid: 'f4', rid: 'recF4a' }, { uid: 'f4', rid: 'recF4b' },     // 同 uid 两行都空着 → 两行都补（第二行在第二页）
      { uid: 'f5', rid: 'recF5', play: '' }                          // 空串也算空着，但库里播放页不是 http → 不动
    ]
  });
  const dramas = [
    { itemId: 'f1', status: 'trans', playUrl: PLAY }, { itemId: 'f2', status: 'trans', playUrl: PLAY },
    { itemId: 'f3', status: 'trans' }, { itemId: 'f4', status: 'trans', playUrl: PLAY },
    { itemId: 'f5', status: 'trans', playUrl: 'javascript:alert(1)' }, { itemId: 'n9', status: 'trans', title: 'New', playUrl: PLAY }
  ];
  const r = await B.syncOnce(B.createContext(config, { fetchImpl: stub.fetchImpl }), { dramas });
  const link = { text: PLAY, link: PLAY };
  check('B11a 表里「IMDB跳转播放」空着、库里有播放页的行按 record_id 补上；有值的、库里没有的、不是 http 的不动；同 uid 几行空着补几行',
    show(stub.updated) === show([
      { record_id: 'recF1', fields: { 'IMDB跳转播放': link } },
      { record_id: 'recF4a', fields: { 'IMDB跳转播放': link } }, { record_id: 'recF4b', fields: { 'IMDB跳转播放': link } }
    ]) && r.filled === 3 && r.fillError === null && r.added === 1, show({ updated: stub.updated, r }));
  const order = stub.calls.map(c => c.path.split('/').pop());
  check('B11b 先追加新行再补；新追加的行自己就带播放页，不在补的范围里', order.indexOf('batch_create') < order.indexOf('batch_update'), show(order));

  const off = makeFetch({ existing: [{ uid: 'f1', rid: 'recF1' }] });
  const rOff = await B.syncOnce(B.createContext({ ...config, bitableFields: { playUrl: '' } }, { fetchImpl: off.fetchImpl }), { dramas });
  const missing = makeFetch({ existing: [{ uid: 'f1', rid: 'recF1' }], fieldsList: [{ field_name: 'uid', type: T.TEXT }] });
  const rMissing = await B.syncOnce(B.createContext(config, { fetchImpl: missing.fetchImpl }), { dramas });
  const wrongType = makeFetch({ existing: [{ uid: 'f1', rid: 'recF1' }], fieldsList: [{ field_name: 'uid', type: T.TEXT }, { field_name: 'IMDB跳转播放', type: 17 }] });
  await B.syncOnce(B.createContext(config, { fetchImpl: wrongType.fetchImpl }), { dramas });
  check('B11c 映射里关掉这一列、表里没有这一列、列类型不是超链接 / 文本：只读 uid 一列，不补',
    [off, missing, wrongType].every(st => st.updated.length === 0 && st.calls.find(c => c.path.endsWith('/records'))?.query.field_names === '["uid"]')
    && rOff.filled === 0 && rMissing.filled === 0, show([off, missing, wrongType].map(st => st.updated.length)));

  const textCol = makeFetch({ existing: [{ uid: 'f1', rid: 'recF1' }], fieldsList: [{ field_name: 'uid', type: T.TEXT }, { field_name: 'IMDB跳转播放', type: T.TEXT }] });
  await B.syncOnce(B.createContext(config, { fetchImpl: textCol.fetchImpl }), { dramas });
  check('B11d 文本类型的列补纯文本地址', show(textCol.updated) === show([{ record_id: 'recF1', fields: { 'IMDB跳转播放': PLAY } }]), show(textCol.updated));

  const failing = makeFetch({ existing: [{ uid: 'f1', rid: 'recF1' }], failOn: '/batch_update' });
  let thrown = null;
  let rFail = null;
  try { rFail = await B.syncOnce(B.createContext(config, { fetchImpl: failing.fetchImpl }), { dramas }); } catch (e) { thrown = e; }
  check('B11e 补的时候出错：不抛、不影响追加，原因放在 fillError，filled 为 0',
    !thrown && rFail?.added === 5 && rFail.filled === 0 && /FieldNameNotFound/.test(rFail.fillError || ''), show({ thrown: thrown?.message, rFail }));

  const probe = makeFetch({ existing: [{ uid: 'f1', rid: 'recF1' }, { uid: 'f2', rid: 'recF2', play: { link: 'https://x/hand', text: '手改' } }] });
  const t = await B.testConnection(B.createContext(config, { fetchImpl: probe.fetchImpl }), { dramas });
  check('B11f 测试连接只读：报要补几行（fillCount），不调 batch_update', t.fillCount === 1 && probe.updated.length === 0
    && !probe.calls.some(c => c.path.endsWith('/batch_update')), show(t));
}

// B9
{
  B.__resetTokenCache();
  const stub = makeFetch({ existing: ['a'], fieldsList: [{ field_name: 'uid', type: 1 }, { field_name: 'title0', type: 1 }] });
  const r = await B.testConnection(B.createContext(config, { fetchImpl: stub.fetchImpl }), {
    dramas: [{ itemId: 'a', status: 'trans' }, { itemId: 'b', status: 'trans' }, { itemId: 'c', status: 'new' }]
  });
  check('B9 测试连接只读：不调 batch_create；报行数、待追加条数与表里缺的列',
    stub.created.length === 0 && r.rowCount === 1 && r.pendingCount === 1 && r.missingColumns.includes('des0') && !r.missingColumns.includes('uid'),
    show(r));
}

// B10
{
  const cliConfig = { bitableEnabled: true, bitableUrl: LARK_WIKI };
  const calls = [];
  const rows = [];
  const ok = data => ({ code: 0, stdout: `${JSON.stringify({ ok: true, identity: 'user', data })}\n`, stderr: '' });
  const runCli = async (args, { input } = {}) => {
    calls.push({ args, input });
    const [, method, apiPath] = args;
    if (apiPath.endsWith('/get_node')) return ok({ node: { obj_type: 'bitable', obj_token: 'AppTok' } });
    if (apiPath.endsWith('/fields')) return ok({ items: [{ field_name: 'uid', type: 1 }, { field_name: 'title0', type: 1 }], has_more: false });
    if (apiPath.endsWith('/records') && method === 'GET') return ok({ items: [{ fields: { uid: 'old' } }], has_more: false });
    if (apiPath.endsWith('/batch_create')) {
      const body = JSON.parse(input);
      rows.push(...body.records);
      // 写入前夹一行进度提示，结果仍要认得出
      return { code: 0, stdout: `Writing records...\n${JSON.stringify({ ok: true, data: { records: body.records } })}`, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: JSON.stringify({ ok: false, error: { type: 'api', code: 404, message: 'nope' } }) };
  };
  const ctx = B.createContext(cliConfig, { runCli });
  const r = await B.syncOnce(ctx, { dramas: [{ itemId: 'old', status: 'trans' }, { itemId: 'n1', status: 'trans', title: 'New' }] });
  check('B10a 没填凭据走 lark-cli：mode=cli、追加表里没有的 1 条', ctx.mode === 'cli' && r.added === 1 && rows[0]?.fields?.title0 === 'New', show(r));
  check('B10b 参数：api GET <路径> --as user --format json --params <JSON>',
    show(calls[2].args) === show(['api', 'GET', '/open-apis/bitable/v1/apps/AppTok/tables/tblAAA/records', '--as', 'user', '--format', 'json',
      '--params', JSON.stringify({ page_size: '500', field_names: '["uid"]' })]), show(calls[2].args));
  const write = calls.find(c => c.args[2].endsWith('/batch_create'));
  check('B10c 写入体走 stdin（--data -），不进命令行参数', write && show(write.args.slice(-2)) === show(['--data', '-'])
    && JSON.parse(write.input).records.length === 1 && !write.args.some(a => a.includes('New')), show(write && write.args));

  const expired = async () => ({ code: 1, stdout: '', stderr: `${JSON.stringify({ ok: false, error: { type: 'authorization', code: 99991677, message: 'token expired' } })}\n` });
  let e1 = null;
  try { await B.testConnection(B.createContext(cliConfig, { runCli: expired })); } catch (e) { e1 = e; }
  check('B10d 登录失效：报飞书的原因，并给出重新登录的命令', e1 instanceof B.BitableError && /token expired/.test(e1.message)
    && /lark-cli auth login --domain all/.test(e1.message) && e1.code === 99991677, e1 && e1.message);

  let e2 = null;
  try { await B.testConnection(B.createContext(cliConfig, { runCli: async () => ({ code: 127, stdout: '', stderr: 'command not found' }) })); } catch (e) { e2 = e; }
  check('B10e 输出不是 JSON：带退出码和原文报错', /退出码 127/.test(e2?.message || '') && /command not found/.test(e2?.message || ''), e2 && e2.message);

  let e3 = null;
  try { await B.testConnection(B.createContext(cliConfig, {})); } catch (e) { e3 = e; }
  check('B10f 没注入 runCli（比如在扩展里）：说清楚要交给同步服务或改填凭据', /只有同步服务能用这种身份/.test(e3?.message || ''), e3 && e3.message);
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
