// 测试用的极小 DOM 模型（v1.6.9 起给 Shortical / ShortMax 两套适配器用）。
//
// 本仓库零依赖，既有适配器单测都是手写桩；但 Shortical 读实时 DOM、ShortMax 读
// DOMParser 解出的文档，用的是**真正的选择器**（类、属性、后代组合），用「正则抠一段」
// 的桩会把选择器本身排除在考核之外——选择器写错正是这类适配器最常见的失败方式。
//
// 因此这里给一棵**手搭的元素树**（不解析 HTML，避免把 HTML 解析器的 bug 算进被测行为），
// 配一个只覆盖被测代码实际用到的那点选择器语法的匹配器：
//   标签 / .类 / 标签.类 / [attr="v"] / [attr*="v"] / [attr^="v"] / 后代组合 / 逗号选择器组
// 语法之外的写法一律抛错——免得测试悄悄退化成「什么都匹配不到所以通过」。

function parseCompound(text) {
  const compound = { tag: null, classes: [], attrs: [] };
  let rest = text;

  const tag = rest.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  if (tag) { compound.tag = tag[0].toLowerCase(); rest = rest.slice(tag[0].length); }

  while (rest) {
    const cls = rest.match(/^\.([A-Za-z0-9_-]+)/);
    if (cls) { compound.classes.push(cls[1]); rest = rest.slice(cls[0].length); continue; }
    const attr = rest.match(/^\[([A-Za-z-]+)(?:([*^]?)=\s*"([^"]*)")?\]/);
    if (attr) { compound.attrs.push({ name: attr[1], op: attr[2] || '=', value: attr[3] }); rest = rest.slice(attr[0].length); continue; }
    throw new Error(`dom-fixture: 不支持的选择器片段 ${JSON.stringify(text)}（剩余 ${JSON.stringify(rest)}）`);
  }
  if (!compound.tag && !compound.classes.length && !compound.attrs.length) {
    throw new Error(`dom-fixture: 空选择器片段 ${JSON.stringify(text)}`);
  }
  return compound;
}

const parseSelector = selector => String(selector).split(',')
  .map(part => part.trim()).filter(Boolean)
  .map(part => part.split(/\s+/).map(parseCompound));

function matchesCompound(node, compound) {
  if (compound.tag && node.tagName !== compound.tag) return false;
  const classList = String(node.attrs.class || '').split(/\s+/).filter(Boolean);
  if (!compound.classes.every(c => classList.includes(c))) return false;
  return compound.attrs.every(({ name, op, value }) => {
    const actual = node.attrs[name];
    if (actual == null) return false;
    if (value === undefined) return true;                 // 只判属性存在
    if (op === '*') return String(actual).includes(value);
    if (op === '^') return String(actual).startsWith(value);
    return String(actual) === value;
  });
}

/** 末段匹配后再逐级往上找前面各段的祖先（不要求相邻，即后代组合符语义）。 */
function matchesChain(node, chain) {
  if (!matchesCompound(node, chain[chain.length - 1])) return false;
  let remaining = chain.slice(0, -1);
  let ancestor = node.parentElement;
  while (remaining.length && ancestor) {
    if (matchesCompound(ancestor, remaining[remaining.length - 1])) remaining = remaining.slice(0, -1);
    ancestor = ancestor.parentElement;
  }
  return remaining.length === 0;
}

class FakeElement {
  constructor(tagName, attrs = {}, children = [], text = '') {
    this.tagName = String(tagName).toLowerCase();
    this.attrs = attrs;
    this.children = [];
    this.parentElement = null;
    this.ownText = text;
    for (const child of children) {
      if (!child) continue;
      child.parentElement = this;
      this.children.push(child);
    }
  }

  get textContent() {
    return this.ownText + this.children.map(c => c.textContent).join('');
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  descendants() {
    const out = [];
    const walk = node => { for (const c of node.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }

  querySelectorAll(selector) {
    const chains = parseSelector(selector);
    return this.descendants().filter(node => chains.some(chain => matchesChain(node, chain)));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

/** el('div', { class: 'card' }, [child, ...], '文本') —— 文本是本节点自己的，子节点各自带各自的。 */
export const el = (tagName, attrs = {}, children = [], text = '') => new FakeElement(tagName, attrs, children, text);

/**
 * 把一棵元素树包成 content.js 能当 document 用的对象：补上抓取按钮那套
 * getElementById / createElement / body，其余选择器直落到树上。
 */
export function documentFrom(root) {
  const fakeElement = () => ({ style: {}, disabled: false, innerHTML: '', addEventListener() {}, querySelector() { return null; } });
  return {
    root,
    getElementById() { return null; },
    createElement() { return fakeElement(); },
    body: { appendChild() {} },
    querySelector: sel => root.querySelector(sel),
    querySelectorAll: sel => root.querySelectorAll(sel)
  };
}
