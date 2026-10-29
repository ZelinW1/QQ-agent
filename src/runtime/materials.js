// 自由时刻的素材：她此刻是谁、最近过成什么样、还惦记着什么。
//
// 为什么单独一层：提示词里"她现在是谁"这几段以前散在编排器里，
// 增删一律要改大函数；而素材的形状（self / narrative / intentions / scene）
// 是设计里定死的，应该能单独测、单独演进。
//
// 本文件不 import 领域模块：数据一律从端口读，端口返回空也不抛。

/**
 * 收集自由时刻的素材。
 *
 * @param {object} opts
 * @param {object} opts.port 运行时端口
 * @param {number} [opts.now]
 * @param {number} [opts.intentionLimit]
 * @returns {{selfBrief:string, narrativeTitles:string[], intentions:object[], pendingIntents:number}}
 */
export function buildFreeMaterials({ port, now = Date.now(), intentionLimit = 3 } = {}) {
  const out = { selfBrief: '', narrativeTitles: [], intentions: [], pendingIntents: 0 };
  if (!port) return out;

  try { out.selfBrief = String(port.selfBrief?.() || '').trim(); } catch { out.selfBrief = ''; }

  try {
    const list = typeof port.narratives === 'function' ? port.narratives({ limit: 3 }) : [];
    out.narrativeTitles = (Array.isArray(list) ? list : [])
      .map((n) => String(n?.title || '').trim())
      .filter(Boolean)
      .slice(0, 3);
  } catch { out.narrativeTitles = []; }

  try {
    const list = typeof port.intentions === 'function'
      ? port.intentions({ status: 'open', dueBefore: now, limit: intentionLimit })
      : [];
    out.intentions = Array.isArray(list) ? list : [];
    out.pendingIntents = out.intentions.length;
  } catch { out.intentions = []; out.pendingIntents = 0; }

  return out;
}

/**
 * 渲染成提示词里的一段。没有素材就返回空串（调用方据此决定要不要加这一段）。
 *
 * @param {object} materials buildFreeMaterials 的返回
 * @returns {string}
 */
export function renderMaterials(materials) {
  if (!materials) return '';
  const lines = [];
  const self = String(materials.selfBrief || '').trim();
  if (self) lines.push(`你现在怎么看自己：${self}`);
  if (Array.isArray(materials.narrativeTitles) && materials.narrativeTitles.length) {
    lines.push(`最近写下的事：${materials.narrativeTitles.join('；')}`);
  }
  if (Array.isArray(materials.intentions) && materials.intentions.length) {
    const items = materials.intentions
      .map((x) => {
        const due = Number(x?.dueAt) || 0;
        const when = due && due <= Date.now() ? '（到点了）' : '';
        return `- ${String(x?.text || '').slice(0, 80)}${when}`;
      })
      .filter(Boolean);
    if (items.length) lines.push(`你之前说要做的事：`, ...items);
  }
  return lines.join('\n');
}
