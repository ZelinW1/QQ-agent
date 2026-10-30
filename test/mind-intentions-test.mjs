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

  const r = store.resolveObservation(ob.id, { verdict: 'missed', note: '没回' });
  check(r.ok === true && r.observation.verdict === 'missed', '可以判定为 missed');
  check(store.listDueObservations(now + 80 * H).length === 0, '判定后不再待复查');
  check(store.resolveObservation(ob.id, { verdict: '乱写' }).ok === false, '非法判定被拒绝');
}

// ── 3b. 观察闭环：回话即命中，动作节律据此调频 ──────────────────────────
console.log('\n=== 3b. 观察闭环与节律 ===');
{
  const store = mkStore();
  const now = Date.now();

  // 对方回话：把所有等待中的观测一次关成 hit
  store.appendObservation({ chatKey: 'private:1', action: 'send_proactive', expect: '会回', at: now - 3600000 });
  store.appendObservation({ chatKey: 'private:2', action: 'send_proactive', expect: '会回', at: now - 3600000 });
  const closed = store.closeObservationsForChat('private:1', { verdict: 'hit', now });
  check(closed.closed === 1, '只关闭这个会话的观测');
  const rows = store.listObservations({ limit: 10 });
  check(rows.some((o) => o.chatKey === 'private:1' && o.verdict === 'hit'), '这个会话的观测变成 hit');
  check(rows.some((o) => o.chatKey === 'private:2' && o.verdict === 'pending'), '别的会话不受影响');

  // utility 观测不吃回声：它做完就已经判完，不该被"对方回话"再关一次
  store.appendObservation({ chatKey: 'private:3', action: 'organize', kind: 'utility', expect: '欠账变少', at: now - 60000 });
  const closed2 = store.closeObservationsForChat('private:3', { verdict: 'hit', now });
  check(closed2.closed === 0, '回话只关闭 echo 观测');

  // 动作节律：命中缩短间隔，落空拉长间隔
  const a = store.recordActionStat('send_proactive', { ok: true, now });
  check(a.stat.meanIntervalMs < 4 * 3600000, `命中后间隔变短（${a.stat.meanIntervalMs}）`);
  check(a.stat.nextRipeAt > now, '给出下次可做时间');
  const b = store.recordActionStat('send_proactive', { ok: false, now });
  check(b.stat.meanIntervalMs > a.stat.meanIntervalMs, `落空后间隔变长（${a.stat.meanIntervalMs} → ${b.stat.meanIntervalMs}）`);
  check(b.stat.fail === 1 && b.stat.ok === 1, '成/败次数分别累计');
  check(store.getTick().actionStats.send_proactive.nextRipeAt === b.stat.nextRipeAt, '写进 tick（重启后仍然生效）');
}

// ── 3d. 节律规则：少样本保守、0.6×/3×、dormant ──────────────────────────
console.log('\n=== 3d. 节律规则 ===');
{
  const store = mkStore();
  const now = Date.now();
  const H = 3600000;

  // 前 5 次不放大：一次命中只做 5% 微调
  const first = store.recordActionStat('send_proactive', { ok: true, now });
  check(first.stat.attempts === 1, '第一次也记 attempts');
  check(first.stat.meanIntervalMs > 3 * H, `样本不足 5 次不做大幅调频（${Math.round(first.stat.meanIntervalMs / H * 10) / 10}h）`);

  // 连续 5 次命中 → 0.6×（4h → 2.4h 左右）
  const s2 = mkStore();
  for (let i = 0; i < 5; i++) s2.recordActionStat('send_proactive', { ok: true, now });
  const good = s2.getTick().actionStats.send_proactive;
  check(good.rate >= 0.8, '成功率到 0.8 以上');
  check(good.meanIntervalMs <= 0.65 * 4 * H, `很有效 → 间隔缩短到 0.6×（${Math.round(good.meanIntervalMs / H * 100) / 100}h）`);

  // 连续 5 次落空 → 3×，并进入 dormant
  const s3 = mkStore();
  for (let i = 0; i < 5; i++) s3.recordActionStat('send_proactive', { ok: false, now });
  const bad = s3.getTick().actionStats.send_proactive;
  check(bad.meanIntervalMs >= 3 * 4 * H, `基本没用 → 间隔放大（${Math.round(bad.meanIntervalMs / H)}h）`);
  check(bad.dormant === true, '成功率 < 20% → dormant');
  check(bad.dormantUntil > now, 'dormant 有一周的退场期');
}
// ── 3c. 收到消息即命中：不需要等窗口到期 ────────────────────────────────
console.log('\n=== 3c. 回声命中 ===');
{
  const { Orchestrator } = await import(src('src/orchestrator.js'));
  const { createRuntimePort } = await import(src('src/contract/mind-port.js'));
  const { updateConfig } = await import(src('src/config.js'));
  updateConfig({ api: { model: '', baseUrl: '' } });   // 不触发模型：只验证"收到消息"这一步

  const store = mkStore();
  store.appendObservation({ chatKey: 'private:1', action: 'send_proactive', expect: '会回', at: Date.now() - 3600000 });

  const orch = new Orchestrator({
    store: { listChats: () => [], getChatMeta: () => ({}), recent: () => [] },
    memory: {}, stickers: {}, sender: {}, sessions: {}, onebot: {}, mind: store
  });
  orch.paused = false;
  orch.aborted = false;
  orch.asleep = false;
  orch.onIncoming('private:1');

  const rows = store.listObservations({ limit: 5 });
  check(rows[0]?.verdict === 'hit', '收到消息 → 该会话的观测当场命中');
  const stat = store.getTick().actionStats?.send_proactive;
  check(Boolean(stat), '命中同时回写了动作节律（不只是关掉观测）');
  check(Number(stat?.meanIntervalMs) < 4 * 3600000, `命中后期望间隔变短（${stat?.meanIntervalMs}）`);
  check(Number(stat?.ok) >= 1, '计一次成功');
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
