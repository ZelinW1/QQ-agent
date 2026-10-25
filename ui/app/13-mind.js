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
    const [st, a, b] = await Promise.all(jobs);
    mindState = st;
    if (mode === 'stream') {
      mindEvents = a?.events || [];
      mindChats = b?.chats || [];
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
  return `
    <div class="mind-head">
      <span class="mind-pill ${d.enabled ? 'on' : 'off'}">${d.enabled ? '已开启' : '已关闭'}</span>
      <span class="mind-pill">${esc(d.mode === 'roleText' ? '整段角色卡' : '分槽身份')}</span>
      <span class="mind-pill ${sleep.asleep ? 'on' : ''}">${sleep.asleep ? '睡着' : (sleep.enabled ? '醒着' : '作息未启用')}</span>
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
  const selfBody = `
    <div class="mind-slot">
      <div class="k">v${self.version || 0}${self.updatedAt ? ` · ${fmtTime(self.updatedAt)} 更新` : ''}</div>
      <div class="v">${esc(self.narrative || '（还没认真想过自己是个什么样的人）')}</div>
    </div>
    <div class="mind-slot"><div class="k">此刻心情</div><div class="v">${esc(self.mood?.label || '说不清')}</div></div>
    ${(self.preoccupations || []).length ? `<div class="mind-slot"><div class="k">挂心的事</div><div class="mind-chips">${self.preoccupations.map((p) => `<span class="mind-chip">${esc(p)}</span>`).join('')}</div></div>` : ''}`;

  const relBody = (d.relations || []).length
    ? d.relations.map((r) => `
      <div class="mind-rel">
        <div class="mind-rel-head">
          <span class="mind-rel-name">${esc(r.nickname || r.names?.[0] || r.userId)}</span>
          <span class="mind-rel-meta">${esc(r.userId)} · ${esc(MIND_STAGE[r.stage] || r.stage)} · 把握 ${Math.round((r.confidence || 0) * 100)}%</span>
        </div>
        <div class="mind-bar" title="信任 ${mindClamp(r.trust)}"><i style="width:${mindClamp(r.trust)}%"></i></div>
        ${(r.knownFor || []).length ? `<div class="mind-rel-line">知道：${esc(r.knownFor.join('；'))}</div>` : ''}
        ${(r.tender || []).length ? `<div class="mind-rel-line">别提：${esc(r.tender.join('；'))}</div>` : ''}
        ${(r.openLoops || []).length ? `<div class="mind-rel-line">还没问完：${esc(r.openLoops.join('；'))}</div>` : ''}
        ${r.recentSummary ? `<div class="mind-rel-line">上次：${esc(r.recentSummary)}</div>` : ''}
      </div>`).join('')
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

  const refBody = (d.recentReflections || []).length
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
    : '<div class="mind-empty">还没反思过。</div>';

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
  const sleep = d.sleep || {};

  // 开关与作息
  const sc = sleep.config || {};
  const two = (n) => String(n).padStart(2, '0');
  const hhmm = (h, m) => `${two(h)}:${two(m)}`;
  const sw = (id, checked, label) => (typeof switchHtml === 'function'
    ? switchHtml(id, checked, label)
    : `<label class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} /><span>${esc(label)}</span></label>`);

  const switchBody = `
    <div class="mind-form">
      <div class="mind-actions">
        ${sw('mind-sw-on', d.enabled, '心智功能')}
        ${sw('mind-sw-sleep', sleep.enabled, '夜里会睡着')}
      </div>
      <div class="mind-grid" style="gap:10px">
        <label>入睡时间<input type="time" id="mind-sleep-start" value="${hhmm(sc.startHour ?? 23, sc.startMinute ?? 30)}" /></label>
        <label>醒来时间<input type="time" id="mind-sleep-end" value="${hhmm(sc.endHour ?? 8, sc.endMinute ?? 0)}" /></label>
        <label>每晚抖动（± 分钟）<input type="number" id="mind-sleep-jitter" min="0" max="180" value="${Number(sc.jitterMin ?? 40)}" /></label>
        <label>一晚最多再撑几次<input type="number" id="mind-sleep-stay" min="0" max="5" value="${Number(sc.maxStayUp ?? 2)}" /></label>
      </div>
      <div class="hint">睡着时她不看消息、不做决策；醒来后把积压当成一批读。时段每晚有随机抖动。</div>
      <div class="mind-actions">
        <button class="btn btn-primary btn-small" id="mind-save-switches">保存开关</button>
        <span class="muted" id="mind-sw-msg"></span>
      </div>
    </div>`;

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
    ? `<div class="mind-empty">当前生效的是整段角色卡（${d.roleTextChars} 字符），下面的分槽不会进提示词。把「设置 → 人设」里的角色卡清空即可切换。</div>`
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
    ${mindCard('开关与作息', switchBody)}
    ${mindCard('身份', editBody)}`;
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
  $('#mind-save-switches')?.addEventListener('click', saveMindSwitches);
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

// ── 保存：开关与作息 ───────────────────────────────────────────────────
async function saveMindSwitches() {
  const on = Boolean($('#mind-sw-on')?.checked);
  const sleepOn = Boolean($('#mind-sw-sleep')?.checked);
  const parseTime = (v, dh, dm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? ''));
    return m ? [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))] : [dh, dm];
  };
  const [sh, sm] = parseTime($('#mind-sleep-start')?.value, 23, 30);
  const [eh, em] = parseTime($('#mind-sleep-end')?.value, 8, 0);
  const jitter = Math.max(0, Math.min(180, Number($('#mind-sleep-jitter')?.value) || 0));
  const maxStayUp = Math.max(0, Math.min(5, Number($('#mind-sleep-stay')?.value) || 0));

  const msg = $('#mind-sw-msg');
  if (msg) msg.textContent = '保存中…';
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        mind: {
          enabled: on,
          sleep: {
            enabled: sleepOn,
            startHour: sh, startMinute: sm,
            endHour: eh, endMinute: em,
            jitterMin: jitter, maxStayUp
          }
        }
      })
    });
    await loadMindPage();
  } catch (e) {
    const m = $('#mind-sw-msg');
    if (m) m.textContent = `保存失败：${e.message}`;
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
