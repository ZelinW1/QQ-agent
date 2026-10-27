# 节律系统 v2 —— 待办与设计决定

> 记录 2026-10-27 的讨论结论。按 P0 → P4 顺序实施。
> 每一步单独可验收；数值（恢复速率、阈值）留到全部流程跑通后再调。
>
> 进度：P0 ✅（9b9fd21）· P1 ✅ 已实现并默认关闭（`mind.tick.mode='global'` 才启用）·
> P2/P3/P4 待做。

## P0 · 修复：同一天窗口永远不睡（阻塞级）—— ✅ 已完成

**现象**：作息开关开着、窗口显示正常（如 00:32–07:29），但凌晨仍判定"醒着"，
消息照回、心跳照跑。

**根因**：`src/mind/sleep.js` 的 `resolveSleepWindow()` 用

```js
if (d.getHours() < end.h) d.setDate(d.getDate() - 1);
```

把窗口整体挪到前一天。这行只对**跨午夜**窗口（23:30→08:00）成立；
当开始与结束在同一天（00:30→07:30）时，窗口会被算成昨天的 00:30–07:30，
于是 `inWindow=false`。

**修复**：先判跨午夜再挪日期。

```js
const crossesMidnight = (start.h * 60 + start.m) > (end.h * 60 + end.m);
if (crossesMidnight && d.getHours() < end.h) d.setDate(d.getDate() - 1);
```

`start == end` 视为无效配置（不睡）。

**测试**：`mind-sleep-test` 增加
- 同日窗口：01:00 入睡、09:00 醒
- 跨午夜窗口回归（23:30→08:00）
- 同日窗口 + 抖动仍落在当天

---

## P1 · 全局唤醒 + roster —— ✅ 已实现（默认关闭，`mind.tick.mode='global'` 启用）

已落地：
- `#runGlobalTick()`：一次唤醒只调一次模型，roster 排序取前 3，余下折叠一行
- `buildGlobalDecisionPrompt()`：与单会话版共用同一份 system（缓存前缀一致）
- 决策可带 `args.chatKey` 指定目标会话；缺省时挑候选里最该找的那个人
- 全局节拍 `globalNextWakeAt`：同一时段不会连续决策
- 未读 / 到期 openLoop / 沉默时长 / 亲近度 排序分（`scoreRosterEntry`）
- 测试：`mind-global-tick-test`（17 项）

**尚未做**：把默认值从 `per-chat` 翻成 `global` —— 等 P2 的自由行动循环
一起验证后再翻（单独切过去会失去"一次做多件事"的收益）。

- `wakeOnce()`：扫全部私聊会话，合成 roster
- roster 排序（拍板）：
  ```
  有未读            +100
  有到期 openLoop   +50      // since>0 且 ≥ openLoopDueMs(默认24h)
  距上次联系小时数   +min(30, hours)
  亲近度            +min(10, warmth/10)
  ```
  取前 3；其余折叠一行"另外 N 个会话，最近都安静"
- 每项字段：`name / stage / warmth / openLoops / hoursSince / unread / lastLine(≤30字) / lastSpeaker`
- 未读来源只有三种：睡着、暂停、会话运行中（私聊恒响应，平时不积压）
- 配置：`mind.tick.mode = 'global' | 'per-chat'`，保留旧路径一个版本用于回滚
- 测试：排序、裁剪、空会话、跨会话不重复决策

---

## P2 · 自由行动工具循环 —— ✅ 已实现（随 mode='global' 生效）

- 一次上下文里连续做 ≤ `mind.actions.maxPerWake`（默认 3）件事
- system 复用 `buildDecisionSystem`（与单会话版逐字相同，共享缓存前缀）
- 每个动作注册成独立工具（参数含 `reason`；`send_proactive` 额外含 `chatKey`）+ `finish`
- 每步执行后把结果作为 tool 消息回灌；`idle` 不进工具表（结束就是 `finish`）
- 到达上限后不立刻 break：超出的调用被明确拒绝（"做够几件事了"），让她自己收尾；
  step 上限 `maxActions+2` 兜底
- 体力按当前值判定：不足的调用返回"现在做不了：体力不够"，可继续做别的事
- 只写正文 = 结束；一条都没做 → 记 idle（带她写的理由），并给候选打盹
- 测试：`mind-global-tick-test` 扩到 24 项（连续两件事 / 上限 / 体力不足 / 只写正文）

**仍未做**：默认值仍是 `per-chat` —— 等 P3（动作注册表）一起翻。

---

## P3 · 动作注册表 v2 —— ✅ 已完成（默认 mode 同时翻成 global）

- 内置动作的体力**改为读配置**（`actionsWithCosts`），修掉 `energy.cost`
  是死配置、`actions.js` 里硬编码 25/15/5 的问题
- 扩展行动：`registerTool({ ..., mindAction: { label, energy, defaultEnabled, when } })`
  - 可选字段，`registerTool` 已透传；不写就永远只是辅助工具
  - **默认关闭**，由 `mind.actions.overrides[工具id]` 逐项开启/覆盖 label/energy
  - 技能禁用/卸载 → 工具消失 → 行动一起消失
- 菜单里附 `showBlocked` 条"现在做不了 + 原因"（默认 2）
- 编排器统一执行：扩展行动最终调用 `executeTool`，与聊天里的工具同一条链路
- 测试：`mind-actions-v2-test` 22 项（成本覆盖 / 被拦原因 / 扩展启用与覆盖 /
  工具消失 / 提示词可见 / 编排器真的执行了扩展工具）
- **`mind.tick.mode` 默认已改为 `global`**；旧的 per-chat 路径保留，
  相关测试显式声明 `mode:'per-chat'` 继续覆盖回滚路径


---

## P4 · "记一笔"分叉（验证第 4 点）

- 新增自愿行动 `remember`：args `{ chatKey, text }`
  - 允许先 `recall`（5 体力）补充素材，再 `remember_event`
  - 素材来自 roster 的 `lastLine`，不是强制流程
- 观察指标：事件数是否自然增长、`organize` 是否终于可达
- **若仍不增长**，再考虑在聊天运行末尾加一个"轻量分叉"（一次判断：
  这次有值得留的吗），仍然不是强制写入

---

## 待办（流程之外）

- **界面收口**：目前扩展相关设置分散在三处（设置-技能/插件、运行配置-工具与技能、
  若再加心智-行动）。后端定稿后统一规划，先不动。
- **数值**：体力恢复速率、各动作成本、候选阈值、`maxActionsPerWake` —— 最后调。
- 观察 `lastProactiveAt` 只在内存里（重启丢失），是否需要持久化。
