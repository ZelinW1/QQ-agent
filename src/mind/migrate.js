// 心智数据迁移：把旧版本目录升到当前 storeVersion。
//
// 设计约束（§9.2）：
//   · 幂等：`.schema.json` 已达标就跳过；
//   · 不在原地改：先复制到 `mind.tmp/`，校验通过再原子换名；
//   · 只加不删：补字段，不改事件文本、不改关系数值；
//   · 备份放 data 根，不放 mind/（否则会被一起换名）；
//   · 可回滚：`migration.json` 记下备份路径。
//
// 本模块只做文件操作，不加载 MindStore —— 迁移要在"新代码可能读不懂旧数据"的
// 前提下工作，自己直接读 JSON 比复用 store 更稳。

import fs from 'node:fs';
import path from 'node:path';

export const TARGET_STORE_VERSION = 3;

const readJson = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
const readJsonl = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
};
const listFiles = (dir, predicate = () => true) => {
  try { return fs.readdirSync(dir).filter(predicate); } catch { return []; }
};
const hashText = (text) => {
  let h = 5381;
  for (let i = 0; i < String(text).length; i++) h = ((h << 5) + h + String(text).charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/** 体检：不写任何东西，给 --dry-run 与界面预览用。 */
export function inspectMind(fromDir) {
  const root = path.resolve(String(fromDir || ''));
  if (!fs.existsSync(root)) return { ok: false, reason: '目录不存在', root };
  const schema = readJson(path.join(root, '.schema.json'), null);
  const version = Number(schema?.storeVersion) || 0;

  let events = 0;
  const eventsRoot = path.join(root, 'events');
  for (const chatDir of listFiles(eventsRoot)) {
    for (const file of listFiles(path.join(eventsRoot, chatDir), (f) => f.endsWith('.jsonl'))) {
      events += readJsonl(path.join(eventsRoot, chatDir, file)).length;
    }
  }
  const relationFiles = listFiles(path.join(root, 'relations'), (f) => f.endsWith('.json'));
  const relations = relationFiles.map((f) => readJson(path.join(root, 'relations', f), null)).filter(Boolean);
  const openLoops = relations.reduce((n, r) => n + (Array.isArray(r.openLoops) ? r.openLoops.length : 0), 0);
  const actions = readJsonl(path.join(root, 'actions.jsonl')).length;
  const intentions = readJsonl(path.join(root, 'intentions.jsonl')).length;

  return {
    ok: true,
    root,
    version,
    needsMigration: version < TARGET_STORE_VERSION,
    counts: { events, relations: relations.length, openLoops, actions, intentions }
  };
}

/** actions.jsonl → actionStats（只补缺，不覆盖已有统计）。 */
function deriveActionStats(actions = []) {
  const stats = {};
  for (const row of actions) {
    const action = String(row?.action || '').trim();
    if (!action) continue;
    const cur = stats[action] || { ok: 0, fail: 0, attempts: 0, lastAt: 0 };
    const outcome = String(row?.outcome || (row?.ok === false ? 'failed' : 'done'));
    const good = outcome === 'done' || outcome === 'acted' || outcome === 'ok';
    cur.ok += good ? 1 : 0;
    cur.fail += good ? 0 : 1;
    cur.attempts = cur.ok + cur.fail;
    cur.lastAt = Math.max(cur.lastAt, Number(row?.at) || 0);
    stats[action] = cur;
  }
  for (const stat of Object.values(stats)) {
    stat.rate = stat.attempts ? Number((stat.ok / stat.attempts).toFixed(3)) : 0;
    stat.meanIntervalMs = 4 * 3600000;
    stat.nextRipeAt = 0;
    stat.dormant = false;
    stat.dormantUntil = 0;
  }
  return stats;
}

/** 旧关系里的 openLoops → 意图（旧版没有意图表）。 */
function deriveIntentions(relations = [], existingTexts = new Set(), now = Date.now()) {
  const out = [];
  for (const rel of relations) {
    for (const loop of Array.isArray(rel.openLoops) ? rel.openLoops : []) {
      const text = String(loop?.text || loop || '').trim();
      if (!text || existingTexts.has(text)) continue;
      const since = Number(loop?.since) || now;
      out.push({
        id: `in_mig_${hashText(text)}`,
        text: text.slice(0, 160),
        at: since,
        dueAt: since + 24 * 3600000,
        source: 'free',
        chatKey: String(rel.chatKey || ''),
        kind: 'follow_up',
        action: 'send_proactive',
        status: 'open',
        resolvedAt: 0,
        note: '由旧版 openLoops 迁移'
      });
    }
  }
  return out;
}

/**
 * 迁移。
 *
 * @param {object} opts
 * @param {string} opts.fromDir
 * @param {string} [opts.dataDir]   默认取 fromDir 的父目录（备份放这里）
 * @param {boolean} [opts.apply]    false = dry-run
 * @param {boolean} [opts.force]    已达标也强制重跑
 * @param {number} [opts.now]
 */
export function migrateMind({ fromDir, dataDir = null, apply = false, force = false, now = Date.now() } = {}) {
  const info = inspectMind(fromDir);
  if (!info.ok) return info;
  const root = info.root;
  const dataRoot = path.resolve(String(dataDir || path.dirname(root)));
  if (!info.needsMigration && !force) {
    return { ok: true, skipped: true, version: info.version, plan: info, message: '已经是当前版本' };
  }

  const ts = Number(now) || Date.now();
  const backupDir = path.join(dataRoot, `.backup-${ts}`);
  const tmpDir = path.join(dataRoot, 'mind.tmp');
  const plan = {
    from: root,
    dataRoot,
    fromVersion: info.version,
    toVersion: TARGET_STORE_VERSION,
    counts: info.counts,
    backupDir,
    tmpDir
  };

  // 1) 复制到临时目录（不在原地改）
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.cpSync(root, tmpDir, { recursive: true });

  // 2) 补字段：self
  const selfFile = path.join(tmpDir, 'self.json');
  const self = readJson(selfFile, {}) || {};
  writeJson(selfFile, {
    ...self,
    version: Number(self.version) || 0,
    changelog: Array.isArray(self.changelog) ? self.changelog : [],
    selfNotes: Array.isArray(self.selfNotes) ? self.selfNotes : []
  });

  // 3) 补字段：relations + 收集 openLoops
  const relationsDir = path.join(tmpDir, 'relations');
  const relations = [];
  for (const file of listFiles(relationsDir, (f) => f.endsWith('.json'))) {
    const filePath = path.join(relationsDir, file);
    const rel = readJson(filePath, null);
    if (!rel) continue;
    const patched = {
      ...rel,
      userId: String(rel.userId || path.basename(file, '.json')),
      version: Number(rel.version) || 0,
      changelog: Array.isArray(rel.changelog) ? rel.changelog : [],
      selfNotes: Array.isArray(rel.selfNotes) ? rel.selfNotes : [],
      names: Array.isArray(rel.names) ? rel.names : [],
      knownFor: Array.isArray(rel.knownFor) ? rel.knownFor : [],
      openLoops: Array.isArray(rel.openLoops) ? rel.openLoops : []
    };
    writeJson(filePath, patched);
    relations.push(patched);
  }

  // 4) openLoops → intentions（已有意图则只补缺）
  const intentionsFile = path.join(tmpDir, 'intentions.jsonl');
  const existing = readJsonl(intentionsFile);
  const existingTexts = new Set(existing.map((x) => String(x.text || '')));
  const derived = deriveIntentions(relations, existingTexts, ts);
  if (derived.length) {
    fs.appendFileSync(intentionsFile, derived.map((x) => JSON.stringify(x)).join('\n') + '\n');
  }

  // 5) actions.jsonl → actionStats（只补缺）
  const tickFile = path.join(tmpDir, 'tick.json');
  const tick = readJson(tickFile, {}) || {};
  const derivedStats = deriveActionStats(readJsonl(path.join(tmpDir, 'actions.jsonl')));
  const stats = (tick.actionStats && typeof tick.actionStats === 'object') ? { ...tick.actionStats } : {};
  for (const [id, stat] of Object.entries(derivedStats)) {
    if (!stats[id]) stats[id] = stat;
  }
  writeJson(tickFile, { ...tick, actionStats: stats });

  // 6) 校验：条数一致、关系/自我有版本
  const after = inspectMind(tmpDir);
  const problems = [];
  if (after.counts.events !== info.counts.events) problems.push(`事件数不一致：${info.counts.events} → ${after.counts.events}`);
  if (after.counts.relations !== info.counts.relations) problems.push(`关系数不一致：${info.counts.relations} → ${after.counts.relations}`);
  for (const rel of relations) if (!Number.isFinite(Number(rel.version))) problems.push('关系缺 version');
  if (!Number.isFinite(Number(readJson(selfFile, {})?.version))) problems.push('自我缺 version');

  // 7) 写版本 + 迁移记录
  writeJson(path.join(tmpDir, '.schema.json'), {
    storeVersion: TARGET_STORE_VERSION,
    migratedAt: ts,
    fromVersion: info.version
  });

  if (problems.length) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { ok: false, reason: '校验失败', problems, plan };
  }

  if (!apply) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      ok: true, dryRun: true, plan,
      would: { intentions: derived.length, actionStats: Object.keys(derivedStats).length }
    };
  }

  // 8) 备份 → 换名
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.cpSync(root, backupDir, { recursive: true });
  const oldDir = path.join(dataRoot, `mind.old-${ts}`);
  fs.rmSync(oldDir, { recursive: true, force: true });
  fs.renameSync(root, oldDir);
  fs.renameSync(tmpDir, root);

  writeJson(path.join(root, 'migration.json'), {
    at: ts,
    from: info.root,
    fromVersion: info.version,
    toVersion: TARGET_STORE_VERSION,
    backupDir,
    oldDir,
    counts: info.counts,
    derived: { intentions: derived.length, actionStats: Object.keys(derivedStats).length },
    verified: true
  });

  return {
    ok: true, applied: true, plan, backupDir, oldDir,
    derived: { intentions: derived.length, actionStats: Object.keys(derivedStats).length }
  };
}

/** 回滚到迁移前：换名回去，并清掉迁移产生的新文件。 */
export function rollbackMind({ dataDir, backupDir, now = Date.now() } = {}) {
  const dataRoot = path.resolve(String(dataDir || ''));
  const root = path.join(dataRoot, 'mind');
  const backup = path.resolve(String(backupDir || ''));
  if (!fs.existsSync(backup)) return { ok: false, reason: '备份不存在' };
  if (!fs.existsSync(root)) return { ok: false, reason: '当前心智目录不存在' };

  const ts = Number(now) || Date.now();
  const failedDir = path.join(dataRoot, `mind.failed-${ts}`);
  fs.renameSync(root, failedDir);
  fs.cpSync(backup, root, { recursive: true });
  // 迁移生成的新文件旧版本不认识：回滚后清掉
  for (const name of ['intentions.jsonl', 'attempts.jsonl', 'observations.jsonl', 'moments.jsonl',
    'narratives.jsonl', 'migration.json', '.schema.json', '.boot.json']) {
    fs.rmSync(path.join(root, name), { force: true });
  }
  return { ok: true, restoredFrom: backup, movedTo: failedDir };
}

/**
 * 首启检测（设计 §9.2）：目录存在、版本落后、且确实有内容 → 自动迁移一次。
 *
 * 为什么要有"有内容"这个条件：全新安装会创建空目录，空迁移除了制造备份什么也不做。
 * 由装配根在打开 store 之前调用（迁移会换目录，store 打开后换会有竞态）。
 *
 * @param {{dataDir:string, mindDir?:string, now?:number}} opts
 */
export function autoMigrateIfNeeded({ dataDir, mindDir = null, now = Date.now() } = {}) {
  const root = path.resolve(String(mindDir || path.join(String(dataDir || ''), 'mind')));
  const info = inspectMind(root);
  if (!info.ok) return { ok: true, skipped: true, reason: '没有心智目录' };
  if (!info.needsMigration) return { ok: true, skipped: true, reason: '已是当前版本', version: info.version };
  const total = info.counts.events + info.counts.relations + info.counts.actions + info.counts.intentions;
  if (total === 0) return { ok: true, skipped: true, reason: '空目录，无需迁移', version: info.version };
  return migrateMind({ fromDir: root, dataDir: dataDir || path.dirname(root), apply: true, now });
}