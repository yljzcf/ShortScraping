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

if (card) {
  const json = JSON.stringify(card);
  check('C2 msg_type=interactive 且带 card 根', card.msg_type === 'interactive' && Boolean(card.card), json.slice(0, 80));
  check('C3 标题含中英文对照', json.includes('低语者') && json.includes('The Whisper Man'), '');
  check('C4 含来源站点显示名', json.includes('Netflix'), '');
  check('C5 含类型标签', json.includes('Thrillers'), '');
  check('C6 中文简介优先于英文', json.includes('一段中文简介') && !json.includes('An English synopsis'), '');
  check('C7 带跳转按钮指向原页', json.includes('https://www.netflix.com/title/12345')
    && json.includes('"tag":"button"'), '');
  // 硬限制：卡片里不能出现 img 元素，否则飞书整条拒收（ErrCode 11310）
  check('C8 不含 img 元素（img_key 需自建应用，实测会被拒收）',
    !json.includes('"tag":"img"') && !json.includes('img_key'), '');
  check('C9 封面链接不出现在卡片里', !json.includes('nflximg'), '');
}

// 退化面
{
  const noZh = Lark.buildBotCard({ ...FULL, titleZh: '', descriptionZh: '' });
  const s = JSON.stringify(noZh);
  check('C10 无中文时退回英文标题与简介',
    s.includes('The Whisper Man') && s.includes('An English synopsis'), '');
  const noUrl = Lark.buildBotCard({ ...FULL, url: '' });
  check('C11 无合法 url 时不渲染按钮', !JSON.stringify(noUrl).includes('"tag":"button"'), '');
  const badUrl = Lark.buildBotCard({ ...FULL, url: 'javascript:alert(1)' });
  check('C12 非 http(s) 的 url 不渲染按钮', !JSON.stringify(badUrl).includes('"tag":"button"'), '');
  const bare = Lark.buildBotCard({});
  check('C13 空条目也能组装出合法卡片', bare?.msg_type === 'interactive' && Boolean(bare?.card?.elements?.length), '');
  const longDesc = Lark.buildBotCard({ ...FULL, descriptionZh: '很长'.repeat(400) });
  check('C14 超长简介被裁剪（群里不刷屏）', JSON.stringify(longDesc).length < 1500,
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
