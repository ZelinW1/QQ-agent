# 当前状态：一对一的运行流程与能力接入

> 本文回答两个问题：**一次私聊从消息进来到回复发出去，中间发生了什么**；以及
> **原版工程的哪些能力现在可以直接用、验证到什么程度**。
>
> 记录时间：2026-10-25。默认配置下心智全部关闭，行为与改造前一致。

---

## 一、一次私聊的运行流程

### 0. 前提：这个引擎没有"对话"

每来一条（批）消息，系统新开一次**独立运行**：重新组装提示词、重新调模型、跑完就结束。
没有任何跨运行的对话记忆。所以"她记得什么"完全取决于两处持久化：

| 持久化 | 内容 | 谁写 |
|---|---|---|
| `data/messages/` | 原始聊天记录（含自我发言） | 收发时自动 |
| `data/mind/` | 事件 / 关系 / 自我 / 节律 | 她自己（工具 + 反思） |

这条设计决定了后面所有事：**要让她"记得"，必须把东西写进上面两处，而不是指望上下文连着。**

### 1. 时间线

```
① 消息进来
   OneBot WS → app.handleOneBotEvent
   → store.appendIncoming(chatKey, entry)        // 先落库，永不丢消息
   → orchestrator.onIncoming(chatKey, entry)

② 三道门（任一命中就直接返回，消息留在未读）
   ├─ paused / aborted                → 用户暂停或中止
   ├─ asleep（作息）                  → 夜里睡着：只入库，不唤醒
   └─ running / pendingWake           → 该会话正在跑或已排定

③ 触发判定
   resolveContextTier({ isPrivate: true, ... })
   → **私聊恒为 4 档、必响应**（一对一没有 @ 机制，不该套群聊的骰子）
   → scheduleWake(chatKey, wakeDelayMs)           // 攒一小会儿，避免一条一发

④ 组装（每次运行都重做，这是"零历史"成本模型的来源）
   profile   = resolveChatProfile(chatKey)         // 会话级配置快照
   mindCtx   = collectMindContext(...)             // 她自己 + 关系 + 最近想起
   anchor    = promptAnchors.get(chatKey)          // 前缀缓存锚点
   systemPrompt = buildSystemPrompt({ mind, chatKind:'private', ... })
   userPrompt   = buildUserPrompt({ profile, mind, triggerEntries, ... })
   tools        = getToolAvailability(...)         // 按能力/技能/心智过滤

⑤ 调模型
   messages = [ {role:'system'}, {role:'user'} ]   // 只有两条
   工具通过请求的 tools 参数提供（不在提示词里列清单）

⑥ 工具循环
   模型 → tool_calls → 执行 → 结果回填 → 继续，直到 finish 或没有工具调用

⑦ 发送
   send_message → SendQueue → OneBot send_private_msg
   → store.appendSelf(chatKey, ...)                // 自己说的话也要入库

⑧ 收尾
   会话留档（用量 / 已发送 / 提示词 / 模型）
   触发批标已读；运行期间新来的消息保持未读，结束后补一次 drain

⑨ 后台（不阻塞回复）
   #maybeConsolidateMemory  旧的印象整理（已基本退场）
   #maybeReflect            攒够 8 条未反思事件且过冷却 → 反思
   tickOnce                 全局唤醒（默认）：结算体力 → roster → 一次菜单 → 工具循环
                            （旧的 per-chat 路径保留，mind.tick.mode='per-chat' 可回滚）
```

### 2.1 一次全局唤醒做什么

```
tickOnce
└─ 睡着？ → 不决策（只入库存消息，醒来再一起读）
   结算体力 + 跨天清零
   全局节拍到了？
   ├─ roster：所有私聊，按 未读 > 到期 openLoop > 沉默时长 > 亲近度 排序取前 3
   │          每条带 昵称/多久没联系/未读数/最后一句线索/最近事件时间
   ├─ 候选：miss_you / open_loop / reflect_pending / unprocessed（刚聊过但没记）
   ├─ 菜单：内置动作（成本读 config.mind.energy.cost）+ 已启用的扩展行动
   │        附 showBlocked 条"现在做不了 + 原因"
   └─ 自由行动会话：一次上下文里连续做 ≤ mind.actions.maxPerWake 件事
        每步结果回灌；体力和次数不够会被明确拒绝；finish 收尾
        一次都没做 → 记 idle 并给候选打盹
```

扩展行动：工具定义里可声明 `mindAction: { label, energy, defaultEnabled }`；
也可以在「设置 → 运行配置 → 工具与技能 → 作为自愿行动」里手动把任意扩展工具
设为行动（默认关闭，配置存 `mind.actions.overrides[工具id]`）。

### 2. 心智子系统在流程里的六个插入点

| 位置 | 调用 | 关掉时 |
|---|---|---|
| ② 门禁 | `#refreshSleep` / `onIncoming` 的 asleep 判断 | 永不睡，消息照常唤醒 |
| ④ 组装 | `collectMindContext` → system 的 self 层 + user 的回忆段 | 一段都不插 |
| ④ 工具 | `getToolAvailability({ mindEnabled })` | 四个心智工具消失 |
| ⑦ 之后 | `#maybeReflect` | 不反思 |
| 定时 | `tickOnce`（体力/决策/行动） | 不跑心跳 |
| 工具内 | `remember_event` / `update_relation` / `self_revise` / `recall` | 不注册到工具表 |

### 3. 默认开关

| 开关 | 默认 | 位置 |
|---|---|---|
| `mind.enabled` | **false** | 她 → 身份 → 开关与作息 |
| `mind.scope` | `private` | 配置文件（群聊暂不注入） |
| `mind.tick.enabled` | true（受总开关约束） | 同上 |
| `mind.sleep.enabled` | **false** | 她 → 身份 |
| `proactive.enabled` | 由配置决定 | 心智节拍开启时被它取代（互斥） |

---

## 二、能力接入清单

「原版能力」= 改造前就有的工具。心智工具另算。

### 已验证可用（有测试实际执行，不只是"注册了"）

| 能力 | 工具 | 依赖 | 验证 |
|---|---|---|---|
| 发消息（分条） | `send_message` | SendQueue → OneBot | coverage-e2e ×2（含 CQ 转义、空列表拒绝）、selftest |
| 查历史消息 | `get_recent_messages` | 本地存档 | coverage-e2e |
| 查活跃成员 | `get_active_members` | 本地存档 | coverage-e2e |
| 表情：列表 | `list_stickers` | 本地表情库 | coverage-e2e |
| 表情：发送 | `send_sticker` | OneBot + 图片校验 | **selftest（image 段 + 存档记录）** |
| 表情：收藏 | `collect_sticker` | 下载 → 转存 → 入库 | sticker-collect-test |
| 拍一拍 | `send_poke` | OneBot | coverage-e2e |
| 提醒 | `set_reminder` / `list_reminders` / `cancel_reminder` | 本地 + 发送管道 | coverage-e2e（含去重） |
| 查节日 | `check_holiday` | 本地表 | coverage-e2e |
| 联网搜索 | `web_search` | mock 搜索源 | coverage-e2e |
| 抓网页 | `web_fetch` | SSRF 防护 | coverage-e2e（内网地址被拒） |
| 结束 | `finish` | — | coverage-e2e |
| 工具格式 | `toOpenAiTools` | — | coverage-e2e |

### 注册了但这一轮**没有端到端验证**

这些工具在工具表里、参数与实现都在，但没有测试真正执行过它们（属"可能可用"）：

`send_image`、`get_message_images`、`get_message_detail`、`read_forward`、
`read_video`、`search_images`、`send_to`、`get_chats`、`get_sticker_image`、`sticker_note`

> 其中 `send_image` / `get_message_images` / `read_forward` 最值得先验 —— 它们的
> 依赖（图片下载、`get_forward_msg`、`get_image`）在 mock OneBot 里已经有桩，
> 只是还没被调用过。

### 心智工具（需 `mind.enabled`）

`remember_event` / `update_relation` / `self_revise` / `recall` —— 单测覆盖（39 项），
**没有走完整模型调用链路的 e2e**。可用性门控有测试（关闭时整体消失）。

### 心智开启后被隐藏的旧工具

`memory_append` / `memory_query` / `memory_remove` —— 旧 `memberImpression` 体系，
已由关系档案接管（`update_relation`）。有心智开启时它们从工具表消失的断言。

---

## 三、验证记录（2026-10-25）

| 套件 | 结果 |
|---|---|
| `test/selftest.mjs` | 41 项审计通过（含表情包发送、安全边界） |
| `test/coverage-e2e.mjs` | 44 项通过（端到端工具链路 + 白名单 + Skill 开关） |
| `test/sticker-collect-test.mjs` | 全部通过 |
| 全量套件 | **46 / 48**（既有失败：`coverage-ui`、`setup-qq-version`） |

已知的**环境性**失败（不是回归）：
- `usage-daily-test`：在本地时间 00:00–00:10 之间跑会失败（夹具用 `now-10min` 表示今天）
- `setup-qq-version`：`setup.mjs --check` 在没有 `snowluma/` 时退出码 1
- `coverage-ui`：落地页链接文件名与版本号不一致（上游遗留）

---

## 四、已知边界

1. **群聊不走心智**：`mind.scope = private`，群聊里不注入自我/关系，也不跑反思。
2. **睡眠是全局的**：夜里对所有人都不响应，包括私聊。没有"紧急联系人可吵醒"。
3. **一次运行 = 一批消息**：运行期间新来的消息不会打断，结束后补处理。
4. **反思与决策都花模型调用**：反思有冷却与每日上限；决策有当日次数上限。
5. **关系是 QQ 全局的**：同一个人在私聊和群聊里共用一份关系档案（M1 决策）。

---

## 五、接着测什么

按风险排序：

1. 打开心智（她 → 身份 → 心智功能），随便聊几句，看「她 → 记忆流」里有没有事件
2. 等攒够 8 条事件或手动触发一次反思（目前没有手动入口），看关系是否更新
3. 打开作息，把入睡时间设成 2 分钟后，看是否到点睡着、消息是否不被处理
4. 表情相关：让模型发一张表情（`send_sticker`），确认 QQ 端显示正常
5. 上面「未端到端验证」那批工具：`send_image` / `get_message_images` / `read_forward`

---

## 六、收敛轮变更（2026-10-25）

上面几节写于收敛之前，以下为之后的结构变化，以本节为准：

**导航**（一级竖排 + 二级横排）

```
心智 → 状态 | 节律 | 身份 | 记忆流 | 会话配置
记录 → 会话过程 | 消息存档 | 用量 | 心跳日志
设置 → 运行配置 | 技能 | 插件 | SnowLuma
```

- 顶层从「她」改为**心智**（中性、不预设性别，也不落入 Agent/机器人的工具化框架）
- 日志与设置分家：「心跳日志」在记录里；「节律」只放会改变行为的参数
  （体力/心跳/反思/作息），传输参数（温度/轮数/防抖/并发/重试）仍在设置
- 「聊天设置」改名「发送与群聊」，页内用分组标题隔开通用与群聊参数；
  心智开启时「主动开话题」不再渲染输入框（它已被节律接管，留着可编辑才是误导）

**可编辑（带留痕与伦理提示）**

- 自我描述、每段关系的阶段/信任/亲近/称呼/雷点都能改，改前弹确认：
  "改它等于改写已经经历过的自我，不建议像基因编辑那样动"
- 自我记 `by: owner` + changelog；关系记 `evidence: owner:manual`
- 存储层钳制照旧（阶段一次一级、信任单次 ±10）——手动编辑不是后门

**备份**（设置无法被备份覆盖）

| 包 | 内容 | 不含 |
|---|---|---|
| 她自己 | `mind/` + persona（名字/人设/charter/参与度/群友备注） | 聊天、设置、密钥 |
| 完整备份 | 上面 + 聊天记录 / 会话留档 / 表情 / 用量 | **设置与 API Key** |

导入前自动打 `data/backups/pre-import-<时间>.zip`；做不出后悔药就中止导入。
还原只写白名单目录，`config.json` 即使被塞进包里也会被忽略。
有会话在跑时导入直接 409（先暂停）。

**已知限制**

- 备份文件不做版本迁移（版本 1 的包只能被同格式读）
- 导入后建议重启一次（内存里的会话/锚点状态不会重置）

