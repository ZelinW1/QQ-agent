// 自动化设置页渲染自测。
//
// 与 mind-ui-test 同一套办法：把 ui/app/14-automation.js 放进 vm 执行，
// 用假的 DOM/api，断言渲染结果、转义、以及两个曾经出过事的地方：
//   · 只自动拉一次（空列表不能让界面陷入"渲染→拉取→渲染"的死循环）；
//   · 界面文案不出现行话（不叫 cron，叫"什么时候执行"）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-ui-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const code = fs.readFileSync(path.join(ROOT, 'ui/app/14-automation.js'), 'utf8');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function makeSandbox({ tasks = [], apiImpl = null, chats = [] } = {}) {
  const calls = [];
  const rendered = { count: 0 };
  const sandbox = {
    console,
    esc,
    state: { settingsSection: 'automation', tab: 'settings', chats },
    api: async (p, opts) => {
      calls.push({ path: p, opts });
      if (apiImpl) {
        const r = await apiImpl(p, opts);
        if (r !== undefined) return r;
      }
      if (p === '/api/automations') return { ok: true, tasks };
      return { ok: true };
    },
    renderSettings: () => { rendered.count++; }
  };
  vm.createContext(sandbox);
  new vm.Script(code, { filename: '14-automation.js' }).runInContext(sandbox);
  return { sandbox, calls, rendered };
}

// ── 1. 空状态与文案 ─────────────────────────────────────────────────────
console.log('\n=== 1. 空状态 ===');
{
  const { sandbox } = makeSandbox({ tasks: [] });
  const html = sandbox.renderAutomationSection();
  check(html.includes('还没有定时任务'), '没有任务时给引导而不是空白');
  check(html.includes('不受体力和作息影响'), '说明它与自由时刻的区别');
  check(html.includes('连续失败 3 次会自动停用'), '说明失败退避（用户要知道任务会自己停）');
  check(!/\bcron\b/i.test(html), '界面上不出现 cron 这个行话');
}

// ── 2. 时间怎么拼 ───────────────────────────────────────────────────────
console.log('\n=== 2. 什么时候执行 ===');
{
  const { sandbox } = makeSandbox();
  check(sandbox.buildScheduleExpression({ freq: 'daily', time: '09:30' }) === '30 9 * * *', '每天 09:30 → 30 9 * * *');
  check(sandbox.buildScheduleExpression({ freq: 'weekly', time: '08:05', weekday: '3' }) === '5 8 * * 3', '每周三 08:05');
  check(sandbox.buildScheduleExpression({ freq: 'hourly', minute: '15' }) === '15 * * * *', '每小时的 15 分');
  check(sandbox.buildScheduleExpression({ freq: 'custom', custom: '0 21 * * 5' }) === '0 21 * * 5', '自定义原样使用');
  check(sandbox.buildScheduleExpression({ freq: 'daily', time: '23:59' }) === '59 23 * * *', '边界时间正确');

  const form = sandbox.automationFormHtml();
  const freqOptions = form.match(/<option value="(daily|weekly|hourly|custom)"/g) || [];
  check(freqOptions.length === 4, '四种频率都能选（默认不让人手写表达式）');
  check(form.includes('id="auto-time"') && form.includes('type="time"'), '默认给时间选择器，而不是文本框');
  check(!form.includes('id="auto-cron"'), '不再有名为 cron 的输入框');
}

// ── 3. 列表与状态 ───────────────────────────────────────────────────────
console.log('\n=== 3. 列表 ===');
{
  const tasks = [
    {
      id: 'au_1', name: '每日问候', describe: '每天 09:00', action: 'send',
      chatKey: 'private:1', enabled: true,
      nextRunAt: new Date(2026, 0, 2, 9, 0).getTime(), lastRunAt: 0, lastResult: 'ok', failures: 0
    },
    {
      id: 'au_2', name: '提醒喝水', describe: '每小时', action: 'remember',
      enabled: false, failures: 3, lastResult: '网络错误（连续失败 3 次，已停用）', nextRunAt: 0, lastRunAt: 0
    }
  ];
  const { sandbox } = makeSandbox({ tasks });
  await sandbox.loadAutomations();
  const html = sandbox.renderAutomationSection();
  check(html.includes('每日问候') && html.includes('每天 09:00'), '任务名与时序描述都渲染');
  check(html.includes('01-02 09:00'), '下次时间按本地时间显示');
  check(html.includes('is-off'), '停用的任务有视觉区分');
  check(html.includes('连续失败 3 次，已停用'), '停用原因显示在行里（不是消失）');
  check(html.includes('data-auto="run"') && html.includes('data-auto="del"'), '每行有立即执行与删除');
  check((html.match(/data-auto="run"[^>]*disabled/g) || []).length === 1, '停用任务不能"立即执行"');
}

// ── 4. 转义 ─────────────────────────────────────────────────────────────
console.log('\n=== 4. 转义 ===');
{
  const tasks = [{
    id: 'au_x', name: '<img src=x onerror=alert(1)>', describe: '<script>alert(1)</script>',
    action: 'send', chatKey: 'private:1', enabled: true, nextRunAt: 0, lastResult: '<b>炸</b>', failures: 1
  }];
  const { sandbox } = makeSandbox({ tasks });
  await sandbox.loadAutomations();
  const html = sandbox.renderAutomationSection();
  check(!html.includes('<img src=x'), '任务名被转义');
  check(!html.includes('<script>alert'), '时序描述被转义');
  check(html.includes('&lt;img'), '转义后的内容仍可见');
}

// ── 5. 只拉一次（防死循环）──────────────────────────────────────────────
console.log('\n=== 5. 只自动拉一次 ===');
{
  const { sandbox, calls, rendered } = makeSandbox({ tasks: [] });
  await sandbox.ensureAutomationsLoaded();
  await sandbox.ensureAutomationsLoaded();
  await sandbox.ensureAutomationsLoaded();
  const listCalls = calls.filter((c) => c.path === '/api/automations').length;
  check(listCalls === 1, `空列表也只拉一次（实际 ${listCalls} 次）`);
  check(rendered.count === 1, '拉完只重渲染一次');

  const withTasks = makeSandbox({ tasks: [{ id: 'a', name: 'x', action: 'send', enabled: true, nextRunAt: 0 }] });
  await withTasks.sandbox.ensureAutomationsLoaded();
  await withTasks.sandbox.ensureAutomationsLoaded();
  check(withTasks.calls.filter((c) => c.path === '/api/automations').length === 1, '有任务时也只拉一次');
}

// ── 6. 错误态 ───────────────────────────────────────────────────────────
console.log('\n=== 6. 取数失败 ===');
{
  const { sandbox } = makeSandbox({ apiImpl: (p) => { if (p === '/api/automations') throw new Error('后端 500'); return undefined; } });
  await sandbox.ensureAutomationsLoaded();
  const html = sandbox.renderAutomationSection();
  check(html.includes('读取自动化任务失败'), '取数失败给出可读提示，而不是空白');
  await sandbox.ensureAutomationsLoaded();
  check(sandbox.renderAutomationSection().includes('读取自动化任务失败'), '失败后也不再自动重试（避免死循环）');
}

console.log(`\n自动化页：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
