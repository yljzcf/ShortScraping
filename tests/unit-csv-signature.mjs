import './bootstrap.cjs';
// A7 回归测试：CSV 同步客户端内容签名跳过 + warmup 强推兜底。
// 用法：node tests/unit-csv-signature.mjs（改造前跑 T1 应 RED=同内容两次 POST）
import { background } from './background-fixture.mjs';

// 后台走共用 background-fixture（v1.6.20 起不再手搓 chrome 桩）。发送方按真实弹窗构造（扩展页面）
const POPUP_SENDER = { id: 'fixture', url: 'chrome-extension://fixture/src/popup/popup.html' };
const SUB = 'https://unit.test/list';
let csvPosts = [];
let failCsvPost = false;
const bg = await background({
  // 真定时器：T5 要等 500ms 防抖后的推送真的发出；tick:1 保持手搓桩「让出一拍再读写」的时序
  timers: 'real',
  storage: { tick: 1 },
  data: { urlTags: [{ urlPattern: SUB, tags: ['T'] }] },
  translator: { async translateTitleAndDesc() { return { title: '', desc: '' }; } },
  // 后台所有请求都经这里：tag.json 与 /sync 给桩响应，其余一律断网
  fetch: async (url, init) => {
    const u = String(url);
    if (u.includes('tag.json')) return { ok: true, json: async () => [{ url: SUB, tags: ['T'] }] };
    if (u.includes('/sync')) {
      if (failCsvPost) { failCsvPost = false; throw new TypeError('unit stub: 同步服务不可达'); }
      csvPosts.push(init.body);
      return { ok: true, json: async () => ({ ok: true, count: 0, csvPath: 'stub.csv' }) };
    }
    throw new TypeError('unit stub: no network');
  }
});
const syncTimelineToCsv = () => bg.context.syncTimelineToCsv();

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700);

const mk = (n) => ({
  id: `id-${n}`, itemId: `tt${String(n).padStart(4, '0')}`, title: `Title ${n}`,
  description: `desc ${n}`, status: 'new', source: 'unittest', sourceListUrl: SUB, tags: ['T']
});
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const send = (msg) => bg.send(msg, POPUP_SENDER);

// 数据经生产路径灌入（缓存同步）
await send({ action: 'saveDrama', drama: mk(1) });
await send({ action: 'saveDrama', drama: mk(2) });

// ---------- T1 同内容两次触发只 POST 一次 ----------
{
  csvPosts = [];
  await syncTimelineToCsv();
  await syncTimelineToCsv();
  check('T1 同内容两触发仅 1 次 POST（旧代码 2 次）', csvPosts.length === 1, `posts=${csvPosts.length}`);
}

// ---------- T2 body 拼接正确性：解析回与数据深等 ----------
{
  const parsed = JSON.parse(csvPosts[0]);
  check('T2a body 可解析且 dramas 深等', JSON.stringify(parsed.dramas) === JSON.stringify(bg.dramas()), '');
  check('T2b syncedAt 为合法 ISO 串', typeof parsed.syncedAt === 'string' && !Number.isNaN(Date.parse(parsed.syncedAt)), String(parsed.syncedAt));
}

// ---------- T3 内容变化后照常 POST ----------
{
  csvPosts = [];
  await send({ action: 'saveDrama', drama: mk(3) });
  await syncTimelineToCsv();
  check('T3 内容变化后照常推送', csvPosts.length === 1 && JSON.parse(csvPosts[0]).dramas.length === 3, `posts=${csvPosts.length}`);
}

// ---------- T4 POST 失败签名不记录，下次重试 ----------
{
  csvPosts = [];
  await send({ action: 'saveDrama', drama: mk(4) });
  failCsvPost = true;
  let threw = false;
  await syncTimelineToCsv().catch(() => { threw = true; });
  await syncTimelineToCsv();
  check('T4 失败不记签名、重试成功推送', threw === true && csvPosts.length === 1 && JSON.parse(csvPosts[0]).dramas.length === 4, `threw=${threw} posts=${csvPosts.length}`);
}

// ---------- T5 warmup 消息强推：同内容也重新 POST ----------
{
  csvPosts = [];
  await send({ action: 'warmupCsvSync' });
  await sleep(700); // 等 500ms 防抖后的推送落定
  check('T5 warmup 清签名后同内容强推', csvPosts.length === 1, `posts=${csvPosts.length}`);
}

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
