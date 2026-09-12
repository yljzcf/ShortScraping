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
//   标题栏＝中文译名（英文译名）／正文①中文简介 ②斜体英文原文
//   ③空行后「**来源：**」+tags ④「**类别：**」+genres ⑤按钮「去瞅瞅」
const mdOf = (c, i) => c?.card?.elements?.[i]?.text?.content || '';

if (card) {
  const json = JSON.stringify(card);
  const header = card.card?.header?.title?.content || '';
  check('C2 msg_type=interactive 且带 card 根', card.msg_type === 'interactive' && Boolean(card.card), json.slice(0, 80));
  check('C3 标题栏＝中文译名（英文译名），不带「新增」字样',
    header === '低语者（The Whisper Man）' && !header.includes('新增'), header);
  check('C4 正文第一段是中文简介', mdOf(card, 0) === '一段中文简介。', mdOf(card, 0));
  check('C5 第二段是斜体英文原文', mdOf(card, 1) === '*An English synopsis.*', mdOf(card, 1));
  check('C6 来源行加粗且列 tags（tags 自带平台名）',
    mdOf(card, 2).includes('**来源：**') && mdOf(card, 2).includes('Netflix')
    && mdOf(card, 2).includes('Movie') && mdOf(card, 2).includes('Global'), mdOf(card, 2));
  check('C6b 类别行列 genres', mdOf(card, 2).includes('**类别：**')
    && mdOf(card, 2).includes('Thrillers') && mdOf(card, 2).includes('Mysteries'), mdOf(card, 2));
  check('C6c 来源在类别之前',
    mdOf(card, 2).indexOf('**来源：**') < mdOf(card, 2).indexOf('**类别：**'), mdOf(card, 2));
  check('C7 尾部按钮文案「去瞅瞅」并指向原页',
    json.includes('"去瞅瞅"') && json.includes('https://www.netflix.com/title/12345')
    && json.includes('"tag":"button"'), '');
  // 硬限制：卡片里不能出现 img 元素，否则飞书整条拒收（ErrCode 11310）
  check('C8 不含 img 元素（img_key 需自建应用，实测会被拒收）',
    !json.includes('"tag":"img"') && !json.includes('img_key'), '');
  check('C9 封面链接不出现在卡片里', !json.includes('nflximg'), '');
}

// 退化面
{
  const noZh = Lark.buildBotCard({ ...FULL, titleZh: '', descriptionZh: '' });
  check('C10a 无中文标题时标题栏只留英文原名',
    noZh.card.header.title.content === 'The Whisper Man', noZh.card.header.title.content);
  check('C10b 无中文简介时正文首段直接是斜体英文（不留空段）',
    mdOf(noZh, 0) === '*An English synopsis.*', mdOf(noZh, 0));
  const noEn = Lark.buildBotCard({ ...FULL, description: '' });
  check('C10c 无英文原文时不渲染斜体段（第二段直接是来源/类别）',
    mdOf(noEn, 0) === '一段中文简介。' && mdOf(noEn, 1).includes('**来源：**'), mdOf(noEn, 1));
  const noMeta = Lark.buildBotCard({ ...FULL, tags: [], genres: [] });
  check('C10d 无 tags/genres 时不渲染来源与类别行',
    !JSON.stringify(noMeta).includes('来源：') && !JSON.stringify(noMeta).includes('类别：'), '');
  const onlyTags = Lark.buildBotCard({ ...FULL, genres: [] });
  check('C10e 只有 tags 时仍渲染来源行、不渲染类别行',
    JSON.stringify(onlyTags).includes('来源：') && !JSON.stringify(onlyTags).includes('类别：'), '');

  const noUrl = Lark.buildBotCard({ ...FULL, url: '' });
  check('C11 无合法 url 时不渲染按钮', !JSON.stringify(noUrl).includes('"tag":"button"'), '');
  const badUrl = Lark.buildBotCard({ ...FULL, url: 'javascript:alert(1)' });
  check('C12 非 http(s) 的 url 不渲染按钮', !JSON.stringify(badUrl).includes('"tag":"button"'), '');
  const bare = Lark.buildBotCard({});
  check('C13 空条目也能组装出合法卡片', bare?.msg_type === 'interactive' && Boolean(bare?.card?.header), '');
  const longDesc = Lark.buildBotCard({ ...FULL, descriptionZh: '很长'.repeat(400) });
  check('C14 超长简介被裁剪（群里不刷屏）', JSON.stringify(longDesc).length < 1800,
    String(JSON.stringify(longDesc).length));
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

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
