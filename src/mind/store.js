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
import { detectStrongText, stageRegressed, STRONG_KINDS } from './strong.js';

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
  // 意图与观察
  intentionText: 160,
  observationWindowMs: 72 * 3600 * 1000,   // 一条观察的有效窗口（72 小时）
  observationCheckMs: 24 * 3600 * 1000,    // 最早什么时候可以复查（24 小时）
  // 自我笔记：只保留最近的，攒够几条就该由全局整合消化一次。
  selfNotes: 20,
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

/**
 * 一次尝试的结局。
 *
 * 没做动作（idle）与"做了但被拒"必须分开：前者说明她决定不做，
 * 后者说明她想做但世界不允许 —— 这两种情况对"要不要再试"的含义完全相反。
 */
function inferOutcome(entry = {}) {
  if (entry.outcome) return entry.outcome;
  if (entry.error) return 'failed';
  if (entry.action === 'idle') return 'idle';
  if (entry.result && entry.result.blocked) return 'blocked';
  return 'done';
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
    // 待整合的"我好像变了"：会话级反思只能写到这里，改写自我要等全局整合。
    // 有它，"哪个群先攒够事件，哪个群就塑造她"这个问题才被挡住。
    selfNotes: [],
    changelog: []
  };
}

/** 关系的"判断"字段：版本与 changelog 只跟这些走，证据/置信度不算。 */
const JUDGMENT_KEYS = ['nickname', 'stage', 'trust', 'warmth', 'knownFor', 'tender', 'recentSummary', 'openLoops', 'names', 'contexts'];
function judgmentOf(rel) {
  return JSON.stringify(JUDGMENT_KEYS.map((k) => (rel?.[k] ?? null)));
}

function defaultRelation(userId) {
  return {
    userId: String(userId ?? ''),
    // 关系的版本与改写记录：与 self 同口径（谁改的、为什么、依据是什么）。
    // 老数据没有这两个字段，读取时按 0 / [] 兜底，第一次写入就变 1。
    version: 0,
    changelog: [],
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
    // 全局整合的额度与冷却：独立于会话反思（两者抢同一份预算会让"她什么时候想自己"变得随机）。
    todayIntegrates: 0,
    lastIntegrateAt: 0,
    lastNarrativeAt: 0,
    // L2b（全局反思）的时间与当日次数
    lastGlobalReflectAt: 0,
    todayGlobalReflects: 0,
    // 唤醒时钟：impulseAt 是"她自己想醒来的时刻"（指数分布采样）；
    // lastFreeWakeAt 只用于"刚醒过"的节流与观测，不参与下一次计算。
    impulseAt: 0,
    lastFreeWakeAt: 0,
    lastInteractionAt: 0,
    lastReflectAt: 0,
    // 上次**尝试**反思的时间（无论成败）。冷却用它而不是 lastReflectAt：
    // 解析失败时 lastReflectAt 不前移，若不再记尝试时间，失败会变成每轮重试。
    lastReflectAttemptAt: 0,
    // 候选打盹：`<chatKey>|<candidateId>` -> 到期时间。
    // 她"想了一下但决定不做"之后，同一个理由不该每 5 分钟重新叫她一次。
    snoozes: {},
    // 动作节律：每个动作做成/失败多少次、平均多久做一次、下次什么时候可以再试。
    actionStats: {},
    // 作息：夜里睡着是**状态**，不是静音开关（睡着时不看消息、不做决策）。
    sleep: {
      state: 'awake',   // 'awake' | 'asleep'
      since: 0,
      nightKey: '',
      stayUps: 0
    },
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
  // 旧的行动流水账：**已冻结**，只读不写（历史上写进去的记录仍要能看见）。
  #actionsFile() { return path.join(this.root, 'actions.jsonl'); }
  #attemptsFile() { return path.join(this.root, 'attempts.jsonl'); }
  #intentionsFile() { return path.join(this.root, 'intentions.jsonl'); }
  #observationsFile() { return path.join(this.root, 'observations.jsonl'); }
  #narrativesFile() { return path.join(this.root, 'narratives.jsonl'); }
  #momentsFile() { return path.join(this.root, 'moments.jsonl'); }

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
      // 写入溯源（设计 §4.2）：谁写的、属于哪一次运行 / 哪一次尝试。
      // 以前这些字段只存在于端口的入参里，落盘时被丢掉 —— 出了事无法回答"这条谁写的"。
      source: str(input.source, 40),
      momentId: str(input.momentId, 60),
      attemptId: str(input.attemptId, 60),
      compacted: false,
      // 摘要事件用它溯源到被压缩的原事件。必须写进磁盘（否则重启后溯源丢失）。
      summaryOf: strList(input.summaryOf, { maxItems: 50, maxLen: 60 })
    };

    // 强事件在这里判定（纯文本规则，见 strong.js）。模型自己也可以标 strong，
    // 但那是加分项，不是唯一入口——否则她连"这次很重要"都想不起来写。
    const strongHint = detectStrongText(text);
    if (strongHint || input.strong === true) {
      event.strong = true;
      event.strongKind = STRONG_KINDS.includes(input.strongKind)
        ? input.strongKind
        : (strongHint?.kind || 'milestone');
    }

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
    // 摘要事件是压缩产物，不是"还没反思的经历"：把它算进欠账会虚高，
    // 触发一次没有材料的反思（还会把 lastReflectAt 推走）。
    return this.queryEvents({ chatKey, includeCompacted: false })
      .filter((e) => Number(e.ts) > from)
      .filter((e) => !(Array.isArray(e.summaryOf) && e.summaryOf.length))
      .length;
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
  patchRelation(userId, patch = {}, {
    evidence = [], confidence = null, now = Date.now(), by = 'unknown', reason = ''
  } = {}) {
    const id = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(id)) return { ok: false, reason: 'userId 必须是数字 QQ 号' };
    if (!isPlainObject(patch)) return { ok: false, reason: 'patch 必须是对象' };

    const rel = this.getRelation(id);
    const clampNotes = [];
    const beforeJudgment = judgmentOf(rel);
    const stageBefore = rel.stage;

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

    // 只记"看法真的变了"的调用：重复写同一个昵称、或者只是补一条证据，
    // 都不该把版本刷到两位数，也不该在 changelog 里留下空记录。
    // 版本记的是"她对他的判断变了第几次"，不是"这个文件被写过几次"。
    const changed = judgmentOf(rel) !== beforeJudgment;
    // 关系阶段往下掉，本身就是一次强事件（比任何文本规则都可靠）。
    const regressed = stageRegressed(stageBefore, rel.stage, STAGE_LEVEL);
    if (regressed) {
      rel.strongAt = Number(now) || Date.now();
      rel.strongKind = 'stage-regressed';
    }

    rel.updatedAt = Number(now) || Date.now();
    if (changed) {
      rel.version = (Number(rel.version) || 0) + 1;
      rel.changelog = [
        ...(Array.isArray(rel.changelog) ? rel.changelog : []),
        {
          at: rel.updatedAt,
          by: str(by, 40) || 'unknown',
          reason: str(reason, LIMITS.reason),
          evidence: ev.slice(-5)
        }
      ].slice(-LIMITS.changelog);
    }
    writeJsonAtomic(this.#relationFile(id), rel);
    return { ok: true, relation: rel, clamp: clampNotes, changed, stageRegressed: regressed };
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
      selfNotes: Array.isArray(raw.selfNotes) ? raw.selfNotes : [],
      changelog: Array.isArray(raw.changelog) ? raw.changelog : []
    };
  }

  /**
   * 追加"自我笔记"：会话级反思的产物，**不是**对自我的改写。
   *
   * 为什么要分成两层：自我属于全局，而反思按会话触发。如果会话反思能直接改自我，
   * 那么哪个会话先攒够事件，哪个会话的语境就会成为她自我叙事的来源 ——
   * 刷屏的人会系统性地塑造她是谁。笔记只是一闪念，等全局整合来消化。
   *
   * @param {Array<{text:string, at?:number}>|string[]} notes
   * @param {{ by?: string, now?: number }} [opts]
   * @returns {{ ok:boolean, added:number, self?:object, reason?:string }}
   */
  appendSelfNotes(notes, { by = 'reflection', now = Date.now() } = {}) {
    const list = (Array.isArray(notes) ? notes : [])
      .map((n) => (typeof n === 'string' ? { text: n } : (isPlainObject(n) ? n : null)))
      .filter(Boolean)
      .map((n) => String(n.text ?? '').trim())
      .filter(Boolean);
    if (!list.length) return { ok: false, added: 0, reason: '没有要记的笔记' };

    const self = this.getSelf();
    const at = Number(now) || Date.now();
    const next = [...self.selfNotes];
    let added = 0;
    for (const text of list) {
      // 24 小时内同一句话不重复记（她容易连着几轮想到同一件事）
      const dup = next.some((n) => String(n.text) === text && at - Number(n.at) < 24 * 3600 * 1000);
      if (dup) continue;
      next.push({ id: nowId('sn', at), at, text: str(text, 200), by });
      added++;
    }
    if (!added) return { ok: true, added: 0, self };

    // 淘汰顺序：先丢"已消化"的最旧几条，再丢"未消化"的 —— 且要计数。
    // 以前直接 slice(-20)，一个从没触发过整合的月里，最早的笔记会被无声抹掉，
    // 而"被忘掉"本身应该是可观测的，不是悄悄发生。
    let kept = next;
    if (kept.length > LIMITS.selfNotes) {
      // 按原顺序走一遍，先扔掉最旧的"已消化"条目（它们已经进了自我，留着只是归档）
      let over = kept.length - LIMITS.selfNotes;
      kept = kept.filter((n) => {
        if (over > 0 && Number(n.digestedAt)) { over--; return false; }
        return true;
      });
      if (kept.length > LIMITS.selfNotes) {
        const droppedFresh = kept.length - LIMITS.selfNotes;
        kept = kept.slice(-LIMITS.selfNotes);
        self.selfNotesDropped = (Number(self.selfNotesDropped) || 0) + droppedFresh;
      }
    }

    const patched = {
      ...self,
      selfNotes: kept,
      updatedAt: at
    };
    writeJsonAtomic(this.#selfFile(), patched);
    return { ok: true, added, self: patched };
  }

  /** 还没被整合消化的自我笔记（全局整合的材料）。 */
  undigestedSelfNotes() {
    return this.getSelf().selfNotes.filter((n) => !Number(n.digestedAt));
  }

  /**
   * 标记笔记已被消化。
   *
   * 不物理删除：原文留着才能回答"她当时为什么这么想"。消化只是不再进入下一次材料。
   * @param {string[]} ids
   */
  markSelfNotesDigested(ids, now = Date.now()) {
    const want = new Set((Array.isArray(ids) ? ids : []).map(String));
    if (!want.size) return { ok: true, marked: 0 };
    const self = this.getSelf();
    let marked = 0;
    const next = self.selfNotes.map((n) => {
      if (!want.has(String(n.id)) || Number(n.digestedAt)) return n;
      marked++;
      return { ...n, digestedAt: Number(now) || Date.now() };
    });
    if (marked) writeJsonAtomic(this.#selfFile(), { ...self, selfNotes: next });
    return { ok: true, marked };
  }

  /**
   * 最近一段时间里的强事件（事件上的 strong 标记 + 关系阶段回退）。
   * @param {number} since
   */
  listStrongSince(since = 0) {
    const from = Number(since) || 0;
    const out = [];
    try {
      for (const ev of this.queryEvents({ limit: 500 })) {
        if (ev.strong === true && Number(ev.ts) >= from) {
          out.push({ kind: ev.strongKind || 'milestone', at: Number(ev.ts), ref: ev.id });
        }
      }
    } catch { /* 读取失败就当没有强事件 */ }
    for (const rel of this.listRelations()) {
      if (Number(rel.strongAt) >= from && rel.strongAt) {
        out.push({ kind: rel.strongKind || 'stage-regressed', at: Number(rel.strongAt), ref: rel.userId });
      }
    }
    out.sort((a, b) => a.at - b.at);
    return out;
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

  /**
   * 记一次"她做了什么"。
   *
   * 从 B3 起写进 attempts.jsonl，不再写 actions.jsonl（那个文件冻结为只读历史）。
   * 字段是旧记录的超集：多了 outcome（做成了没）与 intentionId（为了哪件事），
   * 所以老代码读 listActions 仍拿到一模一样的形状。
   *
   * @param {object} entry
   * @param {'sent'|'blocked'|'failed'|'idle'|'done'} [entry.outcome] 不传则按 error/result 推断
   */
  appendAction(entry = {}) {
    const at = Number(entry.at) || Date.now();
    const record = {
      ...entry,
      id: String(entry.id || nowId('at', at)),
      at,
      outcome: entry.outcome || inferOutcome(entry)
    };
    appendJsonl(this.#attemptsFile(), record);
    return record;
  }

  /**
   * 写一段叙事。
   *
   * 叙事与反思的区别：反思是"这段时间我想到的"，按会话或全局触发、可能一天几次；
   * 叙事是"这几周我过成了什么样"，按周或里程碑写，写的是已经沉淀下来的东西。
   * 所以它只在 integrate 层产出，且**不覆盖**旧段落 —— 每一段都是她人生里的一段。
   */
  appendNarrative(input = {}) {
    const at = Number(input.at) || Date.now();
    const text = str(input.text, 2000);
    if (!text) return { ok: false, reason: '叙事不能为空' };
    const narrative = {
      id: nowId('nr', at),
      at,
      title: str(input.title, 60),
      text,
      source: String(input.source || 'integrate.global'),
      period: {
        from: Number(input.period?.from) || 0,
        to: Number(input.period?.to) || at
      },
      materials: {
        reflections: Array.isArray(input.materials?.reflections) ? input.materials.reflections.slice(0, 40) : [],
        strong: Array.isArray(input.materials?.strong) ? input.materials.strong.slice(0, 20) : []
      }
    };
    appendJsonl(this.#narrativesFile(), narrative);
    return { ok: true, narrative };
  }

  listNarratives({ limit = 10 } = {}) {
    return tailJsonl(this.#narrativesFile(), limit);
  }

  latestNarrative() {
    return this.listNarratives({ limit: 1 })[0] || null;
  }

  /**
   * 记一次"时刻"：一次模型调用及其子运行。
   *
   * 为什么单独存：attempts 记"做了什么"，moments 记"这一次想了多久、花了多少"。
   * 两者分开，才能回答"她一天想几次、每次多贵"这种问题。
   *
   * @param {object} input
   * @param {string} [input.runtime] 'free' | 'chat' | 'integrate' | 'automate'
   * @param {object} [input.usage]   `{ self, subtree }`（子树 = 她叫起来的子运行合计）
   * @param {string} [input.configDigest]
   */
  appendMoment(input = {}) {
    const at = Number(input.at) || Date.now();
    const moment = {
      id: String(input.id || nowId('mo', at)),
      at,
      runtime: String(input.runtime || 'free'),
      outcome: String(input.outcome || 'done'),
      usage: {
        self: Number(input.usage?.self) || 0,
        subtree: Number(input.usage?.subtree) || 0
      },
      configDigest: String(input.configDigest || ''),
      parentMomentId: String(input.parentMomentId || ''),
      // 这一次时刻叫起来的子时刻（嵌套运行）：父与子都能互相追到。
      childMomentIds: Array.isArray(input.childMomentIds) ? input.childMomentIds.slice(0, 20) : [],
      attempts: Array.isArray(input.attempts) ? input.attempts.slice(0, 50) : [],
      actions: Array.isArray(input.actions) ? input.actions.slice(0, 20) : []
    };
    appendJsonl(this.#momentsFile(), moment);
    return moment;
  }

  listMoments({ limit = 20 } = {}) {
    return tailJsonl(this.#momentsFile(), limit);
  }

  /** 只读：全部尝试（按写入顺序）。给 UI/统计用。 */  /** 只读：全部尝试（按写入顺序）。给 UI/统计用。 */
  listAttempts({ limit = 50, outcome = '' } = {}) {
    const all = readJsonl(this.#attemptsFile());
    const filtered = outcome ? all.filter((x) => x.outcome === outcome) : all;
    return filtered.slice(-Math.max(1, Number(limit) || 50));
  }

  /**
   * 增删改意图。
   *
   * 意图回答的是"她想做什么、打算什么时候做"，与 `attempts`（做成了没）分开：
   * 一次意图可以对应多次尝试（失败重试），失败原因也属于尝试而不是意图。
   *
   * @param {object} input
   * @param {string} input.text 她想做的事（一句话）
   * @param {number} [input.dueAt] 打算什么时候做（到点会进候选）
   * @param {string} [input.source] 'chat' | 'free' | 'user'
   * @param {string} [input.chatKey]
   * @param {string} [input.kind] 自由标记（delayed_check / follow_up / ...）
   */
  addIntention(input = {}) {
    const text = str(input.text, LIMITS.intentionText);
    if (!text) return { ok: false, reason: '意图不能为空' };
    const at = Number(input.at) || Date.now();
    const open = this.listIntentions({ status: 'open', limit: 200 });
    // 同一句话不重复挂：她经常在相邻两轮想同一件事
    const dup = open.find((x) => String(x.text) === text);
    if (dup) return { ok: true, intention: dup, duplicate: true };

    const intention = {
      id: nowId('in', at),
      text,
      at,
      dueAt: Number(input.dueAt) || 0,
      source: ['chat', 'free', 'user'].includes(input.source) ? input.source : 'chat',
      chatKey: String(input.chatKey || ''),
      kind: str(input.kind, 40) || 'follow_up',
      // 这条意图"打算怎么完成"：不记的话，只要对同一个人做了任何动作，
      // 都会被当成"事办完了"（remember 也能关掉"问问他搬家"）。
      action: str(input.action, 40),
      status: 'open',
      resolvedAt: 0,
      note: ''
    };
    appendJsonl(this.#intentionsFile(), intention);
    return { ok: true, intention, duplicate: false };
  }

  /** 列意图。同一 id 多行时以最后一行为准（状态机是追加写的）。 */
  listIntentions({ status = '', limit = 50, dueBefore = 0 } = {}) {
    const latest = new Map();
    for (const row of readJsonl(this.#intentionsFile())) {
      if (!row || !row.id) continue;
      const prev = latest.get(row.id);
      if (!prev || Number(row.at) >= Number(prev.at)) latest.set(row.id, { ...(prev || {}), ...row });
    }
    let out = [...latest.values()];
    if (status) out = out.filter((x) => x.status === status);
    if (dueBefore) out = out.filter((x) => Number(x.dueAt) > 0 && Number(x.dueAt) <= Number(dueBefore));
    out.sort((a, b) => (Number(a.dueAt) || Number(a.at)) - (Number(b.dueAt) || Number(b.at)));
    return out.slice(0, Math.max(1, Number(limit) || 50));
  }

  /**
   * 了结一条意图。
   * @param {string} id
   * @param {{status?: 'done'|'dropped'|'expired', note?: string, now?: number}} [opts]
   */
  resolveIntention(id, { status = 'done', note = '', now = Date.now() } = {}) {
    const cur = this.listIntentions({ limit: 500 }).find((x) => x.id === String(id));
    if (!cur) return { ok: false, reason: '没有这条意图' };
    if (cur.status !== 'open') return { ok: true, intention: cur, unchanged: true };
    if (!['done', 'dropped', 'expired'].includes(status)) return { ok: false, reason: '非法状态' };
    const next = { ...cur, status, resolvedAt: Number(now) || Date.now(), note: str(note, 200), at: Number(now) || Date.now() };
    appendJsonl(this.#intentionsFile(), next);
    return { ok: true, intention: next };
  }

  /**
   * 记一条观察：一次尝试之后，世界有没有按预期变化。
   *
   * 为什么要等：她发完消息不知道对方看没看、回没回；立刻判定只能判"发出去了"，
   * 判不了"有没有用"。所以给一个窗口（默认 72 小时），窗口到期才复查。
   */
  appendObservation(input = {}) {
    const at = Number(input.at) || Date.now();
    const windowMs = Number(input.windowMs) || LIMITS.observationWindowMs;
    const observation = {
      id: nowId('ob', at),
      at,
      attemptId: String(input.attemptId || ''),
      intentionId: String(input.intentionId || ''),
      chatKey: String(input.chatKey || ''),
      // 哪个动作、什么足迹：没有这两个字段，观测就只是"某件事有没有变化"，
      // 无法回写到具体动作的节律统计上（成长也就无从谈起）。
      action: str(input.action, 40),
      footprint: str(input.footprint, 40),
      expect: str(input.expect, 200),
      dueAt: at + windowMs,
      checkAfterAt: at + Math.min(windowMs, LIMITS.observationCheckMs),
      verdict: 'pending',
      note: ''
    };
    appendJsonl(this.#observationsFile(), observation);
    return observation;
  }

  /** 到期待复查的观察（窗口已过、还没判定）。 */
  listDueObservations(now = Date.now(), limit = 20) {
    const latest = new Map();
    for (const row of readJsonl(this.#observationsFile())) {
      if (!row || !row.id) continue;
      const prev = latest.get(row.id);
      if (!prev || Number(row.at) >= Number(prev.at)) latest.set(row.id, { ...(prev || {}), ...row });
    }
    return [...latest.values()]
      .filter((x) => x.verdict === 'pending' && Number(x.dueAt) <= Number(now))
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, Math.max(1, Number(limit) || 20));
  }

  /**
   * 收到对方的真实消息时，把这个会话里"等着看有没有回应"的观测一次关掉。
   *
   * 这是回声闭环里最便宜的一环：不用模型，不用等窗口到期 ——
   * 人回了，就是 hit。窗口到期的判定（drainDueObservations）只处理没人回的那部分。
   *
   * @param {string} chatKey
   * @param {{verdict?:'hit'|'missed'|'void', now?:number}} [opts]
   * @returns {{ok:boolean, closed:number}}
   */
  closeObservationsForChat(chatKey, { verdict = 'hit', now = Date.now() } = {}) {
    const key = String(chatKey || '');
    if (!key) return { ok: true, closed: 0 };
    const latest = new Map();
    for (const row of readJsonl(this.#observationsFile())) {
      if (!row || !row.id) continue;
      const prev = latest.get(row.id);
      if (!prev || Number(row.at) >= Number(prev.at)) latest.set(row.id, { ...(prev || {}), ...row });
    }
    let closed = 0;
    const actions = [];
    for (const ob of latest.values()) {
      if (ob.verdict !== 'pending' || String(ob.chatKey || '') !== key) continue;
      appendJsonl(this.#observationsFile(), {
        ...ob,
        verdict,
        note: verdict === 'hit' ? '对方回了话' : '手动关闭',
        resolvedAt: Number(now) || Date.now(),
        at: Number(now) || Date.now()
      });
      closed += 1;
      // 把动作带出去：命中要回写节律（调用方负责，store 不替它决定语义）。
      if (ob.action) actions.push(String(ob.action));
    }
    return { ok: true, closed, actions };
  }

  /**
   * 记一次动作的节律统计：成/败次数、平均间隔、下次可以再试的时间。
   *
   * 这是"成长"落到可观察行为上的地方：做成过的动作间隔变短，失败过的变长。
   * 没有它，观测队列就只是日志 —— 记了，但不会改变下一次行为。
   *
   * @param {string} actionId
   * @param {{ok?:boolean, now?:number}} [opts]
   */
  recordActionStat(actionId, { ok = true, now = Date.now() } = {}) {
    const id = String(actionId || '').trim();
    if (!id) return { ok: false, reason: '缺少动作 id' };
    const tick = this.getTick();
    const stats = (tick.actionStats && typeof tick.actionStats === 'object') ? { ...tick.actionStats } : {};
    const cur = stats[id] && typeof stats[id] === 'object' ? { ...stats[id] } : {};
    const at = Number(now) || Date.now();
    const HOUR = 3600000;
    const mean = Math.max(HOUR / 2, Math.min(24 * HOUR, Number(cur.meanIntervalMs) || 4 * HOUR));
    const nextMean = ok
      ? Math.max(HOUR / 2, Math.round(mean * 0.9))
      : Math.min(24 * HOUR, Math.round(mean * 1.2));
    stats[id] = {
      ok: (Number(cur.ok) || 0) + (ok ? 1 : 0),
      fail: (Number(cur.fail) || 0) + (ok ? 0 : 1),
      lastAt: at,
      meanIntervalMs: nextMean,
      nextRipeAt: at + nextMean
    };
    this.updateTick({ actionStats: stats });
    return { ok: true, stat: stats[id] };
  }
  /**
   * 作废过期观测：窗口过太久还没判的，直接 void。
   *
   * 为什么要作废而不是补判：那时候的"有没有变化"已经无法从现有事件里判准；
   * 留一条 pending 只会让队列越积越长。
   */
  voidStaleObservations({ olderThanMs = 7 * 86400000, now = Date.now(), beforeAt = 0 } = {}) {
    // 截止线取两者更晚的：既不能留太久（7 天），也不能留着"停机期间就到期"的观测——
    // 那段时间世界发生了什么没人看见，补判只会是编的。
    const deadline = Math.max(
      Number(now) - Math.max(86400000, Number(olderThanMs) || 0),
      Number(beforeAt) || 0
    );
    const latest = new Map();
    for (const row of readJsonl(this.#observationsFile())) {
      if (!row || !row.id) continue;
      const prev = latest.get(row.id);
      if (!prev || Number(row.at) >= Number(prev.at)) latest.set(row.id, { ...(prev || {}), ...row });
    }
    let voided = 0;
    for (const ob of latest.values()) {
      if (ob.verdict !== 'pending' || Number(ob.dueAt) > deadline) continue;
      appendJsonl(this.#observationsFile(), {
        ...ob, verdict: 'void', note: '放太久，判不准了', resolvedAt: Number(now), at: Number(now)
      });
      voided += 1;
    }
    return { ok: true, voided };
  }

  /**
   * 停机之后把学到的节律向默认值衰减一半。
   *
   * 为什么：动作间隔是"最近做成的频率"学出来的；停机一周后，那个频率描述的
   * 是一周前的她。完全不衰减会让一次坏运气永久影响之后的行为。
   */
  decayActionStats({ now = Date.now(), defaultMs = 4 * 3600000 } = {}) {
    const tick = this.getTick();
    const stats = (tick.actionStats && typeof tick.actionStats === 'object') ? { ...tick.actionStats } : {};
    const keys = Object.keys(stats);
    if (!keys.length) return { ok: true, adjusted: 0 };
    const def = Math.max(1800000, Number(defaultMs) || 4 * 3600000);
    for (const id of keys) {
      const cur = stats[id] && typeof stats[id] === 'object' ? { ...stats[id] } : {};
      const mean = Math.max(1800000, Math.min(24 * 3600000, Number(cur.meanIntervalMs) || def));
      const next = Math.round(mean + (def - mean) * 0.5);
      cur.meanIntervalMs = next;
      const ripe = Number(cur.nextRipeAt) || 0;
      cur.nextRipeAt = ripe ? Math.min(ripe, Number(now) + next) : Number(now) + next;
      stats[id] = cur;
    }
    this.updateTick({ actionStats: stats });
    return { ok: true, adjusted: keys.length };
  }

  /** 上一次启动记录（对账用）。 */
  readBootRecord() {
    return readJson(path.join(this.root, '.boot.json'), null);
  }

  writeBootRecord(record) {
    writeJsonAtomic(path.join(this.root, '.boot.json'), { ...(record || {}), at: Number(record?.at) || Date.now() });
    return { ok: true };
  }
  /** 存储结构版本：升级时用它判断要不要迁移/对账。 */
  getStoreVersion() {
    const raw = readJson(path.join(this.root, '.schema.json'), null);
    return Number(raw?.storeVersion) || 0;
  }

  setStoreVersion(version, extra = {}) {
    const file = path.join(this.root, '.schema.json');
    const cur = readJson(file, {}) || {};
    writeJsonAtomic(file, { ...cur, ...extra, storeVersion: Number(version) || 0, updatedAt: Date.now() });
    return { ok: true };
  }
  /**
   * 列出观察（同一 id 以最后一行为准）。
   * @param {{limit?:number}} [opts]
   */
  listObservations({ limit = 20 } = {}) {
    const latest = new Map();
    for (const row of readJsonl(this.#observationsFile())) {
      if (!row || !row.id) continue;
      const prev = latest.get(row.id);
      if (!prev || Number(row.at) >= Number(prev.at)) latest.set(row.id, { ...(prev || {}), ...row });
    }
    const all = [...latest.values()].sort((a, b) => Number(b.at) - Number(a.at));
    return all.slice(0, Math.max(1, Number(limit) || 20));
  }
  /**
   * 判定一条观察。
   * @param {string} id
   * @param {{verdict: 'changed'|'unchanged'|'void', note?: string, now?: number}} opts
   */
  resolveObservation(id, { verdict = 'void', note = '', now = Date.now() } = {}) {
    const cur = [...new Map(readJsonl(this.#observationsFile()).map((r) => [r.id, r])).values()]
      .find((x) => x.id === String(id));
    if (!cur) return { ok: false, reason: '没有这条观察' };
    if (!['hit', 'missed', 'void'].includes(verdict)) return { ok: false, reason: '非法判定' };
    const next = { ...cur, verdict, note: str(note, 200), resolvedAt: Number(now) || Date.now(), at: Number(now) || Date.now() };
    appendJsonl(this.#observationsFile(), next);
    return { ok: true, observation: next };
  }

  listReflections({ limit = 20 } = {}) {
    return tailJsonl(this.#reflectionsFile(), limit);
  }

  /**
   * 读行动流水（兼容旧文件）。
   *
   * 新的写入都进 attempts.jsonl；actions.jsonl 是冻结的历史，仍要能看见，
   * 否则用户升级后"她昨天做过什么"会突然变空。两边形状一致，直接拼接取尾部。
   */
  listActions({ limit = 20 } = {}) {
    const n = Math.max(1, Number(limit) || 20);
    const legacy = readJsonl(this.#actionsFile());
    const fresh = readJsonl(this.#attemptsFile());
    return [...legacy, ...fresh].slice(-n);
  }

  /** 日志文件体积（UI 上让用户知道"清掉能省多少"）。 */
  logSizes() {
    const sizeOf = (file) => {
      try { return fs.statSync(file).size; } catch { return 0; }
    };
    const legacy = sizeOf(this.#actionsFile());
    const attempts = sizeOf(this.#attemptsFile());
    const reflections = sizeOf(this.#reflectionsFile());
    // UI 上的"行动日志"= 冻结的旧文件 + 新的尝试记录，用户不关心这层拆分。
    const actions = legacy + attempts;
    return { actions, legacyActions: legacy, attempts, reflections, total: actions + reflections };
  }

  /**
   * 清空日志（用户手动管理磁盘）。
   *
   * 只删日志，**不动事件/关系/自我**：那些是她的记忆本身，
   * 日志只是"运行过程记录"，两者不能混为一谈。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.actions=true]
   * @param {boolean} [opts.reflections=true]
   * @returns {{ok:boolean, cleared:string[], freed:number}}
   */
  clearLogs({ actions = true, reflections = true } = {}) {
    const before = this.logSizes();
    const cleared = [];
    const truncate = (file) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '', 'utf8');
        return true;
      } catch { return false; }
    };
    // "清空行动日志"同时清掉冻结的旧文件与新的尝试记录：对用户来说它们是同一件事。
    if (actions) {
      let any = false;
      if (truncate(this.#actionsFile())) any = true;
      if (truncate(this.#attemptsFile())) any = true;
      if (any) cleared.push('actions');
    }
    if (reflections && truncate(this.#reflectionsFile())) cleared.push('reflections');
    const after = this.logSizes();
    return { ok: true, cleared, freed: Math.max(0, before.total - after.total) };
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
