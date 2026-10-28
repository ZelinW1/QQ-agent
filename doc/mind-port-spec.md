# 领域端口规格（MindPort，A1 阶段）

| 项 | 内容 |
|---|---|
| 状态 | **接口规范，尚未实施**；A1 期的施工依据 |
| 对应设计 | [action-runtime-design.md §3.3](./action-runtime-design.md#33-mindport领域端口)、§12 A 期 |
| 读者 | 实现 A1 的开发者；以及评审"领域层是否真的解耦"的人 |
| 最后更新 | 2026-10-29 |

**要解决的问题**：让"**删掉 `src/mind/`，应用照常启动**"这条架构判据有一个可编译、
可测试的落地点。它既是 A1 的交付物，也是判断"这次重构有没有真正分层"的唯一硬指标。

**边界**：本文只定接口与迁移顺序。A 期**成功路径**应与现状一致；
失败路径会因管线归一而变化，清单见设计稿 §12 A 期。

**本次同步的要点**

1. `WriterPort` 的 `by` 由**管线注入**，工具侧签名里没有它。
2. `Body` 增加 `rev`，`bodyApply` 变**比较并交换**；顺带修一个现存的并发缺陷（见 §3 取舍）。
3. `recordAttempt` **每个 attempt 开一条观测**（不是每次 `send_message` 一条）；群聊不开观测。
4. `recordAttempt` 支持 `childMomentId`，记录嵌套运行的子 Moment（设计稿 §4.7）。
5. 定**唯一读路径**：`attempts` 为源，`actions.jsonl` 冻结（§8.4）。
6. 迁移**分批**：chat + routes 在 A1，free 侧随 C 期重写（§9）。
7. `scene()` 预留 `policy` 形参但不实现（见 §3 取舍）。

---

## 1. 三条硬约束

这三条决定了下面所有签名，先摆出来：

**① 只有装配根（composition root）可以 import 领域模块。**

`src/app.js` 是唯一 `import { MindStore } from './mind/index.js'` 的地方。
`mind-port.js` **不 import mind**，只接受鸭子类型的对象。否则"删掉目录"时，
端口文件自己就先爆炸了。

**② 端口里没有"改她是谁"的写接口（运行时段）。**

`RuntimePort` 只能读素材、记尝试与结果、改身体状态（体力/计数/睡眠/打盹）。
写 Self / Relation / Event / Narrative 一律走 `WriterPort`，而 `WriterPort`
实现设计 v3 §4.2 的写入规程（谁写哪层、要什么证据、是否版本化）。

**③ 读不抛，写不抛。**

- 读：无 mind 时返回**空形状**（`''` / `[]` / `0` / `null`），调用方不需要处处判空。
- 写：失败返回 `{ ok:false, code, message }`，**绝不 throw**。
  理由：这些错误要变成"模型看得懂的工具错误"，而不是让编排循环崩掉。
  现有工具已经在用这个约定（`src/mind/tools.js:12-13` 的 `err()`）。

---

## 2. 为什么是三个端口，而不是一个

现有 `MindStore` 有 20 个公开方法，但消费者是三类完全不同的角色：

| 角色 | 谁 | 需要什么 | 现有调用 |
|---|---|---|---|
| **运行时** | `orchestrator` / 将来的 `src/runtime/*` | 读素材、结算体力、记行动 | 45 处 / 9 方法 |
| **能力写入者** | 工具（`remember_event`、`update_relation`、`self_revise`） | 按规程写领域 | `ctx.mind` 鸭子类型 |
| **主人控制台** | `routes.js` | 全量读、手动改、日志维护 | 14 处 |

一个端口同时服务三者，必然退化成"store 换了个名字"，A1 就变成假解耦。
所以拆成三个，各自带自己的不变量。

```
                 ┌──────────────┐
  orchestrator ──┤ RuntimePort  │  读素材 / 身体 / 记录
                 └──────────────┘
                 ┌──────────────┐
  tools ─────────┤ WriterPort   │  写入规程（证据 / 版本 / 越权拒绝）
                 └──────────────┘
                 ┌──────────────┐
  routes ────────┤ AdminPort    │  全量读写 + 维护（仅控制台与迁移）
                 └──────────────┘
```

> 迁移期（A1）三个端口都包同一个 `MindStore` 实例；B 期起 `WriterPort`
> 才真正开始执行写入规程的校验（那时才会出现 `not_a_writer` 这类错误）。

---

## 3. RuntimePort

```js
// src/contract/mind-port.js
// 注意：本文件不 import ../mind/**，只接受鸭子类型的 store。

/**
 * @typedef {object} Body
 * @property {boolean} enabled
 * @property {number} rev            // 单调递增的写版本，用于 bodyApply 的比较并交换
 * @property {number} energy
 * @property {number} energyMax
 * @property {{ todayProactive: number, todayDecisions: number }} counters
 * @property {{ state: 'awake'|'asleep', since: number, nightKey: string, stayUps: number }} sleep
 * @property {Record<string, number>} snoozes   // `chatKey|candidateId` → 到期时刻
 * @property {Record<string, number>} proactiveAt  // chatKey → 上次主动发言时刻（从内存迁入，§8.2）
 * @property {number} impulseAt     // 下次"无理由冲动"的抽样时刻（设计 v3 §7.3；nextWakeAt 不落盘）
 */

/**
 * @typedef {object} SceneEntry
 * @property {string} chatKey
 * @property {string} name
 * @property {string} stage
 * @property {number} warmth
 * @property {number|null} hoursSince
 * @property {number} unread
 * @property {string} lastLine
 * @property {number} lastEventAt
 * @property {number} openLoopsDue
 * @property {boolean} running
 * @property {boolean} recent
 * @property {boolean} suppressed
 */

export const MIND_PORT_API = 1;

export function createRuntimePort(mind, { log = console } = {}) {
  if (!mind) return createNoopRuntimePort();

  return {
    apiVersion: MIND_PORT_API,
    get enabled() { return true; },

    // ── 身体：能量 / 计数 / 睡眠 / 打盹 ──────────────────────────────
    // 语义化读写，不做通用 JSON merge。一个 patch 一次写盘，保持原子性。

    /** @returns {Body} */
    bodyRead() { /* getTick() → Body */ },

    /**
     * 结算能量 + 跨天清零，并写盘。取代「settleEnergy + resetDaily + updateTick」三步。
     * @returns {{ body: Body }}
     */
    bodySettle({ now }) { /* … */ },

    /**
     * 原子补丁 + **比较并交换**。白名单键，未识别的键直接报错（不静默忽略）。
     *
     * `rev` 必须来自上一次 bodyRead/bodyApply 的返回值；不匹配返回 `stale`，调用方重读后重算。
     * 为什么要有：一次 tick 里夹着模型调用（秒级），期间另一次 tick 可能已经改过体力。
     * 没有 CAS 时，两个 tick 各读 100、各扣 25，最终写 75 而不是 50 —— 丢更新。
     * （现有代码就有这个问题：`startTickLoop` 是裸 setInterval，见 §3 取舍。）
     *
     * @param {{
     *   rev: number,                                       // 必填，防丢更新
     *   spend?: number,                                    // 扣体力，不足则截到 0
     *   counterDelta?: { todayProactive?: number, todayDecisions?: number },
     *   sleep?: { state: 'awake'|'asleep', nightKey?: string, since?: number, stayUps?: number },
     *   snooze?: Record<string, number>,                   // 整表替换（不是合并）
     *   proactiveAt?: { chatKey: string, at: number },     // 单键写入
     * }} patch
     * @returns {{ ok: boolean, body?: Body, spent?: number, code?: string }}
     *   code: 'invalid_patch' | 'stale' | 'no-mind'
     */
    bodyApply(patch) { /* … */ },

    // ── 现场（L3 素材）────────────────────────────────────────────

    /**
     * 一次性给出"她现在看得到谁"。取代：listChats + getChatMeta + getRelation
     * + queryEvents(lastEventAt) + proactiveAt 的散装拼装。
     *
     * `policy` 目前不接受参数（只有一种排序）。留这个形参是为了将来 free / chat
     * 需要不同排序时不用改调用方签名 —— 现在**不要**实现它。
     *
     * @returns {{ entries: SceneEntry[], restCount: number }}
     */
    scene({ now, limit = 3 /*, policy */ }) { /* … */ },

    /** @returns {string} 无 mind 时为 '' */
    selfBrief() { /* … */ },

    /** @returns {string} */
    relationBrief(userId) { /* … */ },

    // ── 记忆读取（L2 / L4）────────────────────────────────────────

    /** @returns {Array<{ id, ts, kind, text, actorId, salience }>} */
    recall({ chatKey, query, limit = 6, sinceTs = 0 }) { /* … */ },

    /** @returns {Array} */
    recentEvents({ chatKey, limit = 5, sinceTs = 0 }) { /* … */ },

    /** 取代 countUnreflected。@returns {number} */
    reflectionDebt({ chatKey }) { /* … */ },

    /** @returns {{ at, actionId, reason, ok }|null} */
    lastAction() { /* … */ },

    /** @returns {Array} */
    recentActions({ limit = 10 }) { /* … */ },

    // ── 意图（A 期返回 []，B 期接真实现）──────────────────────────

    /** @returns {Array<{ id, text, about, dueAt, priority, status }>} */
    intentions({ now, limit = 5 }) { return []; },

    /** @returns {{ ok: boolean, intention?: object, code?: string }} */
    proposeIntention(patch) { return { ok: false, code: 'not-implemented' }; },

    /** @returns {{ ok: boolean, code?: string }} */
    closeIntention(id, { outcome } = {}) { return { ok: false, code: 'not-implemented' }; },

    // ── 记录（只记"做了什么"，不改她是谁）──────────────────────────

    /**
     * A 期沿用 appendAction 的字段；B 期由 recordAttempt 取代（§8.4 唯一读路径）。
     * @returns {{ ok: boolean, id?: string, code?: string }}
     */
    recordAction(entry) { /* … */ },

    /**
     * B 期起的主写入。除了记一次尝试，还要**按 footprint 开一条待观测记录**：
     * 回声可能在几小时后才到（设计 v3 §4.5.3），此刻不能下结论。
     *
     * 关键粒度：**每个 attempt 一条观测**，键是 attemptId。
     * 她一次行动连发两条消息属于同一次 attempt，第二条不会把第一条 void 掉。
     * 群聊不开观测（群里任何新消息都不等于回应）。
     *
     * @param {{ momentId, parentMomentId?, childMomentId?, toolId, intentionId?,
     *           args, footprint?, target?, chatKind?, now }} entry
     * @returns {{ ok, attemptId?, observationId?, code? }}
     */
    recordAttempt(entry) { return { ok: false, code: 'not-implemented' }; },

    /**
     * 关闭一条观测。三条路径都走它：echo（chat 收到消息时顺手关）、
     * missed（integrate 扫过期）、void（连发 / 会话被改动，作废不判定）。
     * @param {{ observationId, state: 'hit'|'missed'|'void', evidence?, now }} entry
     * @returns {{ ok: boolean, code?: string }}
     */
    recordOutcome(entry) { return { ok: false, code: 'not-implemented' }; },

    /** 待观测表（诊断/界面用）。@returns {Array} */
    openObservations({ now }) { return []; },
  };
}
```

**几个刻意的取舍**

- **`bodyRead` 一个方法读全部，而不是 `getEnergy()` / `getCounters()` 拆开**：
  现有 13 处 `getTick()` 里多数只取一两个字段（`energy` / `todayDecisions` / `lastReflectAt` / `sleep`），
  拆成细粒度 getter 会让这些调用点各写两三行。一个快照对象 + 一次读，迁移最省事，
  也避免"读到一半状态变了"。
- **`bodyApply` 接受整表替换 snooze，而不是 add/remove 两个方法**：
  三个调用点（2214 / 2263 / 2627）全都是"算出新整表再写"，接口对齐现实。
- **`scene()` 放在端口里，而不是让 materials 自己拼**：
  roster 的排序规则（未读 > 到期未完结 > 沉默时长 > 亲密度）是**领域知识**，
  而且 per-chat / global 两条路径现在各写了一遍（`orchestrator.js:2290-2344` 与
  `:2106-2127`）。收到端口里是消掉重复的唯一办法。
- **端口同步，不 async**：现有 store 全同步（`fs.readFileSync`/`appendFileSync`）。
  A1 保持同步，迁移面最小；B 期若统计需要异步，再整体加 `await`（一次性改，不散着改）。
- **`bodyApply` 必须带 `rev`（比较并交换）**：这不是洁癖，是因为
  `startTickLoop` 是裸 `setInterval(() => this.tickOnce())`（`orchestrator.js:2001`），
  **没有重入保护**——一次 tick 里有模型调用，超过 5 分钟就会和下一次并发，
  两边各读旧体力各扣一次，后写者赢。这是**现在就有**的丢更新。
  两条修法可以并存：给端口加 CAS（结构上挡住），给循环加 `if (this.ticking) return`（省事）。
  建议都做：CAS 防未来，重入锁防当下。
- **`scene()` 留 `policy` 形参但不实现**：现在只有一种排序（未读 > 到期未完结 > 沉默 > 亲密度），
  参数化只会造出一个没人用的分支。留签名是为了将来 free / chat 排序分化时不用改调用方。

---

## 4. WriterPort

```js
export function createWriterPort(mind, { now = Date.now } = {}) {
  if (!mind) return createNoopWriterPort();

  // 设计 v3 §4.2 的写入规程（A 期先只校验"证据"与"来源"，版本化在 B1 上）
  const WRITERS = {
    'self.narrative': ['integrate.global', 'tool:self_revise'],
    'self.notes':     ['integrate.chat', 'integrate.global'],
    'relation':       ['tool:update_relation', 'integrate.chat'],
    'event':          ['tool:remember_event', 'runtime.chat', 'runtime.free', 'integrate.global'],
    'reflection':     ['integrate.chat', 'integrate.global'],
    'narrative':      ['tool:diary_write', 'integrate.global'],
    'intention':      ['runtime.free', 'integrate.chat', 'integrate.global', 'user'],
  };

  return {
    apiVersion: MIND_PORT_API,
    get enabled() { return true; },

    /** 某个来源能不能写某个目标。UI 可以据此显示"这个工具需要什么"。 */
    canWrite(target, { by }) { return (WRITERS[target] || []).includes(by); },

    /**
     * @param {{ chatKey, actorId?, actorName?, kind?, text, valence?, salience?,
     *           tags?, source, momentId? }} input
     * @returns {{ ok, event?, duplicate?, code?, message? }}
     */
    appendEvent(input) { /* → mind.appendEvent，来源取句柄上的 by */ },

    /**
     * @param {string} userId
     * @param {object} patch
     * @param {{ evidence: string[], reason?: string }} meta   ← **没有 by**
     * @returns {{ ok, relation?, clamp?, code?, message? }}
     *   code: 'not_a_writer' | 'needs_evidence' | 'invalid_patch'
     */
    patchRelation(userId, patch, meta) { /* … */ },

    /**
     * @param {object} patch { narrative?, mood?, preoccupations? }
     * @param {{ reason: string, momentId? }} meta             ← **没有 by**
     * @returns {{ ok, self?, code?, message? }}    code: 'not_a_writer' | 'needs_reason'
     */
    reviseSelf(patch, meta) { /* → mind.reviseSelf */ },

    appendReflection(input) { /* … */ },
    writeNarrative(input) { /* … */ },
    writeSelfNotes(notes, { momentId }) { /* B2 起才有存储；A 期 no-op ok:true */ },
  };
}
```

**`by` 由管线注入，不由调用方传（v3 修正）。**

原案的写法是 `patchRelation(userId, patch, { by: 'tool:update_relation' })`——
工具自己填"我是谁"，等于让被检查者写检查结果，越权检查形同虚设。
改为：**管线按每次调用创建句柄，`by` 固定在闭包里**：

```js
// src/contract/pipeline.js（管线内部）
const writer = createWriterPort(mind, {
  by: `tool:${toolId}`,         // 工具拿不到这个参数
  ownerId,
  momentId,
});
// 工具侧只见 ctx.writer.appendEvent(...) / ctx.writer.patchRelation(...)
```

这样越权在**结构上**不可能发生，而不是靠作者自觉。
`canWrite(target, {by})` 仍保留显式参数，因为它的用途是 UI 查询（"这个来源能写什么"）。

**A 期只做两件事**：`by` 存在性检查、`patchRelation` 的 `evidence` 非空检查。
`version/changelog` 的版本化在 B1 上——A 期不改数据结构，只加一层门。

---

## 5. AdminPort

控制台与迁移用，**一对一**包住 store 的全部 20 个方法，不做语义化：

```js
createAdminPort(mind) → {
  enabled,
  getTick, updateTick,            // 迁移脚本要用
  getSelf, listRelations, patchRelation, reviseSelf,
  queryEvents, countUnreflected, listReflections, listActions,
  logSizes, clearLogs,
  listIntentions,                 // B 期新增
}
```

不加语义包装的理由：控制台要看"原样的状态"，任何聚合都会掩盖诊断信息。
但 `AdminPort` **不得**出现在 `src/runtime/` 或 `src/contract/pipeline.js` 里——
这一点靠 §10 的静态检查守。

---

## 6. NOOP 语义表

无 mind 时每个方法的返回值。这张表就是"删掉 `src/mind/` 之后她的样子"。

| 方法 | NOOP 返回 | 后果 |
|---|---|---|
| `enabled` | `false` | 运行时据此决定要不要走心智分支 |
| `bodyRead()` | `{ enabled:false, rev:0, energy:0, energyMax:0, counters:{0,0}, sleep:{state:'awake',since:0,nightKey:'',stayUps:0}, snoozes:{}, proactiveAt:{} }` | 体力 0 → free 不可行（且 free 的 `profile.requires` 会先拦住） |
| `bodySettle()` | `{ body: <同上> }` | 不写盘 |
| `bodyApply()` | `{ ok:false, code:'no-mind' }` | 调用方忽略返回值即可 |
| `scene()` | `{ entries:[], restCount:0 }` | 素材里没有"人" |
| `selfBrief()` / `relationBrief()` | `''` | 提示词里少一段，不出现空标题 |
| `recall()` / `recentEvents()` / `recentActions()` / `intentions()` / `openObservations()` | `[]` | |
| `reflectionDebt()` | `0` | 整合阶梯不会跑 |
| `lastAction()` | `null` | |
| `proposeIntention()` / `closeIntention()` / `recordAction()` / `recordAttempt()` / `recordOutcome()` | `{ ok:false, code:'no-mind' }` | |
| WriterPort 全部写方法 | `{ ok:false, code:'no-mind' }` | 工具返回"心智功能未启用"给模型（**不是崩溃**） |

**关键一点**：`free` 与 `integrate` 两个运行时在无 mind 时**不是靠 NOOP 兜底，而是根本不启动**。
做法是给 profile 加一个字段，复用同一条能力总线：

```js
// src/runtime/profiles.js
free:      { requires: ['mind.store'], … },
integrate: { requires: ['mind.store'], … },
chat:      { requires: [], … },
automate:  { requires: [], … },
```

`mind.store` 由 `src/mind/index.js` 在装配时通过 `capabilityBus.provide('mind.store', 'mind', …)` 登记。
心智目录被删 → 装配根不登记 → 两个运行时不可用、相关工具（`requires:['mind.store']`）自动消失。
**全链路没有任何 `if (noMind)` 特判。**

---

## 7. 错误码

| code | 何时 | 谁该处理 |
|---|---|---|
| `no-mind` | 端口为空实现 | 调用方返回人话给模型；不重试 |
| `not_a_writer` | 句柄来源不在写入规程里 | 编程错误，记日志并拒绝 |
| `needs_evidence` | `patchRelation` 没带证据 | 工具层补证据后重试 |
| `needs_reason` | `reviseSelf` 没写理由 | 模型补参数后重试 |
| `invalid_patch` | `bodyApply` 出现白名单外的键 | 编程错误，拒绝而非静默忽略 |
| `stale` | `bodyApply` 的 `rev` 与磁盘不一致 | **重读 `bodyRead()` 后重算**，不要原地重试 |
| `not-implemented` | B 期接口在 A 期被调用 | 编程错误；A 期这些方法只应出现在开关后面 |
| `store-error` | 底层 IO 失败 | 记日志；本次调用失败但进程继续 |

统一形状：`{ ok:false, code, message }`，`message` 是给模型/用户看的中文一句话。

---

## 8. 迁移清单（45 处 → 约 20 处）

`orchestrator.js` 里 `this.mind.*` 共 **45 处**，按方法分布：

| 方法 | 次数 | 目标端口 |
|---|---|---|
| `updateTick` | 13 | `bodyApply` / `bodySettle` |
| `getTick` | 13 | `bodyRead` / `bodySettle` 返回值 |
| `appendAction` | 6 | `recordAction` |
| `queryEvents` | 3 | `scene` / `recentEvents` / `recall` |
| `countUnreflected` | 3 | `reflectionDebt` |
| `getRelation` | 3 | `scene` |
| `appendEvent` | 2 | `WriterPort.appendEvent` |
| `patchRelation` | 1 | `WriterPort.patchRelation` |
| `listActions` | 1 | `lastAction` |

### 8.1 逐行

| 行 | 现在 | 改成 | 备注 |
|---|---|---|---|
| 1742 | `getTick() → lastReflectAt` | `bodyRead().sleep`… → `reflectionDebt` | `#maybeReflect`，B 期整体挪进 integrate |
| 1744 | `countUnreflected` | `reflectionDebt({chatKey})` | |
| 1887 | `getTick` | `bodyRead` | `migrateImpressions`，**A 期就挪到迁移脚本** |
| 1903 | `getRelation` | `WriterPort.patchRelation` 前置检查 | 同下 |
| 1907 | `patchRelation` | `WriterPort.patchRelation(…, { evidence: [] })`（句柄 `by:'migration'`） | 迁移专用，允许空证据 |
| 1912 | `updateTick({migratedImpressions})` | `AdminPort.updateTick` | **移出运行时** |
| 1937 | `getTick` | `bodyRead` | `#refreshSleep` |
| 1946 | `updateTick({sleep: asleep})` | `bodyApply({sleep:{state:'asleep',…}})` | |
| 1949 | `appendAction(sleep)` | `recordAction` | |
| 1952 | `updateTick({sleep: awake})` | `bodyApply({sleep:{state:'awake', stayUps:0}})` | |
| 1953 | `appendAction(wake)` | `recordAction` | |
| 1960 | `updateTick({sleep: jitter})` | `bodyApply({sleep:{…}})` | |
| 2097 | `getTick` | — | 与 2099 合并成一次 `bodySettle` |
| 2099 | `updateTick(tick)` | `const {body} = bodySettle({now})` | 消掉一次读写 |
| 2131 | `getRelation` | `scene()` | 与 2137 一起收进 `materials.js` |
| 2132 | `getTick` | `bodySettle` 已给 | |
| 2133 | `countUnreflected` | `reflectionDebt` | |
| 2137 | `queryEvents(limit:1)` | `scene()` 的 `lastEventAt` | |
| 2203 | `getTick` | — | 与 2204 合并 |
| 2204 | `updateTick({todayDecisions:+1})` | `bodyApply({counterDelta:{todayDecisions:1}})` | |
| 2214 | `updateTick({snoozes})` | `bodyApply({snooze: next})` | |
| 2216 | `appendAction(idle)` | `recordAction` | |
| 2242 | `getTick` | `bodyApply` 的返回值 | |
| 2263 | `updateTick(patch)` 复合 | `bodyApply({spend, counterDelta, snooze})` | **一次写盘，保持原子** |
| 2266 | `appendAction(decision)` | `recordAction` | |
| 2280 | `getTick()` 作为返回值 | `bodyRead()` | `#runTick` 返回值 |
| 2303 | `getRelation` | `scene()` | `#buildRoster` |
| 2312 | `queryEvents(limit:1)` | `scene()` | |
| 2360 | `listActions(limit:2)` | `lastAction()` | `#lastActionText` |
| 2382 | `getTick` | — | 与 2384 合并 |
| 2384 | `updateTick(tick)` | `bodySettle({now})` | |
| 2399 | `getTick().energy` | `body.energy` | 已在手 |
| 2418 | `countUnreflected` | `reflectionDebt` | 全局候选 |
| 2559 | `getTick` | `bodyApply` 返回值 | |
| 2576 | `updateTick(patch)` 复合 | `bodyApply({spend, counterDelta, snooze})` | |
| 2580 | `appendAction` | `recordAction` | |
| 2614 | `getTick` | — | 与 2615 合并 |
| 2615 | `updateTick({todayDecisions:+1})` | `bodyApply({counterDelta:{todayDecisions:1}})` | |
| 2627 | `updateTick({snoozes})` | `bodyApply({snooze: next})` | |
| 2628 | `appendAction(idle)` | `recordAction` | |
| 2699 | `getTick` | `bodyApply({sleep:{stayUps}})` 自增 | `stay_up` 动作 |
| 2702 | `updateTick({sleep: stayUps})` | 同上（合并成一次） | |
| 2746 | `appendEvent` | `WriterPort.appendEvent({ source:'free-action' })`（句柄 `by:'runtime.free'`） | **C 期改为调 `remember_event` 工具后删除** |
| 2766 | `queryEvents` | `recall({chatKey, query})` | `#recallForChat` |
| 2779 | `appendEvent` | `WriterPort.appendEvent` | **C 期同上** |

### 8.2 连带清理（不在 45 处内，但必须一起改）

| 位置 | 现在 | 改成 |
|---|---|---|
| `prompt.js:998` | `ctx.mind && ctx.mind.enabled` | `ctx.mindEnabled` 布尔（由装配根传） |
| `mind/tools.js:17` | `typeof ctx.mind.appendEvent === 'function'` 鸭子判型 | `ctx.writer`（WriterPort），`writer.enabled` |
| `routes.js` 14 处 | 直接 `mind.*` | `AdminPort` |
| `orchestrator.js:111` | `this.lastProactiveAt = new Map()`（内存，重启丢） | `body.proactiveAt`（随 `tick.json` 落盘，见 §8.4） |

### 8.3 收益

迁移不是等价替换，调用点会**收敛**：

| 现在 | 合并后 |
|---|---|
| 2097+2099、2382+2384、2203+2204、2614+2615、2699+2702 | 各合成 1 次 |
| 2131+2132+2137、2303+2312 | 收进 `materials.js` 的一次 `scene()` |
| 2360 的 5 行格式化 | 收进 `materials.js`，端口只给记录 |

45 处 → 约 20 处端口调用 + 3 处挪进 materials。
**但这 20 处不必一次做完**——见 §9 分批。

### 8.4 唯一读路径（防止两份真相）

B 期会出现 `actions.jsonl` 与 `attempts.jsonl` 并存。规则：

| 阶段 | 写 | 读 |
|---|---|---|
| A1 | `recordAction` → `actions.jsonl`（不变） | `lastAction` / `recentActions` 读 `actions.jsonl` |
| B4 起 | `recordAttempt` → `attempts.jsonl`；**`actions.jsonl` 冻结，不再写入** | `lastAction` / `recentActions` **只读 `attempts`**，并在端口内映射成旧形状 |

- 唯一读路径是端口，不是文件。UI 永远调 `recentActions()`，不直接读 jsonl。
- `actions.jsonl` 冻结后保留当历史，可在 B 期结束时归档；**不做迁移、不做双写**。
- `proactiveAt` 与 `snooze` 同源（都在 `Body`），一起落 `tick.json`，重启不丢。

---

## 9. 迁移步骤（每步可编译、可测）

| 步 | 内容 | 完成标志 |
|---|---|---|
| **A1-1** | 新增 `src/contract/mind-port.js`（三个工厂 + 三个 NOOP + `rev`）。**无人调用** | `node -e "import('./src/contract/mind-port.js')"` 通过 |
| **A1-2** | `Orchestrator` 注入 `runtimePort`/`writerPort`，**保留 `this.mind` 一版**；只迁 **chat 侧**：`body` → `scene` → `actions` | `npm run test:mind` 全绿；chat 相关用例不变 |
| **A1-3** | 工具 ctx 从 `mind` 换成 `writer`（`by` 由管线注入）；`mindOf()` 改判 `writer.enabled` | `mind-tools-test` 全绿（12 项） |
| **A1-4** | `routes.js` 换 `AdminPort`；`app.js` 成为唯一 import 领域模块的地方 | 控制台接口测试全绿 |
| **A1-5** | 删除 chat 侧的 `this.mind` 直连；加守门测试与静态检查 | 见 §10.3（只覆盖 chat） |

**free 侧（`#runGlobalTick` 与 6 个行动实现，约 25 处）不在 A1 做**，
它随 C 期被重写成 `runFreeAgent` 时一起换端口。理由：那 25 处里有 2 处（`remember` / `recall`
的写入）本来就要删掉改成调工具，先迁一遍等于做两次。

**回滚**：A1-2 到 A1-4 期间 `this.mind` 与 `this.mindPort` 并存，
`config.runtime.mindPort = false` 时全部走旧路径。A1-5 才移除 chat 侧的旧字段；
free 侧的旧字段留到 C 期删。

---

## 10. 测试与守门

### 10.1 单测（新增 `test/mind-port-test.mjs`）

1. `NOOP` 每个方法的返回形状与 §6 表一致（逐条断言，防止实现漂移）。
2. `bodyApply` 白名单：`{ spend: 5, rev }` 生效；`{ foo: 1, rev }` 返回 `invalid_patch` 且**不写盘**。
3. `bodyApply` 原子性：`{ spend: 15, counterDelta:{todayProactive:1}, snooze:{...}, rev }`
   一次写盘后，重读磁盘三处都变了（防止实现成三次写）。
4. **CAS**：两次 `bodyRead()` 拿到同一个 `rev`，先后 `bodyApply` → 第二次返回 `stale`，
   且体力只被扣一次（这条同时是并发回归测试）。
5. **观测**：`recordAttempt({footprint:'chat:outbound', target:'private:1'})` 后
   `openObservations()` 多一条；`recordOutcome({state:'hit'})` 后消失。
6. `WriterPort`：管线注入 `by:'tool:update_relation'` 的句柄写 `self.narrative` → `not_a_writer`；
   **工具自己无法改 `by`**（传参被忽略，断言）。
7. `patchRelation` 空证据 → `needs_evidence`；带证据 → 成功。
8. `createRuntimePort(null).enabled === false`，且所有读方法不抛。

### 10.2 架构守门（放进 `npm test`）

```js
// test/mind-port-boundary-test.mjs
// ① 除装配根与 mind 自身外，任何文件都不许 import 领域模块
// ② src/runtime/** 与 src/contract/pipeline.js 不许出现 AdminPort
// ③ src/contract/mind-port.js 不许出现 from '../mind
```

用 `fs` + 正则扫源码即可，不需要 AST。

### 10.3 "删掉 mind 仍能启动"的等价测试

不真的删目录（CI 里会有缓存与副作用），而是**用一个不登记 `mind.store` 的装配**：

```js
// test/mind-absent-test.mjs
const app = await createApp({ mind: null });          // 装配根不创建 MindStore
await feedMessage(app, 'private:123', '在吗');         // chat 走完一轮
assert(app.ports.runtime.enabled === false);
assert.equal(runtimeAvailable('free'), false);         // profile.requires 拦住
assert.equal(toolAvailable('remember_event'), false);  // requires:['mind.store'] 拦住
assert.equal(session.status, 'done');                  // 没有崩，也没有空回复
```

**范围说明**：A1 只迁了 chat 侧，所以这条测试在 A1 **只对 chat 成立**。
完整的"删掉 mind 仍能跑"（含 free / integrate 不启动）在 **C 期收尾**复验——
那时 `#runGlobalTick` 已经变成 `runFreeAgent` + 端口。

它仍然是 §1 那条架构判据的机械形式，只是**分两次兑现**：A 期兑现 chat 那一半，
C 期兑现另一半。这也是为什么它不该当排期的驱动项——它是收尾的守门，不是路线图。

---

## 11. 待拍板

1. **`tick.json` 要不要在 A 期拆成 `body.json` + `rhythm.json`？**
   现在混了三种东西：身体（energy）、计数器（today*）、调度（`impulseAt` / `actionStats`）。
   倾向：**A 期不拆**（拆了要迁移），C 期再拆；端口从第一天就只暴露 `body` 语义，
   所以拆分对调用方无感。
2. **`recordAction` → `recordAttempt` 的切换窗口怎么写？**
   已定方向（§8.4）：B4 起 `attempts` 为唯一写入与读取源，`actions.jsonl` 冻结、不迁移、不双写。
   仍待定的是**冻结时点**——是 B4 一上线就冻，还是先双写一周观察。
3. **端口要不要 async？**
   见 §3 末。建议 A 期同步，B 期统一加 `await`（一次性，不散着改）。
4. **`by` 的取值表要不要允许扩展自定义？**
   目前只有 `tool:<id>` / `integrate.chat` / `integrate.global` / `runtime.*` / `user` / `migration`。
   建议**封闭枚举**——开放自定义等于开放越权面。真需要新来源时改代码加一行。

---

## 附：与设计 v3 的对应

| 设计 v3 章节 | 本文落点 |
|---|---|
| §3.3 MindPort | §3 / §4 / §5 |
| §4.2 写入规程 | §4 的 `WRITERS` 表；`by` 由管线注入 |
| §4.5.4 待观测表 | §3 的 `recordAttempt` / `recordOutcome` / `openObservations` |
| §7.3 唤醒（两套时钟） | 不属端口，但 `bodyRead()` 提供 `impulseAt` 与 `proactiveAt` |
| §12 A1 | §9 的 A1-1…A1-5（只含 chat + routes） |
| §12 A 期收尾守门 | §10.3（chat 部分），C 期复验全部 |
| §6.1 `profile.requires` | §6 末（已写入设计 v3 的 profiles 示例） |
