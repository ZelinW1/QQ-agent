// "没有心智也能跑"的守门测试（A 期的收尾判据）。
//
// 设计里这条判据是：把 src/mind/ 整个删掉，应用照常启动，只是"她没有内心生活了"。
// 真删目录没法在 CI 里做（模块缓存、别的测试还要用），所以用等价的装配：
//   createApp({ mind: null }) —— 装配根不创建 MindStore，注入的全是空实现端口。
//
// 这条测试要证明的不是"某条路径安静退出"，而是：
//   1. 对话链路完整可用（有人找她 → 调模型 → 发出去）；
//   2. 需要心智的地方降级，不会把整条链路带崩；
//   3. 控制台接口不 500，只是没有内容。
import assert from 'node:assert/strict';
import { bootApp, sleep, waitFor } from './_harness.mjs';

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const env = await bootApp({
  // 明确不要心智：装配根会注入空实现端口
  mind: null,
  config: {
    mind: { enabled: true, tick: { enabled: true } }, // 即使配置说"开着"
    store: { contextSliderPos: 100, historyCount: 20 },
    wakeDelayMs: 150
  }
});
const { app, pushGroupMsg, llm, request, waitSessionDone, onebotHttp } = env;
// 发出的消息记在 mock OneBot 的 HTTP 侧（send_group_msg 走 HTTP API）
const sentCount = () => (onebotHttp?.state?.sends || []).length;

await check('1 装配根没有创建心智存储', async () => {
  assert.equal(app.orchestrator.mind, null, 'orchestrator.mind 应为 null');
  assert.equal(app.orchestrator.mindPort.enabled, false, '运行时端口应是空实现');
});

await check('2 心跳直接跳过（no-mind），不抛错', async () => {
  const r = await app.orchestrator.tickOnce({ now: Date.now() });
  assert.equal(r.skipped, 'no-mind');
});

await check('3 对话照跑：有人 @ 她 → 调模型 → 发出去', async () => {
  // 模拟一次正常应答：调 send_message 把话说出去，然后结束。
  llm.state.script.push(
    { toolCalls: [{ name: 'send_message', args: { messages: ['在的'] } }] },
    { content: '（处理完毕）' }
  );
  const before = llm.state.requests.length;
  pushGroupMsg(111, '张三', '@覆盖Bot 在吗', 91001);
  const session = await waitSessionDone('在吗');
  assert.ok(session, '应产生一次会话');
  assert.equal(session.status, 'done', `会话应正常结束（实际 ${session.status}）`);
  assert.ok(llm.state.requests.length > before, '应当调过模型');
  await waitFor(() => sentCount() >= 1, 5000, '发送队列把消息发出去');
  assert.ok(sentCount() >= 1, '应当至少往 QQ 发出一条消息');
  assert.equal(app.store.getChatMeta('group:456').unread, 0, '未读应被消费');
});

await check('4 需要心智的工具不出现在工具表里', async () => {
  // 没有心智时，requiresMind 的工具整体从工具表消失 —— 模型连尝试的机会都没有，
  // 这比"看得见但一调就报错"干净。
  const req = llm.state.requests[llm.state.requests.length - 1];
  const names = (req.tools || []).map((t) => t.function?.name || t.name);
  assert.ok(names.length > 0, '普通工具仍应在表里');
  for (const id of ['remember_event', 'update_relation', 'self_revise', 'recall']) {
    assert.ok(!names.includes(id), `不应提供 ${id}`);
  }
  assert.ok(names.includes('send_message'), '发送工具仍应在表里');
});
await check('5 控制台接口不 500（只是没有内容）', async () => {
  const state = await request('GET', '/api/mind/state');
  assert.ok(state.status === 200, `/api/mind/state 状态码 ${state.status}`);
  const events = await request('GET', '/api/mind/events');
  assert.ok(events.status === 200, `/api/mind/events 状态码 ${events.status}`);
  const tickLog = await request('GET', '/api/mind/tick-log');
  assert.ok(tickLog.status === 200, `/api/mind/tick-log 状态码 ${tickLog.status}`);
});

console.log(`\n无心智装配：通过 ${pass.length}，失败 ${fail.length}`);
// 必须显式 teardown：app 里有心跳定时器和 HTTP/WS 服务，不关的话进程不会退出。
await env.teardown();
process.exit(fail.length ? 1 : 0);
