import './bootstrap.cjs';
import { startIsolatedServer, card } from './server-fixture.mjs';
// 写入来源固定（config/sync-origin.json）的重新固定与固定时机（v1.7.0 审查 M3）。
//
// 起因：固定来源只在启动时读一次。README 说「换目录重载扩展（ID 变了）后删除该文件即可重新固定」，
// 可常驻的服务（开机自启下一直在跑）还攥着内存里的旧值，删了文件照样 403，弹窗 🔄 重启请求自己也被 403，
// 只剩 npm run restart。另外固定发生在 Content-Type 与路由判定之前：未固定期间任何扩展发个 415 / 404 的 POST
// 也能抢走固定位。现在：来源不符时重读文件（已删＝重新首见即固定、手改生效、坏文件拒绝）；只有过完
// 「来源 → application/json → 真实写路由」全部闸门的请求才会固定。
//
//   O1 未固定时 415 / 未知路由不固定，合格写入才固定
//   O2 别的扩展被拒，403 带 ORIGIN_NOT_PINNED 与恢复提示
//   O3 删文件后换来源免重启写入成功，旧来源随之被拒
//   O4 手改文件即时生效
//   O5 坏文件不把写接口敞开（fail closed），内存里已固定的来源不受影响
//   O6 不带 Origin 的本机 Node 工具照常放行、但不触发固定
//   O7 删文件后新来源可 /shutdown（弹窗 ⏹ / 🔄 同一闸门），进程正常退出
// 隔离方式：tests/server-fixture.mjs（os.tmpdir() 隔离树 + 随机端口，绝不碰 31919）。
// 用法：node tests/unit-server-origin.mjs
import fs from 'node:fs';
import { once } from 'node:events';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);

const A = `chrome-extension://${'a'.repeat(32)}`;
const B = `chrome-extension://${'b'.repeat(32)}`;
const push = (origin, extra = {}) => ({ Origin: origin, ...extra });

const server = await startIsolatedServer({ prefix: 'shortscraping-origin-' });
try {
  const pinFile = server.tree.p('config/sync-origin.json');
  const pinnedOrigin = () => (fs.existsSync(pinFile) ? JSON.parse(fs.readFileSync(pinFile, 'utf8')).origin : null);
  const sync = (origin, ids = ['tt1']) => server.post('/sync', { dramas: ids.map(id => card(id)) }, push(origin));

  // O1 未固定期间：415 与未知路由都不固定，合格写入才固定
  const wrongType = await server.post('/sync', { dramas: [card('tt1')] }, push(A, { 'Content-Type': 'text/plain' }));
  const unknown = await server.post('/nope', {}, push(A));
  check('O1a 未固定时 A 发 415（非 JSON）与 404（未知写接口）：都不固定',
    wrongType.status === 415 && unknown.status === 404 && !fs.existsSync(pinFile), show({ wrongType: wrongType.status, unknown: unknown.status, pinned: pinnedOrigin() }));
  const first = await sync(A);
  check('O1b A 的合格写入成功并固定为写入来源', first.status === 200 && pinnedOrigin() === A, show({ status: first.status, pinned: pinnedOrigin() }));

  // O2 别的扩展被拒，给出恢复提示
  const denied = await sync(B);
  check('O2 B 被拒：403、code=ORIGIN_NOT_PINNED、提示删除 sync-origin.json 且无需重启',
    denied.status === 403 && denied.body.code === 'ORIGIN_NOT_PINNED' && /sync-origin\.json/.test(denied.body.error)
      && /无需重启/.test(denied.body.error), show(denied));

  // O3 删文件：新来源免重启写入成功，旧来源随之被拒
  fs.unlinkSync(pinFile);
  const repinned = await sync(B, ['tt1', 'tt2']);
  check('O3a 删掉 sync-origin.json 后 B 不重启服务即写入成功，文件改记 B', repinned.status === 200 && pinnedOrigin() === B,
    show({ status: repinned.status, pinned: pinnedOrigin() }));
  const oldDenied = await sync(A);
  check('O3b 重新固定后 A 被拒', oldDenied.status === 403, show(oldDenied));

  // O4 手改文件即时生效
  fs.writeFileSync(pinFile, JSON.stringify({ origin: A, pinnedAt: '2026-09-26T00:00:00.000Z' }));
  const handA = await sync(A);
  const handB = await sync(B);
  check('O4 手把文件改回 A：A 立即放行、B 被拒（来源不符时重读文件）', handA.status === 200 && handB.status === 403,
    show({ a: handA.status, b: handB.status }));

  // O5 坏文件：不敞开写接口，内存里已固定的 A 不受影响
  fs.writeFileSync(pinFile, '{ not json');
  const garbageB = await sync(B);
  const garbageA = await sync(A);
  check('O5 文件被写坏：B 仍被拒（fail closed），已固定的 A 照常写入（不重读、不受影响）',
    garbageB.status === 403 && garbageA.status === 200 && fs.readFileSync(pinFile, 'utf8') === '{ not json',
    show({ b: garbageB.status, a: garbageA.status }));

  // O6 本机 Node 工具（不带 Origin）照常放行，但不触发固定
  fs.unlinkSync(pinFile);
  const tool = await server.post('/sync', { dramas: [card('tt1')] });
  check('O6 删文件后不带 Origin 的本机工具写入照常放行、不触发固定', tool.status === 200 && !fs.existsSync(pinFile),
    show({ status: tool.status, pinned: pinnedOrigin() }));

  // O7 删文件后新来源可 /shutdown：弹窗 ⏹ / 🔄 与 /sync 同一闸门，以前在这种状态下也被 403
  const exited = once(server.proc, 'exit');
  const stop = await server.post('/shutdown', {}, push(B));
  const [code] = await exited;
  check('O7 删文件后新来源 POST /shutdown → 200，进程以 0 退出（且顺带固定为 B）',
    stop.status === 200 && code === 0 && pinnedOrigin() === B, show({ status: stop.status, code, pinned: pinnedOrigin() }));
} finally {
  await server.stop();
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
