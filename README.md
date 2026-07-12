# ShortScraping - 爆款短剧监控助手

Chrome 浏览器插件，用于按配置 URL 监控 IMDB 等页面的新短剧条目，以时间线卡片展示，并支持 AI/API 翻译与本地 CSV 同步。

## ✨ 功能特性

- 🎬 **多 URL 监控**：URL 与来源标签由 `config/tag.json` 配置
- 📅 **时间线卡片**：新增影片按抓取时间展示，同一时间段合并
- 🌐 **翻译线**：卡片先以英文即时出现，随后按 `config/trans.json` 配置翻译为中文
- 🔁 **抓取**：全量抓取由定时任务执行；弹窗内再次点击已激活的站点标签可手动刷新该站点，完成后状态栏下方提示本次新增条数（3 秒自动消失），按 `imdbId` 去重新增
- 💾 **CSV 同步**：可通过本地同步服务将时间线实时写入 `db/timeline.csv`
- 📡 **局域网共享**：局域网设备通过链接只读浏览时间线，数据更新自动刷新；链接显示在弹窗底栏（点击复制 + 二维码）

## 📦 安装方式

1. 打开 Chrome 浏览器，进入 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目目录

## 🚀 使用方法

1. 修改 `config/tag.json` 配置监控 URL 与 1-3 个标签
2. 修改 `config/trans.json` 配置翻译模式、模型、提示词、超时时间
3. 刷新扩展，或打开扩展设置页点击「重新读取配置」
4. 全量抓取由定时任务自动执行；想立即刷新某个站点时，在弹窗内再点一次已激活的站点标签，完成后状态栏下方会提示「本次刷新新增 N 条内容」
5. 新卡片会先以英文出现；每次抓取任务开始 10 秒后，翻译线会并行扫描 `待翻译` 卡片并翻译。点击右上角 `🌐` 可手动触发全部翻译：任务在后台执行（弹窗关闭也会继续），按钮悬停提示实时显示「已处理 X/Y」进度，重新打开弹窗会自动恢复进行中状态

## 💾 CSV 同步

由于 Chrome 扩展无法直接写入项目目录文件，项目提供本地同步服务将时间线数据写入 `db/timeline.csv`。

### 启动同步服务

手动前台启动：

```bash
npm run sync
# 或
node server/sync-server.js
```

Windows 推荐使用脚本管理。`server/` 根目录只放两个日常入口，其余管理脚本在 `server/tools/`：

```bat
server\start-sync.bat          # 启动服务（日常入口）
server\setup-launcher.bat      # 一次性注册一键启动集成（见下节）
server\tools\stop-sync.bat     # 关闭
server\tools\restart-sync.bat  # 重启（升级后用）
```

`server/start-sync.bat` 会先检查 `http://127.0.0.1:31919/health`，如果服务已经运行就提示后退出，避免重复启动；否则会在当前命令窗口中启动 `server/sync-server.js`。启动后同步服务会常驻该命令窗口，持续监听扩展写入请求；关闭窗口、按 `Ctrl+C` 或运行 `server/tools/stop-sync.bat` 后服务才会停止。

扩展弹窗顶部状态栏分左右两段：左侧显示同步服务状态（`同步服务：已开启/已关闭`，点击重新检测），最前方的 `📁` 可打开同步服务脚本所在文件夹（未注册一键集成时退化为复制路径），服务关闭时还会出现 `▶ 启动` 按钮（见下方「一键启动集成」）；右侧显示当前版本与远端版本状态（读取 GitHub 仓库 master 分支的 `manifest.json`，点击重新检查）。远端有新版本时右侧会以橙色高亮提示 `v当前 → v新版 可更新`，此时 `git pull` 更新代码后在 `chrome://extensions` 重载扩展即可。如果同步服务显示已关闭，点 `▶ 启动` 或运行 `server/start-sync.bat` 后点击状态条重新检测。

服务地址：`http://127.0.0.1:31919`

本地同步服务还提供网页订阅配置写回接口，设置页「网页订阅」保存时会调用 `POST /config/tag` 写入：

```text
config/tag.json
```

因此如果需要在设置页中勾选/取消订阅并持久写回文件，请先启动同步服务；未启动时只会更新扩展本地配置。

扩展中时间线数据变化时，会自动同步到：

```text
db/timeline.csv
```

> CSV 已移除 `year` 列（发售/上映年份）——该字段在扩展界面从不展示，仅曾存在于 CSV。

CSV 默认写入为带 BOM 的 UTF-8，并使用 Windows 换行，便于 Excel/WPS 直接识别中文。如果已有 CSV 仍乱码，可先关闭 Excel/WPS，然后运行：

```bat
server\tools\fix-csv-encoding.bat
```

该脚本会把现有 `db/timeline.csv` 重新保存为 UTF-8 with BOM。也可以启动同步服务后打开一次扩展弹窗——弹窗检测到服务健康会自动补推当前时间线，让服务重新写出 CSV。

> 如果未启动同步服务，扩展仍可正常使用，只是控制台会提示 CSV 同步失败。

### 一键启动集成（Windows 可选）

浏览器扩展本身无法打开资源管理器或启动本地进程。运行一次 `server/setup-launcher.bat`（双击即可，仅写当前用户注册表 `HKCU\Software\Classes\shortscraping`，无需管理员）注册 `shortscraping://` 协议后，弹窗获得两个能力：

- `📁`：直接在资源管理器中打开 `server/` 文件夹（同时仍会复制路径作为兜底）。
- `▶ 启动`：服务关闭时一键拉起 `start-sync.bat`（最小化窗口运行，自带防重复启动探测），弹窗随后自动轮询并把状态刷新为「已开启」。

说明与边界：

- Chrome 首次触发协议时会弹「打开外部应用」确认框，勾选「一律允许」后不再询问。
- 未运行注册脚本时点击这两个按钮无副作用：`📁` 退化为复制路径 + 按系统提示（Windows 提示 Win+E 粘贴，macOS 提示 Finder ⌘⇧G），`▶` 轮询超时后给出手动启动指引。
- 协议分发器 `server/tools/launcher.vbs` 只做固定动作匹配（打开 server 文件夹 / 运行 start-sync.bat），从不把 URL 参数拼进命令行；网页即使构造 `shortscraping://` 链接也必须经过浏览器确认框，最坏结果只是打开文件夹或启动本地只读服务。
- 撤销注册：运行 `server/tools/remove-launcher.bat`。

### Windows 登录自启动

1. 按 `Win + R`，输入 `shell:startup`。
2. 将 `server/start-sync.bat` 的快捷方式放入启动目录。
3. 下次 Windows 登录后会自动启动本地同步服务。

## 📡 局域网共享

同步服务运行时会同时提供一个**只读**的局域网时间线页面：局域网内的手机、平板、其他电脑打开 `http://<本机IP>:31919/` 即可浏览与弹窗一致的时间线（六站点切换、日期分组、卡片样式），扩展抓取/翻译产生新数据时页面自动刷新（SSE 推送），无需手动刷新。

- **链接位置**：扩展弹窗底部状态栏（与翻译状态、抓取时间同一行）显示 `📡 <IP>:31919`，点击复制完整链接；旁边 `▦` 按钮弹出二维码，手机扫码直达。服务未启动时显示灰色「未启动」。
- **防火墙**：更新后首次启动同步服务时，Windows 会询问是否允许 `node.exe` 访问网络，请勾选**专用网络**并允许；拒绝后局域网设备将无法访问。
- **只读边界**：局域网设备只能浏览页面与时间线数据；写入接口（CSV 同步、订阅/翻译配置写回）仅接受本机调用，翻译 API Key 无任何读取接口。
- **仅本机模式**：不需要局域网共享时，可用 `node server/sync-server.js --local-only` 启动，退回仅 127.0.0.1 监听（此时弹窗底栏显示「不可用」）。
- **更新提示**：从旧版本升级后需重启同步服务（`server/tools/restart-sync.bat`），否则弹窗底栏拿不到局域网地址。
- **共享页没数据？**：打开一次扩展弹窗即可——弹窗检测到服务健康会自动把当前时间线推给共享服务（服务与扩展的启动先后顺序不再影响）。

## ⚙️ 配置说明

### `config/tag.json`

网页订阅完全以 `config/tag.json` 为准；程序不会自动补充任何默认订阅。未配置 URL 时，后台抓取会直接跳过。

设置页「网页订阅」为勾选式：可选规则清单来自规则目录 `config/tag.example.json`（按站点分组、标签随规则固定），勾选保存后写回 `config/tag.json`。目录仅提供候选项，未勾选的规则不会参与抓取；界面暂不支持自由添加 URL，新增规则请编辑 `config/tag.example.json` 后重载扩展。

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

目前支持六个站点（内容脚本按域名自动识别）：

- **IMDB** 榜单/搜索页：列表取条目，进详情页补简介与公司。
- **Steam** 内容中心页（`/category/<name>` 与 `/tags/<locale>/<标签名>`）：列表来自官方动态查询接口，再用 `appdetails` 接口（`?l=english`）补英文名/简介/开发者；成人专属或受限作品（接口 `success=false`）自动跳过。
- **RoyalRoad** 榜单页（`/fictions/*`）：服务端渲染，列表自带标题/封面/全文简介，详情页补作者。
- **My Drama** 主站首页「最流行」板块与 fandom 子域（`fandom.my-drama.com`）文章流 / Trending 菜单：fandom 条目通过文章内回主站链接与主站条目全局去重。
- **ReelShort** 主站首页「TOP」板块（`www.reelshort.com`，解析页内 `__NEXT_DATA__` SSR 数据）与 `/fandom/` 文章流：fandom 条目通过文章内回主站 `/movie/` 链接与主站条目全局去重。
- **DramaShorts**（`dramashorts.io`，解析页内 `__NEXT_DATA__` SSR 数据）：`/top-movies` 榜单页与首页板块；首页订阅 URL 用 `?list=<板块id>` 选板块（`top_trending` / `popular_now` / `audience_favorite`），列表自带全文简介，无需请求详情页。

### `config/cron.json`

定时任务单独配置，不与翻译接口配置混放。

```json
{
  "scheduleMode": "cron",
  "scrapeCron": "45 * * * *",
  "translateCron": "50 * * * *"
}
```

`scheduleMode` 支持：

- `cron`：按 5 段 cron 表达式调度，格式为 `分钟 小时 日期 月份 星期`；例如 `45 * * * *` 表示每小时第 45 分钟执行。
- `interval`：兼容旧配置，按 `scrapeInterval` / `translateInterval` 的小时数循环执行。

Cron 模式下扩展会计算下一次执行时间并创建一次性 Chrome Alarm；任务触发完成后再排下一次，避免 service worker 被唤醒时反复清空并重置定时任务。

### `config/trans.json`

翻译接口单独配置，不包含 Cron 或间隔定时字段。

```json
{
  "translateMode": "ai",
  "aiEndpoint": "https://api.example.com/chat/completions",
  "aiApiKey": "",
  "aiModel": "your-model",
  "requestTimeoutSec": 10
}
```

> 不要把真实 API Key 提交到公开仓库；本地使用时自行填写。`config/tag.json`、`config/cron.json` 与 `config/trans.json` 已加入 `.gitignore`，可共享模板位于 `config/tag.example.json`、`config/cron.example.json` 与 `config/trans.example.json`。

## 📁 项目结构

```text
ShortScraping/
├── manifest.json                 # Chrome 扩展配置
├── package.json                  # 本地同步服务脚本
├── README.md
├── src/
│   ├── background/background.js  # 后台 service worker
│   ├── content/                  # 内容脚本
│   ├── popup/                    # 扩展弹窗页面
│   ├── settings/                 # 设置中心：配置文件、网页订阅、定时任务、翻译接口、数据存档
│   └── shared/                   # 共享模块：translator.js（翻译）、timeline-render.js（时间线渲染，弹窗与共享页共用）、qrcode.js（二维码）
├── assets/icons/                 # 扩展图标、站点图标与默认海报
├── config/                       # 本地配置与示例配置
├── server/                       # 本地同步服务（CSV + 局域网共享页）；根目录仅日常入口 start-sync.bat / setup-launcher.bat
│   ├── public/                   # 局域网只读时间线页面（share.html/css/js）
│   └── tools/                    # 管理脚本：stop/restart-sync、fix-csv-encoding、remove-launcher、launcher.vbs（协议分发器）
├── db/timeline.csv               # 本地 CSV 输出
└── db/timeline.json              # 时间线快照（局域网页面数据源，服务重启后回读）
```

## 🔧 技术栈

- Chrome Extension Manifest V3
- 原生 JavaScript
- Chrome Storage API
- Chrome Alarms API
- Chrome Notifications API
- Node.js 本地同步服务（CSV 写入 + 局域网只读共享页，SSE 实时推送）
