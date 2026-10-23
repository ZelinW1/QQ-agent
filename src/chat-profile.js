// 会话级配置快照（ChatProfile）——**唯一**做"全局配置 × 分会话覆盖"合并的地方。
//
// 为什么需要它（问题陈述）：
//   存储早就是按会话的（messages/<chat>.json、memory/<chat>/<QQ>.json），但**决策不是** ——
//   per-chat 配置的读取散落在任意深度的读点里：prompt.js 组装途中直读 getConfig()、
//   orchestrator 内联算 tools/api、skills/config.js 读全局 skills 单例。
//   后果是"同一件事有两个真相"，已经实际发生过两类事故：
//     · qqSceneRules 自己算 api.vision，而工具闸门用 orchestrator 算好的 visionEnabled
//       （后者还含 modelImageVerdict 探测）→ 模型不支持图片时，工具被移除、
//       系统提示却仍在说"你能直接看懂图片内容"。
//     · 设置页/预览用的 runtimeContext 不带 chatKey，运行时带 → 依赖 chatKey 的扩展
//       会出现"UI 显示可用、实际在某会话不可用"。
//
// 设计（三条约束，改这个文件前先读）：
//   1. **一处解析**：分辨率的唯一入口。核心代码不许再散落 `perChat(x) ?? global(x)`。
//   2. **纯函数**：buildChatProfileFrom(cfg, chatKey) 不读全局状态，测试可喂任意夹具配置。
//      只有 resolveChatProfile(chatKey) 这一个便利包装会去取全局配置。
//   3. **快照不可变 + 与存储分离**：
//        · 存储（config.chatProfiles[chatKey]）只放用户**显式改过**的字段（稀疏），
//          因为"继承"与"显式关掉"必须可区分（enabled:false ≠ 没有这个键）。
//        · 快照是**解析后的完整视图**（深拷贝），一次运行内不变 ——
//          用户跑到一半改配置不会让同一次运行的"系统提示"和"工具列表"自相矛盾。
//
// 扩展边界（重要）：**只有知道 chatKey 的路径才吃分会话值**。
//   resolveCapabilityFn / api.capability() 等以空上下文解析的路径一律走全局档。
//   它们的调用点有意不传 profile —— 别为了让"per-chat 也生效"而给它们硬塞 chatKey：
//   那会让"某个扩展在哪生效"变得不可预测，比现在的分裂更难查。
import { getConfig, deepMerge } from './config.js';
import { personaForChat, storeConfigForChat } from './config.js';
import { modelImageVerdict } from './vision-scan.js';

/** 快照结构版本：形状变了就 +1（调试输出据此判断是否过期）。 */
export const CHAT_PROFILE_VERSION = 1;

/** api 段允许被分会话覆盖的字段。**绝不含 apiKey** —— 快照会进运行期上下文。 */
const API_OVERRIDABLE = ['model', 'provider', 'vision', 'video'];

/**
 * 快照里的 api 段**只保留这些派生/可安全外传的字段**。
 *
 * 为什么不直接带上整个 api：
 *   profile 会被放进 skillContext（→ 扩展）、会话记录、以及 UI 的提示词预览。
 *   带 apiKey 就等于把明文密钥复制到这些地方 —— 而扩展没有任何沙箱（同进程 import），
 *   完全没有必要把密钥递到它们手里。密钥/baseUrl 由 orchestrator 从 config 直接读，
 *   不走快照。
 */
const API_SNAPSHOT_FIELDS = ['model', 'provider', 'vision', 'video'];

/**
 * 可被分会话覆盖的配置路径（声明式表 = 唯一真相）。
 *
 * 加一个新维度时只改这里 + buildChatProfileFrom 里的默认值提取；
 * 校验、UI、文档都读这张表。
 */
export const CHAT_PROFILE_PATHS = {
  persona: { merge: 'builtin' },   // 交给 personaForChat（四字段白名单 + personaUnified 语义）
  store: { merge: 'builtin' },     // 交给 storeConfigForChat（四象限 + 峰谷 + 指令禁言）
  tools: { merge: 'deep' },        // 递归合并（支持 __replace__）
  skills: { merge: 'byId' },       // { id: {...} } 逐条浅合并
  api: { merge: 'pick', keys: API_OVERRIDABLE },
  webSearch: { merge: 'pick', keys: ['enabled'] }
};

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 解包 __replace__ 约定：{ __replace__: X } → X，否则原值。 */
function unwrapReplace(v) {
  if (isPlainObject(v) && '__replace__' in v) return v.__replace__;
  return v;
}

/** pick 策略：只允许白名单字段进入（防止密钥/旁路字段被分会话写进来）。 */
function pickMerge(baseValue, overrideValue, keys) {
  if (!isPlainObject(overrideValue)) return baseValue;
  // __replace__ 依然尊重，但**仍过白名单**：整体替换也不能借机塞进 apiKey。
  const src = unwrapReplace(overrideValue);
  if (!isPlainObject(src)) return baseValue;
  const out = isPlainObject(baseValue) ? { ...baseValue } : {};
  for (const k of keys) {
    if (k in src && src[k] !== undefined) out[k] = structuredClone(src[k]);
  }
  return out;
}

/** byId 策略：{ id: { ... } } 逐条浅合并（skills 的 enabled / settings 都走这里）。 */
function byIdMerge(baseValue, overrideValue) {
  if (!isPlainObject(overrideValue)) return baseValue;
  if ('__replace__' in overrideValue) {
    const replaced = unwrapReplace(overrideValue);
    return isPlainObject(replaced) ? structuredClone(replaced) : baseValue;
  }
  const out = isPlainObject(baseValue) ? structuredClone(baseValue) : {};
  for (const [id, patch] of Object.entries(overrideValue)) {
    if (patch === undefined) continue;
    if (!isPlainObject(patch)) { out[id] = structuredClone(patch); continue; }
    const prev = isPlainObject(out[id]) ? out[id] : {};
    out[id] = { ...prev, ...structuredClone(patch) };
  }
  return out;
}

/** 从完整 api 配置里只取可安全外传的字段（剥掉 apiKey / baseUrl 等）。 */
function apiSnapshotFrom(apiCfg) {
  const out = {};
  if (!isPlainObject(apiCfg)) return out;
  for (const k of API_SNAPSHOT_FIELDS) {
    if (apiCfg[k] !== undefined) out[k] = structuredClone(apiCfg[k]);
  }
  return out;
}

/**
 * 按 chatKey 解析出完整的会话级配置快照。
 *
 * **纯函数**：不读全局配置（cfg 必须显式传入），因此测试可以喂任意夹具，
 * 也不会因为全局配置在别处被改而漂移。
 *
 * @param {object} cfg 完整配置（形状同 DEFAULT_CONFIG）
 * @param {string} chatKey 'group:123' / 'private:456'
 */
export function buildChatProfileFrom(cfg, chatKey) {
  const key = String(chatKey || '');
  const [kind, id] = key.split(':');
  const base = isPlainObject(cfg) ? cfg : {};
  const override = isPlainObject(base.chatProfiles?.[key]) ? base.chatProfiles[key] : {};

  // ── 1. 基准值：直接复用既有的会话级折算函数（不重写合并逻辑）──
  //    persona/store 的合并规则复杂且有历史语义（personaUnified、四象限、峰谷、
  //    指令禁言），复用它们是"最小改动"的关键。
  let persona = structuredClone(personaForChat(key, base) || {});
  let store = structuredClone(storeConfigForChat(key, base) || {});
  let tools = structuredClone(isPlainObject(base.tools) ? base.tools : {});
  let skills = structuredClone(isPlainObject(base.skills) ? base.skills : {});
  // api 只取白名单字段：密钥/baseUrl 不进快照（见 API_SNAPSHOT_FIELDS 的说明）。
  let api = apiSnapshotFrom(base.api);
  let webSearch = structuredClone(isPlainObject(base.webSearch) ? base.webSearch : {});

  // ── 2. 应用分会话覆盖 ──
  //    persona/store 的覆盖**走同一套既有函数**：把它们并进 cfg 的浅拷贝再调用，
  //    这样"分会话人设"与 personaUnified、"分会话档位"与峰谷/禁言的相对优先级
  //    与现状完全一致 —— 新增命名空间不改变既有语义。
  if (Object.keys(override).length) {
    const patched = { ...base };
    const hasBuiltin = isPlainObject(override.persona) || isPlainObject(override.store);
    if (isPlainObject(override.persona)) {
      // 让既有 personaForChat 看到分会话人设：作为该会话的 personaByChat 条目。
      // 显式写了分会话人设 = 用户明确要分会话，因此同时关掉统一人设 ——
      // 否则"统一人设=true + chatProfiles 里却有人设"会静默不生效。
      patched.personaUnified = false;
      patched.personaByChat = { ...(base.personaByChat || {}), [key]: override.persona };
    }
    if (isPlainObject(override.store)) {
      patched.store = deepMerge(isPlainObject(base.store) ? base.store : {}, override.store);
    }
    if (hasBuiltin) {
      persona = structuredClone(personaForChat(key, patched) || {});
      store = structuredClone(storeConfigForChat(key, patched) || {});
    }
    if ('tools' in override) tools = deepMerge(tools, override.tools);
    if ('skills' in override) skills = byIdMerge(skills, override.skills);
    if ('api' in override) api = pickMerge(api, override.api, CHAT_PROFILE_PATHS.api.keys);
    if ('webSearch' in override) webSearch = pickMerge(webSearch, override.webSearch, CHAT_PROFILE_PATHS.webSearch.keys);
  }

  // ── 3. 派生量：只算一次，供所有消费方共用 ──
  //    visionEnabled 的口径必须与 orchestrator 一致（含模型探测）——
  //    这正是"两处各算一次"曾经导致提示词与工具列表打架的地方。
  const visionEnabled = (api.vision !== false)
    && modelImageVerdict(api.provider, api.model) !== 'no-vision';
  const searchEnabled = webSearch.enabled !== false;

  // ── 4. 其余按会话天然隔离的数据（不是"可覆盖配置"，但提示词组装需要）──
  const globalBlocklist = (Array.isArray(base.globalBlocklist) ? base.globalBlocklist : []).map(String);
  const blocklist = (kind === 'group' && id && Array.isArray(base.blocklist?.[id]))
    ? base.blocklist[id].map(String)
    : [];
  const sticker = structuredClone(isPlainObject(base.sticker) ? base.sticker : {});

  const profile = {
    version: CHAT_PROFILE_VERSION,
    chatKey: key,
    persona, store, tools, skills, api, webSearch, sticker,
    blocklist, globalBlocklist,
    visionEnabled, searchEnabled,
    fingerprint: ''
  };
  profile.fingerprint = chatProfileFingerprint(profile);
  return profile;
}

/**
 * 解析当前生效配置下的会话快照（便利包装；唯一读全局配置的入口）。
 *
 * 刻意**不做缓存**：快照包含深拷贝与模型能力探测，看名字像是"该缓存"，但实测
 * 调用点都不热 —— wake 每个会话每批一次、onIncoming 只在未命中触发判定时解析
 * （not-trigger 路径压根不解析）。加缓存就要处理失效，而"配置变了缓存没失效"
 * 的后果是"改了配置但行为没变"，这种 bug 极难定位。真出现性能问题再按
 * config.js 的修订号加缓存，不要凭猜想预先引入。
 *
 * @param {string} chatKey
 * @param {object} [cfg] 调用方已取过的配置（省一次 getConfig()）
 */
export function resolveChatProfile(chatKey, cfg = getConfig()) {
  return buildChatProfileFrom(cfg, chatKey);
}

/**
 * 把快照里的 skills 覆盖叠到 SkillManager 上，得到"可用于 getToolAvailability"的
 * skills 视图。
 *
 * 背景：`config.skills[id].enabled` 的读取在 src/skills/config.js，而那里读的是
 * **全局**配置。要支持"某会话单独关掉某技能"，需要把分会话的 skills 传进去。
 * 用原型委托而不是改 SkillManager：既不改动那个类的公开行为，
 * 也让"没覆盖时"完全等价于直接传单例（阶段 1 零行为变更）。
 *
 * @param {object} manager SkillManager 单例
 * @param {object} profile 会话快照
 */
export function skillsViewForProfile(manager, profile) {
  const overlay = isPlainObject(profile?.skills) ? profile.skills : null;
  if (!overlay || !Object.keys(overlay).length) return manager;
  return Object.assign(Object.create(manager), { __skillsCfg: overlay });
}

/**
 * 影响**提示词字节**的字段摘要。
 *
 * 用途：提示词锚点（promptAnchor）靠"上一轮前缀原样复用"命中缓存。分会话人设/
 * 档位/工具集一变，旧前缀就不再是本轮的合法前缀 —— 在这种变更后继续追加，
 * 会让模型看到"上一套人设的旧基线 + 新一套的追加段"。调用方比较 fingerprint，
 * 不同就清掉该会话的锚点（回到标准结构重建）。
 *
 * 刻意**只收影响提示词的项**：模型 id、密钥、限频参数等变化不该导致锚点失效。
 */
export function chatProfileFingerprint(profile) {
  if (!isPlainObject(profile)) return '';
  const p = profile.persona || {};
  const s = profile.store || {};
  const skills = Object.entries(profile.skills || {})
    .filter(([, v]) => isPlainObject(v) && v.enabled !== undefined)
    .map(([k, v]) => `${k}=${v.enabled === false ? '0' : '1'}`)
    .sort();
  const flagMap = (m) => Object.entries(m || {})
    .map(([k, v]) => `${k}=${v === false ? '0' : '1'}`).sort();
  return JSON.stringify({
    // 人设：四个说话风格字段 + 参与度（都会改写系统/用户提示）
    roleText: String(p.roleText ?? ''),
    participation: String(p.participation ?? ''),
    customRules: String(p.customRules ?? ''),
    systemPromptOverride: String(p.systemPromptOverride ?? ''),
    // 档位与上下文条数
    tier: Number(s.contextTier) || 0,
    historyCount: Number(s.historyCount) || 0,
    keywords: (Array.isArray(s.keywords) ? s.keywords : []).map(String),
    // 工具/技能的启停（决定注入哪些工具描述与【可用技能】片段）
    toolsEnabled: profile.tools?.enabled !== false,
    categories: flagMap(profile.tools?.categories),
    overrides: flagMap(profile.tools?.overrides),
    skills,
    // 提示词里的条件段（能否看图 / 有无联网）由这两个派生量决定
    vision: profile.visionEnabled === true,
    search: profile.searchEnabled === true
  });
}
