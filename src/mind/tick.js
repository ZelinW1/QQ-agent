// 心跳的纯逻辑：结算、候选预判、决策提示词、解析。
//
// 这里**不碰 IO、不调模型**，只做计算 —— 因为心跳每 5 分钟一次，
// 其中 90% 应该在这几个函数里就走完、花 0 token。
// 真正调模型的那一步在 orchestrator（#tickOnce），只有候选非空才发生。
//
// 术语：
//   结算（settle）  —— 纯算术：能量恢复、跨天清零
//   预判（precheck）—— 几条 if：有没有值得考虑的事
//   决策（decide）  —— 调模型，极小上下文，只决定"做什么"，不决定"说什么"

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * 能量结算。
 *
 * 按"上次结算到现在的时间差"补，而不是靠定时器累加 ——
 * 心跳可能因为休眠/卡顿漏跑，累加会丢能量，时间差不会。
 *
 * @param {object} tick 现有 tick 状态
 * @param {number} now
 * @param {object} energyCfg config.mind.energy
 * @returns {object} 新的 tick 状态（不修改入参）
 */
export function settleEnergy(tick = {}, now = Date.now(), energyCfg = {}) {
  const max = Math.max(1, Number(energyCfg.max) || 100);
  const perHour = Math.max(0, Number(energyCfg.recoverPerHour) || 0);
  const prev = Number(tick.energy);
  const prevAt = Number(tick.energyAt) || 0;

  // 首次运行（energyAt=0）不该"补"出天文数字：以当前能量为准，只记下起点。
  const energy = prevAt > 0 && Number.isFinite(prev)
    ? clamp(prev + ((now - prevAt) / 3600000) * perHour, 0, max)
    : clamp(Number.isFinite(prev) ? prev : max, 0, max);

  return { ...tick, energy, energyAt: now };
}

/**
 * 跨天清零。
 *
 * 只清"按天计"的计数器；能量、lastReflectAt 这些跨天延续的不动。
 */
export function resetDaily(tick = {}, today = '') {
  const day = String(today || '');
  if (!day || tick.today === day) return { ...tick, today: tick.today || day };
  return {
    ...tick,
    today: day,
    todayProactive: 0,
    todayDecisions: 0,
    todayReflections: 0
  };
}

/**
 * 廉价预判：这次心跳有没有"值得考虑"的事。
 *
 * 返回的每条都带一句人话理由 —— 它会原样进决策提示词，
 * 所以措辞要是她自己的想法，不是系统日志。
 *
 * @param {object} p
 * @param {number} p.now
 * @param {number} p.energy
 * @param {number} p.lastInteractionAt 距上次互动
 * @param {object[]} [p.openLoops] 这个人的未完结事项
 * @param {number} [p.unreflected] 未反思事件数
 * @param {object} [p.cfg] config.mind
 * @returns {{id:string, text:string}[]}
 */
export function collectCandidates({
  now = Date.now(),
  energy = 0,
  lastInteractionAt = 0,
  lastEventAt = 0,
  openLoops = [],
  unreflected = 0,
  cfg = {}
} = {}) {
  const out = [];
  const tickCfg = cfg.tick || {};
  const energyCfg = cfg.energy || {};
  const costs = energyCfg.cost || {};
  const floor = Number(energyCfg.floor) || 10;

  // 1) 有件想问的事拖太久了
  const openLoopDueMs = Math.max(3600000, Number(tickCfg.openLoopDueMs) || 24 * 3600000);
  const due = (Array.isArray(openLoops) ? openLoops : []).filter((l) => {
    const since = Number(l?.since) || 0;
    return since > 0 && now - since >= openLoopDueMs;
  });
  if (due.length) {
    const first = String(due[0]?.text || '').trim();
    out.push({
      id: 'open_loop',
      text: first ? `有件事一直没问：「${first}」` : '有件事一直没问'
    });
  }

  // 2) 很久没说话，可能想她了
  const idleMs = Math.max(600000, Number(tickCfg.proactiveIdleMs) || 6 * 3600000);
  if (lastInteractionAt > 0 && now - lastInteractionAt >= idleMs) {
    const hours = Math.round((now - lastInteractionAt) / 3600000);
    out.push({ id: 'miss_you', text: `已经 ${hours} 小时没联系了` });
  }

  // 3) 攒了太多没整理的事
  const need = Math.max(1, Number(cfg.reflectAfterEvents) || 8);
  if (unreflected >= need) {
    out.push({ id: 'reflect_pending', text: `攒了 ${unreflected} 件没整理的事` });
  }

  // 4) 刚聊过、但还没有任何事件：这是一个"要不要记下"的分叉点。
  //    没有它的话，"记一笔"只能等到几小时后因为别的原因醒来才可能出现，
  //    到那时对话细节早就只剩最后一句了。
  const rememberWindowMs = Math.max(600000, Number(tickCfg.rememberWindowMs) || 12 * 3600000);
  if (lastInteractionAt > 0) {
    const sinceChat = now - lastInteractionAt;
    const stillFresh = sinceChat <= rememberWindowMs;
    const nothingRecorded = !(Number(lastEventAt) >= Number(lastInteractionAt));
    if (stillFresh && nothingRecorded && sinceChat >= 120000) {
      out.push({ id: 'unprocessed', text: '刚才聊了几句，还没记下什么' });
    }
  }

  // 体力低于下限：什么都不想，直接歇着。
  // 放在最后统一判断，而不是逐个候选判断 —— 累了就是累了，不是因为哪件事不值得。
  if (energy < floor) return [];
  return out;
}

/**
 * 决策提示词的 system 段（逐字稳定，用于前缀缓存）。
 *
 * 单会话决策与全局唤醒共用同一段 —— 两者唯一的差别在 user（状态与素材）。
 */
export function buildDecisionSystem({ name = '她', actions = [] } = {}) {
  const who = String(name || '她').trim() || '她';
  return [
    `你是${who}。`,
    '现在没有人找你，你自己待着。根据下面的状态，决定要不要做点什么。',
    '',
    '原则：',
    '- 优先什么都不做。没有真的想做的事，就选 idle。',
    '- 主动找人说话要有理由：有话想说、有件挂心的事、或者真的很久没联系了。',
    '- 不要因为"该做点什么"而做点什么。',
    '- 只输出 JSON：{"action":"动作id","args":{},"reason":"一句给自己看的理由"}',
    '',
    '动作：',
    ...actions.map((a) => `- ${a.id}：${a.label}${a.description ? `。${a.description}` : ''}（消耗 ${a.energy ?? 0} 体力）`)
  ].join('\n');
}

/**
 * 下一次心跳时间：固定间隔 + 抖动。
 *
 * 抖动是为了避免所有会话在同一秒醒来（那会形成周期性的成本尖峰，
 * 也让行为看起来很机械）。
 */
export function nextTickAt(now = Date.now(), intervalMs = 300000, jitter = 0.1, rand = Math.random) {
  const base = Math.max(60000, Number(intervalMs) || 300000);
  const j = Math.min(0.5, Math.max(0, Number(jitter) || 0));
  const factor = 1 + (rand() * 2 - 1) * j;
  return now + Math.round(base * factor);
}

/** 动作是否可用（前置条件）。返回 null 表示可用，否则返回原因。 */
export function actionBlocked(action, state) {
  if (!action) return '没有这个动作';
  const energy = Number(state?.energy) || 0;
  if (energy < (Number(action.energy) || 0)) return '体力不够';
  if (typeof action.when === 'function') {
    try {
      const r = action.when(state);
      if (r === false) return '现在不适合';
      if (r && typeof r === 'object' && r.ok === false) return String(r.reason || '现在不适合');
    } catch { return '前置判断出错'; }
  }
  return null;
}

// ── 全局唤醒：roster 与提示词 ──────────────────────────────────────────

/** 把一段可能很长的消息压成一行线索（roster 里每条只占一行）。 */
export function truncateText(text, max = 30) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * roster 排序分数。数值只为排序，不代表"重要性"承诺。
 *   有未读 > 有到期未完结 > 沉默越久 > 关系越亲近
 */
export function scoreRosterEntry({ unread = 0, openLoopsDue = 0, hoursSince = 0, warmth = 0 } = {}) {
  return (Number(unread) > 0 ? 100 : 0)
    + (Number(openLoopsDue) > 0 ? 50 : 0)
    + Math.min(30, Math.max(0, Number(hoursSince) || 0))
    + Math.min(10, Math.max(0, Number(warmth) || 0) / 10);
}

/**
 * 全局唤醒的决策提示词。
 *
 * 与单会话版的区别只在 user：这里给的是**一份 roster（几个人）**。
 * system 逐字相同，所以两套模式共享同一份缓存前缀。
 *
 * @param {object} p
 * @param {string} [p.botName]
 * @param {object} p.state { energy, todayProactive, maxProactive }
 * @param {object[]} p.roster 已排序的会话摘要（top N）
 * @param {{id:string,text:string,chatKey?:string,name?:string}[]} p.candidates
 * @param {object[]} p.actions
 * @param {number} [p.now]
 * @param {number} [p.restCount] 未进 roster 的会话数
 * @param {string} [p.lastAction] 上次行动摘要（"3 小时前：找王哥说话"）
 */
export function buildGlobalDecisionPrompt({
  botName = '她', state = {}, roster = [], candidates = [], actions = [],
  now = Date.now(), restCount = 0, lastAction = null, blocked = [], materials = ''
} = {}) {
  const name = String(botName || '她').trim() || '她';
  const system = buildDecisionSystem({ name, actions });

  const lines = [
    `现在：${new Date(now).toLocaleString('zh-CN', { hour12: false })}`,
    `体力：${Math.round(Number(state.energy) || 0)}`,
    `今天已经主动说过 ${Number(state.todayProactive) || 0} 次话`
  ];

  // 素材段（她是谁 / 最近写下什么 / 还惦记什么）。没有素材就整段不出现，
  // 而不是留一个空标题 —— 空段会让模型以为"这一项是空的"，而不是"没这一项"。
  const materialText = String(materials || '').trim();
  if (materialText) lines.push('', '【现在的你】', materialText);

  if (roster.length) {
    lines.push('', '你最近留意到的人：');
    for (const r of roster) {
      const bits = [];
      if (r.stageLabel) bits.push(String(r.stageLabel));
      const h = Number(r.hoursSince);
      if (r.hoursSince !== null && r.hoursSince !== undefined && Number.isFinite(h)) {
        bits.push(h >= 24 ? `${Math.round(h / 24)} 天前` : `${h} 小时前`);
      }
      if (Number(r.unread) > 0) bits.push(`${Number(r.unread)} 条未读`);
      lines.push(`- ${r.name}${bits.length ? `（${bits.join('，')}）` : ''}${r.lastLine ? `：「${r.lastLine}」` : ''}`);
      if (Number(r.openLoopsDue) > 0) lines.push('  · 有件事一直没问');
    }
    if (Number(restCount) > 0) lines.push(`（另外还有 ${Number(restCount)} 个会话，最近都很安静）`);
  }

  if (candidates.length) {
    lines.push('', '你想到的：');
    for (const c of candidates) lines.push(`- ${c.name ? `${c.name}：` : ''}${c.text}`);
  } else {
    lines.push('', '你没想到什么特别的。');
  }

  // 被拦下的动作只列几条并附原因：让她知道"以后能做"，
  // 但不让 prompt 被一堆做不了的选项撑爆。
  if (Array.isArray(blocked) && blocked.length) {
    lines.push('', '现在做不了的：');
    for (const b of blocked) {
      const label = b?.action?.label || b?.action?.id || '某项行动';
      lines.push(`- ${label}：${b?.reason || '现在不适合'}`);
    }
  }

  if (lastAction) lines.push('', `上次行动：${lastAction}`);

  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') }
  ];
}

