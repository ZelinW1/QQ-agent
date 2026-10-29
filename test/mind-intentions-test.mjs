// 意图 / 尝试 / 观察自测（B3）。
//
// 这三张表替换的是旧的 actions.jsonl 流水账。流水账只回答"她做过什么"，
// 回答不了三件真正要看的事：
//   · 她想做什么、打算什么时候做      → intentions
//   · 做成了没有、没做成是因为什么    → attempts
//   · 做完之后世界有没有变化          → observations
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-intent-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { MindStore } = await import(src('src/mind/store.js'));
const mkStore = () => new MindStore({
  root: fs.mkdtempSync(path.join(dataDir, 'm-')),
  getOptions: () => ({ seedInvariants: [] })
});

const H = 3600000;

// ── 1. 尝试：新记录进 attempts，旧文件冻结 ─────────────────────────────
console.log('\n=== 1. 尝试与冻结 ===');
{
  const store = mkStore();
  const dir = store.root;
  // 先放一条"历史"记录，模拟升级前留下的 actions.jsonl
  fs.writeFileSync(path.join(dir, 'actions.jsonl'),
    `${JSON.stringify({ id: 'a_old', at: 1, action: 'recall', reason: '旧记录' })}\n`, 'utf8');

  const rec = store.appendAction({ chatKey: 'private:456', action: 'send_proactive', reason: '想她了', at: 1000 });
  check(rec.outcome === 'done', '不传 outcome 时按结果推断为 done');

  const legacySize = fs.statSync(path.join(dir, 'actions.jsonl')).size;
  store.appendAction({ chatKey: 'private:456', action: 'idle', reason: '算了' });
  check(fs.statSync(path.join(dir, 'actions.jsonl')).size === legacySize, 'actions.jsonl 不再增长（已冻结）');
  check(store.listAttempts({ limit: 10 }).length === 2, '新记录都进 attempts.jsonl');

  const merged = store.listActions({ limit: 10 });
  check(merged.length === 3, `listActions 合并新旧（${merged.length}）`);
  check(merged[0].id === 'a_old', '旧的排在前（按写入顺序）');
  check(merged.at(-1).action === 'idle', '新的排在后');

  store.appendAction({ chatKey: 'x', action: 'organize', error: '超时' });
  check(store.listAttempts({ limit: 1 })[0].outcome === 'failed', '有 error 推断为 failed');
  store.appendAction({ chatKey: 'x', action: 'send_proactive', result: { blocked: true } });
  check(store.listAttempts({ limit: 1 })[0].outcome === 'blocked', '被拒推断为 blocked');
  check(store.listAttempts({ limit: 10, outcome: 'failed' }).length === 1, '可按结局筛选');

  const sizes = store.logSizes();
  check(sizes.actions > 0 && sizes.legacyActions > 0, '日志体积分别统计新旧');
  store.clearLogs({ actions: true, reflections: false });
  check(store.listAttempts({ limit: 10 }).length === 0 && store.listActions({ limit: 10 }).length === 0,
    '清空行动日志会同时清掉新旧两处');
}

// ── 2. 意图 ─────────────────────────────────────────────────────────────
console.log('\n=== 2. 意图 ===');
{
  const store = mkStore();
  const now = Date.now();
  const r1 = store.addIntention({ text: '问他后来那件事怎么样了', dueAt: now + 2 * H, source: 'chat', chatKey: 'private:456' });
  check(r1.ok === true && r1.intention.status === 'open', '新建意图是 open');
  check(r1.intention.id.startsWith('in_'), '意图有独立 id 前缀');
  check(r1.intention.kind === 'follow_up', '默认 kind 是跟进');

  const r2 = store.addIntention({ text: '问他后来那件事怎么样了' });
  check(r2.duplicate === true && r2.intention.id === r1.intention.id, '同一句话不会重复挂');

  const r3 = store.addIntention({ text: '给自己换个头像', dueAt: now + 26 * H, source: 'free', kind: 'delayed_check' });
  check(r3.ok === true && r3.intention.kind === 'delayed_check', '可带自由标记');

  check(store.listIntentions({ status: 'open' }).length === 2, '两条都还在待办');
  const due = store.listIntentions({ dueBefore: now + 3 * H });
  check(due.length === 1 && due[0].id === r1.intention.id, '按到期时间筛选');

  const done = store.resolveIntention(r1.intention.id, { status: 'done', note: '问过了' });
  check(done.ok === true && done.intention.status === 'done', '了结为 done');
  check(store.listIntentions({ status: 'open' }).length === 1, '待办里只剩一条');
  check(done.intention.note === '问过了', '了结时留下备注');

  const again = store.resolveIntention(r1.intention.id, { status: 'dropped' });
  check(again.unchanged === true, '已了结的不会被二次改写');
  check(store.addIntention({ text: '   ' }).ok === false, '空意图被拒绝');
  check(store.resolveIntention('in_nope').ok === false, '不存在的意图返回失败');
}

// ── 3. 观察 ─────────────────────────────────────────────────────────────
console.log('\n=== 3. 观察 ===');
{
  const store = mkStore();
  const now = Date.now();
  const ob = store.appendObservation({
    attemptId: 'at_1', intentionId: 'in_1', chatKey: 'private:456',
    expect: '他应该会回我', at: now, windowMs: 72 * H
  });
  check(ob.verdict === 'pending', '新观察是 pending');
  check(ob.dueAt === now + 72 * H, '窗口 72 小时');
  check(ob.checkAfterAt === now + 24 * H, '最早 24 小时后可复查');
  check(store.listDueObservations(now + H).length === 0, '窗口内不算到期');
  check(store.listDueObservations(now + 73 * H).length === 1, '窗口过后进入待复查');

  const r = store.resolveObservation(ob.id, { verdict: 'unchanged', note: '没回' });
  check(r.ok === true && r.observation.verdict === 'unchanged', '可以判定为 unchanged');
  check(store.listDueObservations(now + 80 * H).length === 0, '判定后不再待复查');
  check(store.resolveObservation(ob.id, { verdict: '乱写' }).ok === false, '非法判定被拒绝');
}

// ── 4. 静态：写入路径真的换了 ───────────────────────────────────────────
console.log('\n=== 4. 写入路径 ===');
{
  const text = fs.readFileSync(path.join(ROOT, 'src/mind/store.js'), 'utf8');
  const appendBody = text.slice(text.indexOf('appendAction(entry = {})'), text.indexOf('appendAction(entry = {})') + 400);
  check(!appendBody.includes('#actionsFile()'), 'appendAction 不再写 actions.jsonl');
  check(appendBody.includes('#attemptsFile()'), 'appendAction 写 attempts.jsonl');
}

console.log(`\n意图与观察：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
