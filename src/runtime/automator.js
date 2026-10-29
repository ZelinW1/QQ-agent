// 自动化执行器：到点跑任务，走同一条八步管线。
//
// 为什么也要过管线：自动化最容易变成"绕过一切规则的旁路"。一旦它能不看权限、
// 不看目标是否存在、失败不留痕，它就会成为系统里最危险的那块代码 ——
// 而它恰恰是"用户配置一次、之后无人看管"的那块。
//
// 与自由时刻共用管线，但走自己的步骤：eligibility 只做开关与并发，**不做**
// 体力/作息/决策次数检查（自动化按设计不受这些限制）。
import { createPipeline } from './pipeline.js';

/**
 * 跑一个任务。
 *
 * @param {object} opts
 * @param {object} opts.task 任务定义
 * @param {Function} opts.execute async (task) => any  真正的动作（发消息/记事件/挂意图）
 * @param {Function} [opts.log]
 * @returns {Promise<{ok:boolean, code?:string, message?:string, value?:any}>}
 */
export async function runAutomation({ task, execute, log = null, timeoutMs = 30000 } = {}) {
  if (typeof execute !== 'function') return { ok: false, code: 'no-executor', message: '没有执行器' };

  const pipe = createPipeline({
    steps: {
      eligibility: () => {
        if (!task || task.enabled === false) return { ok: false, code: 'disabled', message: '任务已停用' };
        if (!task.action) return { ok: false, code: 'no-action', message: '任务没有动作' };
        return undefined;
      },
      validate: () => {
        // 发消息类任务必须有目标；其它动作可以没有。
        if (task.action === 'send' && !String(task.args?.text || '').trim()) {
          return { ok: false, code: 'invalid_args', message: '发消息任务缺少 text' };
        }
        return undefined;
      },
      execute: async () => ({ value: await execute(task) }),
      normalize: (ctx) => ({ value: ctx.value ?? null }),
      audit: () => {
        // 审计由调用方（编排器）写在 markRun 里：那是唯一知道"任务表在哪"的地方。
        return null;
      }
    },
    executeTimeoutMs: timeoutMs,
    log
  });

  const r = await pipe.run({ task });
  return { ok: r.ok, code: r.code, message: r.message, value: r.value };
}
