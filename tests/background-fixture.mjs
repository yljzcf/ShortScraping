import './bootstrap.cjs';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SUB = 'https://www.imdb.com/search/title/';
// 扩展页面发送方（设置页以标签页打开，Chrome 给的 sender 带 tab）：后台 onMessage 只对扩展页面放行特权动作
export const PAGE_SENDER = { id: 'fixture', url: 'chrome-extension://fixture/src/settings/settings.html', tab: { id: 1 } };
export const card = (itemId, extra = {}) => ({
  id: `id_${itemId}`, itemId, title: 'Fixture', source: 'imdb', sourceListUrl: SUB,
  tags: ['IMDB'], status: 'new', scrapedAt: '2026-09-05T01:00:00.000Z', ...extra
});

// 选项：data 覆盖初始 storage；settle:false 在顶层代码刚执行完（顶层初始化仍在飞）时就返回，
// 供「SW 为分发 onInstalled/onStartup 而启动」的场景在初始化落定前派发事件。
// log 按发生顺序记 fetch / storage.set / alarms.create / tabs.create，供断言先后与次数。
// fetch(url, options)：外网请求的替身，返回 undefined 则落回默认行为（config/ 读文件，其余抛错）；
// 可返回永不 resolve 的 promise 模拟「请求挂住」。
export async function background({ data: seed = {}, settle = true, fetch: fetchOverride = null } = {}) {
  const data = { dramas: [], urlTags: [{ urlPattern: SUB, tags: ['IMDB'] }], rsEpisodeUrlMigrated: true, legacyDramaMigrated: true, ...seed };
  const alarms = new Map();
  const listeners = {};
  const log = [];
  let now = Date.parse('2026-09-05T00:00:00Z');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, Date: Clock, URL, AbortController, AbortSignal,
    structuredClone, TextEncoder, crypto: webcrypto, setTimeout: () => 1, clearTimeout() {},
    chrome: {
      storage: { local: {
        async get(keys) {
          const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
          return Object.fromEntries(ks.filter(k => k in data).map(k => [k, structuredClone(data[k])]));
        },
        async set(values) { log.push(`set:${Object.keys(values).join(',')}`); Object.assign(data, structuredClone(values)); }
      }, onChanged: { addListener(fn) { listeners.changed = fn; } } },
      runtime: { id: 'fixture', getURL: p => `chrome-extension://fixture/${p}`, onInstalled: { addListener(fn) { listeners.installed = fn; } }, onStartup: { addListener(fn) { listeners.startup = fn; } }, onMessage: { addListener(fn) { listeners.message = fn; } } },
      alarms: {
        async get(name) { return alarms.get(name); }, async clear(name) { return alarms.delete(name); },
        create(name, info) { log.push(`alarm:${name}`); alarms.set(name, { name, ...info, scheduledTime: info.when ?? now + info.periodInMinutes * 60000 }); },
        onAlarm: { addListener(fn) { listeners.alarm = fn; } }
      },
      tabs: { create(info) { log.push(`tab:${info?.url}`); }, onUpdated: { addListener() {}, removeListener() {} } }, notifications: { create() {} }
    },
    fetch: async (url, options) => {
      log.push(`fetch:${url}`);
      const overridden = fetchOverride?.(url, options);
      if (overridden !== undefined) return overridden;
      if (!String(url).startsWith('chrome-extension://fixture/config/')) throw new Error('External network disabled in test');
      return { ok: true, async json() { return String(url).endsWith('/tag.json') ? [{ url: SUB, tags: ['IMDB'] }] : {}; } };
    }
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.resolve(root, 'src/background', file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(root, 'src/background/background.js'), 'utf8'), context);
  const bg = { context, data, alarms, listeners, log, setTime: value => { now = value; }, run: code => vm.runInContext(code, context) };
  if (!settle) return bg;
  for (let i = 0; i < 100; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  return bg;
}
