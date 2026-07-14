/**
 * ShortScraping Content Script
 * 渐进式加载：每抓取一条，立即保存
 */

(function() {
  'use strict';

  // 防重注入：manifest 声明注入与后台 scripting.executeScript 强制注入（重媒体页
  // 兜底路径）可能先后发生，二次执行会重复注册消息监听导致并发抓取
  if (window.__dramamoContentLoaded) return;
  window.__dramamoContentLoaded = true;

  // 抓取进行中护栏：后台兜底路径（waitForTabComplete 超时 → 强制注入 →
  // sendScrapeWhenReady 轮询补发）可能让同一标签页先后收到多条 'scrape'。
  // 并行双跑会经保存点去重互相分走对方的新增卡——入库不重复，但每个 response
  // 都只有部分结果，performScrape 报告计数失真（实测报 83 存 87）。
  // 复用进行中的 Promise，让每条消息都拿到同一份完整结果；结束后复位，
  // 后续消息照常开启新一轮。
  let scrapeInFlight = null;

  /**
   * 初始化
   */
  function init() {
    console.log('[ShortScraping] 内容脚本已加载');

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'scrape') {
        if (!scrapeInFlight) {
          scrapeInFlight = scrapePage().finally(() => { scrapeInFlight = null; });
        }
        scrapeInFlight.then(data => {
          sendResponse({ success: true, data: data });
        }).catch(e => {
          console.error('[ShortScraping] 抓取出错:', e);
          sendResponse({ success: false, error: e.message });
        });
        return true;
      }
      // 非 scrape 消息不保留异步响应通道，避免发送方端口悬挂
      return false;
    });

    const site = detectSite(window.location.hostname);
    const adapter = site ? ADAPTERS[site] : null;
    if (adapter && adapter.matches(window.location.href)) {
      addScrapeButton();
    }
  }

  /**
   * 按 hostname 判断当前站点
   */
  function detectSite(hostname) {
    if (hostname.endsWith('imdb.com')) return 'imdb';
    if (hostname === 'store.steampowered.com') return 'steam';
    if (hostname.endsWith('royalroad.com')) return 'royalroad';
    if (hostname.endsWith('my-drama.com')) return 'mydrama';
    if (hostname.endsWith('reelshort.com')) return 'reelshort';
    if (hostname.endsWith('dramashorts.io')) return 'dramashorts';
    return null;
  }

  /**
   * IMDB 适配器：封装现有 IMDB 抓取逻辑，行为不变。
   */
  const imdbAdapter = {
    matches(url) {
      return /imdb\.com\/(search\/title|find)/.test(url);
    },
    async getListItems() {
      return Array.from(document.querySelectorAll('.ipc-metadata-list-summary-item'));
    },
    extractId(item) {
      return extractImdbIdFromListItem(item);
    },
    extractBasic(item, tags, id, index) {
      return extractFromListItem(item, index, tags, id);
    },
    async fetchDetail(drama) {
      // IMDB 详情失败也返回 drama（保留原行为：简介/公司可为空但仍记录）
      return await fetchImdbDetail(drama);
    }
  };

  /**
   * 解码常见 HTML 命名实体（appdetails 文本里会出现 &quot; &amp; 等）
   */
  function decodeHtmlEntities(text) {
    if (!text) return '';
    return text
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  /**
   * 取单个 appId 的 appdetails 数据（指定语言）。失败/无数据返回 null。
   */
  async function fetchSteamAppDetails(appId, lang) {
    const api = `https://store.steampowered.com/api/appdetails?appids=${appId}&l=${lang}&cc=us`;
    const response = await fetch(api, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) return null;
    const json = await response.json();
    const entry = json && json[appId];
    return (entry && entry.success && entry.data) ? entry.data : null;
  }

  /**
   * 用 Steam 官方 appdetails 取英文原名/简介 + 官方简体中文名/简介（同源，绕开年龄门）。
   * 英文取不到（成人专属/受限/不可用）→ 返回 null 跳过。
   * 有官方中文则直接采用并标记已翻译；完全无中文则保持 new，交给翻译线 AI 兜底。
   */
  async function fetchSteamDetail(drama) {
    const appId = drama.imdbId; // Steam 项的 appId 存在 imdbId 字段
    try {
      const en = await fetchSteamAppDetails(appId, 'english');
      if (!en) {
        console.log(`[ShortScraping] Steam appdetails 无数据，跳过: ${drama.title} (${appId})`);
        return null;
      }

      const clean = arr => (Array.isArray(arr) ? arr : []).map(s => String(s).trim()).filter(Boolean);
      const enName = (en.name || '').trim();
      const enDesc = decodeHtmlEntities(en.short_description || '').trim();
      const developers = clean(en.developers);
      const publishers = clean(en.publishers);

      if (!enName && !enDesc) {
        console.log(`[ShortScraping] Steam 详情无正文，跳过: ${drama.title} (${appId})`);
        return null;
      }

      // 官方简体中文：仅当与英文不同（确有本地化）才作为中文译名采用
      const zh = await fetchSteamAppDetails(appId, 'schinese');
      const zhName = zh ? (zh.name || '').trim() : '';
      const zhDesc = zh ? decodeHtmlEntities(zh.short_description || '').trim() : '';
      const titleZh = (zhName && zhName !== enName) ? zhName : '';
      const descriptionZh = (zhDesc && zhDesc !== enDesc) ? zhDesc : '';

      if (enName) drama.title = enName;        // 英文原名（弹窗里的“（原名）”）
      drama.description = enDesc;
      drama.company = (developers.length ? developers : publishers).join(', ');
      if (en.header_image) drama.poster = en.header_image;

      if (titleZh || descriptionZh) {
        // 采用 Steam 官方中文，跳过 AI 翻译
        drama.titleZh = titleZh;
        drama.descriptionZh = descriptionZh;
        drama.status = 'trans';
        drama.translatedAt = new Date().toISOString();
      }

      console.log(`[ShortScraping] Steam 详情: ${drama.title}${titleZh ? ` / ${titleZh}` : ''} | 公司: ${drama.company || '无'}`);
      return drama;
    } catch (e) {
      console.warn(`[ShortScraping] Steam 详情获取失败: ${drama.title} (${appId})`, e.message);
      return null;
    }
  }

  /**
   * Steam 适配器：列表来自内容中心动态查询接口（同源 JSON，不依赖渲染），
   * 详情来自官方 appdetails 接口。
   * 解决后台标签页 React 网格不渲染、DOM 只剩 0-1 个卡片导致只抓到 0-1 部的问题。
   */
  const steamAdapter = {
    matches(url) {
      // 内容中心两种形态：/category/<name> 与 /tags/<locale>/<本地化标签名>
      return /store\.steampowered\.com\/(category|tags)\//.test(url);
    },
    async getListItems() {
      const queryUrl = buildSteamQueryUrl(window.location.href);
      if (!queryUrl) {
        console.log('[ShortScraping] 无法从当前 URL 解析 Steam 分类/标签，跳过');
        return [];
      }
      try {
        const resp = await fetch(queryUrl, { headers: { 'Accept': 'application/json' }, credentials: 'include' });
        if (!resp.ok) return [];
        const json = await resp.json();
        const appids = Array.isArray(json.appids) ? json.appids : [];
        return [...new Set(appids.map(String))];
      } catch (e) {
        console.warn('[ShortScraping] Steam 列表接口失败:', e.message);
        return [];
      }
    },
    extractId(appId) {
      return appId ? String(appId) : null;
    },
    extractBasic(appId, tags, id, index) {
      return buildSteamDramaSkeleton(id, index, tags);
    },
    async fetchDetail(drama) {
      return await fetchSteamDetail(drama);
    }
  };

  /**
   * RoyalRoad 适配器：榜单页为服务端渲染，列表项自带标题/封面/多段全文简介；
   * 作者名列表页没有，由详情页补充（详情失败保留列表页数据，不丢卡）。
   */
  const royalroadAdapter = {
    matches(url) {
      return /royalroad\.com\/fictions\//.test(url);
    },
    async getListItems() {
      return Array.from(document.querySelectorAll('.fiction-list-item'));
    },
    extractId(item) {
      const link = item.querySelector('a[href*="/fiction/"]');
      const match = link ? (link.getAttribute('href') || '').match(/\/fiction\/(\d+)/) : null;
      // fiction id 是纯数字，加 rr 前缀避免与 Steam appId 在全局去重键上撞号
      return match ? `rr${match[1]}` : null;
    },
    extractBasic(item, tags, id, index) {
      return extractRoyalRoadFromListItem(item, index, tags, id);
    },
    async fetchDetail(drama) {
      return await fetchRoyalRoadDetail(drama);
    }
  };

  /**
   * My Drama 适配器，覆盖两个入口、同一去重键空间（弹窗同属 mydrama 分类）：
   * - 主站首页（Next.js SSR + hydrate）：按订阅 URL 的约定参数 ?list=<板块锚点id>
   *   选板块（无参数默认 most_trending「最流行」，如 best_choices「最佳选择」；
   *   Next.js 忽略未知参数照常渲染）；板块以语言无关锚点 id 定位（板块标题文字随
   *   浏览器语言变化），SSR 只直出轮播首屏几条，hydrate 后 DOM 才有全部条目，需轮询等待。
   * - fandom 子域（fandom.my-drama.com，WordPress SSR）：订阅 URL 带 ?list=trending
   *   抓导航菜单 Most Trending，否则抓首页文章流；列表项只有标题/链接（文章流多张横版图），
   *   剧目文章页里有回主站的 /video/<UUID> 链接，详情阶段把去重键映射回 md+UUID 与主站合并。
   */
  const mydramaAdapter = {
    matches(url) {
      try {
        const u = new URL(url);
        return u.hostname.endsWith('my-drama.com') && u.pathname === '/';
      } catch (e) {
        return false;
      }
    },
    async getListItems() {
      if (window.location.hostname === 'fandom.my-drama.com') {
        return getFandomListItems();
      }
      return await waitForMyDramaItems(getMyDramaSectionId());
    },
    extractId(item) {
      const link = item.matches('a[href]') ? item : item.querySelector('.wp-block-post-title a, a[href]');
      const href = link ? (link.getAttribute('href') || '') : '';
      // 主站条目 id 是 UUID，加 md 前缀与 tt/纯数字/rr 的全局去重键约定保持一致
      const vid = href.match(/\/video\/([0-9a-f-]{36})/);
      if (vid) return `md${vid[1]}`;
      // fandom 列表项没有 UUID，先用 mdf-+slug 临时键（md+UUID 的 f 后必是连续 hex，
      // 带连字符的 mdf- 不会与之歧义）；详情页找到主站链接后改写为 md+UUID
      const slug = href.match(/fandom\.my-drama\.com\/([^/?#]+)\/?/);
      return slug ? `mdf-${slug[1]}` : null;
    },
    extractBasic(item, tags, id, index) {
      // 按页面 hostname 分派，不能用 id 前缀猜：UUID 以 f 开头的主站键（mdf…）会误判
      if (window.location.hostname === 'fandom.my-drama.com') {
        return extractFandomFromListItem(item, index, tags, id);
      }
      return extractMyDramaFromListItem(item, index, tags, id);
    },
    async fetchDetail(drama) {
      if (/fandom\.my-drama\.com/.test(drama.url)) {
        return await fetchFandomDetail(drama);
      }
      return await fetchMyDramaDetail(drama);
    }
  };

  /**
   * ReelShort 适配器（reelshort.com，与 My Drama 同属 Crazy Maple Studio），
   * 覆盖同域名下两个入口、同一去重键空间（弹窗同属 reelshort 分类）：
   * - 主站首页（Next.js Pages Router）：SSR 在 script#__NEXT_DATA__ 直出完整板块
   *   数据，「TOP」板块按 bookshelf_name 定位（板块顺序与索引不可信），无需等待
   *   hydrate。站点无本地化（标题恒英文），status 走 new 交给 AI 翻译。
   * - /fandom/ 路径（WordPress SSR）：首页文章流每页 12 篇；文章页里有回主站的
   *   /movie/<slug>-<book_id> 链接，详情阶段把去重键映射回 rs+book_id 与主站合并。
   * 两入口同域名，条目来源分派只能按 pathname（不能按 id 形态猜，同 mydrama 教训）。
   */
  const reelshortAdapter = {
    matches(url) {
      try {
        const u = new URL(url);
        if (!u.hostname.endsWith('reelshort.com')) return false;
        // 只在首页与 fandom 列表页触发；文章页/movie 页/分页由 fetch 取，不开 tab
        return u.pathname === '/' || u.pathname === '/fandom/' || u.pathname === '/fandom';
      } catch (e) {
        return false;
      }
    },
    async getListItems() {
      if (window.location.pathname.startsWith('/fandom')) {
        return getReelshortFandomItems();
      }
      return getReelshortTopBooks();
    },
    extractId(item) {
      // 按页面 pathname 分派（fandom 项是 DOM 元素，主站项是 book 纯对象）
      if (window.location.pathname.startsWith('/fandom')) {
        const link = item.querySelector('.entry-title a');
        const href = link ? (link.getAttribute('href') || '') : '';
        // fandom 文章无主站 book_id，先用 rsf-+slug 临时键（rs 后必是连续 hex，
        // 带连字符的 rsf- 不会与之歧义）；详情页找到 /movie/ 回链后改写为 rs+book_id
        const slug = href.match(/\/fandom\/([^/?#]+)\/?/);
        return slug ? `rsf-${slug[1]}` : null;
      }
      // 主站 book_id 是 24 位 hex，加 rs 前缀与 tt/纯数字/rr/md 的全局去重键约定保持一致
      const bookId = item && typeof item.book_id === 'string' ? item.book_id : '';
      return /^[0-9a-f]{24}$/.test(bookId) ? `rs${bookId}` : null;
    },
    extractBasic(item, tags, id, index) {
      if (window.location.pathname.startsWith('/fandom')) {
        return extractReelshortFandomFromListItem(item, index, tags, id);
      }
      return extractReelshortFromBook(item, index, tags, id);
    },
    async fetchDetail(drama) {
      if (/reelshort\.com\/fandom\//.test(drama.url)) {
        return await fetchReelshortFandomDetail(drama);
      }
      return await fetchReelshortDetail(drama);
    }
  };

  /**
   * DramaShorts 适配器（dramashorts.io，Next.js Pages Router）：列表数据全部由
   * SSR 在 script#__NEXT_DATA__ 直出，无需等待 hydrate，也无需请求详情页——
   * 详情页 movieDetails.movie.description 与列表逐字一致（实测简介以省略号
   * 结尾的也是站点原始数据，非接口截断）。两类入口，同一去重键空间：
   * - /top-movies 榜单页：pageProps.movies 直出第 1 页 20 条（不翻页）；
   * - 首页 discover 板块：订阅 URL 用约定参数 ?list=<板块id> 选板块（同 mydrama
   *   范式，Next.js 忽略未知参数照常渲染），板块 id 即站点数据自身的 section id
   *   （top_trending / popular_now / audience_favorite），无参数默认 top_trending。
   * 基础域恒为英文（语言版本在 /es /ja 等子路径，zh-CN 浏览器不重定向），
   * 无平台中文，status 走 new 交给 AI 翻译。
   */
  const dramashortsAdapter = {
    matches(url) {
      try {
        const u = new URL(url);
        if (!u.hostname.endsWith('dramashorts.io')) return false;
        return u.pathname === '/' || u.pathname.replace(/\/+$/, '') === '/top-movies';
      } catch (e) {
        return false;
      }
    },
    async getListItems() {
      return getDramashortsMovies();
    },
    extractId(item) {
      // 条目 id 是 UUID，加 ds 前缀与 tt/纯数字/rr/md/rs 的全局去重键约定保持一致
      const id = item && typeof item.id === 'string' ? item.id : '';
      return /^[0-9a-f-]{36}$/.test(id) ? `ds${id}` : null;
    },
    extractBasic(item, tags, id, index) {
      return extractDramashortsFromMovie(item, index, tags, id);
    },
    async fetchDetail(drama) {
      // 列表数据已含全文简介（与详情页逐字一致），无需二次请求
      return drama;
    }
  };

  // 站点适配器注册表。
  const ADAPTERS = { imdb: imdbAdapter, steam: steamAdapter, royalroad: royalroadAdapter, mydrama: mydramaAdapter, reelshort: reelshortAdapter, dramashorts: dramashortsAdapter };

  /**
   * 添加抓取按钮
   */
  function addScrapeButton() {
    if (document.getElementById('dramamo-scrape-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'dramamo-scrape-btn';
    btn.innerHTML = '🎬 抓取到 ShortScraping';
    btn.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      z-index: 9999;
      padding: 12px 20px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
      transition: all 0.2s;
    `;

    btn.addEventListener('mouseenter', () => btn.style.transform = 'scale(1.05)');
    btn.addEventListener('mouseleave', () => btn.style.transform = 'scale(1)');

    btn.addEventListener('click', async () => {
      btn.innerHTML = '⏳ 抓取中...';
      btn.disabled = true;

      try {
        const data = await scrapePage();
        const newCount = data.filter(d => d.status === 'new').length;

        btn.innerHTML = `✅ 新增 ${newCount} 部`;
        setTimeout(() => {
          btn.innerHTML = '🎬 抓取到 ShortScraping';
          btn.disabled = false;
        }, 2000);
      } catch (e) {
        console.error('[ShortScraping] 抓取失败:', e);
        btn.innerHTML = '❌ 抓取失败';
        setTimeout(() => {
          btn.innerHTML = '🎬 抓取到 ShortScraping';
          btn.disabled = false;
        }, 2000);
      }
    });

    document.body.appendChild(btn);
  }

  /**
   * 抓取当前页面 - 站点无关骨架，逐条保存。
   */
  async function scrapePage() {
    console.log('[ShortScraping] 开始抓取页面...');

    const { dramas: existing = [], urlTags } = await chrome.storage.local.get(['dramas', 'urlTags']);
    const finalUrlTags = Array.isArray(urlTags) ? urlTags : [];

    const currentUrl = window.location.href;
    const subscription = findSubscriptionForUrl(currentUrl, finalUrlTags);
    if (!subscription) {
      console.log('[ShortScraping] 当前页面不在用户订阅配置中，跳过保存');
      return [];
    }
    const tags = subscription.tags;

    const site = detectSite(window.location.hostname);
    const adapter = site ? ADAPTERS[site] : null;
    if (!adapter || !adapter.matches(currentUrl)) {
      console.log('[ShortScraping] 当前站点无对应适配器，跳过');
      return [];
    }
    console.log(`[ShortScraping] 站点=${site}，标签: ${tags.join(', ')}`);

    // 去重键统一用 imdbId 字段（IMDB=ttId，Steam=appId，RoyalRoad=rr+数字）；过滤空值避免塌缩。
    const existingIds = new Set(existing.map(d => d.imdbId).filter(Boolean));
    const allNewDramas = [];

    const listItems = await adapter.getListItems();
    console.log(`[ShortScraping] 找到 ${listItems.length} 个列表项`);

    for (let index = 0; index < listItems.length; index++) {
      const item = listItems[index];
      try {
        const id = adapter.extractId(item);
        if (!id) {
          console.log(`[ShortScraping] 第 ${index + 1} 项未找到 id，跳过`);
          continue;
        }
        if (existingIds.has(id)) {
          console.log(`[ShortScraping] 跳过已存在: ${id}`);
          continue;
        }

        const drama = adapter.extractBasic(item, tags, id, index);
        if (!drama) continue;

        const detailed = await adapter.fetchDetail(drama);
        if (!detailed) {
          console.log(`[ShortScraping] 详情不可用，跳过: ${drama.title}`);
          continue;
        }

        // 归属 canonical 化：sourceListUrl 统一写命中的订阅 URL 本身（适配器里
        // 填的是 location.href，跳转/补斜杠时可能与订阅 URL 有尾部差异），
        // 保证弹窗/后台/CSV 的精确等值过滤对新卡永远成立。
        detailed.sourceListUrl = subscription.urlPattern;

        const saved = await saveSingleDrama(detailed);
        if (!saved) {
          console.log(`[ShortScraping] 跳过重复内容: ${detailed.title}`);
          continue;
        }

        existingIds.add(detailed.imdbId);
        allNewDramas.push(detailed);
        console.log(`[ShortScraping] ✅ 已保存: ${detailed.title} (${index + 1}/${listItems.length})`);

        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.error(`[ShortScraping] 第 ${index} 项处理失败:`, e);
      }
    }

    console.log(`[ShortScraping] 抓取完成，新增 ${allNewDramas.length} 部`);
    return allNewDramas;
  }

  /**
   * 根据当前页面 URL 找到命中的订阅项，返回 { urlPattern, tags }；无匹配返回 null。
   * urlPattern 会被写进卡片的 sourceListUrl（归属 canonical 化），使弹窗/后台/CSV
   * 的精确等值过滤天然成立。
   */
  function findSubscriptionForUrl(url, urlTags) {
    console.log('[ShortScraping] 查找订阅，URL:', url);
    console.log('[ShortScraping] 标签配置:', JSON.stringify(urlTags));

    // 确保 urlTags 是数组
    if (!Array.isArray(urlTags) || urlTags.length === 0) {
      console.log('[ShortScraping] 标签配置为空，跳过当前页面');
      return null;
    }

    // 查找匹配的配置：先精确等值、再前缀匹配（容忍跳转/补斜杠导致的 href 尾部差异）。
    // 两轮分开是为了支持互为前缀的订阅 URL（如 fandom 首页与 fandom/?list=trending），
    // 不受配置顺序影响。原第三轮 url.includes() 模糊匹配因匹配面过宽、易误标已移除。
    for (const config of urlTags) {
      if (!config.urlPattern || !config.tags) continue;
      if (url === config.urlPattern) {
        console.log(`[ShortScraping] ✓ 精确匹配! 标签: ${config.tags.join(', ')}`);
        return { urlPattern: config.urlPattern, tags: config.tags.slice(0, 3) };
      }
    }
    for (const config of urlTags) {
      if (!config.urlPattern || !config.tags) continue;
      if (url.startsWith(config.urlPattern)) {
        console.log(`[ShortScraping] ✓ 前缀匹配! 标签: ${config.tags.join(', ')}`);
        return { urlPattern: config.urlPattern, tags: config.tags.slice(0, 3) }; // 最多3个标签
      }
    }

    // 没有匹配，跳过当前页面
    console.log('[ShortScraping] 无匹配订阅配置，跳过当前页面');
    return null;
  }

  /**
   * 从列表项提取
   */
  function extractFromListItem(item, index, tags = ['IMDB'], imdbId = '') {
    const resolvedImdbId = imdbId || extractImdbIdFromListItem(item);
    if (!resolvedImdbId) return null;

    const links = item.querySelectorAll('a[href*="/title/tt"]');

    const url = `https://www.imdb.com/title/${resolvedImdbId}/`;
    let title = '';
    for (const link of links) {
      const text = link.textContent.trim();
      if (text && /^\d+\./.test(text)) {
        title = text.replace(/^\d+\.\s*/, '').trim();
        break;
      }
    }

    if (!title || title.length < 2) {
      const img = item.querySelector('img[alt]');
      if (img && img.alt) {
        title = img.alt.replace(/\s*\(\d{4}\)\s*$/, '').trim();
      }
    }

    if (!title || title.length < 2) {
      // 标题彻底解析失败＝页面版式已变化：跳过该项，避免把「标题=ID、简介空」的
      // 残卡写进库并反复喂给翻译线（与 Steam/Next 系站点解析失败安全返回空的行为对齐）
      console.warn(`[ShortScraping] 第 ${index + 1} 项标题解析失败（${resolvedImdbId}），跳过`);
      return null;
    }

    // 提取封面图片 - 精确匹配海报
    let poster = '';

    // 查找海报容器（IMDB 搜索结果的海报通常在这个容器内）
    const posterContainer = item.querySelector('.dli-poster-container');
    if (posterContainer) {
      const posterImg = posterContainer.querySelector('img');
      if (posterImg) {
        const src = posterImg.src || posterImg.dataset?.src || '';
        const alt = posterImg.alt || '';

        // 验证：封面图片的 alt 通常是 "标题 (年份)" 格式
        if (src && src.includes('amazon') && alt.match(/\(\d{4}\)/)) {
          poster = src;
        }
      }
    }

    // 备用：查找 ipc-poster 容器
    if (!poster) {
      const ipcPoster = item.querySelector('.ipc-poster img');
      if (ipcPoster) {
        const src = ipcPoster.src || '';
        const alt = ipcPoster.alt || '';
        if (src.includes('amazon') && alt.match(/\(\d{4}\)/)) {
          poster = src;
        }
      }
    }

    return {
      id: `imdb_${resolvedImdbId}_${index}`,
      imdbId: resolvedImdbId,
      title,
      titleZh: '',
      poster,
      tags,
      description: '',
      descriptionZh: '',
      company: '',
      source: 'imdb',
      sourceListUrl: window.location.href,
      status: 'new',
      url,
      scrapedAt: new Date().toISOString(),
      translatedAt: null
    };
  }

  /**
   * 由 appId 构造 Steam drama 骨架；title/poster/简介等由 fetchSteamDetail 接口填充。
   */
  function buildSteamDramaSkeleton(appId, index, tags) {
    if (!appId) return null;
    return {
      id: `steam_${appId}_${index}`,
      imdbId: appId,
      title: appId,            // 占位，fetchSteamDetail 用英文名覆盖
      titleZh: '',
      poster: '',              // 占位，fetchSteamDetail 用 header_image 覆盖
      tags,
      description: '',
      descriptionZh: '',
      company: '',
      source: 'steam',
      sourceListUrl: window.location.href,
      status: 'new',
      url: `https://store.steampowered.com/app/${appId}/`,
      scrapedAt: new Date().toISOString(),
      translatedAt: null
    };
  }

  /**
   * 取容器内多段 <p> 文本，按换行拼接保留段落；无 <p> 时退回整体文本。
   * （CSV 侧写入时会把换行压成空格，单行安全。）
   */
  function extractParagraphText(el) {
    if (!el) return '';
    const paras = Array.from(el.querySelectorAll('p'))
      .map(p => p.textContent.trim())
      .filter(Boolean);
    return paras.length ? paras.join('\n') : el.textContent.trim();
  }

  /**
   * 从 RoyalRoad 榜单列表项提取基础信息（标题/封面/全文简介都在列表项内）。
   */
  function extractRoyalRoadFromListItem(item, index, tags, rrId) {
    const titleLink = item.querySelector('.fiction-title a');
    const title = titleLink ? titleLink.textContent.trim() : '';
    const url = titleLink ? titleLink.href : '';

    if (!title) {
      // 标题解析失败＝版式已变化，跳过该项避免残卡入库（与 IMDB/Steam 行为对齐）
      console.warn(`[ShortScraping] RoyalRoad 第 ${index + 1} 项标题解析失败（${rrId}），跳过`);
      return null;
    }

    const img = item.querySelector('img[data-type="cover"]') || item.querySelector('figure img');
    const poster = img ? (img.src || img.dataset?.src || '') : '';

    const descEl = item.querySelector('div[id^="description-"]');
    const description = extractParagraphText(descEl);

    return {
      id: `royalroad_${rrId}_${index}`,
      imdbId: rrId,
      title,
      titleZh: '',
      poster,
      tags,
      description,
      descriptionZh: '',
      company: '',               // 作者名由详情页补充
      source: 'royalroad',
      sourceListUrl: window.location.href,
      status: 'new',
      url,
      scrapedAt: new Date().toISOString(),
      translatedAt: null
    };
  }

  /**
   * RoyalRoad 详情页补作者（存 company 字段）与完整简介；任何失败都保留列表页数据。
   */
  async function fetchRoyalRoadDetail(drama) {
    if (!drama.url) return drama;

    try {
      const response = await fetch(drama.url, {
        headers: { 'Accept': 'text/html' }
      });

      if (!response.ok) return drama;

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // 作者：页头 "by <a href=/profile/...>"；兜底取文档序第一个 profile 链接
      const authorLink = doc.querySelector('h4.font-white a[href*="/profile/"]') ||
                         doc.querySelector('a[href*="/profile/"]');
      if (authorLink) {
        drama.company = authorLink.textContent.replace(/^by\s+/i, '').trim();
      }

      // 完整简介：非空才覆盖列表页版本
      const fullDesc = extractParagraphText(
        doc.querySelector('.description .hidden-content') || doc.querySelector('.description')
      );
      if (fullDesc) drama.description = fullDesc;

      console.log(`[ShortScraping] RoyalRoad 详情: ${drama.title} | 作者: ${drama.company || '无'}`);
    } catch (e) {
      console.warn(`[ShortScraping] RoyalRoad 详情获取失败: ${drama.title}`, e.message);
    }

    return drama;
  }

  /**
   * 等 My Drama 首页 hydrate 完成再取「最流行」条目：SSR 只直出首屏几条，
   * 轮询到条目数非 0 且连续两次不再变化即认为轮播已填满，最长约 8 秒。
   */
  async function waitForMyDramaItems(sectionId) {
    const query = () => Array.from(
      document.querySelectorAll(`#${sectionId} [data-testid="series-section-item"]`)
    );
    let last = -1;
    for (let i = 0; i < 16; i++) {
      const items = query();
      if (items.length > 0 && items.length === last) return items;
      last = items.length;
      await new Promise(r => setTimeout(r, 500));
    }
    return query();
  }

  /**
   * 主站订阅 URL 用约定参数 ?list=<板块锚点id> 选板块（同 fandom ?list=trending
   * 范式）；无参数或非法值默认「最流行」。锚点 id 语言无关，新板块无需改代码，
   * 订阅 URL 带上对应锚点即可（如 ?list=best_choices）。
   */
  function getMyDramaSectionId() {
    const list = new URLSearchParams(window.location.search).get('list') || '';
    return /^[a-z0-9_-]+$/.test(list) ? list : 'most_trending';
  }

  /**
   * 简介按语言归位：平台本地化的中文简介直接当译文用，英文简介走原文字段；
   * 空文本不动原值。
   */
  function applyMyDramaDescription(drama, text) {
    if (!text) return;
    if (/[一-鿿]/.test(text)) {
      drama.descriptionZh = text;
    } else {
      drama.description = text;
    }
  }

  /**
   * 封面 URL 形如 https://static.my-drama.com/convert/<英文名 URL 编码>/<lang>/.../cover.webp，
   * 从中还原英文原名；结构对不上返回空串。空格有 %20 与 +（clear 无字版封面）两种编码，
   * 先把 + 还原为空格再 decode。
   */
  function extractMyDramaEnglishTitle(posterUrl) {
    const match = (posterUrl || '').match(/\/convert\/([^/]+)\//);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
    } catch (e) {
      return '';
    }
  }

  /**
   * 从 My Drama「最流行」轮播条目提取基础信息。
   * 列表 h3 标题会随界面语言本地化，英文原名优先从封面 URL 还原、h3 兜底；
   * h3 为平台自带中文名时直接存 titleZh。悬停层简介覆盖率低，主要靠详情页补。
   */
  function extractMyDramaFromListItem(item, index, tags, mdId) {
    let url = '';
    try {
      const u = new URL(item.getAttribute('href') || '', window.location.origin);
      u.search = '';
      url = u.toString();
    } catch (e) {
      // href 异常时留空，详情阶段自动跳过
    }

    // 部分板块（如「最佳选择」）条目的第一个 <img> 是板块共用背景图占位，
    // 真封面是后面的 /convert/ 竖版海报——优先取它，取不到再退回第一个 img
    const img = item.querySelector('img[src*="/convert/"]') || item.querySelector('img');
    const poster = img ? (img.currentSrc || img.src || '') : '';

    const h3 = item.querySelector('h3');
    const listTitle = h3 ? h3.textContent.trim() : '';
    const title = extractMyDramaEnglishTitle(poster) || listTitle;
    const titleZh = (listTitle && listTitle !== title && /[一-鿿]/.test(listTitle)) ? listTitle : '';

    // 悬停层唯一的 <p> 是简介；不用 extractParagraphText，它在 p 为空时会兜底返回整卡文本
    const descP = item.querySelector('p');
    const hoverDesc = descP ? descP.textContent.trim() : '';

    const drama = {
      id: `mydrama_${mdId}_${index}`,
      imdbId: mdId,
      title: title || mdId,
      titleZh,
      poster,
      tags,
      description: '',
      descriptionZh: '',
      company: '',               // 平台自制剧，无独立制作公司信息
      source: 'mydrama',
      sourceListUrl: window.location.href,
      status: 'new',
      url,
      scrapedAt: new Date().toISOString(),
      translatedAt: null
    };
    applyMyDramaDescription(drama, hoverDesc);
    return drama;
  }

  /**
   * My Drama 详情页（播放页）补简介：正文由 RSC 客户端渲染、fetch 拿不到，
   * 但 og:description / meta description 静态直出，格式
   * 「{标题} - 集数 N - 在 My Drama 流媒体平台观看. {简介正文}」，剥模板前缀取正文。
   * 平台自带中英文齐全时直接标记已翻译（对齐 Steam 官方中文范式）；任何失败都保留列表页数据。
   */
  async function fetchMyDramaDetail(drama) {
    if (!drama.url) return drama;

    try {
      const response = await fetch(drama.url, {
        headers: { 'Accept': 'text/html' }
      });

      if (!response.ok) return drama;

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const meta = doc.querySelector('meta[property="og:description"]') ||
                   doc.querySelector('meta[name="description"]');
      const content = meta ? (meta.getAttribute('content') || '').trim() : '';
      // 模板前缀总含品牌词 My Drama 且以英文句点收尾。剥后为空 = 该剧本身无简介，
      // 不能拿模板文案兜底（会污染简介字段）；正则未命中时 body 即全文，照用不丢数据。
      const body = content.replace(/^.*?My Drama[^.]*\.\s*/, '').trim();
      if (body) {
        applyMyDramaDescription(drama, body);
      }

      // 详情页 og:image 是真实封面（/convert/<英文名>/ 路径，CDN host 不定）。
      // 部分板块（如「最佳选择」）列表条目的第一个 <img> 是板块共用背景图占位，
      // 既不是封面、也还原不出英文名：列表封面缺 /convert/ 结构时用 og:image 替换，
      // 并二次尝试还原英文原名（原 h3 中文名移入 titleZh）。「最流行」条目列表封面
      // 本就是 /convert/ 结构且英文名已还原，此段对其为无操作。
      const ogImage = doc.querySelector('meta[property="og:image"]');
      const cover = ogImage ? (ogImage.getAttribute('content') || '').trim() : '';
      if (cover) {
        if (!(drama.poster || '').includes('/convert/')) drama.poster = cover;
        const english = extractMyDramaEnglishTitle(cover);
        if (english && drama.title !== english) {
          if (!drama.titleZh && /[一-鿿]/.test(drama.title)) drama.titleZh = drama.title;
          drama.title = english;
        }
      }

      if (drama.titleZh && drama.descriptionZh && drama.status === 'new') {
        drama.status = 'trans';
        drama.translatedAt = new Date().toISOString();
      }

      console.log(`[ShortScraping] My Drama 详情: ${drama.title} | 简介: ${(drama.description || drama.descriptionZh) ? '有' : '无'}`);
    } catch (e) {
      console.warn(`[ShortScraping] My Drama 详情获取失败: ${drama.title}`, e.message);
    }

    return drama;
  }

  /**
   * fandom 子域（WordPress SSR，无需等待渲染）按订阅 URL 分流两个数据源：
   * ?list=trending → 全站导航菜单 Most Trending 子菜单（约束参数，WP 忽略它照常渲染）；
   * 无参数 → 首页文章流。
   */
  function getFandomListItems() {
    if (/[?&]list=trending/.test(window.location.search)) {
      // 导航有多个下拉（Most Trending / Reviews …），按菜单名定位、第一个下拉兜底
      const submenus = Array.from(document.querySelectorAll('#modal-2-content .wp-block-navigation-submenu'));
      const trendingMenu = submenus.find(li => {
        const label = li.querySelector('.wp-block-navigation-item__label');
        return label && /most\s*trending/i.test(label.textContent);
      }) || submenus[0];
      if (!trendingMenu) return [];
      return Array.from(trendingMenu.querySelectorAll(
        '.wp-block-navigation__submenu-container .wp-block-navigation-link'
      ));
    }
    return Array.from(document.querySelectorAll('li.wp-block-post'));
  }

  /**
   * 从 fandom 列表项提取基础信息。菜单项只有「⬤ 标题」+链接；
   * 文章流项多一张横版特色图。简介与主站 UUID 由详情页补。
   */
  function extractFandomFromListItem(item, index, tags, mdfId) {
    const link = item.querySelector('.wp-block-post-title a') || item.querySelector('a[href]');
    const title = link ? link.textContent.replace(/^[⬤●]\s*/, '').trim() : '';
    const url = link ? link.href : '';

    const img = item.querySelector('.wp-block-post-featured-image img');
    const poster = img ? (img.currentSrc || img.src || '') : '';

    return {
      id: `mydrama_${mdfId}_${index}`,
      imdbId: mdfId,
      title: title || mdfId,
      titleZh: '',
      poster,
      tags,
      description: '',
      descriptionZh: '',
      company: '',
      source: 'mydrama',
      sourceListUrl: window.location.href,
      status: 'new',
      url,
      scrapedAt: new Date().toISOString(),
      translatedAt: null
    };
  }

  /**
   * fandom 剧目文章页（WP SSR）补数据：
   * - 页内回主站的 /video/<UUID> 链接 → 去重键改写为 md+UUID、url 换成主站播放页，
   *   与主站「最流行」条目全局去重（saveSingleDrama 按 imdbId 兜底）；找不到则保留 mdf+slug 键
   * - h1 为权威标题；og:image 兜底封面（菜单项无图）；正文前几个长段落作简介
   *   （og:description 是 SEO 模板文案，不用）。任何失败都保留列表页数据。
   */
  async function fetchFandomDetail(drama) {
    if (!drama.url) return drama;

    try {
      const response = await fetch(drama.url, {
        headers: { 'Accept': 'text/html' }
      });

      if (!response.ok) return drama;

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const mainLink = doc.querySelector('a[href*="my-drama.com/video/"]');
      const vid = mainLink ? (mainLink.getAttribute('href') || '').match(/\/video\/([0-9a-f-]{36})/) : null;
      if (vid) {
        drama.imdbId = `md${vid[1]}`;
        drama.url = `https://my-drama.com/video/${vid[1]}`;
      }

      const h1 = doc.querySelector('h1');
      const h1Text = h1 ? h1.textContent.trim() : '';
      if (h1Text) drama.title = h1Text;

      if (!drama.poster) {
        const ogImage = doc.querySelector('meta[property="og:image"]');
        drama.poster = ogImage ? (ogImage.getAttribute('content') || '').trim() : '';
      }

      // 正文容器内前 3 个长段落当简介；导航菜单等短文本被长度阈值排除
      const content = doc.querySelector('.entry-content') || doc.querySelector('main') || doc.body;
      const paras = Array.from(content.querySelectorAll('p'))
        .map(p => p.textContent.trim())
        .filter(t => t.length > 80)
        .slice(0, 3);
      if (paras.length) drama.description = paras.join('\n');

      console.log(`[ShortScraping] fandom 详情: ${drama.title} | 主站映射: ${vid ? drama.imdbId : '无'} | 简介: ${drama.description ? '有' : '无'}`);
    } catch (e) {
      console.warn(`[ShortScraping] fandom 详情获取失败: ${drama.title}`, e.message);
    }

    return drama;
  }

  /**
   * 读取 Next.js Pages Router 的 SSR 数据（script#__NEXT_DATA__），列表页与详情页
   * 共用，ReelShort 与 DramaShorts 两站通用。解析失败返回 null。
   */
  function readNextData(doc = document) {
    try {
      const script = doc.querySelector('script#__NEXT_DATA__');
      return script ? JSON.parse(script.textContent) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 从首页 SSR 数据取「TOP」板块的 books。按 bookshelf_name 定位而非索引：
   * 板块列表首项没有 books 字段，顺序不可信。定位失败返回空数组（scrapePage 安全跳过）。
   */
  function getReelshortTopBooks() {
    const data = readNextData();
    const shelves = data?.props?.pageProps?.fallback?.['/api/ms/hall/webInfo']?.bookShelfList;
    if (!Array.isArray(shelves)) {
      console.log('[ShortScraping] ReelShort 首页 __NEXT_DATA__ 板块数据未找到');
      return [];
    }
    const top = shelves.find(s => s && typeof s.bookshelf_name === 'string' &&
      s.bookshelf_name.trim().toUpperCase() === 'TOP');
    if (!top || !Array.isArray(top.books)) {
      console.log('[ShortScraping] ReelShort TOP 板块未找到');
      return [];
    }
    return top.books;
  }

  /**
   * 由标题构造友好 slug。详情页 URL 只认结尾的 book_id（错误 slug 会 301 到规范地址），
   * slug 只求可读性，不承担准确性。
   */
  function slugifyReelshortTitle(title) {
    return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /**
   * 从「TOP」板块的 book 对象提取基础信息。
   * special_desc 是截断版简介，先入库兜底，完整版由详情页覆盖。
   */
  function extractReelshortFromBook(book, index, tags, rsId) {
    const title = (book.book_title || '').trim();
    const slug = slugifyReelshortTitle(title) || 'x';
    return {
      id: `reelshort_${rsId}_${index}`,
      imdbId: rsId,
      title: title || rsId,
      titleZh: '',
      poster: book.book_pic || book.default_pic || '',
      tags,
      description: (book.special_desc || '').trim(),
      descriptionZh: '',
      company: '',               // 平台自制剧，无独立制作公司信息
      source: 'reelshort',
      sourceListUrl: window.location.href,
      status: 'new',
      url: `https://www.reelshort.com/movie/${slug}-${book.book_id}`,
      scrapedAt: new Date().toISOString(),
      translatedAt: null
    };
  }

  /**
   * ReelShort 详情页（/movie/<slug>-<book_id>）补完整简介：详情数据同样在
   * __NEXT_DATA__ 直出（pageProps.data.special_desc 为全文）。不读 og:description
   * （带 "Drama also known as X; " 拼接前缀，JSON 更干净）。请求成功后用
   * response.url 覆盖为 301 后的规范地址。任何失败保留列表页截断版数据，不丢卡。
   */
  async function fetchReelshortDetail(drama) {
    if (!drama.url) return drama;

    try {
      const response = await fetch(drama.url, {
        headers: { 'Accept': 'text/html' }
      });

      if (!response.ok) return drama;

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const detail = readNextData(doc)?.props?.pageProps?.data;
      if (detail) {
        const fullDesc = (detail.special_desc || '').trim();
        if (fullDesc) drama.description = fullDesc;
        const title = (detail.book_title || '').trim();
        if (title) drama.title = title;
        if (!drama.poster && detail.book_pic) drama.poster = detail.book_pic;
      }
      if (response.url) drama.url = response.url.split('?')[0];

      console.log(`[ShortScraping] ReelShort 详情: ${drama.title} | 简介: ${drama.description ? '有' : '无'}`);
    } catch (e) {
      console.warn(`[ShortScraping] ReelShort 详情获取失败: ${drama.title}`, e.message);
    }

    return drama;
  }

  /**
   * ReelShort fandom 文章流（WordPress SSR，无需等待渲染）。
   * 主题与 my-drama fandom 不同：无 wp-block-post，文章卡为 article.post。
   */
  function getReelshortFandomItems() {
    return Array.from(document.querySelectorAll('article.post'));
  }

  /**
   * 从 fandom 文章流列表项提取基础信息：标题/链接在 .entry-title a，
   * 封面在 .featured-image 的行内 background-image，摘要在 .entry-content p（尾带 […]）。
   * 简介全文与主站 book_id 由详情页补。
   */
  function extractReelshortFandomFromListItem(item, index, tags, rsfId) {
    const link = item.querySelector('.entry-title a');
    const title = link ? link.textContent.trim() : '';
    const url = link ? link.href : '';

    let poster = '';
    const figure = item.querySelector('.featured-image');
    if (figure) {
      const m = (figure.getAttribute('style') || '').match(/url\(\s*['"]?(.*?)['"]?\s*\)/);
      poster = m ? m[1].trim() : '';
    }

    const excerptP = item.querySelector('.entry-content p');
    const excerpt = excerptP
      ? excerptP.textContent.replace(/\[(…|\.\.\.)\]\s*$/, '').trim()
      : '';

    return {
      id: `reelshort_${rsfId}_${index}`,
      imdbId: rsfId,
      title: title || rsfId,
      titleZh: '',
      poster,
      tags,
      description: excerpt,
      descriptionZh: '',
      company: '',
      source: 'reelshort',
      sourceListUrl: window.location.href,
      status: 'new',
      url,
      scrapedAt: new Date().toISOString(),
      translatedAt: null
    };
  }

  /**
   * fandom 文章页（WP SSR）补数据：
   * - 回主站 /movie/<slug>-<book_id> 链接 → 去重键改写为 rs+book_id、url 换成主站
   *   剧目页，与主站 TOP 条目全局去重（saveSingleDrama 按 imdbId 兜底；同批多篇
   *   文章指向同一剧时后到者在保存点被拦）；找不到回链保留 rsf-+slug 键照常入库
   * - h1.entry-title 为权威标题；正文前几个长段落作简介——此站 og:description 是
   *   正文首段真摘要（与 my-drama fandom 的「SEO 模板不可用」相反），可作兜底；
   *   封面列表页 background-image 优先、og:image 兜底。任何失败都保留列表页数据。
   */
  async function fetchReelshortFandomDetail(drama) {
    if (!drama.url) return drama;

    try {
      const response = await fetch(drama.url, {
        headers: { 'Accept': 'text/html' }
      });

      if (!response.ok) return drama;

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const mainLink = doc.querySelector('a[href*="reelshort.com/movie/"], a[href^="/movie/"]');
      const mainHref = mainLink ? (mainLink.getAttribute('href') || '') : '';
      const bid = mainHref.match(/-([0-9a-f]{24})(?:[/?#]|$)/);
      if (bid) {
        drama.imdbId = `rs${bid[1]}`;
        const u = new URL(mainHref, 'https://www.reelshort.com');
        u.search = '';
        u.hash = '';
        drama.url = u.toString();
      }

      const h1 = doc.querySelector('h1.entry-title') || doc.querySelector('h1');
      const h1Text = h1 ? h1.textContent.trim() : '';
      if (h1Text) drama.title = h1Text;

      if (!drama.poster) {
        const ogImage = doc.querySelector('meta[property="og:image"]');
        drama.poster = ogImage ? (ogImage.getAttribute('content') || '').trim() : '';
      }

      // 正文容器内前 3 个长段落当简介；导航菜单等短文本被长度阈值排除
      const content = doc.querySelector('.entry-content') || doc.querySelector('main') || doc.body;
      const paras = Array.from(content.querySelectorAll('p'))
        .map(p => p.textContent.trim())
        .filter(t => t.length > 80)
        .slice(0, 3);
      if (paras.length) {
        drama.description = paras.join('\n');
      } else {
        const ogDesc = doc.querySelector('meta[property="og:description"]');
        const ogText = ogDesc ? (ogDesc.getAttribute('content') || '').trim() : '';
        if (ogText) drama.description = ogText;
      }

      console.log(`[ShortScraping] ReelShort fandom 详情: ${drama.title} | 主站映射: ${bid ? drama.imdbId : '无'} | 简介: ${drama.description ? '有' : '无'}`);
    } catch (e) {
      console.warn(`[ShortScraping] ReelShort fandom 详情获取失败: ${drama.title}`, e.message);
    }

    return drama;
  }

  /**
   * DramaShorts 列表数据：/top-movies 直取 pageProps.movies；首页按 ?list=<板块id>
   * 从 pageProps.discover 选板块（板块项形如 {id, type, data: {title, movies}}），
   * 无参数或非法值默认 top_trending。定位失败返回空数组（scrapePage 安全跳过）。
   */
  function getDramashortsMovies() {
    const pageProps = readNextData()?.props?.pageProps;
    if (!pageProps) {
      console.log('[ShortScraping] DramaShorts __NEXT_DATA__ 未找到');
      return [];
    }
    if (window.location.pathname.replace(/\/+$/, '') === '/top-movies') {
      return Array.isArray(pageProps.movies) ? pageProps.movies : [];
    }
    const list = new URLSearchParams(window.location.search).get('list') || '';
    const sectionId = /^[a-z0-9_-]+$/.test(list) ? list : 'top_trending';
    const sections = Array.isArray(pageProps.discover) ? pageProps.discover : [];
    const section = sections.find(s => s && s.id === sectionId);
    const movies = section && section.data ? section.data.movies : null;
    if (!Array.isArray(movies)) {
      console.log(`[ShortScraping] DramaShorts 首页板块未找到: ${sectionId}`);
      return [];
    }
    return movies;
  }

  /**
   * 封面走站点 Next.js 图片优化端点（站内卡片同款取图方式）：CDN 原图约 1.5MB/张，
   * w=384 约 72KB（浏览器协商 WebP 更小），弹窗一屏多卡不至于拖垮带宽与加载。
   */
  function buildDramashortsPosterUrl(rawUrl) {
    if (!rawUrl) return '';
    return `https://dramashorts.io/_next/image?url=${encodeURIComponent(rawUrl)}&w=384&q=75`;
  }

  /**
   * 从 movie 对象提取基础信息。简介为全文；封面用 coverWithTitle（站点卡片
   * cover+title 双图叠加的预合成版），退化取 cover。观看页 /shorts/<UUID>
   * 仅凭 id 即可构造。
   */
  function extractDramashortsFromMovie(movie, index, tags, dsId) {
    const images = movie.images || {};
    return {
      id: `dramashorts_${dsId}_${index}`,
      imdbId: dsId,
      title: (movie.title || '').trim() || dsId,
      titleZh: '',
      poster: buildDramashortsPosterUrl(images.coverWithTitle || images.cover),
      tags,
      description: (movie.description || '').trim(),
      descriptionZh: '',
      company: '',               // 平台自制剧，无独立制作公司信息
      source: 'dramashorts',
      sourceListUrl: window.location.href,
      status: 'new',
      url: `https://dramashorts.io/shorts/${dsId.slice(2)}`,
      scrapedAt: new Date().toISOString(),
      translatedAt: null
    };
  }

  /**
   * 获取单个剧集详情
   */
  async function fetchImdbDetail(drama) {
    if (!drama.url) return drama;

    try {
      const response = await fetch(drama.url, {
        headers: { 'Accept': 'text/html' }
      });

      if (!response.ok) return drama;

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // 提取简介
      drama.description = extractDescription(doc);

      // 提取出品公司
      drama.company = extractCompany(doc);

      // 不从详情页补封面：详情页可能返回剧照、视频缩略图或推荐图，容易误当成封面。
      // 封面只信任搜索结果列表中的海报容器；没有则使用默认占位图。

      console.log(`[ShortScraping] 详情: ${drama.title} | 公司: ${drama.company || '无'} | 封面: ${drama.poster ? '有' : '无'}`);
    } catch (e) {
      console.warn(`[ShortScraping] 详情获取失败: ${drama.title}`, e.message);
    }

    return drama;
  }

  /**
   * 提取简介
   */
  function extractDescription(doc) {
    const testIdEl = doc.querySelector('[data-testid="plot-xl"]') ||
                     doc.querySelector('[data-testid="plot"]');
    if (testIdEl) {
      const text = testIdEl.textContent.trim();
      if (text.length > 10) return text;
    }

    const metaDesc = doc.querySelector('meta[name="description"]');
    if (metaDesc) {
      const content = metaDesc.getAttribute('content') || '';
      if (content.length > 20 && !content.includes('IMDb') && !content.includes('Watch')) {
        return content;
      }
    }

    return '';
  }

  /**
   * 提取出品公司
   */
  function extractCompany(doc) {
    // 查找 company 链接
    const companyLinks = doc.querySelectorAll('a[href*="/company/"]');
    for (const link of companyLinks) {
      const text = link.textContent.trim();
      // 排除标签文本
      if (text.length > 2 && !/production compan|companies/i.test(text)) {
        return text;
      }
    }

    // 旧版 IMDB
    const txtBlocks = doc.querySelectorAll('.txt-block');
    for (const block of txtBlocks) {
      const header = block.querySelector('h4, h3, span.inline');
      if (header && /company/i.test(header.textContent)) {
        const links = block.querySelectorAll('a');
        for (const link of links) {
          const text = link.textContent.trim();
          if (text.length > 2 && !/company/i.test(text)) {
            return text;
          }
        }
      }
    }

    return '';
  }

  /**
   * 保存单条数据：经后台单写者队列入库。此前这里直接「get 全表 → set 全表」，
   * 落在后台翻译线读改写窗口内时，新卡会被翻译线的整表写回覆盖丢失。
   */
  async function saveSingleDrama(drama) {
    const response = await chrome.runtime.sendMessage({ action: 'saveDrama', drama });

    if (!response?.success) {
      throw new Error(response?.error || '后台保存失败');
    }

    return response.saved;
  }

  /**
   * 从列表项快速提取 IMDB ID。用于先查重，重复项无需继续解析标题、封面和详情页。
   */
  function extractImdbIdFromListItem(item) {
    const link = item.querySelector('a[href*="/title/tt"]');
    return link ? extractImdbId(link.getAttribute('href') || '') : null;
  }

  /**
   * 从 URL 提取 IMDB ID
   */
  function extractImdbId(url) {
    if (!url) return null;
    const match = url.match(/\/title\/(tt\d+)/);
    return match ? match[1] : null;
  }

  // Steam 列表每次取的条数（new&trending top N）
  const STEAM_QUERY_COUNT = 50;

  /**
   * 从订阅的内容中心页 URL 构造动态查询接口 URL。
   * 该接口同源返回 appids，不依赖页面渲染（后台标签页也可用）。
   * - /category/<cat>：strContentHubType=category，分类名取自路径。
   * - /tags/<locale>/<标签名>：接口只认数字 tagID（strContentHubType=tag + nTagID），
   *   URL 里只有本地化标签名，id 从页面 SSR 直出的 [data-ch_hub_data] 读取。
   */
  function buildSteamQueryUrl(pageUrl) {
    let flavor = '';
    let hubParams = null;
    try {
      const u = new URL(pageUrl);
      flavor = u.searchParams.get('flavor') || 'contenthub_newandtrending';
      const categoryMatch = u.pathname.match(/\/category\/([^/?#]+)/);
      if (categoryMatch) {
        hubParams = { strContentHubType: 'category', strContentHubCategory: categoryMatch[1] };
      } else if (u.pathname.startsWith('/tags/')) {
        const tagId = readSteamTagIdFromPage();
        if (tagId) {
          hubParams = { strContentHubType: 'tag', strContentHubCategory: '', nTagID: String(tagId) };
        }
      }
    } catch (e) {
      return null;
    }
    if (!hubParams) return null;

    const params = new URLSearchParams({
      cc: 'us',
      l: 'english',
      flavor,
      start: '0',
      count: String(STEAM_QUERY_COUNT),
      ...hubParams,
      return_capsules: 'false',
      origin: 'https://store.steampowered.com'
    });
    return `https://store.steampowered.com/saleaction/ajaxgetsaledynamicappquery?${params.toString()}`;
  }

  /**
   * 读标签页内嵌 hub 配置的数字 tagID，形如 {"strHubType":"tags","nTagID":18594}。
   * 该属性由服务端渲染直出，后台非激活标签页无需等 React 渲染即可读取。
   */
  function readSteamTagIdFromPage() {
    const el = document.querySelector('[data-ch_hub_data]');
    if (!el) return null;
    try {
      const tagId = parseInt(JSON.parse(el.getAttribute('data-ch_hub_data')).nTagID, 10);
      return tagId > 0 ? tagId : null;
    } catch (e) {
      return null;
    }
  }

  // 初始化
  init();
})();
