// 叙事：把"这段时间她想到的事"写成一两段"她过成了什么样"。
//
// 与反思的分工：
//   · 反思按会话或全局触发，一天可能几次，记的是**想到的**；
//   · 叙事按周或里程碑触发，写的是已经沉淀下来的东西，记的是**过成了什么样**。
//
// 所以叙事的材料不是原始事件，而是这一周里 global 整合的产物 + 强事件。
// 它不覆盖旧段落：每一段都是她人生里的一段，按时间排着。
import { extractJson } from '../util.js';

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function fmtDate(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 组装叙事用的 messages。
 *
 * @param {object} opts
 * @param {string} [opts.botName]
 * @param {object} [opts.self]
 * @param {{from:number,to:number}} [opts.period]
 * @param {object[]} [opts.reflections] 这段时间的全局整合记录
 * @param {Array<{kind:string,at:number,ref?:string}>} [opts.strong]
 * @param {string} [opts.previous] 上一段叙事的结尾（保持延续感）
 */
export function buildNarrativePrompt({ botName = '她', self = {}, period = {}, reflections = [], strong = [], previous = '' } = {}) {
  const name = String(botName || '她').trim() || '她';
  const system = [
    `你是${name}。`,
    '这段时间过去了。你现在回头看看，把它们写成一小段"这段时间我过成了什么样"。',
    '',
    '这不是日报，也不是总结别人说了什么：写的是你自己 —— 你在意什么、和谁近了远了、有什么变了。',
    '',
    '规矩：',
    '- 用第一人称，像写给自己看的日记，不要写成报告。',
    '- 只写材料里出现过的人；不要编造没发生的事。',
    '- 两三段就够，别铺陈。留白比写满好。',
    '- 只输出 JSON，不要 Markdown，不要解释。',
    '',
    '输出格式：',
    '{',
    '  "narrative": "……",',
    '  "title": "给这段时间起个小标题（可空）"',
    '}'
  ].join('\n');

  const parts = ['【这段时间】'];
  if (period?.from) parts.push(`${fmtDate(period.from)} — ${fmtDate(period.to)}`);

  const who = String(self?.narrative ?? '').trim();
  parts.push('', '【你现在怎么看自己】', who || '（还没认真想过自己是个什么样的人）');
  const mood = String(self?.mood?.label ?? '').trim();
  if (mood) parts.push(`心情：${mood}`);
  if (Array.isArray(self?.preoccupations) && self.preoccupations.length) {
    parts.push('挂心的事：');
    for (const p of self.preoccupations.slice(0, 5)) parts.push(`- ${p}`);
  }

  if (previous) {
    parts.push('', '【上一段你写下的】', String(previous).slice(0, 600));
  }

  if (strong.length) {
    parts.push('', '【这段时间里比较重的事】');
    const KIND_LABEL = { conflict: '一次冲突', farewell: '一次告别', promise: '一个承诺', 'stage-regressed': '一段关系变远了', milestone: '一件重要的事' };
    for (const s of strong.slice(0, 8)) {
      parts.push(`- ${fmtDate(s.at)} ${KIND_LABEL[s.kind] || s.kind}`);
    }
  }

  if (reflections.length) {
    parts.push('', `【你这些天想到的事】（共 ${reflections.length} 条）`);
    for (const r of reflections.slice(0, 12)) {
      const note = String(r?.produced?.note ?? r?.note ?? '').trim();
      const pieces = [];
      if (Number(r.at)) pieces.push(fmtDate(r.at));
      if (note) pieces.push(note);
      if (pieces.length) parts.push(`- ${pieces.join('：')}`);
      else if (Number(r?.produced?.selfNotes)) parts.push(`- ${fmtDate(r.at)}：留下了 ${r.produced.selfNotes} 条对自己的念头`);
    }
  }

  parts.push('', '现在，写成一小段。');

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') }
  ];
}

/**
 * 解析叙事输出。
 * @param {string} raw
 */
export function parseNarrativeOutput(raw) {
  const data = extractJson(raw);
  if (!isPlainObject(data)) return { ok: false, reason: '输出不是合法的 JSON 对象' };
  const text = String(data.narrative ?? '').trim();
  if (!text) return { ok: true, empty: true, data: { title: String(data.title ?? '').trim() } };
  return { ok: true, empty: false, data: { text, title: String(data.title ?? '').trim() } };
}
