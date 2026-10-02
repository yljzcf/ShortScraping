import './bootstrap.cjs';
// 固定英文页（v1.7.4，用户 2026-10-02 定：My Drama 要英文 / 美国页面，不要中文、日文）。
//
// 起因：中文偏好的浏览器打开 https://my-drama.com/ 会被站点 307 到 /zh，订阅与适配器只认 /，整条订阅每轮
// 抓 0 条；中文偏好下播放页的 og:description 也是空的。后台用一条 declarativeNetRequest 动态规则把
// SiteRegistry.FORCE_ENGLISH_DOMAINS 的 accept-language 固定成英文（权限 declarativeNetRequestWithHostAccess）。
//
//   E1    SW 启动即装上规则：modifyHeaders 把 accept-language 设成 SiteRegistry 的同一个值，域名取注册表，
//         覆盖页面导航、子框架与 XHR / fetch
//   E2    重复安装幂等：按同一 id 先删后加，不会因「id 已存在」被拒
//   E3    API 不可用（扩展没重新加载 / manifest 缺权限）：初始化照常走完，只记一条告警
//   E4    updateDynamicRules reject：不冒成未处理的 rejection，只记告警
//   E5    SiteRegistry.isForceEnglishUrl 的点边界匹配
//   E6    manifest 声明的是不弹安装提示的 declarativeNetRequestWithHostAccess
// 用法：node tests/unit-force-english.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { background } from './background-fixture.mjs';

const require = createRequire(import.meta.url);
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });
const show = v => JSON.stringify(v);
const SiteRegistry = require('../src/shared/site-registry.js');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

// 把后台的 console.warn 收进数组（夹具缺省的 console 是空实现）
const captureWarnings = bg => {
  const warnings = [];
  bg.context.console.warn = (...args) => warnings.push(args.map(String).join(' '));
  return warnings;
};

// ---------- E1 / E2 ----------
{
  const bg = await background({ dnr: true });
  const rules = [...bg.dnr.rules.values()];
  const rule = rules[0];
  const header = rule?.action?.requestHeaders?.[0];
  check('E1a SW 启动即装上恰好一条动态规则', rules.length === 1 && bg.dnr.calls.length === 1, show(bg.dnr.calls));
  check('E1b 动作：modifyHeaders 把 accept-language 设成 SiteRegistry 的英文值',
    rule?.action?.type === 'modifyHeaders' && header?.header === 'accept-language' && header?.operation === 'set'
      && header?.value === SiteRegistry.FORCE_ENGLISH_ACCEPT_LANGUAGE && /^en-US/.test(header?.value), show(rule?.action));
  check('E1c 条件：域名取 FORCE_ENGLISH_DOMAINS（含 my-drama.com），覆盖导航 / 子框架 / XHR 与 fetch',
    show(rule?.condition?.requestDomains) === show([...SiteRegistry.FORCE_ENGLISH_DOMAINS])
      && rule.condition.requestDomains.includes('my-drama.com')
      && ['main_frame', 'sub_frame', 'xmlhttprequest'].every(t => rule.condition.resourceTypes.includes(t)), show(rule?.condition));
  check('E1d 安装时先按同一 id 删旧规则（removeRuleIds）', show(bg.dnr.calls[0]?.removeRuleIds) === show([rule?.id]), show(bg.dnr.calls[0]));

  const warnings = captureWarnings(bg);
  bg.run('installForceEnglishRule()');
  await bg.flush();
  check('E2 再装一次（下一次 SW 启动）仍只有一条规则，且没有因 id 重复被拒',
    bg.dnr.rules.size === 1 && bg.dnr.calls.length === 2 && warnings.length === 0, show({ calls: bg.dnr.calls.length, warnings }));
}

// ---------- E3 API 不可用 ----------
{
  const bg = await background();
  check('E3a 没有 declarativeNetRequest 时初始化照常走完（看门狗闹钟已装）', bg.alarms.has('watchdog'), show([...bg.alarms.keys()]));
  const warnings = captureWarnings(bg);
  let threw = null;
  try {
    bg.run('installForceEnglishRule()');
  } catch (e) {
    threw = e;
  }
  check('E3b 不抛错，只记一条「规则未生效」告警', threw === null && warnings.length === 1 && warnings[0].includes('固定英文页规则未生效'),
    show({ threw: threw?.message, warnings }));
}

// ---------- E4 updateDynamicRules reject ----------
{
  const bg = await background({ dnr: 'reject' });
  check('E4a reject 时初始化照常走完（看门狗闹钟已装）', bg.alarms.has('watchdog'), show([...bg.alarms.keys()]));
  const warnings = captureWarnings(bg);
  bg.run('installForceEnglishRule()');
  await bg.flush();
  check('E4b rejection 被接住，只记告警（未处理的 rejection 会让本套件直接崩掉）',
    warnings.length === 1 && warnings[0].includes('固定英文页规则未生效') && warnings[0].includes('rejected'), show(warnings));
}

// ---------- E5 isForceEnglishUrl ----------
{
  const cases = [
    ['https://my-drama.com/', true],
    ['https://my-drama.com/?list=best_choices', true],
    ['https://my-drama.com/video/9340c70d-230a-4ef1-9f75-8269a0f49477', true],
    ['https://fandom.my-drama.com/', true],
    ['https://notmy-drama.com/', false],
    ['https://my-drama.com.evil.example/', false],
    ['https://www.reelshort.com/', false],
    ['not a url', false],
    ['', false]
  ];
  const wrong = cases.filter(([url, want]) => SiteRegistry.isForceEnglishUrl(url) !== want);
  check('E5 isForceEnglishUrl 按点边界匹配裸域与子域，其余（含仿冒域名、坏地址）一律 false', wrong.length === 0, show(wrong));
}

// ---------- E6 manifest ----------
check('E6 manifest 声明 declarativeNetRequestWithHostAccess（不弹安装提示），没有申请会弹提示的 declarativeNetRequest',
  manifest.permissions.includes('declarativeNetRequestWithHostAccess') && !manifest.permissions.includes('declarativeNetRequest'),
  show(manifest.permissions));

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failedCount = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failedCount}/${results.length} 通过`);
process.exit(failedCount ? 1 : 0);
