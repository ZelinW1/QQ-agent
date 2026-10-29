// 行动管线：八步，每步都可以拦下这次行动。
//
// 为什么要有它：现在的自由行动把"该不该做、能不能做、做没做成"揉在一个函数里，
// 结果是失败原因只能写一句自由文本（`reason`），既没法统计，也没法在界面上说清。
// 拆成八步之后，每一步失败都带**稳定的原因码**，attempt 记录才有意义。
//
// 八步（顺序固定）：
//   resolve    找到这次要做什么（会话、意图、候选）
//   eligibility 静态条件：配置、开关、额度、时间窗
//   permission  权限：扩展是否被允许、技能是否启用
//   validate    参数校验：字段、长度、目标是否存在
//   veto        动态否决：可能要看一眼当前世界（同会话正在跑、刚发过）
//   execute     真正执行（有超时；执行前**重新确认身份**）
//   normalize   把结果整理成统一形状
//   audit       无论成败都写一条记录
//
// 本文件不 import 任何领域模块：步骤由调用方注入，这里只负责"按顺序跑、失败即停、审计必跑"。
// 依赖方向必须保持单向（runtime → 调用方注入），否则端口/领域分层会重新糊在一起。

/**
 * @typedef {{ ok: boolean, code?: string, message?: string, value?: any }} StepResult
 */

/** 管线被拦下时抛的错（内部用，run 会把它转成结果）。 */
class PipelineStop extends Error {
  constructor(step, code, message, detail) {
    super(message || code || step);
    this.name = 'PipelineStop';
    this.step = step;
    this.code = code || 'stopped';
    this.detail = detail;
  }
}

const STEP_NAMES = ['resolve', 'eligibility', 'permission', 'validate', 'veto', 'execute', 'normalize', 'audit'];

/**
 * 建一个管线。
 *
 * @param {object} opts
 * @param {Record<string, Function>} opts.steps 只提供用得到的步骤；缺的跳过
 * @param {number} [opts.executeTimeoutMs] execute 的超时（默认 30 秒）
 * @param {Function} [opts.log] 调试日志
 * @param {Function} [opts.recheck] execute 之前重新确认身份；返回 false 则中止
 */
export function createPipeline({ steps = {}, executeTimeoutMs = 30000, log = null, recheck = null } = {}) {
  const order = STEP_NAMES.filter((name) => typeof steps[name] === 'function');

  /**
   * 跑一次。
   *
   * @param {object} input 传给每一步的上下文（步骤可以往里写，约定只写自己的键）
   * @returns {Promise<{ok:boolean, stoppedAt?:string, code?:string, message?:string,
   *   value?:any, trace:string[], audit?:any}>}
   */
  async function run(input = {}) {
    const trace = [];
    const ctx = { ...input };
    const finish = (result) => {
      // 审计必跑：被拦下的行动也要留下"为什么没做"，否则界面上只剩沉默。
      if (typeof steps.audit === 'function') {
        try {
          const audit = steps.audit(ctx, result);
          return { ...result, trace, audit };
        } catch (error) {
          log?.error?.(`[pipeline] audit 失败：${error?.message ?? error}`);
        }
      }
      return { ...result, trace };
    };

    for (const name of order) {
      if (name === 'audit') continue;
      trace.push(name);

      if (name === 'execute' && typeof recheck === 'function') {
        let stillOk = true;
        try { stillOk = await recheck(ctx); } catch { stillOk = false; }
        if (!stillOk) {
          return finish({ ok: false, stoppedAt: name, code: 'identity-changed', message: '执行前身份已变化，放弃这次行动' });
        }
      }

      let outcome;
      try {
        outcome = name === 'execute'
          ? await withTimeout(Promise.resolve(steps.execute(ctx)), executeTimeoutMs, 'execute')
          : await Promise.resolve(steps[name](ctx));
      } catch (error) {
        if (error instanceof PipelineStop) {
          return finish({ ok: false, stoppedAt: error.step, code: error.code, message: error.message, detail: error.detail });
        }
        if (error?.code === 'timeout') {
          return finish({ ok: false, stoppedAt: name, code: 'timeout', message: `步骤 ${name} 超时` });
        }
        return finish({ ok: false, stoppedAt: name, code: 'error', message: String(error?.message ?? error) });
      }

      // 步骤返回 false / {ok:false} / {stop:true} 都表示"到此为止"
      if (outcome === false) {
        return finish({ ok: false, stoppedAt: name, code: 'stopped', message: `步骤 ${name} 拒绝` });
      }
      if (outcome && typeof outcome === 'object') {
        if (outcome.ok === false || outcome.stop === true) {
          return finish({
            ok: false,
            stoppedAt: name,
            code: String(outcome.code || 'stopped'),
            message: String(outcome.message || outcome.reason || `步骤 ${name} 拒绝`)
          });
        }
        if (outcome.ctx && typeof outcome.ctx === 'object') Object.assign(ctx, outcome.ctx);
        if (outcome.value !== undefined) ctx.value = outcome.value;
      }
    }

    return finish({ ok: true, value: ctx.value, trace });
  }

  return { run, steps: order };
}

function withTimeout(promise, ms, label) {
  const timeout = Math.max(1, Number(ms) || 30000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} 超时（${timeout}ms）`);
      error.code = 'timeout';
      reject(error);
    }, timeout);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export const PIPELINE_STEPS = STEP_NAMES;
