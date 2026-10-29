// 硬指标守门：把"心智"整块拿掉，应用照常启动。
//
// 设计里 A 期的判据是"删掉 src/mind/ 之后应用照常启动"。真的删目录没法在 CI 里做，
// 所以留了一个等价的开关：QQ_AGENT_NO_MIND=1 时，**所有**对 src/mind/ 的 import
// 都变成"加载失败就降级"——等价于那些文件不存在。
//
// 与 mind-absent-test.mjs 的区别：
//   · mind-absent 测的是 createApp({ mind: null })：领域模块还在，只是不建存储；
//   · 本测试测的是同一件事的**极限情形**：连模块都加载不到。
// 两条都过，才说明"运行时确实不依赖领域符号"。
process.env.QQ_AGENT_NO_MIND = '1';

import assert from 'node:assert/strict';
import { bootApp, sleep, waitFor } from './_harness.mjs';

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const env = await bootApp({
  config: {
    mind: { enabled: true, tick: { enabled: true } },
    store: { contextSliderPos: 100, historyCount: 20 },
    wakeDelayMs: 150
  }
});
const { app, pushGroupMsg, llm, request, waitSessionDone, onebotHttp } = env;
const sentCount = () => (onebotHttp?.state?.sends || []).length;

await check('1 装配根没有心智存储，运行时端口是空实现', async () => {
  assert.equal(app.orchestrator.mind, null);
  assert.equal(app.orchestrator.mindPort.enabled, false);
});

await check('2 心智工具根本没注册进工具表', async () => {
  const ids = app.orchestrator.toolDefs.map((t) => t.id);
  assert.ok(ids.length > 0, '普通工具仍在');
  for (const id of ['remember_event', 'update_relation', 'self_revise', 'recall']) {
    assert.ok(!ids.includes(id), `不应注册 ${id}`);
  }
});

await check('3 心跳直接跳过（no-mind）', async () => {
  const r = await app.orchestrator.tickOnce({ now: Date.now() });
  assert.equal(r.skipped, 'no-mind');
});

await check('4 对话照跑：有人 @ 她 → 调模型 → 发出去', async () => {
  llm.state.script.push(
    { toolCalls: [{ name: 'send_message', args: { messages: ['在的'] } }] },
    { content: '（处理完毕）' }
  );
  pushGroupMsg(111, '张三', '@覆盖Bot 在吗', 92001);
  const session = await waitSessionDone('在吗');
  assert.ok(session, '应产生一次会话');
  assert.equal(session.status, 'done', `会话应正常结束（实际 ${session.status}）`);
  await waitFor(() => sentCount() >= 1, 5000, '消息真的发出去了');
});

await check('5 控制台接口不 500', async () => {
  for (const path of ['/api/mind/state', '/api/mind/events', '/api/mind/tick-log']) {
    const r = await request('GET', path);
    assert.equal(r.status, 200, `${path} 状态码 ${r.status}`);
  }
});

await check('6 自由时刻也没有炸（没有动作可做就是 idle）', async () => {
  const r = await app.orchestrator.tickOnce({ now: Date.now() + 60000 });
  assert.ok(r && (r.skipped === 'no-mind' || Array.isArray(r.results)), 'tick 有兜底结果');
});

console.log(`\n领域缺席：通过 ${pass.length}，失败 ${fail.length}`);
await env.teardown();
process.exit(fail.length ? 1 : 0);
