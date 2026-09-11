import './bootstrap.cjs';
// 单元校验：category 分支与旧实现逐字节一致；tags 分支拼出 tag+nTagID；无 hub 数据返回 null
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const fnSrc = src.match(/function buildSteamQueryUrl[\s\S]*?\n  \}/)[0];

const STEAM_QUERY_COUNT = 50;
let stubTagId = null;
// eslint-disable-next-line no-unused-vars
const readSteamTagIdFromPage = () => stubTagId;
const buildSteamQueryUrl = eval(`(${fnSrc.replace('function buildSteamQueryUrl', 'function')})`);

// 改动前的旧实现，作为 category 行为基线
function oldBuild(pageUrl) {
  let category = '';
  let flavor = '';
  try {
    const u = new URL(pageUrl);
    const m = u.pathname.match(/\/category\/([^/?#]+)/);
    category = m ? m[1] : '';
    flavor = u.searchParams.get('flavor') || 'contenthub_newandtrending';
  } catch (e) {
    return null;
  }
  if (!category) return null;
  const params = new URLSearchParams({
    cc: 'us',
    l: 'english',
    flavor,
    start: '0',
    count: String(STEAM_QUERY_COUNT),
    strContentHubType: 'category',
    strContentHubCategory: category,
    return_capsules: 'false',
    origin: 'https://store.steampowered.com'
  });
  return `https://store.steampowered.com/saleaction/ajaxgetsaledynamicappquery?${params.toString()}`;
}

const results = [];
const catUrls = [
  'https://store.steampowered.com/category/visual_novel?flavor=contenthub_newandtrending',
  'https://store.steampowered.com/category/visual_novel?flavor=popularcomingsoon',
  'https://store.steampowered.com/category/visual_novel'
];
for (const u of catUrls) {
  results.push({ case: `category 等价 ${u.slice(-30)}`, pass: buildSteamQueryUrl(u) === oldBuild(u) });
}

stubTagId = 18594;
const tagsUrl = 'https://store.steampowered.com/tags/zh-cn/%E5%85%A8%E5%8A%A8%E6%80%81%E5%BD%B1%E5%83%8F/?flavor=popularcomingsoon';
const built = buildSteamQueryUrl(tagsUrl);
results.push({ case: 'tags 含 strContentHubType=tag', pass: built.includes('strContentHubType=tag&') });
results.push({ case: 'tags 含 nTagID=18594', pass: built.includes('nTagID=18594') });
results.push({ case: 'tags 保留 flavor', pass: built.includes('flavor=popularcomingsoon') });

stubTagId = null;
results.push({ case: 'tags 无 hub 数据返回 null', pass: buildSteamQueryUrl(tagsUrl) === null });
results.push({ case: '非 hub 页面返回 null', pass: buildSteamQueryUrl('https://store.steampowered.com/app/123/') === null });

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.case}`).join('\n'));
console.log('\ntags 查询串:', built);
if (results.some(r => !r.pass)) process.exit(1);
