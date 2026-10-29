import './bootstrap.cjs';
// 卡片版式单测（v1.6.3）。
//
// 背景：封面加载失败时会换成 default-poster.svg（200×300 竖版），旧写法拿**占位图**
// 的比例重判方向，把 Steam 卡（真实 header.jpg 恒为 460×215 横版）摘掉 card-landscape、
// 掉进双列窄版式。那里 .card-main 只有 90px，标题还要给右上三槽位按钮让 80px，
// 2026-09-14 实测标题只剩 10~12px、被裁成一个字（离线/CDN 被挡/游戏下架时整屏都这样）。
//
// 两道防线，分别由 O 组与 C 组守着：
//   O：orientationFromPoster 不拿占位图改判（根因，修完标题 12px → 196px）
//   C：「占位图不铺满整行」在两页共用的 timeline-cards.css 里。卡片操作按钮浮在右上角（弹窗才有）：
//      v1.8.0 起只剩两枚、角标改成标题行里的小标签，留白从整个标题区 80px 收成只给标题第一行留 ≤60px；
//      「窄卡标题让行」底线（Steam 真发竖版封面时兜底）仍在 popup.css——不让行标题就只剩一两个字
//   D：2026-09-25 审计 E 把两页逐字相同的规则收进 src/shared/timeline-cards.css——三份文件之间
//      不许再出现重复规则（重复就又回到「改一处漏一处」），两页都要先引入共享文件再引入自己的 css
//   G：v1.8.0 时间线只按入库日期分组（去掉卡片上方的抓取时刻）；日期标题带今天 / 昨天与星期
//   T：v1.8.0 标题分主副两行，titleParts 与 titleDisplay 判据同一份（v1.8.12 起卡片只显示一种语言，
//      titleDisplay 的「中文（英文）」留给标题悬停提示）
//   L：v1.8.12 卡片中英切换——cardTextOf 按语言取标题 / 简介 / 内容标签，缺了退回另一种；
//      中文标签走通用标签体系、英文标签滤掉演员名；双语版式（副标题、两段简介）整段退场。
//      v1.8.13 搜索命中另一种语言时的双语卡（L15-L17）
//
// 用法：node tests/unit-card-layout.mjs
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
(0, eval)(read('../src/shared/site-registry.js'));
(0, eval)(read('../src/shared/genre-taxonomy.js'));
(0, eval)(read('../src/shared/timeline-render.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ---------- O 组：封面方向判定 ----------
const orient = globalThis.TimelineRender.orientationFromPoster;
check('O0 orientationFromPoster 已导出', typeof orient === 'function', `typeof=${typeof orient}`);

check('O1 真实横版封面（Steam header 460×215）判横版',
  orient(460, 215, false) === true, String(orient(460, 215, false)));
check('O2 真实竖版封面（2:3 海报）判竖版',
  orient(400, 600, false) === false, String(orient(400, 600, false)));
check('O3 已回退占位图时返回 null＝不改判（保留按 source 定的初始猜测）',
  orient(200, 300, true) === null, String(orient(200, 300, true)));
check('O3b 占位图恰好是横版也一样不改判（形状不带信息，不是「竖版才跳过」）',
  orient(460, 215, true) === null, String(orient(460, 215, true)));
check('O4 尺寸未知（图还没解码）返回 null，不瞎判',
  orient(0, 0, false) === null && orient(undefined, undefined, false) === null,
  `${orient(0, 0, false)} / ${orient(undefined, undefined, false)}`);
check('O5 正方形不算横版（宽>高才是）', orient(300, 300, false) === false, String(orient(300, 300, false)));

// ---------- C 组：卡片版式规则 ----------
const SHARED_CSS_REL = 'src/shared/timeline-cards.css';
const sharedCss = read(`../${SHARED_CSS_REL}`);
const CSS = {
  'src/popup/popup.css': read('../src/popup/popup.css'),
  'server/public/share.css': read('../server/public/share.css')
};
// 空白无关的包含判断：两份文件缩进不同（share.css 的双列规则在 @media 块里）
const squash = s => s.replace(/\s+/g, ' ');
const ruleBody = (src, selector) => {
  const m = squash(src).match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`));
  return m ? m[1].trim() : null;
};
// 占位图不带信息，横版布局（封面在上）留着它就白占一整行把卡片撑高 → 不显示
const fallbackPoster = ruleBody(sharedCss, '.drama-card.poster-fallback.card-landscape .card-poster');
check(`C1 ${SHARED_CSS_REL} 横版下的占位图不显示`, Boolean(fallbackPoster) && /display:\s*none/.test(fallbackPoster),
  fallbackPoster || '(未匹配到规则)');
// 共享的 .card-title 不留白：共享页没有按钮，留白只在弹窗自己的 css 里给
const titleRule = ruleBody(sharedCss, '.card-title');
check(`C1b ${SHARED_CSS_REL} 的 .card-title 不为右上按钮留白`,
  Boolean(titleRule) && !/padding-right/.test(titleRule) && !/margin-top/.test(titleRule), titleRule || '(未匹配到规则)');
// 留白只给标题第一行（副标题在按钮底边之下、占满整宽），且不超过 60px（v1.8.0 前整个标题区 80px）
{
  const popupCss = squash(CSS['src/popup/popup.css']);
  // 首个 `.card-title-row {` 就是不带前缀的那条（横版 / 窄卡的覆盖规则都排在它后面）
  const rowReserve = ((ruleBody(CSS['src/popup/popup.css'], '.card-title-row') || '').match(/padding-right:\s*(\d+)px/) || [])[1];
  check('C2 popup.css 只给 .card-title-row 留白，且不超过 60px', Number(rowReserve) > 0 && Number(rowReserve) <= 60, String(rowReserve));
  const wholeTitle = popupCss.match(/[^{}]*\.card-title \{[^}]*padding-right:\s*[1-9][^}]*\}/);
  check('C2a popup.css 不再给整个标题区（含副标题）留白', !wholeTitle, wholeTitle ? wholeTitle[0].trim() : '');
  check('C2c share.css 不给标题留白（共享页没有操作按钮）',
    !/\.card-title[^{]*\{[^}]*padding-right:\s*[1-9]/.test(squash(CSS['server/public/share.css'])), '');
  // 窄卡让行：清掉留白并下移到按钮带下方
  const m = popupCss.match(/\.drama-card:not\(\.card-full\):not\(\.card-landscape\) \.card-title-row \{([^}]*)\}/);
  check('C2b popup.css 有「Steam 窄卡竖版标题让行」底线规则（padding-right:0 + margin-top）',
    Boolean(m) && /padding-right:\s*0/.test(m[1]) && /margin-top:\s*[1-9]/.test(m[1]), m ? m[1].trim() : '(未匹配到规则)');
  // 横版卡封面失效：占位图藏起后标题行成了最上面一行，要重新给按钮让位
  const fallback = popupCss.match(/\.drama-card\.card-landscape\.poster-fallback \.card-title-row \{([^}]*)\}/);
  check('C2d popup.css 横版卡封面失效时标题行重新留白', Boolean(fallback) && /padding-right:\s*[1-9]/.test(fallback[1]),
    fallback ? fallback[1].trim() : '(未匹配到规则)');
  const actions = ruleBody(CSS['src/popup/popup.css'], '.card-actions');
  check('C3b popup.css 把 .card-actions 绝对定位到卡片右上角',
    Boolean(actions) && /position:\s*absolute/.test(actions) && /top:/.test(actions) && /right:/.test(actions), actions || '(未匹配到规则)');
}
// 按钮由共享渲染模块画在卡片顶层（.card-content 之前），飞书是纸飞机线条图标；「待翻译」是标题行里的小标签
{
  const renderSrc = read('../src/shared/timeline-render.js');
  const contentAt = renderSrc.indexOf('<div class="card-content">');
  const actionsAt = renderSrc.indexOf('<div class="card-actions">');
  check('C3 timeline-render 把卡片操作按钮画在卡片顶层、.card-content 之前',
    actionsAt >= 0 && contentAt > actionsAt && !renderSrc.includes('status-badge') && renderSrc.includes('class="status-chip"'),
    `actions=${actionsAt} content=${contentAt}`);
  check('C3c 飞书按钮用纸飞机线条图标（不再是 lark.png）',
    renderSrc.includes("global.Icons.svg('send')") && !renderSrc.includes('lark.png'), '');
}
// 加 poster-fallback 类的是共享渲染模块，两页共用——类名拼错就全盘失效
check('C4 timeline-render 在封面失败时加 poster-fallback 类',
  read('../src/shared/timeline-render.js').includes("classList.add('poster-fallback')"), '');

// ---------- G 组：时间线只按入库日期分组（v1.8.0） ----------
{
  const { groupByDate } = globalThis.TimelineRender;
  const now = new Date(2026, 9, 18, 20, 0);   // 2026-10-18 周日（本地时间）
  const at = (d, h, m) => new Date(2026, 9, d, h, m).toISOString();
  const list = [
    { id: 'a', scrapedAt: at(18, 14, 56) },
    { id: 'b', scrapedAt: at(18, 9, 3) },     // 同一天、相隔五个多小时：v1.8.0 前会拆成两个时间组
    { id: 'c', scrapedAt: at(17, 23, 59) },
    { id: 'd', scrapedAt: at(16, 8, 0) },
    { id: 'e', scrapedAt: new Date(2025, 11, 3, 10, 0).toISOString() },
    { id: 'f' },
    { id: 'g', scrapedAt: 'not a date' }
  ];
  const groups = groupByDate(list, now);
  const view = groups.map(g => `${g.label}:${g.dramas.map(d => d.id).join('')}`);
  check('G1 同一天的卡片都在一个日期组里，组内保持调用方给的顺序', view[0] === '今天 · 10月18日 周日:ab', JSON.stringify(view));
  check('G2 昨天加前缀、其余写月日与星期、跨年才写年份',
    view[1] === '昨天 · 10月17日 周六:c' && view[2] === '10月16日 周五:d' && view[3] === '2025年12月3日 周三:e', JSON.stringify(view));
  check('G3 缺 scrapedAt 或时间戳非法的条目归入「未知日期」一组', view[4] === '未知日期:fg' && groups.length === 5, JSON.stringify(view));
  const renderSrc = read('../src/shared/timeline-render.js');
  check('G4 renderTimeline 不再输出抓取时刻（.timeline-time），formatTime 已删',
    !renderSrc.includes('timeline-time') && !/\bformatTime\b/.test(renderSrc), '');
  check('G5 日期标题末尾是当天条数', renderSrc.includes("count.textContent = `+${dateGroup.dramas.length}`"), '');
}

// ---------- T 组：标题主副两行（v1.8.0） ----------
{
  const { titleParts, titleDisplay } = globalThis.TranslateConfig;
  const cases = [
    [{ titleZh: '亿万总裁的二婚娇妻', title: "The Billionaire's Second Wife" }, { main: '亿万总裁的二婚娇妻', sub: "The Billionaire's Second Wife" }],
    [{ titleZh: '骷髅传奇', title: '骷髅传奇' }, { main: '骷髅传奇', sub: '' }],
    [{ titleZh: '《NBA 2K27》', title: 'NBA 2K27' }, { main: '《NBA 2K27》', sub: '' }],
    [{ title: 'Untranslated Drama' }, { main: 'Untranslated Drama', sub: '' }],
    [{ titleZh: '只有中文', title: '  ' }, { main: '只有中文', sub: '' }]
  ];
  for (const [drama, expected] of cases) {
    const parts = titleParts(drama);
    const joined = parts.sub ? `${parts.main}（${parts.sub}）` : parts.main;
    check(`T1 titleParts ${JSON.stringify(drama)}`,
      parts.main === expected.main && parts.sub === expected.sub && joined === titleDisplay(drama), JSON.stringify(parts));
  }
}

// ---------- L 组：卡片中英切换（v1.8.12） ----------
{
  const { cardTextOf, normalizeLang, LANG_LABELS } = globalThis.TimelineRender;
  const full = {
    title: "The Billionaire's Stand-in Bride", titleZh: '亿万富翁的替嫁新娘',
    description: 'She married him in her sister\'s place.', descriptionZh: '她替姐姐嫁给了他。',
    genres: ['Substitute Bride', 'Billionaire', 'USA', 'Aaron Russell']
  };
  const zh = cardTextOf(full, 'zh');
  check('L1 中文模式：标题、简介取中文，标签走通用标签体系（按体系顺序、去掉刻意不收的 USA 与演员名）',
    zh.title === '亿万富翁的替嫁新娘' && zh.desc === '她替姐姐嫁给了他。' && zh.descLang === 'zh'
      && JSON.stringify(zh.tags) === '["替嫁","霸总"]' && zh.tagsLang === 'zh', JSON.stringify(zh));
  const en = cardTextOf(full, 'en');
  check('L2 英文模式：标题、简介取英文，标签是站点原文但滤掉混进 genres 的演员名',
    en.title === full.title && en.desc === full.description && en.descLang === 'en'
      && JSON.stringify(en.tags) === '["Substitute Bride","Billionaire","USA"]' && en.tagsLang === 'en', JSON.stringify(en));

  const untranslated = cardTextOf({ title: 'Fresh Drama', description: 'Just scraped.', genres: ['Revenge'], status: 'new' }, 'zh');
  check('L3 中文模式下未翻译的新卡：标题、简介退回英文（descLang 标 en），标签照样能对出中文',
    untranslated.title === 'Fresh Drama' && untranslated.desc === 'Just scraped.' && untranslated.descLang === 'en'
      && JSON.stringify(untranslated.tags) === '["复仇"]', JSON.stringify(untranslated));
  const unmapped = cardTextOf({ titleZh: '某剧', genres: ['Totally New Tag', 'Aaron Russell'] }, 'zh');
  check('L4 中文模式下标签一个都对不上体系：退回英文原文（仍滤演员名）',
    JSON.stringify(unmapped.tags) === '["Totally New Tag"]' && unmapped.tagsLang === 'en', JSON.stringify(unmapped));
  const zhOnly = cardTextOf({ titleZh: '只有中文', descriptionZh: '只有中文简介', title: '  ' }, 'en');
  check('L5 英文模式下缺英文：退回中文', zhOnly.title === '只有中文' && zhOnly.desc === '只有中文简介' && zhOnly.descLang === 'zh',
    JSON.stringify(zhOnly));
  const empty = cardTextOf({ id: 'x' }, 'zh');
  check('L6 什么都没有：空串与空标签，不炸', empty.title === '' && empty.desc === '' && empty.tags.length === 0, JSON.stringify(empty));
  check('L6b 另一种语言（搜索双语卡用）：中文模式给英文名与英文简介；名字只差装饰性标点、或缺另一种时为空串',
    zh.titleAlt === full.title && zh.descAlt === full.description && zh.descAltLang === 'en'
      && en.titleAlt === full.titleZh && en.descAltLang === 'zh'
      && cardTextOf({ titleZh: '《NBA 2K27》', title: 'NBA 2K27' }, 'zh').titleAlt === ''
      && untranslated.titleAlt === '' && untranslated.descAlt === '', JSON.stringify({ zh, untranslated }));
  check('L7 语言缺省、不认识的值都当中文；默认选项是中文',
    normalizeLang(undefined) === 'zh' && normalizeLang('fr') === 'zh' && normalizeLang('en') === 'en'
      && cardTextOf(full).title === zh.title, '');
  check('L8 按钮文字显示当前语言（中 / EN），悬停提示说清点了切到哪',
    LANG_LABELS.zh.text === '中' && LANG_LABELS.en.text === 'EN'
      && /切换为英文/.test(LANG_LABELS.zh.title) && /切换为中文/.test(LANG_LABELS.en.title), JSON.stringify(LANG_LABELS));

  const renderSrc = read('../src/shared/timeline-render.js');
  check('L9 双语版式退场：卡片不再画副标题与「中 + 英」两段简介的旧类名；平时只画一段 .card-desc 并标 lang（第二段只给搜索双语卡）',
    !/card-title-sub|card-desc-zh|card-desc-en|desc-zh-only|desc-en-only/.test(renderSrc)
      && renderSrc.includes('<div class="card-desc${extraClass}" lang="') && renderSrc.includes("bilingual && text.descAlt ? descHtml("), '');
  check('L10 标题悬停提示仍是 titleDisplay（中文（英文）），看得到另一种语言',
    renderSrc.includes('<div class="card-title-text" title="${escapeAttribute(titleDisplay)}">'), '');

  const allCss = [sharedCss, ...Object.values(CSS)].join('\n');
  check('L11 三份 CSS 都不再有双语版式的类（副标题、.card-desc-zh / -en、desc-*-only）',
    !/card-title-sub|card-desc-zh|card-desc-en|desc-zh-only|desc-en-only/.test(allCss), '');
  const titleText = ruleBody(sharedCss, '.card-title-text') || '';
  check('L12 标题最多折两行（英文标题长，单行省略太多）', /-webkit-line-clamp:\s*2/.test(titleText) && !/nowrap/.test(titleText), titleText);
  const desc = ruleBody(sharedCss, '.card-desc') || '';
  const large = ruleBody(sharedCss, '.card-description.desc-large .card-desc') || '';
  const ratio = renderSrc.match(/DESC_LARGE_SCALE = (\d+) \/ (\d+);/);
  check('L13 简介字号与 timeline-render 的放大倍数对得上（12px → desc-large 14px，行高写倍数）',
    /font-size:\s*12px/.test(desc) && /line-height:\s*1\.\d+;/.test(desc) && /font-size:\s*14px/.test(large)
      && Boolean(ratio) && ratio[1] === '14' && ratio[2] === '12', `${desc} | ${large} | ${ratio && ratio[0]}`);
  const alt = ruleBody(sharedCss, '.card-desc.is-alt') || '';
  check('L15 搜索双语卡（v1.8.13）：另一种语言的标题行与简介段有样式，简介段字色淡一级',
    Boolean(ruleBody(sharedCss, '.card-title-alt')) && /color:\s*var\(--text-secondary\)/.test(alt)
      && /margin-bottom:\s*4px/.test(ruleBody(sharedCss, '.card-desc:not(:last-child)') || ''), alt);
  const { splitDescLines } = globalThis.TimelineRender;
  const cases = [[[2, 3], 8, [2, 3]], [[10, 10], 7, [3, 4]], [[2, 10], 7, [2, 5]], [[10, 2], 7, [5, 2]], [[9, 9], 6, [3, 3]]];
  check('L16 双语两段分行数：放得下都放全；放不下各给一半、短的让出富余，奇数多出的一行给第二段（命中的那段）',
    cases.every(([lines, avail, want]) => JSON.stringify(splitDescLines(lines, avail)) === JSON.stringify(want)),
    JSON.stringify(cases.map(([lines, avail]) => splitDescLines(lines, avail))));
  const btn = ruleBody(sharedCss, '.btn-lang') || '';
  check('L14 「中 / EN」按钮样式只在共享文件里写一份（两页同一枚）',
    /width:\s*32px/.test(btn) && Object.values(CSS).every(src => !src.includes('.btn-lang')), btn);
}

// ---------- D 组：三份 CSS 之间零重复、两页先引共享样式 ----------
/** 顶层切块（去注释、压空白）：@media / @keyframes 整块算一条，块内规则随所在上下文比较。 */
function topLevelRules(src) {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) {
      rules.push(text.slice(start, i + 1).replace(/\s+/g, ' ').replace(/\s*([{};:,>])\s*/g, '$1').trim());
      start = i + 1;
    }
  }
  return rules;
}
const ruleSets = {
  [SHARED_CSS_REL]: topLevelRules(sharedCss),
  ...Object.fromEntries(Object.entries(CSS).map(([rel, src]) => [rel, topLevelRules(src)]))
};
check('D0 切块自检：共享文件收了卡片/标签条规则，两页各自还有布局规则',
  ruleSets[SHARED_CSS_REL].length >= 60 && Object.keys(CSS).every(rel => ruleSets[rel].length >= 10),
  JSON.stringify(Object.fromEntries(Object.entries(ruleSets).map(([rel, rules]) => [rel, rules.length]))));
const rels = Object.keys(ruleSets);
for (let a = 0; a < rels.length; a++) {
  for (let b = a + 1; b < rels.length; b++) {
    const other = new Set(ruleSets[rels[b]]);
    const dups = ruleSets[rels[a]].filter(rule => other.has(rule));
    check(`D1 ${rels[a]} 与 ${rels[b]} 没有逐字相同的规则`, dups.length === 0,
      dups.map(rule => rule.slice(0, rule.indexOf('{'))).join(' | '));
  }
}
for (const [rel, rules] of Object.entries(ruleSets)) {
  const seen = new Set();
  const dups = rules.filter(rule => (seen.has(rule) ? true : (seen.add(rule), false)));
  check(`D1b ${rel} 自身没有重复规则`, dups.length === 0, dups.join(' | '));
}
// 共享文件必须排在页面 css 之前：两边同特异度的规则以页面为准（抽取时就按这个次序核过层叠）
for (const [rel, sharedHref, pageHref] of [
  ['src/popup/popup.html', '../shared/timeline-cards.css', 'popup.css'],
  ['server/public/share.html', '/shared/timeline-cards.css', '/public/share.css']
]) {
  const html = read(`../${rel}`);
  const sharedAt = html.indexOf(`<link rel="stylesheet" href="${sharedHref}">`);
  const pageAt = html.indexOf(`<link rel="stylesheet" href="${pageHref}">`);
  check(`D2 ${rel} 先引入 ${sharedHref} 再引入 ${pageHref}`, sharedAt >= 0 && pageAt > sharedAt,
    `shared=${sharedAt} page=${pageAt}`);
}
// 共享页的样式经同步服务静态白名单伺服（实际请求在 unit-server-safety 里验）
check('D3 同步服务静态白名单含 /shared/timeline-cards.css（text/css）',
  /'\/shared\/timeline-cards\.css': \{ file: path\.join\(SHARED_DIR, 'timeline-cards\.css'\), type: 'text\/css; charset=utf-8' \}/
    .test(read('../server/sync-server.js')), '');

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
