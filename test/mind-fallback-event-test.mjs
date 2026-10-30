// 兜底事件（设计 §4.2.1）：一轮对话至少要留下一条记录。
//
// 为什么单独测：模型不主动调 remember_event 是常态。没有兜底事件，
// 反思的"未反思事件"永远到不了阈值，L2a/L2b/L3/L4 整条链会长期空转。
// 这条不能用单元测试代替 —— 必须走一次真实的"消息进来 → 跑完 → 落盘"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootApp, waitFor } from './_harness.mjs';

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const env = await bootApp({
  config: {
    mind: { enabled: true },
    store: { contextSliderPos: 100, historyCount: 20 },
    wakeDelayMs: 150
  }
});
const { app, dataDir, onebotWs, llm, waitSessionDone } = env;
// 心智默认只作用于私聊（scope=private），所以兜底事件要在私聊里验。
const pushPrivate = (userId, name, text, mid) => onebotWs.push({
  post_type: 'message', message_type: 'private', user_id: userId, self_id: 888,
  message_id: mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: userId, nickname: name },
  message: [{ type: 'text', data: { text } }]
});

/** 直接读心智存储：走接口会丢掉 source / tags 这类字段。 */
const { MindStore } = await import('../src/mind/store.js');
const mind = new MindStore({ root: path.join(dataDir, 'mind'), getOptions: () => ({}) });
const eventsOf = (chatKey) => mind.queryEvents({ chatKey, limit: 200 });

await check('1 模型什么都没记，也要留下一条"聊过了"', async () => {
  llm.state.script.push({ content: '（这轮不调用任何工具，也不记东西）' });
  pushPrivate(777, '小王', '在吗', 93001);
  const session = await waitSessionDone('在吗');
  // 这一轮她没说话（noreply）也算跑完：兜底事件与"要不要回"是两件事。
  assert.notEqual(session.status, 'error');

  const events = eventsOf('private:777');
  assert.ok(events.length >= 1, `应至少有一条事件（实际 ${events.length}）`);
  const fallback = events.find((e) => e.source === 'runtime.chat' || (e.tags || []).includes('兜底'));
  assert.ok(fallback, '应当有一条兜底事件');
  assert.match(String(fallback.text), /在吗|聊了几句/, '兜底事件带上这次对话的线索');
});

await check('2 模型自己记了就不再补（不重复灌事件）', async () => {
  const before = eventsOf('private:777').length;
  llm.state.script.push({ toolCalls: [{ name: 'remember_event', args: { text: '他说下周要出差' } }] });
  await new Promise((r) => setTimeout(r, 10));
  pushPrivate(777, '小王', '记一下我下周出差', 93002);
  const session = await waitSessionDone('出差');
  // 这一轮她没说话（noreply）也算跑完：兜底事件与"要不要回"是两件事。
  assert.notEqual(session.status, 'error');
  await waitFor(() => eventsOf('private:777').length > before, 3000, '事件写进去了');
  const events = eventsOf('private:777');
  const fallback = events.filter((e) => e.source === 'runtime.chat' || (e.tags || []).includes('兜底'));
  assert.equal(fallback.length, 1, '第二轮不应该再补兜底事件');
  assert.ok(events.some((e) => String(e.text).includes('出差') && e.actorId === 'self'), '模型写的那条在');
});

await check('2b 聊天里的工具调用也走管线并留下账本', async () => {
  const tools = mind.listAttempts({ limit: 20 }).filter((a) => a.kind === 'tool');
  assert.ok(tools.length >= 1, '至少有一次工具调用被记账');
  const hit = tools.find((a) => a.action === 'remember_event');
  assert.ok(hit, 'remember_event 有记录');
  assert.equal(hit.outcome, 'done', '成功的工具调用结局是 done');
  assert.ok(String(hit.momentId || '').length > 0, '带 momentId（能追到那一次运行）');
  const moments = mind.listMoments({ limit: 10 }).filter((m) => m.runtime === 'chat');
  assert.ok(moments.length >= 2, `聊天每次运行都落 moment（${moments.length}）`);
  assert.ok(moments.every((m) => typeof m.configDigest === 'string'), 'moment 带配置摘要');
});
await check('3 兜底事件会计入"未反思欠账"', async () => {
  const debt = app.orchestrator.mind.countUnreflected('private:777', 0);
  assert.ok(debt >= 1, `欠账应大于 0（实际 ${debt}）`);
});

console.log(`\n兜底事件：通过 ${pass.length}，失败 ${fail.length}`);
await env.teardown();
process.exit(fail.length ? 1 : 0);
