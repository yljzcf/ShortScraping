// chrome.storage.local 的测试替身：background-fixture 与各套件共用这一份实现，不再每个套件手搓一份。
// 口径尽量贴 Chromium：
//   get 接受 字符串 | 数组 | 默认值对象 | null/undefined（全部键），可带回调（也照样返回 Promise）；
//   set / remove / clear 可带回调也返回 Promise；
//   值按结构化克隆存取——测试或被测代码拿到的对象改了不会回写 storage（直改 data 除外，那是测试的后门）；
//   onChanged 在微任务里派发，只带值真正变化的键（{oldValue,newValue}；新增键没有 oldValue、删除键
//   没有 newValue），写入同值不派发——Chromium 按序列化后的值比较，这里用键序无关的 JSON 比较。
// 时序：tick=0（默认）时 get 在调用当拍取值、set 在调用当拍落盘，与旧 background-fixture 逐拍一致；
// 手搓桩里「先 await Promise.resolve() 再读写」的口径传 tick:1。
// dramas 表的存储键名只出现在本文件的 DRAMAS_KEY 与几个 dramas 访问器里：日后按站点分片换键时
// 只改这里，套件一律经 seedDramas / dramas / dramasReadCount / writesDramas 访问，不直写键名。

const DRAMAS_KEY = 'dramas';
const FAIL_MESSAGE = 'unit stub: 注入的 set 失败';

const clone = value => structuredClone(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// 键序无关的规范化 JSON：判断「值是否真的变了」。Chromium 存的是序列化后的值，undefined 字段
// 本来就不落盘，所以 JSON 口径与它一致
const canonical = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]]))
  : v));
const sameValue = (a, b) => canonical(a) === canonical(b);

/** get 的键参数 → 键名数组；null 表示「全部键」。 */
function keyList(keys) {
  if (keys === null || keys === undefined) return null;
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys.map(String);
  if (typeof keys === 'object') return Object.keys(keys);
  throw new TypeError(`storage.get 不接受 ${typeof keys} 类型的键参数`);
}

/** 带回调时回调收结果（返回的 Promise 也 resolve 同一结果）；失败时回调不带参数、错误记在
 *  store.lastError（Chromium 放 runtime.lastError），Promise 此时 resolve undefined 而不 reject，
 *  免得调用方只传了回调却冒出未处理拒绝。 */
function settle(promise, callback, store) {
  if (typeof callback !== 'function') return promise;
  return promise.then(
    result => { callback(result); return result; },
    error => { store.lastError = error; callback(); return undefined; }
  );
}

/**
 * @param {object} seed 初始内容（结构化克隆后写入，不记日志、不派发）
 * @param {object} opts
 *   log             数组：每次 set 落盘时推 `set:k1,k2`、remove 推 `remove:k1,k2`、clear 推 `clear`
 *                   （background-fixture 把它和 fetch / alarm / tab 记在同一条日志里比先后）
 *   tick            get/set/remove/clear 生效前让出的微任务数，默认 0
 *   dispatchChanges onChanged 是否派发，默认 true（background-fixture 默认关，保持它历来不派发的行为）
 *   area            派发给监听器的 areaName，默认 'local'
 */
export function createChromeStorage(seed = {}, opts = {}) {
  const { log = null, tick = 0, dispatchChanges = true, area = 'local' } = opts;
  const data = {};
  const reads = [];
  const listeners = new Set();
  const failHooks = [];
  const pauseHooks = [];
  // 只在 tick>0 时调用：tick=0 若也 await 一次空 Promise，就比旧 fixture 多让出一拍
  const yieldTicks = async () => { for (let i = 0; i < tick; i++) await Promise.resolve(); };

  const takeHook = (hooks, values) => {
    const index = hooks.findIndex(hook => hook.pred(values));
    return index < 0 ? null : hooks.splice(index, 1)[0];
  };

  const dispatch = changes => {
    if (!dispatchChanges || !Object.keys(changes).length) return;
    queueMicrotask(() => {
      let firstError = null;
      for (const fn of [...listeners]) {
        try { fn(clone(changes), area); } catch (e) { firstError ??= e; }
      }
      if (firstError) throw firstError; // 其余监听器照常收到后再抛，让测试进程带栈失败
    });
  };

  const commitSet = values => {
    const keys = Object.keys(values);
    if (log) log.push(`set:${keys.join(',')}`);
    const changes = {};
    if (dispatchChanges) {
      for (const key of keys) {
        if (!hasOwn(data, key)) changes[key] = { newValue: clone(values[key]) };
        else if (!sameValue(data[key], values[key])) changes[key] = { oldValue: clone(data[key]), newValue: clone(values[key]) };
      }
    }
    Object.assign(data, values);
    dispatch(changes);
  };

  const commitRemove = (keys, entry) => {
    if (log) log.push(entry);
    const changes = {};
    for (const key of keys) {
      if (!hasOwn(data, key)) continue;
      if (dispatchChanges) changes[key] = { oldValue: clone(data[key]) };
      delete data[key];
    }
    dispatch(changes);
  };

  const pick = keys => {
    const list = keyList(keys);
    const defaults = keys && typeof keys === 'object' && !Array.isArray(keys) ? keys : null;
    const out = {};
    for (const key of list ?? Object.keys(data)) {
      if (hasOwn(data, key)) out[key] = clone(data[key]);
      else if (defaults) out[key] = clone(defaults[key]);
    }
    return out;
  };

  // 这些 async 函数在 tick=0 且没有钩子时一次 await 都不走：取值 / 落盘发生在调用当拍
  async function readNow(keys) {
    reads.push(keyList(keys));
    if (tick) await yieldTicks();
    return pick(keys);
  }

  async function writeNow(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('storage.set 需要一个对象');
    const snapshot = clone(values); // 调用当拍定格（Chromium 在调用时就序列化了）
    const fail = takeHook(failHooks, snapshot);
    if (fail) throw fail.error;
    const pause = takeHook(pauseHooks, snapshot);
    if (pause) {
      pause.reached(snapshot);
      await pause.gate;
    }
    if (tick) await yieldTicks();
    commitSet(snapshot);
  }

  async function removeNow(keys) {
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys.map(String) : null;
    if (!list) throw new TypeError('storage.remove 需要字符串或字符串数组');
    if (tick) await yieldTicks();
    commitRemove(list, `remove:${list.join(',')}`);
  }

  async function clearNow() {
    if (tick) await yieldTicks();
    commitRemove(Object.keys(data), 'clear');
  }

  const store = {
    data,
    /** 每次 get 请求的键名数组（null＝读全部键），调用当拍记录；清零用 reads.length = 0。 */
    reads,
    log,
    lastError: null,
    local: {
      get(keys, callback) {
        if (typeof keys === 'function') { callback = keys; keys = null; }
        return settle(readNow(keys), callback, store);
      },
      set(values, callback) { return settle(writeNow(values), callback, store); },
      remove(keys, callback) { return settle(removeNow(keys), callback, store); },
      clear(callback) { return settle(clearNow(), callback, store); }
    },
    onChanged: {
      addListener(fn) { listeners.add(fn); },
      removeListener(fn) { listeners.delete(fn); },
      hasListener(fn) { return listeners.has(fn); }
    },
    /** 请求过该键的 get 次数（get(null) 读全部键，也算）。 */
    readCount(key) {
      return reads.filter(list => list === null || list.includes(key)).length;
    },
    /**
     * 下一次满足 pred(values) 的 set 抛错、不落盘（values 是那次 set 的克隆）。可连续布置多个，
     * 按布置顺序各消耗一次。error 可给 Error 或文案。
     */
    failNextSet(pred = () => true, error = FAIL_MESSAGE) {
      failHooks.push({ pred, error: error instanceof Error ? error : new Error(String(error)) });
    },
    /**
     * 下一次满足 pred(values) 的 set 卡在落盘前，模拟「读改写」的写回窗口。
     * 返回 { reached, release }：reached 在那次 set 卡住时 resolve（值为它要写的内容），
     * release() 放行；先 release 再到达的那次 set 不停直接过。
     */
    pauseNextSet(pred = () => true) {
      let release;
      let reached;
      const gate = new Promise(resolve => { release = resolve; });
      const reachedPromise = new Promise(resolve => { reached = resolve; });
      pauseHooks.push({ pred, gate, reached });
      return { reached: reachedPromise, release: () => release() };
    },
    /** 直写 data（结构化克隆，不记日志、不派发 onChanged）：等价于 SW 启动前 storage 已是这个样子。 */
    seed(values = {}) {
      Object.assign(data, clone(values));
    },
    /** 直写 dramas 表（结构化克隆，不记日志、不派发）；传 undefined 删掉这个键（从未写过）。 */
    seedDramas(list) {
      if (list === undefined) delete data[DRAMAS_KEY];
      else data[DRAMAS_KEY] = clone(list);
    },
    /** 当前 dramas 表：storage 里的活引用（只读约定），从未写过时为 undefined。 */
    dramas() {
      return data[DRAMAS_KEY];
    },
    /** 请求过 dramas 表的 get 次数。 */
    dramasReadCount() {
      return store.readCount(DRAMAS_KEY);
    },
    /** 这次 set 是否写了 dramas 表：给 failNextSet / pauseNextSet 当 pred 用。 */
    writesDramas(values) {
      return Boolean(values) && hasOwn(values, DRAMAS_KEY);
    }
  };
  store.seed(seed ?? {});
  return store;
}
