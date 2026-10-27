// 心跳与行动自测（PR5）。
//
// 两段：
//   纯逻辑 —— 能量结算、候选预判、决策提示词与解析、动作可用性
//   一轮心跳 —— 用真实 Orchestrator 实例 + 假 store + 注入的决策模型，
//               验证"多数时候什么都不做、真的要做时才花钱"
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
  settleEnergy, resetDaily, collectCandidates, buildDecisionPrompt,
  parseDecision, nextTickAt, actionBlocked
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

// ── 4. 决策提示词 ───────────────────────────────────────────────────────
console.log('\n=== 4. 决策提示词（system 必须稳定）===');
{
  const actions = availableActions({ energy: 100, todayProactive: 0, maxProactive: 6, minProactiveGapMs: 0, lastProactiveAt: 0, unreflected: 5 });
  const m1 = buildDecisionPrompt({ botName: '小鲸鱼', state: { energy: 80, todayProactive: 1, lastInteractionAt: now0 - 7 * H }, candidates: [{ id: 'miss_you', text: '已经 7 小时没联系了' }], actions, now: now0 });
  const m2 = buildDecisionPrompt({ botName: '小鲸鱼', state: { energy: 20, todayProactive: 4, lastInteractionAt: now0 - 2 * H }, candidates: [], actions, now: now0 + 1000 });

  check(m1[0].role === 'system' && m2[0].role === 'system', '都是 system+user 两条');
  check(m1[0].content === m2[0].content, 'system 与状态无关（可被前缀缓存）');
  check(m1[1].content !== m2[1].content, 'user 随状态变化');
  check(m1[0].content.includes('优先什么都不做'), '写明优先不行动');
  check(m1[0].content.includes('send_proactive'), '列出动作 id');
  check(m1[1].content.includes('已经 7 小时没联系了'), '带上候选理由');
  check(m1[1].content.includes('体力：80'), '带上体力');
}

// ── 5. 决策解析 ─────────────────────────────────────────────────────────
console.log('\n=== 5. 决策解析 ===');
{
  const allowed = ['send_proactive', 'organize', 'recall', 'idle'];
  const ok = parseDecision('{"action":"recall","args":{},"reason":"想翻翻旧事"}', allowed);
  check(ok && ok.action === 'recall' && ok.reason === '想翻翻旧事', '正常解析');

  const fenced = parseDecision('```json\n{"action":"idle","reason":"没什么事"}\n```', allowed);
  check(fenced && fenced.action === 'idle', '代码块包裹也能解析');

  const embedded = parseDecision('我想了想 {"action":"idle"} 就这样', allowed);
  check(embedded && embedded.action === 'idle', '夹在文字里也能抠出来');

  check(parseDecision('{"action":"delete_everything"}', allowed) === null, '不在菜单里的动作 → null');
  check(parseDecision('算了不做了', allowed) === null, '纯文本 → null');
  check(parseDecision('', allowed) === null, '空输出 → null');
  check(parseDecision('{"action":"idle"', allowed) === null, '半截 JSON → null');
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

// ── 7. 一轮心跳（真实编排器 + 假 store + 注入决策）──────────────────────
console.log('\n=== 7. 一轮心跳 ===');
{
  updateConfig({
    api: { model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1' },
    // 本套测的是旧的 per-chat 心跳路径；全局路径由 mind-global-tick-test 覆盖
    mind: { enabled: true, tick: { enabled: true, mode: 'per-chat' }, reflectAfterEvents: 3, energy: { floor: 10 } }
  });

  const mkOrch = ({ lastTs, unread = 0, running = false } = {}) => {
    const mind = new MindStore({ root: fs.mkdtempSync(path.join(dataDir, 'tick-')), getOptions: () => ({}) });
    const store = {
      listChats: () => ['private:456'],
      unreadCount: () => unread,
      getChatMeta: () => ({ lastTs }),
      recent: () => []
    };
    const orch = new Orchestrator({ store, memory: {}, stickers: {}, sender: {}, sessions: {}, onebot: {}, mind });
    orch.paused = false;
    orch.aborted = false;
    if (running) orch.runningChats.add('private:456');
    return { orch, mind };
  };

  // 7a. 心智关闭 → 什么都不做
  {
    updateConfig({ mind: { enabled: false } });
    const { orch } = mkOrch({ lastTs: now0 - 7 * H });
    let called = false;
    const r = await orch.tickOnce({ now: now0, chat: async () => { called = true; return { message: { content: '{}' } }; } });
    check(r.skipped === 'disabled' && !called, '心智关闭时不跑心跳');
    updateConfig({ mind: { enabled: true } });
  }

  // 7b. 没有候选 → 不调模型
  //（"刚聊过但没记"本身是候选，所以这里先记一条事件，模拟已经记过）
  {
    const { orch, mind } = mkOrch({ lastTs: now0 - 1 * H });
    mind.appendEvent({ chatKey: 'private:456', text: '刚聊过的事，已经记下了', ts: now0 - 30 * 60000 });
    let called = false;
    const r = await orch.tickOnce({ now: now0, chat: async () => { called = true; return { message: { content: '{}' } }; } });
    check(!called, '没有候选时不调模型（0 token）');
    check(r.results.some((x) => x.action === 'idle' && x.reason === 'no-candidate'), '记为 idle/no-candidate');
  }

  // 7c. 有未读 → 让位给应答管线
  {
    const { orch } = mkOrch({ lastTs: now0 - 7 * H, unread: 2 });
    let called = false;
    await orch.tickOnce({ now: now0, chat: async () => { called = true; return { message: { content: '{}' } }; } });
    check(!called, '有未读时心跳不抢答');
  }

  // 7d. 正在跑 → 跳过
  {
    const { orch } = mkOrch({ lastTs: now0 - 7 * H, running: true });
    let called = false;
    await orch.tickOnce({ now: now0, chat: async () => { called = true; return { message: { content: '{}' } }; } });
    check(!called, '同会话正在运行时跳过');
  }

  // 7e. 决策 idle → 记账但不耗体力
  {
    const { orch, mind } = mkOrch({ lastTs: now0 - 7 * H });
    const before = mind.getTick().energy;
    const r = await orch.tickOnce({ now: now0, chat: async () => ({ message: { content: '{"action":"idle","reason":"没什么事"}' } }) });
    check(r.results.some((x) => x.action === 'idle' && x.reason === 'chose-idle'), '她选择什么都不做');
    const tick = mind.getTick();
    check(Math.round(tick.energy) === Math.round(before), 'idle 不耗体力');
    check((tick.todayDecisions || 0) === 1, '决策次数已记账');
    check(mind.listActions({ limit: 5 }).length === 1, '写了一条行动日志');
  }

  // 7e-2. 决定不做之后，同一个候选要打盹（否则每 5 分钟重新叫她一次）
  {
    const { orch, mind } = mkOrch({ lastTs: now0 - 7 * H });
    let calls = 0;
    const chat = async () => { calls++; return { message: { content: '{"action":"idle","reason":"算了"}' } }; };
    await orch.tickOnce({ now: now0, chat });
    check(calls === 1, '第一次：调了决策模型');
    const snoozes = mind.getTick().snoozes || {};
    check(Object.keys(snoozes).some((k) => k === 'private:456|miss_you'), '给候选记了打盹');

    // 用 10 分钟后再来：nextTickAt 有 ±10% 抖动（最长 5.5 分钟），
    // 5 分钟时可能还没到"下一次心跳"，测不到打盹逻辑。
    const r2 = await orch.tickOnce({ now: now0 + 10 * 60000, chat });
    check(calls === 1, '五分钟后再来：候选还在打盹，不再调模型');
    check(r2.results.some((x) => x.action === 'idle' && x.reason === 'no-candidate'), '记为 no-candidate');
  }

  // 7f. 决策 recall → 执行、耗体力
  {
    const { orch, mind } = mkOrch({ lastTs: now0 - 7 * H });
    mind.appendEvent({ chatKey: 'private:456', actorId: '456', actorName: '小王', text: '很久以前他说过想学吉他', ts: now0 - 30 * 86400000, salience: 0.8 });
    const before = mind.getTick().energy;
    const r = await orch.tickOnce({ now: now0, chat: async () => ({ message: { content: '{"action":"recall","reason":"想翻翻旧事"}' } }) });
    check(r.results.some((x) => x.action === 'recall'), '执行了回想');
    const tick = mind.getTick();
    check(Math.round(tick.energy) === Math.round(before) - 5, `消耗 5 体力（剩 ${Math.round(tick.energy)}）`);
    const events = mind.queryEvents({ chatKey: 'private:456' });
    check(events.some((e) => String(e.text).startsWith('我忽然想起')), '回想写成了一条新事件');
    // 回想不改变现场（旧事还在），所以做完要给候选打盹，否则会十分钟一次
    const sn = mind.getTick().snoozes || {};
    check(Object.values(sn).some((v) => Number(v) > now0), '回想后给候选打了盹');
  }

  // 7g. 决策 send_proactive → 走正常 proactive 管线
  {
    const { orch, mind } = mkOrch({ lastTs: now0 - 7 * H });
    let woke = null;
    orch.wake = async (chatKey, opts) => { woke = { chatKey, opts }; return null; };
    const before = mind.getTick().energy;
    const r = await orch.tickOnce({ now: now0, chat: async () => ({ message: { content: '{"action":"send_proactive","reason":"有点想她"}' } }) });
    check(woke && woke.chatKey === 'private:456' && woke.opts?.proactive === true, '通过 normal wake 发起主动会话');
    const tick = mind.getTick();
    check(Math.round(tick.energy) === Math.round(before) - 25, '消耗 25 体力');
    check((tick.todayProactive || 0) === 1, '今日主动次数 +1');
    check(orch.lastProactiveAt.get('private:456') === now0, '记录了最近主动时间');
    check(r.results.some((x) => x.action === 'send_proactive'), '结果里报告了动作');
  }

  // 7h. 无法解析 → 按不行动处理，但仍记账
  {
    const { orch, mind } = mkOrch({ lastTs: now0 - 7 * H });
    const r = await orch.tickOnce({ now: now0, chat: async () => ({ message: { content: '我想了想，算了' } }) });
    check(r.results.some((x) => x.action === 'idle' && x.reason === 'unparsable'), '解析失败按 idle 处理');
    check((mind.getTick().todayDecisions || 0) === 1, '决策次数仍记账（钱已经花了）');
  }

  // 7i. 决策次数熔断 → 连模型都不调
  {
    const { orch, mind } = mkOrch({ lastTs: now0 - 7 * H });
    mind.updateTick({ today: todayKey(now0), todayDecisions: 999 });
    let called = false;
    const r = await orch.tickOnce({ now: now0, chat: async () => { called = true; return { message: { content: '{"action":"idle"}' } }; } });
    check(!called, '熔断后不再调模型');
    check(r.results.some((x) => x.action === 'idle' && x.reason === 'decision-cap'), '原因是触到当日决策上限');
  }
}

// ── 7j. 心跳日志：空扫描不记，连续相同状态合并 ─────────────────────────
console.log('\n=== 7j. 心跳日志的取舍 ===');
{
  updateConfig({ api: { model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1' }, mind: { enabled: true, tick: { enabled: true } } });

  // 没有任何会话 → 这一轮什么也没发生，不该记
  {
    const mind = new MindStore({ root: fs.mkdtempSync(path.join(dataDir, 'log-')), getOptions: () => ({}) });
    const store = { listChats: () => [], unreadCount: () => 0, getChatMeta: () => ({ lastTs: 0 }), recent: () => [] };
    const orch = new Orchestrator({ store, memory: {}, stickers: {}, sender: {}, sessions: {}, onebot: {}, mind });
    orch.paused = false; orch.aborted = false;
    await orch.tickOnce({ now: now0, chat: async () => ({ message: { content: '{}' } }) });
    check(orch.recentTicks.length === 0, '空扫描（没有到期会话）不记日志');
  }

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
