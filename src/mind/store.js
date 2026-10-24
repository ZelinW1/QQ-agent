// 心智状态存储：事件 / 关系 / 自我 / 节律状态 / 日志。
//
// 设计边界（改这个文件前先读）：
//   1. **纯存储，不含 LLM、不含提示词**。反思逻辑在 reflect.js，检索在 recall.js。
//   2. **不 import orchestrator.js**（防循环依赖，与 chat-profile.js 同）。
//   3. 所有写操作**幂等或可重放**：事件按 id 去重、关系按 patch 合并、自我按版本递增。
//   4. 默认根目录是 `DATA_DIR/mind`。DATA_DIR 已按 QQ_AGENT_PROFILE 隔离，
//      所以"一个 QQ 账户 = 一份心智"天然成立。
//
// 目录：
//   data/mind/
//     self.json
//     relations/<QQ>.json
//     events/<chatKeyDir>/<YYYY-MM>.jsonl
//     tick.json
//     reflections.jsonl
//     actions.jsonl
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from '../config.js';

const MIND_DIR = path.join(DATA_DIR, 'mind');

/** 事件类型（书写自由，但归档时限定这几类，便于检索与统计）。 */
export const EVENT_KINDS = ['interaction', 'observation', 'promise', 'conflict', 'milestone'];

/** 关系阶梯：数值用于"单次最多移动一级"的钳制。 */
export const STAGE_LEVEL = { stranger: 0, acquaintance: 1, familiar: 2, close: 3 };
/** 全部合法阶段（strained 是脱离阶梯的"破裂"态，不参与级差计算）。 */
export const STAGES = [...Object.keys(STAGE_LEVEL), 'strained'];

// ── 上限（防止单条记录膨胀；与方案 §2 一致）─────────────────────────────
const LIMITS = {
  eventText: 200,
  eventTags: 5,
  tagLen: 20,
  knownFor: 5,
  tender: 5,
  listItem: 40,
  openLoops: 5,
  openLoopText: 60,
  recentSummary: 120,
  nickname: 20,
  evidence: 10,
  narrative: 1200,
  moodLabel: 20,
  preoccupations: 5,
  preoccupationItem: 60,
  changelog: 50,
  reason: 200
};

// ── 小工具 ───────────────────────────────────────────────────────────────

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** chatKey → 目录名（与 memory.js 的 chatDirName 同款转义，便于人工对照）。 */
function chatDirName(chatKey) {
  return String(chatKey || '').replace(/[^a-z0-9_]/gi, '_') || '_unknown';
}

/** 时间戳 → `YYYY-MM`（事件按月分片）。 */
function monthKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function nowId(prefix, ts) {
  return `${prefix}_${Number(ts) || Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

function strList(v, { maxItems, maxLen }) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = str(item, maxLen);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch { /* 跳过坏行，不因一行损坏丢掉整个文件 */ }
  }
  return out;
}

function writeJsonlAtomic(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
  fs.renameSync(tmp, file);
}

function appendJsonl(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** 读 JSONL 的末尾 N 条（按文件行序，即写入顺序）。 */
function tailJsonl(file, limit) {
  const all = readJsonl(file);
  const n = Math.max(1, Number(limit) || 20);
  return all.slice(-n);
}

/**
 * 在文本里找既定的底线词，并看它前面一小段有没有否定词。
 *
 * 为什么不用"否定词 + 紧邻底线"的正则：中文里否定和名词之间常夹动词，
 * 「不想再当小鲸鱼」中间隔了"再当"。所以改为**前置窗口**判断：
 * 底线词出现的位置往前 6 个字内含否定词，就算否定。
 *
 * 这会带来少量误判（例如"我不得不说，我是小鲸鱼"会被误判为否定），
 * 但方向是保守的：宁可拒绝一次改写，也不要让她悄悄否掉自己的底线。
 * 语义级的判断留到 M3 的反思侧。
 */
function negatedMention(text, inv) {
  const NEG = /[不没无别非未]/;
  let idx = text.indexOf(inv);
  while (idx !== -1) {
    if (NEG.test(text.slice(Math.max(0, idx - 6), idx))) return true;
    idx = text.indexOf(inv, idx + 1);
  }
  return false;
}

/** 人格底线校验：既定底线不能被删掉，也不能被公开否定。 */
function violateInvariants(oldNarrative, newNarrative, invariants) {
  for (const raw of Array.isArray(invariants) ? invariants : []) {
    const inv = String(raw ?? '').trim();
    if (!inv) continue;
    if (oldNarrative.includes(inv) && !newNarrative.includes(inv)) {
      return `不能删掉既定的人格底线：「${inv}」`;
    }
    if (negatedMention(newNarrative, inv)) {
      return `不能否定既定的人格底线：「${inv}」`;
    }
  }
  return '';
}

/** 关系阶梯的"单次最多一级"钳制。 */
function clampStage(from, to) {
  if (!STAGES.includes(to)) return from;
  if (to === from) return to;
  // 破裂可以从任何状态突然发生（人被伤到是一次性的），不受级差限制。
  if (to === 'strained') return to;
  // 从破裂里恢复：一次只能回到"泛泛之交"，不能一步回到亲密。
  if (from === 'strained') return to === 'close' || to === 'familiar' ? 'acquaintance' : to;
  const fromLevel = STAGE_LEVEL[from];
  const toLevel = STAGE_LEVEL[to];
  if (fromLevel === undefined || toLevel === undefined) return from;
  const delta = toLevel - fromLevel;
  const step = Math.max(-1, Math.min(1, delta));
  return Object.keys(STAGE_LEVEL).find((k) => STAGE_LEVEL[k] === fromLevel + step) || from;
}

// ── 默认值 ───────────────────────────────────────────────────────────────

function defaultSelf() {
  return {
    version: 0,
    updatedAt: 0,
    narrative: '',
    mood: { label: '', valence: 0, since: 0 },
    preoccupations: [],
    changelog: []
  };
}

function defaultRelation(userId) {
  return {
    userId: String(userId ?? ''),
    names: [],
    stage: 'stranger',
    trust: 50,
    warmth: 50,
    nickname: '',
    knownFor: [],
    tender: [],
    openLoops: [],
    recentSummary: '',
    lastInteractedAt: 0,
    confidence: 0.3,
    evidence: [],
    contexts: {},
    updatedAt: 0
  };
}

function defaultTick() {
  return {
    energy: 100,
    energyAt: 0,
    nextTickAt: 0,
    today: '',
    todayProactive: 0,
    todayDecisions: 0,
    todayReflections: 0,
    lastInteractionAt: 0,
    lastReflectAt: 0,
    // 上次**尝试**反思的时间（无论成败）。冷却用它而不是 lastReflectAt：
    // 解析失败时 lastReflectAt 不前移，若不再记尝试时间，失败会变成每轮重试。
    lastReflectAttemptAt: 0,
    // 候选打盹：`<chatKey>|<candidateId>` -> 到期时间。
    // 她"想了一下但决定不做"之后，同一个理由不该每 5 分钟重新叫她一次。
    snoozes: {},
    notes: []
  };
}

// ── 存储 ─────────────────────────────────────────────────────────────────

export class MindStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.root] 数据根目录（默认 `DATA_DIR/mind`）。
   * @param {() => object} [opts.getOptions] 读取 `config.mind`（测试可注入）。
   */
  constructor({ root = MIND_DIR, getOptions = () => getConfig().mind || {} } = {}) {
    this.root = root;
    this._getOptions = getOptions;
    this._shards = new Map();   // 绝对路径 -> { mtimeMs, events }
  }

  get options() {
    try { return this._getOptions() || {}; } catch { return {}; }
  }

  // ── 路径 ──
  #selfFile() { return path.join(this.root, 'self.json'); }
  #tickFile() { return path.join(this.root, 'tick.json'); }
  #relationFile(userId) { return path.join(this.root, 'relations', `${String(userId)}.json`); }
  #relationsDir() { return path.join(this.root, 'relations'); }
  #eventsRoot() { return path.join(this.root, 'events'); }
  #chatEventsDir(chatKey) { return path.join(this.#eventsRoot(), chatDirName(chatKey)); }
  #shardFile(chatKey, ts) { return path.join(this.#chatEventsDir(chatKey), `${monthKey(ts)}.jsonl`); }
  #reflectionsFile() { return path.join(this.root, 'reflections.jsonl'); }
  #actionsFile() { return path.join(this.root, 'actions.jsonl'); }

  // ── 事件 ──

  /**
   * 追加一条事件。
   *
   * 幂等规则：显式 id 已存在 → 返回既有条目；同一会话 + 同一主体 + 完全相同的
   * 文本在 24h 内重复写 → 返回既有条目（duplicate=true），不新增。
   *
   * @returns {{ok:boolean, event?:object, duplicate?:boolean, reason?:string}}
   */
  appendEvent(input = {}) {
    const chatKey = String(input.chatKey ?? '').trim();
    const text = str(input.text, LIMITS.eventText);
    if (!chatKey) return { ok: false, reason: '缺少 chatKey' };
    if (!text) return { ok: false, reason: '缺少 text' };

    const ts = Number(input.ts) || Date.now();
    const kind = EVENT_KINDS.includes(input.kind) ? input.kind : 'observation';
    const actorId = String(input.actorId ?? '').trim() || 'self';
    const file = this.#shardFile(chatKey, ts);
    const shard = this.#loadShard(file);

    const explicitId = String(input.id ?? '').trim();
    if (explicitId) {
      const hit = shard.events.find((e) => e.id === explicitId);
      if (hit) return { ok: true, event: hit, duplicate: true };
    }

    // 24h 内同主体同文本去重（她容易在几轮里重复记同一件事）
    const dayAgo = ts - 24 * 60 * 60 * 1000;
    const dup = shard.events.find((e) => e.actorId === actorId
      && e.text === text
      && Number(e.ts) >= dayAgo
      && Number(e.ts) <= ts + 60 * 1000);
    if (dup) return { ok: true, event: dup, duplicate: true };

    const event = {
      id: explicitId || nowId('e', ts),
      ts,
      chatKey,
      actorId,
      actorName: str(input.actorName, 60),
      kind,
      text,
      valence: clampNum(input.valence, -1, 1, 0),
      salience: clampNum(input.salience, 0, 1, 0.5),
      tags: strList(input.tags, { maxItems: LIMITS.eventTags, maxLen: LIMITS.tagLen }),
      refs: isPlainObject(input.refs) ? { ...input.refs } : {},
      compacted: false,
      // 摘要事件用它溯源到被压缩的原事件。必须写进磁盘（否则重启后溯源丢失）。
      summaryOf: strList(input.summaryOf, { maxItems: 50, maxLen: 60 })
    };

    shard.events.push(event);
    this.#writeShard(file, shard.events);
    return { ok: true, event };
  }

  /**
   * 查询事件。
   *
   * @param {object} q
   * @param {string} [q.chatKey] 限定会话；省略 = 全部会话
   * @param {string} [q.actorId]
   * @param {string[]} [q.kinds]
   * @param {number} [q.fromTs] / [q.toTs]
   * @param {boolean} [q.includeCompacted=false]
   * @param {number} [q.limit] 取最近 N 条（结果仍按时间升序返回）
   * @returns {object[]} 按 ts 升序
   */
  queryEvents(q = {}) {
    const files = q.chatKey
      ? this.#shardFilesOf(q.chatKey)
      : this.#allShardFiles();
    const fromTs = Number.isFinite(Number(q.fromTs)) ? Number(q.fromTs) : -Infinity;
    const toTs = Number.isFinite(Number(q.toTs)) ? Number(q.toTs) : Infinity;
    const kinds = Array.isArray(q.kinds) && q.kinds.length ? new Set(q.kinds) : null;
    let out = [];
    for (const file of files) {
      for (const e of this.#loadShard(file).events) {
        if (!q.includeCompacted && e.compacted) continue;
        if (kinds && !kinds.has(e.kind)) continue;
        if (q.actorId && String(e.actorId) !== String(q.actorId)) continue;
        const ts = Number(e.ts) || 0;
        if (ts < fromTs || ts > toTs) continue;
        out.push(e);
      }
    }
    out.sort((a, b) => (Number(a.ts) - Number(b.ts)) || String(a.id).localeCompare(String(b.id)));
    const limit = Number(q.limit);
    if (Number.isFinite(limit) && limit > 0) out = out.slice(-limit);
    return out;
  }

  /**
   * 统计"尚未被反思吸收"的事件数。
   * @param {string} chatKey
   * @param {number} since 上次反思时间（0 = 全部未吸收）
   */
  countUnreflected(chatKey, since = 0) {
    const from = Number(since) || 0;
    return this.queryEvents({ chatKey, includeCompacted: false })
      .filter((e) => Number(e.ts) > from).length;
  }

  /**
   * 把若干事件标记为已压缩，并追加一条摘要事件。
   *
   * 为什么要重写分片：JSONL 是追加式，但"已压缩"是原地状态。
   * 按月分片后单个文件很小（一个私聊一个月通常几百行），重写代价可接受。
   *
   * @param {string[]} ids
   * @param {object} summaryEvent 摘要事件（会自动补 summaryOf / kind）
   * @returns {{ok:boolean, compacted:number, summary?:object}}
   */
  markCompacted(ids, summaryEvent = {}) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean));
    if (!wanted.size) return { ok: false, compacted: 0, reason: '缺少 ids' };

    const touched = new Map();   // file -> events
    let compacted = 0;
    for (const file of this.#allShardFiles()) {
      const shard = this.#loadShard(file);
      let changed = false;
      for (const e of shard.events) {
        if (!wanted.has(String(e.id)) || e.compacted) continue;
        e.compacted = true;
        compacted++;
        changed = true;
      }
      if (changed) touched.set(file, shard.events);
    }
    for (const [file, events] of touched) this.#writeShard(file, events);
    if (!compacted) return { ok: false, compacted: 0, reason: '没有可压缩的事件' };

    const summary = this.appendEvent({
      ...summaryEvent,
      kind: summaryEvent.kind || 'observation',
      summaryOf: [...wanted],
      // 摘要本身不应被再次压缩
      text: str(summaryEvent.text, LIMITS.eventText) || `压缩了 ${compacted} 条旧记忆`
    });
    return { ok: true, compacted, summary: summary.event || null };
  }

  // ── 关系 ──

  getRelation(userId) {
    const id = String(userId ?? '').trim();
    if (!id) return defaultRelation('');
    const raw = readJson(this.#relationFile(id), null);
    if (!isPlainObject(raw)) return defaultRelation(id);
    return { ...defaultRelation(id), ...raw, userId: id };
  }

  /**
   * 合并更新关系。只接受白名单字段，越界变化被钳制而不是报错。
   *
   * @param {string} userId
   * @param {object} patch
   * @param {object} [opts]
   * @param {string[]} [opts.evidence] 支撑事件 id
   * @param {number|null} [opts.confidence]
   * @returns {{ok:boolean, relation?:object, clamp?:string[], reason?:string}}
   */
  patchRelation(userId, patch = {}, { evidence = [], confidence = null, now = Date.now() } = {}) {
    const id = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(id)) return { ok: false, reason: 'userId 必须是数字 QQ 号' };
    if (!isPlainObject(patch)) return { ok: false, reason: 'patch 必须是对象' };

    const rel = this.getRelation(id);
    const clampNotes = [];

    if (patch.nickname !== undefined) rel.nickname = str(patch.nickname, LIMITS.nickname);

    if (patch.stage !== undefined && STAGES.includes(patch.stage)) {
      const next = clampStage(rel.stage, patch.stage);
      if (next !== patch.stage) clampNotes.push(`stage 从 ${patch.stage} 钳制为 ${next}（一次最多一级）`);
      rel.stage = next;
    }

    for (const key of ['trust', 'warmth']) {
      if (patch[key] === undefined) continue;
      const current = Number(rel[key]) || 50;
      const target = clampNum(patch[key], 0, 100, current);
      const delta = Math.max(-10, Math.min(10, target - current));
      if (delta !== target - current) clampNotes.push(`${key} 变化钳制为 ${delta}`);
      rel[key] = Math.max(0, Math.min(100, current + delta));
    }

    if (Array.isArray(patch.knownFor)) {
      rel.knownFor = strList(patch.knownFor, { maxItems: LIMITS.knownFor, maxLen: LIMITS.listItem });
    }
    if (Array.isArray(patch.tender)) {
      rel.tender = strList(patch.tender, { maxItems: LIMITS.tender, maxLen: LIMITS.listItem });
    }
    if (patch.recentSummary !== undefined) {
      rel.recentSummary = str(patch.recentSummary, LIMITS.recentSummary);
    }
    if (patch.lastInteractedAt !== undefined) {
      const ts = Number(patch.lastInteractedAt);
      if (Number.isFinite(ts) && ts > 0) rel.lastInteractedAt = ts;
    }

    if (patch.openLoop !== undefined) {
      const text = str(patch.openLoop, LIMITS.openLoopText);
      if (text && !rel.openLoops.some((l) => l.text === text)) {
        rel.openLoops.push({ text, since: Number(now) || Date.now() });
        if (rel.openLoops.length > LIMITS.openLoops) rel.openLoops = rel.openLoops.slice(-LIMITS.openLoops);
      }
    }
    if (patch.closeLoop !== undefined) {
      const needle = str(patch.closeLoop, LIMITS.openLoopText);
      if (needle) rel.openLoops = rel.openLoops.filter((l) => !String(l.text).includes(needle));
    }

    // 名字累积：改名不应该让旧名字消失（认人靠这个）
    const nameNow = str(patch.name, 60);
    if (nameNow && !rel.names.includes(nameNow)) {
      rel.names = [...rel.names, nameNow].slice(-5);
    }

    const ev = (Array.isArray(evidence) ? evidence : [])
      .map((x) => String(x ?? '').trim()).filter(Boolean);
    if (ev.length) rel.evidence = [...rel.evidence, ...ev].slice(-LIMITS.evidence);

    if (confidence !== null && confidence !== undefined) {
      rel.confidence = clampNum(confidence, 0, 1, Number(rel.confidence) || 0.3);
    } else if (ev.length) {
      // 有新证据就略微提一点把握，但不会一步到满
      rel.confidence = Math.min(1, (Number(rel.confidence) || 0.3) + 0.05 * ev.length);
    }

    rel.updatedAt = Number(now) || Date.now();
    writeJsonAtomic(this.#relationFile(id), rel);
    return { ok: true, relation: rel, clamp: clampNotes };
  }

  listRelations() {
    let files = [];
    try { files = fs.readdirSync(this.#relationsDir()).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
    const out = [];
    for (const f of files) {
      const rel = readJson(path.join(this.#relationsDir(), f), null);
      if (isPlainObject(rel)) out.push({ ...defaultRelation(String(rel.userId || f.replace(/\.json$/, ''))), ...rel });
    }
    out.sort((a, b) => String(a.userId).localeCompare(String(b.userId)));
    return out;
  }

  // ── 自我 ──

  getSelf() {
    const raw = readJson(this.#selfFile(), null);
    if (!isPlainObject(raw)) return defaultSelf();
    return {
      ...defaultSelf(),
      ...raw,
      mood: { ...defaultSelf().mood, ...(isPlainObject(raw.mood) ? raw.mood : {}) },
      preoccupations: Array.isArray(raw.preoccupations) ? raw.preoccupations : [],
      changelog: Array.isArray(raw.changelog) ? raw.changelog : []
    };
  }

  /**
   * 改写自我。任何一次成功改写都会 version++ 并留 changelog。
   *
   * @param {object} patch { narrative?, mood?, preoccupations? }
   * @param {object} opts  { by?: 'self'|'reflection'|'owner', reason: string, now? }
   * @returns {{ok:boolean, self?:object, reason?:string}}
   */
  reviseSelf(patch = {}, { by = 'self', reason = '', now = Date.now() } = {}) {
    if (!isPlainObject(patch)) return { ok: false, reason: 'patch 必须是对象' };
    const why = str(reason, LIMITS.reason);
    if (!why) return { ok: false, reason: '改写自我必须给出 reason' };

    const self = this.getSelf();
    const next = {
      ...self,
      mood: { ...self.mood },
      preoccupations: [...self.preoccupations]
    };

    if (patch.narrative !== undefined) {
      const narrative = str(patch.narrative, LIMITS.narrative);
      if (!narrative) return { ok: false, reason: 'narrative 不能为空（想清空请用 owner 通道）' };
      const violated = violateInvariants(
        String(self.narrative || ''),
        narrative,
        this.options.seedInvariants
      );
      if (violated) return { ok: false, reason: violated };
      next.narrative = narrative;
    }

    if (isPlainObject(patch.mood)) {
      const label = str(patch.mood.label, LIMITS.moodLabel);
      const valence = clampNum(patch.mood.valence, -1, 1, Number(next.mood.valence) || 0);
      if (label || patch.mood.valence !== undefined) {
        next.mood = {
          label: label || next.mood.label || '',
          valence,
          since: Number(now) || Date.now()
        };
      }
    }

    if (Array.isArray(patch.preoccupations)) {
      next.preoccupations = strList(patch.preoccupations, {
        maxItems: LIMITS.preoccupations,
        maxLen: LIMITS.preoccupationItem
      });
    }

    next.version = (Number(self.version) || 0) + 1;
    next.updatedAt = Number(now) || Date.now();
    next.changelog = [
      ...self.changelog,
      {
        at: next.updatedAt,
        by: by === 'owner' ? 'owner' : by === 'reflection' ? 'reflection' : 'self',
        reason: why
      }
    ].slice(-LIMITS.changelog);

    writeJsonAtomic(this.#selfFile(), next);
    return { ok: true, self: next };
  }

  // ── 节律状态 ──

  getTick() {
    const raw = readJson(this.#tickFile(), null);
    if (!isPlainObject(raw)) return defaultTick();
    return { ...defaultTick(), ...raw };
  }

  updateTick(patch = {}) {
    if (!isPlainObject(patch)) return this.getTick();
    const next = { ...this.getTick(), ...patch };
    writeJsonAtomic(this.#tickFile(), next);
    return next;
  }

  // ── 日志 ──

  appendReflection(entry = {}) {
    const record = {
      id: String(entry.id || nowId('r', Date.now())),
      at: Number(entry.at) || Date.now(),
      ...entry
    };
    appendJsonl(this.#reflectionsFile(), record);
    return record;
  }

  appendAction(entry = {}) {
    const record = {
      id: String(entry.id || nowId('a', Date.now())),
      at: Number(entry.at) || Date.now(),
      ...entry
    };
    appendJsonl(this.#actionsFile(), record);
    return record;
  }

  listReflections({ limit = 20 } = {}) {
    return tailJsonl(this.#reflectionsFile(), limit);
  }

  listActions({ limit = 20 } = {}) {
    return tailJsonl(this.#actionsFile(), limit);
  }

  // ── 分片读写 ──

  #loadShard(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return { events: [] }; }
    const cached = this._shards.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
    const entry = { mtimeMs: stat.mtimeMs, events: readJsonl(file) };
    this._shards.set(file, entry);
    return entry;
  }

  #writeShard(file, events) {
    writeJsonlAtomic(file, events);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
    this._shards.set(file, { mtimeMs, events });
  }

  #shardFilesOf(chatKey) {
    const dir = this.#chatEventsDir(chatKey);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)); } catch { return []; }
    return files.sort().map((f) => path.join(dir, f));
  }

  #allShardFiles() {
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(this.#eventsRoot(), { withFileTypes: true }); } catch { return out; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let files = [];
      try { files = fs.readdirSync(path.join(this.#eventsRoot(), d.name)); } catch { continue; }
      for (const f of files) {
        if (/^\d{4}-\d{2}\.jsonl$/.test(f)) out.push(path.join(this.#eventsRoot(), d.name, f));
      }
    }
    return out.sort();
  }
}

export { MIND_DIR, LIMITS as MIND_LIMITS, chatDirName as mindChatDirName };
