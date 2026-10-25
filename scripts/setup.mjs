#!/usr/bin/env node
/**
 * QQ Agent · 洄 一键 setup：安装 SnowLuma 协议端，并检查便携 QQ 是否就绪。
 *
 *   npm run setup              # 首次安装（已就绪则跳过）
 *   node scripts/setup.mjs --force     # 强制重新下载 SnowLuma
 *   node scripts/setup.mjs --check     # 只检查是否就绪
 *   node scripts/setup.mjs --skip-qq   # 完全不看便携 QQ
 *
 * **本分支不下载、不安装 QQ**：便携 QQ 请使用上游项目作者的分发服务
 * （https://kondius.cn/qq-agent），取到后放到 runtime/qq-portable/。
 * 也可以不装便携 QQ，直接连接你自己的 OneBot 实现。
 *
 * 不入库任何腾讯二进制。SnowLuma 为独立第三方项目，按其许可分发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
// 共用下载器（流式 + 进度条 + 增量哈希 + 原子改名），setup-napcat 用的是同一份
import { download as downloadFile, fileSha256 } from './lib/download.mjs';
import {
  detectInstallerTypeFromFile, commonQqDirs, parseVersionDir,
  findQqInstallDir, readQqVersionFromDir, SKIP_ON_COPY, countQqProcesses,
  collectQqInstallCandidates, chooseQqInstall
} from './lib/qq-installer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── 目录约定 ──
const SNOWLUMA_DIR = path.join(ROOT, 'snowluma');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const QQ_PORTABLE_DIR = path.join(RUNTIME_DIR, 'qq-portable');
const QQ_PORTABLE_DATA_DIR = path.join(RUNTIME_DIR, 'qq-portable-data');
const QQ_CACHE_DIR = path.join(RUNTIME_DIR, '.cache');

// ── SnowLuma 下载源 ──
// 官方 GitHub Release（固定版本保证可复现）。
// 2026-09-26 更新：仓库已从 SnowLumaDevs/SnowLuma 迁移到 SnowLuma/SnowLuma；
// Windows 产物命名也从 snowluma-win32-x64.zip 改为 SnowLuma-<版本>-win-x64.zip
// （完整版、内置 Node.js —— lite 版没有 node.exe，isSnowlumaReady 校验不过）。
const SNOWLUMA_DEFAULT_VERSION = 'v1.14.19';
const SNOWLUMA_REPO = process.env.SNOWLUMA_REPO || 'SnowLuma/SnowLuma';
const SNOWLUMA_VERSION = process.env.SNOWLUMA_VERSION || SNOWLUMA_DEFAULT_VERSION;
const SNOWLUMA_ASSET = `SnowLuma-${SNOWLUMA_VERSION}-win-x64.zip`;
// 供应链防线：官方 zip 的 SHA256 固定如下（GitHub Release 资产摘要，
// v1.14.19 win-x64 完整版，2026-09-26 核对）。换版本 / 换源时必须用
// SNOWLUMA_SHA256 环境变量显式给出新包的哈希，否则拒绝下载。
const SNOWLUMA_PINNED_SHA256 = '2c77f0bcbe1f828e2d5109d193e71d8dac995e715dd144222a0a2c60a783c5a5';
const SNOWLUMA_REPO_OVERRIDDEN = !!process.env.SNOWLUMA_REPO && process.env.SNOWLUMA_REPO !== 'SnowLuma/SnowLuma';
const SNOWLUMA_VERSION_OVERRIDDEN = !!process.env.SNOWLUMA_VERSION && process.env.SNOWLUMA_VERSION !== SNOWLUMA_DEFAULT_VERSION;
const SNOWLUMA_SHA256 = (process.env.SNOWLUMA_SHA256 || '').trim()
  || ((SNOWLUMA_REPO_OVERRIDDEN || SNOWLUMA_VERSION_OVERRIDDEN) ? '' : SNOWLUMA_PINNED_SHA256);

// ── QQ 下载源 ──
// 从自己的分发站下载（不依赖腾讯 CDN 的文件名规则，也不会因 CDN 清档而 404）。
// ── 目标版本 ──────────────────────────────────────────────────────────
// 我们希望协议栈打交道的客户端版本。免安装包里装的就是这一版。
// EXPECTED_CLIENT_BUILD 由它推导，用来和 SnowLuma 声明的版本比对。
const QQ_VERSION = process.env.QQ_PORTABLE_VERSION || '9.9.33.51802';
const QQ_VERSION_SHORT = QQ_VERSION.split('.').slice(0, 3).join('.');
const QQ_BUILD = QQ_VERSION.split('.').pop();

// ── 便携 QQ：本分支不下载、不安装 ─────────────────────────────────────
// 这里刻意不再保留任何"下载 QQ 安装包/免安装包"的常量与逻辑：
// 依赖上游分发地址会把分支的发版绑在别人的服务上，而退回装官方包又有
// 版本与协议栈不适配的风险。需要便携 QQ 时，由使用者从上游项目作者那里
// 取用，放到 runtime/qq-portable/（见 installQqPortable 里的提示）。

// ⚠️ 版本匹配检查用：SnowLuma 的协议栈会声明一个 CLIENT_BUILD（形如 "9.9.26-44343"），
// 它决定了握手时自称的客户端版本。QQ 版本与它差太远时，登录可能被拒或行为异常。
// 安装完成后会读出来和 QQ_VERSION 比对并给出醒目提示（见 checkClientBuildMatch）。
const EXPECTED_CLIENT_BUILD = process.env.EXPECTED_CLIENT_BUILD || `${QQ_VERSION_SHORT}-${QQ_BUILD}`;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const CHECK_ONLY = args.includes('--check');
const SKIP_QQ = args.includes('--skip-qq');
// 已移除的参数（以前用于"帮用户装 QQ"）：--from / --run-installer / --no-portable。
// 仍然接受但不做任何事，只是为了老脚本不会因为未知参数报错。
const LEGACY_FLAGS = ['--from', '--run-installer', '--no-portable'];

const log = (...a) => console.log('[setup]', ...a);
const warn = (...a) => console.warn('[setup] ⚠', ...a);
{
  const legacyUsed = LEGACY_FLAGS.filter((f) => args.includes(f));
  if (legacyUsed.length) {
    warn(`参数 ${legacyUsed.join(' / ')} 已停用（本分支不再安装 QQ），本次忽略。`);
  }
}
const die = (msg) => { console.error('[setup] ❌', msg); process.exit(1); };

// ── 工具函数 ──

/**
 * 包一层，把日志接到共用下载器上。
 *
 * 下载实现放在 scripts/lib/download.mjs（与 setup-napcat 共用）：
 * 流式写盘 + 进度条 + 增量哈希 + .part 原子改名。
 * 原来这里是一次 arrayBuffer() 全读进内存 —— 几百 MB 的安装包
 * 既看不到进度也占内存，中断还得从头再来。
 */
async function download(url, dest, { expectedSha256 = null, label = '' } = {}) {
  log('下载', url);
  try {
    const r = await downloadFile(url, dest, {
      expectedSha256,
      label,
      // 各调用方的缓存目录不同，404 的提示由调用方给
      hint404: `可手动下载后放入 ${path.dirname(dest)}`
    });
    if (expectedSha256) log('SHA256 校验通过 ✓');
    log(`已保存 ${dest}（${(r.bytes / 1048576).toFixed(1)} MB）`);
    return r;
  } catch (error) {
    // 进度条刚画在 stderr 上，这里让出一条干净的行再打日志，避免两行糊在一起
    process.stderr.write('\n');
    throw error;
  }
}

/**
 * 解压归档。zip / tar.gz / tar.zst 都能吃 —— 交给 bsdtar 自己嗅探格式，
 * 我们不需要按扩展名分支（写成"看起来对但某个格式没覆盖"反而是隐患）。
 *
 * Windows 10+ 自带 bsdtar（就是 tar.exe），链接了 libzstd，能直接解 .tar.zst。
 * 所以选 zstd 不会给用户增加任何安装步骤。
 */
function unzip(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // 优先用 bsdtar：它同时支持 zip 与各种 tar 压缩，跨平台一致
  try {
    execFileSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'inherit', timeout: 900_000 });
    return;
  } catch (error) {
    // 退路：Linux 上有些环境没装 bsdtar 的 zstd 支持，试 unzip（只对 zip 有效）
    if (process.platform !== 'win32' && /\.zip$/i.test(archivePath)) {
      execFileSync('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'inherit', timeout: 900_000 });
      return;
    }
    throw error;
  }
}

// ── SnowLuma 安装/检查 ──

function isSnowlumaReady() {
  const indexMjs = path.join(SNOWLUMA_DIR, 'index.mjs');
  const nodeExe = path.join(SNOWLUMA_DIR, 'node.exe');
  return fs.existsSync(indexMjs) && fs.existsSync(nodeExe);
}

/**
 * 协议端：本分支不再代为下载 / 分发 / 安装。
 *
 * 上游在 0.4 版把口径改成了"协议端由使用者自行准备"，并移除了协议端安装脚本；
 * 我们跟随这个口径，同时也不去碰第三方程序的账号目录：
 *   · 只检测本机是否已有可用的协议端目录（供应用内"一键启动"使用）
 *   · 没有就打印指引，由使用者自行安装任意 OneBot v11 实现
 */
async function installSnowluma() {
  if (isSnowlumaReady()) {
    log('✅ 检测到本机协议端（', SNOWLUMA_DIR, '），跳过。');
    return;
  }
  warn('');
  warn('='.repeat(66));
  warn('本分支不代为下载、分发或安装 OneBot 协议端。');
  warn('');
  warn('请自行准备一个 OneBot v11 协议端（需要提供正向 WebSocket 事件接口 + HTTP API），');
  warn('按它自己的说明安装并登录，然后在「设置 → OneBot」里填写：');
  warn('  · WebSocket 地址（形如 ws://127.0.0.1:3001）');
  warn('  · HTTP 地址（形如 http://127.0.0.1:3000）');
  warn('  · 对应的访问令牌');
  warn('');
  warn('第三方程序与 QQ 客户端的版本要求、使用许可与风险，请以对应项目的说明为准。');
  warn('='.repeat(66));
  warn('');
}

/**
 * 把协议栈声明的客户端版本对齐到我们实际运行的 QQ 版本。
 *
 * ── 为什么做这件事 ────────────────────────────────────────────────────
 * SnowLuma 里写死了两处"我是谁"的声明：
 *   var CLIENT_BUILD = "9.9.26-44343";   → 自定义表情服务 inner.qqVersion
 *   var BUILD_VERSION_SHORT = "9.9.26";  → OrderCustomFace 的 env.buildVersion
 * 而我们实际跑的是 9.9.33-51802。**声明与实际不一致**本身就不对，
 * 而且会让 setup 一直报一条版本不匹配的警告 —— 那条警告是真话，
 * 但如果不去处理它，用户很快就会学会忽略它，这才是最危险的。
 *
 * ── 为什么相对安全 ────────────────────────────────────────────────────
 * 这两处都只是**握手时自报家门**，不参与任何协议分支选择
 * （全文只有这 2 处引用 CLIENT_BUILD，且都在自定义表情相关服务里，
 *   不在登录链路）。声明一个真实存在的版本号，比声明一个对不上的更合理。
 *
 * ── 为什么在 setup 里做，而不是手改文件 ──────────────────────────────
 * snowluma/ 是**下载来的**，重新 setup（或换 SnowLuma 版本）会把整个目录覆盖掉，
 * 手改的改动会静默丢失、警告又会冒出来。做成 setup 的一个步骤才是可重复的。
 *
 * 关掉：set QQ_ALIGN_CLIENT_BUILD=0
 * 还原：备份在 index.mjs.orig
 */
function alignClientBuild() {
  if (process.env.QQ_ALIGN_CLIENT_BUILD === '0') {
    log('QQ_ALIGN_CLIENT_BUILD=0：跳过协议栈版本对齐（那条版本不一致的警告会保留）');
    return;
  }
  const p = path.join(SNOWLUMA_DIR, 'index.mjs');
  if (!fs.existsSync(p)) { warn('找不到 snowluma/index.mjs，跳过版本对齐'); return; }

  const wantBuild = EXPECTED_CLIENT_BUILD;   // 形如 9.9.33-51802
  const wantShort = QQ_VERSION_SHORT;        // 形如 9.9.33
  let text;
  try { text = fs.readFileSync(p, 'utf8'); }
  catch (e) { warn(`读不了 snowluma/index.mjs：${e.message}`); return; }

  // v1.14.19 起 CLIENT_BUILD 改名为 LIST_QQ_VERSION（同语义：握手自报的客户端 build），
  // 两个名字都认；替换各走各的字面量，避免误伤同名的引用处。
  const curBuild = (text.match(/var (?:CLIENT_BUILD|LIST_QQ_VERSION) = "([^"]+)"/) || [])[1];
  const curShort = (text.match(/var BUILD_VERSION_SHORT = "([^"]+)"/) || [])[1];
  if (!curBuild && !curShort) {
    warn('协议栈里没找到 CLIENT_BUILD / LIST_QQ_VERSION / BUILD_VERSION_SHORT —— 版本可能改名了，跳过对齐');
    return;
  }
  if (curBuild === wantBuild && curShort === wantShort) {
    log(`协议栈声明的版本已是 ${wantBuild}，无需对齐`);
    return;
  }

  // 只在第一次改之前备份，避免反复 setup 把备份覆盖成"已改过的版本"
  const bak = `${p}.orig`;
  if (!fs.existsSync(bak)) {
    try { fs.copyFileSync(p, bak); } catch { /* 备份失败不致命 */ }
  }
  let next = text;
  if (curBuild) {
    next = next.replace(/var CLIENT_BUILD = "[^"]+"/, `var CLIENT_BUILD = "${wantBuild}"`);
    next = next.replace(/var LIST_QQ_VERSION = "[^"]+"/, `var LIST_QQ_VERSION = "${wantBuild}"`);
  }
  if (curShort) next = next.replace(/var BUILD_VERSION_SHORT = "[^"]+"/, `var BUILD_VERSION_SHORT = "${wantShort}"`);
  if (next === text) { warn('替换没有生效（可能与预期格式不符），跳过'); return; }
  try {
    fs.writeFileSync(p, next, 'utf8');
    log(`协议栈版本已对齐：${curBuild || '?'} → ${wantBuild}（原文件备份在 index.mjs.orig）`);
    log('  只是握手时"自报家门"的字段，不参与协议分支；如需还原：把 index.mjs.orig 盖回去');
  } catch (e) { warn(`写入失败：${e.message}`); }
}

/** QQ 的来路：'archive'=免安装包解压 | 'copied'=从已装的 QQ 复制 | ''=未知 */
let QQ_SOURCE = '';

// ── QQ 版本与 SnowLuma 协议栈的兼容性检查 ──────────────────────────────
//
// 背景：SnowLuma 的协议栈里写死了一个 CLIENT_BUILD（形如 "9.9.26-44343"），
// 握手时用它自称"我是 QQ 9.9.26 build 44343"。如果实际装的便携 QQ 是别的版本，
// 两者对不上 —— 轻则某些接口行为异常，重则**扫码后登录被拒**。
//
// 这类问题的表现很误导：setup 全绿、QQ 也能打开，只是扫码登不上，
// 用户会去怀疑网络/账号，而真正的原因是版本不匹配。
// 所以这里在装完后主动读出来比对，并在不一致时把话说清楚。

/** 从 snowluma/index.mjs 里读出协议栈自报的客户端 build
 *  （旧名 CLIENT_BUILD；v1.14.19 起改名 LIST_QQ_VERSION）。读不到返回 null。 */
function readClientBuild() {
  try {
    const p = path.join(SNOWLUMA_DIR, 'index.mjs');
    if (!fs.existsSync(p)) return null;
    // 文件很大（20 万行+），只扫前面若干 MB 就够 —— 常量都在前面
    const text = fs.readFileSync(p, 'utf8');
    const m = text.match(/var\s+(?:CLIENT_BUILD|LIST_QQ_VERSION)\s*=\s*["']([^"']+)["']/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * 比对 QQ 版本与协议栈声明的 CLIENT_BUILD。
 * 不一致**不中止安装**（QQ 本身是能用的），但会给出醒目提示与处理建议。
 */
function checkClientBuildMatch() {
  const build = readClientBuild();
  if (!build) {
    warn('读不到 SnowLuma 的 CLIENT_BUILD，跳过版本匹配检查。');
    return;
  }
  // ⚠️ 比对的是**实际装好的**便携 QQ 版本，不是配置里期望的版本。
  // 两者可能不同 —— 比如"从机器上已装的 QQ 复制过来"时，拿到的是 9.9.33-51802，
  // 而配置里写的文件名对应 260813。报配置值等于在自欺欺人：
  // 用户看到"build 260813"以为对上了，实际跑的是另一个 build。
  // 如果这次没走过下载/复制流程（比如 setup:check），就用清单文件反推来源。
  // 有这个文件 = 免安装包解出来的（打包脚本才会写它）。
  if (!QQ_SOURCE) {
    try {
      if (fs.existsSync(path.join(QQ_PORTABLE_DIR, 'portable-info.json'))) QQ_SOURCE = 'archive';
    } catch { /* ignore */ }
  }
  const actual = readQqVersionFromDir(QQ_PORTABLE_DIR);
  const actualShort = actual ? actual.short : QQ_VERSION_SHORT;
  const actualBuild = actual ? actual.build : QQ_BUILD;
  const actualLabel = actual ? `${actual.short}-${actual.build}` : `${QQ_VERSION_SHORT}-${QQ_BUILD}（读不到已装版本，按配置显示）`;

  // CLIENT_BUILD 形如 "9.9.26-44343"；对比短版本 + build 两段
  const norm = (x) => String(x || '').replace(/[^0-9.]/g, '').replace(/\.$/, '');
  const same = build === EXPECTED_CLIENT_BUILD
    || build === actualLabel
    || norm(build.split('-')[0]) === norm(actualShort)
    || build.includes(actualBuild);

  if (same) {
    log(`✅ QQ 版本与 SnowLuma 协议栈匹配（CLIENT_BUILD ${build}）`);
    return;
  }
  warn('');
  warn('='.repeat(64));
  warn('⚠️  QQ 版本与 SnowLuma 协议栈声明的客户端版本不一致');
  warn(`   便携 QQ 版本      : ${actualLabel}${actual ? '' : '（未安装？）'}`);
  if (actual && (actual.short !== QQ_VERSION_SHORT || actual.build !== QQ_BUILD)) {
    warn(`   （注意：与配置里期望的 ${QQ_VERSION_SHORT}-${QQ_BUILD} 不同 ——`);
    // 说清"为什么不同"。来源不同，用户该采取的行动也不同：
    //   免安装包 → 这是发行版带的版本，所有人一样，要换得重新打包
    //   复制来的 → 是这台机器上那份 QQ 的版本，别人可能不一样
    if (QQ_SOURCE === 'archive') {
      warn('     这是便携包自带的版本（打包时用的那份），属于预期内的差异。');
      warn('     要统一版本，需要用同一份便携包重新分发）');
    } else if (QQ_SOURCE === 'copied') {
      warn('     这是从本机已装的 QQ 复制来的版本，属于预期内的差异。');
      warn('     换机器时版本可能又不一样 —— 想统一版本请用免安装包）');
    } else {
      warn('     与配置里期望的版本不同，属于预期内的差异）');
    }
  }
  warn(`   SnowLuma 声明     : ${build}`);
  warn('');
  warn('   后果：QQ 能正常打开，但**扫码登录可能被拒**或某些接口行为异常。');
  warn('   这属于协议栈与客户端版本的对齐问题，不是网络/账号问题。');
  warn('');
  warn('   处理办法（任选）：');
  warn('   1) 换用与协议栈匹配的 QQ 版本：');
  warn(`      set QQ_PORTABLE_VERSION=${build.replace('-', '.')} && npm run setup -- --force`);
  warn('   2) 或换一个与当前 QQ 版本匹配的 SnowLuma：');
  warn('      set SNOWLUMA_VERSION=vX.Y.Z && npm run setup');
  warn('   3) 若确认当前组合能正常登录，可忽略本提示。');
  warn('='.repeat(64));
  warn('');
}

// ── 便携 QQ 安装/检查 ──

function isQqPortableReady() {
  const qqExe = path.join(QQ_PORTABLE_DIR, 'QQ.exe');
  return fs.existsSync(qqExe);
}

/**
 * 便携 QQ：本分支**不再自动下载/安装**。
 *
 * 两个原因：
 *   1) 自动下载依赖上游作者的分发地址（网盘接口），对方停服或改名，
 *      分支发版就会卡在"下载几百 MB 失败"上；
 *   2) 退回去装腾讯官方包又存在版本与协议栈不适配的风险
 *      （SnowLuma 钉死了 CLIENT_BUILD，装错版本能启动但登录被拒）。
 *
 * 所以这里只做两件事：检测是否已经放好；没放好就把**上游项目作者**的
 * 分发地址告诉用户，由用户自己取用。
 */
function installQqPortable() {
  if (isQqPortableReady()) {
    log('✅ 便携 QQ 已就绪（', QQ_PORTABLE_DIR, '），跳过。');
    if (fs.existsSync(path.join(QQ_PORTABLE_DIR, 'portable-info.json'))) QQ_SOURCE = 'archive';
    return;
  }
  warn('');
  warn('='.repeat(66));
  warn('本分支不提供便携 QQ 的下载与安装。');
  warn('');
  warn('需要便携 QQ 时，请使用**上游项目作者**提供的分发服务：');
  warn('  https://kondius.cn/qq-agent');
  warn('  （该页面与其中的分发包由上游项目作者维护，本分支不代为分发、不代为安装）');
  warn('');
  warn('拿到之后，把 QQ 程序文件放到：');
  warn(`  ${QQ_PORTABLE_DIR}`);
  warn('（该目录下要能直接看到 QQ.exe），然后重跑 npm run setup。');
  warn('');
  warn('已经把 QQ 装在系统里？也可以直接把安装目录里的文件复制到上面那个路径。');
  warn('='.repeat(66));
  warn('');
}


// ── 便携化辅助 ────────────────────────────────────────────────────────

/**
 * 兜底策略：把常见打包器的开关都列出来，逐个试。
 *
 * 为什么值得试全：识别可能会落空（打包器自定义/加了壳），而试错的代价只是 2 分钟。
 * 顺序按"QQ NT 历史上实际用过"的先后来排 —— 先试最可能的。
 */
const INSTALLER_FALLBACKS = [
  {
    name: 'NSIS 风格（/S /D=）',
    args: (dir) => ['/S', `/D=${dir}`]
  },
  {
    name: 'Inno 风格（/VERYSILENT /DIR=）',
    args: (dir) => ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${dir}`]
  },
  {
    name: '静默参数 /quiet',
    args: (dir) => ['/quiet', `INSTALLDIR=${dir}`]
  }
];

/**
 * 在便携目录里递归找 QQ.exe。
 *
 * 找到了就把它所在目录的**内容上提到根**（保持 `runtime/qq-portable/QQ.exe`
 * 这个约定不变，否则启动脚本、进程匹配、user-data-dir 全都要跟着改）。
 */
function foundQqExe() {
  const direct = path.join(QQ_PORTABLE_DIR, 'QQ.exe');
  if (fs.existsSync(direct)) return true;
  if (!fs.existsSync(QQ_PORTABLE_DIR)) return false;
  const found = findFileRecursive(QQ_PORTABLE_DIR, 'QQ.exe');
  if (!found) return false;
  const dir = path.dirname(found);
  if (path.resolve(dir) === path.resolve(QQ_PORTABLE_DIR)) return true;
  log(`QQ.exe 在子目录 ${path.relative(QQ_PORTABLE_DIR, dir) || '.'}，上提到根目录`);
  try {
    for (const item of fs.readdirSync(dir)) {
      const dst = path.join(QQ_PORTABLE_DIR, item);
      if (fs.existsSync(dst)) continue;   // 不覆盖已存在的
      fs.renameSync(path.join(dir, item), dst);
    }
  } catch (e) {
    warn(`上提失败：${e.message}（可手动把 ${dir} 里的文件复制到 ${QQ_PORTABLE_DIR}）`);
  }
  return fs.existsSync(path.join(QQ_PORTABLE_DIR, 'QQ.exe'));
}

/**
 * QQ 是否在运行？返回进程数（0 = 没在跑；检测不了也返回 0，不阻塞流程）。
 */
function runningQqCount() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/NH'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000
    });
    return countQqProcesses(out);
  } catch {
    return 0;
  }
}

/**
 * 找一个已经装好的 QQ。
 *
 * **注册表优先**：QQNT 安装后会把路径写进注册表，这是最可靠的来源
 * （比猜目录准得多 —— 用户完全可能装在 C:\Softwares\QQ 这种地方）。
 * 注册表查不到再退回到常见默认目录。
 */
function findInstalledQq() {
  const runReg = (a) => execFileSync('reg', a, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000
  });
  let cands = [];
  try { cands = collectQqInstallCandidates(runReg); } catch { cands = []; }
  const chosen = chooseQqInstall(cands, { wantShort: QQ_VERSION_SHORT });
  if (cands.length > 1) {
    log(`找到 ${cands.length} 个已安装的 QQ：`);
    for (const c of cands) {
      log(`  - ${c.dir}${c.version ? `（${c.version.short}-${c.version.build}）` : '（版本未知）'}`);
    }
  }
  if (!chosen.pick) return null;
  // 读不到版本的直接给出提示
  if (chosen.mismatched) {
    warn(`已安装的 QQ 版本与本脚本期望的不同：${chosen.reason}`);
    warn('  同大版本通常仍可用；若登录被拒，请装一份期望版本再重跑。');
  } else {
    log(`选中：${chosen.pick.dir}（${chosen.reason}）`);
  }
  return chosen.pick;
}

/**
 * 把已装好的 QQ 复制进便携目录。
 *
 * 跳过用户数据目录（Tencent Files / MyFiles 等）：我们要的是**程序文件**，
 * 把用户的聊天记录一起搬过来既慢又没必要（而且便携实例本来就该用自己的数据目录）。
 */
function copyInstalledQq(srcDir) {
  const skip = SKIP_ON_COPY;
  let copied = 0;
  let bytes = 0;
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const s1 = path.join(from, e.name);
      const s2 = path.join(to, e.name);
      if (e.isDirectory()) { walk(s1, s2); continue; }
      if (!e.isFile()) continue;
      try {
        fs.copyFileSync(s1, s2);
        copied += 1;
        bytes += fs.statSync(s2).size;
      } catch { /* 单个文件失败（被占用等）不中断整体 */ }
    }
  };
  log(`复制程序文件 ${srcDir} → ${QQ_PORTABLE_DIR}（已跳过用户数据目录）`);
  try {
    walk(srcDir, QQ_PORTABLE_DIR);
  } catch (e) {
    warn(`复制过程出错：${e.message}`);
  }
  log(`复制完成：${copied} 个文件，${(bytes / 1048576).toFixed(0)} MB`);
  return foundQqExe();
}

/** 尝试用 7zip 解压 NSIS 安装器（备选方案） */
function tryExtractWith7z(installerPath, destDir) {
  const sevenZ = ['7z', '7za', '7zz'];
  for (const cmd of sevenZ) {
    try {
      fs.mkdirSync(destDir, { recursive: true });
      execFileSync(cmd, ['x', installerPath, `-o${destDir}`, '-y'], {
        timeout: 120_000,
        stdio: 'pipe'
      });
      // 检查是否提取出 QQ.exe
      const qqExe = findFileRecursive(destDir, 'QQ.exe');
      if (qqExe) {
        // 如果 QQ.exe 在子目录里，上提
        const qqDir = path.dirname(qqExe);
        if (qqDir !== destDir) {
          log(`7zip 提取：将 ${qqDir}/ 内容上提到 ${destDir}/`);
          for (const item of fs.readdirSync(qqDir)) {
            fs.renameSync(path.join(qqDir, item), path.join(destDir, item));
          }
        }
        return true;
      }
    } catch {
      // 该命令不可用，尝试下一个
    }
  }
  return false;
}

function findFileRecursive(dir, filename) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === filename) return full;
      if (entry.isDirectory()) {
        const found = findFileRecursive(full, filename);
        if (found) return found;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ── 主流程 ──

async function main() {
  if (CHECK_ONLY) {
    const sl = isSnowlumaReady();
    const qq = isQqPortableReady();
    log(`协议端:    ${sl ? '✅ 就绪' : '❌ 未提供（自行准备即可）'}`);
    log(`便携 QQ:  ${qq ? '✅ 就绪' : '❌ 缺失（可选）'}`);
    const cb = readClientBuild();
    if (cb) log(`协议栈 CLIENT_BUILD: ${cb}（本脚本期望 ${EXPECTED_CLIENT_BUILD}）`);
    // --check 只报告状态：协议端/便携 QQ 都属"可选外部依赖"，
    // 缺了不影响应用本身启动，所以这里不再用退出码判失败。
    if (sl && qq) checkClientBuildMatch();
    return;
  }

  log('=== QQ Agent Setup ===');
  log('协议端:   由使用者自行准备（本脚本不下载、不分发）');
  log(`QQ:       ${QQ_VERSION}（便携包可选，本脚本不下载）`);
  log(`工作目录: ${ROOT}`);
  log('');

  // 1. 协议端：只检测 + 给指引
  await installSnowluma();
  // 1.5 仅当本机已有协议端目录时，才去对齐它声明的客户端版本
  alignClientBuild();

  // 2. 便携 QQ：只检测 + 给上游地址，不下载不安装
  if (!SKIP_QQ) {
    installQqPortable();
  } else {
    log('跳过便携 QQ 检查（--skip-qq）');
  }

  // 3. 最终校验
  log('');
  log('=== 校验 ===');
  const checks = [
    ['QQ Agent src/app.js', fs.existsSync(path.join(ROOT, 'src', 'app.js'))],
  ];
  // 协议端与便携 QQ 都是"可选的外部依赖"：缺了只影响应用内一键启动/本机进程管理，
  // 连外部 OneBot 照样能用 —— 所以不列入失败项，只做提示。
  if (!isSnowlumaReady()) {
    log('  ℹ️  本机协议端目录未就绪（不影响应用启动；按上方提示自行准备即可）');
  }
  // 便携 QQ 缺失不算失败：它只影响"应用内一键启动"，连外部 OneBot 照样能用。
  if (!SKIP_QQ && !fs.existsSync(path.join(QQ_PORTABLE_DIR, 'QQ.exe'))) {
    log('  ℹ️  便携 QQ 未就绪（不影响应用启动；需要时按上方提示放置）');
  }

  let allOk = true;
  for (const [name, ok] of checks) {
    log(`  ${ok ? '✅' : '❌'} ${name}`);
    if (!ok) allOk = false;
  }

  if (!allOk) {
    die('部分校验未通过，请检查上方输出');
  }

  // 版本兼容性检查放在最后：前面先保证"装上了"，这里再提示"装得对不对"。
  // 跳过 QQ 安装时也检查 —— 之前装好的便携 QQ 同样可能与协议栈不匹配。
  checkClientBuildMatch();

  log('');
  log('🎉 Setup 完成！现在可以启动：');
  log('   双击「启动QQ机器人.bat」或 npm start');
  log('');
  log('首次使用：');
  log('  1. 启动后在 SnowLuma 页签点「启动 QQ」');
  log('  2. 在弹出的便携 QQ 窗口扫码登录');
  log('  3. SnowLuma 会自动注入并连上 OneBot');
  log('  4. 机器人开始工作');
}

main().catch((e) => die(e.stack ?? e.message));
