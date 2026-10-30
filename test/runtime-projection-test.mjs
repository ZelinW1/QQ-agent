// 工具投影与模型循环自测。
//
// 投影是"同一份动作表如何变成不同场合的工具表"；循环是"一次时刻里怎么调模型、
// 执行工具、把结果回灌"。两者都是纯逻辑，不需要真实模型。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { projectFreeTools, renderMenu, traitsForAction, TOOL_SCHEMA_VERSION } = await import(src('src/runtime/project-tools.js'));
const { runAgentLoop, digestConfig } = await import(src('src/runtime/agent-loop.js'));

const ACTIONS = [
  { id: 'send_proactive', label: '找人说话', description: '主动开口', energy: 25 },
  { id: 'remember', label: '记一笔', energy: 5 },
  { id: 'plan', label: '记下要做的事', energy: 3 },
  { id: 'stay_up', label: '再撑一会儿', energy: 0 }
];

// ── 1. 投影 ─────────────────────────────────────────────────────────────
console.log('\n=== 1. 工具投影 ===');
{
  const { tools, menu, blocked } = projectFreeTools({ actions: ACTIONS });
  check(tools.length === ACTIONS.length + 1, '每个动作一个工具 + finish');
  check(tools[tools.length - 1].function.name === 'finish', 'finish 永远在最后');
  check(menu.length === ACTIONS.length && blocked.length === 0, '默认全部可用');

  const limited = projectFreeTools({ actions: ACTIONS, traits: { act: ['remember', 'plan'] } });
  check(limited.menu.map((a) => a.id).join(',') === 'remember,plan', 'traits.act 决定了哪些动作进菜单');
  check(limited.tools.every((t) => t.function.name !== 'send_proactive'), '没进菜单的不会出现在工具表（同一份投影）');

  const vetoed = projectFreeTools({
    actions: ACTIONS,
    blocked: (a) => (a.id === 'send_proactive' ? '今天说够话了' : null)
  });
  check(!vetoed.menu.some((a) => a.id === 'send_proactive'), '被拦下的动作不在菜单');
  check(vetoed.blocked.some((b) => b.id === 'send_proactive' && b.reason === '今天说够话了'), '但会记下原因（提示词里能解释）');

  const reads = projectFreeTools({
    actions: [],
    readTools: [
      { id: 'get_recent_messages', name: '翻消息', description: '看历史', traits: { modes: ['free'] }, execute: () => {} },
      { id: 'send_message', name: '发消息', description: '聊天用', traits: { modes: ['chat'] }, execute: () => {} }
    ]
  });
  const names = reads.tools.map((t) => t.function.name);
  check(names.includes('get_recent_messages'), '只读工具可以进自由场合');
  check(!names.includes('send_message'), '聊天专用工具不会进自由场合');

  const t = traitsForAction(ACTIONS[0]);
  check(t.schemaVersion === TOOL_SCHEMA_VERSION && t.traits.modes.includes('free'), '动作带 schema 版本与场合');

  const menuText = renderMenu(ACTIONS, { includeIdle: true });
  check(menuText.includes('send_proactive') && menuText.includes('什么都不做'), '菜单文本与工具表同源，并说明"可以不做"');
}

// ── 2. 模型循环 ─────────────────────────────────────────────────────────
console.log('\n=== 2. 模型循环 ===');
{
  const replies = [
    { message: { tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'remember', arguments: '{"text":"x"}' } },
      { id: 'c2', type: 'function', function: { name: 'finish', arguments: '{"reason":"够了"}' } }
    ] }, usage: { total_tokens: 100 } },
    { message: { content: '结束' } }
  ];
  const seen = [];
  const r = await runAgentLoop({
    callModel: async () => replies.shift(),
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
    tools: [],
    onCall: async (call) => { seen.push(call.name); return { ok: true, result: 'ok' }; }
  });
  check(seen.join(',') === 'remember', 'finish 不当作动作执行');
  check(r.executed.length === 1 && r.executed[0].name === 'remember', '执行结果被记下');
  check(r.idleReason === '够了', 'finish 的理由成为收手原因');
  check(r.usage === 100, '用量累计');
}

// ── 3. 没有工具调用 = 收手 ──────────────────────────────────────────────
console.log('\n=== 3. 收手语义 ===');
{
  const r = await runAgentLoop({
    callModel: async () => ({ message: { content: '今天不想说话' } }),
    messages: [{ role: 'user', content: 'u' }],
    tools: [],
    onCall: async () => ({ ok: true })
  });
  check(r.ok === true && r.executed.length === 0, '只写正文也算正常结束');
  check(r.idleReason === '今天不想说话', '正文成为收手原因');

  const err = await runAgentLoop({
    callModel: async () => ({ message: { tool_calls: [{ id: 'a', type: 'function', function: { name: 'remember', arguments: '{}' } }] } }),
    messages: [],
    tools: [],
    onCall: async () => { throw new Error('炸了'); },
    maxSteps: 1
  });
  check(err.ok === true && err.executed.length === 0, '工具执行异常不会炸穿循环（只是这一件没做成）');

  const bad = await runAgentLoop({ callModel: async () => { throw new Error('模型挂了'); }, messages: [], tools: [], onCall: async () => ({ ok: true }) });
  check(bad.ok === false && bad.error.includes('模型挂了'), '模型调用失败返回失败结果');

  let calls = 0;
  await runAgentLoop({
    callModel: async () => { calls++; return { message: { tool_calls: [{ id: `x${calls}`, type: 'function', function: { name: 'remember', arguments: '{}' } }] } }; },
    messages: [], tools: [], onCall: async () => ({ ok: true }), maxSteps: 3
  });
  check(calls === 3, 'maxSteps 是硬上限（不会无限循环）');
}

// ── 4. 配置摘要 ─────────────────────────────────────────────────────────
console.log('\n=== 4. 配置摘要 ===');
{
  const base = { api: { model: 'm' }, mind: { scope: 'private', reflectAfterEvents: 8, tick: { maxDecisionsPerDay: 24 } } };
  const a = digestConfig(base);
  const same = digestConfig({ ...base, ui: { theme: 'dark' }, store: { historyCount: 999 } });
  check(a === same, '只改界面/存档这类配置不影响摘要');
  const changed = digestConfig({ ...base, mind: { ...base.mind, reflectAfterEvents: 6 } });
  check(a !== changed, '改了行为参数 → 摘要变化');
  check(a.length > 0 && a.length <= 16, '摘要是短串');
}

console.log(`\n投影与循环：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
