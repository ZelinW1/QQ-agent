'use strict';
// 「自动化」设置区：定时任务的增删改与立即执行。
//
// 为什么单独一个设置分区而不是塞进「工具与技能」：它回答的是另一个问题——
// 工具是"她能做什么"，自动化是"说好了什么时候做"。混在一起，用户会以为
// 定时任务也是一种能力开关。
//
// 与其它页一致的结构约定：render 只拼 HTML（纯函数、可单独测），
// 取数与交互在 load / bind 里；innerHTML 整块重建，事件每次重绑。

/** 服务端与本地共用的动作表。加动作时这里和服务端 `execAutomation` 一起改。 */
const AUTO_ACTIONS = [
  { id: 'send', label: '发一条消息', needText: true, needChat: true, hint: '到点直接发出去（不经过模型）' },
  { id: 'remember', label: '记一件事', needText: true, needChat: false, hint: '写进她的记忆；没有心智时会被跳过' },
  { id: 'plan', label: '安排一件要做的事', needText: true, needChat: false, hint: '挂一条意图，到点她会想起来' }
];

let autoTasks = [];
let autoError = '';
let autoLoading = false;

/** 本地时间显示（与设置页其它地方一致，不引第三方）。 */
function autoTime(ts) {
  const n = Number(ts) || 0;
  if (!n) return '—';
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function autoActionOf(id) {
  return AUTO_ACTIONS.find((a) => a.id === id) || AUTO_ACTIONS[0];
}

/** 一条任务卡片。抽成纯函数是为了能单独断言转义与状态文案。 */
function automationTaskRow(t = {}) {
  const a = autoActionOf(t.action);
  const enabled = t.enabled !== false;
  const failures = Number(t.failures) || 0;
  const last = String(t.lastResult || '');
  const bad = failures > 0 || (last && last !== 'ok');
  return `
    <div class="auto-row ${enabled ? '' : 'is-off'}" data-id="${esc(t.id || '')}">
      <div class="auto-main">
        <div class="auto-title">${esc(t.name || '(未命名)')}
          <span class="auto-cron">${esc(t.describe || t.cron || '')}</span>
        </div>
        <div class="auto-meta muted">
          ${esc(a.label)}${t.chatKey ? ` · ${esc(t.chatKey)}` : ''}
          · 下次 ${esc(autoTime(t.nextRunAt))}
          ${t.lastRunAt ? ` · 上次 ${esc(autoTime(t.lastRunAt))}` : ''}
          ${bad ? ` · <span class="auto-bad">${esc(last || `失败 ${failures} 次`)}</span>` : ''}
        </div>
      </div>
      <div class="auto-ops">
        <button class="btn-ghost" data-auto="run" data-id="${esc(t.id || '')}" ${enabled ? '' : 'disabled'}>立即执行</button>
        <button class="btn-ghost" data-auto="toggle" data-id="${esc(t.id || '')}">${enabled ? '停用' : '启用'}</button>
        <button class="btn-ghost danger" data-auto="del" data-id="${esc(t.id || '')}">删除</button>
      </div>
    </div>`;
}

/** 新建表单。动作不同要的字段不同，所以整块跟着下拉重渲染（见 bind）。 */
function automationFormHtml() {
  return `
    <div class="auto-form">
      <div class="auto-form-row">
        <label>名称
          <input id="auto-name" class="input" placeholder="例如：每天早上问早" maxlength="60" />
        </label>
        <label>时间（cron）
          <input id="auto-cron" class="input" placeholder="0 9 * * *" value="0 9 * * *" />
          <span id="auto-cron-hint" class="muted small">每天 09:00</span>
        </label>
      </div>
      <div class="auto-form-row">
        <label>做什么
          <select id="auto-action" class="input">
            ${AUTO_ACTIONS.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('')}
          </select>
        </label>
        <label>目标会话（发消息必填）
          <input id="auto-chat" class="input" placeholder="private:123456 / group:123456" />
        </label>
        <label id="auto-hours-wrap" class="hidden">几小时后（安排用）
          <input id="auto-hours" class="input" type="number" min="0.25" step="0.25" value="24" />
        </label>
      </div>
      <div class="auto-form-row">
        <label>内容
          <input id="auto-text" class="input" placeholder="要发的话 / 要记的事 / 要安排的提醒" maxlength="500" />
        </label>
      </div>
      <div class="auto-form-ops">
        <button class="btn" id="auto-create">新建任务</button>
        <span id="auto-form-error" class="auto-bad"></span>
      </div>
    </div>`;
}

/** 设置区主体。`stateFetcher` 用于触发一次异步刷新（渲染期间不 await）。 */
function renderAutomationSection() {
  const rows = autoTasks.length
    ? autoTasks.map(automationTaskRow).join('')
    : '<div class="empty-hint">还没有定时任务。下面建一个试试——比如每天早上九点跟她说声早安。</div>';
  return `
    <h3 id="settings-automation">自动化</h3>
    <div class="setcard">
      <div class="setcard-body">
        <p class="muted">
          到点就执行，<b>不受体力、作息、决策次数限制</b>——这是"说好了要做"，不是"她想做"。
          连续失败 3 次会自动停用，停用的任务会留在这里，方便你看见它为什么停了。
        </p>
        ${autoError ? `<div class="auto-bad">${esc(autoError)}</div>` : ''}
        <div class="auto-list">${autoLoading ? '<div class="muted">读取中…</div>' : rows}</div>
      </div>
    </div>
    <div class="setcard">
      <div class="setcard-head">新建任务</div>
      <div class="setcard-body">${automationFormHtml()}</div>
    </div>`;
}

/** 拉一次任务表。失败不抛：设置页其它区块仍要能看。 */
async function loadAutomations() {
  if (autoLoading) return;
  autoLoading = true;
  try {
    const d = await api('/api/automations');
    autoTasks = Array.isArray(d?.tasks) ? d.tasks : [];
    autoError = '';
  } catch (error) {
    autoError = `读取自动化任务失败：${error?.message || error}`;
  } finally {
    autoLoading = false;
  }
}

/** 进入该分区时调用：先渲染占位，拿到数据后重渲染。 */
function ensureAutomationsLoaded() {
  if (autoTasks.length || autoLoading) return Promise.resolve();
  return loadAutomations().then(() => {
    if (state.settingsSection === 'automation' && typeof renderSettings === 'function') renderSettings();
  });
}

/**
 * 绑事件。每次重渲染都重绑（innerHTML 整块重建）。
 * @param {HTMLElement} root 设置表单容器
 */
function bindAutomationEvents(root) {
  if (!root) return;

  const err = (msg) => {
    const el = root.querySelector('#auto-form-error');
    if (el) el.textContent = msg || '';
  };

  // 列表操作：委托，新增行不用重绑。
  // 但根节点（#settings-form）在多次渲染之间是**同一个元素**，每渲染一次就 addEventListener
  // 会叠加出 N 个处理器 —— 点一次"删除"会发 N 个请求。所以只绑一次，处理器读的是模块级
  // 的 autoTasks，重渲染后依然正确。
  if (!root.__autoDelegated) {
    root.__autoDelegated = true;
    root.addEventListener('click', async (event) => {
      const btn = event.target?.closest?.('[data-auto]');
      if (!btn) return;
      const id = btn.getAttribute('data-id') || '';
      const action = btn.getAttribute('data-auto');
      const task = autoTasks.find((t) => String(t.id) === id);
      if (!task) return;
      btn.disabled = true;
      try {
        if (action === 'del') {
          await api(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
        } else if (action === 'toggle') {
          await api(`/api/automations/${encodeURIComponent(id)}`, {
            method: 'POST',
            body: JSON.stringify({ enabled: task.enabled === false })
          });
        } else if (action === 'run') {
          const r = await api(`/api/automations/${encodeURIComponent(id)}/run`, { method: 'POST' });
          if (r && r.ok === false) err(r.error || '执行失败');
        }
        await loadAutomations();
        renderSettings();
      } catch (error) {
        err(String(error?.message || error));
        btn.disabled = false;
      }
    });
  }
  // cron 预览：边输入边校验，别等保存才报错
  const cronInput = root.querySelector('#auto-cron');
  if (cronInput) {
    const hint = root.querySelector('#auto-cron-hint');
    const preview = async () => {
      const expr = String(cronInput.value || '').trim();
      if (!expr) return;
      try {
        const d = await api(`/api/automations/preview?cron=${encodeURIComponent(expr)}`);
        if (hint) {
          hint.textContent = d?.ok ? `下一次：${autoTime(d.next?.[0])}` : (d?.error || '表达式非法');
          hint.classList.toggle('auto-bad', !d?.ok);
        }
      } catch { /* 预览失败不影响填写 */ }
    };
    cronInput.addEventListener('change', preview);
  }

  // 动作切换：显示/隐藏与它相关的字段
  const actionSel = root.querySelector('#auto-action');
  if (actionSel) {
    actionSel.addEventListener('change', () => {
      const a = autoActionOf(actionSel.value);
      const hoursWrap = root.querySelector('#auto-hours-wrap');
      if (hoursWrap) hoursWrap.classList.toggle('hidden', a.id !== 'plan');
      if (a.id === 'plan') {
        const chat = root.querySelector('#auto-chat');
        if (chat) chat.placeholder = 'private:123456（可选：跟谁有关）';
      }
    });
  }

  const createBtn = root.querySelector('#auto-create');
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      err('');
      const action = String(root.querySelector('#auto-action')?.value || 'send');
      const a = autoActionOf(action);
      const body = {
        name: String(root.querySelector('#auto-name')?.value || '').trim(),
        cron: String(root.querySelector('#auto-cron')?.value || '').trim(),
        action,
        chatKey: String(root.querySelector('#auto-chat')?.value || '').trim(),
        args: { text: String(root.querySelector('#auto-text')?.value || '').trim() }
      };
      if (action === 'plan') {
        body.args.inHours = Number(root.querySelector('#auto-hours')?.value) || 24;
      }
      if (a.needText && !body.args.text) return err('请填写内容');
      if (a.needChat && !body.chatKey) return err('发消息任务需要目标会话');
      createBtn.disabled = true;
      try {
        const r = await api('/api/automations', { method: 'POST', body: JSON.stringify(body) });
        if (r && r.ok === false) throw new Error(r.error || '创建失败');
        await loadAutomations();
        renderSettings();
      } catch (error) {
        err(String(error?.message || error));
        createBtn.disabled = false;
      }
    });
  }
}
