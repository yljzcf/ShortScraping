import './bootstrap.cjs';
// 弹窗同步服务控制（🔄 / ⏹）与状态栏键盘可达性的回归测试（2026-09-25 审计 C3 / E5）。
//
// 背景：v1.6.13 新增的 🔄/⏹ 没有任何测试；审计还发现两处缺陷——
//   1. 状态栏容器 div[role=button] 的 keydown 不看事件来源，内嵌 📁/▶/🔄/⏹/▦ 上按
//      Enter/空格时被容器 preventDefault，按钮本身的键盘激活被取消，执行成了容器的动作；
//   2. 重启失败（新实例 10 秒内没起来）后状态栏不刷新，一直显示「已开启」+ 局域网链接。
//
// 做法：vm 跑真实 popup.js（只把 DOMContentLoaded 注册行换成导出内部函数），配一棵
// 只含状态栏相关节点的假 DOM（带冒泡与 stopPropagation，Enter/空格未被 preventDefault
// 时按浏览器语义给原生 button 补发 click），fetch 按 URL 桩成一个可编排的同步服务，
// setTimeout 走虚拟时钟：轮询 10 秒在测试里是瞬间完成的，且顺序确定。
//
// 分组：
//   K 组：键盘——内嵌按钮的 Enter/空格触发按钮自己的动作，焦点在容器本身时仍刷新状态
//   C 组：runSyncControl 执行期间两个按钮一起禁用、结束（含抛错）后恢复、防连点
//   P 组：postSyncControl 非 ok 一律抛错（HTTP 非 2xx 或 body.ok 不为 true）
//   R 组：重启——进程号变了才算成功；失败时刷新状态栏；logPath 提示按 mode 区分
//   S 组：停止——轮询到 /health 不再应答才算停止
//   W 组：服务健康时发给后台的补喂消息带上 /health 的 contentHash / csvInSync（v1.6.22 冷启动指纹），旧版服务不带
// 用法：node tests/unit-popup-sync-control.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ---------- 假 DOM ----------
class FakeEl {
  constructor(id, tagName = 'div', parentNode = null, classes = []) {
    this.id = id;
    this.tagName = tagName;
    this.parentNode = parentNode;
    this.listeners = {};
    this.classes = new Set(classes);
    this.title = '';
    this.textContent = '';
    this.disabled = false;
    this.dataset = {};
    this.focused = 0;
    this.classList = {
      add: (...names) => names.forEach(n => this.classes.add(n)),
      remove: (...names) => names.forEach(n => this.classes.delete(n)),
      toggle: (name, force) => {
        const on = force === undefined ? !this.classes.has(name) : Boolean(force);
        if (on) this.classes.add(name); else this.classes.delete(name);
        return on;
      },
      contains: name => this.classes.has(name)
    };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  focus() { this.focused++; }
  querySelectorAll() { return []; }
}

/** 从 target 起逐级冒泡到 document，尊重 stopPropagation。 */
function dispatch(target, type, init = {}) {
  const event = {
    type, target, defaultPrevented: false, propagationStopped: false, ...init,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; }
  };
  for (let node = target; node && !event.propagationStopped; node = node.parentNode) {
    event.currentTarget = node;
    for (const fn of node.listeners[type] || []) fn(event);
  }
  return event;
}

/** 键盘按下：原生 button 的 Enter/空格激活只在 keydown 未被 preventDefault 时发生。 */
function pressKey(target, key) {
  const event = dispatch(target, 'keydown', { key });
  if (target.tagName === 'button' && !event.defaultPrevented && (key === 'Enter' || key === ' ')) {
    dispatch(target, 'click');
  }
  return event;
}

// ---------- 夹具 ----------
function popupFixture() {
  // 虚拟时钟：setTimeout 只登记，由 idle()/drive() 按到期先后逐个触发
  let now = 0;
  let seq = 0;
  const timers = new Map();

  const doc = new FakeEl('#document');
  const byId = {};
  const node = (id, tagName, parent, classes) => (byId[id] = new FakeEl(id, tagName, parent, classes));
  const sync = node('syncServiceStatus', 'div', doc);
  node('btnSyncFolder', 'button', sync);
  node('syncServiceText', 'span', sync);
  node('btnSyncRestart', 'button', sync, ['hidden']);
  node('btnSyncStop', 'button', sync, ['hidden']);
  node('btnSyncStart', 'button', sync, ['hidden']);
  const version = node('versionStatus', 'div', doc);
  node('versionStatusText', 'span', version);
  const lan = node('lanShare', 'div', doc);
  node('lanShareText', 'span', lan);
  node('btnLanQr', 'button', lan, ['hidden']);
  node('lanQrPopover', 'div', doc, ['hidden']);
  doc.getElementById = id => byId[id] || (byId[id] = new FakeEl(id, 'div', doc));
  const misc = {};
  doc.querySelector = sel => misc[sel] || (misc[sel] = new FakeEl(sel, 'div', doc));
  doc.createElement = tag => new FakeEl('', tag, null);
  doc.body = { appendChild() {} };

  // 可编排的同步服务：health() 返回 /health 的 body，null 表示连不上
  const server = {
    health: () => ({ ok: true, pid: 100, lanUrls: ['http://192.168.1.8:31919'], serverDir: '/proj/ShortScraping/server' }),
    posts: {}
  };
  const calls = [];
  const fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    const { btnSyncStop: stop, btnSyncRestart: restart } = byId;
    calls.push({ url: u, method, at: now, headers: options.headers, body: options.body, disabled: [stop.disabled, restart.disabled] });
    if (u === 'http://127.0.0.1:31919/health') {
      const body = server.health();
      if (!body) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => structuredClone(body) };
    }
    const route = u.replace('http://127.0.0.1:31919', '');
    if (method === 'POST' && server.posts[route]) {
      const { status = 200, body } = server.posts[route]();
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => { if (body === undefined) throw new SyntaxError('Unexpected end of JSON input'); return structuredClone(body); }
      };
    }
    throw new TypeError('Failed to fetch');
  };

  const clipboard = [];
  const messages = []; // chrome.runtime.sendMessage 收到的消息（W 组断言补喂消息的形状）
  const window = { location: { href: '' } };
  const qrDraws = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    document: doc,
    window,
    navigator: { platform: 'MacIntel', clipboard: { writeText: async text => { clipboard.push(text); } } },
    chrome: {
      runtime: { sendMessage: message => { messages.push(structuredClone(message)); return Promise.resolve(undefined); }, getURL: p => `chrome-extension://unit-test/${p}` },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      tabs: { create() {} }
    },
    QrCode: { drawToCanvas: (canvas, url) => { qrDraws.push(url); } },
    SiteRegistry: { hostBySource: {} },
    AbortController,
    fetch,
    setTimeout(fn, ms = 0) { const id = ++seq; timers.set(id, { due: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });

  let script = fs.readFileSync(path.join(root, 'src/popup/popup.js'), 'utf8');
  const marker = "document.addEventListener('DOMContentLoaded', init);";
  if (!script.includes(marker)) throw new Error('popup.js 的 DOMContentLoaded 注册行已变，夹具需同步');
  script = script.replace(marker, 'globalThis.fixture = { elements, state, cacheElements, bindEvents, '
    + 'checkSyncServiceStatus, runSyncControl, postSyncControl, onSyncRestartClick, onSyncStopClick, '
    + 'setToast: fn => { showToast = fn; } };');
  vm.runInContext(script, context);
  const fx = context.fixture;
  const toasts = [];
  fx.setToast((message, opts = {}) => toasts.push({ message, type: opts.type || 'info', duration: opts.duration }));
  fx.cacheElements();
  fx.bindEvents();

  const macrotask = () => new Promise(r => setImmediate(r));
  const fireNext = () => {
    let next = null;
    for (const entry of timers) if (!next || entry[1].due < next[1].due) next = entry;
    if (!next) return false;
    timers.delete(next[0]);
    now = Math.max(now, next[1].due);
    next[1].fn();
    return true;
  };
  /** 跑到没有待触发的计时器为止（fire-and-forget 的事件处理器用）。 */
  const idle = async (maxSteps = 500) => {
    for (let i = 0; i < maxSteps; i++) {
      await macrotask();
      if (!fireNext()) { await macrotask(); return; }
    }
    throw new Error('idle(): 计时器一直不收敛');
  };
  /** 推进虚拟时钟直到 promise 落定。 */
  const drive = async (promise, maxSteps = 500) => {
    let settled = false;
    let value;
    let error;
    promise.then(v => { settled = true; value = v; }, e => { settled = true; error = e; });
    for (let i = 0; i < maxSteps && !settled; i++) {
      await macrotask();
      if (!settled && !fireNext()) await macrotask();
    }
    if (!settled) throw new Error('drive(): promise 未落定');
    if (error) throw error;
    return value;
  };

  const posts = route => calls.filter(c => c.method === 'POST' && c.url.endsWith(route));
  const healthCalls = () => calls.filter(c => c.url.endsWith('/health'));
  const statusText = () => byId.syncServiceText.textContent;
  const hidden = id => byId[id].classes.has('hidden');
  return {
    fx, byId, server, calls, posts, healthCalls, toasts, clipboard, window, qrDraws, messages,
    idle, drive, statusText, hidden, now: () => now
  };
}

/** 夹具起来后先完成一次状态检测，状态栏进入「已开启」（⏹/🔄 可见）。 */
async function onlineFixture() {
  const h = popupFixture();
  await h.drive(h.fx.checkSyncServiceStatus());
  h.calls.length = 0;
  return h;
}

const LOG = '/Users/alice/Library/Logs/ShortScraping/sync.log';

// ============ K 组：键盘 ============
{
  const h = await onlineFixture();
  check('K0 前提：检测到服务后状态栏为「已开启」、⏹/🔄 可见、▦ 可见',
    h.statusText() === '同步服务：已开启' && !h.hidden('btnSyncStop') && !h.hidden('btnSyncRestart') && !h.hidden('btnLanQr'),
    JSON.stringify({ text: h.statusText() }));

  h.server.posts['/shutdown'] = () => { h.server.health = () => null; return { body: { ok: true, message: 'shutting down' } }; };
  const ev = pressKey(h.byId.btnSyncStop, 'Enter');
  await h.idle();
  check('K1 ⏹ 上按 Enter：容器不 preventDefault（按钮自己的键盘激活不被取消）', ev.defaultPrevented === false, '');
  check('K1b ⏹ 上按 Enter：真的发出 POST /shutdown（修复前只刷新了状态）',
    h.posts('/shutdown').length === 1, JSON.stringify(h.calls.map(c => `${c.method} ${c.url}`)));
  check('K1c 停止后状态栏为「已关闭」', h.statusText() === '同步服务：已关闭', h.statusText());
}
{
  const h = await onlineFixture();
  h.server.posts['/restart'] = () => ({ body: { ok: true, mode: 'launchd', logPath: LOG } });
  const ev = pressKey(h.byId.btnSyncRestart, ' ');
  await h.idle();
  check('K2 🔄 上按空格：发出 POST /restart、未被容器 preventDefault',
    ev.defaultPrevented === false && h.posts('/restart').length === 1, JSON.stringify(h.calls.map(c => `${c.method} ${c.url}`)));
}
{
  const h = await onlineFixture();
  const ev = pressKey(h.byId.btnSyncFolder, 'Enter');
  await h.idle();
  check('K3 📁 上按 Enter：走打开文件夹（协议触发 + 复制服务目录），不触发容器的状态刷新',
    ev.defaultPrevented === false && h.window.location.href === 'shortscraping://open-folder'
    && h.clipboard.includes('/proj/ShortScraping/server') && h.healthCalls().length === 0,
    JSON.stringify({ href: h.window.location.href, clipboard: h.clipboard, health: h.healthCalls().length }));
}
{
  const h = await onlineFixture();
  const ev = pressKey(h.byId.btnLanQr, 'Enter');
  await h.idle();
  check('K4 ▦ 上按 Enter：弹出二维码，不把链接复制走（修复前执行的是 onLanShareClick）',
    ev.defaultPrevented === false && h.qrDraws.length === 1 && !h.hidden('lanQrPopover') && h.clipboard.length === 0,
    JSON.stringify({ qr: h.qrDraws, clipboard: h.clipboard }));
}
{
  const h = popupFixture();
  h.server.health = () => null;
  await h.drive(h.fx.checkSyncServiceStatus());
  const ev = pressKey(h.byId.btnSyncStart, 'Enter');
  await h.idle();
  check('K5 ▶ 上按 Enter（服务未开）：走一键启动协议', ev.defaultPrevented === false
    && h.window.location.href === 'shortscraping://start-sync', h.window.location.href);
}
{
  const h = await onlineFixture();
  const enter = pressKey(h.byId.syncServiceStatus, 'Enter');
  await h.idle();
  const afterEnter = h.healthCalls().length;
  const space = pressKey(h.byId.syncServiceStatus, ' ');
  await h.idle();
  check('K6 焦点在状态栏容器本身时 Enter/空格仍刷新状态并 preventDefault（空格防滚动）',
    enter.defaultPrevented && space.defaultPrevented && afterEnter === 1 && h.healthCalls().length === 2
    && h.posts('/shutdown').length === 0 && h.posts('/restart').length === 0,
    JSON.stringify({ afterEnter, total: h.healthCalls().length }));
  const other = pressKey(h.byId.syncServiceStatus, 'a');
  check('K6b 其他按键不触发、不 preventDefault', !other.defaultPrevented && h.healthCalls().length === 2, '');

  const lanEnter = pressKey(h.byId.lanShare, 'Enter');
  await h.idle();
  check('K7 焦点在局域网区块本身时 Enter 仍复制链接', lanEnter.defaultPrevented
    && h.clipboard.includes('http://192.168.1.8:31919'), JSON.stringify(h.clipboard));
}

// ============ C 组：runSyncControl ============
{
  const h = await onlineFixture();
  const { stopBtn, restartBtn } = h.fx.elements.syncService;
  let during = null;
  await h.drive(h.fx.runSyncControl(async () => { during = [stopBtn.disabled, restartBtn.disabled]; }, '测试'));
  check('C1 执行期间 ⏹/🔄 同时禁用，结束后同时恢复',
    JSON.stringify(during) === '[true,true]' && !stopBtn.disabled && !restartBtn.disabled,
    JSON.stringify({ during, after: [stopBtn.disabled, restartBtn.disabled] }));
}
{
  const h = await onlineFixture();
  h.server.posts['/shutdown'] = () => { h.server.health = () => null; return { body: { ok: true } }; };
  const first = h.fx.onSyncStopClick();
  const second = h.fx.onSyncStopClick();   // 连点
  const viaRestart = h.fx.onSyncRestartClick(); // 停止进行中点 🔄
  await h.drive(Promise.all([first, second, viaRestart]));
  const shutdown = h.posts('/shutdown');
  check('C2 进行中再点 ⏹ 或 🔄 都被挡住：只发出一次 POST /shutdown、没有 /restart',
    shutdown.length === 1 && h.posts('/restart').length === 0, JSON.stringify(h.calls.map(c => `${c.method} ${c.url}`)));
  check('C2b 发 POST 时两个按钮都处于禁用态', JSON.stringify(shutdown[0]?.disabled) === '[true,true]',
    JSON.stringify(shutdown[0]?.disabled));
  const { stopBtn, restartBtn } = h.fx.elements.syncService;
  check('C2c 流程结束后两个按钮恢复可用', !stopBtn.disabled && !restartBtn.disabled, '');
}
{
  const h = await onlineFixture();
  h.server.posts['/restart'] = () => ({ status: 500, body: { ok: false, error: '派生新实例失败：spawn EAGAIN', logPath: LOG } });
  await h.drive(h.fx.onSyncRestartClick());
  const { stopBtn, restartBtn } = h.fx.elements.syncService;
  const last = h.toasts.at(-1);
  check('C3 请求被拒（500）→ 错误 toast 带服务端原因、按钮恢复',
    last?.type === 'error' && last.message === '重启失败：派生新实例失败：spawn EAGAIN' && !stopBtn.disabled && !restartBtn.disabled,
    JSON.stringify(h.toasts));
  check('C3b 请求失败后也按实测刷新一次状态（旧实例仍在 → 仍是「已开启」）',
    h.healthCalls().length === 2 && h.statusText() === '同步服务：已开启', JSON.stringify({ n: h.healthCalls().length, text: h.statusText() }));
}
{
  const h = await onlineFixture();
  h.server.health = () => null; // 服务早已退出，状态栏还停在「已开启」
  await h.drive(h.fx.onSyncStopClick());
  check('C4 POST 本身发不出去（Failed to fetch）→ 报错并把状态栏刷新成「已关闭」',
    h.toasts.at(-1)?.message === '停止失败：Failed to fetch' && h.statusText() === '同步服务：已关闭'
    && h.hidden('btnSyncStop') && !h.hidden('btnSyncStart'), JSON.stringify({ toasts: h.toasts, text: h.statusText() }));
}

// ============ P 组：postSyncControl ============
{
  const h = await onlineFixture();
  const reason = async (route) => {
    try { await h.drive(h.fx.postSyncControl(route)); return null; } catch (e) { return e.message; }
  };
  h.server.posts['/a'] = () => ({ status: 500, body: { ok: false, error: '派生新实例失败：spawn EAGAIN' } });
  h.server.posts['/b'] = () => ({ status: 200, body: { ok: false } });
  h.server.posts['/c'] = () => ({ status: 415 });                     // 非 JSON 响应
  h.server.posts['/d'] = () => ({ status: 200, body: { ok: true, mode: 'respawn', logPath: LOG } });
  check('P1 HTTP 500 → 抛错且信息取自 body.error', await reason('/a') === '派生新实例失败：spawn EAGAIN', '');
  check('P2 HTTP 200 但 body.ok 不为 true → 仍抛错（HTTP 200）', await reason('/b') === 'HTTP 200', '');
  check('P3 非 JSON 错误响应 → 抛 HTTP 状态码', await reason('/c') === 'HTTP 415', '');
  check('P4 连不上 → 抛错', await reason('/nowhere') === 'Failed to fetch', '');
  const ok = await h.drive(h.fx.postSyncControl('/d'));
  check('P5 成功时返回服务端 body（含 mode / logPath）', ok?.mode === 'respawn' && ok?.logPath === LOG, JSON.stringify(ok));
  const sent = h.posts('/d')[0];
  check('P6 以 POST + application/json 发送（服务端写接口要求 JSON，非简单请求须过预检）',
    sent?.headers?.['Content-Type'] === 'application/json' && sent?.body === '{}', JSON.stringify(sent));
}

// ============ R 组：重启 ============
/** 编排一次重启：旧进程还会应答 oldMs，随后 downMs 内连不上，再之后新进程（newPid）上线；newPid 为 null 表示永远起不来。 */
function scheduleRestart(h, { body, oldMs = 1500, downMs = 1000, newPid = 200 }) {
  h.server.posts['/restart'] = () => {
    const at = h.now();
    h.server.health = () => {
      const t = h.now() - at;
      if (t < oldMs) return { ok: true, pid: 100, lanUrls: ['http://192.168.1.8:31919'] };
      if (newPid === null || t < oldMs + downMs) return null;
      return { ok: true, pid: newPid, lanUrls: ['http://192.168.1.8:31919'] };
    };
    return { body };
  };
}
{
  const h = await onlineFixture();
  scheduleRestart(h, { body: { ok: true, mode: 'respawn', logPath: LOG } });
  await h.drive(h.fx.onSyncRestartClick());
  const polls = h.healthCalls();
  const sawOldPid = polls.some(c => c.at > 0 && c.at < 1500);
  check('R1 旧进程还在应答（pid 未变）时不判成功，轮询到新 pid 才判成功',
    sawOldPid && h.toasts.at(-1)?.type === 'success', JSON.stringify({ polls: polls.map(c => c.at), toasts: h.toasts }));
  check('R1b 派生新实例（respawn）成功：提示已转入后台并带日志路径，家目录缩成 ~',
    h.toasts.at(-1)?.message === '同步服务已重启 ✓，已转入后台运行（日志：~/Library/Logs/ShortScraping/sync.log）', JSON.stringify(h.toasts.at(-1)));
  check('R1c 成功后状态栏为「已开启」', h.statusText() === '同步服务：已开启', h.statusText());
}
{
  const h = await onlineFixture();
  scheduleRestart(h, { body: { ok: true, mode: 'launchd', logPath: LOG } });
  await h.drive(h.fx.onSyncRestartClick());
  check('R2 launchd 托管成功：不多提日志（本就写同一份）', h.toasts.at(-1)?.message === '同步服务已重启 ✓'
    && h.toasts.at(-1)?.type === 'success', JSON.stringify(h.toasts.at(-1)));
}
{
  const h = await onlineFixture();
  scheduleRestart(h, { body: { ok: true, mode: 'respawn' } }); // 旧版服务不带 logPath
  await h.drive(h.fx.onSyncRestartClick());
  check('R3 没有 logPath 时沿用原提示', h.toasts.at(-1)?.message === '同步服务已重启 ✓', JSON.stringify(h.toasts.at(-1)));
}
{
  const h = await onlineFixture();
  scheduleRestart(h, { body: { ok: true, mode: 'respawn', logPath: 'D:\\ShortScraping\\logs\\sync.log' } });
  await h.drive(h.fx.onSyncRestartClick());
  check('R4 Windows 路径原样显示', h.toasts.at(-1)?.message === '同步服务已重启 ✓，已转入后台运行（日志：D:\\ShortScraping\\logs\\sync.log）',
    JSON.stringify(h.toasts.at(-1)));
}
{
  const h = await onlineFixture();
  scheduleRestart(h, { body: { ok: true, mode: 'respawn', logPath: LOG }, oldMs: 60000 }); // 旧进程一直在、pid 不变
  await h.drive(h.fx.onSyncRestartClick());
  check('R5 pid 始终不变 → 判失败（旧进程应答不算重启成功）',
    h.toasts.at(-1)?.type === 'error', JSON.stringify(h.toasts.at(-1)));
}
{
  const h = await onlineFixture();
  scheduleRestart(h, { body: { ok: true, mode: 'respawn', logPath: LOG }, newPid: null }); // 新实例启动即崩溃
  const beforeText = h.statusText();
  await h.drive(h.fx.onSyncRestartClick());
  const polls = h.healthCalls().filter(c => c.at > 0);
  check('R6 前提：重启前是「已开启」', beforeText === '同步服务：已开启', beforeText);
  check('R6b 新实例没起来：轮询 10 次（约 10 秒）后收手，再刷新一次状态（共 11 次 /health）', polls.length === 11 && h.now() >= 10000,
    JSON.stringify(polls.map(c => c.at)));
  check('R6c 失败后状态栏刷新为「已关闭」：⏹/🔄 隐藏、▶ 出现、局域网显示未启动',
    h.statusText() === '同步服务：已关闭' && h.hidden('btnSyncStop') && h.hidden('btnSyncRestart')
    && !h.hidden('btnSyncStart') && h.byId.lanShareText.textContent === '未启动' && h.hidden('btnLanQr'),
    JSON.stringify({ text: h.statusText(), lan: h.byId.lanShareText.textContent }));
  check('R6d 失败提示指向日志文件', h.toasts.at(-1)?.type === 'error'
    && h.toasts.at(-1)?.message === '重启后未检测到服务，请查看日志：~/Library/Logs/ShortScraping/sync.log',
    JSON.stringify(h.toasts.at(-1)));
  const { stopBtn, restartBtn } = h.fx.elements.syncService;
  check('R6e 失败后按钮恢复可用', !stopBtn.disabled && !restartBtn.disabled, '');
}
{
  const h = await onlineFixture();
  scheduleRestart(h, { body: { ok: true, mode: 'respawn' }, newPid: null });
  await h.drive(h.fx.onSyncRestartClick());
  check('R7 失败且没有 logPath：沿用原提示，状态栏同样刷新',
    h.toasts.at(-1)?.message === '重启后未检测到服务：请点状态刷新，或手动启动' && h.statusText() === '同步服务：已关闭',
    JSON.stringify({ toast: h.toasts.at(-1), text: h.statusText() }));
}

// ============ S 组：停止 ============
{
  const h = await onlineFixture();
  h.server.posts['/shutdown'] = () => {
    const at = h.now();
    h.server.health = () => (h.now() - at < 1200 ? { ok: true, pid: 100, lanUrls: [] } : null);
    return { body: { ok: true } };
  };
  await h.drive(h.fx.onSyncStopClick());
  check('S1 轮询到 /health 不再应答才判已停止', h.toasts.at(-1)?.message === '同步服务已停止'
    && h.toasts.at(-1)?.type === 'success' && h.statusText() === '同步服务：已关闭', JSON.stringify(h.toasts));
  // 判定停止的那次轮询之后只刷新一次状态栏（2026-09-25 审计 E：此前 waitForSyncService 刷一次、回到
  // onSyncStopClick 又刷一次）。服务 1200ms 后不再应答：1500ms 那次轮询判停，紧跟一次状态刷新
  const afterDown = h.healthCalls().filter(c => c.at >= 1200);
  check('S1b 停止成功后只多一次 /health（刷新状态栏），不重复探测', afterDown.length === 2,
    JSON.stringify(h.healthCalls().map(c => c.at)));
}
{
  const h = await onlineFixture();
  h.server.posts['/shutdown'] = () => ({ body: { ok: true } }); // 回了 ok 却一直在应答
  await h.drive(h.fx.onSyncStopClick());
  check('S2 服务仍在应答 → 错误提示且状态栏如实显示「已开启」',
    h.toasts.at(-1)?.type === 'error' && h.toasts.at(-1)?.message.includes('仍在响应') && h.statusText() === '同步服务：已开启',
    JSON.stringify({ toasts: h.toasts, text: h.statusText() }));
}

// ============ W 组：补喂消息带 /health 指纹 ============
{
  const h = popupFixture();
  h.server.health = () => ({ ok: true, pid: 100, lanUrls: [], contentHash: 'abc123', csvInSync: true });
  await h.drive(h.fx.checkSyncServiceStatus());
  const warm = h.messages.filter(m => m.action === 'warmupCsvSync');
  check('W1 服务健康：补喂消息带上 /health 的 contentHash 与 csvInSync（后台据此比对冷启动指纹）',
    warm.length === 1 && JSON.stringify(warm[0]) === JSON.stringify({ action: 'warmupCsvSync', contentHash: 'abc123', csvInSync: true }),
    JSON.stringify(h.messages));
}
{
  const h = popupFixture();
  h.server.health = () => ({ ok: true, pid: 100, lanUrls: [], contentHash: 'abc123' });
  await h.drive(h.fx.checkSyncServiceStatus());
  const warm = h.messages.filter(m => m.action === 'warmupCsvSync');
  check('W2 /health 没给 csvInSync：按 false 带过去（后台照旧推）',
    warm.length === 1 && warm[0].contentHash === 'abc123' && warm[0].csvInSync === false, JSON.stringify(h.messages));
}
{
  const h = popupFixture(); // 默认 /health 没有 contentHash：旧版同步服务
  await h.drive(h.fx.checkSyncServiceStatus());
  const warm = h.messages.filter(m => m.action === 'warmupCsvSync');
  check('W3 旧版同步服务（/health 没有 contentHash）：补喂消息不带指纹，后台维持强推',
    warm.length === 1 && JSON.stringify(warm[0]) === JSON.stringify({ action: 'warmupCsvSync' }), JSON.stringify(h.messages));
}
{
  const h = popupFixture();
  h.server.health = () => null;
  await h.drive(h.fx.checkSyncServiceStatus());
  check('W4 服务不在：不发补喂消息', !h.messages.some(m => m.action === 'warmupCsvSync'), JSON.stringify(h.messages));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
