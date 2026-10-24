// 作息：夜里她会睡着，早上醒来。
//
// 为什么这不是"加个静音开关"：睡着是一种**状态**，它同时改变三件事
//   1. 心跳不再做决策（省钱，也符合"人睡了就不折腾"）
//   2. 收到的消息**看不见**（只入库，不唤醒）—— 早上醒来才一起读
//   3. 醒来时把积压的消息当一批处理（而不是一条条补回）
//
// 两个刻意的设计：
//   · 入睡/醒来时间**每晚有随机抖动**（默认 ±40 分钟，可配）。固定 23:30 入睡
//     像一个设置项，不像一个人。抖动由当晚的 nightKey 派生，所以同一天内
//     反复计算得到同一个窗口（不能用 Math.random，否则每次心跳的入睡时间都在变）。
//   · 入睡前有"安静宽限"：刚刚还在聊天就不会立刻睡着，得先静一会儿。
//     另外她可以在入睡窗口里选"再撑一会儿"（次数有上限），避免
//     "上一刻还在聊天，下一秒直接睡了"。
//
// 本文件只有纯函数：不算 IO、不调模型，便于单测。

const MIN = 60000;
const HOUR = 3600000;

function hashSeed(s) {
  let h = 2166136261;
  const text = String(s);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 由窗口键派生一个 [-1,1] 的确定性系数。 */
function unitFrom(key) {
  return (hashSeed(key) % 10000) / 10000 * 2 - 1;
}

function parseHHMM(hour, minute, fallbackH, fallbackM) {
  const h = Number.isFinite(Number(hour)) ? Math.min(23, Math.max(0, Math.round(Number(hour)))) : fallbackH;
  const m = Number.isFinite(Number(minute)) ? Math.min(59, Math.max(0, Math.round(Number(minute)))) : fallbackM;
  return { h, m };
}

function dayKeyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 解析"今晚"的入睡窗口。
 *
 * 窗口跨午夜（默认 23:30 → 次日 08:00）。凌晨时段（hour < endHour）
 * 属于**前一晚**，否则凌晨 2 点会被算成"今天的睡前"，窗口就错位了。
 *
 * @param {number} now
 * @param {object} cfg mind.sleep
 * @returns {{nightKey:string, startAt:number, endAt:number, startAtBase:number, endAtBase:number}}
 */
export function resolveSleepWindow(now = Date.now(), cfg = {}) {
  const start = parseHHMM(cfg.startHour, cfg.startMinute, 23, 30);
  const end = parseHHMM(cfg.endHour, cfg.endMinute, 8, 0);
  const jitterMin = Math.min(180, Math.max(0, Number(cfg.jitterMin) || 0));

  const d = new Date(now);
  // 凌晨属于前一晚：以"结束时刻"为界
  if (d.getHours() < end.h) d.setDate(d.getDate() - 1);
  const nightKey = dayKeyOf(d);

  const startBase = new Date(d.getFullYear(), d.getMonth(), d.getDate(), start.h, start.m, 0, 0).getTime();
  let endBase = new Date(d.getFullYear(), d.getMonth(), d.getDate(), end.h, end.m, 0, 0).getTime();
  // 结束早于开始 = 跨午夜
  if (endBase <= startBase) endBase += 24 * HOUR;

  const startJitter = Math.round(unitFrom(`${nightKey}|start`) * jitterMin) * MIN;
  const endJitter = Math.round(unitFrom(`${nightKey}|end`) * jitterMin) * MIN;

  return {
    nightKey,
    startAt: startBase + startJitter,
    endAt: endBase + endJitter,
    startAtBase: startBase,
    endAtBase: endBase
  };
}

/**
 * 判断此刻该不该睡。
 *
 * 状态机很浅，但顺序重要：
 *   ① 窗口外 → 醒着（如果之前睡着，就是该醒了）
 *   ② 窗口内但"还没到入睡点" → 醒着（还没到点 / 她选择了再撑一会）
 *   ③ 到点了但刚刚还在聊天 → 醒着（安静宽限）
 *   ④ 其余 → 睡着
 *
 * @param {object} p
 * @param {number} p.now
 * @param {object} p.window resolveSleepWindow 的结果
 * @param {object} [p.state] tick.sleep（stayUps / nightKey）
 * @param {number} [p.quietForMs] 距最近一次活动多久（Infinity = 一直很安静）
 * @param {object} p.cfg mind.sleep
 * @returns {{asleep:boolean, inWindow:boolean, startAt:number, endAt:number, effectiveSleepAt:number, nightKey:string, reason:string}}
 */
export function classifySleep({
  now = Date.now(),
  window,
  state = {},
  quietForMs = Infinity,
  cfg = {}
} = {}) {
  const w = window || resolveSleepWindow(now, cfg);
  const enabled = cfg.enabled === true;
  const inWindow = now >= w.startAt && now < w.endAt;

  if (!enabled) {
    return { asleep: false, inWindow: false, startAt: 0, endAt: 0, effectiveSleepAt: 0, nightKey: w.nightKey, reason: '未启用' };
  }

  // 换夜了：她的"再撑一会"次数不该带到下一晚
  const sameNight = String(state?.nightKey || '') === String(w.nightKey);
  const stayUps = sameNight ? Math.max(0, Math.min(10, Number(state?.stayUps) || 0)) : 0;
  const stayUpMs = Math.max(0, Number(cfg.stayUpMs) || 30 * MIN);
  const effectiveSleepAt = w.startAt + stayUps * stayUpMs;

  if (!inWindow) {
    return {
      asleep: false, inWindow: false,
      startAt: w.startAt, endAt: w.endAt, effectiveSleepAt,
      nightKey: w.nightKey,
      reason: now < w.startAt ? '还没到睡觉的点' : '已经醒了'
    };
  }

  if (now < effectiveSleepAt) {
    return {
      asleep: false, inWindow: true,
      startAt: w.startAt, endAt: w.endAt, effectiveSleepAt,
      nightKey: w.nightKey,
      reason: '还不想睡'
    };
  }

  const graceMs = Math.max(0, Number(cfg.graceMs) || 15 * MIN);
  if (quietForMs < graceMs) {
    return {
      asleep: false, inWindow: true,
      startAt: w.startAt, endAt: w.endAt, effectiveSleepAt,
      nightKey: w.nightKey,
      reason: '刚还在聊天，先不睡'
    };
  }

  return {
    asleep: true, inWindow: true,
    startAt: w.startAt, endAt: w.endAt, effectiveSleepAt,
    nightKey: w.nightKey,
    reason: '夜里睡着了'
  };
}

/** 供日志/UI 展示的时间段文本，例如 "23:12 – 08:27（今晚）"。 */
export function describeWindow(window) {
  if (!window) return '';
  const fmt = (ts) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return `${fmt(window.startAt)} – ${fmt(window.endAt)}`;
}
