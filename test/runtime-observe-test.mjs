// 观察队列：她做过的事，过一阵子回头看一眼有没有用。
//
// 判定是机械的（不调模型）：窗口内对方有动静 → changed；只有她自己说话 → void；
// 什么都没发生 → unchanged。价值判断留给反思与整合。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { verdictFor, drainDueObservations } = await import(src('src/runtime/observe.js'));

const NOW = Date.now();
const H = 3600000;

// ── 1. 判定 ─────────────────────────────────────────────────────────────
console.log('\n=== 1. 判定 ===');
{
  const ob = { id: 'ob_1', at: NOW - 80 * H, chatKey: 'private:1' };

  check(verdictFor({ observation: ob, events: [], now: NOW }).verdict === 'unchanged', '什么都没发生 → unchanged');

  const other = verdictFor({
    observation: ob,
    events: [{ ts: NOW - 10 * H, actorId: '456', text: '刚看到' }],
    now: NOW
  });
  check(other.verdict === 'changed' && other.note.includes('回应'), '对方有回应 → changed');

  const self = verdictFor({
    observation: ob,
    events: [{ ts: NOW - 10 * H, actorId: 'self', text: '我自己又说了一句' }],
    now: NOW
  });
  check(self.verdict === 'void', '只有她在说 → void（判断不了）');

  const before = verdictFor({
    observation: ob,
    events: [{ ts: ob.at - 1000, actorId: '456', text: '窗口之前的事' }],
    now: NOW
  });
  check(before.verdict === 'unchanged', '窗口之前的事件不算数');

  check(verdictFor({ observation: { at: 0 }, events: [], now: NOW }).verdict === 'void', '记录不完整 → void');
}

// ── 2. 批量判掉到期观察 ─────────────────────────────────────────────────
console.log('\n=== 2. 批量处理 ===');
{
  const resolved = [];
  const port = {
    openObservations: () => [
      { id: 'ob_a', at: NOW - 80 * H, chatKey: 'private:1' },
      { id: 'ob_b', at: NOW - 80 * H, chatKey: 'private:2' }
    ],
    recentEvents: ({ chatKey }) => (chatKey === 'private:1'
      ? [{ ts: NOW - H, actorId: '456', text: '嗯' }]
      : []),
    resolveObservation: (id, opts) => { resolved.push({ id, ...opts }); return { ok: true }; }
  };
  const summary = drainDueObservations({ port, now: NOW });
  check(summary.checked === 2, '两条都处理了');
  check(summary.changed === 1 && summary.unchanged === 1, '一条 changed 一条 unchanged');
  check(resolved.length === 2 && resolved.every((r) => r.note), '判定带备注（界面上能解释）');

  const broken = drainDueObservations({ port: { openObservations: () => { throw new Error('炸'); } }, now: NOW });
  check(broken.checked === 0, '端口抛错时安静返回（不影响心跳）');
  check(drainDueObservations({ port: null }).checked === 0, '没有端口时也是空结果');
}

console.log(`\n观察队列：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
