// 提示词分层声明。
//
// 这套表解决的是"半年后有人往任意位置塞一段话，层就名存实亡"的问题。
// 每一段必须声明自己属于哪一层；层的顺序是固定的，不能交叉。
//
// 分层的轴不是"谁能改"，而是**这是谁的声音**：
//
//   层            顺序   来源     谁能改    声音
//   safety       100    代码     没人      系统对她说的硬规矩（安全、工具协议）
//   charter      200    配置     管理员    管理员对她的设定（她不能改）
//   self         300    心智     她自己    她自己的话（反思/工具写入）
//   skills       400    扩展     作者      能力说明（插件、技能）
//   situation    500    运行时   —         此刻发生了什么（每轮都变；在 user 里）
//
// 为什么 safety 必须在最前：它是唯一"任何人都不该能稀释"的一段。
// 曾经系统提示里身份句写在安全规则之前——顺序上没出错，但语义上等于
// "先自我介绍，再听规矩"，规矩更容易被后续内容盖过去。
//
// 为什么 situation 不在 system：情景每轮都变。放在系统提示里会让整段
// 前缀缓存每次失效；而且"我是谁"与"现在发生了什么"混在一起，
// 模型会把身份也当成这一轮的台词。
export const PROMPT_LAYERS = {
  safety: {
    order: 100, source: 'code', mutable: 'nobody',
    desc: '安全规则与工具协议：任何配置、任何扩展都不能覆盖'
  },
  charter: {
    order: 200, source: 'config', mutable: 'owner',
    desc: '身份宪法与行为规范：管理员可改，她自己改不了'
  },
  self: {
    order: 300, source: 'mind', mutable: 'self',
    desc: '她自己的自述与对人的看法：反思/工具写入'
  },
  skills: {
    order: 400, source: 'extensions', mutable: 'author',
    desc: '插件与技能片段：由 manifest.prompt.sections 提供'
  },
  situation: {
    order: 500, source: 'runtime', mutable: 'none',
    desc: '此刻的情景：时间、已读/未读、最近想起的事'
  }
};

export function layerOrder(layer) {
  const def = PROMPT_LAYERS[layer];
  return def ? def.order : Number.MAX_SAFE_INTEGER;
}

/**
 * 校验一组 section 的层序。
 *
 * 返回问题列表（空数组 = 合法）。刻意不用 assert：
 * 调用方（测试/审计）需要看到**全部**问题，而不是停在第一条。
 *
 * @param {{layer:string, id:string, text?:string}[]} sections
 * @returns {string[]}
 */
export function validateSections(sections = []) {
  const problems = [];
  let last = -Infinity;
  for (const s of sections || []) {
    if (!s || typeof s !== 'object') { problems.push('section 不是对象'); continue; }
    const def = PROMPT_LAYERS[s.layer];
    if (!def) { problems.push(`未知层：${s.layer}（段 ${s.id ?? '?'}）`); continue; }
    if (!String(s.id ?? '').trim()) problems.push(`缺少段 id（层 ${s.layer}）`);
    if (def.order < last) {
      problems.push(`层序倒退：${s.id}（${s.layer}=${def.order}）排在了更晚的层之后`);
    }
    last = Math.max(last, def.order);
  }
  return problems;
}

/** 渲染：段与段之间空一行（与改动前的字节布局一致）。 */
export function renderSections(sections = []) {
  return (sections || [])
    .filter((s) => s && String(s.text ?? '').trim())
    .map((s) => String(s.text))
    .join('\n\n');
}
