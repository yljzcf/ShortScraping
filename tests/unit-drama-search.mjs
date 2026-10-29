import './bootstrap.cjs';
// 弹窗搜索（v1.8.2）的匹配判据与卡片高亮。
//
//   M 组：shared/drama-search.js——归一（大小写、全角）、多词 AND、各字段命中、题材中文对照、
//         字段之间不拼凑命中、空查询与脏条目；v1.8.12 起中文类型标签体系的标签也能搜（M13）；
//         v1.8.13 起题材中文对照换成体系的搜索同义词（M11、M14、M15），1~3 个字母的英文按整词（M12）
//   H 组：timeline-render.js——highlightHtml 先切段再转义（词不命中 HTML 实体）、长词优先；
//         createDramaCard 的 highlightTerms / isUnsubscribed 选项（共享页不传时输出不变）；
//         v1.8.12 起标签整枚标亮跨语言（中文模式看英文原标签、英文模式看归到的中文标签，H10-H13）；
//         v1.8.13 起命中了没显示的那种语言时卡片改双语（H14-H17）、长简介从命中处附近开始（H18）、
//         没有对应标签的命中原词补成标签、命中的标签排最前（H19-H20）、短英文整词标亮（H21）
// 用法：node tests/unit-drama-search.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DramaSearch = require(path.join(root, 'src/shared/drama-search.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

const drama = (id, fields) => ({ id, title: '', titleZh: '', description: '', descriptionZh: '', tags: [], genres: [], ...fields });
const LIB = [
  drama('a', { title: 'The CEO\'s Revenge', titleZh: '总裁的复仇', tags: ['IMDB'], genres: ['Revenge', 'Billionaire'] }),
  drama('b', { title: 'Moonlight Pack', titleZh: '月光狼群', description: 'A werewolf alpha falls in love.', genres: ['Werewolf'], tags: ['ReelShort', 'Top'] }),
  drama('c', { title: 'School Days', descriptionZh: '校园青春故事，一场误会。', genres: ['School Life'], tags: ['Netflix'] }),
  drama('d', { title: 'Plain', titleZh: '平凡', tags: ['trending'], genres: [] })
];
const hit = q => DramaSearch.searchDramas(LIB, q).map(d => d.id).join(',');

// ============ M 组：匹配 ============
check('M1 英文不区分大小写', hit('revenge') === 'a' && hit('REVENGE') === 'a', hit('REVENGE'));
check('M2 全角字母与全角空格先归一（ＲＥＶＥＮＧＥ　ｃｅｏ）', hit('ＲＥＶＥＮＧＥ　ｃｅｏ') === 'a', hit('ＲＥＶＥＮＧＥ　ｃｅｏ'));
check('M3 多个词须全部命中（AND）', hit('ceo revenge') === 'a' && hit('ceo werewolf') === '', hit('ceo werewolf'));
check('M4 各字段都能命中：中文标题 / 英文简介 / 中文简介 / 站点标签 / 题材',
  hit('月光') === 'b' && hit('alpha') === 'b' && hit('误会') === 'c' && hit('netflix') === 'c' && hit('school life') === 'c',
  [hit('月光'), hit('alpha'), hit('误会'), hit('netflix'), hit('school life')].join('|'));
check('M5 题材中文标签：「狼人」命中 Werewolf，「霸总」命中 Billionaire，「校园」命中 School Life',
  hit('狼人') === 'b' && hit('霸总') === 'a' && hit('校园') === 'c', [hit('狼人'), hit('霸总'), hit('校园')].join('|'));
check('M6 子串命中：「霸总」的同义词是「霸道总裁」，搜其中一截「道总」也命中', DramaSearch.searchDramas(
  [drama('x', { genres: ['Billionaire/CEO'] })], '道总').length === 1, '');
check('M7 字段之间不拼凑命中：标题末尾 + 标签开头凑不出一个词',
  DramaSearch.searchDramas([drama('y', { title: 'Plai', tags: ['n'] })], 'plain').length === 0, '');
check('M8 空查询 / 纯空白没有结果', hit('') === '' && hit('   ') === '', '');
check('M9 脏条目（null、缺字段、genres 不是数组）不炸、不命中',
  DramaSearch.searchDramas([null, 'x', { id: 'z' }, { id: 'w', genres: 'Revenge' }], 'revenge').length === 0, '');
check('M10 parseQuery 去重、去空', JSON.stringify(DramaSearch.parseQuery(' A  a b ')) === '["a","b"]',
  JSON.stringify(DramaSearch.parseQuery(' A  a b ')));
const SYN_LIB = [
  drama('war', { title: 'Iron Front', genres: ['War & Military'] }),
  drama('gay', { title: 'Two Hearts', genres: ['Gay'] }),
  drama('les', { title: 'Her Girl', genres: ['LGBTQ'] }),
  drama('god', { title: 'Return of the War God', genres: ['War God'] }),
  drama('rich', { title: 'The Billionaire Bloodline', description: 'A global empire.', genres: ['Billionaire'] }),
  drama('usa', { title: 'Plain Story', genres: ['USA'] }),
  drama('ai', { title: 'Robot Love', description: 'AI真人短剧。', genres: [] })
];
const synHit = q => DramaSearch.searchDramas(SYN_LIB, q).map(d => d.id).join(',');
check('M11 体系搜索同义词（2026-10-29 审定）：「战争军事」「军事」→ 战争，「耽美」「百合」「女同」→ 同性，「兵王」→ 战神，「总裁」→ 霸总',
  synHit('战争军事') === 'war' && synHit('军事') === 'war' && synHit('耽美') === 'gay,les' && synHit('百合') === 'gay,les'
    && synHit('女同') === 'gay,les' && synHit('兵王') === 'god' && synHit('总裁') === 'rich',
  ['战争军事', '军事', '耽美', '兵王', '总裁'].map(synHit).join('|'));
check('M12 1~3 个字母的英文按整词：BL / GL 只命中同性片，不命中 Billionaire、Bloodline、Global；CEO、AI、USA 照样整词命中；LGBT 仍按子串命中 LGBTQ+',
  synHit('bl') === 'gay,les' && synHit('BL') === 'gay,les' && synHit('gl') === 'gay,les' && hit('ceo') === 'a'
    && synHit('ai') === 'ai' && synHit('usa') === 'usa' && synHit('lgbt') === 'gay,les' && synHit('blo') === '' && synHit('bloodline') === 'rich',
  ['bl', 'gl', 'ai', 'usa', 'lgbt', 'blo'].map(synHit).join('|'));
{
  // 「替嫁」「真假千金」是体系的标签名（v1.8.2 的 GENRE_ZH 没收）：卡片中文模式显示它们，就得搜得到
  const lib = [drama('s', { title: 'The Stand-in Bride', genres: ['Substitute Bride', 'Fake Heiress'] }), LIB[1]];
  const ids = q => DramaSearch.searchDramas(lib, q).map(d => d.id).join(',');
  check('M13 中文类型标签体系的标签能搜到（v1.8.12）',
    ids('替嫁') === 's' && ids('真假千金') === 's' && ids('替嫁 狼人') === '', [ids('替嫁'), ids('真假千金')].join('|'));
}
check('M14 GENRE_ZH 已退场（v1.8.13）：体系刻意不收的词（USA）不再经中文「美国」命中，英文原词照样能搜',
  !('GENRE_ZH' in DramaSearch) && !('genresMatchedByZh' in DramaSearch) && synHit('美国') === '' && synHit('usa') === 'usa', synHit('美国'));
{
  // 生成文件随公开仓库发布，体系脚本（build.mjs）只在维护者本地：这里把它的同义词校验再守一遍
  const { ORDER, SYNONYMS, synonymsOf } = globalThis.GenreTaxonomy;
  const tagNames = new Set(ORDER.map(t => t.toLowerCase()));
  const owners = new Map();
  const problems = [];
  for (const [tag, words] of Object.entries(SYNONYMS)) {
    if (!ORDER.includes(tag)) problems.push(`标签不存在：${tag}`);
    for (const word of words) {
      const k = word.toLowerCase();
      if (tagNames.has(k)) problems.push(`和标签名重名：${word}`);
      if (owners.has(k)) problems.push(`重复挂靠：${word}（${owners.get(k)} / ${tag}）`);
      owners.set(k, tag);
    }
  }
  check('M15 genre-taxonomy.js 的 SYNONYMS：挂靠的标签都存在、词不和标签名重名、一个词只挂一个标签；没有同义词的标签得空数组',
    problems.length === 0 && owners.size >= 90 && synonymsOf('同性').includes('耽美') && synonymsOf('狼人').length === 0,
    problems.join(' | ') || String(owners.size));
}

// ============ H 组：卡片高亮与「已退订」标记 ============
// timeline-render 需要的最小 DOM：createElement 出来的节点 textContent 写入时按浏览器口径转义
const escapeLikeBrowser = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fakeNode = () => {
  const node = {
    className: '', dataset: {}, innerHTML: '',
    style: { setProperty() {} },
    classList: { add() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    querySelector() { return null; }
  };
  Object.defineProperty(node, 'textContent', { set(v) { node.innerHTML = escapeLikeBrowser(v); } });
  return node;
};
globalThis.document = { createElement: fakeNode };
// genre-taxonomy 已随 drama-search 的 require 挂上 globalThis（与弹窗里先载它的效果相同）
for (const file of ['icons.js', 'site-registry.js', 'translate-config.js', 'timeline-render.js']) {
  (0, eval)(fs.readFileSync(path.join(root, 'src/shared', file), 'utf8'));
}
const { highlightHtml, createDramaCard, snippetAround } = globalThis.TimelineRender;

check('H1 没有词时等同转义', highlightHtml('<b>&', null) === '&lt;b&gt;&amp;', highlightHtml('<b>&', null));
check('H2 不区分大小写、保留原文大小写', highlightHtml('Revenge of revenge', ['revenge'])
  === '<mark class="search-hit">Revenge</mark> of <mark class="search-hit">revenge</mark>', highlightHtml('Revenge of revenge', ['revenge']));
check('H3 先切段再转义：词「amp」不会命中 & 转出来的实体，原文里的 < 照样转义',
  highlightHtml('A & B <amp>', ['amp']) === 'A &amp; B &lt;<mark class="search-hit">amp</mark>&gt;', highlightHtml('A & B <amp>', ['amp']));
check('H4 正则特殊字符按字面匹配', highlightHtml('C++ (2026)', ['c++', '(2026)'])
  === '<mark class="search-hit">C++</mark> <mark class="search-hit">(2026)</mark>', highlightHtml('C++ (2026)', ['c++', '(2026)']));
check('H5 重叠时长词优先', highlightHtml('复仇之路', ['复仇', '复仇之路']) === '<mark class="search-hit">复仇之路</mark>',
  highlightHtml('复仇之路', ['复仇', '复仇之路']));

const sample = LIB[0];
const plain = createDramaCard(sample, { readOnly: true }).innerHTML;
const marked = createDramaCard(sample, { readOnly: true, highlightTerms: ['复仇', 'imdb'], isUnsubscribed: () => true }).innerHTML;
check('H6 不传搜索选项（共享页 / 平时的弹窗）：卡片里没有高亮也没有「已退订」',
  !plain.includes('search-hit') && !plain.includes('chip-unsubscribed'), '');
check('H7 传了 highlightTerms：标题与标签里的命中词包进 mark',
  marked.includes('总裁的<mark class="search-hit">复仇</mark>') && marked.includes('<mark class="search-hit">IMDB</mark>'), '');
check('H8 isUnsubscribed 为真：标题行多一枚「已退订」', marked.includes('chip-unsubscribed') && marked.includes('>已退订<'), '');
check('H9 title 悬停属性不带 mark 标记', !/title="[^"]*<mark/.test(marked), '');
const searchOpts = terms => ({ readOnly: true, highlightTerms: DramaSearch.parseQuery(terms.join(' ')) });
const card = (d, terms, lang) => createDramaCard(d, { ...searchOpts(terms), ...(lang ? { lang } : {}) }).innerHTML;
const chipsOf = html => [...html.matchAll(/<span class="tag tag-genre">(.*?)<\/span>/g)].map(m => m[1]);
const byZhEn = card(sample, ['总裁'], 'en');
check('H10 英文模式搜同义词「总裁」：Billionaire 归到的「霸总」挂着它，Billionaire 整枚标亮，没命中的不标',
  byZhEn.includes('<mark class="search-hit">Billionaire</mark>') && !byZhEn.includes('<mark class="search-hit">Revenge</mark>'), byZhEn);
const byEnZh = card(sample, ['billionaire']);
check('H11 中文模式搜英文「billionaire」：挂它的中文标签「霸总」整枚标亮，「复仇」不标；只命中标签不改双语',
  byEnZh.includes('<mark class="search-hit">霸总</mark>') && !byEnZh.includes('<mark class="search-hit">复仇</mark>')
    && !byEnZh.includes('card-title-alt') && !byEnZh.includes('is-alt'), '');
const byTag = card(sample, ['总裁']);
check('H12 中文模式搜同义词「总裁」：标签「霸总」整枚标亮，标题里的「总裁」照常标', byTag.includes('<mark class="search-hit">霸总</mark>')
  && byTag.includes('<mark class="search-hit">总裁</mark>的') && !byTag.includes('<mark class="search-hit">复仇</mark>'), '');
const swapped = { ...sample, genres: ['Substitute Bride'] };
const byTaxonomy = card(swapped, ['替嫁'], 'en');
check('H13 英文模式搜体系里的中文标签「替嫁」：归到它的 Substitute Bride 整枚标亮',
  byTaxonomy.includes('<mark class="search-hit">Substitute Bride</mark>'), '');

// ---- 双语搜索卡（v1.8.13）----
const wolf = drama('w', { title: 'Moonlight Pack', titleZh: '月光狼群', description: 'A werewolf alpha falls in love.',
  descriptionZh: '狼人首领坠入爱河。', genres: ['Werewolf'] });
const enHitInZh = card(wolf, ['alpha']);
check('H14 中文模式命中英文简介：卡片改双语——标题下补英文名，中文简介下补英文简介（is-alt），命中处标亮',
  enHitInZh.includes('<div class="card-title-alt" title="Moonlight Pack">Moonlight Pack</div>')
    && enHitInZh.includes('<div class="card-desc" lang="zh-CN">狼人首领坠入爱河。</div>')
    && enHitInZh.includes('<div class="card-desc is-alt" lang="en">A werewolf <mark class="search-hit">alpha</mark> falls in love.</div>'), enHitInZh);
const zhHitInZh = card(wolf, ['首领']);
check('H15 命中的就在当前语言里：不改双语', !zhHitInZh.includes('card-title-alt') && !zhHitInZh.includes('is-alt')
  && zhHitInZh.includes('狼人<mark class="search-hit">首领</mark>'), zhHitInZh);
const zhHitInEn = card(wolf, ['月光'], 'en');
check('H16 英文模式命中中文标题：补中文名一行，另一段是中文简介（lang=zh-CN）',
  zhHitInEn.includes('<mark class="search-hit">月光</mark>狼群</div>') && zhHitInEn.includes('class="card-title-alt"')
    && zhHitInEn.includes('<div class="card-desc is-alt" lang="zh-CN">狼人首领坠入爱河。</div>'), zhHitInEn);
check('H17 不在搜索态：永远单语（共享页、平时的弹窗）',
  !createDramaCard(wolf, { readOnly: true }).innerHTML.includes('is-alt') && !createDramaCard(wolf, { readOnly: true, lang: 'en' }).innerHTML.includes('card-title-alt'), '');

{
  const filler = 'Before anything else happens in this long story there is a great deal of setup to read through ';
  const long = `${filler}and then the twist arrives when the alpha returns home.`;
  const cut = snippetAround(long, ['alpha']);
  const zhLong = `${'很长的铺垫'.repeat(12)}，最后他终于完成了复仇。`;
  const zhCut = snippetAround(zhLong, ['复仇']);
  check('H18 长简介的命中处在两行之后：从命中处附近开始显示（前面加「…」、英文从词首开始）；命中在开头的不动',
    cut.startsWith('…') && cut.includes('alpha') && !cut.startsWith('… ') && long.includes(cut.slice(1)) && /^…\w/.test(cut)
      && cut.length < long.length - 40 && zhCut.startsWith('…') && zhCut.includes('复仇') && zhCut.length <= 1 + 15 + 9
      && snippetAround('Short alpha text.', ['alpha']) === 'Short alpha text.' && snippetAround(long, []) === long,
    JSON.stringify([cut, zhCut]));
  const longCard = card({ ...wolf, description: long }, ['alpha']);
  check('H18b 双语卡里的另一段简介同样从命中处开始', longCard.includes('<div class="card-desc is-alt" lang="en">…') && longCard.includes('<mark class="search-hit">alpha</mark>'), longCard);
}

{
  const ward = drama('h', { title: 'Night Shift', titleZh: '夜班', genres: ['Werewolf', 'Hospital'] });
  const zhChips = chipsOf(card(ward, ['hospital']));
  check('H19 中文模式命中体系不收的英文标签（Hospital，平时中文模式不显示）：补成英文标签并标亮，排在最前',
    JSON.stringify(zhChips) === JSON.stringify(['<mark class="search-hit">Hospital</mark>', '狼人']), JSON.stringify(zhChips));
  const actor = drama('r', { title: 'Cold Heir', genres: ['Revenge', 'Aaron Russell'] });
  const enChips = chipsOf(card(actor, ['russell'], 'en'));
  check('H19b 英文模式命中演员名（平时滤掉）：补成标签显示；不搜时照旧不显示演员名',
    enChips.includes('Aaron <mark class="search-hit">Russell</mark>')
      && !chipsOf(createDramaCard(actor, { readOnly: true, lang: 'en' }).innerHTML).some(c => c.includes('Russell')), JSON.stringify(enChips));
  const many = drama('m', { title: 'X', genres: ['Werewolf', 'Revenge', 'Billionaire'] });
  const ordered = chipsOf(card(many, ['总裁']));
  check('H20 搜索时命中的标签排最前（右槽只显示一行，排后面会被裁掉）；不搜时按体系顺序',
    ordered[0] === '<mark class="search-hit">霸总</mark>' && ordered.slice(1).join() === '狼人,复仇'
      && chipsOf(createDramaCard(many, { readOnly: true }).innerHTML).join() === '狼人,复仇,霸总', JSON.stringify(ordered));
}
check('H21 短英文词整词标亮：搜 bl 只标独立的 BL，不标 Billionaire 里的那一截',
  highlightHtml('Billionaire BL romance', ['bl']) === 'Billionaire <mark class="search-hit">BL</mark> romance',
  highlightHtml('Billionaire BL romance', ['bl']));

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
