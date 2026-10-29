// 领域端口（MindPort）：运行时与心智之间的唯一通道。
//
// 为什么要有它：运行时不认识 MindStore，只认识"读素材 / 记尝试 / 改身体状态"这几件事。
// 做到这一步，`src/mind/` 才能被整体替换甚至删除——删掉之后装配根注入空实现，
// 应用照常启动，只是"她没有内心生活了"。这是设计稿 §3.3 的唯一硬指标。
//
// 本文件**不 import 任何领域模块**（`src/mind/**`），只接受鸭子类型的对象。
// 唯一允许 import 领域模块的地方是装配根（`src/app.js`）。
//
// 三个端口，不是一个大端口：
//   RuntimePort —— 运行时用：读素材、身体状态、记尝试。**故意没有"改她是谁"的写接口**
//   WriterPort  —— 工具用：按写入规程写领域；来源 `by` 由管线注入，工具自己给不出来
//   AdminPort   —— 控制台与迁移用：一对一包住 store，不做语义化
//
// 同步实现：现有 store 全是同步 IO（readFileSync / appendFileSync），A 期保持同步，
// 迁移面最小。将来若统计需要异步，一次性统一，不散着改。

export const MIND_PORT_API = 1;

/** 写入规程（设计稿 §4.2）。值为允许的来源；来源不在表里 = 越权。 */
export const WRITERS = Object.freeze({
  'self.narrative': ['integrate.global', 'tool:self_revise'],
  'self.notes': ['integrate.chat', 'integrate.global'],
  relation: ['tool:update_relation', 'integrate.chat'],
  // 两个工具会写事件：记一笔，以及关系更新的"依据事件"。
  // recall 是只读工具；自由时间的回想写回由 runtime.free 负责。
  event: [
    'tool:remember_event',
    'tool:update_relation',
    'runtime.chat',
    'runtime.free',
    'integrate.global'
  ],
  reflection: ['integrate.chat', 'integrate.global'],
  narrative: ['tool:diary_write', 'integrate.global'],
  intention: ['runtime.free', 'integrate.chat', 'integrate.global', 'user']
});

/** bodyApply 接受的键。白名单，未识别的键直接报错——不静默忽略。 */
const BODY_PATCH_KEYS = ['rev', 'spend', 'counterDelta', 'sleep', 'snooze', 'proactiveAt'];
const COUNTER_KEYS = ['todayProactive', 'todayDecisions'];
const SLEEP_KEYS = ['state', 'nightKey', 'since', 'stayUps'];

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (code, message) => ({ ok: false, code, message });

// ── 形状转换 ────────────────────────────────────────────────────────────

function pickNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * tick（磁盘上的节律状态）→ Body（端口对外的身体快照）。
 *
 * 为什么不直接把 tick 抛出去：tick 里混着调度字段（nextTickAt、energyAt…），
 * 运行时不该看到它们。端口只暴露"她现在什么样"。
 */
function toBody(tick = {}) {
  const sleep = plainObject(tick.sleep) ? tick.sleep : {};
  const snoozes = plainObject(tick.snoozes) ? tick.snoozes : {};
  const proactiveAt = plainObject(tick.proactiveAt) ? tick.proactiveAt : {};
  return {
    enabled: true,
    rev: pickNumber(tick.rev),
    energy: pickNumber(tick.energy),
    energyMax: null, // A2 起由配置注入；null 表示"未知"，调用方不要用它做判断
    counters: {
      todayProactive: pickNumber(tick.todayProactive),
      todayDecisions: pickNumber(tick.todayDecisions)
    },
    sleep: {
      state: sleep.state === 'asleep' ? 'asleep' : 'awake',
      since: pickNumber(sleep.since),
      nightKey: String(sleep.nightKey ?? ''),
      stayUps: pickNumber(sleep.stayUps)
    },
    snoozes: { ...snoozes },
    proactiveAt: { ...proactiveAt },
    impulseAt: pickNumber(tick.impulseAt)
  };
}

function emptyBody() {
  return {
    enabled: false,
    rev: 0,
    energy: 0,
    energyMax: null,
    counters: { todayProactive: 0, todayDecisions: 0 },
    sleep: { state: 'awake', since: 0, nightKey: '', stayUps: 0 },
    snoozes: {},
    proactiveAt: {},
    impulseAt: 0
  };
}

/** 关系的对外摘要。A2 起改由 `src/mind/inject.js` 的渲染器统一，避免两套措辞。 */
function relationLine(rel = {}) {
  if (!rel || !rel.userId) return '';
  const name = String(rel.nickname || rel.userId);
  const bits = [];
  if (rel.stage) bits.push(String(rel.stage));
  const known = Array.isArray(rel.knownFor) ? rel.knownFor.slice(0, 2) : [];
  if (known.length) bits.push(known.join('、'));
  const summary = String(rel.recentSummary || '').trim();
  const tail = summary ? `最近：${summary}` : '';
  return [name, bits.length ? `（${bits.join('，')}）` : '', tail ? ` ${tail}` : '']
    .join('')
    .trim();
}

// ── RuntimePort ────────────────────────────────────────────────────────

/**
 * @param {object} mind  领域存储（鸭子类型；为空时返回空实现）
 * @param {object} [deps]
 * @param {(tick:object, now:number)=>object} [deps.settle]  体力结算 + 跨天清零；由装配根绑定配置
 * @param {object} [deps.chatStore] 会话存档（scene 用；缺省时 scene 为空）
 * @param {(entry:object)=>number} [deps.scoreEntry] 现场排序分数；缺省按"多久没联系"排
 * @param {(events:object[], opts:object)=>object[]} [deps.pickEvents] 回想排序；缺省按关键词匹配
 * @param {number} [deps.energyMax]
 * @param {object} [deps.log]
 */
export function createRuntimePort(mind, deps = {}) {
  if (!mind || typeof mind.getTick !== 'function') return createNoopRuntimePort();
  const { settle = null, chatStore = null, scoreEntry = null, pickEvents = null, energyMax = null, log = console } = deps;
  const now = () => Date.now();

  const readBody = () => {
    const body = toBody(mind.getTick());
    if (Number.isFinite(Number(energyMax))) body.energyMax = Number(energyMax);
    return body;
  };

  /**
   * 应用一个身体补丁并写盘。`rev` 由调用方持有：bodyUpdate 会用刚读到的 rev，
   * bodyApply 用外部传入的 rev（可能是几秒前读的）。
   */
  const applyPatch = (patch = {}) => {
    if (!plainObject(patch)) return fail('invalid_patch', '补丁必须是对象');
    const unknown = Object.keys(patch).filter((k) => !BODY_PATCH_KEYS.includes(k));
    if (unknown.length) return fail('invalid_patch', `不认识的键：${unknown.join('、')}`);
    if (patch.rev === undefined) return fail('invalid_patch', '必须带 rev（防丢更新）');

    const tick = mind.getTick();
    const current = pickNumber(tick.rev);
    if (pickNumber(patch.rev, -1) !== current) {
      return fail('stale', '身体状态已被别处改动，请重读后重算');
    }

    const next = { ...tick, rev: current + 1 };
    let spent = 0;

    if (patch.spend !== undefined) {
      const want = Math.max(0, pickNumber(patch.spend));
      const before = pickNumber(tick.energy);
      spent = Math.min(before, want);
      next.energy = before - spent;
    }

    if (patch.counterDelta !== undefined) {
      if (!plainObject(patch.counterDelta)) return fail('invalid_patch', 'counterDelta 必须是对象');
      for (const [key, delta] of Object.entries(patch.counterDelta)) {
        if (!COUNTER_KEYS.includes(key)) return fail('invalid_patch', `不认识的计数：${key}`);
        next[key] = Math.max(0, pickNumber(tick[key]) + pickNumber(delta));
      }
    }

    if (patch.sleep !== undefined) {
      if (!plainObject(patch.sleep)) return fail('invalid_patch', 'sleep 必须是对象');
      const base = plainObject(tick.sleep) ? tick.sleep : {};
      const merged = { ...base };
      for (const [key, value] of Object.entries(patch.sleep)) {
        if (!SLEEP_KEYS.includes(key)) return fail('invalid_patch', `不认识的睡眠字段：${key}`);
        merged[key] = value;
      }
      next.sleep = merged;
    }

    if (patch.snooze !== undefined) {
      // 整表替换，不是合并：调用点都是"算出新整表再写"。
      if (!plainObject(patch.snooze)) return fail('invalid_patch', 'snooze 必须是对象');
      next.snoozes = { ...patch.snooze };
    }

    if (patch.proactiveAt !== undefined) {
      if (!plainObject(patch.proactiveAt)) return fail('invalid_patch', 'proactiveAt 必须是对象');
      const { chatKey, at } = patch.proactiveAt;
      if (!chatKey) return fail('invalid_patch', 'proactiveAt 需要 chatKey');
      const base = plainObject(tick.proactiveAt) ? tick.proactiveAt : {};
      next.proactiveAt = { ...base, [String(chatKey)]: pickNumber(at, now()) };
    }

    try {
      mind.updateTick(next);
    } catch (error) {
      log.error?.(`[mind-port] 写身体状态失败：${error?.message ?? error}`);
      return fail('store-error', '体力状态写入失败');
    }
    return ok({ body: readBody(), spent });
  };

  return {
    apiVersion: MIND_PORT_API,
    get enabled() { return true; },

    // ── 身体 ──────────────────────────────────────────────────────────

    bodyRead: readBody,

    /**
     * 结算能量 + 跨天清零，并写盘。取代「settleEnergy + resetDaily + updateTick」三步。
     * 结算函数由装配根注入：它是领域逻辑，端口不复制一份，否则两处公式必然漂移。
     */
    bodySettle({ now: at = now() } = {}) {
      try {
        if (typeof settle === 'function') {
          const settled = settle(mind.getTick(), at);
          if (plainObject(settled)) mind.updateTick(settled);
        }
        return { ok: true, body: readBody() };
      } catch (error) {
        log.error?.(`[mind-port] 结算失败：${error?.message ?? error}`);
        return fail('store-error', '体力结算失败');
      }
    },

    /**
     * 原子补丁 + 比较并交换（**遗留入口**）。
     *
     * `rev` 必填。它只适用于"必须先读到、稍后才写"的场景：读取与写入之间夹了 await，
     * 期间别处可能已经改过身体，rev 不符就返回 stale。
     * 只做一次写的话，优先用 bodyUpdate —— 那里没有这个时间窗。
     */
    bodyApply: applyPatch,

    /**
     * 同步读-改-写：读当前身体 → 回调算补丁 → 一次写盘。
     *
     * 回调是同步的，中间没有 await，整个过程天然原子；这是调用方**首选**的写法，
     * 也是把旧代码里"先 getTick 再 updateTick"的两步收敛成一步的地方。
     * 回调返回 null/undefined 表示"这次不改"，不算错误。
     *
     * @param {(body: object) => (object|null)} mutate
     * @returns {{ok:boolean, body?:object, spent?:number, changed?:boolean, code?:string}}
     */
    bodyUpdate(mutate) {
      if (typeof mutate !== 'function') return fail('invalid_patch', 'bodyUpdate 需要回调');
      const snapshot = readBody();
      let patch;
      try {
        // 给回调一份浅拷贝，避免它顺手改了快照又被当成补丁
        patch = mutate({
          ...snapshot,
          counters: { ...snapshot.counters },
          sleep: { ...snapshot.sleep },
          snoozes: { ...snapshot.snoozes },
          proactiveAt: { ...snapshot.proactiveAt }
        });
      } catch (error) {
        log.error?.(`[mind-port] 身体补丁回调抛错：${error?.message ?? error}`);
        return fail('store-error', '身体补丁计算失败');
      }
      if (patch === null || patch === undefined) return ok({ body: snapshot, spent: 0, changed: false });
      const result = applyPatch({ ...patch, rev: snapshot.rev });
      return result.ok ? { ...result, changed: true } : result;
    },

    // ── 现场 ──────────────────────────────────────────────────────────

    /**
     * 她现在看得到谁。取代：listChats + getChatMeta + getRelation + queryEvents 的散装拼装。
     *
     * A1 只给到私聊；群聊进 roster 是后续版本的事（与现有 global 唤醒一致）。
     */
    scene({ now: at = now(), limit = 3 } = {}) {
      if (!chatStore || typeof chatStore.listChats !== 'function') {
        return { entries: [], restCount: 0 };
      }
      let chats = [];
      try {
        chats = (chatStore.listChats() || []).filter((k) => String(k).startsWith('private:'));
      } catch (error) {
        log.error?.(`[mind-port] 读会话列表失败：${error?.message ?? error}`);
        return { entries: [], restCount: 0 };
      }

      const entries = [];
      for (const chatKey of chats) {
        try {
          const meta = chatStore.getChatMeta?.(chatKey) || {};
          const chatId = String(chatKey).split(':')[1] || '';
          const rel = mind.getRelation?.(chatId) || {};
          const lastTs = pickNumber(meta.lastTs);
          const lastEventAt = (() => {
            try {
              const list = mind.queryEvents?.({ chatKey, limit: 1 }) || [];
              return pickNumber(list[list.length - 1]?.ts);
            } catch { return 0; }
          })();
          const hoursSince = lastTs > 0 ? Math.max(0, Math.round((at - lastTs) / 3600000)) : null;
          const openLoopsDue = (Array.isArray(rel.openLoops) ? rel.openLoops : []).filter((l) => {
            const since = Number(l?.since) || 0;
            return since > 0 && at - since >= 24 * 3600000;
          }).length;
          const proactiveAt = pickNumber((mind.getTick()?.proactiveAt || {})[chatKey]);
          entries.push({
            chatKey,
            name: String(rel.nickname || chatId),
            stage: String(rel.stage || ''),
            warmth: pickNumber(rel.warmth),
            hoursSince,
            unread: pickNumber(meta.unread),
            lastLine: String(meta.lastText || '').slice(0, 30),
            lastEventAt,
            openLoopsDue,
            running: false, // 由运行时自己填（端口不该知道谁在跑）
            recent: lastTs > 0 && at - lastTs < 2 * 60000,
            suppressed: proactiveAt > 0 && at - proactiveAt < 600000
          });
        } catch (error) {
          log.error?.(`[mind-port] 现场读取失败（${chatKey}）：${error?.message ?? error}`);
        }
      }

      const score = typeof scoreEntry === 'function'
        ? scoreEntry
        : (e) => {
          // 缺省只按"沉默时长"排。真正的打分（未读 > 到期 > 沉默 > 亲近）
          // 属于领域知识，A2 起由装配根注入，避免两处各写一份。
          return Math.min(30, e.hoursSince ?? 0);
        };
      entries.sort((a, b) => score(b) - score(a) || String(a.name).localeCompare(String(b.name)));
      const top = entries.slice(0, Math.max(0, limit));
      return { entries: top, restCount: Math.max(0, entries.length - top.length) };
    },

    /** 她是谁（一句话）。A2 起统一到 `src/mind/inject.js` 的渲染器。 */
    selfBrief() {
      try {
        const narrative = String(mind.getSelf?.()?.narrative || '').trim();
        return narrative.slice(0, 160);
      } catch { return ''; }
    },

    /** 对某个人的看法（一句话）。 */
    relationBrief(userId) {
      try {
        return relationLine(mind.getRelation?.(userId));
      } catch { return ''; }
    },

    // ── 记忆读取 ──────────────────────────────────────────────────────

    /**
     * 回想。缺省按关键词字面匹配 + 时间近的优先；A2 起接 `src/mind/recall.js` 的打分器。
     * 不抛：查不到就是空数组。
     */
    recall({ chatKey = '', query = '', limit = 6, sinceTs = 0 } = {}) {
      try {
        let events = mind.queryEvents?.({ chatKey: chatKey || undefined, fromTs: sinceTs || undefined }) || [];
        if (typeof pickEvents === 'function') {
          events = pickEvents(events, { query, limit, now: now() }) || [];
        } else if (String(query || '').trim()) {
          const needle = String(query).trim();
          events = events.filter((e) => String(e.text || '').includes(needle));
        }
        return events.slice(-Math.max(1, limit));
      } catch { return []; }
    },

    recentEvents({ chatKey = '', limit = 5, sinceTs = 0 } = {}) {
      try {
        const events = mind.queryEvents?.({
          chatKey: chatKey || undefined,
          fromTs: sinceTs || undefined,
          limit: Math.max(1, limit)
        }) || [];
        return events.slice(-Math.max(1, limit));
      } catch { return []; }
    },

    /**
     * 反思账本：欠了多少条未整理、上次尝试是什么时候。
     * 两者一起给，是因为调用方几乎总是同时要（攒够没 + 冷却没）。
     */
    reflectionState({ chatKey = '' } = {}) {
      try {
        const tick = mind.getTick?.() || {};
        return {
          debt: Number(mind.countUnreflected?.(chatKey, pickNumber(tick.lastReflectAt))) || 0,
          lastAttemptAt: pickNumber(tick.lastReflectAttemptAt),
          // 每日上限要用的两个字段。放在同一次读里，调用方不必再摸 store。
          today: String(tick.today || ''),
          todayReflections: pickNumber(tick.todayReflections)
        };
      } catch { return { debt: 0, lastAttemptAt: 0, today: '', todayReflections: 0 }; }
    },

    /** 未反思事件数。`since` 缺省取她的 `lastReflectAt`，与现有语义一致。 */
    reflectionDebt({ chatKey = '', since = null } = {}) {
      try {
        const from = since === null ? pickNumber(mind.getTick?.()?.lastReflectAt) : pickNumber(since);
        return Number(mind.countUnreflected?.(chatKey, from)) || 0;
      } catch { return 0; }
    },

    /** @returns {{at:number, actionId:string, reason:string, ok:boolean}|null} */
    lastAction() {
      try {
        const list = mind.listActions?.({ limit: 2 }) || [];
        const item = list[list.length - 1];
        if (!item?.at) return null;
        return {
          at: pickNumber(item.at),
          actionId: String(item.action || ''),
          reason: String(item.reason || ''),
          ok: !item.error
        };
      } catch { return null; }
    },

    recentActions({ limit = 10 } = {}) {
      try { return mind.listActions?.({ limit }) || []; } catch { return []; }
    },

    // ── 意图（B3 起有存储）──────────────────────────────────────────────

    /** 她的待办（按到期时间排）。读永远不抛。 */
    intentions({ status = 'open', dueBefore = 0, limit = 20 } = {}) {
      try { return mind.listIntentions?.({ status, dueBefore, limit }) || []; } catch { return []; }
    },

    // ── 记录 ──────────────────────────────────────────────────────────

    /** A 期沿用 appendAction；B4 起由 recordAttempt 取代（唯一读路径见规格 §8.4）。 */
    recordAction(entry = {}) {
      try {
        const record = mind.appendAction?.(entry);
        return ok({ id: String(record?.id || '') });
      } catch (error) {
        log.error?.(`[mind-port] 记录行动失败：${error?.message ?? error}`);
        return fail('store-error', '行动记录写入失败');
      }
    },

    recordAttempt() { return fail('not-implemented', '尝试记录在 B 期接入'); },
    recordOutcome() { return fail('not-implemented', '观测在 B 期接入'); },
    openObservations() { return []; }
  };
}

// ── WriterPort ─────────────────────────────────────────────────────────

/** 把管线的 `by` 映射成 store 认识的三档（self / reflection / owner）。 */
function storeBy(by) {
  if (by === 'tool:self_revise') return 'self';
  if (by === 'user') return 'owner';
  if (String(by || '').startsWith('integrate.')) return 'reflection';
  return 'self';
}

/**
 * @param {object} mind
 * @param {object} opts
 * @param {string} opts.by        来源，**由管线按调用注入**，工具侧拿不到
 * @param {string} [opts.ownerId]
 * @param {string} [opts.momentId]
 */
export function createWriterPort(mind, opts = {}) {
  if (!mind || typeof mind.appendEvent !== 'function') return createNoopWriterPort();
  const { by = '', ownerId = '', momentId = '', log = console } = opts;
  const allowed = (target) => (WRITERS[target] || []).includes(by);
  const deny = (target) => fail('not_a_writer', `来源 ${by || '(未指定)'} 不能写 ${target}`);

  return {
    apiVersion: MIND_PORT_API,
    get enabled() { return true; },
    get by() { return by; },
    get ownerId() { return ownerId; },

    canWrite(target, who = by) {
      return (WRITERS[target] || []).includes(who);
    },

    appendEvent(input = {}) {
      if (!allowed('event')) return deny('event');
      try {
        const r = mind.appendEvent({ ...input, source: input.source || 'tool' });
        if (!r?.ok) return fail('store-error', r?.reason || '事件写入失败');
        return ok({ event: r.event, duplicate: r.duplicate === true });
      } catch (error) {
        log.error?.(`[mind-port] 写事件失败：${error?.message ?? error}`);
        return fail('store-error', '事件写入失败');
      }
    },

    patchRelation(userId, patch = {}, meta = {}) {
      if (!allowed('relation')) return deny('relation');
      const evidence = Array.isArray(meta.evidence) ? meta.evidence.filter(Boolean) : [];
      // 关系必须有据：凭空气改看法是她最不该有的能力。
      if (!evidence.length && by !== 'migration') {
        return fail('needs_evidence', '改对人的看法必须给依据（事件 id）');
      }
      try {
        // 来源与理由一路带到 store：关系的 changelog 要能回答"谁改的、为什么"。
        const r = mind.patchRelation(userId, patch, {
          evidence, now: Date.now(), by, reason: String(meta.reason || '').trim()
        });
        if (!r?.ok) return fail('invalid_patch', r?.reason || '关系更新失败');
        return ok({ relation: r.relation, clamp: r.clamp || [] });
      } catch (error) {
        log.error?.(`[mind-port] 更新关系失败：${error?.message ?? error}`);
        return fail('store-error', '关系更新失败');
      }
    },

    reviseSelf(patch = {}, meta = {}) {
      const target = 'self.narrative';
      if (!allowed(target)) return deny(target);
      const reason = String(meta.reason || '').trim();
      if (!reason) return fail('needs_reason', '改写自我必须写理由');
      try {
        const r = mind.reviseSelf(patch, { by: storeBy(by), reason, now: Date.now() });
        if (!r?.ok) return fail('invalid_patch', r?.reason || '改写被拒绝');
        return ok({ self: r.self });
      } catch (error) {
        log.error?.(`[mind-port] 改写自我失败：${error?.message ?? error}`);
        return fail('store-error', '改写自我失败');
      }
    },

    appendReflection(input = {}) {
      if (!allowed('reflection')) return deny('reflection');
      try {
        const r = mind.appendReflection?.(input);
        return ok({ reflection: r?.id ? r : r });
      } catch (error) {
        log.error?.(`[mind-port] 写反思失败：${error?.message ?? error}`);
        return fail('store-error', '反思写入失败');
      }
    },

    /** 叙事（日记）：B 期才有存储。 */
    writeNarrative() { return fail('not-implemented', '叙事在 B 期接入'); },

    /**
     * 挂一条意图："我想做某件事，打算什么时候做"。
     *
     * 与 recordAttempt 分开：意图是她想做什么，尝试是有没有做成。
     * 一条意图可以对应多次尝试（失败重试），归因才不会糊在一起。
     */
    proposeIntention(input, meta = {}) {
      if (!allowed('intention')) return deny('intention');
      try {
        // 来源按写入句柄推断：工具与整合算"聊天时想到的"，自由时刻自己想的算 free。
        const source = input?.source
          || (by === 'user' ? 'user' : (by === 'runtime.free' ? 'free' : 'chat'));
        const r = mind.addIntention?.({ ...input, source }) || { ok: false, reason: '存储不支持意图' };
        if (!r?.ok) return fail('invalid_patch', r?.reason || '意图写入失败');
        return ok({ intention: r.intention, duplicate: r.duplicate === true });
      } catch (error) {
        log.error?.(`[mind-port] 写意图失败：${error?.message ?? error}`);
        return fail('store-error', '意图写入失败');
      }
    },

    /** 了结一条意图：done / dropped / expired。 */
    closeIntention(id, { status = 'done', note = '' } = {}) {
      if (!allowed('intention')) return deny('intention');
      try {
        const r = mind.resolveIntention?.(id, { status, note, now: Date.now() }) || { ok: false };
        if (!r?.ok) return fail('invalid_patch', r?.reason || '意图了结失败');
        return ok({ intention: r.intention, unchanged: r.unchanged === true });
      } catch (error) {
        log.error?.(`[mind-port] 了结意图失败：${error?.message ?? error}`);
        return fail('store-error', '意图了结失败');
      }
    },

    /** 自我笔记：会话级反思的产物，只记为"待整合"，不是改写自我。 */
    writeSelfNotes(notes, meta = {}) {
      if (!allowed('self.notes')) return deny('self.notes');
      try {
        const r = mind.appendSelfNotes?.(notes, { by, now: Date.now() });
        if (!r?.ok) return fail('invalid_patch', r?.reason || '笔记写入失败');
        return ok({ added: r.added ?? 0, self: r.self });
      } catch (error) {
        log.error?.(`[mind-port] 写自我笔记失败：${error?.message ?? error}`);
        return fail('store-error', '自我笔记写入失败');
      }
    }
  };
}

// ── AdminPort ──────────────────────────────────────────────────────────

/**
 * 控制台与迁移专用：一对一包住 store，不做任何语义化。
 * 控制台要看"原样的状态"，聚合会掩盖诊断信息。
 *
 * 它**不得**出现在 `src/runtime/` 或 `src/contract/pipeline.js` 里（A1 静态检查守）。
 */
export function createAdminPort(mind) {
  if (!mind) return createNoopAdminPort();
  const methods = [
    'getTick', 'updateTick', 'getSelf', 'listRelations', 'patchRelation', 'reviseSelf',
    'queryEvents', 'countUnreflected', 'listReflections', 'listActions', 'appendEvent',
    'appendReflection', 'appendAction', 'logSizes', 'clearLogs'
  ];
  const port = { apiVersion: MIND_PORT_API, get enabled() { return true; } };
  for (const name of methods) {
    port[name] = typeof mind[name] === 'function' ? mind[name].bind(mind) : () => undefined;
  }
  port.listIntentions = typeof mind.listIntentions === 'function'
    ? mind.listIntentions.bind(mind)
    : () => [];
  return port;
}

// ── 空实现（无心智时的样子）────────────────────────────────────────────

export function createNoopRuntimePort() {
  const nothing = () => fail('no-mind', '心智功能未启用');
  return {
    apiVersion: MIND_PORT_API,
    get enabled() { return false; },
    bodyRead: emptyBody,
    bodySettle() { return { ok: true, body: emptyBody() }; },
    bodyApply: nothing,
    scene() { return { entries: [], restCount: 0 }; },
    selfBrief() { return ''; },
    relationBrief() { return ''; },
    recall() { return []; },
    recentEvents() { return []; },
    reflectionState() { return { debt: 0, lastAttemptAt: 0, today: '', todayReflections: 0 }; },
    reflectionDebt() { return 0; },
    lastAction() { return null; },
    recentActions() { return []; },
    intentions() { return []; },
    recordAction: nothing,
    recordAttempt: nothing,
    recordOutcome: nothing,
    openObservations() { return []; }
  };
}

export function createNoopWriterPort() {
  const nothing = () => fail('no-mind', '心智功能未启用');
  return {
    apiVersion: MIND_PORT_API,
    get enabled() { return false; },
    get by() { return ''; },
    get ownerId() { return ''; },
    canWrite() { return false; },
    appendEvent: nothing,
    patchRelation: nothing,
    reviseSelf: nothing,
    appendReflection: nothing,
    writeNarrative: nothing,
    writeSelfNotes: nothing,
    proposeIntention: nothing,
    closeIntention: nothing
  };
}

export function createNoopAdminPort() {
  const nothing = () => undefined;
  return {
    apiVersion: MIND_PORT_API,
    get enabled() { return false; },
    getTick: () => ({}),
    updateTick: nothing,
    getSelf: () => ({}),
    listRelations: () => [],
    patchRelation: () => ({ ok: false, code: 'no-mind' }),
    reviseSelf: () => ({ ok: false, code: 'no-mind' }),
    queryEvents: () => [],
    countUnreflected: () => 0,
    listReflections: () => [],
    listActions: () => [],
    appendEvent: () => ({ ok: false, code: 'no-mind' }),
    appendReflection: nothing,
    appendAction: nothing,
    logSizes: () => ({ actions: 0, reflections: 0, total: 0 }),
    clearLogs: () => ({ ok: false, code: 'no-mind' }),
    listIntentions: () => []
  };
}
