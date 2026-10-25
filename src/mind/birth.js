// 出生仪式：由主人给种子，模型出草案，主人选定后冻结。
//
// 为什么不让模型直接写盘：身份是**一次性**的。写坏了可以改，但"她一开始是谁"
// 这件事如果反复重来，她就不再有一个稳定的起点 —— 而稳定性恰恰是"像一个人"
// 的前提。所以这里只出草案，写盘必须经过主人确认（UI 的"采用这组"）。
//
// 两条边界，刻意写进提示词也写进校验：
//   1. 只写"我是谁"，不写"该怎么做" —— 行为规矩是主人的事。让被约束者起草规矩，
//      写着写着就会变成"在合适的时候可以通融"。
//   2. 必须留出"还不确定"的余地 —— 她是一个起点，不是一个成品。
//      baseline 里不写这句话，她之后很难允许自己改变。
import { extractJson } from '../util.js';

const MARKDOWN_MARKERS = ['**', '##', '```', '- [', '> '];

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function clampText(v, max) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 组装出生仪式的 messages。
 *
 * system 固定不变（可缓存），种子全在 user 里。
 *
 * @param {object} p
 * @param {string} [p.botName]
 * @param {string[]|string} [p.keywords]
 * @param {string} [p.vision]
 * @param {number} [p.count]
 */
export function buildBirthPrompt({ botName = '', keywords = [], vision = '', count = 3 } = {}) {
  const kw = Array.isArray(keywords)
    ? keywords.map((k) => String(k ?? '').trim()).filter(Boolean)
    : String(keywords ?? '').split(/[，,、;；\s]+/).map((k) => k.trim()).filter(Boolean);
  const n = Math.min(3, Math.max(1, Number(count) || 3));

  const system = [
    '你在帮一个人确立身份。',
    '不是写角色卡，是写"她一开始是谁"：一个还没活过、但即将开始活的起点。',
    '',
    `请产出 ${n} 组**不同**的草案。每组包含：`,
    '- name：3 个候选名字（2~6 个字，中文，不要外语词）',
    '- selfImage：我是谁。第一人称，写形象与来历，1~3 句。',
    '- baseline：最初的我。第一人称，写性格底色与不确定感，2~4 句。',
    '- voice：2~3 条说话习惯（例如"句尾很少用句号""被夸会先否认"），不是规矩。',
    '',
    '硬约束：',
    '- 全部用第一人称自述。不要出现"你要扮演""这个角色"这类说法。',
    '- 不要写行为规矩（不写"不要做什么""必须做什么"）——规矩由主人另写。',
    '- 不用 markdown：不要加粗、标题、列表符号、代码块。',
    '- selfImage 里用 {botName} 代替她自己的名字，这样改名时不用改这段。',
    '- baseline 必须留出余地：她现在只是起点，以后会变。',
    '- 不要写成客服、助手、工具。她是一个有自己想法的人。',
    '- 只输出 JSON，不要解释。',
    '',
    '输出格式：',
    '{ "drafts": [ { "name": ["…","…","…"], "selfImage": "…", "baseline": "…", "voice": ["…"] } ] }'
  ].join('\n');

  const userLines = ['【主人给的形象关键词】'];
  userLines.push(kw.length ? kw.map((k) => `- ${k}`).join('\n') : '（没给）');
  userLines.push('', '【主人给的愿景】');
  userLines.push(String(vision ?? '').trim() || '（没给）');
  if (String(botName ?? '').trim()) {
    userLines.push('', '【她现在的名字】', String(botName).trim());
  }
  userLines.push('', `按上面的格式，给我 ${n} 组草案。`);

  return [
    { role: 'system', content: system },
    { role: 'user', content: userLines.join('\n') }
  ];
}

/**
 * 校验一组草案。
 *
 * 返回 null 表示可用，否则返回拒绝原因（人话，直接给 UI 看）。
 * 这里刻意不接受"差不多能用"的草案：身份是要天天带着的东西，
 * 一个含 markdown 或没有"我"的自述，写进去之后每轮都在被读。
 *
 * @param {object} draft
 * @returns {string|null}
 */
export function validateDraft(draft) {
  if (!isPlainObject(draft)) return '草案不是对象';

  const names = (Array.isArray(draft.name) ? draft.name : [draft.name])
    .map((n) => clampText(n, 12))
    .filter(Boolean);
  if (!names.length) return '缺少名字';
  if (names.some((n) => n.length < 2)) return '名字太短';
  if (names.length > 5) return '名字候选太多';

  const selfImage = clampText(draft.selfImage, 600);
  if (selfImage.length < 12) return '自我形象太短';
  if (!selfImage.includes('我') && !selfImage.includes('{botName}')) return '自我形象不是第一人称';

  const baseline = clampText(draft.baseline, 800);
  if (baseline.length < 12) return '最初的样子太短';
  if (!baseline.includes('我')) return '最初的样子不是第一人称';

  const voice = (Array.isArray(draft.voice) ? draft.voice : []).map((v) => clampText(v, 40)).filter(Boolean);
  if (voice.length > 4) return '说话习惯太多';

  for (const [field, text] of [['selfImage', selfImage], ['baseline', baseline], ...voice.map((v, i) => [`voice[${i}]`, v])]) {
    if (MARKDOWN_MARKERS.some((m) => text.includes(m))) return `${field} 里含 markdown`;
    if (/扮演|角色扮演/.test(text)) return `${field} 用了角色扮演的说法`;
  }
  return null;
}

/**
 * 解析模型输出。
 *
 * 坏掉的草案**逐条丢弃**并记录原因，而不是整批放弃 —— 三组里有一组不合格，
 * 另外两组仍然可用。若一组都不合格才整体失败。
 *
 * @param {string} raw
 * @param {number} [want] 期望组数（仅用于报告，不强制）
 * @returns {{ok:boolean, drafts:object[], rejected:{index:number, reason:string}[], reason?:string}}
 */
export function parseBirthDrafts(raw, want = 3) {
  const data = extractJson(raw);
  if (!isPlainObject(data)) return { ok: false, drafts: [], rejected: [], reason: '输出不是合法的 JSON' };

  const list = Array.isArray(data.drafts) ? data.drafts : [];
  if (!list.length) return { ok: false, drafts: [], rejected: [], reason: '没有产出任何草案' };

  const drafts = [];
  const rejected = [];
  list.forEach((item, index) => {
    const reason = validateDraft(item);
    if (reason) { rejected.push({ index, reason }); return; }
    const names = (Array.isArray(item.name) ? item.name : [item.name]).map((n) => clampText(n, 12)).filter(Boolean);
    drafts.push({
      name: names,
      selfImage: clampText(item.selfImage, 600),
      baseline: clampText(item.baseline, 800),
      voice: (Array.isArray(item.voice) ? item.voice : []).map((v) => clampText(v, 40)).filter(Boolean)
    });
  });

  if (!drafts.length) {
    return { ok: false, drafts: [], rejected, reason: '草案全部不合格' };
  }
  return { ok: true, drafts: drafts.slice(0, Math.max(1, Number(want) || 3)), rejected };
}
