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

const outName = `QQ-Agent-Hui-V${version}-win64-portable.zip`;
const outFile = path.join(ROOT, 'dist', outName);
fs.rmSync(outFile, { force: true });

// Windows 10+ 自带 bsdtar：tar -a 会按扩展名自动选 zip 格式。
// 比 Compress-Archive 快得多（后者对 200MB+ 目录要几分钟）。
console.log(`打包 ${path.relative(ROOT, appDir)} → dist/${outName} …`);
execFileSync('tar', ['-a', '-c', '-f', outFile, '-C', appDir, '.'], { stdio: 'inherit' });

const mb = (fs.statSync(outFile).size / 1048576).toFixed(1);
console.log(`完成：dist/${outName}（${mb} MB）`);
