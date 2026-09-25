// 内容脚本单测共用的 chrome 桩片段（与 dom-fixture.mjs 并列；不以 unit- 开头，run.mjs 不把它当套件跑）。
//
// content.js 不再读写 chrome.storage（审查 storage-secrets-exposed-to-content / full-table-read-per-scrape）：
// 开轮时发 { action: 'getScrapeContext' } 向后台要抓取上下文，后台从 dramas 缓存算出
//   { success: true, urlTags, known: [[itemId, 库中是否已有 genres], ...] }
// （background.js scrapeContextForContent，形状由 unit-message-sender M2c 对真实后台守着）。
// 各内容脚本套件的 sendMessage 桩只需加一行、不必各自手写这份换算：
//   if (message?.action === 'getScrapeContext') return scrapeContextReply(store.dramas, subscriptions);
// 桩里刻意**不再提供 chrome.storage**：content.js 哪天又直连 storage，套件会当场 TypeError，
// 而不是悄悄读到桩数据照样通过。

/** 按后台同一口径，从桩库与订阅配置拼出 getScrapeContext 的应答（深拷贝，内容脚本改不到桩状态）。 */
export function scrapeContextReply(dramas = [], urlTags = []) {
  return {
    success: true,
    urlTags: structuredClone(Array.isArray(urlTags) ? urlTags : []),
    known: (Array.isArray(dramas) ? dramas : [])
      .filter(drama => drama && drama.itemId)
      .map(drama => [drama.itemId, Array.isArray(drama.genres) && drama.genres.length > 0])
  };
}
