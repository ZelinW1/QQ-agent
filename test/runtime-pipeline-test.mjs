// 运行时管线与现场（C1）。
//
// 这一层是 C 期换引擎的地基：八步管线决定"该不该做、能不能做、做没做成"，
// 现场（scene）决定"她现在看得到谁"。两者都不依赖编排器，因此可以单独测。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { createPipeline, PIPELINE_STEPS } = await import(src('src/runtime/pipeline.js'));
const { createRuntimePort } = await import(src('src/contract/mind-port.js'));

// ── 1. 顺序与审计 ───────────────────────────────────────────────────────
console.log('\n=== 1. 八步顺序 ===');
{
  const ran = [];
  const audits = [];
  const pipe = createPipeline({
    steps: {
      resolve: () => { ran.push('resolve'); return { ctx: { chatKey: 'private:1' } }; },
      eligibility: () => { ran.push('eligibility'); },
      permission: () => { ran.push('permission'); },
      validate: () => { ran.push('validate'); },
      veto: () => { ran.push('veto'); },
      execute: (ctx) => { ran.push(`execute:${ctx.chatKey}`); return { value: 'sent' }; },
      normalize: () => { ran.push('normalize'); },
      audit: (_ctx, result) => { audits.push(result); }
    }
  });
  const r = await pipe.run({ chatKey: '' });
  check(r.ok === true && r.value === 'sent', '整条跑通并带回结果');
  check(ran.join(',') === 'resolve,eligibility,permission,validate,veto,execute:private:1,normalize',
    `顺序固定且 ctx 能传递（${ran.join(',')}）`);
  check(audits.length === 1 && audits[0].ok === true, 'audit 最后跑，拿到结果');
  check(pipe.steps.at(-1) === 'audit' && pipe.steps.length === 8, '八步齐全，audit 排在最后（由管线强制）');
}

// ── 2. 任一步拦下 ───────────────────────────────────────────────────────
console.log('\n=== 2. 拦下与原因码 ===');
{
  let executed = false;
  const audits = [];
  const pipe = createPipeline({
    steps: {
      resolve: () => {},
      eligibility: () => ({ ok: false, code: 'disabled', message: '心智关闭' }),
      execute: () => { executed = true; },
      audit: (_c, r) => { audits.push(r); return 'logged'; }
    }
  });
  const r = await pipe.run({});
  check(r.ok === false && r.stoppedAt === 'eligibility' && r.code === 'disabled', '停在出问题的那一步，带原因码');
  check(r.message === '心智关闭', '原因可读');
  check(executed === false, '后面的步骤不再执行');
  check(audits.length === 1 && audits[0].ok === false, '被拦下也要审计（界面上不能只剩沉默）');
  check(r.audit === 'logged', 'audit 的返回值带回结果');
  check(r.trace.includes('eligibility') && !r.trace.includes('execute'), 'trace 记录跑到哪');
}

// ── 3. 三种"不做"的写法 ─────────────────────────────────────────────────
console.log('\n=== 3. 步骤返回值的语义 ===');
{
  const p1 = createPipeline({ steps: { resolve: () => false } });
  check((await p1.run({})).code === 'stopped', '返回 false → 停止');
  const p2 = createPipeline({ steps: { resolve: () => ({ stop: true, reason: '没到时候' }) } });
  const r2 = await p2.run({});
  check(r2.ok === false && r2.message === '没到时候', '返回 {stop:true} → 停止并带原因');
  const p3 = createPipeline({ steps: { resolve: () => undefined } });
  check((await p3.run({})).ok === true, '返回 undefined → 继续（普通步骤不必返回值）');
}

// ── 4. 超时与身份复核 ───────────────────────────────────────────────────
console.log('\n=== 4. 超时与身份复核 ===');
{
  const pipe = createPipeline({
    steps: { execute: () => new Promise((resolve) => setTimeout(() => resolve({ value: 'late' }), 200)) },
    executeTimeoutMs: 20
  });
  const r = await pipe.run({});
  check(r.ok === false && r.code === 'timeout', '执行超时被拦下（不会永远挂着）');

  let executed = false;
  const pipe2 = createPipeline({
    steps: { execute: () => { executed = true; } },
    recheck: async () => false
  });
  const r2 = await pipe2.run({});
  check(r2.ok === false && r2.code === 'identity-changed', '执行前身份变了 → 放弃');
  check(executed === false, '身份复核失败时不会真的执行');
}

// ── 5. 异常不会炸穿 ─────────────────────────────────────────────────────
console.log('\n=== 5. 异常处理 ===');
{
  const pipe = createPipeline({
    steps: { resolve: () => { throw new Error('炸了'); }, audit: () => { throw new Error('审计也炸了'); } }
  });
  const r = await pipe.run({});
  check(r.ok === false && r.code === 'error' && r.message.includes('炸了'), '步骤异常转成结果，不抛给调用方');
}

// ── 6. 现场：窗口参数与注入 ─────────────────────────────────────────────
console.log('\n=== 6. 现场 ===');
{
  const now = Date.now();
  const H = 3600000;
  const mind = {
    getTick: () => ({ rev: 1 }),
    getRelation: (id) => ({ nickname: `人${id}`, stage: 'familiar', warmth: 60, openLoops: id === '111' ? [{ text: '问他', since: now - 30 * H }] : [] }),
    queryEvents: () => [{ ts: now - 2 * H }]
  };
  const chatStore = {
    listChats: () => ['private:111', 'private:222', 'group:333'],
    getChatMeta: (k) => (k === 'private:111'
      ? { lastTs: now - 60000, unread: 2, lastText: '刚发的', lastSelf: false }
      : { lastTs: now - 10 * H, unread: 0, lastText: '很久以前' })
  };
  const port = createRuntimePort(mind, { chatStore, proactiveAt: (k) => (k === 'private:222' ? now - 60000 : 0) });

  const s = port.scene({ now, limit: 3 });
  check(s.entries.length === 2, '群聊不进现场（与现有行为一致）');
  const first = s.entries.find((e) => e.chatKey === 'private:111');
  check(first.lastTs === now - 60000 && first.unread === 2, '带最后时间与未读');
  check(first.openLoopsDue === 1, '未完结事项超时会被数出来');
  check(first.recent === true, '一分钟前聊过 → recent');
  const second = s.entries.find((e) => e.chatKey === 'private:222');
  check(second.suppressed === true, '注入的 proactiveAt 生效（刚主动找过 → 压住）');

  const narrow = port.scene({ now, limit: 3, options: { idleLookbackMs: 30000 } });
  check(narrow.entries.find((e) => e.chatKey === 'private:111').recent === false, '窗口参数可调');

  const noStore = createRuntimePort(mind, {});
  check(noStore.scene().entries.length === 0, '没有会话源时返回空，而不是抛错');
}

console.log(`\n运行时地基：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
