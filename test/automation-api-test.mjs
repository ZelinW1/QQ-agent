// 自动化接口自测（后端全链路）。
//
// 与 runtime-automation-test 的分工：那套测调度与 cron 求值，这套测**HTTP 接口**——
// 参数校验、状态码、以及"手动执行不吞掉定时"这类只有走 HTTP 才看得见的语义。
import assert from 'node:assert/strict';
import { bootApp } from './_harness.mjs';

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const env = await bootApp({
  config: { persona: { botName: '覆盖Bot' }, store: { contextSliderPos: 0, historyCount: 20 } }
});
const { request } = env;

await check('1 初始为空', async () => {
  const r = await request('GET', '/api/automations');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.tasks, []);
});

await check('2 cron 预览：合法的给出描述与接下来三次', async () => {
  const r = await request('GET', '/api/automations/preview?cron=' + encodeURIComponent('0 9 * * *'));
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.describe, '每天 09:00');
  assert.equal(r.data.next.length, 3);
  assert.ok(r.data.next[0] > Date.now());
});

await check('3 cron 预览：非法的说明为什么', async () => {
  const r = await request('GET', '/api/automations/preview?cron=' + encodeURIComponent('0 9 *'));
  assert.equal(r.data.ok, false);
  assert.match(r.data.error, /五段|非法/);
});

await check('4 创建：参数校验拦在前面', async () => {
  const noAction = await request('POST', '/api/automations', { body: { cron: '0 9 * * *' } });
  assert.equal(noAction.status, 400);
  assert.match(noAction.data.error, /action/);

  const noText = await request('POST', '/api/automations', { body: { cron: '0 9 * * *', action: 'send', chatKey: 'private:1' } });
  assert.equal(noText.status, 400);
  assert.match(noText.data.error, /内容/);

  const noChat = await request('POST', '/api/automations', { body: { cron: '0 9 * * *', action: 'send', args: { text: '早' } } });
  assert.equal(noChat.status, 400);
  assert.match(noChat.data.error, /目标会话/);

  const badCron = await request('POST', '/api/automations', { body: { cron: '0 9 *', action: 'remember', args: { text: 'x' } } });
  assert.equal(badCron.status, 400);
});

await check('5 创建成功并出现在列表里', async () => {
  const r = await request('POST', '/api/automations', {
    body: { name: '每日问候', cron: '0 9 * * *', action: 'send', chatKey: 'private:1', args: { text: '早' } }
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.task.describe, '每天 09:00');
  assert.ok(r.data.task.nextRunAt > 0);

  const list = await request('GET', '/api/automations');
  assert.equal(list.data.tasks.length, 1);
  assert.equal(list.data.tasks[0].name, '每日问候');
});

await check('6 停用 / 启用', async () => {
  const list = await request('GET', '/api/automations');
  const id = list.data.tasks[0].id;
  const off = await request('POST', `/api/automations/${id}`, { body: { enabled: false } });
  assert.equal(off.data.task.enabled, false);
  const on = await request('POST', `/api/automations/${id}`, { body: { enabled: true } });
  assert.equal(on.data.task.enabled, true);
});

await check('7 立即执行：走管线，不吞掉定时', async () => {
  const list = await request('GET', '/api/automations');
  const task = list.data.tasks[0];
  const before = task.nextRunAt;
  const r = await request('POST', `/api/automations/${task.id}/run`);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  const after = (await request('GET', '/api/automations')).data.tasks[0];
  assert.equal(after.nextRunAt, before, '手动执行不改 nextRunAt（否则点一下就把今天的定时吃掉了）');
});

await check('7b 界面脚本能被真正加载', async () => {
  const js = await request('GET', '/app/14-automation.js');
  assert.equal(js.status, 200);
  assert.match(js.text, /renderAutomationSection/);
  const html = await request('GET', '/');
  assert.equal(html.status, 200);
  assert.match(html.text, /14-automation\.js/, '首页引入了自动化脚本（否则设置了也不会生效）');
});
await check('8 删除', async () => {
  const list = await request('GET', '/api/automations');
  const id = list.data.tasks[0].id;
  const del = await request('DELETE', `/api/automations/${id}`);
  assert.equal(del.status, 200);
  const after = await request('GET', '/api/automations');
  assert.equal(after.data.tasks.length, 0);
  const again = await request('DELETE', `/api/automations/${id}`);
  assert.equal(again.status, 404);
});

console.log(`\n自动化接口：通过 ${pass.length}，失败 ${fail.length}`);
await env.teardown();
process.exit(fail.length ? 1 : 0);
