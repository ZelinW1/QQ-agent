// 自动化设置页渲染自测。
//
// 与 mind-ui-test 同一套办法：把 ui/app/14-automation.js 放进 vm 执行，
// 用假的 DOM/api，断言渲染结果与转义。检查的是"拼出来的 HTML 对不对"，
// 而不是浏览器里的最终观感 —— 后者得靠人看，前者能进 CI。
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

function makeSandbox({ tasks = [], apiImpl = null } = {}) {
  const calls = [];
  const rendered = { count: 0 };
  const sandbox = {
    console,
    esc,
    state: { settingsSection: 'automation', tab: 'settings' },
    api: async (p, opts) => {
      calls.push({ path: p, opts });
      // 注入的 api 优先：错误路径的测试要能让它抛
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

// ── 1. 空状态 ───────────────────────────────────────────────────────────
console.log('\n=== 1. 空状态 ===');
{
  const { sandbox } = makeSandbox({ tasks: [] });
  const html = sandbox.renderAutomationSection();
  check(html.includes('还没有定时任务'), '没有任务时给引导而不是空白表格');
  check(html.includes('连续失败 3 次会自动停用'), '说明失败退避（用户要知道任务会自己停）');
  check(html.includes('不受体力、作息、决策次数限制'), '说明它与自由时刻的区别');
  check(html.includes('id="auto-cron"') && html.includes('value="0 9 * * *"'), '默认给一个能跑的 cron 示例');
}

// ── 2. 列表渲染 ─────────────────────────────────────────────────────────
console.log('\n=== 2. 列表 ===');
{
  const tasks = [
    {
      id: 'au_1', name: '每日问候', cron: '0 9 * * *', describe: '每天 09:00',
      action: 'send', chatKey: 'private:1', enabled: true,
      nextRunAt: new Date(2026, 0, 2, 9, 0).getTime(),
      lastRunAt: 0, lastResult: 'ok', failures: 0
    },
    {
      id: 'au_2', name: '提醒喝水', cron: '*/30 * * * *', describe: '*/30 * * * *',
      action: 'remember', enabled: false, failures: 3, lastResult: '网络错误（连续失败 3 次，已停用）',
      nextRunAt: 0, lastRunAt: 0
    }
  ];
  const { sandbox } = makeSandbox({ tasks });
  await sandbox.loadAutomations();
  const html = sandbox.renderAutomationSection();
  check(html.includes('每日问候') && html.includes('每天 09:00'), '任务名与时序描述都渲染');
  check(html.includes('01-02 09:00'), `下次时间按本地时间显示（${(html.match(/下次 [^<·]+/) || [''])[0]}）`);
  check(html.includes('is-off'), '停用的任务有视觉区分');
  check(html.includes('连续失败 3 次，已停用'), '停用原因显示在行里（不是消失）');
  check(html.includes('data-auto="run"') && html.includes('data-auto="del"'), '每行有立即执行与删除');
  check((html.match(/data-auto="run"[^>]*disabled/g) || []).length === 1, '停用任务不能"立即执行"');
}

// ── 3. 转义 ─────────────────────────────────────────────────────────────
console.log('\n=== 3. 转义 ===');
{
  const tasks = [{
    id: 'au_x', name: '<img src=x onerror=alert(1)>', cron: '* * * * *',
    describe: '<script>alert(1)</script>', action: 'send', chatKey: 'private:1',
    enabled: true, nextRunAt: 0, lastResult: '<b>炸</b>', failures: 1
  }];
  const { sandbox } = makeSandbox({ tasks });
  await sandbox.loadAutomations();
  const html = sandbox.renderAutomationSection();
  check(!html.includes('<img src=x'), '任务名被转义（不会执行注入的标签）');
  check(!html.includes('<script>alert'), 'cron 描述被转义');
  check(html.includes('&lt;img'), '转义后的内容仍可见');
}

// ── 4. 表单与动作差异 ───────────────────────────────────────────────────
console.log('\n=== 4. 表单 ===');
{
  const { sandbox } = makeSandbox();
  const form = sandbox.automationFormHtml();
  for (const id of ['auto-name', 'auto-cron', 'auto-action', 'auto-chat', 'auto-text']) {
    check(form.includes(`id="${id}"`), `表单有 ${id}`);
  }
  check(form.includes('value="send"') && form.includes('value="remember"') && form.includes('value="plan"'),
    '三个动作都在下拉里（与服务端 execAutomation 一致）');
  check(form.includes('few-hours') === false && form.includes('type="number"'), '安排用的"几小时后"是个数字输入');
}

// ── 5. 拉取与错误 ───────────────────────────────────────────────────────
console.log('\n=== 5. 拉取 ===');
{
  const { sandbox, rendered } = makeSandbox({
    apiImpl: (p) => (p === '/api/automations' ? { ok: true, tasks: [] } : { ok: true })
  });
  await sandbox.ensureAutomationsLoaded();
  check(rendered.count >= 1, '拿数据后触发一次重渲染');

  const bad = makeSandbox({ apiImpl: (p) => { if (p === '/api/automations') throw new Error('后端 500'); return { ok: true }; } });
  await bad.sandbox.ensureAutomationsLoaded();
  const html = bad.sandbox.renderAutomationSection();
  check(html.includes('读取自动化任务失败'), '取数失败给出可读提示，而不是空白');
}

console.log(`\n自动化页：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
