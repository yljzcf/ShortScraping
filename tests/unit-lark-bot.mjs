import './bootstrap.cjs';
// 回归测试：Lark 群机器人实时推送（v1.5.14）。
//
// 通道与 Base 工作流 webhook 并存、互不影响：机器人是自定义机器人 webhook，
// 免费、无月度额度（只有频率限流），走 msg_type=interactive 卡片。
// **封面图进不了卡片**——2026-09-12 实测 ErrCode 11310「the card contains images
// but no imagekey is passed in」，img_key 只能经开放平台上传拿、需自建应用，
// 故卡片只有标题/来源/类型/简介/跳转按钮，不带 img 元素。
//
// 最要命的一条是 W 组「启用水位线」：存量 3454 条（含 resetPartialTranslations
// 退回队列的 683 条）会陆续走完翻译线，若无水位线会在群里瞬间刷出几百条消息。
// 用法：node tests/unit-lark-bot.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Lark = createRequire(import.meta.url)(path.join(worktreeRoot, 'src/shared/lark.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ---------- C 组：卡片组装（纯函数） ----------
const FULL = {
  itemId: 'nf12345', source: 'netflix', title: 'The Whisper Man', titleZh: '低语者',
  description: 'An English synopsis.', descriptionZh: '一段中文简介。',
  tags: ['Netflix', 'Movie', 'Global'], genres: ['Thrillers', 'Mysteries'],
  url: 'https://www.netflix.com/title/12345',
  poster: 'https://dnm.nflximg.net/x.jpg', scrapedAt: '2026-09-12T00:00:00.000Z'
};

const card = Lark.buildBotCard ? Lark.buildBotCard(FULL) : null;
check('C1 buildBotCard 已导出', typeof Lark.buildBotCard === 'function', typeof Lark.buildBotCard);

// 卡片版式（2026-09-12 用户定，顺序固定）：
//   标题栏＝中文译名（英文译名）／正文①简介（中文优先，**不再单列斜体英文原文**）
//   ②空行后「**来源**」+tags 与「**类别**」+genres ③按钮「去瞅瞅」
// v2 schema：正文在 card.body.elements，文本元素是 markdown、内容在 content
const elsOf = (c) => c?.card?.body?.elements || [];
const mdOf = (c, i) => elsOf(c)[i]?.content || '';

if (card) {
  const json = JSON.stringify(card);
  const header = card.card?.header?.title?.content || '';
  check('C2 msg_type=interactive 且带 card 根', card.msg_type === 'interactive' && Boolean(card.card), json.slice(0, 80));
  check('C3 标题栏＝中文译名（英文译名），不带「新增」字样',
    header === '低语者（The Whisper Man）' && !header.includes('新增'), header);
  check('C4 正文第一段是中文简介', mdOf(card, 0) === '一段中文简介。', mdOf(card, 0));
  check('C5 有中文简介时不再渲染英文原文段',
    !json.includes('An English synopsis') && !json.includes('*An'), json.slice(0, 200));
  check('C6 来源行加粗且列 tags（tags 自带平台名）',
    mdOf(card, 1).includes('**来源**') && mdOf(card, 1).includes('Netflix')
    && mdOf(card, 1).includes('Movie') && mdOf(card, 1).includes('Global'), mdOf(card, 1));
  check('C6b 类别行列 genres', mdOf(card, 1).includes('**类别**')
    && mdOf(card, 1).includes('Thrillers') && mdOf(card, 1).includes('Mysteries'), mdOf(card, 1));
  check('C6c 来源在类别之前',
    mdOf(card, 1).indexOf('**来源**') < mdOf(card, 1).indexOf('**类别**'), mdOf(card, 1));
  check('C6d 正文只有简介与来源类别两段（无多余段落）',
    elsOf(card).filter(e => e.tag === 'markdown').length === 2,
    String(elsOf(card).filter(e => e.tag === 'markdown').length));
  check('C6e 用 v2 schema 且正文挂在 body.elements 下',
    card.card.schema === '2.0' && Array.isArray(card.card.body?.elements)
    && card.card.elements === undefined, JSON.stringify(card.card.schema));
  // v2 的 markdown 走严格 CommonMark：闭合 ** 前是标点「：」、后面若紧跟字母，
  // 右侧界定符判定不通过，加粗不生效、星号原样漏出（v1 的 lark_md 不挑，切 v2 才暴露）
  check('C6f 加粗标签闭合 ** 后留空格（否则 CommonMark 下加粗失效）',
    /\*\*来源\*\* \S/.test(mdOf(card, 1)) && /\*\*类别\*\* \S/.test(mdOf(card, 1)),
    JSON.stringify(mdOf(card, 1)));
  check('C6g 正文里不出现「**紧跟非空白」的写法',
    !/\*\*[^\s*][^*]*\*\*[^\s*]/.test(mdOf(card, 0) + '\n' + mdOf(card, 1)), mdOf(card, 1));
  check('C7 尾部按钮文案「去瞅瞅」并指向原页',
    json.includes('"去瞅瞅"') && json.includes('https://www.netflix.com/title/12345')
    && json.includes('"tag":"button"'), '');
  // 不传 imgKey 就不带图：ErrCode 11310 的语义是「你没给真 img_key」，塞个空值
  // 或外链 URL 都会被整条拒收，所以宁可发无图卡（见 I 组）
  check('C8 不传 imgKey 时不含 img 元素',
    !json.includes('"tag":"img"') && !json.includes('img_key'), '');
  check('C9 封面链接不出现在卡片里（图只能经 img_key 进卡，URL 进不去）',
    !json.includes('nflximg'), '');
}

// 退化面
{
  const noZh = Lark.buildBotCard({ ...FULL, titleZh: '', descriptionZh: '' });
  check('C10a 无中文标题时标题栏只留英文原名',
    noZh.card.header.title.content === 'The Whisper Man', noZh.card.header.title.content);
  // v1.6.2：中英文名其实是同一个时只留一个，不推「骷髅传奇（骷髅传奇）」给群里。
  // 成因＝中文开发商的 Steam 英文档名本身就是中文，AI 原样返回（全库 70 条）
  const sameName = Lark.buildBotCard({ ...FULL, title: '骷髅传奇', titleZh: '骷髅传奇' });
  check('C10d 中英同名时标题栏不写成「X（X）」',
    sameName.card.header.title.content === '骷髅传奇', sameName.card.header.title.content);
  const decorated = Lark.buildBotCard({ ...FULL, title: 'NBA 2K27', titleZh: '《NBA 2K27》' });
  check('C10e 仅差装饰性标点也视作同名（保留官方《》形态）',
    decorated.card.header.title.content === '《NBA 2K27》', decorated.card.header.title.content);
  // 中文缺失才回退英文（且不带斜体）：机器人只在翻译完成后推，理论上都有中文，
  // 但半成品收口的卡可能没有，不能给张空卡
  check('C10b 无中文简介时回退英文原文，且不加斜体',
    mdOf(noZh, 0) === 'An English synopsis.', mdOf(noZh, 0));
  const noAny = Lark.buildBotCard({ ...FULL, descriptionZh: '', description: '' });
  check('C10c 中英简介都没有时不渲染简介段（首段直接是来源/类别）',
    mdOf(noAny, 0).includes('**来源**'), mdOf(noAny, 0));
  const noMeta = Lark.buildBotCard({ ...FULL, tags: [], genres: [] });
  check('C10d 无 tags/genres 时不渲染来源与类别行',
    !JSON.stringify(noMeta).includes('**来源**') && !JSON.stringify(noMeta).includes('**类别**'), '');
  const onlyTags = Lark.buildBotCard({ ...FULL, genres: [] });
  check('C10e 只有 tags 时仍渲染来源行、不渲染类别行',
    JSON.stringify(onlyTags).includes('**来源**') && !JSON.stringify(onlyTags).includes('**类别**'), '');

  const noUrl = Lark.buildBotCard({ ...FULL, url: '' });
  check('C11 无合法 url 时不渲染按钮', !JSON.stringify(noUrl).includes('"tag":"button"'), '');
  const badUrl = Lark.buildBotCard({ ...FULL, url: 'javascript:alert(1)' });
  check('C12 非 http(s) 的 url 不渲染按钮', !JSON.stringify(badUrl).includes('"tag":"button"'), '');
  const bare = Lark.buildBotCard({});
  check('C13 空条目也能组装出合法卡片', bare?.msg_type === 'interactive' && Boolean(bare?.card?.header), '');
  // 裁剪上限 240（2026-09-12 用户三轮验收后定稿：160→240→200→240）。刻意断言「被裁那一段的长度」而不是整卡
  // JSON 总长——后者是随版式浮动的魔数，改版式就得跟着调，挡不住真回归
  const LIMIT = 240;
  const longDesc = Lark.buildBotCard({
    ...FULL, descriptionZh: '很长'.repeat(400), description: 'x'.repeat(900)
  });
  check('C14a 超长中文简介裁到 240 字 + 省略号',
    mdOf(longDesc, 0).length === LIMIT + 1 && mdOf(longDesc, 0).endsWith('…'),
    `len=${mdOf(longDesc, 0).length}`);
  const longEn = Lark.buildBotCard({ ...FULL, descriptionZh: '', description: 'x'.repeat(900) });
  check('C14b 回退的英文原文同上限', mdOf(longEn, 0).length === LIMIT + 1
    && mdOf(longEn, 0).endsWith('…') && !mdOf(longEn, 0).startsWith('*'),
    `len=${mdOf(longEn, 0).length}`);

  const exact = '刚好'.repeat(LIMIT / 2);      // 恰好 240 字
  const atLimit = Lark.buildBotCard({ ...FULL, descriptionZh: exact });
  check('C14c 恰好等于上限时不裁、不加省略号',
    mdOf(atLimit, 0) === exact && !mdOf(atLimit, 0).endsWith('…'), `len=${mdOf(atLimit, 0).length}`);

  const shortZh = Lark.buildBotCard({ ...FULL, descriptionZh: '短简介。' });
  check('C14d 未超限的简介原样输出', mdOf(shortZh, 0) === '短简介。', mdOf(shortZh, 0));
}

// ---------- B 组：按钮靠右（2026-09-12 逐个实测的唯一可行形态，别再换写法） ----------
// 三种走法只有第三种被接受：
//   v1 column_set 里放 action → ErrCode 200410 action components are not allowed in the column
//   v2 button 直接加 horizontal_align → ErrCode 200621 unknown property: horizontal_align
//   v2 column_set(horizontal_align:right) 里直接放 button → ✅
// 另实测 schema 2.1 / 3.0 均回 `unknown schema`，2.0 就是当前最新。
{
  const els = elsOf(card);
  const last = els[els.length - 1];
  check('B1 按钮包在靠右的 column_set 里（唯一被飞书接受的靠右形态）',
    last?.tag === 'column_set' && last?.horizontal_align === 'right'
    && last?.columns?.[0]?.width === 'auto', JSON.stringify(last).slice(0, 160));
  const btn = last?.columns?.[0]?.elements?.[0];
  check('B2 button 用 v2 的 behaviors 携带跳转地址（v2 不认 v1 的 url 字段）',
    btn?.tag === 'button' && btn?.text?.content === '去瞅瞅'
    && btn?.behaviors?.[0]?.type === 'open_url'
    && btn?.behaviors?.[0]?.default_url === FULL.url, JSON.stringify(btn));
  check('B3 button 上不带 horizontal_align（v2 的 button 不认该属性，会整卡拒收）',
    btn && !('horizontal_align' in btn), JSON.stringify(Object.keys(btn || {})));
}

// ---------- R 组：就绪判据 ----------
{
  const on = { botWebhookUrl: 'https://open.larksuite.com/open-apis/bot/v2/hook/abc', botEnabled: true };
  check('R1 地址合法且已启用 → 就绪', Lark.botReadiness(on).ok === true, JSON.stringify(Lark.botReadiness(on)));
  check('R2 未启用 → 不就绪', Lark.botReadiness({ ...on, botEnabled: false }).ok === false, '');
  check('R3 地址为空 → 不就绪', Lark.botReadiness({ botWebhookUrl: '', botEnabled: true }).ok === false, '');
  check('R4 非 http(s) 地址 → 不就绪',
    Lark.botReadiness({ botWebhookUrl: 'ftp://x/y', botEnabled: true }).ok === false, '');
  const norm = Lark.normalizeConfig({ botWebhookUrl: '  https://x/y  ', botEnabled: 1 });
  check('R5 normalizeConfig 归一化 bot 字段',
    norm.botWebhookUrl === 'https://x/y' && norm.botEnabled === true, JSON.stringify(norm));
  check('R6 缺省时 bot 关闭、地址为空',
    Lark.DEFAULT_CONFIG.botEnabled === false && Lark.DEFAULT_CONFIG.botWebhookUrl === '', '');
  check('R7 Base webhook 就绪判据不受 bot 字段影响',
    Lark.configReadiness({ webhookUrl: 'https://base/hook' }).ok === true
    && Lark.configReadiness({ botWebhookUrl: 'https://bot/hook', botEnabled: true }).ok === false, '');
}

// ---------- I 组：封面真图（v1.6.0） ----------
// 2026-09-12 晚实测翻案：11310 的语义是「你没给真 img_key」，不是「机器人不许放图」。
// 自建应用上传拿到的 img_key 塞进卡片能正常渲染，且**跨云可用**——飞书租户上传的图
// 推到 Lark 国际版群里照样显示（用户肉眼验收）。故本项目形态是：
// 推送目标＝Lark 群，飞书自建应用只当图床。
{
  const withImg = Lark.buildBotCard(FULL, { imgKey: 'img_v3_unit_test' });
  const els = elsOf(withImg);
  const img = els.find(e => e.tag === 'img');
  check('I1 传入 imgKey 时插入 img 元素',
    img?.img_key === 'img_v3_unit_test', JSON.stringify(img));
  check('I2 img 带 alt（飞书要求图片元素有 alt 结构）',
    img?.alt?.tag === 'plain_text', JSON.stringify(img?.alt));
  // 版式（2026-09-12 用户定稿）：简介 → 来源/类别 → 按钮 → **封面图**。
  // 图垫在整张卡最底下、按钮在它上方；满宽原样，不裁不缩。
  check('I3 版式顺序＝简介 → 来源类别 → 按钮 → 图',
    els.map(e => e.tag).join(',') === 'markdown,markdown,column_set,img',
    els.map(e => e.tag).join(','));
  check('I3b 图恒为最后一个元素', els[els.length - 1]?.tag === 'img',
    els.map(e => e.tag).join(','));
  check('I4 img 上不带 size/scale_type（满宽原样）',
    img && !('size' in img) && !('scale_type' in img), JSON.stringify(Object.keys(img || {})));

  // 退化面：上面缺内容时图也不能跑上去，恒在最底
  const imgNoMeta = Lark.buildBotCard({ ...FULL, tags: [], genres: [] }, { imgKey: 'k' });
  check('I4b 无来源/类别时顺序＝简介 → 按钮 → 图',
    elsOf(imgNoMeta).map(e => e.tag).join(',') === 'markdown,column_set,img',
    elsOf(imgNoMeta).map(e => e.tag).join(','));
  const imgNoText = Lark.buildBotCard({ ...FULL, descriptionZh: '', description: '', tags: [], genres: [] }, { imgKey: 'k' });
  check('I4c 完全无文字时只剩按钮与图',
    elsOf(imgNoText).map(e => e.tag).join(',') === 'column_set,img',
    elsOf(imgNoText).map(e => e.tag).join(','));
  const imgNoUrl = Lark.buildBotCard({ ...FULL, url: '' }, { imgKey: 'k' });
  check('I4d 无按钮时图仍在最后',
    elsOf(imgNoUrl).map(e => e.tag).join(',') === 'markdown,markdown,img',
    elsOf(imgNoUrl).map(e => e.tag).join(','));

  for (const [label, opts] of [['无 options', undefined], ['空 imgKey', { imgKey: '' }], ['null', { imgKey: null }]]) {
    const c = Lark.buildBotCard(FULL, opts);
    check(`I5 ${label} 时不插 img 元素`, !JSON.stringify(c).includes('"tag":"img"'), label);
  }
}

// ---------- G 组：飞书图床凭据（配置层） ----------
{
  check('G1 DEFAULT_CONFIG 含飞书应用凭据两字段且默认空',
    Lark.DEFAULT_CONFIG.feishuAppId === '' && Lark.DEFAULT_CONFIG.feishuAppSecret === '',
    JSON.stringify(Lark.DEFAULT_CONFIG));
  const norm = Lark.normalizeConfig({ feishuAppId: '  cli_x  ', feishuAppSecret: ' s3cret ' });
  check('G2 normalizeConfig 归一化凭据（trim）',
    norm.feishuAppId === 'cli_x' && norm.feishuAppSecret === 's3cret', JSON.stringify(norm));
  // 两个字段即开关：都填才带图，缺一就发无图卡（不另设勾选框，否则「关的是图还是推送」会混）
  check('G3 两个凭据齐全 → 图床就绪',
    Lark.imageReadiness({ feishuAppId: 'cli_x', feishuAppSecret: 's' }).ok === true, '');
  check('G4 只填 appId → 不就绪',
    Lark.imageReadiness({ feishuAppId: 'cli_x' }).ok === false, '');
  check('G5 只填 secret → 不就绪',
    Lark.imageReadiness({ feishuAppSecret: 's' }).ok === false, '');
  check('G6 都不填 → 不就绪（现状：无图卡）', Lark.imageReadiness({}).ok === false, '');
  check('G7 图床就绪与机器人就绪互不影响',
    Lark.botReadiness({ botWebhookUrl: 'https://x/y', botEnabled: true, feishuAppId: '' }).ok === true, '');
}

// ---------- U 组：封面上传（效果层，桩掉 fetch） ----------
const TOKEN_API = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const IMAGE_API = 'https://open.feishu.cn/open-apis/im/v1/images';
const POSTER = 'https://dnm.nflximg.net/x.jpg';   // netflix：posterForPayload 不改写的形态
// IMDB 真实形态（同 unit-lark-table 的 POSTERS.imdb）：库里存的是 90×133 缩略图，
// posterForPayload 去掉变换段还原成原图。v1.6.4 前机器人上传的是前者，满宽卡片上糊成一片。
const IMDB_THUMB = 'https://m.media-amazon.com/images/M/MV5BMTQzMTdmMGUtYWJhYi00MzYzLWI5NTItZGJlNzY4MGRjYWMzXkEyXkFqcGc@._V1_QL75_UX90_CR0,13,90,133_.jpg';
const IMDB_FULL = 'https://m.media-amazon.com/images/M/MV5BMTQzMTdmMGUtYWJhYi00MzYzLWI5NTItZGJlNzY4MGRjYWMzXkEyXkFqcGc@._V1_.jpg';
const CRED = { feishuAppId: 'cli_x', feishuAppSecret: 's3cret', requestTimeoutSec: 5 };

let calls = [];
const jsonRes = (body, ok = true) => ({
  ok, status: ok ? 200 : 500, async text() { return JSON.stringify(body); }, async json() { return body; }
});
const imgRes = () => ({ ok: true, status: 200, async blob() { return new Blob([new Uint8Array([1, 2, 3])]); } });
const notFound = () => ({ ok: false, status: 404, async blob() { return new Blob([]); } });
function installFetch(handlers = {}) {
  calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
    if (u === TOKEN_API) return handlers.token ? handlers.token() : jsonRes({ code: 0, tenant_access_token: 't-1', expire: 7200 });
    if (u === IMAGE_API) return handlers.image ? handlers.image() : jsonRes({ code: 0, data: { image_key: 'img_v3_ok' } });
    if (u === POSTER) return handlers.poster ? handlers.poster() : imgRes();
    if (u === IMDB_FULL) return handlers.imdbFull ? handlers.imdbFull() : imgRes();
    if (u === IMDB_THUMB) return handlers.imdbThumb ? handlers.imdbThumb() : imgRes();
    if (u.includes('/open-apis/bot/')) return jsonRes({ code: 0, msg: 'success' });
    throw new TypeError(`unit stub: 未预期的请求 ${u}`);
  };
}

{
  installFetch();
  Lark.__resetTokenCache();
  const key = await Lark.uploadCoverImage(CRED, POSTER);
  check('U1 上传成功返回 image_key', key === 'img_v3_ok', String(key));
  check('U2 顺序＝取 token → 拉图 → 上传',
    calls.map(c => c.url).join('|') === [TOKEN_API, POSTER, IMAGE_API].join('|'),
    calls.map(c => c.url).join('|'));
  const upload = calls.find(c => c.url === IMAGE_API);
  check('U3 上传带 Bearer token 且是 POST',
    upload?.method === 'POST' && upload?.headers?.Authorization === 'Bearer t-1',
    JSON.stringify(upload?.headers));
  check('U4 上传用 multipart（body 是 FormData，image_type=message）',
    upload?.body instanceof FormData && upload.body.get('image_type') === 'message',
    String(upload?.body?.constructor?.name));

  // token 缓存：第二次上传不该再取 token（SW 内存缓存，提前 5 分钟过期）
  installFetch();
  const key2 = await Lark.uploadCoverImage(CRED, POSTER);
  check('U5 token 命中缓存时不重复取', key2 === 'img_v3_ok'
    && !calls.some(c => c.url === TOKEN_API), calls.map(c => c.url).join('|'));

  // 换 appId 视为不同凭据，必须重新取
  installFetch();
  await Lark.uploadCoverImage({ ...CRED, feishuAppId: 'cli_other' }, POSTER);
  check('U6 换 appId 后重新取 token', calls.some(c => c.url === TOKEN_API), calls.map(c => c.url).join('|'));
}

// 失败面：一律返回 null（由调用方降级发无图卡），绝不抛
{
  installFetch(); Lark.__resetTokenCache();
  check('U7 凭据不全时零请求直接返回 null',
    await Lark.uploadCoverImage({ feishuAppId: 'cli_x' }, POSTER) === null && calls.length === 0,
    `calls=${calls.length}`);

  installFetch(); Lark.__resetTokenCache();
  check('U8 封面 URL 非 http(s) 时零请求返回 null',
    await Lark.uploadCoverImage(CRED, '') === null && calls.length === 0, `calls=${calls.length}`);

  installFetch({ token: () => jsonRes({ code: 99991663, msg: 'app not enabled' }) }); Lark.__resetTokenCache();
  check('U9 token 接口业务错误 → null', await Lark.uploadCoverImage(CRED, POSTER) === null, '');

  installFetch({ poster: () => ({ ok: false, status: 404, async blob() { return new Blob([]); } }) }); Lark.__resetTokenCache();
  check('U10 封面下载失败 → null', await Lark.uploadCoverImage(CRED, POSTER) === null, '');

  installFetch({ image: () => jsonRes({ code: 99991672, msg: 'permission denied' }) }); Lark.__resetTokenCache();
  check('U11 上传接口业务错误 → null（缺 im:resource 权限的典型形态）',
    await Lark.uploadCoverImage(CRED, POSTER) === null, '');

  installFetch({ image: () => { throw new Error('network down'); } }); Lark.__resetTokenCache();
  check('U12 网络异常被吞成 null，不向上抛',
    await Lark.uploadCoverImage(CRED, POSTER).then(v => v === null, () => 'THREW') === true, '');
}

// ---------- P 组：pushBotCard 串接（上传对调用方不可见） ----------
{
  const BOT = 'https://open.larksuite.com/open-apis/bot/v2/hook/unit';
  const botCfg = { ...CRED, botWebhookUrl: BOT, botEnabled: true };

  installFetch(); Lark.__resetTokenCache();
  await Lark.pushBotCard(botCfg, { ...FULL, poster: POSTER });
  const sent = JSON.parse(calls.find(c => c.url === BOT)?.body || '{}');
  const sentImg = (sent.card?.body?.elements || []).find(e => e.tag === 'img');
  check('P1 有凭据有封面时推带图卡（图垫在最底）',
    sentImg?.img_key === 'img_v3_ok'
    && (sent.card?.body?.elements || []).map(e => e.tag).join(',') === 'markdown,markdown,column_set,img',
    JSON.stringify((sent.card?.body?.elements || []).map(e => e.tag)));

  // 降级：上传挂了照样把卡推出去，绝不因为图没上传成而丢推送
  installFetch({ image: () => jsonRes({ code: 1, msg: 'boom' }) }); Lark.__resetTokenCache();
  await Lark.pushBotCard(botCfg, { ...FULL, poster: POSTER });
  const degraded = JSON.parse(calls.find(c => c.url === BOT)?.body || '{}');
  check('P2 上传失败时降级推无图卡（推送不能丢）',
    Boolean(calls.find(c => c.url === BOT)) && !JSON.stringify(degraded).includes('img_key'), '');

  installFetch(); Lark.__resetTokenCache();
  await Lark.pushBotCard({ botWebhookUrl: BOT, botEnabled: true }, { ...FULL, poster: POSTER });
  check('P3 无凭据时不碰上传接口，直接推无图卡',
    !calls.some(c => c.url === TOKEN_API || c.url === IMAGE_API)
    && Boolean(calls.find(c => c.url === BOT)), calls.map(c => c.url).join('|'));

  installFetch(); Lark.__resetTokenCache();
  await Lark.pushBotCard(botCfg, { ...FULL, poster: '' });
  check('P4 条目无封面时不碰上传接口（IMDB 有 37 条无封面）',
    !calls.some(c => c.url === IMAGE_API) && Boolean(calls.find(c => c.url === BOT)),
    calls.map(c => c.url).join('|'));

  /* —— v1.6.4：上传的必须是 posterForPayload 的高清形态 ——————————————
   * 库里存的是榜单页缩略图（IMDB 实测 90×133、4KB），卡片满宽渲染会放大 5 倍以上。
   * v1.6.0 刻意绕开 posterForPayload（注释误判成「那是为链接转附件放大的形态」），
   * 结果就是用户报的「群里图太模糊」。P6 直接钉死两条通道同源，防再次漂移。
   */
  installFetch(); Lark.__resetTokenCache();
  await Lark.pushBotCard(botCfg, { ...FULL, source: 'imdb', poster: IMDB_THUMB });
  check('P5 拉的是改写后的高清图，绝不拉库里的缩略图',
    calls.some(c => c.url === IMDB_FULL) && !calls.some(c => c.url === IMDB_THUMB),
    calls.map(c => c.url).join('|'));
  check('P6 与多维表格 payload 同源（两条通道不许各写一套封面形态）',
    Lark.buildPayload({ poster: IMDB_THUMB }).poster === IMDB_FULL
    && calls.filter(c => c.url.startsWith('https://m.media-amazon.com/'))[0]?.url === IMDB_FULL,
    `payload=${Lark.buildPayload({ poster: IMDB_THUMB }).poster}`);

  // 回退：高清挂了退回缩略图，保底不能从「模糊」退化成「没图」（2026-09-15 用户定）
  installFetch({ imdbFull: notFound }); Lark.__resetTokenCache();
  await Lark.pushBotCard(botCfg, { ...FULL, source: 'imdb', poster: IMDB_THUMB });
  const fellBack = JSON.parse(calls.find(c => c.url === BOT)?.body || '{}');
  check('P7 高清拉不到时回退缩略图，卡片仍带图',
    (fellBack.card?.body?.elements || []).some(e => e.tag === 'img' && e.img_key === 'img_v3_ok')
    && calls.filter(c => c.url.startsWith('https://m.media-amazon.com/'))
      .map(c => c.url).join('|') === [IMDB_FULL, IMDB_THUMB].join('|'),
    calls.map(c => c.url).join('|'));

  installFetch({ imdbFull: notFound, imdbThumb: notFound }); Lark.__resetTokenCache();
  await Lark.pushBotCard(botCfg, { ...FULL, source: 'imdb', poster: IMDB_THUMB });
  const bothDead = JSON.parse(calls.find(c => c.url === BOT)?.body || '{}');
  check('P8 两条都挂 → 无图卡，且只试两次不试第三次',
    !JSON.stringify(bothDead).includes('img_key')
    && calls.filter(c => c.url.startsWith('https://m.media-amazon.com/')).length === 2,
    calls.map(c => c.url).join('|'));

  installFetch({ poster: notFound }); Lark.__resetTokenCache();
  await Lark.pushBotCard(botCfg, { ...FULL, poster: POSTER });
  check('P9 不改写的站点失败后不重复拉同一个 URL（改写前后同值即无回退可言）',
    calls.filter(c => c.url === POSTER).length === 1, calls.map(c => c.url).join('|'));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
