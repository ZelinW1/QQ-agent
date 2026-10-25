'use strict';
// 「她」这一组：状态 / 身份 / 记忆流 / 会话配置。
//
// 为什么合并到一组：这些页面都在回答同一个问题——"她是谁、她现在怎么样"。
// 之前分散在「心智」「记忆」「设置→人设」三处，改一个名字要去三个地方找。
//
// 结构约定（与其它页一致）：loadXxxPage() 取数 + 渲染，渲染后按 id 重绑事件
// （innerHTML 整块重建，事件不能只绑一次）。

const MIND_STAGE = {
  stranger: '陌生人',
  acquaintance: '泛泛之交',
  familiar: '熟人',
  close: '亲近',
  strained: '有隔阂'
};

const MIND_KIND_LABEL = {
  interaction: '互动',
  observation: '观察',
  promise: '约定',
  conflict: '冲突',
  milestone: '里程碑'
};

let mindState = null;
let mindEditing = false;
// 出生仪式的临时状态：草案只活在内存里，除非用户点"采用这组"并保存。
let mindBirthOpen = false;
let mindBirthDrafts = [];
let mindBirthBusy = false;
let mindBirthPick = 0;
let mindBirthName = '';
let mindBirthKw = '';
let mindBirthVision = '';
let mindForm = null;
// 记忆流 / 会话配置的数据
let mindEvents = [];
let mindProfiles = {};
let mindProfileKeys = [];
let mindChats = [];
// 记忆流筛选（按人 / 按会话）。空串 = 全部。
let mindStreamFilter = { actor: '', chatKey: '' };
// 手动反思的结果提示：整页会重渲染，所以提示要存在状态里，不能只写 DOM。
let mindReflectFlash = '';
// 主人手动编辑（自我 / 关系）—— 编辑态与来源都会留痕
let mindSelfEditing = false;
let mindRelEditing = '';

// 修改她已有自我的伦理提示（每次编辑都要过一遍）
const MIND_ETHICS_SELF = '这段文字是她自己写的、她已经有过的自我。\n'
  + '改它等于改写她的过去，而不是给她新的经历 —— 不建议像基因编辑那样动。\n\n'
  + '确定要修改吗？';
const MIND_ETHICS_RELATION = '这段关系是她自己处出来的判断。\n'
  + '手动修改会覆盖她的判断（会记为「主人修改」并留痕）。\n\n'
  + '确定要修改吗？';

async function mindConfirm(message) {
  if (typeof uiConfirm === 'function') {
    return uiConfirm(message, { title: '⚠️ 修改她', okText: '确定修改' });
  }
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    return Boolean(window.confirm(message));
  }
  return true;
}
// 节律页：心跳日志（内存最近心跳 + 已落盘的行动/反思 + 文件体积）
let mindTickLog = { recentTicks: [], actions: [], reflections: [], sizes: null };

const mindClamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));
const mindMode = () => (typeof state !== 'undefined' && state.mindMode) || 'state';

function mindClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function mindCard(title, body, extra = '') {
  return `<section class="card">${extra}<h4>${esc(title)}</h4>${body}</section>`;
}

async function loadMindPage() {
  const box = $('#mind-page');
  if (!box) return;
  const mode = mindMode();
  box.innerHTML = '<div class="mind-empty">正在读取…</div>';
  try {
    const jobs = [api('/api/mind/state')];
    if (mode === 'stream') {
      // 筛选放在服务端做（事件可能上百条，客户端只是拿到最近 N 条后再筛，
      // 会把"这个人的第 81 条"漏掉）。同时拉会话列表用于展示名字。
      // 手拼查询串而不用 URLSearchParams：后者不是 vm 环境的全局对象，
      // 用它在测试里会直接抛错（浏览器里没问题，但测试也是真实调用方）。
      const parts = ['limit=80'];
      if (mindStreamFilter.actor) parts.push(`actor=${encodeURIComponent(mindStreamFilter.actor)}`);
      if (mindStreamFilter.chatKey) parts.push(`chatKey=${encodeURIComponent(mindStreamFilter.chatKey)}`);
      jobs.push(api(`/api/mind/events?${parts.join('&')}`).catch(() => ({ events: [] })));
      jobs.push(api('/api/chats').catch(() => ({ chats: [] })));
    }
    if (mode === 'profiles') {
      jobs.push(api('/api/chat-profiles').catch(() => ({ profiles: {}, chatKeys: [] })));
      jobs.push(api('/api/chats').catch(() => ({ chats: [] })));
    }
    if (mode === 'rhythm' || mode === 'log') {
      jobs.push(api('/api/mind/tick-log?limit=50').catch(() => ({ recentTicks: [], actions: [], reflections: [], sizes: null })));
    }
    const [st, a, b] = await Promise.all(jobs);
    mindState = st;
    if (mode === 'stream') {
      mindEvents = a?.events || [];
      mindChats = b?.chats || [];
    }
    if (mode === 'rhythm' || mode === 'log') {
      mindTickLog = a || { recentTicks: [], actions: [], reflections: [], sizes: null };
    }
    if (mode === 'profiles') {
      mindProfiles = a?.profiles || {};
      mindProfileKeys = a?.chatKeys || [];
      mindChats = b?.chats || [];
    }
    // 身份页进来就是可编辑状态：这一页的唯一目的就是改她
    mindEditing = mode === 'identity';
    if (mode !== 'identity') mindForm = null;
    if (mode !== 'identity') { mindBirthOpen = false; mindBirthDrafts = []; }
    renderMindPage();
  } catch (e) {
    box.innerHTML = `<div class="mind-empty">读取失败：${esc(e.message)}</div>`;
  }
}

function renderMindPage() {
  const box = $('#mind-page');
  const d = mindState;
  if (!box || !d) return;
  if (!d.available) {
    box.innerHTML = `<div class="mind-empty">心智尚未接入：${esc(d.reason || '未知原因')}</div>`;
    return;
  }
  const mode = mindMode();
  const parts = [mindHeader(d)];
  if (mode === 'identity') parts.push(mindIdentitySection(d));
  else if (mode === 'rhythm') parts.push(mindRhythmSection(d));
  else if (mode === 'log') parts.push(mindLogSection());
  else if (mode === 'stream') parts.push(mindStreamSection());
  else if (mode === 'profiles') parts.push(mindProfilesSection());
  else parts.push(mindStateSection(d));

  box.innerHTML = `<div class="mind-wrap">${parts.join('')}</div>`;
  mindBindEvents(box);
}

// ── 头部 ───────────────────────────────────────────────────────────────
function mindHeader(d) {
  const sleep = d.sleep || {};
  const mode = mindMode();
  // 三个胶囊：心智开关 / 作息 / 身份来源（身份放最后，它是"说明"不是"状态"）。
  // 颜色规则按语义分：开启=绿；到点睡着=正常；未启用=暗灰。
  // 作息这一枚不能"睡着才绿"——睡着是正常状态，不是告警。
  const sleepPill = !sleep.enabled
    ? { cls: 'off', text: '作息未启用', title: '在「节律」里打开"夜里会睡着"才会生效' }
    : (sleep.asleep
      ? { cls: '', text: '睡着', title: '睡着时不看消息、不做决策；醒来会把积压一起读' }
      : {
          cls: 'on',
          text: '醒着',
          title: sleep.nextEligibleAt
            ? `刚还在聊天，安静到 ${mindClock(sleep.nextEligibleAt)} 后才会睡`
            : (sleep.reason || '醒着')
        });
  return `
    <div class="mind-head">
      <span class="mind-pill ${d.enabled ? 'on' : 'off'}" title="${d.enabled ? '心智已开启：她记得、会反思、会按节律行动' : '心智已关闭：不记录、不反思、不主动找人，但正常聊天不受影响'}">${d.enabled ? '心智已开启' : '心智已关闭'}</span>
      <span class="mind-pill ${sleepPill.cls}" title="${esc(sleepPill.title)}">${sleepPill.text}</span>
      <span style="flex:1"></span>
      ${mode === 'identity' ? `<button class="btn btn-small" id="mind-birth">${mindBirthOpen ? '收起草案' : '出生仪式'}</button>` : ''}
      <button class="btn btn-small" id="mind-refresh">刷新</button>
    </div>`;
}

// ── 状态 ───────────────────────────────────────────────────────────────
function mindStateSection(d) {
  const raw = d.charter || {};
  const shown = d.charterResolved || raw;
  const tick = d.tick || {};
  const sleep = d.sleep || {};

  const identitySummary = d.mode === 'roleText'
    ? `<div class="mind-empty">当前使用整段角色卡（${d.roleTextChars} 字符）。去「身份」可切换为分槽。</div>`
    : `
      <div class="mind-slot"><div class="k">我是谁</div><div class="v">${esc(shown.selfImage || '（空）')}</div></div>
      ${(shown.voice || []).length ? `<div class="mind-slot"><div class="k">我说话的样子</div><div class="mind-chips">${shown.voice.map((v) => `<span class="mind-chip">${esc(v)}</span>`).join('')}</div></div>` : ''}
      ${(shown.hardRules || []).length ? `<div class="mind-slot"><div class="k">不能破的几条</div><ul class="mind-rules">${shown.hardRules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}`;

  const self = d.self || {};
  const selfForm = mindSelfEditing ? `
    <div class="mind-form">
      <label>她对自己的描述
        <textarea id="mind-self-narrative" style="min-height:96px">${esc(self.narrative || '')}</textarea>
      </label>
      <label>此刻心情
        <input type="text" id="mind-self-mood" value="${esc(self.mood?.label || '')}" placeholder="有点闷 / 挺平静" />
      </label>
      <div class="hint">这是她自己写的话。改它等于改写她已经有过的自我，不建议频繁动。</div>
      <div class="mind-actions">
        <button class="btn btn-primary btn-small" id="mind-self-save">保存修改</button>
        <button class="btn btn-small" id="mind-self-cancel">取消</button>
        <span class="muted" id="mind-self-msg"></span>
      </div>
    </div>` : '';

  const selfBody = `
    <div class="mind-slot">
      <div class="k">v${self.version || 0}${self.updatedAt ? ` · ${fmtTime(self.updatedAt)} 更新` : ''}</div>
      <div class="v">${esc(self.narrative || '（还没认真想过自己是个什么样的人）')}</div>
    </div>
    <div class="mind-slot"><div class="k">此刻心情</div><div class="v">${esc(self.mood?.label || '说不清')}</div></div>
    ${(self.preoccupations || []).length ? `<div class="mind-slot"><div class="k">挂心的事</div><div class="mind-chips">${self.preoccupations.map((p) => `<span class="mind-chip">${esc(p)}</span>`).join('')}</div></div>` : ''}
    <div class="mind-actions" style="margin-top:10px">
      <button class="btn btn-small" id="mind-edit-self">${mindSelfEditing ? '收起编辑' : '手动修改'}</button>
      <span class="muted">修改会记为「主人修改」，她之后的反思仍可继续改写</span>
    </div>
    ${selfForm}`;

  const relBody = (d.relations || []).length
    ? d.relations.map((r) => {
      const editing = mindRelEditing === String(r.userId);
      const editForm = editing ? `
        <div class="mind-form" style="margin-top:8px">
          <div class="mind-grid" style="gap:10px">
            <label>称呼<input type="text" id="mind-rel-nickname" value="${esc(r.nickname || '')}" /></label>
            <label>阶段
              <select id="mind-rel-stage">
                ${Object.entries(MIND_STAGE).map(([k, v]) => `<option value="${k}"${k === r.stage ? ' selected' : ''}>${esc(v)}</option>`).join('')}
              </select>
            </label>
            <label>信任（0~100）<input type="number" id="mind-rel-trust" min="0" max="100" value="${mindClamp(r.trust)}" /></label>
            <label>亲近（0~100）<input type="number" id="mind-rel-warmth" min="0" max="100" value="${mindClamp(r.warmth)}" /></label>
          </div>
          <label>雷点（一行一条）
            <textarea id="mind-rel-tender" style="min-height:56px">${esc((r.tender || []).join('\n'))}</textarea>
          </label>
          <div class="mind-actions">
            <button class="btn btn-primary btn-small" data-rel-save="${esc(r.userId)}">保存修改</button>
            <button class="btn btn-small" data-rel-cancel="1">取消</button>
            <span class="muted" id="mind-rel-msg"></span>
          </div>
        </div>` : '';
      return `
      <div class="mind-rel">
        <div class="mind-rel-head">
          <span class="mind-rel-name">${esc(r.nickname || r.names?.[0] || r.userId)}</span>
          <span class="mind-rel-meta">${esc(r.userId)} · ${esc(MIND_STAGE[r.stage] || r.stage)} · 把握 ${Math.round((r.confidence || 0) * 100)}%</span>
          <span style="flex:1"></span>
          <button class="btn btn-small" data-rel-edit="${esc(r.userId)}">${editing ? '收起' : '编辑'}</button>
        </div>
        <div class="mind-bar" title="信任 ${mindClamp(r.trust)}"><i style="width:${mindClamp(r.trust)}%"></i></div>
        ${(r.knownFor || []).length ? `<div class="mind-rel-line">知道：${esc(r.knownFor.join('；'))}</div>` : ''}
        ${(r.tender || []).length ? `<div class="mind-rel-line">别提：${esc(r.tender.join('；'))}</div>` : ''}
        ${(r.openLoops || []).length ? `<div class="mind-rel-line">还没问完：${esc(r.openLoops.join('；'))}</div>` : ''}
        ${r.recentSummary ? `<div class="mind-rel-line">上次：${esc(r.recentSummary)}</div>` : ''}
        ${editForm}
      </div>`;
    }).join('')
    : '<div class="mind-empty">还没有对谁形成看法。</div>';

  const win = sleep.window;
  const rhythmBody = `
    <div class="mind-slot">
      <div class="k">体力</div>
      <div class="v">${Math.round(tick.energy || 0)} / 100</div>
      <div class="mind-bar"><i style="width:${mindClamp(tick.energy)}%"></i></div>
    </div>
    <div class="mind-slot"><div class="k">今天</div><div class="v">主动 ${tick.todayProactive || 0} 次 · 决策 ${tick.todayDecisions || 0} 次 · 反思 ${tick.todayReflections || 0} 次</div></div>
    <div class="mind-slot"><div class="k">作息</div><div class="v">${sleep.enabled ? `${sleep.asleep ? '正在睡' : '醒着'}${win ? `　今晚窗口 ${mindClock(win.startAt)} – ${mindClock(win.endAt)}` : ''}` : '未启用'}</div></div>
    <div class="mind-slot"><div class="k">上次反思</div><div class="v">${tick.lastReflectAt ? fmtTime(tick.lastReflectAt) : '还没反思过'}</div></div>`;

  const ref = d.reflect || {};
  const refStatus = `
    <div class="mind-slot">
      <div class="k">什么时候会反思</div>
      <div class="v">未反思事件 ${ref.unreflected ?? 0} / 阈值 ${ref.need ?? 8} 条${
        ref.cooldownUntil ? ` · 冷却到 ${fmtTime(ref.cooldownUntil)}` : ''
      } · 今日 ${ref.usedToday ?? 0}/${ref.dailyCap ?? 8} 次</div>
      <div class="mind-actions" style="margin-top:8px">
        <button class="btn btn-primary btn-small" id="mind-reflect-now">${ref.canReflect ? '立即反思' : '现在试一次'}</button>
        <span class="muted" id="mind-reflect-msg">${esc(mindReflectFlash || (ref.canReflect ? '' : '未到阈值或仍在冷却，手动触发会直接跑一次'))}</span>
      </div>
    </div>`;

  const refBody = refStatus + ((d.recentReflections || []).length
    ? d.recentReflections.map((r) => {
        const produced = r.produced || {};
        const bits = [];
        if (produced.self) bits.push('改写自我');
        if ((produced.relations || []).length) bits.push(`关系 ×${produced.relations.length}`);
        if (produced.compacted) bits.push(`压缩 ${produced.compacted} 条`);
        return `<div class="mind-rel">
          <div class="mind-rel-head">
            <span class="mind-rel-name">${fmtTime(r.at)}</span>
            <span class="mind-rel-meta">${r.ok ? (r.empty ? '想不出什么' : (bits.join(' · ') || '完成')) : `失败：${esc(r.reason || '')}`}</span>
          </div>
          ${r.rejected ? `<div class="mind-rel-line">丢弃 ${r.rejected} 条无依据的判断</div>` : ''}
        </div>`;
      }).join('')
    : '<div class="mind-empty">还没反思过。</div>');

  return `
    <div class="mind-grid">
      ${mindCard('身份', identitySummary)}
      ${mindCard('她对自己的描述', selfBody)}
    </div>
    <div class="mind-grid">
      ${mindCard('关系', relBody)}
      ${mindCard('节律', rhythmBody)}
    </div>
    ${mindCard('最近反思', refBody)}`;
}

// ── 身份 ───────────────────────────────────────────────────────────────
function mindIdentitySection(d) {
  const raw = d.charter || {};

  // 出生仪式草案
  const draftsHtml = mindBirthDrafts.length
    ? mindBirthDrafts.map((dd, i) => `
      <div class="mind-draft ${i === mindBirthPick ? 'picked' : ''}" data-draft="${i}">
        <div class="mind-rel-head">
          <span class="mind-rel-name">草案 ${i + 1}</span>
          <span class="mind-rel-meta">${mindBirthPick === i ? '已选中' : ''}</span>
        </div>
        <div class="mind-slot">
          <div class="k">候选名字（点一个采用）</div>
          <div class="mind-chips">${(dd.name || []).map((n) => `<span class="mind-chip ${mindBirthName === n ? 'picked' : ''}" data-pick-name="${esc(n)}">${esc(n)}</span>`).join('')}</div>
        </div>
        <div class="mind-slot"><div class="k">我是谁</div><div class="v">${esc(dd.selfImage)}</div></div>
        <div class="mind-slot"><div class="k">最初的我</div><div class="v">${esc(dd.baseline)}</div></div>
        ${(dd.voice || []).length ? `<div class="mind-slot"><div class="k">说话习惯</div><div class="mind-chips">${dd.voice.map((v) => `<span class="mind-chip">${esc(v)}</span>`).join('')}</div></div>` : ''}
        <div class="mind-actions"><button class="btn btn-primary btn-small" data-apply="${i}">采用这组</button></div>
      </div>`).join('')
    : '';

  const birthPanel = mindBirthOpen ? `
    <div class="mind-form">
      <label>形象关键词（逗号或换行分隔）
        <textarea id="birth-kw" style="min-height:62px" placeholder="鲸鱼少女，蓝色渐变长发，蓝瞳…">${esc(mindBirthKw || '')}</textarea>
      </label>
      <label>愿景
        <textarea id="birth-vision" style="min-height:56px" placeholder="她希望成为一个什么样的人">${esc(mindBirthVision || '')}</textarea>
      </label>
      <div class="mind-actions">
        <button class="btn btn-primary btn-small" id="birth-gen" ${mindBirthBusy ? 'disabled' : ''}>${mindBirthBusy ? '生成中…' : '生成三组草案'}</button>
        <button class="btn btn-small" id="birth-close">收起</button>
        <span class="muted" id="birth-msg"></span>
      </div>
      <div class="hint">草案不会自动保存。选定一组、确认文字之后点「采用这组」，再在下面保存。</div>
      ${draftsHtml}
    </div>` : '';

  // 编辑表单
  const formSrc = mindForm || {
    name: d.botName || '',
    selfImage: raw.selfImage || '',
    baseline: raw.baseline || '',
    scenarioPrivate: raw.scenario?.private || '',
    scenarioGroup: raw.scenario?.group || '',
    voice: raw.voice || [],
    hardRules: raw.hardRules || []
  };
  const roleTextNotice = d.mode === 'roleText'
    ? `<div class="mind-empty">
         当前生效的是<strong>整段角色卡</strong>（${d.roleTextChars} 字符），下面的分槽不会进提示词。
         <div class="mind-actions" style="margin-top:8px">
           <button class="btn btn-small" id="mind-to-charter">改用分槽身份</button>
           <span class="muted">会清空整段角色卡（不可撤销，建议先复制备份）</span>
         </div>
       </div>`
    : '';

  const editBody = `
    ${roleTextNotice}
    <div class="mind-form">
      <label>名字（她自称，也是身份句里的称呼）
        <input type="text" id="mind-f-name" value="${esc(formSrc.name ?? '')}" placeholder="例如 澄" />
      </label>
      <label>我是谁
        <textarea id="mind-f-self" placeholder="名字、形象、来历…">${esc(formSrc.selfImage)}</textarea>
      </label>
      <label>我最初的样子
        <textarea id="mind-f-base" placeholder="还没经历这些事时，是个什么样的人…">${esc(formSrc.baseline)}</textarea>
      </label>
      <label>我说话的样子（一行一条，是习惯不是规矩）
        <textarea id="mind-f-voice" style="min-height:64px" placeholder="句尾很少用句号&#10;被夸会先否认一句">${esc((formSrc.voice || []).join('\n'))}</textarea>
      </label>
      <label>一对一的场合
        <textarea id="mind-f-priv" placeholder="私聊时的分寸：长度、语气、节奏…">${esc(formSrc.scenarioPrivate)}</textarea>
      </label>
      <label>群里的场合
        <textarea id="mind-f-group" placeholder="群里时的分寸：多短、接不接话…">${esc(formSrc.scenarioGroup)}</textarea>
      </label>
      <label>不能破的几条（一行一条）
        <textarea id="mind-f-rules" style="min-height:96px">${esc((formSrc.hardRules || []).join('\n'))}</textarea>
      </label>
      <div class="hint">可以用 <code>{botName}</code> 占位她的名字。${mindBirthName ? `　保存后名字将改为「${esc(mindBirthName)}」。` : ''}</div>
      <div class="mind-actions">
        <button class="btn btn-primary btn-small" id="mind-save">${mindBirthName ? `保存并改名为「${esc(mindBirthName)}」` : '保存'}</button>
        <span class="muted" id="mind-save-msg"></span>
      </div>
    </div>`;

  return `
    ${mindBirthOpen ? mindCard('出生仪式', birthPanel) : ''}
    ${mindCard('身份', editBody)}`;
}

// ── 节律（她自己的生理与行为参数）──────────────────────────────────────
// 这里放的是"她怎么活着"：体力、心跳、反思、作息、日志。
// 而「设置 → 发送与节奏」放的是"引擎怎么把消息送出去"（温度/轮数/防抖/并发）。
// 两者的分界线是：**改这个参数会不会改变她的行为**，会 → 这里；不会 → 设置。
function mindNum(id, label, value, { min = 0, max = 9999, step = 1, unit = '', desc = '' } = {}) {
  return `<label>${esc(label)}${unit ? `<span class="muted" style="font-weight:400">（${esc(unit)}）</span>` : ''}
    <input type="number" id="${id}" min="${min}" max="${max}" step="${step}" value="${Number(value)}" />
    ${desc ? `<span class="hint" style="font-weight:400">${esc(desc)}</span>` : ''}
  </label>`;
}

function mindRhythmSection(d) {
  const sleep = d.sleep || {};
  const sc = sleep.config || {};
  const tick = d.tick || {};
  const energy = d.energy || {};
  const tickCfg = d.tickConfig || {};
  const reflectCfg = d.reflectConfig || {};
  const two = (n) => String(n).padStart(2, '0');
  const hhmm = (h, m) => `${two(h)}:${two(m)}`;
  const sw = (id, checked, label) => (typeof switchHtml === 'function'
    ? switchHtml(id, checked, label)
    : `<label class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} /><span>${esc(label)}</span></label>`);

  const switchBody = `
    <div class="mind-form">
      <div class="mind-actions">${sw('mind-sw-on', d.enabled, '心智功能')}</div>
      <div class="hint">
        关掉后：她不再记录、不再反思、不再按节律行动，也不会睡觉 ——
        <strong>但正常聊天完全不受影响</strong>。想让她"现在别回话"，用右上角的「暂停」。<br>
        这里只放<strong>会改变她行为</strong>的参数；温度 / 轮数 / 防抖 / 并发这类传输参数在「设置 → 聊天设置」里。
      </div>
      <div class="mind-actions">
        <button class="btn btn-primary btn-small" id="mind-save-rhythm">保存节律</button>
        <button class="btn btn-small" id="mind-reset-rhythm">恢复默认</button>
        <span class="muted" id="mind-rhythm-msg"></span>
      </div>
    </div>`;

  const energyBody = `
    <div class="mind-form">
      <div class="mind-grid" style="gap:10px">
        ${mindNum('rh-energy-max', '体力上限', energy.max ?? 100, { min: 10, max: 1000, desc: '她累不累的上限' })}
        ${mindNum('rh-energy-recover', '每小时恢复', energy.recoverPerHour ?? 10, { min: 0, max: 100, desc: '按时间差补，不靠定时器' })}
        ${mindNum('rh-energy-floor', '低于此值不动', energy.floor ?? 10, { min: 0, max: 100, desc: '累了就歇着，连决策都不做' })}
      </div>
    </div>`;

  const tickBody = `
    <div class="mind-form">
      <div class="mind-grid" style="gap:10px">
        ${mindNum('rh-tick-interval', '心跳间隔', Math.round((tickCfg.intervalMs ?? 300000) / 60000), { min: 1, max: 120, unit: '分钟', desc: '多久看一次"要不要做点什么"' })}
        ${mindNum('rh-tick-jitter', '间隔抖动', Math.round((tickCfg.jitter ?? 0.1) * 100), { min: 0, max: 50, unit: '%', desc: '避免所有会话同一秒醒来' })}
        ${mindNum('rh-tick-decisions', '每日决策上限', tickCfg.maxDecisionsPerDay ?? 24, { min: 1, max: 200, desc: '用尽后连模型都不调' })}
        ${mindNum('rh-tick-proactive', '每日主动次数', tickCfg.maxProactivePerDay ?? 6, { min: 0, max: 50, desc: '她主动找人的上限' })}
        ${mindNum('rh-tick-gap', '两次主动最小间隔', Math.round((tickCfg.minProactiveGapMs ?? 3600000) / 60000), { min: 0, max: 1440, unit: '分钟' })}
        ${mindNum('rh-tick-idle', '多久没聊才想她', Math.round((tickCfg.proactiveIdleMs ?? 21600000) / 3600000), { min: 1, max: 168, unit: '小时' })}
        ${mindNum('rh-tick-snooze', '候选打盹', Math.round((tickCfg.idleSnoozeMs ?? 3600000) / 60000), { min: 1, max: 1440, unit: '分钟', desc: '想过但没做，这么久内不再叫她' })}
      </div>
    </div>`;

  const reflectBody = `
    <div class="mind-form">
      <div class="mind-grid" style="gap:10px">
        ${mindNum('rh-reflect-after', '攒够多少条反思', reflectCfg.reflectAfterEvents ?? 8, { min: 1, max: 100, unit: '条' })}
        ${mindNum('rh-reflect-cooldown', '两次反思间隔', Math.round((reflectCfg.reflectCooldownMs ?? 7200000) / 60000), { min: 1, max: 1440, unit: '分钟' })}
        ${mindNum('rh-reflect-daily', '每日反思上限', tickCfg.maxReflectPerDay ?? 8, { min: 1, max: 100, unit: '次' })}
      </div>
    </div>`;

  const sleepBody = `
    <div class="mind-form">
      <div class="mind-actions">${sw('mind-sw-sleep', sleep.enabled, '夜里会睡着')}</div>
      <div class="mind-grid" style="gap:10px">
        <label>入睡时间<input type="time" id="mind-sleep-start" value="${hhmm(sc.startHour ?? 23, sc.startMinute ?? 30)}" /></label>
        <label>醒来时间<input type="time" id="mind-sleep-end" value="${hhmm(sc.endHour ?? 8, sc.endMinute ?? 0)}" /></label>
        ${mindNum('mind-sleep-jitter', '每晚抖动', sc.jitterMin ?? 40, { min: 0, max: 180, unit: '±分钟', desc: '固定时间像设置项，抖动像人' })}
        ${mindNum('mind-sleep-stay', '一晚最多再撑', sc.maxStayUp ?? 2, { min: 0, max: 5, unit: '次' })}
        ${mindNum('mind-sleep-grace', '安静多久才睡', Math.round((sc.graceMs ?? 300000) / 60000), { min: 0, max: 120, unit: '分钟', desc: '刚聊过天就不会立刻睡' })}
      </div>
      <div class="hint">
        睡着时不看消息、不做决策；醒来把积压当一批读。${sleep.asleep
          ? '现在：<strong>已睡着</strong>。'
          : (sleep.nextEligibleAt
            ? `现在：<strong>醒着</strong>（刚还在聊天，安静到 ${mindClock(sleep.nextEligibleAt)} 后才会睡）。`
            : `现在：<strong>醒着</strong>${sleep.reason ? `（${esc(sleep.reason)}）` : ''}。`)}
      </div>
    </div>`;

  // ── 日志已搬到「记录 → 心跳日志」──
  return `
    ${mindCard('总开关', switchBody)}
    ${mindCard('作息', sleepBody)}
    <div class="mind-grid">
      ${mindCard('体力', energyBody)}
      ${mindCard('心跳', tickBody)}
    </div>
    ${mindCard('反思', reflectBody)}`;
}

// ── 心跳日志（「记录」组）──────────────────────────────────────────────
// 从节律页搬出来的：日志是"记录"，不是"设置"，放在参数面板里会让人以为它能调。
function mindLogSection() {
  const sizes = mindTickLog.sizes;
  const kb = (n) => (Number(n) >= 1024 ? `${(Number(n) / 1024).toFixed(1)} KB` : `${Number(n) || 0} B`);
  const ticks = mindTickLog.recentTicks || [];

  const describe = (t) => {
    if (t.skipped) {
      const label = { asleep: '睡着中', paused: '已暂停', 'no-model': '未配置模型', 'tick-disabled': '心跳已关', 'no-mind': '心智未接入' }[t.skipped] || t.skipped;
      return `跳过（${esc(label)}）`;
    }
    const rs = t.results || [];
    if (!rs.length) return '无事';
    return rs.map((r) => `${esc(r.action)}${r.reason ? `·${esc(r.reason)}` : ''}`).join(' / ');
  };

  const tickRows = ticks.length
    ? ticks.slice().reverse().map((t) => (
      `<div class="mind-rel-line"><span class="mind-rel-meta">${fmtTime(t.at)}</span>　${describe(t)}</div>`
    )).join('')
    : '<div class="mind-empty">还没有心跳记录。这里只显示"真的做了什么"的轮次；每 60 秒的空扫描与连续相同的状态不会刷屏。</div>';

  const actRows = (mindTickLog.actions || []).length
    ? mindTickLog.actions.slice().reverse().map((a) => (
      `<div class="mind-rel-line"><span class="mind-rel-meta">${fmtTime(a.at)}</span>　${esc(a.action)}${a.reason ? ` · ${esc(String(a.reason).slice(0, 40))}` : ''}${a.energySpent ? `（-${a.energySpent} 体力）` : ''}</div>`
    )).join('')
    : '<div class="mind-empty">没有落盘的行动记录。只有真正发生的事才会写进来（跳过的心跳不写盘）。</div>';

  return `
    ${mindCard('最近心跳（内存，重启即清空）', tickRows)}
    ${mindCard('已落盘的行动（actions.jsonl）', actRows + `
      <div class="mind-actions" style="margin-top:10px">
        <button class="btn btn-small" id="mind-clear-logs">清空日志文件</button>
        <span class="muted">${sizes ? `当前占用 ${kb(sizes.total)}（行动 ${kb(sizes.actions)} · 反思 ${kb(sizes.reflections)}）` : ''}</span>
        <span class="muted" id="mind-log-msg"></span>
      </div>
      <div class="hint">只清 actions/reflections 两个日志文件；事件、关系、自我一个字都不动。</div>`)}`;
}

// ── 记忆流 ─────────────────────────────────────────────────────────────
function mindStreamSection() {
  const rels = mindState?.relations || [];
  const actorOpts = [
    { v: '', t: '所有人' },
    { v: 'self', t: '她自己' },
    ...rels.map((r) => ({ v: r.userId, t: r.nickname || r.names?.[0] || r.userId }))
  ];
  const chatOpts = [
    { v: '', t: '所有会话' },
    ...(mindChats || []).map((c) => ({ v: c.key, t: c.name || c.key }))
  ];
  const options = (list, cur) => list
    .map((o) => `<option value="${esc(o.v)}"${o.v === cur ? ' selected' : ''}>${esc(o.t)}</option>`)
    .join('');
  const filtering = Boolean(mindStreamFilter.actor || mindStreamFilter.chatKey);

  const filterBar = `
    <div class="mind-form" style="margin-bottom:12px">
      <div class="mind-grid" style="gap:10px">
        <label>按人
          <select id="mind-stream-actor">${options(actorOpts, mindStreamFilter.actor)}</select>
        </label>
        <label>按会话
          <select id="mind-stream-chat">${options(chatOpts, mindStreamFilter.chatKey)}</select>
        </label>
      </div>
    </div>`;

  if (!mindEvents.length) {
    return mindCard('记忆流', `${filterBar}<div class="mind-empty">${filtering ? '这个范围内还没有记录。' : '还没有任何经历记录。'}</div>`);
  }

  const rows = mindEvents.map((e) => {
    const who = e.actorId && e.actorId !== 'self' ? `${e.actorName || e.actorId}：` : '';
    const tags = (e.tags || []).length ? `<span class="mind-rel-meta">${e.tags.map((t) => esc(t)).join(' / ')}</span>` : '';
    const kind = MIND_KIND_LABEL[e.kind] || e.kind || '';
    const badge = e.summaryOf?.length ? '<span class="mind-pill">压缩摘要</span>' : '';
    return `<div class="mind-rel">
      <div class="mind-rel-head">
        <span class="mind-rel-name">${fmtTime(e.ts)}</span>
        <span class="mind-rel-meta">${esc(kind)}</span>
        ${badge}${tags}
        <span class="mind-rel-meta">重要度 ${Math.round((e.salience || 0) * 100)}%</span>
      </div>
      <div class="mind-rel-line">${esc(who)}${esc(e.text)}</div>
    </div>`;
  }).join('');

  return mindCard(`记忆流（${mindEvents.length} 条，从新到旧）`, filterBar + rows);
}

// ── 会话配置 ───────────────────────────────────────────────────────────
function mindProfilesSection() {
  const keys = [...new Set([...(mindProfileKeys || []), ...Object.keys(mindProfiles || {})])];
  const nameOf = (key) => {
    const hit = (mindChats || []).find((c) => c.key === key);
    return hit?.name || (key.startsWith('private:') ? `私聊 ${key.slice(8)}` : key);
  };
  const options = keys.map((k) => `<option value="${esc(k)}">${esc(nameOf(k))}</option>`).join('');
  const overridden = Object.entries(mindProfiles || {}).filter(([, v]) => v && Object.keys(v).length);

  return mindCard('会话配置', `
    ${keys.length ? `
    <div class="mind-form">
      <label>会话
        <select id="mind-prof-key">${options}</select>
      </label>
      <label>参与度（留空 = 跟随全局）
        <select id="mind-prof-part">
          <option value="">（跟随全局）</option>
          <option value="low">安静</option>
          <option value="medium">普通</option>
          <option value="high">活跃</option>
        </select>
      </label>
      <label>角色文本覆盖（留空 = 用全局）
        <textarea id="mind-prof-role" placeholder="这个会话专用的整段角色卡（会替换 charter 的分槽身份）">${''}</textarea>
      </label>
      <div class="hint">只影响这个会话；名字、模型、密钥永远用全局，不会被分会话改掉。</div>
      <div class="mind-actions">
        <button class="btn btn-primary btn-small" id="mind-prof-save">保存覆盖</button>
        <button class="btn btn-small" id="mind-prof-clear">清除覆盖</button>
        <span class="muted" id="mind-prof-msg"></span>
      </div>
    </div>` : '<div class="mind-empty">还没有任何会话。</div>'}
    <div class="mind-slot">
      <div class="k">已有覆盖（${overridden.length} 个）</div>
      ${overridden.length
        ? overridden.map(([k, v]) => `<div class="mind-rel-line">${esc(nameOf(k))}：${esc(JSON.stringify(v))}</div>`).join('')
        : '<div class="mind-empty">没有会话使用独立配置。</div>'}
    </div>`);
}

// ── 事件绑定 ───────────────────────────────────────────────────────────
function mindBindEvents(box) {
  $('#mind-refresh')?.addEventListener('click', () => loadMindPage());
  $('#mind-birth')?.addEventListener('click', () => { mindBirthOpen = !mindBirthOpen; renderMindPage(); });
  $('#birth-close')?.addEventListener('click', () => { mindBirthOpen = false; mindBirthDrafts = []; renderMindPage(); });
  $('#birth-gen')?.addEventListener('click', generateBirthDrafts);
  $('#mind-save')?.addEventListener('click', saveMindCharter);
  $('#mind-reflect-now')?.addEventListener('click', runReflectNow);
  $('#mind-save-rhythm')?.addEventListener('click', saveMindRhythm);
  $('#mind-reset-rhythm')?.addEventListener('click', resetMindRhythm);
  $('#mind-clear-logs')?.addEventListener('click', clearMindLogs);
  $('#mind-to-charter')?.addEventListener('click', switchToCharter);
  // 主人手动编辑：自我 / 关系
  $('#mind-edit-self')?.addEventListener('click', () => { mindSelfEditing = !mindSelfEditing; renderMindPage(); });
  $('#mind-self-cancel')?.addEventListener('click', () => { mindSelfEditing = false; renderMindPage(); });
  $('#mind-self-save')?.addEventListener('click', saveSelfEdit);
  box.querySelectorAll?.('[data-rel-edit]')?.forEach((el) => {
    el.addEventListener('click', () => {
      const uid = String(el.dataset.relEdit || '');
      mindRelEditing = mindRelEditing === uid ? '' : uid;
      renderMindPage();
    });
  });
  box.querySelectorAll?.('[data-rel-save]')?.forEach((el) => {
    el.addEventListener('click', () => saveRelationEdit(String(el.dataset.relSave || '')));
  });
  box.querySelectorAll?.('[data-rel-cancel]')?.forEach((el) => {
    el.addEventListener('click', () => { mindRelEditing = ''; renderMindPage(); });
  });
  $('#mind-prof-save')?.addEventListener('click', () => saveProfile(false));
  $('#mind-prof-clear')?.addEventListener('click', () => saveProfile(true));
  $('#mind-prof-key')?.addEventListener('change', fillProfileForm);
  // 记忆流筛选：改选后重新拉取（筛选在服务端做）
  $('#mind-stream-actor')?.addEventListener('change', (e) => {
    mindStreamFilter.actor = String(e.target?.value || '');
    loadMindPage();
  });
  $('#mind-stream-chat')?.addEventListener('change', (e) => {
    mindStreamFilter.chatKey = String(e.target?.value || '');
    loadMindPage();
  });
  box.querySelectorAll?.('[data-pick-name]')?.forEach((el) => {
    el.addEventListener('click', () => { mindBirthName = el.dataset.pickName; renderMindPage(); });
  });
  box.querySelectorAll?.('[data-apply]')?.forEach((el) => {
    el.addEventListener('click', () => applyBirthDraft(Number(el.dataset.apply)));
  });
  fillProfileForm();
}

function fillProfileForm() {
  const key = $('#mind-prof-key')?.value;
  if (!key) return;
  const p = (mindProfiles || {})[key] || {};
  const part = p?.persona?.participation || '';
  const role = p?.persona?.roleText || '';
  if ($('#mind-prof-part')) $('#mind-prof-part').value = part;
  if ($('#mind-prof-role')) $('#mind-prof-role').value = role;
}

// ── 手动触发反思（调试/验证用）─────────────────────────────────────────
async function runReflectNow() {
  const btn = $('#mind-reflect-now');
  if (btn) btn.disabled = true;
  mindReflectFlash = '正在反思（一次模型调用）…';
  renderMindPage();
  try {
    const r = await api('/api/mind/reflect', { method: 'POST', body: JSON.stringify({}) });
    if (r?.ok) {
      const applied = r.applied || {};
      const bits = [];
      if (applied.self) bits.push('改写自我');
      if ((applied.relations || []).length) bits.push(`关系 ×${applied.relations.length}`);
      if (applied.compacted) bits.push(`压缩 ${applied.compacted} 条`);
      mindReflectFlash = r.empty ? '想不出什么（也算成功）' : `完成：${bits.join(' · ') || '无改动'}`;
    } else {
      mindReflectFlash = `没跑成：${r?.reason || r?.error || '未知原因'}`;
    }
    await loadMindPage();
  } catch (e) {
    mindReflectFlash = `失败：${e.message}`;
    renderMindPage();
  }
}

// ── 保存：节律（体力 / 心跳 / 反思 / 作息）────────────────────────────
async function saveMindRhythm() {
  const num = (id, min, max, fallback) => {
    const v = Number($(`#${id}`)?.value);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
  };
  const parseTime = (v, dh, dm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? ''));
    return m ? [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))] : [dh, dm];
  };
  const [sh, sm] = parseTime($('#mind-sleep-start')?.value, 23, 30);
  const [eh, em] = parseTime($('#mind-sleep-end')?.value, 8, 0);

  const msg = $('#mind-rhythm-msg');
  if (msg) msg.textContent = '保存中…';
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        mind: {
          enabled: Boolean($('#mind-sw-on')?.checked),
          energy: {
            max: num('rh-energy-max', 10, 1000, 100),
            recoverPerHour: num('rh-energy-recover', 0, 100, 10),
            floor: num('rh-energy-floor', 0, 100, 10)
          },
          tick: {
            intervalMs: num('rh-tick-interval', 1, 120, 5) * 60000,
            jitter: num('rh-tick-jitter', 0, 50, 10) / 100,
            maxDecisionsPerDay: num('rh-tick-decisions', 1, 200, 24),
            maxProactivePerDay: num('rh-tick-proactive', 0, 50, 6),
            minProactiveGapMs: num('rh-tick-gap', 0, 1440, 60) * 60000,
            proactiveIdleMs: num('rh-tick-idle', 1, 168, 6) * 3600000,
            idleSnoozeMs: num('rh-tick-snooze', 1, 1440, 60) * 60000,
            maxReflectPerDay: num('rh-reflect-daily', 1, 100, 8)
          },
          reflectAfterEvents: num('rh-reflect-after', 1, 100, 8),
          reflectCooldownMs: num('rh-reflect-cooldown', 1, 1440, 120) * 60000,
          sleep: {
            enabled: Boolean($('#mind-sw-sleep')?.checked),
            startHour: sh, startMinute: sm,
            endHour: eh, endMinute: em,
            jitterMin: num('mind-sleep-jitter', 0, 180, 40),
            maxStayUp: num('mind-sleep-stay', 0, 5, 2),
            graceMs: num('mind-sleep-grace', 0, 120, 5) * 60000
          }
        }
      })
    });
    await loadMindPage();
  } catch (e) {
    const m = $('#mind-rhythm-msg');
    if (m) m.textContent = `保存失败：${e.message}`;
  }
}

/** 恢复默认：把节律参数重置为出厂值（保留"心智开不开/作息开不开"）。 */
async function resetMindRhythm() {
  const d = mindState?.defaults;
  if (!d) return;
  const msg = $('#mind-rhythm-msg');
  if (msg) msg.textContent = '恢复中…';
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        mind: {
          energy: d.energy,
          tick: { ...d.tick, maxReflectPerDay: d.tick?.maxReflectPerDay },
          reflectAfterEvents: d.reflect.reflectAfterEvents,
          reflectCooldownMs: d.reflect.reflectCooldownMs,
          reflectMaxEvents: d.reflect.reflectMaxEvents,
          reflectMaxRelations: d.reflect.reflectMaxRelations,
          // 作息恢复默认，但保留"是否启用"这一个开关
          sleep: { ...d.sleep, enabled: mindState?.sleep?.enabled === true }
        }
      })
    });
    await loadMindPage();
  } catch (e) {
    const m = $('#mind-rhythm-msg');
    if (m) m.textContent = `恢复失败：${e.message}`;
  }
}

/** 主人手动修改"她对自己的描述"（留痕 by:owner）。 */
async function saveSelfEdit() {
  const narrative = String($('#mind-self-narrative')?.value || '').trim();
  const moodLabel = String($('#mind-self-mood')?.value || '').trim();
  if (!narrative) {
    const m = $('#mind-self-msg');
    if (m) m.textContent = '描述不能为空';
    return;
  }
  if (!(await mindConfirm(MIND_ETHICS_SELF))) return;
  const msg = $('#mind-self-msg');
  if (msg) msg.textContent = '保存中…';
  try {
    const r = await api('/api/mind/self/edit', {
      method: 'POST',
      body: JSON.stringify({ narrative, moodLabel, reason: '主人在界面里手动修改' })
    });
    if (!r?.ok) throw new Error(r?.error || '修改失败');
    mindSelfEditing = false;
    await loadMindPage();
  } catch (e) {
    const m = $('#mind-self-msg');
    if (m) m.textContent = `失败：${e.message}`;
  }
}

/** 主人手动修改某段关系（留痕 owner:manual）。 */
async function saveRelationEdit(userId) {
  if (!userId) return;
  const numOrUndef = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : undefined;
  };
  const patch = {
    nickname: String($('#mind-rel-nickname')?.value || '').trim(),
    stage: String($('#mind-rel-stage')?.value || '').trim(),
    tender: String($('#mind-rel-tender')?.value || '').split('\n').map((s) => s.trim()).filter(Boolean)
  };
  const trust = numOrUndef($('#mind-rel-trust')?.value);
  const warmth = numOrUndef($('#mind-rel-warmth')?.value);
  if (trust !== undefined) patch.trust = trust;
  if (warmth !== undefined) patch.warmth = warmth;

  if (!(await mindConfirm(MIND_ETHICS_RELATION))) return;
  const msg = $('#mind-rel-msg');
  if (msg) msg.textContent = '保存中…';
  try {
    const r = await api('/api/mind/relation/edit', {
      method: 'POST',
      body: JSON.stringify({ userId, patch })
    });
    if (!r?.ok) throw new Error(r?.error || '修改失败');
    mindRelEditing = '';
    await loadMindPage();
  } catch (e) {
    const m = $('#mind-rel-msg');
    if (m) m.textContent = `失败：${e.message}`;
  }
}

/** 从"整段角色卡"切回"分槽身份"（清空 persona.roleText）。 */
async function switchToCharter() {
  if (typeof window !== 'undefined' && typeof window.confirm === 'function'
    && !window.confirm('清空整段角色卡，改用分槽身份？此操作不可撤销。')) return;
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ persona: { roleText: '' } }) });
    await loadMindPage();
  } catch (e) {
    mindReflectFlash = `切换失败：${e.message}`;
    renderMindPage();
  }
}

/** 清空日志文件（用户手动管理磁盘）。 */
async function clearMindLogs() {
  const msg = $('#mind-log-msg');
  if (msg) msg.textContent = '清理中…';
  try {
    const r = await api('/api/mind/logs/clear', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
    await loadMindPage();
    const m = $('#mind-log-msg');
    if (m) m.textContent = r?.ok ? `已清空（释放 ${Math.round((r.freed || 0) / 1024)} KB）` : `失败：${r?.error || '未知'}`;
  } catch (e) {
    const m = $('#mind-log-msg');
    if (m) m.textContent = `失败：${e.message}`;
  }
}

// ── 保存：身份 ─────────────────────────────────────────────────────────
async function saveMindCharter() {
  const val = (id) => String($(`#${id}`)?.value ?? '').trim();
  const charter = {
    selfImage: val('mind-f-self'),
    baseline: val('mind-f-base'),
    scenario: { private: val('mind-f-priv'), group: val('mind-f-group') },
    voice: val('mind-f-voice').split('\n').map((s) => s.trim()).filter(Boolean),
    hardRules: val('mind-f-rules').split('\n').map((s) => s.trim()).filter(Boolean)
  };
  const msg = $('#mind-save-msg');
  if (msg) msg.textContent = '保存中…';
  const payload = { persona: { charter } };
  const name = val('mind-f-name') || mindBirthName;
  if (name) payload.persona.botName = name;
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    mindEditing = false;
    mindForm = null;
    mindBirthName = '';
    mindBirthDrafts = [];
    mindBirthOpen = false;
    await loadMindPage();
  } catch (e) {
    if (msg) msg.textContent = `保存失败：${e.message}`;
  }
}

// ── 保存：会话覆盖 ─────────────────────────────────────────────────────
async function saveProfile(clear) {
  const key = String($('#mind-prof-key')?.value || '').trim();
  const msg = $('#mind-prof-msg');
  if (!key) { if (msg) msg.textContent = '先选一个会话'; return; }
  if (msg) msg.textContent = clear ? '清除中…' : '保存中…';
  try {
    const body = clear
      ? { chatKey: key, clear: true }
      : {
          chatKey: key,
          patch: {
            persona: {
              participation: String($('#mind-prof-part')?.value || ''),
              roleText: String($('#mind-prof-role')?.value || '')
            }
          }
        };
    await api('/api/chat-profiles', { method: 'POST', body: JSON.stringify(body) });
    await loadMindPage();
  } catch (e) {
    const m = $('#mind-prof-msg');
    if (m) m.textContent = `失败：${e.message}`;
  }
}

// ── 出生仪式 ───────────────────────────────────────────────────────────
async function generateBirthDrafts() {
  const kw = String($('#birth-kw')?.value ?? '').trim();
  const vision = String($('#birth-vision')?.value ?? '').trim();
  mindBirthKw = kw;
  mindBirthVision = vision;
  if (!kw && !vision) {
    const m = $('#birth-msg');
    if (m) m.textContent = '至少写一点形象关键词或一句愿景。';
    return;
  }
  mindBirthBusy = true;
  mindBirthOpen = true;
  renderMindPage();
  const busyMsg = $('#birth-msg');
  if (busyMsg) busyMsg.textContent = '正在生成（一次模型调用）…';

  try {
    const r = await api('/api/mind/charter/draft', {
      method: 'POST',
      body: JSON.stringify({ seed: { keywords: kw, vision } })
    });
    mindBirthDrafts = Array.isArray(r.drafts) ? r.drafts : [];
    mindBirthPick = 0;
    mindBirthName = mindBirthDrafts[0]?.name?.[0] || '';
    mindBirthBusy = false;
    renderMindPage();
    const m = $('#birth-msg');
    if (m) m.textContent = mindBirthDrafts.length ? `生成了 ${mindBirthDrafts.length} 组` : '没有可用的草案';
  } catch (e) {
    mindBirthBusy = false;
    mindBirthDrafts = [];
    renderMindPage();
    const m = $('#birth-msg');
    if (m) m.textContent = `生成失败：${e.message}`;
  }
}

function applyBirthDraft(index) {
  const dd = mindBirthDrafts[index];
  if (!dd) return;
  const base = mindState?.charter || {};
  mindBirthPick = index;
  mindForm = {
    name: mindBirthName || (mindState?.botName || ''),
    selfImage: dd.selfImage,
    baseline: dd.baseline,
    scenarioPrivate: base.scenario?.private || '',
    scenarioGroup: base.scenario?.group || '',
    voice: Array.isArray(dd.voice) ? dd.voice : [],
    hardRules: base.hardRules || []
  };
  mindEditing = true;
  renderMindPage();
}
