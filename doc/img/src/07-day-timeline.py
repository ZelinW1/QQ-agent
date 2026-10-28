# -*- coding: utf-8 -*-
"""生成「典型的一天」时间线图。只依赖 matplotlib。"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, FancyArrowPatch
from matplotlib.font_manager import FontProperties, findfont, FontManager
import os

FONT = "Microsoft YaHei"
plt.rcParams["font.sans-serif"] = [FONT, "SimHei"]
plt.rcParams["axes.unicode_minus"] = False

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "07-day-timeline.png")

fig, ax = plt.subplots(figsize=(14.5, 5.2))
fig.patch.set_facecolor("white")

ax.set_xlim(0, 24)
ax.set_ylim(-1.75, 1.80)
ax.axis("off")

# ── 睡着时段 ─────────────────────────────────────────────
ax.add_patch(Rectangle((0, -1.05), 8, 2.5, facecolor="#eef0f3", edgecolor="none", zorder=0))
ax.add_patch(Rectangle((23.5, -1.05), 0.5, 2.5, facecolor="#eef0f3", edgecolor="none", zorder=0))
ax.text(4.0, 1.42, "睡着：不醒、不调模型、不推进「冲动」", ha="center", va="center",
        fontsize=10.5, color="#5b6472")
ax.text(0.22, -1.02, "前一晚 23:30", ha="left", va="top", fontsize=8.5, color="#7b8494")
ax.text(7.78, -1.02, "08:00", ha="right", va="top", fontsize=8.5, color="#7b8494")

# ── 时间轴 ───────────────────────────────────────────────
ax.plot([0, 24], [-0.35, -0.35], color="#b6bdc7", lw=1.2, zorder=1)
for h in range(0, 25, 2):
    ax.plot([h, h], [-0.41, -0.29], color="#b6bdc7", lw=1.0, zorder=1)
    ax.text(h, -0.55, f"{h:02d}", ha="center", va="center", fontsize=8.5, color="#7b8494")

# ── 三类事件 ─────────────────────────────────────────────
chat = [8.33, 9.1, 10.5, 12.67, 14.0, 15.33, 16.75, 19.17, 20.5, 21.83]
free = [8.67, 12.17, 15.83, 19.67, 21.17, 22.67]
inte = [13.5, 18.0, 23.1]
cron = [3.0]

for t in chat:
    ax.plot([t, t], [-0.35, 0.30], color="#5b8def", lw=2.2, solid_capstyle="round", zorder=2)
for t in free:
    ax.plot(t, 0.62, "o", ms=8, color="#4a9c5d", zorder=3)
for t in inte:
    ax.plot(t, 0.95, "s", ms=8, color="#d08b32", zorder=3)
for t in cron:
    ax.plot(t, 0.30, "*", ms=13, color="#8b93a1", zorder=3)

# ── 标注 ─────────────────────────────────────────────────
notes = [
    (3.0, 0.30, 3.0, 1.05, "定时任务照跑\n（不受睡着影响）", "#8b93a1", "center"),
    (8.67, 0.62, 7.55, 1.18, "醒来后第一次「抬头」\n把睡眠期间的冲动重抽", "#4a9c5d", "left"),
    (13.5, 0.95, 13.5, 1.62, "会话反思", "#d08b32", "center"),
    (18.0, 0.95, 18.0, 1.62, "会话反思", "#d08b32", "center"),
    (23.1, 0.95, 21.3, 1.62, "睡前最后一次\n全局反思", "#d08b32", "right"),
]
for x, y, tx, ty, txt, col, ha in notes:
    ax.annotate(txt, xy=(x, y), xytext=(tx, ty), ha=ha, va="center",
                fontsize=8.8, color=col,
                arrowprops=dict(arrowstyle="-", color=col, lw=0.8,
                                connectionstyle="arc3,rad=0.12"))

# 群聊/私聊消息标注
ax.annotate("每批消息到达 → 一次对话时刻\n（当天 10 批）", xy=(15.33, 0.30), xytext=(15.9, 1.16),
            ha="left", va="center", fontsize=8.8, color="#5b8def",
            arrowprops=dict(arrowstyle="-", color="#5b8def", lw=0.8,
                            connectionstyle="arc3,rad=-0.15"))

# ── 图例 ─────────────────────────────────────────────────
lg = [
    ("对话时刻 chat", "#5b8def", "|"),
    ("自由时刻 free", "#4a9c5d", "o"),
    ("整合时刻 integrate", "#d08b32", "s"),
    ("定时任务 automate", "#8b93a1", "*"),
]
x0 = 0.2
for i, (name, col, mk) in enumerate(lg):
    x = x0 + i * 3.1
    ax.plot(x, -1.38, mk, color=col, ms=9, zorder=3)
    ax.text(x + 0.35, -1.38, name, fontsize=9.5, va="center", color="#3f4754")

fig.text(0.5, 0.015,
         "示意，不代表真实时刻；一天里她自己的生活（自由 + 整合）大约 12–16 次调用，"
         "对话次数取决于有人找她多少。",
         ha="center", fontsize=8.5, color="#8b93a1")

plt.tight_layout(rect=[0, 0.03, 1, 1])
plt.savefig(out, dpi=150, bbox_inches="tight", facecolor="white")
print("saved", os.path.normpath(out))
