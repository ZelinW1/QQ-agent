// 行动注册表：心跳醒来后，她可以做的事。
//
// 为什么要有注册表而不是写死的 if/else：
//   后面要接 MCP、要让她习得新动作时，只需要往这里加一条，
//   决策提示词和前置判断都会自动跟上。
//
// 每个动作的契约：
//   id / label / description  —— 会进决策提示词，措辞要是她能理解的人话
//   energy                    —— 消耗多少体力（同时是天然限流）
//   when(state)               —— 前置条件；返回 false 或 {ok:false,reason} 表示不可用
//   run(ctx, args)            —— 真正执行；ctx 由编排器注入（不 import 编排器，防循环依赖）
//
// 设计上刻意让"不可用的动作不进菜单"：她看不到被拒绝的选项，
// 就不会产生"想做但被拦住"的挫败感。
import { actionBlocked } from './tick.js';

/** 内置动作。顺序即菜单顺序（idle 放最后，符合"优先什么都不做"）。 */
export const ACTIONS = [
  {
    id: 'send_proactive',
    label: '主动找她说句话',
    description: '有话想说、有件挂心的事、或者真的很久没联系了才用',
    energy: 25,
    // 效用信号（设计 §4.5.2）：这个动作有没有用，看"对方回没回"。
    utility: 'echo',
    // 嵌套运行（设计 §4.7）：这个动作会叫起一次完整的聊天运行。
    // 深度上限 1：她可以在自由时刻找人说话，但那场对话里不能再套一层。
    composite: { runtime: 'chat', maxDepth: 1 },
    when: (s) => {
      if (Number(s.todayProactive) >= Number(s.maxProactive)) return { ok: false, reason: '今天已经说过几次了' };
      const now = Number(s.now) || Date.now();
      if (Number(s.lastProactiveAt) > 0 && now - Number(s.lastProactiveAt) < Number(s.minProactiveGapMs)) {
        return { ok: false, reason: '刚说完没多久' };
      }
      return true;
    },
    async run(ctx) {
      return ctx.proactive();
    }
  },
  {
    id: 'organize',
    label: '整理一下记忆',
    description: '把攒着的事想清楚、更新对人的看法',
    energy: 15,
    // 效用信号：整理完"没整理的事"有没有变少 / 有没有产出新看法。
    // 不能拿"对方回没回"判它 —— 整理是给自己做的，不需要观众。
    utility: 'debt',
    when: (s) => {
      if (Number(s.unreflected) < Number(s.organizeMinEvents || 3)) {
        return { ok: false, reason: '还没攒下多少事' };
      }
      // 与后台自动反思共用同一条冷却：否则她可以每隔几分钟"整理一次"，
      // 反复烧体力和决策额度（真实模拟里抓到的就是这个）。
      const now = Number(s.now) || Date.now();
      const lastAttempt = Number(s.lastReflectAttemptAt) || 0;
      const cooldown = Number(s.reflectCooldownMs) || 0;
      if (lastAttempt > 0 && cooldown > 0 && now - lastAttempt < cooldown) {
        return { ok: false, reason: '刚整理过不久' };
      }
      return true;
    },
    async run(ctx) {
      return ctx.reflect();
    }
  },
  {
    id: 'recall',
    label: '回想一些事',
    description: '翻翻更早的记忆，看看有没有值得想起的',
    energy: 5,
    // 效用信号：这次回想有没有真的翻出东西。
    utility: 'recall',
    // 回想不会改变现场（旧事还在那儿），所以做完要给候选打个盹，
    // 否则同一个"有件事没问"会让她每隔十分钟回想一次。
    snoozeMs: 3 * 3600 * 1000,
    async run(ctx) {
      return ctx.recall();
    }
  },
  {
    id: 'remember',
    label: '记一笔',
    description: '把刚才聊到的、值得留下的写进记忆；拿不准可以先回想一下再写',
    energy: 5,
    // 写记忆/挂意图/再撑一会儿没有短期可观测的效用：
    // 宁可没有统计，也不要拿"对方回了话"冒充它有用。
    utility: 'none',
    async run(ctx, args) {
      return ctx.remember(args || {});
    }
  },
  {
    id: 'plan',
    label: '记下要做的事',
    description: '把"过一会儿/明天想做的事"记下来，到点你会想起来；不用现在做',
    energy: 3,
    utility: 'none',
    async run(ctx, args) {
      return ctx.plan(args || {});
    }
  },
  {
    id: 'stay_up',
    label: '再撑一会儿',
    description: '还不想睡，再待一会儿再睡',
    energy: 0,
    utility: 'none',
    when: (s) => {
      if (Number(s.inSleepWindow) !== 1) return { ok: false, reason: '还不到睡觉的点' };
      if (Number(s.stayUps) >= Number(s.maxStayUp)) return { ok: false, reason: '不能再撑了，该睡了' };
      return true;
    },
    async run(ctx) {
      return ctx.stayUp();
    }
  },
  {
    id: 'idle',
    label: '什么都不做',
    description: '没有真的想做的事就选这个',
    energy: 0,
    async run() {
      return { done: true };
    }
  }
];

/** 按 id 取动作。 */
export function getAction(id) {
  return ACTIONS.find((a) => a.id === id) || null;
}

/**
 * 内置动作 + 配置里的体力成本。
 *
 * 早先体力是写死在 actions.js 里的（25/15/5），而 config.mind.energy.cost
 * 是一份没人读的死配置 —— 用户在设置里改了也不会生效。现在统一从这里取。
 */
export function actionsWithCosts(cfg = {}) {
  const costs = (cfg && cfg.energy && cfg.energy.cost) || {};
  return ACTIONS.map((a) => {
    const c = Number(costs[a.id]);
    return Number.isFinite(c) && c >= 0 ? { ...a, energy: c } : a;
  });
}

/**
 * 当前可用的动作（已过前置条件与体力检查）。
 * 菜单只列这些，所以被拦下的动作她根本看不到。
 *
 * @param {object} state
 * @param {object[]} [actions] 允许传入已解析成本的动作表（内置 + 扩展）
 */
export function availableActions(state = {}, actions = ACTIONS) {
  return actions.filter((a) => actionBlocked(a, state) === null);
}

/** 被拦下的动作及原因（菜单里最多列几条，让她知道"以后能做"）。 */
export function blockedActions(state = {}, actions = ACTIONS) {
  return actions
    .map((a) => ({ action: a, reason: actionBlocked(a, state) }))
    .filter((x) => x.reason);
}
