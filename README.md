# ShortScraping - 爆款短剧监控助手

Chrome 浏览器插件：按你订阅的 URL 定时监控 IMDB、Steam、RoyalRoad、My Drama、ReelShort、DramaShorts、NetShort、FlickReels、GoodShort、Shortical、ShortMax、DramaBox、PinesDramas、Netflix、Apple TV 十五个平台的榜单/板块，新条目以时间线卡片展示，自动翻译为中文，并可经本地服务同步为 CSV、在局域网内只读共享。

适合谁：追踪海外短剧/游戏/网文热榜动向的编辑、制片、市场与数据同学——打开弹窗就能看到"最近各平台新上了什么"，无需逐站巡逻。

## ✨ 功能特性

- 🎬 **订阅式监控**：抓什么完全由 `config/tag.json` 的订阅 URL 决定，程序不内置任何默认订阅；每条订阅可配 1-3 个来源标签
- 📅 **时间线卡片**：新条目按抓取时间倒序分组展示（同日一组、±1 分钟合并），卡片含封面、标题、简介、来源标签与站点原生内容类型标签（如 Romance / Billionaire，英文原值；悬停查看全量，v1.5.3）
- 🌐 **翻译线**：卡片先以英文即时入库，随后按 `config/trans.json` 自动翻译为中文；平台自带官方中文的条目（Steam 中文详情、My Drama 本地化标题）直接采用、不再消耗翻译
- 🔁 **抓取节奏**：全量抓取由定时任务（cron 或固定间隔）执行；弹窗内再点一次已激活的站点图标可手动刷新该站点，完成后提示"本次新增 N 条"（定时全量抓取进行中、还没轮到该站时直接并入这一轮，不再排到整轮之后重抓一遍；定时触发撞上没跑完的上一轮时最多再排一轮，不再越积越多；v1.6.19）；全局按去重键防重复入库；页内每个请求 25 秒内未读完即放弃，单个订阅页 5 分钟内抓不完按失败跳过并关闭后台标签页，一个挂住的站点不再堵死后面的抓取（v1.6.16）
- 💾 **CSV 同步**：本地同步服务把时间线实时写入 `db/timeline.csv`（UTF-8 BOM + CRLF，Excel/WPS 直接打开；v1.5.3 起含 `genres` 内容类型标签列，`tags`/`genres` 多值以英文逗号分隔——v1.5.13 起，与 Lark 推送约定一致）
- 📡 **局域网共享**：同一局域网的手机/平板/电脑打开 `http://<本机IP>:31919/` 即可只读浏览时间线，数据更新经 SSE 自动刷新；链接显示在弹窗底栏（点击复制 + 二维码）。同步服务一启动就默认开放，不需要时用 `--local-only` 改为仅本机（见「局域网共享」）
- 🔔 **版本自检**：弹窗对比远端仓库 master 的 `manifest.json`，有新版本以橙色提示
- 🤖 **Lark 推送**：单卡按钮把条目 POST 到多维表格工作流 webhook；群机器人在条目翻译完成后自动推一张卡到飞书 / Lark 群（含卡片 `🌍` 单卡翻完的新卡，v1.6.19；可关；配置飞书自建应用凭据时附封面真图；新订阅 URL 的首轮抓取只入库不推送，避免刷屏）；推送失败的卡每分钟自动重试、最多 3 次，重试进行中新失败的卡照常排队，不丢也不重复推（v1.6.16）

## 🌍 支持站点

| 站点 | 订阅入口 | 取数方式 | 去重键 |
|------|----------|----------|--------|
| IMDB | 榜单/搜索页（`/search/title`、`/find`） | 列表 DOM + 详情页补简介与类型标签 | `tt` 编号 |
| Steam | 内容中心 `/category/<name>`、`/tags/<语言>/<标签名>` | 官方动态查询接口取列表 + `appdetails` 补英文详情 | appId |
| RoyalRoad | 榜单页 `/fictions/*` | 服务端渲染列表自带全文简介与标签，详情页只核对完整简介 | `rr`+数字 id |
| My Drama | 主站首页板块（`?list=<板块锚点>`）与 fandom 子域文章流/Trending 菜单 | Next.js SSR + hydrate 轮询 / WordPress SSR | `md`+UUID |
| ReelShort | 主站首页 TOP 板块与 `/fandom/` 文章流 | 页内 `__NEXT_DATA__` SSR 数据直出 / WordPress SSR | `rs`+book_id |
| DramaShorts | `/top-movies` 榜单与首页板块（`?list=<板块id>`） | 页内 `__NEXT_DATA__` 直出，无需请求详情页 | `ds`+UUID |
| NetShort | 首页板块（`?list=<板块名>`，如 `trending_now` / `exclusive_originals`） | 页内 RSC flight 数据直出，无需请求详情页 | `ns`+shortPlayId |
| FlickReels | 首页板块（`?list=<板块名>`，如 `hot_picks` / `7_day_star`；订阅须写 `https://www.flickreels.net/?list=…` 带 www） | 页内 Nuxt `__NUXT_DATA__`（devalue 扁平格式）SSR 直出，无需请求详情页 | `fr`+playlet_id |
| GoodShort | 板块「More」页 `/channel/<板块>`（`Most-Trending` / `Top-in-GoodShort` / `Hot-List`，各 10 条） | 同源重取服务端 HTML 解 `window.__INITIAL_STATE__`，列表字段齐全，无需请求详情页 | `gs`+sourceId |
| Shortical | 首页 Top Recommended 板块（`?list=top_recommended`，9 条；订阅须写裸域 `https://shortical.com/`） | 纯前端渲染，等 hydrate 后读 DOM；作品地址取站点 sitemap 的规范形态；内容类型标签尽力经官方接口补全量 | `sc`+规范 id |
| ShortMax | 首页板块（`?list=<板块名>`，如 `most_popular`）与 `/fandom` 文章流；订阅须带 www | 同源重取服务端 HTML 解析（实时 DOM 的轮播会按视口裁剪条目）+ 详情页补简介与类型标签 | `sm`+数字 id |
| DramaBox | 两个域名各 2 个板块列表页（各 18 条）：`dramabox.com/more/{must-sees,trending}` 与 `dramaboxdb.com/channel/{must-sees,trending}`；订阅须带 www | 页内 `__NEXT_DATA__` SSR 直出，无需请求详情页 | `db`+bookId |
| PinesDramas | `/novels` 的 Recommended（6 条）与 Popular Short Dramas（6 条）、首页的 Popular Novels（6 条）与 Editor's Pick（4 条），各按 `?list=<板块标题>` 订阅；订阅须写裸域 `https://pinedrama.com/` | 板块 SSR 直出、读页面 DOM；简介与类型标签均取自作品详情页 | `pdn`/`pdd`+slug |
| Netflix | Tudum Top 10 六个榜单页：`/tudum/top10`、`/tv`、`/films-non-english`、`/tv-non-english`、`/united-states`、`/united-states/tv` | 页内 `netflix.reactContext` 内联脚本 SSR 榜单数据直出；类型标签经后台代理取作品 `/title/` 页 | `nf`+videoId |
| Apple TV | Top 10 TV Shows 与 Top 10 Movies 两个榜单页（`/us/collection/most-popular-now/uts.col.Charts{Shows,Movies}.tvs.sbd.4000`） | 页内 `serialized-server-data` JSON SSR 直出榜单；简介与类型标签经后台代理取作品详情页 | `at`+`umc.cmc.` 编号 |

站点细节：

- **Steam**：成人专属/受限作品（接口 `success=false`）自动跳过；官方中文简介与英文不同时直接作为翻译结果。
- **My Drama / ReelShort / ShortMax 的 fandom 入口**：文章条目通过文中回主站的链接换取主站 id，与主站条目全局去重；换不到 id 的条目本轮不入库，待文章补上回链后下轮抓取自动重试。同一部剧只留一张卡，标签先到先得——已被主站板块抓到的剧不会再追加 `fandom` 标签。
- **DramaShorts**：首页板块 id 支持 `top_trending`（默认）/ `popular_now` / `audience_favorite`；板块内容每次请求轮换属站点自身行为，多轮定时抓取会逐步累积。规则目录当前未内置 `audience_favorite`（该板块为大池随机采样、单次重合度低），需要时可手动写入 `config/tag.json`。
- **Apple TV**：榜单即 Apple TV+ 自家的 Top 10，两条订阅分别对应剧集榜与电影榜（标签 `Apple, TV, US` / `Apple, Movie, US`）。榜单页本身不含简介，简介与内容类型标签由后台无 cookie 代理取作品详情页补齐，与你的 Apple TV+ 登录状态无关；某条详情取不到时该作品本轮不入库，下轮榜单复现时自动重来（避免留下永远补不上简介的卡）。内容脚本只注入这两个榜单页，不进 Apple TV 的播放/浏览页。**若抓取成片失败**：先检查本机代理/VPN 是否把 tv.apple.com 的 HTTP/3(QUIC) 流量分流到了非 Apple 边缘节点——那条路会一律返回 404，关闭 QUIC 或调整分流规则即可。
- **Netflix**：内容脚本只注入 `/tudum/top10*` 栏目页，不进 Netflix 播放/浏览页；同一作品同时上全球榜与美国榜时按作品全局去重、先到先得（订阅顺序全球榜在前，美国榜实际记录「上美国榜但未上全球榜」的作品）；标签约定 `Global`（英语榜）/ `Global-nE`（非英语榜）/ `US`；每周名次与观看量不入库，只记录首次进榜时间。内容类型标签取自作品 `/title/` 页 Netflix 自身分类（如 Thrillers / Dramas / Comedies，英文原值），由后台无 cookie 代理抓取，与你的 Netflix 登录状态无关；单次抓取失败的作品会在下轮榜单复现时自动补上。
- **FlickReels**：首页板块按标题归一化订阅（`Hot Picks` → `hot_picks`、`7-Day Star` → `7_day_star`，无参数默认 `hot_picks`），站点改板块文案时调整订阅 `?list=` 值即可；订阅 URL 必须带 `www.`（裸域会 301 到 www，跳转后与订阅串不等就不会入库）；列表数据自带全文简介与英文标签，无需请求详情页；播放页链接的 slug 由站点服务端校验、错一字即 404，扩展逐字复刻了站点的 slug 算法；「未上线预告」条目（站内只提示 Not released yet）本轮跳过，上线后下轮自动入库；`/tc/` 是另一套繁中片库而非同片中文版，标题一律走 AI 翻译。
- **GoodShort**：订阅的是每个板块的「More」页 `/channel/<板块>` 而不是首页——首页每个板块只给 6 条，`/channel/` 页正好 10 条且首页那 6 条是它的子集。简介、封面、内容类型标签全在列表数据里，不需要额外请求详情页（列表里结尾带「…」的简介是站点自己的原文，不是被截断）。
- **Shortical**：站点是纯前端渲染，扩展等页面渲染完成后再读；卡片上只印一个分类，扩展会尽力再向站点接口取全量分类补上，取不到就用卡片上那一个（不影响入库）。订阅 URL 要写**裸域** `https://shortical.com/`（带 `www.` 会被 301 到裸域，跳转后与订阅串不等就不会入库）。**作品地址取站点 sitemap 的规范形态**：站点首页卡片链接里的编号和详情页实际能打开的编号是两套，直接照抄首页链接有大半会落到站点自己的 404 页（实测 9 条里 6 条），而且同一部剧的编号还会变、导致同一部剧被反复当成新卡入库。扩展改为每轮抓取先读一次站点 sitemap 换取规范地址；换不到的作品本轮不入库，等站点收录后下轮自动补上。库里已有的旧条目会在扩展更新后自动改正并合并重复项。此外，**该站首页列表需要页面完成匿名登录才会出现**——若页面显示「No series available」则扩展抓到的就是 0 条，通常是网络挡掉了 Google 鉴权域名。
- **ShortMax**：站点首页板块在浏览器里是横向轮播、**只渲染当前可见的那几张卡**（窗口窄时 8 条会只剩 5 条），扩展改为重新取一次服务端页面来解析，条数不再受窗口宽度影响。列表本身没有简介和类型标签，两者都从作品详情页补齐；某条详情取不到时该作品本轮不入库、下轮重来（避免留下永远补不上简介的卡）。订阅 URL 须带 `www.`。
- **DramaBox**：`dramabox.com` 与 `dramaboxdb.com` 是同一片库的**两套人工编排视图**（同一套站点程序、同一批作品编号、连站点图标都完全相同），所以在扩展里合并成 **一个 DramaBox 来源**。两站同名板块的内容其实并不一样——实测四个板块共 72 个位置只对应 62 部不重复的剧（`dramaboxdb` 的 Must-sees 恰好是 `dramabox` 的 Trending），所以两站都抓才能拿全；重叠的剧按先到先得只留一张卡。**卡片链接统一指向 `dramabox.com`**（实测 `dramaboxdb` 独有的作品在 `dramabox.com` 上也都能打开）。订阅的是板块列表页而不是首页：首页每个板块只给 6 条，列表页正好 18 条；板块还有更多页，扩展只抓第一页。板块内容不随访问变化（同一板块连抓三次，条目与顺序完全一致），所以重复抓取新增为 0 是正常的。订阅 URL 须带 `www.`（裸域会 301 到 www，跳转后与订阅串不等就不会入库）。简介、封面与类型标签全在列表数据里，不需要请求详情页。

- **PinesDramas**：一个站点同时有网文与短剧两类内容，两者各有各的作品页（同名地址互不通用），扩展里合并成 **一个 PinesDramas 来源**、按标签区分（`novel` / `drama`），整站归在「游戏 · 网文」分组下。四个板块分落两个页面，按板块标题订阅（`Recommended WebNovels For You` → `?list=recommended_webnovels_for_you`，其余同理），站点改板块文案时调整订阅 `?list=` 值即可。**列表卡片的简介覆盖不全**——Popular Novels 与 Popular Short Dramas 的卡上根本没有简介，另两个板块的短句也和作品页的完整梗概是两段不同文案，所以扩展对每条都取一次作品页，顺带拿到 2~4 个内容类型标签（卡片上只印 1 个）；某条取不到时该作品本轮不入库、下轮重来（避免留下永远补不上简介的卡）。每轮约 22 条、耗时 20 秒上下。订阅 URL 要写**裸域**（带 `www.` 会被 301 到裸域，跳转后与订阅串不等就不会入库）。站点上的评分不入库。

> 各站的域名形态并不一致，订阅 URL 写错一个字符就会静默零抓取：FlickReels、GoodShort、ShortMax、DramaBox 必须带 `www.`，Shortical 与 PinesDramas 必须**不带**。规则目录里已按正确形态内置。`?list=` 的板块值同理：值写错（归一化后为空，或找不到对应板块）时这条订阅抓 0 条，后台日志会提示，不再悄悄退回默认板块、把别的板块的条目记到这条订阅名下（v1.6.16）；只有完全不带 `?list=` 时才用各站的默认板块。

## 📦 安装与快速上手

1. 打开 Chrome，进入 `chrome://extensions/`，开启「开发者模式」
2. 点击「加载已解压的扩展程序」，选择本项目目录（首次安装会自动打开设置页）
3. 在设置页「网页订阅」勾选想监控的规则，点「保存订阅配置」
   - 勾选结果经本地同步服务（见下文）写回 `config/tag.json`。新增订阅、改标签时服务未启动也能保存：本地订阅保留在扩展里，服务启动后（扩展下次唤醒时）自动写回文件，不会被旧文件回滚；取消订阅会删除历史，必须先启动服务、写回文件成功才会生效
4. 之后交给定时任务自动抓取；想立即看某个站点，在弹窗内再点一次该站点图标手动刷新
5. 新卡片先以英文出现，抓取开始 10 秒后翻译线自动扫描翻译，一直跟到抓取全部结束；也可点弹窗右上角 `🌐` 手动触发全部翻译（后台执行，弹窗关闭不中断，重开自动恢复进度显示），或点某张卡片右上角的 `🌍` 只翻这一张（同样在后台执行，点完就关弹窗也会翻完）

## 🖥️ 弹窗与设置页

**弹窗**（点击扩展图标）：

- **站点图标标签**：只显示有订阅的站点；点未激活图标＝切换查看，再点已激活图标＝只抓取该站点（图标转圈，完成后提示新增条数；定时全量抓取进行中且还没轮到该站时并入这一轮，图标立即停转并提示，新卡片随本轮自动出现，v1.6.19）
- **`🌐` 全部翻译**：手动触发一轮全量翻译，悬停按钮可见「已处理 X/Y」实时进度
- **卡片 `🌍` 单卡翻译**：只翻这一张，新结果覆盖旧译文（可用于重译）；请求由后台执行，弹窗关闭不中断。只翻出一半时卡片保持「待翻译」并提示，等下轮自动补齐。把待翻译的卡翻成已翻译时，同样自动推一张群机器人卡（重译已翻译的卡不推；v1.6.19）
- **顶部状态栏**：左侧同步服务状态（`📁` 打开服务目录；服务开启时出现 `🔄` 重启 / `⏹` 停止，关闭时出现 `▶ 启动`，见「一键启动集成」）；右侧当前版本与远端版本对比（点击重新检查）
- **底部状态栏**：条目总数、上次抓取时间（弹窗开着时随抓取实时刷新；一轮里所有订阅都没抓成时不刷新这个时间，而是在后面标「· 最近一轮全部失败」，悬停看失败的订阅数与原因；v1.6.19）、翻译进度，以及局域网共享链接 `📡 <IP>:31919`（点击复制，`▦` 弹出二维码）

**设置页**（弹窗 ⚙️ 进入，独立页面，六个标签页）：

| 标签页 | 能做什么 |
|--------|----------|
| 配置文件 | 「重新读取配置」让四个 JSON 立即生效；快捷查看各配置文件 |
| 网页订阅 | 勾选式订阅管理：候选规则来自目录 `config/tag.example.json`（按站点分组），保存后写回 `config/tag.json`；不支持在界面自由添加 URL，新增规则＝编辑目录文件后重载扩展。**取消订阅会连带删除该订阅下的全部历史记录**，故保存前弹确认并列出条数，确认后自动下载这批条目的 JSON 备份（可用「导入恢复」写回，但要先把订阅加回来；v1.6.7）。订阅在别处（另一个设置页、后台回读 `config/tag.json`）改过时列表自动刷新，本页未保存的勾选会丢弃并提示重新勾选（v1.6.15） |
| 定时任务 | **完整编辑器**（v1.5.2）：调度模式切换、间隔/Cron 表达式编辑、实时预览下一次执行时间；非法表达式拒绝保存，保存即重排定时任务并写回 `config/cron.json`（需同步服务） |
| 翻译接口 | 完整表单编辑 `config/trans.json` 的全部字段（模式/端点/密钥/模型/提示词/批量/延迟/超时），保存写回文件（需同步服务） |
| Lark 推送 | 三节：多维表格工作流 webhook 与超时（「发送测试」验证链路）；群机器人 webhook 与开关（翻译完成后自动推卡，「发送机器人测试」真发一张）；飞书自建应用 App ID / Secret（两个都填才上传封面真图，留空发无图卡）。保存写回 `config/lark.json`（需同步服务）；工作流 payload 15 键含内容类型标签 `genres`（v1.5.3，已在用的工作流重发测试即可捕获新参数） |
| 数据存档 | 检测同步服务与 CSV 路径；**导出 JSON 备份 / 导出 CSV / 导入恢复（按条目 ID 去重合并）/ 按站点与时间两段式清理**（v1.5.2）；扩展按订阅范围自动清理历史（取消订阅、回读 `config/tag.json` 等）前，会把被删条目存进「自动清理回收站」（只留最近 3 批），有内容时出现「导出自动清理回收站（N 批 / M 条）」按钮，导出的文件直接用「导入恢复」写回（先把订阅加回来；v1.6.15）；「导出到多维表格」把增量复制成表格格式粘进 Base：增量按**入库时间**计（「导入恢复」补回的条目按原抓取时间，不当新条目重导），只勾部分站点复制时各站分别记住上次复制时间、没勾的站点不受影响；复制时还没翻译完的条目照常导出（中文列为空或不全），状态提示里报条数，译文完成后**不会**自动补发；剪贴板写入失败时不推进上次复制时间（v1.6.16） |

## ⚙️ 配置文件

四个本地配置文件（`tag` / `cron` / `trans` / `lark`）均已加入 `.gitignore`，共享模板为对应的 `config/*.example.json`；另有同步服务运行时自动生成的 `config/sync-origin.json`（固定写入来源，见「数据与隐私」），同样被排除、不需要手改。修改后在设置页点「重新读取配置」（或重载扩展）生效。

可以取消全部订阅；在设置页取消订阅时，保存前会确认对应历史数据的清理，并且必须先写回 `config/tag.json` 成功才会清理（同步服务未启动时拒绝取消，不动扩展里的历史数据）。但扩展每次唤醒都会回读 `config/tag.json`：直接在文件里删掉的订阅（包括手改笔误），其下历史会在下次唤醒时被清理、不弹确认；被删条目会先存进「自动清理回收站」（最近 3 批），可在「数据存档」导出后导入恢复。

设置页保存配置时若同步服务未启动（写回文件失败），扩展会记下这项配置「本地领先于文件」：此后唤醒不再用旧文件覆盖它，而是在同步服务启动后自动把本地配置写回文件，写成后才恢复以文件为准。这期间手改的对应文件会被写回覆盖；想以文件为准，在设置页点「重新读取配置」或该标签页的「从配置文件重载」。配置文件读取或解析失败（如 JSON 多了个逗号）时，扩展保留上一次的配置并在后台日志告警，扩展里也没有旧配置时才用默认值——不再静默回落默认值（此前 `trans.json` 写坏会切回 MyMemory，`lark.json` 写坏会关掉群机器人）。

同步服务读取订阅文件损坏时保留已有 CSV 和共享快照，修正文件后重新推送即可恢复同步；文件尚未生成时按「零订阅」处理，不会阻塞同步。

### `config/tag.json` — 订阅什么

程序完全以此文件为准，未配置的 URL 一律不抓。数组元素为 `url` + `tags`（1-3 个标签，首个通常是站点名）：

```json
[
  {
    "url": "https://www.imdb.com/search/title/?release_date=2026-01-01,&genres=short",
    "tags": ["IMDB", "short"]
  },
  {
    "url": "https://store.steampowered.com/category/visual_novel?flavor=contenthub_newandtrending",
    "tags": ["Steam", "视觉小说", "人气蹿升"]
  }
]
```

### `config/cron.json` — 什么时候抓

```json
{
  "scheduleMode": "cron",
  "scrapeCron": "45 * * * *",
  "translateCron": "50 * * * *"
}
```

- `scheduleMode: "cron"`：按 5 段 cron 表达式（`分钟 小时 日期 月份 星期`）调度；Chrome Alarms 不原生支持 cron，扩展会计算下一次执行时间创建一次性 alarm，触发后续排，并有每小时看门狗兜底重建
- `scheduleMode: "interval"`：按 `scrapeInterval` / `translateInterval`（小时）循环执行
- 可在设置页「定时任务」标签直接编辑（校验+实时预览，保存自动生效并写回文件）；手动编辑文件后回「配置文件」点「重新读取配置」即可
- 表达式校验从严（v1.6.19）：各段只认 `*`、十进制整数、恰好两端的区间 `a-b`、逗号列表与 `/步长`；多打的逗号（`45, * * * *`）、`1-2-3`、`0x1f` 这类写法直接报错，不再被静默解析成别的含义；单值带步长（`5/15`）各家 cron 解释不一，也报错并提示改写为区间形式（如 `5-59/15`）。`0 0 29 2 *` 这类要跨过平年才命中的闰日表达式能正常算出下一次执行时间

### `config/trans.json` — 怎么翻译

完整字段（九项全集，缺省时使用括号内默认值）：

```json
{
  "translateMode": "ai",
  "apiEndpoint": "https://api.mymemory.translated.net/get",
  "aiEndpoint": "https://api.example.com/chat/completions",
  "aiApiKey": "sk-xxxx",
  "aiModel": "your-model",
  "aiPrefixPrompt": "请把片名和内容简介翻译为最有网感的中文表达。",
  "batchSize": 10,
  "delayMs": 200,
  "requestTimeoutSec": 10
}
```

- `translateMode`：`api`（免费 API 逐条 GET，默认 MyMemory）或 `ai`（OpenAI 兼容 Chat Completions 接口批量翻译）
- `aiPrefixPrompt` 只需描述翻译风格/人设；输入输出 JSON 格式与批量对应关系由程序自动处理
- `batchSize`（1-10）：AI 模式每批条数上限；实际按内容长度动态打包，长简介少装、短简介多装
- `delayMs` / `requestTimeoutSec`：请求间延迟与单次请求超时

> ⚠️ 不要把真实 API Key 提交到公开仓库；`config/trans.json` 已被 `.gitignore` 排除，本地自行填写。

## 💾 本地同步服务

Chrome 扩展无法直接写项目文件，本地 Node 服务负责三件事：把时间线写入 `db/timeline.csv`、承接设置页的配置写回（`config/tag.json`、`config/cron.json`、`config/trans.json`、`config/lark.json`；请求体缺少对应配置时拒绝写入、原文件不动，不会被写成默认配置而清空 API Key 与 webhook）、提供局域网只读共享页。

### 启动与管理

跨平台命令（Windows / macOS / Linux，需 Node.js 22 或更新版本，见 `package.json` 的 `engines`）：

```bash
npm run sync          # 启动（等价 node server/sync-server.js，前台常驻，Ctrl+C 停止；弹窗 🔄 之后转入后台，见下文；已设 macOS 开机自启时提示改用 npm run restart 后退出）
npm run start         # 同上（sync 的别名，-- 之后的参数照转，如 npm start -- --local-only）
npm run stop          # 优雅停止（经本机 POST /shutdown，只停本服务自身）
npm run restart       # 重启（升级后用）：已设 macOS 开机自启时重启后台服务（launchctl kickstart -k，仍归 launchd 托管），否则停掉旧实例后在本终端前台启动
```

Windows 双击脚本（`server/` 根目录只放日常入口，管理脚本在 `server/tools/`）：

```bat
server\start-sync.bat          # 启动（已运行则提示后退出，防重复启动）
server\setup-launcher.bat      # 一次性注册一键启动集成（见下节）
server\tools\stop-sync.bat     # 停止（调 stop.js，同 npm run stop：经 POST /shutdown 优雅停止，不按端口杀进程）
server\tools\restart-sync.bat  # 重启（调 stop.js --restart，同 npm run restart：停掉旧实例后在本窗口前台启动）
```

macOS 双击对应 `.command` 脚本（首次先 `chmod +x server/*.command server/tools/*.command`）：

```bash
server/start-sync.command              # 启动（已运行则提示后退出）
server/setup-autostart.command         # 一次性设置开机自启（见下）
server/tools/stop-sync.command         # 停止（同 npm run stop）
server/tools/restart-sync.command      # 重启（同 npm run restart）
server/tools/remove-autostart.command  # 撤销开机自启
```

**macOS 开机自启**：运行一次 `server/setup-autostart.command`，注册当前用户的 launchd 后台服务（`~/Library/LaunchAgents/com.shortscraping.sync.plist`）：登录即启动、崩溃自动拉起，日志在 `~/Library/Logs/ShortScraping/sync.log`。后台服务按默认方式启动、不带 `--local-only`，所以**每次登录都会向当前所连网络开放只读共享页**，连着公共 Wi-Fi（咖啡馆、机场、酒店）时也一样（见「局域网共享」）。`npm run stop` 或弹窗 `⏹` 停下后不会被自动拉回；设置后 `start-sync.command` / `restart-sync.command` / `npm run restart` 改为操作这个后台服务（等价 `launchctl kickstart [-k] gui/$(id -u)/com.shortscraping.sync`；重启会先停掉端口上残留的前台实例，10 秒内未检测到服务则提示去看日志）。设置后 `npm run sync` / `npm start` 不再另起前台实例，而是提示改用 `npm run restart` 后退出（确需前台调试：先 `npm run stop`，再 `SHORTSCRAPING_NO_LAUNCHD=1 npm run sync`）。后台服务拉起时若端口已被前台实例（如旧版 `npm run restart` 或前台调试留下的）占着，它会打印提示后正常退出、不再每 10 秒反复重试；想交回后台托管，运行一次 `npm run restart` 即可。同一脚本还会生成 `~/Applications/ShortScraping Launcher.app` 接住 `shortscraping://` 协议，弹窗 `▶ 启动` 与 `📁` 在 macOS 上随即可用（双击这个应用也能启动服务）。plist 与小应用记的都是绝对路径，移动项目文件夹后重新运行一次设置脚本；Node 装在 nvm / fnm 下时 plist 记的是带版本号的 Node 路径，升级、切换或卸载该版本后同样要重新运行（脚本会打印所用的 Node 路径与版本并提示，fnm 只在当前终端有效的临时路径会先换成版本目录）。重复运行设置脚本会等上一个后台服务卸载干净再注册，仍注册失败时提示再运行一次。撤销用 `server/tools/remove-autostart.command`：它如实报告「已停止后台服务并撤销开机自启」或「未设置开机自启」，并顺带停掉端口上不归 launchd 托管的实例，日志目录保留（v1.6.19）。

**弹窗 `🔄` 重启**：开机自启下交给 launchd 拉起，服务仍在后台、日志照旧；其余场景（终端/双击脚本前台启动、Windows）由服务派生一个新实例接管端口，新实例**转入后台**运行，原窗口里的旧进程随即结束、不再有输出，日志改写到 `~/Library/Logs/ShortScraping/sync.log`（macOS）或项目下的 `logs/sync.log`（Windows / Linux）。此后关窗口不会停止服务，请用弹窗 `⏹`、stop 脚本或 `npm run stop`。弹窗提示里附日志路径；新实例派生失败时旧实例保持运行，弹窗提示失败原因。

服务地址：`http://127.0.0.1:31919`，扩展固定连这个端口；端口被占用时会打印友好提示（先 `npm run stop`）而非报错堆栈。服务与 stop 脚本不读通用环境变量 `PORT`（v1.6.19 起；以前在 shell 里给别的项目设的 `PORT` 会被继承，服务跑到扩展连不上的端口），只有测试与调试用的 `SHORTSCRAPING_PORT` 能改端口，改了会在启动时打印告警。未启动同步服务时扩展一切照常，只是 CSV/配置写回暂不可用：设置页保存的配置先留在扩展里，服务启动后自动写回（见「配置文件」一节）；取消订阅要等服务启动后才能保存。

### CSV 输出

时间线数据变化时自动同步到 `db/timeline.csv`，带 BOM 的 UTF-8 + Windows 换行，Excel/WPS 直接识别中文。CSV 只是导出物，数据源在扩展存储和 `db/timeline.json` 里，文件坏了（旧版服务写出的乱码、被 Excel 另存成 ANSI/GBK 等）删掉重建即可：关闭 Excel/WPS，删除 `db/timeline.csv`（服务运行或停止时都可以），确保同步服务在运行，再打开一次扩展弹窗——弹窗检测到服务后会强制补推当前时间线，服务发现 CSV 缺失（或启动时刚补建的空表）就按当前数据重新写出。只「再抓一轮」不可靠：时间线内容没变化时扩展不会重推。Windows 上 Excel/WPS 正打开着 `timeline.csv` 时 CSV 暂时写不进（同步报「被其他程序占用」，共享页照常更新），关闭文件后下一次同步自动补写。

**空时间线保护**（v1.6.15）：扩展本地时间线为空（新 profile、重装扩展）时不推送，避免把 `db/timeline.*` 与共享页一起清空——重装后请在下一次抓取前用设置页「导入恢复」选 `db/timeline.json` 把历史导回（抓到新条目后推上去的时间线会覆盖它，届时只能从 `db/history/` 的 drop 档找回）。同步服务也会把关：服务端已有数据时，空时间线推送必须带 `allowEmpty: true`，否则返回 409（`EMPTY_REJECTED`）、不写任何文件。只有在设置页确认过的取消订阅或按条件清理把时间线清空时，扩展才会带这个标记推送。

**请求体上限**（v1.6.19）：`/sync` 每次推送订阅内的整张时间线，体积只增不减，写接口（`/sync` 与配置写回）的请求体上限从 20MB 提到 64MB。超限时服务回 413（`BODY_TOO_LARGE`）、不写任何文件，扩展后台日志报出本次推送的体积；旧版服务超限是直接断开连接，扩展看到的与「服务没启动」一模一样——后台日志提示推送超过 20MB 又连不上时，先更新并重启同步服务。CSV 同步失败的日志也按形态区分：连不上才提示确认服务已启动，服务端回了错误则打印它给的原因。

### 一键启动集成（Windows / macOS，可选）

> macOS 由 `server/setup-autostart.command` 一并注册（见上文「macOS 开机自启」），行为与下述一致。弹窗 `🔄` / `⏹` 直接调服务接口，两个平台都无需注册；`🔄` 在 macOS 开机自启下交由 launchd 拉起，其余场景由服务自行派生新实例接管端口（新实例转入后台，见上文「弹窗 `🔄` 重启」）。

运行一次 `server/setup-launcher.bat`（只写当前用户注册表 `HKCU\Software\Classes\shortscraping`，无需管理员）注册 `shortscraping://` 协议后，弹窗获得两个能力：

- `📁`：在资源管理器中直接打开 `server/` 文件夹（同时复制路径作兜底）
- `▶ 启动`：服务关闭时一键拉起 `start-sync.bat`，弹窗自动轮询刷新状态

边界说明：Chrome 首次触发协议会弹「打开外部应用」确认框；未注册时点击这两个按钮无副作用（`📁` 退化为复制路径，`▶` 超时后给手动指引）；协议分发器 `server/tools/launcher.vbs` 只认 `shortscraping://open-folder` 与 `shortscraping://start-sync` 两个固定地址（整串比较，不分大小写、允许末尾斜杠，与 macOS 小应用一致），其余一律忽略，从不拼接 URL 参数。撤销注册：`server/tools/remove-launcher.bat`。

### Windows 登录自启动

`Win + R` → `shell:startup`，把 `server/start-sync.bat` 的快捷方式放入启动目录即可。

## 📡 局域网共享

同步服务**默认**就对同一网络开放**只读**时间线页面，不需要另外开启：同网任意设备打开 `http://<本机IP>:31919/`，看到与弹窗一致的时间线（按分组折叠的全部站点切换、日期分组、同款卡片），新数据经 SSE 推送自动刷新。

- **链接位置**：弹窗底栏 `📡 <IP>:31919`，点击复制；`▦` 弹出二维码供手机扫码
- **防火墙**：首次启动时若系统询问是否允许 Node 联网（Windows 为 `node.exe`），请允许**专用网络**，否则局域网设备无法访问
- **只读边界**：同网设备能看到全部时间线内容（标题、简介、封面、链接、标签与译文）和本机的局域网 IP；不能写配置、推送数据或停止服务——CSV 同步、配置写回、停止/重启服务等写接口仅接受本机调用，翻译 API Key 与 Lark webhook 无任何读取接口
- **开机自启时**：macOS 开机自启的后台服务（以及 Windows 启动目录里的 `start-sync.bat`）都不带 `--local-only`，每次登录都会开放共享页，连着公共 Wi-Fi 时同一热点下的陌生设备也能打开
- **仅本机模式**：`npm run sync -- --local-only`（等价 `node server/sync-server.js --local-only`）只监听 127.0.0.1，其他设备无法访问（弹窗底栏显示「不可用」）；不需要共享、或常连公共网络时建议用这个模式。开机自启不支持这个参数，只想本机用时先撤销自启（macOS 运行 `server/tools/remove-autostart.command`，Windows 删掉启动目录里的快捷方式），再按此方式手动启动
- **升级后**：重启同步服务（`npm run restart`），否则弹窗拿不到局域网地址
- **共享页没数据**：打开一次扩展弹窗即可，弹窗会自动把当前时间线推给服务

## 🌐 翻译机制

- **两条状态**：卡片入库即 `待翻译`（new），翻译成功变 `已翻译`（trans）；Steam 官方中文、My Drama 平台自带中文的条目入库时直接标记 `已翻译`
- **完成判据**：标题、简介该翻的都翻出来才标 `已翻译`；只回一半的存下已得部分、保持 `待翻译` 等下轮补另一半，连续 3 轮补不齐才收口。接口应答了却一个字都没给出的条目（含单条请求被接口拒收，如内容审核）同样计轮次（一整轮一条都没翻成、失败又不止两条时不计，那更像提示词或模型的全局问题），连续 3 轮拿不到译文也收口：标 `已翻译`、显示英文原名，不再反复重试（v1.6.16）。不含汉字的译文（模型把英文原样回显）按没翻出处理，批量线与单卡 `🌍` 都不会拿它覆盖已有中文。批量线只补空缺、不覆盖既有译文（保护 Steam 官方中文）；卡片 `🌍` 单卡重译走后台 `translateSingle`，新结果优先覆盖
- **API 模式**：逐条 GET 请求（默认 MyMemory，`q=<文本>&langpair=en|zh-CN`；`apiEndpoint` 可以自带查询参数，如 MyMemory 的 `?de=<邮箱>`，程序在其后追加这两个参数，v1.6.19）
- **AI 模式**：按内容长度动态打包成 1-10 条/批（单批约 4000 字符预算），一次请求翻译整批；返回结果按条目 id 回填，缺失的条目保持待翻译、下一轮自动重试（计入上面的 3 轮上限）；整批请求失败或整批没给出可用译文时，同一轮内拆成单条各试一次，一条被拒收的内容不再连累同批邻居一起卡在待翻译（v1.6.16）
- **时序**：每次抓取任务开始 10 秒后，翻译线并行扫描待翻译卡片，直到抓取全部结束后连续 3 次扫描无新内容（抓取还在进行时的空扫描不计，抓取后半程入库的卡不必等兜底轮；翻译线提前退出的，最后一个抓取结束时再补一轮扫描；v1.6.16）；定时任务中的 `translateCron` 是独立的兜底轮；弹窗 `🌐` 随时手动触发
- **失败行为**：接口失败不丢卡，条目保持待翻译等下一轮；网络、超时、密钥/额度/限流、服务端 5xx 这类通道故障不计入上面的 3 轮上限，接口恢复或配置改对后照常翻。同一轮连续 3 次请求失败即提前结束本轮（密钥过期时不再把整库待翻译卡逐批白发一遍），抓取后翻译线随之停下（v1.6.16）；批量结果与条目按 id 对应，不依赖返回顺序

## 🔒 数据与隐私

- 抓取数据保存在本机：`chrome.storage.local`（扩展内，已申请 `unlimitedStorage`，不受 10MB 配额限制——数千条记录约 5MB，按月增长）与 `db/`（CSV/JSON，若启用同步服务）。同步服务运行时默认开放局域网只读共享页，同网设备可以浏览全部时间线并看到本机局域网 IP；不需要时以 `--local-only` 启动（见「局域网共享」）。
- 站外请求包括抓取订阅站点、调用配置的翻译接口、检查更新，以及 Lark 推送：用户点击单卡按钮时 POST 到配置的多维表格工作流 webhook；开启群机器人后，条目翻译完成即自动 POST 到配置的机器人 webhook（可随时关闭）；填写了飞书自建应用凭据时，还会把封面图上传到 `open.feishu.cn` 换取卡片图片 key（不填则发无图卡）。
- 四个本地配置（含翻译密钥和 webhook）均被 `.gitignore` 排除，不会随仓库分发；原子写入中断时残留的 `config/*.tmp` 同样被排除。同步服务写回 `config/trans.json`、`config/lark.json` 这两个存明文密钥的文件时只给文件属主读写权限（0600，macOS / Linux；Windows 沿用目录权限），同机其他账号读不到。v1.6.17 之前写出的这两个文件仍是默认权限，在设置页对应标签页保存一次即收紧，或手动运行 `chmod 600 config/trans.json config/lark.json`。
- 同步服务写接口仅接受回环连接，并且只认首次写入时固定下来的那个扩展（记录在 `config/sync-origin.json`，换目录重载扩展后删除该文件即可重新固定）；所有写请求都要求 `application/json`，本机管理脚本仍可调用。
- 扩展权限（v1.6.17 收紧）：不申请 `tabs` 权限；内容脚本仅注入支持的平台域名，其中 IMDB（`/search/title`、`/find`）、Steam（`/category/`、`/tags/`）、RoyalRoad（`/fictions/`）与 Netflix、Apple TV 一样只注入订阅页路径，在这几站浏览其他页面时不注入；后台的强制注入兜底只对支持的站点放行，订阅页跳到了站外（地区跳转、同意页等）时本次抓取直接报失败、不注入。内容脚本不直接读写扩展存储（v1.6.19）：开轮需要的订阅清单与已入库条目的 ID 由后台经消息下发，不含简介、译文和任何配置密钥；后台还会尝试把 `chrome.storage.local` 收窄为只对扩展自身页面开放（Chrome 不支持收窄该区时只在后台日志告警）。内容脚本只能向后台索取抓取上下文、提交抓取结果、请求代取详情页，清库、导入、配置写回、Lark 推送与测试发送等操作只接受扩展自己的弹窗和设置页发起。
- 共享页按主机地址类型放行：IP 地址与 `localhost` 直接可用，用自定义域名访问需启动时加 `--allow-host=<域名>`。
- 防 CSV 公式注入：`db/timeline.csv`、设置页「导出 CSV」与 `npm run export-lark` 产出的 `.csv`（v1.6.17 起）里，以 `= + - @`（或 Tab、换行）开头的单元格会加一个前导撇号 `'`，Excel/WPS 打开时按文本显示、不当公式执行；代价是以 `- `、`+` 开头的正常简介也会带上撇号。原始 JSON 备份、剪贴板「导出到多维表格」与 export-lark 的 TSV 保持原文；确定不经 Excel/WPS 打开、直接导入 Base 的 export-lark CSV 可加 `--raw` 关掉撇号。导入跳过字段类型、时间戳（含 `2026-02-30`、`2026-13-01` 这类日历上不存在的日期）、链接或 ID 无效的记录，计入「无效」条数、不影响同批其余记录（封面链接无效只清空封面，不丢整条记录）；原文（标题/简介/标签）含乱码字符 `�` 的记录照常导入，结果里单独报条数——多为旧版同步服务写坏的备份，原文无法还原，重新抓取也不会覆盖；条件清理会验证预览范围，范围变化时需重新预览。

## 📁 项目结构

```text
ShortScraping/
├── manifest.json                 # Chrome 扩展配置（版本号唯一源）
├── package.json                  # 同步服务 npm 脚本（版本与 manifest 同步）
├── README.md / LICENSE / .gitignore / .gitattributes
├── src/
│   ├── background/background.js  # 后台 service worker：调度、抓取/翻译编排、CSV 推送
│   ├── content/                  # 内容脚本：十五个站点适配器（16 个域名；content.js + content.css）
│   ├── popup/                    # 扩展弹窗（popup.html/css/js）
│   ├── settings/                 # 设置中心：配置文件/网页订阅/定时任务/翻译接口/Lark 推送/数据存档
│   └── shared/                   # 共享模块（UMD 多端共用）：site-registry（站点元数据单一真源）、scrape-rules（内容脚本与后台共用的采集口径：fandom 临时键前缀、类型标签清洗、Shortical sitemap 解析）、site-tabs（分组折叠标签条）、timeline-render（时间线渲染）、timeline-cards.css（弹窗与共享页共用的时间线/卡片样式）、timeline-csv（CSV 序列化/导入校验）、schedule-config（cron 解析）、translate-config（翻译配置与文本判据）、subscription-config（订阅规范化）、url-match（订阅 URL 归属）、translator（翻译）、lark（Lark 推送/多维表格导出/群机器人卡片）、qrcode（二维码）
├── assets/icons/                 # 扩展图标、站点图标与默认海报
├── config/                       # 本地配置（gitignore）与 example 模板
├── server/                       # 本地同步服务；根目录仅日常入口 start-sync.bat/.command、setup-launcher.bat、setup-autostart.command
│   ├── sync-server.js            # CSV 写入 + 配置写回 + 局域网只读共享（SSE）
│   ├── public/                   # 局域网共享页（share.html/css/js；共用的 src/shared 渲染脚本与 timeline-cards.css 由服务经 /shared/ 白名单伺服）
│   └── tools/                    # 管理脚本：stop-sync/restart-sync（.bat + .command，都调用 stop.js）、Node 助手 stop.js（停止/重启单一实现）、remove-launcher.bat、remove-autostart.command、launcher.vbs
├── scripts/                      # update-site-matches.mjs（由 site-registry 生成 manifest 内容脚本匹配清单）、export-lark-csv.mjs（多维表格导入文件，`npm run export-lark`；`--since=YYYY-MM-DD` 按本地 0 点切、比的是入库时间 `savedAt`（旧条目退回 `scrapedAt`），与设置页日期框一致；`.csv` 默认加公式撇号，`--raw` 关掉）
├── tests/                       # 隔离回归测试 unit-*.mjs 与夹具；run.mjs 逐套串行跑（npm test），单套超过 60 秒连同它派生的进程一起结束
├── db/timeline.csv               # CSV 输出（运行时生成）
├── db/timeline.json              # 时间线快照（共享页数据源，服务重启后回读）
├── db/history/                   # 覆盖前的留痕备份（v1.6.7，运行时生成）：每日档保留 14 天、条数骤降的 drop 档保留 10 份
└── logs/sync.log                 # 弹窗 🔄 转入后台后的服务日志（Windows / Linux，运行时生成；macOS 在 ~/Library/Logs/ShortScraping/）
```

## 🔧 技术栈

- Chrome Extension Manifest V3，原生 JavaScript（无框架依赖）
- Chrome Storage / Alarms / Notifications API
- Node.js 本地同步服务（无第三方依赖；CSV 写入 + 局域网只读共享页 + SSE 实时推送）

## 验证与升级

使用 Node.js 22 或更新版本运行 `npm test`（当前 56 套，以 `tests/unit-*.mjs` 实际数量为准），无需安装第三方依赖。测试使用模拟的 Chrome API 和独立的服务目录，不读写用户的配置和数据。`tests/unit-audit-regressions.mjs` 覆盖调度、导入、清理、计数、CSV 与设置页异步状态，`tests/unit-server-safety.mjs` 覆盖服务来源校验、请求异常和持久化保护。

更新文件后，在 Chrome 扩展管理页重新加载扩展，并重启本地同步服务（`npm run restart` 或弹窗 `🔄`）以启用服务端修复。站点元数据仍只维护 `src/shared/site-registry.js`；新增站点后运行 `npm run update-sites`，由注册表生成 manifest 的内容脚本匹配清单（域名，及个别站点的订阅页路径），测试会检查两者一致。

## 📄 License

[MIT](LICENSE)
