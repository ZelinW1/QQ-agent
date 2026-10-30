// 自由时刻（C 期主干）自测：唤醒时钟、门禁、工具投影、moment、嵌套预算。
//
// 与 mind-global-tick-test 的分工：那套测"她做了什么"；这套测**骨架**——
// 什么时候醒、凭什么醒、每次醒留下了什么记录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { MindStore } = await import(src('src/mind/store.js'));
const { Orchestrator } = await import(src('src/orchestrator.js'));
const { updateConfig } = await import(src('src/config.js'));

const H = 3600000;
const NOW = Date.now();

updateConfig({
  api: { model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1' },
  mind: { enabled: true, tick: { enabled: true }, wake: { impulseMeanHours: 4, tooSoonMs: 300000 } }
});

const mk = ({ chats = ['private:111'], lastTs = NOW - 3 * H, unread = 0 } = {}) => {
  const mind = new MindStore({ root: fs.mkdtempSync(path.join(dataDir, 'g-')), getOptions: () => ({}) });
  const store = {
    listChats: () => chats,
    getChatMeta: () => ({ lastTs, unread, lastText: '在吗' }),
    recent: () => []
  };
  const orch = new Orchestrator({ store, memory: {}, stickers: {}, sender: {}, sessions: {}, onebot: {}, mind });
  orch.paused = false;
  orch.aborted = false;
  return { orch, mind };
};

const idleChat = async () => ({ message: { content: '今天不想说话' }, usage: { total_tokens: 42 } });

// ── 1. 唤醒时钟落盘 ─────────────────────────────────────────────────────
console.log('\n=== 1. 唤醒时钟 ===');
{
  const { orch, mind } = mk();
  await orch.tickOnce({ now: NOW, chat: idleChat });
  const tick = mind.getTick();
  check(Number(tick.impulseAt) > NOW, `醒来后重抽了冲动时刻（+${Math.round((tick.impulseAt - NOW) / 60000)} 分钟）`);
  check(Number(tick.lastFreeWakeAt) === NOW, '记下这次醒来的时间');

  const r2 = await orch.tickOnce({ now: NOW + 60000, chat: idleChat });
  check(r2.skipped === 'too-soon', `刚醒过不重复醒（${r2.skipped}）`);

  const r3 = await orch.tickOnce({ now: NOW + 6 * 60000, chat: idleChat });
  check(r3.skipped === 'not-due' || r3.skipped === '', `过了最小间隔但仍未到唤醒点（${r3.skipped || '已醒'}）`);
}

// ── 2. 到期意图能提前叫醒 ───────────────────────────────────────────────
console.log('\n=== 2. 意图叫醒 ===');
{
  const { orch, mind } = mk();
  await orch.tickOnce({ now: NOW, chat: idleChat });   // 先让它有一次冲动
  mind.updateTick({ impulseAt: NOW + 5 * H });         // 把冲动推远
  mind.addIntention({ text: '问问他搬家的事', dueAt: NOW + 10 * 60000, chatKey: 'private:111' });

  const r = await orch.tickOnce({ now: NOW + 11 * 60000, chat: idleChat });
  check(r.skipped === '', '意图到点 → 即使冲动没到也会醒');
}

// ── 3. 门禁 ─────────────────────────────────────────────────────────────
console.log('\n=== 3. 门禁 ===');
{
  const { orch } = mk();
  orch.runningChats.add('private:111');
  orch.tickOnce = orch.tickOnce.bind(orch);
  const r = await orch.tickOnce({ now: NOW, chat: idleChat });
  check(r.skipped === 'chat-running', `正在聊天时让位（${r.skipped}）`);

  const { orch: o2 } = mk();
  o2.pendingWake.add('private:111');
  const r2 = await o2.tickOnce({ now: NOW, chat: idleChat });
  check(r2.skipped === 'chat-pending', `马上要回消息时让位（${r2.skipped}）`);

  const { orch: o3, mind: m3 } = mk();
  m3.updateTick({ energy: 5 });
  const r3 = await o3.tickOnce({ now: NOW, chat: idleChat });
  check(r3.skipped === 'tired', `体力不足不醒（${r3.skipped}）`);

  const { orch: o4, mind: m4 } = mk();
  const { todayKey } = await import(src('src/util.js'));
  m4.updateTick({ today: todayKey(), todayDecisions: 999 });
  const r4 = await o4.tickOnce({ now: NOW, chat: idleChat });
  check(r4.skipped === 'decision-cap', `决策次数用完不醒（${r4.skipped}）`);
}

// ── 4. Moment 与 attempts 记账 ──────────────────────────────────────────
console.log('\n=== 4. 记账 ===');
{
  const { orch, mind } = mk();
  let calls = 0;
  const chat = async () => {
    calls += 1;
    return {
      message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'remember', arguments: '{"text":"他说明天来"}' } }] },
      usage: { total_tokens: 120 }
    };
  };
  const replies = [chat, async () => ({ message: { content: '好了' } })];
  const r = await orch.tickOnce({ now: NOW, chat: async (m, t) => replies.shift()(m, t) });
  check(calls >= 1 && r.skipped === '', '正常跑完一次');

  const moments = mind.listMoments({ limit: 5 });
  check(moments.length === 1, '落了一条 moment');
  const mo = moments[0];
  check(mo.runtime === 'free', 'runtime 标为 free');
  check(mo.usage.self.tokens >= 120, `用量记下（${mo.usage.self.tokens}）`);
  check(typeof mo.configDigest === 'string' && mo.configDigest.length > 0, '带配置摘要（能分清"她变了"还是"配置变了"）');
  check((mo.attempts || []).length >= 1, 'moment 关联到 attempt');

  const attempts = mind.listAttempts({ limit: 5 });
  check(attempts.every((a) => a.momentId === mo.id), 'attempt 带同一个 momentId');
}

// ── 5. 只读工具在自由时刻可用 ───────────────────────────────────────────
console.log('\n=== 5. 只读工具 ===');
{
  const { buildToolDefs } = await import(src('src/tools.js'));
  buildToolDefs();
  const { orch, mind } = mk();
  let sawTools = null;
  const replies = [
    async (msgs, tools) => {
      sawTools = tools;
      return { message: { tool_calls: [{ id: 'r1', type: 'function', function: { name: 'get_recent_messages', arguments: '{"limit":2}' } }] } };
    },
    async () => ({ message: { content: '看过了' } })
  ];
  const r = await orch.tickOnce({ now: NOW, chat: async (m, t) => replies.shift()(m, t) });
  const names = (sawTools || []).map((t) => t.function?.name || '');
  check(names.includes('get_recent_messages'), '自由时刻能看见只读工具（不只是动作）');
  check(names.includes('finish'), 'finish 始终在');
  check(!names.includes('send_message'), '聊天专用工具不会混进自由时刻');
  check(names.includes('web_search'), 'web_search 不会被前 4 个工具挤掉（不再写死上限）');
  check(!names.includes('memory_query'), 'memory_query 不会绕过 hideWithMind 混进自由时刻');
  check(r.skipped === '', '只读工具执行不会让这一轮失败');
  const toolAttempt = mind.listAttempts({ limit: 5 }).find((a) => a.kind === 'read');
  check(Boolean(toolAttempt), '只读工具调用也落账（kind=read）');
  check(toolAttempt.chatKey === 'private:111', '只读工具也拿到了会话目标（以前是空串）');
}

// ── 6. 嵌套预算：子运行的用量算进父 moment ──────────────────────────────
console.log('\n=== 6. 嵌套 ===');
{
  const { orch, mind } = mk();
  orch.wake = async () => ({ ok: true, sent: ['在的'], usage: { totalTokens: 500 }, momentId: 'mo_child_1' });
  const replies = [
    async () => ({ message: { tool_calls: [{ id: 's1', type: 'function', function: { name: 'send_proactive', arguments: '{"chatKey":"private:111","reason":"想问问"}' } }] }, usage: { total_tokens: 80 } }),
    async () => ({ message: { content: '好了' } })
  ];
  await orch.tickOnce({ now: NOW, chat: async (m, t) => replies.shift()(m, t) });
  const mo = mind.listMoments({ limit: 1 })[0];
  check(mo.usage.subtree.tokens === 500, `子运行（聊天）的用量计入 subtree（${mo.usage.subtree.tokens}）`);
  check(mo.usage.self.tokens > 0 && mo.usage.self.tokens < mo.usage.subtree.tokens, '父/子用量分开记');
  check(mo.actions.includes('send_proactive'), '动作记在 moment 上');
  check((mo.childMomentIds || []).includes('mo_child_1'), '父 moment 记得住子时刻');
}

// ── 7. 内部动作的效用信号（整理 → 欠账变少）─────────────────────────────
console.log('\n=== 7. 效用信号 ===');
{
  const { orch, mind } = mk();
  // 攒够"该整理"的门槛（默认 reflectAfterEvents=8）
  for (let i = 0; i < 8; i++) {
    mind.appendEvent({ chatKey: 'private:111', actorId: '111', actorName: '王哥', text: `第 ${i} 件事`, ts: NOW - (20 - i) * 60000 });
  }
  const before = mind.getTick().lastReflectAt || 0;
  const replies = [
    async () => ({ message: { tool_calls: [{ id: 'o1', type: 'function', function: { name: 'organize', arguments: '{"reason":"该整理了"}' } }] } }),
    // organize 内部的反思调用（chat 注入）
    async () => ({ message: { content: '{"relations":[]}' }, usage: { total_tokens: 60 } }),
    async () => ({ message: { content: '整理完了' } })
  ];
  await orch.tickOnce({ now: NOW, chat: async (m, tl) => replies.shift()(m, tl) });

  const stat = mind.getTick().actionStats.organize;
  check(Boolean(stat), '整理动作有了节律统计');
  check(stat.ok >= 1, '这次整理记为有用（欠账变少）');
  check((mind.getTick().lastReflectAt || 0) > before, '反思窗口确实前移');
  const obs = mind.listObservations({ limit: 10 }).find((o) => o.action === 'organize');
  check(Boolean(obs), '整理也落了一条观测');
  check(obs.kind === 'utility', '整理用效用信号，不挂回声窗口');
  check(obs.verdict === 'hit', '观测当场判为有用（不需要等谁回话）');
}
console.log(`\n自由时刻骨架：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
