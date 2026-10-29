// 自动化：cron 求值、任务表、调度与执行（D2）。
//
// 与自由时刻的区别：自动化是"说好了要做"，到点就跑，不看体力/作息/决策次数；
// 但它仍然走八步管线——配置一次就无人看管的东西，最该被约束。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { parseCron, nextCronAt, describeCron } = await import(src('src/runtime/cron.js'));
const { createAutomationStore, dueTasks, MAX_FAILURES } = await import(src('src/runtime/automation-store.js'));
const { runAutomation } = await import(src('src/runtime/automator.js'));

// ── 1. cron 解析 ────────────────────────────────────────────────────────
console.log('\n=== 1. cron 解析 ===');
{
  check(parseCron('* * * * *').ok === true, '全通配合法');
  check(parseCron('*/15 9-18 * * 1-5').ok === true, '区间 + 步长 + 工作日合法');
  check(parseCron('0 9 * * *').fields.hour.has(9), '单值解析正确');

  const bad = parseCron('0 9 * *');
  check(bad.ok === false && bad.reason.includes('五段'), '四段被拒绝并说明原因');
  check(parseCron('0 9 * * 1,7').fields.dayOfWeek.has(0), '周日写 7 也认（等价 0）');
  check(parseCron('61 * * * *').ok === false, '越界分钟被拒绝');
  check(parseCron('0 9 * * abc').ok === false, '非数字被拒绝');
}

// ── 2. 下一次触发 ───────────────────────────────────────────────────────
console.log('\n=== 2. 下一次触发 ===');
{
  const base = new Date(2026, 0, 15, 8, 30, 0, 0); // 2026-01-15 08:30 本地时间
  const at = base.getTime();

  const nine = nextCronAt('0 9 * * *', at);
  check(nine === new Date(2026, 0, 15, 9, 0, 0, 0).getTime(), '每天 9 点：同一天稍后');

  const afterNine = nextCronAt('0 9 * * *', new Date(2026, 0, 15, 9, 0, 0, 0).getTime());
  check(afterNine === new Date(2026, 0, 16, 9, 0, 0, 0).getTime(), '严格晚于当前时间（不会同分钟重复触发）');

  const monday = nextCronAt('30 8 * * 1', at); // 2026-01-15 是周四
  check(monday === new Date(2026, 0, 19, 8, 30, 0, 0).getTime(), '每周一：跳到下一个周一');

  const monthEnd = nextCronAt('0 0 1 * *', at);
  check(monthEnd === new Date(2026, 1, 1, 0, 0, 0, 0).getTime(), '每月 1 日：跨月');

  check(nextCronAt('0 0 31 2 *', at) === null, '2 月 31 日：永远不会触发，返回 null');
  check(nextCronAt('坏表达式', at) === null, '非法表达式返回 null');
}

// ── 3. 人话描述 ─────────────────────────────────────────────────────────
console.log('\n=== 3. 描述 ===');
{
  check(describeCron('0 9 * * *') === '每天 09:00', `每天（${describeCron('0 9 * * *')}）`);
  check(describeCron('30 8 * * 1') === '每周一 08:30', `每周（${describeCron('30 8 * * 1')}）`);
  check(describeCron('* * * * *') === '每分钟', '每分钟');
  check(describeCron('坏').startsWith('无效'), '非法表达式给出可读提示');
}

// ── 4. 任务表 ───────────────────────────────────────────────────────────
console.log('\n=== 4. 任务表 ===');
{
  const dir = fs.mkdtempSync(path.join(dataDir, 'store-'));
  const store = createAutomationStore({ dir });

  const bad = store.add({ name: '坏的', cron: '0 9 *', action: 'send', args: { text: 'hi' } });
  check(bad.ok === false, '非法 cron 拒绝入库');

  const added = store.add({ name: '早安', cron: '0 9 * * *', action: 'send', chatKey: 'private:1', args: { text: '早' } });
  check(added.ok === true && Boolean(added.task.nextRunAt), '新建任务并算出下次时间');
  check(store.list().length === 1, '可以列出');

  const upd = store.update(added.task.id, { cron: '0 10 * * *' });
  check(upd.ok === true && new Date(upd.task.nextRunAt).getHours() === 10, '改 cron 会重算下次时间');

  const failed = store.markRun(added.task.id, { ok: false, error: '网络错误', at: Date.now() });
  check(failed.task.failures === 1 && failed.task.enabled === true, '失败一次仍启用');
  const okRun = store.markRun(added.task.id, { ok: true, at: Date.now() });
  check(okRun.task.failures === 0, '成功一次清零失败计数');

  for (let i = 0; i < MAX_FAILURES; i++) store.markRun(added.task.id, { ok: false, error: `失败${i}` });
  const stopped = store.list()[0];
  check(stopped.enabled === false, `连续失败 ${MAX_FAILURES} 次自动停用`);
  check(stopped.lastResult.includes('已停用'), '停用原因写在记录里（界面上能看见）');

  check(store.remove(added.task.id).ok === true && store.list().length === 0, '可以删除');
}

// ── 5. 挑选到期任务 ─────────────────────────────────────────────────────
console.log('\n=== 5. 到期挑选 ===');
{
  const now = Date.now();
  const tasks = [
    { id: 'a', enabled: true, nextRunAt: now - 1000 },
    { id: 'b', enabled: false, nextRunAt: now - 1000 },
    { id: 'c', enabled: true, nextRunAt: now + 60000 },
    { id: 'd', enabled: true, nextRunAt: 0 }
  ];
  const due = dueTasks(tasks, now, 5);
  check(due.length === 1 && due[0].id === 'a', '只挑启用且到点的');
  check(dueTasks(tasks, now, 5)[0].id === 'a' && dueTasks([...tasks, { id: 'e', enabled: true, nextRunAt: now - 2000 }], now, 5)[0].id === 'e',
    '按到期时间排序（先到先跑）');
  check(dueTasks(tasks, now, 1).length === 1, '受 limit 限制');
}

// ── 6. 执行走管线 ───────────────────────────────────────────────────────
console.log('\n=== 6. 执行 ===');
{
  const disabled = await runAutomation({ task: { enabled: false, action: 'send' }, execute: async () => 'x' });
  check(disabled.ok === false && disabled.code === 'disabled', '停用任务不执行');

  const noText = await runAutomation({ task: { enabled: true, action: 'send', args: {} }, execute: async () => 'x' });
  check(noText.ok === false && noText.code === 'invalid_args', '发消息缺正文被参数校验拦下');

  let ran = 0;
  const good = await runAutomation({ task: { enabled: true, action: 'remember', args: { text: 'x' } }, execute: async () => { ran++; return { ok: true }; } });
  check(good.ok === true && ran === 1, '正常任务执行一次');

  const boom = await runAutomation({ task: { enabled: true, action: 'remember' }, execute: async () => { throw new Error('炸了'); } });
  check(boom.ok === false && boom.code === 'error' && boom.message.includes('炸了'), '执行异常转成失败结果');
}

// ── 7. 编排器：到点就跑，失败记账 ────────────────────────────────────────
console.log('\n=== 7. 编排器调度 ===');
{
  const { Orchestrator } = await import(src('src/orchestrator.js'));
  const dir = fs.mkdtempSync(path.join(dataDir, 'orch-'));
  const store = createAutomationStore({ dir });
  const made = store.add({ name: '每日问候', cron: '* * * * *', action: 'send', chatKey: 'private:1', args: { text: '早' } });

  const sent = [];
  const sender = { sendTextBatch: async (chatKey, msgs) => { sent.push({ chatKey, msgs }); return { sent: msgs.map((text) => ({ text })), failed: [] }; } };
  const orch = new Orchestrator({
    store: { listChats: () => [], getChatMeta: () => ({}), recent: () => [] },
    memory: {}, stickers: {}, sender, sessions: {}, onebot: {}, mind: null, automationDir: dir
  });
  // 把它推到"已到点"
  store.update(made.task.id, { nextRunAt: Date.now() - 1000 });

  const r = await orch.runDueAutomations({ now: Date.now() });
  check(r.ran === 1 && r.results[0].ok === true, '到点的任务被执行');
  check(sent.length === 1 && sent[0].chatKey === 'private:1', '消息发到了指定会话');
  const after = store.list()[0];
  check(Number(after.nextRunAt) > Date.now(), '跑完推进到下一次');
  check(after.lastResult === 'ok', '结果记在任务上');

  const again = await orch.runDueAutomations({ now: Date.now() });
  check(again.ran === 0, '同一分钟不会重复跑');
}
console.log(`\n自动化：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
