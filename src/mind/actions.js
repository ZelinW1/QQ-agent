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
    when: (s) => {
      if (Number(s.unreflected) < Number(s.organizeMinEvents || 3)) {
        return { ok: false, reason: '还没攒下多少事' };
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
    async run(ctx) {
      return ctx.recall();
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
 * 当前可用的动作（已过前置条件与体力检查）。
 * 菜单只列这些，所以被拦下的动作她根本看不到。
 */
export function availableActions(state = {}) {
  return ACTIONS.filter((a) => actionBlocked(a, state) === null);
}
