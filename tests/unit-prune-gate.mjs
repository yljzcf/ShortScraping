import './bootstrap.cjs';
// SW 唤醒订阅外清理的指纹闸门（v1.6.5）：pruneDramasOutsideConfiguredUrls 每次唤醒都跑，
// 此前无闸门＝每次冷启动把约 5MB 的 dramas 全表反序列化一遍。现在把订阅 URL 集合的
// 指纹持久化在 storage.pruneFingerprint，集合没变就跳过（读一个小键代替读全表）；
// 抓取结束处走 force 强制过一遍（队列缓存必热、零 storage 读），关掉「退订时抓取仍在飞、
// 迟到的 saveDrama 把界外卡写回」的竞态。
// 用法：node tests/unit-prune-gate.mjs
import fs from 'node:fs';
import { background, card, SUB } from './background-fixture.mjs';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

const FP = SUB.replace(/\/+$/, '');   // UrlMatch 尾斜杠归一后的单订阅指纹
const OUT = 'https://other.example/x';
const SUB2 = 'https://store.steampowered.com/category/unit';

const bg = await background();
const getLog = [];
const origGet = bg.context.chrome.storage.local.get;
bg.context.chrome.storage.local.get = async function (keys) { getLog.push(keys); return origGet.call(this, keys); };
const keysOf = k => (typeof k === 'string' ? [k] : Array.isArray(k) ? k : Object.keys(k || {}));
const dramasReads = () => getLog.filter(k => keysOf(k).includes('dramas')).length;
const ids = () => (bg.data.dramas || []).map(d => d.itemId).sort().join(',');
const reload = () => bg.run('loadConfigFromJsonFiles()');
// 直改 data.dramas 前先让队列内存缓存失效（缓存变量是 SW 顶层 let，vm 上下文里可直接赋值）
const seed = (...dramas) => { bg.data.dramas = dramas; bg.run('dramasCache = null'); };
const drainQueue = () => bg.run('dramaWriteQueue');

// ---------- G1 首轮（无指纹）：照常清理并落指纹 ----------
check('G1a 构造时的首轮唤醒已把指纹落库', bg.data.pruneFingerprint === FP, String(bg.data.pruneFingerprint));

delete bg.data.pruneFingerprint;
seed(card('tt0001'), card('tt0002', { sourceListUrl: OUT }));
await reload();
check('G1b 无指纹时界外卡被清理', ids() === 'tt0001', ids());
check('G1c 清理完成后指纹落库', bg.data.pruneFingerprint === FP, String(bg.data.pruneFingerprint));

// ---------- G2 同订阅二次唤醒：零全表读、不触碰表 ----------
seed(card('tt0001'), card('tt0009', { sourceListUrl: OUT }));
getLog.length = 0;
await reload();
check('G2a 订阅集合未变时唤醒零 dramas 全表读', dramasReads() === 0, `reads=${dramasReads()} log=${JSON.stringify(getLog)}`);
check('G2b 闸门命中时不触碰表（界外卡留给抓取结束的强制清理）', ids() === 'tt0001,tt0009', ids());
check('G2c 指纹不变', bg.data.pruneFingerprint === FP, String(bg.data.pruneFingerprint));

// ---------- G4 force：绕过闸门，零 storage 读（缓存热态） ----------
bg.run('dramasCache = null');
getLog.length = 0;
await bg.run(`pruneDramasOutsideConfiguredUrls(${JSON.stringify(bg.data.urlTags)}, { force: true })`);
check('G4a force 绕过闸门清理界外卡', ids() === 'tt0001', ids());
check('G4b force 且集合未变时指纹不重写', bg.data.pruneFingerprint === FP, String(bg.data.pruneFingerprint));

// ---------- G5 onChanged(urlTags) 路径同样受闸门约束 ----------
seed(card('tt0001'), card('tt0010', { sourceListUrl: OUT }));
getLog.length = 0;
bg.listeners.changed({ urlTags: { newValue: bg.data.urlTags } }, 'local');
await drainQueue();
check('G5a 同集合的 onChanged 不读全表', dramasReads() === 0 && ids() === 'tt0001,tt0010', `reads=${dramasReads()} ids=${ids()}`);
bg.listeners.changed({ urlTags: { newValue: [] } }, 'local');
await drainQueue();
check('G5b 集合变为零订阅 → 照常清库（既定语义）并落新指纹', ids() === '' && bg.data.pruneFingerprint === '', `ids=${ids()} fp=${JSON.stringify(bg.data.pruneFingerprint)}`);

// ---------- G3 订阅集合变化：清理 + 指纹更新 ----------
bg.context.fetch = async url => ({ ok: true, async json() { return String(url).endsWith('/tag.json') ? [{ url: SUB2, tags: ['Steam'] }] : {}; } });
seed(card('tt0001'), card('st0001', { source: 'steam', sourceListUrl: SUB2 }));
await reload();
check('G3a 订阅集合变化 → 清理旧订阅的卡', ids() === 'st0001', ids());
check('G3b 指纹更新为新集合', bg.data.pruneFingerprint === SUB2, String(bg.data.pruneFingerprint));

// ---------- G6 静态探针：抓取结束处强制清理（重读最新订阅） ----------
const bgSrc = fs.readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8');
check('G6 performScrapeOnce 结束处 force 清理并重读最新 urlTags',
  bgSrc.includes('pruneDramasOutsideConfiguredUrls(latestUrlTags, { force: true })'), '');

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
