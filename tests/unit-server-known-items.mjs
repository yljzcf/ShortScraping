import './bootstrap.cjs';
import { startIsolatedServer } from './server-fixture.mjs';
// 已知片单的服务端备份（v1.7.0）：GET / POST /known-items ⇄ db/known-items.json。
//
// 扩展把「只记 ID、不入库」的条目（IMDb 切换为滚动日期窗口时的基线老片）存在 storage.knownItems，重装扩展
// 就没了——库能从 db/timeline.json 导入恢复，片单没有别处可取。所以扩展每次追加后把整份推到这里（整份替换），
// 唤醒发现本地从没有过片单时取回。
//
//   K1 没有文件时 GET 回空片单（扩展据此记成空、不再每次问）
//   K2 POST 整份替换：按 id 去重、只留 id/site/at/reason 并截断超长字段，原子落盘 { updatedAt, items }
//   K3 GET 回刚存的片单；重启后照样读得回来
//   K4 坏请求 400 且文件不动：items 不是数组 / 含无效 id / 坏 JSON / 超过条数上限
//   K5 写入闸门同 /sync：非 JSON 415、固定来源之外的扩展 403
//   K6 文件损坏：GET 按空片单回 200（不 500），POST 照常覆盖修好
// 隔离方式：tests/server-fixture.mjs（os.tmpdir() 隔离树 + 随机端口，绝不碰 31919 与真实 db/）。
// 用法：node tests/unit-server-known-items.mjs
import fs from 'node:fs';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);

const A = `chrome-extension://${'a'.repeat(32)}`;
const B = `chrome-extension://${'b'.repeat(32)}`;
const server = await startIsolatedServer({ prefix: 'shortscraping-known-' });
try {
  const file = server.tree.p('db/known-items.json');
  const stored = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
  const raw = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  const get = () => server.getJson('/known-items');

  // K1
  const empty = await get();
  check('K1 没有 db/known-items.json 时 GET 回 { ok:true, items:[] }', empty?.ok === true && show(empty.items) === '[]' && !fs.existsSync(file),
    show(empty));

  // K2
  const long = 'x'.repeat(500);
  const posted = await server.post('/known-items', {
    items: [
      { id: 'tt900', site: 'imdb', at: '2026-09-27T00:00:00.000Z', reason: 'IMDb 切换基线', extra: '丢掉' },
      { id: 'tt901', site: long, at: long, reason: long },
      { id: 'tt900', site: 'imdb', at: 'later', reason: '重复的后来者' },
      { id: 'rs:abc_1.2-3' }
    ]
  }, { Origin: A });
  const saved = stored();
  check('K2a 合法片单 200，回条数（按 id 去重后）', posted.status === 200 && posted.body.ok === true && posted.body.count === 3, show(posted));
  check('K2b 落盘 { updatedAt, items }：去重保留先到的、只留四个字段、超长字段截断、缺的字段记空串',
    typeof saved?.updatedAt === 'string' && show(saved.items) === show([
      { id: 'tt900', site: 'imdb', at: '2026-09-27T00:00:00.000Z', reason: 'IMDb 切换基线' },
      { id: 'tt901', site: 'x'.repeat(32), at: 'x'.repeat(40), reason: 'x'.repeat(200) },
      { id: 'rs:abc_1.2-3', site: '', at: '', reason: '' }
    ]), show(saved));

  // K3
  const back = await get();
  check('K3a GET 回刚存的片单', show(back?.items) === show(saved.items), show(back));
  await server.restart();
  const afterRestart = await get();
  check('K3b 重启后照样读得回来', show(afterRestart?.items) === show(saved.items), show(afterRestart));

  // K4
  const before = raw();
  const notArray = await server.post('/known-items', { items: { id: 'tt1' } }, { Origin: A });
  const badId = await server.post('/known-items', { items: [{ id: 'tt1' }, { id: '../etc' }] }, { Origin: A });
  const emptyId = await server.post('/known-items', { items: [{ id: '' }] }, { Origin: A });
  const numberId = await server.post('/known-items', { items: [{ id: 42 }] }, { Origin: A });
  const badJson = await server.request('/known-items', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: A }, body: '{"items": [' });
  check('K4a items 不是数组 / 含无效 id（路径字符、空串、非字符串）一律 400、文件一个字节不动',
    [notArray, badId, emptyId, numberId].every(r => r.status === 400 && r.body.ok === false) && /无效条目|必须是数组/.test(badId.body.error)
      && raw() === before, show([notArray, badId, emptyId, numberId].map(r => [r.status, r.body.error])));
  check('K4b 坏 JSON 400（点明不是合法 JSON）、文件不动', badJson.status === 400 && /不是合法 JSON/.test((await badJson.json())?.error || '')
    && raw() === before, String(badJson.status));
  const tooMany = await server.post('/known-items', { items: Array.from({ length: 100001 }, (_, i) => ({ id: `tt${i}` })) }, { Origin: A }, { timeoutMs: 15000 });
  check('K4c 超过 10 万条上限 400、文件不动', tooMany.status === 400 && /上限/.test(tooMany.body.error) && raw() === before, show(tooMany.body));

  // K5
  const wrongType = await server.request('/known-items', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: A }, body: '{"items":[]}' });
  const otherExtension = await server.post('/known-items', { items: [] }, { Origin: B });
  check('K5 写入闸门同 /sync：非 JSON 请求体 415，固定来源（A）之外的扩展 403，文件都不动',
    wrongType.status === 415 && otherExtension.status === 403 && raw() === before, show({ wrongType: wrongType.status, other: otherExtension }));

  // K6
  fs.writeFileSync(file, '{ 坏掉的 JSON');
  const corrupt = await server.request('/known-items');
  const corruptBody = await corrupt.json();
  check('K6a 文件损坏：GET 按空片单回 200（不 500）', corrupt.status === 200 && show(corruptBody.items) === '[]', show(corruptBody));
  const repaired = await server.post('/known-items', { items: [{ id: 'tt900', site: 'imdb' }] }, { Origin: A });
  check('K6b 损坏后 POST 照常整份覆盖修好', repaired.status === 200 && show(stored()?.items.map(i => i.id)) === show(['tt900']), show(stored()));
} finally {
  await server.stop();
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
