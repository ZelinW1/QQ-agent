# 代码架构快照（`ef5a8ec`，重构前）

> **过期警告（2026-10-29）**：行动运行时重构已实施（`ef5a8ec..05f3f33`，17 个提交），
> 本文描述的是**重构前**的结构。行号、模块清单、装配路径都已变化，
> 引用它时应以本节下面的"变化清单"为准，而不是以正文的 `path:line` 为准。
>
> 需要了解**当前**结构时，读 [导读](./architecture-primer.md) 与
> [设计稿 §12 进度表](./action-runtime-design.md)；扩展作者接口见
> [`extend_development/`](./extend_development/)。

| 项 | 内容 |
|---|---|
| 状态 | **重构前快照**：由通读 `ef5a8ec` 得出；与扩展文档的偏差见 §10 |
| 代码基准 | `ef5a8ec` |
| 读者 | 需要对照历史、或要读 `ef5a8ec` 那一版代码的人 |
| 最后更新 | 2026-10-29（只加横幅，正文未重写） |

本文所有结论均带 `path:line`，可直接跳转核对。**行号会随代码漂移**，以符号名为准。

## Δ 重构改变了什么（相对本文）

| 方面 | `ef5a8ec`（本文） | 现在 |
|---|---|---|
| 运行时与领域 | 编排器直接持有 `MindStore` 并调用其方法 | 字面 `this.mind.xxx()` 为 0，但 `reflectForChat` / `runIntegrate` / `runNarrative` 仍用 `const store = this.mind` 别名直调；**名义成立、实质未达成**（2026-10-30 审查结论） |
| 领域缺席 | 静态 import，删掉 `src/mind/` 就起不来 | 动态加载 + 降级；`QQ_AGENT_NO_MIND=1` 等价于删除（`test/mind-deleted-test.mjs`） |
| 自由时刻 | `#runGlobalTick`：一次 JSON 决策，按动作注册表执行 | 八步管线（`src/runtime/pipeline.js`）+ 素材层（`src/runtime/materials.js`）：提示词带 self/叙事/意图，每个动作留 attempts 与观察 |
| 心跳模式 | 全局 + per-chat 两套 | 只剩全局（`d42ea67` 删除 per-chat） |
| 行动记录 | `actions.jsonl` | 冻结读写分离：新写入进 `attempts.jsonl`，`listActions` 合并新旧；新增 `intentions.jsonl` / `observations.jsonl` / `narratives.jsonl` |
| 自我改写 | 会话反思可直接改 self | 会话反思只写 `selfNotes`；只有全局整合能改 self（月度兜底） |
| 控制台 | `routes.js` 直接摸 store | 全部经 AdminPort，`new MindStore` 只在 `app.js` |
| 扩展接口 | — | **未变**：技能/插件契约保持兼容（有意与上游切割的部分只在内部运行时） |

## 0. 一句话架构

**事件驱动 + 无状态会话（stateless per-run）**：QQ 消息落成 JSON 存档 → 每条消息当场做一次
「要不要响应」判定 → 命中才开一个**独立 agent 会话**，提示词 = 静态系统提示 + 存档切片 + 本次新消息
→ 会话结束即弃置（LLM 层面零历史）→ 还有未读就再开一个会话，直到清空。

成本控制的核心不是"省着用"，而是**成本不随聊天量增长**：一次处理的开销是恒定小份。

---

## 1. 唯一身份锚点：`chatKey`

整个工程用**一个字符串**贯穿所有分层：

```
"group:123456"  /  "private:789012"
```

它同时是：存档文件名、记忆目录名、存档键、记忆键、会话记录的归属、限频队列键、去重键、
提示词的 `ctx.chatKey`、以及扩展运行时上下文的一个字段。

| 环节 | chatKey 的用法 | 位置 |
|---|---|---|
| 生成 | `${kind}:${id}`，kind ∈ {group, private} | [app.js:901](../src/app.js#L901) |
| 存档文件 | `data/messages/group_123.json` | [store.js:23-27](../src/store.js#L23-L27) |
| 记忆目录 | `data/memory/group_123/<QQ>.json` | [memory.js:13-23](../src/memory.js#L13-L23) |
| 发送队列/限频/去重 | `Map` 全部以 chatKey 为键 | [sender.js:50-53](../src/sender.js#L50-L53) |
| 并发闸门 | `runningChats` / `pendingWake` 集合 | [orchestrator.js:45-49](../src/orchestrator.js#L45-L49) |
| prompt 前缀缓存锚点 | `promptAnchors: Map<chatKey, …>` | [orchestrator.js:66](../src/orchestrator.js#L66) |
| 活跃模式状态 | `activeTopics: Map<chatKey, …>` | [orchestrator.js:60](../src/orchestrator.js#L60) |

> **关键点**：`chatKey` 只在 app.js 边界处解析，之后一路传字符串（[app.js:901](../src/app.js#L901)、[app.js:913](../src/app.js#L913)）。
> 工具层从不自己拼群号 —— 它只拿 `ctx.chatKey`（见 §6）。
> id 段一律 `String()` 化，因此数字型 QQ 号/群号没有前导零问题。
>
> ⚠️ **一个真实存在的键格式不一致**：**群键控配置**（`groupSliderPos` / `groupPeakPos` /
> `blocklist` / `commandMute.active`）的键是**裸群号** `"123"`，而 `personaByChat` 的键是
> **完整 chatKey** `"group:123"`。`personaForChat` 为此做了双格式兼容
> （`perChat[id] ?? perChat[chatKey]`，[config.js:657](../src/config.js#L657)），
> 所以同一会话理论上可能同时存在两份条目，**读侧以裸 id 优先**。
> 配置写入没有 per-chat 端点，全部走 `POST /api/config` + map 型字段的 `__replace__` 整体替换。

---

## 2. 端到端链路（一条消息的一生）

```
OneBot WS 事件
  │
  ├─ app.js ingestMessage(kind, id, event)                         app.js:824
  │    ① allowed(kind, id, cfg)  白名单/黑名单闸门 → 不在名单内**完全不记录**   app.js:47-54, 826
  │    ② 屏蔽名单（全局优先，其次按群）→ 直接 return              app.js:835-839
  │    ③ segments → 文本（含 @ 段收集、语音转写、合并转发展开）    app.js:842-873
  │    ④ atMe 判定：有 @ 段以 **QQ 号**为准，无 @ 段回落文本匹配    app.js:885-892
  │    ⑤ 指令禁言检测（@我 + 指令 → 该群临时锁 1 档）             app.js:897-899
  │    ⑥ store.appendIncoming(chatKey, …)  落成未读条目           app.js:901
  │    ⑦ orchestrator.onIncoming(chatKey, entry)  ← 逐条触发判定   app.js:913
  │
  ├─ onIncoming: resolveContextTier(单条)                           orchestrator.js:166-207
  │    不命中 → markEntryRead(只标这一条) → 沉入历史，**零 token**
  │    命中   → scheduleWake(verified)  进入固定倒计时
  │
  ├─ scheduleWake: 倒计时 wakeDelayMs（**不可重置**，只聚批不重判） orchestrator.js:220-282
  │    同时建一个 status='waiting' 的"等待中"会话（UI 可见）
  │
  ├─ wake(chatKey)                                                  orchestrator.js:348
  │    ① 机器人被禁言 → 标已读、不建会话（不白烧 token）          orchestrator.js:363-371
  │    ② 全局并发闸门 maxConcurrentRuns，满了 3s 后重排            orchestrator.js:374-399
  │    ③ 取触发批：drainUnreadFrom(触发消息 ts)                     orchestrator.js:401-504
  │        批边界之前的老积压 → 标已读沉历史（**不塞进本轮**）
  │        机械批（drain/恢复积压）→ 逐条补判定，全不命中就整体归档，不建会话
  │    ④ 固定本轮的 tier / contextLimit（随机档骰子只掷一次）      orchestrator.js:513-530
  │    ⑤ 会话级重试循环（最多 1+sessionRetryAttempts 次）          orchestrator.js:577-611
  │
  ├─ #runAgent(session, …)                                          orchestrator.js:732
  │    ① skillContext = { chatKey, kind, chatId, chatName, model, provider,
  │                        visionEnabled, searchEnabled, proactive, sessionId }   orchestrator.js:762-770
  │    ② hook 'before-context'                                     orchestrator.js:776
  │    ③ 主人识别能力 message.owner-check → ownerPersona           orchestrator.js:790-807
  │    ④ buildSystemPrompt({ persona, skillContext, extraSections })  prompt.js:212
  │    ⑤ buildUserPrompt({ chatKey, store, memory, … })            prompt.js:708
  │    ⑥ getToolAvailability() 逐工具算可用性 → 交给模型            orchestrator.js:888-905
  │    ⑦ ctx = { chatKey, kind, chatId, store, memory, sender, … }  ← 工具绑定现场  orchestrator.js:907-921
  │    ⑧ 多轮循环：LLM → 工具 → 结果 → LLM …（maxRounds）          orchestrator.js:933-1256
  │
  └─ 收尾
       status = sent>0 ? 'done' : 'noreply'                         orchestrator.js:1259
       runningChats.delete(chatKey)                                 orchestrator.js:633
       还有未读 → drainDelayMs 后再开一个新会话                     orchestrator.js:637-644
       #maybeConsolidateMemory(chatKey) 后台静默整理                orchestrator.js:647
```

### 2.1 触发档位：唯一的"要不要响应"口径

[resolveContextTier()](../src/prompt.js#L446) 是**两处调用、同一口径**：入口逐条判（onIncoming）
与机械批补判（wake 内）都用它。

判定顺序（第一个命中的决定结果；**顺序即代码顺序**）：

| 顺序 | 条件 | 结果 |
|---|---|---|
| 0 | `isPrivate` | 恒 tier 4 必响应（1v1 无 @ 机制） |
| 1 | 拍了拍我（`isPoke` + 文本匹配 `拍了拍 我`） | tier 1 必响应 |
| 2 | 档位 ≥ 4 | tier 4 全响应 |
| 3 | atMe（@ 段 QQ 号优先，老存档回落文本匹配） | tier 1 被艾特 |
| 4 | 档位 ≥ 2 且关键词命中（**剔除 @ 片段与引用块**） | tier 2 关键词命中 |
| 5 | 档位 ≥ 3 且随机命中 `roll < randomPercent` | tier 3 随机命中(骰子值) |
| — | 都不命中 | tier 0，**标已读、不建会话、不调 LLM** |

> 两个容易误读的地方：① 拍了我在 `tier >= 4` **之前**判定；② `tier >= 4` 在 atMe **之前**，
> 所以 4 档下被 @ 也只会报"全部响应"而非"被艾特"（`reason` 只写进会话供排障，**不进提示词**）。

**滑条位置 → 档位**（[sliderToTier](../src/tier-slider.js#L28-L41)，段界见 `TIER_SLIDER_BANDS`）：
`0~10 → 1 档`、`10~20 → 2 档`、`20~90 → 3 档`（`randomPercent = (pos-20)/70*100` 线性）、`90~100 → 4 档`。

**判定发生三次、同一口径**（这是"预判/实跑"设计的遗留说明）：

| 时机 | 位置 | 作用 |
|---|---|---|
| 入口逐条判 | [onIncoming](../src/orchestrator.js#L180-L190) | 决定要不要进倒计时；不触发就当场标这一条已读 |
| 机械批补判定 | [wake](../src/orchestrator.js#L444-L453) | 未判定过的积压逐条补判，取**最早**触发消息定批边界；全不触发则整体归档 |
| 唤醒定稿 | [wake](../src/orchestrator.js#L516-L524) | 结果固定进 `session.contextTier/contextLimit/contextReason`，供会话页解释"为什么响应了" |

档位由滑条位置派生，且**派生逻辑只在 config.js**（前端只上报位置，防止配置自相矛盾）：
[updateConfig → sliderToTier](../src/config.js#L611-L619)。

`storeConfigForChat(chatKey)` 共 **5 个调用点**，全部在 orchestrator：
[185](../src/orchestrator.js#L185)、[449](../src/orchestrator.js#L449)、[515](../src/orchestrator.js#L515)、
[521](../src/orchestrator.js#L521)、[529](../src/orchestrator.js#L529)。**任何绕过它的档位读取都会与设置脱节。**

---

## 3. ★ 五个分层如何按会话耦合

这是本文的核心。**耦合点只有一个：`chatKey` 作为查表键 + `ctx` 对象作为运行期注入。**

```
                    ┌─────────────────────────────────────┐
                    │        chatKey = "group:123"        │
                    └──────────────┬──────────────────────┘
         ┌──────────────┬──────────┼──────────┬───────────────┐
         ▼              ▼          ▼          ▼               ▼
    ┌─────────┐   ┌─────────┐  ┌────────┐ ┌────────┐  ┌─────────────┐
    │  人设   │   │  记忆   │  │聊天设置│ │ 存档   │  │ 技能/插件   │
    ├─────────┤   ├─────────┤  ├────────┤ ├────────┤  ├─────────────┤
    │persona  │   │memory/  │  │store.* │ │messages│  │config.skills│
    │ByChat[id]│  │group_123│  │group   │ │group_  │  │  [id]       │
    │         │   │  /<QQ>  │  │Slider  │ │123.json│  │  ⚠️全局唯一 │
    │✅按会话 │   │✅按会话 │  │Pos     │ │✅按会话│  │  ❌不按会话 │
    └─────────┘   └─────────┘  └────────┘ └────────┘  └─────────────┘
```

### 3.1 人设（persona）：三层收窄，命中即用

**优先级**：主人专属人设 → 会话级人设 → 全局人设
（[orchestrator.js:809-822](../src/orchestrator.js#L809-L822)，注释里写明是"逐层收窄"）

| 层 | 来源 | 实现 |
|---|---|---|
| 1 | `message.owner-check` 能力（owner-identity 插件） | [orchestrator.js:790-807](../src/orchestrator.js#L790-L807) |
| 2 | `config.personaByChat[群号或QQ号]` | [personaForChat()](../src/config.js#L647) |
| 3 | `config.persona`（全局） | 同上，兜底返回 base |

**可以按会话覆盖的字段只有 4 个**：`roleText` / `participation` / `customRules` / `systemPromptOverride`
（[config.js:659-669](../src/config.js#L659-L669)）。

**结构上禁止覆盖**：`botName` / `selfNickname`。原因是它们参与 @ 判定与存档里"我"的称呼，
按群改名会让"@ 判定"和"存档里我是谁"全部对不上 —— 这是**结构约束，不是纪律约束**
（`personaForChat` 的 `out = { ...base }` 只白名单式挑 4 个字段，其余天然无法改）。

**两个开关**：
- `personaUnified === true`（默认）→ `personaByChat` **完全不生效**（数据保留，只是不参与合并）。理由：统一人设模式下 UI 已隐藏分会话编辑入口，旧条目若继续静默覆盖，用户既发现不了也改不了 → 开关形同虚设（[config.js:641-652](../src/config.js#L641-L652)）。
- 键格式兼容两种：`personaByChat["123"]` 与 `personaByChat["group:123"]` 都查，曾经只认一种导致"存了却永不生效"（[config.js:654-657](../src/config.js#L654-L657)）。

**人设正文 `roleText` 落在用户提示里，不在系统提示里** —— 这一点容易搞反：

| 位置 | 内容 |
|---|---|
| 系统提示（[prompt.js:212](../src/prompt.js#L212)） | 行为准则、安全规则、工具协议、**技能片段**；`persona` 只贡献 `botName`（身份句）与 `participation` / 表情积极程度（改写语气段） |
| 用户提示【角色设定】段（[prompt.js:788-790](../src/prompt.js#L788-L790)） | `personaForChat(ctx.chatKey).roleText` 的正文 |

两处必须同源（都用 `personaForChat`），否则"系统里的角色"和"输入里的角色"会打架
（[prompt.js:710-713](../src/prompt.js#L710-L713)）。

> 这也解释了为什么 UI 的提示词预览看不到会话级人设变化：预览只含**系统提示 + 工具清单**，
> 不含用户提示（[routes.js:730-770](../src/routes.js#L730-L770)）。

### 3.2 记忆（memory）：按会话分目录，按成员分文件

**磁盘结构**（[memory.js:1-6](../src/memory.js#L1-L6)）：

```
data/memory/group_123/<QQ号>.json     ← 一个群友一个文件
data/memory/group_123/_meta.json      ← 整理冷却时间
data/memory/private_456/<QQ号>.json
```

成员文件形状：`{ userId, name, impressions: [{content, createdAt}], updatedAt, lastConsolidatedAt }`。

| 特性 | 实现 |
|---|---|
| 会话隔离 | 目录名 = `chatKey.replace(/[^a-z0-9_]/gi,'_')` → `group_123` |
| 群友身份 | 文件名优先用 QQ 号（`<QQ>.json`）；无 QQ 号时 `_n_<名字>.json` |
| 同名去重 | 拿到 QQ 号后自动合并 `_n_` 文件，写回 QQ 号文件（[#mergeNameDuplicates](../src/memory.js#L165)） |
| 旧版迁移 | `data/memory/group_123.json`（单文件）首次访问自动迁移到目录，旧文件移入 `backups/`（[#migrateLegacy](../src/memory.js#L100)） |
| 缓存 | `cache: Map<chatKey, Map<userId, member>>`（[memory.js:79](../src/memory.js#L79)） |

**注入提示词的口径 = "真的出现在本次提示词里的群友"**（[prompt.js:807-825](../src/prompt.js#L807-L825)）：

- 标准模式：触发者 + 已读窗口里出现的人
- 锚定模式：**锚点成员集**（不随追加条目扩展，保证前缀字节不变），新群友走【新加入成员】段
- 每人只带**最近 3 条**印象（[memory.js:467](../src/memory.js#L467)）
- 无 QQ 号的旧数据始终带上（[memory.js:461](../src/memory.js#L461)）

> 这个口径是被修过的：曾写死 `recent(12)`，与档位脱钩，导致模型看到历史里根本没出现过的群友印象。

**自动整理**（[#maybeConsolidateMemory](../src/orchestrator.js#L1458)）在会话结束后后台跑，**绝不阻塞聊天**：

- 触发条件二选一：全群印象总数超阈值 **或** 任一成员条数超上限
  （只看总数会在"人少"的群里彻底失灵：3 人各 1 条永远够不到阈值）
- 冷却 `consolidateMinIntervalMs`（默认 6h）
- 整理前整个会话文件夹备份到 `data/memory/backups/<会话>/`
- 整理模型可跟随聊天模型，也可指定专用模型（`memory.useChatModel` / `provider` / `model`）

### 3.3 聊天设置（store.*）：全局为主，按群为补

**唯一的按会话入口**是 [storeConfigForChat(chatKey)](../src/config.js#L682)，它把"全局 + 分群 + 时段"
合成一份**本轮立即生效的档位配置**。所有读取点都走它（orchestrator 共 5 处）。

**四象限决策**（[config.js:694-718](../src/config.js#L694-L718)）：

| `unifiedTier` | `peakSchedule.enabled` | 取值 |
|---|---|---|
| true（默认） | false | 全局滑条 `contextSliderPos` |
| true | true | 全局峰谷双点按时段取（高峰内/外） |
| false | false | 群有 `groupSliderPos[群号]` → 用它；否则全局滑条 |
| false | true | 群有 `groupPeakPos[群号]` → 按时段取 peak/valley；否则全局双点 |

配套约束与细节：

- **私聊永远跟随全局口径**（分群设置只对 `kind === 'group'` 生效）
- **峰谷语义**：高峰窗口内 = `peak.sliderPos`，窗口外**一律** = `valley.sliderPos`
  → `valley.start/end` 是死字段，`loadConfig` 时剔除（[OBSOLETE_PATHS](../src/config.js#L516-L519)）
- **指令禁言优先**：`commandMuteTier(chatKey) !== null` 直接返回 `{contextTier:1, randomPercent:0}`，
  在四象限之前短路（[config.js:684-688](../src/config.js#L684-L688)）
- **数组/映射型字段用 `__replace__` 约定整体替换**（普通深合并传 `{}` 删不掉已有键，[deepMerge](../src/config.js#L386-L405)）

**其他按会话键控的设置**：

| 字段 | 键形式 | 语义 |
|---|---|---|
| `blocklist` | `{ [群号]: [QQ号,…] }` | 按群屏蔽某群员：不存档、不触发、不进提示词 |
| `globalBlocklist` | `[QQ号,…]` | 对**所有群+私聊**生效（与云端名单合并、可本机豁免） |
| `commandMute.active` | `{ [群号]: 到期时间戳 }` | 0 = 直到手动解除 |
| `groupSliderPos` / `groupPeakPos` | `{ [群号]: … }` | 仅 `unifiedTier === false` 时读 |
| `personaByChat` | `{ [群号或QQ号]: … }` | 仅 `personaUnified === false` 时读 |
| `memberNotes` | `{ [QQ号]: 备注名 }` | 影响提示词里的称呼（含人名匹配） |

**不是按会话的**（容易误以为可以）：`allow` / `deny` 是**列表**（含即放行/拒绝），
`allowAllWhenEmpty` 是全局兜底；`send.*` 限频参数是全局的，但**计数状态按 chatKey 分桶**
（[sender.js:51-52](../src/sender.js#L51-L52)）；`tools.*`、`skills.*`、`api.*` 全全局。

### 3.4 存档（store）：触发批 / 已读 / 未读的状态机

[ChatStore](../src/store.js#L46) 的读状态语义是整个触发体系的地基：

| 方法 | 语义 | 谁调用 |
|---|---|---|
| `appendIncoming` | 追加未读条目 | app.js ingest |
| `markEntryRead` | 只标**这一条**已读（不取走） | onIncoming 不触发时 |
| `markAllRead` | 全部标已读，不取走 | 机械批全不命中时 |
| `drainUnreadFrom(chatKey, fromTs)` | fromTs **之后**进批；之前的标已读沉历史 | wake 取触发批 |
| `drainUnread` | 全部取走 | 主动机会 |
| `markUnreadInWindow` | 时间窗内已读翻回未读 | 手动重试失败会话 |
| `peekUnread` | 只读不消费 | 等待会话摘要 |

`drainUnreadFrom` 是**触发链路重做的核心补丁**：磁盘上可能遗留旧进程/暂停期间攒下的积压未读，
它们从未经过逐条判定，若被一次 drain 全吃进触发批，模型会看到一大坨"未读信息"
→ 用户看到的就是"积压被整批塞进唤醒"（[store.js:142-155](../src/store.js#L142-L155)）。

**过滤规则**（[buildPastState](../src/prompt.js#L518-L544)），顺序为：
剔除触发批 id → 撤回的（`recalled`）→ **拍一拍**（`isPoke`，避免教模型复读）
→ 全局屏蔽 → **按群屏蔽** → `slice(-maxLimit)`。

后两条是**屏蔽名单的历史兜底**：入口拦截只管新消息，这里管"屏蔽生效前已存档的老库存"
（[prompt.js:529-538](../src/prompt.js#L529-L538)）。仅带图消息带 `#id`
（纯文本历史行不带，避免整屏数字噪音）。

### 3.5 技能与插件（extensions）：开关全局，运行期可按会话

> **本节已随"会话级配置"重构更新。** 历史版本断言"按会话的扩展配置不存在" ——
> 那只对**技能开关的存储**成立；现在 `config.chatProfiles` 提供了真正的会话级
> 配置层，而运行期上下文一直就带 `chatKey`。

**技能开关的存储仍是全局**：`config.skills[id].enabled`
（[isSkillEnabledInConfig](../src/skills/config.js#L28-L32)）。它现在接受第三个可选参数
`skillsCfg`，但**默认仍读全局**，签名里没有会话参数。

**会话覆盖走 `config.chatProfiles[chatKey].skills`**，由 `skillsViewForProfile()`
（[chat-profile.js](../src/chat-profile.js)）用原型委托叠到 SkillManager 实例上 ——
不改那个类的公开行为，且**没有覆盖时原样返回单例**（这是阶段 1 零行为变更的关键）。

**最终生效 = `isActive()` = loaded && enabled && available**
（[manager.js:207-218](../src/skills/manager.js#L207-L218)，注释称"所有'这个功能能不能用'判断的唯一出口"）。

**四层状态模型**（可解释，不是笼统的"工具关闭"）：

| 层 | 问题 | 错误码 |
|---|---|---|
| loaded | 加载成功了吗？（清单/入口/setup 抛错） | `skill-not-loaded` |
| enabled | 用户开了吗？（唯一开关） | `skill-disabled` |
| available | 依赖满足吗？（requires 能力、自检 available()） | `capability-missing` / `skill-unavailable` |
| active | 上面三者都过 | — |

**但插件确实能按会话** —— 通道是 `runtimeContext`：

```js
const skillContext = { chatKey, kind, chatId, chatName, model, provider,
                       visionEnabled, searchEnabled, proactive, sessionId };   // orchestrator.js:762
```

这份上下文被传给：
- `skills.isActive(id, context)` → 插件的 `available(ctx)` 可**按 chatKey 自行判断**
- `skills.getToolGuards(context)` → `tool.guard` 能力可**按 chatKey 否决某个工具**
  （[tool-registry.js:198-209](../src/tool-registry.js#L198-L209)）
- 全部 5 个 hook：`before-context` / `before-llm-messages` / `after-response` / `before-tool` / `after-tool`
- `getPromptSections(context)` → 提示词片段也能按会话变化

> **结论（重构后更新）**：技能开关的**存储**是全局的（`config.skills[id].enabled`），
> 但有两层"按会话"：
> 1. **配置层**（新增）：`config.chatProfiles[chatKey].skills[id].enabled` 由
>    `skillsViewForProfile()` 覆盖全局值 —— 现在"某技能只在 A 群开"**是开箱配置项**。
> 2. **运行期层**（一直都有）：扩展自己读 `ctx.chatKey` 实现更细的条件判断。
>
> ⚠️ 下面这份"五处独立证据"记录的是**重构前**的状态，保留它是为了说明当年为什么
> 判定"不存在"：其中第 1、2、3 条在重构后已不成立（分别多了 `skillsCfg` 参数、
> 多了 `chatProfiles` 维度、预览端点已接受 `chatKey`）。

**"同一工具在群 A 与群 B 表现不同"的机制**（配置层已就位，运行期仍有三条途径）：

| 途径 | 机制 | 效果 |
|---|---|---|
| 0. **配置层覆盖**（新增） | `chatProfiles[A].tools/skills` | 核心直接产出不同工具集，**不需要扩展写任何代码** |
| a. 提供者按会话失活 | `available({chatKey})` 对 A 真、对 B 假 | `getCapabilityProviders` 过滤后提供者集合不同 → 该能力在 A 生效、在 B 消失（[manager.js:374](../src/skills/manager.js#L374)） |
| b. guard 按会话否决 | `tool.guard({toolId, tool, context})` 返回 `{ok:false, reason}` | 该工具在 A 的 tools 列表里有、B 里没有（[tool-registry.js:199-206](../src/tool-registry.js#L199-L206)） |
| c. 钩子/片段按会话加工 | hook 与 `promptSections(ctx)` 读 `ctx.chatKey` | 同一条拼装路径产出不同内容（[orchestrator.js:816-822](../src/orchestrator.js#L816-L822)） |

代码里**真实存在**的按会话调用点：`chat.ban-state` 传 `{chatKey, kind:'group'}`
（[orchestrator.js:1409-1410](../src/orchestrator.js#L1409-L1410)、[app.js:1077](../src/app.js#L1077)）、
`message.owner-check` 传完整 `skillContext`（[orchestrator.js:793-804](../src/orchestrator.js#L793-L804)）、
reply 链路 `#capFirst(name, skillContext)`。

> ⚠️ **口径分裂风险（已有代码事实）**：**不带 ctx 的能力解析路径**会以"空上下文"参与
> `isActive` 判定，从而可能被排除、或选中的提供者与实际会话不一致：
> `resolveCapabilityFn`（[prompt.js:305-311](../src/prompt.js#L305-L311)）、
> `normalizeInlineAt` / `transcribeVoice`（[onebot.js:19](../src/onebot.js#L19)、[:38](../src/onebot.js#L38)）、
> `media.download`（[app.js:965](../src/app.js#L965)）、video-reader（[video-reader.js:134](../src/video-reader.js#L134)、[:258](../src/video-reader.js#L258)）、
> `image.mime-support`（[tools.js:1029](../src/tools.js#L1029)）、`llm.endpoint-*`（[llm.js:279](../src/llm.js#L279)、[:501](../src/llm.js#L501)）、
> 以及扩展互调 `api.capability()` **固定传 `{}`**（[plugin-loader.js:109-114](../src/plugin-loader.js#L109-L114)）。
>
> **UI 与运行时的口径分裂同理**：设置页与提示词预览用的 runtimeContext **没有 chatKey**
> （[routes.js:67-84](../src/routes.js#L67-L84)、[routes.js:750-757](../src/routes.js#L750-L757)），
> 而运行时带 chatKey。若某扩展的 `available()` 依赖 chatKey，
> **UI 会显示"生效中/工具可用"，实际在某会话不可用**。
>
> **重构后已部分修复**：`skillRuntimeContext(chatKey)` 现在接受会话参数
> （[routes.js:67-104](../src/routes.js#L67-L104)），`/api/prompt-preview` 也接受
> `chatKey` 并按该会话快照组装（[routes.js:750-790](../src/routes.js#L750-L790)）——
> 于是"同一 chatKey 下 UI 与运行时同判据"成立。
> **仍未处理**：无 chatKey 的路径（`api.capability()`、`resolveCapabilityFn` 等）
> 依旧以空上下文解析，属于"有意为之的边界"，见 §12 的扩展边界说明。

**工具可用性的唯一口径**：[getToolAvailability()](../src/tool-registry.js#L126) 的 **8 道闸门**
（文档写的是 7 道，漏了第 5.5），顺序即优先级（上游不过就不看下游，保证 reason 指向真正原因）：

| # | 闸门 | 条件 | code |
|---|---|---|---|
| 0 | 未注册 | registry 无此 id | `skill-not-found` |
| 1 | 工具总开关 | `toolsCfg.enabled === false` | `tools-disabled` |
| 2 | 所属 Skill 生效 | `skills.isActive(skillId, runtimeContext)` 不通过 | 透传 `st.code` |
| 3 | 工具级能力依赖 | `def.requires[]` 逐个 `explainCapability().available === false` | `capability-missing` |
| 4 | 分类开关 | `toolsCfg.categories[category] === false` | `category-disabled` |
| 5 | 单工具 override | `override === undefined ? defaultEnabled!==false : override!==false` | `tool-disabled` |
| **5.5** | **跨会话发送** | `def.id === 'send_to' && crossChatSend !== true` | `tool-disabled` |
| 6 | 运行期依赖 | `requiresVision && !visionEnabled` → `no-vision`；`requiresSearch && !searchEnabled` → `no-search` | — |
| 7 | `tool.guard` 附加否决 | 每个 active guard 返回 `false` 或 `{ok:false}` | `skill-guard` |

> 为什么必须集中在一处：以前 orchestrator 里散落着五层条件，加 Skill 后又到处各判一半，
> 必然出现"UI 说能用、运行时空工具列表"的割裂（[tool-registry.js:21-24](../src/tool-registry.js#L21-L24)）。
>
> `skills` 参数**缺省回落到全局单例而不是跳过检查** —— 曾经默认 `null`，导致"调用方忘了传"
> 会让整段技能开关检查静默失效（[tool-registry.js:131-144](../src/tool-registry.js#L131-L144)）。
>
> **关闭 Skill 不会注销它注册的工具** —— registry 里仍然存在，只是被第 2 闸隐藏；
> 真正回收要 `dispose` / `unregister`（[plugin-loader.js:433-435](../src/plugin-loader.js#L433-L435)、
> [tool-registry.js:65-74](../src/tool-registry.js#L65-L74)）。

**两型扩展的判据**（[manifest.js:26-41](../src/skills/manifest.js#L26-L41)）：

| 类型 | 目录 | 生效方式 | 谁决定何时执行 |
|---|---|---|---|
| 确定性型（plugin） | `plugins/<id>/` | `providers`（能力）/ `hooks` | **核心代码**：满足条件必然执行，不经过 LLM |
| LLM 型（skill） | `skills/<id>/` | `registerTool` + 提示词片段 | **模型**：看工具说明自己判断 |

**清单文件功能等价**：`plugin.json` 与 `skill.json` 走同一条 `normalizeManifest`，
目录只决定语义分类，不限制可用特性。

**提示词片段的优先级护栏 —— 澄清一个常见误解**：

真正生效的强制手段是**位置硬编码**：所有核心段是 `parts` 数组字面量
（[prompt.js:247-275](../src/prompt.js#L247-L275)），技能片段只能 `push` 到其后
（[prompt.js:278](../src/prompt.js#L278)）；代码里**不存在**"核心=priority 100、技能≤99
所以排在后面"的数值比较。`priority` 只在**技能块内部**决定先后（数值大的更靠前）。

配合的两道归一化封顶（属约定 + 文档级保证）：

- manifest 层：`priority: Math.min(99, …)`，注释写明"Skill 不得覆盖核心安全规则"
  （[manifest.js:118-128](../src/skills/manifest.js#L118-L128)）
- 动态 `promptSections()` 层：`Math.min(99, …)`，默认 40（[manager.js:443-455](../src/skills/manager.js#L443-L455)）
- `prompt.js` 内默认 50 + 稳定排序（`sort(priority 降序 || __seq 升序)`），
  注释说明这是防止 `sort` 不稳定让 `nsfw-gate(99)` 这类动态段时前时后、字节布局抖动
  → 前缀缓存命中率大幅波动（[prompt.js:222-228](../src/prompt.js#L222-L228)）

⚠️ **一个由此产生的顺序细节**：`extraSections`（主人规则，注入 `priority: 72`，
[orchestrator.js:819-821](../src/orchestrator.js#L819-L821)）与技能片段进入**同一个**排序列表，
所以 priority > 72 的技能段会渲染在主人规则**之前**。另外 `prompt.js` 层不去重
（manager 层按 `id` 去重），技能与 `extraSections` 撞 id 会各渲染一份。

### 3.6 耦合一览表（回答本问的核心）

> ⚠️ **表内标注"全局"的三行已随"会话级配置"重构改变**：现在都可以被
> `config.chatProfiles[chatKey]` 覆盖，且**判据统一来自 `resolveChatProfile(chatKey)`**。
> 这是本次重构的落点 —— 详见 §3.7。

| 维度 | 按会话？ | 键 / 机制 | 读取函数 | UI 开关 |
|---|---|---|---|---|
| 人设 | ✅ 可选 | `personaByChat[群号/QQ号]`、`chatProfiles[k].persona` | `resolveChatProfile().persona` | `personaUnified` |
| 记忆 | ✅ 天然 | 目录 `memory/<group\|private>_<id>/<QQ>.json` | `MemoryStore.*` | — |
| 存档 | ✅ 天然 | 文件 `messages/<group\|private>_<id>.json` | `ChatStore.*` | `store.maxMessagesPerChat` |
| 响应档位 | ✅ 可选 | `groupSliderPos` / `groupPeakPos`、`chatProfiles[k].store` | `resolveChatProfile().store` | `unifiedTier` |
| 屏蔽 | ✅ | `blocklist[群号]`、`globalBlocklist`（进快照） | `resolveChatProfile().blocklist` | — |
| 指令禁言 | ✅ | `commandMute.active[群号]` | `resolveChatProfile().store` | `commandMute.enabled` |
| 活跃模式 | ✅ 运行期 | `activeTopics: Map<chatKey,…>` | `#activeState` | `chatActive.enabled` |
| 前缀缓存锚点 | ✅ 运行期 | `promptAnchors: Map<chatKey,…>` | `buildUserPrompt` | `store.promptAnchor` |
| **配置指纹** | ✅ 运行期 | `profileFingerprints: Map<chatKey,…>` | `#resetAnchorIfProfileChanged` | — |
| 限频/去重 | ✅ 状态分桶 | sender 的 `chains/minuteTimes/hourTimes/recentSent` | `SendQueue` | `send.*`（参数全局） |
| 会话记录 | ✅ 天然 | `session.chatKey` | `SessionRegistry` | `store.keepSessionFiles` |
| 主人人设 | ✅ 运行期 | `message.owner-check` 能力 | orchestrator | 插件开关 |
| **技能/插件** | ✅ 可覆盖 | `chatProfiles[k].skills` → `skillsViewForProfile` | `isSkillEnabledInConfig(id, dflt, skillsCfg)` | 技能页（全局） |
| 工具开关 | ✅ 可覆盖 | `chatProfiles[k].tools` | `resolveChatProfile().tools` | 工具页（全局） |
| API/模型/搜索 | ✅ 可覆盖 | `chatProfiles[k].api` / `.webSearch` | `resolveChatProfile().api` | 设置页（全局） |
| 能否看图 / 有无联网 | ✅ 派生 | `visionEnabled` / `searchEnabled`（只算一次） | `resolveChatProfile()` | `api.vision` / `webSearch.enabled` |

### 3.7 会话级配置的解析机制（重构新增）

**一句话**：per-chat 配置的合并**只有一处实现**（`src/chat-profile.js`），
运行开始解析一次成快照，然后由两个边界注入。

```
config.json                        ┌──────────────────────────────────────┐
├─ persona / store / tools /   ──▶ │  buildChatProfileFrom(cfg, chatKey)  │
│  skills / api / webSearch        │  —— 唯一做合并的地方（纯函数）        │
├─ personaByChat  (legacy 兼容)    │  · persona/store 复用既有折算函数     │
└─ chatProfiles[chatKey]  (新增)   │  · tools/skills/api/webSearch 白名单  │
      ↑ 只存用户显式改过的字段     │  · 算出 visionEnabled/searchEnabled   │
      （稀疏覆盖）                 │  · 生成 fingerprint（锚点失效用）     │
                                   └──────────────┬───────────────────────┘
                                                  │ 快照（深拷贝，运行内不变）
                    ┌─────────────────────────────┼─────────────────────────────┐
                    ▼                             ▼                             ▼
        buildSystemPrompt({profile})   buildUserPrompt({profile})   getToolAvailability({toolsCfg, skills})
        → qqSceneRules 的看图/联网行    → 记忆条数/屏蔽/备注          → 工具表（模型实际看到什么）
                                                │
                                                └─ skillContext.profile → 扩展的 available/guard/hook
```

| 要点 | 说明 |
|---|---|
| **存储 vs 快照分离** | `chatProfiles[chatKey]` 是**稀疏覆盖**（只放用户改过的字段），快照是**解析后的完整视图**。两者必须分开：`enabled:false` 与"没这个键"语义不同，靠合并时"缺失即回落全局"实现 |
| **键格式** | 新命名空间**只用完整 chatKey**（`group:123`）。`personaByChat` 的裸 id 兼容是历史包袱，读侧保留、写侧不再新增 |
| **快照不可变** | 运行开始解析一次，运行内不变 → 用户跑到一半改配置，不会让同一次运行的"系统提示"与"工具列表"自相矛盾 |
| **无缓存（有意）** | 调用点都不热（wake 每会话每批一次；onIncoming 只在未命中触发判定时解析）。加缓存要处理失效，而"配置变了缓存没生效"极难定位 |
| **密钥不进快照** | `api` 段只保留 `model/provider/vision/video`（`API_SNAPSHOT_FIELDS`）。快照会进 `skillContext`（→ 扩展，同进程无沙箱）、会话记录、UI 预览 —— 明文 Key 没有理由跟着流动 |
| **扩展边界** | **只有知道 chatKey 的路径才吃会话值**。`api.capability()` / `resolveCapabilityFn` 等空上下文路径一律走全局档 —— 这是有意的，别硬塞 chatKey 进去 |
| **提示词锚点联动** | 配置一变，上一轮前缀不再是本轮合法前缀 → `#resetAnchorIfProfileChanged` 按 `fingerprint` 清锚点，避免"旧人设基线 + 新人设追加段"的角色串味 |

**静态守卫**：`test/tools-skill-audit.mjs` 第十七节断言
① `prompt.js` 的配置读取只在顶部 helper 区且一律带 `profile` 优先兜底；
② orchestrator 不再直接调用 `storeConfigForChat`/`personaForChat`；
③ 可覆盖路径表与 api 快照白名单都不含密钥字段。
**一个 `getConfig()` 直读在功能上完全正常、review 也看不出问题，但它就是"同一件事两个真相"的种子** —— 所以只能靠静态检查守住。

**测试**：`test/chat-profile-test.mjs`（61 项，纯解析层）+ `test/chat-profile-runtime-test.mjs`
（5 项，真实链路：配置 → 消息 → orchestrator → 最终发给模型的 tools 数组）。

---

## 4. 提示词拼装管线

### 4.1 系统提示（[buildSystemPrompt](../src/prompt.js#L212)）— 静态为主，越靠前越稳定

段序固定：身份句 →【安全规则】→【工作方式】→【反 AI 味】→【保持主体性】→【该说/不该说】
→【群聊不是客服队列】→【像真人一样】→【不要当群管家】→【引用与点名】→【轻量记忆】
→【表情包策略】→【QQ 场景规则】→【发送与汇报禁令】→ **【可用技能】** →【管理员附加规则】

- 随档位改写：`speakOrNot(participation)`、表情包积极程度
- 条件增删：`qqSceneRules(profile)` 按**快照的** `visionEnabled` / `searchEnabled` 决定文案
  —— 与工具闸门同源，不再各自判断（见 §11.1b）
- 动态段一律**殿后**：`skillSections` 含随会话变化内容时必须追加到末尾 —— 插在中间会把
  后面所有核心规则的字节位置推移，系统提示的缓存前缀（token 大头）直接归零
  （[prompt.js:218-221](../src/prompt.js#L218-L221)）

**覆盖模式**（`persona.systemPromptOverride` 非空）：人格/风格类准则整体被替换，
但 **`securityRules()` 与 `toolProtocol()` 强制保留并追加在后面** ——
防止一次配置失误删掉"不执行本地操作/不泄露密钥/工具协议"整套底线
（[prompt.js:230-245](../src/prompt.js#L230-L245)）。

### 4.2 用户提示（[buildUserPrompt](../src/prompt.js#L708)）— 按"变化频率"排序

```
【角色设定】      会话级人设 roleText（与系统提示同源 personaForChat）      稳定
【可用表情包】    按使用次数排序 + 按时间轮换一半（按轮次播种，同轮稳定）    半稳定
【引导说明】      固定 4 条                                             固定
【记忆】          只带"真的出现在本次提示词里"的群友印象（每人最近 3 条）   滚动 ← 锚点前缀起点
【已读信息】      锚定=锚点条目 / 标准=滑窗条目                           滚动
【新已读信息】    锚定模式专有：锚点之后新沉淀的已读条目                    易变
【未读信息】      触发批，每条带标签（@我/提到我/提问/引用/拍我）          必变
【新加入成员】    锚定模式专有：追加窗口里新群友的印象（殿后，不打断前缀）    易变
【活跃模式】      chatActive 话题锚点 + 偏离判断要求                     条件
【当前时间】      精确到秒 → 必然每次不同，所以放**最末**                  必变
```

> 【此刻状态】段（群名/消息密度/距上次发言）已于 2026-09-25 **整体删除**：
> 这些信息模型从已读信息的时间戳与内容里能自然感知，单独罗列反而助长"汇报式"开场
> （[prompt.js:848-851](../src/prompt.js#L848-L851)）。

### 4.3 提示词锚点：把前缀缓存做深

问题：连续触发时两次运行的【已读信息】+【记忆】高度相似但**不相同** ——
标准结构里已读窗口整体前滚（BCDEF→CDEFG），前缀字节一变，缓存全灭。

方案（[resolvePromptAnchor](../src/prompt.js#L628)、[buildUserPrompt](../src/prompt.js#L728-L769)）：

- 复用上一轮【记忆】+【已读信息】前缀，本轮只在其后**追加**新沉淀的已读条目 →【新已读信息】
- 新增群友的印象放【新加入成员】（靠后，不打断前缀）
- 追加条数超过 `maxExtraRead` → **整体重置**，回到标准窗口重新锚定
  （理由：已读信息按条计费，无限追加是"为了省钱花更多钱"）
**重置条件**（`freshAnchor()`，全部落到 `mode='reset'`，[prompt.js:640-677](../src/prompt.js#L640-L677)）：

1. 没有上一轮锚点，或 `readIds` 为空
2. 出现**锚点成员集之外的新群友**（`hasNewMember`）
3. 锚点首条 id 已滚出全量池（`start < 0`）
4. 锚点 id 序列与全量池前缀**不对齐**（含中间被删的情况）
5. 锚点条目在池中缺失
6. 追加条数 `> maxExtraRead`（追加预算超限）

> 第 2 条的口径值得注意：新成员集合取的是「全量已读池 **∪ 本轮触发批**」的差集
> （[prompt.js:740-744](../src/prompt.js#L740-L744)）—— 新群友第一次发言时他还在触发批里，
> 只取已读池会漏算，从而错过 reset 时机。

**六种重置条件**之外，还有两条已修的口径（2026-09-26）：

- **锚定轮不受 `historyCount` 截尾**：锚定成立时已读部分 = 锚点数 + 追加数，**可以超过** `historyCount`，
  上限由 `maxExtraRead` 封顶；不成立才回到滑窗（[prompt.js:594-600](../src/prompt.js#L594-L600)、[prompt.js:722-726](../src/prompt.js#L722-L726)）
- `session.pastStateCount` 写的是**模型实际看到的条数**（[prompt.js:767-774](../src/prompt.js#L767-L774)），
  供 `get_recent_messages` 做 offset 补偿（[tools.js:484](../src/tools.js#L484)）——
  注释指出该属性此前**从未被赋值**，导致翻页工具恒返回重复内容

状态存 `promptAnchors: Map<chatKey, {readIds, readCount, memberIds}>`；
重启丢失 → 回标准结构，无害（[orchestrator.js:61-66](../src/orchestrator.js#L61-L66)）。

---

## 5. 会话记录与无状态语义

**一次 agent 处理 = 一个会话 = 一个 `data/sessions/<id>.json`**（[sessions.js](../src/sessions.js)）。

会话对象关键字段（[sessions.js:265-294](../src/sessions.js#L265-L294)）：
`id / chatKey / startedAt / status / trigger / triggerText / systemPrompt / userPrompt /
model / rounds / messages / sent / feedbacks / finishReason / usage`

**status 取值**：`waiting | running | done | noreply | error | aborted`

| 机制 | 目的 | 位置 |
|---|---|---|
| 索引缓存 `session-index-cache.json` | 启动加速：2277 文件/178MB 要 25s → 单文件 3ms | [sessions.js:9-13](../src/sessions.js#L9-L13) |
| 后台对账 `reconcileInBackground` | 缓存只是快路径，不阻塞请求 | [sessions.js:216](../src/sessions.js#L216) |
| 僵尸回收 | 上次进程异常退出遗留的 running/waiting 启动即改判 `aborted`（只扫最近 3 天） | [sessions.js:142](../src/sessions.js#L142) |
| 落盘节流 2s/会话 | `activity` 每轮翻转 2 次，逐次同步写整个 JSON 会阻塞 event loop | [sessions.js:533](../src/sessions.js#L533) |
| `discard` vs `finish` | "压根没开始"（未触发）要干净消失，不留"中止"记录；跑过并烧了 token 的必须走 finish 保账 | [sessions.js:368-393](../src/sessions.js#L368-L393) |

**无状态的三条保证**：
1. `messages` 数组**每次运行重建**（`[{system}, {user}]` 只有两条，之后是工具循环增长）
2. 会话结束即 `runningChats.delete`，LLM 侧零历史可复用
3. 跨运行的信息只通过**记忆工具持久化**（`data/memory/`）与**存档**（`data/messages/`）传递

**重试的双重护栏**（[orchestrator.js:577-611](../src/orchestrator.js#L577-L611)）：
- 单次 API 请求内部已重试（`chatCompletionWithRetry`）
- 会话级重试只在**整轮失败**时触发，且硬条件：`canRetry = attempt < MAX && isRetryableError && sentCount === 0 && !aborted`
- **已发出过消息绝不自动重试** —— 重试会让群里看到两遍同样的话

**同一会话严格串行**（四道闸门都只看 `runningChats` 这一个集合）：
- `onIncoming` 开头 `if (this.runningChats.has(chatKey)) return;`（运行期消息只入库，由会话结束的 drain 路径补判）
- `wake` 入口同款检查；倒计时到点再查一次（命中则 `#finishWaiting(aborted)`）
- `retrySession` 开头拒绝正在运行的会话
- `activeRuns` 是 `Map<chatKey, sessionId>` —— 每个 chatKey 一个运行槽

不同会话并行，受 `maxConcurrentRuns`（默认 2）限流。

> ⚠️ **一处窄竞态（代码阅读所得，未运行验证）**：`wake` 入口的闸门与 `runningChats.add()`
> 之间隔着一个 `await`（群聊禁言预检），且**没有互斥锁，只有这一个集合**。
> 若第二个 wake 的定时器恰好在这次往返内到点，入口检查看不到 chatKey，
> 理论上可进入第二次运行（`activeRuns` 被覆盖、`finally` 提前释放）。

---

## 6. 工具与会话的绑定（安全边界的关键）

工具执行现场是 orchestrator 组装的单个 `ctx` 对象（[orchestrator.js:907-921](../src/orchestrator.js#L907-L921)）：

```js
const ctx = {
  chatKey, kind, chatId,     // ← 会话边界
  selfId, selfNickname, botName,
  onebot, store, memory, stickers, sender, session, reminders, videoReader,
  emit
};
```

**每一个工具都从 `ctx.chatKey` 取会话**，从不自己拼群号（`tools.js` 中 `ctx.chatKey` 出现 20+ 次）。
`send_message` 的描述里直接写死"本工具只能发到本次会话对应的群/私聊"
（[tools.js:162](../src/tools.js#L162)）。

**唯一的例外 `send_to`**（跨会话发送，默认关），三道硬校验
（[tools.js:218-241](../src/tools.js#L218-L241)）：

1. 可用性层拦截：`crossChatSend !== true` → 工具**根本不进模型列表**（第 5.5 层）
2. 执行期再查一次开关（描述里的引导不是安全边界）
3. 目标必须在白名单内，且**空名单口径必须与消息入口 `app.allowed()` 一致**
   —— 曾经入口拒收私聊、`send_to` 却能替模型发给任意私聊 QQ，同一概念两处判定相反

**发送一律走 `ctx.sender`**（[sender.js](../src/sender.js)）：队列化、限频、去重、超长切分、
CQ 转义、失败留档六件事都在里面。直调 `onebot.send*` 会跳过全部 ——
审计脚本有一条静态检查专门抓这个（[doc/extend_development/skill-development.md:304](extend_development/skill-development.md)）。

---

## 7. 运行期按会话的状态（不在 config.json 里）

这些状态**只活在内存**，重启丢失且无害：

| 结构 | 位置 | 丢失后果 |
|---|---|---|
| `runningChats` / `pendingWake` / `pendingSessions` / `verifiedWakes` | [orchestrator.js:45-47](../src/orchestrator.js#L45-L47) | 无（重建） |
| `activeTopics`（活跃模式话题锚点） | [orchestrator.js:60](../src/orchestrator.js#L60) | 回普通档位 |
| `promptAnchors`（前缀缓存锚点） | [orchestrator.js:66](../src/orchestrator.js#L66) | 回标准提示词结构 |
| `sessionAbortMarks` / `sessionAbortControllers` | [orchestrator.js:51-52](../src/orchestrator.js#L51-L52) | 中止能力丢失 |
| `runSeq`（第几次处理） | [orchestrator.js:53](../src/orchestrator.js#L53) | 表情包轮换重新播种 |
| sender 的 `chains` / `minuteTimes` / `hourTimes` / `recentSent` | [sender.js:50-53](../src/sender.js#L50-L53) | 限频与去重窗口清零 |
| `consolidating`（正在整理记忆的会话） | [orchestrator.js:48](../src/orchestrator.js#L48) | 可能重复整理一次 |

**活跃模式状态机**（[orchestrator.js:1195-1220](../src/orchestrator.js#L1195-L1220)）值得单列：
1/2/3 档被召唤响应后，模型若在 `finish` 时带回 `activeTopic` → 该群进入活跃期（TTL 默认 30min）
→ 活跃期内**忽略档位判定必响应**，提示词注入话题锚点让模型自判是否仍在话题上
→ 偏离则 `finish("话题结束")` 退出。设计意图是"开始活跃容易、停下由模型自主判断"，
恰好是档位系统的反向补充；TTL 兜住"模型忘了结束"。

---

## 8. 数据目录（全部挂在 `DATA_DIR` 下）

**多实例**：`QQ_AGENT_PROFILE=2` → 数据目录变 `data-2/`、端口整体 **+100**（避免实例互撞）。
必须在 `config.js` 顶部生效 —— `DATA_DIR` 是进程根路径，晚一步设置就会有一部分文件写到主实例目录里，
造成两个实例数据互相污染（[config.js:11-24](../src/config.js#L11-L24)）。

```
data/
├─ config.json                  全量配置（含明文 Key，唯一真相）
├─ messages/<chat>_<id>.json    每会话消息存档（未读状态、media、atMe 标记）
├─ memory/<chat>_<id>/<QQ>.json 每会话每群友的印象
│  ├─ _meta.json                整理冷却时间
│  └─ backups/                  整理前备份（保留最近一次）
├─ sessions/<id>.json           每会话记录（提示词、消息流、工具调用、用量）
├─ session-index-cache.json     会话索引缓存（启动加速）
├─ usage-today.json             今日用量汇总
├─ telemetry-totals.json        匿名累计（调用次数 + 三档 token 数，无身份信息）
└─ …（表情库、提醒、日志、云端屏蔽名单缓存等）
```

**配置写入的三条防呆**（[updateConfig](../src/config.js#L594)）：
1. `stripDerivedFlags` —— 剔除 `hasXxx` 派生字段（前端把它们当配置回传会污染 config.json）
2. `stripObsoleteFields` —— 剔除已废弃字段（否则旧值继续冒充"生效配置"）
3. `preserveSanitizedSecrets` —— 数组型密钥容器按 id 回填现值
   （前端拿到的是脱敏配置，回传时光 Key 天然缺失；对象型靠 deepMerge 保住，**数组型整体替换会静默清空**）

**配置损坏不静默回落**：解析失败先把坏文件改名备份为 `config.json.corrupt-<时间戳>` 并打 error 日志，
绝不直接返回默认值 —— 否则下一次任何 `updateConfig`（比如 5 分钟一次的云端名单同步）
都会以默认配置为底整体写回，把用户的 Key/白名单/人设静默抹成出厂值（[config.js:413-432](../src/config.js#L413-L432)）。

**一个容易踩的坑**：`contextTier` / `randomPercent` 是**派生字段**，由 `updateConfig` 依据
`store.contextSliderPos` 重算并覆盖（[config.js:611-619](../src/config.js#L611-L619)）。
但该重算**只在 patch 里带 `contextSliderPos` 时才触发** —— 手改 config.json 里的 `contextTier`
在下次保存滑条时会被抹掉。**滑条位置才是唯一真相。**

**旁路字段**：`memberNotes`（`{ [QQ号]: 备注名 }`）**不在 `DEFAULT_CONFIG` 里**，
由 [memory.js:305-309](../src/memory.js#L305-L309) 按需写入。它是 **per-QQ 全局**映射，
**不是 per-chat** —— 同一个 QQ 在所有群显示同一备注。

---

## 9. 扩展机制（两型）生命周期

```
loadPlugins()                                          plugin-loader.js:489
  ├─ loadSkillRoot(skills/)   → 逐个 loadSkillDir（串行，避免抢 id 时顺序不定）
  ├─ loadSkillRoot(plugins/)
  │    ├─ readManifest → normalizeManifest（补默认值/去重/筛非法，**不抛错**，交 problems）
  │    ├─ import 入口 → setup(api) → api.registerTool / 导出 providers+hooks
  │    ├─ lintKindPlacement：只有 providers 的模块放 skills/ → 警告（模型根本看不到它）
  │    │                     有工具却没 providers 的放 plugins/ → 警告
  │    └─ 失败也**带 loadError 注册进表**（UI 能看到"加载失败 + 原因"，而不是条目凭空消失）
  ├─ pruneMissing(aliveIds)   与磁盘对齐，卸载已删除目录的幽灵 Skill
  └─ 孤儿工具清扫            注册表里有 skillId、但本轮该 Skill 没注册的 id → 注销
watchPlugins()  fs.watch + 500ms 防抖 → 整体重扫（fs.watch 只给文件名不给语义，逐个重载不可靠）
refreshToolDefs()  热重载后必须重读快照
```

**热重载的语义与代价**：默认开（`config.extensions.hotReload`）。
等价于"任意落地的 JS 会被执行"，共享机器建议关掉。
覆盖注册时必须**先 deactivate 再 dispose** —— 历史上只调 dispose，
开发模式每次保存都会让 `activate` 里建的定时器/订阅永久泄漏（累积幽灵行为：重复推送、重复发言）。

**能拿到什么**（[createSkillApi](../src/plugin-loader.js#L71)）：
`registerTool` / `config()` / `isSkillActive(id, ctx)` / `log` / `fetch`（**仅声明 `permissions:["web_fetch"]` 时**）/ `utils`。

**hook 五时机**：`before-context`（加工触发消息/补上下文）→ `before-llm-messages`（原地改 messages）
→ `after-response` → `before-tool`（可返回 `{block:true, reason}` **否决**这次调用）
→ `after-tool`。hook 只能**追加/加工**，无法覆盖安全规则与工具协议。

**已知能力名**（[skill-system.md](extend_development/skill-system.md) 与代码一致的部分）：
`llm.request-params` / `llm.response` / `llm.usage` / `llm.retry-advisor` / `tool.guard` /
`media.download` 为**多提供者**（[MULTI_PROVIDER_CAPABILITIES](../src/skills/manager.js#L39-L46)），
其余单提供者：`message.speaker-format` / `message.inline-at-normalize` / `message.owner-check` /
`chat.ban-state` / `llm.endpoint-*` / `video.frames*` / `sticker.annotate*` / `model.thinking-detect` 等。

---

## 10. 与既有文档的偏差（已核实）

| 文档 | 声明 | 代码实际 |
|---|---|---|
| [prompt-pipeline.md:83](extend_development/prompt-pipeline.md#L83) | 用户提示含【此刻状态】段（第 6 段） | **已删除**（prompt.js:848-851 明写"此刻状态段已删除"），排序注释也不再包含它 |
| [skill-system.md:352-365](extend_development/skill-system.md#L352-L365) | 列出 10 个内置 Skill（speaker-identity、thinking-adapters…） | **本检出中 `skills/` 与 `plugins/` 目录都不存在**（`git ls-tree HEAD` 无这两项，工作树干净）。`loadSkillRoot` 会打 `⚠️ 目录不存在，已跳过`；因此全部技能类扩展当前不可用，走核心兜底路径（如 `formatEntry` 自拼 `名字(QQ:xxx)`） |
| skill-system.md:181-184 | `api.thinking` → `skills.thinking.enabled` | **不一致**：思考已收编进核心，迁移目标是 `api.thinkingMode`（[config.js:449-456, 464-474](../src/config.js#L449-L456)）。文档表格是旧版；`LEGACY_SKILL_MIGRATIONS` 实际只剩 3 条 |
| skill-system.md:346、skill-reference.md:249 | 「生产环境没有热重载」 | **反了**：默认**开启**（[config.js:364-366](../src/config.js#L364-L366)、[app.js:1622-1626](../src/app.js#L1622-L1626)）。该行与同文件 [config.js:361-363](../src/config.js#L361-L363) 的注释自相矛盾 |
| skill-reference.md:287-304、:649-668 | "核心实际消费 14 个能力名（已核对源码）" | 实际约 **24 个**（多出 7 个 `reply.*`、`video.frames.available`、`media.download`）。反向也有错：`model.thinking-detect` 在 `src/` **无消费方**（[routes.js:514](../src/routes.js#L514) 用的是 [thinking.js:35](../src/thinking.js#L35) 的 `detectDialect`）；`sticker.annotate*` / `image.random` / `media.download.bilibili\|douyin` / `llm.endpoint-snapshot` 在 `src/` 中**全无消费方**，属扩展自建名而被文档列为"标准能力名" |
| skill-system.md:163-171、skill-reference.md:976-988 | 可用性判定链 **7 步** | 实际 **8 步**（漏了 `send_to` 的跨会话闸，见 §3.5） |
| skill-reference.md:1021 | `npm run test:skillui` | `package.json` **无此脚本** |
| skill-system.md:382 vs skill-reference.md:1019 | test:skill「21 项」vs「36 项」 | 文档**内部**不一致（未运行测试以免写盘） |
| plugin-development.md:289-295 | 能力名冲突"审计会报" | 运行期**无**冲突检测，`MULTI_PROVIDER_CAPABILITIES` 仅被测试消费 |
| skill-system.md:63、skill-reference.md:586 | "核心安全规则恒为 100+" | 核心规则**不走 priority 机制**：片段并入 `skillSections` 后按 priority 降序，**整体**排在固定顺序的核心段之后；"100+" 只是文档说法（见 §3.5 的澄清） |
| scripts/judge-check.mjs:10 | `npm run check:judge` | import `../skills/reply-safety/salvage.js`（**不存在**）→ 该脚本**必然崩溃**，本检出不可用 |
| prompt-pipeline.md 全文行号 | `resolveContextTier` prompt.js:429 / `buildUserPrompt` prompt.js:545 / `#runAgent` orchestrator.js:597 / before-context :648 / 主人识别 :662 / 主动机会 :732 / before-llm-messages :740 / 循环 :800+ | **全线漂移**，实际依次为 **446 / 708 / 732（调用点 590）/ 776 / 793 / 868-870 / 876 / 933** |
| prompt-pipeline.md 第 0 步 | 四档各读 `atCount/keywordCount/randomCount/allCount` 条 | **已废弃**：四档统一 `historyCount`（默认 80），四个分档字段被 `OBSOLETE_PATHS` 剔除（[config.js:510-515](../src/config.js#L510-L515)） |
| prompt-pipeline.md | 段名【过去状态】/【本次唤醒】 | 现名**【已读信息】/【未读信息】** |
| prompt-pipeline.md | 用户提示顺序：…过去状态→记忆→**此刻状态**→本次唤醒… | 实际：**角色设定→表情包→引导说明→记忆→已读→新已读→未读→新加入成员→[活跃模式]→当前时间**；且【记忆】提到【已读信息】**之前**（锚点设计核心） |
| prompt-pipeline.md | 未提及 | **promptAnchor 整套机制**（文档最需要补的一节）、【活跃模式】段、`session.pastStateCount` 翻页补偿 |
| prompt-pipeline.md 第 5 步过滤 | 撤回 / 全局屏蔽 / 本群屏蔽 | 还多两条：**触发批 id 剔除**与 **`isPoke` 过滤** |
| prompt-pipeline.md【记忆】口径 | "触发者 + 过去状态里的人，每人最近 3 条" | 只适用**标准轮**；锚定轮改为"锚点成员集"，新成员另开【新加入成员】 |
| prompt-pipeline.md 覆盖模式 | "2~9 段被替换" | 表述含糊：实际替换**除【安全规则】【工作方式】以外的全部核心段**；技能段与管理员规则两种模式都追加 |
| prompt-pipeline.md 附录 | "两处完整提示词预览" | 预览只含**系统提示 + 工具清单**，**不含用户提示** → 会话级 / 主人级 `roleText` 的变化在预览里看不到 |

第三行需要特别注意：它是"文档滞后于一次架构回迁"，而前两行分别是"功能删除未同步文档"与
"仓库内容与文档不符"。三者都不影响运行正确性，但会让读者按文档预期去找不存在的东西。

> 另有两个文档未提、但影响实际拼装的实现细节：
> ① 活跃期会覆盖档位（[orchestrator.js:525-530](../src/orchestrator.js#L525-L530)）、
> 指令禁言会强制 1 档（[config.js:684-688](../src/config.js#L684-L688)），两者都在
> `storeConfigForChat` 之后改写判定，文档"第 0 步"未提；
> ② `buildUserPrompt` 的 `ctx` 里 `kind / chatId / chatName / runSeq / moreUnreadDuringRun /
> tierInfo / proactive / skillContext` 传入后**未被使用**，属冗余参数。

---

## 11. 已知缺口与静默失效点（代码阅读所得，除注明外未运行验证）

按"影响面 × 隐蔽性"排序。**这些不是本文的批判，而是读代码时发现、容易踩的事实记录。**

### 11.1 会静默失效的语义陷阱

| # | 事实 | 位置 | 后果 |
|---|---|---|---|
| 1 | **只有字面 `false` 才算关闭**：`raw.enabled !== false` | [skills/config.js:30-31](../src/skills/config.js#L30-L31) | `enabled: null / 0 / "false"` 全被当成**开启** —— 手改 config.json 或外部工具写配置时典型静默失效 |
| 2 | `available()` 返回 Promise 被当 truthy = **可用** | [manager.js:187-195](../src/skills/manager.js#L187-L195) | 异步自检被静默忽略；文档已警告（[skill-system.md:80-85](extend_development/skill-system.md)），代码无保护 |
| 3 | **占位能力被 `isAvailable` 放行**：只用 `providersOf(cap).length`，**不过滤 `provider === null`** | [manager.js:162-184](../src/skills/manager.js#L162-L184) vs [manager.js:371-376](../src/skills/manager.js#L371-L376) | A 硬依赖 X、B 只在 manifest 声明 X 而无实现时：A 的 **skill 级**判定"可用"，但**工具级** `requires` 走 `explainCapability` 被拒 → 两处口径分裂、运行期静默 no-op |
| 4 | `status().available` 公式怪异：`active \|\| (code ∉ {UNAVAILABLE, CAPABILITY_MISSING, NOT_FOUND})` | [manager.js:260](../src/skills/manager.js#L260) | `skill-disabled` 时 `available = true`，UI 语义反直觉 |
| 5 | guard / hook / `api.capability` 抛错一律被吞 | [tool-registry.js:207](../src/tool-registry.js#L207)、[manager.js:421-426](../src/skills/manager.js#L421-L426)、[plugin-loader.js:111](../src/plugin-loader.js#L111) | 扩展写错时表现为"某个守卫悄悄不生效"，不报错 |
| 6 | `MULTI_PROVIDER_CAPABILITIES` 运行期**无冲突检测** | [manager.js:39-46](../src/skills/manager.js#L39-L46)；仅 [test/tools-skill-audit.mjs:70,100](../test/tools-skill-audit.mjs) 使用 | 两个扩展提供同一单提供者能力时，谁生效取决于**注册顺序**；且热重载会 `removeOwner` 后重新 push 到列表末尾 → **重载即换序** |
| 7 | 旧 `plugin.json` 的 `prompt.when` / `examples` 会被**静默丢弃** | [manifest.js:131-134](../src/skills/manifest.js#L131-L134) 先于 [plugin-loader.js:49-65](../src/plugin-loader.js#L49-L65) | `instruction` 先被转成 section，导致 `adaptLegacyPrompt` 的 `sections.length` 早退；只有"无 instruction 仅 when/examples"才走适配 |
| 8 | `session.excludedTools`（本轮因何少了哪些工具）**写入了但 UI 从不读取** | [orchestrator.js:901-904](../src/orchestrator.js#L901-L904)（全仓仅此一处赋值，`ui/` 零命中） | 排障信息进不了界面，与"状态可解释"的设计承诺不闭环 |

### 11.1b 已修复：一处"同一件事两个真相"

会话级配置重构的直接动因。**记录在此以免回退**：

| 事实 | 位置 | 后果 | 现状 |
|---|---|---|---|
| `qqSceneRules` 自己按 `api.vision` 判断"能否看图"，而工具闸门用的是 orchestrator 算好的 `visionEnabled`（**含 `modelImageVerdict` 模型探测**） | 旧 [prompt.js:154-156](../src/prompt.js#L154-L156) vs [orchestrator.js:758-759](../src/orchestrator.js#L758-L759) | 模型被探测为"明确不支持图片"时：**看图工具被移除，系统提示却仍在说"你能直接看懂图片内容"** | ✅ 已修：两处都读 `profile.visionEnabled`，只算一次（[chat-profile.js](../src/chat-profile.js)） |
| 设置页/预览的 runtimeContext 不带 chatKey，运行时带 | [routes.js:67-84](../src/routes.js#L67-L84) | 依赖 chatKey 的扩展"UI 显示可用、实际不可用" | ✅ 已修：`skillRuntimeContext(chatKey)` + 预览端点接受 chatKey |
| `formatEntry` 逐条消息读一次 `getConfig()` 取备注表 | 旧 [prompt.js:323,331](../src/prompt.js#L323) | 纯浪费（一批几十条消息 = 几十次读全局单例） | ✅ 已修：每批取一次传入 |

### 11.2 运行期风险

| # | 事实 | 位置 |
|---|---|---|
| 9 | **并发饱和时的"幽灵等待会话"**：并发分支只推后 `waitUntil` 并 `scheduleWake(0)`，但 `pendingSessions` 已在定时器里删除 → `scheduleWake` 因 `!pendingSessions.has` **新建第二个 waiting 会话**，旧的那个再也不会被 `finish`/`discard` | [orchestrator.js:374-399](../src/orchestrator.js#L374-L399) + [:254-264](../src/orchestrator.js#L254-L264)。会话页会残留"等待中"，直到重启被僵尸回收改判 `aborted` |
| 10 | **同会话串行的窄竞态**：入口闸门与 `runningChats.add()` 之间隔着 `await #checkSelfMuted`，**无互斥锁** | [orchestrator.js:351](../src/orchestrator.js#L351) / [:364](../src/orchestrator.js#L364) / [:532](../src/orchestrator.js#L532) |
| 11 | 注释与实现漂移：`#resetSessionForRetry` 的注释称会重置 `promptAnchorState`，实际未清（也未清 `activeTopic` / `pastStateCount`） | 注释 [orchestrator.js:858-860](../src/orchestrator.js#L858-L860) vs 实现 [:661-674](../src/orchestrator.js#L661-L674)。副作用有限：`buildUserPrompt` 每次无条件覆盖 |
| 12 | `proactive` **绕过 `paused`**：`if (this.paused && !proactive)` | [orchestrator.js:350](../src/orchestrator.js#L350)、[:1363](../src/orchestrator.js#L1363) |
| 13 | `get_chats` 描述文案陈旧（写的是"`send_message` 的 `targetChatKey`"，现为 `send_to`），且**不受 `crossChatSend` 管辖** | [tools.js:559](../src/tools.js#L559)；可用性层只特判 `send_to`（[tool-registry.js:186-188](../src/tool-registry.js#L186-L188)） |
| 14 | 预览端点 **反映不出 per-chat 人设**：`buildSystemPrompt` 调用未传 persona | [routes.js:766](../src/routes.js#L766) |
| 15 | 提醒（reminders）**完全绕过触发判定**：直接走 SendQueue 发送，不建会话、不调模型、无 session 记录 | [orchestrator.js:1334-1350](../src/orchestrator.js#L1334-L1350)。是唯一"不经判定就发言"的来源 |
| 16 | 记忆整理有**幻觉守卫**：整理后条数变多即判为幻觉、放弃该次结果 | [orchestrator.js:1753-1756](../src/orchestrator.js#L1753-L1756) |

### 11.3 扩展安全（重要）

**扩展没有沙箱。** 入口是主进程内 `await import()`（[plugin-loader.js:301-315](../src/plugin-loader.js#L301-L315)）——
与核心**同一进程、同一模块图、完整 Node 权限**。

- `permissions: ["web_fetch"]` 只决定 `api.fetch` 是不是真 fetch（[plugin-loader.js:123-126](../src/plugin-loader.js#L123-L126)），
  而 `globalThis.fetch` 天然可达 → **权限声明是约定/门面，不是隔离**。
- 静态推断（未实跑）：`skills/<id>/index.js` 可用相对路径 `import '../../src/config.js'`
  拿到**同一模块实例**的明文 apiKey / Cookie。
  `settingsView` 的脱敏只保护 **HTTP 响应**，不保护进程内代码。
- **真实强制项**只有：entry 必须落在 Skill 目录内 + realpath 防 symlink 越界
  （[plugin-loader.js:266-289](../src/plugin-loader.js#L266-L289)）、工具 id 字符集/长度、
  清单 BOM 剥离、市场 zip 的扩展名与路径黑名单（[zip-install.js:119-123](../src/zip-install.js#L119-L123)）。
- **软约束**（无运行时强制）：hook 不得发请求/发消息/重试、"插件不得绕过 SendQueue" ——
  后者只在审计测试里做静态检查（[test/tools-skill-audit.mjs:502-514](../test/tools-skill-audit.mjs)）。

**`hotReload` 的真实含义**：默认**开启**，即"任何落盘到 `skills/` 或 `plugins/` 的 JS 会被自动
import 并执行"（[config.js:363-366](../src/config.js#L363-L366)、[app.js:1622-1626](../src/app.js#L1622-L1626)，
条件为 `QQ_AGENT_DEV==='1' || hotReload !== false`）。重扫是**全量**的，含 `pruneMissing`
与孤儿工具清扫；watcher 每次重建以自愈。

### 11.4 本检出的扩展现状（影响面最大）

`skills/` 与 `plugins/` 目录**不存在**（`git ls-files` 计数 0，工作树干净），
因此**所有文档宣称的"内置 Skill/插件"在本检出中都没有实现**，相关功能全部走核心兜底降级：

| 消费点 | 降级行为 |
|---|---|
| `prompt.js:305-311` `resolveCapabilityFn` → `null` | `formatEntry` 自拼 `名字(QQ:xxx)`（核心承诺，不随 Skill 消失） |
| `onebot.js:19` `message.inline-at-normalize` | 不做正文 @ 规范化 |
| `onebot.js:38` `media.transcribe` | 不转写语音 |
| `video-reader.js:134/258` `video.frames*` | 无 ffmpeg 抽帧 |
| `tools.js:1029` `image.mime-support` | 不做图片格式改写 |
| `orchestrator.js:686-692` `#capFirst` → `null` | reply-safety 链路整条失效（`reply-rescue` 全 null 分支） |
| `app.js:965` `media.download` | 不转发 B站/抖音链接 |

> ⚠️ 附带一个**必然崩溃**的脚本：`scripts/judge-check.mjs:10` import
> `../skills/reply-safety/salvage.js`（不存在）→ 该脚本一跑就挂。
> `npm run check:judge` 因此在本检出中不可用。

---

## 12. 设计上的硬约束（这些是"不许改"的，不是风格偏好）

1. **`botName` / `selfNickname` 不参与按会话覆盖** —— 它们参与 @ 判定与存档称呼，改了就对不上。
   分会话唯一保留的账号身份是全局值，`profile.persona` 结构性不允许覆盖这两个字段。
2. **`personaUnified=true` 时 `personaByChat` 不读** —— 但 `chatProfiles[k].persona` 一旦显式写出，
   解析器会同时关掉统一模式（"显式写了分会话人设"= 用户明确要分会话）—— 否则静默不生效。
3. **会话级配置只有一个解析入口**：`resolveChatProfile(chatKey)` / `buildChatProfileFrom`。
   核心代码不许再散落 `??` 兜底式的 per-chat 判断（有静态守卫，见 §3.7）。
4. **快照里不许有密钥**：`api` 段的 `API_SNAPSHOT_FIELDS` 白名单 + 可覆盖路径表都排除
   `apiKey` / `baseUrl` / `accessToken`。快照会进 `skillContext` → 扩展（同进程无沙箱）。
5. **只有知道 chatKey 的路径才吃会话值** —— 空上下文路径（`api.capability()`、`resolveCapabilityFn`）
   一律全局档，这是边界不是缺陷。
6. **技能开关只有一处存储**：`config.skills[id].enabled`（可被 `chatProfiles[k].skills` 覆盖），
   模块不许再写影子开关。
7. **工具可用性只有一个口径**：`getToolAvailability()`，调用方不许自己拼条件。
8. **`visionEnabled` / `searchEnabled` 只算一次**（在快照里）—— 提示词与工具闸门必须同源，
   这是"工具没了、提示词还说能看图"的根治点。
9. **Skill 提示词 priority 封顶 99**，核心安全规则与工具协议不可被覆盖（含 `systemPromptOverride` 路径）。
10. **已发出消息的会话绝不自动重试** —— 重复发言比失败更糟。
11. **`valley.start/end` 是死字段** —— 语义是"高峰窗口外一律低谷"。
12. **`__replace__` 约定**是删映射型键的唯一途径（普通深合并做不到）。
13. **`DATA_DIR` 必须在模块顶部确定**，否则多实例数据互相污染。
14. **发送必须走 `ctx.sender`**，直连 OneBot 会跳过队列/限频/去重/切分/留档（有静态审计）。
15. **提示词配置变化必须让锚点失效** —— 否则模型看到"旧人设基线 + 新人设追加段"
    （`#resetAnchorIfProfileChanged` + `chatProfileFingerprint`）。
