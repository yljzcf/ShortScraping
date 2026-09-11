// manifest 是生成结果；站点元数据仍只维护 site-registry.js。
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SITES } = require('../src/shared/site-registry.js');
const file = new URL('../manifest.json', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const matches = SITES.map(site => `*://${site.match === 'exact' ? '' : '*.'}${site.host}/*`);
const content = manifest.content_scripts.find(entry => entry.js.includes('src/content/content.js'));
if (!content) throw new Error('未找到内容脚本配置');
if (JSON.stringify(content.matches) !== JSON.stringify(matches)) {
  content.matches = matches;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}
console.log(`内容脚本域名清单已同步（${matches.length} 项）`);
