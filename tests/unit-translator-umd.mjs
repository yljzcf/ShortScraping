// translator.js 的 UMD 外壳与配置注入（v1.6.20）。
//
// 起因：translator.js 原是 `globalThis.Translator = (() => {…})()`，依赖隐式全局 TranslateConfig，
// 每次调用用回调形式的 storage.get 自读 translateConfig——Node 里 require 不了，测试 eval 真实
// 模块得给 storage 桩垫一层回调；一轮翻译按开头快照选定 AI / API 模式后，中途改配置还会让
// translateBatchAI 落进它自己的逐条分支，与后台这一轮的分支对不上。
//
// 契约：
//   U 组（模块本身）：Node 里 require 成功并导出两个方法；源码不含 `chrome.`；TranslateConfig 经
//     require 解析（不靠全局）；缺配置参数直接 reject、不发请求（不落回默认的 MyMemory）；
//     translateBatchAI 的非 AI 分支把同一份配置传给逐条翻译。
//   G 组（源码守卫）：background.js 每处 Translator.* 调用都带尾参配置，且该配置现读自
//     readTranslateConfig（或包着它的每批读取）。
//   B 组（后台行为，background-fixture + Translator 桩）：每批开头重读配置并传入；读到的模式与
//     本轮不同则本轮提前结束、不报错；API 逐条与单卡 🌍 同样传入现读的配置。
// 用法：node tests/unit-translator-umd.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { background, card } from './background-fixture.mjs';

const require = createRequire(import.meta.url);
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const readSource = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

let unhandledCount = 0;
process.on('unhandledRejection', (e) => { unhandledCount++; console.error('UNHANDLED:', e?.message || e); });

const origLog = console.log, origWarn = console.warn;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };

// ============ U 组：模块本身（Node require） ============
{
  // background-fixture 经 bootstrap.cjs 预载过 translate-config（主 realm 全局已有 TranslateConfig）。
  // 先摘掉全局再 require：translator 若仍靠 global.TranslateConfig，下面归一化时就会抛错
  const savedTranslateConfig = globalThis.TranslateConfig;
  const savedFetch = globalThis.fetch;
  delete globalThis.TranslateConfig;
  let T = null;
  let loadError = null;
  try { T = require('../src/shared/translator.js'); } catch (e) { loadError = e; }
  const loaded = !loadError && typeof T?.translateTitleAndDesc === 'function' && typeof T?.translateBatchAI === 'function';
  check('U1 Node 里 require 成功，导出 translateTitleAndDesc / translateBatchAI', loaded,
    loadError ? String(loadError.message) : JSON.stringify(Object.keys(T || {})));

  const translatorSrc = readSource('../src/shared/translator.js');
  check('U2 translator.js 源码不含 chrome.（配置全靠调用方注入）', !translatorSrc.includes('chrome.'),
    (translatorSrc.match(/.*chrome\..*/g) || []).join(' | '));

  const fetchLog = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchLog.push({ url: String(url), method: options.method || 'GET', auth: options.headers?.Authorization || '' });
    if (options.method === 'POST') {
      const content = JSON.stringify([{ id: 1, 片名: '甲', 简介: '甲简介' }, { id: 2, 片名: '乙', 简介: '' }]);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    }
    const q = new URL(url).searchParams.get('q');
    return { ok: true, status: 200, json: async () => ({ responseStatus: 200, responseData: { translatedText: `译:${q}` } }) };
  };

  if (!loaded) {
    // 模块没导出（旧的无 module.exports 写法）：下面三项照样记 FAIL，check 名单保持不变
    for (const name of ['U3 TranslateConfig 经 require 解析（全局摘掉仍能归一化：旧字段 mode:ai 走批量 AI 请求）',
      'U4 缺配置参数直接 reject、不发请求（不落回默认的 MyMemory）',
      'U5 translateBatchAI 非 AI 分支把注入的配置传给逐条翻译（请求打到注入的 apiEndpoint）']) check(name, false, '模块未能 require');
  } else {
    // 旧字段 mode:'ai' 只有经 TranslateConfig.normalizeConfig 才会认成 AI 模式
    let aiOut = null;
    let aiError = null;
    try {
      aiOut = await T.translateBatchAI([{ title: 'A', desc: 'a' }, { title: 'B', desc: '' }],
        { mode: 'ai', aiEndpoint: 'https://ai.test/v1/chat', aiApiKey: 'k-umd', requestTimeoutSec: 5 });
    } catch (e) { aiError = e; }
    check('U3 TranslateConfig 经 require 解析（全局摘掉仍能归一化：旧字段 mode:ai 走批量 AI 请求）',
      !aiError && fetchLog.length === 1 && fetchLog[0].url === 'https://ai.test/v1/chat' && fetchLog[0].method === 'POST'
        && fetchLog[0].auth === 'Bearer k-umd' && aiOut?.[0]?.title === '甲' && aiOut?.[1]?.title === '乙',
      JSON.stringify({ error: aiError?.message, fetchLog, aiOut }));

    fetchLog.length = 0;
    const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
    const e1 = await rejects(() => T.translateBatchAI([{ title: 'A', desc: '' }]));
    const e2 = await rejects(() => T.translateTitleAndDesc('A', 'B'));
    check('U4 缺配置参数直接 reject、不发请求（不落回默认的 MyMemory）',
      e1 instanceof TypeError && e2 instanceof TypeError && String(e1.message).includes('配置') && fetchLog.length === 0,
      JSON.stringify({ e1: e1?.message, e2: e2?.message, fetchLog }));

    fetchLog.length = 0;
    const apiOut = await T.translateBatchAI([{ title: 'A', desc: '' }, { title: 'B', desc: '' }],
      { translateMode: 'api', apiEndpoint: 'https://mt.test/get', requestTimeoutSec: 5 });
    check('U5 translateBatchAI 非 AI 分支把注入的配置传给逐条翻译（请求打到注入的 apiEndpoint）',
      fetchLog.length === 2 && fetchLog.every(f => f.url.startsWith('https://mt.test/get?'))
        && apiOut?.[0]?.title === '译:A' && apiOut?.[1]?.title === '译:B',
      JSON.stringify({ fetchLog, apiOut }));
  }

  globalThis.fetch = savedFetch;
  globalThis.TranslateConfig = savedTranslateConfig;
}

// ============ G 组：background.js 调用点源码守卫 ============
{
  const bgSrc = readSource('../src/background/background.js');
  const EXPECTED_ARITY = { translateBatchAI: 2, translateTitleAndDesc: 3 };

  // 从 '(' 起切出顶层实参（跳过字符串与嵌套括号），返回实参文本数组
  const callArgs = (src, openIndex) => {
    const args = [];
    let depth = 0;
    let start = openIndex + 1;
    for (let i = openIndex; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
        continue;
      }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) {
        depth--;
        if (depth === 0) {
          const last = src.slice(start, i).trim();
          if (last || args.length) args.push(last);
          return args;
        }
      } else if (ch === ',' && depth === 1) {
        args.push(src.slice(start, i).trim());
        start = i + 1;
      }
    }
    return null;
  };

  const sites = [];
  for (const m of bgSrc.matchAll(/\bTranslator\.(translateBatchAI|translateTitleAndDesc)\s*\(/g)) {
    const lineStart = bgSrc.lastIndexOf('\n', m.index) + 1;
    const lineHead = bgSrc.slice(lineStart, m.index).trim();
    if (lineHead.startsWith('//') || lineHead.startsWith('*')) continue; // 注释里的提及不算调用点
    const line = bgSrc.slice(0, m.index).split('\n').length;
    sites.push({ index: m.index, line, method: m[1], args: callArgs(bgSrc, m.index + m[0].length - 1) });
  }
  const bad = sites.filter(s => !s.args || s.args.length !== EXPECTED_ARITY[s.method]
    || !/^[A-Za-z_$][\w$]*$/.test(s.args[s.args.length - 1]));
  check('G1 background.js 每处 Translator.* 调用都带尾参配置（batch 2 参、单条 3 参）',
    sites.some(s => s.method === 'translateBatchAI') && sites.some(s => s.method === 'translateTitleAndDesc') && bad.length === 0,
    JSON.stringify({ sites: sites.length, bad }));

  // 尾参须现读：调用点之前最近一次声明该变量时，绑定自 readTranslateConfig()，或绑定自一个内部
  // 调用 readTranslateConfig() 的读取函数（按最近声明找，同名的 config 在别的函数里现读不算数）
  const staleness = [];
  for (const site of sites) {
    const id = site.args?.[site.args.length - 1];
    if (!id) continue;
    const decls = [...bgSrc.slice(0, site.index).matchAll(new RegExp(`(?:const|let)\\s+${id}\\s*=\\s*([^;\\n]*)`, 'g'))];
    const bind = decls.length ? decls[decls.length - 1][1].match(/^await\s+(read\w*Config)\(\)/) : null;
    if (!bind) { staleness.push(`:${site.line} ${id} 不是现读的配置（${decls.length ? decls[decls.length - 1][1] : '未声明'}）`); continue; }
    const fn = bind[1];
    if (fn === 'readTranslateConfig') continue;
    const def = bgSrc.match(new RegExp(`(?:function\\s+${fn}\\b|(?:const|let)\\s+${fn}\\s*=)[\\s\\S]{0,400}`));
    if (!def || !def[0].includes('readTranslateConfig()')) staleness.push(`:${site.line} ${fn} 没有调用 readTranslateConfig()`);
  }
  check('G2 注入的配置现读自 readTranslateConfig（每批 / 每次单卡各读一次）',
    /async function readTranslateConfig\(\)/.test(bgSrc) && staleness.length === 0, staleness.join(' | '));
}

// ============ B 组：后台行为（真实 background.js + Translator 桩） ============
const SUB_CARDS = () => [card('b1', { title: 'One', description: 'first' }), card('b2', { title: 'Two', description: 'second' })];
const AI = { translateMode: 'ai', aiEndpoint: 'https://ai.test/v1', aiApiKey: 'k1', batchSize: 1, delayMs: 0 };

let swLoaded = null; // 第一次 boot 时记下：替身装上之前，vm 里真实 translator.js 挂上的全局 Translator

async function boot({ translateConfig, dramas }) {
  // 不传 translator 选项：让 fixture 照 SW 的 importScripts 顺序加载真实 translator.js（走 global 分支），
  // 装替身前先核对它挂上了全局 Translator
  const bg = await background({ dramas });
  if (swLoaded === null) {
    const real = bg.context.Translator;
    swLoaded = typeof real?.translateBatchAI === 'function' && typeof real?.translateTitleAndDesc === 'function';
  }
  // 批间 pause 是 setTimeout(delayMs=0)：只放行 0 延迟的定时器，保活 20s、CSV 防抖 500ms 等照旧不触发
  bg.context.setTimeout = (fn, ms) => { if (!(Number(ms) > 0)) setImmediate(fn); return 1; };
  // 初始化会用 config/trans.json 覆盖 storage 里的 translateConfig，所以落定后再写
  await bg.context.chrome.storage.local.set({ translateConfig });
  const calls = [];
  const hooks = { onBatch: null };
  bg.context.Translator = {
    async translateBatchAI(items, config) {
      calls.push({ kind: 'batch', titles: items.map(it => it.title), config });
      if (hooks.onBatch) await hooks.onBatch(calls.length);
      return items.map(it => ({ title: `中·${it.title}`, desc: '中文简介' }));
    },
    async translateTitleAndDesc(title, description, config) {
      calls.push({ kind: 'single', title, config });
      return { title: `中·${title}`, desc: '中文简介' };
    }
  };
  const setConfig = cfg => bg.context.chrome.storage.local.set({ translateConfig: cfg });
  const statusOf = async () => Object.fromEntries((await bg.run('getDramasSnapshot()')).map(d => [d.itemId, d.status]));
  return { bg, calls, hooks, setConfig, statusOf };
}

{
  const { bg, calls, hooks, setConfig, statusOf } = await boot({ translateConfig: AI, dramas: SUB_CARDS() });
  check('B0 SW 路径（importScripts、无 module）按全局 TranslateConfig 加载真实 translator.js，挂上全局 Translator', swLoaded === true);
  hooks.onBatch = async (n) => { if (n === 1) await setConfig({ ...AI, aiApiKey: 'k2' }); };
  const summary = await bg.run('performTranslate({ source: "manual" })');
  const status = await statusOf();
  check('B1 AI 模式每批开头重读配置并作尾参传入（批间改了密钥，下一批即用新密钥）',
    calls.length === 2 && calls.every(c => c.kind === 'batch' && c.config?.translateMode === 'ai')
      && calls[0].config.aiApiKey === 'k1' && calls[1].config.aiApiKey === 'k2'
      && summary?.translatedCount === 2 && !summary?.error && status.b1 === 'trans' && status.b2 === 'trans',
    JSON.stringify({ calls: calls.map(c => ({ kind: c.kind, key: c.config?.aiApiKey })), summary, status }));
}

{
  const { bg, calls, hooks, setConfig, statusOf } = await boot({ translateConfig: AI, dramas: SUB_CARDS() });
  hooks.onBatch = async (n) => { if (n === 1) await setConfig({ ...AI, translateMode: 'api' }); };
  const summary = await bg.run('performTranslate({ source: "manual" })');
  const status = await statusOf();
  check('B2 本轮中途模式改成 API → 本轮提前结束，不落进逐条分支，剩下的保持 new、不报错',
    calls.length === 1 && calls[0].kind === 'batch'
      && summary?.pendingCount === 2 && summary?.translatedCount === 1 && !summary?.error && !summary?.aborted
      && status.b1 === 'trans' && status.b2 === 'new',
    JSON.stringify({ calls: calls.map(c => c.kind), summary, status }));
}

{
  const { bg, calls, statusOf } = await boot({ translateConfig: AI, dramas: SUB_CARDS() });
  // 本轮开头那次扫描（translateConfig + urlTags）读完即把模式改成 API：第一批开头就读到变化
  bg.run(`(() => {
    const local = chrome.storage.local;
    const get = local.get.bind(local);
    let armed = true;
    local.get = async (keys) => {
      const out = await get(keys);
      if (armed && Array.isArray(keys) && keys.length === 2 && keys.includes('translateConfig') && keys.includes('urlTags')) {
        armed = false;
        await local.set({ translateConfig: { ...out.translateConfig, translateMode: 'api' } });
      }
      return out;
    };
  })()`);
  const summary = await bg.run('performTranslate({ source: "manual" })');
  const status = await statusOf();
  check('B3 第一批开头就读到模式变了 → 一条不试、不报「检查配置」，留给下一轮',
    calls.length === 0 && summary?.pendingCount === 2 && summary?.translatedCount === 0 && !summary?.error
      && status.b1 === 'new' && status.b2 === 'new',
    JSON.stringify({ calls: calls.map(c => c.kind), summary, status }));
}

{
  const API = { translateMode: 'api', apiEndpoint: 'https://mt.test/get', delayMs: 0 };
  const { bg, calls, statusOf } = await boot({ translateConfig: API, dramas: [card('a1', { title: 'Solo', description: 'solo' })] });
  const summary = await bg.run('performTranslate({ source: "manual" })');
  const status = await statusOf();
  check('B4 API 模式逐条翻译同样传入现读、已归一化的配置',
    calls.length === 1 && calls[0].kind === 'single' && calls[0].config?.translateMode === 'api'
      && calls[0].config.apiEndpoint === 'https://mt.test/get' && calls[0].config.batchSize === 10
      && summary?.translatedCount === 1 && status.a1 === 'trans',
    JSON.stringify({ calls, summary, status }));
}

{
  const { bg, calls } = await boot({ translateConfig: { ...AI, aiApiKey: 'k-single' }, dramas: [card('s1', { title: 'Single', description: 'one' })] });
  const resp = await bg.run('handleTranslateSingle("id_s1")');
  check('B5 单卡 🌍 调用前现读配置并传入（已归一化）',
    resp?.success === true && calls.length === 1 && calls[0].kind === 'single' && calls[0].config?.translateMode === 'ai'
      && calls[0].config.aiApiKey === 'k-single' && calls[0].config.requestTimeoutSec === 60,
    JSON.stringify({ resp, calls }));
}

await new Promise(r => setImmediate(r));
check('T0 全程无未捕获 rejection', unhandledCount === 0, `unhandled=${unhandledCount}`);

console.log = origLog; console.warn = origWarn;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
