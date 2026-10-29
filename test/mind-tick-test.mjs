// 心跳的纯逻辑与日志取舍。
//
// 本套只测不依赖模型的那些规则：能量结算、跨天清零、候选预判、抖动、动作可用性，
// 以及"跳过"日志的合并。心跳的完整流程（一次唤醒做什么、扣多少体力）由
// mind-global-tick-test 覆盖 —— per-chat 模式移除后，心跳只有一条路径。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-tick-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const {
  settleEnergy, resetDaily, collectCandidates, nextTickAt, actionBlocked
} = await import(src('src/mind/tick.js'));
const { ACTIONS, getAction, availableActions } = await import(src('src/mind/actions.js'));
const { MindStore } = await import(src('src/mind/store.js'));
const { Orchestrator } = await import(src('src/orchestrator.js'));
const { updateConfig } = await import(src('src/config.js'));
const { todayKey } = await import(src('src/util.js'));

const H = 3600000;
const now0 = Date.now();

// ── 1. 能量结算 ─────────────────────────────────────────────────────────
console.log('\n=== 1. 能量结算 ===');
{
  const cfg = { max: 100, recoverPerHour: 10 };
  const a = settleEnergy({ energy: 50, energyAt: now0 - 2 * H }, now0, cfg);
  check(Math.round(a.energy) === 70, `2 小时恢复 20（${Math.round(a.energy)}）`);
  check(a.energyAt === now0, '结算时间前移');

  const b = settleEnergy({ energy: 95, energyAt: now0 - 10 * H }, now0, cfg);
  check(b.energy === 100, '不会超过上限');

  const first = settleEnergy({ energy: 100, energyAt: 0 }, now0, cfg);
  check(first.energy === 100, '首次运行不会补出天文数字（以当前值为准）');

  const low = settleEnergy({ energy: 0, energyAt: now0 - 1 * H }, now0, cfg);
  check(Math.round(low.energy) === 10, '从 0 恢复');
}

// ── 2. 跨天清零 ─────────────────────────────────────────────────────────
console.log('\n=== 2. 跨天清零 ===');
{
  const tick = { today: '2026-10-24', todayProactive: 3, todayDecisions: 5, todayReflections: 2, energy: 42, lastReflectAt: 123 };
  const same = resetDaily(tick, '2026-10-24');
  check(same.todayProactive === 3 && same.todayDecisions === 5, '同一天不清零');

  const next = resetDaily(tick, '2026-10-25');
  check(next.todayProactive === 0 && next.todayDecisions === 0 && next.todayReflections === 0, '新的一天清零计数');
  check(next.energy === 42 && next.lastReflectAt === 123, '能量与反思时间跨天保留');
}

// ── 3. 廉价预判 ─────────────────────────────────────────────────────────
console.log('\n=== 3. 廉价预判（决定要不要调模型）===');
{
  const cfg = { reflectAfterEvents: 8, tick: { proactiveIdleMs: 6 * H, openLoopDueMs: 24 * H }, energy: { floor: 10 } };

  const none = collectCandidates({ now: now0, energy: 80, lastInteractionAt: now0 - 1 * H, lastEventAt: now0 - 30 * 60000, openLoops: [], unreflected: 0, cfg });
  check(none.length === 0, '刚聊过、且已经记过 → 没有候选');

  // 刚聊过但还没记：这是刻意存在的候选（"要不要记一笔"的分叉）
  const unprocessed = collectCandidates({ now: now0, energy: 80, lastInteractionAt: now0 - 1 * H, lastEventAt: 0, openLoops: [], unreflected: 0, cfg });
  check(unprocessed.some((c) => c.id === 'unprocessed'), '刚聊过但没记 → 出现 unprocessed 候选');

  const miss = collectCandidates({ now: now0, energy: 80, lastInteractionAt: now0 - 7 * H, openLoops: [], unreflected: 0, cfg });
  check(miss.some((c) => c.id === 'miss_you'), '久未联系 → 想她了');

  const loop = collectCandidates({ now: now0, energy: 80, lastInteractionAt: now0 - H, openLoops: [{ text: '问他工作', since: now0 - 30 * H }], unreflected: 0, cfg });
  check(loop.some((c) => c.id === 'open_loop' && c.text.includes('问他工作')), '有拖了很久没问的事');

  const fresh = collectCandidates({ now: now0, energy: 80, lastInteractionAt: now0 - H, openLoops: [{ text: '刚记的', since: now0 - H }], unreflected: 0, cfg });
  check(!fresh.some((c) => c.id === 'open_loop'), '刚记下的事不算"拖太久"');

  const pending = collectCandidates({ now: now0, energy: 80, lastInteractionAt: now0 - H, openLoops: [], unreflected: 9, cfg });
  check(pending.some((c) => c.id === 'reflect_pending'), '攒够未反思事件');

  const tired = collectCandidates({ now: now0, energy: 5, lastInteractionAt: now0 - 7 * H, openLoops: [{ text: 'x', since: now0 - 30 * H }], unreflected: 9, cfg });
  check(tired.length === 0, '体力低于下限 → 什么都不想');
}

// ── 6. 抖动与动作可用性 ─────────────────────────────────────────────────
console.log('\n=== 6. 抖动与动作可用性 ===');
{
  const lo = nextTickAt(now0, 300000, 0.1, () => 0);
  const hi = nextTickAt(now0, 300000, 0.1, () => 1);
  check(lo === now0 + 270000, `下界 -10%（${lo - now0}）`);
  check(hi === now0 + 330000, `上界 +10%（${hi - now0}）`);
  check(nextTickAt(now0, 300000, 0, () => 0.5) === now0 + 300000, '无抖动时等于间隔');

  const rich = availableActions({ energy: 100, todayProactive: 0, maxProactive: 6, minProactiveGapMs: 0, lastProactiveAt: 0, unreflected: 5 });
  check(rich.map((a) => a.id).join(',') === 'send_proactive,organize,recall,remember,idle', `体力充足时四个都可选（${rich.map((a) => a.id).join(',')}）`);

  const poor = availableActions({ energy: 6, todayProactive: 0, maxProactive: 6, minProactiveGapMs: 0, lastProactiveAt: 0, unreflected: 5 });
  check(poor.map((a) => a.id).join(',') === 'recall,remember,idle', `体力低时只留轻量动作（${poor.map((a) => a.id).join(',')}）`);

  const capped = availableActions({ energy: 100, todayProactive: 6, maxProactive: 6, minProactiveGapMs: 0, lastProactiveAt: 0, unreflected: 5 });
  check(!capped.some((a) => a.id === 'send_proactive'), '今日主动次数用完 → 菜单里不出现');

  const gap = availableActions({ energy: 100, todayProactive: 0, maxProactive: 6, minProactiveGapMs: 3600000, lastProactiveAt: now0 - 60000, unreflected: 5, now: now0 });
  check(!gap.some((a) => a.id === 'send_proactive'), '刚主动过 → 菜单里不出现');

  // 整理必须走反思冷却，否则她会每隔几分钟"整理一次"、反复烧体力和决策额度
  const orgCooldown = availableActions({
    energy: 100, unreflected: 9, now: now0,
    lastReflectAttemptAt: now0 - 60000, reflectCooldownMs: 7200000
  });
  check(!orgCooldown.some((a) => a.id === 'organize'), '刚整理过 → 整理不在菜单里');
  const orgReady = availableActions({
    energy: 100, unreflected: 9, now: now0,
    lastReflectAttemptAt: now0 - 3 * H, reflectCooldownMs: 7200000
  });
  check(orgReady.some((a) => a.id === 'organize'), '冷却过后整理重新可用');

  check(actionBlocked(getAction('idle'), { energy: 0 }) === null, 'idle 永远可用');
}

// ── 7. 心跳日志：连续相同的"跳过"合并成一条 ───────────────────────────
console.log('\n=== 7. 心跳日志的取舍 ===');
{
  updateConfig({ api: { model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1' }, mind: { enabled: true, tick: { enabled: true } } });


  // 暂停状态连续两次 → 合并成一条（跳过原因为 paused，判定在作息之前，稳定可测）
  {
    const mind = new MindStore({ root: fs.mkdtempSync(path.join(dataDir, 'log2-')), getOptions: () => ({}) });
    const store = { listChats: () => ['private:456'], unreadCount: () => 0, getChatMeta: () => ({ lastTs: 0 }), recent: () => [] };
    const orch = new Orchestrator({ store, memory: {}, stickers: {}, sender: {}, sessions: {}, onebot: {}, mind });
    orch.paused = true;
    orch.aborted = false;
    await orch.tickOnce({ now: now0 });
    await orch.tickOnce({ now: now0 + 60000 });
    check(orch.recentTicks.length === 1, '连续相同的"跳过"合并为一条');
    check(orch.recentTicks[0].skipped === 'paused', '保留原因');
    check(orch.recentTicks[0].at === now0 + 60000, '时间更新到最近一次');
  }
}

// ── 8. 行动注册表完整性 ─────────────────────────────────────────────────
console.log('\n=== 8. 行动注册表 ===');
{
  const ids = ACTIONS.map((a) => a.id);
  check(ids.join(',') === 'send_proactive,organize,recall,remember,stay_up,idle', `内置动作齐全且顺序固定（${ids.join(',')}）`);
  check(ACTIONS.every((a) => a.label && !/扮演|角色扮演|人设/.test(a.label + (a.description || ''))), '动作文案不含扮演类词汇');
  check(ACTIONS.every((a) => typeof a.run === 'function'), '每个动作都有 run');
}

console.log(`\n心智心跳：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
