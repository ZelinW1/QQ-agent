// 记忆检索：从事件流里挑出"此刻值得想起来"的几条。
//
// 为什么不把事件全量灌进提示词：
//   · 成本会随相处时间线性增长，而人的回忆不是这样的 —— 她只想起相关的几件；
//   · 全量注入会让"最近的事"淹没"很重要但很久以前的事"。
//
// 打分 = 相关性 + 时近性 + 显著度 + 未完结。
// 刻意保持纯函数、无 IO、无 LLM：这样才能单测、才能在反思与对话两条路径上复用。
import { formatShortTime } from '../util.js';

/** 中文二元 + 拉丁词。够用且零依赖（不引 web-search.js，避免拖进网络模块）。 */
export function tokenize(text) {
  const tokens = new Set();
  const s = String(text ?? '').toLowerCase();
  if (!s) return tokens;

  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) tokens.add(m[0]);

  const han = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of han) {
    if (run.length === 1) { tokens.add(run); continue; }
    for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

/**
 * 单条事件的分数（各分量加权后用于排序，不是概率）。
 *
 * @param {object} event
 * @param {object} ctx
 * @param {Set<string>} [ctx.queryTokens]
 * @param {number} [ctx.now]
 * @param {Set<string>} [ctx.unresolvedIds] 命中这些 id 视为"未完结的事"
 * @param {number} [ctx.halfLifeDays=30] 时近性半衰期
 */
export function scoreEvent(event, { queryTokens = null, now = Date.now(), unresolvedIds = null, halfLifeDays = 30 } = {}) {
  if (!event) return 0;
  const ts = Number(event.ts) || now;
  const ageDays = Math.max(0, (now - ts) / 86400000);
  // 指数衰减：30 天前约 0.37，90 天前约 0.05
  const recency = Math.exp(-ageDays / Math.max(1, halfLifeDays));

  const salience = Math.min(1, Math.max(0, Number(event.salience) || 0.5));

  let relevance = 0;
  if (queryTokens && queryTokens.size) {
    const hay = tokenize(`${event.text || ''} ${(Array.isArray(event.tags) ? event.tags.join(' ') : '')}`);
    let hit = 0;
    for (const t of queryTokens) if (hay.has(t)) hit += 1;
    relevance = hit / queryTokens.size;
  }

  const unresolved = unresolvedIds && unresolvedIds.has(String(event.id)) ? 1 : 0;

  return 0.45 * relevance + 0.25 * recency + 0.20 * salience + 0.10 * unresolved;
}

/**
 * 选出一批事件。
 *
 * @param {object[]} events
 * @param {object} opts
 * @param {string} [opts.query] 当前话题
 * @param {string} [opts.userId] 只看某个人（她的自己记录始终可入选）
 * @param {number} [opts.now]
 * @param {number} [opts.limit=4]
 * @param {string[]} [opts.unresolvedIds] 未完结事件 id
 * @param {number} [opts.maxPerActor=3] 同一主体最多占几条（避免一个人的旧事刷屏）
 * @returns {object[]} 分数降序（同分按 id 升序，保证可复现）
 */
export function selectRecall(events = [], {
  query = '',
  userId = '',
  now = Date.now(),
  limit = 4,
  unresolvedIds = [],
  maxPerActor = 3
} = {}) {
  const wantUser = String(userId ?? '').trim();
  const unresolved = new Set((Array.isArray(unresolvedIds) ? unresolvedIds : []).map(String));
  const queryTokens = tokenize(query);
  const scored = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.compacted) continue;
    if (wantUser && String(ev.actorId) !== wantUser && String(ev.actorId) !== 'self') continue;
    scored.push({
      ev,
      score: scoreEvent(ev, { queryTokens, now, unresolvedIds: unresolved })
    });
  }
  scored.sort((a, b) => (b.score - a.score) || String(a.ev.id).localeCompare(String(b.ev.id)));

  const cap = Math.max(1, Number(limit) || 4);
  const perActor = Math.max(1, Number(maxPerActor) || 3);
  const used = new Map();
  const out = [];
  for (const { ev } of scored) {
    if (out.length >= cap) break;
    const actor = String(ev.actorId || '');
    const n = used.get(actor) || 0;
    if (n >= perActor) continue;
    used.set(actor, n + 1);
    out.push(ev);
  }
  return out;
}

/**
 * 渲染成提示词里的一小段。每条 `<日期> <文本>`，总长硬上限。
 * 刻意不带消息 id：这段是"想起来的事"，不是可引用的聊天记录。
 */
export function formatRecallForPrompt(events = [], { maxChars = 600, perLine = 120 } = {}) {
  const lines = [];
  let total = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    const text = String(ev?.text ?? '').trim();
    if (!text) continue;
    const when = ev?.ts ? formatShortTime(Number(ev.ts)) : '';
    const line = `- ${when ? `${when} ` : ''}${text.slice(0, perLine)}`;
    if (total + line.length > maxChars) break;
    lines.push(line);
    total += line.length;
  }
  return lines.join('\n');
}
