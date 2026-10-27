# 行动运行时重构设计（v1 提案）

> 状态：**设计稿，未实施**。目的：在继续加扩展行为之前，把"什么时候调模型、给它什么信息、
> 它能调用什么、循环怎么收尾"这四件事一次定清楚，避免工具、动作、素材、时机继续互相缠绕。
>
> 范围：后端运行时（对话 / 自由行动 / 反思 / 自动化）+ 能力的注册与暴露规则。
> 界面只写对齐原则，不排期。

---

## 0. 一句话

把现在"工具列表 / 动作菜单 / 候选 / 提示词素材"四张互相影响的清单，
改成 **一个能力注册表 + 四种运行时 + 一套预算与循环控制**：

- 能力（capability）只描述"能做什么、从哪来、有什么副作用"
- 运行时（runtime）决定"这一次给它看哪些能力、哪些素材、多少预算"
- 触发（trigger）只决定"这一次要不要调模型"，**不决定菜单里有什么**

---

## 1. 现状盘点：乱在哪

### 1.1 四类东西混在一个平面上

| 维度 | 现在的表达方式 | 问题 |
|---|---|---|
| 来源 | `skillId` 只是 UI 标签 | 不参与暴露/权限，插件工具和内置工具同权 |
| 时机 | 对话工具表 / 自由行动工具表 各维护一份 | 同一能力要写两遍，读工具在自由时间直接消失 |
| 性质 | "工具"和"动作"是两套对象 | `send_message` 与 `send_proactive`、`remember_event` 与 `remember` 重复表达 |
| 效果 | 散落在各工具实现里 | 读/写/发消息/跨会话没有统一的风险与预算口径 |

### 1.2 具体问题清单（都能在代码里指到）

1. **唤醒与菜单耦合**：`collectCandidates` 有候选才醒；醒来后菜单又由候选过滤。
   结果是"和聊天无关的行为"没有触发时机，"有候选"又偷偷决定了能做什么。
2. **自由行动够不到只读工具**：`get_recent_messages` / `get_chats` / `get_message_detail`
   只出现在对话工具表；写动态时只能靠 roster 的一行 `lastLine`。
3. **同一件事两种表达**：`send_message`（对话）与 `send_proactive`（动作）是两条代码路径；
   `remember_event`（工具）与 `remember`（动作）也是。
4. **来源没有进入规则**：`getToolAvailability` 只看启用/依赖/技能失活，
   不区分"内置 / 技能 / 插件"，也不区分"读 / 写 / 发消息"。
5. **提示词只有 system 有分层**（安全/章程/自我/技能/情境），
   **user 的素材没有预算**：roster、候选、回忆、上次行动谁多谁少靠拼接顺序。
6. **两套循环各自演化**：对话的 `#runAgent`（maxRounds、finish、只写正文纠正）
   与自由行动的 `#runGlobalTick`（maxPerWake、体力、finish）是两份实现。
7. **"定时"没有位置**：想"每天发条动态"只能把日程塞进"行动"，于是行动变成隐形日程。
8. **持久化缺口**：`lastProactiveAt` 只在内存；重启后可能刚说完又去说；
   动作的 `lastRunAt` 也不存在，没法谈"多久没做"。
9. **界面按页面分**：技能页、工具页、节律页各管一段生命周期；
   用户要在三处拼出一个扩展的完整状态。

---

## 2. 设计原则

1. **正交元数据，投影出视图**：能力只声明属性；工具表、菜单、设置页都是投影。
2. **运行时决定暴露，不决定选择**：对话/自由时间决定"能看见什么"，
   不决定"该选什么"。
3. **触发只决定是否醒来**：候选、成熟度、随机都只影响唤醒概率，不改菜单。
4. **读写分离**：读能力有调用预算与输出截断；写能力才有体力/冷却/次数。
5. **一切有预算**：token、工具调用数、行动数、体力、墙钟时间。
6. **自愿 vs 自动化分离**：她可以选择不做的，叫行动；到点必须做的，叫自动化，不进菜单。
7. **稳定前缀可缓存**：system 与运行时说明稳定；素材与任务在后。
8. **一个执行器，多种策略**：对话和自由时间共用同一套循环，只是策略参数不同。

---

## 3. 核心概念

| 概念 | 定义 | 谁拥有 | 例子 |
|---|---|---|---|
| **Capability（能力）** | 一次可调用的操作，带来源/性质/副作用 | 注册表 | `send_message`、`qzone_post`、`get_recent_messages` |
| **Tool（工具）** | 在某次运行里暴露给模型的能力（函数定义） | 运行时投影 | 对话里的 `send_message` |
| **Action（行动）** | 被标记为"自愿"的能力，出现在自由时间菜单，消耗体力 | 运行时投影 | `send_proactive`、`remember` |
| **Material（素材）** | 运行时自动打包的只读上下文 | 素材构建器 | roster、近期事件、日记摘要 |
| **Moment（时机）** | 一次模型调用及其完整输入输出 | 运行时 | 对话一轮、一次自由唤醒、一次反思 |
| **Runtime（运行时）** | 决定暴露哪些能力、给什么素材、怎么循环 | 代码 | `chat` / `free` / `reflect` / `automation` |

一条能力的"身份"由 `id` 唯一确定；**工具、动作、菜单项都只是它在某个运行时的投影**，
不再是三份独立数据。

---

## 4. 能力注册表

### 4.1 定义

```js
{
  id: 'qzone_post',                 // OpenAI function name 规范
  name: '发动态',
  description: '发一条 QQ 空间动态',
  inputSchema: { ... },             // JSON Schema

  source: { kind: 'skill', id: 'qzone' },   // builtin | skill | plugin | mcp
  runtime: ['chat', 'free'],        // 允许出现的运行时（缺省 ['chat']）
  kind: 'write',                    // read | write | send | control
  scope: 'global',                  // chat（需要 chatKey）| global
  effects: {
    energy: 15,                     // 仅行动使用
    cooldownMs: 6 * 3600000,
    maxPerDay: 2,
    external: true                  // 有外部副作用（发消息/发动态/改资料）
  },
  requires: {
    candidate: false,               // 是否必须有聊天候选
    capability: []                  // 可选：依赖的其它能力
  },
  voluntary: true,                  // 是否可进自由时间菜单
  mind: {
    label: '发条动态',               // 菜单里怎么念
    ripeness: { afterMs: 2 * 86400000, jitter: 0.3 },  // 只影响"想起来"的概率
    needs: ['diary', 'events']      // 素材需求（核心据此打包）
  },
  policy: {
    crossChat: false,               // 是否允许跨会话（send_to）
    requiresOwner: false            // 是否必须主人显式开启
  },
  execute: async (ctx, args) => ({ ok, summary, data })
}
```

### 4.2 规则

- `id` 全局唯一；重复注册直接报错（不再允许"两个工具同名"）。
- `runtime` 是**第一等字段**，不再由代码里的两个列表决定。
- `kind` 决定风险口径：`read` 不耗体力、有输出预算；`write/send` 必须有冷却与次数。
- `voluntary: true` 才进菜单；`runtime` 不含 `free` 的能力，即使 voluntary 也不出现。
- `source` 参与权限：插件工具默认 `runtime: ['chat']`、`voluntary: false`，
  作者显式声明才升级。
- `mind.ripeness` 只提高唤醒速率，**不保证被执行**。

### 4.3 与现有字段的兼容

| 现在 | 新位置 |
|---|---|
| `skillId` | `source: { kind: 'skill', id }` |
| `mindAction: { label, energy, defaultEnabled }` | `voluntary` + `mind.label` + `effects.energy` |
| `requiresVision` / `requiresSearch` | `requires.capability: ['vision', 'search']` |
| `category` | `ui.group`（只影响展示，不参与运行时） |
| `defaultEnabled` | 保持不变（工具启用是另一条轴） |

---

## 5. 运行时矩阵

| 运行时 | 何时发生 | 调模型 | 能力暴露 | 循环控制 | 产物 |
|---|---|---|---|---|---|
| **chat** | 收到消息且通过门禁 | 是 | 所有 `runtime` 含 chat 且可用的能力（发送/查询/心智/扩展） | ≤8 轮；必须 send 或 finish；只写正文纠正一次 | 消息、记忆更新 |
| **free** | 调度器判定"抬头看一眼" | 是 | `voluntary` 行动 + `kind:read` 且含 free 的只读能力 | ≤3 个行动 + ≤3 次读取；预算/体力/次数 | 行动日志、可选记忆写入 |
| **reflect** | 攒够未反思事件 / 主动整理 | 是 | 无（纯生成）或极小的读取白名单 | 单次调用 | 事件、关系、自我；可选日记 |
| **automation** | cron / 间隔 | 否（或固定小模型） | 只暴露该任务需要的那一个能力 | 直接执行一次 | 外部副作用、运行日志 |
| **compact** | 背景阈值 | 是 | 无 | 单次调用 | 摘要事件（未来） |

> 关键：**chat 与 free 的能力集合由 `runtime` 字段投影得到，不再维护两份名单。**

### 5.1 运行时与触发的关系

```
触发（candidate / ripeness / impulse / manual）
        │  只回答"要不要醒来"
        ▼
    free 运行时
        │  能力投影 + 素材打包
        ▼
   菜单（全部有资格的动作）
```

候选不是"菜单过滤器"，它只做两件事：

1. 提高唤醒速率
2. 作为素材（"王哥在等你"）出现在上下文里

---

## 6. 信息分层与素材包

### 6.1 四层信息

| 层 | 内容 | 存储 | 写入者 | 读取接口 | 进入提示词 |
|---|---|---|---|---|---|
| **L0 自我** | 名字、来历、价值观、说话方式、当前状态 | `self.json` | 她自己（反思/工具） | `mind.self` | 每轮（摘要） |
| **L1 关系** | 对每个人的看法、阶段、未完结 | `relations.json` | 她自己 | `mind.relations` | 相关会话（摘要） |
| **L2 叙事** | 事件、反思、日记 | `events/`、`reflections.jsonl`、`diary/` | 她自己 + 自动反思 | `mind.query` / `diary.list` | 素材包（有预算） |
| **L3 现场** | roster、未读、最近对话 | `chat store` + `mind meta` | 引擎（机械） | `store.*` | 每次 free（有预算） |
| **L4 原文** | 消息、转发、图片描述 | `chat store` | 引擎 | `get_*` 能力 | 只在显式读取时 |

原则：

- L0/L1 是"她认为的"，L2 是"她记得的"，L3 是"现场"，L4 是"证据"。
- **L3 永远免费自动出现**；L4 永远按需、且有预算。
- 日记放在 L2，是"叙事层"，不是 L4 的替代。

### 6.2 素材包（free 运行时）

```
MaterialPack {
  roster:      top 3（昵称/多久没联系/未读/最后一句/最近事件时间）
  candidates:  当前候选（带 chatKey）
  ripe:        成熟动作的中性事实（"距上次发动态 3 天"）
  recent:      最近 3 天事件（≤5 条）+ 最近 2 篇日记标题
  lastAction:  上次行动一句话
}
```

- 每段有 `maxTokens`，按优先级裁剪：candidates > roster > recent > ripe > lastAction。
- 素材包**构建一次、快照进行动日志**，便于回放"她当时看到了什么"。
- 扩展的 `needs` 决定额外打包哪些段（例如 `needs: ['diary']`）。

### 6.3 对话运行时的素材

对话不是"没有素材"，而是素材来自另一套：

```
chat context = 触发消息批 + 已读历史（按档位）+ 心智注入（self/relations/recall）
```

这部分维持现状，但同样纳入"分层 + 预算"的框架，不再单独一套拼接逻辑。

---

## 7. 提示词装配

### 7.1 层序

| 层 | 内容 | 稳定性 | 预算（建议） |
|---|---|---|---|
| S0 | 安全 + 章程 + 身份摘要 | 永久稳定 | ≤300 tok |
| S1 | 运行时说明（chat / free 各一份） | 每运行时稳定 | ≤120 tok |
| S2 | 能力目录（工具定义） | 半稳定 | 见 §12 |
| U1 | 现场（时间、体力、睡眠、预算） | 每次变 | ≤80 tok |
| U2 | 素材包 | 每次变 | ≤600 tok |
| U3 | 任务（消息批 / 菜单） | 每次变 | ≤200 tok |
| U4 | 循环中的工具结果 | 每步变 | 每步 ≤400 tok，累计有上限 |

### 7.2 缓存策略

- S0+S1 放最前，按运行时各一份前缀（chat / free 不共享，但各自稳定）。
- S2 只要工具集合不变就稳定；**扩展启停会打断缓存**，这是可接受的。
- 所有变量后置，避免把时间戳之类的东西塞进 system。

### 7.3 预算执行

- 装配时按层预算裁剪，而不是"先拼再截断"。
- 素材包超预算：先丢 `ripe`，再丢 `lastAction`，再压缩 `recent`，最后只留 top1 roster。
- 工具结果超预算：截断 + 标记"（已截断，可再查）"。

---

## 8. 循环控制（统一执行器）

### 8.1 伪代码

```
runLoop({ runtime, capabilities, material, budget, policy }):
  messages = assemble(runtime, material, capabilities)
  steps = 0; actions = 0; reads = 0; tokens = 0
  while steps < policy.maxSteps:
    res = callModel(messages, tools=project(capabilities))
    tokens += res.usage
    if tokens > budget.tokens: break
    if no tool_calls:
       if runtime == 'chat' and looksLikeUnsentReply: nudge once; continue
       break
    for call in res.tool_calls:
       if call is finish: return
       cap = lookup(call)
       if !allowed(cap, runtime, state): toolResult(error); continue
       if cap.kind == 'read':
          if reads >= policy.maxReads: toolResult(budget exhausted); continue
          reads += 1
       else:
          if actions >= policy.maxActions: toolResult(limit); continue
          if energy < cap.effects.energy: toolResult(no energy); continue
          actions += 1
       result = execute(cap); applyEffects(result)
       messages.append(toolResult(result))
    steps += 1
  return
```

### 8.2 策略参数

| 参数 | chat | free |
|---|---|---|
| `maxSteps` | 8 | 5（3 行动 + 2 收尾） |
| `maxActions` | —（发送不受行动预算限制） | `mind.actions.maxPerWake`（默认 3） |
| `maxReads` | —（受 token 预算） | 3 |
| `maxTokens` | 模型上下文上限的 60% | 同左 |
| 结束条件 | 发送 + finish / 无工具 | finish / 无工具 / 预算耗尽 |
| 只写正文 | 纠正一次 | 视为结束 |

### 8.3 失败策略

- 读失败：把错误回灌，允许换一个查询；不扣行动次数。
- 行动失败：记录 `energySpent: 0`，计入"本次已尝试"；同一行动连续失败 →
  提高 `nextRipeAt`（指数退避），避免每 tick 重试。
- 模型输出无法解析：chat 走现有兜底；free 记 `idle(unparsable)`。

### 8.4 日志

每次 Moment 落一条 `runtime-log`（或复用 actions.jsonl）：

```jsonc
{
  "runtime": "free",
  "trigger": { "impulse": true, "candidates": 2, "ripe": ["qzone_post"] },
  "materialId": "m_...",          // 素材包快照 id
  "actions": [{ "id": "qzone_post", "ok": true, "energy": 15, "ms": 800 }],
  "usage": { "prompt": 900, "completion": 120 },
  "stopReason": "finish"
}
```

---

## 9. 触发与调度

### 9.1 统一速率模型

```
λ = λ_impulse + λ_chat + λ_ripe
λ_impulse = 1 / 基础间隔（默认 6 小时平均一次，仅醒着）
λ_chat    = 有候选时加一个权重（按候选类型/紧急度）
λ_ripe    = Σ 成熟动作 × 弱权重

每 tick：p = 1 - exp(-λ × dt)，掷一次
```

- **没有 chance / routine 两种唤醒**；只有速率项。
- 同刻多个信号合并成一次唤醒。
- "天"不参与计算：基础间隔用**时长**，避免与作息系统冲突。

### 9.2 门禁

以下情况直接跳过 free 唤醒（不掷骰）：

- 睡着（除非某动作声明 `skipWhileAsleep: false`）
- 暂停 / 中止
- 体力 < floor
- 当日决策次数用尽
- 有未读且应答管线将运行（让位给 chat）
- 距上次 free 唤醒 < 最小间隔（防止连续 wake）

### 9.3 持久化

`tick.json` 增加：

```jsonc
{
  "lastFreeWakeAt": 0,
  "nextImpulseAt": 0,              // 可选：预抽样的下一次基础唤醒
  "actionRuns": { "qzone_post": { "lastRunAt": 0, "failures": 0 } },
  "proactiveAt": { "private:123": 0 }
}
```

`lastProactiveAt` 从内存迁到磁盘，重启不再丢。

### 9.4 与自动化分离

- 自动化任务（cron / 间隔）**不经过 λ，也不进菜单**。
- 它直接调用能力的 `execute`，日志记 `runtime: 'automation'`。
- 界面上单独一栏，措辞明确："到点执行，不是她的决定"。

---

## 10. 动作资格与菜单

### 10.1 资格

```
eligible(action, state) =
     action.voluntary
  && runtime.includes('free')
  && (!action.requires.candidate || hasCandidate)
  && cooldownSatisfied(action)
  && dailyCount < maxPerDay
  && energy >= effects.energy
  && (!action.mind.requiresOwner || ownerEnabled)
```

菜单 = 全部 eligible。**不按触发来源增删。**

### 10.2 素材里的"成熟"

成熟动作只以中性事实出现：

```
你有三天没发动态了。
```

不出现"该发了""是时候了"这类催促；也不排到菜单最前。

### 10.3 菜单示例

```
你可以做：
- 找人说句话（25）  —— 需要候选
- 记一笔（5）        —— 需要候选
- 发条动态（15）     —— 三天没发了
- 整理记忆（15）     —— 攒了 4 件事
- 什么都不做
```

---

## 11. 日记（中观层）

### 11.1 定位

- 事件 = 原子事实；反思 = 她对自己的看法；日记 = "最近发生了什么"的叙述。
- 日记是 L2 的一等成员，不替代事件，也不替代反思。
- **写入是自愿行动**（`diary_write` 或菜单里的"写日记"），不做每日定时。

### 11.2 存储

```
data/mind/diary/2026-10.jsonl
{ id, ts, title, body, tags[], eventIds[], chats[], deleted }
```

### 11.3 能力

| 能力 | kind | 说明 |
|---|---|---|
| `diary_list` | read | 标题 + 摘要 + 时间，按时间倒序 |
| `diary_read` | read | 读全文 |
| `diary_write` | write/action | 写一篇，消耗体力 |
| `diary_delete` | write（软删） | 打 `deleted` 标记 |

### 11.4 素材

- free 的素材包默认带"最近 2 篇日记标题"。
- 扩展 `needs: ['diary']` 时带最近 N 天日记摘要。

---

## 12. 工具膨胀的控制

问题：技能/插件越多，工具定义越长，prompt 越贵，模型越容易选错。

### 12.1 三层暴露

| 层 | 内容 | 何时进 prompt |
|---|---|---|
| **核心集** | 每个运行时必用的能力（发送、finish、几个查询） | 永远 |
| **已启用集** | 用户打开的技能/工具，且 `runtime` 匹配 | 运行时自动带 |
| **可发现集** | 已安装但未启用的能力目录 | 只在模型调用 `find_capability` 时返回定义 |

- 核心集控制在 ~10 个以内。
- 可发现集只给"名字 + 一句话"，不给完整 schema。
- `find_capability(query)` 返回匹配能力的 schema，模型下一轮才能调用。
- 这条不是现在必须做，但注册表要预留 `discoverable` 标记与目录查询接口。

### 12.2 去重规则

- 同一 `id` 只能注册一次；包装层（动作）引用能力，不复制实现。
- `send_proactive` 不再单独实现发送：它调用 `send_message` 的能力内核，
  额外负责"开一场对话"。
- `remember` 不再单独写事件：它调用 `remember_event` 的能力内核。

---

## 13. UI 对齐（后端定稿后）

原则：**按能力的生命周期分组，而不是按页面分。**

- 一个"能力"页：按来源（内置/技能/插件）× 运行时（对话/自由时间/自动化）分组。
- 能力详情里同时有：启用开关、允许的运行时、是否自愿行动、体力/冷却、素材需求。
- 自动化单独一栏，明确"不是她的决定"。
- 节律页只保留：唤醒速率、体力、睡眠、预算；不再散落动作成本。

---

## 14. 迁移计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0** | 盘点 + 冻结现有测试基线 | 53/53 不变 |
| **M1** | 注册表 schema + `runtime` 字段 + 兼容适配层 | 现有行为不变，测试全绿 |
| **M2** | 统一执行器（chat/free 共用）+ free 只读能力 | 自由行动能查消息；对话行为不变 |
| **M3** | 速率调度 + 持久化（lastRunAt/proactiveAt/lastFreeWakeAt） | 重启后节奏不乱；无候选也能醒 |
| **M4** | 素材包（含日记）+ 扩展 `needs` | 写动态有素材；日记可写可查 |
| **M5** | UI 收口到"能力"视图 | 三处设置合并为一处 |

每阶段都可单独回滚：M1 用适配层保留旧字段；M2 用开关切换新旧执行器；
M3 用 `mind.wake.mode` 回滚到纯候选唤醒。

---

## 15. 风险与开放问题

| 风险 | 说明 | 缓解 |
|---|---|---|
| 能力注册表改动面大 | 28 个内置工具 + 所有技能 | M1 只加字段与适配，不改实现 |
| 可发现集增加一轮调用 | 模型要先 `find_capability` | 只对扩展生效；核心集永可直接调用 |
| 素材包变长 | 预算失控 | 每段硬预算 + 优先级裁剪 |
| 日记变成流水账 | 与"自愿"冲突 | 写入是行动，不做定时 |
| 自动化越界 | 借"行动"之名做日程 | 独立 runtime，日志与 UI 明确标注 |
| 读原文的隐私边界 | 自由行动跨会话读取 | `scope` + `policy.crossChat` + 读预算 |

**开放问题（需要拍板）**

1. `λ_impulse` 的默认值：6 小时平均一次是否合适？
2. 自由行动是否允许读原文（`get_recent_messages`）？还是只到日记/事件层？
3. 日记写入：自愿行动，还是反思时顺带产出（省一次调用）？
4. 可发现集（`find_capability`）现在就做，还是等扩展数量上来再说？
5. 自动化的范围：只做"定时调用一个能力"，还是要支持"定时跑一段小流程"？

---

## 16. 附：与当前代码的映射

| 现在 | 目标 |
|---|---|
| `src/tools.js` 的 28 个工具 | 逐步迁移为能力定义（`runtime`、`kind`、`source`） |
| `src/tool-registry.js` | 成为能力注册表 + 投影函数 |
| `src/mind/actions.js` | 变成"能力的 voluntary 投影"，不再单独实现 |
| `src/mind/tick.js` 的候选 | 拆成"唤醒速率项" + "素材" |
| `#runAgent` / `#runGlobalTick` | 合并为 `runLoop` + 两套 policy |
| `#memoryChat` / `#runFreeTime` | 统一为 `callModel(moment)` |
| `prompt-layers.js` | 扩成 S0-S2 / U1-U4 的装配器 |
| `mind.actions.overrides` | 保留，作为能力的行动元数据覆盖 |
