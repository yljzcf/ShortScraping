// manifest 的内容脚本域名清单是派生产物；站点元数据仍只维护 src/shared/site-registry.js。
// 用法：npm run update-sites（新增站点后跑一次，回归 unit-audit-regressions 会核对一致性）
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SiteRegistry = require('../src/shared/site-registry.js');

const file = new URL('../manifest.json', import.meta.url);
const text = fs.readFileSync(file, 'utf8');
const manifest = JSON.parse(text);
const matches = SiteRegistry.contentScriptMatches();

const content = manifest.content_scripts.find(entry => entry.js.includes('src/content/content.js'));
if (!content) throw new Error('未找到内容脚本配置');

if (JSON.stringify(content.matches) !== JSON.stringify(matches)) {
  // 只替换 matches 这一段，其余字节原样保留：整文件 JSON.stringify 会把行内的
  // "js"/"css" 数组炸成多行、并把工作副本的 CRLF 压成 LF，diff 里混进与站点无关的噪音
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = `"matches": [${eol}${matches.map(m => `        ${JSON.stringify(m)}`).join(`,${eol}`)}${eol}      ]`;
  const updated = text.replace(/"matches"\s*:\s*\[[^\]]*\]/, block);
  if (updated === text) throw new Error('未能在 manifest.json 中定位 matches 段');
  fs.writeFileSync(file, updated);
  console.log(`内容脚本域名清单已更新（${matches.length} 项）`);
} else {
  console.log(`内容脚本域名清单已是最新（${matches.length} 项）`);
}
