/**
 * ShortScraping 时间线渲染共享模块
 *
 * 弹窗（src/popup/popup.js）与局域网共享页（server/public/share.js）共用的
 * 纯 DOM 渲染逻辑。本文件不依赖 chrome.* API：扩展相关行为（翻译按钮回调等）
 * 由调用方通过 opts 注入；共享页由同步服务以 /shared/timeline-render.js 伺服
 * 同一份文件，保证两端渲染永不漂移。
 */
(function (global) {
  'use strict';

  // 分类标签：按 source 筛选时间线
  const CATEGORY_SOURCES = ['imdb', 'steam', 'royalroad', 'mydrama', 'reelshort', 'dramashorts'];

  const DEFAULT_OPTS = {
    source: 'imdb',
    readOnly: false,
    onTranslate: null,
    assetsBase: '../../assets/icons'
  };

  function dramaSource(drama) {
    return CATEGORY_SOURCES.includes(drama.source) ? drama.source : 'imdb';
  }

  function pickDefaultSource(dramas) {
    return CATEGORY_SOURCES.find(src => (dramas || []).some(d => dramaSource(d) === src)) || 'imdb';
  }

  /**
   * 按日期和时间分组（±1min 合并）
   */
  function groupByDate(dramas) {
    const groups = {};

    dramas.forEach(drama => {
      if (!drama.scrapedAt) {
        const date = '未知日期';
        if (!groups[date]) groups[date] = { timeGroups: [] };
        groups[date].timeGroups.push({ time: null, dramas: [drama] });
        return;
      }

      const dateObj = new Date(drama.scrapedAt);
      const date = dateObj.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      if (!groups[date]) {
        groups[date] = { timeGroups: [] };
      }

      // 查找是否有 ±1min 内的时间组
      const timeMs = dateObj.getTime();
      let found = false;

      for (const tg of groups[date].timeGroups) {
        if (tg.time && Math.abs(tg.time - timeMs) < 60000) {
          tg.dramas.push(drama);
          found = true;
          break;
        }
      }

      if (!found) {
        groups[date].timeGroups.push({
          time: timeMs,
          timeStr: formatTime(drama.scrapedAt),
          dramas: [drama]
        });
      }
    });

    return groups;
  }

  /**
   * 格式化时间
   */
  function formatTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  /**
   * 格式化相对时间
   */
  function formatRelativeTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    return `${days} 天前`;
  }

  /**
   * 截断文本
   */
  function truncate(text, maxLen) {
    if (!text) return '';
    return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
  }

  /**
   * 转义 HTML
   */
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // escapeHtml 不转义双引号，插入 HTML 属性值的内容（抓取的标题/海报 URL 等）必须用这个
  function escapeAttribute(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
  }

  /**
   * 获取卡片显示标签。兼容旧数据没有 tags 字段的情况。
   */
  function getDisplayTags(drama) {
    if (Array.isArray(drama.tags) && drama.tags.length > 0) {
      return drama.tags.slice(0, 3);
    }

    const sourceNames = { imdb: 'IMDB', steam: 'Steam', royalroad: 'RoyalRoad', mydrama: 'MyDrama', reelshort: 'ReelShort', dramashorts: 'DramaShorts' };
    const tags = [sourceNames[drama.source] || 'IMDB'];

    if (drama.genre) {
      tags.push(String(drama.genre).toLowerCase());
    } else if (drama.sourceListUrl) {
      const genreMatch = drama.sourceListUrl.match(/genres=([^&,]+)/i);
      if (genreMatch) {
        tags.push(decodeURIComponent(genreMatch[1]).toLowerCase());
      }
    }

    return tags.slice(0, 3);
  }

  /**
   * 创建剧集卡片。opts.readOnly 为 true 时不渲染翻译按钮（共享页纯浏览）。
   */
  function createDramaCard(drama, opts) {
    const options = Object.assign({}, DEFAULT_OPTS, opts);
    const defaultPoster = `${options.assetsBase}/default-poster.svg`;

    const card = document.createElement('div');
    card.className = `drama-card ${drama.status === 'new' ? 'status-new' : ''} ${drama.source === 'steam' ? 'card-landscape' : ''}`;
    card.dataset.id = drama.id;

    // 标题：中文（英文）或 英文；trim 防止仅含空白的字段渲染出空行
    const titleZh = (drama.titleZh || '').trim();
    const titleDisplay = titleZh
      ? `${titleZh}（${drama.title}）`
      : drama.title;

    // 简介
    const descZh = (drama.descriptionZh || '').trim();
    const descEn = (drama.description || '').trim();

    card.innerHTML = `
      ${drama.status === 'new' ? '<div class="status-badge">待翻译</div>' : ''}
      ${options.readOnly ? '' : `<button class="btn-translate" title="翻译此卡片" data-id="${escapeAttribute(drama.id)}">🌍</button>`}
      <div class="card-content">
        <div class="card-top">
          <img class="card-poster" src="${escapeAttribute(drama.poster || defaultPoster)}" alt="${escapeAttribute(drama.title)}">
          <div class="card-main">
            <div class="card-title">
              <div class="card-title-text" title="${escapeAttribute(titleDisplay)}">${escapeHtml(titleDisplay)}</div>
            </div>
            <div class="card-description">
              ${descZh ? `<div class="card-desc-zh${descEn ? '' : ' desc-zh-only'}">${escapeHtml(descZh)}</div>` : ''}
              ${descEn ? `<div class="card-desc-en${descZh ? '' : ' desc-en-only'}">${escapeHtml(descEn)}</div>` : ''}
              ${!descZh && !descEn ? '<div class="card-desc-empty">暂无简介</div>' : ''}
            </div>
          </div>
        </div>
        <div class="card-footer">
          <div class="card-tags-left">
            ${getDisplayTags(drama).map(tag => `<span class="tag tag-source">${escapeHtml(tag)}</span>`).join('')}
          </div>
          ${drama.company ? `<div class="card-tags-right"><span class="tag tag-company">${escapeHtml(truncate(drama.company, 20))}</span></div>` : ''}
        </div>
      </div>
    `;

    // 绑定翻译按钮事件（只读模式不渲染按钮）
    if (!options.readOnly) {
      const translateBtn = card.querySelector('.btn-translate');
      if (translateBtn && typeof options.onTranslate === 'function') {
        translateBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          options.onTranslate(drama.id, translateBtn);
        });
      }
    }

    // 封面方向：横版（宽>高）置于文字上方整行铺开，竖版保持左侧；按图片实际尺寸判定。
    // source 作初始猜测避免布局闪动，加载后用真实尺寸校正。
    const posterImg = card.querySelector('.card-poster');
    if (posterImg) {
      // 扩展页 CSP 禁止内联 onerror 属性，海报加载失败的默认图回退用监听器实现；
      // once 兼防默认图自身也加载失败时的换源死循环
      posterImg.addEventListener('error', () => {
        posterImg.src = defaultPoster;
      }, { once: true });
      const applyOrientation = () => {
        if (posterImg.naturalWidth && posterImg.naturalHeight) {
          card.classList.toggle('card-landscape', posterImg.naturalWidth > posterImg.naturalHeight);
          // 竖版空间预算取决于海报实际高度，横竖翻转又会改文字列宽，加载后必须重排
          adjustCardDescription(card);
        }
      };
      if (posterImg.complete) applyOrientation();
      else posterImg.addEventListener('load', applyOrientation);
    }

    return card;
  }

  /**
   * 简介动态排版（仅中英双语卡片，单语卡片沿用静态规则）：
   * - 中文实际超过 3 行：放宽为 4 行中文 + 2 行英文；
   * - 中文有富余空间不足时：英文行数补齐剩余空间；
   * - 中英文全文放完仍有大段空白：整体放大字号（desc-large，14px 3中+2英）。
   * 竖版卡（海报在左）以「简介顶部到海报底边 + 内容区 gap」为固定预算分配整行，
   * 上半区高度钉死为海报高，文字只填充原有空隙、分割线绝不因文字增行下移；
   * 横版卡（封面在上，Steam 等高双列）无海报边界，按行数规则分配（合计 7 行封顶）。
   * 行数按 scrollHeight / line-height 测量（line-clamp 不影响 scrollHeight），
   * 必须在卡片进入可见 DOM 后调用；测得 0 行（容器不可见）时保持默认样式。
   */
  function adjustCardDescription(card) {
    const zhEl = card.querySelector('.card-desc-zh');
    const enEl = card.querySelector('.card-desc-en');
    if (!zhEl || !enEl) return;

    const box = card.querySelector('.card-description');
    const cardTop = card.querySelector('.card-top');
    box.classList.remove('desc-large');
    zhEl.style.removeProperty('-webkit-line-clamp');
    enEl.style.removeProperty('-webkit-line-clamp');
    if (cardTop) cardTop.style.removeProperty('height');

    const countLines = el => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      return lineHeight > 0 ? Math.round(el.scrollHeight / lineHeight) : 0;
    };

    const zhLines = countLines(zhEl);
    const enLines = countLines(enEl);
    if (zhLines === 0 || enLines === 0) return;

    const poster = card.querySelector('.card-poster');
    if (!card.classList.contains('card-landscape') && cardTop && poster && poster.offsetHeight > 40) {
      const zhLh = parseFloat(getComputedStyle(zhEl).lineHeight);
      const enLh = parseFloat(getComputedStyle(enEl).lineHeight);
      const zhGap = parseFloat(getComputedStyle(zhEl).marginBottom) || 0;
      const contentGap = parseFloat(getComputedStyle(cardTop.parentElement).rowGap) || 0;
      // 文字可下溢到海报底边之下、吃掉内容区 gap，与分割线保持 footer margin 的间距
      const budget = poster.getBoundingClientRect().bottom - box.getBoundingClientRect().top + contentGap;
      const fits = (zh, en) => zh * zhLh + zhGap + en * enLh <= budget + 0.5;

      let zhShow = zhLines > 3 && fits(4, 2) ? 4 : Math.min(zhLines, 3);
      while (zhShow > 1 && !fits(zhShow, 1)) zhShow--;
      const enShow = Math.max(1, Math.floor((budget - zhShow * zhLh - zhGap) / enLh));

      const sparse = zhLines <= zhShow && enLines <= enShow &&
        budget - (zhLines * zhLh + zhGap + enLines * enLh) >= enLh;
      if (sparse) {
        box.classList.add('desc-large');
      } else {
        if (zhShow !== 3) zhEl.style.setProperty('-webkit-line-clamp', String(zhShow));
        if (enShow !== 2) enEl.style.setProperty('-webkit-line-clamp', String(enShow));
      }
      // 上半区高度钉死为海报高：文字增行只填充空隙，分割线不动
      cardTop.style.height = `${poster.offsetHeight}px`;
      return;
    }

    if (zhLines > 3) {
      zhEl.style.setProperty('-webkit-line-clamp', '4');
    } else if (zhLines + enLines < 7) {
      box.classList.add('desc-large');
    } else if (zhLines < 3) {
      enEl.style.setProperty('-webkit-line-clamp', String(7 - zhLines));
    }
  }

  /**
   * 渲染时间线到 container。dramas 需为调用方按当前站点过滤后的列表；
   * 返回是否有数据（供调用方切换空状态显示）。
   */
  function renderTimeline(container, dramas, opts) {
    const options = Object.assign({}, DEFAULT_OPTS, opts);
    container.dataset.source = options.source;
    container.innerHTML = '';

    const list = dramas || [];
    if (list.length === 0) return false;

    // 按日期分组
    const grouped = groupByDate(list);

    Object.entries(grouped).forEach(([date, groupData]) => {
      const group = document.createElement('div');
      group.className = 'timeline-date-group';

      const dateHeader = document.createElement('div');
      dateHeader.className = 'timeline-date-header';
      dateHeader.textContent = date;
      group.appendChild(dateHeader);

      // 遍历时间组
      groupData.timeGroups.forEach(tg => {
        // 时间标签（±1min 内的卡片共享一个时间）
        if (tg.timeStr) {
          const timeEl = document.createElement('div');
          timeEl.className = 'timeline-time';
          timeEl.textContent = tg.timeStr;
          group.appendChild(timeEl);
        }

        // 该时间组内的所有卡片；奇数张时首卡标记 card-full，
        // Steam 双列下横跨整行，避免出现单卡独占一行的空缺
        const oddCount = tg.dramas.length % 2 === 1;
        tg.dramas.forEach((drama, index) => {
          const card = createDramaCard(drama, options);
          if (oddCount && index === 0) card.classList.add('card-full');
          group.appendChild(card);
        });
      });

      container.appendChild(group);
    });

    // 卡片进入 DOM 后按实际渲染行数微调简介排版
    container.querySelectorAll('.drama-card').forEach(adjustCardDescription);
    return true;
  }

  global.TimelineRender = {
    CATEGORY_SOURCES,
    dramaSource,
    pickDefaultSource,
    groupByDate,
    renderTimeline,
    createDramaCard,
    adjustCardDescription,
    getDisplayTags,
    formatTime,
    formatRelativeTime,
    truncate,
    escapeHtml,
    escapeAttribute
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
