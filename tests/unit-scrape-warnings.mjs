import './bootstrap.cjs';
// 「抓到 0 条」告警（v1.7.0 审查 M2）。
//
// 起因：内容脚本的 scrape 应答只带新卡，丢了「打开的页面不在订阅里（跳转了）」与「页面上一条列表项都没找到
// （站点改版 / 没加载完整）」这两个信号，后台一律记成「成功、新增 0」、照常刷新 lastScrape——某条订阅可能就此
// 静默停摆，弹窗还一直显示「抓取于几分钟前 / 本次刷新无新增内容」。现在应答带 subscribed / listCount，
// 后台把这两种记成告警（不算失败），与 lastScrape 同一次 set 写 storage.lastScrapeWarnings = { at, items } | null。
//
//   W1-W2 全量轮：告警随 lastScrape 同一次 set 落库；干净的一轮写回 null
//   W3    单站刷新只换该站的告警，别站的保留
//   W4    抓失败的 URL 记成 failed（带错误原因）、取代旧告警，并打一行日志（v1.7.4；以前保留旧告警，失败无处可查）
//   W5    整轮全失败不动告警
//   W6    只有告警的一轮仍算成功：刷新 lastScrape、清掉 lastScrapeFailure
//   W7    应答缺这两个字段（旧桩 / 其它来源）不告警
//   W8    全量轮丢掉已不在订阅里的旧告警
//   W9    新增条数取 newCount
//   W10   文档 4xx / 5xx 且一条都没拿到 → blocked（带 HTTP 状态码），v1.7.4：DramaBox 的 CloudFront 403 拦截页
//   W11   文档回了 4xx 却照样找到列表（SPA 软路由）→ 不告警
//   W12   不在订阅里且实际打开的地址变了 → detail 写跳到了哪（My Drama 被 307 到 /zh）；地址没变不带 detail
// 用法：node tests/unit-scrape-warnings.mjs
import { background } from './background-fixture.mjs';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);

const IMDB = 'https://www.imdb.com/search/title/?release_date=2026-01-01,&genres=short';
const NETFLIX = 'https://www.netflix.com/tudum/top10';
const REEL = 'https://www.reelshort.com/';
const ok = (newCount = 0, listCount = 10) => ({ success: true, newCount, subscribed: true, listCount });
const empty = { success: true, newCount: 0, subscribed: true, listCount: 0 };
const redirected = { success: true, newCount: 0, subscribed: false, listCount: null };
const failed = { success: false, error: '整页抓取超时' };

const bg = await background();
bg.data.urlTags = [IMDB, NETFLIX, REEL].map(urlPattern => ({ urlPattern, tags: ['T'] }));
let replies = {};
bg.context.scrapeUrlInTab = async (url) => replies[url] || ok();
const round = (site = null) => bg.run(site ? `performScrapeOnce({ site: '${site}' })` : 'performScrapeOnce()');
const warned = () => (bg.data.lastScrapeWarnings?.items || []).map(i => `${i.url === IMDB ? 'imdb' : i.url === NETFLIX ? 'netflix' : i.url === REEL ? 'reel' : i.url}:${i.kind}`).sort().join(',');
const itemOf = url => (bg.data.lastScrapeWarnings?.items || []).find(i => i.url === url);
const detailOf = url => itemOf(url)?.detail;

// W1 全量轮：IMDB 列表为空、Netflix 页面跳走了、ReelShort 正常
replies = { [IMDB]: empty, [NETFLIX]: redirected, [REEL]: ok(3) };
bg.log.length = 0;
const r1 = await round();
check('W1a 两种「一条都没拿到」都记成告警（empty / unsubscribed），正常的那条不记',
  warned() === 'imdb:empty,netflix:unsubscribed', warned());
check('W1b 告警与 lastScrape、lastScrapeFailure 同一次 set 落库', bg.log.includes('set:lastScrape,lastScrapeFailure,lastScrapeWarnings')
  && bg.data.lastScrapeWarnings?.at === bg.data.lastScrape, show(bg.log));
check('W1c 结果里带 warning、仍算成功', r1.results.filter(r => r.warning).length === 2 && r1.results.every(r => r.success),
  show(r1.results));

// W2 干净的一轮：告警清成 null
replies = {};
await round();
check('W2 全部正常的一轮写回 lastScrapeWarnings=null', bg.data.lastScrapeWarnings === null, show(bg.data.lastScrapeWarnings));

// W3 单站刷新：只换该站的告警
replies = { [IMDB]: empty, [NETFLIX]: empty };
await round();
replies = { [NETFLIX]: ok(1) };
await round('netflix');
check('W3 单站刷新（netflix 恢复）只摘该站告警，imdb 的保留', warned() === 'imdb:empty', warned());

// W4 抓失败的 URL 记 failed、取代旧告警，并打日志
const warnLines = [];
bg.context.console.warn = (...args) => warnLines.push(args.map(String).join(' '));
replies = { [IMDB]: failed };
await round();
check('W4a 本轮抓失败的 imdb 记成 failed、取代旧的 empty（v1.7.4）', warned() === 'imdb:failed', warned());
check('W4b failed 带错误原因', detailOf(IMDB) === '整页抓取超时', show(bg.data.lastScrapeWarnings));
check('W4c 定时轮里单条失败也打一行日志（订阅 URL + 原因）',
  warnLines.some(line => line.includes('抓取 URL 失败') && line.includes(IMDB) && line.includes('整页抓取超时')), show(warnLines));

// W5 整轮全失败：不动告警、也不刷新 lastScrape
const before = { warnings: bg.data.lastScrapeWarnings, lastScrape: bg.data.lastScrape };
replies = { [IMDB]: failed, [NETFLIX]: failed, [REEL]: failed };
await round();
check('W5 整轮全失败：告警与 lastScrape 原样（失败另有 lastScrapeFailure）',
  show(bg.data.lastScrapeWarnings) === show(before.warnings) && bg.data.lastScrape === before.lastScrape && bg.data.lastScrapeFailure?.failed === 3,
  show({ warnings: bg.data.lastScrapeWarnings, failure: bg.data.lastScrapeFailure }));

// W6 只有告警的一轮仍算成功
bg.setTime(Date.parse('2026-09-06T00:00:00Z'));
replies = { [IMDB]: empty, [NETFLIX]: empty, [REEL]: empty };
await round();
check('W6 全是「抓到 0 条」的一轮仍算成功：刷新 lastScrape、清掉 lastScrapeFailure',
  bg.data.lastScrape === '2026-09-06T00:00:00.000Z' && bg.data.lastScrapeFailure === null && warned() === 'imdb:empty,netflix:empty,reel:empty',
  show({ lastScrape: bg.data.lastScrape, failure: bg.data.lastScrapeFailure, warned: warned() }));

// W7 应答缺字段不告警
replies = { [IMDB]: { success: true, data: [] }, [NETFLIX]: { success: true }, [REEL]: ok() };
await round();
check('W7 应答缺 subscribed / listCount（旧桩）不告警', bg.data.lastScrapeWarnings === null, show(bg.data.lastScrapeWarnings));

// W8 全量轮丢掉已退订 URL 的旧告警
replies = { [REEL]: empty };
await round();
bg.data.urlTags = [IMDB, NETFLIX].map(urlPattern => ({ urlPattern, tags: ['T'] }));
replies = {};
await round();
check('W8 全量轮丢掉已不在订阅里的 reel 告警', bg.data.lastScrapeWarnings === null, show(bg.data.lastScrapeWarnings));

// W9 新增条数取 newCount
replies = { [IMDB]: ok(4), [NETFLIX]: ok(2) };
const r9 = await round();
check('W9 totalNewCount 按应答的 newCount 累加', r9.totalNewCount === 6, show(r9.totalNewCount));

// W10 文档 4xx / 5xx 且一条都没拿到 → blocked（W8 退订了 reel，这里订回来）
bg.data.urlTags = [IMDB, NETFLIX, REEL].map(urlPattern => ({ urlPattern, tags: ['T'] }));
replies = {
  [IMDB]: { ...empty, httpStatus: 403, pageUrl: 'https://www.imdb.com/search/title/' },
  [NETFLIX]: { ...redirected, httpStatus: 503, pageUrl: 'https://www.netflix.com/blocked' },
  [REEL]: { ...empty, httpStatus: 200 }
};
const r10 = await round();
check('W10a 没找到列表 + 403 → blocked；不在订阅里 + 503 → 同样 blocked；200 的照旧 empty',
  warned() === 'imdb:blocked,netflix:blocked,reel:empty', warned());
check('W10b blocked 的 detail 是 HTTP 状态码', detailOf(IMDB) === 'HTTP 403' && detailOf(NETFLIX) === 'HTTP 503' && itemOf(REEL)?.detail === undefined,
  show(bg.data.lastScrapeWarnings));
check('W10c 本轮结果同样带 warning / detail（弹窗手动刷新的提示用它）',
  r10.results.find(r => r.url === IMDB)?.warning === 'blocked' && r10.results.find(r => r.url === IMDB)?.detail === 'HTTP 403', show(r10.results));

// W11 4xx 但找到了列表：不告警
replies = { [IMDB]: { ...ok(2, 5), httpStatus: 404 }, [NETFLIX]: ok(), [REEL]: ok() };
await round();
check('W11 文档回 404 却照样找到列表（SPA 软路由）→ 不告警', bg.data.lastScrapeWarnings === null, show(bg.data.lastScrapeWarnings));

// W12 不在订阅里：实际地址变了才带 detail
replies = {
  [NETFLIX]: { ...redirected, httpStatus: 200, pageUrl: 'https://www.netflix.com/jp/tudum/top10' },
  [REEL]: { ...redirected, pageUrl: REEL }
};
await round();
check('W12a 跳转了（实际地址与打开的不同）→ detail 写实际打开的地址', detailOf(NETFLIX) === '实际打开 https://www.netflix.com/jp/tudum/top10',
  show(bg.data.lastScrapeWarnings));
check('W12b 地址没变 → 不带 detail', itemOf(REEL)?.kind === 'unsubscribed' && !('detail' in (itemOf(REEL) || {})), show(itemOf(REEL)));

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failedCount = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failedCount}/${results.length} 通过`);
process.exit(failedCount ? 1 : 0);
