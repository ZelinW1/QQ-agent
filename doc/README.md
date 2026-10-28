# 文档索引

本目录只保留三类内容：**能指导当前开发的**、**能解释现状的**、**写扩展要用的**。
已被取代的设计稿与状态快照不做长期保留，需要时从 git 历史取（见 §5）。

---

## 1. 按目的选文档

| 你想做什么 | 读这份 | 状态 |
|---|---|---|
| 先弄懂"她到底怎么运转" | [architecture-primer.md](./architecture-primer.md) · 行动运行时导读 | 设计导读（未实施） |
| 动手实现重构 | [action-runtime-design.md](./action-runtime-design.md) · 设计 v3.1 | 施工依据（未实施） |
| 实现 A1 的领域解耦 | [mind-port-spec.md](./mind-port-spec.md) · 领域端口规格 | 接口规范（未实施） |
| 改这个仓库现有代码 | [architecture-overview.md](./architecture-overview.md) · 现行代码架构 | 现状快照 `ef5a8ec` |
| 写技能 / 插件 | [extend_development/](./extend_development/) | 扩展作者文档（有已知偏差） |

一句话顺序：**导读 → 设计稿 → 端口规格 → 开工**；改现有代码时另看架构快照。

---

## 2. 状态一览

| 文件 | 状态 | 读者 | 维护方式 |
|---|---|---|---|
| `architecture-primer.md` | 设计导读 | 产品 / 设计 / 验收 | 随设计稿同步 |
| `action-runtime-design.md` | 施工依据（定稿未实施） | 实现者 / 评审 | 设计变更时改版本号与 §14 |
| `mind-port-spec.md` | 接口规范（A1） | 实现者 | 随 A1 交付更新 |
| `architecture-overview.md` | 现状快照 | 实现者 | 重构动工后按阶段重写 |
| `extend_development/*` | 扩展作者文档 | 扩展作者 / AI | 契约变更时更新，偏差先记在 `architecture-overview.md §10` |

两张描述"未来"、一张描述"现在"，不要混用：
**导读与设计稿写的是重构之后的样子，不是当前版本行为。** 当前版本见仓库根 `README.md`。

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
