import './bootstrap.cjs';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { createChromeStorage } from './storage-stub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SUB = 'https://www.imdb.com/search/title/';
// 扩展页面发送方（设置页以标签页打开，Chrome 给的 sender 带 tab）：后台 onMessage 只对扩展页面放行特权动作
export const PAGE_SENDER = { id: 'fixture', url: 'chrome-extension://fixture/src/settings/settings.html', tab: { id: 1 } };
export const card = (itemId, extra = {}) => ({
  id: `id_${itemId}`, itemId, title: 'Fixture', source: 'imdb', sourceListUrl: SUB,
  tags: ['IMDB'], status: 'new', scrapedAt: '2026-09-05T01:00:00.000Z', ...extra
});

// 顶层初始化 / 定时器回调之间让在飞的 promise 链走完：100 拍微任务 + 一轮 setImmediate（fetch 桩等宏任务）
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
};

/**
 * 可控时钟上的 setTimeout / clearTimeout：定时器只在 advance / runAll 时按到期先后触发，
 * 触发前把时钟拨到它的到期时刻（回调里 Date.now() 就是到期时刻），每个回调之后 flush 一遍，
 * 让它引出的 await 链与新定时器落定。clock = { now(), set(ms) }。
 */
export function createManualTimers(clock, { limit = 10000 } = {}) {
  const pending = new Map();
  let seq = 0;
  const setTimeout = (fn, ms, ...args) => {
    const id = ++seq; // 从 1 起：后台用 `if (csvSyncTimer)` 判定时器在不在，id 须为真值
    const delay = Math.max(0, Number(ms) || 0);
    pending.set(id, { id, due: clock.now() + delay, delay, fn, args });
    return id;
  };
  const clearTimeout = id => { pending.delete(id); };
  const earliest = until => {
    let best = null;
    for (const t of pending.values()) {
      if (t.due <= until && (!best || t.due < best.due || (t.due === best.due && t.id < best.id))) best = t;
    }
    return best;
  };
  const fire = async t => {
    pending.delete(t.id);
    if (t.due > clock.now()) clock.set(t.due);
    if (typeof t.fn === 'function') t.fn(...t.args);
    await flush();
  };
  // 自我续期的定时器（如 SW 保活）会让 runAll 排不空：超过 limit 个就抛错，而不是死循环
  const drain = async (until, label) => {
    await flush(); // 先让调用方刚引出的 await 链把定时器挂上
    let fired = 0;
    for (let t = earliest(until); t; t = earliest(until)) {
      if (++fired > limit) throw new Error(`${label} 触发了 ${limit} 个定时器仍未排空（可能有自我续期的定时器）`);
      await fire(t);
    }
    return fired;
  };
  return {
    setTimeout,
    clearTimeout,
    /** 时钟前进 ms，其间到期的定时器按先后触发；返回触发个数。 */
    async advance(ms = 0) {
      const target = clock.now() + Math.max(0, Number(ms) || 0);
      const fired = await drain(target, `advance(${ms})`);
      if (clock.now() < target) clock.set(target);
      return fired;
    },
    /** 触发全部定时器（含回调里新挂的），时钟停在最后一个的到期时刻；返回触发个数。 */
    runAll() { return drain(Infinity, 'runAll()'); },
    /** 还没触发的定时器：[{ id, delay, dueIn }]，按到期先后。 */
    pending() {
      return [...pending.values()]
        .sort((a, b) => a.due - b.due || a.id - b.id)
        .map(({ id, delay, due }) => ({ id, delay, dueIn: due - clock.now() }));
    }
  };
}

// 选项（全部可选，缺省即历来行为）：
//   data     覆盖初始 storage；dramas 另给时经 seedDramas 种表（默认空表），data 里显式带 dramas 的旧写法照旧生效。
//   settle   false 在顶层代码刚执行完（顶层初始化仍在飞）时就返回，供「SW 为分发 onInstalled/onStartup
//            而启动」的场景在初始化落定前派发事件。
//   fetch(url, options)  外网请求的替身，返回 undefined 则落回默认行为（config/ 读文件，其余抛错）；
//            可返回永不 resolve 的 promise 模拟「请求挂住」。
//   timers   'noop'（默认：setTimeout 不执行、返回 1）| 'manual'（可控时钟，bg.timers.advance / runAll /
//            pending，与 Date 共用一个时钟）| 'real'（Node 真定时器；Date 仍是固定时钟，只随 setTime 走；
//            后台的防抖 / 保活定时器会真跑，套件结束前自己收尾）。
//   translator  Translator 替身对象：给了就不加载真实 translator.js（importScripts 按子串跳过），
//            后台调用时解析到它。事后也可直接改 bg.context.Translator。
//   storage  透传给 createChromeStorage 的选项（如 { tick: 1 }、{ dispatchChanges: true }）；
//            log 固定是 bg.log，onChanged 缺省不派发（历来如此，测试自己调 bg.listeners.changed）。
//   dnr      chrome.declarativeNetRequest 桩（v1.7.4 固定英文页规则）：true 时动态规则存进 bg.dnr.rules（id → 规则），
//            每次 updateDynamicRules 的参数记进 bg.dnr.calls；与 Chrome 一样，加一条 id 已存在的规则会 reject。
//            'reject' 时 updateDynamicRules 一律 reject。缺省不提供这个 API（历来如此，后台按「不可用」处理）。
// log 按发生顺序记 fetch / storage.set（落盘时）/ storage.remove / alarms.create / tabs.create，供断言先后与次数。
export async function background({
  data: seed = {}, dramas = [], settle = true, fetch: fetchOverride = null,
  timers = 'noop', translator = null, storage: storageOpts = {}, dnr: dnrMode = false
} = {}) {
  const alarms = new Map();
  const listeners = {};
  const log = [];
  const injected = [];
  const dnr = { rules: new Map(), calls: [] };
  const declarativeNetRequest = {
    async updateDynamicRules(options = {}) {
      dnr.calls.push(structuredClone(options));
      if (dnrMode === 'reject') throw new Error('fixture: updateDynamicRules rejected');
      const next = new Map(dnr.rules);
      for (const id of options.removeRuleIds || []) next.delete(id);
      for (const rule of options.addRules || []) {
        if (next.has(rule.id)) throw new Error(`Rule with id ${rule.id} does not have a unique ID.`);
        next.set(rule.id, structuredClone(rule));
      }
      dnr.rules = next;
    },
    async getDynamicRules() { return [...dnr.rules.values()].map(rule => structuredClone(rule)); }
  };
  const store = createChromeStorage({}, { dispatchChanges: false, ...storageOpts, log });
  store.seedDramas(dramas);
  store.seed({ urlTags: [{ urlPattern: SUB, tags: ['IMDB'] }], rsEpisodeUrlMigrated: true, legacyDramaMigrated: true, ...seed });
  const data = store.data;
  let now = Date.parse('2026-09-05T00:00:00Z');
  const clock = { now: () => now, set: value => { now = value; } };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  let manual = null;
  let timerGlobals;
  if (timers === 'noop') timerGlobals = { setTimeout: () => 1, clearTimeout() {} };
  else if (timers === 'manual') {
    manual = createManualTimers(clock);
    timerGlobals = { setTimeout: manual.setTimeout, clearTimeout: manual.clearTimeout };
  } else if (timers === 'real') timerGlobals = { setTimeout, clearTimeout };
  else throw new TypeError(`timers 只能是 'noop' | 'manual' | 'real'，收到 ${timers}`);
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, Date: Clock, URL, AbortController, AbortSignal,
    structuredClone, TextEncoder, TextDecoder, Blob, performance, crypto: webcrypto, ...timerGlobals,
    chrome: {
      storage: {
        local: store.local,
        // 历来暴露 bg.listeners.changed 供测试手动派发；storage.dispatchChanges 打开时 stub 也会自动派发
        onChanged: {
          addListener(fn) { listeners.changed = fn; store.onChanged.addListener(fn); },
          removeListener(fn) { store.onChanged.removeListener(fn); if (listeners.changed === fn) delete listeners.changed; },
          hasListener(fn) { return store.onChanged.hasListener(fn); }
        }
      },
      runtime: { id: 'fixture', getURL: p => `chrome-extension://fixture/${p}`, onInstalled: { addListener(fn) { listeners.installed = fn; } }, onStartup: { addListener(fn) { listeners.startup = fn; } }, onMessage: { addListener(fn) { listeners.message = fn; } } },
      alarms: {
        async get(name) { return alarms.get(name); }, async clear(name) { return alarms.delete(name); },
        create(name, info) { log.push(`alarm:${name}`); alarms.set(name, { name, ...info, scheduledTime: info.when ?? now + info.periodInMinutes * 60000 }); },
        onAlarm: { addListener(fn) { listeners.alarm = fn; } }
      },
      tabs: { create(info) { log.push(`tab:${info?.url}`); }, onUpdated: { addListener() {}, removeListener() {} } }, notifications: { create() {} },
      // 兜底注入的替身：记下每次调用的参数（bg.injected），不真注入；要模拟注入效果的套件自己整个替换
      scripting: { async executeScript(options) { injected.push(options); return []; } },
      ...(dnrMode ? { declarativeNetRequest } : {})
    },
    fetch: async (url, options) => {
      log.push(`fetch:${url}`);
      const overridden = fetchOverride?.(url, options);
      if (overridden !== undefined) return overridden;
      if (!String(url).startsWith('chrome-extension://fixture/config/')) throw new Error('External network disabled in test');
      return { ok: true, async json() { return String(url).endsWith('/tag.json') ? [{ url: SUB, tags: ['IMDB'] }] : {}; } };
    }
  });
  if (translator) context.Translator = translator;
  context.importScripts = (...files) => files.forEach(file => {
    if (translator && file.includes('translator')) return; // 注入了替身：真实 translator.js 不加载，免得覆盖
    vm.runInContext(fs.readFileSync(path.resolve(root, 'src/background', file), 'utf8'), context);
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/background/background.js'), 'utf8'), context);
  const run = code => vm.runInContext(code, context);
  const bg = {
    context, data, alarms, listeners, log, storage: store, injected, timers: manual, dnr,
    setTime: value => { now = value; }, run, flush,
    /** 当前 dramas 表（storage 里的活引用，只读约定）。 */
    dramas: () => store.dramas(),
    /** 直改 storage 里的 dramas 表并让队列内存缓存失效：等价于 SW 冷启动前 storage 被外部改写。 */
    seedDramas(list) { store.seedDramas(list); run('dramasCache = null'); },
    /**
     * 让后台 dramas 内存缓存失效（下次队列操作重读 storage）。当拍即置空，另在已入队的写都
     * 提交后再置空一次：在飞的写提交时会把缓存指回它写的表。需要后者时 await。
     */
    resetDramasCache() {
      run('dramasCache = null');
      return run('dramaWriteQueue').then(() => { run('dramasCache = null'); });
    },
    /**
     * 以 sender 身份（缺省扩展页面）给后台发一条消息，resolve 为 sendResponse 收到的应答。
     * 监听器没保留异步通道（没 return true）且没当拍应答时按 Chrome 关端口处理，resolve undefined；
     * 保留了通道却 10 秒不应答则 reject，免得套件挂到 run.mjs 的 60 秒强杀。
     */
    send(message, sender = PAGE_SENDER) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) { settled = true; reject(new Error(`send(${message?.action}) 10 秒内无应答`)); }
        }, 10000);
        const done = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        let keepOpen;
        try {
          keepOpen = listeners.message(message, sender, done);
        } catch (e) {
          settled = true;
          clearTimeout(timer);
          reject(e);
          return;
        }
        if (keepOpen !== true) done(undefined);
      });
    }
  };
  if (!settle) return bg;
  await flush();
  return bg;
}
