/**
 * 弹窗搜索（v1.8.2）的匹配判据：纯函数，不碰 DOM / chrome.*，弹窗与单测共用。
 *
 * - 可搜字段：title / titleZh / description / descriptionZh / tags / genres，
 *   外加 genres 经 GENRE_ZH 对照出的中文同义词（站点的 genres 只有英文，中文搜「复仇」
 *   靠这份对照命中 Revenge）。对照只用于匹配，卡片上仍显示站点原始英文。
 * - 归一：NFKC（全角字母数字、全角空格转半角）+ 小写；查询按空白切词、全部命中（AND）。
 * - 子串匹配：「总裁」命中「霸道总裁」。各字段之间用不可见分隔符拼接，
 *   词不会跨字段拼凑命中。
 * - 排序不在这里管：结果交给 TimelineRender.renderTimeline 按入库日期分组。
 */
(function (global) {
  'use strict';

  // 英文题材（小写）→ 中文同义词（空格分隔，任一子串命中即可）。
  // 初稿按 2026-10-20 全库 genres 出现次数前 ~150 名整理，覆盖全部出现次数约八成；
  // 新题材没收录只是中文搜不到它，英文照样能搜
  const GENRE_ZH = Object.freeze({
    'romance': '爱情 言情 恋爱',
    'drama': '剧情',
    'dramas': '剧情',
    'fantasy': '奇幻 玄幻',
    'action': '动作',
    'adventure': '冒险',
    'progression': '升级 成长',
    'revenge': '复仇 报仇',
    'billionaire': '亿万富翁 霸总 豪门 总裁',
    'billionaire/ceo': '亿万富翁 霸总 霸道总裁 豪门',
    'ceo': '总裁 霸总 霸道总裁',
    'all ages': '全年龄',
    'male lead': '男主 男频',
    'male': '男频 男主',
    'female': '女频 女主',
    'female lead': '女主 女频',
    'strong lead': '强主角 大女主 大男主',
    'strong female lead': '大女主 强女主',
    'magic': '魔法',
    'modern': '现代 都市',
    'contemporary': '现代 当代 都市',
    'urban': '都市',
    'urban fantasy': '都市奇幻 都市异能',
    'litrpg': '游戏 数据流',
    'gamelit': '游戏',
    'high fantasy': '奇幻 西幻',
    'low fantasy': '奇幻',
    'hidden identity': '隐藏身份 隐藏大佬 马甲',
    'secret identity': '隐藏身份 马甲',
    'multiple identities': '多重身份 马甲',
    'mistaken identity': '认错人 错认身份',
    'identity reveal': '身份曝光 掉马 揭露身份',
    'karma payback': '打脸 报应 因果',
    'karma': '报应 因果',
    'portal fantasy / isekai': '穿越 异世界',
    'time travel': '穿越 时间旅行',
    'mystery': '悬疑 推理',
    'comedy': '喜剧 搞笑',
    'comedies': '喜剧 搞笑',
    'reincarnation': '重生 转生',
    'rebirth': '重生',
    'second chance': '重来 第二次机会 重生',
    'slice of life': '日常 生活',
    'love triangle': '三角恋',
    'supernatural': '超自然 灵异',
    'paranormal': '超自然 灵异',
    'underdog rise': '逆袭 废柴',
    'counterattack': '逆袭 反击 反杀',
    'glow-up': '逆袭 蜕变',
    'usa': '美国 美剧',
    'mafia': '黑帮 黑手党',
    'secret reveal': '秘密 揭秘',
    'secret': '秘密',
    'strategy': '策略 谋略',
    'thriller': '惊悚',
    'thrillers': '惊悚',
    'misunderstanding': '误会',
    'all-too-late': '追妻火葬场 追悔莫及',
    'feel-good': '治愈 温馨',
    'heartfelt': '温情 治愈',
    'anti-hero lead': '反派主角 反英雄',
    'survival': '生存 求生',
    'sweet romance': '甜宠 甜文',
    'short': '短篇',
    'enemies to lovers': '欢喜冤家 相爱相杀',
    'love-hate': '相爱相杀 欢喜冤家',
    'kingdom building': '建国 种田 基建',
    'werewolf': '狼人',
    'strong-willed': '倔强 坚强',
    'romance subplot': '感情线',
    'war and military': '战争 军事',
    'romantic': '浪漫 爱情',
    'betrayal': '背叛',
    'cultivation': '修仙 修真 修炼',
    'martial arts': '武侠 武术 功夫',
    'modern knowledge': '现代知识',
    'ruling class': '权贵 统治阶层 豪门',
    'love after marriage': '先婚后爱',
    'mansion': '豪宅 豪门',
    'villa': '别墅 豪宅',
    'hidden feelings': '暗恋',
    'forbidden love': '禁忌之恋 禁恋',
    'taboo': '禁忌',
    'getting back at ex': '报复前任 虐渣',
    'school life': '校园',
    'campus': '校园',
    'student': '学生 校园',
    'hooking-up': '一夜情',
    'one night stand': '一夜情',
    'magitech': '魔导科技',
    'psychological': '心理',
    'multiple lead characters': '多主角 群像',
    'sci-fi': '科幻',
    'soft sci-fi': '科幻',
    'redemption': '救赎',
    'non-human lead': '非人类主角',
    'dark romance': '虐恋 暗黑',
    'toxic relationship': '虐恋 有毒关系',
    'self-growth': '成长',
    'emotional': '情感',
    'independent woman': '独立女性 大女主',
    'mythos': '神话',
    'attractive lead': '颜值',
    'local protagonist': '土著主角',
    'crafting': '制作 打造',
    'pregnancy': '怀孕 带球跑 萌宝',
    'action romance': '动作 爱情',
    'grimdark': '黑暗',
    'love after divorce': '离婚后 追妻',
    'divorce': '离婚',
    'heiress/socialite': '千金 名媛 豪门',
    'contract lovers': '契约恋人',
    'contract marriage': '契约婚姻',
    'contract': '契约',
    'flash marriage': '闪婚',
    'marriage': '婚姻',
    'fake relationship': '假戏真做 假扮情侣',
    'playing dumb': '扮猪吃虎 装傻',
    'possessive': '占有欲 强取豪夺',
    'possessive love': '占有欲 强取豪夺',
    'protective husband': '宠妻 护妻',
    'young adult': '青春',
    'age gap': '年龄差',
    'office': '职场 办公室',
    'dungeon crawler': '地下城 副本',
    'apocalypse': '末日 末世',
    'post apocalyptic': '末日 末世 废土',
    'system invasion': '系统',
    'family': '家庭',
    'dysfunctional-family': '原生家庭 家庭矛盾',
    'caught cheating': '出轨 捉奸',
    'hospital': '医院 医生',
    'horror': '恐怖',
    'bullying': '霸凌',
    'morals & ethics': '伦理',
    'fated lovers': '命中注定',
    'competition': '比赛 竞技',
    'banquet': '宴会',
    'sabotaging': '陷害',
    'lesbian romance': '百合 女同',
    'modern romance': '现代言情 都市爱情',
    'multiple lovers': '多角恋',
    'plot twist': '反转',
    'the chosen one': '天选之子',
    'super power': '超能力 异能',
    'super heroes': '超级英雄',
    'first love': '初恋'
  });

  // 字段之间的分隔符：不可见、查询里打不出来，词不会跨字段拼出命中
  const SEP = '\u0001';

  function normalize(text) {
    return String(text == null ? '' : text).normalize('NFKC').toLowerCase();
  }

  /** 查询 → 归一后的词表（按空白切、去空、去重）；空查询得 []。 */
  function parseQuery(query) {
    return [...new Set(normalize(query).split(/\s+/).filter(Boolean))];
  }

  function stringList(value) {
    return Array.isArray(value) ? value.map(v => String(v == null ? '' : v).trim()).filter(Boolean) : [];
  }

  /** 一部剧可被搜到的全部文本（已归一，字段间用 SEP 隔开）。 */
  function haystackOf(drama) {
    const genres = stringList(drama.genres);
    const genreZh = genres.map(g => GENRE_ZH[g.toLowerCase()]).filter(Boolean);
    return normalize([
      drama.title, drama.titleZh, drama.description, drama.descriptionZh,
      ...stringList(drama.tags), ...genres, ...genreZh
    ].filter(v => v != null && v !== '').join(SEP));
  }

  /** terms 为 parseQuery 的结果；空词表不算命中（没有查询就没有结果）。 */
  function matchDrama(drama, terms) {
    if (!drama || typeof drama !== 'object' || !terms || terms.length === 0) return false;
    const haystack = haystackOf(drama);
    return terms.every(term => haystack.includes(term));
  }

  /**
   * 经中文对照命中的英文题材（小写）。卡片上题材只显示英文，搜「复仇」时把 Revenge 整枚标亮，
   * 用户才看得出这部为什么被搜出来。
   */
  function genresMatchedByZh(terms) {
    const list = Array.isArray(terms) ? terms : [];
    return Object.keys(GENRE_ZH).filter(genre => list.some(term => normalize(GENRE_ZH[genre]).includes(term)));
  }

  /** 从 dramas 里挑出命中 query 的条目，保持原顺序；空查询得 []。 */
  function searchDramas(dramas, query) {
    const terms = parseQuery(query);
    if (terms.length === 0 || !Array.isArray(dramas)) return [];
    return dramas.filter(drama => matchDrama(drama, terms));
  }

  const api = { GENRE_ZH, normalize, parseQuery, matchDrama, searchDramas, genresMatchedByZh };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DramaSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
