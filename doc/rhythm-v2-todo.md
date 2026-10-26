# 节律系统 v2 —— 待办与设计决定

> 记录 2026-10-27 的讨论结论。**尚未动代码**，按 P0 → P4 顺序实施。
> 每一步单独可验收；数值（恢复速率、阈值）留到全部流程跑通后再调。

## P0 · 修复：同一天窗口永远不睡（阻塞级）

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

## P1 · 全局唤醒 + roster

不再"每个会话各想一次"，改为一次唤醒、一份菜单。

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

## P2 · 自由行动工具循环

- `#runFreeTime()`：一次上下文里连续做 ≤N 个动作
  - system 稳定（可缓存）；user = roster + 自身状态 + 菜单
  - 每个可用行动注册为独立工具（参数 schema 明确）+ `finish`
  - 每步执行后把 `{ok, summary, deltas}` 回灌，由她决定继续或结束
  - 上限 `maxActionsPerWake`（默认 3）、体力下限、单行动失败默认允许继续
  - 没有 tool_calls → 视作 finish（可复用聊天那套"一次纠正"）
- 收尾：每次行动写 `actions.jsonl`（summary + deltas），供下次唤醒当"上次行动"
- 测试：连续 2~3 个动作、超限即停、体力不足即停、失败后继续、finish 正常结束

---

## P3 · 动作注册表 v2

- 内置动作的体力**改为读配置**（修掉现在 `energy.cost` 是死配置、
  `actions.js` 里硬编码 25/15/5 的问题）
- 扩展行动：`registerTool({ ..., mindAction: { label, energy, defaultEnabled, when } })`
  - 可选字段，`registerTool` 已透传；不写就永远只是辅助工具
  - **默认关闭**，由用户在配置里逐项开启
- 配置（界面以后再说，先收在一个命名空间）：
  ```jsonc
  "mind": { "actions": {
    "maxPerWake": 3,
    "showBlocked": 2,
    "overrides": { "qzone_post": { "enabled": true, "label": "发条动态", "energy": 15 } }
  } }
  ```
- 菜单里最多附带 `showBlocked` 条"现在做不了 + 原因"
- 技能禁用/卸载 → 其行动自动消失（`skillId` 生命周期已有）
- 测试：扩展行动启用/禁用、技能卸载后消失、体力覆盖生效

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
