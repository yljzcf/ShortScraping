/**
 * ShortScraping Local Sync & LAN Share Server
 *
 * Chrome 扩展无法直接写入项目目录文件，因此由本地 Node 服务接收扩展数据，
 * 将时间线内容实时同步到 db/timeline.csv，并向局域网提供只读时间线页面。
 *
 * 启动：node server/sync-server.js [--local-only] [--allow-host=<域名>]
 *   默认监听 0.0.0.0，局域网设备可通过 http://<本机IP>:31919/ 访问只读共享页；
 *   --local-only 退回仅本机 127.0.0.1；--allow-host=<域名>（可多次）放行用该主机名访问共享页
 *   （默认只认 IP 与 localhost，见 ALLOWED_HOSTS）。测试可用环境变量 SHORTSCRAPING_PORT 覆盖端口
 *   （扩展只连 31919，非默认端口启动时会打印告警）。
 *
 * 安全边界：写入接口（POST /sync、POST /config/*、POST /shutdown、POST /restart）仅接受
 * 本机回环地址调用，局域网设备只能访问只读页面与只读数据接口；trans.json（含 API Key）与
 * lark.json（webhook 地址即写权限凭据）均无任何读取接口。
 */

const http = require('http');
const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');
const { spawn, spawnSync } = require('child_process');
const SubscriptionConfig = require('../src/shared/subscription-config.js');
const Lark = require('../src/shared/lark.js');
const TimelineCsv = require('../src/shared/timeline-csv.js');
const ScheduleConfig = require('../src/shared/schedule-config.js');
const TranslateConfig = require('../src/shared/translate-config.js');
const SiteRegistry = require('../src/shared/site-registry.js');

const DEFAULT_PORT = 31919;
// 专用变量名而不是通用的 PORT：开发者在 ~/.zshrc / direnv / Windows 用户变量里给别的项目设的 PORT
// 会被静默继承，服务跑到扩展连不上的端口，stop / restart 也跟着去找错端口（与 stop.js 同一口径）
const PORT = Number(process.env.SHORTSCRAPING_PORT) || DEFAULT_PORT;
// macOS 开机自启的 launchd 标签（server/setup-autostart.command 注册）；launchd 会把它写进
// 子进程的 XPC_SERVICE_NAME，据此判断重启该交给 launchd 还是自行派生新实例
const LAUNCHD_LABEL = 'com.shortscraping.sync';
const LAUNCHD_MANAGED = process.env.XPC_SERVICE_NAME === LAUNCHD_LABEL;
const RESTART_EXIT_CODE = 75; // 非零退出才触发 KeepAlive.SuccessfulExit=false 的拉起
// 自行重启派生的新实例带此标记：旧实例还没让出端口时重试监听，而不是直接报占用退出
const WAIT_PORT_ENV = 'SHORTSCRAPING_WAIT_PORT';
const WAIT_PORT_TIMEOUT_MS = 10000;
const LOCAL_ONLY = process.argv.includes('--local-only');
// 域名形态的 Host 默认拒绝（DNS rebinding 只能经域名发起）；确需用主机名访问
// 共享页时显式放行：node server/sync-server.js --allow-host=mypc.local
const ALLOWED_HOSTS = new Set(process.argv
  .filter(arg => arg.startsWith('--allow-host='))
  .map(arg => arg.slice('--allow-host='.length).trim().toLowerCase())
  .filter(Boolean));
const PROJECT_DIR = path.join(__dirname, '..');
const DB_DIR = path.join(PROJECT_DIR, 'db');
const CONFIG_DIR = path.join(PROJECT_DIR, 'config');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SHARED_DIR = path.join(PROJECT_DIR, 'src', 'shared');
const ICONS_DIR = path.join(PROJECT_DIR, 'assets', 'icons');
const CSV_PATH = path.join(DB_DIR, 'timeline.csv');
const TIMELINE_JSON_PATH = path.join(DB_DIR, 'timeline.json');
// 已知片单（v1.7.0）：只记 ID、不入库的条目（扩展 storage.knownItems 的备份，扩展重装后据此恢复）
const KNOWN_ITEMS_PATH = path.join(DB_DIR, 'known-items.json');
const TAG_CONFIG_PATH = path.join(CONFIG_DIR, 'tag.json');
const TRANS_CONFIG_PATH = path.join(CONFIG_DIR, 'trans.json');
const LARK_CONFIG_PATH = path.join(CONFIG_DIR, 'lark.json');
const CRON_CONFIG_PATH = path.join(CONFIG_DIR, 'cron.json');
const SYNC_ORIGIN_PATH = path.join(CONFIG_DIR, 'sync-origin.json');
// 🔄 派生的接替实例没有终端可写，stdout/stderr 接到这份日志。darwin 与 launchd 的
// StandardOutPath（setup-autostart.command）是同一文件：不管服务由谁拉起，排查都只看一处。
// 测试用 SHORTSCRAPING_LOG_FILE 指到临时目录，不写用户的 ~/Library
const LOG_PATH = process.env.SHORTSCRAPING_LOG_FILE
  ? path.resolve(process.env.SHORTSCRAPING_LOG_FILE)
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Logs', 'ShortScraping', 'sync.log')
    : path.join(PROJECT_DIR, 'logs', 'sync.log');
// —— 局域网共享状态：最新时间线快照（内存 + db/timeline.json 持久化） ——
let latestDramas = [];
let latestSerialized = '[]';
// 快照内容指纹：latestSerialized 的 sha1（hex），只经 commitSnapshotContent 与前两者一起前进。
// 不写进 timeline.json：重启时 loadSnapshot 从同一份内容重算，天然跨重启稳定。
// 供 /health 本机块、/sync 响应（扩展 v1.6.22 起的冷启动指纹比对）与 /api/timeline 的 ETag 使用
let contentHash = sha1Hex(latestSerialized);
let dataVersion = 0;
let updatedAt = null;
// CSV 单独记签名：json 快照落盘成功而 CSV 失败（Windows 上被 Excel 锁住）时，
// 共享页照常前进，下一次同内容推送仍要补写 CSV，不能因快照签名相同被跳过。
// null＝已知磁盘上的 CSV 落后于快照（见 loadSnapshot），下一次推送必写
let csvSerialized = '[]';
const sseClients = new Set();

// 本次启动时 CSV 不存在、由 ensureDb 新建了只有表头的空文件：停机期间被手删（或首次运行）。
// loadSnapshot 据此判定 CSV 落后于快照（启动时由 healCsvFromSnapshot 补写）——新建文件比快照新，单看 mtime 认不出它落后
let csvCreatedAtStartup = false;

function sha1Hex(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

// latestDramas / latestSerialized / contentHash 三者必须同步前进（ETag、/health 指纹都依赖它们一致），只经这里改
function commitSnapshotContent(dramas, serialized) {
  latestDramas = dramas;
  latestSerialized = serialized;
  contentHash = sha1Hex(serialized);
}

// 磁盘上的 CSV 与快照文件都已知与内存快照一致：CSV 签名相同且两份文件都还在。任一份运行期间被手删，
// 这里即为 false——扩展冷启动指纹比对（v1.6.22）据此判定过期并补推，/sync 的 existsSync 守卫与
// timeline.json 自愈随即补写。只看 CSV 的话，timeline.json 被删后指纹仍判一致，要等时间线变化才补写。
// 空快照从不落 timeline.json（首启只建空 CSV），文件不在不算落后。
// csvSerialized 为 null（见 loadSnapshot）或落后于快照时都是 false
function csvInSync() {
  const snapshotOnDisk = latestSerialized === '[]' || fs.existsSync(TIMELINE_JSON_PATH);
  return csvSerialized === latestSerialized && fs.existsSync(CSV_PATH) && snapshotOnDisk;
}

function ensureDb() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, TimelineCsv.buildTimelineCsv([]).content, 'utf8');
    csvCreatedAtStartup = true;
  }
}

// 原子落盘单一真源：先写同目录 .tmp 再 rename，进程中断不会留下半截文件。
// CSV、局域网快照与四个配置文件共用，改写入策略（重试、fsync、临时名）只改这里。
// options.mode 只给带明文密钥的配置用（见 SECRET_FILE_MODE），其余文件沿用 umask 默认权限
function writeFileAtomic(filePath, content, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const { mode } = options;
  fs.writeFileSync(tmpPath, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  // writeFileSync 的 mode 只在新建时生效：上次中断残留的 .tmp 会沿用旧的 0644，rename 前再收紧一次。
  // 目标文件不用单独 chmod——rename 让它直接换成 .tmp 的 inode，旧文件的宽松权限随之作废。
  // Windows 的 chmod 只认只读位，权限靠目录 ACL，不在这里处理
  if (mode !== undefined && process.platform !== 'win32') fs.chmodSync(tmpPath, mode);
  if (process.platform === 'win32') renameWithRetryWin32(tmpPath, filePath);
  else fs.renameSync(tmpPath, filePath);
}

// Windows 上目标文件被别的程序打开着（最常见：Excel 打开 timeline.csv）时 MoveFileEx 覆盖会报
// EPERM/EACCES/EBUSY。杀毒、索引服务的短暂占用退避几次就能过去；Excel 这种长期占用则换成
// 能看懂的错误（经 /sync 500 回给扩展），并清掉 .tmp，免得用户目录里多出一个半成品文件
const WIN_RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const WIN_RENAME_RETRY_DELAYS_MS = [50, 150, 400];

function renameWithRetryWin32(tmpPath, filePath) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (error) {
      if (!WIN_RENAME_RETRY_CODES.has(error.code)) throw error;
      if (attempt >= WIN_RENAME_RETRY_DELAYS_MS.length) {
        try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* 清理失败不掩盖原错误 */ }
        // 配置文件也走这里，而它们不会随 /sync 自动重写：「下次同步补写」只对 CSV / 快照成立
        const hint = filePath === CSV_PATH || filePath === TIMELINE_JSON_PATH ? '关闭后下次同步会自动补写' : '关闭后请重新保存';
        throw new Error(`${path.basename(filePath)} 被其他程序占用（如 Excel 正打开它），${hint}：${error.message}`);
      }
      // 调用链全是同步的（/sync 一次请求内按序落盘），用 Atomics.wait 原地等待而不是改成异步
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WIN_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function writeJsonAtomic(filePath, value, options) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

// trans.json（aiApiKey）与 lark.json（feishuAppSecret、webhook）存的是明文密钥，只许属主读写：
// 项目放在 /Users/Shared、/opt 这类可遍历目录时，默认的 0644 让同机其他账号直接 cat 走
const SECRET_FILE_MODE = 0o600;

// 手改配置常带 UTF-8 BOM（PowerShell 5.1 的 Set-Content -Encoding UTF8、编辑器的「UTF-8 with BOM」）。
// 扩展端 fetch().json() 会自动剥掉，fs 读出来却原样留着、JSON.parse 直接报错——
// 同一份文件扩展能读、服务端却让 /sync 永久 500。服务端从磁盘读 JSON 一律经这里
function parseJsonText(text) {
  return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
}

// —— 覆盖 db/timeline.* 之前留痕（v1.6.7）——
// 2026-09-17 事故：用户退订后扩展推来的快照少了 1847 条，服务端原样覆盖，
// timeline.csv 与 timeline.json 两份本地副本同时消失（原子写 rename 不留旧文件）。
// 两档留痕，都只挂在**真正要覆盖**的那一支（同内容推送本就不重写，见 /sync），
// 所以 SW 每次唤醒的预热推送不会刷屏：
//   每日档 timeline-YYYYMMDD.json        当天第一次改写前的状态，保留最近 7 份（每个有改写的日子至多一份）；
//   drop 档 timeline-YYYYMMDD-HHMMSS-mmm-drop.json
//                                        条数清空或跌超 20%、或任一站点（原有 ≥10 条）跌超 20% 时
//                                        额外留一份，保留最近 10 份。
// 事故形态必定落在 drop 档；日常改写只多出每天一个文件。
// 只存 timeline.json（v1.7.1，2026-09-27 用户定）：设置页「导入恢复」只认 JSON，CSV 随时能由 JSON 重新生成，
// 以前 CSV、JSON 各存一份，备份目录一半是用不上的副本；每日档也从 14 份减到 7 份。旧版本留下的 .csv 备份
// 不轮转、不自动删（是同名 JSON 的副本，可手动删除）。盘上还没有 timeline.json 时（新装的第一次推送）没有
// 旧快照可留，当天的每日档在下一次改写时再留
const HISTORY_DIR = path.join(DB_DIR, 'history');
const HISTORY_KEEP_DAILY = 7;
const HISTORY_KEEP_DROP = 10;
const HISTORY_DROP_RATIO = 0.8;
// 分站点口径（v1.6.21）：整表 80% 看不见「只清空一个站」——2026-09 实测清空 royalroad（430/2239，占 19.2%）
// 不留任何 drop 档。站点原有不足 10 条时不算：小站换榜、下架几条就是 20%，会把 10 份 drop 档挤成噪声
const HISTORY_SITE_DROP_MIN = 10;

function countBySite(dramas) {
  const counts = new Map();
  for (const drama of dramas) {
    const site = SiteRegistry.siteOfDrama(drama); // 与共享页站点标签同口径（注册表外的 source 归 imdb）
    counts.set(site, (counts.get(site) || 0) + 1);
  }
  return counts;
}

/** 条数骤降的站点：[{ site, prev, next }]，按站点在旧快照里首次出现的顺序。 */
function findSiteDrops(nextDramas, prevDramas) {
  const nextCounts = countBySite(nextDramas);
  const drops = [];
  for (const [site, prev] of countBySite(prevDramas)) {
    const next = nextCounts.get(site) || 0;
    if (prev >= HISTORY_SITE_DROP_MIN && next < prev * HISTORY_DROP_RATIO) drops.push({ site, prev, next });
  }
  return drops;
}

// drop 档的时刻带毫秒：退订那一刻扩展可能在同一秒内连推两次（清理后紧跟一次预热），
// 只到秒会让后一份覆盖前一份、正好丢掉最该留的那一版。字典序仍等于时间序。
function stampParts(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    day: `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`
  };
}

// 源文件是原子写落定的完整文件，copyFileSync 拿到的必然是一致快照；还没有 timeline.json（新装的第一次推送）
// 时跳过不报错。返回留下的备份路径（没有就是空数组）
function copyTimelineSnapshot(baseName) {
  if (!fs.existsSync(TIMELINE_JSON_PATH)) return [];
  const target = path.join(HISTORY_DIR, `${baseName}.json`);
  fs.copyFileSync(TIMELINE_JSON_PATH, target);
  return [target];
}

// 同类备份只保留最近 keep 份：文件名以 YYYYMMDD[-HHMMSS] 开头，字典序即时间序
function rotateHistory(pattern, keep) {
  const names = fs.readdirSync(HISTORY_DIR).filter(name => pattern.test(name)).sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    fs.rmSync(path.join(HISTORY_DIR, name), { force: true });
  }
}

// 上一份 drop 档备份的源内容签名（即当时的 latestSerialized）与路径。落盘失败时扩展会反复重推
// 同一份骤降快照，源状态没变，每次都另存一份会在几次重试内把此前 10 份不同时刻的 drop 档全部挤掉
let lastDrop = { signature: null, paths: [] };

/**
 * 返回 drop 档路径（未触发则空数组）供调用方写进告警。siteDrops 是 findSiteDrops 的结果，非空也触发 drop 档。
 * 备份失败只警告不抛——留痕是保险，不该成为同步的前置条件。
 */
function backupBeforeOverwrite(nextCount, prevCount, prevSignature, siteDrops = []) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const { day, time } = stampParts();

    if (!fs.existsSync(path.join(HISTORY_DIR, `timeline-${day}.json`))) {
      copyTimelineSnapshot(`timeline-${day}`);
      rotateHistory(/^timeline-\d{8}\.json$/, HISTORY_KEEP_DAILY);
    }

    const tableDropped = prevCount > 0 && nextCount < prevCount * HISTORY_DROP_RATIO;
    if (!tableDropped && siteDrops.length === 0) return [];
    // 同一源状态已留过 drop 档：它是最新一份、不会被轮转掉，直接复用路径写进告警
    if (prevSignature === lastDrop.signature) return lastDrop.paths;
    const dropPaths = copyTimelineSnapshot(`timeline-${day}-${time}-drop`);
    rotateHistory(/^timeline-\d{8}-\d{6}-\d{3}-drop\.json$/, HISTORY_KEEP_DROP);
    lastDrop = { signature: prevSignature, paths: dropPaths };
    return dropPaths;
  } catch (error) {
    console.warn('[ShortScraping Sync] 落盘前备份失败（不影响同步）:', error.message);
    return [];
  }
}

// CSV 列序/转义/去重/normalizeDrama 单一真源在 src/shared/timeline-csv.js
// （与设置页「导出 CSV」共用）；本函数只负责落盘
function writeTimelineCsv(dramas) {
  const { content, count } = TimelineCsv.buildTimelineCsv(dramas);
  writeFileAtomic(CSV_PATH, content);
  return count;
}

// 订阅规范化单一真源在 src/shared/subscription-config.js（v1.6.5 收敛，与扩展端同一份语义）；
// 这里只做文件形态投影 { url, tags }
function normalizeTagConfig(rawTags) {
  return SubscriptionConfig.toTagFileEntries(rawTags);
}

/**
 * 写入前的强校验：设置页只会发合法条目，坏数据一律拒绝落盘（绝不静默收窄）。拒绝回 400（带 statusCode，
 * 与另外三个配置写回接口缺键时同口径；v1.7.0 前是 500 并打整段堆栈，像服务自己出了错）。
 */
function assertTagConfig(rawTags) {
  const reject = message => Object.assign(new Error(message), { statusCode: 400 });
  if (!Array.isArray(rawTags)) throw reject('网页订阅必须是数组');
  const tags = normalizeTagConfig(rawTags);
  if (tags.length !== rawTags.length) throw reject('网页订阅包含无效或重复条目');
  return tags;
}

function writeTagConfig(rawTags) {
  const tags = assertTagConfig(rawTags);
  writeJsonAtomic(TAG_CONFIG_PATH, tags);
  return tags.length;
}

// 翻译 / Lark / 定时三个写回接口的请求体形态闸：必须是 { <key>: 普通对象 }，缺键、null、数组、
// 键名写错一律返回 null（路由回 400、不落盘）。旧写法 `payload.X || {}` 会把缺键规范化成默认配置
// 原子覆盖文件：API Key、webhook、App Secret 静默清空，且这三份没有 history 备份，
// SW 下次唤醒还会把清空后的文件回灌进 storage。设置页 trySyncConfig 始终发完整对象，不受影响
function pickConfigObject(payload, key) {
  const value = payload?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function writeTransConfig(rawConfig) {
  const config = TranslateConfig.normalizeConfig(rawConfig);

  writeJsonAtomic(TRANS_CONFIG_PATH, config, { mode: SECRET_FILE_MODE });
  return config;
}

function writeLarkConfig(rawConfig) {
  const config = Lark.normalizeConfig(rawConfig);

  writeJsonAtomic(LARK_CONFIG_PATH, config, { mode: SECRET_FILE_MODE });
  return config;
}

// 拒绝坏配置范式（同 /config/tag）：cron 表达式校验不过直接抛（→400，v1.7.0 前是 500），
// 文件不动——非法调度落盘会让扩展 SW 每次唤醒都读到坏配置
function writeCronConfig(rawConfig) {
  const { ok, errors, config } = ScheduleConfig.validateConfig(rawConfig);
  if (!ok) {
    const detail = Object.entries(errors).map(([key, msg]) => `${key}: ${msg}`).join('；');
    throw Object.assign(new Error(`Cron 配置无效——${detail}`), { statusCode: 400 });
  }

  writeJsonAtomic(CRON_CONFIG_PATH, config);
  return config;
}

let missingTagConfigWarned = false;

/**
 * 读取订阅配置，三态而非二态（2026-09-11 复查）：
 *   1) 文件不存在 → 返回 null，由调用方区分两种情形（见 filterDramasByTagConfig）：现有快照为空＝尚未在
 *      设置页保存过订阅的引导态，按零订阅处理（新 clone 必然没有这个 gitignored 文件，不能每次推送都报错）；
 *      现有快照非空＝文件被删 / 改名 / 项目挪了位置，拒绝推送（409 TAG_CONFIG_MISSING，v1.7.0）；
 *   2) 读不动 / JSON 损坏 / 根不是数组 / 整份条目全部失效 → 抛错，由调用方拒绝
 *      本次同步并保住已有 CSV 与共享快照——这是「坏配置不清空数据」的底线；
 *   3) 个别条目无效或重复 → 告警后丢弃该条，与扩展端 normalizeUrlTags 口径一致，
 *      不因一条手写错误让整份文件失效、把 /sync 变成永久 500。
 */
function readTagConfig() {
  let text;
  try {
    text = fs.readFileSync(TAG_CONFIG_PATH, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`读取 tag.json 失败，保留现有数据：${error.message}`);
    return null;
  }
  missingTagConfigWarned = false;

  let raw;
  try {
    raw = parseJsonText(text);
  } catch (error) {
    throw new Error(`读取 tag.json 失败，保留现有数据：${error.message}`);
  }
  if (!Array.isArray(raw)) throw new Error('读取 tag.json 失败，保留现有数据：网页订阅必须是数组');

  const tags = normalizeTagConfig(raw);
  if (raw.length > 0 && tags.length === 0) {
    throw new Error('读取 tag.json 失败，保留现有数据：全部订阅条目无效或重复');
  }
  if (tags.length !== raw.length) {
    console.warn(`[ShortScraping Sync] tag.json 有 ${raw.length - tags.length} 条订阅无效或重复，已跳过（扩展端同样忽略它们）`);
  }
  return tags;
}

/**
 * tag.json 不见了、现有快照却非空：拒绝按「零订阅」把整张时间线滤成空再覆盖（v1.7.0 审查 M1）。
 * 以前缺文件一律当零订阅，下一次非空推送被滤成 []，照写 db/timeline.json / .csv 与共享页，只剩一份 drop 档；
 * 扩展那头读不到文件时保留上一次的订阅照常推，用户毫无察觉。发生在备份与落盘之前，什么都不写；
 * 扩展 409 分支不重推同内容，弹窗按 /health 的 tagConfigMissing 提示去设置页保存一次订阅（重建本文件）。
 */
function tagConfigMissingError(existingCount) {
  const error = new Error(`未找到 config/tag.json，已拒绝按零订阅覆盖现有 ${existingCount} 条时间线（未写入任何文件）；` +
    '请在扩展设置页「网页订阅」点一次保存以重新生成该文件');
  error.statusCode = 409;
  error.apiCode = 'TAG_CONFIG_MISSING';
  return error;
}

// 与扩展端同规则：尾斜杠归一后的精确等值、零订阅返回 []。归属判定单一真源是
// SubscriptionConfig.dramasUnderUrls（内部委托 src/shared/url-match.js），这里不再另写一份
function filterDramasByTagConfig(dramas) {
  const tags = readTagConfig();
  if (tags === null) {
    // 推送本身为空（扩展声明 allowEmpty 的清空）照常放行：滤不滤结果都是空
    if (dramas.length > 0 && latestDramas.length > 0) throw tagConfigMissingError(latestDramas.length);
    if (!missingTagConfigWarned) {
      missingTagConfigWarned = true;
      console.warn(`[ShortScraping Sync] 未找到 ${TAG_CONFIG_PATH}，按零订阅处理；在设置页保存一次网页订阅即可生成`);
    }
    return [];
  }
  return SubscriptionConfig.dramasUnderUrls(dramas, tags.map(item => item.url));
}

// —— 局域网共享：快照持久化、SSE 广播与地址枚举 ——

function loadSnapshot() {
  try {
    if (!fs.existsSync(TIMELINE_JSON_PATH)) return;
    const raw = parseJsonText(fs.readFileSync(TIMELINE_JSON_PATH, 'utf8'));
    const dramas = Array.isArray(raw.dramas) ? raw.dramas : [];
    commitSnapshotContent(dramas, JSON.stringify(dramas));
    // /sync 先写 json 再写 CSV，正常情况下 CSV 不会比快照旧；旧了说明上次运行里 CSV 写失败
    // （Windows 上被 Excel 锁住）后没等到补写就重启了——签名留空，启动时 healCsvFromSnapshot 按快照补写
    // （补写失败则由首次推送补写），否则重启后同内容推送会一直跳过它。服务运行期间 CSV 被手删，由 /sync 的
    // existsSync 守卫兜底；停机期间被删的，启动时 ensureDb 已先建出只有表头的新文件（比快照新、mtime 认不出），
    // 靠 csvCreatedAtStartup 补上
    csvSerialized = csvCreatedAtStartup || csvOlderThanSnapshot() ? null : latestSerialized;
    dataVersion = Number.isInteger(raw.version) ? raw.version : 0;
    updatedAt = raw.updatedAt || null;
    console.log(`[ShortScraping Sync] 已恢复时间线快照：${latestDramas.length} 条（version ${dataVersion}）`);
  } catch (error) {
    console.warn('[ShortScraping Sync] 读取时间线快照失败，将等待扩展下一次推送:', error.message);
  }
}

function csvOlderThanSnapshot() {
  try {
    return fs.statSync(CSV_PATH).mtimeMs < fs.statSync(TIMELINE_JSON_PATH).mtimeMs;
  } catch (_) {
    return false; // CSV 不存在交给 existsSync 守卫
  }
}

// 启动自愈（v1.6.21）：loadSnapshot 判定 CSV 落后于快照（停机期间被删 / 上次 CSV 写失败后没等到补写就重启）时，
// 直接按内存快照补写，不必等扩展下一次推送；/health 的 csvInSync 随即回到 true，扩展冷启动比对指纹时
// 不会因此白推一次整表。快照为空时不动：ensureDb 刚建的表头文件本就与空快照一致，另一种情形（旧 CSV 有行、
// 快照已清空）交给推送，启动时不凭空删行。写失败只告警，csvSerialized 留 null，下一次推送照旧补写
function healCsvFromSnapshot() {
  if (csvSerialized !== null || latestDramas.length === 0) return;
  try {
    const count = writeTimelineCsv(latestDramas);
    csvSerialized = latestSerialized;
    console.log(`[ShortScraping Sync] CSV 落后于时间线快照，已按快照补写：${count} 条`);
  } catch (error) {
    console.warn('[ShortScraping Sync] 按快照补写 CSV 失败，等扩展下一次推送再补:', error.message);
  }
}

// 传入待提交的新状态而不是读全局：先落盘、成功后调用方才改内存，失败不留「内存已前进、磁盘没跟上」
function saveSnapshot(snapshot) {
  writeFileAtomic(TIMELINE_JSON_PATH, JSON.stringify(snapshot));
}

function broadcastUpdate() {
  const payload = `event: update\ndata: ${JSON.stringify({ version: dataVersion })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (error) {
      sseClients.delete(client);
    }
  }
}

// 局域网地址优先级：家用网段 192.168.* 最常见，排最前便于弹窗默认展示
function lanScore(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}

function getLanUrls() {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  ips.sort((a, b) => lanScore(a) - lanScore(b));
  return ips.map(ip => `http://${ip}:${PORT}`);
}

function isLocalRequest(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Host 校验按「类型」而不是枚举本机地址：DNS rebinding 的前提是攻击者控制一个
 * 域名，IP 字面量与 localhost 不可能被 rebinding。枚举 os.networkInterfaces()
 * 会把局域网共享页的主机名/mDNS/VPN 名/端口转发访问全部误杀（还要每请求一次系统调用），
 * 而这些正是「同网设备只读浏览」邀请的用法。
 */
function isAllowedHost(hostHeader) {
  const header = (hostHeader || '').trim().toLowerCase();
  if (!header) return false;
  // IPv6 字面量形如 [::1]:31919；IPv4/主机名形如 127.0.0.1:31919
  const hostname = (header.startsWith('[') ? header.slice(0, header.indexOf(']') + 1) : header.split(':')[0])
    .replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  return ALLOWED_HOSTS.has(hostname) || ALLOWED_HOSTS.has(header);
}

const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;
// 会改盘或进程状态的写路由：只有「来源合格 + JSON 请求体 + 这些路由」的请求才可能触发首见即固定（v1.7.0）。
// 以前固定发生在 Content-Type 与路由判定之前，未固定期间任何扩展发个 415 / 404 的 POST 也能抢走固定位
const WRITE_ROUTES = new Set(['/sync', '/config/tag', '/config/trans', '/config/lark', '/config/cron', '/known-items', '/shutdown', '/restart']);
let pinnedWriteOrigin = null;

/** 盘上的固定来源：{ state: 'missing' }（文件不在）/ { state: 'ok', origin } / { state: 'unreadable' }（读不动、坏 JSON、来源不合法）。 */
function readPinnedWriteOriginFile() {
  let text;
  try {
    text = fs.readFileSync(SYNC_ORIGIN_PATH, 'utf8');
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const raw = parseJsonText(text);
    if (EXTENSION_ORIGIN_PATTERN.test(raw && raw.origin)) return { state: 'ok', origin: raw.origin };
  } catch (error) {
    // 坏 JSON：同下，按读不动处理
  }
  return { state: 'unreadable' };
}

function loadPinnedWriteOrigin() {
  const file = readPinnedWriteOriginFile();
  // 尚未固定（或文件坏了）时内存留空：前者等第一次合格写入建立，后者由 writeOriginVerdict 重读后拒绝（fail closed）
  if (file.state === 'ok') pinnedWriteOrigin = file.origin;
}

/**
 * 写接口来源判定（无副作用的读判定）：'allow' 放行；'pin' 放行，并在请求过完 Content-Type 与路由闸门后
 * 固定为写入来源（pinWriteOrigin）；'deny' 拒绝。
 *
 * chrome-extension:// 正则只能证明「是某个扩展」——同一 profile 下任何持 localhost 主机权限的扩展都能
 * 冒名清空数据，因此只认「首次写入时固定下来的那一个」（首见即固定 / TOFU，存 config/sync-origin.json，
 * 已 gitignore）；换目录重载扩展导致 ID 变化时，删掉该文件即可重新固定。Node 管理工具不带 Origin，照常放行。
 *
 * 内存里的固定值与请求来源不符（或尚未固定）时**重读**该文件（v1.7.0 审查 M3）：以前只在启动时读一次，
 * 照 README 删了文件照样 403——服务（开机自启下常驻）还攥着内存里的旧值，弹窗 🔄 重启请求自己也被 403，
 * 只剩 npm run restart 这条不带 Origin 的路。现在：
 *   - 文件已删 → 回到未固定，这个请求过完其余闸门即重新固定（与首次启动同一个 TOFU 窗口）；
 *   - 文件里正是请求来源（用户手改）→ 采用并放行；是别的来源 → 采用该值并拒绝；
 *   - 读不动 / 坏 JSON / 来源不合法 → 拒绝（fail closed：一个坏文件不能把写接口敞开），403 提示删文件重来。
 * 只在来源不符时读一次小文件，正常写入零磁盘读。
 *
 * 为什么不按项目路径推算扩展 ID 做强校验：manifest 没有 key 字段，未打包扩展的 ID 确实
 * 由加载目录的绝对路径派生（SHA-256 取前 16 字节映射到 a-p），PROJECT_DIR 在手，理论上
 * 能算。但 Chrome 用的是它自己规范化后的路径（解析符号链接；Windows 盘符大写并按 UTF-16LE
 * 取字节；macOS 上含中文的目录名 NFC/NFD 未必与 __dirname 一致），扩展也可能从另一份副本
 * 目录加载——算错一次，用户自己的扩展就被 403、同步悄悄失效。给 manifest 加 key 固定 ID
 * 又会换掉现有用户的扩展 ID、丢光 chrome.storage.local。能钻 TOFU 窗口（首次固定前、
 * 或按 README 删掉该文件后）抢先写入的，只能是已装进同一 profile、持 127.0.0.1 或全站
 * 主机权限的扩展，它本就能读全部网页数据，增量风险很低，因此维持首见即固定（2026-09 复核）。
 */
function writeOriginVerdict(req) {
  const origin = req.headers.origin;
  if (origin === undefined) {
    // 浏览器发起的请求一定带 Origin 或 Sec-Fetch-*；两者皆无才视为本机 Node 工具
    return req.headers['sec-fetch-site'] === undefined ? 'allow' : 'deny';
  }
  if (!EXTENSION_ORIGIN_PATTERN.test(origin)) return 'deny';
  if (origin === pinnedWriteOrigin) return 'allow';
  const file = readPinnedWriteOriginFile();
  if (file.state === 'missing') {
    pinnedWriteOrigin = null;
    return 'pin';
  }
  if (file.state === 'ok') {
    pinnedWriteOrigin = file.origin;
    if (file.origin === origin) return 'allow';
    console.warn(`[ShortScraping Sync] 拒绝非固定扩展的写入请求：${origin}`);
    return 'deny';
  }
  console.warn(`[ShortScraping Sync] ${SYNC_ORIGIN_PATH} 读不动或内容无效，拒绝写入请求：${origin}；删除该文件后重试即可重新固定`);
  return 'deny';
}

function pinWriteOrigin(origin) {
  pinnedWriteOrigin = origin;
  try {
    writeJsonAtomic(SYNC_ORIGIN_PATH, { origin, pinnedAt: new Date().toISOString() });
  } catch (error) {
    console.warn('[ShortScraping Sync] 写入来源固定失败（本次运行内仍生效）:', error.message);
  }
  console.log(`[ShortScraping Sync] 已固定写入来源扩展：${origin}；换目录重载扩展后如被拒，删除 ${SYNC_ORIGIN_PATH} 即可重新固定（无需重启服务）`);
}

/** 403 应答体：格式合法的扩展来源被拒时点明怎么恢复（换目录重载扩展是最常见的原因），其余来源只给短句。 */
function originDeniedBody(req) {
  if (!EXTENSION_ORIGIN_PATTERN.test(req.headers.origin || '')) return { ok: false, error: '写入请求来源不受信任' };
  return {
    ok: false,
    code: 'ORIGIN_NOT_PINNED',
    error: '写入请求来源与已固定的扩展不符：若是换目录重载了扩展，删除 config/sync-origin.json 后重试即可重新固定（无需重启同步服务）'
  };
}

// —— 静态文件（显式白名单，防路径穿越） ——

const STATIC_ROUTES = {
  '/': { file: path.join(PUBLIC_DIR, 'share.html'), type: 'text/html; charset=utf-8' },
  '/public/share.css': { file: path.join(PUBLIC_DIR, 'share.css'), type: 'text/css; charset=utf-8' },
  '/public/share.js': { file: path.join(PUBLIC_DIR, 'share.js'), type: 'text/javascript; charset=utf-8' },
  '/shared/timeline-render.js': { file: path.join(SHARED_DIR, 'timeline-render.js'), type: 'text/javascript; charset=utf-8' },
  '/shared/site-registry.js': { file: path.join(SHARED_DIR, 'site-registry.js'), type: 'text/javascript; charset=utf-8' },
  '/shared/site-tabs.js': { file: path.join(SHARED_DIR, 'site-tabs.js'), type: 'text/javascript; charset=utf-8' },
  // 弹窗与共享页共用的卡片/标签条样式（share.html 须在 share.css 之前引入）
  '/shared/timeline-cards.css': { file: path.join(SHARED_DIR, 'timeline-cards.css'), type: 'text/css; charset=utf-8' },
  // timeline-render 的标题文案单一真源（v1.6.2）；漏了这条共享页直接白屏
  '/shared/translate-config.js': { file: path.join(SHARED_DIR, 'translate-config.js'), type: 'text/javascript; charset=utf-8' }
};

const ICON_TYPES = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveFile(res, filePath, contentType, cacheSeconds) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      return sendJson(res, 404, { ok: false, error: 'Not Found' });
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheSeconds > 0 ? `max-age=${cacheSeconds}` : 'no-cache'
    });
    res.end(content);
  });
}

function sendJson(res, statusCode, body) {
  // 不设置 CORS 头：合法消费方要么同源（局域网共享页），要么是带 host_permissions
  // 的扩展页面（不受 CORS 限制）；任意网页试图跨源读取时间线数据会被浏览器拦截。
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(body));
}

// —— GET /api/timeline：响应体按 (version, contentHash) 缓存（v1.6.21） ——
// 整表 3.7MB 起步、按月增长，共享页每次打开 / 回到前台 / 收到 SSE 都来拉：旧写法每个请求整表
// JSON.stringify 一次、明文发出。现在同一版本只拼一次明文、压一次 gzip（异步，不堵事件循环；
// 同一版本的并发请求共用同一个压缩 Promise），并带 ETag 让回到前台的条件请求直接 304。
// 只留最新一份：旧版本的条目在飞的请求用完即被回收
const gzipAsync = promisify(zlib.gzip);
// 实测 3.7MB 的表：level 1 约 34ms / 1616KB，level 6 约 86ms / 1479KB；4 取两者之间，一个版本只压一次
const TIMELINE_GZIP_LEVEL = 4;
let timelineCache = null;

function timelineCacheEntry() {
  const key = `${dataVersion}:${contentHash}`;
  if (!timelineCache || timelineCache.key !== key) {
    // 与旧写法 JSON.stringify({ ok: true, version, updatedAt, dramas: latestDramas }) 逐字节相同：
    // 键序照旧，version / updatedAt（字符串或 null）仍经 JSON.stringify 产出，dramas 直接复用
    // 与 latestDramas 同步维护的 latestSerialized（见 commitSnapshotContent），省掉每请求一次整表序列化。
    // updatedAt 只随版本前进（json 自愈补写不改它），所以键里不必带它
    const body = `{"ok":true,"version":${JSON.stringify(dataVersion)},"updatedAt":${JSON.stringify(updatedAt)},"dramas":${latestSerialized}}`;
    timelineCache = {
      key,
      // 弱校验器：同一份内容换了压缩方式（明文 / gzip）字节不同但语义相同，按 RFC 9110 只能用 W/
      etag: `W/"${contentHash.slice(0, 16)}-${dataVersion}"`,
      plain: Buffer.from(body, 'utf8'),
      gzip: null
    };
  }
  return timelineCache;
}

function timelineGzip(entry) {
  if (!entry.gzip) {
    entry.gzip = gzipAsync(entry.plain, { level: TIMELINE_GZIP_LEVEL });
    // 失败不缓存：这一批请求退回明文，下一个请求重新压缩
    entry.gzip.catch(() => { entry.gzip = null; });
  }
  return entry.gzip;
}

// Accept-Encoding：显式列出 gzip 的按它自己的 q 值，没列出才看 *；解析不了一律回明文——明文永远正确
function acceptsGzip(header) {
  const qualities = new Map();
  for (const part of String(header || '').toLowerCase().split(',')) {
    const [coding, ...params] = part.split(';').map(item => item.trim());
    if (!coding) continue;
    const q = params.find(item => item.startsWith('q='));
    qualities.set(coding, q ? Number(q.slice(2)) : 1);
  }
  const q = qualities.has('gzip') ? qualities.get('gzip') : qualities.get('*');
  return q > 0;
}

// If-None-Match 用弱比较（RFC 9110 §13.1.2）：去掉 W/ 前缀后相等即命中；* 匹配任何现存表示
function etagMatches(header, etag) {
  if (!header) return false;
  const opaque = tag => tag.trim().replace(/^W\//, '');
  const target = opaque(etag);
  return header.split(',').some(tag => tag.trim() === '*' || opaque(tag) === target);
}

async function sendTimeline(req, res) {
  const entry = timelineCacheEntry();
  // no-cache＝可以缓存但每次都要回源校验：浏览器带 If-None-Match 来问，内容没变只回 304 头
  const headers = { 'Cache-Control': 'no-cache', 'ETag': entry.etag, 'Vary': 'Accept-Encoding' };
  if (etagMatches(req.headers['if-none-match'], entry.etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  let body = entry.plain;
  if (acceptsGzip(req.headers['accept-encoding'])) {
    try {
      body = await timelineGzip(entry);
      headers['Content-Encoding'] = 'gzip';
    } catch (error) {
      console.warn('[ShortScraping Sync] 时间线压缩失败，本次回明文:', error.message);
    }
  }
  // 不设置 CORS 头，理由同 sendJson
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, ...headers });
  res.end(body);
}

// 写接口请求体上限。/sync 每次推送订阅内的整表，体积随数据只增不减（2026-09 时 db/timeline.json
// 约 3.7MB、按月增长），旧的 20MB 约一年触顶；64MB 留出数年余量。只拦异常体积，不是配额
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

// 带 statusCode 的请求错误由路由 catch 经 sendRouteError 原样回给调用方，其余错误按 500
function bodyTooLargeError(maxBytes) {
  const error = new Error(`请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限，本次未写入任何文件`);
  error.statusCode = 413;
  error.apiCode = 'BODY_TOO_LARGE';
  return error;
}

// 分块先攒 Buffer、收齐再整体解码：逐块 `data += chunk` 会把跨块的多字节汉字
// 拆成两半各自解码成 `\uFFFD`（2026-09-25 实测每次整表推送都随机写坏几个字）
// 超限回 413 而不是 req.destroy()：销毁 socket 后路由再写的错误响应发不出去，扩展只拿到
// 「fetch failed」、提示成「请确认同步服务已启动」，而 /health 一切正常，无从定位。现在超限后
// 只丢弃余下分块（不再累积），响应结束后 Node 会自行排空请求体，客户端能读到 413 JSON
function readBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    // 声明的 Content-Length 已超限（扩展 fetch 字符串 body 必带）：不必先收几十 MB 再拒
    if (Number(req.headers['content-length']) > maxBytes) {
      reject(bodyTooLargeError(maxBytes));
      return;
    }
    let chunks = [];
    let size = 0;
    let over = false;
    req.on('data', chunk => {
      if (over) return;
      size += chunk.length;
      if (size > maxBytes) {
        over = true;
        chunks = [];
        reject(bodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

/* —— 已知片单（v1.7.0）：扩展 storage.knownItems 的备份 ——
 * 扩展把「只记 ID、不入库」的条目（IMDb 切换基线等）存在自己的 storage 里，重装扩展就没了；库能从
 * db/timeline.json 导入恢复，片单没有别处可取，所以每次追加后整份推到这里，扩展唤醒发现本地从没有过片单时
 * 取回。POST 是整份替换（扩展推的是按 id 去重后的全集），GET 只给本机。
 */
const KNOWN_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_KNOWN_ITEMS = 100000;

function normalizeKnownItems(raw) {
  const reject = message => Object.assign(new Error(message), { statusCode: 400 });
  if (!Array.isArray(raw)) throw reject('已知片单必须是数组，未写入');
  if (raw.length > MAX_KNOWN_ITEMS) throw reject(`已知片单超过 ${MAX_KNOWN_ITEMS} 条上限，未写入`);
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const seen = new Set();
  const items = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !KNOWN_ITEM_ID.test(entry.id)) {
      throw reject('已知片单包含无效条目（每条须有合法的 id），未写入');
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    items.push({ id: entry.id, site: text(entry.site, 32), at: text(entry.at, 40), reason: text(entry.reason, 200) });
  }
  return items;
}

function readKnownItems() {
  try {
    const raw = parseJsonText(fs.readFileSync(KNOWN_ITEMS_PATH, 'utf8'));
    return Array.isArray(raw?.items) ? raw.items : [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[ShortScraping Sync] 读取 db/known-items.json 失败，按空片单返回:', error.message);
    return [];
  }
}

/**
 * 读完请求体并解析成 JSON（五个写接口共用，v1.7.0 收拢）：坏 JSON 回 400（带 statusCode，经 sendRouteError），
 * 以前各路由直接 JSON.parse(body || '{}')，SyntaxError 一路冒成 500 并打整段堆栈，像是服务自己出了错。
 * 超限照旧是 readBody 的 413。
 */
async function readJsonBody(req) {
  const body = await readBody(req);
  try {
    return JSON.parse(body || '{}');
  } catch (error) {
    const bad = new Error(`请求体不是合法 JSON，未写入任何文件：${error.message}`);
    bad.statusCode = 400;
    throw bad;
  }
}

// 写接口 catch 的统一出口：带 statusCode 的请求错误只记一行原因，其余照旧打印完整错误并回 500
function sendRouteError(res, label, error) {
  if (error.statusCode) console.warn(`[ShortScraping Sync] ${label}: ${error.message}`);
  else console.error(`[ShortScraping Sync] ${label}:`, error);
  const body = { ok: false, error: error.message };
  if (error.apiCode) body.code = error.apiCode;
  return sendJson(res, error.statusCode || 500, body);
}

async function handleRequest(req, res) {
  let pathname;
  try {
    if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new Error('invalid target');
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (_) {
    return sendJson(res, 400, { ok: false, error: '无效请求路径' });
  }

  if (!isAllowedHost(req.headers.host)) {
    return sendJson(res, 403, { ok: false, error: '不允许的主机名' });
  }

  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  // 写入接口仅限本机：局域网设备只读
  if (req.method === 'POST' && !isLocalRequest(req)) {
    return sendJson(res, 403, { ok: false, error: '写入接口仅限本机调用' });
  }

  if (req.method === 'POST') {
    const originVerdict = writeOriginVerdict(req);
    if (originVerdict === 'deny') {
      return sendJson(res, 403, originDeniedBody(req));
    }
    // 所有写接口都要求 application/json：非简单请求必须先过预检，
    // 无主机权限的扩展连「发出去就生效」的副作用请求都构造不出来。
    if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      return sendJson(res, 415, { ok: false, error: '请使用 application/json' });
    }
    if (!WRITE_ROUTES.has(pathname)) {
      return sendJson(res, 404, { ok: false, error: '没有这个写接口' });
    }
    // 过完全部闸门才固定；判定到固定之间没有 await，两个并发的首次写入不会各自固定一次
    if (originVerdict === 'pin') pinWriteOrigin(req.headers.origin);
  }

  if (req.method === 'GET' && pathname === '/health') {
    const body = {
      ok: true,
      localOnly: LOCAL_ONLY,
      lanUrls: LOCAL_ONLY ? [] : getLanUrls(),
      version: dataVersion
    };
    // 本机磁盘路径只发给本机调用方（弹窗 📁 与设置页展示依赖），
    // 不向局域网设备/任意网页暴露本机目录布局
    if (isLocalRequest(req)) {
      body.csvPath = CSV_PATH;
      body.serverDir = __dirname;
      body.pid = process.pid; // 重启后据此确认已换成新进程
      // 扩展冷启动指纹比对用（v1.6.21 起提供）：内容指纹 + CSV 是否已知与快照一致，两者都对得上才可能跳过推送
      body.contentHash = contentHash;
      body.csvInSync = csvInSync();
      // 订阅配置文件缺失（v1.7.0）：推送会被 409 TAG_CONFIG_MISSING 拒绝，弹窗据此提示去设置页保存一次订阅
      body.tagConfigMissing = !fs.existsSync(TAG_CONFIG_PATH);
    }
    return sendJson(res, 200, body);
  }

  // 停止服务：仅本机可调用（已受上方 POST 回环护栏保护），供 stop.js / 停止脚本 / 弹窗 ⏹ 优雅关停
  if (req.method === 'POST' && pathname === '/shutdown') {
    sendJson(res, 200, { ok: true, message: 'shutting down' });
    console.log('[ShortScraping Sync] 收到停止请求，正在关闭服务...');
    shutdownServer(0);
    return;
  }

  // 重启服务（弹窗 🔄）：macOS 开机自启下以非零码退出、由 launchd 按 KeepAlive 立即拉起，
  // 进程仍归 launchd 管；其余场景（前台 / Windows）先派生脱离的新实例再退出，新实例等端口空出后接管。
  // 派生的新实例转入后台、输出写进 LOG_PATH，原前台窗口随旧进程结束，之后用 ⏹ / stop 脚本停止
  if (req.method === 'POST' && pathname === '/restart') {
    if (LAUNCHD_MANAGED) {
      sendJson(res, 200, { ok: true, message: 'restarting', mode: 'launchd', logPath: LOG_PATH });
      console.log('[ShortScraping Sync] 收到重启请求，正在重启服务（交由 launchd 拉起）...');
      shutdownServer(RESTART_EXIT_CODE);
      return;
    }
    let child;
    try {
      child = spawnReplacement();
    } catch (error) {
      console.error('[ShortScraping Sync] 派生新实例失败，服务保持运行:', error.message);
      return sendJson(res, 500, { ok: false, error: `派生新实例失败：${error.message}`, logPath: LOG_PATH });
    }
    // 等子进程真正起来再答复并退出：spawn 失败（EAGAIN 等）走 'error'，此时旧实例必须留着，
    // 否则端口上一个服务都没有，而弹窗已收到「重启中」
    child.on('error', (error) => {
      if (res.headersSent) return;
      console.error('[ShortScraping Sync] 派生新实例失败，服务保持运行:', error.message);
      sendJson(res, 500, { ok: false, error: `派生新实例失败：${error.message}`, logPath: LOG_PATH });
    });
    child.once('spawn', () => {
      child.unref();
      sendJson(res, 200, { ok: true, message: 'restarting', mode: 'respawn', logPath: LOG_PATH });
      console.log(`[ShortScraping Sync] 收到重启请求，已派生新实例（pid ${child.pid}），当前进程即将退出；`
        + `服务转入后台继续运行，日志：${LOG_PATH}；停止请用弹窗 ⏹ 或 stop-sync 脚本 / npm run stop`);
      shutdownServer(0);
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/known-items') {
    // 片单只给本机扩展：局域网共享页用不到它
    if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: '已知片单只对本机开放' });
    return sendJson(res, 200, { ok: true, items: readKnownItems() });
  }

  if (req.method === 'POST' && pathname === '/known-items') {
    try {
      const payload = await readJsonBody(req);
      const items = normalizeKnownItems(payload?.items);
      writeJsonAtomic(KNOWN_ITEMS_PATH, { updatedAt: new Date().toISOString(), items });
      return sendJson(res, 200, { ok: true, count: items.length });
    } catch (error) {
      return sendRouteError(res, '写入已知片单失败', error);
    }
  }

  if (req.method === 'GET' && pathname === '/api/timeline') {
    return sendTimeline(req, res);
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('retry: 3000\n\n');
    res.write(`event: update\ndata: ${JSON.stringify({ version: dataVersion })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'GET' && STATIC_ROUTES[pathname]) {
    const route = STATIC_ROUTES[pathname];
    return serveFile(res, route.file, route.type, 0);
  }

  if (req.method === 'GET' && pathname.startsWith('/assets/icons/')) {
    const name = pathname.slice('/assets/icons/'.length);
    const ext = path.extname(name).toLowerCase();
    if (!/^[\w.-]+$/.test(name) || !ICON_TYPES[ext]) {
      return sendJson(res, 404, { ok: false, error: 'Not Found' });
    }
    return serveFile(res, path.join(ICONS_DIR, name), ICON_TYPES[ext], 3600);
  }

  if (req.method === 'POST' && pathname === '/sync') {
    try {
      const payload = await readJsonBody(req);
      if (!payload || !Array.isArray(payload.dramas) || payload.dramas.some(d => !d || typeof d !== 'object' || Array.isArray(d))) {
        return sendJson(res, 400, { ok: false, error: '缺少有效的 dramas 数组' });
      }
      const dramas = payload.dramas;
      // 空库护栏：新 profile / 重装扩展后 storage 为空，SW 启动的预热推送会带着 []
      // 把 db/timeline.* 与共享页一起清空。「原始就是空数组」只在扩展声明 allowEmpty:true
      // （用户在扩展页确认过的清空/退订）时才接受；共享快照本就为空时无可覆盖，照常放行。
      // 只看原始数组：非空推送被 tag.json 过滤成空（订阅已取消）仍走下方的告警 + drop 档留痕；
      // tag.json 整个不见了（快照又非空）则在下面过滤时 409 拒绝（TAG_CONFIG_MISSING，v1.7.0）。
      // 409 拒绝不写任何文件（连备份都不留），扩展端据此不重试这份内容
      if (dramas.length === 0 && payload.allowEmpty !== true && latestDramas.length > 0) {
        const error = `拒绝用空时间线覆盖现有 ${latestDramas.length} 条（未带 allowEmpty）`;
        console.warn(`[ShortScraping Sync] ${error}——如确需清空，请在扩展设置页操作`);
        return sendJson(res, 409, { ok: false, code: 'EMPTY_REJECTED', error });
      }
      const configured = filterDramasByTagConfig(dramas);
      // 同内容跳过 CSV 重写：扩展唤醒、打开弹窗时的补推（旧版扩展每次唤醒都推）绝大多数与上次内容一致，
      // 无谓的磁盘重写全部拦在这里；existsSync 守卫保住「服务运行期间 CSV 被手删后下次推送自愈」的行为
      //（停机期间被删的见 loadSnapshot）
      const serialized = JSON.stringify(configured);
      const snapshotChanged = serialized !== latestSerialized;
      const csvStale = serialized !== csvSerialized || !fs.existsSync(CSV_PATH);
      // 服务运行期间 timeline.json 被手删（与 CSV 的 existsSync 守卫对称）：内容没变也按当前版本补写，
      // 不 bump 版本、不广播——共享页看到的内容没变。内存里没有可恢复的快照（首启、从未推送过）时不凭空建文件
      const jsonMissing = !snapshotChanged && (dataVersion > 0 || latestDramas.length > 0)
        && !fs.existsSync(TIMELINE_JSON_PATH);
      let dropBackups = [];
      let siteDrops = [];
      if (snapshotChanged || csvStale) {
        // 覆盖前留痕；备份只在真会重写时发生，同内容的预热推送不触发
        siteDrops = findSiteDrops(configured, latestDramas);
        dropBackups = backupBeforeOverwrite(configured.length, latestDramas.length, latestSerialized, siteDrops);
      }

      // 带 allowEmpty 的空推送或订阅已取消导致清空时留痕；配置读取失败已在过滤阶段拒绝。
      if (configured.length === 0 && latestDramas.length > 0) {
        console.warn(
          `[ShortScraping Sync] 警告：收到空时间线推送（原始 ${dramas.length} 条 / 过滤后 0 条），` +
          `现有快照 ${latestDramas.length} 条即将被清空——` +
          (dramas.length === 0 ? '扩展声明为用户主动清空（allowEmpty）' : '若非主动清空订阅，请检查扩展数据与 config/tag.json') +
          (dropBackups.length > 0 ? `；覆盖前的快照已备份到 ${dropBackups.join('、')}` : '')
        );
      } else if (siteDrops.length > 0) {
        // 整表还在、只是个别站点骤降（清空一个站、退订其中一个列表页）：点名站点，整表口径看不出是哪个
        const detail = siteDrops.map(({ site, prev, next }) => `${site} ${prev}→${next} 条`).join('、');
        console.warn(
          `[ShortScraping Sync] 警告：站点条数骤降（${detail}；整表 ${latestDramas.length}→${configured.length} 条）——` +
          '若非主动清空或退订，请检查扩展数据与 config/tag.json' +
          (dropBackups.length > 0 ? `；覆盖前的快照已备份到 ${dropBackups.join('、')}` : '')
        );
      }

      // 先落 json 快照再写 CSV：共享页只依赖快照，CSV 被 Excel 锁住时共享页照常更新。
      // 两份都是「落盘成功才提交内存签名」——先改签名的话，落盘失败后扩展重推同一内容会被当成
      // 未变化直接跳过，磁盘就一直停在旧版本。内容未变化时不 bump 版本、不广播：
      // 扩展唤醒 / 弹窗补推多为同内容（旧版扩展每次唤醒都推），避免共享页无谓重渲染
      if (snapshotChanged) {
        const snapshot = { version: dataVersion + 1, updatedAt: new Date().toISOString(), dramas: configured };
        saveSnapshot(snapshot);
        commitSnapshotContent(configured, serialized);
        dataVersion = snapshot.version;
        updatedAt = snapshot.updatedAt;
        broadcastUpdate();
      } else if (jsonMissing) {
        saveSnapshot({ version: dataVersion, updatedAt, dramas: latestDramas });
        console.log(`[ShortScraping Sync] timeline.json 不在磁盘上，已按当前快照补写（version ${dataVersion}，不变）`);
      }

      // 不重写时 CSV 就是这份内容写出的，条数照 buildTimelineCsv 同一去重口径现算
      // （TimelineCsv.countTimelineRows），与写入那次回报的条数一致
      let count;
      if (csvStale) {
        count = writeTimelineCsv(configured);
        csvSerialized = serialized;
      } else {
        count = TimelineCsv.countTimelineRows(configured);
      }

      return sendJson(res, 200, { ok: true, count, csvPath: CSV_PATH, contentHash });
    } catch (error) {
      return sendRouteError(res, '同步失败', error);
    }
  }

  if (req.method === 'POST' && pathname === '/config/tag') {
    try {
      const payload = await readJsonBody(req);
      const rawTags = payload?.urlTags;
      const existed = fs.existsSync(TAG_CONFIG_PATH);
      const count = writeTagConfig(rawTags);
      if (!existed && latestDramas.length > 0) {
        console.log(`[ShortScraping Sync] 已重新生成 ${TAG_CONFIG_PATH}：此前被拒的推送在扩展下次推送（或打开弹窗）时补上`);
      }
      return sendJson(res, 200, { ok: true, count, configPath: TAG_CONFIG_PATH });
    } catch (error) {
      return sendRouteError(res, '写入网页订阅配置失败', error);
    }
  }

  if (req.method === 'POST' && pathname === '/config/trans') {
    try {
      const payload = await readJsonBody(req);
      const rawConfig = pickConfigObject(payload, 'translateConfig');
      if (!rawConfig) return sendJson(res, 400, { ok: false, error: '缺少有效的 translateConfig 对象，未写入' });
      const config = writeTransConfig(rawConfig);
      return sendJson(res, 200, { ok: true, config, configPath: TRANS_CONFIG_PATH });
    } catch (error) {
      return sendRouteError(res, '写入翻译接口配置失败', error);
    }
  }

  if (req.method === 'POST' && pathname === '/config/lark') {
    try {
      const payload = await readJsonBody(req);
      const rawConfig = pickConfigObject(payload, 'larkConfig');
      if (!rawConfig) return sendJson(res, 400, { ok: false, error: '缺少有效的 larkConfig 对象，未写入' });
      const config = writeLarkConfig(rawConfig);
      return sendJson(res, 200, { ok: true, config, configPath: LARK_CONFIG_PATH });
    } catch (error) {
      return sendRouteError(res, '写入 Lark 推送配置失败', error);
    }
  }

  if (req.method === 'POST' && pathname === '/config/cron') {
    try {
      const payload = await readJsonBody(req);
      const rawConfig = pickConfigObject(payload, 'scheduleConfig');
      if (!rawConfig) return sendJson(res, 400, { ok: false, error: '缺少有效的 scheduleConfig 对象，未写入' });
      const config = writeCronConfig(rawConfig);
      return sendJson(res, 200, { ok: true, config, configPath: CRON_CONFIG_PATH });
    } catch (error) {
      return sendRouteError(res, '写入定时任务配置失败', error);
    }
  }

  sendJson(res, 404, { ok: false, error: 'Not Found' });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error('[ShortScraping Sync] 请求处理失败:', error.message);
    if (!res.headersSent && !res.destroyed) sendJson(res, 500, { ok: false, error: '请求处理失败' });
    else res.destroy();
  });
});

/**
 * 已设 macOS 开机自启（LaunchAgent 已加载）时不再另起前台实例（npm run sync / npm start / 直接 node）：
 * 后台服务在跑时只会撞端口；后台服务停着时则占住端口，服务从此脱离 launchd 托管、随终端存亡。
 * 判定与 stop.js launchdTarget 同一口径（plist 不带 SHORTSCRAPING_PORT，只有默认端口会相撞）；🔄 派生的接替实例
 * 由旧实例决定过去向，放行；SHORTSCRAPING_NO_LAUNCHD=1 留给前台调试（测试也靠它与随机端口避开本机自启）
 */
function exitIfLaunchdAgentLoaded() {
  if (process.platform !== 'darwin' || LAUNCHD_MANAGED || process.env[WAIT_PORT_ENV]
    || PORT !== DEFAULT_PORT || process.env.SHORTSCRAPING_NO_LAUNCHD === '1') return;
  const target = `gui/${process.getuid()}/${LAUNCHD_LABEL}`;
  if (spawnSync('launchctl', ['print', target], { stdio: 'ignore' }).status !== 0) return;
  console.error('[ShortScraping Sync] 已设置 macOS 开机自启，服务由 launchd 在后台托管，不再另起前台实例。');
  console.error(`[ShortScraping Sync] 启动或重启后台服务：npm run restart（或双击 server/start-sync.command，即 launchctl kickstart ${target}）；日志：${LOG_PATH}`);
  console.error('[ShortScraping Sync] 确需前台调试：先 npm run stop，再以 SHORTSCRAPING_NO_LAUNCHD=1 npm run sync 启动；不再需要自启可运行 server/tools/remove-autostart.command。');
  process.exit(1);
}

exitIfLaunchdAgentLoaded();
ensureDb();
loadSnapshot();
healCsvFromSnapshot();
loadPinnedWriteOrigin();

// SSE 心跳：防止空闲长连接被中间设备掐断
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(': ping\n\n');
    } catch (error) {
      sseClients.delete(client);
    }
  }
}, 30000);

/** 优雅关停：主动断开 SSE 长连接（否则 server.close 会一直等它们结束），兜底 500ms 强退。 */
function shutdownServer(exitCode) {
  for (const client of sseClients) {
    try { client.end(); } catch (error) { /* 忽略断开异常 */ }
  }
  sseClients.clear();
  server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode), 500).unref();
}

/**
 * 🔄 的接替实例：脱离当前终端，stdout/stderr 追加进 LOG_PATH（stdio:'ignore' 会让启动报错与
 * 运行告警全部丢失）。先写一行交接记录，日志里看得出哪次启动来自 🔄；fd 在 spawn 返回时
 * 已被子进程继承，本进程随即关掉自己那份。带上 execArgv，node 启动参数不因重启丢失。
 */
function spawnReplacement() {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const fd = fs.openSync(LOG_PATH, 'a');
  try {
    fs.writeSync(fd, `\n[ShortScraping Sync] ${new Date().toISOString()} 由 🔄 重启派生新实例（接替 pid ${process.pid}）\n`);
    return spawn(process.execPath, [...process.execArgv, __filename, ...process.argv.slice(2)], {
      cwd: process.cwd(), env: { ...process.env, [WAIT_PORT_ENV]: '1' },
      detached: true, stdio: ['ignore', fd, fd], windowsHide: true
    });
  } finally {
    fs.closeSync(fd);
  }
}

const waitPortDeadline = process.env[WAIT_PORT_ENV] ? Date.now() + WAIT_PORT_TIMEOUT_MS : 0;
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && Date.now() < waitPortDeadline) {
    setTimeout(listen, 200);
    return;
  }
  if (error.code === 'EADDRINUSE') {
    console.error(`[ShortScraping Sync] 端口 ${PORT} 已被占用（可能同步服务已在运行）。`);
    console.error('[ShortScraping Sync] 如需停止，请运行 npm run stop（macOS 可双击 stop-sync.command）。');
    // launchd 拉起时端口却被另一个实例（多为脱离托管的前台实例）占着：以 1 退出会被
    // KeepAlive(SuccessfulExit=false) 每 10 秒重拉一次，sync.log 无限增长。以 0 退出让 launchd
    // 就此罢手；之后想交回 launchd 托管，npm run restart 会先停掉端口上的实例再 kickstart
    if (LAUNCHD_MANAGED) {
      console.error(`[ShortScraping Sync] 当前由 launchd（${LAUNCHD_LABEL}）拉起，端口已被另一个实例占用：本实例正常退出，launchd 不再反复重试；交回后台托管请运行 npm run restart。`);
      process.exit(0);
    }
    process.exit(1);
  }
  console.error('[ShortScraping Sync] 服务发生错误：', error);
  process.exit(1);
});

function listen() {
  server.listen(PORT, LOCAL_ONLY ? '127.0.0.1' : '0.0.0.0');
}
server.once('listening', onListening); // 等端口重试时 listen() 会调多次，回调只挂一次
listen();

function onListening() {
  console.log(`[ShortScraping Sync] 服务已启动：http://127.0.0.1:${PORT}${LOCAL_ONLY ? '（仅本机模式）' : ''}`);
  console.log(`[ShortScraping Sync] CSV 输出：${CSV_PATH}`);
  // 扩展（后台 / 弹窗 / 设置页）写死连 31919：非默认端口上的实例收不到任何推送，弹窗照样显示「已关闭」
  if (PORT !== DEFAULT_PORT) {
    console.warn(`[ShortScraping Sync] 注意：当前监听非默认端口 ${PORT}（来自环境变量 SHORTSCRAPING_PORT），`
      + `扩展只连 ${DEFAULT_PORT}，此实例仅供测试 / 调试；日常使用请取消该变量后重启`);
  }
  if (!LOCAL_ONLY) {
    const lanUrls = getLanUrls();
    if (lanUrls.length > 0) {
      console.log(`[ShortScraping Sync] 局域网共享页：${lanUrls.join('  ')}`);
      console.log('[ShortScraping Sync] 首次启动如系统弹出防火墙授权提示，请允许 Node 访问局域网（专用网络）。');
    }
  }
}
