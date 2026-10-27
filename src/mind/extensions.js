// 扩展行动：把装了 mindAction 的工具，转成她"自由时间里可以做的事"。
//
// 边界（与讨论一致的取舍）：
//   · 只有**显式声明** mindAction 的工具才会成为行动。搜索/看图/翻记录这类
//     辅助工具永远不会因为"它能写点什么"就混进菜单。
//   · **默认关闭**：清单里声明了也要用户在配置里打开（mind.actions.overrides）。
//   · 本文件是纯函数，不 import 工具执行器 —— 执行包装由编排器注入，
//     这样"什么算行动"可以单独测试，不需要起整个运行时。
//
// 清单声明（工具定义里可选的一段）：
//   mindAction: {
//     label: '更新 QQ 资料',       // 菜单里怎么念
//     energy: 10,                  // 花多少体力（可被配置覆盖）
//     defaultEnabled: false,       // 作者建议默认开/关；用户配置优先
//     when: (state) => boolean,    // 可选前置条件
//   }
//
// 配置覆盖（config.mind.actions.overrides[工具 id]）：
//   { enabled: true, label: '...', energy: 8 }

/**
 * @param {object} p
 * @param {object[]} p.tools 工具定义（来自 listTools()）
 * @param {object} [p.cfg] config.mind.actions
 * @returns {object[]} 行动描述（与内置动作同形，可直接进菜单）
 */
export function extensionActions({ tools = [], cfg = {} } = {}) {
  const overrides = (cfg && typeof cfg.overrides === 'object' && cfg.overrides) || {};
  const out = [];

  for (const tool of Array.isArray(tools) ? tools : []) {
    const meta = tool?.mindAction;
    if (!meta || typeof meta !== 'object') continue;   // 没声明 = 永远只是辅助工具

    const id = String(tool.id || '');
    if (!id) continue;
    const o = (overrides[id] && typeof overrides[id] === 'object') ? overrides[id] : {};

    // 开关：配置 > 清单默认 > 关闭
    const enabled = o.enabled !== undefined ? o.enabled === true : meta.defaultEnabled === true;
    if (!enabled) continue;

    const energyRaw = o.energy !== undefined ? o.energy : meta.energy;
    const energy = Number.isFinite(Number(energyRaw)) && Number(energyRaw) >= 0
      ? Number(energyRaw)
      : 10;

    out.push({
      id,
      label: String(o.label || meta.label || tool.name || id).slice(0, 40),
      description: String(meta.description || tool.description || '').slice(0, 80),
      energy,
      external: true,
      toolId: id,
      // 扩展动作的前置条件由清单提供；没有就永远可用（体力仍会拦）
      when: typeof meta.when === 'function' ? meta.when : undefined
    });
  }
  return out;
}
