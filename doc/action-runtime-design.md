# 行动运行时设计（v3.1）

| 项 | 内容 |
|---|---|
| 状态 | **设计定稿，尚未实施**；本文件是施工依据，不是现状描述 |
| 目标版本 | 0.6 |
| 代码基准 | `ef5a8ec` |
| 读者 | 参与本模块实现与验收的开发者 |
| 最后更新 | 2026-10-29 |
| 配套 | [导读（非开发者优先）](./architecture-primer.md) · [领域端口规格](./mind-port-spec.md) · [文档索引](./README.md) |

**先读导读。** [`architecture-primer.md`](./architecture-primer.md) 不含代码细节，配 7 张图，
说明"何时调用模型 / 各时刻看到什么 / 上下文与缓存 / 记录如何生长 / 一天怎么跑"。
本文只写"怎么实现、按什么顺序、怎么验收"。

**与上游的关系**：本分支基于上游 0.4。上游 0.5 是一次重写，方向是多账号、协议端管理、
扩展市场与规则画布，并且**没有"心智/自由行动"这一层**。因此本文只在架构手法上参考它
（分层、调用管线、owner 化注册、启动组合），**不追随其路线**；心智部分没有外部参考答案，
判断依据一律写进正文与 §2 的"被否决方案"。

**本版要点（v3.1）**：兜底事件（§4.2.1）、强事件可机械命中（§4.3.1）、
内置工具的场合分配与扩展分配入口（§6.2.1 / §6.2.2）、启动对账（§9.4）、参数分档（§13.1）。
版本沿革见 §14。

---

## 0. 一页纸

**做什么**

- 切成五层（内核 / 契约 / 领域 / 投影 / 界面），依赖单向，**领域层独立可删**。
- 领域层定义六个一等对象（自我、关系、事件、反思、叙事、意图）与**写入规程**，
  用一条**整合阶梯**把"发生过什么"逐级变成"她认为自己是怎样的人"，并加**强事件**触发。
- 补**结果回路**：意图 → 尝试 → 观察 → 更新节律。按动作类型分三套信号；
  没有干净信号的动作**明确不学**，而不是假装在学。
- 运行时变成一张数据表；工具只声明 traits；**嵌套运行**有明确语义与深度限制。
- 唤醒拆成**两套时钟**：冲动随机（`impulseAt`），到期确定（意图 / 成熟 / 社交截止 / 自动化）。
- 每次模型调用落一条 **Moment**，按"是否写了领域状态"分层保留，可回放、可对账。

**不做什么**

- 不做多账号、协议端管理、扩展市场、规则画布。
- 不做组件 `wrap` 组合层（只预留 `(previous, ctx)` 签名，本期最多单层 replace）。
- 不重命名已存在的工具字段（`parameters` / `requires` / `category` / `defaultEnabled` 原样保留）。
- 不新增"第 5 种运行时"来装日记——日记是整合阶梯 L3。
- 不做"动作自己上报有没有人回应"——观测归系统。

---

## 1. 判据

| 词 | 可操作定义 | 验收 |
|---|---|---|
| **成长** | 写过的东西能被读回，并**改变下一次行为** | 意图→结果→节律三段打通；失败后该动作的期望间隔变长 |
| **自由** | 能自己决定何时、做什么、对谁，只受**可解释**的约束 | 无标记者也能醒；菜单不因触发来源增删；约束集中在权限与预算两处 |
| **成熟** | 同一处境行为稳定、可解释、不自相矛盾 | 自我只能被自己的整合写；写入有证据与版本；成本与副作用可观测、可撤销 |

架构判据（分两次兑现，见 §12）：

> **把 `src/mind/` 整个删掉，应用照常启动，只是"她没有内心生活了"。**
> A 期兑现 chat 那一半，C 期兑现全部。

---

## 2. 词汇表（不新造词）

代码里 `capability` 已被"服务能力提供者"占用（`src/skills/capabilities.js`）。v3 沿用现有词：

| 词 | 含义 | 落点 |
|---|---|---|
| **Capability** | 服务接口，按名字由若干 owner 提供 | `src/skills/capabilities.js`：owner 化、同 owner 覆盖、`removeOwner`、null 占位 |
| **Tool** | 模型可调用的函数，带 `parameters` 与 `execute` **或** `composite` | `src/tool-registry.js`：28 个内置 + 技能/插件注册 |
| **Action** | Tool 的投影：`traits.act` 为真且当前模式为 free | 现 `src/mind/actions.js` 的 6 条 |
| **Composite** | 一次 Tool 调用 = 一次子模型运行（§4.7） | 新增 |
| **Material** | 运行时打包的只读上下文 | 现散落在 `buildGlobalDecisionPrompt` |
| **Moment** | 一次模型调用及其完整输入输出，可嵌套 | 新增，§8 |
| **Runtime** | 一套策略：工具、素材、预算、收尾 | 现 `#runAgent` 与 `#runGlobalTick` 两份 |
| **Intention** | 她想做但还没做的一件事 | 现 `relation.openLoops` 的雏形，§4.4 |
| **Observation** | 系统替她盯的"后来有没有反应" | 新增，§4.5.4 |

**结论：不需要新的"能力注册表"。** 只需给现有 Tool 注册表加 traits，把现成 Capability 注册表提层当服务总线。

---

## 3. 分层与依赖

### 3.1 五层

```
L4 界面      console / ui        按"她的成长"组织
L3 投影      src/runtime/        profile × 处境 → 工具表 / 菜单 / 素材 / 提示词
L2 领域      src/mind/           六对象 + 写入规程 + 整合阶梯 + 意图/观测
L1 契约      src/contract/       工具注册与管线 / 能力总线 / 权限 / 冲突
L0 内核      src/kernel/         config / storage / bus / http / llm / scheduler / transport
```

**依赖规则（可检查，才有意义）**

1. 只允许上层 import 下层。
2. **配置 schema 分层注册**：kernel 只提供通用配置设施（默认值合并、脱敏、原子写、变更事件），
   **不认识产品字段**；`mind.*` / `tools.*` / `persona.*` / `sticker.*` 由各层在装配时注册。
   现状 `src/config.js` 883 行塞了八个产品段，所以这是 **A 期 A5 的一个条目**，不是"第一天就该绿"的规则。
3. L2 不得 import `onebot` / `http`；L0 不得 import 领域模块。
4. **跨层唯一通道是契约**：扩展 ↔ 领域只经 Tool/Capability；领域 ↔ 外部只经 Capability。
5. 三条静态检查（`fs` + 正则即可）：
   `grep -r "onebot" src/mind/` 为空；`grep -r "from '../mind" src/kernel/ src/runtime/` 为空；
   `grep -r "AdminPort" src/runtime/` 为空。

### 3.2 文件落位

**不做一次性目录大搬迁**（会把 40 多个文件的 import 全打散）。只新建两个目录放新代码，旧文件按 §12 逐步搬：

```
src/contract/     （新建）
  tool-registry.js      由 src/tool-registry.js 迁入并扩展（旧路径保留 re-export）
  pipeline.js           八步调用管线
  permissions.js        权限作用域（收据在 D 期）
  capability-bus.js     由 src/skills/capabilities.js 提层
  mind-port.js          领域端口（接口 + 空实现）
  nested.js             嵌套运行：深度、ancestry、anthropic 预算传递（§4.7）

src/runtime/      （新建）
  profiles.js           运行时数据表
  project-tools.js      工具表投影
  project-menu.js       菜单投影
  materials.js          素材包
  prompt.js             装配（复用 src/prompt-layers.js）
  run-agent.js          统一执行器
  chat.js / free.js / integrate.js / automate.js
  wake.js               impulseAt / nextWakeAt / 门禁（纯函数）
  automator.js          自动化调度器（与 free 无关，§7.3）

src/mind/         （既有，按层整理）
  store.js / writer.js / integration.js / intention.js / habits.js / observations.js
  recall.js / inject.js / birth.js / sleep.js
  migrate.js            心智数据迁移（§9.3）
```

`src/orchestrator.js` 的目标：**只剩 chat 的触发与编排**，从 3328 行降到 800 行以内。

### 3.3 MindPort：领域端口

运行时**不允许**直接 `this.mind.appendEvent(...)`。接口详见 [`mind-port-spec.md`](./mind-port-spec.md)，此处只列约束：

- **只有装配根**（`src/app.js`）可以 import 领域模块；`mind-port.js` 不 import mind，只接受鸭子类型。
- `RuntimePort`：读素材、身体状态、意图、记录尝试/结果。**没有 `reviseSelf` / `patchRelation`**。
- `WriterPort`：领域写入，`by` 由**管线按调用注入**（工具侧签名里没有这个参数）。
- `AdminPort`：控制台与迁移专用，一对一包 store。
- 读不抛（空形状），写不抛（`{ok:false, code}`）。

---

## 4. 领域层：心智

### 4.1 六个一等对象

```js
Self {
  version, narrative, mood: { label, valence }, preoccupations: [],
  invariants: [],                // 底线，整合改不动，只有管理员能改
  selfNotes: [],                 // 待整合的"我好像变了"（per-chat 反思产出）
  changelog: [], updatedAt
}
Relation {
  userId, names: [], nickname, stage, trust, warmth,
  knownFor: [], tender: [], recentSummary, confidence, evidence: [],
  version, changelog: [], updatedAt          // B1 已补：老数据读取时按 0 / [] 兜底
}
Event {
  id, ts, chatKey, actorId, actorName, kind, text,
  valence, salience, tags: [],
  source,                        // chat | tool | free | integration
  momentId, attemptId            // 溯源
}
Reflection {
  id, ts, scope: 'chat' | 'global', chatKey?, materialsDigest,
  text, patches: []              // 这次反思实际改了什么
}
Narrative { id, ts, title, body, eventIds: [], reflectionIds: [], chats: [], tags: [], deleted }
Intention {
  id, ts, createdBy: 'self' | 'reflection' | 'user',
  text, about: { chatKey?, userId? },
  kind: 'contact' | 'check' | 'write' | 'organize' | 'custom',
  dueAt, expiresAt, priority,
  status: 'open' | 'done' | 'expired' | 'dropped',
  attempts: [], evidence: []
}
```

> `Intention.kind: 'check'` 是为"2 小时后看看动态"这类**延时查看**准备的（§4.4 末）。

### 4.2 写入规程

管线执行写入前查表。

| 目标 | 允许的写入者（`by`） | 必须带 | 版本化 |
|---|---|---|---|
| `Self.narrative/mood/preoccupations` | `integrate.global`、`tool:self_revise` | `momentId` + `reason` | `version++` + `changelog` |
| `Self.selfNotes` | `integrate.chat`、`integrate.global` | `momentId` | 追加，上限 20 滚动 |
| `Self.invariants` | 无（仅配置） | — | 运行时只读 |
| `Relation` | `tool:update_relation`、`integrate.chat` | `evidence: [eventId]` | `version++` + `changelog`；**只补证据不算改动**（版本记的是"判断变了第几次"） |
| `Event` | `tool:remember_event`、`tool:update_relation`（依据事件）、`runtime.chat`、`runtime.free`、`integrate.global` | `source` + `momentId` | 追加，按 id 去重 |
| `Reflection` | `integrate.chat`、`integrate.global` | `materialsDigest` | 追加 |
| `Narrative` | `tool:diary_write`、`integrate.global` | `eventIds` 或 `reflectionIds` | 软删 |
| `Intention` | `runtime.free`、`integrate.*`、`user` | `reason` 或来源 | 状态机 |
| `Observation` | 管线（自动） | `attemptId` | 状态机 |

三条规矩：

1. **写入即溯源**：每条领域记录必须能指回一个 `momentId`。
2. **改结构必版本**：覆盖式写入（Self / Relation）必须 `version++` 且留 `changelog`。
3. **越权即失败**：写入者不在表里 → 管线返回 `denied`，不是静默丢弃。

`by` 是**封闭枚举**（`tool:<id>` / `integrate.chat` / `integrate.global` / `runtime.chat` / `runtime.free` /
`runtime.automate` / `user` / `migration`）。开放自定义等于开放越权面。

#### 4.2.1 兜底事件：记忆不能依赖模型自觉

**问题**：现在事件只有三个来源——`remember_event` 工具、`remember` 行动、`recall` 回写——
**全部要求模型主动发起**。而模型在"怎么回这句话"的任务里几乎不会顺手去记，
于是事件长期为 0，未整理数永远到不了阈值 8，反思永不触发，关系与自我永不更新。
这是**整条整合链的冷启动死锁**，不是调参问题。

**规则**

1. **一次对话时刻至少产生一条事件。** 模型自己写了（`wrote` 里有 event）就用它的；
   没有就由运行时补一条**兜底事件**：`source:'runtime.chat'`、`kind:'interaction'`、
   正文是机械摘要（触发消息前 40 字 ＋ 她回复前 40 字）、`salience: 0.3`。
   **不额外调模型、不额外花钱。**
2. **一次对话时刻最多两条**（模型写的 ＋ 兜底），不叠加。
3. **自由时刻有对外行动且成功时**，同样补一条 `source:'runtime.free'` 的事件。
4. 兜底事件的 `kind` 恒为 `interaction` / `observation`，**不参与强事件判定**（§4.3.1），
   它只保证"有东西可反思"。

**原则一句话**：**"有没有记录"由系统保证，"记录得有多好"由模型负责。**

这条同时解决三件事：反思不再饿死；`reflectionDebt` 有真实输入；
长会话不会因为"她今天没想起来记"而整段丢失。

### 4.3 整合阶梯

| 级 | 输入 | 触发（满足任一） | 上限 | 产物 | 可写 |
|---|---|---|---|---|---|
| **L1 事件** | 聊天 / 工具 | 随时 | — | Event | — |
| **L2a 反思·会话** | 该会话未反思事件 | 未反思 ≥ 8 **或** 距上次 ≥ 6h 且醒着 | 8/日 | Reflection(chat) + Relation 补丁 + `selfNotes` | Relation、selfNotes |
| **L2b 反思·全局** | 近 12 条 L2a + Self 摘要 | 累计 ≥ 12 条 **或** 每日固定时刻 **或** 强事件 | 2/日 | Reflection(global) | — |
| **L3 叙事** | 近 7 天事件 + L2a/L2b | 每 7 天 **或** 里程碑 | 1/周 + 里程碑不占额 | Narrative | — |
| **L4 自我** | 近 3 篇 L3 + 近 10 条 L2b + `selfNotes` | **强事件** **或** 每月 **或** `selfNotes` ≥ 3 | 1/月 + 强事件不占额 | Self（`version++`） | Self |

#### 4.3.1 强事件：判定必须能机械命中

原判据里 5 条有 3 条依赖模型主动打标签（`kind` / `salience` / `openLoops` 标签），
而模型连 `remember_event` 都不常调——所以强事件**有很高概率永远不命中**。
改成"系统可机械判定 ＋ 模型可加标签 ＋ 用户可兜底"：

| 判据 | 由谁判定 | 说明 |
|---|---|---|
| `stageRegressed(relation)` | **系统** | 关系阶段回退（`familiar → acquaintance`、任何 → `strained`）时机械检测 |
| **文本规则命中** | **系统** | 冲突词（`别说了`/`拉黑`/`不想理你`/`滚`）、告别词（`走了`/`以后不来了`/`再见`）、重大承诺（`答应你`/`一定`）。命中即给该事件 `strong: true`，并把 `kind` 补成 `conflict` / `milestone` |
| **长时间沉默后回归** | **系统** | 某人 > 30 天没出现又出现 → 只触发 L2b，**不**触发 L4（回归不是冲突） |
| `kind ∈ {conflict, milestone}` | 模型 | 模型主动打了标签就照收 |
| `salience >= 0.8` | 模型 | 同上 |
| 用户在界面「标为重要」 | 用户 | 手动兜底 |

命中后不等月度窗口，下一次 `integrate` 就排 L4；但**同日最多一次**（避免一次争吵引发整夜自我重写）；
强事件**不占**月度额度。

**两条保底**

1. **L4 的月历触发不依赖强事件**——即使强事件一次都没命中，自我仍会按月更新。
   强事件只是"提前"，不是"唯一"。
2. **可观测**：`moments` 与界面里统计"强事件命中次数"。若一个月为 0，
   说明文本规则错了或阈值得调，而不是"她这月很平静"。

**与旧行为的关键差异**：现在 `applyReflection` 会直接写 Self（`mind/reflect.js:189`），
而反思是**按会话**触发的——谁的会话先攒够 8 条事件，谁的语境就成为她自我叙事的来源。
本设计把 Self 的写权限收到 L4，L2a 只产出 `selfNotes`。

### 4.4 意图：只有开/关

```
open ──做了什么──► done
  ├──到 expiresAt──► expired
  └──她放弃────────► dropped
```

**没有 `proposed → accepted`。** 让 free 每轮先审意图 = 多一轮调用；自动采纳 = 又变回待办清单。
**"采纳"就是她真的去做了。**

| 来源 | 素材措辞 |
|---|---|
| `self` / `reflection` | "你惦记着：…" |
| `user` | "有人希望你：…"（她可以不理，自然 `expired`） |

**延时查看（回答"能不能 2 小时后看看社交媒体"）**：不需要新机制，用意图即可。

```
她：intend({ text: '看看动态有没有人理', kind: 'check', dueIn: 2h })
2h 后：free 被这条 dueAt 叫醒 → 素材里出现"你惦记着：看看动态…" → 调只读工具 → closeIntention(done)
```

要写清的两件事：

- **意图是"她安排的未来动作"（有意志）**；**观测是"系统替她盯的后果"（无意志）**。
  前者用 `intend`，后者由 `traits.footprint` 自动开。两者不要混。
- 意图的 `kind: 'check'` 只影响素材措辞与默认 `expiresAt`（读类给 24h），**不影响调度**——
  调度只看 `dueAt`。

### 4.5 节律：从配置到统计

#### 4.5.1 信号由系统观测，不由动作上报

**核心决定：动作不测量自己，系统测量它。** 观测通道（消息存档、发送队列、`WriterPort`）都在系统手里。

`traits.footprint` 是封闭枚举，**可缺省**：

| footprint | 含义 | 回声判定 | 参与调频 |
|---|---|---|---|
| `chat:outbound`（**仅私聊**） | 她给某个私聊发了消息 | 该会话出现非她的新消息，且她那条是最后一条 | ✅ |
| `chat:outbound`（群聊） | 她在群里说话 | **不判定**（群里任何新消息都不等于回应） | ❌ 只判成败 |
| `store:event` / `store:relation` / `store:self` / `store:narrative` | 写了领域状态 | 只做审计，**不算回声** | ❌ |
| `external:post` | 发到外部平台 | **不判定**（拿不到可靠信号） | ❌ 只判成败 |
| `none` | 只读 / 计算 / 内部整理 | — | 走"效用"（§4.5.3-C） |

**缺省推断（作者零负担）**：`kind:'send'` 且 scopes 含 `chat.send` → `chat:outbound`；
经 `WriterPort` 落盘的自动记 `store:<target>`；其余 `none`。

**为什么 `store:*` 不算回声**：她自己 recall 自己刚写的事件，会形成自我强化。
写作类动作的价值不由"有没有人立刻用上"决定，交给审计与叙事层评估。

#### 4.5.2 三套更新规则

```js
// data/mind/tick.json → actionStats
send_proactive: {
  kind: 'contact',
  attempts: 12, ok: 10, failed: 1,
  echo: { hit: 6, missed: 4 },
  initialIntervalMs: 6 * 3600000,
  meanIntervalMs: 5.4 * 3600000,
  dormant: false,
  lastRunAt: 0, nextRipeAt: 0
}
```

**A. `contact`（私聊 `chat:outbound`）—— 保守**

| 条件 | 效果 |
|---|---|
| `attempts < 5` | **不调**，用初值 |
| 有回声 | `meanInterval × 0.95` |
| 无回声 | `meanInterval × 1.03`（轻微降频，**不归因**） |
| 探索下限 | `meanInterval ≥ 0.6 × initial` |
| 衰减上限 | `meanInterval ≤ 3 × initial`；触顶标 `dormant: true`，进素材与 UI，不静默死掉 |
| 执行失败 | 只退避 `nextRipeAt`，不动 interval |

**B. `publish`（群聊 / `external:post`）—— 只判成败**

节奏 = 初值 + 抖动 + 每日上限。不做 ×0.95 / ×1.03，因为没有可靠信号。

**C. `internal`（`none` + 写 store）—— 用效用，权重更小**

| 动作 | 效用信号 | 效果 |
|---|---|---|
| `organize` / 反思 | 本次产出的事件/反思条数 > 0 | `meanInterval × 0.97` |
| 同上 | 连续 3 次 0 产出 | `× 1.10` |
| `recall` / `check` | 召回到的内容在 24h 内被引用 | `× 0.97` |

**贯穿原则：不归因。** "没人回应"只允许轻微降频，**不许**进 `changelog`、**不许**进自我叙事。

#### 4.5.3 一次行动 = 一条观测

```jsonc
// data/mind/observations.jsonl
{ "id":"o_...", "attemptId":"a_...", "toolId":"send_proactive",
  "kind":"echo", "chatKind":"private", "key":"private:123",
  "openedAt":0, "deadlineAt":0, "state":"open" }
```

- **开**：管线在 `traits.act` 工具**成功**后开一条，**每个 attempt 一条**，键是 `attemptId`，
  **不是每次 `send_message` 一条**。她一次连发两条属于同一次行动，第二条**不会**把第一条 void 掉。
- **关（零成本）**：`chat` 运行时收到该会话消息时顺手关 → `hit`。
- **关（补偿）**：`integrate` 每次启动扫过期项 → `missed`。
- **作废 `void`**：截止前**又发生了一次同目标的新 attempt** / 该会话被别的动作改动 / 会话正在运行。
- **统计就地更新**：观测关闭时就地写 `actionStats` 计数并重算 `meanIntervalMs`；
  `integrate` 只做审计与 `dormant` 标记。**不能等 integrate**，否则 C4 的 `nextRipeAt` 会滞后一整个整合周期。

窗口：私聊 `contact` 默认 72h；`check` 类 24h；群聊不开观测。

#### 4.5.4 扩展如何兼容

| 场景 | 扩展要做的 |
|---|---|
| 默认（发消息 / 写记忆 / 只读） | **什么都不用做**——footprint 推断 + `WriterPort` 自动记账 |
| 想更准 | 声明 `traits.footprint`，或 `traits.outcome: { kind, windowMs }` |
| 永不要求 | 自己去测"有没有人回应"。它没这个视野，也不该有这个权限 |

**护栏**：`footprint` **只影响统计，不影响权限**。声明错了顶多让一个动作学歪，不会越权。

### 4.6 素材包

```
MaterialPack {
  now,            // 时间、睡眠窗口、体力、今日额度
  self,           // ≤120 tok
  relations,      // ≤150 tok：相关的人 top3
  intentions,     // ≤120 tok：到期 / 近期（含 kind:'check'）
  scene,          // ≤150 tok：roster top3
  recent,         // ≤120 tok：近 3 天事件 ≤5 条
  narrative,      // ≤100 tok：最近 1 篇标题 + 首句
  ripe,           // ≤80  tok：中性事实（"距上次发动态 3 天"）
  lastAction,     // ≤40  tok
}
```

- 超预算按 `intentions > scene > recent > ripe > lastAction` 依次丢弃（**意图先保**）。
- **构建一次只存摘要**：Moment 存 digest 与分段 token 数；正文按 §8 分层保留。
- `needs` 是工具声明的最小集合，运行时可以多给。

### 4.7 嵌套运行时

`send_proactive`（→ chat）与 `organize`（→ integrate）**本身就是一次模型运行**，
不是普通工具。必须先把语义定死，否则 C 期一开工就撞墙。

#### 声明

```js
{
  id: 'send_proactive',
  kind: 'send',
  traits: { modes: ['free'], act: true, external: true, target: 'chat-or-user',
            cost: { energy: 25 },
            composite: { runtime: 'chat', seed: 'proactive', maxDepth: 1 } },
  // 没有 execute —— 有 composite 就不许有 execute，注册时校验
}
```

**注册期校验**：`execute` 与 `traits.composite` **恰好其一**。

#### 调用链

```
free.runAgent(depth=0)
  └─ pipeline.invoke('send_proactive', { chatKey }, ctx)
       ├─ eligibility / 权限 / 参数校验（照常）
       ├─ composite → runAgent({
       │      profile: 'chat', seed: 'proactive', target: chatKey,
       │      parent: { momentId, depth: 1 }, ancestry: [...ctx.ancestry, toolId]
       │   })
       │    ├─ 独立 Moment（parentMomentId = 父，depth = 1）
       │    ├─ 独立 session（UI 可见："她主动开了个话头"）
       │    └─ 返回 { ok, summary, sent, chatKey, usage }
       └─ normalize → toolResult = { ok, summary } 回灌给**父模型**
```

父模型看到的是一句人话摘要（≤200 字），例如"你去找他说了句，他回了两句"，
**不是**子运行的完整对话。子运行的细节在 session 与 Moment 里。

#### 五条硬规则

| 规则 | 做法 |
|---|---|
| **深度 ≤ 1** | `projectTools` 在 `ctx.depth > 0` 时**过滤掉所有 `composite` 工具**——结构上禁止 chat→free，而不是靠判断 |
| **不重复进入** | `ctx.ancestry` 记工具链；同一工具链里重复出现即拒（`recursive`） |
| **体力只扣一次** | 由**父**（发起行动那层）扣；子运行不扣体力（chat/integrate 本来也不扣） |
| **预算** | 子运行的 token 计入**父唤醒的 token 预算**（`wake.budget.tokens` 是整棵子树的上限） |
| **成本只算一次** | 每个 Moment 只记 `usage.self`；报表按 `runtime` 汇总 `self`；`usage.subtree` 只用于展示，**不进报表** |

#### 并发与失败

- 目标会话正在运行 → 子运行返回 `busy`，行动记 `ok:false, code:'busy'`，**不重试**（下一轮自然再考虑）。
- 子运行失败（模型错、超时）→ 行动记 `failed`，**不扣体力**（她确实试过，但没做成，与 §4.5 一致）。
- 子运行成功但没发任何消息 → 行动记 `ok:true, echo 不适用`，摘要写"她想说但没说"。

#### 为什么深度只要 1

`chat → free` 意味着"回消息时决定去发呆"，既打断应答又没有必要；
`free → chat` 是唯一合理的嵌套（她自己发起对话）。
未来若要 `free → chat → 某个工具`，那是深度 1 内的普通工具调用，不受限制。

---

## 5. 契约层

### 5.1 两层注册表（都用现成的）

| 注册表 | 已有实现 | v3 要做 |
|---|---|---|
| **Capability 总线** | `src/skills/capabilities.js`：owner 化、同 owner 覆盖、`removeOwner`、null 占位；`explainCapability` 在 `skills/manager.js` | 提到 `src/contract/`，补 `claim/claimAsync` 与 `explain()` |
| **Tool 注册表** | `src/tool-registry.js`：id 校验、默认值、`getToolAvailability` 七层、`unregisterToolsBySkill` | 加 traits / kind / scopes / `schemaVersion` / 冲突留痕；可用性统一上下文构造器 |

**不新造第三张表。**

### 5.2 工具 schema v3（只加不改）

```js
{
  schemaVersion: 2,              // 缺省 = 1，见下

  id: 'send_message',            // [a-zA-Z0-9_-]{1,64}；技能工具已有 <skillId>__ 前缀
  owner: 'kernel',               // kernel | mind | skill:qzone | plugin:xxx（取代 skillId，保留兼容）
  name: '发送消息',
  description: '…',
  parameters: { … },             // ← 沿用旧名，绝不改成 params

  kind: 'read' | 'write' | 'send' | 'control',

  traits: {
    modes: ['chat'],             // 唯一可见性来源：chat | free | integrate | automate
    act: false,                  // 可作为"选择"进入菜单
    external: false,             // 有外部副作用
    target: 'none',              // none | chat | chat-or-user
    footprint: null,             // 结果怎么观测；缺省按 kind/scopes 推断（§4.5.1）
    cost: { energy: 0 },         // 仅 act 用
    limits: { cooldownMs: 0, maxPerDay: 0, timeoutMs: null },
    ripeness: null,              // { afterMs, jitter } —— 只是初值
    needs: [],                   // 素材需求
    eligibleIf: [],              // 纯函数数组：能力级资格（静态）
    composite: null              // { runtime, seed, maxDepth }（§4.7）
  },

  scopes: [],                    // ['net.fetch','mind.write','chat.send']
  requires: [],                  // 能力依赖：['mind.store','vision','search']

  discoverable: false,
  defaultEnabled: true,
  category: 'messaging',         // 仅 UI 分组

  execute: async (ctx, args) => ({ ok, summary, data })
}
```

**`schemaVersion` 缺省为 1（重要）**

| 值 | 含义 | 处理 |
|---|---|---|
| 缺省 / `1` | 旧形状：没有 traits / composite；`mindAction`、`requiresVision` 等照旧 | 加载时经 `normalizeTool()` 适配成内部 v2 形状 |
| `2` | 新形状 | 直接用 |
| `> 2` / 非法 | 不认识的语义 | **拒绝加载**，扩展列表标 `unsupported-schema`，附原因 |

没有这一条，升级当天所有存量技能都会被"未知版本"拒掉。

**字段映射**

| 旧 | 新 | 说明 |
|---|---|---|
| `skillId` | `owner` | 保留 `skillId` 一版用于兼容读取 |
| `mindAction.{label,energy,defaultEnabled,when}` | `name` + `traits.act` + `traits.cost.energy` + `traits.eligibleIf` | |
| `requiresVision` / `requiresSearch` | `requires: ['vision']` / `['search']` | **把 vision/search 提升为 Capability** |
| `requires`（旧） | 不变 | 能力依赖轴，不能丢 |
| `category` / `defaultEnabled` | 不变 | |
| v1 的 `runtime` | `traits.modes` | |
| v1 的 `effects.*` | `traits.{cost,limits,external}` | |
| v1 的 `mind.{ripeness,needs}` | `traits.{ripeness,needs}` | |
| v1 的 `policy.{crossChat,requiresOwner}` | `scopes` + `traits.target` + 权限 | |
| （新增） | `traits.footprint` / `limits.timeoutMs` / `composite` | |

**已删除**：`traits.quiet`。原意是"夜间不出现"，但与"睡着整体跳过 free"重复，
且单个工具无权要求半夜叫醒她——真需要夜间行为请用 **automation**（§7.3），它不受睡眠门禁。

### 5.3 调用管线（八步）

`invoke(toolId, args, ctx)`，每步一个错误码：

| # | 步骤 | 名 | 失败码 | 做什么 |
|---|---|---|---|---|
| 1 | resolve | — | `unknown_tool` | 查注册表 |
| 2 | **eligibility** | 资格 | `unavailable` / `disabled` | 八层可用性（唯一口径）+ `traits.modes` + `traits.eligibleIf`。**静态：同一时刻对所有人一致** |
| 3 | permission | 权限 | `denied` / `need_approval` | 逐 scope；A 期无收据 |
| 4 | validate | 校验 | `bad_params` | JSON Schema 子集 + 禁止 `__proto__` 类键 |
| 5 | **veto** | 否决 | `blocked` | 技能 `tool.guard` + before-tool 钩子。**动态：可能因 args 而变** |
| 6 | execute | 执行 | `timeout` / `aborted` / `failed` / `busy` / `recursive` | 超时按 `limits.timeoutMs`（缺省 30s）；执行前复核工具身份；composite 走 §4.7 |
| 7 | normalize | 归一 | — | 统一 `{ ok, summary, data }`；旧式 `{content,isError}` 在此适配 |
| 8 | audit | 审计 | — | 事件、Moment、体力/次数、`actionStats`、开 observation（§4.5.3） |

**第 2 步与第 5 步的职责必须分清**（这是旧代码里最容易混的一处）：

- **eligibility 回答"这个工具现在能不能被用"**——不因这一次的参数而变。
  等价于现有 `getToolAvailability`；它的八个理由要能直接显示在设置页。
- **veto 回答"这一次调用要不要拦"**——可以看参数。
  现有 `tool.guard` 与 `before-tool` 钩子属于这一层。

混淆的后果：把带参数的判断写进 eligibility，会让工具表随参数抖动；
把静态判断写进 veto，会让"设置页说能用、调用被拒"。

三条细节：

- **第 6 步执行前复核**：`tools.get(id) === t` 一行。完整的收据/撤销推到 D 期。
- **超时按工具可配**：`web_fetch` / `read_video` / `read_forward` 必须能声明 `limits.timeoutMs`。
  全局一刀切 30s 会把"慢但会成功"的调用变成失败。
- **归一化在管线里**：现有工具返回 `{content, isError}`，由这一步转 `{ok, summary, data}`，30 多个工具一行不改。

### 5.4 权限与信任（分两期）

**A 期只做三样：**

```js
scope      // 'chat.send' | 'net.fetch' | 'mind.write' | 'fs.read' | 'sys.exec'
policy     // 每个 owner 一张：{ scope: 'allow' | 'ask' | 'deny' }
identity   // 执行前一行：tools.get(id) === t
```

1. **首装默认 deny/ask**：新扩展的 `write/send/external` 默认要批准，与 `defaultEnabled` 是两个轴。
2. **越权不静默**：拒绝原因进 Moment 与界面。
3. **主人开关不是权限**：`requiresOwner` 属于 UI 交互。

**D 期才做**：收据（`receipt`）/ 撤销 / 在途复核 / `fingerprint`。
理由：上游那套的动机是插件市场 + 远程安装；我们目前是本地目录、作者即用户。
在单机前提下，收据的复杂度大于它挡住的风险。

### 5.5 冲突、热重载、卸载

- **命名空间**：`<skillId>__<toolId>` **已是现状**（`plugin-loader.js:81-92`，含 64 字符截断与撞名告警），
  配置里的 key 本来就是前缀后的 id，**没有迁移问题**。
- **同 owner 重复注册 = 覆盖**：热重载路径，必须保留（`plugin-loader.js:393` 依赖它）。
- **跨 owner 撞名 = 后注册者生效 + warn + 留痕**（`{id, winner, loser, at}` 可查）。**不抛错**。
- **卸载**：`unregisterByOwner(ownerId)` 一把清；定时器、订阅、面板按 owner 回收。
- **schemaVersion**：不认识就拒绝，不静默降级。

---

## 6. 投影层

### 6.1 运行时是数据

```js
// src/runtime/profiles.js
// 没有 tools 筛选：可见性只有一个来源 traits.modes。requires 与工具走同一条能力总线。
export const RUNTIME_PROFILES = {
  chat:      { requires: [],             materials: ['now','self','relations','recent'],
               budget: { maxSteps: 8, maxActions: 3, maxTokens: 0.6 }, stop: 'reply-sent-or-end' },
  free:      { requires: ['mind.store'], materials: ['now','self','intentions','scene','recent','narrative','ripe','lastAction'],
               budget: { maxSteps: 5, maxReads: 3, maxActions: 3, maxTokens: 0.6 }, stop: 'chosen-or-idle' },
  integrate: { requires: ['mind.store'], materials: ['events','reflections','self','relations','narrative'],
               budget: { maxSteps: 1, maxActions: 0 }, stop: 'single-pass' },
  automate:  { requires: [],             materials: ['now'],
               budget: { maxSteps: 1 }, stop: 'single-tool' },
  // 预留：learn（能力获取），实现前不出现
};
```

**加一个模式 = 加一行 profile + 给该出现在这个模式里的工具加一个字符串。**
新模式默认什么都不暴露——安全的默认值。

### 6.2 工具表投影

```js
projectTools({ profile, tools, state, availability, depth, ancestry })
```

1. `traits.modes` 包含本模式（唯一可见性来源）；
2. `eligibility(id)` 通过（UI 与运行时共用同一个上下文构造器）；
3. **`depth > 0` 时过滤掉所有 `traits.composite`**（§4.7）；
4. `ancestry` 里已出现过的 `composite` 工具不再出现（防重复）。
5. 总数超阈值时按 `discoverable` 折叠，**不做 `find_capability` 往返**。

#### 6.2.1 内置工具落在哪个场合

现状是硬的：对话拿到「过滤后的全部 28 个工具」，自由时间只拿到 `#freeActionTools()`
里手写的 6 条动作（`send_proactive / organize / recall / remember / stay_up / idle`）。
所以"自由时间读不了消息"不是配置问题，是**两处各写了一遍**。

v3.1 把分配写进 traits，一张表定死（`▲` = 可作为行动进菜单）：

| 组 | 工具 | chat | free | integrate | automate | 说明 |
|---|---|---|---|---|---|---|
| 发消息 | `send_message` | ● | | | | 需要一批消息作为回话对象 |
| | `send_to` | ● | | | | 跨会话，独立开关 |
| | `send_sticker` / `send_poke` / `send_image` | ● | | | | 回话的附属 |
| 查询 | `get_recent_messages` | ● | ● | | | free 里"写之前先看看" |
| | `get_chats` / `get_active_members` / `get_message_detail` | ● | ● | | | |
| | `read_forward` / `get_message_images` | ● | ● | | | 读取类，受读预算约束 |
| 表情 | `list_stickers` / `get_sticker_image` | ● | | | | 表情管理是聊天时的事 |
| | `sticker_note` / `collect_sticker` | ● | | | | |
| 旧的群友印象 | `memory_append` / `memory_query` / `memory_remove` | ● | ● | | | 与心智并存期，C 期后逐步退场 |
| **心智** | `remember_event` | ● | ▲ | ● | | 同一工具：对话里是工具，自由时间是菜单项（5 体力） |
| | `recall` | ● | ▲ | | | 内部动作，效用信号 |
| | `update_relation` | ● | | ● | | 需要证据，不作为菜单项 |
| | `self_revise` | ● | ▲ | ● | | 冷却 7 天，防频繁改写 |
| | `diary_write` | ● | ▲ | ● | | B 期新增 |
| **复合行动** | `send_proactive` | | ▲ | | | `composite → chat`，唯一"开一场对话" |
| | `organize` | | ▲ | | | `composite → integrate`，主动发起一次整合 |
| | `intend` | | ▲ | | | 安排一件以后想做的事 |
| | `stay_up` | | ▲ | | | 晚间"再撑一会儿" |
| 外部信息 | `web_search` / `web_fetch` | ● | ● | | | free 里也允许查，受读预算 |
| | `search_images` | ● | | | | |
| | `read_video` | ● | ● | | | 慢工具，需声明超时 |
| | `check_holiday` | ● | ● | | | |
| 提醒 | `set_reminder` / `list_reminders` / `cancel_reminder` | ● | ● | | | |
| 系统 | `report_feedback` | ● | ● | | | |
| | `finish` | ● | ● | | | 控制类，两个运行时的收尾 |
| 自动化 | （每个任务只拿它需要的那一个） | | | | ● | 不进菜单 |

三条要点：

1. **`integrate` 不是只读**：它需要 `remember_event` / `update_relation` / `self_revise` / `diary_write`
   才能落产物——只是不给它发消息、查外部的能力。
2. **同一个工具可以是"工具"也可以是"行动"**：区别只在 `traits.act`。
   这消掉了现在 `remember` 与 `remember_event` 两套实现（§12 C 期删掉旧动作）。
3. **`automate` 只拿一个能力**，由任务声明；它不进菜单、不受睡眠门禁（§7.3）。

#### 6.2.2 外部扩展怎么分配（人为管理的唯一入口）

作者只能"建议"，用户才能"决定"。默认值刻意保守：

| 工具来源 | 默认 `modes` | 默认 `act` | 默认可见 | 用户要做什么 |
|---|---|---|---|---|
| 内置 | 见上表 | 见上表 | 是 | — |
| 技能 / 插件（新装） | `['chat']` | `false` | **否**（`defaultEnabled` 沿用旧行为：内置默认开、扩展默认关） | 在能力页勾选"允许出现的场合" |
| 扩展作者声明了 `mindAction` | `['chat']` | `false`，但记 `suggestedAct: true` | 否 | UI 显示"作者建议可作为行动"，用户自己勾 |

- **`external: true` 的工具不允许作者自带 `act`**：产生外部副作用的能力要进自由时间，
  必须由用户在界面上逐个打开。
- 分配界面只有一处：**能力页 → 某个工具 → 四个场合的勾选 ＋「可作为行动」＋ 体力/冷却**。
  勾"可作为行动"时才允许填体力与冷却，且必须同时勾上 `free`。
- 所有分配结果落到 `tools.overrides`，与现状的配置路径一致，不引入新的存储。

### 6.3 菜单投影

```js
projectMenu({ profile, tools, state, intentions })
  → MenuItem[] = { toolId, label, reason?, cost, target?, intentionId? }
```

```
菜单 = 全部 eligible 的行动 ∪ 到期意图对应的行动（带 intentionId 与"已经 N 天了"）
```

- **eligible 不含"有没有候选"**。候选只作为素材与 `socialDueAt` 出现。
- 意图项与目录项去重合并：因意图进时多一句上下文，排在最前。
- `traits.target` 决定选不选对象：`none` 不选、`chat` 由运行时给、`chat-or-user` 她选。

**自由 = 目录保证全部可选项，意图保证她看见自己惦记的事。** 两者缺一不可。

### 6.4 提示词装配与预算

沿用 `src/prompt-layers.js` 的五层（safety 100 / charter 200 / self 300 / skills 400 / situation 500），
把 situation 拆成 U1-U4：

| 层 | 内容 | 预算 |
|---|---|---|
| S0 | 安全 + 章程 + 身份摘要 | ≤300 tok |
| S1 | 运行时说明（每 profile 一份，逐字稳定） | ≤120 tok |
| S2 | 工具定义 | 由 profile 决定 |
| U1 | 现场：时间、体力、额度、睡眠 | ≤80 tok |
| U2 | 素材包 | ≤600 tok |
| U3 | 任务：消息批 / 菜单 + 意图 | ≤200 tok |
| U4 | 工具结果（逐步） | 每步 ≤400 tok，累计有上限；超限截断并标注 |

---

## 7. 运行时

### 7.1 一个执行器，四种策略

```js
export async function runAgent({
  profile, port, tools, materials, budget, depth = 0, ancestry = [], parentMomentId = null,
  invokeTool, callModel, hooks, signal, onStep, random, now,
}) → { stop, steps, usage, sent, attempts }
```

**落地形态**：不是"把 chat 与 free 重写成一个新循环"，而是**把 free 的循环体抽成与 `#runAgent` 同形的函数**，
两边共享 `invokeTool` 契约，不共享实现。`#runAgent` 有 600 行（hooks / streaming / abort / inline tool /
rescue / 轮次催发），重写它是最大单点风险。

### 7.2 四个运行时

| 运行时 | 何时 | 调模型 | 工具 | 结束 | 产物 |
|---|---|---|---|---|---|
| **chat** | 收到消息通过门禁 / 被 composite 唤起 | 是 | 读 + 发 + 深思 | 发出消息 / 无工具 / 轮次上限 | 消息、事件、用量 |
| **free** | 唤醒（§7.3） | 是 | 行动 + 读 | 做完一个行动 / idle / 预算 | 尝试、观测、意图、事件 |
| **integrate** | 整合阶梯 | 是 | 只读素材 | 单次 | 反思 / 叙事 / 自我 |
| **automate** | cron / 间隔 | 否（或固定小模型） | 该任务那一个 | 单次 | 外部副作用、运行日志 |

**free 的"做完"**：一次唤醒可连续做 ≤3 个行动，但只有 **1 个 `external` 行动**；
每次行动走管线、结果回灌；可以中途改 idle；结束时每条行动一条 Attempt，整体一条 Moment。

### 7.3 唤醒：两套时钟 + 三条独立调度

**free 的唤醒**

```js
// ① 只持久化这一个随机量
impulseAt = now + Exp(λ0)          // λ0 = 1/4h

// ② nextWakeAt 是纯函数，每次现算，不落盘，不含 cron
nextWakeAt = min(
  impulseAt,
  min(intention.dueAt  for open intentions),
  min(action.nextRipeAt for non-dormant actions),
  socialDueAt
)
```

**`nextWakeAt` 不持久化**：它是当前状态的纯函数，"新增意图要不要重排"这个问题天然不存在。

**`socialDueAt`：把候选从"菜单过滤器"改成"调度项"**

```
socialDueAt = min over chats of:
    lastInteractionAt + proactiveIdleMs      // 很久没联系
    openLoop.since    + openLoopDueMs        // 有件事一直没问
    lastInteractionAt + rememberWindowMs     // 刚聊过、还没记（仅"未记"成立时）
```

**未读不参与**——那是 chat 的职责（见下面的 `chat-pending` 门禁）。

**自动化不进这个公式**

cron 的语义是"到点必须执行"，不该被睡眠、体力、决策预算拦下。
凌晨三点的定时任务如果塞进 `min()`，会被 `asleep` 门禁吞掉。

```
src/runtime/automator.js
  scheduler.every / scheduler.at（按 owner 回收，disposeOwner）
  门禁：只有 paused / aborted / 任务自身 enabled 为 false
  不检查：asleep / energy / decision-cap
  UI 与日志里与 free 并列，措辞明确"到点执行，不是她的决定"
```

**睡眠 × 冲动（v3 定死）**

| 时点 | 处理 |
|---|---|
| 睡着 | `impulseAt` **不推进也不清零**；free 被 `asleep` 门禁跳过；`gatedSkips++` |
| 醒来 | `impulseAt = now + Exp(λ0)`（**重抽，不补偿**）；`gatedSkips = 0` |
| 为什么 | 不补偿：Poisson 无记忆，"欠下的冲动"会在睁眼瞬间集中爆发；不保留：确定性项（意图/成熟/社交）本来就会在醒来后立刻生效，随机项不需要来补 |

**门禁表（不掷骰，直接跳过并记原因）**

| 门禁 | 原因码 |
|---|---|
| 睡着 | `asleep` |
| 暂停 / 中止 | `paused` |
| 体力 < floor | `tired` |
| 当日决策次数用尽 | `decision-cap` |
| 距上次 free 唤醒 < 最小间隔 | `too-soon` |
| **有可应答未读且 chat 管线可运行** | **`chat-pending`** |
| **目标会话正在运行** | **`chat-running`** |
| 刚聊过（会话活跃窗口内） | `recent-activity` |
| 成本预算超限 | `cost-cap` |

`chat-pending` 是 v3 补回的：改唤醒模型时曾把它丢掉，结果是 free 可能在应答管线正要跑时抢会话。

**可测性**：`random` / `now` 是显式依赖。可构造"impulse 在 10 小时后、意图 2 小时后到期"→ 断言 2 小时后醒。

### 7.4 失败与停止

| 情形 | 处理 |
|---|---|
| 读失败 | 错误回灌，允许换查询；不扣行动数、不扣体力 |
| 行动执行失败 | 记 `ok:false`、`energySpent:0`、`failed++`；`nextRipeAt` 指数退避 |
| 行动成功、回声未到 | 记 attempt + 开 observation，**此时不下结论** |
| 回声窗口到期未命中 | observation → `missed`，就地轻微降频 |
| 被权限/体力/冷却拒绝 | 记 `denied`，**不**进统计 |
| 子运行 `busy` | 记 `ok:false, code:'busy'`，不重试 |
| 模型输出不可解析 | chat 走现有兜底；free 记 `idle(unparsable)` |
| 预算耗尽 | `stop: budget`，正常结束，不报警 |

---

## 8. 观测：Moment

每次模型调用一条，`data/mind/moments/<YYYY-MM>.jsonl`。

```jsonc
{
  "id": "m_...", "parentMomentId": null, "depth": 0,
  "runtime": "free",
  "startedAt": 0, "endedAt": 0,
  "trigger": { "kind": "impulse|ripe|intention|social|chat-batch|cron|manual", "ref": "..." },
  "materials": { "digest": "sha256:...", "segments": [{ "id": "scene", "tokens": 120 }] },
  "prompt": { "profile": "free", "layers": [{ "id": "S0", "tokens": 210 }], "systemDigest": "..." },
  "model": { "provider": "...", "model": "...", "temperature": 0.2 },
  "usage": { "self": { "prompt": 0, "completion": 0, "cacheRead": 0, "cost": 0 },
             "subtree": { "cost": 0 } },
  "steps": [{ "toolId": "send_proactive", "ok": true, "code": "ok", "ms": 812,
              "energy": 25, "childMomentId": "m_..." }],
  "wrote": ["event:e_...", "relation:123"],
  "intentions": ["i_..."],
  "stop": "sent|idle|budget|finish|error|aborted",
  "outcome": { "sent": 1, "external": true }
}
```

**成本只算一次**：每个 Moment 只记 `usage.self`；报表按 `runtime` 汇总 `self`；
`usage.subtree` 只用于"这次唤醒一共花了多少"的展示，**不进报表**。
嵌套关系靠 `parentMomentId` + `steps[].childMomentId` 还原。

**分层保留**

| 类别 | 判定 | 存什么 | 保留 |
|---|---|---|---|
| 写入门槛：`wrote` 非空 | 每天几次 | 全量（含渲染后的素材与提示词文本） | 90 天 |
| 其余 | 每天几十次 | 摘要：digest + 分段 token + 工具序列 + 用量 | 30 天 |

- 非写入门槛默认 1/10 存全文，其余只存摘要。
- **不做内容寻址去重**（素材每次都带时间戳与 `lastLine`，命中率极低），按 moment 存一份、gzip。
- **隐私**：消息正文只出现在写入门槛的全量记录里，90 天后随文件滚动删除。

---

## 9. 持久化、迁移与升级

### 9.1 布局

```
data/mind/
  .schema.json                 { storeVersion: 3 }
  self.json                    + version / changelog / selfNotes[]
  relations/<qq>.json          + version / changelog
  intentions.jsonl             新增
  events/<chat>/<YYYY-MM>.jsonl + momentId / attemptId
  reflections.jsonl            + scope / materialsDigest / patches[]
  diary/<YYYY-MM>.jsonl        新增
  tick.json                    + impulseAt / lastFreeWakeAt / proactiveAt{} / actionStats{}
  attempts.jsonl               新增
  observations.jsonl           新增（有界，过期即关）
  moments/<YYYY-MM>.jsonl      新增
data/usage/<YYYY-MM-DD>.json   + 按 runtime 分桶
```

`nextWakeAt` **不落盘**；落盘的是 `impulseAt`。

### 9.2 迁移（一次性、可回滚、可重跑）

**不变量**

1. **只加不删**：旧字段保留一版，读完即打 `migrated: true`。
2. **幂等**：`.schema.json` 已达 `storeVersion` 就跳过。
3. **不在原地改**：迁移写进 `mind.tmp/`，校验通过后原子换名。
4. **不碰内容**：只补字段，不改事件文本、不改关系数值。
5. **备份在 data 根**，不在 `mind/` 里（否则会被一起换名）。

**算法**

```
1. 定位源：--from <dir> 或默认 DATA_DIR/mind
2. 体检：读 .schema.json（缺失 → 视为 0）；统计 events/relations/actions 条数；检查可写
3. 备份：<data>/.backup-<ts>/  （整目录拷贝）
4. 迁移：写 <data>/mind.tmp/
     - 补 version:0 / changelog:[] / selfNotes:[]
     - openLoops → Intention（id = 文本哈希，since → ts，dueAt = since+24h，createdBy:'reflection'）
     - actions.jsonl → 回填 actionStats（按 action 聚合 ok/failed/lastRunAt）
     - 补 momentId/attemptId 占位（null）
5. 校验：条数一致；随机抽 20 条 round-trip；self/relations 有 version
6. 换名：mind → mind.old-<ts>；mind.tmp → mind
7. 落盘：.schema.json（storeVersion:3）+ migration.json（来源/时间/备份路径/校验结果）
8. 失败：删 mind.tmp，保留原目录，界面提示 + 日志
```

**入口**

```
npm run mind:migrate -- --from "D:\old\data\mind" --dry-run
npm run mind:migrate -- --in-place
npm run mind:rollback -- --to "D:\QQ Agent\data\.backup-20261029"
```

- **首启检测**：`mind/` 存在但 `.schema.json` 缺失 → 视为 v0，自动迁移一次，日志 + 界面提示。
- **从旧版本导入**：设置 →「心智」→「从旧目录导入」，选**旧版本的 data 目录**（或直接选 `mind/`），
  走同一套 migrator（先 `--dry-run` 预览：多少事件、多少关系、多少条会转成意图）。
- **安装版升级**：沿用现有安装器的 `preserve-user-data`（`build/installer.nsh` 已有把 `data/` 备份到
  `%LOCALAPPDATA%\QQ Agent\upgrade-backup` 的机制），装完还原，首启再跑 migrator。

### 9.3 回滚

- `migration.json` 里记着备份路径；界面上给一个「回到迁移前」按钮（仅当备份还在）。
- 回滚 = 换名回去，删掉迁移产生的 `intentions/attempts/observations/moments`（它们都是新文件，旧版本不认识）。
- 回滚后 `storeVersion` 回到 0，下次启动会**再次**尝试迁移——所以回滚后要先修问题再重启。

### 9.4 启动对账：重启、崩溃、长时间停机

这个程序会被反复重启，也会有人关掉它几周。**停机期间"什么都不发生"不能被她理解成"没人理我"。**
每次启动，在调度任何东西之前先跑一遍对账：

| # | 做什么 | 为什么 |
|---|---|---|
| 1 | 迁移（若 `storeVersion` 落后） | 老数据先补齐形状 |
| 2 | **把停机期间过期的观测标 `void`（不是 `missed`）** | 否则"她没运行"会被记成"对方没回应"，凭空把她的节奏调慢 |
| 3 | 结算体力与跨天计数（按时间差补，不按次数） | 现有 `settleEnergy` 已是时间差口径，沿用 |
| 4 | **重算 `impulseAt`**：若已过期超过 `2 × λ0`（8 小时），重抽；否则保留 | 避免"停机三天，一开机连醒三次" |
| 5 | **补齐整合欠账**：未反思事件 > 3 × 阈值时，只跑一次的"补偿整合"，把积压压成一条"这段时间我不在"的叙事 | 防止停机两周后连跑二十次反思 |
| 6 | **修正节律统计**：`lastRunAt` 与现在的间隔若超过 24 小时，视为停机，**不计入** `meanIntervalMs` | 否则休个年假回来，她所有行动的间隔都被拉长 |
| 7 | 清理半截写入：`attempts` 有开始无结束的、`moments` 缺 `endedAt` 的，标 `interrupted` | 崩溃留下的残行不能当成正常数据 |
| 8 | 落一条 `boot` 记录（含停机时长） | 排查"她为什么这几天很安静"时有据可查 |

**语义约定**

- **停机不算"没回应"**（第 2 条），也**不算"她变懒"**（第 6 条）。
- **停机不补"冲动"次数**，只补一条"我离开了多久"的素材（第 5 条）；
  她醒来时看到的是"你有 12 天没在这里了"，而不是 12 天的账单。
- **时钟被改动**（系统时间跳变）时，用 `abs(now - lastRunAt) > 30 天` 做兜底，同样按停机处理。

---

## 10. 扩展生态

| 环节 | 最小契约 | 备注 |
|---|---|---|
| **获取** | 装一个扩展 = 一次有审计的行为：谁装的、何时、来自哪、版本 | 进 Moment 与界面 |
| **信任** | 按 `scopes` 申请；`write/send/external` 默认 `ask` | 与 `defaultEnabled` 分离 |
| **可见** | 新装默认不出现在工具表；启用后才出现 | 沿用 `defaultEnabled` |
| **可学** | 声明 `traits.footprint`（可缺省）→ 系统据此观测 | 不要求扩展自己测回应（§4.5.4） |
| **察觉** | 素材里出现"你最近学会了 X（还没用过）" | 这一句比任何 UI 都更能体现成长 |
| **兼容** | `schemaVersion` 缺省 1，经适配器归一 | §5.2 |
| **自检** | 预留 `npm run ext:check` / `ext:test` / `ext:pack` | 实现推后，接口先定 |
| **卸载** | `unregisterByOwner` + 定时器/订阅/面板按 owner 回收 | |

---

## 11. 界面

组织轴从"功能页"改为"**她的成长**"：

- **她**：自我叙事、心情、最近在意的事、版本历史（能看见"她变了"）。
- **记忆**：事件 / 反思 / 叙事三层切换；每条可追到 Moment。
- **关系**：每人一页，阶段与证据；改动有 changelog。
- **行动**：做过什么、结果如何、哪些事越做越少（`actionStats` 可视化，含 `dormant` 标记）。
- **能力**：按 owner 分组；每个工具显示 `modes` / `scopes` / 成本 / 冷却 / **是否 composite**。
- **自动化**：单独一栏，"到点执行，不是她的决定"。
- **花费**：按运行时（chat/free/integrate/automate）分桶。

---

## 12. 施工计划

**进度**（每轮更新；细节看提交记录）

| 轮次 | 内容 | 状态 |
|---|---|---|
| R1 | A1-1 领域端口 + 空实现 + 单测（74 项） | ✅ |
| R2 | A1-2 端口接线 + 睡眠/心跳/stay_up 的 body 与行动记录迁移（26 处） | ✅ |
| R3 | 切割：删除 per-chat 心跳模式，只保留全局唤醒（-186 行，含配置项与两套测试） | ✅ |
| R4 | A1-3 三个写工具改走 WriterPort（`by` 由管线注入，工具伪造不了） | ✅ |
| R5 | A1-4 控制台改走 AdminPort；`new MindStore` 收口到 app.js + 静态守门 | ✅ |
| R6 | A1-5 收尾：`createApp({ mind: null })` 测试缝 + 端到端守门（没有心智时对话照跑、工具消失、接口不 500） | ✅ |
| —— | **A 期收尾**：chat 侧仍有两处直连（`#buildMindContext` 的采集、`#maybeReflect` 的阈值），它们跟着 `materials.js` / 整合阶梯在 B、C 期一起搬 | 已知 |
| R7 | B1 关系版本化：`version` + `changelog`（来源、理由、依据），只补证据不升版本 | ✅ |
| R8 | B2 整合阶梯：L2a/L2b 两级、Self 写入收窄到全局整合、强事件接入 | 未开始 |

每期必须：可独立合并、可独立回滚、验收里不出现"行为变了"（除显式列出的失败路径变更）。

### A 期 · 骨架（成功路径不变，失败路径语义变更）

| 步 | 内容 | 回滚开关 |
|---|---|---|
| A1 | `MindPort` + 空实现；**只迁 chat 侧 + routes 侧** | `runtime.mindPort = off` |
| A2 | 工具 schema v3（只加字段）+ `schemaVersion` 缺省 1 + 唯一可用性口径 | `tools.schemaV3 = off` |
| A3 | 八步管线，先只对 `kind: write/send` 强制；慢工具声明 `timeoutMs` | `pipeline.enforce = false` |
| A4 | Moment（含 `usage.self`/`subtree`）+ Usage 按 runtime 分桶 | `runtime.moment = off` |
| A5 | 配置 schema 分层注册（`config.js` 八个产品段迁出） | `config.layered = off` |

**验收**

- 成功路径不变；**失败路径语义变更**（新增超时、权限拒绝码、`{content,isError}` → `{ok,code}`）
  必须写进预期清单；`web_fetch` / `read_video` 声明超时后仍成功。
- 管线单测覆盖八个错误码。
- 跑一天后 `moments/` 有数据、`usage` 分桶正确。
- **守门（A 期收尾，不驱动排期）**：移走 `src/mind/` → 应用启动、chat 正常、心智工具消失。
  只覆盖 chat 那一半。

### B 期 · 生长

| 步 | 内容 |
|---|---|
| B1 | 六对象 schema + `writer.js` 写入规程；`relation` 补 version/changelog |
| B2 | 整合阶梯 + `integrate` 运行时；**Self 写入收窄**；旧 `applyReflection` 的 self 补丁改 `selfNotes`；L4 加**强事件** |
| B3 | `Intention`（四态）+ `intend` 控制工具 + `openLoops` 迁移 |
| B4 | `attempts.jsonl` + `recordAttempt` + `actionStats`（**只统计，不驱动调度**） |
| B5 | `observations.jsonl` + 回声判定 + 关闭时就地更新 + 过期扫描 |

**验收**

- 预期变更：① per-chat 反思不再写 `self`；② 新增 `intentions/attempts/observations`；
  ③ `relation` 多两个字段。
- 每条领域记录能追到 `momentId`。
- 手动触发一次 L4：`self.version++` 且有 `changelog`。
- **调频护栏**：第 4 次尝试时 `meanInterval` 不变；第 5 次起才动；不跌破 `0.6×` 不超 `3×`；触顶 `dormant`。
- **回声**：注入"发消息 + 3h 后对方回"→ `open → hit`，且只轻微调频。
- **连发**：一次行动发两条消息 → 只开一条 observation，不被自己 void。

### C 期 · 自由

| 步 | 内容 |
|---|---|
| C1 | 唤醒：`impulseAt` 持久化 + `nextWakeAt` 现算 + `socialDueAt` + 门禁（含 `chat-pending`） |
| C2 | 只读工具进 free；free 侧改用 `MindPort`；`#runGlobalTick` → `runFreeAgent` |
| C3 | 嵌套运行（§4.7）：`send_proactive` / `organize` 改 `composite` |
| C4 | 菜单 = eligible ∪ 意图视图；删除 `guards` 里"有没有候选" |
| C5 | `actionStats` 驱动 `nextRipeAt` |

**验收**

- **确定性唤醒**：impulse 10h、意图 2h → 断言 2h 后醒；新增意图不需要重采样。
- **睡眠**：睡 8 小时后 `impulseAt` 重抽，不出现"一睁眼就醒"的突发。
- **让位**：有可应答未读时 free 跳过（`chat-pending`）。
- **嵌套**：`send_proactive` 产生一个 depth=1 的 chat Moment；父 Moment 的 `usage.self` **不含**子运行；
  depth=1 的 chat 里看不到任何 composite 工具；同一链上重复调用被拒（`recursive`）。
- **守门（完整）**：移走 `src/mind/` → 应用启动、chat 正常、free/integrate 不启动、心智工具消失。

### D 期 · 扩展

| 步 | 内容 |
|---|---|
| D1 | 能力获取流程（安装审计 / scopes / 默认不可见 / 察觉素材） |
| D2 | `automate` 运行时 + `automator.js`（owner 回收，不受 sleep 门禁） |
| D3 | 组合层最小版：单层 replace（预留 `(previous, ctx)`） |
| D4 | 权限收据 / 撤销 / 在途复核 |
| D5 | 界面按 §11 重组 |

**验收**

- 装一个带定时器的扩展再卸载 → `scheduler.count()` 归零。
- **自动化不被 sleep 拦**：设一个凌晨的任务，睡着时仍然执行。
- 扩展零负担：只 `registerTool`、不声明 footprint，也能被正确统计。
- 组合替换一个组件后行为改变，禁用后恢复出厂。

### 预期会变的测试

| 测试 | 现在断言 | 之后 |
|---|---|---|
| `tools-skill-audit` | 工具字段清单 | A2 增加 traits 断言（纯加法） |
| 工具单测（错误路径） | 错误文本 / `isError` | A3 断言 `{ok:false, code}`（失败路径变更） |
| `mind-reflect-test` | 反思结果含 `self` 补丁 | B2 断言 `selfNotes`，`self` 不变 |
| `mind-global-tick-test` | "没有候选时不调模型" | C1 改为"没有候选仍可能醒；有未读时让位" |
| `mind-actions-v2-test` | 行动表来自 `actions.js` | C2 断言来自 `traits.act` 投影 |

现状基线（实测）：`mind-tick` 72 / `mind-actions-v2` 28 / `mind-global-tick` 34 / `wake-semantics` 10，全绿。

---

## 13. 风险与默认取值

| 风险 | 缓解 |
|---|---|
| A1 端口化触及面广（45 处） | 只迁 chat + routes（约 20 处）；free 侧随 C 重写 |
| B4 统计把行为调死 | 样本门槛 5、下限 0.6×、上限 3×、无回声不归因、`publish` 不学 |
| B5 回声延迟 | 待观测表 + `void` 规则 + 关闭时就地更新 |
| C3 嵌套失控 | 深度 1 结构过滤 + ancestry + 预算并入父唤醒 |
| C 期成本上升 | `impulseAt` 预抽样 + `maxDecisionsPerDay` + 当日成本上限 + A4 观测先行 |
| A5 配置拆分 | 只做机制、不改字段名；逐段迁，每段可回滚 |
| 迁移丢数据 | 备份在 data 根 + tmp 目录 + 原子换名 + 只加不删 + 回滚按钮 |

**默认取值（施工时不需要再问）**

| 项 | 默认 | 可调？ |
|---|---|---|
| `λ0`（冲动平均间隔） | 4 小时 | ✅ 档位 |
| 回声窗口（私聊 contact） | 72 小时 | ✅ 档位 |
| 回声窗口（check 类） | 24 小时 | ⛔ 结构 |
| 样本门槛 | 5 次 | ✅ 高级 |
| 探索下限 / 衰减上限 | `0.6 ×` / `3 ×` initial | ✅ 高级 |
| 强事件 `salience` 阈值 | 0.8（冲突与里程碑无条件触发） | ⛔ 结构 |
| 整合阈值（会话反思 / 全局反思） | 8 条 / 12 条 | ✅ 档位 |
| 整合周期（叙事 / 自我） | 7 天 / 30 天 | ✅ 档位 |
| L4 同日上限 | 1 次 | ⛔ 结构 |
| 工具超时 | 30s（`limits.timeoutMs` 可覆盖） | ✅ 高级 |
| 嵌套深度 | 1 | ⛔ 结构 |
| Moment 保留 | 写入门槛 90 天 / 其余 30 天 / 采样 1/10 | ✅ 高级 |
| `schemaVersion` 缺省 | 1 | ⛔ 结构 |

#### 13.1 哪些该开放、哪些不该

把"可配置"当成越多越好，是这类系统最常见的坏方向。分三档：

| 档 | 例子 | 为什么 |
|---|---|---|
| **结构常量（不开放）** | 嵌套深度、`self` 的写入白名单、观察作废规则、`by` 枚举 | 开放它们只会让系统坏掉，用户也不会因此更开心 |
| **可调参数（开放，带预设）** | 整合阈值与周期、冲动间隔、回声窗口、学习门槛、保留期 | 这些直接对应"她多久整理一次记忆""她多主动"，是产品口味 |
| **自适应量（不手调）** | 每类行动的 `meanIntervalMs`、`nextRipeAt` | 由结果统计决定；手调会与学习打架 |

**开放方式不要做成散落开关**，做成三个预设 ＋ 一个高级区：

| 预设 | 冲动 | 会话反思 | 叙事 | 自我 | 适合 |
|---|---|---|---|---|---|
| 安静 | 8 小时 | 12 条 | 14 天 | 60 天 | 只想要个聊天机器人 |
| **标准** | 4 小时 | 8 条 | 7 天 | 30 天 | 默认 |
| 活跃 | 2 小时 | 5 条 | 3 天 | 14 天 | 想看她的生活感 |

高级区里逐项改数值，但每项旁边写"人话 + 预估"：
「每 8 条未整理的事就整理一次（约等于每天 1–2 次）」。

**"强制执行"与"交由自愿"的边界**

| 层面 | 谁决定 | 说明 |
|---|---|---|
| **会不会发生** | 系统强制 | 事件一定有（兜底事件）；整合到点一定跑；不乱序、不饿死 |
| **做什么、说什么** | 她自愿 | 自由时刻可以一直选"什么都不做"；整合产出什么由她写 |
| **能不能做** | 用户授权 | 工具的场合分配、外部副作用、体力与冷却 |

一句话：**系统保证"她有事可想"，她自己决定"想不想做"。**

**另有一条硬规则**：任何阈值改动都要**写进 Moment 的 `configDigest`**，
否则"她这几天行为变了"永远分不清是她的变化还是配置的变化。

**仍开放（不阻塞开工）**

1. `actions.jsonl` 的冻结时点：B4 一上线就冻，还是先双写一周观察。（倾向：直接冻，双写会制造两份真相）
2. `by` 枚举是否永远封闭。（倾向：封闭，新增来源改代码加一行）
3. 自动化是否向扩展作者开放 cron。（D 期先只允许内置）
4. 兜底事件的正文模板：用"触发消息 + 她的回复"还是用"会话摘要"。前者零成本，后者要一次额外调用。

---

## 14. 变更记录

| 版本 | 变化 |
|---|---|
| v1 | 能力注册表 + 四运行时；有诊断、缺执行侧与领域层 |
| v2 | 中心改为心智；五层；六对象；四回路；管线；runtime 数据化 |
| v2.1 | 唤醒拆两套时钟；节律按动作类型分三套信号；A 期收窄；权限分期；Moment 分层；强事件；意图四态；`by` 注入；CAS；唯一读路径 |
| **v3** | **嵌套运行时**；**自动化独立调度**；**睡眠×冲动语义**；**`chat-pending` 门禁**；**回声四坑**；**`schemaVersion` 缺省 1**；**eligibility/veto 分离**；迁移与升级指南；延时查看用意图 |
| **v3.1** | **兜底事件**（解决"模型不自觉记 → 反思永不触发"的死锁）；**强事件改机械判定**；**内置工具场合分配表 + 扩展分配入口**；**启动对账**（重启/崩溃/长时间停机）；**参数分档**（结构常量 / 可调 / 自适应）与三档预设 |

---

## 附录 A · 代码映射

| 现有 | 目标 | 期次 |
|---|---|---|
| `#runAgent` | `src/runtime/run-agent.js` + `chat.js` | A |
| `#runGlobalTick` 循环 | `run-agent.js` + `free.js` | C |
| `#freeActionTools` | `runtime/project-tools.js` | C |
| `buildGlobalDecisionPrompt` 素材部分 | `runtime/materials.js` | C |
| `mind/tick.js` 的 `buildDecision*` | `runtime/prompt.js` + `project-menu.js` | C |
| `mind/tick.js` 的 `collectCandidates` | `runtime/wake.js` 的 `socialDueAt()` | C |
| `mind/actions.js` 的 6 条 | 6 个工具的 `traits.act`（2 个是 `composite`） | C |
| `mind/extensions.js` | 由 `traits.act` 直接投影，文件删除 | C |
| `mind/reflect.js` | `mind/integration.js`（拆 chat/global 两级） | B |
| `tool-registry.js` | `contract/tool-registry.js`（保留 re-export） | A2 |
| `skills/capabilities.js` | `contract/capability-bus.js` | A2 |
| 新增 | `contract/{pipeline,permissions,mind-port,nested}.js` | A |
| 新增 | `mind/{writer,intention,habits,observations,migrate}.js` | B |
| 新增 | `runtime/{profiles,wake,automator}.js` | C/D |

## 附录 B · 被否决的方案与理由

施工时如果又想改回去，先看这里。

| 方案 | 否决理由 |
|---|---|
| 菜单只由意图生成 | 把"自由"换成"待办列表"；意图只是菜单的**增项**，不是替代 |
| 用"概念表里没有心智词汇"论证架构 | 词表是启发式，不是证明；命名一天能改，回路改不动 |
| 把"删掉 mind 仍能启动"当成排期驱动 | 会诱导"为解耦而解耦"；它是守门测试 |
| `λ = λ0 + Σλ_ripe + Σλ_intent` + 预抽样 | 把确定性到期塞进指数分布只会推迟；预抽样后不重采样 |
| 候选完全不参与唤醒 | "想她了/有件事没问"是社会性到期，不是菜单过滤 |
| 统一用"有没有回应"驱动所有动作 | 三类动作拿不到同一种信号；`publish` 拿不到反馈，假装学更糟 |
| 让扩展自己上报回应 | 越权、且它没这个视野；改为声明 footprint、系统观测 |
| 提交 `proposed → accepted` 状态 | 空门槛：多一轮调用，或退化成待办清单 |
| 组件 `wrap` 组合层 | 本期量级不匹配；只预留签名 |
| 权限收据 / 指纹在 A 期做 | 单机本地扩展的前提下，复杂度大于风险 |
| 工具改名 `parameters → params` | 30 多个工具与所有技能都要改，收益为零 |
| Moment 全量存正文 + 内容寻址 | GB 级存储 + 隐私成本；素材每次不同，命中率极低 |
| `traits.quiet` 夜间例外 | 与"睡着整体跳过 free"矛盾；夜间行为应交 automation |
