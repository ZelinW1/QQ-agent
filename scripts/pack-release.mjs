// 把 electron-builder 的 --dir 产物打成一个便携 ZIP。
//
// 为什么需要它：electron-builder 打 NSIS 安装包时需要联网下载 nsis/winCodeSign
// 工具链；离线或网络受限的机器上，最实用的发布物就是"解压即用"的便携包。
//
// 用法：npm run dist:dir && npm run dist:zip
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');

const appDir = path.join(ROOT, 'dist', 'win-unpacked');
if (!fs.existsSync(path.join(appDir, 'QQ Agent Hui.exe'))) {
  console.error('找不到 dist/win-unpacked —— 先运行：npm run dist:dir');
  process.exit(1);
}

// 冒烟测试会在 win-unpacked 里生成 data/（含 config.json 与 API Key）；
// 协议端若被解到 resources/app/snowluma 也会被一起打进去（近 100MB + 你的令牌）。
// 一旦混进发布包就是泄露 —— 直接中止，让人自己决定删掉还是换目录。
const appResources = path.join(appDir, 'resources', 'app');
const leaked = [
  ...['data', 'snowluma', 'runtime'].map((d) => path.join(appDir, d)),
  ...['data', 'snowluma', 'runtime', 'private'].map((d) => path.join(appResources, d))
].filter((p) => fs.existsSync(p));
if (leaked.length) {
  console.error('拒绝打包：win-unpacked 里存在这些目录（测试残留或数据目录）：');
  for (const p of leaked) console.error(`  ${p}`);
  console.error('请先删掉它们再打包，例如：');
  console.error(`  rmdir /s /q "${leaked[0]}"`);
  process.exit(1);
}

const outName = `QQ-Agent-Hui-V${version}-win64-portable.zip`;
const outFile = path.join(ROOT, 'dist', outName);
// 直接删旧文件偶尔会 EPERM（资源管理器预览、杀毒扫描会持有句柄）。
// 先写到 .tmp，再尝试替换；替换失败就把旧文件改名让路。
const tmpFile = `${outFile}.tmp`;
fs.rmSync(tmpFile, { force: true });

// Windows 10+ 自带 bsdtar：tar -a 会按扩展名自动选 zip 格式。
// 比 Compress-Archive 快得多（后者对 200MB+ 目录要几分钟）。
console.log(`打包 ${path.relative(ROOT, appDir)} → dist/${outName} …`);
execFileSync('tar', ['-a', '-c', '-f', tmpFile, '-C', appDir, '.'], { stdio: 'inherit' });

try {
  fs.rmSync(outFile, { force: true });
  fs.renameSync(tmpFile, outFile);
} catch {
  const parked = `${outFile}.old-${Date.now()}`;
  try {
    fs.renameSync(outFile, parked);
    fs.renameSync(tmpFile, outFile);
    console.warn(`旧包被占用，已改名为 ${path.basename(parked)}（可稍后手动删除）`);
  } catch (error) {
    console.error(`无法写入 ${outName}：${error.message}`);
    console.error(`新包已生成在 ${tmpFile}，请关闭占用它的程序后手动改名。`);
    process.exit(2);
  }
}

const mb = (fs.statSync(outFile).size / 1048576).toFixed(1);
console.log(`完成：dist/${outName}（${mb} MB）`);
