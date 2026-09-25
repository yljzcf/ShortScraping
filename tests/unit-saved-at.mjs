import './bootstrap.cjs';
// 入库时刻 savedAt 回归测试（批次 B6 后台一半，审查 lark-export-watermark-gap）。
// 多维表格增量导出按 savedAt || scrapedAt 比水位线（Lark.exportStamp）：scrapedAt 是内容脚本
// 提取列表时定的，要等详情补抓完才入库，复制恰好落在这几秒里的卡会被水位线永久挡掉。
// 契约：savedAt 只由 saveDramaRecord 在新卡首次入库时写（此刻，覆盖调用方传来的值）；
// 去重命中 / 翻译回写 / 导入恢复都不写、不改（导入补回的旧条目可能早已导进 Base，不重导）。
// 用法：node tests/unit-saved-at.mjs
import { background, card } from './background-fixture.mjs';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const T0 = Date.parse('2026-09-05T02:00:00.000Z');
const T1 = Date.parse('2026-09-05T03:00:00.000Z');
const byItem = (bg, itemId) => bg.data.dramas.find(d => d.itemId === itemId);

const bg = await background();

// S1 新卡入库写 savedAt＝入库时刻（晚于内容脚本提取时写的 scrapedAt）
bg.setTime(T0);
bg.context.fresh = card('tt1');          // scrapedAt 2026-09-05T01:00Z
const saved = await bg.run('saveDramaRecord(fresh)');
const s1 = byItem(bg, 'tt1');
check('S1a 新卡入库成功', saved === true && Boolean(s1), JSON.stringify(s1));
check('S1b 新卡写 savedAt＝入库时刻，scrapedAt 原样保留',
  s1?.savedAt === new Date(T0).toISOString() && s1?.scrapedAt === '2026-09-05T01:00:00.000Z', JSON.stringify(s1));
check('S1c lastScrape 与 savedAt 同一时刻', bg.data.lastScrape === s1?.savedAt, String(bg.data.lastScrape));
check('S1d 不改调用方传入的对象（入库的是副本）', !('savedAt' in bg.context.fresh), JSON.stringify(bg.context.fresh));

// S2 调用方（内容脚本 saveDrama 消息）传来的 savedAt 不可信，一律覆盖
bg.setTime(T1);
const viaMessage = await new Promise(resolve => bg.listeners.message(
  { action: 'saveDrama', drama: card('tt2', { savedAt: '2020-01-01T00:00:00.000Z' }) }, {}, resolve));
check('S2 经 saveDrama 消息入库：外来 savedAt 被入库时刻覆盖',
  viaMessage?.saved === true && byItem(bg, 'tt2')?.savedAt === new Date(T1).toISOString(), JSON.stringify(byItem(bg, 'tt2')));

// S3 去重命中（含 genres 回填写回）不动已有卡的 savedAt；无 savedAt 的旧条目也不补写
bg.setTime(T1 + 3600000);
bg.context.again = card('tt1', { genres: ['Romance'] });
const dup = await bg.run('saveDramaRecord(again)');
const s3 = byItem(bg, 'tt1');
check('S3a 去重命中且 genres 回填：savedAt 保持首次入库时刻',
  dup === false && s3?.genres?.[0] === 'Romance' && s3?.savedAt === new Date(T0).toISOString(), JSON.stringify(s3));
bg.context.fixture = [card('legacy1')];
await bg.run('importDramaRecords(fixture)');
bg.context.legacyAgain = card('legacy1', { genres: ['Drama'] });
await bg.run('saveDramaRecord(legacyAgain)');
const legacy = byItem(bg, 'legacy1');
check('S3b 旧条目（无 savedAt）被去重命中回填 genres 时不补写 savedAt',
  legacy?.genres?.[0] === 'Drama' && !('savedAt' in legacy), JSON.stringify(legacy));

// S4 导入恢复不写 savedAt：补回的旧条目按原 scrapedAt 落窗口，不因「此刻导入」被重新导出
bg.context.fixture = [card('imp1'), card('imp2', { status: 'trans', titleZh: '中文' })];
const imported = await bg.run('importDramaRecords(fixture)');
check('S4 导入恢复的条目不带 savedAt',
  imported.added === 2 && ['imp1', 'imp2'].every(id => byItem(bg, id) && !('savedAt' in byItem(bg, id))),
  JSON.stringify(['imp1', 'imp2'].map(id => byItem(bg, id))));

// S5 翻译回写不改 savedAt（入库时刻不随翻译完成而后移）
bg.setTime(T1 + 7200000);
const s1Id = byItem(bg, 'tt1').id;
bg.context.s1Id = s1Id;
await bg.run("updateSingleDramaTranslation(s1Id, { title: '中文名', desc: '' })");
const s5 = byItem(bg, 'tt1');
check('S5 翻译回写后 savedAt 不变', s5?.titleZh === '中文名' && s5?.savedAt === new Date(T0).toISOString(), JSON.stringify(s5));

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
