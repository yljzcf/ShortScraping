import './bootstrap.cjs';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SUB = 'https://www.imdb.com/search/title/';
export const card = (itemId, extra = {}) => ({
  id: `id_${itemId}`, itemId, title: 'Fixture', source: 'imdb', sourceListUrl: SUB,
  tags: ['IMDB'], status: 'new', scrapedAt: '2026-09-05T01:00:00.000Z', ...extra
});

export async function background() {
  const data = { dramas: [], urlTags: [{ urlPattern: SUB, tags: ['IMDB'] }], rsEpisodeUrlMigrated: true, legacyDramaMigrated: true };
  const alarms = new Map();
  const listeners = {};
  let now = Date.parse('2026-09-05T00:00:00Z');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, Date: Clock, URL, AbortController,
    structuredClone, TextEncoder, crypto: webcrypto, setTimeout: () => 1, clearTimeout() {},
    chrome: {
      storage: { local: {
        async get(keys) {
          const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
          return Object.fromEntries(ks.filter(k => k in data).map(k => [k, structuredClone(data[k])]));
        },
        async set(values) { Object.assign(data, structuredClone(values)); }
      }, onChanged: { addListener(fn) { listeners.changed = fn; } } },
      runtime: { getURL: p => `chrome-extension://fixture/${p}`, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener(fn) { listeners.message = fn; } } },
      alarms: {
        async get(name) { return alarms.get(name); }, async clear(name) { return alarms.delete(name); },
        create(name, info) { alarms.set(name, { name, ...info, scheduledTime: info.when ?? now + info.periodInMinutes * 60000 }); },
        onAlarm: { addListener(fn) { listeners.alarm = fn; } }
      },
      tabs: { create() {}, onUpdated: { addListener() {}, removeListener() {} } }, notifications: { create() {} }
    },
    fetch: async url => {
      if (!String(url).startsWith('chrome-extension://fixture/config/')) throw new Error('External network disabled in test');
      return { ok: true, async json() { return String(url).endsWith('/tag.json') ? [{ url: SUB, tags: ['IMDB'] }] : {}; } };
    }
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.resolve(root, 'src/background', file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(root, 'src/background/background.js'), 'utf8'), context);
  for (let i = 0; i < 100; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  return { context, data, alarms, listeners, setTime: value => { now = value; }, run: code => vm.runInContext(code, context) };
}
