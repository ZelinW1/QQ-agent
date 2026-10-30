// 一次"时刻"里的模型循环：工具驱动的多步执行。
//
// 为什么单独成模块：这是四种运行时（chat / free / integrate / automate）将来要共享的
// 那段骨架——调模型、执行工具、把结果回灌、直到她自己收手。现在 free 先用它，
// 其它场合逐步接过来；逻辑集中在一处，才不会出现"四处各写一个循环"。
//
// 本模块只管循环与用量统计；"该不该做、能不能做、做成了没"由调用方经 onCall 走管线。

/**
 * @param {object} opts
 * @param {(messages:object[], tools:object[]) => Promise<object>} opts.callModel
 * @param {object[]} opts.messages 初始消息（system + user），会被拷贝
 * @param {object[]} opts.tools
 * @param {(call:{id:string,name:string,args:object}) => Promise<{ok:boolean, result?:any, error?:string}>} opts.onCall
 * @param {number} [opts.maxSteps]
 * @param {(msg:object) => void} [opts.log]
 * @returns {Promise<{ok:boolean, executed:object[], idleReason:string, usage:number, steps:number, error?:string}>}
 */
export async function runAgentLoop({
  callModel,
  messages = [],
  tools = [],
  onCall,
  maxSteps = 5,
  log = null
} = {}) {
  const convo = messages.slice();
  const executed = [];
  let idleReason = '';
  let usage = 0;
  let steps = 0;

  const stepsCap = Math.max(1, Math.min(12, Number(maxSteps) || 5));

  for (let step = 0; step < stepsCap; step++) {
    steps += 1;
    let res;
    try {
      res = await callModel(convo, tools);
    } catch (error) {
      log?.(`[agent] 模型调用失败：${error?.message ?? error}`);
      return { ok: false, executed, idleReason, usage, steps, error: String(error?.message ?? error) };
    }
    usage += Number(res?.usage?.total_tokens) || 0;

    const msg = res?.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const content = typeof msg.content === 'string' ? msg.content.trim() : '';

    // 没有工具调用 = 她自己收手了（只写正文也算收手）
    if (!calls.length) {
      idleReason = content || (executed.length ? '' : '没有调用任何动作');
      break;
    }

    convo.push({
      role: 'assistant',
      content: msg.content ?? null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.function?.name, arguments: c.function?.arguments ?? '{}' }
      }))
    });

    const finishCall = calls.find((c) => c.function?.name === 'finish');
    for (const call of calls) {
      const name = String(call.function?.name || '');
      if (name === 'finish') continue;
      let args = {};
      try { args = JSON.parse(String(call.function?.arguments || '{}')) || {}; } catch { args = {}; }

      let outcome;
      try {
        outcome = await onCall({ id: String(call.id || ''), name, args });
      } catch (error) {
        outcome = { ok: false, error: String(error?.message ?? error) };
      }
      if (!outcome || typeof outcome !== 'object') outcome = { ok: false, error: '执行没有返回结果' };

      if (outcome.ok) {
        executed.push({ name, args, result: outcome.result ?? null });
      }
      convo.push({
        role: 'tool',
        tool_call_id: String(call.id || ''),
        content: JSON.stringify(outcome.ok
          ? { ok: true, result: outcome.result ?? null }
          : { ok: false, error: outcome.error || '没有做成' }).slice(0, 1500)
      });
    }

    if (finishCall) {
      try {
        const fa = JSON.parse(String(finishCall.function?.arguments || '{}')) || {};
        idleReason = String(fa.reason || idleReason || '').slice(0, 120);
      } catch { /* 忽略解析失败 */ }
      convo.push({ role: 'tool', tool_call_id: String(finishCall.id || ''), content: JSON.stringify({ ok: true }) });
      break;
    }
  }

  return { ok: true, executed, idleReason, usage, steps, messages: convo };
}

/**
 * 配置摘要：回答"她这几天的变化是她的变化，还是配置的变化"。
 * 只取会影响行为的字段，避免改个界面颜色也让摘要变化。
 *
 * @param {object} cfg
 * @param {(s:string)=>string} hash 注入的哈希函数（不引 crypto，纯字符串即可）
 */
export function digestConfig(cfg = {}, hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}) {
  const m = cfg.mind || {};
  const pick = {
    model: String(cfg.api?.model || ''),
    scope: String(m.scope || ''),
    energy: m.energy || {},
    tick: { maxDecisionsPerDay: m.tick?.maxDecisionsPerDay, maxProactivePerDay: m.tick?.maxProactivePerDay },
    reflect: { after: m.reflectAfterEvents, cooldown: m.reflectCooldownMs },
    integrate: { max: m.integrate?.maxPerDay, cooldown: m.integrate?.cooldownMs },
    narrative: { every: m.narrative?.everyMs }
  };
  return hash(JSON.stringify(pick));
}
