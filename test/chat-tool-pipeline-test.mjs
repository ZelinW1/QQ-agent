// 聊天工具的八步管线自测（P0：permission 顺序与超时取值）。
//
// 这两件事都只能端到端验：权限要靠真实的工具表过滤与 tool call 回灌，
// 超时要靠管线真正把 Promise 掐断。纯函数测试看不见它们。
import assert from 'node:assert/strict';
import { bootApp, waitFor } from './_harness.mjs';

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const env = await bootApp({
  config: { store: { contextSliderPos: 100, historyCount: 20 }, wakeDelayMs: 120, mind: { enabled: false } },
  // 工具必须在 harness 设好数据目录之后、应用加载之前注册：
  // 提前 import 会把 config.js 先带上默认数据目录，应用就读不到这份测试配置。
  setup: async () => {
    const { registerTool: register } = await import('../src/tool-registry.js');
    // 只在自由场合开放：聊天里调用应当被管线拒绝
    register({
      id: 'free_only_probe',
      name: '自由专用探针',
      description: '只用于测试场合权限',
      category: 'system',
      traits: { modes: ['free'], scopes: [] },
      parameters: { type: 'object', properties: {} },
      async execute() { return { content: '不该被调用' }; }
    });
    // 永远不返回：验证超时按工具自己声明的值生效
    register({
      id: 'hanging_probe',
      name: '挂起探针',
      description: '只用于测试超时',
      category: 'system',
      timeoutMs: 30,
      parameters: { type: 'object', properties: {} },
      execute() { return new Promise(() => {}); }
    });
  }
});
const { onebotWs, llm, waitSessionDone } = env;
const pushPrivate = (userId, name, text, mid) => onebotWs.push({
  post_type: 'message', message_type: 'private', user_id: userId, self_id: 888,
  message_id: mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: userId, nickname: name },
  message: [{ type: 'text', data: { text } }]
});

await check('1 场合不符的工具在聊天里被拒绝', async () => {
  // mock 按"第几次请求"取脚本（requests.length），不是队列：要按下标写。
  llm.state.script[llm.state.requests.length] = { toolCalls: [{ name: 'free_only_probe', args: {} }] };
  pushPrivate(777, '小王', '试试那个自由专用工具', 94101);
  const session = await waitSessionDone('自由专用');
  assert.ok(session, '会话应结束');
  const toolMsgs = llm.state.requests.flatMap((r) => (r.messages || []).filter((m) => m.role === 'tool'));
  const hit = toolMsgs.map((m) => String(m.content || '')).find((c) => c.includes('不在聊天场合开放'));
  assert.ok(hit, '工具结果里应当说明"不在聊天场合开放"');
});

await check('2 超时按工具自己声明的值生效', async () => {
  llm.state.script[llm.state.requests.length] = { toolCalls: [{ name: 'hanging_probe', args: {} }] };
  pushPrivate(777, '小王', '再试试挂起的工具', 94102);
  await waitSessionDone('挂起的工具');
  await waitFor(() => {
    const toolMsgs = llm.state.requests.flatMap((r) => (r.messages || []).filter((m) => m.role === 'tool'));
    return toolMsgs.some((m) => String(m.content || '').includes('超时'));
  }, 3000, '超时被报到模型');
});

console.log(`\n聊天工具管线：通过 ${pass.length}，失败 ${fail.length}`);
await env.teardown();
process.exit(fail.length ? 1 : 0);
