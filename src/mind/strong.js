// 强事件：会"改写她对自己的看法"的那种事。
//
// 为什么需要它：只靠日历触发全局整合，她的自我会滞后一个月。真实的人会被一次冲突、
// 一次告别、一次郑重的承诺改写。但**判定必须由系统做**——如果靠模型自己标"这次很重要"，
// 那等于没有：它连"记下来"都常常想不起来。
//
// 这里只做文本规则（纯函数、可测）。关系阶段回退由 store 在 patchRelation 里判定，
// 因为它要看得到前后两级。
//
// 规则刻意保守：宁可漏，不可误伤。误判的代价是"她因为一句'一定的'突然重写自我"，
// 那比少触发一次严重得多。

/** 强事件的三种类型。 */
export const STRONG_KINDS = ['conflict', 'farewell', 'promise'];

const RULES = [
  {
    kind: 'conflict',
    // 明确的冲突信号：敌意、断绝、驱赶。不用"烦"这类高频词，它太容易误伤。
    re: /(别说了|拉黑|不想理你|绝交|滚开|滚吧|讨厌你|别烦我)/
  },
  {
    kind: 'farewell',
    // 告别：必须带"以后/再也/最后"这类终结意味；单说"走了""再见"不算。
    re: /(以后不来了|再也不来|最后一次|以后别找我|别再找我|退群了|不玩了，走)/
  },
  {
    kind: 'promise',
    // 郑重的承诺：要带宾语或"说好了"这类敲定语气；"一定"单独出现太常见。
    re: /(答应你|我保证|说好了|约好了|一言为定)/
  }
];

/**
 * 从文本里识别强事件。
 *
 * @param {string} text
 * @returns {{ kind: string, matched: string }|null}
 */
export function detectStrongText(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  for (const rule of RULES) {
    const m = t.match(rule.re);
    if (m) return { kind: rule.kind, matched: m[1] };
  }
  return null;
}

/** 一条事件是否已经被标记为强事件。 */
export function isStrongEvent(event) {
  return Boolean(event) && event.strong === true;
}

/**
 * 关系阶段是否回退了。
 *
 * 只认"往下走"：strained 视为最低；同级或上升都不算。
 * @param {string} before
 * @param {string} after
 * @param {Record<string, number>} levels
 */
export function stageRegressed(before, after, levels = {}) {
  const rank = (s) => (s === 'strained' ? -1 : Number(levels[s] ?? 0));
  return rank(after) < rank(before);
}
