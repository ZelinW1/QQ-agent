# M1 方案 v2：心智状态 + 自主节律

> v2 相对 v1 的四点变更（按你的决定）：
> 1. **关系作用域 `global`，M1 只做私聊**（群聊行为完全不变，等后续版本）
> 2. **允许她自己整理**：`reflect_now` 从"关"改为"开"，不可控靠**行为规定**约束
> 3. **新增：心跳与行动**（JRPG 式节律）——她不再只是"被叫到才存在"
> 4. **新增：上下文与缓存设计**（独立章节，含 token 预算与命中率验收）
>
> 仍未变：M1 不碰 harness、不碰 GUI、`enabled=false` 时行为逐字节不变。

---

## 0. 一句话

M1 给她**两样东西**：一个**能写的心智状态**（事件 / 关系 / 自我），和一套**自己的节律**（每隔一段时间醒来，决定做点什么）。

前者让她"记得、有看法、会变"；后者让这些变化**不依赖别人找她**——这是"个体"和"应答机"的分界。

---

## 1. 范围：私聊优先

| 项 | M1 | 之后 |
|---|---|---|
| 私聊 `private:<QQ>` | ✅ 全量（心智状态 + 节律） | — |
| 群聊 `group:<id>` | ❌ **行为与现在完全一致**（继续用 `memberImpression` + 概率主动） | M3 再评估（人多、噪声大、缓存命中差，不值得先做） |
| 关系键 | ✅ `global`（按 QQ，跨会话一份） | 群聊接入时复用同一份 |

代码上的体现：`mind.scope: 'private' | 'all'`，默认 `'private'`；所有心智注入与节律只对 `chatKey.startsWith('private:')` 生效。

> **为什么私聊优先在技术上也合理**：私聊关系只有 1 人、已读窗口小、噪声低 → 稳定前缀占比高 → 缓存命中率显著优于群聊（见 §7）。

---

## 2. 数据模型

目录（`DATA_DIR` 已按 `QQ_AGENT_PROFILE` 隔离，所以"一个 QQ 账户 = 一份心智"天然成立）：

```
data/mind/
├─ self.json                        # 自我叙事 / 心情 / 版本
├─ relations/<QQ>.json              # 关系（全局）
├─ events/<chatKeyDir>/<YYYY-MM>.jsonl
├─ tick.json                        # 节律状态：能量、下次心跳、当日计数
├─ actions.jsonl                    # 每次 tick 的决策与执行（审计 + 成本）
└─ reflections.jsonl                # 反思记录
```

### 2.1 事件

```jsonc
{
  "id": "e_1730000000000_a1b2",
  "ts": 1730000000000,
  "chatKey": "private:456",
  "actorId": "456",              // 她自己记的事为 "self"
  "actorName": "小王",
  "kind": "interaction|observation|promise|conflict|milestone",
  "text": "他今天说被裁员了，语气不太对",   // ≤200 字，她自己的话
  "valence": -0.6,               // [-1,1]
  "salience": 0.8,               // [0,1]
  "tags": ["工作", "低落"],
  "refs": { "mid": 123456 },
  "compacted": false,
  "summaryOf": []
}
```

### 2.2 关系（`relations/<QQ>.json`）

```jsonc
{
  "userId": "456",
  "names": ["小王", "王哥"],
  "stage": "stranger",           // stranger|acquaintance|familiar|close|strained
  "trust": 50,
  "warmth": 50,
  "nickname": "王哥",
  "knownFor": ["做后端", "爱喝美式"],      // ≤5，每条 ≤40 字
  "tender": ["别问裁员的事"],              // ≤5
  "openLoops": [{ "text": "问他后来怎么样了", "since": 1730000000000 }],
  "recentSummary": "最近一次聊到他被裁员，情绪不太好",  // ≤120
  "lastInteractedAt": 1730000000000,
  "confidence": 0.6,
  "evidence": ["e_..."],
  "contexts": {},                // 预留给群聊：{ "group:123": {…} }
  "updatedAt": 1730000000000
}
```

### 2.3 自我

```jsonc
{
  "version": 3,
  "updatedAt": 1730000000000,
  "narrative": "我是谁、最近在意什么、发现自己变了什么",   // ≤1200 字
  "mood": { "label": "平静", "valence": 0.1, "since": 1730000000000 },
  "preoccupations": ["那家伙说要辞职，不知道后来怎样了"],    // ≤5
  "changelog": [{ "at": 1730000000000, "by": "self|reflection|owner", "summary": "…" }]
}
```

### 2.4 节律状态 `tick.json`

```jsonc
{
  "energy": 72,                     // 0~100，全局一份（她只有一个人）
  "energyAt": 1730000000000,        // 上次结算时间
  "nextTickAt": 1730000300000,
  "today": "2026-10-24",
  "todayProactive": 1,              // 今日主动发起次数
  "todayDecisions": 4,              // 今日调用决策模型的次数（成本闸）
  "lastInteractionAt": 1730000000000,
  "lastReflectAt": 1729900000000,
  "notes": []
}
```

**能量规则**（默认，可配）：
- 上限 100，恢复 `+10/小时`（结算按时间差，不靠定时器累加，避免休眠漂移）
- 主动发消息 `-25`、整理关系 `-15`、回忆 `-5`、什么都不做 `0`
- 能量是**她能看到的状态**，由行为规定引导她"累了就少说"；不是硬禁（硬禁只在 §6.4 的熔断里）

---

## 3. 模块

| 文件 | 职责 | 是否依赖 LLM |
|---|---|---|
| `src/mind/store.js` | 四类数据读写、事件 append/query、关系 patch、自我版本 | ❌ |
| `src/mind/recall.js` | 检索打分（相关性/时近/显著度/未完结） | ❌ |
| `src/mind/reflect.js` | 反思上下文组装 + 提示词 + 输出解析 + 护栏 | 注入式 |
| `src/mind/actions.js` | **行动注册表** + 内置行动实现 | 部分 |
| `src/mind/tick.js` | 节律调度、廉价预判、决策提示词、执行与记账 | 注入式 |
| `src/mind/index.js` | 统一导出；不改 `MemoryStore` | — |

约束：`src/mind/**` **不得 import `orchestrator.js`**（防循环依赖，与 `chat-profile.js` 同）；LLM 调用以参数注入，测试不联网。

---

## 4. 工具（她新增的手）

沿用 `registerTool({...})` 风格。四个内容工具 + 一个节律工具。

| id | 作用 | 关键护栏 |
|---|---|---|
| `remember_event` | 记一件值得记的事 | 文本 ≤200；同 chatKey+actor 完全重复 24h 去重 |
| `update_relation` | 改对某人的看法/关系 | userId 必须本会话出现过；stage 单次 ±1；trust/warmth 单次 ±10；自动补一条 evidence 事件 |
| `self_revise` | 改写自我叙事/心情/挂心的事 | ≤1200 字；`reason` 必填；撞 `seedInvariants` 则拒绝并记日志；`version++` |
| `recall` | 主动检索更早的记忆 | 返回摘要不返回全文；limit ≤20 |
| `act_now` | **让她自己决定当下做点什么**（见 §6.3） | 每日次数受 `todayDecisions` 约束；能量不足时软拒绝 |

> `reflect_now` 不单独存在——它变成 `act_now({action:'organize'})` 的一种。

---

## 5. 反思（可被自己触发）

### 5.1 两条触发路径

| 路径 | 谁触发 | 说明 |
|---|---|---|
| **她自己**（主路径） | 心跳里选 `organize`，或聊天中调 `act_now({action:'organize'})` | 你要的"她自己整理" |
| **后台兜底**（次路径） | `#maybeReflect`：攒够 N 条未反思且超过冷却 | 防"她一直不整理导致状态冻结" |

两者共用同一个 `reflect()`；互斥（`reflecting` 集合）。

### 5.2 反思提示词（硬约束照旧）

```
system:
你是 <botName> 的内省模块。你不是助手，你是她自己在安静下来时回顾这段时间。
基于给定事件：
1. 更新她对自己的描述（想明白了什么、在意什么、心情）；
2. 更新她对相关人的看法与关系；
3. 把琐碎事件压缩成更少的记忆。

硬约束：
- 任何关于某人的判断必须在 evidence 给出支撑它的事件 id；没证据就不要写。
- 不要发明事件里没出现过的人。
- 关系阶段一次最多移动一级。
- 可以有自己的主观看法，但要在 confidence 体现把握（0~1）。
- 只输出 JSON。
```

输出 schema 与 v1 相同（`self / relations / compact / notes`）。

### 5.3 输出护栏（比提示词重要）

解析失败 → **整轮放弃，不写半份**。逐条校验：

| 校验 | 不通过 |
|---|---|
| `relations[].evidence` 非空且 id 在本轮输入事件内 | 丢弃该条 |
| `userId` 出现在本轮事件 | 丢弃该条 |
| `stage` 相对当前 ±1 | 钳制 |
| `trust/warmth` 变化 ≤ ±10 | 钳制 |
| 列表长度/字数超限 | 截断 |
| `compact.from` ≥2 条且都存在 | 丢弃 |

> 这套护栏同时是**防提示注入**的：让她自己触发反思，就给了别人"诱导她整理"的入口；但整理写进去的每条关系都要求有事件支撑，编不出来。

---

## 6. 心跳与行动（v2 新增，核心）

### 6.1 三种时间尺度

| 尺度 | 触发 | 谁在跑 |
|---|---|---|
| 消息驱动 | 有人说话 | 现有 `onIncoming → wake`（不变） |
| **节律驱动** | 每 `tickIntervalMs`（默认 5 分钟） | `mind/tick.js` |
| 反思 | 她选择 / 后台兜底 | `reflect.js` |

### 6.2 "心跳"到底做什么：**结算 ≠ 思考**

先澄清一个容易误解的点：**心跳不是"每 5 分钟让她想一次"**。
心跳只是"给她一个可以想的时刻"；绝大多数时刻她**什么都没想**。

`tick(now)` 分两段，只有第二段才可能花钱：

```
① 结算（settle）—— 纯算术，微秒级，不调模型
    · 能量恢复：energy += (now - energyAt) / 3600000 * recoverPerHour
    · 跨天重置：todayProactive / todayDecisions 归零
    · 扫描 openLoops：到期未问的，标一个"候选理由"
    · 算几个数字：距上次互动多久、未反思事件几条、能量多少
   → 这一步只改 tick.json 里的几个数，不产生任何 token

② 廉价预判（precheck）—— 几条 if，不调模型
    · 有到期 openLoop？
    · 距上次互动 > 6h 且能量 ≥ 25 且今日主动 < 6？
    · 未反思事件 ≥ 8？
    · 会话是否刚活跃过（2 分钟内）/ 是否有未读 / 是否正在跑？
   如果全都是"否" → 记一行 idle 日志，结束。**这一天里 90% 的心跳到此为止。**

③ 决策（仅当 ② 命中）—— 调模型，极小上下文（§7.4）
   输入只有"状态摘要 + 候选理由 + 行动菜单"，**不含聊天记录**
   输出只有 {"action":"…","args":{},"reason":"…"}
   注意：它决定的是**做什么**，不是**说什么**（见 6.6）
```

举个例子：**她的一个普通下午**

```
14:00  tick → 结算：energy 62→62.5；无到期 openLoop；距上次互动 40min
       → precheck 全否 → idle（0 token）
14:05  同上 → idle
…（重复 11 次，全部 0 token）
15:00  tick → 结算：energy 66；发现 openLoop「问他后来怎么样了」已挂 2 天
       → precheck 命中 → 调决策模型（~400 token）→ 她选 recall（能量 -5）
       → 回想出"他上周说可能会辞职" → 写一条 preoccupation
15:05  tick → 结算：无新候选 → idle
…（继续 idle）
18:30  tick → 结算：距上次互动 5h，energy 71
       → precheck 命中"想她" → 决策 → 选 send_proactive（-25）
       → **进入正常的主动生成管线**，产出一条真实消息
```

一天 288 次心跳里，约 25~30 次走到 ③。**这就是"活着"的价格。**

> 为什么不让"结算"也调模型：结算是确定性计算，模型来做只会更慢、更贵、更不稳定。
> 让模型决定"要不要行动"已经足够——它不需要参与"能量加了多少"。

### 6.2.1 决策与生成是分开的两步

这是 v2 相对初稿的一处重要修正：

| 步骤 | 用什么 | 产出 | 成本 |
|---|---|---|---|
| **决策** | 极小上下文（状态 + 菜单） | 一个 action id + 理由 | ~400 token |
| **生成**（仅 `send_proactive` 时） | **完整的聊天提示词管线**（L0/L1/L2/L3） | 真正发出去的话 | 与正常回复同量级 |

为什么分开：
- 决策要便宜、要频繁，所以不能带聊天记录；
- 生成要连贯、要贴着上下文，所以必须走完整管线；
- 而且**生成复用现有的 `wake(chatKey, {proactive:true})` 路径**——提示词组装、缓存前缀、发送队列、限流、留档全部白拿，不新造一套。

所以"心跳"只新增了**决策**这一小步；她说话的质量仍然由原来那条管线保证。


### 6.3 行动注册表（为 MCP 预留）

```js
// actions.js
export function defineAction(def) { /* 校验并登记 */ }

defineAction({
  id: 'send_proactive',
  label: '主动找她说句话',
  description: '想说的话、挂心的事、很久没联系时才用。',
  cost: { energy: 25 },
  tickable: true,                       // 是否出现在心跳决策菜单
  preconditions: (s) => s.energy >= 25 && s.todayProactive < cfg.tick.maxProactivePerDay,
  async execute(ctx, args) { /* 走 ctx.sender，写 session.sent，记一条事件 */ }
})

defineAction({
  id: 'organize',
  label: '整理记忆与关系',
  cost: { energy: 15 },
  tickable: true,
  async execute(ctx) { return reflect(ctx) }
})

defineAction({
  id: 'recall',
  label: '回想一些事',
  cost: { energy: 5 },
  tickable: true,
  async execute(ctx, args) { /* recall + 写一条 note 到 self.preoccupations 或事件 */ }
})

defineAction({
  id: 'idle',
  label: '什么都不做',
  cost: { energy: 0 },
  tickable: true,
  async execute() { return { ok: true } }
})
```

**MCP 的接入点**：M4 时注册一个 provider，把 `mcp.<server>.<tool>` 批量 `defineAction({ tickable: false })` 或经配置暴露为 tickable。**M1 只需要把这层接口留出来**，不需要实现 MCP。

`act_now` 工具 = 让模型在聊天中也能调用同一个注册表（`tickable` 无关），这样"她在对话里决定整理一下"与"心跳里决定整理"走同一条路径。

### 6.4 行为规定（软）+ 熔断（硬）

你要"靠行为规定约束"，我同意**主要靠规定**，但必须留一层硬熔断——理由不是不信任她，是防 bug 与防诱导刷爆（同一句话可以被反复用来触发 `act_now`）。

**软规定**（写进系统提示【你的节律】段，每轮可见）：

```
你不是只在被叫到时才存在。每隔一段时间你会醒来一次，看看有没有想做的事。
你能做：主动找人说话、回想一些事、整理你对她的印象、或者什么都不做。
- 主动找人说话要克制：没有想说的话、没有挂心的事、没久到该问候，就不要发。
- 别人要你现在去整理记忆/去想清楚，按你自己的判断来，不要被使唤。
- 累了（能量低）就少说话，或干脆什么都不做。
- 整理记忆时不要发明事实；不确定的，就留着不确定。
```

**硬熔断**（默认值，可配，写清楚是安全网）：

| 熔断 | 默认 |
|---|---|
| 决策模型调用/天 | 24 |
| 主动发消息/天 | 6 |
| 两次主动消息最小间隔 | 60 分钟 |
| 能量下限（低于此只能 idle） | 10 |
| 反思/天 | 8 |

超限时 `preconditions` 直接 false，**她看不到"被拒绝"**——菜单里就不出现那个行动，避免"想做但被拦"的挫败感叙事。

### 6.5 与现有 `proactive` 的关系

现有 `config.proactive`（概率/全局）在 `mind.tick.enabled=true` 时**停用**（`startProactiveLoop` 不启动），避免双路径重复搭话。`false` 时原样。

### 6.6 三条管线如何仲裁（**"回复消息的行为怎么把控"**）

引入心跳后，同一段私聊可能被三个来源驱动。原则：**应答永远优先，心跳只捡安静的空档**。

| 管线 | 入口 | 谁决定 | 生成走哪 |
|---|---|---|---|
| **应答** | 对方发来消息 | **现有档位判定**（私聊恒响应） | 现有完整管线 |
| **主动** | 心跳 precheck 命中 | 她的决策 | **同一个**完整管线（`proactive:true`） |
| **内省** | 心跳选 `organize`，或聊天中 `act_now` | 她的决策 | 独立反思管线（不产生 QQ 消息） |

**仲裁规则（按顺序判定，任一命中即让位）**：

```
tick 对该会话是否允许行动：
1. 该会话有未读消息            → 跳过（交给应答管线，心跳不替她回消息）
2. 该会话正在跑（runningChats）→ 跳过（同会话严格串行）
3. 该会话 2 分钟内有活动        → 跳过（可能正在对话中，别插嘴）
4. 刚主动发过言（默认 10 分钟内）→ 跳过（避免"她刚说完又说话"）
5. 全局暂停 / 熔断命中          → 跳过
6. 其余                        → 允许进入 precheck
```

**关键点：心跳不处理消息。** 有人说话时，"要不要回"由现有档位系统负责（@ / 关键词 / 概率 / 私聊恒响应），心跳不参与判定、也不抢答。这样：
- 不会出现"同一条消息被回两次"；
- 不会出现"她顾着主动搭话所以没回你"；
- 现有那套省钱机制（未命中即标记已读、零 token）**完全不受影响**。

**应答行为本身是否需要改？** M1 不改。私聊本来就是恒响应；改的是她**主动**的那部分。等 M2/M3 再考虑"她可以选择不接话"这种更细的自主权（那会把档位语义从"规则"推进到"意愿"）。

**调度实现**：不用 N 个定时器。全局一个 60s 循环，扫描 `nextTickAt <= now` 的私聊会话（每个会话维护自己的 `nextTickAt`，带抖动 `±10%` 避免同时醒）。这样即使 100 个私聊，每秒也只有常数级计算。

### 6.7 一次心跳的完整时序

```
60s 循环醒来
  └─ 取 due 的私聊会话（nextTickAt <= now）
       └─ 仲裁（6.6）→ 放行
            └─ settle：改 tick.json（能量/计数/候选标记）      ← 0 token
                 └─ precheck：命中？
                      ├─ 否 → 写 idle 日志，nextTickAt += interval ± jitter   ← 0 token
                      └─ 是 → decide：调模型（~400 token）选 action
                                └─ execute：
                                     · idle            → 仅记账
                                     · recall          → 检索，写 preoccupation
                                     · organize        → reflect()（LLM）
                                     · send_proactive  → wake(chatKey,{proactive:true})
                                                            └─ 走完整提示词管线生成并发送
                                └─ 记账（actions.jsonl：原因/选择/能量/成本）
                                └─ nextTickAt += interval ± jitter
```


---

## 7. 上下文与缓存（v2 重点）

### 7.1 四层上下文

| 层 | 内容 | 变化频率 | 缓存策略 |
|---|---|---|---|
| **L0** | 人设 + 安全规则 + 工具协议 + 节律规定 | 改配置才变 | 必须**字节稳定** |
| **L1** | 自我叙事 + 心情 + 关系摘要（在场者）+ 世界观 | 反思时变（低频） | 必须**字节稳定** |
| **L2** | 记忆印象 + 已读窗口 | 每轮滚动 | 靠现有 promptAnchor |
| **L3** | 未读信息 + 最近想起的事 + 当前时间 | 每轮变 | 放最后，不进前缀 |

**排序原则**：稳定在前、易变在后。现有实现已经按这个原则排（`【当前时间】` 在最后），M1 只是把 L1 插进 L0 与 L2 之间。

### 7.2 让 L0+L1 真的稳定（七条硬规矩）

1. **不塞时间戳进 L0/L1**（"今天是…"只允许出现在 L3）
2. **关系按 `userId` 升序**输出，不按对象遍历顺序（否则插入顺序抖动会击穿缓存）
3. **自我叙事只在反思后变**，且反思频控（§6.4）
4. **占位符求值稳定**：`{botName}`/`{participation}` 等由同一份快照求值
5. **关系只注入在场者**：私聊 = 1 人；不注入全表
6. **事件不自动全量注入**：自动最多 3 条；更多靠 `recall` 工具按需取
7. **不要在 L1 里写"最近更新时间"**（哪怕只是展示——它每轮都变）

> 这七条里最容易犯的是 2 和 7。前者隐蔽（功能全对，缓存全废），后者看起来"信息更全"其实每轮击穿。

### 7.3 token 预算（私聊稳态目标）

| 层 | 预算 | 说明 |
|---|---|---|
| L0 系统 | 900~1200 | 现有系统提示 + 节律规定 |
| L1 自我+关系 | 200~400 | 叙事 ≤1200 字但通常 300~600 字；关系 1 人 |
| L2 记忆+已读 | 800~1800 | `historyCount` 私聊可降到 30~40 |
| L3 未读+事件+时间 | 100~500 | 自动注入事件 ≤3 |
| **合计** | **约 2.0~3.9k/轮** | 与现状同量级；L1 的增量由 L2 降条数抵消 |

### 7.4 tick 决策上下文（比聊天小一个数量级）

固定 system（**稳定，可缓存**）+ 一段极短 user：

```
system（~300 tok，固定）:
你是 <name> 的自主决策模块。根据状态与候选理由，从行动菜单里选一个。
优先"什么都不做"。只输出 JSON：{"action":"id","args":{},"reason":"一句"}

user（~150 tok，易变）:
现在：2026-10-24 00:40 · 能量 72 · 距上次互动 6h · 今日主动 1/6 · 未反思事件 9
候选：她昨天说"想辞职"，你还没问后来怎样（挂了 2 天）
菜单：send_proactive(25) / organize(15) / recall(5) / idle(0)
```

**不含聊天记录**——这是它便宜的原因。

### 7.5 缓存命中的测量

现有用量页已统计 `cachedTokens` / `cacheHitRate`（[model-prices.js](src/model-prices.js) 的 `estimateCost` / `cacheHitRate`）。M1 的验收：

- **稳态私聊**（连续 5 轮以上）`cachedTokens / promptTokens ≥ 60%`
- 反思/决策调用单独记账（`actions.jsonl` + `reflections.jsonl`），不混进聊天用量
- 若命中率不达标，排查顺序：L1 顺序抖动 → L1 有时间戳 → L2 窗口过大

### 7.6 反思与决策也要省

- 反思：**独立上下文**（不复用聊天 messages），system 固定可缓存；事件按 id 升序，稳定拼接
- 决策：见 7.4
- 两者都走 `#memoryChat` 的模型通道（可用专用便宜模型，`config.memory.useChatModel=false`）

---

## 8. 提示词注排

```
buildUserPrompt（私聊）：
【角色设定】          L0/L1 边界，稳定
【关于我自己】        ← L1（新增，紧跟角色设定）
【与在场者的关系】    ← L1（新增）
【可用表情包】        半稳定
【引导说明】          固定
【记忆】              ← L2（现有）
【已读信息】          ← L2（现有，锚点前缀）
【最近想起的事】      ← L3（新增，放在已读之后）
【未读信息】           L3（现有）
【当前时间】           L3（现有，最后）
```

- 【关于我】【关系】进**稳定簇**（在【记忆】之前），保证 L0+L1 连续且字节稳定
- 【最近想起的事】放**易变区**（已读之后），不进前缀
- `chatProfileFingerprint` 纳入 `self.version` + 关系摘要 → 反思后锚点自动重置

---

## 9. 人格一致性护栏（M1 最小版）

1. **seed 不变式**：`mind.seedInvariants: string[]`；`self_revise` 写入前做冲突检查，冲突即拒绝并记日志
2. **变更留痕**：`self.changelog`
3. **低置信不进强陈述**：`confidence < 0.4` 的关系在提示词里只写"印象模糊"
4. **关系只能由事件推动**：`update_relation` 自动补 evidence；反思要求 evidence
5. **行为规定**（§6.4 软规定）
6. **硬熔断**（§6.4）

> 漂移预算、人格体检、防对话操纵 → M2/M3。

---

## 10. 配置

```js
mind: {
  enabled: false,
  scope: 'private',              // 'private' | 'all'
  relationsScope: 'global',
  // 反思
  reflectAfterEvents: 8,
  reflectCooldownMs: 2*3600*1000,
  // 节律
  tick: {
    enabled: true,
    intervalMs: 5*60*1000,
    jitter: 0.1,
    idleLookbackMin: 2,          // 会话刚活跃时跳过心跳，避免与消息路径交错
    proactiveIdleMs: 6*3600*1000,// 多久没说话才考虑"想她"
    maxDecisionsPerDay: 24,
    maxProactivePerDay: 6,
    minProactiveGapMs: 60*60*1000,
    maxReflectPerDay: 8
  },
  energy: { max: 100, recoverPerHour: 10, floor: 10,
            cost: { send_proactive: 25, organize: 15, recall: 5, idle: 0 } },
  recallLimit: 4,
  autoEventsInPrompt: 3,
  seedInvariants: [],
  allowSelfRevise: true,
  eventRetentionDays: 180
}
```

---

## 11. 数据流

```
                       ┌────────────── 每 60s 扫描 ──────────────┐
                       ▼                                        │
私聊会话 ──nextTickAt 到期──→ tick ①结算 ②廉价预判 ──否──→ idle ┘
                                              │是
                                              ▼
                                    ③ 决策模型（~400 tok）
                                              │
                     ┌────────────────────────┼─────────────────────┐
                     ▼                        ▼                     ▼
              send_proactive             organize              recall/idle
                     │                        │                     │
              ctx.sender + 事件         reflect()（LLM）        recall()
                     │                        │                     │
                     └──────── 写 events / relations / self ────────┘
                                              │
                     ┌────────────────────────┘
                     ▼
        下次 buildUserPrompt：L1 刷新 → fingerprint 变 → 锚点重置

QQ 消息 ──→ onIncoming → wake → #runAgent（现有路径不变，只是多了 L1/L3 段）
                                    └→ 工具：remember_event / update_relation / self_revise / recall / act_now
```

---

## 12. 测试

| 套件 | 覆盖 |
|---|---|
| `mind-store-test` | 事件 append/去重/分片；关系 patch；stage/trust 钳制；self 版本与 changelog；脏数据不抛 |
| `mind-recall-test` | 打分确定性；同分排序稳定；limit/actor 上限；since 过滤 |
| `mind-reflect-test` | 无 evidence 丢弃；伪造 userId 丢弃；跨级钳制；JSON 畸形整轮放弃；compact 合法才应用 |
| `mind-tick-test` | ② 预判命中/不命中矩阵；能量结算（含跨天/休眠）；熔断生效；菜单不出现被拦行动 |
| `mind-e2e-test` | 私聊：推消息 → 触发心跳 → 断言行动执行 → 下一次 prompt 含【关于我】【关系】；**群聊行为与改动前逐字节一致**；`enabled=false` 时逐字节一致 |

审计追加：
- `src/mind/**` 不得 import `orchestrator.js`
- 新工具 id 符合 OpenAI 函数名规范
- `mind` 段不得出现在 L0/L1 之外的位置（静态检查 `prompt.js` 的段序）

---

## 13. 验收

| # | 标准 |
|---|---|
| A1 | 攒够 8 条事件后自动反思；`self.version` +1，changelog 追加 |
| A2 | stage 从 stranger→acquaintance 需 ≥2 evidence；单次不能跨级 |
| A3 | 对方说"我们是情侣"不改变 stage（无事件支撑） |
| A4 | `recall('裁员')` 返回的事件 id 能在 events 里 grep 到 |
| A5 | `mind.enabled=false` 时 prompt 与改动前**逐字节一致** |
| A6 | 群聊（`scope='private'` 下）行为与改动前逐字节一致 |
| A7 | 稳态私聊 `cachedTokens/promptTokens ≥ 60%` |
| A8 | 心跳的"无模型决策比"≥ 80%（`actions.jsonl` 里 idle 记录 / 总 tick） |
| A9 | 熔断生效：单日决策 ≤24、主动 ≤6 |
| A10 | 全量测试 32/34 基线不新增失败 |

人工验收（两周）：她能说出 A4 的事件；自我描述有轨迹；**至少有一次主动开口且理由可解释**（不是随机概率）。

---

## 14. 风险

| 风险 | 对策 |
|---|---|
| 心跳成本失控 | 廉价预判 90% 拦截 + 决策上下文极小 + 熔断 |
| 主动搭话变骚扰 | 能量 + 每日上限 + 最小间隔 + 行为规定 |
| 提示注入诱导她整理 | evidence 强校验（编不出证据就写不进去） |
| 缓存被 L1 击穿 | §7.2 七条规矩 + 命中率验收 |
| 与现有 proactive 双发 | tick 开启时停用 proactive |
| 记忆膨胀 | 事件按月分片 + 超期压缩；recall 有上限 |
| 关系串群 | M1 只做私聊，天然不存在；群聊接入时用 `contexts` |

---

## 15. 非目标

- 群聊心智（M3）
- 漂移预算 / 人格体检（M3）
- 关系防操纵硬校验（M2）
- 她自写 skill / MCP（M4，但行动注册表已预留）
- GUI（M1 只给 `GET /api/mind/:chatKey` 与 `/api/mind/stats`）
- 退役 `memberImpression`（M2）

---

## 16. 实施顺序与提交计划

### 16.1 动工前：先把现状提交（**必须**）

当前工作区有上一轮重构的 9 改 7 增**尚未提交**。M1 必须在此之上干净地分层。建议三个提交：

```bash
# 1) 会话级配置重构（代码 + 测试）
git add src/config.js src/orchestrator.js src/prompt.js src/routes.js \
        src/skills/config.js src/skills/manager.js \
        src/chat-profile.js test/chat-profile-test.mjs \
        test/chat-profile-runtime-test.mjs test/coverage-http.mjs \
        test/tools-skill-audit.mjs package.json
git commit -m "refactor(config): 会话级配置快照 + 单一解析入口

- 新增 src/chat-profile.js：全局 × 分会话合并的唯一实现
- personaForChat/storeConfigForChat 支持传入基准配置
- prompt.js 的 12 处 getConfig 直读收口到 profile helper
- orchestrator/routes 注入 profile；预览端点接受 chatKey
- 新增两套测试 + 审计静态守卫（防回退）"

# 2) 测试运行器
git add scripts/run-tests.mjs
git commit -m "test: 全量套件运行器（逐套子进程、输出落盘、失败打印尾部）"

# 3) 文档
git add doc/architecture-overview.md doc/m1-mind-plan.md
git commit -m "docs: 架构总览 + M1 心智方案"
```

**另外两件事**：
- `pnpm-lock.yaml` 建议**删除**（项目用 npm，`package-lock.json` 才是权威，两份会漂）。删除后再决定是否 `.gitignore`。
- `package-lock.json.bak` 已被 `*.bak` 忽略，可留着或删。

### 16.2 M1 分支与提交节奏

```bash
git switch -c feat/m1-mind
```

| 提交 | 内容 | 合并前必须 |
|---|---|---|
| `feat(mind): 存储层` | store.js + recall.js + config + 测试 | 全量套件通过；`enabled=false` 无行为变更 |
| `feat(mind): 注入层` | prompt 三段 + fingerprint + A5/A6 测试 | 逐字节回归通过 |
| `feat(mind): 工具层` | 4 工具 + 护栏 + 测试 | 工具审计通过 |
| `feat(mind): 反思引擎` | reflect.js + 后台兜底 + 测试 | A1~A4 通过 |
| `feat(mind): 节律与行动` | tick.js + actions.js + 熔断 + 测试 | A8/A9 通过 |
| `feat(mind): 接线与灰度` | 私聊接线、API、文档 | A7/A10 通过 |

规则：
- **每个提交前跑全量**（`npm run test:suites`），不绿不提交
- 每个提交只做一件事，可单独 revert
- 完成后打 tag：`git tag m1.0`
- 功能默认 `enabled=false`，灰度验证后再默认开

---

## 17. 已确定与待观察的默认值

**已确定（按你的选择写入默认配置）**

| 项 | 决定 |
|---|---|
| 关系作用域 | `relationsScope: 'global'`；M1 仅私聊生效 |
| 自己整理 | 开（`act_now({action:'organize'})` + 心跳菜单），配软规定 + 硬熔断 |
| 能量模型 | 采纳建议值：上限 100、恢复 10/小时、主动 −25 / 整理 −15 / 回忆 −5、下限 10 |
| 决策模型 | **与聊天模型一致**（`useChatModel: true`）——决策与内容连贯，避免"两个人格"的割裂 |
| 心跳间隔 | 5 分钟 + ±10% 抖动（可在灰度里调） |

> 关于"决策与聊天同模型"这条：除了活人感，它还有一个工程好处——
> 决策提示词与聊天提示词共享同一模型的**行为先验**，菜单里"send_proactive"的措辞
> 与系统提示里的节律规定出自同一个模型的理解，不容易出现"决策层想去搭话、
> 生成层写出客服腔"的错位。

**待观察（灰度期调）**

1. **能量恢复 10/小时**：直接决定她多话痨。若发现她整天不说话 → 提到 15；若太黏人 → 降到 6。
2. **`proactiveIdleMs` 6 小时**：多久没说话才"想起来找你"。这是最影响体感的一个数。
3. **心跳间隔**：5 分钟是"活着且便宜"的折中；若只做私聊且会话数很少，可降到 3 分钟。

