import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(directory).filter(name => /^unit-.*\.mjs$/.test(name)).sort();
let failed = 0;
for (const file of files) {
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(directory, file)], {
      cwd: path.dirname(directory), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('error', error => { clearTimeout(timer); resolve({ code: 1, output: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${file}`);
  if (result.code !== 0) { failed++; console.log(result.output); }
}
console.log(`${files.length - failed}/${files.length} suites passed`);
process.exitCode = failed ? 1 : 0;
