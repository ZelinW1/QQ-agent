// 工具投影：同一个工具在不同"场合"里该不该出现。
//
// 设计要解决的问题：工具表以前是手写的（自由时刻 7 个动作 + finish），
// 加一个动作要改三处：动作表、工具表、提示词。投影把这件事变成数据：
//   · 每个工具带 `traits`：允许出现在哪些场合（modes）、作为行动时消耗多少、前置条件；
//   · 运行时按 mode + 当前状态投影出一份工具表与菜单，提示词也由同一份投影生成。
//
// 本文件不 import 领域模块；动作与工具都从调用方传进来。

/** 工具 schema 版本：1 = 旧（无 traits）；2 = 带 traits/modes。 */
export const TOOL_SCHEMA_VERSION = 2;

/**
 * 把领域动作包装成"带 traits 的工具定义"。
 *
 * @param {object[]} actions 动作（mind/actions.js 的形状）
 * @param {{mode?:string}} [opts]
 */
export function traitsForAction(action, { mode = 'free' } = {}) {
  return {
    schemaVersion: TOOL_SCHEMA_VERSION,
    name: action.id,
    traits: {
      modes: [mode],
      act: {
        energy: Number(action.energy) || 0,
        snoozeMs: Number(action.snoozeMs) || 0,
        label: String(action.label || action.id)
      }
    }
  };
}

/**
 * 投影自由时刻的工具表与菜单。
 *
 * @param {object} opts
 * @param {object[]} opts.actions    可行动作（已经过 availableActions）
 * @param {object[]} [opts.readTools] 只读工具（聊天域里注册的那些，带 traits.modes）
 * @param {object} [opts.traits]     `{ act: { 允许的动作 }, read: [允许的读工具] }`
 * @param {(action:object)=>object|null} [opts.blocked] 返回非空 = 现在做不了（附原因）
 * @param {boolean} [opts.includeFinish]
 * @returns {{tools:object[], menu:object[], blocked:object[]}}
 */
export function projectFreeTools({
  actions = [],
  readTools = [],
  traits = {},
  blocked = null,
  includeFinish = true
} = {}) {
  const allowActs = Array.isArray(traits.act) && traits.act.length ? new Set(traits.act) : null;
  const allowReads = Array.isArray(traits.read) && traits.read.length ? new Set(traits.read) : null;

  const menu = [];
  const blockedList = [];

  for (const action of actions) {
    if (allowActs && !allowActs.has(action.id)) continue;
    const why = typeof blocked === 'function' ? blocked(action) : null;
    if (why) { blockedList.push({ id: action.id, reason: String(why) }); continue; }
    menu.push(action);
  }

  const tools = menu.map((action) => ({
    type: 'function',
    function: {
      name: action.id,
      description: `${action.label}${action.description ? `：${action.description}` : ''}（消耗 ${Number(action.energy) || 0} 体力）`,
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '一句给自己看的理由' },
          ...(action.id === 'send_proactive'
            ? { chatKey: { type: 'string', description: '找谁：用上面列出的 chatKey，不填则由系统挑最该找的人' } }
            : {}),
          ...(action.id === 'remember'
            ? {
                text: { type: 'string', description: '要记住的那句话或那件事（用她自己的话）' },
                chatKey: { type: 'string', description: '这条记忆属于谁 / 哪个会话' }
              }
            : {}),
          ...(action.id === 'plan'
            ? {
                text: { type: 'string', description: '要做的事（一句话，比如"问问他搬家的事"）' },
                inHours: { type: 'number', description: '大概几小时后做（默认 24；不确定就省略）' },
                chatKey: { type: 'string', description: '跟谁有关（可选）' }
              }
            : {})
        },
        ...(action.id === 'remember' || action.id === 'plan' ? { required: ['text'] } : {}),
        additionalProperties: true
      }
    }
  }));

  for (const tool of readTools) {
    if (!tool || typeof tool.execute !== 'function') continue;
    if (allowReads && !allowReads.has(tool.id)) continue;
    const modes = tool.traits?.modes;
    if (Array.isArray(modes) && !modes.includes('free')) continue;
    tools.push({
      type: 'function',
      function: {
        name: tool.id,
        description: String(tool.description || tool.name || tool.id).slice(0, 500),
        parameters: tool.parameters || { type: 'object', properties: {} }
      }
    });
  }

  if (includeFinish) {
    tools.push({
      type: 'function',
      function: {
        name: 'finish',
        description: '这一次就到这里（做完想做的事、或者决定什么都不做时调用）',
        parameters: {
          type: 'object',
          properties: { reason: { type: 'string', description: '一句给自己看的理由' } },
          additionalProperties: true
        }
      }
    });
  }

  return { tools, menu, blocked: blockedList };
}

/**
 * 把投影结果渲染成提示词里的"你现在能做的事"。
 * 与工具表同源：不另写一份列表，避免提示词说能做、工具表却没有。
 */
export function renderMenu(menu = [], { includeIdle = false } = {}) {
  const lines = menu.map((a) => `- ${a.id}：${a.label}${a.description ? `。${a.description}` : ''}（消耗 ${Number(a.energy) || 0} 体力）`);
  if (includeIdle) lines.push('- 什么都不做：不调用任何工具即可');
  return lines.join('\n');
}
