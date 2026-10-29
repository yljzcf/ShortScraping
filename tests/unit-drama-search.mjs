import './bootstrap.cjs';
// 弹窗搜索（v1.8.2）的匹配判据与卡片高亮。
//
//   M 组：shared/drama-search.js——归一（大小写、全角）、多词 AND、各字段命中、题材中文对照、
//         字段之间不拼凑命中、空查询与脏条目；v1.8.12 起中文类型标签体系的标签也能搜（M13）
//   H 组：timeline-render.js——highlightHtml 先切段再转义（词不命中 HTML 实体）、长词优先；
//         createDramaCard 的 highlightTerms / isUnsubscribed 选项（共享页不传时输出不变）；
//         v1.8.12 起标签整枚标亮跨语言（中文模式看英文原标签、英文模式看归到的中文标签，H10-H13）
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
check('M5 题材中文对照：「狼人」命中 Werewolf，「霸总」命中 Billionaire，「校园」命中 School Life',
  hit('狼人') === 'b' && hit('霸总') === 'a' && hit('校园') === 'c', [hit('狼人'), hit('霸总'), hit('校园')].join('|'));
check('M6 子串命中：对照写的是「霸道总裁」，搜其中一截「道总」也命中', DramaSearch.searchDramas(
  [drama('x', { genres: ['Billionaire/CEO'] })], '道总').length === 1, '');
check('M7 字段之间不拼凑命中：标题末尾 + 标签开头凑不出一个词',
  DramaSearch.searchDramas([drama('y', { title: 'Plai', tags: ['n'] })], 'plain').length === 0, '');
check('M8 空查询 / 纯空白没有结果', hit('') === '' && hit('   ') === '', '');
check('M9 脏条目（null、缺字段、genres 不是数组）不炸、不命中',
  DramaSearch.searchDramas([null, 'x', { id: 'z' }, { id: 'w', genres: 'Revenge' }], 'revenge').length === 0, '');
check('M10 parseQuery 去重、去空', JSON.stringify(DramaSearch.parseQuery(' A  a b ')) === '["a","b"]',
  JSON.stringify(DramaSearch.parseQuery(' A  a b ')));
check('M11 对照表的键都是小写（匹配时按小写查）',
  Object.keys(DramaSearch.GENRE_ZH).every(k => k === k.toLowerCase()), '');
{
  // 「替嫁」「真假千金」只在中文类型标签体系里有，GENRE_ZH 的同义词里没有：卡片中文模式显示它们，就得搜得到
  const synonyms = Object.values(DramaSearch.GENRE_ZH).join(' ');
  const lib = [drama('s', { title: 'The Stand-in Bride', genres: ['Substitute Bride', 'Fake Heiress'] }), LIB[1]];
  const ids = q => DramaSearch.searchDramas(lib, q).map(d => d.id).join(',');
  check('M13 中文类型标签体系的标签能搜到（v1.8.12，GENRE_ZH 没收的「替嫁」「真假千金」）',
    !synonyms.includes('替嫁') && !synonyms.includes('真假千金') && ids('替嫁') === 's' && ids('真假千金') === 's' && ids('替嫁 狼人') === '',
    [ids('替嫁'), ids('真假千金')].join('|'));
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
const { highlightHtml, createDramaCard } = globalThis.TimelineRender;

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
const searchOpts = terms => ({ readOnly: true, highlightTerms: terms, highlightGenres: DramaSearch.genresMatchedByZh(terms) });
const byZhEn = createDramaCard(sample, { ...searchOpts(['霸总']), lang: 'en' }).innerHTML;
check('H10 英文模式：经中文对照命中的题材整枚标亮（搜「霸总」→ Billionaire），没命中的题材不标',
  byZhEn.includes('<mark class="search-hit">Billionaire</mark>') && !byZhEn.includes('<mark class="search-hit">Revenge</mark>'), '');
const byEnZh = createDramaCard(sample, searchOpts(['billionaire'])).innerHTML;
check('H11 中文模式搜英文「billionaire」：挂它的中文标签「霸总」整枚标亮，「复仇」不标',
  byEnZh.includes('<mark class="search-hit">霸总</mark>') && !byEnZh.includes('<mark class="search-hit">复仇</mark>'), '');
const byTag = createDramaCard(sample, searchOpts(['霸总'])).innerHTML;
check('H12 中文模式搜中文标签本身「霸总」：整枚标亮', byTag.includes('<mark class="search-hit">霸总</mark>')
  && !byTag.includes('<mark class="search-hit">复仇</mark>'), '');
const swapped = { ...sample, genres: ['Substitute Bride'] };
const byTaxonomy = createDramaCard(swapped, { ...searchOpts(['替嫁']), lang: 'en' }).innerHTML;
check('H13 英文模式搜体系里的中文标签「替嫁」：归到它的 Substitute Bride 整枚标亮（GENRE_ZH 没收这个词）',
  byTaxonomy.includes('<mark class="search-hit">Substitute Bride</mark>'), '');
check('M12 genresMatchedByZh：按对照的中文同义词反查英文题材',
  DramaSearch.genresMatchedByZh(['狼人']).join() === 'werewolf' && DramaSearch.genresMatchedByZh(['nothing']).length === 0,
  DramaSearch.genresMatchedByZh(['狼人']).join());

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
