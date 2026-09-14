import './bootstrap.cjs';
// 卡片版式单测（v1.6.3）。
//
// 背景：封面加载失败时会换成 default-poster.svg（200×300 竖版），旧写法拿**占位图**
// 的比例重判方向，把 Steam 卡（真实 header.jpg 恒为 460×215 横版）摘掉 card-landscape、
// 掉进双列窄版式。那里 .card-main 只有 90px，标题还要给右上三槽位按钮让 80px，
// 2026-09-14 实测标题只剩 10~12px、被裁成一个字（离线/CDN 被挡/游戏下架时整屏都这样）。
//
// 两道防线，分别由 O 组与 C 组守着：
//   O：orientationFromPoster 不拿占位图改判（根因，修完标题 12px → 196px）
//   C：两份 CSS 都带「窄卡标题让行」底线（Steam 真发竖版封面时兜底，12px → 92px）
//      以及「占位图不铺满整行」——popup.css 与 share.css 必须同步，这里防漂移
//
// 用法：node tests/unit-card-layout.mjs
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
(0, eval)(read('../src/shared/site-registry.js'));
(0, eval)(read('../src/shared/timeline-render.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ---------- O 组：封面方向判定 ----------
const orient = globalThis.TimelineRender.orientationFromPoster;
check('O0 orientationFromPoster 已导出', typeof orient === 'function', `typeof=${typeof orient}`);

check('O1 真实横版封面（Steam header 460×215）判横版',
  orient(460, 215, false) === true, String(orient(460, 215, false)));
check('O2 真实竖版封面（2:3 海报）判竖版',
  orient(400, 600, false) === false, String(orient(400, 600, false)));
check('O3 已回退占位图时返回 null＝不改判（保留按 source 定的初始猜测）',
  orient(200, 300, true) === null, String(orient(200, 300, true)));
check('O3b 占位图恰好是横版也一样不改判（形状不带信息，不是「竖版才跳过」）',
  orient(460, 215, true) === null, String(orient(460, 215, true)));
check('O4 尺寸未知（图还没解码）返回 null，不瞎判',
  orient(0, 0, false) === null && orient(undefined, undefined, false) === null,
  `${orient(0, 0, false)} / ${orient(undefined, undefined, false)}`);
check('O5 正方形不算横版（宽>高才是）', orient(300, 300, false) === false, String(orient(300, 300, false)));

// ---------- C 组：两份 CSS 同步 ----------
const CSS = {
  'src/popup/popup.css': read('../src/popup/popup.css'),
  'server/public/share.css': read('../server/public/share.css')
};
// 空白无关的包含判断：两份文件缩进不同（share.css 的双列规则在 @media 块里）
const squash = s => s.replace(/\s+/g, ' ');
const ruleBody = (src, selector) => {
  const m = squash(src).match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`));
  return m ? m[1].trim() : null;
};
for (const [rel, src] of Object.entries(CSS)) {
  // 占位图不带信息，横版布局（封面在上）留着它就白占一整行把卡片撑高 → 不显示
  const poster = ruleBody(src, '.drama-card.poster-fallback.card-landscape .card-poster');
  check(`C1 ${rel} 横版下的占位图不显示`, Boolean(poster) && /display:\s*none/.test(poster),
    poster || '(未匹配到规则)');
  // 占位图一藏，标题成了最上面的元素，必须让到右上按钮带下方，否则被压住
  const title = ruleBody(src, '.drama-card.poster-fallback.card-landscape .card-title');
  check(`C1b ${rel} 藏了占位图后标题让到按钮下方`, Boolean(title) && /margin-top:\s*[1-9]/.test(title),
    title || '(未匹配到规则)');
  check(`C2 ${rel} 有「窄卡标题让行」底线规则`,
    squash(src).includes('.drama-card:not(.card-full):not(.card-landscape) .card-title'), '');
}
// 让行规则必须真的把 padding-right 归零，否则 80px 预留还在、标题照样只剩 10px
for (const [rel, src] of Object.entries(CSS)) {
  const m = squash(src).match(/\.drama-card:not\(\.card-full\):not\(\.card-landscape\) \.card-title \{([^}]*)\}/);
  check(`C3 ${rel} 的让行规则清掉了 padding-right`,
    Boolean(m) && /padding-right:\s*0/.test(m[1]), m ? m[1].trim() : '(未匹配到规则)');
}
// 加 poster-fallback 类的是共享渲染模块，两页共用——类名拼错就全盘失效
check('C4 timeline-render 在封面失败时加 poster-fallback 类',
  read('../src/shared/timeline-render.js').includes("classList.add('poster-fallback')"), '');

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`).join('\n'));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
