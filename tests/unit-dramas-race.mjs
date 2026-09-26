import './bootstrap.cjs';
// dramas 表并发写竞态回归测试（确定性交错，非碰运气）。
// 复现 2026-07-09 DramaShorts e2e 丢卡：翻译线「get 全表 → 改 → set 全表」窗口内，
// 内容脚本 saveSingleDrama 写入的新卡被整表写回覆盖。
// 用法：node tests/unit-dramas-race.mjs
//   修复前（内容脚本直写 storage、后台无单写者队列）：T1-T5 应大面积 FAIL（RED）
//   修复后（所有 dramas 写操作收敛后台队列串行）：全部 PASS（GREEN）
import fs from 'node:fs';
import { background } from './background-fixture.mjs';

// 后台走共用 background-fixture（v1.6.20 起不再手搓 chrome 桩）。发送方按真实弹窗构造（扩展页面、不带 tab），
// 与改造前手搓 runtime.sendMessage 桩给的身份一致
const POPUP_SENDER = { id: 'fixture', url: 'chrome-extension://fixture/src/popup/popup.html' };
const bg = await background({
  // 真定时器：用例靠 sleep 让出「竞态窗口」；tick:1 保持手搓桩「让出一拍再读写」的时序
  timers: 'real',
  storage: { tick: 1 },
  fetch: () => { throw new TypeError('unit stub: no network'); }
});
const { updateSingleDramaTranslation, clearAllDramas } = bg.context; // 后台顶层函数声明＝vm 上下文全局属性
const send = (message) => bg.send(message, POPUP_SENDER);

// ---------- 加载内容脚本侧的真实代码 ----------
// content.js 的 saveSingleDrama：按 unit-buildurl.mjs 范式提取函数源码。内容脚本与 SW 不在同一 realm，
// 它跑在外层，调的 chrome.runtime.sendMessage 由这里转给后台 onMessage（fixture 上下文里的 SW
// 自己没有 sendMessage：真实 SW 收不到自己发的消息）。storage.local 与 SW 共用同一份（Chrome 里
// 内容脚本与后台读写的是同一个存储区），修复前「内容脚本直写 storage」的实现照样能跑出 RED
globalThis.chrome = { runtime: { sendMessage: send }, storage: { local: bg.storage.local } };
const contentSrc = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const saveFnSrc = contentSrc.match(/async function saveSingleDrama\(drama\) \{[\s\S]*?\n  \}/)?.[0];
if (!saveFnSrc) { console.log('FAIL  无法从 content.js 提取 saveSingleDrama'); process.exit(1); }
const contentSaveSingleDrama = (0, eval)(`(${saveFnSrc.replace('async function saveSingleDrama', 'async function')})`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(150); // 等后台顶层初始化（配置回退 + prune/migrate 空跑）落定

const mk = (n, itemId) => ({
  id: `id-${n}`, itemId, title: `Title ${n}`, description: `desc ${n}`,
  status: 'new', source: 'unittest', sourceListUrl: 'https://unit.test/list'
});
// v1.5.1 起后台队列持有 dramas 内存缓存（生产写路径全收口队列内）。测试直改
// storage 里的 dramas 表等价于「SW 冷启动前 storage 被外部改写」，须先等在飞的队列写
// 落定、让缓存失效，模拟冷启动首读（bg.resetDramasCache），再种表。
const seedDramas = async (list) => {
  await bg.resetDramasCache();
  bg.seedDramas(list);
};
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ---------- T1 后台提供 saveDrama 消息接口（含权威去重） ----------
{
  await seedDramas([]);
  const first = await send({ action: 'saveDrama', drama: mk('x', 'tt0100') });
  const dup = await send({ action: 'saveDrama', drama: mk('x2', 'tt0100') });
  check('T1a saveDrama 首次保存成功', first?.success === true && first?.saved === true, JSON.stringify(first));
  check('T1b saveDrama 重复 itemId 拒绝', dup?.success === true && dup?.saved === false, JSON.stringify(dup));
  check('T1c 表内恰好 1 条', (bg.dramas() || []).length === 1, `len=${(bg.dramas() || []).length}`);
  check('T1d 保存后 lastScrape 已更新', typeof bg.data.lastScrape === 'string', String(bg.data.lastScrape));
}

// ---------- T2 核心竞态：翻译线 get/set 窗口内保存的新卡不得丢失 ----------
{
  await seedDramas([mk('A', 'tt0001')]);
  const { reached, release } = bg.storage.pauseNextSet(); // 下一次 set 卡在写回一步，模拟并行窗口
  const p1 = updateSingleDramaTranslation('id-A', { title: '甲', desc: '甲简介' });
  await reached;                                   // 翻译线已完成 get、卡在 set
  const p2 = contentSaveSingleDrama(mk('B', 'tt0002')); // 内容脚本此刻保存新卡
  await sleep(80);
  release();                                       // 翻译线写回
  const [updated, saved] = await Promise.all([p1, p2.catch(e => `threw:${e.message}`)]);
  const dramas = bg.dramas() || [];
  const cardA = dramas.find(d => d.itemId === 'tt0001');
  check('T2a 竞态窗口内保存的新卡未丢失', dramas.some(d => d.itemId === 'tt0002'), `dramas=${dramas.map(d => d.itemId).join(',')}`);
  check('T2b 翻译结果同时生效', updated?.done === true && cardA?.titleZh === '甲' && cardA?.status === 'trans', JSON.stringify({ updated, cardA }));
  check('T2c 两卡俱在', dramas.length === 2, `len=${dramas.length} saved=${JSON.stringify(saved)}`);
}

// ---------- T3 并发双保存同 itemId：只入一条，且只有一次 saved=true ----------
{
  await seedDramas([]);
  const { release } = bg.storage.pauseNextSet();
  const p1 = contentSaveSingleDrama(mk('C1', 'tt0003'));
  const p2 = contentSaveSingleDrama(mk('C2', 'tt0003'));
  await sleep(80);
  release();
  const flags = await Promise.all([p1, p2].map(p => p.catch(e => `threw:${e.message}`)));
  const count = (bg.dramas() || []).filter(d => d.itemId === 'tt0003').length;
  check('T3a 同 itemId 并发保存只入一条', count === 1, `count=${count}`);
  check('T3b 恰好一次 saved=true', flags.filter(f => f === true).length === 1 && flags.filter(f => f === false).length === 1, JSON.stringify(flags));
}

// ---------- T4 单卡翻译落库走队列（applyTranslation 入口已于 2026-09-25 删除，直接调队列内写入） ----------
{
  await seedDramas([mk('D', 'tt0004')]);
  const updated = await updateSingleDramaTranslation('id-D', { title: '丁', desc: '丁简介' });
  const cardD = (bg.dramas() || []).find(d => d.itemId === 'tt0004');
  check('T4a updateSingleDramaTranslation 收口成功', updated?.done === true, JSON.stringify(updated));
  check('T4b 翻译字段落库', cardD?.titleZh === '丁' && cardD?.descriptionZh === '丁简介' && cardD?.status === 'trans', JSON.stringify(cardD));
}

// ---------- T5 清空路径：弹窗消息接口已移除（v1.3.3 改「全部翻译」），安装初始化函数仍走队列 ----------
{
  await seedDramas([mk('E', 'tt0005')]);
  bg.data.lastScrape = '2026-07-09T00:00:00.000Z';
  const resp = await send({ action: 'clearDramas' });
  check('T5a clearDramas 消息接口已移除', resp === undefined, JSON.stringify(resp));
  await clearAllDramas(); // 安装初始化路径保留
  check('T5b clearAllDramas 清空且时间戳复位', Array.isArray(bg.dramas()) && bg.dramas().length === 0 && bg.data.lastScrape === null, JSON.stringify({ dramas: bg.dramas(), lastScrape: bg.data.lastScrape }));
}

// ---------- T6 genres 回填合并（v1.5.3）：去重命中只补缺失的 genres、其余字段不动 ----------
{
  await seedDramas([mk('F', 'tt0006')]);
  bg.data.lastScrape = '2026-01-01T00:00:00.000Z';
  const before = structuredClone(bg.dramas()[0]);
  const resp = await send({ action: 'saveDrama',
    drama: { ...mk('F2', 'tt0006'), title: 'HIJACK', status: 'trans', genres: [' Romance ', '', 'Romance', 'Mystery'] } });
  const card = (bg.dramas() || []).find(d => d.itemId === 'tt0006');
  check('T6a 回填响应仍 saved=false（非新增）', resp?.success === true && resp?.saved === false, JSON.stringify(resp));
  check('T6b genres 已补写（trim/去空/去重）', JSON.stringify(card?.genres) === JSON.stringify(['Romance', 'Mystery']), JSON.stringify(card?.genres));
  check('T6c 其余字段逐键不动（先到先得语义）',
    card?.id === before.id && card?.title === before.title && card?.status === before.status && card?.description === before.description,
    JSON.stringify(card));
  check('T6d 回填不刷新 lastScrape', bg.data.lastScrape === '2026-01-01T00:00:00.000Z', String(bg.data.lastScrape));
  const snapshot = JSON.stringify(bg.dramas());
  const again = await send({ action: 'saveDrama', drama: { ...mk('F3', 'tt0006'), genres: ['Other'] } });
  check('T6e 已有 genres 二次提交零改动（幂等）', again?.saved === false && JSON.stringify(bg.dramas()) === snapshot, JSON.stringify(bg.dramas()));
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
