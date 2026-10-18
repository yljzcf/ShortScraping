/**
 * 界面线条图标（v1.8.0 起取代 emoji）：弹窗、局域网共享页、设置页共用这一份。
 *
 * emoji 在不同系统上字形、大小、配色都不一样，和站点 logo 混排时显得杂乱；扩展页又不能从 CDN
 * 加载字体图标，所以把用得到的几十个图标以内联 SVG 路径收在这里。路径取自 Tabler Icons（MIT），
 * 24×24 视框、描边 currentColor——颜色跟随所在元素的文字色，尺寸默认 1em（跟随字号）。
 *
 * 用法：
 *   - 静态 HTML 写占位 <span data-icon="settings"></span>，本文件载入后在 DOMContentLoaded 时
 *     自动填成 SVG（hydrate）；
 *   - 脚本里要换按钮图标时用 Icons.svg(name) 拿标记串（innerHTML 写入，内容全是本文件的常量）。
 *
 * 加载方式：页面 <script> 标签（挂 globalThis.Icons）/ 测试经 require（module.exports）。
 */
(function (global) {
  'use strict';

  const PATHS = {
    language: ['M4 5h7', 'M9 3v2c0 4.418 -2.239 8 -5 8', 'M5 9c0 2.144 2.952 3.908 6.7 4', 'M12 20l4 -9l4 9', 'M19.1 18h-6.2'],
    settings: [
      'M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z',
      'M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0'
    ],
    folder: ['M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2'],
    refresh: ['M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4'],
    stop: ['M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z'],
    play: ['M7 4v16l13 -8z'],
    wifi: ['M12 18l.01 0', 'M9.172 15.172a4 4 0 0 1 5.656 0', 'M6.343 12.343a8 8 0 0 1 11.314 0', 'M3.515 9.515c4.686 -4.687 12.284 -4.687 17 0'],
    qrcode: [
      'M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z', 'M7 17l0 .01',
      'M14 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z', 'M7 7l0 .01',
      'M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z', 'M17 7l0 .01',
      'M14 14l3 0', 'M20 14l0 .01', 'M14 14l0 3', 'M14 20l3 0', 'M17 17l3 0', 'M20 17l0 3'
    ],
    tv: ['M3 9a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -9', 'M16 3l-4 4l-4 -4'],
    check: ['M5 12l5 5l10 -10'],
    x: ['M18 6l-12 12', 'M6 6l12 12'],
    loader: ['M12 3a9 9 0 1 0 9 9'],
    world: ['M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0', 'M3.6 9h16.8', 'M3.6 15h16.8', 'M11.5 3a17 17 0 0 0 0 18', 'M12.5 3a17 17 0 0 1 0 18'],
    database: ['M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0', 'M4 6v6a8 3 0 0 0 16 0v-6', 'M4 12v6a8 3 0 0 0 16 0v-6'],
    adjustments: [
      'M12 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M4 6l8 0', 'M16 6l4 0',
      'M6 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M4 12l2 0', 'M10 12l10 0',
      'M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M4 18l11 0', 'M19 18l1 0'
    ],
    dashboard: [
      'M5 4h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1',
      'M5 16h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1',
      'M15 12h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1',
      'M15 4h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1'
    ],
    'table-export': ['M12.5 21h-7.5a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v7.5', 'M3 10h18', 'M10 3v18', 'M16 19h6', 'M19 16l3 3l-3 3'],
    send: ['M10 14l11 -11', 'M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5'],
    'file-text': ['M14 3v4a1 1 0 0 0 1 1h4', 'M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z', 'M9 9l1 0', 'M9 13l6 0', 'M9 17l6 0'],
    clock: ['M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0', 'M12 7v5l3 3'],
    robot: [
      'M6 6a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -4', 'M12 2v2', 'M9 12v9', 'M15 12v9',
      'M5 16l4 -2', 'M15 14l4 2', 'M9 18h6', 'M10 8v.01', 'M14 8v.01'
    ],
    plug: ['M9.785 6l8.215 8.215l-2.054 2.054a5.81 5.81 0 1 1 -8.215 -8.215l2.054 -2.054z', 'M4 20l3.5 -3.5', 'M15 4l-3.5 3.5', 'M20 9l-3.5 3.5'],
    tool: ['M7 10h3v-3l-3.5 -3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1 -3 3l-6 -6a6 6 0 0 1 -8 -8l3.5 3.5'],
    photo: [
      'M15 8h.01', 'M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12z',
      'M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5', 'M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3'
    ],
    package: ['M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5', 'M12 12l8 -4.5', 'M12 12l0 9', 'M12 12l-8 -4.5', 'M16 5.25l-8 4.5'],
    apps: [
      'M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z',
      'M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z',
      'M14 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z', 'M14 7l6 0', 'M17 4l0 6'
    ],
    alert: ['M12 9v4', 'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z', 'M12 16h.01'],
    eraser: ['M19 20h-10.5l-4.21 -4.3a1 1 0 0 1 0 -1.41l10 -10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.41l-9.2 9.3', 'M18 13.3l-6.3 -6.3']
  };

  const NAMES = Object.freeze(Object.keys(PATHS));

  /** 图标的 SVG 标记串；未登记的名字返回空串（调用方照常写入，不会抛错）。 */
  function svg(name) {
    const paths = Object.prototype.hasOwnProperty.call(PATHS, name) ? PATHS[name] : null;
    if (!paths) return '';
    return `<svg class="icon icon-${name}" viewBox="0 0 24 24" width="1em" height="1em" fill="none" `
      + 'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + paths.map(d => `<path d="${d}"/>`).join('') + '</svg>';
  }

  /** 把 root 下所有 [data-icon] 占位填成 SVG；已经填过的跳过，可重复调用。 */
  function hydrate(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    for (const el of root.querySelectorAll('[data-icon]')) {
      if (el.querySelector('svg')) continue;
      el.insertAdjacentHTML('afterbegin', svg(el.dataset.icon));
    }
  }

  const api = { NAMES, svg, hydrate };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.Icons = api;

  // 页面脚本都放在 body 末尾，执行时 DOMContentLoaded 还没触发：等它一到就填好静态占位
  if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function'
    && typeof document.querySelectorAll === 'function') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => hydrate(document));
    } else {
      hydrate(document);
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
