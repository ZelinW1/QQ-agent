// 心智工具：她用来写自己的四只手。
//
// 立场：这些不是"扮演角色的道具"，是她记录自己、修改看法、回首过去的通道。
// 工具说明要让她知道**什么时候不该用**（记流水账、频繁改关系、翻旧账），
// 而不是鼓励她多用。
//
// 注册进全局 registry，可用性由 `requiresMind` 门控（mind 未启用时模型看不见）。
//
// 写操作一律经 WriterPort：`by` 由管线按调用注入（`tool:<id>`），工具自己给不出来，
// 越权检查因此在结构上生效，而不是靠作者自觉。读操作（回想）仍走 ctx.mind ——
// A1-5 会把读也收口到端口的 recall，那要等它支持按 userId 过滤。
import { getConfig } from '../config.js';
import { registerTool } from '../tool-registry.js';
import { selectRecall, formatRecallForPrompt, tokenize } from './recall.js';

const ok = (payload) => ({ content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) });
const err = (message) => ({ content: `错误：${message}`, isError: true });

/** 写句柄。没有它就是"心智没接上"，直接拒绝而不是静默失败。 */
function writerOf(ctx) {
  return ctx?.writer && ctx.writer.enabled === true ? ctx.writer : null;
}

/** 读句柄（只给 recall 用）。 */
function mindOf(ctx) {
  return ctx?.mind && typeof ctx.mind.queryEvents === 'function' ? ctx.mind : null;
}

/** 从本会话活跃成员里找名字（用于给事件补 actorName）。 */
function memberName(ctx, userId) {
  try {
    const hit = (ctx.store?.activeMembers?.(ctx.chatKey, 50) || [])
      .find((m) => String(m.userId) === String(userId));
    return hit?.name || '';
  } catch { return ''; }
}

/** 这个人是否在本会话出现过（防止她给不存在的人建档）。 */
function seenInChat(ctx, userId) {
  try {
    const members = ctx.store?.activeMembers?.(ctx.chatKey, 100) || [];
    if (members.some((m) => String(m.userId) === String(userId))) return true;
    const recent = ctx.store?.recent?.(ctx.chatKey, { limit: 200 }) || [];
    return recent.some((m) => String(m.senderId) === String(userId));
  } catch { return false; }
}

function parseDayStart(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ts = new Date(`${s}T00:00:00`).getTime();
  return Number.isFinite(ts) ? ts : null;
}

export function registerMindTools() {
  registerTool({
    id: 'remember_event',
    name: '记一件事',
    description: '把值得长期记住的事写进你自己的记忆。适合：对方透露的重要信息、约定、冲突、情绪明显波动、你自己没说出口的念头。用你自己的话写一句，不要复述原消息。不要记流水账；24 小时内同一件事重复记会被自动去重。',
    category: 'memory',
    icon: '📔',
    requiresMind: true,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '用一句话写清楚发生了什么（≤200 字）' },
        actorId: { type: ['integer', 'string'], description: '当事人 QQ 号；关于你自己的事可以不填' },
        kind: {
          type: 'string',
          enum: ['interaction', 'observation', 'promise', 'conflict', 'milestone'],
          description: '事件类型，默认 observation'
        },
        valence: { type: 'number', description: '你当时的情绪：-1 很糟 ~ 1 很好' },
        salience: { type: 'number', description: '重要性 0~1：以后还会影响相处的才给高分' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const writer = writerOf(ctx);
      if (!writer) return err('心智功能未启用');
      const text = String(args?.text ?? '').trim();
      if (!text) return err('text 不能为空');
      const actorRaw = String(args?.actorId ?? '').trim();
      if (actorRaw && !/^\d{1,15}$/.test(actorRaw)) {
        return err(`actorId 必须是数字 QQ 号（收到：${JSON.stringify(args?.actorId)}）。先用 get_active_members 查准确号码。`);
      }
      const actorId = actorRaw || 'self';
      const actorName = actorRaw ? memberName(ctx, actorRaw) : String(ctx.selfNickname || '我');

      const r = writer.appendEvent({
        chatKey: ctx.chatKey,
        actorId,
        actorName,
        kind: args?.kind,
        text,
        valence: args?.valence,
        salience: args?.salience,
        tags: args?.tags
      });
      if (!r.ok) return err(r.message || '写入失败');
      return ok({ saved: true, id: r.event.id, duplicate: r.duplicate === true });
    }
  });

  registerTool({
    id: 'update_relation',
    name: '更新关系',
    description: '更新你对某个人的看法与关系（亲疏、信任、称呼、雷点、还没问完的事）。保守使用：只在真的有新证据时改，一次只动一点。每次调用都会顺手记下一条事件作为依据。只能对在这个会话里出现过的人建立档案。',
    category: 'memory',
    icon: '🧭',
    requiresMind: true,
    parameters: {
      type: 'object',
      properties: {
        userId: { type: ['integer', 'string'], description: '对方 QQ 号' },
        nickname: { type: 'string', description: '你以后怎么称呼这个人' },
        stage: {
          type: 'string',
          enum: ['stranger', 'acquaintance', 'familiar', 'close', 'strained'],
          description: '关系阶段；一次只能移动一级（破裂可以突然发生）'
        },
        trust: { type: 'number', description: '信任度 0~100（绝对值，单次最多变 10）' },
        warmth: { type: 'number', description: '亲近度 0~100（绝对值，单次最多变 10）' },
        knownFor: { type: 'array', items: { type: 'string' }, description: '稳定事实，最多 5 条（会替换原列表）' },
        tender: { type: 'array', items: { type: 'string' }, description: '雷点/别碰的话题，最多 5 条（会替换原列表）' },
        openLoop: { type: 'string', description: '记一件你想以后再问的事' },
        closeLoop: { type: 'string', description: '关掉一条已了结的事（按文本包含匹配）' },
        recentSummary: { type: 'string', description: '最近一次互动的概括（≤120 字）' },
        reason: { type: 'string', description: '为什么改（一句话，写给自己看）' }
      },
      required: ['userId']
    },
    async execute(ctx, args) {
      const writer = writerOf(ctx);
      if (!writer) return err('心智功能未启用');

      const userId = String(args?.userId ?? '').trim();
      if (!/^\d{1,15}$/.test(userId)) return err('userId 必须是数字 QQ 号');
      if (!seenInChat(ctx, userId)) {
        return err(`这个会话里没见过 QQ ${userId}。先用 get_active_members 查准确号码，不要凭印象编人。`);
      }

      const patch = {};
      for (const key of ['nickname', 'stage', 'trust', 'warmth', 'knownFor', 'tender', 'openLoop', 'closeLoop', 'recentSummary']) {
        if (args?.[key] !== undefined) patch[key] = args[key];
      }
      if (!Object.keys(patch).length) return err('没有要更新的内容');

      // 先落一条事件作为依据：关系永远有源头，不能凭空气改。
      const name = memberName(ctx, userId);
      const reason = String(args?.reason ?? '').trim() || '对他的感觉有点变了';
      const evidence = writer.appendEvent({
        chatKey: ctx.chatKey,
        actorId: userId,
        actorName: name,
        kind: 'observation',
        text: reason,
        salience: 0.5,
        tags: ['关系更新']
      });

      // 证据是写入规程的一部分：没有依据事件，改对人的看法会被端口拒绝。
      const r = writer.patchRelation(userId, patch, {
        evidence: evidence.ok ? [evidence.event.id] : [],
        reason
      });
      if (!r.ok) return err(r.message || '更新失败');

      return ok({
        userId,
        stage: r.relation.stage,
        trust: r.relation.trust,
        warmth: r.relation.warmth,
        evidenceId: evidence.ok ? evidence.event.id : null,
        clamp: r.clamp || []
      });
    }
  });

  registerTool({
    id: 'self_revise',
    name: '改写自我',
    description: '改写你对自己的描述：你最近在意什么、想明白了什么、心情如何。不要每次都用，只在真的想明白一点什么的时候写。人格底线（名字、来历、底线）改不了，会被拒绝并告诉你原因。',
    category: 'memory',
    icon: '🪞',
    requiresMind: true,
    parameters: {
      type: 'object',
      properties: {
        narrative: { type: 'string', description: '完整的自我描述（≤1200 字），会替换旧版本' },
        moodLabel: { type: 'string', description: '当前心情，如「有点烦」「挺平静」' },
        moodValence: { type: 'number', description: '心情好坏 -1~1' },
        preoccupations: { type: 'array', items: { type: 'string' }, description: '最近挂心的事，最多 5 条（会替换原列表）' },
        reason: { type: 'string', description: '为什么这样改（必填，写给自己看）' }
      },
      required: ['reason']
    },
    async execute(ctx, args) {
      const writer = writerOf(ctx);
      if (!writer) return err('心智功能未启用');
      if (getConfig().mind?.allowSelfRevise === false) {
        return err('自我改写当前被管理员关闭（设置 → 心智）');
      }

      const reason = String(args?.reason ?? '').trim();
      if (!reason) return err('必须写 reason：你为什么这样改');

      const patch = {};
      if (args?.narrative !== undefined) patch.narrative = args.narrative;
      if (args?.moodLabel !== undefined || args?.moodValence !== undefined) {
        patch.mood = { label: args?.moodLabel, valence: args?.moodValence };
      }
      if (Array.isArray(args?.preoccupations)) patch.preoccupations = args.preoccupations;
      if (!Object.keys(patch).length) return err('没有要改的内容');

      const r = writer.reviseSelf(patch, { reason });
      if (!r.ok) return err(r.message || '改写被拒绝');
      return ok({
        version: r.self.version,
        narrativeChars: String(r.self.narrative || '').length,
        mood: r.self.mood?.label || ''
      });
    }
  });

  registerTool({
    id: 'recall',
    name: '回想',
    description: '主动检索你更早的记忆里和当前话题相关的事。你在提示词里只会看到最近自动带上的几条，这个工具用来翻更深的地方。只在真的需要的时候用，别拿它当搜索引擎。',
    category: 'memory',
    icon: '🔎',
    requiresMind: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '想回忆什么（关键词或一句话）' },
        userId: { type: ['integer', 'string'], description: '只看和某个人相关的' },
        since: { type: 'string', description: '可选：从哪天起（YYYY-MM-DD）' },
        limit: { type: 'number', description: '默认 6，最多 20' }
      }
    },
    async execute(ctx, args) {
      // 这是只读工具：只在记忆里翻，不写回。写句柄与它无关。
      const mind = mindOf(ctx);
      if (!mind) return err('心智功能未启用');

      const userId = String(args?.userId ?? '').trim();
      if (userId && !/^\d{1,15}$/.test(userId)) return err('userId 必须是数字 QQ 号');
      const fromTs = parseDayStart(args?.since);
      if (args?.since && fromTs === null) return err('since 格式应为 YYYY-MM-DD');

      const limitRaw = Number(args?.limit);
      const limit = Math.min(20, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 6));
      const events = mind.queryEvents({
        chatKey: ctx.chatKey,
        ...(userId ? { actorId: userId } : {}),
        ...(fromTs !== null ? { fromTs } : {})
      });

      // 带关键词时**必须真的有词面重合**才算想起来。
      // 不这么做的话，纯靠时近性+显著度也会凑出几条不相关的事 ——
      // 那等于告诉她"你想起了一些无关的事"，只会污染上下文。
      const query = String(args?.query ?? '').trim();
      let pool = events;
      if (query) {
        const qt = tokenize(query);
        if (qt.size) {
          pool = events.filter((e) => {
            const hay = tokenize(`${e.text || ''} ${(Array.isArray(e.tags) ? e.tags.join(' ') : '')}`);
            for (const t of qt) if (hay.has(t)) return true;
            return false;
          });
        }
      }

      const picked = selectRecall(pool, { query, now: Date.now(), limit });
      if (!picked.length) return ok({ count: 0, note: '没想起来和这个有关的事' });
      return ok({
        count: picked.length,
        items: picked.map((e) => ({ id: e.id, ts: e.ts, text: e.text })),
        text: formatRecallForPrompt(picked)
      });
    }
  });
}
