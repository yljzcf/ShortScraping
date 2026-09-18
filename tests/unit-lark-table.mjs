import './bootstrap.cjs';
// 回归测试：Lark 多维表格导出投影层（lark.js 的 TABLE_COLUMNS / buildTableRows /
// toCsv / toTsv），以及此前零覆盖的 posterForPayload。
//
// 本出口与 TimelineCsv 的两处刻意分歧在此固化，防止日后被「统一口径」改回去：
//   1. poster 一律经 posterForPayload 改写——官方「链接转附件」捷径解析不了
//      含英文逗号/百分号编码的 URL，不改写则 IMDB/dramashorts/mydrama 共 601 条
//      封面转不成附件（2026-09-12 全量实测）；
//   2. 不加 CSV 公式前缀——Base 文本字段不执行公式，加前缀只会让以 - / + 开头的
//      正常简介多出撇号。
// 用法：node tests/unit-lark-table.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Lark = require(path.join(worktreeRoot, 'src/shared/lark.js'));
const TimelineCsv = require(path.join(worktreeRoot, 'src/shared/timeline-csv.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- 真实形态的封面样本（取自 db/timeline.json 实际数据） ----------
const POSTERS = {
  imdb: 'https://m.media-amazon.com/images/M/MV5BMTQzMTdmMGUtYWJhYi00MzYzLWI5NTItZGJlNzY4MGRjYWMzXkEyXkFqcGc@._V1_QL75_UX90_CR0,13,90,133_.jpg',
  dramashorts: 'https://dramashorts.io/_next/image?url=https%3A%2F%2Fcdn.dramashorts.io%2Fimg%2Fmovies%2FK-9jI4j1kJ4p91IQGhcVcVDp%2Fcover-with-title.png%3Fv%3D1788856848815&w=384&q=75',
  mydramaPlus: 'https://static.my-drama.com/convert/A+Love+Too+Risky+to+Resist/clear/2025-04-11+09%3A01%3A15/cover.webp?format=webp&width=420',
  mydramaPct: 'https://static.my-drama.com/convert/Make%20Me%20Yours/en/2025-12-15%2016:24:39/cover.webp?format=webp&width=189&height=283',
  mydramaFandom: 'https://fandom.my-drama.com/wp-content/uploads/2026/09/image-12.png',
  steam: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3611450/937d900955024359b85eb594cf8ca92b46f9ad64/header.jpg?t=1789052430',
  royalroad: 'https://www.royalroadcdn.com/public/covers-large/118997-ascension-of-the-primalist.jpg?time=1785630239',
  reelshort: 'https://www.reelshort.com/fandom/wp-content/uploads/2026/09/SU28371.jpg',
  netflix: 'https://dnm.nflximg.net/api/v6/E8vDc_W8CLv7-yMQu8KMEC7Rrr8/AAAABdCWuSdka3esimqrgO2mxNy9gs7n6dHQ.jpg?r=bc9',
  appletv: 'https://is1-ssl.mzstatic.com/image/thumb/i-QRI7ak7O755Nvdv11UnQ/400x600nr.jpg',
  netshort: 'https://awscover.netshort.com/tos-vod-mya-v-da59d5a2040f5f77/coverG/prod/-2145583186.jpg~tplv-vod-rs:651:868.webp',
  // FlickReels：采集存站内卡片同款 OSS 缩放形态（600×780 webp ≈60KB），原图 1000×1300 jpg ≈400KB
  flickreels: 'https://zshipubcf.farsunpteltd.com/playlet/1782901183_eBpQFwxmRR.jpg?x-oss-process=image/resize,w_600,image/format,webp',
  flickreelsRaw: 'https://zshipubcf.farsunpteltd.com/playlet/1782901183_eBpQFwxmRR.jpg',
  // ShortMax：采集存站内卡片同款（293×390 ≈65KB），原图 ≈651KB。x-oss-process 里的逗号是捷径致死字符
  shortmax: 'https://akamai-static.shorttv.live/images/cover/2026/08/21/9927c43c172545b39ca19eab36859097.jpg?process=mediagate&x-oss-process=m_fill,w_293,h_390',
  shortmaxRaw: 'https://akamai-static.shorttv.live/images/cover/2026/08/21/9927c43c172545b39ca19eab36859097.jpg',
  // GoodShort：采集存 ?w=293&h=412（≈28KB），原图 ≈271KB。两种形态本就无逗号/百分号，改写纯为放大
  goodshort: 'https://acf.goodshort.com/videobook/202609/cover-WL7xIOUEJP.jpg?w=293&h=412',
  goodshortRaw: 'https://acf.goodshort.com/videobook/202609/cover-WL7xIOUEJP.jpg',
  // Shortical：站点只有这一种尺寸形态，无可改写
  shortical: 'https://dirjqbe1kaah2.cloudfront.net/198/image.webp',
  // DramaBox（两站共用这个封面 CDN）：站点自己就给 @w=240&h=400（240×320 ≈24KB），
  // 剥掉尾段即原图 600×800 ≈99KB。尾段在 pathname 里，整个 URL 没有 '?'
  dramabox: 'https://thwztchapter.dramaboxdb.com/data/cppartner/4x2/42x0/420x0/42000024547/42000024547.jpg@w=240&h=400',
  dramaboxRaw: 'https://thwztchapter.dramaboxdb.com/data/cppartner/4x2/42x0/420x0/42000024547/42000024547.jpg',
  pinedrama: 'https://v.pinedrama.com/b1265344voduse1318177724/5eb5db755001834811001798224/vJq5RLc9BRQA.webp!15491.webp',
  pinedramaRaw: 'https://v.pinedrama.com/b1265344voduse1318177724/5eb5db755001834811001798224/vJq5RLc9BRQA.webp'
};

// 捷径致死字符：英文逗号与百分号编码（2026-07-25 两轮对照实锤）
const convertible = (url) => !/[,%]/.test(url || '');

// ---------- P 组：posterForPayload（此前零覆盖） ----------
const pfp = Lark.posterForPayload;
check('P1 posterForPayload 已导出', typeof pfp === 'function', `typeof=${typeof pfp}`);

if (typeof pfp === 'function') {
  check('P2 IMDB 去掉含逗号的 _V1_ 变换段', pfp(POSTERS.imdb) ===
    'https://m.media-amazon.com/images/M/MV5BMTQzMTdmMGUtYWJhYi00MzYzLWI5NTItZGJlNzY4MGRjYWMzXkEyXkFqcGc@._V1_.jpg',
    pfp(POSTERS.imdb));
  check('P3 dramashorts 解包 _next/image 回原始 CDN', pfp(POSTERS.dramashorts) ===
    'https://cdn.dramashorts.io/img/movies/K-9jI4j1kJ4p91IQGhcVcVDp/cover-with-title.png?v=1788856848815',
    pfp(POSTERS.dramashorts));
  check('P4 mydrama 去掉 width/height 尺寸参数',
    !/width|height/.test(pfp(POSTERS.mydramaPlus)) && !/width|height/.test(pfp(POSTERS.mydramaPct)),
    `${pfp(POSTERS.mydramaPlus)} | ${pfp(POSTERS.mydramaPct)}`);

  // 新增：%3A→: 与 %20→+ 两种等价形态 CDN 均返回同字节（2026-09-12 curl 实测 200/115836、200/63814）
  check('P5 mydrama %3A 解码为冒号', pfp(POSTERS.mydramaPlus) ===
    'https://static.my-drama.com/convert/A+Love+Too+Risky+to+Resist/clear/2025-04-11+09:01:15/cover.webp?format=webp',
    pfp(POSTERS.mydramaPlus));
  check('P6 mydrama %20 归一为 +（不可解码成裸空格，URL 会失效）', pfp(POSTERS.mydramaPct) ===
    'https://static.my-drama.com/convert/Make+Me+Yours/en/2025-12-15+16:24:39/cover.webp?format=webp',
    pfp(POSTERS.mydramaPct));
  check('P7 两类 mydrama 形态改写后均可转附件',
    convertible(pfp(POSTERS.mydramaPlus)) && convertible(pfp(POSTERS.mydramaPct)), '');

  // 归一只作用于 static.my-drama.com/convert/ 分支，不波及 fandom 子域与别站
  const passthrough = ['mydramaFandom', 'steam', 'royalroad', 'reelshort', 'netflix', 'netshort', 'shortical'];
  check('P8 其余站点原样透传', passthrough.every(k => pfp(POSTERS[k]) === POSTERS[k]),
    passthrough.filter(k => pfp(POSTERS[k]) !== POSTERS[k]).join(','));
  check('P9 空值/非法值安全', pfp('') === '' && pfp(null) === '' && pfp(undefined) === '', '');
  check('P10 IMDB/dramashorts 改写后均可转附件',
    convertible(pfp(POSTERS.imdb)) && convertible(pfp(POSTERS.dramashorts)), '');

  /* —— v1.6.5：FlickReels 剥掉 OSS 缩放参数还原原图 ————————————————————
   * 采集存站内卡片同款 ?x-oss-process=image/resize,w_600,image/format,webp（600×780 ≈60KB），
   * 参数里的英文逗号正是捷径解析不了的字符；只删这一个参数（CDN 日后加缓存参数不受波及），
   * 删空后序列化不带尾部 '?'，即 1000×1300 原图 ≈400KB（2026-09-16 实测 200）。
   */
  check('P20 flickreels 剥掉 x-oss-process 参数还原原图（无尾部 ?）',
    pfp(POSTERS.flickreels) === POSTERS.flickreelsRaw, pfp(POSTERS.flickreels));
  check('P21 flickreels 改写后可转附件', convertible(pfp(POSTERS.flickreels)), pfp(POSTERS.flickreels));
  check('P22 flickreels 原图形态原样透传', pfp(POSTERS.flickreelsRaw) === POSTERS.flickreelsRaw, pfp(POSTERS.flickreelsRaw));
  check('P23 flickreels 只删 x-oss-process、其它查询参数保留',
    pfp(`${POSTERS.flickreelsRaw}?v=2&x-oss-process=image/resize,w_600`) === `${POSTERS.flickreelsRaw}?v=2`,
    pfp(`${POSTERS.flickreelsRaw}?v=2&x-oss-process=image/resize,w_600`));

  /* —— v1.6.9：ShortMax / GoodShort 剥掉缩放参数还原原图 ————————————————
   * 两家都是「库里存站内小图、推出去才放大」（v1.6.4 定的口径），与 content.js 的
   * SHORTMAX_POSTER_SUFFIX / GOODSHORT_POSTER_SUFFIX 成对改。
   * ShortMax 多一层理由：x-oss-process 里的英文逗号正是捷径解析不了的字符。
   */
  check('P24 shortmax 只删 x-oss-process、保留 process=mediagate（实测同回原图）',
    pfp(POSTERS.shortmax) === `${POSTERS.shortmaxRaw}?process=mediagate`, pfp(POSTERS.shortmax));
  check('P25 shortmax 改写后可转附件（逗号已消失）', convertible(pfp(POSTERS.shortmax)), pfp(POSTERS.shortmax));
  check('P26 shortmax 无参形态原样透传', pfp(POSTERS.shortmaxRaw) === POSTERS.shortmaxRaw, pfp(POSTERS.shortmaxRaw));
  check('P27 goodshort 删掉 w/h 还原原图（删空后无尾部 ?）',
    pfp(POSTERS.goodshort) === POSTERS.goodshortRaw, pfp(POSTERS.goodshort));
  check('P28 goodshort 只删 w/h，其它查询参数保留',
    pfp(`${POSTERS.goodshortRaw}?w=293&v=2&h=412`) === `${POSTERS.goodshortRaw}?v=2`,
    pfp(`${POSTERS.goodshortRaw}?w=293&v=2&h=412`));
  check('P29 shortical 只有一种尺寸形态，原样透传', pfp(POSTERS.shortical) === POSTERS.shortical, pfp(POSTERS.shortical));

  /* —— v1.6.11：DramaBox 剥掉 @ 尾段的尺寸参数还原原图 ————————————————
   * 同为「库里存站内小图、推出去才放大」（v1.6.4 口径）。两点与别站不同：
   * 尾段在 **pathname** 里（URL 没有 '?'，searchParams 用不上），且必须**按形状**匹配
   * `@键=数字(&键=数字)*` —— 详情页用的就是 @w=360&h=640，写死 240×400 会漏。
   */
  check('P30 dramabox 剥掉 @w=240&h=400 还原原图',
    pfp(POSTERS.dramabox) === POSTERS.dramaboxRaw, pfp(POSTERS.dramabox));
  check('P31 dramabox 别的尺寸组合同样被剥（不写死 240×400）',
    pfp(`${POSTERS.dramaboxRaw}@w=360&h=640`) === POSTERS.dramaboxRaw, pfp(`${POSTERS.dramaboxRaw}@w=360&h=640`));
  check('P31b dramabox 单参数尾段也被剥',
    pfp(`${POSTERS.dramaboxRaw}@w=240`) === POSTERS.dramaboxRaw, pfp(`${POSTERS.dramaboxRaw}@w=240`));
  check('P32 dramabox 原图形态原样透传', pfp(POSTERS.dramaboxRaw) === POSTERS.dramaboxRaw, pfp(POSTERS.dramaboxRaw));
  check('P33 dramabox 两种形态本就无逗号/百分号，改写前后都可转附件',
    convertible(POSTERS.dramabox) && convertible(pfp(POSTERS.dramabox)), pfp(POSTERS.dramabox));
  // 尾段不是「键=数字」形状时不许乱剥：文件名里的 @ 是合法字符
  check('P34 dramabox 非尺寸形状的 @ 尾段不被剥',
    pfp(`https://thwztchapter.dramaboxdb.com/data/x/cover@2x.jpg`) === 'https://thwztchapter.dramaboxdb.com/data/x/cover@2x.jpg',
    pfp('https://thwztchapter.dramaboxdb.com/data/x/cover@2x.jpg'));
  check('P35 别站的 @ 尺寸尾段不受波及',
    pfp('https://example.com/img/a.jpg@w=240&h=400') === 'https://example.com/img/a.jpg@w=240&h=400',
    pfp('https://example.com/img/a.jpg@w=240&h=400'));

  /* —— v1.6.12：PinesDramas 剥掉 !<数字>.webp 缩略图尾缀还原原图 ————————————
   * 同为「库里存站内小图、推出去才放大」（v1.6.4 口径）：站点卡片给的就是
   * 200×270 ≈7.8KB 的缩略图，剥掉尾缀即 960×1478 ≈213KB 原图。尾缀在 pathname 里
   * （URL 没有 '?'），且**按形状**匹配 `!<数字>.webp` 而非写死 !15491.webp——
   * 同 AppleTV 尺寸码、DramaBox @ 尾段的教训。
   */
  check('P36 pinedrama 剥掉 !15491.webp 缩略图尾缀还原原图',
    pfp(POSTERS.pinedrama) === POSTERS.pinedramaRaw, pfp(POSTERS.pinedrama));
  check('P37 pinedrama 别的尾缀数字同样被剥（不写死 15491）',
    pfp(`${POSTERS.pinedramaRaw}!20000.webp`) === POSTERS.pinedramaRaw, pfp(`${POSTERS.pinedramaRaw}!20000.webp`));
  check('P38 pinedrama 原图形态原样透传', pfp(POSTERS.pinedramaRaw) === POSTERS.pinedramaRaw, pfp(POSTERS.pinedramaRaw));
  check('P39 pinedrama 两种形态本就无逗号/百分号，改写前后都可转附件',
    convertible(POSTERS.pinedrama) && convertible(pfp(POSTERS.pinedrama)), pfp(POSTERS.pinedrama));
  // 尾缀不是「!数字.webp」形状时不许乱剥
  check('P40 pinedrama 非尺寸形状的 ! 尾段不被剥',
    pfp('https://v.pinedrama.com/a/b/c.webp!thumb.webp') === 'https://v.pinedrama.com/a/b/c.webp!thumb.webp',
    pfp('https://v.pinedrama.com/a/b/c.webp!thumb.webp'));
  check('P41 别站的 !数字.webp 尾缀不受波及',
    pfp('https://example.com/img/a.webp!15491.webp') === 'https://example.com/img/a.webp!15491.webp',
    pfp('https://example.com/img/a.webp!15491.webp'));

  /* —— v1.6.4：Apple TV 尺寸码提到 1200×1800 ————————————————————
   * 采集存 400×600（73KB），机器人卡满宽渲染偏软；mzstatic 按请求尺寸裁切，
   * 1200×1800 同为 2:3 不改构图，22/22 条存量实测 200（2026-09-15）。
   */
  check('P11 appletv 尺寸码提到 1200x1800（裁切码与扩展名保留）', pfp(POSTERS.appletv) ===
    'https://is1-ssl.mzstatic.com/image/thumb/i-QRI7ak7O755Nvdv11UnQ/1200x1800nr.jpg',
    pfp(POSTERS.appletv));
  // 裁切码取自站点自己的 artwork.template（content.js 只替换 {w}/{h}/{f}），
  // 当前存量恰好全是 nr，但 sr/bb 等随时可能出现——故按形状匹配数字，不写死字符串
  check('P12 非 nr 裁切码同样归一', pfp(
    'https://is5-ssl.mzstatic.com/image/thumb/Video/aa/bb/cc/hash.png/800x1200bb.jpg') ===
    'https://is5-ssl.mzstatic.com/image/thumb/Video/aa/bb/cc/hash.png/1200x1800bb.jpg',
    pfp('https://is5-ssl.mzstatic.com/image/thumb/Video/aa/bb/cc/hash.png/800x1200bb.jpg'));
  check('P13 尾段不是尺寸码时原样透传', pfp(
    'https://is1-ssl.mzstatic.com/image/thumb/i-QRI7ak7O755Nvdv11UnQ/cover.jpg') ===
    'https://is1-ssl.mzstatic.com/image/thumb/i-QRI7ak7O755Nvdv11UnQ/cover.jpg', '');
  check('P14 别站的尺寸形状尾段不受波及', pfp('https://example.com/img/400x600nr.jpg') ===
    'https://example.com/img/400x600nr.jpg', pfp('https://example.com/img/400x600nr.jpg'));
  check('P15 appletv 改写后仍可转附件', convertible(pfp(POSTERS.appletv)), pfp(POSTERS.appletv));
}

// ---------- D 组：buildPayload 的 title_display（与卡片/机器人同一份文案） ----------
{
  const disp = d => Lark.buildPayload(d).title_display;
  check('D1 中英不同 → 「中文（英文）」',
    disp({ title: 'Yandere Virus', titleZh: '病娇病毒' }) === '病娇病毒（Yandere Virus）',
    disp({ title: 'Yandere Virus', titleZh: '病娇病毒' }));
  // v1.6.2：中文开发商的 Steam 英文档名本身就是中文，AI 原样返回（全库 70 条）
  check('D2 中英同名 → 不写成「X（X）」',
    disp({ title: '骷髅传奇', titleZh: '骷髅传奇' }) === '骷髅传奇',
    disp({ title: '骷髅传奇', titleZh: '骷髅传奇' }));
  check('D3 仅差装饰性标点也视作同名', disp({ title: 'NBA 2K27', titleZh: '《NBA 2K27》' }) === '《NBA 2K27》',
    disp({ title: 'NBA 2K27', titleZh: '《NBA 2K27》' }));
  check('D4 无中文译名 → 只留英文', disp({ title: 'Solo English', titleZh: '' }) === 'Solo English',
    disp({ title: 'Solo English', titleZh: '' }));
  check('D5 title_zh 键本身不受折叠影响（表格列要的是原值）',
    Lark.buildPayload({ title: '骷髅传奇', titleZh: '骷髅传奇' }).title_zh === '骷髅传奇', '');
}

// ---------- T 组：表格投影层 ----------
const SUB = 'https://unit.test/list';
const FIXTURE = [
  { id: 'id-1', itemId: 'tt0001', title: 'Alpha', titleZh: '阿尔法', tags: ['IMDB', 'micro-drama'],
    description: 'line one\nline two', descriptionZh: '含，逗号与"引号"', company: 'Studio A',
    source: 'imdb', status: 'trans', url: 'https://x/1', sourceListUrl: SUB, poster: POSTERS.imdb,
    scrapedAt: '2026-09-01T00:00:00.000Z', translatedAt: '2026-09-01T01:00:00.000Z',
    genres: ['Romance', 'Drama'] },
  { id: 'id-2', itemId: 'ds0002', title: 'Beta', source: 'dramashorts', status: 'trans',
    description: '- 以减号开头的正常简介', poster: POSTERS.dramashorts, sourceListUrl: SUB,
    scrapedAt: '2026-08-01T00:00:00.000Z', tags: [], genres: [] },
  { id: 'id-3', itemId: 'md0003', title: 'Gamma', source: 'mydrama', status: 'trans',
    poster: POSTERS.mydramaPct, sourceListUrl: SUB, scrapedAt: '2026-09-10T00:00:00.000Z',
    tags: ['MyDrama'], genres: [] },
  { id: 'id-4', itemId: 'tt0001', title: 'Alpha 重复条目', source: 'imdb', sourceListUrl: SUB,
    scrapedAt: '2026-09-11T00:00:00.000Z' },
  // 去重键＝itemId||id（与 buildTimelineCsv 同语义），两者皆无才跳过
  { title: '无键应跳过', source: 'steam', sourceListUrl: SUB }
];

check('T1 TABLE_COLUMNS 与 TimelineCsv.CSV_COLUMNS 严格一致',
  deepEq(Lark.TABLE_COLUMNS, TimelineCsv.CSV_COLUMNS) && Lark.TABLE_COLUMNS.length === 15,
  `${(Lark.TABLE_COLUMNS || []).length} 列`);
check('T1c company 不在导出列内（v1.5.13 彻底移除）',
  !Lark.TABLE_COLUMNS.includes('company') && !Lark.TABLE_HEADERS.some(h => h.includes('出品方')), '');
check('T1b TABLE_HEADERS 为中文名、与列一一对应且无空缺',
  Array.isArray(Lark.TABLE_HEADERS) && Lark.TABLE_HEADERS.length === Lark.TABLE_COLUMNS.length
  && Lark.TABLE_HEADERS.every(h => typeof h === 'string' && h.trim() && !/^[a-zA-Z]+$/.test(h))
  && new Set(Lark.TABLE_HEADERS).size === Lark.TABLE_HEADERS.length,
  JSON.stringify(Lark.TABLE_HEADERS));

const rows = Lark.buildTableRows ? Lark.buildTableRows(FIXTURE) : [];
check('T2 itemId 去重 + 无键跳过（5 输入 → 3 行）', rows.length === 3, `rows=${rows.length}`);
check('T3 去重先到先得（保留首条 Alpha）', rows[0]?.title === 'Alpha', rows[0]?.title);
check('T4 每行含全部 15 键', rows.every(r => deepEq(Object.keys(r), TimelineCsv.CSV_COLUMNS)), '');
check('T5 行内 poster 已改写', rows.every(r => convertible(r.poster)),
  rows.filter(r => !convertible(r.poster)).map(r => r.poster).join(' | '));

// 筛选谓词
const since = Lark.buildTableRows(FIXTURE, { since: '2026-09-01T00:00:00.000Z' });
check('T6 since 过滤（含边界，取 >=）', since.length === 2 && since.every(r => r.scrapedAt >= '2026-09-01T00:00:00.000Z'),
  `len=${since.length}`);
const bySource = Lark.buildTableRows(FIXTURE, { sources: ['mydrama', 'dramashorts'] });
check('T7 sources 过滤', bySource.length === 2 && bySource.every(r => ['mydrama', 'dramashorts'].includes(r.source)),
  `len=${bySource.length}`);
const both = Lark.buildTableRows(FIXTURE, { since: '2026-09-01T00:00:00.000Z', sources: ['mydrama'] });
check('T8 since + sources 叠加', both.length === 1 && both[0].itemId === 'md0003', `len=${both.length}`);
check('T9 空输入返回空数组', deepEq(Lark.buildTableRows([]), []) && deepEq(Lark.buildTableRows(null), []), '');

// ---------- S 组：序列化 ----------
const tsv = Lark.toTsv(rows);
const tsvLines = tsv.split('\n');
// TSV 是「粘到表末追加」用的，带表头会平白多出一行垃圾记录——Base 粘贴不会
// 把首行认成字段名，字段名只在 CSV 导入建表时由表头确定
check('S1 TSV 只有数据行、不带表头', tsvLines.length === rows.length
  && !tsvLines[0].startsWith('id\t') && !tsvLines[0].includes('条目ID'), `lines=${tsvLines.length}`);
check('S2 TSV 首行即第一条数据', tsvLines[0].split('\t')[2] === 'Alpha', tsvLines[0].slice(0, 60));
check('S3 TSV 每行恰好 15 格（无制表符污染导致的错位）',
  tsvLines.every(line => line.split('\t').length === 15),
  tsvLines.map(l => l.split('\t').length).join(','));
check('S4 TSV 内嵌换行已折成空格', !/\r/.test(tsv) && tsv.includes('line one line two'), '');
check('S5 TSV 不加公式前缀（- 开头的简介原样）', tsv.includes('- 以减号开头的正常简介') && !tsv.includes("'- 以减号"), '');
check('S6 TSV 不做 CSV 引号包裹（逗号/引号原样进单元格）',
  tsv.includes('含，逗号与"引号"') && !tsv.includes('""引号""'), '');
check('S7 TSV tags/genres 逗号连接（制表符分列，逗号在格内无害）',
  tsv.includes('IMDB,micro-drama') && tsv.includes('Romance,Drama'), '');

const csv = Lark.toCsv(rows);
// CSV 是「导入建表」用的，表头即字段名——固定中文（2026-09-12 用户定）
check('S8 CSV 带 BOM + CRLF + 中文表头', csv.startsWith('﻿') && csv.includes('\r\n')
  && csv.split('\r\n')[0].replace('﻿', '') === Lark.TABLE_HEADERS.map(h => `"${h}"`).join(','),
  csv.split('\r\n')[0].slice(0, 80));
check('S9 CSV 行数 = 表头 + 记录数', csv.trimEnd().split('\r\n').length === rows.length + 1,
  `lines=${csv.trimEnd().split('\r\n').length}`);
check('S10 CSV 引号转义生效', csv.includes('""引号""'), '');
check('S11 CSV 同样不加公式前缀', !csv.includes("'- 以减号"), '');
check('S12 CSV 与 TimelineCsv 产物不同（poster 已改写、表头已中文，证明没走错出口）',
  csv !== TimelineCsv.buildTimelineCsv(FIXTURE).content, '');
check('S13 空输入：CSV 只剩表头、TSV 为空串', Lark.toTsv([]) === ''
  && Lark.toCsv([]).trimEnd().split('\r\n').length === 1, JSON.stringify(Lark.toTsv([])));
check('S14 CSV 数据行列数与表头一致', csv.trimEnd().split('\r\n').slice(1)
  .every(line => (line.match(/","/g) || []).length + 1 === 15), '');

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
