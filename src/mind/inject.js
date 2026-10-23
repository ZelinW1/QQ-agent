// 心智上下文：把"她自己"和"她记得的事"变成提示词里的几段。
//
// 立场（很重要）：这里写的是**她是谁**，不是**她该演谁**。
//   · 用第一人称的经验陈述：「你最近在意的」「你叫他……」
//   · 不用扮演框架：不出现「扮演」「人设」「角色扮演」「按照设定」这类词
//   · 文案要短：她是个人，不是一份档案
// 测试里有一条断言专门守这件事（禁止扮演类词汇），改文案时别绕过它。
//
// 分层（决定缓存命中）：
//   · renderSelfSection / renderRelationsSection  → 稳定簇（反思时才变）
//   · renderRecentSection                         → 易变区（每轮可能不同）
import { formatRecallForPrompt, selectRecall } from './recall.js';

/** 关系阶段的人话说法。 */
const STAGE_LABEL = {
  stranger: '陌生人',
  acquaintance: '泛泛之交',
  familiar: '熟人',
  close: '亲近',
  strained: '有隔阂'
};

/** 低于这个把握的关系只给模糊印象，不做强陈述（方案 §7 护栏 3）。 */
const LOW_CONFIDENCE = 0.4;

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 【关于我自己】——稳定簇。
 * 没有内容时返回空串（调用方据此不插段，保持逐字节不变）。
 */
export function renderSelfSection(self = null) {
  if (!isPlainObject(self)) return '';
  const narrative = String(self.narrative ?? '').trim();
  const moodLabel = String(self.mood?.label ?? '').trim();
  const concerns = Array.isArray(self.preoccupations)
    ? self.preoccupations.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 5)
    : [];
  if (!narrative && !moodLabel && !concerns.length) return '';

  const lines = ['【关于我自己】'];
  if (narrative) lines.push(narrative);
  if (moodLabel) lines.push(`我现在的心情：${moodLabel}`);
  if (concerns.length) {
    lines.push('我最近挂心的：');
    for (const c of concerns) lines.push(`- ${c}`);
  }
  return lines.join('\n');
}

/**
 * 【与在场者的关系】——稳定簇。
 *
 * 顺序按 userId 升序排列，**不按调用方传入顺序**：对象遍历顺序一旦抖动，
 * 稳定前缀就变了，提示词缓存会整段失效。这是最容易犯又最难发现的错误。
 */
export function renderRelationsSection(relations = []) {
  const rows = (Array.isArray(relations) ? relations : [])
    .filter(isPlainObject)
    .sort((a, b) => String(a.userId).localeCompare(String(b.userId)));
  if (!rows.length) return '';

  const lines = ['【与在场者的关系】'];
  for (const rel of rows) {
    const id = String(rel.userId ?? '');
    const name = String(rel.nickname || '').trim()
      || (Array.isArray(rel.names) && rel.names.length ? String(rel.names.at(-1)) : '')
      || id || '某人';
    const tag = id ? `${name}(QQ:${id})` : name;

    if ((Number(rel.confidence) || 0) < LOW_CONFIDENCE) {
      lines.push(`- ${tag}：印象还有些模糊，说不好是个什么样的人。`);
      continue;
    }

    const bits = [];
    const stage = STAGE_LABEL[rel.stage];
    if (stage) bits.push(stage);
    if (Number.isFinite(Number(rel.trust))) bits.push(`信任 ${Math.round(Number(rel.trust))}`);
    if (String(rel.nickname || '').trim()) bits.push(`你称呼「${String(rel.nickname).trim()}」`);
    lines.push(`- ${tag}：${bits.join('，') || '认识'}。`);

    const knownFor = Array.isArray(rel.knownFor) ? rel.knownFor.filter(Boolean).slice(0, 5) : [];
    if (knownFor.length) lines.push(`  你知道的：${knownFor.join('；')}。`);

    const tender = Array.isArray(rel.tender) ? rel.tender.filter(Boolean).slice(0, 5) : [];
    if (tender.length) lines.push(`  别提：${tender.join('；')}。`);

    const loops = Array.isArray(rel.openLoops)
      ? rel.openLoops.map((l) => String(l?.text ?? '').trim()).filter(Boolean).slice(0, 5)
      : [];
    if (loops.length) lines.push(`  还没问完：${loops.join('；')}。`);

    if (String(rel.recentSummary || '').trim()) {
      lines.push(`  上次：${String(rel.recentSummary).trim()}。`);
    }
  }
  return lines.join('\n');
}

/**
 * 【最近想起的事】——易变区。
 *
 * 放在易变区的原因：它每轮都可能不同，塞进稳定前缀会每次击穿缓存。
 * 措辞上强调"这些是想起的事，不是这次要说的话"，避免她照着念。
 */
export function renderRecentSection(events = []) {
  const text = formatRecallForPrompt(events, { maxChars: 600, perLine: 120 });
  if (!text) return '';
  return [
    '【最近想起的事】',
    '这些是你自己想起来的事，不是你这次要说的话；用得上就自然带上，用不上就放着。',
    text
  ].join('\n');
}

/**
 * 影响**提示词字节**的心智状态摘要。
 *
 * 只收稳定簇（自我版本 + 关系档），**不收事件**：事件在易变区，收进来会让
 * 每次运行都判定"配置变了"，提示词锚点永远重建，缓存收益归零。
 */
export function mindFingerprint({ self = null, relations = [] } = {}) {
  const version = Number(self?.version) || 0;
  const rows = (Array.isArray(relations) ? relations : [])
    .filter(isPlainObject)
    .map((r) => [
      String(r.userId ?? ''),
      String(r.stage ?? ''),
      Math.round(Number(r.trust) || 0),
      Math.round(Number(r.warmth) || 0),
      String(r.nickname ?? ''),
      Math.round((Number(r.confidence) || 0) * 100)
    ])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify({ v: version, r: rows });
}

/**
 * 采集一次运行要用的心智上下文。
 *
 * 这是本文件里**唯一做 IO** 的函数（其余都是纯渲染），方便上面几段被单独单测。
 *
 * @param {object} opts
 * @param {object} opts.store MindStore
 * @param {string} opts.chatKey
 * @param {object} [opts.options] config.mind
 * @param {number} [opts.now]
 * @param {string[]} [opts.participantIds] 本批涉及的人（私聊 = 对方）
 * @param {string} [opts.query] 当前话题（用于检索）
 */
export function collectMindContext({
  store,
  chatKey,
  options = {},
  now = Date.now(),
  participantIds = [],
  query = ''
} = {}) {
  if (!store || typeof store.getSelf !== 'function') return null;

  const self = store.getSelf();

  const ids = [...new Set((Array.isArray(participantIds) ? participantIds : [])
    .map((x) => String(x ?? '').trim()).filter(Boolean))];
  const relations = ids
    .map((id) => store.getRelation(id))
    .filter((r) => isPlainObject(r) && (r.updatedAt || r.names.length || r.knownFor.length || r.openLoops.length));

  const autoLimit = Math.max(1, Number(options.autoEventsInPrompt) || 3);
  const minSalience = Number.isFinite(Number(options.minEventSalience))
    ? Number(options.minEventSalience) : 0.2;
  const pool = store.queryEvents({ chatKey, limit: 200 })
    .filter((e) => Number(e.salience) >= minSalience);
  const events = selectRecall(pool, {
    query,
    now,
    limit: Math.min(autoLimit, 6)
  });

  return {
    enabled: true,
    self,
    relations,
    events,
    fingerprint: mindFingerprint({ self, relations })
  };
}
