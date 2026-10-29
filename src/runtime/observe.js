// 观察队列：她做过的事，过一阵子回头看一眼有没有用。
//
// 为什么要等：发完消息她不知道对方看没看、回没回；立刻判定只能判"发出去了"。
// 所以一次尝试之后开一个窗口（默认 72 小时），到期才复查。
//
// 判定全部是机械的，不调模型：
//   · 窗口内对方有任何动静（新事件且不是她自己说的）→ changed
//   · 窗口内只有她自己在说，或者什么都没发生         → unchanged
//   · 会话已经不在、或者根本查不到                   → void
//
// 为什么不做"好/坏"的价值判断：那是反思与整合的事。观察只回答"世界有没有变化"，
// 它给的是原料，不是结论。

/**
 * 对一条到期的观察下判定。
 *
 * @param {object} opts
 * @param {object} opts.observation 一条观察（`{ at, chatKey, windowUntil? }`）
 * @param {object[]} opts.events 该会话 **在观察开始之后** 的事件（调用方负责切窗口）
 * @param {number} [opts.now]
 * @returns {{verdict:'changed'|'unchanged'|'void', note:string}}
 */
export function verdictFor({ observation = {}, events = [], now = Date.now() } = {}) {
  const since = Number(observation.at) || 0;
  if (!since) return { verdict: 'void', note: '观察记录不完整' };

  const after = (Array.isArray(events) ? events : [])
    .filter((e) => Number(e?.ts) > since);
  // 判定值用 hit / missed / void（设计 §4.5）：能不能被回声命中，
  // 直接决定这个动作下一次的期望间隔变长还是变短。
  if (!after.length) return { verdict: 'missed', note: '窗口内没有新的动静' };

  const fromOther = after.some((e) => {
    const actor = String(e?.actorId || '');
    return actor && actor !== 'self';
  });
  if (fromOther) return { verdict: 'hit', note: '对方有回应' };
  return { verdict: 'void', note: '只有她自己在说话，判断不了' };
}

/**
 * 把到期的观察逐条判掉。
 *
 * @param {object} opts
 * @param {object} opts.port 运行时端口（openObservations / recentEvents）
 * @param {number} [opts.now]
 * @param {number} [opts.limit]
 * @returns {{checked:number, changed:number, unchanged:number, void:number}}
 */
export function drainDueObservations({ port, now = Date.now(), limit = 10, onResolved = null } = {}) {
  const summary = { checked: 0, hit: 0, missed: 0, void: 0, resolved: [] };
  if (!port || typeof port.openObservations !== 'function') return summary;

  let due = [];
  try { due = port.openObservations(now) || []; } catch { return summary; }

  for (const ob of due.slice(0, limit)) {
    const chatKey = String(ob?.chatKey || '');
    let events = [];
    try {
      events = chatKey ? (port.recentEvents({ chatKey, limit: 50 }) || []) : [];
    } catch { events = []; }

    const { verdict, note } = verdictFor({ observation: ob, events, now });
    try {
      port.resolveObservation?.(ob.id, { verdict, note, now });
      summary.checked += 1;
      summary[verdict] += 1;
      summary.resolved.push({ id: ob.id, action: String(ob.action || ''), chatKey: String(ob.chatKey || ''), verdict });
      // 就地回写到动作统计：这是观测队列唯一真正"改变下一次行为"的地方。
      if (typeof onResolved === 'function' && ob.action) {
        try { onResolved({ action: String(ob.action), verdict, chatKey: String(ob.chatKey || '') }); } catch { /* 记账失败不影响判定 */ }
      }
    } catch { /* 单条失败不影响其它 */ }
  }
  return summary;
}
