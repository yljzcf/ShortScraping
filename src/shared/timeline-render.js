/**
 * ShortScraping 时间线渲染共享模块
 *
 * 弹窗（src/popup/popup.js）与局域网共享页（server/public/share.js）共用的
 * 纯 DOM 渲染逻辑。本文件不依赖 chrome.* API：扩展相关行为（翻译按钮、封面
 * 点击打开原站等回调）由调用方通过 opts 注入；共享页由同步服务以
 * /shared/timeline-render.js 伺服
 * 同一份文件，保证两端渲染永不漂移。
 */
(function (global) {
  'use strict';

  // 分类标签：按 source 筛选时间线。站点全集单一真源在 site-registry.js（须先加载）
  const CATEGORY_SOURCES = global.SiteRegistry.CATEGORY_SOURCES;

  const DEFAULT_OPTS = {
    source: 'imdb',
    readOnly: false,
    onTranslate: null,
    onLarkPush: null,
    onOpenUrl: null,
    // 封面菜单「搜 X」（v1.7.3）：(dramaId) => Promise，弹窗注入（交给后台查找并开页）；共享页不传
    onOpenPlatform: null,
    // 弹窗搜索（v1.8.2）：命中词高亮（DramaSearch.parseQuery 的结果）与「已退订」标记，共享页不传
    highlightTerms: null,
    // 经中文对照命中的英文题材（小写数组），对应的题材标签整枚标亮
    highlightGenres: null,
    isUnsubscribed: null,
    // 卡片显示语言（v1.8.12）：'zh' | 'en'，标题、简介、内容标签只显示这一种（缺了退回另一种）
    lang: 'zh',
    assetsBase: '../../assets/icons'
  };

  // 两页右上角「中 / EN」按钮的文字与悬停提示（按钮显示当前语言）
  const LANG_LABELS = Object.freeze({
    zh: Object.freeze({ text: '中', title: '显示语言：中文（点击切换为英文）' }),
    en: Object.freeze({ text: 'EN', title: '显示语言：英文（点击切换为中文）' })
  });
  // 存储里读回来的值不可信（缺省、旧版本、手改），不认识的一律当中文
  const normalizeLang = lang => (lang === 'en' ? 'en' : 'zh');

  // 卡片归哪个站点：单一真源在 SiteRegistry.siteOfDrama（与同步服务同口径，v1.7.0 收拢）
  const dramaSource = drama => global.SiteRegistry.siteOfDrama(drama);

  // 标题文案单一真源在 translate-config.js（弹窗/共享页卡片、多维表格 payload、
  // 群机器人卡片三处共用，见那边 titleDisplay 的注释）。须先加载该模块。
  // v1.8.12 起卡片只显示一种语言，「中文（英文）」留给标题的悬停提示
  const titleDisplayOf = global.TranslateConfig.titleDisplay;

  /**
   * 由封面实际尺寸判定卡片是否走横版布局；返回 null＝**不改判**，保留按 source
   * 定的初始猜测。
   *
   * `usedFallback` 是必需的一档：封面加载失败时会换成 default-poster.svg
   * （200×300 竖版），而**占位图的比例跟真实封面毫无关系**。旧写法拿它重判，
   * 于是 Steam 卡（真实 header.jpg 恒为 460×215 横版）在离线/CDN 被挡/游戏下架
   * 时被摘掉 card-landscape，掉进双列窄版式——那里 .card-main 只有 90px，
   * 而标题还要给右上三槽位按钮让出 80px，实测标题只剩 10px、被裁成一个字。
   * 非 Steam 站点初始就不带 card-landscape，这一档对它们是无变化的。
   */
  function orientationFromPoster(naturalWidth, naturalHeight, usedFallback) {
    if (usedFallback) return null;
    if (!naturalWidth || !naturalHeight) return null;
    return naturalWidth > naturalHeight;
  }

  // 封面可点性闸门：条目 url 为 http(s) 时即为封面点击目标，否则封面不可点
  // （拦截缺 url 的历史条目与 javascript: 等异常值）
  function posterLinkUrl(drama) {
    const url = drama && drama.url;
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  }

  /**
   * 封面菜单的菜单项（v1.7.3）：只给已知平台的 IMDb 卡——IMDb 没有播放页，按出品公司能反查
   * 平台（SiteRegistry.imdbPlatformOf）。返回 null＝不弹菜单，封面照旧直接打开原站。
   * - 弹窗（传了 onOpenPlatform）：「搜 X」交给后台查，唯一同名直达播放页，多部 / 没搜到开搜索结果页
   *   （没有搜索页的平台开平台页，v1.8.7）；
   * - 共享页（没有扩展后台，查不了）：「搜 X」打开条目上记下的播放页，没有就开平台搜索页或平台页，都没有不弹。
   * 每项为 { label, url }（直接打开）或 { label, platform: true }（交给 onOpenPlatform）。
   */
  function posterMenuItems(drama, opts) {
    const options = Object.assign({}, DEFAULT_OPTS, opts);
    const registry = global.SiteRegistry;
    const site = registry.imdbPlatformOf(drama);
    const imdbUrl = posterLinkUrl(drama);
    if (!site || !imdbUrl || typeof options.onOpenUrl !== 'function') return null;

    const label = `搜 ${registry.SOURCE_NAMES[site] || site}`;
    let platformItem = null;
    if (typeof options.onOpenPlatform === 'function') {
      platformItem = { label, platform: true };
    } else {
      const stored = typeof drama.playUrl === 'string' && registry.isPlatformUrl(site, drama.playUrl) ? drama.playUrl : null;
      const url = stored || registry.platformLandingUrl(site, drama.title);
      if (url) platformItem = { label, url };
    }
    if (!platformItem) return null;
    return [{ label: `${registry.SOURCE_NAMES.imdb} 影片页`, url: imdbUrl }, platformItem];
  }

  // 同一时刻只开一个封面菜单。挂在 document.body 而不是卡片里：弹窗每次 storage.onChanged 都整树重建
  // 卡片（抓取 / 翻译期间可能一秒一次），挂在卡里会被连带销毁。「搜 X」进行中的卡记在 platformBusy，
  // 菜单关了再开、卡片重建后都保住「⏳」状态
  let activePosterMenu = null;   // { menu, anchor, dramaId, cleanup }
  const platformBusy = new Set();

  const platformBusyLabel = label => `⏳ 正在${label}…`;

  function closePosterMenu() {
    if (!activePosterMenu) return;
    const { menu, cleanup } = activePosterMenu;
    activePosterMenu = null;
    cleanup();
    menu.remove();
  }

  function openPosterMenu(anchor, event, drama, items, options) {
    const doc = anchor.ownerDocument;
    const view = doc.defaultView || global;
    const menu = doc.createElement('div');
    menu.className = 'poster-menu';
    menu.setAttribute('role', 'menu');

    for (const item of items) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'poster-menu-item';
      button.setAttribute('role', 'menuitem');
      const busy = Boolean(item.platform) && platformBusy.has(drama.id);
      button.textContent = busy ? platformBusyLabel(item.label) : item.label;
      button.disabled = busy;
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!item.platform) {
          closePosterMenu();
          options.onOpenUrl(item.url, drama);
          return;
        }
        if (platformBusy.has(drama.id)) return;
        platformBusy.add(drama.id);
        button.textContent = platformBusyLabel(item.label);
        button.disabled = true;
        // 查找要一两秒：菜单留着显示进度；结束后收起（找到时后台已开页，没找到时调用方已提示）
        Promise.resolve()
          .then(() => options.onOpenPlatform(drama.id))
          .catch(() => {})
          .finally(() => {
            platformBusy.delete(drama.id);
            if (activePosterMenu && activePosterMenu.dramaId === drama.id) closePosterMenu();
          });
      });
      menu.appendChild(button);
    }
    doc.body.appendChild(menu);

    // 贴着点击处展开，放不下就往左 / 往上翻，最后夹进视口（留 4px）；没有点击坐标时贴封面右上角
    const rect = anchor.getBoundingClientRect();
    const x = event && event.clientX > 0 ? event.clientX : rect.right;
    const y = event && event.clientY > 0 ? event.clientY : rect.top;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let left = x + 4;
    let top = y + 4;
    if (left + width > view.innerWidth - 4) left = x - width - 4;
    if (top + height > view.innerHeight - 4) top = y - height - 4;
    menu.style.left = `${Math.max(4, Math.min(left, view.innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(top, view.innerHeight - height - 4))}px`;

    // 点外面 / Esc / 滚轮 / 触摸滑动 / 窗口失焦或缩放即收起。刻意不听 scroll：弹窗重渲染后 restoreScroll
    // 以程序方式设 scrollTop，同样派发 scroll，听了菜单会被每次重渲染关掉
    const onPointerDown = (e) => {
      if (menu.contains(e.target) || e.target === anchor) return;   // 点同一张封面交给它的 click 收起
      closePosterMenu();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') closePosterMenu();
    };
    const dismiss = () => closePosterMenu();
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('wheel', dismiss, { capture: true, passive: true });
    doc.addEventListener('touchmove', dismiss, { capture: true, passive: true });
    view.addEventListener('blur', dismiss);
    view.addEventListener('resize', dismiss);
    activePosterMenu = {
      menu,
      anchor,
      dramaId: drama.id,
      cleanup() {
        doc.removeEventListener('pointerdown', onPointerDown, true);
        doc.removeEventListener('keydown', onKeyDown, true);
        doc.removeEventListener('wheel', dismiss, { capture: true });
        doc.removeEventListener('touchmove', dismiss, { capture: true });
        view.removeEventListener('blur', dismiss);
        view.removeEventListener('resize', dismiss);
      }
    };
  }

  // 再点同一张封面＝收起；点另一张＝换成那张的菜单
  function togglePosterMenu(anchor, event, drama, items, options) {
    const sameCard = Boolean(activePosterMenu) && activePosterMenu.anchor === anchor;
    closePosterMenu();
    if (!sameCard) openPosterMenu(anchor, event, drama, items, options);
  }

  // 日期分组键与标题：本地日历日。今天 / 昨天加前缀，跨年才写年份
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const dayKeyOf = date => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

  function dateLabelOf(date, now) {
    const sameYear = date.getFullYear() === now.getFullYear();
    const monthDay = `${sameYear ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`;
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const prefix = dayKeyOf(date) === dayKeyOf(now) ? '今天 · '
      : dayKeyOf(date) === dayKeyOf(yesterday) ? '昨天 · ' : '';
    return `${prefix}${monthDay} ${WEEKDAYS[date.getDay()]}`;
  }

  /**
   * 按入库日期分组（v1.8.0 起只分到日：卡片上方不再标抓取时刻，同一天内保持调用方给的顺序）。
   * 返回按出现顺序排列的 [{ key, label, dramas }]；缺 scrapedAt 或时间戳非法的条目归入「未知日期」。
   * now 只供单测固定「今天」。
   */
  function groupByDate(dramas, now = new Date()) {
    const groups = [];
    const byKey = new Map();

    for (const drama of dramas || []) {
      const date = drama && drama.scrapedAt ? new Date(drama.scrapedAt) : null;
      const valid = date && !Number.isNaN(date.getTime());
      const key = valid ? dayKeyOf(date) : 'unknown';
      let group = byKey.get(key);
      if (!group) {
        group = { key, label: valid ? dateLabelOf(date, now) : '未知日期', dramas: [] };
        byKey.set(key, group);
        groups.push(group);
      }
      group.dramas.push(drama);
    }

    return groups;
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

  const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * 转义并把命中词包进 <mark class="search-hit">（v1.8.2 弹窗搜索）。没有词时等同 escapeHtml。
   * 按原文不区分大小写找词，切段后逐段转义——不在转义后的 HTML 上替换，免得词命中实体（&amp;）。
   */
  function highlightHtml(text, terms) {
    const raw = String(text == null ? '' : text);
    const list = (terms || []).filter(Boolean);
    if (!raw || list.length === 0) return escapeHtml(raw);
    // 长词优先，重叠时整段高亮长的那个
    const pattern = new RegExp(`(${[...list].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})`, 'gi');
    return raw.split(pattern).map((part, i) => (i % 2 === 1
      ? `<mark class="search-hit">${escapeHtml(part)}</mark>`
      : escapeHtml(part))).join('');
  }

  /**
   * 获取卡片显示标签。兼容旧数据没有 tags 字段的情况。
   */
  function getDisplayTags(drama) {
    if (Array.isArray(drama.tags) && drama.tags.length > 0) {
      return drama.tags.slice(0, 3);
    }

    const tags = [global.SiteRegistry.SOURCE_NAMES[drama.source] || 'IMDB'];

    if (drama.sourceListUrl) {
      const genreMatch = drama.sourceListUrl.match(/genres=([^&,]+)/i);
      if (genreMatch) {
        tags.push(decodeURIComponent(genreMatch[1]).toLowerCase());
      }
    }

    return tags.slice(0, 3);
  }

  /**
   * 获取卡片显示的内容类型标签（站点原始英文值，v1.5.3，不翻译）。
   * 全量渲染、不设数量上限：实际显示几个交给 CSS 按可用宽度自适应——
   * 左槽来源标签优先占位（flex-shrink:0），右槽放不下的 chips 折行后被
   * 单行 max-height 裁掉（footer 视觉高度不变），全量经容器 title 悬停可见。
   */
  function getDisplayGenres(drama) {
    if (!Array.isArray(drama.genres)) return [];
    return drama.genres.map(g => String(g || '').trim()).filter(Boolean);
  }

  /**
   * 卡片上显示的文字（v1.8.12 中英切换）：标题、简介、内容标签只取一种语言，缺了才退回另一种
   * ——未翻译的新卡在中文模式照样显示英文，靠「待翻译」小标签区分。
   * 中文标签按通用标签体系（GenreTaxonomy.zhTagsOf）对照，一个都对不上时退回英文；英文标签滤掉
   * ReelShort 混进 genres 的演员名。没加载体系（理应不会）时标签照旧显示站点原文。
   * descLang / tagsLang 是实际显示的语言（退回时与 lang 不同）。
   */
  function cardTextOf(drama, lang) {
    const zhFirst = normalizeLang(lang) === 'zh';
    const text = value => String(value || '').trim();
    const pick = (zh, en) => {
      const [first, second] = zhFirst ? [zh, en] : [en, zh];
      return first.text || !second.text ? first : second;
    };
    const title = pick({ text: text(drama.titleZh) }, { text: text(drama.title) });
    const desc = pick({ text: text(drama.descriptionZh), lang: 'zh' }, { text: text(drama.description), lang: 'en' });

    const taxonomy = global.GenreTaxonomy;
    const enTags = taxonomy ? taxonomy.displayGenres(drama.genres) : getDisplayGenres(drama);
    const zhTags = zhFirst && taxonomy ? taxonomy.zhTagsOf(drama.genres) : [];
    const tagsLang = zhTags.length ? 'zh' : 'en';
    return {
      title: title.text,
      desc: desc.text,
      descLang: desc.lang,
      tags: tagsLang === 'zh' ? zhTags : enTags,
      tagsLang
    };
  }

  /**
   * 搜索时整枚标亮哪些标签（v1.8.12 起跨语言）：中文标签看挂它的英文原标签，英文标签看它归到的
   * 中文标签——用哪种语言搜、在哪种模式下看，都看得出这部为什么被搜出来。
   * terms 为 DramaSearch.parseQuery 的结果（已归一），genreHits 为经 GENRE_ZH 对照命中的英文题材（小写）。
   * 返回 tag => boolean；不在搜索态时恒为 false。
   */
  function tagHitTest(drama, tagsLang, terms, genreHits) {
    if (!terms.length && !genreHits.size) return () => false;
    const taxonomy = global.GenreTaxonomy;
    const zhOf = genre => (taxonomy ? taxonomy.zhTagsOf([genre]) : []);
    const termHit = value => terms.some(term => String(value).normalize('NFKC').toLowerCase().includes(term));
    const genreHit = genre => genreHits.has(genre.toLowerCase()) || termHit(genre);
    if (tagsLang === 'zh') {
      const hitTags = new Set(getDisplayGenres(drama).filter(genreHit).flatMap(zhOf));
      return tag => hitTags.has(tag);
    }
    return genre => genreHits.has(genre.toLowerCase()) || zhOf(genre).some(termHit);
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

    const terms = Array.isArray(options.highlightTerms) ? options.highlightTerms : null;
    const mark = text => highlightHtml(text, terms);
    const unsubscribed = typeof options.isUnsubscribed === 'function' && options.isUnsubscribed(drama);

    // 标题、简介、内容标签只显示一种语言（v1.8.12）；悬停标题看「中文（英文）」
    const text = cardTextOf(drama, options.lang);
    const titleDisplay = titleDisplayOf(drama);

    // footer 右槽：内容类型标签 chips（v1.5.3 替换原制作公司/作者标签展示；
    // company 字段已于 v1.5.13 从数据模型彻底移除——不再采集、不进 CSV 列）
    const genreChips = text.tags;
    const tagHit = tagHitTest(drama, text.tagsLang, terms || [],
      new Set(Array.isArray(options.highlightGenres) ? options.highlightGenres : []));
    const markGenre = g => (tagHit(g) ? `<mark class="search-hit">${escapeHtml(g)}</mark>` : mark(g));

    // Lark 按钮双闸门：readOnly（共享页）不渲染，未注入回调（调用方未接入）也不渲染
    const showLarkButton = !options.readOnly && typeof options.onLarkPush === 'function';

    // 卡片操作：右上角浮着（定位在 popup.css），共享页只读、没有操作。v1.8.0 起是线条图标，飞书是纸飞机
    const translateButton = options.readOnly ? ''
      : `<button class="btn-translate card-action" title="翻译此卡片" aria-label="翻译此卡片" data-id="${escapeAttribute(drama.id)}">${global.Icons.svg('language')}</button>`;
    const larkButton = showLarkButton
      ? `<button class="btn-lark card-action" title="推送到飞书（写入多维表格/发送群消息）" aria-label="推送到飞书" data-id="${escapeAttribute(drama.id)}">${global.Icons.svg('send')}</button>`
      : '';

    card.innerHTML = `
      ${translateButton || larkButton ? `<div class="card-actions">${larkButton}${translateButton}</div>` : ''}
      <div class="card-content">
        <div class="card-top">
          <img class="card-poster" src="${escapeAttribute(drama.poster || defaultPoster)}" alt="${escapeAttribute(drama.title)}">
          <div class="card-main">
            <div class="card-title">
              <div class="card-title-row">
                <div class="card-title-text" title="${escapeAttribute(titleDisplay)}">${mark(text.title)}</div>
                ${drama.status === 'new' ? '<span class="status-chip">待翻译</span>' : ''}
                ${unsubscribed ? '<span class="status-chip chip-unsubscribed" title="所属订阅已退订，弹窗平时不显示这部">已退订</span>' : ''}
              </div>
            </div>
            <div class="card-description">
              ${text.desc
                ? `<div class="card-desc" lang="${text.descLang === 'zh' ? 'zh-CN' : 'en'}">${mark(text.desc)}</div>`
                : '<div class="card-desc-empty">暂无简介</div>'}
            </div>
          </div>
        </div>
        <div class="card-footer">
          <div class="card-tags-left">
            ${getDisplayTags(drama).map(tag => `<span class="tag tag-source">${mark(tag)}</span>`).join('')}
          </div>
          ${genreChips.length ? `<div class="card-tags-right" title="${escapeAttribute(genreChips.join(text.tagsLang === 'zh' ? '、' : ', '))}">${genreChips.map(g => `<span class="tag tag-genre">${markGenre(g)}</span>`).join('')}</div>` : ''}
        </div>
      </div>
    `;

    // 海报染色（v1.8.0）：卡片底下垫一层模糊放大的海报（timeline-cards.css .drama-card::after），
    // 底色随海报主色调变。只走 CSS 背景图、不读像素，跨域图片照样能用。不经 innerHTML 拼接：
    // setProperty 只认一个 CSS 值，JSON 串的引号与反斜杠转义在 CSS 字符串里同样成立
    if (drama.poster) {
      card.style.setProperty('--poster-url', `url(${JSON.stringify(String(drama.poster))})`);
    }

    // 绑定翻译/Lark 按钮事件（只读模式不渲染按钮）
    if (!options.readOnly) {
      const translateBtn = card.querySelector('.btn-translate');
      if (translateBtn && typeof options.onTranslate === 'function') {
        translateBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          options.onTranslate(drama.id, translateBtn);
        });
      }

      const larkBtn = card.querySelector('.btn-lark');
      if (larkBtn && typeof options.onLarkPush === 'function') {
        larkBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          options.onLarkPush(drama.id, larkBtn);
        });
      }
    }

    // 封面方向：横版（宽>高）置于文字上方整行铺开，竖版保持左侧；按图片实际尺寸判定。
    // source 作初始猜测避免布局闪动，加载后用真实尺寸校正。
    const posterImg = card.querySelector('.card-poster');
    if (posterImg) {
      // 扩展页 CSP 禁止内联 onerror 属性，海报加载失败的默认图回退用监听器实现；
      // once 兼防默认图自身也加载失败时的换源死循环
      let usedFallback = false;
      posterImg.addEventListener('error', () => {
        usedFallback = true;
        card.classList.add('poster-fallback'); // 让 CSS 知道现在展示的是占位图
        posterImg.src = defaultPoster;
      }, { once: true });
      const applyOrientation = () => {
        const landscape = orientationFromPoster(posterImg.naturalWidth, posterImg.naturalHeight, usedFallback);
        if (landscape === null) return;
        card.classList.toggle('card-landscape', landscape);
        // 竖版空间预算取决于海报实际高度，横竖翻转又会改文字列宽，加载后必须重排
        adjustCardDescription(card);
      };
      if (posterImg.complete) applyOrientation();
      else posterImg.addEventListener('load', applyOrientation);

      // 封面点击打开原站页面：打开动作由调用方注入（弹窗 chrome.tabs.create、
      // 共享页 window.open），与 readOnly 无关——只读共享页同样可跳转。
      // 已知平台的 IMDb 卡改为弹菜单「IMDB 影片页 / 搜 X」（v1.7.3，见 posterMenuItems）
      const linkUrl = posterLinkUrl(drama);
      if (linkUrl && typeof options.onOpenUrl === 'function') {
        const menuItems = posterMenuItems(drama, options);
        posterImg.classList.add('poster-link');
        posterImg.title = menuItems ? `点击选择：${menuItems.map(item => item.label).join(' / ')}` : '点击打开原站页面';
        posterImg.addEventListener('click', (e) => {
          e.stopPropagation();
          if (menuItems) togglePosterMenu(posterImg, e, drama, menuItems, options);
          else options.onOpenUrl(linkUrl, drama);
        });
      }
    }

    return card;
  }

  /**
   * 简介动态排版（v1.8.12 起卡片只显示一种语言，简介是单独一段）：
   * - 竖版卡（海报在左）以「简介顶部到海报底边 + 内容区 gap」为固定预算，行数 = 预算能放下的整行数；
   * - 全文还占不到预算的一半：放大字号（desc-large，14px）填空白，行数按放大后的行高重算；
   * - 上半区高度钉死为海报高，文字只填充原有空隙、分割线绝不因文字增行下移；
   * - 横版卡（封面在上，Steam）没有海报边界，行数走 CSS 静态规则，这里不动。
   * 行数按 scrollHeight / line-height 测量（line-clamp 不影响 scrollHeight），
   * 必须在卡片进入可见 DOM 后调用；测得 0 行（容器不可见）时保持默认样式。
   */
  // 三段拆分（v1.5.1 性能批次）：reset（写）→ measure（纯读+纯计算）→ apply（纯写），
  // renderTimeline 对全卡分三轮批处理，强制同步 reflow 从每卡 4+ 次降为整树约 2 次。
  // 批量测量与旧逐卡交错结果等价的依据：预算 = 同卡内 poster.bottom − box.top
  // （平移不变量，兄弟卡高度变化只整体平移本卡不改差值）；行数取决于文字列宽，
  // 列宽由容器网格决定、不受兄弟卡样式影响。

  // timeline-cards.css：.card-desc 12px，desc-large 14px，行高写的是倍数，跟着字号同比放大
  const DESC_LARGE_SCALE = 14 / 12;

  /** 第一段（写）：清掉上一轮动态样式，返回后续两段共用的元素上下文；没有简介的卡返回 null。 */
  function resetCardDescStyles(card) {
    const descEl = card.querySelector('.card-desc');
    if (!descEl) return null;

    const box = card.querySelector('.card-description');
    const cardTop = card.querySelector('.card-top');
    box.classList.remove('desc-large');
    descEl.style.removeProperty('-webkit-line-clamp');
    if (cardTop) cardTop.style.removeProperty('height');
    return { descEl, box, cardTop };
  }

  /** 第二段（纯读+计算）：测量并产出应用计划；横版卡、容器不可见（测得 0 行）时返回 null 保持默认样式。 */
  function measureCardDesc(ctx, card) {
    const { descEl, box, cardTop } = ctx;
    const poster = card.querySelector('.card-poster');
    if (card.classList.contains('card-landscape') || !cardTop || !poster || poster.offsetHeight <= 40) return null;

    const lineHeight = parseFloat(getComputedStyle(descEl).lineHeight);
    const lines = lineHeight > 0 ? Math.round(descEl.scrollHeight / lineHeight) : 0;
    if (lines === 0) return null;

    const contentGap = parseFloat(getComputedStyle(cardTop.parentElement).rowGap) || 0;
    // 文字可下溢到海报底边之下、吃掉内容区 gap，与分割线保持 footer margin 的间距
    const budget = poster.getBoundingClientRect().bottom - box.getBoundingClientRect().top + contentGap;
    const large = lines * lineHeight * 2 <= budget;
    const showLineHeight = large ? lineHeight * DESC_LARGE_SCALE : lineHeight;
    const show = Math.max(1, Math.floor((budget + 0.5) / showLineHeight));
    return { show, large, posterHeight: poster.offsetHeight };
  }

  /** 第三段（纯写）：按计划应用样式。 */
  function applyCardDesc(ctx, plan) {
    if (!plan) return;
    const { descEl, box, cardTop } = ctx;
    if (plan.large) box.classList.add('desc-large');
    descEl.style.setProperty('-webkit-line-clamp', String(plan.show));
    // 上半区高度钉死为海报高：文字增行只填充空隙，分割线不动
    cardTop.style.height = `${plan.posterHeight}px`;
  }

  /** 单卡入口（海报 load 回调与两端页面沿用，签名不变）＝三段的单卡组合。 */
  function adjustCardDescription(card) {
    const ctx = resetCardDescStyles(card);
    if (!ctx) return;
    applyCardDesc(ctx, measureCardDesc(ctx, card));
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

    // 按入库日期分组：日期标题吸顶，末尾是当天入库条数
    for (const dateGroup of groupByDate(list)) {
      const group = document.createElement('div');
      group.className = 'timeline-date-group';

      const dateHeader = document.createElement('div');
      dateHeader.className = 'timeline-date-header';
      const label = document.createElement('span');
      label.className = 'timeline-date-label';
      label.textContent = dateGroup.label;
      const count = document.createElement('span');
      count.className = 'timeline-date-count';
      count.textContent = `+${dateGroup.dramas.length}`;
      count.title = `当天新入库 ${dateGroup.dramas.length} 部`;
      dateHeader.append(label, count);
      group.appendChild(dateHeader);

      // 奇数张时首卡标记 card-full，Steam 双列下横跨整行，避免出现单卡独占一行的空缺
      const oddCount = dateGroup.dramas.length % 2 === 1;
      dateGroup.dramas.forEach((drama, index) => {
        const card = createDramaCard(drama, options);
        if (oddCount && index === 0) card.classList.add('card-full');
        group.appendChild(card);
      });

      container.appendChild(group);
    }

    // 卡片进入 DOM 后按实际渲染行数微调简介排版：三轮批处理（全卡清样式 →
    // 全卡测量 → 全卡应用），读写不交错，整树只强制约 2 次同步 reflow
    const cards = Array.from(container.querySelectorAll('.drama-card'));
    const ctxs = cards.map(resetCardDescStyles);
    const plans = ctxs.map((ctx, i) => (ctx ? measureCardDesc(ctx, cards[i]) : null));
    ctxs.forEach((ctx, i) => { if (ctx) applyCardDesc(ctx, plans[i]); });
    return true;
  }

  global.TimelineRender = {
    CATEGORY_SOURCES,
    LANG_LABELS,
    normalizeLang,
    dramaSource,
    titleDisplay: titleDisplayOf,
    cardTextOf,
    tagHitTest,
    orientationFromPoster,
    groupByDate,
    renderTimeline,
    createDramaCard,
    adjustCardDescription,
    getDisplayTags,
    getDisplayGenres,
    highlightHtml,
    posterMenuItems,
    closePosterMenu,
    formatRelativeTime,
    escapeHtml,
    escapeAttribute
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
