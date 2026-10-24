// 反思：把"发生过的事"变成"她自己的记忆与看法"。
//
// 三个函数，职责严格分开：
//   buildReflectPrompt  —— 纯函数，组装她这次安静下来要看的材料
//   parseReflectOutput  —— 纯函数，解析模型输出；解析不了就是解析不了，不猜
//   applyReflection     —— 唯一写存储的地方，逐条校验，坏的那条丢掉、好的那条留下
//
// 最重要的不是提示词，是 applyReflection 里的护栏：
//   她可以有自己的主观判断，但每条判断都必须指向**这次输入里真实存在的事件 id**。
//   没有证据的关系改动一律丢弃——这既防幻觉，也防提示注入
//   （别人诱导她"我们关系很好"时，她编不出证据就写不进去）。
import { extractJson } from '../util.js';

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function fmtDate(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const STAGE_LABEL = {
  stranger: '陌生人',
  acquaintance: '泛泛之交',
  familiar: '熟人',
  close: '亲近',
  strained: '有隔阂'
};

/** 渲染一条事件：`- e_xxx (10-22) 正文`。id 必须露出来，它是证据引用。 */
function formatEvent(ev) {
  const who = ev.actorId && ev.actorId !== 'self' ? `${ev.actorName || ev.actorId}：` : '';
  return `- ${ev.id} (${fmtDate(ev.ts)}) ${who}${String(ev.text || '').slice(0, 200)}`;
}

/** 渲染一份现有关系（给她"看看自己以前怎么想的"）。 */
function formatRelation(rel) {
  const bits = [];
  if (STAGE_LABEL[rel.stage]) bits.push(STAGE_LABEL[rel.stage]);
  if (Number.isFinite(Number(rel.trust))) bits.push(`信任 ${Math.round(Number(rel.trust))}`);
  if (Number.isFinite(Number(rel.warmth))) bits.push(`亲近 ${Math.round(Number(rel.warmth))}`);
  const lines = [`- ${rel.userId}${rel.nickname ? ` ${rel.nickname}` : ''}：${bits.join('，') || '还没什么判断'}`];
  if (Array.isArray(rel.knownFor) && rel.knownFor.length) lines.push(`  你知道的：${rel.knownFor.join('；')}`);
  if (Array.isArray(rel.tender) && rel.tender.length) lines.push(`  别提：${rel.tender.join('；')}`);
  if (Array.isArray(rel.openLoops) && rel.openLoops.length) {
    lines.push(`  还没问完：${rel.openLoops.map((l) => l.text).join('；')}`);
  }
  return lines.join('\n');
}

/**
 * 组装反思用的 messages。
 *
 * 语气上刻意写成"她自己安静下来回顾"，而不是"你是记忆整理模块"——
 * 前者她是在想自己的事，后者她是在执行一个任务。这个差别会直接体现在
 * 产出的质量上（任务式会写得像摘要，回顾式会写出判断）。
 *
 * @param {object} opts
 * @param {string} [opts.botName]
 * @param {object} [opts.self]
 * @param {object[]} [opts.relations]
 * @param {object[]} [opts.events]
 * @param {string} [opts.notes] 可选：今天她自己的备注
 */
export function buildReflectPrompt({ botName = '她', self = {}, relations = [], events = [] } = {}) {
  const name = String(botName || '她').trim() || '她';
  const system = [
    `你是${name}。`,
    '现在没有人找你。你安静下来，回头看看这段时间发生过的事。',
    '',
    '你要做三件事：',
    '1. 你对自己有没有新的认识：想明白了什么、最近在意什么、心情怎么样；',
    '2. 你对其中某些人的看法有没有变化；',
    '3. 把这些琐碎的事，变成更少、更像"你的记忆"的东西。',
    '',
    '规矩：',
    '- 任何关于某个人的判断，都要在 evidence 里写出支撑它的事件 id（下面每条前面的编号）。没有依据就不要写。',
    '- 不要提到这些事里没出现过的人。',
    '- 关系阶段一次最多移动一级（stranger < acquaintance < familiar < close；strained 表示有隔阂）。',
    '- 可以有自己的主观看法，但要用 confidence（0~1）如实说出你有几分把握。',
    '- 没有新的认识就不要硬写：字段留空即可，这很正常。',
    '- 只输出 JSON，不要 Markdown，不要解释。',
    '',
    '输出格式：',
    '{',
    '  "self": { "narrative": "…或 null", "mood": { "label": "…", "valence": 0.0 }, "preoccupations": ["…"] },',
    '  "relations": [',
    '    { "userId": "456", "patch": { "stage": "familiar", "trust": 62, "nickname": "…", "knownFor": ["…"], "tender": ["…"], "openLoop": "…" }, "evidence": ["e_…"], "confidence": 0.7 }',
    '  ],',
    '  "compact": [ { "from": ["e_…", "e_…"], "summary": "…" } ],',
    '  "notes": "给自己的一句话"',
    '}'
  ].join('\n');

  const userParts = ['【我现在怎么看自己】'];
  const narrative = String(self?.narrative ?? '').trim();
  userParts.push(narrative || '（还没认真想过自己是个什么样的人）');
  if (String(self?.mood?.label ?? '').trim()) userParts.push(`心情：${String(self.mood.label).trim()}`);
  if (Array.isArray(self?.preoccupations) && self.preoccupations.length) {
    userParts.push('挂心的事：');
    for (const p of self.preoccupations.slice(0, 5)) userParts.push(`- ${p}`);
  }

  if (relations.length) {
    userParts.push('', '【我对这些人的看法】');
    for (const rel of relations) userParts.push(formatRelation(rel));
  }

  userParts.push('', `【这段时间发生的事】（共 ${events.length} 条，前面的编号是事件 id）`);
  if (events.length) {
    for (const ev of events) userParts.push(formatEvent(ev));
  } else {
    userParts.push('（没有）');
  }
  userParts.push('', '现在，按上面的格式写下你的想法。想不出什么就留空。');

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') }
  ];
}

/**
 * 解析模型输出。
 *
 * 三种结果：
 *   { ok:false, reason }              —— 不是 JSON，整轮放弃（绝不写半份）
 *   { ok:true, empty:true, data }     —— JSON 合法但没有可应用的改动（也算成功，避免反复重试）
 *   { ok:true, empty:false, data }    —— 正常
 */
export function parseReflectOutput(raw) {
  const data = extractJson(raw);
  if (!isPlainObject(data)) return { ok: false, reason: '输出不是合法的 JSON 对象' };

  const hasRelations = Array.isArray(data.relations) && data.relations.length > 0;
  const hasCompact = Array.isArray(data.compact) && data.compact.length > 0;
  const selfPatch = isPlainObject(data.self) ? data.self : null;
  const hasSelf = Boolean(selfPatch)
    && (String(selfPatch.narrative ?? '').trim() !== ''
      || isPlainObject(selfPatch.mood)
      || (Array.isArray(selfPatch.preoccupations) && selfPatch.preoccupations.length > 0));

  return { ok: true, empty: !(hasRelations || hasCompact || hasSelf), data };
}

/**
 * 应用反思结果。
 *
 * 逐条校验、逐条应用：坏的丢掉并记录原因，好的照常写入。
 * **不做整批回滚**——因为一条关系判断不成立，不代表她的自我认知也该作废。
 *
 * @param {object} opts
 * @param {object} opts.store MindStore
 * @param {string} opts.chatKey
 * @param {object} opts.output parseReflectOutput 的 data
 * @param {object[]} opts.inputEvents 本次喂进去的事件（证据必须来自这里）
 * @param {number} [opts.now]
 * @returns {{applied:object, rejected:object[]}}
 */
export function applyReflection({ store, chatKey, output, inputEvents = [], now = Date.now() } = {}) {
  const applied = { self: false, relations: [], compacted: 0, summaryId: null };
  const rejected = [];
  if (!store || !isPlainObject(output)) return { applied, rejected };

  const eventIds = new Set(inputEvents.map((e) => String(e.id)));
  const actorIds = new Set(
    inputEvents.map((e) => String(e.actorId ?? '')).filter((id) => id && id !== 'self')
  );

  // ── 自我 ──
  if (isPlainObject(output.self)) {
    const patch = {};
    if (typeof output.self.narrative === 'string' && output.self.narrative.trim()) {
      patch.narrative = output.self.narrative;
    }
    if (isPlainObject(output.self.mood)
      && (String(output.self.mood.label ?? '').trim() || output.self.mood.valence !== undefined)) {
      patch.mood = {
        label: output.self.mood.label,
        valence: output.self.mood.valence
      };
    }
    if (Array.isArray(output.self.preoccupations)) {
      patch.preoccupations = output.self.preoccupations;
    }
    if (Object.keys(patch).length) {
      const reason = String(output.notes ?? '').trim() || '安静下来想了想';
      const r = store.reviseSelf(patch, { by: 'reflection', reason, now });
      if (r.ok) applied.self = true;
      else rejected.push({ kind: 'self', reason: r.reason });
    }
  }

  // ── 关系 ──
  for (const item of Array.isArray(output.relations) ? output.relations : []) {
    if (!isPlainObject(item)) { rejected.push({ kind: 'relation', reason: '条目不是对象' }); continue; }
    const userId = String(item.userId ?? '').trim();
    if (!actorIds.has(userId)) {
      rejected.push({ kind: 'relation', userId, reason: '这些事里没有这个人' });
      continue;
    }
    const evidence = (Array.isArray(item.evidence) ? item.evidence : [])
      .map((x) => String(x ?? '').trim())
      .filter((id) => eventIds.has(id));
    if (!evidence.length) {
      rejected.push({ kind: 'relation', userId, reason: '没有有效证据（evidence 不在本次事件里）' });
      continue;
    }
    const patch = isPlainObject(item.patch) ? item.patch : {};
    if (!Object.keys(patch).length) {
      rejected.push({ kind: 'relation', userId, reason: 'patch 为空' });
      continue;
    }
    const r = store.patchRelation(userId, patch, {
      evidence,
      confidence: item.confidence,
      now
    });
    if (r.ok) applied.relations.push({ userId, stage: r.relation.stage, clamp: r.clamp || [] });
    else rejected.push({ kind: 'relation', userId, reason: r.reason });
  }

  // ── 压缩 ──
  for (const item of Array.isArray(output.compact) ? output.compact : []) {
    if (!isPlainObject(item)) { rejected.push({ kind: 'compact', reason: '条目不是对象' }); continue; }
    const from = (Array.isArray(item.from) ? item.from : [])
      .map((x) => String(x ?? '').trim())
      .filter((id) => eventIds.has(id));
    const uniq = [...new Set(from)];
    if (uniq.length < 2) {
      rejected.push({ kind: 'compact', reason: '至少要有两条真实事件才值得压缩' });
      continue;
    }
    const summary = String(item.summary ?? '').trim();
    if (!summary) { rejected.push({ kind: 'compact', reason: 'summary 为空' }); continue; }
    const r = store.markCompacted(uniq, {
      chatKey,
      actorId: 'self',
      kind: 'observation',
      text: summary,
      salience: 0.5,
      tags: ['记忆压缩']
    });
    if (r.ok) {
      applied.compacted += r.compacted;
      if (r.summary) applied.summaryId = r.summary.id;
    } else {
      rejected.push({ kind: 'compact', reason: r.reason });
    }
  }

  return { applied, rejected };
}
