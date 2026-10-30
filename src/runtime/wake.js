// 唤醒时钟：她下一次什么时候"想起来"。
//
// 设计把两个时钟分开：
//   · impulseAt —— 她自己的冲动，指数分布采样，醒来后重抽；
//   · nextWakeAt —— **按需计算**，取四者最早：
//       min(impulseAt, 最早到期意图, 最早可再做的动作, 最早该联系的会话)
// 不持久化 nextWakeAt：它是派生值，落盘只会带来"文件里的是旧世界"的问题。
//
// 本文件是纯函数，不读配置、不碰存储；调用方把需要的数传进来。

const HOUR = 3600000;

/**
 * 采样下一次冲动时刻（指数分布，均值为 λ 的倒数）。
 *
 * 为什么用指数分布而不是固定间隔：固定间隔会让她的主动行为带上"整点报时"的
 * 机械感；指数分布下"刚醒过又醒"与"很久没醒"都合法，整体频率仍受均值控制。
 *
 * @param {number} now
 * @param {number} meanMs 平均间隔（默认配置 4 小时）
 * @param {() => number} [rng] 测试注入
 * @returns {number} 下一次冲动的时间戳（至少晚于 now 1 分钟）
 */
export function sampleImpulseAt(now, meanMs = 4 * HOUR, rng = Math.random) {
  const mean = Math.max(HOUR / 4, Number(meanMs) || 4 * HOUR);
  const u = Math.min(1 - 1e-9, Math.max(1e-9, Number(rng()) || 1e-9));
  // Exp(λ) 采样：-ln(U)/λ，λ = 1/mean
  const gap = -Math.log(u) * mean;
  return Number(now) + Math.max(60000, Math.round(gap));
}

/**
 * 派生下一次唤醒时间。
 *
 * @param {object} opts
 * @param {number} opts.now
 * @param {number} [opts.impulseAt]        她自己想醒来的时刻
 * @param {number[]} [opts.intentionDueAts] 意图的到期时间列表
 * @param {number[]} [opts.actionRipeAts]  动作的 nextRipeAt 列表
 * @param {number[]} [opts.socialDueAts]   各会话"太久没联系"的时刻
 * @param {number} [opts.maxGapMs]         兜底上限（默认 6 小时）：没有任何到期源时也别睡太久
 * @returns {{at:number, reason:string}}
 */
export function nextWakeAt({ now, impulseAt = 0, intentionDueAts = [], actionRipeAts = [], socialDueAts = [], maxGapMs = 6 * HOUR } = {}) {
  const at = Number(now) || Date.now();
  const candidates = [];
  // 已经过点（含"刚刚到点"）都算现在就该醒：把时间夹到现在，而不是排到未来。
  if (Number(impulseAt) > 0) candidates.push({ at: Math.max(at, Number(impulseAt)), reason: 'impulse' });
  for (const due of intentionDueAts) {
    const t = Number(due);
    if (t > 0) candidates.push({ at: Math.max(at, t), reason: 'intention' });
  }
  for (const ripe of actionRipeAts) {
    const t = Number(ripe);
    if (t > 0) candidates.push({ at: Math.max(at, t), reason: 'action-ripe' });
  }
  for (const due of socialDueAts) {
    const t = Number(due);
    if (t > 0) candidates.push({ at: Math.max(at, t), reason: 'social' });
  }
  // 没有任何已知来源：给一个上限，避免"再也不醒"
  if (!candidates.length) {
    return { at: at + Math.max(HOUR / 2, Number(maxGapMs) || 6 * HOUR), reason: 'fallback' };
  }
  candidates.sort((a, b) => a.at - b.at);
  return candidates[0];
}

/**
 * 门禁：现在到底能不能醒。
 *
 * 设计里这些是**独立**的一层：候选为空不等于不能醒（目录保证总有可选项）；
 * 但睡着 / 暂停 / 会话在跑 / 刚醒过 / 预算用完，就是真的不能醒。
 *
 * @param {object} s
 * @param {number} s.now
 * @param {boolean} [s.asleep]
 * @param {boolean} [s.paused]
 * @param {boolean} [s.aborted]
 * @param {number} [s.energy]
 * @param {number} [s.energyFloor]
 * @param {number} [s.todayDecisions]
 * @param {number} [s.maxDecisionsPerDay]
 * @param {number} [s.lastWakeAt]
 * @param {number} [s.tooSoonMs]
 * @param {boolean} [s.chatPending]
 * @param {boolean} [s.chatRunning]
 * @param {number} [s.costTodayUsd]
 * @param {number} [s.costCapUsd]
 * @param {boolean} [s.hasModel]
 * @returns {{ok:boolean, code:string, reason:string}}
 */
export function checkGates(s = {}) {
  const now = Number(s.now) || Date.now();
  const no = (code, reason) => ({ ok: false, code, reason });

  if (s.aborted) return no('aborted', '已中止');
  if (s.paused) return no('paused', '已暂停');
  if (!s.hasModel) return no('no-model', '没有可用的模型');
  if (s.asleep) return no('asleep', '睡着了');
  if (Number(s.energy) < Number(s.energyFloor ?? 10)) return no('tired', '体力不够');
  if (Number(s.todayDecisions) >= Number(s.maxDecisionsPerDay ?? 24)) return no('decision-cap', '今天的决策次数用完了');
  if (s.chatRunning) return no('chat-running', '正在跟人说话');
  if (s.chatPending) return no('chat-pending', '马上要回消息');
  const tooSoon = Math.max(0, Number(s.tooSoonMs) || 0);
  if (tooSoon > 0 && Number(s.lastWakeAt) > 0 && now - Number(s.lastWakeAt) < tooSoon) {
    return no('too-soon', '刚醒过');
  }
  if (Number(s.costCapUsd) > 0 && Number(s.costTodayUsd) >= Number(s.costCapUsd)) {
    return no('cost-cap', '今天的成本到上限了');
  }
  return { ok: true, code: '', reason: '' };
}

/**
 * 把门禁结果压成一行给人看的话（UI / 日志用）。
 * @param {{code:string, reason:string}} gate
 */
export function describeGate(gate = {}) {
  const map = {
    asleep: '她睡着了',
    paused: '已暂停',
    aborted: '已中止',
    tired: '体力不够',
    'decision-cap': '今天的决策次数用完了',
    'chat-running': '正在跟人说话',
    'chat-pending': '马上要回消息',
    'too-soon': '刚醒过',
    'cost-cap': '今天的成本到上限了',
    'no-model': '没有可用的模型'
  };
  return map[gate.code] || gate.reason || gate.code || '可以醒';
}
