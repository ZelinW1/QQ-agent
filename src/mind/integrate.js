// 全局整合：把"零散的自我笔记"收拢成"她对自己的说法"。
//
// 为什么它必须独立于会话级反思：
//   · 会话级按单个会话触发 —— 让它写自我，等于让话最多的群决定她是谁；
//   · 全局整合看的是**所有会话**沉淀下来的笔记，加上她现有的自我，
//     一次只做一件事：这些一闪念里，有哪些真的变成了"我是这样的人"。
//
// 三个函数，职责与会话反思一一对应：
//   buildIntegratePrompt  —— 纯函数，组装材料
//   parseIntegrateOutput  —— 纯函数，解析；解析不了就不写，不猜
//   applyIntegrate        —— 唯一写存储的地方：改自我 + 标记消化掉的笔记
import { extractJson } from '../util.js';

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function fmtDate(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 组装全局整合用的 messages。
 *
 * @param {object} opts
 * @param {string} [opts.botName]
 * @param {object} [opts.self]
 * @param {Array<{id:string,text:string,at:number,by?:string}>} [opts.notes]
 * @param {Array<{chatKey:string,at:number,produced?:object}>} [opts.reflections]
 * @param {object[]} [opts.relations]
 */
export function buildIntegratePrompt({ botName = '她', self = {}, notes = [], reflections = [], relations = [] } = {}) {
  const name = String(botName || '她').trim() || '她';
  const system = [
    `你是${name}。`,
    '最近你在不同的人那里，零零散散想过一些关于自己的事。现在你把它们收拢一下。',
    '',
    '你要做的只有一件事：决定这些一闪念里，哪些真的变成了"你对自己的看法"。',
    '不是总结别人说了什么，是想清楚你自己是谁、在意什么、心情如何。',
    '',
    '规矩：',
    '- 只改你自己的描述，不要评价别人；不要提到材料里没出现过的人。',
    '- 你现在怎么描述自己，可以保留、可以改，但要能说清为什么。',
    '- 如果这一批笔记没有让你对自己有新的认识，就留空（这很正常，不要硬写）。',
    '- 只输出 JSON，不要 Markdown，不要解释。',
    '',
    '输出格式：',
    '{',
    '  "self": { "narrative": "…或 null", "mood": { "label": "…", "valence": 0.0 }, "preoccupations": ["…"] },',
    '  "digest": ["sn_…"],',
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

  userParts.push('', `【这段时间你自己留下的念头】（共 ${notes.length} 条，编号用于 digest）`);
  if (notes.length) {
    for (const n of notes) userParts.push(`- ${n.id} (${fmtDate(n.at)}) ${String(n.text || '').slice(0, 200)}`);
  } else {
    userParts.push('（没有）');
  }

  if (reflections.length) {
    userParts.push('', '【这些念头是什么时候冒出来的】');
    for (const r of reflections.slice(0, 12)) {
      const bits = [];
      if (r.chatKey) bits.push(r.chatKey);
      if (Number(r.at)) bits.push(fmtDate(r.at));
      userParts.push(`- ${bits.join(' ')}`);
    }
  }

  if (relations.length) {
    userParts.push('', '【你最近对这几个人的看法】（只作参照，不要在这里改它）');
    for (const rel of relations.slice(0, 6)) {
      const bits = [];
      if (rel.nickname) bits.push(String(rel.nickname));
      if (rel.stage) bits.push(String(rel.stage));
      userParts.push(`- ${rel.userId}${bits.length ? ` ${bits.join('，')}` : ''}`);
    }
  }

  userParts.push('', '现在，按上面的格式写下你的想法。没有新认识就留空。');

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') }
  ];
}

/**
 * 解析全局整合的输出。
 *
 * @param {string} raw
 * @returns {{ok:boolean, empty?:boolean, data?:object, reason?:string}}
 */
export function parseIntegrateOutput(raw) {
  const data = extractJson(raw);
  if (!isPlainObject(data)) return { ok: false, reason: '输出不是合法的 JSON 对象' };

  const selfPatch = isPlainObject(data.self) ? data.self : null;
  const hasSelf = Boolean(selfPatch)
    && (String(selfPatch.narrative ?? '').trim() !== ''
      || (isPlainObject(selfPatch.mood) && String(selfPatch.mood.label ?? '').trim() !== '')
      || (Array.isArray(selfPatch.preoccupations) && selfPatch.preoccupations.length > 0));
  const digest = Array.isArray(data.digest) ? data.digest.filter((x) => typeof x === 'string') : [];

  return { ok: true, empty: !(hasSelf || digest.length), data };
}

/**
 * 应用全局整合的结果。
 *
 * **只改自我，不改关系**：关系属于会话级反思的地盘，全局整合再去动它，
 * 就变成了"两个地方都能改对人的看法"，出了问题无法归因。
 *
 * @param {object} opts
 * @param {object} opts.store
 * @param {object} opts.output parseIntegrateOutput 的 data
 * @param {string[]} opts.noteIds 本次喂进去的笔记 id（digest 只能来自这里）
 * @param {number} [opts.now]
 */
export function applyIntegrate({ store, output, noteIds = [], now = Date.now() } = {}) {
  const applied = { self: false, digested: 0 };
  const rejected = [];
  if (!store || !isPlainObject(output)) return { applied, rejected };

  const known = new Set(noteIds.map(String));

  if (isPlainObject(output.self)) {
    const patch = {};
    if (typeof output.self.narrative === 'string' && output.self.narrative.trim()) {
      patch.narrative = output.self.narrative;
    }
    const moodLabel = String(output.self.mood?.label ?? '').trim();
    if (isPlainObject(output.self.mood) && moodLabel) {
      patch.mood = { label: moodLabel, valence: output.self.mood.valence };
    }
    if (Array.isArray(output.self.preoccupations)) {
      const list = output.self.preoccupations.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 8);
      if (list.length) patch.preoccupations = list;
    }
    if (Object.keys(patch).length) {
      const reason = String(output.notes ?? '').trim() || '把想到的事收拢了一下';
      const r = store.reviseSelf(patch, { by: 'reflection', reason, now });
      if (r.ok) applied.self = true;
      else rejected.push({ kind: 'self', reason: r.reason });
    }
  }

  // digest：只消化本次材料里真实存在的笔记。编出来的 id 一律忽略（防幻觉）。
  const digest = (Array.isArray(output.digest) ? output.digest : [])
    .map((x) => String(x ?? '').trim()).filter((id) => known.has(id));
  if (digest.length && typeof store.markSelfNotesDigested === 'function') {
    const r = store.markSelfNotesDigested(digest, now);
    applied.digested = Number(r?.marked) || 0;
  }

  return { applied, rejected };
}

/**
 * L2b：全局反思的提示词。
 *
 * 与会话反思的区别：会话反思只看一个会话；这里看**所有会话**沉淀下来的反思，
 * 目的是发现"跨会话的模式"（她在不同人面前是不是一个人）。
 *
 * 与 L4 自我整合的区别：这里只产出"想法"（notes）与一段小结，**不改自我**。
 * 自我只由 L4 在月度/强事件/积攒足够之后统一改。
 */
export function buildGlobalReflectPrompt({ botName = '她', self = {}, reflections = [], relations = [] } = {}) {
  const name = String(botName || '她').trim() || '她';
  const system = [
    `你是${name}。`,
    '最近你在不同的会话里各自想过一些事。现在你把它们放在一起看看。',
    '',
    '你要做两件事：',
    '1. 找出跨会话的东西：你在不同人面前是不是同一个人？有没有反复出现的念头？',
    '2. 把值得留下的写成几句"对自己的观察"（notes），不要写别人的事。',
    '',
    '规矩：',
    '- 只写你自己的想法，不要评价具体某个人。',
    '- 材料不足就少写，甚至留空，这很正常。',
    '- 只输出 JSON，不要 Markdown，不要解释。',
    '',
    '输出格式：',
    '{',
    '  "notes": ["……"],',
    '  "summary": "一两句话，给自己看的"',
    '}'
  ].join('\n');

  const parts = ['【你现在怎么看自己】'];
  const narrative = String(self?.narrative ?? '').trim();
  parts.push(narrative || '（还没认真想过自己是个什么样的人）');

  if (reflections.length) {
    parts.push('', `【最近各会话里的反思】（共 ${reflections.length} 条）`);
    for (const r of reflections.slice(-12)) {
      const at = Number(r.at) || 0;
      const date = at ? `${String(new Date(at).getMonth() + 1).padStart(2, '0')}-${String(new Date(at).getDate()).padStart(2, '0')}` : '';
      const bits = [];
      if (r.chatKey) bits.push(String(r.chatKey));
      const produced = r.produced || {};
      if (Number(produced.selfNotes) > 0) bits.push(`留下 ${produced.selfNotes} 条对自己的念头`);
      if (Array.isArray(produced.relations) && produced.relations.length) bits.push(`对 ${produced.relations.length} 个人的看法有变化`);
      parts.push(`- ${date} ${bits.join(' · ') || '（没有产出）'}`);
    }
  }

  if (relations.length) {
    parts.push('', '【你最近对这几个人】');
    for (const rel of relations.slice(0, 8)) {
      parts.push(`- ${rel.userId}${rel.nickname ? ` ${rel.nickname}` : ''}${rel.stage ? ` · ${rel.stage}` : ''}`);
    }
  }

  parts.push('', '现在，按格式写下你看到的东西。没有就留空。');
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') }
  ];
}

/** 解析 L2b 输出。 */
export function parseGlobalReflectOutput(raw) {
  const data = extractJson(raw);
  if (!isPlainObject(data)) return { ok: false, reason: '输出不是合法的 JSON 对象' };
  const notes = Array.isArray(data.notes)
    ? data.notes.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 6)
    : [];
  const summary = String(data.summary ?? '').trim();
  return { ok: true, empty: !(notes.length || summary), data: { notes, summary } };
}