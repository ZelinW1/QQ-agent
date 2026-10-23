#!/usr/bin/env node
/**
 * 全量测试运行器。
 *
 * 为什么需要它（而不是直接 `npm test`）：
 *   1) `npm test` 是一条 `a.mjs && b.mjs && …` 的长链，**第一个失败就中断**，
 *      拿不到"哪些通过/哪些失败"的全貌 —— 做重构等价性验证时需要的正是全貌。
 *   2) 用 process.execPath 启动子进程，不依赖 PATH 里有没有 node：
 *      本机 node 装在自定义目录（D:\software\nodejs），而部分 shell 进程的
 *      PATH 是旧的，`node`/`npm` 解析不到。
 *
 * 用法：
 *   node scripts/run-tests.mjs            # 全部
 *   node scripts/run-tests.mjs chat-profile usage   # 只跑名字里含这些片段的
 *
 * 退出码：有失败 → 1，否则 0。
 *
 * ⚠️ 与 `npm test` 的差异（刻意）：那些套件在 npm 链里是**顺序同一进程组**执行；
 *    部分套件会互相污染（例如 coverage-e2e 单独跑通过、紧跟某些套件后失败）。
 *    本运行器**每套一个独立子进程、串行执行**，结果更可复现，也更贴近 CI。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

// 脚手架不是测试：_harness.mjs 只导出工具函数，跑了也不会自检。
const SKIP = new Set(['_harness.mjs']);

const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const QUIET = process.argv.includes('--quiet');
const FAILED_ONLY = process.argv.includes('--failed-only');
const TAIL_LINES = 40;

/**
 * 每套的输出落盘位置。
 *
 * 为什么**不**继承父进程的 stdout（曾经就是 stdio:'inherit'）：
 *   父进程的 stdout 常常被调用方接进管道（PowerShell 的 `| Select-String`、
 *   CI 的日志采集）。多套测试合计输出几十万行时，会撞上管道缓冲上限，
 *   **子进程被整锅杀掉**（表现为 exit -1，且只输出到一半）——
 *   看起来像"这套测试挂了"，实际是输出通道被掐断，非常容易误判成代码回归。
 *   落盘 + 事后只打印尾部，就把"输出量"与"成败判定"彻底解耦了。
 */
const LOG_DIR = path.join(os.tmpdir(), `qq-agent-tests-${process.pid}`);
fs.mkdirSync(LOG_DIR, { recursive: true });

function discover() {
  return fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.mjs') && !SKIP.has(f))
    .filter((f) => !filters.length || filters.some((q) => f.includes(q)))
    .sort();
}

function tailOf(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    return lines.slice(-n);
  } catch { return []; }
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const logFile = path.join(LOG_DIR, `${file}.log`);
    const out = fs.openSync(logFile, 'w');
    const child = spawn(process.execPath, [path.join(TEST_DIR, file)], {
      cwd: ROOT,
      stdio: ['ignore', out, out]
    });
    const finish = (code, signal) => {
      try { fs.closeSync(out); } catch { /* ignore */ }
      resolve({ file, code: code ?? 1, signal: signal || null, ms: Date.now() - started, logFile });
    };
    child.on('close', finish);
    child.on('error', (err) => {
      try { fs.writeSync(out, `[run-tests] 无法启动: ${err?.message ?? err}\n`); } catch { /* ignore */ }
      finish(1, null);
    });
  });
}

const files = discover();
if (!files.length) {
  console.error(filters.length
    ? `[run-tests] 没有匹配的测试：${filters.join(', ')}`
    : '[run-tests] test/ 下没有测试文件');
  process.exit(1);
}

console.log(`[run-tests] 共 ${files.length} 套，每套独立子进程串行执行`);
console.log(`[run-tests] node = ${process.execPath}`);
console.log(`[run-tests] 日志 = ${LOG_DIR}`);
console.log(`[run-tests] 过滤 = ${filters.length ? filters.join(', ') : '(无)'}\n`);

const results = [];
for (const f of files) {
  const r = await runOne(f);
  results.push(r);
  const bad = r.code !== 0;
  const mark = bad ? '❌ FAIL' : '✅ PASS';
  console.log(`${mark}  ${f}  (${(r.ms / 1000).toFixed(1)}s)${r.signal ? ` [signal ${r.signal}]` : ''}`);
  if (bad && !QUIET) {
    console.log(`      ── 输出尾部（完整日志：${r.logFile}）──`);
    for (const line of tailOf(r.logFile, TAIL_LINES)) console.log('      ' + line);
    console.log('');
  }
}

const failed = results.filter((r) => r.code !== 0);
console.log('\n' + '═'.repeat(70));
console.log(`[run-tests] PASS ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  const shown = FAILED_ONLY ? failed : failed;
  for (const r of shown) console.log(`[run-tests]   ❌ ${r.file}  (exit ${r.code})  ${r.logFile}`);
} else {
  console.log('[run-tests] 全部通过');
}
console.log('═'.repeat(70));

process.exit(failed.length ? 1 : 0);
