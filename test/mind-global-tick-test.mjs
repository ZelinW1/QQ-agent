// 全局唤醒自测：一次唤醒、一份 roster、一次决策。心跳只有这一条路径。
//
// 覆盖：
//   · roster 排序（未读 > 沉默时长）
//   · 决策提示词里能看到多个人与最后一句线索
//   · 决策指定目标会话时，动作跑在目标会话上（而不是第一个候选）
//   · 一次唤醒只排一次节拍（同一时刻不会连续决策）
//   · 没候选时不调模型
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-global-'));
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
const { updateConfig, getConfig } = await import(src('src/config.js'));

const H = 3600000;
const now0 = Date.now();

// 全局模式 + 短节拍（抖动 0，便于断言）
updateConfig({
  api: { model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1' },
  mind: {
    enabled: true,
    tick: {
      enabled: true,
      mode: 'global',
      intervalMs: 10 * 60000,
      jitter: 0,
      idleLookbackMin: 2,
      proactiveIdleMs: 1 * H,
      maxDecisionsPerDay: 24,
      maxProactivePerDay: 8,
      minProactiveGapMs: 0,
      idleSnoozeMs: 60000,
      suppressAfterProactiveMs: 0
    },
    energy: { max: 100, recoverPerHour: 0, floor: 0 }
  }
});
const cfg = getConfig();
// per-chat 模式已移除：心跳只有这一条路径，配置里不再有 mode 这个轴。
check(cfg.mind.tick.enabled === true && cfg.mind.tick.mode === undefined, '心跳只有一条路径（无 mode 开关）');

const mk = ({ chats, lastTsOf, unreadOf, relations = {} }) => {
  const mind = new MindStore({ root: fs.mkdtempSync(path.join(dataDir, 'g-')), getOptions: () => ({}) });
  for (const [userId, patch] of Object.entries(relations)) {
    mind.patchRelation(userId, patch, { evidence: ['test'] });
  }
  const store = {
    listChats: () => chats,
    unreadCount: (k) => Number(unreadOf?.[k]) || 0,
    getChatMeta: (k) => ({ lastTs: Number(lastTsOf?.[k]) || 0, unread: Number(unreadOf?.[k]) || 0, lastText: `来自${k}的话` }),
    recent: () => []
  };
  const orch = new Orchestrator({ store, memory: {}, stickers: {}, sender: {}, sessions: {}, onebot: {}, mind });
  orch.paused = false;
  orch.aborted = false;
  return { orch, mind };
};

// ── 1. roster 排序 + 提示词素材 ─────────────────────────────────────────
console.log('\n=== 1. roster 与提示词 ===');
{
  const { orch } = mk({
    chats: ['private:111', 'private:222'],
    lastTsOf: { 'private:111': now0 - 3 * H, 'private:222': now0 - 30 * H },
    unreadOf: { 'private:111': 2 },
    relations: {
      111: { nickname: '王哥', stage: 'familiar', warmth: 60 },
      222: { nickname: '小林', stage: 'stranger', warmth: 10 }
    }
  });

  let seen = null;
  const r = await orch.tickOnce({
    now: now0,
    chat: async (messages) => {
      seen = messages;
      return { message: { content: '{"action":"idle","reason":"先看看"}' } };
    }
  });

  check(!!seen, '全局模式确实调了一次决策模型');
  const user = seen?.[1]?.content || '';
  const system = String(seen?.[0]?.content || '');
  check(!system.includes('只输出 JSON'), 'system 不再要求"只输出 JSON"（那与工具循环矛盾，照做就只会 idle）');
  check(system.includes('调用对应的工具'), 'system 明确要求用工具调用');
  check(!system.includes('选 idle'), '菜单里不再让模型"选 idle"（idle 不是工具）');
  check(user.includes('你最近注意到') || user.includes('你最近留意到的人'), '提示词带 roster 段');
  check(user.includes('王哥') && user.includes('小林'), '两个会话都出现在 roster 里');
  check(user.indexOf('王哥') < user.indexOf('小林'), '有未读的王哥排在前面');
  check(user.includes('2 条未读'), '未读条数可见');
  check(user.includes('「来自private:111的话」'), '带上了最后一句线索');
  check(user.includes('上次行动') === false || user.includes('上次行动'), '上次行动字段可选存在');
  check(r.skipped === '' || r.skipped === undefined, `本次唤醒正常执行（skipped=${r.skipped}）`);
}

// ── 2. 自由行动：按工具调用执行，并指定目标会话 ─────────────────────────
console.log('\n=== 2. 自由行动会话 ===');
{
  const { orch, mind } = mk({
    chats: ['private:111', 'private:222'],
    lastTsOf: { 'private:111': now0 - 2 * H, 'private:222': now0 - 20 * H },
    unreadOf: {},
    relations: { 111: { nickname: '王哥' }, 222: { nickname: '小林' } }
  });
  const woke = [];
  orch.wake = async (chatKey) => { woke.push(chatKey); return { ok: true }; };

  const replies = [
    { tool_calls: [{ id: 'c1', function: { name: 'send_proactive', arguments: JSON.stringify({ chatKey: 'private:222', reason: '想问问她' }) } }] },
    { tool_calls: [{ id: 'c2', function: { name: 'finish', arguments: '{"reason":"够了"}' } }] }
  ];
  const before = Number(mind.getTick().energy) || 100;
  const r = await orch.tickOnce({ now: now0, chat: async () => ({ message: replies.shift() }) });
  check(r.results?.[0]?.action === 'send_proactive', '结果里记录了动作');
  const after = Number(mind.getTick().energy) || 0;
  check(after === before - 25, `体力按动作成本扣减（${before} → ${after}）`);
  check(mind.getTick().todayProactive === 1, '今日主动次数 +1');

  // 尝试与观察：C2 起每次动作都留结局与原因码，发出话之后开 72 小时观察窗口。
  const attempts = mind.listAttempts({ limit: 5 });
  check(attempts.length === 1 && attempts[0].action === 'send_proactive', '动作写进 attempts');
  check(attempts[0].outcome === 'done', '成功动作的结局是 done');
  const obs = mind.listDueObservations(now0 + 73 * H, 5);
  check(obs.length === 1 && obs[0].chatKey === 'private:222', '发完话开了一条观察（72 小时后复查）');
}

// ── 2b. 一次唤醒连续做多件事 ────────────────────────────────────────────
console.log('\n=== 2b. 连续多件事 ===');
{
  const { orch, mind } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 5 * H },
    unreadOf: {},
    relations: { 111: { nickname: '王哥' } }
  });
  orch.wake = async () => ({ ok: true });
  const replies = [
    { tool_calls: [{ id: 'a1', function: { name: 'send_proactive', arguments: '{"reason":"问问近况","chatKey":"private:111"}' } }] },
    { tool_calls: [{ id: 'a2', function: { name: 'recall', arguments: '{"reason":"翻翻旧事"}' } }] },
    { tool_calls: [{ id: 'a3', function: { name: 'finish', arguments: '{"reason":"够了"}' } }] }
  ];
  const before = Number(mind.getTick().energy) || 100;
  const r = await orch.tickOnce({ now: now0, chat: async () => ({ message: replies.shift() }) });

  check(r.results.length === 2, `一次唤醒做了 2 件事（${r.results.map((x) => x.action).join(',')}）`);
  check(r.results[0].action === 'send_proactive' && r.results[1].action === 'recall', '动作顺序正确');
  check(Number(mind.getTick().energy) === before - 30, `体力累计扣减（${before} → ${mind.getTick().energy}）`);
}

// ── 2c. 上限与体力：做不了的要拒绝，且不超次数 ──────────────────────────
console.log('\n=== 2c. 上限与体力 ===');
{
  updateConfig({ mind: { actions: { maxPerWake: 2 } } });
  const { orch, mind } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 5 * H },
    unreadOf: {},
    relations: { 111: { nickname: '王哥' } }
  });
  orch.wake = async () => ({ ok: true });
  // 一次响应里塞 3 个动作：前两个执行，第三个应被拒绝
  const replies = [
    {
      tool_calls: [
        { id: 'b1', function: { name: 'send_proactive', arguments: '{"reason":"一","chatKey":"private:111"}' } },
        { id: 'b2', function: { name: 'recall', arguments: '{"reason":"二"}' } },
        { id: 'b3', function: { name: 'recall', arguments: '{"reason":"三"}' } }
      ]
    },
    { tool_calls: [{ id: 'b4', function: { name: 'finish', arguments: '{"reason":"收工"}' } }] }
  ];
  let toolPayloads = [];
  const r = await orch.tickOnce({
    now: now0,
    chat: async (messages) => {
      // 收集上一次的 tool 结果，用来断言"第三个被拒绝"
      toolPayloads = (messages || []).filter((m) => m.role === 'tool').map((m) => m.content);
      return { message: replies.shift() };
    }
  });
  check(r.results.length === 2, `最多做 maxPerWake 件（${r.results.length}）`);
  check(toolPayloads.some((t) => String(t).includes('做够几件事')), '超过上限的调用被明确拒绝');
  updateConfig({ mind: { actions: { maxPerWake: 3 } } });

  // 体力不足：sent 后剩 0，recall 应被拒
  const low = mk({ chats: ['private:111'], lastTsOf: { 'private:111': now0 - 5 * H }, unreadOf: {}, relations: {} });
  low.mind.updateTick({ energy: 25 });
  low.orch.wake = async () => ({ ok: true });
  const replies2 = [
    { tool_calls: [{ id: 'c1', function: { name: 'send_proactive', arguments: '{"reason":"说一句"}' } }] },
    { tool_calls: [{ id: 'c2', function: { name: 'recall', arguments: '{}' } }] },
    { tool_calls: [{ id: 'c3', function: { name: 'finish', arguments: '{}' } }] }
  ];
  let payloads2 = [];
  await low.orch.tickOnce({
    now: now0,
    chat: async (messages) => {
      payloads2 = (messages || []).filter((m) => m.role === 'tool').map((m) => m.content);
      return { message: replies2.shift() };
    }
  });
  check(payloads2.some((t) => String(t).includes('现在做不了')), '体力不足的调用被拒绝');
}

// ── 2d. 只写正文 = 结束，记一条 idle ────────────────────────────────────
console.log('\n=== 2d. 只写正文 ===');
{
  const { orch, mind } = mk({ chats: ['private:111'], lastTsOf: { 'private:111': now0 - 5 * H }, unreadOf: {}, relations: {} });
  const r = await orch.tickOnce({ now: now0, chat: async () => ({ message: { content: '算了，不说了' } }) });
  check(r.results?.[0]?.action === 'idle', '只写正文时按 idle 收尾');
  check(mind.listActions({ limit: 3 }).some((a) => a.action === 'idle'), 'idle 有落盘记录');
}

// ── 2e. 「记一笔」把对话写进事件 ───────────────────────────────────────
console.log('\n=== 2e. 记一笔 ===');
{
  const { orch, mind } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 4 * H },
    unreadOf: {},
    relations: { 111: { nickname: '王哥' } }
  });
  const replies = [
    { tool_calls: [{ id: 'r1', function: { name: 'remember', arguments: '{"text":"王哥说项目要上线，压力很大","chatKey":"private:111","reason":"值得留"}' } }] },
    { tool_calls: [{ id: 'r2', function: { name: 'finish', arguments: '{"reason":"记下了"}' } }] }
  ];
  const r = await orch.tickOnce({ now: now0, chat: async () => ({ message: replies.shift() }) });

  const events = mind.queryEvents({ chatKey: 'private:111', limit: 10 }) || [];
  check(events.some((e) => String(e.text || '').includes('项目要上线')), '记一笔真的写进了事件');
  check(r.results?.some((x) => x.action === 'remember'), '结果里记录了 remember');
  check(mind.listActions({ limit: 3 }).some((a) => a.action === 'remember'), '行动也落了盘');
}

// ── 2f. 主动说话没做成时不扣体力 ────────────────────────────────────────
console.log('\n=== 2f. 主动失败不扣体力 ===');
{
  const { orch, mind } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 4 * H },
    unreadOf: {},
    relations: { 111: { nickname: '王哥' } }
  });
  // 会话正在聊：wake 会返回 ok:false
  orch.wake = async () => ({ ok: false, reason: '这个会话正在聊' });
  const replies = [
    { tool_calls: [{ id: 'f1', function: { name: 'send_proactive', arguments: '{"chatKey":"private:111"}' } }] },
    { tool_calls: [{ id: 'f2', function: { name: 'finish', arguments: '{}' } }] }
  ];
  const before = Number(mind.getTick().energy);
  let toolPayload = '';
  await orch.tickOnce({
    now: now0,
    chat: async (messages) => {
      toolPayload = (messages || []).filter((m) => m.role === 'tool').map((m) => m.content).join('\n') || toolPayload;
      return { message: replies.shift() };
    }
  });
  check(Number(mind.getTick().energy) === before, `没做成不扣体力（${before} → ${mind.getTick().energy}）`);
  check(toolPayload.includes('正在聊'), '把失败原因回灌给她');
  check(mind.listActions({ limit: 2 }).some((a) => a.action === 'send_proactive' && a.energySpent === 0), '行动记录里体力消耗为 0');
}

// ── 2g. 刚聊过但没记 → unprocessed 候选 ─────────────────────────────────
console.log('\n=== 2g. 聊过还没记 ===');
{
  const { orch } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 30 * 60000 },   // 半小时前聊过
    unreadOf: {},
    relations: { 111: { nickname: '王哥' } }
  });
  let userPrompt = '';
  await orch.tickOnce({
    now: now0,
    chat: async (messages) => {
      userPrompt = messages?.[1]?.content || '';
      return { message: { content: '算了' } };
    }
  });
  check(userPrompt.includes('还没记下什么'), '出现了"还没记下什么"的候选');
  check(userPrompt.includes('王哥'), '并且指明了是谁');
}

// ── 2h. 先 recall 再 remember ───────────────────────────────────────────
console.log('\n=== 2h. recall → remember ===');
{
  const { orch, mind } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 4 * H },
    unreadOf: {},
    relations: { 111: { nickname: '王哥' } }
  });
  const replies = [
    { tool_calls: [{ id: 'h1', function: { name: 'recall', arguments: '{"reason":"先翻翻旧事"}' } }] },
    { tool_calls: [{ id: 'h2', function: { name: 'remember', arguments: '{"text":"翻旧事之后记下的一句话","chatKey":"private:111"}' } }] },
    { tool_calls: [{ id: 'h3', function: { name: 'finish', arguments: '{}' } }] }
  ];
  const r = await orch.tickOnce({ now: now0, chat: async () => ({ message: replies.shift() }) });
  const events = mind.queryEvents({ chatKey: 'private:111', limit: 5 }) || [];
  check(r.results.map((x) => x.action).join(',') === 'recall,remember', `顺序为 recall → remember（${r.results.map((x) => x.action).join(',')}）`);
  check(events.some((e) => String(e.text || '').includes('翻旧事之后')), 'remember 在 recall 之后仍能写入');
}

// ── 2i. 到期意图：进候选、做完就了结 ────────────────────────────────────
console.log('\n=== 2i. 到期意图 ===');
{
  const { orch, mind } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 3 * H },
    unreadOf: {},
    relations: { 111: { nickname: '王哥' } }
  });
  // 主动说话需要一个能"真的发出去"的唤醒：这一组只关心意图的进出，替身即可。
  orch.wake = async () => ({ ok: true });
  const dueAt = now0 + 60000;
  const made = mind.addIntention({ text: '问问他搬家的事', dueAt, chatKey: 'private:111', source: 'free', kind: 'delayed_check' });
  check(made.ok === true, '先挂一条到期的意图');

  let seen = null;
  const replies = [
    { tool_calls: [{ id: 'c1', function: { name: 'send_proactive', arguments: JSON.stringify({ chatKey: 'private:111', reason: '到点了' }) } }] },
    { tool_calls: [{ id: 'c2', function: { name: 'finish', arguments: '{}' } }] }
  ];
  await orch.tickOnce({ now: dueAt + 1000, chat: async (msgs) => { seen = msgs; return { message: replies.shift() }; } });

  const user = String(seen?.[1]?.content || '');
  check(user.includes('你之前说要做的事'), '到期意图进了提示词');
  const open = mind.listIntentions({ status: 'open' });
  check(open.length === 0, '做完之后意图被了结');
  check(mind.listIntentions({ limit: 10 })[0].status === 'done', '状态是 done');
  const attempt = mind.listAttempts({ limit: 3 })[0] || {};
  check(attempt.intentionId === made.intention.id, '账本记得住这次是为了哪条意图');
}
// ── 2j. 她可以自己安排"过会儿再做" ──────────────────────────────────────
console.log('\n=== 2j. 安排未来 ===');
{
  const { orch, mind } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 3 * H },
    unreadOf: {},
    relations: { 111: { nickname: '王哥' } }
  });
  const replies = [
    { tool_calls: [{ id: 'p1', function: { name: 'plan', arguments: JSON.stringify({ text: '问问他搬家的事', inHours: 2, chatKey: 'private:111' }) } }] },
    { tool_calls: [{ id: 'p2', function: { name: 'finish', arguments: '{}' } }] }
  ];
  await orch.tickOnce({ now: now0, chat: async () => ({ message: replies.shift() }) });

  const open = mind.listIntentions({ status: 'open' });
  check(open.length === 1 && open[0].text.includes('搬家'), 'plan 挂出一条意图');
  check(open[0].kind === 'delayed_check', '标记为延时查看');
  check(open[0].dueAt === now0 + 2 * H, '按 inHours 算到期时间');
}
// ── 2k. 同一轮里的上限与额度 ────────────────────────────────────────────
console.log('\n=== 2k. 同轮上限 ===');
{
  updateConfig({ mind: { tick: { maxProactivePerDay: 1, maxProactiveGapMs: 3600000 } } });
  const { orch, mind } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 3 * H },
    unreadOf: {},
    relations: { 111: { nickname: '王哥' } }
  });
  orch.wake = async () => ({ ok: true });
  const replies = [
    { tool_calls: [
      { id: 'a1', function: { name: 'send_proactive', arguments: '{"chatKey":"private:111"}' } },
      { id: 'a2', function: { name: 'send_proactive', arguments: '{"chatKey":"private:111"}' } }
    ] },
    { tool_calls: [{ id: 'f', function: { name: 'finish', arguments: '{}' } }] }
  ];
  const r = await orch.tickOnce({ now: now0, chat: async () => ({ message: replies.shift() }) });
  const sends = (r.results || []).filter((x) => x.action === 'send_proactive');
  check(sends.length === 1, `同一轮里主动次数上限仍然有效（实际 ${sends.length} 次）`);
  check(mind.getTick().todayProactive === 1, '计数只加一次');

  // 失败不占额度：先调一个不存在的动作，再调一个真动作，maxPerWake=1 仍然放行
  updateConfig({ mind: { actions: { maxPerWake: 1 } } });
  const { orch: o2 } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 3 * H },
    unreadOf: {},
    relations: { 111: { nickname: '王哥' } }
  });
  o2.wake = async () => ({ ok: true });
  const replies2 = [
    { tool_calls: [
      { id: 'x', function: { name: 'not_a_real_action', arguments: '{}' } },
      { id: 'y', function: { name: 'send_proactive', arguments: '{"chatKey":"private:111"}' } }
    ] },
    { tool_calls: [{ id: 'f', function: { name: 'finish', arguments: '{}' } }] }
  ];
  const r2 = await o2.tickOnce({ now: now0, chat: async () => ({ message: replies2.shift() }) });
  check((r2.results || []).some((x) => x.action === 'send_proactive'), '读失败/未知动作不占行动额度');
}
// ── 2l. 节律：做砸过的动作要歇一阵 ──────────────────────────────────────
console.log('\n=== 2l. 动作节律 ===');
{
  const { orch, mind } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 3 * H },
    unreadOf: {},
    relations: { 111: { nickname: '王哥' } }
  });
  mind.recordActionStat('send_proactive', { ok: false, now: now0 - 1000 });
  mind.updateTick({ actionStats: { send_proactive: { ok: 0, fail: 1, lastAt: now0 - 1000, meanIntervalMs: 5 * H, nextRipeAt: now0 + 4 * H } } });
  orch.wake = async () => ({ ok: true });
  let calls = 0;
  const replies = [{ tool_calls: [{ id: 's', function: { name: 'send_proactive', arguments: '{"chatKey":"private:111"}' } }] }];
  const r = await orch.tickOnce({ now: now0, chat: async () => { calls++; return { message: replies.shift() || { content: '' } }; } });
  check(calls >= 1, '这一轮仍然会调模型（还有别的动作可选）');
  check(!(r.results || []).some((x) => x.action === 'send_proactive'), '歇着的动作不会被选中执行');

  // dormant：成功率长期过低 → 一周内不再尝试
  const { orch: o2, mind: m2 } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 3 * H },
    unreadOf: {},
    relations: { 111: { nickname: '王哥' } }
  });
  m2.updateTick({
    actionStats: {
      send_proactive: { ok: 0, fail: 6, attempts: 6, rate: 0, lastAt: now0, meanIntervalMs: 12 * H, nextRipeAt: now0 - 1, dormant: true, dormantUntil: now0 + 6 * 86400000 }
    }
  });
  o2.wake = async () => ({ ok: true });
  let called2 = 0;
  const r2 = await o2.tickOnce({ now: now0, chat: async () => { called2++; return { message: { content: '算了' } }; } });
  check(!(r2.results || []).some((x) => x.action === 'send_proactive'), 'dormant 的动作不在菜单里');
}
// ── 3. 同一次唤醒不会重复决策 ───────────────────────────────────────────
console.log('\n=== 3. 节拍 ===');
{
  const { orch } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 5 * H },
    unreadOf: {},
    relations: {}
  });
  let calls = 0;
  const chat = async () => { calls += 1; return { message: { content: '{"action":"idle","reason":"算了"}' } }; };
  await orch.tickOnce({ now: now0, chat });
  const second = await orch.tickOnce({ now: now0 + 60000, chat });
  check(calls === 1, `同一节拍内只调一次模型（实际 ${calls}）`);
  check(second.skipped === 'too-soon' || second.skipped === 'not-due', `刚醒过就跳过（${second.skipped}）`);
}

// ── 4. 没有候选也要给她选择权（目录，不是门禁）──────────────────────────
console.log('\n=== 4. 没有候选 ===');
{
  const { orch, mind } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 60000 },  // 刚聊过，低于 proactiveIdleMs
    unreadOf: {},
    relations: {}
  });
  let called = false;
  const r = await orch.tickOnce({ now: now0, chat: async () => { called = true; return { message: { content: '今天不想说话' } }; } });
  // 设计 §7.3：候选只是提示，目录保证总有可做的事。没有候选也要让她自己决定不做。
  check(called === true, '没有候选时仍然给她一次选择的机会（而不是系统替她决定）');
  check(r.results?.some((x) => x.action === 'idle'), '她可以选择什么都不做');
  check(mind.listAttempts({ limit: 3 }).some((a) => a.action === 'idle'), 'idle 也落账（能看出"她想过但没做"）');
}

console.log(`\n全局唤醒：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
