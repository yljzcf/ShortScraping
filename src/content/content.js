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

  // 与后台共用的采集口径（src/shared/scrape-rules.js，manifest 与后台强制注入都排在本文件之前）：
  // fandom 临时键前缀、类型标签清洗、Shortical sitemap 解析，两边不再各写一份。
  // 订阅判定 UrlMatch.matchSubscription 同理来自 src/shared/url-match.js（见 findSubscriptionForUrl）
  const { cleanGenres, isUnmappedFandomKey, parseShorticalSitemap } = ScrapeRules;

  // 抓取进行中护栏：后台兜底路径（waitForTabComplete 超时 → 强制注入 →
  // sendScrapeWhenReady 轮询补发）可能让同一标签页先后收到多条 'scrape'。
  // 并行双跑会经保存点去重互相分走对方的新增卡——入库不重复，但每个 response
  // 都只有部分结果，performScrape 报告计数失真（实测报 83 存 87）。
  // 复用进行中的 Promise，让每条消息都拿到同一份完整结果；结束后复位，
  // 后续消息照常开启新一轮。
  let scrapeInFlight = null;

  /**
   * 抓取唯一入口：'scrape' 消息与页面上的抓取按钮都走这里。按钮以前直接调 scrapePage，
   * 用户在后台抓取标签页里恰好抓取进行中点一下，就会两轮并跑、互相分走新增卡、计数失真，
   * 模块级的存量快照也会被另一轮整个换掉（审查 button-bypasses-inflight-guard）。
   */
  function runScrape() {
    if (!scrapeInFlight) {
      scrapeInFlight = scrapePage().finally(() => { scrapeInFlight = null; });
    }
    return scrapeInFlight;
  }

  /**
   * scrape 应答附带的本页事实（v1.7.4）：实际地址与文档的 HTTP 状态。后台据此把「被拦截」（DramaBox 的 CloudFront
   * 403 拦截页照样注入内容脚本、页面上没有列表）与站点改版分开，「打开后的页面不在订阅里」时也能说出跳到了哪。
   * responseStatus 是 Chrome 109+ 的导航计时字段，取不到就不带。
   */
  function pageFacts() {
    const facts = {};
    const href = window.location && window.location.href;
    if (typeof href === 'string' && href) facts.pageUrl = href;
    try {
      const status = Number(performance.getEntriesByType('navigation')[0]?.responseStatus);
      if (Number.isInteger(status) && status > 0) facts.httpStatus = status;
    } catch (e) {
      // 没有导航计时（非浏览器环境 / 旧版本）：不带状态码
    }
    return facts;
  }

  /**
   * 初始化
   */
  function init() {
    console.log('[ShortScraping] 内容脚本已加载');

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'scrape') {
        // 只回条数与判定（v1.7.0）：以前回整批新卡对象，后台只用它的长度，却要跨进程结构化克隆一遍；
        // 也丢了「当前页不在订阅里 / 页面上没找到列表」这两个信号，后台只能当成「没有新增」（审查 M2）
        runScrape().then(result => {
          sendResponse({
            success: true, newCount: result.dramas.length, subscribed: result.subscribed, listCount: result.listCount,
            ...pageFacts()
          });
        }).catch(e => {
          console.error('[ShortScraping] 抓取出错:', e);
          sendResponse({ success: false, error: e.message });
        });
        return true;
      }
      if (request.action === 'collectListIds') {
        collectListIds().then(sendResponse).catch(e => {
          console.error('[ShortScraping] 读列表条目 ID 出错:', e);
          sendResponse({ success: false, error: e.message });
        });
        return true;
      }
      // 其余消息不保留异步响应通道，避免发送方端口悬挂
      return false;
    });

    const site = detectSite(window.location.hostname);
    const adapter = site ? ADAPTERS[site] : null;
    if (adapter && adapter.matches(window.location.href)) {
      addScrapeButton();
    }
  }

  /**
   * 只读当前列表页的条目 ID（v1.7.0，IMDb 订阅切换为滚动日期窗口时的一次性基线用）：不向后台要抓取上下文、
   * 不开详情页、不入库，后台把库里没有的记进已知片单。页面不是该站适配器认得的列表页时回空（listCount 0），
   * 后台据此不记任何 ID。单项解析失败只跳过这一项。
   */
  async function collectListIds() {
    const site = detectSite(window.location.hostname);
    const adapter = site ? ADAPTERS[site] : null;
    if (!adapter || !adapter.matches(window.location.href)) return { success: true, ids: [], listCount: 0 };
    const listItems = await adapter.getListItems();
    const ids = [];
    for (const item of listItems) {
      try {
        const id = adapter.extractId(item);
        if (id && !ids.includes(id)) ids.push(id);
      } catch (e) {
        console.warn('[ShortScraping] 列表项 ID 解析失败，跳过:', e.message);
      }
    }
    return { success: true, ids, listCount: listItems.length };
  }

  /**
   * 按 hostname 判断当前站点。规则单一真源在 src/shared/site-registry.js
   * （经 manifest content_scripts js 数组先行注入，后台强制注入路径同序）。
   */
  function detectSite(hostname) {
    return SiteRegistry.siteOfHostname(hostname);
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
    genresFromDetail: true,    // genres 权威源在详情页 JSON-LD（回填路径需请求详情）
    async fetchDetail(drama) {
      // IMDB 详情失败也返回 drama（保留原行为：简介可为空但仍记录）
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
   * 内容脚本里所有直连 fetch 的唯一入口：默认 25 秒期限，**正文也算在期限内**。
   * 抓取走后台串行队列，后台等 'scrape' 回复又不设期限：一个响应回了头、正文却迟迟
   * 不发完，response.text() 永不 resolve，整条抓取队列就跟着堵死、后台标签页也关不掉
   * （审查 no-fetch-timeout-hangs-scrape-queue）。所以只给 fetch() 本身计时不够——
   * 这里在期限内把正文读成文本，再让返回的 response 的 text()/json() 直接交出这份缓存，
   * 调用方原有写法（ok/status/url + text()/json()）一行不用改。
   * 超时即 abort 底层请求并抛出带地址的中文错误，由各调用方的 catch 按「本轮取不到」收口。
   * 期限用 Promise.race 兜底：底层即使不理会 abort 信号，也保证按时返回。
   * 后台 SW / 设置页用的是同语义的 src/shared/fetch-util.js（FetchUtil.fetchWithDeadline，v1.7.0）；
   * 这里刻意留一份：迁过去要改 manifest content_scripts 与后台强制注入清单、连带一串守卫测试，只省二十几行。
   */
  const FETCH_TIMEOUT_MS = 25000;

  async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    let timer = null;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`请求超时（${timeoutMs / 1000} 秒内未读完响应）: ${url}`);
        error.name = 'TimeoutError';
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const request = (async () => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      // 标准 Response 都有 text()；没有的（非标准对象）原样交回
      if (response && typeof response.text === 'function') {
        const body = await response.text();
        response.text = async () => body;
        response.json = async () => JSON.parse(body);
      }
      return response;
    })();
    try {
      return await Promise.race([request, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 同源取**服务端原始 HTML 文本**：各站同源详情页与列表页重取共用（v1.6.9 起 GoodShort /
   * ShortMax 用，之后 IMDB / RoyalRoad / 两个 fandom / MyDrama 同源详情也收拢到这里）。
   * 缺省取当前页——GoodShort 与 ShortMax 的列表都不能读实时 DOM，理由各不相同、但解法相同：
   *   · GoodShort 的 __INITIAL_STATE__ 内联脚本执行完就把自己从 DOM 里删掉；
   *   · ShortMax 的板块 hydrate 后变成按视口裁剪的轮播（8 张卡在 799px 下只剩 5 张）。
   * 同源请求不需要后台代理；非 2xx / 超时 / 网络异常一律打日志后返回 null，调用方按
   * 「本轮取不到」处理（下轮重试）。要读 response.url（301 后的规范地址）的 ReelShort
   * 两处拿不到它，仍直接用 fetchWithTimeout。
   */
  async function fetchServerHtml(url = window.location.href) {
    // 固定英文的站点（My Drama，v1.7.4）同源取数也显式带英文 Accept-Language：后台的 declarativeNetRequest
    // 规则已改写这些请求头，这里再写一遍，规则没装上（扩展未重新加载）时详情页也不会拿到中文版
    try {
      const headers = { 'Accept': 'text/html' };
      if (SiteRegistry.isForceEnglishUrl?.(new URL(url, window.location.href).href)) {
        headers['Accept-Language'] = SiteRegistry.FORCE_ENGLISH_ACCEPT_LANGUAGE;
      }
      const response = await fetchWithTimeout(url, { headers });
      if (!response.ok) {
        console.warn(`[ShortScraping] 取服务端 HTML 失败 HTTP ${response.status}: ${url}`);
        return null;
      }
      return await response.text();
    } catch (e) {
      console.warn(`[ShortScraping] 取服务端 HTML 异常: ${url}`, e.message);
      return null;
    }
  }

  function parseHtmlDocument(html) {
    try {
      return new DOMParser().parseFromString(html, 'text/html');
    } catch (e) {
      return null;
    }
  }

  /**
   * fetchServerHtml + parseHtmlDocument：取不到或解析失败返回 null。200 的空正文照常解析成
   * 空文档，不当失败（与收拢前各详情路径「!response.ok 才放弃」的口径一致）。
   */
  async function fetchServerDocument(url) {
    const html = await fetchServerHtml(url);
    return html === null ? null : parseHtmlDocument(html);
  }

  /**
   * 从 text[start]（必须是 open）起做**字符串感知**的括号匹配，截出到配对 close 为止的完整
   * 字面量（NetShort flight 数组与 GoodShort 状态对象共用）。不靠尾部锚点（GoodShort 的收尾是
   * `;(function(){…}())` 这种自删脚本，站点随时可改），也不靠计数——标题/简介里带括号或
   * 转义引号时纯计数会截错。只数 open/close 这一对，另一种括号不计。匹配不上返回 null。
   */
  function sliceBalanced(text, start, open, close) {
    if (typeof text !== 'string' || text[start] !== open) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  /**
   * 纯前端渲染区块的等待：每 500ms 取一次，计数非 0 且连续两次不变即认为渲染完成，
   * 最长约 8 秒（16 次），超时交回最后一次的结果（MyDrama 首页与 Shortical 首页共用）。
   * query 取结果，countOf 从结果数出条目数。
   */
  async function pollUntilStable(query, countOf) {
    let last = -1;
    for (let i = 0; i < 16; i++) {
      const result = query();
      const count = countOf(result);
      if (count > 0 && count === last) return result;
      last = count;
      await new Promise(r => setTimeout(r, 500));
    }
    return query();
  }

  /**
   * 取单个 appId 的 appdetails 数据（指定语言）。该语言无数据（success:false）返回 null；
   * **HTTP 非 2xx 抛错**（429 限流 / 5xx），由 fetchSteamDetail 的 catch 收口成整卡本轮跳过、
   * 下轮重试。以前两者都返回 null：中文档一被 429 就当成「无官方中文」，卡片以 new 入库交
   * AI 翻译，之后去重命中只回填 genres，官方中文名与简介再也补不回来（审查 steam-zh-429-permanent-loss）。
   */
  async function fetchSteamAppDetails(appId, lang) {
    const api = `https://store.steampowered.com/api/appdetails?appids=${appId}&l=${lang}&cc=us`;
    const response = await fetchWithTimeout(api, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) throw new Error(`Steam appdetails HTTP ${response.status}（l=${lang}）`);
    const json = await response.json();
    const entry = json && json[appId];
    return (entry && entry.success && entry.data) ? entry.data : null;
  }

  /**
   * 用 Steam 官方 appdetails 取英文原名/简介 + 官方简体中文名/简介（同源，绕开年龄门）。
   * 英文取不到（成人专属/受限/不可用）→ 返回 null 跳过；任一语言档 HTTP 失败 → 整卡本轮跳过。
   * 有官方中文则直接采用并标记已翻译；完全无中文则保持 new，交给翻译线 AI 兜底。
   * opts.genresOnly（存量 genres 回填用）：英文档填好 genres 即返回，不再请求中文档——
   * 后台对去重命中的存量只合并 genres，那次请求的结果用不上，还白白叠加限流压力
   * （审查 steam-backfill-extra-request）。
   */
  async function fetchSteamDetail(drama, opts = {}) {
    const appId = drama.itemId; // Steam 项的 appId 存在 itemId 字段
    try {
      const en = await fetchSteamAppDetails(appId, 'english');
      if (!en) {
        console.log(`[ShortScraping] Steam appdetails 无数据，跳过: ${drama.title} (${appId})`);
        return null;
      }
      // 官方内容类型标签（Action/Adventure/RPG…宽门类）。更细的商店用户标签在
      // 有年龄门的商店页里，appdetails 拿不到，不碰。
      const genres = cleanGenres((en.genres || []).map(g => g && g.description));
      if (opts.genresOnly) {
        drama.genres = genres;
        return drama;
      }

      const enName = (en.name || '').trim();
      const enDesc = decodeHtmlEntities(en.short_description || '').trim();

      if (!enName && !enDesc) {
        console.log(`[ShortScraping] Steam 详情无正文，跳过: ${drama.title} (${appId})`);
        return null;
      }

      // 官方简体中文：与英文不同（确有本地化）**且确实是中文**才采用。
      // 只查「与英文不同」会把开发商母语的名字当成中文译名——Steam 的中文档在
      // 没做简体中文本地化时返回的就是母语名（实测韩/俄/西/法四种，弹窗上直接
      // 显示成韩语标题）。判据见 TranslateConfig.hasChineseChars 的注释。
      const zh = await fetchSteamAppDetails(appId, 'schinese');
      const zhName = zh ? (zh.name || '').trim() : '';
      const zhDesc = zh ? decodeHtmlEntities(zh.short_description || '').trim() : '';
      const titleZh = (zhName && zhName !== enName && TranslateConfig.hasChineseChars(zhName)) ? zhName : '';
      const descriptionZh = (zhDesc && zhDesc !== enDesc && TranslateConfig.hasChineseChars(zhDesc)) ? zhDesc : '';

      if (enName) drama.title = enName;        // 英文原名（弹窗里的“（原名）”）
      drama.description = enDesc;
      drama.genres = genres;
      if (en.header_image) drama.poster = en.header_image;

      // 采用 Steam 官方中文。**官方中文齐全才跳过 AI 翻译**：只有一半时（商店有
      // 中文名但没中文简介，或反之）留 status='new' 交翻译线补另一半——后台的
      // fillOnly 保证不会拿 AI 译文覆盖已有的官方译名。此前判据是「任一非空即
      // 标 trans」，缺的那半就永远补不上了（全库实测 23 条，v1.5.14 修）。
      if (titleZh) drama.titleZh = titleZh;
      if (descriptionZh) drama.descriptionZh = descriptionZh;
      if (titleZh && (!enDesc || descriptionZh)) {
        drama.status = 'trans';
        drama.translatedAt = new Date().toISOString();
      }

      console.log(`[ShortScraping] Steam 详情: ${drama.title}${titleZh ? ` / ${titleZh}` : ''}`);
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
        const resp = await fetchWithTimeout(queryUrl, { headers: { 'Accept': 'application/json' }, credentials: 'include' });
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
    genresFromDetail: true,    // genres 权威源在 appdetails 接口（回填路径需请求详情）
    async fetchDetail(drama, opts) {
      // opts 只有回填路径会传（{ genresOnly: true }），其余适配器都不认第二个参数
      return await fetchSteamDetail(drama, opts);
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
      const sectionId = getMyDramaSectionId();
      return sectionId ? await waitForMyDramaItems(sectionId) : [];
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
    genresFromDetail: true,    // genres 权威源在主站详情页 JSON-LD（回填路径需请求详情）
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
    genresFromDetail: true,    // 列表 theme 只 1 个，权威 tag_list 在 /movie/ 详情页
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

  /**
   * NetShort 适配器（netshort.com，Next.js App Router）：无 __NEXT_DATA__，
   * 数据在内联 self.__next_f.push RSC flight 流中（SSR 直出，document_end 时
   * 已就绪，content script 读 script 文本解析、不依赖页面 window）。首页
   * videoListGroup 约 5 个板块，板块只有 groupName 没有 id，订阅 URL 用约定
   * 参数 ?list=<板块名归一化> 选板块（Trending Now→trending_now、
   * Exclusive Originals→exclusive_originals；无参数默认 trending_now；
   * App Router 忽略未知参数照常渲染）。列表条目自带完整简介（与 /episode/
   * 观看页 flight 中逐字一致），无需请求详情页。基础域恒英文（zh-CN 请求头
   * 不改变输出），无平台中文，status 走 new 交给 AI 翻译。
   */
  const netshortAdapter = {
    matches(url) {
      try {
        const u = new URL(url);
        return u.hostname.endsWith('netshort.com') && u.pathname === '/';
      } catch (e) {
        return false;
      }
    },
    async getListItems() {
      return getNetshortItems();
    },
    extractId(item) {
      // shortPlayId 是页面 URL 所用的规范数字 id，加 ns 前缀与全局去重键约定一致
      const id = item && typeof item.shortPlayId === 'string' ? item.shortPlayId : '';
      return /^\d{5,}$/.test(id) ? `ns${id}` : null;
    },
    extractBasic(item, tags, id, index) {
      return extractNetshortFromItem(item, index, tags, id);
    },
    async fetchDetail(drama) {
      // 列表 shotIntroduce 即简介全文（与观看页逐字一致），无需二次请求
      return drama;
    }
  };

  /**
   * FlickReels 适配器（www.flickreels.net，Nuxt 3 SSR，v1.6.5）：首页板块数据在
   * script#__NUXT_DATA__（devalue「扁平」格式，见 unflattenNuxtPayload），SSR 直出、hydrate
   * 后仍留在 DOM（2026-09-16 真机实测），document_end 直读解析，不依赖页面 window。
   * 板块没有可订的稳定 id（column_config.id 是运营配置号），订阅 URL 用约定参数
   * ?list=<板块标题归一化> 选板块（'🔥🔥🔥Hot Picks ' → hot_picks、'7-Day Star🥇🥈🥉' →
   * 7_day_star；无参数默认 hot_picks；Nuxt 忽略未知 query，实测 200 且载荷一致）。
   * 列表条目自带全文简介 introduce（与详情页逐字一致）与英文 tag_list，无需请求详情页、
   * 无需后台代理。订阅 URL 必须带 www（裸域 301 到 www 后 location.href 与订阅串不等，
   * findSubscriptionForUrl 会落空）。基础域恒英文（Accept-Language: zh-CN 不改输出，
   * i18n detectBrowserLanguage=false 不按浏览器语言跳转；/tc/ 是另一套繁中片库，不是本片
   * 的中文版），无平台中文，status 走 new 交给 AI 翻译。
   */
  const flickreelsAdapter = {
    matches(url) {
      try {
        const u = new URL(url);
        return u.hostname.endsWith('flickreels.net') && u.pathname === '/';
      } catch (e) {
        return false;
      }
    },
    async getListItems() {
      return getFlickreelsItems();
    },
    extractId(item) {
      // playlet_id 是播放页 URL 所用的规范数字 id（当前 4~5 位，不限位数），加 fr 前缀与全局去重键约定一致
      const id = item && item.playlet_id != null ? String(item.playlet_id) : '';
      return /^\d+$/.test(id) ? `fr${id}` : null;
    },
    extractBasic(item, tags, id, index) {
      return extractFlickreelsFromItem(item, index, tags, id);
    },
    async fetchDetail(drama) {
      // 列表 introduce 即简介全文（与详情页 chapters-list 数据逐字一致），无需二次请求
      return drama;
    }
  };

  /**
   * GoodShort 适配器（www.goodshort.com/channel/<板块>，Vue SSR，v1.6.9）：
   * 数据在内联 `window.__INITIAL_STATE__={…}`，但**那个 script 执行完会把自己从
   * DOM 里删掉**（`parentNode.removeChild(s)`，真机实测 document_end 时已查不到，
   * outerHTML 里也没有），页面 window 上的值又在隔离世界外 → 只能同源重取一次
   * 原始 HTML 文本来解析（fetchServerHtml，与 ShortMax 共用）。
   *
   * 订阅用板块的「More」页 /channel/<板块> 而不是首页：首页每板块 SSR 只直出 6 条，
   * channel 页正好 10 条（total=10、pageSize=20，无分页）且首页那 6 条是它的子集
   * （2026-09-17 用户定）。每个板块各是独立 URL，不需要 ?list= 约定（同 Netflix 六榜单）。
   *
   * 条目字段齐全、**零详情请求**：introduction 与详情页逐字一致（结尾的「…」是站点
   * 自己的数据、不是被截断）。页面恒英文（Accept-Language: zh-CN 不改变输出），
   * 无平台中文，status 全走 new 交 AI 翻译。
   */
  const goodshortAdapter = {
    matches(url) {
      try {
        const u = new URL(url);
        return u.hostname.endsWith('goodshort.com') && /^\/channel\/[^/]+\/?$/.test(u.pathname);
      } catch (e) {
        return false;
      }
    },
    async getListItems() {
      return await getGoodshortItems();
    },
    extractId(item) {
      // sourceId 是站点全站规范 id（详情页 URL 尾段就是它），加 gs 前缀与全局去重键约定一致
      const id = item && item.sourceId != null ? String(item.sourceId).trim() : '';
      return /^\d{6,}$/.test(id) ? `gs${id}` : null;
    },
    extractBasic(item, tags, id, index) {
      return extractGoodshortFromItem(item, index, tags, id);
    },
    async fetchDetail(drama) {
      // 列表 introduction 即详情页同一份文本，无需二次请求
      return drama;
    }
  };

  /**
   * Shortical 适配器（shortical.com 首页，Vite+React 纯前端渲染，v1.6.9）：
   * 服务端只回 9KB 空壳（<div id="root">），**只能读 hydrate 后的 DOM**（同 MyDrama
   * 范式轮询等条目数稳定）。「Top Recommended」区块恒 9 张卡（容器是 overflow-x-auto
   * 横滚行，条目数与视口宽度无关）；板块内容每次请求都轮换，复跑有新增属站点行为。
   *
   * **itemId 与 url 都取 sitemap 的规范 slug，不是首页 href 尾段那个数字**（v1.6.10 修）：
   * 站点两套 id 并行，href 那套打不开详情页。取数细节见 readShorticalCanonicalSlugs 与
   * getShorticalItems 的注释；存量由后台 migrateShorticalCanonicalIds 一次性改写。
   *
   * genres 两段式（2026-09-17 用户定「DOM 为主，token 可用时补」）：卡片上只印**第一个**
   * 分类，官方接口 /api/v1/series/top-recommendations 给全量 2~4 个但匿名调用 401——
   * token 在页面 firebaseLocalStorageDb 里、内容脚本同源可读。先用 DOM 那一个填上保底，
   * 再尽力去补全量；token 取不到 / 接口失败一律静默保留保底值（见 backfillShorticalGenres）。
   * 封面两条路线**逐字节相同**（9/9 实测），所以走 DOM 不损失任何图像质量。
   *
   * 订阅 URL 必须是**裸域**（www.shortical.com 会 301 到裸域，带 www 会让
   * findSubscriptionForUrl 落空，与 FlickReels 恰好相反）。无平台中文，status 全走 new。
   */
  const shorticalAdapter = {
    matches(url) {
      try {
        const u = new URL(url);
        return u.hostname.endsWith('shortical.com') && u.pathname === '/';
      } catch (e) {
        return false;
      }
    },
    async getListItems() {
      return await getShorticalItems();
    },
    extractId(item) {
      // item.id 是 sitemap 规范 slug 的尾段数字（**不是**首页 href 的尾段数字，那套号
      // 会漂移、同一部剧被反复当新卡入库）；加 sc 前缀与全局去重键约定一致
      const id = item && item.id ? String(item.id) : '';
      return /^\d+$/.test(id) ? `sc${id}` : null;
    },
    extractBasic(item, tags, id, index) {
      return extractShorticalFromItem(item, index, tags, id);
    },
    async fetchDetail(drama) {
      // 列表卡片已含完整简介（与接口 description 逐字一致），无需二次请求
      return drama;
    }
  };

  /**
   * ShortMax 适配器（www.shorttv.live，Nuxt 3 SSR，v1.6.9）——一个适配器覆盖同域名
   * 两个入口（source 都是 shortmax，弹窗同一分类，**入口分派只按 location.pathname**）。
   * 站点键取品牌名 shortmax（站点 og:site_name 与用户标签都是 ShortMax），host 是 shorttv.live。
   *
   * **两个入口都经 fetchServerHtml 重取服务端 HTML 解析，不读实时 DOM**，理由是首页板块
   * hydrate 后变成按视口裁剪的轮播：799px 视口下 Most Popular 只剩 5 张卡，而 SSR HTML 里
   * 恒为 8 张（两次实测一致）。__NUXT_DATA__ 里的 data 是加密 blob、pinia 是开发假数据，
   * 载荷这条路走不通。
   *
   * 首页（?list=<板块名归一化>，缺省 most_popular）：列表**无简介、无 genres**，两者只有
   * 详情页 /drama/<slug>-<id> 有 → genresFromDetail，且**详情失败一律跳过该卡**（理由与
   * AppleTV 逐字相同：简介只有详情页这一个来源，而存量回填只补 genres 不补简介，
   * 一旦存下无简介的卡就永远自愈不了）。
   *
   * /fandom：12 篇文章，列表项无主站 id，先用 smf-+slug 临时键（sm 后必是数字，带连字符的
   * smf- 不会与之歧义）；文章页里有回主站的绝对链接 /episode/<slug>-<id>-1，据此改写为
   * sm+id 并与首页条目全局去重（先到先得、不追加标签）。映射不到的不入库，由 scrapePage
   * 的未映射闸门跳过、下轮重试。
   *
   * 页面恒英文（Accept-Language: zh-CN 不改变输出），无平台中文，status 全走 new。
   */
  const shortmaxAdapter = {
    matches(url) {
      try {
        const u = new URL(url);
        return u.hostname.endsWith('shorttv.live') && (u.pathname === '/' || /^\/fandom\/?$/.test(u.pathname));
      } catch (e) {
        return false;
      }
    },
    async getListItems() {
      return isShortmaxFandom() ? await getShortmaxFandomItems() : await getShortmaxHomeItems();
    },
    extractId(item) {
      if (isShortmaxFandom()) {
        // 文章 slug 作临时键，详情里找到回主站链接后改写为 sm+id
        const slug = item && item.slug ? String(item.slug).trim() : '';
        return slug ? `smf-${slug}` : null;
      }
      const id = item && item.id ? String(item.id) : '';
      return /^\d{3,}$/.test(id) ? `sm${id}` : null;
    },
    extractBasic(item, tags, id, index) {
      return isShortmaxFandom()
        ? extractShortmaxFandomFromItem(item, index, tags, id)
        : extractShortmaxHomeFromItem(item, index, tags, id);
    },
    genresFromDetail: true,    // 首页与 fandom 的 genres 权威源都在主站 /drama/ 详情页
    async fetchDetail(drama) {
      return isShortmaxFandom() ? await fetchShortmaxFandomDetail(drama) : await fetchShortmaxDetail(drama);
    }
  };

  /**
   * DramaBox 适配器（v1.6.11）——**一个适配器覆盖两个域名**（source 都是 dramabox，
   * 弹窗同一分类）：dramabox.com 与 dramaboxdb.com 是同一套 Next.js Pages Router 代码的
   * 两次构建（buildId dramabox_prod_* / dramaboxdb_prod_*），共用封面 CDN
   * （thwztchapter.dramaboxdb.com）与同一套 bookId，favicon 逐字节相同。
   *
   * **但两站的板块内容各自独立编排**（section id 1264-1266 / 1272-1274）：四个目标板块
   * 72 个位置实测只 62 部不重复（仅 10 处重叠，dramaboxdb 的 Must-sees 恰是 dramabox 的
   * Trending、顺序颠倒），所以两站都要抓，重叠部分靠全局去重键先到先得。
   *
   * **订阅的是板块列表页而不是首页**（首页 SSR 每板块只直出 6 条，列表页 18 条），
   * 而**两站路由名不同**——dramabox 是 /more/<position>、dramaboxdb 是 /channel/<position>，
   * 交叉使用一律 404。故 matches 按 hostname 分派路由名（同 ReelShort/ShortMax 按 pathname
   * 分派入口的范式）。刻意不写死 must-sees|trending：日后加 hidden-gems 只改规则目录、零代码。
   *
   * 取数点是 script#__NEXT_DATA__ 的 props.pageProps.moreData.items（两站两种路由**同一个键**），
   * 真机实测 hydrate 后该 script 仍在 DOM 里，故直接读 DOM、不必同源重取（GoodShort/ShortMax
   * 那条自删脚本、视口裁剪的路不适用）；客户端翻页也不会重写 __NEXT_DATA__，读到的恒为
   * 第 1 页——正合「板块分页只抓第一页」。
   *
   * 条目字段齐全**零详情请求**：introduction 与详情页 bookInfo.introduction 逐字相同
   * （两站各抽样实测），tags/typeTwoNames 同样一致，故不标 genresFromDetail。
   * 页面恒英文（Accept-Language: zh-CN 不改变输出，locale 仍 en），无平台中文，
   * status 全走 new 交 AI 翻译。
   */
  const dramaboxAdapter = {
    matches(url) {
      try {
        const u = new URL(url);
        // 路由名按域名分派，交叉形态（/channel/ @ dramabox.com）站点自己就是 404
        if (u.hostname.endsWith('dramaboxdb.com')) return /^\/channel\/[^/]+\/?$/.test(u.pathname);
        if (u.hostname.endsWith('dramabox.com')) return /^\/more\/[^/]+\/?$/.test(u.pathname);
        return false;
      } catch (e) {
        return false;
      }
    },
    async getListItems() {
      return getDramaboxItems();
    },
    extractId(item) {
      // bookId 是两站共用的全站规范 id（实测恒 11 位数字），加 db 前缀与全局去重键约定一致
      const id = item && item.bookId != null ? String(item.bookId).trim() : '';
      return /^\d{9,13}$/.test(id) ? `db${id}` : null;
    },
    extractBasic(item, tags, id, index) {
      return extractDramaboxFromItem(item, index, tags, id);
    },
    async fetchDetail(drama) {
      // 列表 introduction 即详情页同一份文本（逐字实测），无需二次请求
      return drama;
    }
  };

  /**
   * PinesDramas 适配器（pinedrama.com 的首页与 /novels 页，v1.6.12）：一个适配器覆盖
   * 两个订阅页、四个板块、两类内容（小说与短剧），**入口分派只按 location.pathname**。
   *
   * 站点是 Next.js **App Router**，RSC flight 里是渲染后的 JSX 元素树而不是干净数据载荷
   * （NetShort 那条 parseFlightArray 的路不适用）；四个板块 SSR 直出、hydrate 后 DOM 仍在、
   * **与视口无关**（375px 下条目数与桌面一致），故直接读实时 DOM（DramaBox 范式），
   * 既不必同源重取也不必走后台代理。板块内容不随访问轮换（两页各连抓三次逐次一致）。
   *
   * 板块靠 ?list=<归一化标题> 选（NetShort/FlickReels 同款约定，共用 normalizeSectionName）：
   * recommended_webnovels_for_you / popular_short_dramas 在 /novels，
   * popular_novels / editor_s_pick 在首页；加板块＝只改规则目录、零代码。
   *
   * **列表卡片简介覆盖不全**：Popular Novels 与 Popular Short Dramas 的卡上压根没有简介，
   * 另两个板块的短 blurb 与详情页 Summary 又是两段不同文案（blurb ≈260 字符 SEO 短句，
   * Summary ≈460~700 字符完整梗概），详情页还多给 2~4 个标签（列表只 1 个）→
   * 22 条一律取详情、标 genresFromDetail，详情失败跳过该卡（2026-09-18 用户定）。
   *
   * 站点**无任何数字 id**，slug 即规范 id；/novels/<slug> 与 /dramas/<slug> 是两套独立
   * 命名空间（交叉访问 404），故去重键在站点前缀 pd 之后再带一位类型字母：pdn / pdd。
   * 订阅 URL 须写**裸域**（www.pinedrama.com 301 到裸域，同 Shortical、与 FlickReels 相反）。
   * 页面恒英文（Accept-Language: zh-CN 不改变输出），无平台中文，status 全走 new。
   */
  const pinedramaAdapter = {
    matches(url) {
      try {
        const u = new URL(url);
        return u.hostname.endsWith('pinedrama.com')
          && (u.pathname === '/' || /^\/novels\/?$/.test(u.pathname));
      } catch (e) {
        return false;
      }
    },
    async getListItems() {
      return getPinedramaItems();
    },
    extractId(item) {
      // 站点无数字 id，slug 即规范 id；kind 决定前缀，两套命名空间互不撞键
      const slug = item && item.slug ? String(item.slug).trim() : '';
      if (!PINEDRAMA_SLUG.test(slug)) return null;
      return `${item.kind === 'drama' ? 'pdd' : 'pdn'}${slug}`;
    },
    extractBasic(item, tags, id, index) {
      return extractPinedramaFromItem(item, index, tags, id);
    },
    genresFromDetail: true,    // 官方多值标签的权威源在详情页（列表只印第一个）
    async fetchDetail(drama) {
      return await fetchPinedramaDetail(drama);
    }
  };

  /**
   * Netflix Tudum Top 10 适配器（www.netflix.com/tudum/top10 及其子榜单页，v1.5.8）：
   * 榜单数据 SSR 直出在内联脚本 `netflix.reactContext.models.graphql = JSON.parse('…')`
   * （Apollo 归一化缓存），DOM 上标题是 logo 图、无 /title/ 链接、无简介，页面全局
   * window.netflix 在内容脚本隔离世界读不到 → 读 <script> 文本解析（NetShort 同范式）。
   * 字面量是 JS 单引号字符串（内含裸 "，转义有 \\ \' \uXXXX \xHH），须先反转义再
   * JSON.parse。每个榜单页是独立 URL（无 ?list= 约定），节 guid 'top-10-card-list'
   * 引用 10 个 PulseTop10ItemEntity（'top-10-table' 为同数据副本，作回退）。
   * 条目字段齐全（top10.videoId / top10Video.title+shortSynopsis / artwork.storyArt）；
   * 榜单无类型字段，genres 经后台代理请求 /title/<videoId> 页补采（v1.5.9，见
   * fetchNetflixDetail）。去重键 nf+videoId，全球榜与美国榜重叠作品按全局先到先得、
   * 每周名次/观看量不入库（2026-09-11 用户定）。页面恒英文（localizedPaths 仅
   * en-us/pt-br），无平台中文，status 走 new 交 AI 翻译。
   */
  const netflixAdapter = {
    matches(url) {
      try {
        const u = new URL(url);
        return u.hostname.endsWith('netflix.com') && /^\/tudum\/top10(\/|$)/.test(u.pathname);
      } catch (e) {
        return false;
      }
    },
    async getListItems() {
      return getNetflixTop10Items();
    },
    extractId(item) {
      // videoId 是 Netflix 全站规范数字 id（/title/<id> 页所用），加 nf 前缀与全局去重键约定一致
      const id = item && item.top10 && item.top10.videoId != null ? String(item.top10.videoId) : '';
      return /^\d{5,}$/.test(id) ? `nf${id}` : null;
    },
    extractBasic(item, tags, id, index) {
      return extractNetflixFromItem(item, index, tags, id);
    },
    genresFromDetail: true,    // genres 权威源在 /title/ 详情页（回填路径需请求详情）
    async fetchDetail(drama) {
      // 标题/简介/封面以榜单为准，详情只为补 genres；失败保留榜单数据
      return await fetchNetflixDetail(drama);
    }
  };

  /**
   * Apple TV Top 10 适配器（tv.apple.com 的剧集榜 / 电影榜两个 collection 页，v1.5.10）：
   * 数据 SSR 直出在 `<script type="application/json" id="serialized-server-data">`——
   * 纯 JSON，无需像 Netflix 那样先反转义 JS 字符串字面量。
   *
   * 榜单与详情**都经后台代理取 HTML**，不读实时 DOM——两条硬理由：
   *   1) 页面 hydrate 后会把该 script 从 DOM 里删掉（真机实测 ssdInDom=false），
   *      而后台抓取是「等 tab complete + 1.5s 再发 scrape」，那时早已读不到；
   *   2) 代理路径无 cookie（Apple TV+ 订阅用户在标签页里是登录态）且强制英文请求头，取数确定。
   *
   * 榜单条目（OrdinalChartLockup）字段齐全但**无简介**：id(umc.cmc.…) / title / type /
   * caption（单个类型词）/ ordinal（名次，不入库，对齐 Netflix 裁定）/ artwork.template /
   * contextAction.url（详情页，带 ?ctx_agid= 需剥）。简介与官方多值 genres 只有详情页
   * `About` 节的 AboutReviewCard 有 → genresFromDetail，且详情失败**跳过该卡**（见 fetchAppleDetail）。
   * 页面恒英文（Accept-Language: zh-CN 不改变输出），无平台中文，status 全走 new 交 AI 翻译。
   */
  const appletvAdapter = {
    matches(url) {
      try {
        const u = new URL(url);
        return u.hostname === 'tv.apple.com'
          && /^\/us\/collection\/[^/]+\/uts\.col\.Charts(Shows|Movies)\.tvs\.sbd\.\d+$/.test(u.pathname);
      } catch (e) {
        return false;
      }
    },
    async getListItems() {
      return await fetchAppleListItems(window.location.href);
    },
    extractId(item) {
      // umc.cmc.<字母数字> 是 Apple 全站规范 id（/show|movie/ 页所用），加 at 前缀与全局去重键约定一致
      const id = item && typeof item.id === 'string' ? item.id.trim() : '';
      return /^umc\.cmc\.[a-z0-9]+$/.test(id) ? `at${id}` : null;
    },
    extractBasic(item, tags, id, index) {
      return extractAppleFromItem(item, index, tags, id);
    },
    genresFromDetail: true,    // 官方多值 genres 权威源在详情页 About 节
    async fetchDetail(drama) {
      return await fetchAppleDetail(drama);
    }
  };

  /**
   * Higgsfield 适配器（higgsfield.ai/community/originals，v1.7.2）：Higgsfield Studio 自制的 AI 原创影视
   * （短片、多集剧、长片）。页上三个板块 Higgsfield Choice / First Look / On Our Radar 合起来正好是
   * 全部已上线作品（On Our Radar 本就是剩余项），目录只订**整页**这一条、不带 ?list=（2026-09-27 用户定：
   * 三个板块标签相同，拆开订没有区分意义，每轮还要多开两个标签页）。要单订某个板块时用
   * ?list=higgsfield_choice / first_look / on_our_radar，切分规则见 HIGGSFIELD_SECTIONS。
   *
   * 站点是 TanStack Start SPA，板块是横向**虚拟列表**（16 部的板块 DOM 里只渲染 4~8 张，
   * 随横向滚动增删）→ 不读 DOM，直接调页面自己用的那个接口（一次回全部作品，再按板块规则筛）。
   * 接口匿名可用，CORS 只放行 https://higgsfield.ai 这一个来源——内容脚本的跨域请求按页面来源
   * 走 CORS，正好命中，故直连（同 Shortical 调官方接口），不必加后台代理规则。
   * 连抓三次条目集合与顺序完全一致，不随访问轮换。
   *
   * 列表字段齐全（标题 / 简介 / 海报 / 分集），零详情请求。接口没有内容类型字段（tags 恒空，
   * categories 只是板块名），genres 留空。站点无平台中文，status 全走 new 交 AI 翻译。
   * 订阅 URL 须写**裸域**（www.higgsfield.ai 301 到裸域，同 Shortical / PinesDramas）。
   */
  const higgsfieldAdapter = {
    matches(url) {
      try {
        const u = new URL(url);
        return u.hostname === 'higgsfield.ai' && /^\/community\/originals\/?$/.test(u.pathname);
      } catch (e) {
        return false;
      }
    },
    async getListItems() {
      return await getHiggsfieldItems();
    },
    extractId(item) {
      // 站点规范 id 是 UUID（slug 实测会带尾空格，不宜当键），加 hf 前缀与全局去重键约定一致
      const id = item && typeof item.id === 'string' ? item.id.trim().toLowerCase() : '';
      return HIGGSFIELD_UUID.test(id) ? `hf${id}` : null;
    },
    extractBasic(item, tags, id, index) {
      return extractHiggsfieldFromItem(item, index, tags, id);
    },
    async fetchDetail(drama) {
      // 接口条目已是全量字段（简介取 full_description），无需二次请求
      return drama;
    }
  };

  // 站点适配器注册表。
  const ADAPTERS = { imdb: imdbAdapter, steam: steamAdapter, royalroad: royalroadAdapter, mydrama: mydramaAdapter, reelshort: reelshortAdapter, dramashorts: dramashortsAdapter, netshort: netshortAdapter, flickreels: flickreelsAdapter, goodshort: goodshortAdapter, shortical: shorticalAdapter, shortmax: shortmaxAdapter, dramabox: dramaboxAdapter, pinedrama: pinedramaAdapter, netflix: netflixAdapter, appletv: appletvAdapter, higgsfield: higgsfieldAdapter };

  /**
   * 添加抓取按钮。样式只在 content.css 一处（manifest 随 content.js 一起注入）：
   * 以前这里的 cssText 把样式表逐项抄了一遍，mouseenter/mouseleave 再用内联 transform
   * 模拟 :hover——内联优先级高于样式表，:active 的按下缩放、:disabled 的「不缩放 /
   * not-allowed 光标」、:hover 的加深阴影全被压住（审查 button-style-duplicated-dead-css）。
   * 后台 executeScript 兜底注入不带 CSS，但那条路径只出现在后台抓取标签页里，没人看按钮。
   * 文案都是纯文本，用 textContent。
   */
  function addScrapeButton() {
    if (document.getElementById('dramamo-scrape-btn')) return;

    const IDLE_LABEL = '🎬 抓取到 ShortScraping';
    const btn = document.createElement('button');
    btn.id = 'dramamo-scrape-btn';
    btn.textContent = IDLE_LABEL;

    // 结果文案停 2 秒再复原可点
    const resetLater = () => setTimeout(() => {
      btn.textContent = IDLE_LABEL;
      btn.disabled = false;
    }, 2000);

    btn.addEventListener('click', async () => {
      btn.textContent = '⏳ 抓取中...';
      btn.disabled = true;

      try {
        const { subscribed, dramas, listCount } = await runScrape();
        // dramas 就是本轮实际入库的新卡；再按 status 过滤会把平台自带
        // 中文（Steam/MyDrama 直接 trans）的新卡漏计，与后台通知/弹窗 toast 口径不一致。
        // 当前页不在订阅里、或页面上一条列表都没找到（站点改版 / 没加载完整）时明说，
        // 不再显示一个误导的「新增 0 部」
        if (!subscribed) btn.textContent = '⚠️ 当前页不在订阅中';
        else if (listCount === 0) btn.textContent = '⚠️ 页面上没找到列表';
        else btn.textContent = `✅ 新增 ${dramas.length} 部`;
      } catch (e) {
        console.error('[ShortScraping] 抓取失败:', e);
        btn.textContent = '❌ 抓取失败';
      }
      resetLater();
    });

    document.body.appendChild(btn);
  }

  // 本轮抓取的存量快照（itemId → 库中是否已有 genres），scrapePage 开轮时换成后台给的
  // 那份、本轮新存的卡也记进来；fandom 详情路径用它判断「库中已有 genres」以跳过
  // 主站 / 代理请求（adapter.fetchDetail 签名不带上下文，走模块级快照传递）。
  // 一次只跑一轮（runScrape），不会被并发轮整个换掉
  let existingDramaSnapshot = new Map();

  const hasGenreTags = drama => Array.isArray(drama.genres) && drama.genres.length > 0;

  /**
   * 抓取上下文向后台要（审查 storage-secrets-exposed-to-content / full-table-read-per-scrape）：
   * 订阅配置 + 库中已有条目的精简列表 [[itemId, 是否已有 genres], ...]，由后台从 dramas 缓存
   * 算出。内容脚本跑在第三方站点的渲染进程里，**不再读写扩展的 storage**——那里同时放着
   * AI Key、飞书 AppSecret 与 webhook，直连 storage 还能绕过后台 onMessage 的发送方闸门；
   * 以前每个抓取标签页开轮还要把整张 dramas（含全部简介与译文）跨进程反序列化一遍，
   * 却只用到 itemId 和「有没有 genres」。后台没应答或应答失败即本轮失败（抛出，由调用方收口）。
   */
  async function requestScrapeContext() {
    const response = await chrome.runtime.sendMessage({ action: 'getScrapeContext' });
    if (!response?.success) {
      throw new Error(response?.error || '后台未返回抓取上下文');
    }
    const known = new Map();
    for (const entry of Array.isArray(response.known) ? response.known : []) {
      if (Array.isArray(entry) && entry[0]) known.set(String(entry[0]), entry[1] === true);
    }
    return { urlTags: Array.isArray(response.urlTags) ? response.urlTags : [], known };
  }

  /**
   * 存量条目 genres 回填（v1.5.3）：去重命中的在榜条目若库中还没有类型标签，
   * 用与新条目完全相同的提取路径补一份，经 saveDrama 消息在后台队列内只合并
   * genres 一个键（其余字段一律不动，见 background saveDramaRecord）。
   * 成本闸门：库中已有 genres（hasGenres 为 true）→ 零成本返回；列表提取失败 → 返回；适配器标
   * genresFromDetail（genres 权威源在详情页）才发详情请求（带与新条目同款
   * 200ms 节流，并传 { genresOnly: true }：后台只合并 genres，Steam 据此省掉中文档那次请求）；
   * 最终仍为空 → 不发消息（站点确无标签的条目零消息、下轮重试）。
   * 详情失败时与新条目路径同语义：有列表级兜底值（如 ReelShort theme）就用，
   * 彻底为空则本轮放弃、不落任何标记，下轮抓取自动重试，自愈。
   */
  async function maybeBackfillGenres(adapter, item, tags, id, index, hasGenres) {
    try {
      if (hasGenres !== false) return;

      const drama = adapter.extractBasic(item, tags, id, index);
      if (!drama) return;

      if (adapter.genresFromDetail) {
        await adapter.fetchDetail(drama, { genresOnly: true });
        await new Promise(r => setTimeout(r, 200));
      }

      if (hasGenreTags(drama)) {
        await saveSingleDrama(drama);
        console.log(`[ShortScraping] ♻️ 已回填类型标签: ${drama.title}（${drama.genres.join(', ')}）`);
      }
    } catch (e) {
      console.warn(`[ShortScraping] 类型标签回填失败（下轮重试）: ${id}`, e.message);
    }
  }

  /**
   * 抓取当前页面 - 站点无关骨架，逐条保存。返回 { subscribed, dramas, listCount }：dramas 是本轮
   * 实际入库的新卡（'scrape' 消息只回它的条数）；subscribed 为 false 表示当前页不在订阅里；
   * listCount 是页面上找到的列表项数（不在订阅里时为 null）——为 0 多半是站点改版或页面没加载完整，
   * 后台据此记「抓到 0 条」告警、按钮据此提示，而不是一律显示「新增 0 部」（审查 M2，v1.7.0）。
   */
  async function scrapePage() {
    console.log('[ShortScraping] 开始抓取页面...');

    const { urlTags, known } = await requestScrapeContext();

    const currentUrl = window.location.href;
    const subscription = findSubscriptionForUrl(currentUrl, urlTags);
    if (!subscription) {
      console.log('[ShortScraping] 当前页面不在用户订阅配置中，跳过保存');
      return { subscribed: false, dramas: [], listCount: null };
    }
    const tags = subscription.tags;

    const site = detectSite(window.location.hostname);
    const adapter = site ? ADAPTERS[site] : null;
    if (!adapter || !adapter.matches(currentUrl)) {
      // 订阅了这页、适配器却认不出它是列表页（订阅 URL 手写错路径）：按「页面上没找到列表」报给后台
      console.log('[ShortScraping] 当前站点无对应适配器，跳过');
      return { subscribed: true, dramas: [], listCount: 0 };
    }
    console.log(`[ShortScraping] 站点=${site}，标签: ${tags.join(', ')}`);

    // 去重键统一用 itemId 字段（各站前缀见对应适配器的 extractId）；known 是后台给的
    // itemId → 是否已有 genres，本轮新存的卡也记进去（同批后到的重复条目照样命中）
    existingDramaSnapshot = known;
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
        if (known.has(id)) {
          console.log(`[ShortScraping] 跳过已存在: ${id}`);
          // 在榜存量条目缺类型标签时顺路回填（v1.5.3），照旧不入新卡
          await maybeBackfillGenres(adapter, item, tags, id, index, known.get(id));
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

        // fandom 条目映射不到主站（itemId 仍为 mdf-/rsf-/smf- 临时键，前缀表见 scrape-rules.js）
        // ＝给不了播放页，不入库；未保存条目下轮抓取自动重试，文章补了回链即可正常入库
        if (isUnmappedFandomKey(detailed.itemId)) {
          console.log(`[ShortScraping] fandom 未映射条目跳过入库: ${detailed.title}`);
          continue;
        }

        // fandom 条目进循环时还是临时键，映射回主站后才知道真实去重键：命中存量（或本轮已存的）
        // 就不是新卡（审查 fandom-refetch-every-run）。库里缺 genres 而这次拿到了，才提交一次
        // 让后台只合并 genres（同 maybeBackfillGenres）；其余零消息。以前照发 saveDrama 靠后台
        // 拒收——详情路径对存量短路返回的对象（ShortMax 那份没有简介）碰上存量恰好被删，
        // 就会被当新卡存下
        if (known.has(detailed.itemId)) {
          if (known.get(detailed.itemId) === false && hasGenreTags(detailed)) {
            await saveSingleDrama(detailed);
            known.set(detailed.itemId, true);
            console.log(`[ShortScraping] ♻️ 已回填类型标签: ${detailed.title}（${detailed.genres.join(', ')}）`);
          } else {
            console.log(`[ShortScraping] 映射后命中存量，跳过: ${detailed.itemId}`);
          }
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        const saved = await saveSingleDrama(detailed);
        if (!saved) {
          console.log(`[ShortScraping] 跳过重复内容: ${detailed.title}`);
          // 详情请求照样发过了，节流同样要有：连着几条重复时不能连发
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        // 本轮刚存的卡一律记「已有 genres」：同轮后到的重复条目只需去重，不再走回填——详情刚请求
        // 过，同一轮再请求一次拿到的还是这份（与改走消息之前「本轮新卡不进存量快照、不回填」同口径）；
        // 真缺 genres 的，下一轮后台给的 known 里是 false，照常回填
        known.set(detailed.itemId, true);
        allNewDramas.push(detailed);
        console.log(`[ShortScraping] ✅ 已保存: ${detailed.title} (${index + 1}/${listItems.length})`);

        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.error(`[ShortScraping] 第 ${index} 项处理失败:`, e);
      }
    }

    console.log(`[ShortScraping] 抓取完成，新增 ${allNewDramas.length} 部`);
    return { subscribed: true, dramas: allNewDramas, listCount: listItems.length };
  }

  /**
   * 根据当前页面 URL 找到命中的订阅项，返回 { urlPattern, tags }；无匹配返回 null。
   * urlPattern 会被写进卡片的 sourceListUrl（归属 canonical 化），使弹窗/后台/CSV
   * 的精确等值过滤天然成立。
   * 判定本身在 src/shared/url-match.js 的 matchSubscription（精确轮 + 收紧的前缀轮，两轮都
   * 尾斜杠归一），与弹窗 / 后台 / 同步服务的归属过滤共用同一个 url-match.js。
   */
  function findSubscriptionForUrl(url, urlTags) {
    console.log('[ShortScraping] 查找订阅，URL:', url);
    console.log('[ShortScraping] 标签配置:', JSON.stringify(urlTags));

    if (!Array.isArray(urlTags) || urlTags.length === 0) {
      console.log('[ShortScraping] 标签配置为空，跳过当前页面');
      return null;
    }

    const config = UrlMatch.matchSubscription(url, urlTags);
    if (!config) {
      console.log('[ShortScraping] 无匹配订阅配置，跳过当前页面');
      return null;
    }
    console.log(`[ShortScraping] ✓ 命中订阅 ${config.urlPattern}，标签: ${config.tags.join(', ')}`);
    return { urlPattern: config.urlPattern, tags: config.tags.slice(0, 3) }; // 最多3个标签
  }

  /**
   * 卡片骨架（各适配器 extractBasic 共用）：统一填 id / 翻译字段 / 状态 / 时间戳这些约定默认值，
   * 适配器只传本站解析出的字段。以前 18 个 extract* 各手写一份 15 个字段的字面量，改一处约定
   * （加字段、改 status 初值）要同步改 18 处，漏一处就静默产出形状不同的卡
   * （审查 skeleton-literal-18x-dead-sourcelisturl）。
   *
   * fields 里给了就原样用（含空串 / 空数组），没给（undefined）才落默认值；键序与收拢前逐字一致。
   * descriptionZh 恒从空串起步（MyDrama 平台中文简介由 applyMyDramaDescription 事后归位）。
   * sourceListUrl 先填当前页地址：新卡入库前 scrapePage 会改写成命中的订阅 URL；去重命中的
   * genres 回填提交（maybeBackfillGenres）不改写——后台只合并 genres，但若该卡恰在回填前被删，
   * 后台会把这次提交当新卡存下，那时用的就是这个值，所以不是死字段，保留。
   */
  function createDramaCard(source, itemId, index, tags, fields) {
    const { title, titleZh = '', poster = '', genres = [], description = '', url } = fields;
    return {
      id: `${source}_${itemId}_${index}`,
      itemId,
      title,
      titleZh,
      poster,
      tags,
      genres,
      description,
      descriptionZh: '',
      source,
      sourceListUrl: window.location.href,
      status: 'new',
      url,
      scrapedAt: new Date().toISOString(),
      translatedAt: null
    };
  }

  /**
   * 从列表项提取
   */
  function extractFromListItem(item, index, tags = ['IMDB'], itemId = '') {
    const resolvedItemId = itemId || extractImdbIdFromListItem(item);
    if (!resolvedItemId) return null;

    const links = item.querySelectorAll('a[href*="/title/tt"]');

    const url = `https://www.imdb.com/title/${resolvedItemId}/`;
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
      console.warn(`[ShortScraping] 第 ${index + 1} 项标题解析失败（${resolvedItemId}），跳过`);
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

    // genres 由详情页 JSON-LD genre 补充
    return createDramaCard('imdb', resolvedItemId, index, tags, { title, poster, url });
  }

  /**
   * 由 appId 构造 Steam drama 骨架；title/poster/简介等由 fetchSteamDetail 接口填充。
   */
  function buildSteamDramaSkeleton(appId, index, tags) {
    if (!appId) return null;
    // title 先拿 appId 占位；title / poster / genres / 简介都由 fetchSteamDetail 用 appdetails 覆盖
    return createDramaCard('steam', appId, index, tags, {
      title: appId,
      url: `https://store.steampowered.com/app/${appId}/`
    });
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

    return createDramaCard('royalroad', rrId, index, tags, {
      title,
      poster,
      genres: cleanGenres(Array.from(item.querySelectorAll('a.fiction-tag')).map(a => a.textContent)),
      description,
      url
    });
  }

  /**
   * RoyalRoad 详情页补完整简介；任何失败都保留列表页数据。
   */
  async function fetchRoyalRoadDetail(drama) {
    if (!drama.url) return drama;

    try {
      const doc = await fetchServerDocument(drama.url);
      if (!doc) return drama;

      // 完整简介：非空才覆盖列表页版本
      const fullDesc = extractParagraphText(
        doc.querySelector('.description .hidden-content') || doc.querySelector('.description')
      );
      if (fullDesc) drama.description = fullDesc;

      console.log(`[ShortScraping] RoyalRoad 详情: ${drama.title} | 简介: ${fullDesc ? '已补全' : '沿用列表页'}`);
    } catch (e) {
      console.warn(`[ShortScraping] RoyalRoad 详情获取失败: ${drama.title}`, e.message);
    }

    return drama;
  }

  /**
   * 等 My Drama 首页 hydrate 完成再取「最流行」条目：SSR 只直出首屏几条，
   * 轮询到条目数非 0 且连续两次不再变化即认为轮播已填满，最长约 8 秒（pollUntilStable）。
   */
  async function waitForMyDramaItems(sectionId) {
    const query = () => Array.from(
      // 锚点 id 来自订阅 URL：数字开头的（如 ?list=7days）直拼成 #7days 是非法选择器，
      // querySelectorAll 会抛 SyntaxError 让整页抓取失败，须转义
      document.querySelectorAll(`#${CSS.escape(sectionId)} [data-testid="series-section-item"]`)
    );
    return pollUntilStable(query, items => items.length);
  }

  /**
   * 主站订阅 URL 用约定参数 ?list=<板块锚点id> 选板块（同 fandom ?list=trending
   * 范式）；无参数默认「最流行」，参数值归一后为空返回 null（调用方跳过本页，见
   * readListParam）。锚点 id 语言无关，新板块无需改代码，订阅 URL 带上对应锚点即可
   * （如 ?list=best_choices）。
   */
  function getMyDramaSectionId() {
    return readListParam('most_trending');
  }

  /**
   * 简介按语言归位：平台本地化的中文简介直接当译文用，英文简介走原文字段；
   * 空文本不动原值。
   */
  function applyMyDramaDescription(drama, text) {
    if (!text) return;
    // 与标题同一个中文判据（含扩展 A 区），同一段文本不会在标题和简介上判成两种语言
    if (TranslateConfig.hasChineseChars(text)) {
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
   * My Drama 主站去重键 md+UUID → 规范播放页 https://my-drama.com/video/<UUID>（无 query、无尾斜杠）。
   * 与 fetchFandomDetail 映射出的地址、后台代理白名单（background DETAIL_HTML_PROXY_RULES）
   * 同一形态；不是 md+UUID（如 fandom 文章的 mdf- 临时键）返回 null。
   */
  function myDramaVideoUrl(itemId) {
    const match = String(itemId || '').match(/^md([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
    return match ? `https://my-drama.com/video/${match[1]}` : null;
  }

  /**
   * 从 My Drama「最流行」轮播条目提取基础信息。
   * 列表 h3 标题会随界面语言本地化，英文原名优先从封面 URL 还原、h3 兜底；
   * h3 为平台自带中文名时直接存 titleZh。悬停层简介覆盖率低，主要靠详情页补。
   * url 由去重键推出规范播放页，不读条目的 href：extractId 兼容「条目本身不是锚点、链接在
   * 子 a 上」的写法，这里以前却只读 item 自己的 href——取不到时 new URL('', origin) 不抛错、
   * 得到首页，整个板块会以首页链接加首页文案入库（审查 mydrama-href-null-homepage-url）。
   */
  function extractMyDramaFromListItem(item, index, tags, mdId) {
    const url = myDramaVideoUrl(mdId);
    if (!url) {
      console.warn(`[ShortScraping] My Drama 第 ${index + 1} 项去重键不是 md+UUID（${mdId}），跳过`);
      return null;
    }

    // 部分板块（如「最佳选择」）条目的第一个 <img> 是板块共用背景图占位，
    // 真封面是后面的 /convert/ 竖版海报——优先取它，取不到再退回第一个 img
    const img = item.querySelector('img[src*="/convert/"]') || item.querySelector('img');
    const poster = img ? (img.currentSrc || img.src || '') : '';

    const h3 = item.querySelector('h3');
    const listTitle = h3 ? h3.textContent.trim() : '';
    const title = extractMyDramaEnglishTitle(poster) || listTitle;
    const titleZh = (listTitle && listTitle !== title && TranslateConfig.hasChineseChars(listTitle)) ? listTitle : '';

    // 悬停层唯一的 <p> 是简介；不用 extractParagraphText，它在 p 为空时会兜底返回整卡文本
    const descP = item.querySelector('p');
    const hoverDesc = descP ? descP.textContent.trim() : '';

    // 列表无类型字段，genres 由详情页 JSON-LD 补采（fetchMyDramaDetail）
    const drama = createDramaCard('mydrama', mdId, index, tags, { title: title || mdId, titleZh, poster, url });
    applyMyDramaDescription(drama, hoverDesc);
    return drama;
  }

  /**
   * 经后台代理取主站播放页 HTML（v1.5.5）：fandom 子域上的 content script 直连
   * my-drama.com 被页面 CORS 拦（/video/ 响应无 ACAO 头，2026-08-09 实测），
   * SW fetch 对已授权主机免页面 CORS。任何失败返回 null，调用方按「详情失败
   * 保留列表页数据」既有语义处理。
   */
  async function fetchDetailHtmlViaBackground(url) {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'fetchDetailHtml', url });
      return (response && response.success && typeof response.html === 'string') ? response.html : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * My Drama 详情页（播放页）补简介＋类型标签：正文由 RSC 客户端渲染、fetch 拿不到，
   * 但 og:description / meta description 与 SEO 用 JSON-LD 静态直出——简介按
   * 「{标题} - 集数 N - 在 My Drama 流媒体平台观看. {简介正文}」剥模板前缀取正文；
   * genres 取 JSON-LD @graph 内 VideoObject.genre（英文原值、与浏览器语言无关，
   * 页面上渲染的中文标签是前端 i18n 译文）。平台自带中英文齐全时直接标记已翻译
   * （对齐 Steam 官方中文范式）；任何失败都保留列表页数据。
   * v1.7.4 起 My Drama 的请求固定英文（SiteRegistry.FORCE_ENGLISH_DOMAINS）：英文页的 og:description
   * 是不带模板前缀的纯正文，中文名与简介改由 AI 翻译补；上面按语言分流的写法保留，遇到中文页照样能用。
   */
  async function fetchMyDramaDetail(drama) {
    if (!drama.url) return drama;

    try {
      // fandom 子域上处理主站条目（Most Trending 菜单直链、去重回填）时直连被
      // 页面 CORS 拦，跨源改经后台代理取 HTML；同源保持直连（v1.5.5）
      const html = new URL(drama.url, window.location.href).origin === window.location.origin
        ? await fetchServerHtml(drama.url)
        : await fetchDetailHtmlViaBackground(drama.url);
      if (html === null) return drama;
      const doc = parseHtmlDocument(html);
      if (!doc) return drama;

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
          if (!drama.titleZh && TranslateConfig.hasChineseChars(drama.title)) drama.titleZh = drama.title;
          drama.title = english;
        }
      }

      // 内容类型标签：SSR 直出的 JSON-LD（@graph 内 VideoObject.genre 英文原值，
      // 与浏览器语言无关）；为空保留列表页占位空数组
      const genres = extractJsonLdGenres(doc);
      if (genres.length) drama.genres = genres;

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
   * 无参数 → 首页文章流；其它 ?list= 值 → 空数组。按参数值精确比对：以前的正则
   * /[?&]list=trending/ 连 ?list=trending_now 也会命中，别的值又悄悄退回文章流。
   */
  function getFandomListItems() {
    const list = readListParam('');
    if (list === null) return [];
    if (list && list !== 'trending') {
      console.warn(`[ShortScraping] My Drama fandom 不认识的 ?list= 板块: ${list}，本页跳过`);
      return [];
    }
    if (list === 'trending') {
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
   * Most Trending 菜单里直链主站的条目（去重键已是 md+UUID）url 写规范播放页：原样存 href 时
   * 带参数（?from=menu）或尾斜杠的链接过不了后台代理白名单，条目就没有简介和 genres 入库、
   * 此后也没有补的路径（审查 fandom-menu-url-not-canonical）。文章链接照旧存 href，由详情页映射。
   */
  function extractFandomFromListItem(item, index, tags, mdfId) {
    const link = item.querySelector('.wp-block-post-title a') || item.querySelector('a[href]');
    const title = link ? link.textContent.replace(/^[⬤●]\s*/, '').trim() : '';
    const url = myDramaVideoUrl(mdfId) || (link ? link.href : '');

    const img = item.querySelector('.wp-block-post-featured-image img');
    const poster = img ? (img.currentSrc || img.src || '') : '';

    // fandom 文章无类型数据，genres 留空；映射回主站后条目再现于主站榜单时经回填补采
    return createDramaCard('mydrama', mdfId, index, tags, { title: title || mdfId, poster, url });
  }

  /**
   * WordPress 文章页正文容器内的前 3 个长段落（MyDrama 与 ReelShort 两个 fandom 共用）：
   * 导航菜单等短文本被长度阈值排除。拼成简介前由调用方决定取不到时的兜底。
   */
  function articleLeadParagraphs(doc) {
    const content = doc.querySelector('.entry-content') || doc.querySelector('main') || doc.body;
    return Array.from(content.querySelectorAll('p'))
      .map(p => p.textContent.trim())
      .filter(t => t.length > 80)
      .slice(0, 3);
  }

  /**
   * fandom 剧目文章页（WP SSR）补数据：
   * - 页内回主站的 /video/<UUID> 链接 → 去重键改写为 md+UUID、url 换成主站播放页，
   *   与主站「最流行」条目全局去重（saveSingleDrama 按 itemId 兜底）；找不到则仍为
   *   mdf-+slug 临时键，由 scrapePage 的未映射闸门跳过入库（下轮抓取重试）
   * - h1 为权威标题；og:image 兜底封面（菜单项无图）；正文前几个长段落作简介
   *   （og:description 是 SEO 模板文案，不用）。任何失败都保留列表页数据。
   */
  async function fetchFandomDetail(drama) {
    if (!drama.url) return drama;

    try {
      const doc = await fetchServerDocument(drama.url);
      if (!doc) return drama;

      const mainLink = doc.querySelector('a[href*="my-drama.com/video/"]');
      const vid = mainLink ? (mainLink.getAttribute('href') || '').match(/\/video\/([0-9a-f-]{36})/) : null;
      if (vid) {
        drama.itemId = `md${vid[1]}`;
        drama.url = `https://my-drama.com/video/${vid[1]}`;
        // 播放页 JSON-LD 就带 genres（v1.5.5）：映射当时顺路补采——fandom 子域
        // 直连主站被页面 CORS 拦，经后台代理取 HTML 本地解析；存量已有 genres
        // 的零请求，失败保留空数组下轮自愈（语义同其它详情失败路径）
        if (existingDramaSnapshot.get(drama.itemId) !== true) {
          const detailHtml = await fetchDetailHtmlViaBackground(drama.url);
          const detailDoc = detailHtml ? parseHtmlDocument(detailHtml) : null;
          if (detailDoc) {
            const genres = extractJsonLdGenres(detailDoc);
            if (genres.length) drama.genres = genres;
          }
        }
      }

      const h1 = doc.querySelector('h1');
      const h1Text = h1 ? h1.textContent.trim() : '';
      if (h1Text) drama.title = h1Text;

      if (!drama.poster) {
        const ogImage = doc.querySelector('meta[property="og:image"]');
        drama.poster = ogImage ? (ogImage.getAttribute('content') || '').trim() : '';
      }

      const paras = articleLeadParagraphs(doc);
      if (paras.length) drama.description = paras.join('\n');

      console.log(`[ShortScraping] fandom 详情: ${drama.title} | 主站映射: ${vid ? drama.itemId : '无'} | 简介: ${drama.description ? '有' : '无'}`);
    } catch (e) {
      console.warn(`[ShortScraping] fandom 详情获取失败: ${drama.title}`, e.message);
    }

    return drama;
  }

  /**
   * 读取 Next.js Pages Router 的 SSR 数据（script#__NEXT_DATA__），列表页与详情页
   * 共用，ReelShort / DramaShorts / DramaBox 三站通用。解析失败返回 null。
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
   * 由标题构造友好 slug（ReelShort/NetShort 共用）。两站页面 URL 都只认结尾的
   * id（错误 slug 会 301 到规范地址），slug 只求可读性，不承担准确性。
   */
  function slugifyTitle(title) {
    return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /**
   * 从「TOP」板块的 book 对象提取基础信息。
   * special_desc 是截断版简介，先入库兜底，完整版由详情页覆盖。
   * url 先存 /full-episodes/ 全集页形态兜底（与 /movie/ 剧目页共用
   * slug+book_id，错 slug 同样按 book_id 301 规范化），详情成功后由
   * buildReelshortEpisodeUrl 升级为第一集播放页 /episodes/…。
   */
  function extractReelshortFromBook(book, index, tags, rsId) {
    const title = (book.book_title || '').trim();
    const slug = slugifyTitle(title) || 'x';
    return createDramaCard('reelshort', rsId, index, tags, {
      title: title || rsId,
      poster: book.book_pic || book.default_pic || '',
      genres: cleanGenres(book.theme),   // 列表 theme 兜底（通常 1 个），详情页 tag_list 覆盖
      description: (book.special_desc || '').trim(),
      url: `https://www.reelshort.com/full-episodes/${slug}-${book.book_id}`
    });
  }

  /**
   * 由 /movie/ 规范地址与详情 JSON 构造第一集播放页
   * /episodes/episode-1-<slug>-<book_id>-<chapter_id>：章节尾缀必须带（缺失或
   * 写错直接 404，slug 错则 301 规范化），无法凭 book_id 构造；chapter_id 取
   * __NEXT_DATA__ 的 start_play.chapter_id（online_base[0].chapter_id 兜底）。
   * chapter 实际是预告片时站点会 301 到 trailer-… 规范前缀（同为播放入口，实测）。
   * 拿不到返回空串（调用方退全集页兜底）。
   */
  function buildReelshortEpisodeUrl(movieUrl, detail) {
    const slugId = (String(movieUrl || '').match(/\/movie\/([^/?#]+)/) || [])[1];
    const chapterId = String(detail?.start_play?.chapter_id || detail?.online_base?.[0]?.chapter_id || '').trim();
    return slugId && chapterId ? `https://www.reelshort.com/episodes/episode-1-${slugId}-${chapterId}` : '';
  }

  /**
   * 跳转后的 /movie/ 地址是否仍是这部剧（路径尾段是 -<book_id>）。剧目页 301 只规范 slug；
   * 下架 / 地区不可用的剧可能被 302 到首页或别的剧（都是 200）——不校验就会拿首页当播放页，
   * 或拿别的剧的标题、简介、tag_list 覆盖本卡，之后去重命中只补 genres、永远改不回来
   * （审查 reelshort-redirect-overwrites-url）。
   */
  function isReelshortMovieOf(url, bookId) {
    if (!/^[0-9a-f]{24}$/.test(bookId)) return false;
    try {
      return new RegExp(`/movie/[^/?#]+-${bookId}/?$`).test(new URL(url).pathname);
    } catch (e) {
      return false;
    }
  }

  /**
   * ReelShort 详情补完整简介：数据源固定为 /movie/<slug>-<book_id> 剧目页
   * （__NEXT_DATA__ 的 pageProps.data.special_desc 为简介全文；/full-episodes/
   * 全集页的 special_desc 是「include N episodes」SEO 模板文案，不可用）。
   * 不读 og:description（带 "Drama also known as X; " 拼接前缀，JSON 更干净）。
   * 请求成功后用同一份 __NEXT_DATA__ 的 chapter_id 把 url 升级为第一集播放页
   * /episodes/…；拿不到 chapter_id 时退 301 规范化的 /full-episodes/ 全集页。
   * 任何失败保留列表页截断版数据与构造的全集页 url，不丢卡；跳到了别处（不再是本剧的
   * /movie/ 页，见 isReelshortMovieOf）同样按详情不可用处理。
   */
  async function fetchReelshortDetail(drama) {
    if (!drama.url) return drama;

    try {
      const detailUrl = drama.url.replace('/full-episodes/', '/movie/');
      // 下面要用 response.url（301 规范化后的地址）拼播放页，fetchServerHtml 只交文本，故直接 fetch
      const response = await fetchWithTimeout(detailUrl, {
        headers: { 'Accept': 'text/html' }
      });

      if (!response.ok) return drama;

      const canonical = (response.url || '').split('?')[0] || detailUrl;
      if (!isReelshortMovieOf(canonical, String(drama.itemId || '').slice(2))) {
        console.warn(`[ShortScraping] ReelShort 详情页跳到了别处（${canonical}），保留列表数据: ${drama.title}`);
        return drama;
      }

      const doc = parseHtmlDocument(await response.text());
      if (!doc) return drama;

      const detail = readNextData(doc)?.props?.pageProps?.data;
      if (detail) {
        const fullDesc = (detail.special_desc || '').trim();
        if (fullDesc) drama.description = fullDesc;
        const title = (detail.book_title || '').trim();
        if (title) drama.title = title;
        if (!drama.poster && detail.book_pic) drama.poster = detail.book_pic;
        // 详情 tag_list 是完整类型标签集（列表 theme 通常只 1 个）；为空保留列表值
        const tagTexts = cleanGenres((detail.tag_list || []).map(t => t && t.text));
        if (tagTexts.length) drama.genres = tagTexts;
      }
      const episodeUrl = buildReelshortEpisodeUrl(canonical, detail);
      drama.url = episodeUrl || canonical.replace('/movie/', '/full-episodes/');

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

    // genres 留空，映射回主站后由 /movie/ 页 tag_list 补充
    return createDramaCard('reelshort', rsfId, index, tags, { title: title || rsfId, poster, description: excerpt, url });
  }

  /**
   * fandom 文章页（WP SSR）补数据：
   * - 回主站 /movie/<slug>-<book_id> 链接 → 去重键改写为 rs+book_id、url 换成主站
   *   第一集播放页（需再请求 /movie/ 页取 chapter_id 拼 /episodes/…，失败退
   *   /full-episodes/ 全集页兜底），与主站 TOP 条目全局去重（saveSingleDrama 按 itemId 兜底；同批多篇
   *   文章指向同一剧时后到者在保存点被拦）；找不到回链仍为 rsf-+slug 临时键，
   *   由 scrapePage 的未映射闸门跳过入库（下轮抓取重试）
   * - h1.entry-title 为权威标题；正文前几个长段落作简介——此站 og:description 是
   *   正文首段真摘要（与 my-drama fandom 的「SEO 模板不可用」相反），可作兜底；
   *   封面列表页 background-image 优先、og:image 兜底。任何失败都保留列表页数据。
   */
  async function fetchReelshortFandomDetail(drama) {
    if (!drama.url) return drama;

    try {
      const doc = await fetchServerDocument(drama.url);
      if (!doc) return drama;

      const mainLink = doc.querySelector('a[href*="reelshort.com/movie/"], a[href^="/movie/"]');
      const mainHref = mainLink ? (mainLink.getAttribute('href') || '') : '';
      const bid = mainHref.match(/-([0-9a-f]{24})(?:[/?#]|$)/);
      if (bid) {
        drama.itemId = `rs${bid[1]}`;
        const u = new URL(mainHref, 'https://www.reelshort.com');
        u.search = '';
        u.hash = '';
        const movieUrl = u.toString();
        drama.url = movieUrl.replace('/movie/', '/full-episodes/');
        // 映射到的主站条目库里已有、且已有 genres：scrapePage 不会把它当新卡，也不需要回填，
        // /movie/ 这次请求纯属浪费（照 MyDrama fandom 的写法短路，审查 fandom-refetch-every-run）
        if (existingDramaSnapshot.get(drama.itemId) === true) {
          console.log(`[ShortScraping] ReelShort fandom 映射到已有条目，跳过主站请求: ${drama.itemId}`);
          return drama;
        }
        try {
          // 要读 movieResp.url（301 规范化后的地址），同主站详情，直接 fetch
          const movieResp = await fetchWithTimeout(movieUrl, { headers: { 'Accept': 'text/html' } });
          const canonical = (movieResp.url || '').split('?')[0] || movieUrl;
          // 跳到了别处（首页 / 别的剧）不采：chapter_id 与 tag_list 都会是别人的（isReelshortMovieOf）
          if (movieResp.ok && !isReelshortMovieOf(canonical, bid[1])) {
            console.warn(`[ShortScraping] ReelShort fandom 主站页跳到了别处（${canonical}），保留全集页兜底: ${drama.title}`);
          } else if (movieResp.ok) {
            const movieDoc = parseHtmlDocument(await movieResp.text());
            const movieDetail = readNextData(movieDoc)?.props?.pageProps?.data;
            const episodeUrl = buildReelshortEpisodeUrl(canonical, movieDetail);
            if (episodeUrl) drama.url = episodeUrl;
            // 与主站详情同源的 tag_list（这次 /movie/ 请求本为取 chapter_id）
            const tagTexts = cleanGenres(((movieDetail && movieDetail.tag_list) || []).map(t => t && t.text));
            if (tagTexts.length) drama.genres = tagTexts;
          }
        } catch (e2) {
          console.warn(`[ShortScraping] ReelShort fandom 取播放页失败（保留全集页兜底）: ${drama.title}`, e2.message);
        }
      }

      const h1 = doc.querySelector('h1.entry-title') || doc.querySelector('h1');
      const h1Text = h1 ? h1.textContent.trim() : '';
      if (h1Text) drama.title = h1Text;

      if (!drama.poster) {
        const ogImage = doc.querySelector('meta[property="og:image"]');
        drama.poster = ogImage ? (ogImage.getAttribute('content') || '').trim() : '';
      }

      const paras = articleLeadParagraphs(doc);
      if (paras.length) {
        drama.description = paras.join('\n');
      } else {
        const ogDesc = doc.querySelector('meta[property="og:description"]');
        const ogText = ogDesc ? (ogDesc.getAttribute('content') || '').trim() : '';
        if (ogText) drama.description = ogText;
      }

      console.log(`[ShortScraping] ReelShort fandom 详情: ${drama.title} | 主站映射: ${bid ? drama.itemId : '无'} | 简介: ${drama.description ? '有' : '无'}`);
    } catch (e) {
      console.warn(`[ShortScraping] ReelShort fandom 详情获取失败: ${drama.title}`, e.message);
    }

    return drama;
  }

  /**
   * DramaShorts 列表数据：/top-movies 直取 pageProps.movies；首页按 ?list=<板块id>
   * 从 pageProps.discover 选板块（板块项形如 {id, type, data: {title, movies}}），
   * 无参数默认 top_trending，参数值归一后为空或对不上板块 id 都返回空数组
   * （readListParam，不退回默认板块）。定位失败返回空数组（scrapePage 安全跳过）。
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
    const sectionId = readListParam('top_trending');
    if (!sectionId) return [];
    const sections = Array.isArray(pageProps.discover) ? pageProps.discover : [];
    // 板块 id 同样归一后再比，与参数一侧对称（id 里若有连字符也不会失配）
    const section = sections.find(s => s && normalizeSectionName(s.id) === sectionId);
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
    return createDramaCard('dramashorts', dsId, index, tags, {
      title: (movie.title || '').trim() || dsId,
      poster: buildDramashortsPosterUrl(images.coverWithTitle || images.cover),
      genres: movie.genre && movie.genre.title ? [String(movie.genre.title).trim()] : [],
      description: (movie.description || '').trim(),
      url: `https://dramashorts.io/shorts/${dsId.slice(2)}`
    });
  }

  /**
   * 读取 Next.js App Router 的 RSC flight 数据：SSR 把数据拆进多个内联
   * <script>self.__next_f.push([1,"…"])</script>，按文档顺序取 payload 拼接。
   * 每段 script 文本的首 [ 到末 ] 即 push 参数的 JSON 字面量（Next 序列化时
   * 已做 JSON 兼容转义），只收 [1,"…"] 形态的文本分段。无数据返回 ''。
   */
  function readNextFlight(doc = document) {
    const parts = [];
    for (const script of doc.querySelectorAll('script')) {
      const text = script.textContent || '';
      if (!text.includes('self.__next_f.push(')) continue;
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start < 0 || end <= start) continue;
      try {
        const arr = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(arr) && arr[0] === 1 && typeof arr[1] === 'string') parts.push(arr[1]);
      } catch (e) {
        // 单段坏数据跳过，不影响其余分段
      }
    }
    return parts.join('');
  }

  /**
   * 从 flight 文本截取 "<key>": 后的 JSON 数组并解析。数组终点用字符串感知的
   * 括号匹配定位（sliceBalanced；标题等字符串值里可能出现 [ ]，纯计数会截错）。失败返回 null。
   */
  function parseFlightArray(flight, key) {
    const anchor = flight.indexOf(`"${key}":`);
    if (anchor < 0) return null;
    const literal = sliceBalanced(flight, flight.indexOf('[', anchor), '[', ']');
    if (!literal) return null;
    try {
      return JSON.parse(literal);
    } catch (e) {
      return null;
    }
  }

  /**
   * NetShort 列表数据：flight 里的 videoListGroup 板块按名字归一化后与 ?list=
   * 参数比对（板块无 id 可用），无参数默认 trending_now；参数值非法不退回默认
   * （readListParam）。定位失败返回空数组（scrapePage 安全跳过）。
   */
  function getNetshortItems() {
    const flight = readNextFlight();
    const groups = flight ? parseFlightArray(flight, 'videoListGroup') : null;
    if (!Array.isArray(groups)) {
      console.log('[ShortScraping] NetShort flight 板块数据未找到');
      return [];
    }
    const wanted = readListParam('trending_now');
    if (!wanted) return [];
    const group = groups.find(g => g && normalizeSectionName(g.groupName) === wanted);
    if (!group || !Array.isArray(group.data)) {
      console.log(`[ShortScraping] NetShort 首页板块未找到: ${wanted}`);
      return [];
    }
    return group.data;
  }

  /**
   * 从 flight 条目提取基础信息。shotIntroduce 即简介全文；观看页相对路径
   * shortPlayNameUrl（/episode/<slug>-<id>）站点数据自带，缺失时用标题 slug
   * 构造兜底（错 slug 会被站点 301 到规范地址）。封面 CDN 直链约 42KB/张
   * （站内卡片同款直链，无需图片优化端点）。
   */
  function extractNetshortFromItem(item, index, tags, nsId) {
    const path = typeof item.shortPlayNameUrl === 'string' && item.shortPlayNameUrl.startsWith('/')
      ? item.shortPlayNameUrl
      : `/episode/${slugifyTitle(item.shortPlayName) || 'x'}-${nsId.slice(2)}`;
    return createDramaCard('netshort', nsId, index, tags, {
      title: (item.shortPlayName || '').trim() || nsId,
      poster: (item.shortPlayCover || '').trim(),
      genres: cleanGenres((item.labelList || []).map(l => l && l.labelName)),
      description: (item.shotIntroduce || '').trim(),
      url: `https://netshort.com${path}`
    });
  }

  /**
   * 板块标题归一化（readListParam 与各板块类适配器的板块查找共用；抽自 getNetshortItems 的
   * 内联 normalize，语义不变）：小写、非字母数字连续段折成 '_'、去首尾 '_'。emoji 是多码元也整段折掉：
   * '🔥🔥🔥Hot Picks ' → hot_picks、'7-Day Star🥇🥈🥉' → 7_day_star。
   */
  function normalizeSectionName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  /**
   * 订阅 URL 的 ?list= 板块参数（各首页板块类适配器共用，PinesDramas 原有写法的推广）：
   * 没有参数 → defaultName；有参数 → normalizeSectionName 归一后返回，归一后为空 → null，
   * 调用方见 null 直接返回空数组。归一后的名字与站点板块对不上，由各适配器自己的板块
   * 查找返回空数组（「板块未找到」），同样不退回默认板块。
   * 以前是 `/^[a-z0-9_-]+$/.test(list) ? list : 默认板块`：订阅值写错一个大写字母或空格，
   * 就悄悄抓默认板块，却按这条订阅的标签与 sourceListUrl 入库、推送
   * （审查 list-param-silent-default-fallback）。
   */
  function readListParam(defaultName) {
    const params = new URLSearchParams(window.location.search || '');
    if (!params.has('list')) return defaultName;
    const raw = params.get('list');
    const wanted = normalizeSectionName(raw);
    if (!wanted) {
      console.warn(`[ShortScraping] ?list= 参数值无法识别: ${JSON.stringify(raw)}，不退回默认板块，本页跳过`);
      return null;
    }
    return wanted;
  }

  /**
   * 读取 Nuxt 3 的 SSR 载荷（script#__NUXT_DATA__，JSON 数组＝devalue 扁平格式）并还原成普通
   * 对象。元素带 data-src 时 Nuxt 改从外部 _payload.json 取数、内联为空（预渲染 / payload
   * extraction 场景）——FlickReels 当前内联（data-ssr="true"），遇到该形态只打日志返回 null，
   * 不猜路径去 fetch。解析失败返回 null。
   */
  function readNuxtData(doc = document) {
    try {
      const script = doc.querySelector('script#__NUXT_DATA__');
      if (!script) return null;
      const text = script.textContent || '';
      if (!text.trim()) {
        const external = typeof script.getAttribute === 'function' ? script.getAttribute('data-src') : null;
        console.log(`[ShortScraping] __NUXT_DATA__ 为空${external ? `（载荷外置 data-src=${external}）` : ''}`);
        return null;
      }
      const values = JSON.parse(text);
      return Array.isArray(values) && values.length ? unflattenNuxtPayload(values) : null;
    } catch (e) {
      console.warn('[ShortScraping] __NUXT_DATA__ 解析失败:', e.message);
      return null;
    }
  }

  /**
   * devalue「扁平」载荷还原（Nuxt 3 __NUXT_DATA__ 用它序列化）。values 是一维数组：
   * values[0] 为根；对象值 / 数组元素里的数字都是指向 values 的**下标**而非字面量（字面量
   * 数字自己占一格，同值原始类型共用一格——如重复出现的标签名）；负数是哨兵（取自 devalue
   * src/constants.js，勿凭印象改序）：-1 undefined、-2 数组空洞、-3 NaN、-4 Infinity、
   * -5 -Infinity、-6 -0；-7 开头是稀疏数组 [-7, 长度, 下标, 值下标, …]。扁平的普通数组元素
   * 恒为数字，因此**首元素是字符串即特殊形态**：Nuxt 响应式包装 ShallowReactive / Reactive /
   * Ref / ShallowRef（一律拆包取内层——抓取只要数据形状不要响应式）、EmptyRef / EmptyShallowRef
   * （内层下标指向字符串：'_'＝undefined、'0n'、或 JSON 文本）、devalue 内建 Date（ISO 内联）/
   * Set / Map / null（无原型对象，键内联）/ Object（装箱原始值，字面量内联）/ RegExp / BigInt。
   * 未知类型原样返回不抛错——站点框架升级带来新形态时宁可局部丢数据，不能让整页抓取归零。
   * 带 memo：同一下标只还原一次，且容器先登记再递归，共享引用 / 自引用不会无限递归。
   */
  function unflattenNuxtPayload(values) {
    const UNWRAP = new Set(['ShallowReactive', 'Reactive', 'Ref', 'ShallowRef']);
    const memo = new Map();
    const hydrate = (index) => {
      if (typeof index !== 'number') return undefined;
      if (index < 0) {
        if (index === -3) return NaN;
        if (index === -4) return Infinity;
        if (index === -5) return -Infinity;
        if (index === -6) return -0;
        return undefined;                       // -1 undefined；-2 空洞由数组分支处理；未知哨兵按缺失
      }
      if (memo.has(index)) return memo.get(index);
      const value = values[index];
      if (value === null || typeof value !== 'object') {   // 叶子字面量（越界为 undefined）
        memo.set(index, value);
        return value;
      }
      if (!Array.isArray(value)) {
        const obj = {};
        memo.set(index, obj);
        for (const key of Object.keys(value)) obj[key] = hydrate(value[key]);
        return obj;
      }
      if (value[0] === -7) {                    // 稀疏数组
        const arr = [];
        memo.set(index, arr);
        for (let i = 2; i + 1 < value.length; i += 2) arr[value[i]] = hydrate(value[i + 1]);
        return arr;
      }
      if (typeof value[0] !== 'string') {       // 普通数组
        const arr = [];
        memo.set(index, arr);
        for (const ref of value) arr.push(ref === -2 ? undefined : hydrate(ref));
        return arr;
      }
      const type = value[0];
      let out = value;                          // 默认：未知形态原样返回
      try {
        if (UNWRAP.has(type)) out = hydrate(value[1]);
        else if (type === 'EmptyRef' || type === 'EmptyShallowRef') {
          const text = hydrate(value[1]);
          out = typeof text === 'string' && text !== '_' && text !== '0n' ? JSON.parse(text) : undefined;
        } else if (type === 'Date') out = new Date(value[1]);
        else if (type === 'Set') out = new Set(value.slice(1).map(hydrate));
        else if (type === 'Map') {
          out = new Map();
          for (let i = 1; i + 1 < value.length; i += 2) out.set(hydrate(value[i]), hydrate(value[i + 1]));
        } else if (type === 'null') {
          out = Object.create(null);
          for (let i = 1; i + 1 < value.length; i += 2) out[value[i]] = hydrate(value[i + 1]);
        } else if (type === 'Object') out = value[1];
        else if (type === 'RegExp') out = new RegExp(value[1], value[2]);
        else if (type === 'BigInt') out = BigInt(value[1]);
      } catch (e) {
        out = value;
      }
      memo.set(index, out);
      return out;
    };
    return hydrate(0);
  }

  /**
   * FlickReels 首页板块数据。板块数组按**形状**定位——元素带 column_config + playlet_list——
   * 而不写死 useAsyncData 的键名 'home-playletList'（键名是站点代码里的变量名，改版首当其冲）。
   * 板块按标题归一化后与 ?list= 比对，无参数默认 hot_picks；参数值非法不退回默认（readListParam）。
   * is_playlet_trailer 的条目是「未上线预告」（站内点击只弹 "Not released yet"、没有播放页），
   * 这里直接滤掉（2026-09-16 用户定）——上线后该位翻成 false，下轮抓取自然入库，不留残卡。
   * 定位失败返回空数组（scrapePage 安全跳过）。
   */
  function getFlickreelsItems() {
    const root = readNuxtData();
    const data = root && root.data && typeof root.data === 'object' ? root.data : null;
    if (!data) {
      console.log('[ShortScraping] FlickReels __NUXT_DATA__ 数据未找到');
      return [];
    }
    const isSection = s => !!(s && typeof s === 'object' && s.column_config && Array.isArray(s.playlet_list));
    const sections = Object.values(data).find(v => Array.isArray(v) && v.some(isSection));
    if (!sections) {
      console.log('[ShortScraping] FlickReels 首页板块数据未找到');
      return [];
    }
    const wanted = readListParam('hot_picks');
    if (!wanted) return [];
    const section = sections.find(s => isSection(s) && normalizeSectionName(s.column_config.title) === wanted);
    if (!section) {
      console.log(`[ShortScraping] FlickReels 首页板块未找到: ${wanted}`);
      return [];
    }
    const items = section.playlet_list.filter(p => p && typeof p === 'object');
    const released = items.filter(p => p.is_playlet_trailer !== true);
    if (released.length !== items.length) {
      console.log(`[ShortScraping] FlickReels 跳过 ${items.length - released.length} 条未上线预告`);
    }
    return released;
  }

  /**
   * FlickReels 播放页 slug——逐字照搬站点打包代码里各卡片组件共用的 slug 函数（导出名 D，
   * 2026-09-16 从 bundle 抽出并以 15/15 条真实 URL 验证 200）。**不能复用 slugifyTitle**：
   * ReelShort / NetShort 只认结尾 id、错 slug 会 301 到规范地址，而 FlickReels 服务端校验 slug，
   * 错一字即 404、无 slug 也 404。规则：/ & 空白与各式括号（含全角）变 '-'；其余非字母数字
   * （\p{L}\p{N}，'Fiancée' 的 é 保留、入库时由 URL 构造器百分号编码）直接删不留 '-'——
   * 'Tame Me,My Lord' → 'tame-memy-lord'、'Bride Swap：The Marquis' Reborn Bride' →
   * 'bride-swapthe-marquis-reborn-bride'。返回空串表示造不出合法 URL，调用方跳过该条。
   */
  function flickreelsSlug(title) {
    return String(title || '').toLowerCase()
      .replace(/[/&\s()（）[\]{}]+/g, '-')
      .replace(/[^\p{L}\p{N}-]+/gu, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // 站内卡片同款 OSS 缩放参数（600×780 webp ≈60KB；原图 1000×1300 jpg ≈400KB）。参数含英文逗号，
  // Lark「链接转附件」解析不了——推送侧 lark.js posterForPayload 剥掉该参数还原原图，两处成对改
  const FLICKREELS_POSTER_SUFFIX = '?x-oss-process=image/resize,w_600,image/format,webp';

  /**
   * 从板块条目提取基础信息。introduce 即简介全文；genres 取 tag_list[].name（英文；同对象里的
   * category 是站点内部中文分类，不采）；upload_num 集数无对应字段不存。播放页
   * /playlist/<slug>/<playlet_id>/<episode-1|full-movie>：has_collection 为 true 的是合集
   * （整片一集）用 full-movie，其余第一集 episode-1；经 new URL(path, origin).href 把 slug 里
   * 的非 ASCII 字母百分号编码（fianc%C3%A9e，实测 200）。标题空 / 全符号造不出 slug → 站点必
   * 404，返回 null 跳过（scrapePage 对 extractBasic 为 null 静默 continue），下轮标题正常即入库。
   */
  function extractFlickreelsFromItem(item, index, tags, frId) {
    const title = String(item.title || '').trim();
    const slug = flickreelsSlug(title);
    if (!slug) {
      console.warn(`[ShortScraping] FlickReels 第 ${index + 1} 项标题无法构造 slug（${frId}），跳过`);
      return null;
    }
    const cover = String(item.cover || '').trim();
    const tail = item.has_collection === true ? 'full-movie' : 'episode-1';
    return createDramaCard('flickreels', frId, index, tags, {
      title,
      poster: cover ? cover + (cover.includes('?') ? '' : FLICKREELS_POSTER_SUFFIX) : '',
      genres: cleanGenres((Array.isArray(item.tag_list) ? item.tag_list : []).map(t => t && t.name)),
      description: String(item.introduce || '').trim(),
      url: new URL(`/playlist/${slug}/${frId.slice(2)}/${tail}`, 'https://www.flickreels.net').href
    });
  }

  /* ——— GoodShort / Shortical / ShortMax（v1.6.9）——————————————————————— */

  // 站内卡片同款缩放参数（293×412 ≈28KB；原图 ≈271KB）。无逗号，两种形态 Lark 捷径都能转
  // 附件，但按 v1.6.4 定的「库里存小图、推出去放大」仍由 lark.js posterForPayload 剥掉
  const GOODSHORT_POSTER_SUFFIX = '?w=293&h=412';

  /**
   * GoodShort 板块条目：同源重取 HTML → 解 window.__INITIAL_STATE__ →
   * ChannelModule.channelBooks（10 条）。取不到一律返回空数组，scrapePage 安全跳过。
   */
  async function getGoodshortItems() {
    const html = await fetchServerHtml();
    if (!html) return [];

    const marker = 'window.__INITIAL_STATE__=';
    const at = html.indexOf(marker);
    if (at < 0) {
      console.log('[ShortScraping] GoodShort __INITIAL_STATE__ 未找到');
      return [];
    }
    const literal = sliceBalanced(html, at + marker.length, '{', '}');
    if (!literal) {
      console.log('[ShortScraping] GoodShort __INITIAL_STATE__ 花括号不配对');
      return [];
    }

    let state;
    try {
      state = JSON.parse(literal);
    } catch (e) {
      console.warn('[ShortScraping] GoodShort __INITIAL_STATE__ 解析失败:', e.message);
      return [];
    }

    const books = state && state.ChannelModule && state.ChannelModule.channelBooks;
    if (!Array.isArray(books)) {
      console.log('[ShortScraping] GoodShort ChannelModule.channelBooks 未找到');
      return [];
    }
    return books.filter(b => b && typeof b === 'object');
  }

  /**
   * 从 channelBooks 条目提取基础信息。introduction 即详情页同一份文本（结尾的「…」
   * 是站点自己的数据）。genres 合并两个站点原生英文来源：genreList 是粗分类（Romance），
   * tagsList 是主题标签（Werewolf / Regret / Mafia），cleanGenres 去重。
   * bookResourceUrl 形如 <slug>-<sourceId>，即详情页路径。
   */
  function extractGoodshortFromItem(item, index, tags, gsId) {
    const title = String(item.bookName || item.name || '').trim();
    const cover = String(item.cover || '').trim();
    const resource = String(item.bookResourceUrl || '').trim();
    // 没有详情页路径＝给不了可点的链接：跳过该条、下轮重试（同 FlickReels 造不出 slug）。
    // 以前照样以空 url 入库并推送，之后去重命中只补 genres，站点补上字段也更新不了
    // （审查 goodshort-empty-url-saved）
    if (!resource) {
      console.warn(`[ShortScraping] GoodShort 第 ${index + 1} 项缺 bookResourceUrl（${gsId}），跳过`);
      return null;
    }
    const genreNames = (Array.isArray(item.genreList) ? item.genreList : []).map(g => g && g.name);
    const tagNames = (Array.isArray(item.tagsList) ? item.tagsList : []).map(t => t && t.name);

    return createDramaCard('goodshort', gsId, index, tags, {
      title,
      poster: cover ? cover + (cover.includes('?') ? '' : GOODSHORT_POSTER_SUFFIX) : '',
      genres: cleanGenres([...genreNames, ...tagNames]),
      description: String(item.introduction || '').trim(),
      // 订阅 URL 必须带 www（裸域 301 到 www），入库地址同口径
      url: `https://www.goodshort.com/drama/${resource}`
    });
  }

  const SHORTICAL_ORIGIN = 'https://shortical.com';

  /**
   * Shortical 规范 slug 表：`slug 基名 → 规范 slug`（基名＝去掉尾部 `-<数字>`）。
   *
   * **首页卡片 href 尾段的数字不是规范 series id**（2026-09-18 线上实证）：站点两套 id
   * 并行——首页由实时接口驱动、给 2100–2250 区间的新号，而详情页只吃静态发布产物
   * （SPA 取 `/_seo/drama/<id>.json`，拿不到就渲染 404）。实测 9 张卡里 5 张的 href
   * 打不开，`/drama/bound-by-fire-2200` 是 404 而 `-163` 才是真页面。
   *
   * `sitemaps/series.xml` 与 `_seo` 是同一次静态发布的产物、集合严格一致，所以它就是
   * 「能打开的那套 id」的权威源：公开免鉴权、一次请求约 34KB、142 条**基名零碰撞**。
   * 失败返回 null，调用方本轮放弃——**绝不退回 href 那个号**，那正是本缺陷本身。
   */
  async function readShorticalCanonicalSlugs() {
    try {
      const response = await fetchWithTimeout('/sitemaps/series.xml', { headers: { 'Accept': 'application/xml' } });
      if (!response.ok) {
        console.log(`[ShortScraping] Shortical sitemap HTTP ${response.status}`);
        return null;
      }
      // 解析与后台 migrateShorticalCanonicalIds 共用 ScrapeRules.parseShorticalSitemap
      const map = parseShorticalSitemap(await response.text());
      // 站点对未命中路径一律回 200＋9KB 空壳，所以「拿到响应」不等于「拿到 sitemap」
      if (!map.size) {
        console.log('[ShortScraping] Shortical sitemap 里没有 /drama/ 条目（疑似空壳响应）');
        return null;
      }
      return map;
    } catch (e) {
      console.log('[ShortScraping] Shortical sitemap 读取失败:', e.message);
      return null;
    }
  }

  /**
   * Shortical「Top Recommended」区块条目（读 hydrate 后的 DOM）。
   * 区块按 ?list= 归一化后的标题定位（缺省 top_recommended），从 h2 向上找到第一个
   * 含 /drama/ 链接的祖先即区块本身。每卡：img 给封面，链接文本给标题，
   * **简介取卡内最长的 <p>**——另一个 <p> 是「19.5K」这类观看量，按顺序取第一个会踩雷。
   *
   * **id 三个键必须分开**（2026-09-18）：`apiId`＝href 尾段那个号，只用来匹配官方接口
   * 返回的 `series.id`（接口与首页同源、用的就是这套号）；`slug`/`id`＝sitemap 给的规范值，
   * itemId 与 url 都取它。混用会出两种事故：用 href 号做 url ＝ 点封面落到 404；
   * 用规范号匹配接口 ＝ genres 补全全线失配、静默退化成卡片上那一个标签。
   * 规范 slug 查不到的卡跳过、下轮重试（同 FlickReels「造不出 slug 就跳过该条」）。
   */
  async function getShorticalItems() {
    const wanted = readListParam('top_recommended');
    if (!wanted) return [];

    const section = await waitForShorticalSection(wanted);
    if (!section) {
      console.log(`[ShortScraping] Shortical 区块未找到: ${wanted}`);
      return [];
    }

    const canonical = await readShorticalCanonicalSlugs();
    if (!canonical) {
      console.log('[ShortScraping] Shortical 规范 slug 表取不到，本轮跳过（下轮重试）');
      return [];
    }

    const items = [];
    const seen = new Set();
    for (const link of section.querySelectorAll('a[href*="/drama/"]')) {
      const href = link.getAttribute('href') || '';
      const hrefSlug = (href.match(/\/drama\/([^/?#]+)/) || [])[1] || '';
      const apiId = (hrefSlug.match(/-(\d+)$/) || [])[1];
      if (!apiId) continue;
      const slug = canonical.get(hrefSlug.replace(/-\d+$/, ''));
      if (!slug) {
        console.log(`[ShortScraping] Shortical sitemap 无此剧、跳过该卡（下轮重试）: ${hrefSlug}`);
        continue;
      }
      const id = (slug.match(/-(\d+)$/) || [])[1];
      // 按规范 id 去重：同一卡的封面与标题各是一个链接，两个不同 href 号也可能是同一部剧
      if (seen.has(id)) continue;
      seen.add(id);

      // 从链接向上找到既含图又含简介的卡片根
      let card = link;
      while (card && card !== section && !card.querySelector('img')) card = card.parentElement;
      if (!card || card === section) card = link.parentElement || link;

      const img = card.querySelector('img');
      const paragraphs = Array.from(card.querySelectorAll('p')).map(p => (p.textContent || '').trim());
      const description = paragraphs.reduce((longest, t) => (t.length > longest.length ? t : longest), '');
      // 卡片上只印一个分类（接口给的是全量，随后尽力覆盖）
      const category = Array.from(card.querySelectorAll('div'))
        .map(d => (d.textContent || '').trim())
        .find(t => t && t.length < 40) || '';

      items.push({
        id,
        apiId,   // 只用于匹配接口返回的 series.id，别拿它拼 url
        slug,
        title: (link.textContent || '').trim() || (img ? img.getAttribute('alt') || '' : ''),
        poster: img ? (img.getAttribute('src') || '') : '',
        description,
        categories: cleanGenres([category])
      });
    }

    await backfillShorticalGenres(items);
    return items;
  }

  /** 等区块出现且卡片数连续两次不变（纯前端渲染，同 waitForMyDramaItems 共用 pollUntilStable，最长约 8 秒）。 */
  async function waitForShorticalSection(wanted) {
    const query = () => {
      const heading = Array.from(document.querySelectorAll('h1, h2, h3'))
        .find(h => normalizeSectionName(h.textContent) === wanted);
      if (!heading) return null;
      let node = heading;
      while (node && node !== document.body && node.querySelectorAll('a[href*="/drama/"]').length === 0) {
        node = node.parentElement;
      }
      return node && node !== document.body ? node : null;
    };
    return pollUntilStable(query, section => (section ? section.querySelectorAll('a[href*="/drama/"]').length : 0));
  }

  /**
   * 尽力把 genres 从「卡片上那一个分类」补成官方接口的全量分类（实测每条 2~4 个）。
   * 接口匿名调用 401，token 在页面 firebaseLocalStorageDb 里、内容脚本同源可读。
   * **任何一步失败都静默保留 DOM 的保底值**——这条线只负责锦上添花，绝不能让抓取归零。
   */
  async function backfillShorticalGenres(items) {
    if (!items.length) return;
    try {
      const token = await readShorticalToken();
      if (!token) {
        console.log('[ShortScraping] Shortical 未取到接口凭据，genres 用卡片上的单个分类');
        return;
      }
      const response = await fetchWithTimeout('https://prod.shortical.com/api/v1/series/top-recommendations', {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        console.log(`[ShortScraping] Shortical 接口 HTTP ${response.status}，genres 保留卡片值`);
        return;
      }
      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload : [];
      const byId = new Map();
      for (const row of rows) {
        const series = row && row.series;
        if (series && series.id != null && Array.isArray(series.categories)) {
          byId.set(String(series.id), cleanGenres(series.categories));
        }
      }
      let filled = 0;
      for (const item of items) {
        // 按 apiId 查（＝首页 href 尾段那个号）：接口与首页同源、用的就是这套号。
        // 换成规范 id 会全线失配，表现是「genres 静默退化成卡片上那一个标签」
        const full = byId.get(item.apiId);
        if (full && full.length) {
          item.categories = full;
          filled++;
        }
      }
      console.log(`[ShortScraping] Shortical 已补全 ${filled}/${items.length} 条的内容类型标签`);
    } catch (e) {
      console.log('[ShortScraping] Shortical genres 补全跳过:', e.message);
    }
  }

  /**
   * 读页面 Firebase 会话里的 accessToken。**先用 databases() 确认库已存在再 open**——
   * 直接 open 一个不存在的库会把它按版本 1 建出来且没有对象仓库，反而会把站点自己的
   * 鉴权初始化搞坏。带 3 秒兜底，取不到一律返回 null。
   * **连接用完必关**（审查 shortical-idb-connection-leak）：用户在自己的前台标签页里点按钮时，
   * 挂着的连接会一直留到页面卸载，碰上 Firebase SDK 升级库版本或删库重建就被它 blocked、
   * 站点登录态初始化卡住。所以每个出口都 close，超时后才打开的连接一到手就关，站点要升级
   * 时（versionchange）立即让路；库恰好在 databases() 与 open() 之间被删时 open 会触发
   * upgradeneeded，这里中止升级、不替站点建空库。
   */
  async function readShorticalToken() {
    const DB_NAME = 'firebaseLocalStorageDb';
    const STORE = 'firebaseLocalStorage';
    try {
      if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return null;
      const existing = await indexedDB.databases();
      if (!existing.some(db => db && db.name === DB_NAME)) return null;

      return await new Promise(resolve => {
        let settled = false;
        let db = null;
        const closeDb = () => {
          try { if (db) db.close(); } catch (e) { /* 已关闭 */ }
          db = null;
        };
        const done = value => {
          closeDb();
          if (!settled) { settled = true; resolve(value); }
        };
        setTimeout(() => done(null), 3000);
        const request = indexedDB.open(DB_NAME);
        request.onerror = () => done(null);
        request.onupgradeneeded = () => {
          try { request.transaction.abort(); } catch (e) { /* 中止失败时 onerror / onsuccess 照常收口 */ }
        };
        request.onsuccess = () => {
          db = request.result;
          if (settled) return closeDb();
          try {
            db.onversionchange = () => closeDb();
            if (!db.objectStoreNames.contains(STORE)) return done(null);
            const all = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
            all.onerror = () => done(null);
            all.onsuccess = () => {
              const hit = (all.result || []).find(r => r && r.value && r.value.stsTokenManager
                && typeof r.value.stsTokenManager.accessToken === 'string');
              done(hit ? hit.value.stsTokenManager.accessToken : null);
            };
          } catch (e) {
            done(null);
          }
        };
      });
    } catch (e) {
      return null;
    }
  }

  function extractShorticalFromItem(item, index, tags, scId) {
    return createDramaCard('shortical', scId, index, tags, {
      title: String(item.title || '').trim(),
      poster: String(item.poster || '').trim(),
      genres: cleanGenres(item.categories),
      description: String(item.description || '').trim(),
      // 规范 slug 来自 sitemap，不是首页 href（那个号一大半是 404）；裸域形态，
      // 订阅与入库同口径（www.shortical.com 会 301 到裸域）
      url: item.slug ? `${SHORTICAL_ORIGIN}/drama/${item.slug}` : ''
    });
  }

  const SHORTMAX_ORIGIN = 'https://www.shorttv.live';
  // 站内卡片同款 OSS 缩放参数（293×390 ≈65KB；原图 ≈651KB）。参数含英文逗号，正是 Lark
  // 「链接转附件」解析不了的字符 → 推送侧 lark.js posterForPayload 剥掉，两处成对改
  const SHORTMAX_POSTER_SUFFIX = '?process=mediagate&x-oss-process=m_fill,w_293,h_390';

  /** 入口分派只按 pathname（同 ReelShort 范式），不按 id 前缀猜。 */
  function isShortmaxFandom() {
    return /^\/fandom\/?$/.test(window.location.pathname);
  }

  /** 统一成站内卡片同款缩放形态：先剥掉原有查询串（详情页 preload 给的是 390×520）。 */
  function shortmaxPoster(raw) {
    const url = String(raw || '').trim();
    return url ? url.split('?')[0] + SHORTMAX_POSTER_SUFFIX : '';
  }

  /** /drama/<slug>-<id>：由第一集播放页地址去掉尾部集号推得（实测 200）。 */
  function shortmaxDetailUrl(episodeUrl) {
    const url = String(episodeUrl || '');
    if (!url.includes('/episode/')) return '';
    return url.replace('/episode/', '/drama/').replace(/-\d+\/?$/, '');
  }

  /**
   * ShortMax 首页板块条目：重取服务端 HTML 解析（实时 DOM 的轮播按视口裁剪）。
   * 板块按 ?list=<板块名归一化> 选（'Most Popular 🔥' → most_popular，缺省即它；
   * 参数值非法不退回默认，见 readListParam）。
   */
  async function getShortmaxHomeItems() {
    // 先判参数再重取：参数非法时连请求都不发
    const wanted = readListParam('most_popular');
    if (!wanted) return [];

    const doc = await fetchServerDocument();
    if (!doc) return [];

    const section = Array.from(doc.querySelectorAll('section.section'))
      .find(s => normalizeSectionName((s.querySelector('.section-title') || {}).textContent) === wanted);
    if (!section) {
      console.log(`[ShortScraping] ShortMax 首页板块未找到: ${wanted}`);
      return [];
    }

    const items = [];
    for (const card of section.querySelectorAll('.drama-card')) {
      const detailLink = card.querySelector('a[href*="/drama/"]');
      const episodeLink = card.querySelector('a[href*="/episode/"]');
      const img = card.querySelector('img');
      const href = detailLink ? detailLink.getAttribute('href') || '' : '';
      const id = (href.match(/-(\d+)\/?$/) || [])[1];
      if (!id) continue;
      items.push({
        id,
        title: ((card.querySelector('.card-title') || {}).textContent || '').trim()
          || (img ? img.getAttribute('alt') || '' : ''),
        // data-src 是无参原图，src 带站内缩放参数——都归一到同一形态
        cover: img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '',
        episodeHref: episodeLink ? episodeLink.getAttribute('href') || '' : ''
      });
    }
    return items;
  }

  function extractShortmaxHomeFromItem(item, index, tags, smId) {
    // 条目 url 存第一集播放页（同 ReelShort/NetShort 约定），详情补采按 shortmaxDetailUrl 由它推导。
    // 站点数据没给播放页链接时按 id 构造不了，url 留空——fetchShortmaxDetail 推不出详情页地址，
    // 该卡本轮跳过、下轮重试（并没有退回详情页地址，见审查 shortmax-no-episode-link-skipped）
    const episode = item.episodeHref ? new URL(item.episodeHref, SHORTMAX_ORIGIN).href : '';
    // 列表无类型字段、无简介，genres 与简介都留空：详情页 .tags 与 meta[name=description] 才是来源
    return createDramaCard('shortmax', smId, index, tags, {
      title: String(item.title || '').trim(),
      poster: shortmaxPoster(item.cover),
      url: episode
    });
  }

  /**
   * 首页条目详情：同源取 /drama/<slug>-<id> 补简介与 genres。
   * **失败一律返回 null 跳过该卡**（理由同 AppleTV：简介只有详情页这一个来源，而存量
   * 回填只补 genres 不补简介，一旦存下无简介的卡就永远自愈不了），下轮抓取自动重试。
   * opts.takeTitle：fandom 路径用，拿详情页 h1 当权威标题（文章标题不是剧名）。
   */
  async function fetchShortmaxDetail(drama, opts = {}) {
    const detailUrl = shortmaxDetailUrl(drama.url);
    if (!detailUrl) {
      console.log(`[ShortScraping] ShortMax 无法推出详情页地址，跳过: ${drama.title}`);
      return null;
    }

    const doc = await fetchServerDocument(detailUrl);
    if (!doc) return null;

    const metaDesc = doc.querySelector('meta[name="description"]');
    const description = (metaDesc ? metaDesc.getAttribute('content') || '' : '').trim();
    if (!description) {
      console.log(`[ShortScraping] ShortMax 详情页无简介，跳过: ${drama.title}`);
      return null;
    }
    drama.description = description;

    // 移动端与桌面端各渲染一份同样的标签，cleanGenres 去重
    drama.genres = cleanGenres(Array.from(doc.querySelectorAll('.tags a.tag')).map(a => a.textContent));

    const heading = ((doc.querySelector('h1') || {}).textContent || '').trim();
    if (heading && (opts.takeTitle || !drama.title)) drama.title = heading;

    if (!drama.poster) {
      const preload = doc.querySelector('link[rel="preload"][as="image"]');
      if (preload) drama.poster = shortmaxPoster(preload.getAttribute('href'));
    }
    return drama;
  }

  /**
   * fandom 文章：12 篇，列表项无主站 id。先用 smf-+slug 临时键，文章页里有回主站的
   * /episode/<slug>-<id>-1 链接，据此改写为 sm+id 并与首页条目全局去重。
   * 封面刻意不用 fandom 卡自己那张——是 1200×630 横版且带会过期的 auth_key。
   */
  async function getShortmaxFandomItems() {
    const doc = await fetchServerDocument();
    if (!doc) return [];

    const items = [];
    const seen = new Set();
    for (const card of doc.querySelectorAll('.fandom-card')) {
      // 卡上另有一个指向 /fandom/tags/… 的分类链接，要排掉
      const link = Array.from(card.querySelectorAll('a[href^="/fandom/"]'))
        .find(a => !/^\/fandom\/tags\//.test(a.getAttribute('href') || ''));
      const href = link ? link.getAttribute('href') || '' : '';
      const slug = (href.match(/^\/fandom\/([^/?#]+)/) || [])[1];
      if (!slug || seen.has(slug)) continue;      // 同卡的图与标题各是一个链接
      seen.add(slug);
      items.push({
        slug,
        href,
        title: ((card.querySelector('.fandom-card-title') || {}).textContent || '').trim(),
        description: ((card.querySelector('.fandom-card-description') || {}).textContent || '').trim()
      });
    }
    return items;
  }

  function extractShortmaxFandomFromItem(item, index, tags, tempId) {
    // itemId 是 smf-+slug 临时键，映射成功后由 fetchShortmaxFandomDetail 改写；
    // poster 留空，映射到主站后取详情页的竖版封面
    return createDramaCard('shortmax', tempId, index, tags, {
      title: String(item.title || '').trim(),
      description: String(item.description || '').trim(),
      url: item.href ? new URL(item.href, SHORTMAX_ORIGIN).href : ''
    });
  }

  /**
   * fandom 文章详情：找回主站链接 → 改写 itemId/url → 再取主站详情页拿权威标题/简介/
   * genres/封面。找不到回链就原样返回（itemId 仍是 smf- 临时键），由 scrapePage 的
   * 未映射闸门跳过入库、下轮重试。
   */
  async function fetchShortmaxFandomDetail(drama) {
    if (!drama.url) return drama;

    const doc = await fetchServerDocument(drama.url);
    if (!doc) return drama;

    const episodeLink = Array.from(doc.querySelectorAll('a[href*="/episode/"]'))
      .map(a => a.getAttribute('href') || '')
      .find(href => /\/episode\/.+-\d+-\d+\/?$/.test(href));
    if (!episodeLink) {
      console.log(`[ShortScraping] ShortMax fandom 文章无回主站链接（下轮重试）: ${drama.title}`);
      return drama;
    }

    const episodeUrl = new URL(episodeLink, SHORTMAX_ORIGIN).href;
    const id = (episodeUrl.match(/-(\d+)-\d+\/?$/) || [])[1];
    if (!id) return drama;

    drama.itemId = `sm${id}`;
    drama.url = episodeUrl;
    // 映射到的主站条目库里已有、且已有 genres：scrapePage 不会把它当新卡，也不需要回填，
    // 不再请求 /drama/ 详情页（审查 fandom-refetch-every-run）。这里交回的对象没有简介，
    // 由 scrapePage 的「映射后命中存量」闸门保证它不会被当新卡存下
    if (existingDramaSnapshot.get(drama.itemId) === true) {
      console.log(`[ShortScraping] ShortMax fandom 映射到已有条目，跳过主站请求: ${drama.itemId}`);
      return drama;
    }
    // 文章标题是「剧名：Full Guide & Streaming Options」这类 SEO 句式，以主站 h1 为准
    return await fetchShortmaxDetail(drama, { takeTitle: true });
  }

  const DRAMABOX_ORIGIN = 'https://www.dramabox.com';

  /**
   * DramaBox 板块列表页条目：script#__NEXT_DATA__ → props.pageProps.moreData.items。
   * dramabox 的 /more/<position> 与 dramaboxdb 的 /channel/<position> 用的是**同一个
   * moreData 键**（同一套代码的两次构建），故两站共用这一个取数路径。
   * 取不到一律返回空数组，scrapePage 安全跳过、下轮重试。
   */
  function getDramaboxItems() {
    const items = readNextData()?.props?.pageProps?.moreData?.items;
    if (!Array.isArray(items)) {
      console.log('[ShortScraping] DramaBox moreData.items 未找到');
      return [];
    }
    return items.filter(item => item && typeof item === 'object');
  }

  /**
   * 从板块条目提取基础信息。零详情请求：introduction 与详情页 bookInfo.introduction
   * 逐字相同（两站各抽样实测）。
   *
   * genres 合并两个站点原生英文来源（2026-09-18 用户定）：typeTwoNames 是站点分类
   * （Romance / Fantasy / Paranormal），tags 是主题标签（Billionaire / Reverse Harem），
   * 实测 tags 与 labels 字段 72/72 完全一致故只取前者；cleanGenres 去重并 trim
   * （站点数据里真的有 ' Thrilling Combat' 这种带前导空格的标签）。
   * **刻意不采 typeOneName**——它只有 F-Drama / M-Drama 两个值，是受众划分不是内容类型，
   * 60/72 条都是同一个值、无区分度。viewCount / chapterCount / ratings / shelfTime
   * 同样不入库（对齐 Netflix「名次与观看量不入库」的裁定）。
   *
   * url 恒用 dramabox.com 的规范形态，**即使条目是从 dramaboxdb 抓到的**（2026-09-18
   * 用户定「优先 dramabox.com」；实测 28/28 dramaboxdb 独有作品在 dramabox.com 上都可达）。
   * slug 是装饰位（错 slug 仍回 200 真页面，不是 Shortical 那种 200+空壳），但须编码——
   * replacedBookName 里有全角冒号这类字符（Tempest：The-Last-Mecha），站点自己的 href
   * 也是 %EF%BC%9A 形态；缺失时退裸 bookId 形态，站点会 301 到规范地址。
   */
  function extractDramaboxFromItem(item, index, tags, dbId) {
    const bookId = String(item.bookId || '').trim();
    const slug = String(item.replacedBookName || '').trim();
    const typeNames = Array.isArray(item.typeTwoNames) ? item.typeTwoNames : [];
    const tagNames = Array.isArray(item.tags) ? item.tags : [];

    return createDramaCard('dramabox', dbId, index, tags, {
      title: String(item.bookName || item.name || '').trim(),
      // 站点给的就是站内卡片同款缩略图形态（…jpg@w=240&h=400，240×320 ≈24KB），原样存；
      // 推送侧由 lark.js 的 posterForPayload 剥掉 @ 尾段取原图（600×800 ≈99KB）
      poster: String(item.cover || '').trim(),
      genres: cleanGenres([...typeNames, ...tagNames]),
      description: String(item.introduction || '').trim(),
      url: bookId
        ? `${DRAMABOX_ORIGIN}/drama/${bookId}${slug ? `/${encodeURIComponent(slug)}` : ''}`
        : ''
    });
  }

  /* ——— PinesDramas（pinedrama.com，v1.6.12）———————————————————————————— */

  const PINEDRAMA_ORIGIN = 'https://pinedrama.com';
  // 站点 slug 的实测形态：小写字母、数字与连字符
  const PINEDRAMA_SLUG = /^[a-z0-9][a-z0-9-]*$/;

  /**
   * 从卡片 href 解出 { kind, slug }，解不出返回 null。两处要害：
   *   1) **先剥查询串**——站点会把当前页的 ?list= 原样拼进每个卡片的 href
   *      （/dramas/free-my-heart-mr-ceo?list=recommend），不剥 slug 就带着参数；
   *   2) **取路径里的第一段而不是末段**——卡上的「Read Now」指向
   *      /novels/<slug>/chapter-1，取末段会得到 'chapter-1'（真机实测已踩到）。
   * /novels/category/<name> 是分类链接不是作品，单独排掉。
   */
  function pinedramaRefOf(href) {
    if (!href) return null;
    const path = String(href).split('#')[0].split('?')[0];
    const m = path.match(/\/(novels|dramas)\/([^/]+)/);
    if (!m) return null;
    const slug = m[2];
    if (m[1] === 'novels' && slug === 'category') return null;
    if (!PINEDRAMA_SLUG.test(slug)) return null;
    return { kind: m[1] === 'novels' ? 'novel' : 'drama', slug };
  }

  /** 某个子树内的全部作品链接（带解析出的 kind/slug）。 */
  function pinedramaItemAnchors(root) {
    const out = [];
    for (const anchor of root.querySelectorAll('a[href*="/novels/"], a[href*="/dramas/"]')) {
      const ref = pinedramaRefOf(anchor.getAttribute('href'));
      if (ref) out.push({ el: anchor, ...ref });
    }
    return out;
  }

  /**
   * 板块容器：找到标题后向上爬到**第一个含作品链接的祖先**（四个板块真机分别在
   * 第 1/2/2/3 层——Popular Short Dramas 的 h2 还包在一个 <a href="/genres"> 里）。
   * 爬过头会把下一个板块整段吃进来，故加一道闸门：容器里只能有这一个标题元素，
   * 越界就当作「板块没找到」宁可不抓（下轮重试）。
   *
   * 标题**混用 h2/h3**（Popular Novels 是 h2、Editor's Pick 是 h3），只查 h2 会漏。
   */
  function pinedramaSectionElement(doc, wanted) {
    const HEADINGS = 'h1, h2, h3, h4, h5, h6';
    const heading = Array.from(doc.querySelectorAll(HEADINGS))
      .find(h => normalizeSectionName(h.textContent) === wanted);
    if (!heading) {
      console.log(`[ShortScraping] PinesDramas 板块未找到: ${wanted}`);
      return null;
    }
    let node = heading;
    for (let i = 0; i < 6; i++) {
      node = node.parentElement;
      if (!node) break;
      if (!pinedramaItemAnchors(node).length) continue;
      if (node.querySelectorAll(HEADINGS).length > 1) {
        console.warn(`[ShortScraping] PinesDramas 板块容器越界（含多个标题），跳过: ${wanted}`);
        return null;
      }
      return node;
    }
    console.log(`[ShortScraping] PinesDramas 板块内未找到作品链接: ${wanted}`);
    return null;
  }

  /**
   * 卡片封面：从作品链接**就近向上爬**取第一张 img。两种板式都要覆盖——
   * Recommended / Editor's Pick 的 img 在 <a> 里面，Popular Novels /
   * Popular Short Dramas 的 img 是 <a> 的兄弟节点。一旦某层祖先里出现了别的
   * 作品的链接就停下，免得串到隔壁卡的封面上。
   */
  function pinedramaPosterFor(anchor, slug, section) {
    let node = anchor;
    while (node) {
      const img = node.querySelector('img');
      const src = img && img.getAttribute('src');
      if (src) return String(src).trim();
      if (node === section) break;
      const parent = node.parentElement;
      if (!parent) break;
      if (pinedramaItemAnchors(parent).some(a => a.slug !== slug)) break;
      node = parent;
    }
    return '';
  }

  /**
   * 订阅 URL 的 ?list= 选板块；无参数时按页面给缺省值（/novels → 推荐，首页 → 热门小说）。
   * 参数值归一后为空返回 null（readListParam），调用方跳过本页。
   */
  function pinedramaWantedSection() {
    return readListParam(/^\/novels\/?$/.test(window.location.pathname)
      ? 'recommended_webnovels_for_you'
      : 'popular_novels');
  }

  /**
   * 板块条目：读**实时 DOM**（SSR 直出、hydrate 后仍在、与视口无关——375px 下条目数
   * 与桌面一致，不是 ShortMax 那种按视口裁剪的轮播，故不必同源重取）。
   * 同一张卡里有 2~3 个指向同一作品的链接（封面 / 标题 / 按钮），按 kind+slug 归并；
   * 标题取 aria-label（三个链接都带，比 textContent 稳——封面链接的文本是空的）。
   */
  function getPinedramaItems() {
    const wanted = pinedramaWantedSection();
    if (!wanted) return [];
    const section = pinedramaSectionElement(document, wanted);
    if (!section) return [];

    const byKey = new Map();
    for (const { el: anchor, kind, slug } of pinedramaItemAnchors(section)) {
      const key = `${kind}:${slug}`;
      if (!byKey.has(key)) byKey.set(key, { kind, slug, title: '', poster: '' });
      const item = byKey.get(key);
      if (!item.title) item.title = String(anchor.getAttribute('aria-label') || anchor.textContent || '').trim();
      if (!item.poster) item.poster = pinedramaPosterFor(anchor, slug, section);
    }

    const items = [...byKey.values()];
    console.log(`[ShortScraping] PinesDramas 板块 ${wanted}: ${items.length} 条`);
    return items;
  }

  function extractPinedramaFromItem(item, index, tags, pdId) {
    // genres 与简介都由 fetchPinedramaDetail 从详情页补
    return createDramaCard('pinedrama', pdId, index, tags, {
      title: String(item.title || '').trim(),
      // 站点卡片同款缩略图（200×270 ≈7.8KB）原样存；推送侧由 lark.js 的 posterForPayload
      // 剥掉 !<数字>.webp 尾缀取原图（960×1478 ≈213KB），同 DramaBox 范式
      poster: String(item.poster || '').trim(),
      url: `${PINEDRAMA_ORIGIN}/${item.kind === 'drama' ? 'dramas' : 'novels'}/${item.slug}`
    });
  }

  /**
   * 简介的最小长度。**这道闸门是必需品不是调优**：小说详情页的正文块旁边还有一个移动端
   * 「Read More」行，该作品没有简介时它就是块内最长的叶子文本，不设下限会把 'Read More'
   * 当简介存进库（unit-pinedrama-sections D3 钉着）。真机实测简介 350~700 字符，
   * 取 40 与两边都拉开数量级；短剧那条路同时靠它判断「爬到哪一层才是正文」。
   */
  const PINEDRAMA_MIN_SUMMARY = 40;

  /** 子树内**最长的那个叶子 div** 的文本（同 Shortical「简介取最长的 <p>」范式）。 */
  function pinedramaLongestLeafText(root) {
    let best = '';
    for (const node of root.querySelectorAll('div')) {
      if (node.children.length) continue;
      const text = String(node.textContent || '').trim();
      if (text.length > best.length) best = text;
    }
    return best;
  }

  /**
   * 小说详情简介：<h2>{标题} Summary</h2> 那一块里的正文。同块内还有一个空的渐变遮罩
   * 与移动端「Read More」行，故取最长叶子而不是「第一个 div」——后者依赖节点顺序，
   * 站点调一下版就错。og:description 是 SEO 模板文案（「…Read free on PineDrama.」），不可用。
   */
  function pinedramaNovelSummary(doc) {
    const heading = Array.from(doc.querySelectorAll('h2'))
      .find(h => /\bSummary$/.test(String(h.textContent || '').trim()));
    if (!heading || !heading.parentElement) return '';
    const text = pinedramaLongestLeafText(heading.parentElement);
    return text.length >= PINEDRAMA_MIN_SUMMARY ? text : '';
  }

  /**
   * 短剧详情简介：该页**没有** Summary 标题，正文是 h1 所在 hero 块里的一个叶子 div。
   * 从 h1 逐层向上爬、取第一个出现成段文本的层级（真机在第 3 层）。
   * og:description 同样是 SEO 模板（「…Stream the top mini series… Watch now!」）。
   */
  function pinedramaDramaSummary(doc) {
    const h1 = doc.querySelector('h1');
    if (!h1) return '';
    let node = h1;
    for (let i = 0; i < 4; i++) {
      node = node.parentElement;
      if (!node) break;
      const text = pinedramaLongestLeafText(node);
      if (text.length >= PINEDRAMA_MIN_SUMMARY) return text;
    }
    return '';
  }

  /**
   * 详情页的官方多值标签（2~4 个；列表卡上只印 1 个）。两类页同一个位置——h1 的父节点，
   * 该作用域恰好只含本条目自己的标签，页面下方相关推荐里的同类链接不在内。
   */
  function pinedramaDetailGenres(doc, isDrama) {
    const h1 = doc.querySelector('h1');
    const scope = h1 && h1.parentElement;
    if (!scope) return [];
    const selector = isDrama ? 'a[href*="/genres/"]' : 'a[href*="/novels/category/"]';
    return Array.from(scope.querySelectorAll(selector)).map(a => String(a.textContent || '').trim());
  }

  /**
   * 详情页（同源 fetch，不经后台代理）。列表卡片**简介覆盖不全**——Popular Novels 与
   * Popular Short Dramas 压根没有简介，另两个板块的短 blurb 与详情页 Summary 又是两段
   * 不同文案（2026-09-18 用户定：22 条一律取详情，统一口径）。
   * **失败一律返回 null 跳过该卡**（理由同 AppleTV/ShortMax：简介只有详情页这一个来源，
   * 存量回填只补 genres 不补简介，存下无简介的卡就永远自愈不了）。
   */
  async function fetchPinedramaDetail(drama) {
    if (!drama.url) return null;

    const html = await fetchServerHtml(drama.url);
    if (html === null) {
      console.warn(`[ShortScraping] PinesDramas 详情取不到（跳过，下轮重试）: ${drama.title}`);
      return null;
    }
    const doc = parseHtmlDocument(html);
    if (!doc) {
      console.warn(`[ShortScraping] PinesDramas 详情解析失败（跳过，下轮重试）: ${drama.title}`);
      return null;
    }

    const isDrama = drama.url.includes('/dramas/');
    const description = isDrama ? pinedramaDramaSummary(doc) : pinedramaNovelSummary(doc);
    if (!description) {
      console.warn(`[ShortScraping] PinesDramas 详情无简介（跳过，下轮重试）: ${drama.title}`);
      return null;
    }

    drama.description = description;
    const genres = cleanGenres(pinedramaDetailGenres(doc, isDrama));
    if (genres.length) drama.genres = genres;

    console.log(`[ShortScraping] PinesDramas 详情: ${drama.title} | 类型: ${drama.genres.join(', ')}`);
    return drama;
  }

  /* ——— Higgsfield（higgsfield.ai，v1.7.2）—————————————————————————————— */

  const HIGGSFIELD_ORIGIN = 'https://higgsfield.ai';
  // 与页面自己发的请求一致：order=curated、limit=100、第一页（现有 36 部，远不到一页；
  // 站点点「Load more」才翻页，这里同样只取第一页）
  const HIGGSFIELD_SERIES_API = 'https://fnf-api-gw.higgsfield.ai/fnf-series/series?order=curated&limit=100&offset=0';
  const HIGGSFIELD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  /**
   * 板块筛选规则（coming soon 在此之前已统一排除）。all 是整页、不带 ?list= 时的默认：不再筛——
   * 三个板块的并集恰好就是全部已上线作品。另外三个供单订某个板块，**照抄站点前端**（2026-09-27
   * 读自页面 JS），按作品的 categories[].slug 分：Choice 与 First Look 各认自己的分类，两者可重叠
   * （实测 16 部与 10 部里重叠 2 部，全局去重先到先得）；On Our Radar 是**剩余项**——前两个
   * 分类都不含的已上线作品。它与后台叫 on-our-radar 的那个分类（同一接口网关 /home 里的分组，
   * 实测 10 部、一半同时在精选里）不是一回事，别改成按那个分类筛。
   */
  const HIGGSFIELD_SECTIONS = {
    all: () => true,
    higgsfield_choice: slugs => slugs.includes('higgsfield-choice'),
    first_look: slugs => slugs.includes('first-look'),
    on_our_radar: slugs => !slugs.includes('higgsfield-choice') && !slugs.includes('first-look')
  };

  /**
   * 封面存站内卡片同款缩略图：站点自己的缩放代理 images.higgs.ai，参数照抄其 srcset 的 384w 档
   * （竖版 384×512 / 384×683，≈40KB）。不直接存 portrait_url：已上线 29 部里 24 部是 1080×1920 的
   * _optimized.webp（0.1~1MB），另 5 部没有优化档、就是 png/jpg 原图（1.1~9.7MB），而弹窗封面不懒加载。
   * 推送侧由 lark.js 的 posterForPayload 换成同一代理的 1080 宽档（不解包成 CloudFront 原图，理由同上）
   * ——成对，勿只改一边。
   */
  function higgsfieldThumb(raw) {
    return `https://images.higgs.ai/?default=1&output=webp&url=${encodeURIComponent(raw)}&w=384&q=85`;
  }

  /**
   * 当前订阅页的作品：一次请求拿全部作品，排除 coming soon，再按 ?list= 选中的板块规则筛（整页不筛）。
   * 板块参数无效或未知时不发请求；接口失败、响应形态不对一律返回空数组（scrapePage 安全跳过、下轮重试）。
   */
  async function getHiggsfieldItems() {
    const section = readListParam('all');
    if (!section) return [];
    const inSection = HIGGSFIELD_SECTIONS[section];
    if (!inSection) {
      console.log(`[ShortScraping] Higgsfield 板块未找到: ${section}`);
      return [];
    }

    let payload;
    try {
      // 不带自定义请求头：保持简单请求，免 CORS 预检
      const response = await fetchWithTimeout(HIGGSFIELD_SERIES_API);
      if (!response.ok) {
        console.log(`[ShortScraping] Higgsfield 接口 HTTP ${response.status}，本页跳过`);
        return [];
      }
      payload = await response.json();
    } catch (e) {
      console.log('[ShortScraping] Higgsfield 接口请求失败:', e.message);
      return [];
    }

    const items = payload && Array.isArray(payload.items) ? payload.items : null;
    if (!items) {
      console.log('[ShortScraping] Higgsfield 接口响应缺 items 数组，本页跳过');
      return [];
    }
    return items.filter(item => {
      if (!item || typeof item !== 'object' || item.state === 'coming_soon') return false;
      const slugs = (Array.isArray(item.categories) ? item.categories : [])
        .map(category => category && category.slug)
        .filter(Boolean);
      return inSection(slugs);
    });
  }

  /**
   * 从接口条目提取基础信息。作品地址用站点自己的播放页形态 /original-series/<slug>/<首集 slug>
   * （页面 canonical 同形，29/29 实测 200；/original-series/<slug> 本身是 404），剧集型作品落在第 1 集。
   * 没有分集的条目（coming soon 形态）没有播放页，返回 null 跳过。
   * 标题与简介折叠空白：站点数据里有尾空格（"MORK "）和句中硬换行（ZEPHYR 的简介）。
   * 简介取 full_description（多数比 short_description 长一截），缺了退 short。
   */
  function extractHiggsfieldFromItem(item, index, tags, hfId) {
    const slug = typeof item.slug === 'string' ? item.slug : '';
    const firstEpisode = Array.isArray(item.episodes) ? item.episodes[0] : null;
    const episodeSlug = firstEpisode && typeof firstEpisode.slug === 'string' ? firstEpisode.slug : '';
    if (!slug.trim() || !episodeSlug.trim()) {
      console.log(`[ShortScraping] Higgsfield 条目没有播放页地址，跳过: ${item.name || hfId}`);
      return null;
    }
    const text = value => String(value || '').replace(/\s+/g, ' ').trim();
    const cover = String(item.portrait_url || item.landscape_url || '').trim();

    return createDramaCard('higgsfield', hfId, index, tags, {
      title: text(item.name),
      poster: cover ? higgsfieldThumb(cover) : '',
      genres: [],
      description: text(item.full_description) || text(item.short_description),
      // slug 原样编码、不 trim：与站点自己的链接构造器同形
      url: `${HIGGSFIELD_ORIGIN}/original-series/${encodeURIComponent(slug)}/${encodeURIComponent(episodeSlug)}`
    });
  }

  /**
   * 反转义 JS 单引号字符串字面量的内容（Netflix 内联脚本把 JSON 文本包在
   * JSON.parse('…') 里：裸 " 不转义，只见 \\ \' \uXXXX；标题页还有 \x20 形态）。
   * 只处理反斜杠转义序列，不 eval。
   */
  function decodeJsStringLiteral(body) {
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
    return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, esc) => {
      if (esc.length === 5 && esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (esc.length === 3 && esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
      return Object.prototype.hasOwnProperty.call(simple, esc) ? simple[esc] : esc;
    });
  }

  /**
   * 读取 Netflix 页面内联的 Apollo 归一化缓存：定位
   * `netflix.reactContext.models.graphql = JSON.parse('` 到收尾 `');` 之间的字面量，
   * 反转义后 JSON.parse，返回其 data 对象；缺失/坏数据返回 null。
   */
  function readNetflixGraphql(doc = document) {
    const head = /netflix\.reactContext\.models\.graphql\s*=\s*JSON\.parse\('/;
    for (const script of doc.querySelectorAll('script')) {
      const text = script.textContent || '';
      const m = head.exec(text);
      if (!m) continue;
      const start = m.index + m[0].length;
      const end = text.lastIndexOf("');");
      if (end <= start) continue;
      try {
        const parsed = JSON.parse(decodeJsStringLiteral(text.slice(start, end)));
        if (parsed && parsed.data && typeof parsed.data === 'object') return parsed.data;
      } catch (e) {
        console.warn('[ShortScraping] Netflix graphql 脚本解析失败:', e.message);
      }
    }
    return null;
  }

  /**
   * Netflix Top 10 榜单条目：取 guid 为 top-10-card-list 的节（无则 top-10-table 副本），
   * 按 entities[].__ref 解引用为 PulseTop10ItemEntity 数组。定位失败返回空数组
   * （scrapePage 安全跳过）；条目形态守卫交给 extractId。
   */
  function getNetflixTop10Items() {
    const data = readNetflixGraphql();
    if (!data) {
      console.log('[ShortScraping] Netflix graphql 数据未找到');
      return [];
    }
    const sections = Object.values(data).filter(v => v && v.__typename === 'PulseEntitiesSection');
    const section = sections.find(s => s.guid === 'top-10-card-list') || sections.find(s => s.guid === 'top-10-table');
    if (!section || !Array.isArray(section.entities)) {
      console.log('[ShortScraping] Netflix Top 10 榜单数据未找到');
      return [];
    }
    return section.entities
      .map(ref => (ref && typeof ref.__ref === 'string' ? data[ref.__ref] : null))
      .filter(item => item && typeof item === 'object');
  }

  /**
   * artwork 各图（storyArt/sdpArt/logoArt）的取图键形如 urlsSized({"sizes":…})，
   * 按前缀查找取首个 url；缺失返回 ''。
   */
  function netflixArtUrl(art) {
    if (!art || typeof art !== 'object') return '';
    const key = Object.keys(art).find(k => k.startsWith('urlsSized'));
    const first = key && Array.isArray(art[key]) ? art[key][0] : null;
    return first && typeof first.url === 'string' ? first.url.trim() : '';
  }

  /**
   * 从榜单条目提取基础信息。封面优先 storyArt（1200×675 横版 ≈130KB，URL 无逗号/
   * 百分号，Lark 链接转附件可直接转换）退化 sdpArt（390×219）；标题取 top10Video.title
   * （剧集自带季名，如 "The Gentlemen: Season 2"），缺失时用 parentShow.title + 季号拼接；
   * url 仅凭 videoId 构造 /title/ 页（displayVideo.titlePageSlug 可为 null，不可依赖）。
   */
  function extractNetflixFromItem(item, index, tags, nfId) {
    const video = item.top10Video || {};
    const parentTitle = video.parentShow && typeof video.parentShow.title === 'string' ? video.parentShow.title.trim() : '';
    const fallbackTitle = parentTitle
      ? (video.number != null ? `${parentTitle}: Season ${video.number}` : parentTitle)
      : nfId;
    const artwork = item.artwork || {};
    // 榜单数据无内容类型字段，genres 留空（fetchNetflixDetail 补）
    return createDramaCard('netflix', nfId, index, tags, {
      title: (typeof video.title === 'string' && video.title.trim()) || fallbackTitle,
      poster: netflixArtUrl(artwork.storyArt) || netflixArtUrl(artwork.sdpArt),
      description: typeof video.shortSynopsis === 'string' ? video.shortSynopsis.trim() : '',
      url: `https://www.netflix.com/title/${nfId.slice(2)}`
    });
  }

  /**
   * Netflix 详情（v1.5.9）：/title/<videoId> 页只为补 genres——榜单数据无类型字段。
   * 页面有两个随机变体（`netflix.reactContext.models.graphql` 缓存有数据 / 为空），
   * 两者都含根对象 `netflix.reactContext = {…}`（JS 对象字面量、字符串用 \xHH 转义）→
   * models.nmTitleGQL.data.genreInfo.coreGenre.name[].name 即 Netflix 自身简洁类型
   * （Thrillers / Dramas / Comedies / Kids / Documentaries…），电影/剧集/非英语/授权片均有；
   * 季 id 会 301 到剧集页，genres 同样可取。一律经后台代理取页：Tudum 页同源直连会带
   * 用户 Netflix 登录 cookie（登录态页面形态不同），SW fetch 无 cookie，且代理对 netflix
   * 规则强制 Accept-Language 英文（coreGenre 名随请求头本地化）。标题/简介仍以榜单为准；
   * 任何失败保留空数组，榜单复现时经 maybeBackfillGenres 自愈。就地写 drama.genres
   * （回填路径忽略返回值、只看 drama.genres）。
   */
  async function fetchNetflixDetail(drama) {
    if (!drama.url) return drama;

    try {
      const html = await fetchDetailHtmlViaBackground(drama.url);
      if (html === null) return drama;

      const doc = parseHtmlDocument(html);
      if (!doc) return drama;
      const root = readNetflixReactContext(doc);
      const data = root && root.models && root.models.nmTitleGQL ? root.models.nmTitleGQL.data : null;
      const coreGenre = data && data.genreInfo ? data.genreInfo.coreGenre : null;
      const names = coreGenre && Array.isArray(coreGenre.name) ? coreGenre.name.map(g => g && g.name) : [];
      const genres = cleanGenres(names);
      if (genres.length) drama.genres = genres;

      console.log(`[ShortScraping] Netflix 详情: ${drama.title} | 类型: ${genres.length ? genres.join(', ') : '无'}`);
    } catch (e) {
      console.warn(`[ShortScraping] Netflix 详情失败（保留榜单数据）: ${drama.title}`, e.message);
    }

    return drama;
  }

  /**
   * 读取 Netflix 页面根对象 `netflix.reactContext = {…}`：JS 对象字面量，字符串内特殊
   * 字符以 \xHH 转义（JSON 不认），逐个转义序列归一——\xHH → 等价的 \u00HH、\' → '，
   * 其余（\\ \" \uXXXX \n…）原样保留——后 JSON.parse。取首个 { 到该 script 最后一个 }
   * （字面量以 `};` 收尾、其后无其它内容）。不匹配 `netflix.reactContext.models.graphql =`
   * 那段（点号后不是等号）。缺失/坏数据返回 null。
   */
  function readNetflixReactContext(doc = document) {
    const head = /netflix\.reactContext\s*=\s*\{/;
    for (const script of doc.querySelectorAll('script')) {
      const text = script.textContent || '';
      const m = head.exec(text);
      if (!m) continue;
      const start = m.index + m[0].length - 1;
      const end = text.lastIndexOf('}');
      if (end <= start) continue;
      try {
        const json = text.slice(start, end + 1).replace(/\\(x[0-9a-fA-F]{2}|[\s\S])/g, (whole, esc) => {
          if (esc.length === 3 && esc[0] === 'x') return `\\u00${esc.slice(1)}`;
          return esc === "'" ? "'" : whole;
        });
        return JSON.parse(json);
      } catch (e) {
        console.warn('[ShortScraping] Netflix reactContext 解析失败:', e.message);
      }
    }
    return null;
  }

  /**
   * 读取 Apple TV 页面 SSR 直出的 `<script type="application/json" id="serialized-server-data">`
   * （纯 JSON，直接 JSON.parse）。根形如 `{ data: [ {intent, data}, … ] }`——第一条恒为
   * UtsConfigureIntent（配置，无 shelves），页面数据在带 shelves 的那条（榜单页是
   * CollectionPageIntent、详情页是 ShowPageIntent / MoviePageIntent）。**按「有 shelves 数组」
   * 挑而不是按 intent 名挑**：Apple 给电影/剧集用不同 intent 名，白名单会漏。
   * 缺脚本 / 坏 JSON / 无 shelves 一律返回 null（调用方安全跳过），不抛。
   */
  function readAppleServerData(html) {
    const text = String(html || '');
    const m = /<script[^>]*id="serialized-server-data"[^>]*>/.exec(text);
    if (!m) return null;
    const start = m.index + m[0].length;
    const end = text.indexOf('</script>', start);
    if (end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end));
      const list = parsed && Array.isArray(parsed.data) ? parsed.data : [];
      return list.map(d => d && d.data).find(d => d && Array.isArray(d.shelves)) || null;
    } catch (e) {
      console.warn('[ShortScraping] Apple serialized-server-data 解析失败:', e.message);
      return null;
    }
  }

  /**
   * 取榜单页的 10 个条目：经后台代理拿 HTML（理由见 appletvAdapter 注释），
   * 页面只有一个 shelf（uts.col.Charts…），直接取 shelves[0].items。
   * 代理失败 / 解析失败返回空数组，scrapePage 安全跳过、下轮重试。
   */
  async function fetchAppleListItems(url) {
    const html = await fetchDetailHtmlViaBackground(url);
    if (html === null) {
      console.log('[ShortScraping] Apple 榜单页代理请求失败');
      return [];
    }
    const page = readAppleServerData(html);
    const shelf = page && page.shelves[0];
    if (!shelf || !Array.isArray(shelf.items)) {
      console.log('[ShortScraping] Apple 榜单数据未找到');
      return [];
    }
    return shelf.items.filter(item => item && typeof item === 'object');
  }

  /**
   * artwork.template 形如 `https://is1-ssl.mzstatic.com/image/thumb/<hash>/{w}x{h}nr.{f}`，
   * mzstatic 按请求尺寸裁切（源图是 1680×3636 超长版），取 400×600 标准 2:3 竖版海报
   * （≈66KB，弹窗小卡够用且省流量；URL 无逗号/百分号，Lark「链接转附件」可直接转）。
   * 裁切码（nr/sr/bb…）原样保留，只替换三个占位符。
   * 推送出去时由 lark.js 的 posterForPayload 把尾段尺寸码提到 1200×1800（v1.6.4，
   * 满宽卡片上 400 宽偏软），故这里存小图、那里放大，两边不要互相跟随。
   */
  function appleArtUrl(template) {
    const t = typeof template === 'string' ? template.trim() : '';
    if (!t) return '';
    return t.replace('{w}', '400').replace('{h}', '600').replace('{f}', 'jpg');
  }

  /**
   * 从榜单条目提取基础信息。genres 先填榜单的单个 caption 作兜底（同 ReelShort 的 theme），
   * 详情成功后被 About 节的官方多值 genres 覆盖；url 取 contextAction.url 去掉 query
   * （原值带 ?ctx_agid=…，代理白名单只认无 query 的规范形态，与 mydrama 同约定）。
   */
  function extractAppleFromItem(item, index, tags, atId) {
    const detailUrl = String((item.contextAction && item.contextAction.url) || '').split('?')[0].trim();
    // 榜单数据无简介，留空由详情页补
    return createDramaCard('appletv', atId, index, tags, {
      title: (typeof item.title === 'string' && item.title.trim()) || atId.slice(2),
      poster: appleArtUrl(item.artwork && item.artwork.template),
      genres: cleanGenres([item.caption]),
      url: detailUrl
    });
  }

  /**
   * Apple 详情（/us/show|movie/<slug>/umc.cmc.…）：`About` 节里 $kind 为 AboutReviewCard
   * 的那条同时给出 `description`（完整英文简介）与 `genres`（2~3 个官方类型）。
   *
   * **失败返回 null＝跳过该卡、下轮重试**，不同于 IMDB/ReelShort 的「保留列表页数据」：
   * 简介只有详情页这一个来源，而存量回填只补 genres 不补简介（maybeBackfillGenres +
   * 后台 saveDramaRecord 的合并口径），一旦存下无简介的卡就永远自愈不了。
   * 注意回填路径忽略返回值、只看就地改写的 drama.genres，故两者都写。
   */
  async function fetchAppleDetail(drama) {
    if (!drama.url) return null;

    try {
      const html = await fetchDetailHtmlViaBackground(drama.url);
      if (html === null) {
        console.warn(`[ShortScraping] Apple 详情代理失败（跳过，下轮重试）: ${drama.title}`);
        return null;
      }

      const page = readAppleServerData(html);
      const about = page && page.shelves.find(s => s && s.$type === 'About');
      const card = about && Array.isArray(about.items)
        ? about.items.find(i => i && i.$kind === 'AboutReviewCard')
        : null;
      const description = card && typeof card.description === 'string' ? card.description.trim() : '';
      if (!description) {
        console.warn(`[ShortScraping] Apple 详情无简介（跳过，下轮重试）: ${drama.title}`);
        return null;
      }

      drama.description = description;
      const genres = cleanGenres(card.genres);
      if (genres.length) drama.genres = genres;

      console.log(`[ShortScraping] Apple 详情: ${drama.title} | 类型: ${drama.genres.join(', ')}`);
      return drama;
    } catch (e) {
      console.warn(`[ShortScraping] Apple 详情异常（跳过，下轮重试）: ${drama.title}`, e.message);
      return null;
    }
  }

  /**
   * 获取单个剧集详情
   */
  async function fetchImdbDetail(drama) {
    if (!drama.url) return drama;

    try {
      const doc = await fetchServerDocument(drama.url);
      if (!doc) return drama;

      // 提取简介
      drama.description = extractDescription(doc);

      // 提取内容类型标签（JSON-LD genre）；为空保留列表页占位空数组
      const genres = extractJsonLdGenres(doc);
      if (genres.length) drama.genres = genres;

      // 不从详情页补封面：详情页可能返回剧照、视频缩略图或推荐图，容易误当成封面。
      // 封面只信任搜索结果列表中的海报容器；没有则使用默认占位图。

      console.log(`[ShortScraping] 详情: ${drama.title} | 封面: ${drama.poster ? '有' : '无'}`);
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
   * 提取内容类型标签：详情页 JSON-LD 的 genre 字段（可能是数组或单字符串，
   * 归一成数组）。兼容三种根形态：单对象（IMDB）、对象数组、含 @graph 图谱
   * （MyDrama：genre 在 @graph 里的 VideoObject 节点上）。页面可能有多个
   * ld+json 块，取第一个 genre 清洗后非空的节点；坏 JSON 块跳过。
   */
  function extractJsonLdGenres(doc) {
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const ld = JSON.parse(script.textContent || '');
        const roots = Array.isArray(ld) ? ld : [ld];
        const nodes = roots.flatMap(n => (n && Array.isArray(n['@graph'])) ? [n, ...n['@graph']] : [n]);
        for (const node of nodes) {
          const g = node && node.genre;
          if (!g) continue;
          const genres = cleanGenres(Array.isArray(g) ? g : [g]);
          if (genres.length) return genres;
        }
      } catch (e) {
        // 单块坏数据跳过，继续找下一块
      }
    }
    return [];
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
