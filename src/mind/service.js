// 领域服务：反思 / 整合 / 叙事的"写回"部分。
//
// 为什么单独一层：这三件事的**决策**在运行时（什么时候跑、材料够不够、模型说什么），
// 但它们的**写回**（改关系、写自我、压事件、更新账本）是领域内部的事。
// 以前运行时直接拿着 store 干这些，`const store = this.mind` 就是那个别名。
//
// 现在运行时只认识这个服务的方法；服务拿 store，属于领域层，目录边界清楚：
//   src/mind/**  允许直接操作 store
//   src/runtime + orchestrator  只经端口/服务
//
// 本文件不 import 运行时，只依赖 store 与领域函数。

import { todayKey } from '../util.js';
import { applyReflection } from './reflect.js';
import { applyIntegrate } from './integrate.js';

/**
 * @param {object} store MindStore（鸭子类型即可）
 * @returns {object|null}
 */
export function createMindService(store) {
  if (!store) return null;

  return {
    // ── 会话反思（L2a）────────────────────────────────────────────────
    /**
     * 反思失败：只记尝试时间与一条失败日志，不推进 lastReflectAt。
     * 推进了就等于"这段事件已经消化过"，失败了也当成功，记忆会静默丢。
     */
    recordReflectFailure({ chatKey, now, reason, eventCount, raw }) {
      store.updateTick({ lastReflectAttemptAt: Number(now) || Date.now() });
      store.appendReflection({
        scope: 'chat',
        chatKey,
        at: Number(now) || Date.now(),
        ok: false,
        reason: String(reason || '解析失败'),
        eventCount: Number(eventCount) || 0,
        rawSummary: String(raw || '').slice(0, 300)
      });
    },

    /**
     * 应用一次会话反思：改关系/写笔记/压事件，推进 lastReflectAt，记日志。
     *
     * @returns {{applied:object, rejected:object[]}}
     */
    applyReflectResult({ chatKey, since, newestTs, tick, events, output, empty, usage, raw, now }) {
      const at = Number(now) || Date.now();
      // applyReflection 返回的是 {applied, rejected}，不是 applied 本身。
      const result = empty
        ? { applied: { self: false, relations: [], compacted: 0, summaryId: null }, rejected: [] }
        : applyReflection({ store, chatKey, output, inputEvents: events, now: at });
      const { applied } = result;
      const rejected = result.rejected || [];
      const today = todayKey();
      const sameDay = tick?.today === today;
      store.updateTick({
        today,
        todayReflections: (sameDay ? (Number(tick?.todayReflections) || 0) : 0) + 1,
        lastReflectAt: Number(newestTs) || at,
        lastReflectAttemptAt: at
      });
      store.appendReflection({
        scope: 'chat',
        chatKey,
        at,
        ok: true,
        empty: empty === true,
        window: { from: Number(since) || 0, to: Number(newestTs) || at },
        eventCount: Array.isArray(events) ? events.length : 0,
        produced: applied,
        rejected: rejected.length,
        rejectedDetail: rejected.slice(0, 10),
        usage: usage || null,
        rawSummary: String(raw || '').slice(0, 300)
      });
      return { applied, rejected };
    },

    // ── 全局反思（L2b）────────────────────────────────────────────────
    recordGlobalReflectionFailure({ now, reason }) {
      store.appendReflection({
        scope: 'global',
        kind: 'l2b',
        at: Number(now) || Date.now(),
        ok: false,
        reason: String(reason || '解析失败')
      });
    },

    applyGlobalReflection({ now, notesAdded, empty, summary, reflectionCount, usage }) {
      const at = Number(now) || Date.now();
      const tick = store.getTick();
      const today = todayKey();
      const usedToday = tick.today === today ? (Number(tick.todayGlobalReflects) || 0) : 0;
      store.appendReflection({
        scope: 'global',
        kind: 'l2b',
        at,
        ok: true,
        empty: empty === true,
        produced: { notes: Number(notesAdded) || 0 },
        summary: String(summary || ''),
        reflectionCount: Number(reflectionCount) || 0,
        usage: usage || null
      });
      store.updateTick({ today, todayGlobalReflects: usedToday + 1, lastGlobalReflectAt: at });
    },

    // ── 自我整合（L4）─────────────────────────────────────────────────
    recordIntegrationFailure({ now, reason, noteCount, raw }) {
      store.appendReflection({
        scope: 'global',
        at: Number(now) || Date.now(),
        ok: false,
        reason: String(reason || '解析失败'),
        noteCount: Number(noteCount) || 0,
        rawSummary: String(raw || '').slice(0, 300)
      });
    },

    /**
     * 应用 L4：改自我、标记笔记已消化、推进账本、记日志。
     * @returns {{applied:object, rejected:object[]}}
     */
    applyIntegration({ now, output, noteIds, empty, usage, raw }) {
      const at = Number(now) || Date.now();
      // 同上：applyIntegrate 返回 {applied, rejected}。
      const result = empty
        ? { applied: { self: false, digested: 0 }, rejected: [] }
        : applyIntegrate({ store, output, noteIds: Array.isArray(noteIds) ? noteIds : [], now: at });
      const { applied } = result;
      const rejected = result.rejected || [];
      const tick = store.getTick();
      const today = todayKey();
      const used = tick.today === today ? (Number(tick.todayIntegrates) || 0) : 0;
      store.updateTick({ today, todayIntegrates: used + 1, lastIntegrateAt: at });
      store.appendReflection({
        scope: 'global',
        at,
        ok: true,
        empty: empty === true,
        noteCount: Array.isArray(noteIds) ? noteIds.length : 0,
        produced: applied,
        rejected: rejected.length,
        rejectedDetail: rejected.slice(0, 10),
        usage: usage || null,
        rawSummary: String(raw || '').slice(0, 300)
      });
      return { applied, rejected };
    },

    // ── 叙事（L3）─────────────────────────────────────────────────────
    markNarrativeEmpty({ now }) {
      store.updateTick({ lastNarrativeAt: Number(now) || Date.now() });
    },

    /**
     * 写一段叙事并记账；标题只进反思日志，叙事文件保持"她自己写的那段话"。
     */
    appendNarrative({ title, text, period, materials, now, usage }) {
      const at = Number(now) || Date.now();
      const r = store.appendNarrative({
        title,
        text,
        source: 'integrate.global',
        at,
        period,
        materials
      });
      if (!r?.ok) return r;
      store.updateTick({ lastNarrativeAt: at });
      store.appendReflection({
        scope: 'global',
        kind: 'narrative',
        at,
        ok: true,
        empty: false,
        title: String(title || ''),
        period,
        usage: usage || null
      });
      return r;
    }
  };
}
