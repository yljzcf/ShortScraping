import './bootstrap.cjs';
// 同步服务 /api/timeline 缓存、内容指纹与落盘自愈回归测试（v1.6.21）。
//
// 背景：整表 3.7MB 起步、按月增长。共享页每次打开 / 回到前台 / 收到 SSE 都整表拉取，服务端每个请求
// 都整表 JSON.stringify 一次、明文发出，没有 ETag；CSV 停机期间被删要等扩展下一次推送才补写，
// 运行期间 timeline.json 被删则永远不会补回来（同内容推送一律跳过快照写入）；drop 档只按整表 80% 判断，
// 清空一个占比不到 20% 的大站（2026-09 实测 royalroad 430/2239）不留任何档。
//   C 组 响应体：与旧写法 JSON.stringify({ ok, version, updatedAt, dramas }) 逐字节相同；gzip 解压后逐字节等于明文；
//        Accept-Encoding 协商；并发 gzip 请求拿到同一份字节。
//   E 组 ETag：W/"<指纹前 16 位>-<版本>"，If-None-Match 命中回 304 空体；同内容推送不变、内容变化随之变。
//   H 组 contentHash：/health 本机块与 /sync 响应都带，等于 sha1(快照序列化)，只随内容变、跨重启不变。
//   S 组 csvInSync 与启动自愈：运行中删 CSV → false，推送后 true；停机期间删 CSV / CSV 落后 → 启动即按快照补写；
//        补写失败只告警、仍为 false，之后推送补上。
//   J 组 运行中删 timeline.json：同内容推送按当前版本补写，不 bump 版本、不广播；首启空推送不凭空建文件。
//   D 组 分站点 drop 档：原有 ≥10 条的站点跌超 20% 也留 drop 档（文件名沿用），告警点名站点；小站与小幅下跌不留。
// 隔离方式：tests/server-fixture.mjs 的 os.tmpdir() 隔离树 + 随机端口子进程——全程不触碰真实 31919 与真实 db/。
// 用法：node tests/unit-server-timeline-cache.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { startIsolatedServer, card, SUB } from './server-fixture.mjs';

const RR_LIST = 'https://www.royalroad.com/fictions/best-rated';
const RS_LIST = 'https://www.reelshort.com/shelf/new-release';
const TAGS = [{ url: SUB, tags: ['IMDB'] }, { url: RR_LIST, tags: ['RR'] }, { url: RS_LIST, tags: ['RS'] }];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha1 = text => crypto.createHash('sha1').update(text, 'utf8').digest('hex');
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

const imdb = n => Array.from({ length: n }, (_, i) => card(`tt${1000 + i}`, {
  title: `Title ${i}`, titleZh: `中文标题 ${i}`, description: '一段足够长、便于压缩的简介。'.repeat(20)
}));
const royalroad = n => Array.from({ length: n }, (_, i) => card(`rr${2000 + i}`, {
  source: 'royalroad', sourceListUrl: RR_LIST, tags: ['RR'], title: `Fiction ${i}`
}));
const reelshort = n => Array.from({ length: n }, (_, i) => card(`rs${3000 + i}`, {
  source: 'reelshort', sourceListUrl: RS_LIST, tags: ['RS'], title: `Reel ${i}`
}));
// 序列化边角：多字节、emoji、引号反斜杠、U+2028、孤立代理项、</script>、数字的各种写法、嵌套对象
const tricky = [
  card('tt9001', { title: '引号 " 反斜杠 \\ 换行 \n 制表 \t', titleZh: '短剧😀《测试》', description: 'a\u2028b\u2029c </script>' }),
  card('tt9002', { title: 'lone \uD800 surrogate', extra: { nested: [1, 0.1, 1e21, -0, null, true, 'x'] }, rank: 3 })
];

// 原始 GET：node:http 不会自带 Accept-Encoding、也不会自动解压，要逐字节比较只能这样拿
function rawGet(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    // 值为 undefined 的头直接丢掉（旧服务端不给 ETag 时，后面的条件请求照样能发出去、如实判 FAIL）
    const sent = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    const req = http.get({ host: '127.0.0.1', port, path: route, headers: sent, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error(`${route} 5 秒无响应`)));
    req.on('error', reject);
  });
}

// SSE 订阅：收集 update 帧的 data（已 JSON.parse），ready 在首帧到达时兑现
function openEvents(port) {
  const frames = [];
  let req;
  const ready = new Promise((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port, path: '/api/events', agent: false }, res => {
      res.setEncoding('utf8');
      res.on('error', () => {}); // close() 主动断开时的 aborted 不算失败
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk;
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = block.split('\n').find(line => line.startsWith('data: '));
          if (/^event: update$/m.test(block) && data) frames.push(JSON.parse(data.slice('data: '.length)));
        }
        if (frames.length > 0) resolve();
      });
    });
    req.on('error', reject);
  });
  return { frames, ready, close: () => { req.on('error', () => {}); req.destroy(); } };
}

// 旧写法的响应体：sendJson(res, 200, { ok: true, version: dataVersion, updatedAt, dramas: latestDramas })
const legacyBody = snapshot => Buffer.from(JSON.stringify({
  ok: true, version: snapshot.version, updatedAt: snapshot.updatedAt, dramas: snapshot.dramas
}), 'utf8');
const etagParts = etag => /^W\/"([0-9a-f]{16})-(\d+)"$/.exec(etag || '');
const dataRows = text => text.trim().split('\r\n').length - 1;

const server = await startIsolatedServer({ prefix: 'shortscraping-tlcache-', config: { 'tag.json': TAGS } });
const { port, tree } = server;
const csvPath = tree.p('db/timeline.csv');
const jsonPath = tree.p('db/timeline.json');
const historyDir = tree.p('db/history');
const localHealth = () => server.health(2000);
const dropCsvs = () => (fs.existsSync(historyDir) ? fs.readdirSync(historyDir) : [])
  .filter(name => /^timeline-\d{8}-\d{6}-\d{3}-drop\.csv$/.test(name)).sort();

try {
  // ---------- C0 首启空快照 ----------
  {
    const empty = await rawGet(port, '/api/timeline');
    check('C0 首启未推送：响应体与旧写法逐字节相同', empty.status === 200
      && empty.body.toString('utf8') === '{"ok":true,"version":0,"updatedAt":null,"dramas":[]}', empty.body.toString('utf8'));
    const health = await localHealth();
    check('H0 首启 contentHash＝sha1("[]")、csvInSync 为 true', health?.contentHash === sha1('[]') && health?.csvInSync === true,
      JSON.stringify(health));
  }

  // ---------- C1 响应体逐字节等价 ----------
  const base = [...imdb(30), ...royalroad(12), ...tricky];
  const pushed = await server.postSync(base);
  const snapshot1 = tree.readJson('db/timeline.json');
  const plain1 = await rawGet(port, '/api/timeline');
  {
    check('C1a 前提：推送成功、快照即推送内容', pushed.ok === true && JSON.stringify(snapshot1.dramas) === JSON.stringify(base),
      JSON.stringify(pushed).slice(0, 200));
    check('C1b 明文响应体与旧写法 JSON.stringify({ ok, version, updatedAt, dramas }) 逐字节相同',
      plain1.status === 200 && plain1.body.equals(legacyBody(snapshot1)),
      `len ${plain1.body.length} vs ${legacyBody(snapshot1).length}`);
    check('C1c 明文响应头：JSON 类型、Content-Length 准确、不带 Content-Encoding',
      plain1.headers['content-type'] === 'application/json; charset=utf-8'
        && Number(plain1.headers['content-length']) === plain1.body.length && plain1.headers['content-encoding'] === undefined,
      JSON.stringify(plain1.headers));
    check('C1d 缓存相关头：Cache-Control: no-cache、Vary: Accept-Encoding、弱 ETag',
      plain1.headers['cache-control'] === 'no-cache' && plain1.headers.vary === 'Accept-Encoding' && !!etagParts(plain1.headers.etag),
      JSON.stringify(plain1.headers));
  }

  // ---------- C2 gzip ----------
  {
    const gz = await rawGet(port, '/api/timeline', { 'Accept-Encoding': 'gzip, deflate, br' });
    const unzipped = gz.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(gz.body) : null;
    check('C2a 接受 gzip 时回 gzip，解压后与明文逐字节相同', !!unzipped && unzipped.equals(plain1.body),
      JSON.stringify(gz.headers));
    check('C2b gzip 体确实更小、Content-Length 是压缩后长度、ETag 与明文相同',
      gz.body.length < plain1.body.length / 2 && Number(gz.headers['content-length']) === gz.body.length
        && gz.headers.etag === plain1.headers.etag && gz.headers.vary === 'Accept-Encoding',
      `${gz.body.length} / ${plain1.body.length}`);
    const burst = await Promise.all(Array.from({ length: 6 }, () => rawGet(port, '/api/timeline', { 'Accept-Encoding': 'gzip' })));
    check('C2c 并发 gzip 请求拿到同一份压缩字节（同一版本只压一次、共用在途压缩）',
      burst.every(r => r.status === 200 && r.headers['content-encoding'] === 'gzip' && r.body.equals(burst[0].body))
        && zlib.gunzipSync(burst[0].body).equals(plain1.body), burst.map(r => r.body.length).join(','));
    const q0 = await rawGet(port, '/api/timeline', { 'Accept-Encoding': 'gzip;q=0, identity' });
    const star = await rawGet(port, '/api/timeline', { 'Accept-Encoding': '*' });
    const starButNotGzip = await rawGet(port, '/api/timeline', { 'Accept-Encoding': 'gzip;q=0, *' });
    check('C2d gzip;q=0 回明文、* 回 gzip、显式拒绝 gzip 时 * 不算',
      q0.headers['content-encoding'] === undefined && q0.body.equals(plain1.body)
        && star.headers['content-encoding'] === 'gzip'
        && starButNotGzip.headers['content-encoding'] === undefined && starButNotGzip.body.equals(plain1.body),
      JSON.stringify([q0.headers['content-encoding'], star.headers['content-encoding'], starButNotGzip.headers['content-encoding']]));
    const viaFetch = await server.timeline();
    check('C2e fetch（自带 gzip 协商并自动解压）读到的仍是完整时间线',
      viaFetch.ok === true && viaFetch.version === snapshot1.version && JSON.stringify(viaFetch.dramas) === JSON.stringify(base), '');
  }

  // ---------- H1 contentHash ----------
  const health1 = await localHealth();
  {
    check('H1a /sync 200 响应带 contentHash＝sha1(快照序列化)', pushed.contentHash === sha1(JSON.stringify(base)),
      `${pushed.contentHash} vs ${sha1(JSON.stringify(base))}`);
    check('H1b /health 本机块带同一个 contentHash 与 csvInSync:true',
      health1?.contentHash === pushed.contentHash && health1?.csvInSync === true, JSON.stringify(health1));
    const parts = etagParts(plain1.headers.etag);
    check('H1c ETag＝W/"<contentHash 前 16 位>-<版本>"',
      !!parts && parts[1] === pushed.contentHash.slice(0, 16) && Number(parts[2]) === snapshot1.version, plain1.headers.etag);
  }

  // ---------- E1 条件请求 ----------
  const etag1 = plain1.headers.etag || 'W/"no-etag"';
  {
    const hit = await rawGet(port, '/api/timeline', { 'If-None-Match': etag1, 'Accept-Encoding': 'gzip' });
    check('E1a If-None-Match 命中回 304、没有响应体、仍带 ETag / Vary / Cache-Control',
      hit.status === 304 && hit.body.length === 0 && hit.headers.etag === etag1
        && hit.headers.vary === 'Accept-Encoding' && hit.headers['cache-control'] === 'no-cache', JSON.stringify(hit.headers));
    const strong = await rawGet(port, '/api/timeline', { 'If-None-Match': etag1.slice(2) });
    const list = await rawGet(port, '/api/timeline', { 'If-None-Match': `W/"0000000000000000-1", ${etag1}` });
    const miss = await rawGet(port, '/api/timeline', { 'If-None-Match': 'W/"0000000000000000-1"' });
    check('E1b 弱比较：不带 W/ 的同值、列表里含本 ETag 都命中；不相符回 200 全量',
      strong.status === 304 && list.status === 304 && miss.status === 200 && miss.body.equals(plain1.body),
      JSON.stringify([strong.status, list.status, miss.status]));
  }

  // ---------- E2 / H2 同内容与内容变化 ----------
  {
    const same = await server.postSync(base);
    const sameHealth = await localHealth();
    const sameResp = await rawGet(port, '/api/timeline', { 'If-None-Match': etag1 });
    check('E2a 同内容重推：contentHash、版本不变，旧 ETag 仍 304',
      same.contentHash === pushed.contentHash && sameHealth.contentHash === pushed.contentHash
        && sameHealth.version === snapshot1.version && sameResp.status === 304, JSON.stringify({ same, sameHealth }));

    const next = [...base, card('tt5000', { title: 'New one' })];
    const changed = await server.postSync(next);
    const changedHealth = await localHealth();
    const afterChange = await rawGet(port, '/api/timeline', { 'If-None-Match': etag1 });
    const snapshot2 = tree.readJson('db/timeline.json');
    check('H2a 内容变化：contentHash 随之变，/sync 响应、/health、sha1 三者一致',
      changed.contentHash !== pushed.contentHash && changed.contentHash === sha1(JSON.stringify(next))
        && changedHealth.contentHash === changed.contentHash, JSON.stringify({ changed, changedHealth }));
    const parts = etagParts(afterChange.headers.etag);
    check('E2b 内容变化：旧 ETag 不再命中，回 200 新全量；新 ETag 的指纹与版本都跟上',
      afterChange.status === 200 && afterChange.headers.etag !== etag1 && afterChange.body.equals(legacyBody(snapshot2))
        && !!parts && parts[1] === changed.contentHash.slice(0, 16) && Number(parts[2]) === snapshot2.version,
      `${afterChange.status} ${afterChange.headers.etag}`);
  }

  // ---------- H3 跨重启 ----------
  {
    const before = await localHealth();
    const bodyBefore = await rawGet(port, '/api/timeline');
    await server.restart();
    const after = await localHealth();
    const bodyAfter = await rawGet(port, '/api/timeline');
    check('H3a 重启后 contentHash / 版本不变（loadSnapshot 从同一份内容重算）',
      after?.contentHash === before.contentHash && after?.version === before.version && after?.pid !== before.pid,
      JSON.stringify({ before, after }));
    check('H3b 重启后 ETag 与响应体逐字节不变', bodyAfter.headers.etag === bodyBefore.headers.etag && bodyAfter.body.equals(bodyBefore.body),
      `${bodyBefore.headers.etag} -> ${bodyAfter.headers.etag}`);
    check('H3c 两份一致时重启 csvInSync 仍为 true', after?.csvInSync === true, JSON.stringify(after));
  }

  // ---------- S csvInSync 与启动自愈 ----------
  const current = tree.readJson('db/timeline.json').dramas;
  {
    fs.rmSync(csvPath);
    const deleted = await localHealth();
    check('S1a 运行中删掉 CSV：csvInSync 变 false', deleted?.csvInSync === false, JSON.stringify(deleted));
    const healed = await server.postSync(current);
    check('S1b 同内容推送补写后 csvInSync 回到 true', healed.ok === true && (await localHealth())?.csvInSync === true
      && dataRows(fs.readFileSync(csvPath, 'utf8')) === current.length, JSON.stringify(healed));

    // 运行中删掉 timeline.json：扩展冷启动指纹（v1.6.22）靠 csvInSync 判过期，只看 CSV 会一直判「一致」而不补推
    fs.rmSync(jsonPath);
    const jsonGone = await localHealth();
    check('S1c 运行中删掉 timeline.json：csvInSync 也变 false', jsonGone?.csvInSync === false, JSON.stringify(jsonGone));
    const jsonHealed = await server.postSync(current);
    check('S1d 同内容推送补写 timeline.json 后 csvInSync 回到 true', jsonHealed.ok === true && fs.existsSync(jsonPath)
      && (await localHealth())?.csvInSync === true, JSON.stringify(jsonHealed));

    await server.restart(() => fs.rmSync(csvPath));
    const afterRestart = await localHealth();
    check('S2a 停机期间删掉 CSV：启动即按快照补写，不等推送', afterRestart?.csvInSync === true
      && dataRows(fs.readFileSync(csvPath, 'utf8')) === current.length, JSON.stringify(afterRestart));
    check('S2b 启动日志说明补写了几条', server.output.includes(`已按快照补写：${current.length} 条`), server.output.slice(0, 400));

    // CSV 比快照旧（上次运行 CSV 写失败后没等到补写就重启）：mtime 口径
    await server.restart(() => {
      fs.writeFileSync(csvPath, fs.readFileSync(csvPath, 'utf8').split('\r\n')[0] + '\r\n');
      const old = new Date(Date.now() - 3600 * 1000);
      fs.utimesSync(csvPath, old, old);
    });
    check('S3 CSV 落后于快照时重启：同样启动即补写', (await localHealth())?.csvInSync === true
      && dataRows(fs.readFileSync(csvPath, 'utf8')) === current.length, '');

    // 补写失败（同名 .tmp 目录让原子写第一步失败）：只告警、服务照常起来，csvInSync 如实为 false
    await server.restart(() => { fs.rmSync(csvPath); fs.mkdirSync(`${csvPath}.tmp`); });
    const blocked = await localHealth();
    check('S4a 启动补写失败：服务照常起来，只告警', !!blocked && server.output.includes('按快照补写 CSV 失败'), server.output.slice(0, 400));
    check('S4b 补写失败时 csvInSync 为 false、CSV 仍是空表头', blocked?.csvInSync === false && dataRows(fs.readFileSync(csvPath, 'utf8')) === 0,
      JSON.stringify(blocked));
    fs.rmdirSync(`${csvPath}.tmp`);
    const retried = await server.postSync(current);
    check('S4c 障碍去掉后同内容推送补写，csvInSync 回到 true', retried.ok === true && (await localHealth())?.csvInSync === true
      && dataRows(fs.readFileSync(csvPath, 'utf8')) === current.length, JSON.stringify(retried));
  }

  // ---------- J 运行中删 timeline.json ----------
  {
    const events = openEvents(port);
    await events.ready;
    const before = tree.readJson('db/timeline.json');
    const etagBefore = (await rawGet(port, '/api/timeline')).headers.etag;
    fs.rmSync(jsonPath);
    const resp = await server.postSync(current);
    await sleep(300);
    const restored = fs.existsSync(jsonPath) ? tree.readJson('db/timeline.json') : null;
    check('J1a 同内容推送补写 timeline.json', resp.ok === true && !!restored, JSON.stringify(resp));
    check('J1b 补写的是当前版本：version / updatedAt / dramas 原样，版本不 bump',
      !!restored && restored.version === before.version && restored.updatedAt === before.updatedAt
        && JSON.stringify(restored.dramas) === JSON.stringify(before.dramas) && (await localHealth())?.version === before.version,
      JSON.stringify({ before: [before.version, before.updatedAt], after: restored && [restored.version, restored.updatedAt] }));
    check('J1c 不广播：SSE 只收到连接时的首帧', events.frames.length === 1 && events.frames[0].version === before.version,
      JSON.stringify(events.frames));
    check('J1d 共享页 ETag 不变', (await rawGet(port, '/api/timeline')).headers.etag === etagBefore, '');
    // 对照：内容真的变了照常广播（证明上面的「没收到」不是 SSE 读取本身坏了）
    await server.postSync([...current, card('tt5001')]);
    await sleep(300);
    check('J1e 对照：内容变化时 SSE 收到新版本', events.frames.length === 2 && events.frames[1].version === before.version + 1,
      JSON.stringify(events.frames));
    events.close();
  }

  // ---------- D 分站点 drop 档 ----------
  {
    const imdbRows = imdb(60);
    const baseline = [...imdbRows, ...royalroad(12), ...reelshort(5)];
    await server.postSync(baseline);
    for (const name of fs.readdirSync(historyDir).filter(n => /-drop\.(csv|json)$/.test(n))) fs.rmSync(path.join(historyDir, name));

    server.clearOutput();
    await server.postSync([...imdbRows, ...royalroad(12)]);           // reelshort 5→0：不足 10 条的小站
    await sleep(200);
    check('D1 小站（原有 <10 条）清空不留 drop 档、不告警', dropCsvs().length === 0 && !server.output.includes('站点条数骤降'),
      `${dropCsvs().join(',')} ${server.output.slice(0, 200)}`);

    await server.postSync([...imdbRows, ...royalroad(10)]);           // royalroad 12→10：跌 16.7%，不到 20%
    await sleep(200);
    check('D2 站点小幅下跌（未超 20%）不留 drop 档', dropCsvs().length === 0 && !server.output.includes('站点条数骤降'),
      dropCsvs().join(','));

    server.clearOutput();
    const cleared = await server.postSync(imdbRows);                  // royalroad 10→0；整表 70→60 只跌 14%
    await sleep(300);
    const drops = dropCsvs();
    check('D3a 清空一个 ≥10 条的站（整表只跌 14%）留下 drop 档，文件名沿用原格式', cleared.ok === true && drops.length === 1
      && fs.existsSync(path.join(historyDir, drops[0].replace(/\.csv$/, '.json'))), fs.readdirSync(historyDir).join(','));
    check('D3b drop 档是覆盖前的 70 条', drops.length === 1 && dataRows(fs.readFileSync(path.join(historyDir, drops[0]), 'utf8')) === 70, '');
    check('D3c 告警点名站点与条数变化，并指明备份路径',
      /站点条数骤降（royalroad 10→0 条；整表 70→60 条）/.test(server.output) && /已备份到[\s\S]*db[\\/]history/.test(server.output)
        && !server.output.includes('收到空时间线推送'), server.output.slice(0, 400));
  }
} finally {
  await server.stop();
}

// ---------- J2 首启空推送：内存里没有可恢复的快照，不凭空建 timeline.json ----------
{
  const fresh = await startIsolatedServer({ prefix: 'shortscraping-tlcache-fresh-', config: { 'tag.json': TAGS } });
  try {
    const resp = await fresh.postSync([]);
    check('J2 首启空推送照常 200，但不凭空建 timeline.json', resp.status === 200 && resp.ok === true
      && !fs.existsSync(fresh.tree.p('db/timeline.json')), JSON.stringify(resp));
  } finally {
    await fresh.stop();
  }
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
