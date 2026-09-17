import './bootstrap.cjs';
// 回归测试：弹窗单卡 🌍 翻译改走后台 translateSingle（2026-09-17 体检 H3）。
//
// 起因：translateSingleCard 此前在弹窗页直接 await Translator.translateTitleAndDesc，
// 只把结果经 applyTranslation 回传后台落库——弹窗一关页面即销毁、请求随之中断，
// 与 larkPush 刻意走后台（lark.js 头注释「弹窗关闭后请求仍需完成」）自相矛盾，
// 且 popup.html 载入 translator.js 仅为这一处。
//
// 契约：
//   S 组（后台）：translateSingle 只收 dramaId，SW 内读卡 → Translator → 复用
//     updateSingleDramaTranslation 落库；不传 fillOnly（重译＝新结果优先）；
//     半成品语义与批量线同口径（该翻未翻全保持 new、translateAttempts 累加、达 3 次收口）。
//   U 组（弹窗，vm 跑真实 popup.js）：只发消息；translateInFlight 按 dramaId 防重；
//     终态按 data-id 重查节点回写（storage.onChanged 全量重渲染会换掉节点）。
//   W 组（接线）：popup.html 不再载 translator.js；popup.js 不再引用 Translator。
//   A1：applyTranslation 与 translateSingle 共用同一完成判据（半成品也保持 new）。
// 用法：node tests/unit-translate-single.mjs（实现前 S/U/W/A1 应 RED）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============ 后台夹具（unit-translate-partial 同款：chrome 桩 + eval 真实 background.js） ============
const rawStore = {};
let failNextSet = false;

function pickKeys(keys) {
  const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? rawStore);
  const out = {};
  for (const k of wanted) if (k in rawStore) out[k] = structuredClone(rawStore[k]);
  return out;
}

const chromeStub = {
  storage: {
    local: {
      async get(keys) { await Promise.resolve(); return pickKeys(keys); },
      async set(obj) {
        if (failNextSet) { failNextSet = false; throw new Error('unit stub: 注入的 set 失败'); }
        await Promise.resolve();
        for (const [k, v] of Object.entries(obj)) rawStore[k] = structuredClone(v);
      },
      async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) delete rawStore[k]; }
    },
    onChanged: { addListener() {} }
  },
  runtime: {
    getURL: p => `chrome-extension://unit-test/${p}`,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { chromeStub.__msg = fn; } },
    sendMessage(message) {
      return new Promise((resolve) => {
        const handled = chromeStub.__msg?.(message, {}, resolve);
        if (!handled) resolve(undefined);
      });
    },
    lastError: null
  },
  alarms: { async getAll() { return []; }, async clear() { return true; }, create() {}, onAlarm: { addListener() {} } },
  tabs: { create() {}, onUpdated: { addListener() {}, removeListener() {} } },
  notifications: { create() {} },
  scripting: { async executeScript() { return []; } }
};
globalThis.chrome = chromeStub;

globalThis.importScripts = (...paths) => {
  for (const p of paths) {
    if (String(p).includes('translator')) continue;
    const rel = String(p).replace('../shared/', '../src/shared/');
    (0, eval)(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
  }
};
globalThis.fetch = async () => { throw new TypeError('unit stub: no network'); };

// Translator 桩：记录 SW 内实际收到的入参；plan 决定返回什么（或抛错）
const translatorCalls = [];
let translatorPlan = null;
globalThis.Translator = {
  async translateTitleAndDesc(title, description) {
    translatorCalls.push({ title, description });
    if (typeof translatorPlan === 'function') return translatorPlan(title, description);
    return { title: `中·${title}`, desc: description ? `中文·${description}` : '' };
  }
};

const origLog = console.log, origWarn = console.warn, origError = console.error;
console.log = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origLog(...a); };
console.warn = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origWarn(...a); };
console.error = (...a) => { if (!String(a[0]).includes('[ShortScraping]')) origError(...a); };

(0, eval)(fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8'));
await sleep(150);

const resetDramasCache = async () => { failNextSet = true; await clearAllDramas().catch(() => {}); }; // eslint-disable-line no-undef
const send = msg => chromeStub.runtime.sendMessage(msg);
const byId = () => Object.fromEntries((rawStore.dramas || []).map(d => [d.id, d]));

const SUB = 'https://unit.test/list';
const mk = (id, over = {}) => ({
  id, itemId: id, title: `T-${id}`, description: `D-${id}`,
  status: 'new', source: 'unittest', sourceListUrl: SUB,
  titleZh: '', descriptionZh: '', translatedAt: null, ...over
});

async function seed(...dramas) {
  await resetDramasCache();
  rawStore.urlTags = [{ urlPattern: SUB, tags: ['T'] }];
  rawStore.translateConfig = { translateMode: 'api', delayMs: 1 };
  rawStore.dramas = dramas;
  translatorCalls.length = 0;
  translatorPlan = null;
}

// ---------- S1/S2 完整返回：SW 内读卡翻译并落库 ----------
await seed(mk('full'));
{
  const resp = await send({ action: 'translateSingle', dramaId: 'full' });
  const m = byId();
  check('S1 translateSingle 完整返回 → 标 trans、译文落库、写 translatedAt',
    resp?.success === true && m.full?.status === 'trans'
    && m.full?.titleZh === '中·T-full' && m.full?.descriptionZh === '中文·D-full' && Boolean(m.full?.translatedAt),
    JSON.stringify({ resp, card: m.full }));
  check('S1b 响应报告 complete=true', resp?.complete === true, JSON.stringify(resp));
  check('S2 Translator 在 SW 内以 storage 里那张卡的原文调用（消息只带 dramaId）',
    translatorCalls.length === 1 && translatorCalls[0].title === 'T-full' && translatorCalls[0].description === 'D-full',
    JSON.stringify(translatorCalls));
}

// ---------- S3 半成品：只回简介 → 保持 new、translateAttempts 累加、达 3 次收口 ----------
await seed(mk('partial'));
translatorPlan = () => ({ title: '', desc: '只回了简介' });
{
  const resp = await send({ action: 'translateSingle', dramaId: 'partial' });
  const m = byId();
  check('S3 只回简介 → 简介存下、标题空、保持 new、translateAttempts=1、无 translatedAt',
    resp?.success === true && m.partial?.status === 'new' && m.partial?.descriptionZh === '只回了简介'
    && !m.partial?.titleZh && !m.partial?.translatedAt && m.partial?.translateAttempts === 1,
    JSON.stringify({ resp, card: m.partial }));
  check('S3b 响应报告 complete=false（弹窗据此提示「留待补齐」）', resp?.complete === false, JSON.stringify(resp));

  await send({ action: 'translateSingle', dramaId: 'partial' });
  check('S3c 第二次仍半成品 → translateAttempts=2、仍 new',
    byId().partial?.translateAttempts === 2 && byId().partial?.status === 'new', JSON.stringify(byId().partial));

  const resp3 = await send({ action: 'translateSingle', dramaId: 'partial' });
  const c3 = byId().partial;
  check('S3d 第三次达上限 → 收口 trans、清 translateAttempts、已得简介保留',
    resp3?.complete === true && c3?.status === 'trans' && c3?.translateAttempts === undefined
    && c3?.descriptionZh === '只回了简介' && Boolean(c3?.translatedAt),
    JSON.stringify(c3));
}

// ---------- S4 重译：不走 fillOnly，新结果优先；既有值算数 ----------
await seed(mk('recard', { status: 'trans', titleZh: '旧译名', descriptionZh: '旧简介', translatedAt: '2026-07-01T00:00:00.000Z' }));
translatorPlan = () => ({ title: '新译名', desc: '新简介' });
{
  const resp = await send({ action: 'translateSingle', dramaId: 'recard' });
  const c = byId().recard;
  check('S4 已翻译卡片重译 → 新结果覆盖旧译文（不走 fillOnly）',
    resp?.success === true && c?.titleZh === '新译名' && c?.descriptionZh === '新简介' && c?.status === 'trans',
    JSON.stringify(c));
}
await seed(mk('recard2', { status: 'trans', titleZh: '旧译名', descriptionZh: '旧简介', translatedAt: '2026-07-01T00:00:00.000Z' }));
translatorPlan = () => ({ title: '只回新标题', desc: '' });
{
  const resp = await send({ action: 'translateSingle', dramaId: 'recard2' });
  const c = byId().recard2;
  check('S4b 重译只回标题 → 标题换新、既有中文简介沿用、既有值算完成',
    resp?.complete === true && c?.titleZh === '只回新标题' && c?.descriptionZh === '旧简介' && c?.status === 'trans',
    JSON.stringify(c));
}

// ---------- S5 原文无简介：拿到标题即完成 ----------
await seed(mk('nodesc', { description: '' }));
translatorPlan = () => ({ title: '中文标题', desc: '' });
{
  const resp = await send({ action: 'translateSingle', dramaId: 'nodesc' });
  const c = byId().nodesc;
  check('S5 原文无简介 → 只需标题即 trans',
    resp?.complete === true && c?.status === 'trans' && c?.titleZh === '中文标题' && !c?.translateAttempts,
    JSON.stringify(c));
}

// ---------- S6 未找到卡片：不调 Translator ----------
await seed(mk('other'));
{
  const resp = await send({ action: 'translateSingle', dramaId: 'ghost' });
  check('S6 未找到卡片 → success=false 且点名「未找到」，Translator 未被调用',
    resp?.success === false && String(resp?.error || '').includes('未找到') && translatorCalls.length === 0,
    JSON.stringify(resp));
}

// ---------- S7 结果为空：报错且卡片不动 ----------
await seed(mk('empty'));
translatorPlan = () => ({ title: '', desc: '' });
{
  const before = JSON.stringify(byId().empty);
  const resp = await send({ action: 'translateSingle', dramaId: 'empty' });
  check('S7 翻译结果为空 → success=false 且点名「翻译结果为空」',
    resp?.success === false && String(resp?.error || '').includes('翻译结果为空'), JSON.stringify(resp));
  check('S7b 结果为空时卡片原样不动（不计 translateAttempts）', JSON.stringify(byId().empty) === before, JSON.stringify(byId().empty));
}

// ---------- S8 Translator 抛错：错误原样回传，卡片不动 ----------
await seed(mk('boom'));
translatorPlan = () => { throw new Error('unit stub: 翻译接口 500'); };
{
  const before = JSON.stringify(byId().boom);
  const resp = await send({ action: 'translateSingle', dramaId: 'boom' });
  check('S8 Translator 抛错 → success=false 且 error 为原始信息',
    resp?.success === false && resp?.error === 'unit stub: 翻译接口 500', JSON.stringify(resp));
  check('S8b 抛错时卡片原样不动', JSON.stringify(byId().boom) === before, JSON.stringify(byId().boom));
}

// ---------- A1 applyTranslation 与 translateSingle 同一完成判据 ----------
await seed(mk('apply'));
{
  const resp = await send({ action: 'applyTranslation', dramaId: 'apply', result: { title: '', desc: '只有简介' } });
  const c = byId().apply;
  check('A1 applyTranslation 半成品也保持 new 并累加 translateAttempts（与 translateSingle 同判据）',
    resp?.success === true && resp?.updated === false && c?.status === 'new'
    && c?.descriptionZh === '只有简介' && c?.translateAttempts === 1 && !c?.translatedAt,
    JSON.stringify({ resp, card: c }));
}

// ============ 弹窗夹具：vm 跑真实 popup.js，只替换 DOMContentLoaded 注册行导出内部函数 ============
function popupFixture() {
  const messages = [];
  const pending = [];
  const timers = [];
  const toasts = [];
  const quiet = { log() {}, warn() {}, error() {} };
  const context = vm.createContext({
    console: quiet,
    document: { addEventListener() {} },
    chrome: {
      runtime: {
        sendMessage(message) {
          messages.push(message);
          return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
        },
        getURL: p => `chrome-extension://unit-test/${p}`
      },
      storage: { onChanged: { addListener() {} } },
      tabs: { create() {} }
    },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {}
  });
  let script = fs.readFileSync(path.join(worktreeRoot, 'src/popup/popup.js'), 'utf8');
  const marker = "document.addEventListener('DOMContentLoaded', init);";
  if (!script.includes(marker)) throw new Error('popup.js 的 DOMContentLoaded 注册行已变，夹具需同步');
  // reapplyCardButtonStates 实现前不存在，防御性取用让 U7-U10 自己 FAIL 而不是夹具 ReferenceError
  script = script.replace(marker, 'globalThis.fixture = { elements, state, translateSingleCard, pushCardToLark, '
    + 'reapply: typeof reapplyCardButtonStates === "function" ? reapplyCardButtonStates : null, '
    + 'setToast: fn => { showToast = fn; }, setOpenSettings: fn => { openSettings = fn; } };');
  vm.runInContext(script, context);
  const fx = context.fixture;
  fx.setToast((message, opts = {}) => toasts.push({ message, type: opts.type || 'info' }));
  fx.setOpenSettings(() => {});

  // 假 DOM：timeline 容器按 selector 暴露当前节点集合（可整体换掉模拟 storage.onChanged 的全量重渲染）
  const nodesBySelector = { '.btn-translate': [], '.btn-lark': [] };
  fx.elements.containers = { timeline: { querySelectorAll: sel => nodesBySelector[sel] || [] } };
  fx.elements.toastBar = { classList: { add() {}, remove() {} } };
  const LARK_ICON = '<img src="../../assets/icons/lark.png" alt="Lark">';
  const makeBtn = (id, html = '🌍') => ({ dataset: { id }, innerHTML: html, disabled: false });
  const setNodes = (list, selector = '.btn-translate') => { nodesBySelector[selector] = list; };
  // 模拟一次全量重渲染：所有按钮节点换成默认态的新节点，再走产品的重贴钩子
  const rerender = () => {
    for (const sel of Object.keys(nodesBySelector)) {
      nodesBySelector[sel] = nodesBySelector[sel].map(n => makeBtn(n.dataset.id, sel === '.btn-lark' ? LARK_ICON : '🌍'));
    }
    if (typeof fx.reapply === 'function') fx.reapply();
    return nodesBySelector;
  };
  const flushTimers = () => { const due = timers.splice(0); due.forEach(t => t.fn()); return due; };
  // 无待应答消息时静默返回 false（旧实现根本不发消息，让断言自己 FAIL 而不是夹具抛错）
  const respond = value => { const p = pending.shift(); if (p) p.resolve(value); return Boolean(p); };
  const fail = error => { const p = pending.shift(); if (p) p.reject(error); return Boolean(p); };
  return { fx, messages, toasts, timers, makeBtn, setNodes, rerender, flushTimers, respond, fail, LARK_ICON };
}

// ---------- U1 只发消息，且消息只带 dramaId ----------
{
  const h = popupFixture();
  const btn = h.makeBtn('d1');
  h.setNodes([btn]);
  const run = h.fx.translateSingleCard('d1', btn);
  await sleep(0);
  check('U1 点击即置 ⏳ 并禁用', btn.innerHTML === '⏳' && btn.disabled === true, JSON.stringify(btn));
  check('U1b 只发一条 translateSingle 消息且只带 dramaId',
    h.messages.length === 1 && h.messages[0].action === 'translateSingle' && h.messages[0].dramaId === 'd1'
    && !('result' in h.messages[0]) && !('title' in h.messages[0]),
    JSON.stringify(h.messages));
  h.respond({ success: true, complete: true });
  await run;
  check('U1c 成功后回写 ✅（禁用），无成功 toast（卡片经 onChanged 自会刷新）',
    btn.innerHTML === '✅' && btn.disabled === true && h.toasts.length === 0, JSON.stringify({ btn, toasts: h.toasts }));
  const due = h.flushTimers();
  check('U1d 2 秒后复原 🌍 并启用', due.some(t => t.ms === 2000) && btn.innerHTML === '🌍' && btn.disabled === false, JSON.stringify(btn));
}

// ---------- U2 进行中同卡再点：不发第二条消息 ----------
{
  const h = popupFixture();
  const btn = h.makeBtn('d2');
  h.setNodes([btn]);
  const first = h.fx.translateSingleCard('d2', btn);
  await sleep(0);
  await h.fx.translateSingleCard('d2', btn);
  check('U2 进行中再次点击 → 不再发消息，toast 提示正在翻译',
    h.messages.length === 1 && h.toasts.some(t => t.message.includes('正在翻译')), JSON.stringify({ messages: h.messages, toasts: h.toasts }));
  h.respond({ success: true, complete: true });
  await first;
  h.flushTimers();
  h.toasts.length = 0;
  const third = h.fx.translateSingleCard('d2', btn);
  await sleep(0);
  check('U2b 结束后 in-flight 释放，同卡可再次发起', h.messages.length === 2, `messages=${h.messages.length}`);
  h.respond({ success: true, complete: true });
  await third;
}

// ---------- U3 终态按 data-id 重查节点：重渲染后写新节点、不碰旧节点 ----------
{
  const h = popupFixture();
  const oldBtn = h.makeBtn('d3');
  h.setNodes([oldBtn]);
  const run = h.fx.translateSingleCard('d3', oldBtn);
  await sleep(0);
  const newBtn = h.makeBtn('d3');
  const otherBtn = h.makeBtn('zz');
  h.setNodes([otherBtn, newBtn]);          // storage.onChanged 全量重渲染：节点全部换新
  h.respond({ success: true, complete: true });
  await run;
  check('U3 终态写到重渲染后同 data-id 的新节点', newBtn.innerHTML === '✅' && newBtn.disabled === true, JSON.stringify(newBtn));
  check('U3b 已脱离 DOM 的旧节点停在 ⏳ 不再被写', oldBtn.innerHTML === '⏳', JSON.stringify(oldBtn));
  check('U3c 其它卡片节点不受影响', otherBtn.innerHTML === '🌍' && otherBtn.disabled === false, JSON.stringify(otherBtn));
  h.flushTimers();
  check('U3d 复原也落在新节点', newBtn.innerHTML === '🌍' && newBtn.disabled === false && oldBtn.innerHTML === '⏳', JSON.stringify({ newBtn, oldBtn }));
}

// ---------- U4 后台报错：❌ + 错误 toast ----------
{
  const h = popupFixture();
  const btn = h.makeBtn('d4');
  h.setNodes([btn]);
  const run = h.fx.translateSingleCard('d4', btn);
  await sleep(0);
  h.respond({ success: false, error: '翻译结果为空，请检查翻译接口配置' });
  await run;
  check('U4 success=false → ❌ 且错误 toast 含后台 error 文案',
    btn.innerHTML === '❌' && h.toasts.some(t => t.type === 'error' && t.message.includes('翻译结果为空')),
    JSON.stringify({ btn, toasts: h.toasts }));
  h.flushTimers();
  check('U4b 失败 2 秒后同样复原 🌍', btn.innerHTML === '🌍' && btn.disabled === false, JSON.stringify(btn));
}

// ---------- U5 半成品：✅ + 提示留待补齐 ----------
{
  const h = popupFixture();
  const btn = h.makeBtn('d5');
  h.setNodes([btn]);
  const run = h.fx.translateSingleCard('d5', btn);
  await sleep(0);
  h.respond({ success: true, complete: false });
  await run;
  check('U5 complete=false → ✅ 且 info toast 说明只翻出一部分',
    btn.innerHTML === '✅' && h.toasts.some(t => t.type === 'info' && t.message.includes('一部分')),
    JSON.stringify({ btn, toasts: h.toasts }));
}

// ---------- U6 sendMessage 本身 reject（如 SW 端口关闭）：吞掉并报错，不外抛 ----------
{
  const h = popupFixture();
  const btn = h.makeBtn('d6');
  h.setNodes([btn]);
  const run = h.fx.translateSingleCard('d6', btn);
  await sleep(0);
  h.fail(new Error('The message port closed before a response was received.'));
  let threw = false;
  await run.catch(() => { threw = true; });
  check('U6 sendMessage reject → 不外抛、❌、错误 toast',
    !threw && btn.innerHTML === '❌' && h.toasts.some(t => t.type === 'error' && t.message.includes('port closed')),
    JSON.stringify({ threw, btn, toasts: h.toasts }));
}

// ---------- U7-U9 按钮瞬态熬过全量重渲染（真机 e2e 实测：翻译成功必触发落库 → onChanged → 重渲染，✅ 只闪几十毫秒） ----------
{
  const h = popupFixture();
  const btn = h.makeBtn('d7');
  h.setNodes([btn]);
  const run = h.fx.translateSingleCard('d7', btn);
  await sleep(0);
  const mid = h.rerender()['.btn-translate'][0];
  check('U7 进行中被重渲染 → 新节点重贴 ⏳ 并禁用（不再重建成可点的 🌍）', mid.innerHTML === '⏳' && mid.disabled === true, JSON.stringify(mid));
  h.respond({ success: true, complete: true });
  await run;
  h.flushTimers();
}
{
  const h = popupFixture();
  const btn = h.makeBtn('d8');
  h.setNodes([btn]);
  const run = h.fx.translateSingleCard('d8', btn);
  await sleep(0);
  h.respond({ success: true, complete: true });
  await run;
  const rebuilt = h.rerender()['.btn-translate'][0];   // 落库 → onChanged → 全量重渲染
  check('U8 终态 ✅ 在重渲染后仍在新节点上', rebuilt.innerHTML === '✅' && rebuilt.disabled === true, JSON.stringify(rebuilt));
  h.flushTimers();                                      // 2 秒复原
  const reset = h.rerender()['.btn-translate'][0];
  check('U8b 复原后再重渲染不再重贴（瞬态已忘掉）', reset.innerHTML === '🌍' && reset.disabled === false, JSON.stringify(reset));
}
{
  const h = popupFixture();
  const btn = h.makeBtn('d9');
  h.setNodes([btn]);
  const run = h.fx.translateSingleCard('d9', btn);
  await sleep(0);
  h.respond({ success: false, error: 'x' });
  await run;
  const rebuilt = h.rerender()['.btn-translate'][0];
  check('U9 ❌ 终态同样熬过重渲染', rebuilt.innerHTML === '❌' && rebuilt.disabled === true, JSON.stringify(rebuilt));
  h.flushTimers();
}

// ---------- U10 Lark 按钮同享同一套瞬态机制 ----------
{
  const h = popupFixture();
  const btn = h.makeBtn('L1', h.LARK_ICON);
  h.setNodes([btn], '.btn-lark');
  const run = h.fx.pushCardToLark('L1', btn);
  await sleep(0);
  const mid = h.rerender()['.btn-lark'][0];
  check('U10 Lark 进行中被重渲染 → 新节点重贴 ⏳', mid.innerHTML === '⏳' && mid.disabled === true, JSON.stringify(mid));
  h.respond({ success: true });
  await run;
  const done = h.rerender()['.btn-lark'][0];
  check('U10b Lark ✅ 终态熬过重渲染', done.innerHTML === '✅' && done.disabled === true, JSON.stringify(done));
  h.flushTimers();
  const reset = h.rerender()['.btn-lark'][0];
  check('U10c Lark 复原后重渲染回默认图标且可点', reset.innerHTML === h.LARK_ICON && reset.disabled === false, JSON.stringify(reset));
}

// ============ W 组：接线静态断言 ============
{
  const popupHtml = fs.readFileSync(path.join(worktreeRoot, 'src/popup/popup.html'), 'utf8');
  const popupSrc = fs.readFileSync(path.join(worktreeRoot, 'src/popup/popup.js'), 'utf8');
  const bgSrc = fs.readFileSync(path.join(worktreeRoot, 'src/background/background.js'), 'utf8');
  const renderAt = popupSrc.indexOf('TimelineRender.renderTimeline(');
  const reapplyAt = popupSrc.indexOf('reapplyCardButtonStates();');
  check('W7 renderTimeline 重建卡片后立即重贴按钮瞬态（reapplyCardButtonStates 紧随 TimelineRender.renderTimeline）',
    renderAt >= 0 && reapplyAt > renderAt && reapplyAt - renderAt < 600, `render=${renderAt} reapply=${reapplyAt}`);
  check('W1 popup.html 不再载入 translator.js（翻译只在 SW 发起）', !popupHtml.includes('translator.js'), '');
  check('W2 popup.js 不再引用 Translator（弹窗页不发翻译请求）', !popupSrc.includes('Translator.'), '');
  check('W3 popup.js 不再发 applyTranslation（译文不经弹窗回传）', !popupSrc.includes("'applyTranslation'"), '');
  check('W4 popup.js 发 translateSingle', popupSrc.includes("action: 'translateSingle'"), '');
  check('W5 后台仍 importScripts translator.js', bgSrc.includes("importScripts('../shared/translator.js')"), '');
  check('W6 popup.html 仍保留 translate-config（timeline-render 依赖）', popupHtml.includes('src="../shared/translate-config.js"'), '');
}

console.log = origLog; console.warn = origWarn; console.error = origError;
console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
