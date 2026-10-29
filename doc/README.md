# 文档索引

本目录只保留三类内容：**能指导当前开发的**、**能解释现状的**、**写扩展要用的**。
已被取代的设计稿与状态快照不做长期保留，需要时从 git 历史取（见 §5）。

---

## 1. 按目的选文档

| 你想做什么 | 读这份 | 状态 |
|---|---|---|
| 先弄懂"她到底怎么运转" | [architecture-primer.md](./architecture-primer.md) · 行动运行时导读 | 已落地的形态（先读这个） |
| 查重构做到哪一步、为什么这样做 | [action-runtime-design.md](./action-runtime-design.md) · 设计 v3.2 | 施工依据；§12 是唯一进度清单 |
| 查端口接口与迁移对照 | [mind-port-spec.md](./mind-port-spec.md) · 领域端口规格 | A1 已交付，B 期补齐 |
| 读重构**前**的代码结构 | [architecture-overview.md](./architecture-overview.md) · 代码架构快照 | 快照 `ef5a8ec`（已过期，读开头横幅） |
| 写技能 / 插件 | [extend_development/](./extend_development/) | 扩展作者文档（有已知偏差） |

一句话顺序：**导读 → 设计稿 §12 → 端口规格**；架构快照只在读历史代码时用。

---

## 2. 状态一览

| 文件 | 状态 | 读者 | 维护方式 |
|---|---|---|---|
| `architecture-primer.md` | 已落地的形态 | 产品 / 设计 / 验收 | 随设计稿同步 |
| `action-runtime-design.md` | 施工依据（已实施） | 实现者 / 评审 | 设计变更时改版本号与 §14 |
| `mind-port-spec.md` | 接口规范（A1 已交付） | 实现者 | 随交付更新 |
| `architecture-overview.md` | **过期快照** | 只用于对照历史 | 不再按阶段重写（见 §2.1） |
| `extend_development/*` | 扩展作者文档 | 扩展作者 / AI | 契约变更时更新 |

一张描述"现在"（导读 + 设计稿），一张描述"重构前"（架构快照）。读后者时先看它开头的横幅。

---

## 2.1 实施状态（2026-10-29）

重构按设计稿 §12 的轮次推进，`ef5a8ec` 之后 17 个提交全部落在本仓库：

| 阶段 | 提交 | 交付 |
|---|---|---|
| 前置 | `6161d30` `3632253` | 文档重整（设计收敛到 v3.1）；技能审计不再依赖本地扩展 |
| A 期 | `2df1990` `7054dbb` `0950897` `ff6508f` `a09e48b` | 领域端口（三端口 + 空实现）；睡眠/心跳/stay_up 迁移；写工具经 WriterPort；控制台经 AdminPort；无心智装配守门 |
| 切割 | `d42ea67` | 删除 per-chat 心跳（-186 行），只剩全局唤醒 |
| B 期 | `05cb6b5` `895c24a` `2b14d01` `624a433` `a3a566a` | 关系版本化；会话反思不再改自我（只写 selfNotes）；全局整合 + 强事件机械判定；意图/尝试/观察三张表 + 冻结 `actions.jsonl`；叙事 + 月度兜底 |
| C 期 | `bd9b92a` `59d5719` `46b99fa` `05f3f33` | 八步管线；自由时刻换引擎（素材进提示词、动作过管线、留尝试与观察）；编排器零 store 直连；`QQ_AGENT_NO_MIND=1` 领域缺席守门 |
| D 期 | （见 §12 R16） | 延时意图：`plan` 挂意图 → 到期进候选并提前唤醒 → 做成即了结；观察队列机械消费 |

当前规模：55 个测试文件；`src/orchestrator.js` 约 3.5k 行、`src/contract/mind-port.js` 约 800 行、
`src/runtime/` 两个模块。设计里 A 期的硬指标（删掉 `src/mind/` 仍能启动）**已达成**。

自己验证一遍（不需要读代码）：

```powershell
npm test                              # 全量 55 个文件
node test/mind-deleted-test.mjs       # 领域缺席：QQ_AGENT_NO_MIND=1 下启动整个应用
node test/mind-port-boundary-test.mjs # 边界：谁可以 import / 调用领域
```

---

## 3. 图

`img/` 下有 7 张图，源文件在 `img/src/`，可完整重绘：

| 图 | 源文件 | 工具 |
|---|---|---|
| `01-moments.png` 四个时刻 | `src/01-moments.dot` | Graphviz |
| `02-wake-loop.png` 一次唤醒 | `src/02-wake-loop.dot` | Graphviz |
| `03-prompt-layers.png` 提示词分层 | `src/03-prompt-layers.dot` | Graphviz |
| `04-memory-layers.png` 记忆与整合 | `src/04-memory-layers.dot` | Graphviz |
| `05-action-loop.png` 行动闭环 | `src/05-action-loop.dot` | Graphviz |
| `06-storage.png` 存盘分区 | `src/06-storage.dot` | Graphviz |
| `07-day-timeline.png` 一天 | `src/07-day-timeline.py` | matplotlib |

重绘（Windows，需 graphviz 与 matplotlib）：

```powershell
$dot = 'D:\anaconda3\Library\bin\dot.exe'   # 或 PATH 里的 dot
Get-ChildItem doc\img\src\*.dot | ForEach-Object {
  & $dot -Tpng (Join-Path 'doc\img' ($_.BaseName + '.png')) $_.FullName
}
python doc\img\src\07-day-timeline.py
```

约定：**改图必须改源文件**，不要只替换 PNG——否则下一轮没人能改。

---

## 4. 维护约定

1. **每份文档头部有一张元信息表**（状态 / 基准 / 读者 / 最后更新）。内容改动时同步"最后更新"。
2. **行号引用会漂移**：架构快照里的 `path:line` 只作定位辅助，以符号名为准。
   代码改动导致引用失效时，优先改成函数名/版本号，而不是逐条修行号。
3. **设计稿改版就升版本**（v3.1 → v3.2），并在 §14 记一行；不要静默修改已发布的结论。
4. **被否决的方案留在设计稿附录**，避免同一个问题反复讨论。
5. **不要新增"状态快照"类文档**。这类文档三天就会过期；需要时写进 PR 描述或 issue。

---

## 5. 历史

以下文档曾在本目录，已被现行设计取代并删除，需要时从 git 历史恢复：

| 文档 | 最后所在提交 | 被什么取代 |
|---|---|---|
| `m1-mind-plan.md` | `ef5a8ec` | `action-runtime-design.md`（六对象、整合阶梯、唤醒模型） |
| `rhythm-v2-todo.md` | `ef5a8ec` | 同上（节律改为统计驱动，C 期） |
| `current-state.md` | `ef5a8ec` | 仓库根 `README.md` + 本目录导读 |
| `action-runtime-design-v2.md` / `-review.md` | 未入库 | 并入 `action-runtime-design.md` 与附录"被否决的方案" |

代码注释里原先指向 `m1-mind-plan.md` 的两处已改为指向设计稿 §7.3。
