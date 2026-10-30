// 唤醒时钟与门禁自测。
//
// 时钟是自由时刻的骨架：采样错 → 她要么永不主动、要么刷屏；门禁错 → 该睡不睡、
// 该让位不让位。所以这里只测纯函数，不牵扯编排器。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { sampleImpulseAt, nextWakeAt, checkGates, describeGate } = await import(src('src/runtime/wake.js'));

const NOW = Date.now();
const H = 3600000;

// ── 1. 冲动采样 ─────────────────────────────────────────────────────────
console.log('\n=== 1. 冲动采样 ===');
{
  const at = sampleImpulseAt(NOW, 4 * H, () => 0.5);
  check(at > NOW, '一定晚于现在');
  check(at - NOW > 60000, '至少有 1 分钟的下限（避免连醒）');
  const near = sampleImpulseAt(NOW, 4 * H, () => 0.999999);
  const far = sampleImpulseAt(NOW, 4 * H, () => 0.000001);
  check(near - NOW < far - NOW, 'U 越大间隔越短（指数分布方向正确）');
  check(far - NOW > 4 * H, '尾部可以很长（"很久没醒"是合法的）');

  // 用固定随机数验证均值附近：-ln(0.5)*mean ≈ 0.693*mean
  const half = sampleImpulseAt(NOW, 4 * H, () => 0.5) - NOW;
  check(Math.abs(half - Math.round(Math.LN2 * 4 * H)) < 50, `中位间隔 = ln2×均值（${Math.round(half / 60000)} 分钟）`);
}

// ── 2. 下一次唤醒：取最早 ───────────────────────────────────────────────
console.log('\n=== 2. nextWakeAt ===');
{
  const r1 = nextWakeAt({ now: NOW, impulseAt: NOW + 3 * H, intentionDueAts: [NOW + H] });
  check(r1.at === NOW + H && r1.reason === 'intention', '到期意图早于冲动 → 听意图的');

  const r2 = nextWakeAt({ now: NOW, impulseAt: NOW + H, intentionDueAts: [NOW + 3 * H] });
  check(r2.at === NOW + H && r2.reason === 'impulse', '冲动早于意图 → 听冲动的');

  const r3 = nextWakeAt({ now: NOW, impulseAt: NOW + 5 * H, actionRipeAts: [NOW + 2 * H] });
  check(r3.at === NOW + 2 * H && r3.reason === 'action-ripe', '动作节律也算进最早唤醒');

  const r4 = nextWakeAt({ now: NOW, impulseAt: NOW + 5 * H, socialDueAts: [NOW + 30 * 60000] });
  check(r4.at === NOW + 30 * 60000 && r4.reason === 'social', '"该联系某人了"也能叫醒她');

  const r5 = nextWakeAt({ now: NOW, impulseAt: 0 });
  check(r5.reason === 'fallback' && r5.at > NOW, '什么都不知道时给一个兜底间隔（不会再也不醒）');

  // 已过期的意图：立刻可醒，而不是排到未来
  const r6 = nextWakeAt({ now: NOW, impulseAt: NOW + 3 * H, intentionDueAts: [NOW - H] });
  check(r6.at === NOW && r6.reason === 'intention', '过期的意图 = 现在就该醒');
}

// ── 3. 门禁 ─────────────────────────────────────────────────────────────
console.log('\n=== 3. 门禁 ===');
{
  const base = { now: NOW, energy: 50, energyFloor: 10, todayDecisions: 0, maxDecisionsPerDay: 24, hasModel: true };
  check(checkGates(base).ok === true, '正常情况下可以醒');

  check(checkGates({ ...base, asleep: true }).code === 'asleep', '睡着不醒');
  check(checkGates({ ...base, paused: true }).code === 'paused', '暂停不醒');
  check(checkGates({ ...base, aborted: true }).code === 'aborted', '中止不醒');
  check(checkGates({ ...base, energy: 5 }).code === 'tired', '体力不足不醒');
  check(checkGates({ ...base, todayDecisions: 24 }).code === 'decision-cap', '决策次数用完不醒');
  check(checkGates({ ...base, chatRunning: true }).code === 'chat-running', '正在聊天时让位');
  check(checkGates({ ...base, chatPending: true }).code === 'chat-pending', '马上要回消息时让位');
  check(checkGates({ ...base, lastWakeAt: NOW - 60000, tooSoonMs: 5 * 60000 }).code === 'too-soon', '刚醒过不重复醒');
  check(checkGates({ ...base, lastWakeAt: NOW - 10 * 60000, tooSoonMs: 5 * 60000 }).ok === true, '过了最小间隔就能醒');
  check(checkGates({ ...base, costTodayUsd: 2, costCapUsd: 1 }).code === 'cost-cap', '成本到上限不醒');
  check(checkGates({ ...base, hasModel: false }).code === 'no-model', '没有模型不醒');

  check(describeGate({ code: 'chat-running' }) === '正在跟人说话', '门禁原因能说人话');
  check(describeGate({ code: 'weird', reason: '自定义' }) === '自定义', '未知原因原样透出，不吞信息');
}

console.log(`\n唤醒时钟：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
