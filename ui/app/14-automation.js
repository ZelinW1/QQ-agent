'use strict';
// 「自动化」设置区：定时任务的增删改与立即执行。
//
// 为什么单独一个分区：它回答的是另一个问题——工具是"她能做什么"，
// 自动化是"说好了什么时候做"。混在一起，用户会以为定时任务也是一种能力开关。
//
// 交互约定（与「她」的设置项保持一致）：
//   · 不用行话：界面上不出现 cron / 表达式这类词，默认用"每天 / 每周 / 每小时"拼；
//     只有选了"自定义"才让人直接写时间段，并给出示例与预览。
//   · 改时间不靠猜：每次改动都实时给出"下次什么时候跑"。
//   · 渲染是纯函数（可单独测），取数与交互在 load / bind 里。

const AUTO_ACTIONS = [
  { id: 'send', label: '发一条消息', needText: true, needChat: true },
  { id: 'remember', label: '记一件事', needText: true, needChat: false },
  { id: 'plan', label: '安排一件要做的事', needText: true, needChat: false }
];

const AUTO_WEEKDAYS = [
  ['1', '周一'], ['2', '周二'], ['3', '周三'], ['4', '周四'],
  ['5', '周五'], ['6', '周六'], ['0', '周日']
];

let autoTasks = [];
let autoError = '';
let autoLoading = false;
let autoTried = false;   // 只自动拉一次：空列表也是结果，不能每次渲染都重拉
let autoDraft = null;    // 新建表单的本地状态（切换频率时保留已填内容）

function autoDefaultDraft() {
  return { freq: 'daily', time: '09:00', weekday: '1', minute: '0', custom: '0 9 * * *' };
}

/** 本地时间显示（与设置页其它地方一致）。 */
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

/**
 * 把"每天 / 每周 / 每小时 / 自定义"拼成时间段写法。
 * 抽成纯函数是为了能单独测：这是界面上唯一需要"算"的地方。
 */
function buildScheduleExpression(draft = {}) {
  const d = { ...autoDefaultDraft(), ...(draft || {}) };
  const [hh, mm] = String(d.time || '09:00').split(':');
  const hour = Math.min(23, Math.max(0, Number(hh) || 0));
  const minute = Math.min(59, Math.max(0, Number(mm) || 0));
  if (d.freq === 'hourly') return `${Math.min(59, Math.max(0, Number(d.minute) || 0))} * * * *`;
  if (d.freq === 'weekly') return `${minute} ${hour} * * ${AUTO_WEEKDAYS.some(([v]) => v === String(d.weekday)) ? d.weekday : '1'}`;
  if (d.freq === 'custom') return String(d.custom || '').trim();
  return `${minute} ${hour} * * *`;
}

/** 一条任务。抽成纯函数：能单独断言转义、状态文案与按钮可用性。 */
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
          <span class="mind-chip">${esc(t.describe || '')}</span>
        </div>
        <div class="auto-meta muted">
          ${esc(a.label)}${t.chatKey ? ` · ${esc(t.chatKey)}` : ''}
          · 下次 ${esc(autoTime(t.nextRunAt))}
          ${t.lastRunAt ? ` · 上次 ${esc(autoTime(t.lastRunAt))}` : ''}
          ${bad ? ` · <span class="auto-bad">${esc(last || `连续失败 ${failures} 次`)}</span>` : ''}
        </div>
      </div>
      <div class="auto-ops">
        <button class="btn btn-small" data-auto="run" data-id="${esc(t.id || '')}" ${enabled ? '' : 'disabled'}>立即执行</button>
        <button class="btn btn-small" data-auto="toggle" data-id="${esc(t.id || '')}">${enabled ? '停用' : '启用'}</button>
        <button class="btn btn-small" data-auto="del" data-id="${esc(t.id || '')}">删除</button>
      </div>
    </div>`;
}

/** 新建表单。表单结构跟着"什么时候执行"的选择变。 */
function automationFormHtml() {
  const d = { ...autoDefaultDraft(), ...(autoDraft || {}) };
  const chats = (typeof state !== 'undefined' && Array.isArray(state.chats)) ? state.chats : [];
  const chatOptions = chats.slice(0, 80).map((c) => {
    const key = String(c.chatKey || c.key || '');
    const name = String(c.name || c.title || key);
    return `<option value="${esc(key)}">${esc(name)}</option>`;
  }).join('');

  const timeRow = d.freq === 'hourly'
    ? `<label>每小时的第几分钟
         <input type="number" id="auto-minute" min="0" max="59" value="${esc(d.minute)}" />
       </label>`
    : (d.freq === 'custom'
      ? `<label>直接写时间段
           <input type="text" id="auto-custom" value="${esc(d.custom)}" placeholder="0 9 * * *" />
           <span class="hint" id="auto-when-hint">五段依次是：分 时 日 月 周。例如 0 9 * * * = 每天 9:00</span>
         </label>`
      : `<label>几点
           <input type="time" id="auto-time" value="${esc(d.time)}" />
           <span class="hint" id="auto-when-hint"></span>
         </label>`);

  const weekdayRow = d.freq === 'weekly'
    ? `<label>星期几
         <select id="auto-weekday">
           ${AUTO_WEEKDAYS.map(([v, label]) => `<option value="${v}"${String(d.weekday) === v ? ' selected' : ''}>${label}</option>`).join('')}
         </select>
       </label>`
    : '';

  return `
    <div class="mind-form auto-form">
      <div class="mind-grid">
        <label>名称
          <input type="text" id="auto-name" placeholder="例如：每天早上问声好" maxlength="60" />
        </label>
        <label>什么时候执行
          <select id="auto-freq">
            <option value="daily"${d.freq === 'daily' ? ' selected' : ''}>每天</option>
            <option value="weekly"${d.freq === 'weekly' ? ' selected' : ''}>每周</option>
            <option value="hourly"${d.freq === 'hourly' ? ' selected' : ''}>每小时</option>
            <option value="custom"${d.freq === 'custom' ? ' selected' : ''}>自定义</option>
          </select>
          <span class="hint">到点会自动执行一次；不会因为体力和作息跳过。</span>
        </label>
        ${weekdayRow}
        ${timeRow}
      </div>
      <div class="mind-grid">
        <label>做什么
          <select id="auto-action">
            ${AUTO_ACTIONS.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('')}
          </select>
        </label>
        <label>发给谁
          <input type="text" id="auto-chat" list="auto-chat-list" placeholder="从下面选，或填 private:123456" />
          <datalist id="auto-chat-list">${chatOptions}</datalist>
          <span class="hint">只发消息时需要：私聊填 private:QQ号，群填 group:群号。</span>
        </label>
        <label id="auto-hours-wrap" class="hidden">几小时后提醒（安排用）
          <input type="number" id="auto-hours" min="0.25" step="0.25" value="24" />
        </label>
      </div>
      <label>内容
        <input type="text" id="auto-text" placeholder="要发的话 / 要记的事 / 要安排的提醒" maxlength="500" />
      </label>
      <div class="mind-actions">
        <button class="btn btn-primary btn-small" id="auto-create">新建任务</button>
        <span class="muted" id="auto-form-error"></span>
      </div>
    </div>`;
}

/** 设置区主体。 */
function renderAutomationSection() {
  const rows = autoTasks.length
    ? autoTasks.map(automationTaskRow).join('')
    : '<div class="mind-empty">还没有定时任务。下面加一个试试——比如每天九点跟她说声早安。</div>';
  return `
    <h3 id="settings-automation">自动化</h3>
    <div class="setcard">
      <div class="setcard-body">
        <p class="muted">
          到点就执行，<b>不受体力和作息影响</b>；这是"说好了要做"，不是"她想做"。
          连续失败 3 次会自动停用，停用的任务仍留在这里，方便你看到它为什么停了。
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
    autoTried = true;
  }
}

/**
 * 进入该分区时调用：先渲染占位，拿到数据后重渲染。
 *
 * **只自动拉一次**：空列表也是结果。以前这里判断 `autoTasks.length`，
 * 于是"没有任务"的用户每次渲染都重新拉一次、拉完又渲染 —— 无限循环，界面直接卡死。
 */
function ensureAutomationsLoaded() {
  if (autoTried || autoLoading) return Promise.resolve();
  return loadAutomations().then(() => {
    if (state.settingsSection === 'automation' && typeof renderSettings === 'function') renderSettings();
  });
}

/** 从表单读出"什么时候执行"的草稿。 */
function readScheduleDraft(root) {
  const val = (id) => root.querySelector(`#${id}`)?.value;
  return {
    freq: val('auto-freq') || 'daily',
    time: val('auto-time') || '09:00',
    weekday: val('auto-weekday') || '1',
    minute: val('auto-minute') || '0',
    custom: val('auto-custom') || ''
  };
}

/** 用当前表单内容刷新"下次什么时候跑"的提示。 */
async function refreshScheduleHint(root) {
  const hint = root.querySelector('#auto-when-hint');
  if (!hint) return;
  const expr = buildScheduleExpression(readScheduleDraft(root));
  if (!expr) { hint.textContent = ''; return; }
  try {
    const d = await api('/api/automations/preview?cron=' + encodeURIComponent(expr));
    hint.textContent = d?.ok
      ? `下次：${autoTime(d.next?.[0])}${d.describe ? `（${d.describe}）` : ''}`
      : `这个时间写法不成立：${d?.error || '请检查'}`;
    hint.classList.toggle('auto-bad', !d?.ok);
  } catch {
    hint.textContent = '';
  }
}

/**
 * 绑事件。每次重渲染都调用；其中根节点的委托只绑一次。
 * @param {HTMLElement} root 设置表单容器
 */
function bindAutomationEvents(root) {
  if (!root) return;

  const err = (msg) => {
    const el = root.querySelector('#auto-form-error');
    if (el) el.textContent = msg || '';
  };

  // 设置页在 #settings-form 上挂了 input/change 监听（标记"设置已改动"→ 防抖保存
  // → 可能重建表单）。自动化表单里的输入不是配置项，打一个字就触发保存/重建会
  // 让人没法正常填写，所以在这里把事件拦在表单内部。
  const formEl = root.querySelector('.auto-form');
  if (formEl && !formEl.__autoIsolated) {
    formEl.__autoIsolated = true;
    for (const ev of ['input', 'change']) {
      formEl.addEventListener(ev, (event) => event.stopPropagation());
    }
  }

  // 列表操作：委托在 #settings-form 上。该元素跨渲染复用，每渲染绑一次会叠加出
  // N 个处理器（点一次删除发 N 个请求），所以只绑一次；处理器读模块级 autoTasks。
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

  // 频率切换：换一组字段；草稿保存在模块里，切回来不丢已填内容
  const freqSel = root.querySelector('#auto-freq');
  if (freqSel) {
    freqSel.addEventListener('change', () => {
      autoDraft = { ...readScheduleDraft(root), freq: freqSel.value };
      renderSettings();
    });
  }

  // 时间/星期/自定义输入：实时刷新"下次什么时候跑"
  for (const id of ['auto-time', 'auto-weekday', 'auto-minute', 'auto-custom']) {
    const el = root.querySelector(`#${id}`);
    if (!el) continue;
    el.addEventListener('change', () => {
      autoDraft = { ...readScheduleDraft(root) };
      refreshScheduleHint(root);
    });
  }

  // 动作切换：只显示与它相关的字段
  const actionSel = root.querySelector('#auto-action');
  if (actionSel) {
    actionSel.addEventListener('change', () => {
      const a = autoActionOf(actionSel.value);
      const hoursWrap = root.querySelector('#auto-hours-wrap');
      if (hoursWrap) hoursWrap.classList.toggle('hidden', a.id !== 'plan');
      const chat = root.querySelector('#auto-chat');
      if (chat) {
        chat.placeholder = a.id === 'plan'
          ? '从下面选，或填 private:123456（可选：跟谁有关）'
          : '从下面选，或填 private:123456 / group:123456';
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
        cron: buildScheduleExpression(readScheduleDraft(root)),
        action,
        chatKey: String(root.querySelector('#auto-chat')?.value || '').trim(),
        args: { text: String(root.querySelector('#auto-text')?.value || '').trim() }
      };
      if (action === 'plan') body.args.inHours = Number(root.querySelector('#auto-hours')?.value) || 24;
      if (a.needText && !body.args.text) return err('请填写内容');
      if (a.needChat && !body.chatKey) return err('发消息任务需要选一个会话');
      if (!body.cron) return err('请选择什么时候执行');
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
