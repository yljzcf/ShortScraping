# ShortScraping - 爆款短剧监控助手

Chrome 浏览器插件：按你订阅的 URL 定时监控 IMDB、Steam、RoyalRoad、My Drama、ReelShort、DramaShorts 六个平台的榜单/板块，新条目以时间线卡片展示，自动翻译为中文，并可经本地服务同步为 CSV、在局域网内只读共享。

适合谁：追踪海外短剧/游戏/网文热榜动向的编辑、制片、市场与数据同学——打开弹窗就能看到"最近各平台新上了什么"，无需逐站巡逻。

## ✨ 功能特性

- 🎬 **订阅式监控**：抓什么完全由 `config/tag.json` 的订阅 URL 决定，程序不内置任何默认订阅；每条订阅可配 1-3 个来源标签
- 📅 **时间线卡片**：新条目按抓取时间倒序分组展示（同日一组、±1 分钟合并），卡片含封面、标题、简介、来源标签
- 🌐 **翻译线**：卡片先以英文即时入库，随后按 `config/trans.json` 自动翻译为中文；平台自带官方中文的条目（Steam 中文详情、My Drama 本地化标题）直接采用、不再消耗翻译
- 🔁 **抓取节奏**：全量抓取由定时任务（cron 或固定间隔）执行；弹窗内再点一次已激活的站点图标可手动刷新该站点，完成后提示"本次新增 N 条"；全局按去重键防重复入库
- 💾 **CSV 同步**：本地同步服务把时间线实时写入 `db/timeline.csv`（UTF-8 BOM + CRLF，Excel/WPS 直接打开）
- 📡 **局域网共享**：同一局域网的手机/平板/电脑打开 `http://<本机IP>:31919/` 即可只读浏览时间线，数据更新经 SSE 自动刷新；链接显示在弹窗底栏（点击复制 + 二维码）
- 🔔 **版本自检**：弹窗对比远端仓库 master 的 `manifest.json`，有新版本以橙色提示

## 🌍 支持站点

| 站点 | 订阅入口 | 取数方式 | 去重键 |
|------|----------|----------|--------|
| IMDB | 榜单/搜索页（`/search/title`、`/find`） | 列表 DOM + 详情页补简介/出品公司 | `tt` 编号 |
| Steam | 内容中心 `/category/<name>`、`/tags/<语言>/<标签名>` | 官方动态查询接口取列表 + `appdetails` 补英文详情 | appId |
| RoyalRoad | 榜单页 `/fictions/*` | 服务端渲染列表自带全文简介，详情页补作者 | `rr`+数字 id |
| My Drama | 主站首页板块（`?list=<板块锚点>`）与 fandom 子域文章流/Trending 菜单 | Next.js SSR + hydrate 轮询 / WordPress SSR | `md`+UUID |
| ReelShort | 主站首页 TOP 板块与 `/fandom/` 文章流 | 页内 `__NEXT_DATA__` SSR 数据直出 / WordPress SSR | `rs`+book_id |
| DramaShorts | `/top-movies` 榜单与首页板块（`?list=<板块id>`） | 页内 `__NEXT_DATA__` 直出，无需请求详情页 | `ds`+UUID |

站点细节：

- **Steam**：成人专属/受限作品（接口 `success=false`）自动跳过；官方中文简介与英文不同时直接作为翻译结果。
- **My Drama / ReelShort 的 fandom 入口**：文章条目通过文中回主站的链接换取主站 id，与主站条目全局去重；换不到 id 时以 `mdf-`/`rsf-`+slug 退化保留。
- **DramaShorts**：首页板块 id 支持 `top_trending`（默认）/ `popular_now` / `audience_favorite`；板块内容每次请求轮换属站点自身行为，多轮定时抓取会逐步累积。规则目录当前未内置 `audience_favorite`（该板块为大池随机采样、单次重合度低），需要时可手动写入 `config/tag.json`。

## 📦 安装与快速上手

1. 打开 Chrome，进入 `chrome://extensions/`，开启「开发者模式」
2. 点击「加载已解压的扩展程序」，选择本项目目录（首次安装会自动打开设置页）
3. 在设置页「网页订阅」勾选想监控的规则，点「保存订阅配置」
   - 如需把勾选结果持久写回 `config/tag.json`，请先启动本地同步服务（见下文）；未启动时仅扩展本地生效
4. 之后交给定时任务自动抓取；想立即看某个站点，在弹窗内再点一次该站点图标手动刷新
5. 新卡片先以英文出现，抓取开始 10 秒后翻译线自动扫描翻译；也可点弹窗右上角 `🌐` 手动触发全部翻译（后台执行，弹窗关闭不中断，重开自动恢复进度显示）

## 🖥️ 弹窗与设置页

**弹窗**（点击扩展图标）：

- **站点图标标签**：只显示有订阅的站点；点未激活图标＝切换查看，再点已激活图标＝只抓取该站点（图标转圈，完成后提示新增条数）
- **`🌐` 全部翻译**：手动触发一轮全量翻译，悬停按钮可见「已处理 X/Y」实时进度
- **顶部状态栏**：左侧同步服务状态（`📁` 打开服务目录、服务关闭时出现 `▶ 启动`，见「一键启动集成」）；右侧当前版本与远端版本对比（点击重新检查）
- **底部状态栏**：条目总数、上次抓取时间、翻译进度，以及局域网共享链接 `📡 <IP>:31919`（点击复制，`▦` 弹出二维码）

**设置页**（弹窗 ⚙️ 进入，独立页面，五个标签页）：

| 标签页 | 能做什么 |
|--------|----------|
| 配置文件 | 「重新读取配置」让三个 JSON 立即生效；快捷查看各配置文件 |
| 网页订阅 | 勾选式订阅管理：候选规则来自目录 `config/tag.example.json`（按站点分组），保存后写回 `config/tag.json`；不支持在界面自由添加 URL，新增规则＝编辑目录文件后重载扩展 |
| 定时任务 | **只读摘要**：展示当前调度模式与表达式。修改调度请直接编辑 `config/cron.json`，再回「配置文件」点「重新读取配置」 |
| 翻译接口 | 完整表单编辑 `config/trans.json` 的全部字段（模式/端点/密钥/模型/提示词/批量/延迟/超时），保存写回文件（需同步服务） |
| 数据存档 | 检测同步服务并显示 CSV 输出路径；导出/备份/清理/恢复能力规划中 |

## ⚙️ 配置文件

三个本地配置文件均已加入 `.gitignore`，共享模板为对应的 `config/*.example.json`。修改后在设置页点「重新读取配置」（或重载扩展）生效。

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
- 此文件**只能手动编辑**（设置页「定时任务」为只读展示），保存后记得「重新读取配置」

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

Chrome 扩展无法直接写项目文件，本地 Node 服务负责三件事：把时间线写入 `db/timeline.csv`、承接设置页的配置写回（`config/tag.json`、`config/trans.json`）、提供局域网只读共享页。

### 启动与管理

跨平台命令（Windows / macOS / Linux，需 Node.js）：

```bash
npm run sync          # 启动（等价 node server/sync-server.js，前台常驻，Ctrl+C 停止）
npm run start         # 同上
npm run stop          # 优雅停止（经本机 POST /shutdown，只停本服务自身）
npm run restart       # 重启（升级后用）
npm run fix-encoding  # 修复 CSV 编码
```

Windows 双击脚本（`server/` 根目录只放日常入口，管理脚本在 `server/tools/`）：

```bat
server\start-sync.bat          # 启动（已运行则提示后退出，防重复启动）
server\setup-launcher.bat      # 一次性注册一键启动集成（见下节）
server\tools\stop-sync.bat     # 停止
server\tools\restart-sync.bat  # 重启
```

macOS 双击对应 `.command` 脚本（首次先 `chmod +x server/start-sync.command server/tools/*.command`）：

```bash
server/start-sync.command              # 启动
server/tools/stop-sync.command         # 停止
server/tools/restart-sync.command      # 重启
server/tools/fix-csv-encoding.command  # 修复 CSV 编码
```

服务地址：`http://127.0.0.1:31919`；端口被占用时会打印友好提示（先 `npm run stop`）而非报错堆栈。未启动同步服务时扩展一切照常，只是 CSV/配置写回不可用。

### CSV 输出

时间线数据变化时自动同步到 `db/timeline.csv`，带 BOM 的 UTF-8 + Windows 换行，Excel/WPS 直接识别中文。若历史文件乱码：关闭 Excel/WPS 后运行 `npm run fix-encoding`（或双击对应脚本）重新编码；也可以启动服务后打开一次扩展弹窗，弹窗会自动补推当前时间线重写 CSV。

### 一键启动集成（Windows 可选）

运行一次 `server/setup-launcher.bat`（只写当前用户注册表 `HKCU\Software\Classes\shortscraping`，无需管理员）注册 `shortscraping://` 协议后，弹窗获得两个能力：

- `📁`：在资源管理器中直接打开 `server/` 文件夹（同时复制路径作兜底）
- `▶ 启动`：服务关闭时一键拉起 `start-sync.bat`，弹窗自动轮询刷新状态

边界说明：Chrome 首次触发协议会弹「打开外部应用」确认框；未注册时点击这两个按钮无副作用（`📁` 退化为复制路径，`▶` 超时后给手动指引）；协议分发器 `server/tools/launcher.vbs` 只做固定动作匹配、从不拼接 URL 参数。撤销注册：`server/tools/remove-launcher.bat`。

### Windows 登录自启动

`Win + R` → `shell:startup`，把 `server/start-sync.bat` 的快捷方式放入启动目录即可。

## 📡 局域网共享

同步服务运行时同时提供**只读**时间线页面：局域网设备打开 `http://<本机IP>:31919/`，看到与弹窗一致的时间线（六站点切换、日期分组、同款卡片），新数据经 SSE 推送自动刷新。

- **链接位置**：弹窗底栏 `📡 <IP>:31919`，点击复制；`▦` 弹出二维码供手机扫码
- **防火墙**：首次启动时若系统询问是否允许 Node 联网（Windows 为 `node.exe`），请允许**专用网络**，否则局域网设备无法访问
- **只读边界**：局域网设备只能浏览页面与时间线数据；CSV 同步、配置写回、停止服务等写接口仅接受本机调用，翻译 API Key 无任何读取接口
- **仅本机模式**：`node server/sync-server.js --local-only` 退回仅 127.0.0.1 监听（弹窗底栏显示「不可用」）
- **升级后**：重启同步服务（`npm run restart`），否则弹窗拿不到局域网地址
- **共享页没数据**：打开一次扩展弹窗即可，弹窗会自动把当前时间线推给服务

## 🌐 翻译机制

- **两条状态**：卡片入库即 `待翻译`（new），翻译成功变 `已翻译`（trans）；Steam 官方中文、My Drama 平台自带中文的条目入库时直接标记 `已翻译`
- **API 模式**：逐条 GET 请求（默认 MyMemory，`q=<文本>&langpair=en|zh-CN`）
- **AI 模式**：按内容长度动态打包成 1-10 条/批（单批约 4000 字符预算），一次请求翻译整批；返回结果按条目 id 回填，缺失的条目保持待翻译、下一轮自动重试
- **时序**：每次抓取任务开始 10 秒后，翻译线并行扫描待翻译卡片，直到连续 3 次扫描无新内容；定时任务中的 `translateCron` 是独立的兜底轮；弹窗 `🌐` 随时手动触发
- **失败行为**：接口失败不丢卡，条目保持待翻译等下一轮；批量结果与条目按 id 对应，不依赖返回顺序

## 🔒 数据与隐私

- 所有抓取数据存在本机：`chrome.storage.local`（扩展内）与 `db/`（CSV/JSON，若启用同步服务），无任何远端上报
- 扩展主动发起的站外请求只有三类：抓取你订阅的站点、调用你配置的翻译接口、检查更新（读 GitHub 仓库 master 的 `manifest.json`）
- 三个本地配置（含翻译密钥）均被 `.gitignore` 排除，不会随仓库分发

## 📁 项目结构

```text
ShortScraping/
├── manifest.json                 # Chrome 扩展配置（版本号唯一源）
├── package.json                  # 同步服务 npm 脚本（版本与 manifest 同步）
├── README.md / LICENSE / .gitignore / .gitattributes
├── src/
│   ├── background/background.js  # 后台 service worker：调度、抓取/翻译编排、CSV 推送
│   ├── content/                  # 内容脚本：六站点抓取适配器（content.js + content.css）
│   ├── popup/                    # 扩展弹窗（popup.html/css/js）
│   ├── settings/                 # 设置中心：配置文件/网页订阅/定时任务/翻译接口/数据存档
│   └── shared/                   # 共享模块：translator.js（翻译）、timeline-render.js（时间线渲染，弹窗与共享页共用）、qrcode.js（二维码）
├── assets/icons/                 # 扩展图标、站点图标与默认海报
├── config/                       # 本地配置（gitignore）与 example 模板
├── server/                       # 本地同步服务；根目录仅日常入口 start-sync.bat/.command、setup-launcher.bat
│   ├── sync-server.js            # CSV 写入 + 配置写回 + 局域网只读共享（SSE）
│   ├── public/                   # 局域网共享页（share.html/css/js）
│   └── tools/                    # 管理脚本：stop-sync/restart-sync/fix-csv-encoding（.bat + .command）、Node 助手 stop.js/fix-csv-encoding.js、remove-launcher.bat、launcher.vbs
├── db/timeline.csv               # CSV 输出（运行时生成）
└── db/timeline.json              # 时间线快照（共享页数据源，服务重启后回读）
```

## 🔧 技术栈

- Chrome Extension Manifest V3，原生 JavaScript（无框架依赖）
- Chrome Storage / Alarms / Notifications API
- Node.js 本地同步服务（无第三方依赖；CSV 写入 + 局域网只读共享页 + SSE 实时推送）

## 📄 License

[MIT](LICENSE)
