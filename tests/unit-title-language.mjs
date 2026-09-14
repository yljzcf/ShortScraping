import './bootstrap.cjs';
// 中文译名语言守卫单测（v1.6.2）。覆盖两件事：
//
// 1) Steam 官方中文采用判据（content.js fetchSteamDetail）
//    appdetails?l=schinese 在开发商没做简体中文本地化时，返回的是**开发商母语**
//    的名字。2026-09-14 逐条实测：
//      4719560 Escape! House of Bonds → 탈출! 인연의 집（韩）
//      4882320 QuietCorner           → 조용한구석（韩）
//      4038390 Cherry blossom        → Сакура（俄）
//      5046990 The Mansion of…       → La mansión de Campanillas（西）
//      4840230 The Shadows of…       → Les Ombres de Dry Creek（法）
//    旧判据只查「与英文不同」，这些一律通过，卡片上就出现了韩语标题。
//    新判据加一条「必须含汉字」。L6 是**防过度拒收**的反向守卫：合法中文里
//    的 の / ー / ・ 不能被当成日语误杀。
//
// 2) 标题冗余折叠（timeline-render.js titleDisplay）
//    中文开发商的 Steam **英文档**名本身就是中文，AI 原样返回 → titleZh === title，
//    旧写法渲染成「骷髅传奇（骷髅传奇）」（全库 70 条）。
//
// fixture 全部内嵌、零网络。用法：node tests/unit-title-language.mjs
import fs from 'node:fs';

const contentSrc = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const registrySrc = fs.readFileSync(new URL('../src/shared/site-registry.js', import.meta.url), 'utf8');
(0, eval)(registrySrc);
(0, eval)(fs.readFileSync(new URL('../src/shared/timeline-render.js', import.meta.url), 'utf8'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// 压掉内容脚本日志噪音
const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

const fakeElement = () => ({ style: {}, disabled: false, innerHTML: '', addEventListener() {}, querySelector() { return null; } });
const baseDocument = () => ({
  getElementById() { return null; },
  createElement() { return fakeElement(); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: { appendChild() {} }
});

const STEAM_URL = 'https://store.steampowered.com/category/visual_novel?flavor=contenthub_newandtrending';

/**
 * 跑一轮 Steam 抓取：装桩 appdetails 的英文档与中文档 → eval 真实 content.js →
 * 派发 'scrape' → 返回入库的那张卡。
 */
async function steamScenario({ appId = '111222', en, zh }) {
  const store = { dramas: [] };
  const listeners = [];
  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          await Promise.resolve();
          return { dramas: structuredClone(store.dramas), urlTags: [{ urlPattern: STEAM_URL, tags: ['Steam', '视觉小说'] }] };
        }
      }
    },
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      async sendMessage(message) {
        await Promise.resolve();
        if (message?.action === 'saveDrama') {
          store.dramas.push(structuredClone(message.drama));
          return { success: true, saved: true };
        }
        return { success: true };
      }
    }
  };
  globalThis.window = { location: { href: STEAM_URL, hostname: 'store.steampowered.com', pathname: '/category/visual_novel', search: '?flavor=contenthub_newandtrending' } };
  globalThis.document = baseDocument();
  globalThis.DOMParser = class { parseFromString() { return baseDocument(); } };
  globalThis.fetch = async (url) => {
    if (url.includes('ajaxgetsaledynamicappquery')) {
      return { ok: true, url, json: async () => ({ appids: [Number(appId)] }) };
    }
    if (url.includes(`appdetails?appids=${appId}&l=english`)) {
      return { ok: true, url, json: async () => ({ [appId]: { success: true, data: en } }) };
    }
    if (url.includes(`appdetails?appids=${appId}&l=schinese`)) {
      return zh
        ? { ok: true, url, json: async () => ({ [appId]: { success: true, data: zh } }) }
        : { ok: true, url, json: async () => ({ [appId]: { success: false } }) };
    }
    return { ok: false, url };
  };

  (0, eval)(contentSrc);
  await new Promise(resolve => {
    for (const fn of listeners) fn({ action: 'scrape' }, { tab: { id: 1 } }, resolve);
  });
  return store.dramas[0];
}

const EN_DESC = 'An escape-room adventure.';
const enOf = (name, short = EN_DESC) => ({ name, short_description: short, genres: [{ description: 'Indie' }] });

// ---------- L 组：Steam 官方中文采用判据 ----------

// L1 韩语名（4719560 真实形态：中文档 name 是韩语、简介仍是英文）
const l1 = await steamScenario({
  en: enOf('Escape! House of Bonds'),
  zh: { name: '탈출! 인연의 집', short_description: EN_DESC }
});
check('L1 韩语 schinese 名不得当成中文译名（4719560 真实形态）',
  l1?.titleZh === '' && l1?.status === 'new' && l1?.title === 'Escape! House of Bonds',
  JSON.stringify({ titleZh: l1?.titleZh, status: l1?.status }));

// L2 西里尔（4038390 Cherry blossom → Сакура）
const l2 = await steamScenario({
  en: enOf('Cherry blossom'),
  zh: { name: 'Сакура', short_description: EN_DESC }
});
check('L2 西里尔 schinese 名拒收', l2?.titleZh === '' && l2?.status === 'new', JSON.stringify({ titleZh: l2?.titleZh }));

// L3 纯假名日语（5036620 Mashumaro Trigger!）
const l3 = await steamScenario({
  en: enOf('Mashumaro Trigger!'),
  zh: { name: 'ましゅまろトリガー！', short_description: EN_DESC }
});
check('L3 纯假名 schinese 名拒收', l3?.titleZh === '' && l3?.status === 'new', JSON.stringify({ titleZh: l3?.titleZh }));

// L4 拉丁系外语（5046990 西语 / 4840230 法语）——语种黑名单抓不到，只有「必须含汉字」能拦
const l4 = await steamScenario({
  en: enOf('The Mansion of Campanillas'),
  zh: { name: 'La mansión de Campanillas', short_description: EN_DESC }
});
check('L4 拉丁系外语 schinese 名拒收（黑名单式判据抓不到）',
  l4?.titleZh === '' && l4?.status === 'new', JSON.stringify({ titleZh: l4?.titleZh }));

// L5 真官方中文齐全 → 照常采用并标 trans（不能误伤正常路径）
const l5 = await steamScenario({
  en: enOf('Yandere Virus', 'An online co-op horror game.'),
  zh: { name: '病娇病毒', short_description: '最多支持 4 人一起游玩的在线合作恐怖游戏。' }
});
check('L5 真中文齐全照常采用并标 trans',
  l5?.titleZh === '病娇病毒' && l5?.descriptionZh === '最多支持 4 人一起游玩的在线合作恐怖游戏。' && l5?.status === 'trans',
  JSON.stringify({ titleZh: l5?.titleZh, status: l5?.status }));

// L6 反向守卫：合法中文里的 の / ー / ・ 不得被误杀（全库实测三例）
for (const [i, name] of [['a', '伪娘与扶她の陷阱屋'], ['b', '人间牧场ー搜查篇ー'], ['c', '新約・怒首領蜂大復活']]) {
  const l6 = await steamScenario({ en: enOf('X'), zh: { name, short_description: '中文简介。' } });
  check(`L6${i} 汉字＋の/ー/・ 混排必须保留：${name}`, l6?.titleZh === name, JSON.stringify({ titleZh: l6?.titleZh }));
}

// L7 简介同守卫：中文档简介是外语 → descriptionZh 不采用
const l7 = await steamScenario({
  en: enOf('Some Game'),
  zh: { name: '某游戏', short_description: '탈출 게임입니다. 방을 탈출하세요.' }
});
check('L7 外语 schinese 简介拒收（同一条缺陷路径）',
  l7?.titleZh === '某游戏' && l7?.descriptionZh === '' && l7?.status === 'new',
  JSON.stringify({ titleZh: l7?.titleZh, descriptionZh: l7?.descriptionZh, status: l7?.status }));

// L8 v1.5.14 半成品语义不回退：官方中文名有、简介缺 → 仍留 new 等翻译线补
const l8 = await steamScenario({
  en: enOf('Half Localized'),
  zh: { name: '半本地化', short_description: EN_DESC }
});
check('L8 官方中文只有一半仍留 new（v1.5.14 语义不回退）',
  l8?.titleZh === '半本地化' && l8?.descriptionZh === '' && l8?.status === 'new',
  JSON.stringify({ titleZh: l8?.titleZh, status: l8?.status }));

// L9 中文档无数据（success:false）→ 全走 AI
const l9 = await steamScenario({ en: enOf('No Chinese Store'), zh: null });
check('L9 中文档无数据时留 new', l9?.titleZh === '' && l9?.status === 'new', JSON.stringify({ titleZh: l9?.titleZh }));

// ---------- R 组：标题冗余折叠 ----------
// 取不到函数时返回哨兵而不是抛异常：RED 阶段要看到逐条 FAIL，不要整套崩掉
const td = (drama) => (typeof globalThis.TimelineRender?.titleDisplay === 'function'
  ? globalThis.TimelineRender.titleDisplay(drama)
  : '(titleDisplay 未导出)');

check('R1 中英不同 → 保留「中文（英文）」',
  td({ titleZh: '病娇病毒', title: 'Yandere Virus' }) === '病娇病毒（Yandere Virus）',
  td({ titleZh: '病娇病毒', title: 'Yandere Virus' }));

check('R2 完全同名 → 只显示一次（全库 70 条）',
  td({ titleZh: '骷髅传奇', title: '骷髅传奇' }) === '骷髅传奇',
  td({ titleZh: '骷髅传奇', title: '骷髅传奇' }));

check('R3 仅装饰性标点/大小写之差 → 视作同名',
  td({ titleZh: '《NBA 2K27》', title: 'NBA 2K27' }) === '《NBA 2K27》'
  && td({ titleZh: 'B 2', title: 'b 2' }) === 'B 2'
  && td({ titleZh: 'EA SPORTS™《Madden NFL 27》', title: 'EA SPORTS™ Madden NFL 27' }) === 'EA SPORTS™《Madden NFL 27》',
  JSON.stringify([td({ titleZh: '《NBA 2K27》', title: 'NBA 2K27' }), td({ titleZh: 'B 2', title: 'b 2' })]));

check('R4 titleZh 为空/纯空白 → 显示英文原名',
  td({ titleZh: '', title: 'Solo English' }) === 'Solo English'
  && td({ titleZh: '   ', title: 'Solo English' }) === 'Solo English'
  && td({ title: 'Solo English' }) === 'Solo English',
  JSON.stringify([td({ titleZh: '', title: 'Solo English' }), td({ titleZh: '   ', title: 'Solo English' })]));

check('R5 不同中文名不得被标点归一误判为同名',
  td({ titleZh: '交叠之夏', title: '交错之夏' }) === '交叠之夏（交错之夏）',
  td({ titleZh: '交叠之夏', title: '交错之夏' }));

// 三个消费方（卡片 / 多维表格 payload / 群机器人卡片）必须是同一份实现，不许漂移
check('R6 timeline-render 的 titleDisplay 就是 translate-config 那一份',
  globalThis.TimelineRender.titleDisplay === globalThis.TranslateConfig.titleDisplay, '');

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
