/**
 * IMDb 条目「搜平台」的查找与判定（v1.7.3）：给一部 IMDb 平台榜上的剧（平台由
 * SiteRegistry.imdbPlatformOf 按出品公司反查），在该平台的站内搜索页或站点地图里找同名剧，
 * 判定能不能直达播放页。
 *
 * 只放纯函数（解析 / 比对 / 判定），不碰 chrome.* / DOM / 网络——取数、缓存、回写 playUrl 与
 * 开标签页都在后台 background.js（resolvePlatformLink）。SW 没有 DOMParser，解析一律正则：
 * Next.js 站点取 __NEXT_DATA__ 的 JSON，其余从页内链接或 sitemap 的 <loc> 里取。
 *
 * 判定规则（2026-09-28 用户定）：候选里与片名「完全同名」（比对键相同）的恰好 1 部 → 播放页；
 * 2 部及以上 → 交给调用方开搜索结果页，不替用户挑；0 部同样开搜索结果页。网页端没有搜索页的
 * 平台（MyDrama / Shortical / NetShort）由调用方按「没找到」处理。
 *
 * 各站取数方式（2026-09-28 逐站实测，抽样命中：ReelShort 12/12、DramaBox 10/12、GoodShort 7/8、
 * MyDrama 11/12、Shortical 12/12）：
 *   reelshort   搜索页 __NEXT_DATA__.books[]；播放页 /episodes/episode-1-<slug>-<book_id>-<章节>，
 *               slug 取页内卡片链接 /movie/<slug>-<book_id>（站点自己的写法）
 *   dramabox    搜索页 __NEXT_DATA__.bookList[]；地址与抓取卡同形态 dramabox.com/drama/<bookId>/<slug>
 *   goodshort   搜索页里的 /drama/<slug>-<id> 链接按 slug 比对，播放页取同一部的第 1 集 /episode/ 链接
 *   dramashorts 搜索页 __NEXT_DATA__.searchMovies[]；播放页 /shorts/<UUID>
 *   flickreels  搜索页里的 /playlist/<slug>/<id>/episode-1 链接（slug 由站点校验，原样用）
 *   mydrama     站点地图 sitemap-series.xml 的 /series/<slug>-<UUID>；该 UUID 就是播放页 /video/<UUID>
 *   shortical   站点地图 sitemaps/series.xml（ScrapeRules.parseShorticalSitemap 的规范 slug）
 *   shortmax / netshort 不联网：ShortMax 搜一次约 15 秒且常搜不到，NetShort 网页端只有加密接口；
 *               两家只看库里平台自己的榜单抓到过的同名卡（localCandidates）
 *
 * 加载方式：后台 importScripts（排在 site-registry.js / scrape-rules.js 之后）；Node 测试 require。
 */
(function (global) {
  'use strict';

  /**
   * 片名比对键：去重音 → 小写 → 去掉一切非字母数字。实测 IMDb 与各平台的写法差异都落在这一层：
   * 弯/直引号（Don’t / Don't）、标点（Mr.April / Mr April、Queen Bee, I'm）、空格（Black Out /
   * Blackout）、slug 的连字符（i-don-t-need）。结果为空（中日韩等非拉丁片名）视为不可比对。
   */
  function squashTitle(text) {
    return String(text || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  // 一段片名 / slug 的全部比对键：& 既可能被写成 and（片名），也可能被直接丢掉（slug），两种都算
  function keysOf(text) {
    const raw = String(text || '');
    const keys = new Set([squashTitle(raw.replace(/&/g, ' and ')), squashTitle(raw.replace(/&/g, ' '))]);
    keys.delete('');
    return keys;
  }

  // IMDb 片名的比对键：原片名 + 去掉末尾括号注释的版本（与 SiteRegistry.platformSearchQuery 同口径）
  function titleKeys(title) {
    const keys = keysOf(title);
    const registry = global.SiteRegistry;
    if (registry && typeof registry.platformSearchQuery === 'function') {
      for (const key of keysOf(registry.platformSearchQuery(title))) keys.add(key);
    }
    return keys;
  }

  /**
   * 判定。candidates 为 [{ key, url }]（key＝站上片名或 slug；url＝该剧播放页，拼不出为 null），
   * 同一部剧在页内出现多次（封面链接 + 标题链接）由各解析器按站内 id 去重。
   * 与片名同名的恰好 1 部且 url 合法（isValidUrl 可选）→ { kind: 'play', url }；2 部及以上 →
   * { kind: 'ambiguous', count }；否则 { kind: 'none' }——唯一命中却拼不出合法地址也算 none：
   * 宁可落到搜索页，也不跳一个不确定的地址。
   */
  function decide(title, candidates, isValidUrl) {
    const wanted = titleKeys(title);
    if (!wanted.size) return { kind: 'none' };
    const hits = (Array.isArray(candidates) ? candidates : []).filter(candidate => {
      for (const key of keysOf(candidate && candidate.key)) {
        if (wanted.has(key)) return true;
      }
      return false;
    });
    if (hits.length > 1) return { kind: 'ambiguous', count: hits.length };
    const url = hits.length === 1 ? hits[0].url : null;
    if (typeof url === 'string' && url && (typeof isValidUrl !== 'function' || isValidUrl(url))) {
      return { kind: 'play', url };
    }
    return { kind: 'none' };
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function safeDecode(text) {
    try {
      return decodeURIComponent(text);
    } catch (e) {
      return text;
    }
  }

  // Next.js 页面的 pageProps；页面里没有 __NEXT_DATA__ 或 JSON 坏了返回 null
  function nextPageProps(html) {
    const json = (String(html || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) || [])[1];
    if (!json) return null;
    try {
      const data = JSON.parse(json);
      return (data && data.props && data.props.pageProps) || null;
    } catch (e) {
      return null;
    }
  }

  /*
   * 各站解析器：页面认不出（被拦截的验证码页、改版后没了约定的数据）返回 null，由调用方按
   * 「查找失败」处理；认得出但没有结果返回 []。
   */

  // 与 content.js slugifyTitle 同口径：ReelShort 只认结尾的 id，slug 写错站点会 301 到规范地址
  function slugifyTitle(title) {
    return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function parseReelshortSearch(html) {
    const props = nextPageProps(html);
    if (!props || !Array.isArray(props.books)) return null;
    const text = String(html);
    return props.books.map(book => {
      const bookId = String((book && book.book_id) || '').trim();
      if (!/^[0-9a-f]{24}$/.test(bookId)) return { key: book && book.book_title, url: null };
      const start = (book && book.start_play) || {};
      const chapterId = String(start.chapter_id || book.first_chapter_id || '').trim();
      // slug 优先取页内卡片链接 /movie/<slug>-<book_id>（撇号转连字符这类细节按站点自己的写法），
      // 取不到退回按片名拼的（错 slug 站点 301 规范化）
      const linked = (text.match(new RegExp(`/movie/([^"'/?#\\s<>]+)-${bookId}(?=["'?#/<\\s])`)) || [])[1];
      const slug = linked || slugifyTitle(book.book_title) || 'x';
      return {
        key: book.book_title,
        // 第一集播放页的章节尾缀必须带（缺了 404）；没有章节号就退到剧目页（页上有播放入口）
        url: /^[0-9a-z]+$/i.test(chapterId)
          ? `https://www.reelshort.com/episodes/episode-1-${slug}-${bookId}-${chapterId}`
          : `https://www.reelshort.com/movie/${slug}-${bookId}`
      };
    });
  }

  function parseDramaboxSearch(html) {
    const props = nextPageProps(html);
    if (!props || !Array.isArray(props.bookList)) return null;
    if (props.isEmpty === true) return [];
    return props.bookList.map(book => {
      const bookId = String((book && book.bookId) || '').trim();
      // slug 是装饰位（错 slug 照样回 200 真页面），须编码——与 content.js extractDramaboxFromItem 同形态
      const slug = String((book && (book.replacedBookName || book.bookNameEn)) || '').trim();
      return {
        key: book && book.bookName,
        url: /^\d+$/.test(bookId)
          ? `https://www.dramabox.com/drama/${bookId}${slug ? `/${encodeURIComponent(slug)}` : ''}`
          : null
      };
    });
  }

  function parseGoodshortSearch(html) {
    const text = String(html || '');
    // 正常页面必带 __INITIAL_STATE__；没有就是拦截页 / 改版
    if (!/__INITIAL_STATE__/.test(text)) return null;
    const byId = new Map();
    for (const match of text.matchAll(/\/drama\/([a-z0-9%-]+?)-(\d{6,})(?=["'?#/<\s])/gi)) {
      const [, slug, id] = match;
      if (byId.has(id)) continue;
      const episode = (text.match(new RegExp(`/episode/${escapeRegExp(slug)}-${id}/\\d+-\\d+`, 'i')) || [])[0];
      byId.set(id, {
        key: safeDecode(slug),
        url: `https://www.goodshort.com${episode || `/drama/${slug}-${id}`}`
      });
    }
    return [...byId.values()];
  }

  function parseDramashortsSearch(html) {
    const props = nextPageProps(html);
    if (!props || !Array.isArray(props.searchMovies)) return null;
    return props.searchMovies.map(movie => {
      const id = String((movie && movie.id) || '').trim();
      return {
        key: movie && movie.title,
        url: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
          ? `https://dramashorts.io/shorts/${id}`
          : null
      };
    });
  }

  function parseFlickreelsSearch(html) {
    const text = String(html || '');
    if (!/__NUXT_DATA__|__NUXT__/.test(text)) return null;
    const byId = new Map();
    for (const match of text.matchAll(/\/playlist\/([^"'/?#\s<>]+)\/(\d+)\/(?:episode-1|full-movie)(?=["'?#<\s])/g)) {
      const [path, slug, id] = match;
      if (!byId.has(id)) byId.set(id, { key: safeDecode(slug), url: `https://www.flickreels.net${path}` });
    }
    return [...byId.values()];
  }

  function parseMydramaSitemap(xml) {
    const text = String(xml || '');
    if (!/<urlset/i.test(text)) return null;
    const byId = new Map();
    const pattern = /<loc>\s*https:\/\/my-drama\.com\/series\/([^<\s]+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*<\/loc>/gi;
    for (const match of text.matchAll(pattern)) {
      const id = match[2].toLowerCase();
      if (!byId.has(id)) byId.set(id, { key: safeDecode(match[1]), url: `https://my-drama.com/video/${id}` });
    }
    return [...byId.values()];
  }

  // 规范 slug 与抓取侧同一份解析（基名 → <基名>-<id>）；基名即片名 slug
  function parseShorticalSitemap(xml) {
    const text = String(xml || '');
    if (!/<urlset/i.test(text)) return null;
    const map = global.ScrapeRules.parseShorticalSitemap(text);
    return [...map.entries()].map(([base, slug]) => ({ key: safeDecode(base), url: `https://shortical.com/drama/${slug}` }));
  }

  // search＝按片名取 SiteRegistry.platformSearchUrl 那一页；sitemap＝取整份站点地图（后台缓存）
  const LOOKUPS = Object.freeze({
    reelshort: { kind: 'search', parse: parseReelshortSearch },
    dramabox: { kind: 'search', parse: parseDramaboxSearch },
    goodshort: { kind: 'search', parse: parseGoodshortSearch },
    dramashorts: { kind: 'search', parse: parseDramashortsSearch },
    flickreels: { kind: 'search', parse: parseFlickreelsSearch },
    mydrama: { kind: 'sitemap', url: 'https://my-drama.com/sitemap-series.xml', parse: parseMydramaSitemap },
    shortical: { kind: 'sitemap', url: 'https://shortical.com/sitemaps/series.xml', parse: parseShorticalSitemap }
  });

  /** 该平台的联网查找规格；ShortMax / NetShort（只查库内同名卡）与未知平台返回 null。 */
  function lookupOf(site) {
    return Object.prototype.hasOwnProperty.call(LOOKUPS, site) ? LOOKUPS[site] : null;
  }

  /**
   * 库内同名卡候选（ShortMax / NetShort）：平台自己的榜单抓到过的卡，url 已是抓取侧拼好的播放页。
   * 只收 source 为该平台、url 通过 isValidUrl 的卡。
   */
  function localCandidates(site, dramas, isValidUrl) {
    return (Array.isArray(dramas) ? dramas : [])
      .filter(drama => drama && drama.source === site && typeof drama.url === 'string'
        && (typeof isValidUrl !== 'function' || isValidUrl(drama.url)))
      .map(drama => ({ key: drama.title, url: drama.url }));
  }

  const api = {
    squashTitle, decide, lookupOf, localCandidates,
    parseReelshortSearch, parseDramaboxSearch, parseGoodshortSearch, parseDramashortsSearch,
    parseFlickreelsSearch, parseMydramaSitemap, parseShorticalSitemap
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.PlatformLink = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
