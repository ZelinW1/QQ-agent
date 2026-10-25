'use strict';
// 心智页（M2）：她现在的样子 + 身份编辑。
//
// 数据源：GET /api/mind/state（只读快照）；保存身份：POST /api/config。
// 这一页刻意不塞进设置页：设置页是"改参数"，这一页是"看她是谁"，
// 两种意图混在一屏里，两边都不好用。
//
// 结构约定（与其它页一致）：loadXxxPage() 负责取数 + 渲染，渲染后用 id 绑事件。
// 因为 innerHTML 整块重建，事件必须每次重绑，不能只绑一次。

const MIND_STAGE = {
  stranger: '陌生人',
  acquaintance: '泛泛之交',
  familiar: '熟人',
  close: '亲近',
  strained: '有隔阂'
};

let mindState = null;
let mindEditing = false;
// 出生仪式的临时状态：草案只活在内存里，除非用户点"采用这组"并保存。
let mindBirthOpen = false;
let mindBirthDrafts = [];
let mindBirthBusy = false;
let mindBirthPick = 0;      // 当前选中的草案下标
let mindBirthName = '';     // 采用时同时改的名字（空 = 不改）
let mindBirthKw = '';       // 种子：形象关键词（重渲染时保留输入）
let mindBirthVision = '';   // 种子：愿景
let mindForm = null;        // 编辑表单的当前值（草案采用后从草案来，否则从配置来）

const mindClamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));

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
  box.innerHTML = '<div class="mind-empty">正在读取她的状态…</div>';
  try {
    mindState = await api('/api/mind/state');
    mindEditing = false;
    mindForm = null;
    mindBirthOpen = false;
    mindBirthDrafts = [];
    mindBirthPick = 0;
    mindBirthName = '';
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

  const raw = d.charter || {};
  const shown = d.charterResolved || raw;
  const sleep = d.sleep || {};
  const tick = d.tick || {};

  // ── 头部：状态 + 操作 ──
  const head = `
    <div class="mind-head">
      <h3>心智</h3>
      <span class="mind-pill ${d.enabled ? 'on' : 'off'}">${d.enabled ? '已开启' : '已关闭'}</span>
      <span class="mind-pill">${esc(d.mode === 'roleText' ? '整段角色卡' : '分槽身份')}</span>
      <span class="mind-pill ${sleep.asleep ? 'on' : ''}">${sleep.asleep ? '睡着' : (sleep.enabled ? '醒着' : '作息未启用')}</span>
      <span style="flex:1"></span>
      <button class="btn btn-small" id="mind-refresh">刷新</button>
      <button class="btn btn-small" id="mind-birth">${mindBirthOpen ? '收起草案' : '出生仪式'}</button>
      <button class="btn btn-small ${mindEditing ? '' : 'btn-primary'}" id="mind-edit">${mindEditing ? '收起编辑' : '编辑身份'}</button>
    </div>`;

  // ── 身份 ──
  const identityBody = d.mode === 'roleText'
    ? `<div class="mind-empty">当前使用整段角色卡（${d.roleTextChars} 字符），分槽身份不参与渲染。</div>`
    : `
      <div class="mind-slot">
        <div class="k">我是谁</div>
        <div class="v">${esc(shown.selfImage || '（空）')}</div>
      </div>
      <div class="mind-slot">
        <div class="k">我最初的样子</div>
        <div class="v">${esc(shown.baseline || '（空）')}</div>
      </div>
      <div class="mind-slot">
        <div class="k">一对一的场合</div>
        <div class="v">${esc(shown.scenario?.private || '（空）')}</div>
      </div>
      <div class="mind-slot">
        <div class="k">群里的场合</div>
        <div class="v">${esc(shown.scenario?.group || '（空）')}</div>
      </div>
      ${(shown.hardRules || []).length ? `
        <div class="mind-slot">
          <div class="k">不能破的几条</div>
          <ul class="mind-rules">${shown.hardRules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        </div>` : ''}`;

  // ── 她自己 ──
  const self = d.self || {};
  const selfBody = `
    <div class="mind-slot">
      <div class="k">v${self.version || 0}${self.updatedAt ? ` · ${fmtTime(self.updatedAt)} 更新` : ''}</div>
      <div class="v">${esc(self.narrative || '（还没认真想过自己是个什么样的人）')}</div>
    </div>
    <div class="mind-slot">
      <div class="k">此刻心情</div>
      <div class="v">${esc(self.mood?.label || '说不清')}</div>
    </div>
    ${(self.preoccupations || []).length ? `
      <div class="mind-slot">
        <div class="k">挂心的事</div>
        <div class="mind-chips">${self.preoccupations.map((p) => `<span class="mind-chip">${esc(p)}</span>`).join('')}</div>
      </div>` : ''}`;

  // ── 关系 ──
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

  // ── 节律 ──
  const win = sleep.window;
  const rhythmBody = `
    <div class="mind-slot">
      <div class="k">体力</div>
      <div class="v">${Math.round(tick.energy || 0)} / 100</div>
      <div class="mind-bar"><i style="width:${mindClamp(tick.energy)}%"></i></div>
    </div>
    <div class="mind-slot">
      <div class="k">今天</div>
      <div class="v">主动 ${tick.todayProactive || 0} 次 · 决策 ${tick.todayDecisions || 0} 次 · 反思 ${tick.todayReflections || 0} 次</div>
    </div>
    <div class="mind-slot">
      <div class="k">作息</div>
      <div class="v">${sleep.enabled
        ? `${sleep.asleep ? '正在睡' : '醒着'}${win ? `　今晚窗口 ${mindClock(win.startAt)} – ${mindClock(win.endAt)}` : ''}`
        : '未启用'}</div>
    </div>
    <div class="mind-slot">
      <div class="k">上次反思</div>
      <div class="v">${tick.lastReflectAt ? fmtTime(tick.lastReflectAt) : '还没反思过'}</div>
    </div>`;

  // ── 最近反思 ──
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

  // ── 出生仪式 ──
  const birthPanel = mindBirthOpen ? (() => {
    const draftsHtml = mindBirthDrafts.length
      ? mindBirthDrafts.map((d, i) => `
        <div class="mind-draft ${i === mindBirthPick ? 'picked' : ''}" data-draft="${i}">
          <div class="mind-rel-head">
            <span class="mind-rel-name">草案 ${i + 1}</span>
            <span class="mind-rel-meta">${mindBirthPick === i ? '已选中' : ''}</span>
          </div>
          <div class="mind-slot">
            <div class="k">候选名字（点一个采用）</div>
            <div class="mind-chips">${(d.name || []).map((n) => `<span class="mind-chip ${mindBirthName === n ? 'picked' : ''}" data-pick-name="${esc(n)}">${esc(n)}</span>`).join('')}</div>
          </div>
          <div class="mind-slot"><div class="k">我是谁</div><div class="v">${esc(d.selfImage)}</div></div>
          <div class="mind-slot"><div class="k">最初的我</div><div class="v">${esc(d.baseline)}</div></div>
          ${(d.voice || []).length ? `<div class="mind-slot"><div class="k">说话习惯</div><div class="mind-chips">${d.voice.map((v) => `<span class="mind-chip">${esc(v)}</span>`).join('')}</div></div>` : ''}
          <div class="mind-actions"><button class="btn btn-primary btn-small" data-apply="${i}">采用这组</button></div>
        </div>`).join('')
      : '';

    return `
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
        <div class="hint">草案不会自动保存。选定一组、确认文字之后点「采用这组」，再在编辑框里保存。</div>
        ${draftsHtml}
      </div>`;
  })() : '';

  // ── 编辑表单 ──
  const formSrc = mindForm || {
    selfImage: raw.selfImage || '',
    baseline: raw.baseline || '',
    scenarioPrivate: raw.scenario?.private || '',
    scenarioGroup: raw.scenario?.group || '',
    hardRules: raw.hardRules || []
  };
  const editBody = mindEditing ? `
    <div class="mind-form">
      <label>我是谁
        <textarea id="mind-f-self" placeholder="名字、形象、来历…">${esc(formSrc.selfImage)}</textarea>
      </label>
      <label>我最初的样子
        <textarea id="mind-f-base" placeholder="还没经历这些事时，是个什么样的人…">${esc(formSrc.baseline)}</textarea>
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
      <div class="hint">可以用 <code>{botName}</code> 占位她的名字；改名字时不用改这里。${mindBirthName ? `　保存后名字将改为「${esc(mindBirthName)}」。` : ''}</div>
      <div class="mind-actions">
        <button class="btn btn-primary btn-small" id="mind-save">${mindBirthName ? `保存并改名为「${esc(mindBirthName)}」` : '保存'}</button>
        <button class="btn btn-small" id="mind-cancel">取消</button>
        <span class="muted" id="mind-save-msg"></span>
      </div>
    </div>` : '';

  box.innerHTML = `
    <div class="mind-wrap">
      ${head}
      ${mindBirthOpen ? mindCard('出生仪式', birthPanel) : ''}
      ${mindEditing ? mindCard('编辑身份', editBody) : ''}
      <div class="mind-grid">
        ${mindCard('身份', identityBody)}
        ${mindCard('她对自己的描述', selfBody)}
      </div>
      <div class="mind-grid">
        ${mindCard('关系', relBody)}
        ${mindCard('节律', rhythmBody)}
      </div>
      ${mindCard('最近反思', refBody)}
    </div>`;

  $('#mind-refresh')?.addEventListener('click', () => loadMindPage());
  $('#mind-edit')?.addEventListener('click', () => { mindEditing = !mindEditing; mindForm = null; renderMindPage(); });
  $('#mind-cancel')?.addEventListener('click', () => { mindEditing = false; mindForm = null; renderMindPage(); });
  $('#mind-save')?.addEventListener('click', saveMindCharter);
  $('#mind-birth')?.addEventListener('click', () => {
    mindBirthOpen = !mindBirthOpen;
    renderMindPage();
  });
  $('#birth-close')?.addEventListener('click', () => {
    mindBirthOpen = false;
    mindBirthDrafts = [];
    renderMindPage();
  });
  $('#birth-gen')?.addEventListener('click', generateBirthDrafts);
  box.querySelectorAll?.('[data-pick-name]')?.forEach((el) => {
    el.addEventListener('click', () => { mindBirthName = el.dataset.pickName; renderMindPage(); });
  });
  box.querySelectorAll?.('[data-apply]')?.forEach((el) => {
    el.addEventListener('click', () => applyBirthDraft(Number(el.dataset.apply)));
  });
}

/** 生成草案（只请求，不写盘）。 */
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
  mindBirthOpen = true;   // 直接生成时也要把面板打开，否则草案渲染在折叠区里看不见
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

/** 采用一组草案：填进编辑表单（仍不写盘，要用户再点保存）。 */
function applyBirthDraft(index) {
  const d = mindBirthDrafts[index];
  if (!d) return;
  const base = mindState?.charter || {};
  mindBirthPick = index;
  mindForm = {
    selfImage: d.selfImage,
    baseline: d.baseline,
    scenarioPrivate: base.scenario?.private || '',
    scenarioGroup: base.scenario?.group || '',
    hardRules: base.hardRules || []
  };
  mindEditing = true;
  renderMindPage();
}

async function saveMindCharter() {
  const val = (id) => String($(`#${id}`)?.value ?? '').trim();
  const charter = {
    selfImage: val('mind-f-self'),
    baseline: val('mind-f-base'),
    scenario: { private: val('mind-f-priv'), group: val('mind-f-group') },
    hardRules: val('mind-f-rules').split('\n').map((s) => s.trim()).filter(Boolean)
  };
  const msg = $('#mind-save-msg');
  if (msg) msg.textContent = '保存中…';
  // 采用草案时选定的名字一并写入。只在这里改 botName：
  // 名字是社交标识，不该被"生成"顺手换掉，必须经过"采用这组"这一步。
  const payload = { persona: { charter } };
  if (mindBirthName) payload.persona.botName = mindBirthName;
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
