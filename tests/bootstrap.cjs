// Existing browser unit fixtures stub importScripts; preload its new shared dependencies.
require('../src/shared/translate-config.js');
require('../src/shared/url-match.js'); // subscription-config 的依赖，须先于它
require('../src/shared/subscription-config.js');

// Recursive cleanup must stay inside a directory created by this test process.
const fs = require('node:fs');
const path = require('node:path');
const roots = new Set();
const makeTemp = fs.mkdtempSync;
const remove = fs.rmSync;
fs.mkdtempSync = function (...args) {
  const result = makeTemp.apply(fs, args);
  roots.add(path.resolve(String(result)));
  return result;
};
fs.rmSync = function (target, options) {
  if (options?.recursive) {
    const resolved = path.resolve(target);
    const allowed = [...roots].some(root => {
      const relative = path.relative(root, resolved);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!allowed) throw new Error(`Refusing cleanup outside this test's temporary directories: ${resolved}`);
  }
  return remove.call(fs, target, options);
};
