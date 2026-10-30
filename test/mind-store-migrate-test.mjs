// 存储迁移自测：dry-run、备份、原子换名、校验、回滚。
//
// 迁移是"只许成功一次"的操作：写坏了就是用户几年的记忆。
// 所以这里不测"能跑"，测的是设计里的几条不变量。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { inspectMind, migrateMind, rollbackMind, TARGET_STORE_VERSION } = await import(src('src/mind/migrate.js'));

const NOW = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
const mindDir = path.join(dataDir, 'mind');

/** 造一个 v0 目录：没有 .schema.json，关系没有 version，只有 actions.jsonl。 */
function makeV0() {
  fs.mkdirSync(path.join(mindDir, 'relations'), { recursive: true });
  fs.mkdirSync(path.join(mindDir, 'events', 'private_111'), { recursive: true });
  fs.writeFileSync(path.join(mindDir, 'self.json'), JSON.stringify({ narrative: '我是旧的', updatedAt: NOW - 86400000 }));
  fs.writeFileSync(path.join(mindDir, 'relations', '111.json'), JSON.stringify({
    userId: '111', names: ['王哥'], knownFor: [], openLoops: [{ text: '问问他搬家的事', since: NOW - 2 * 86400000 }]
  }));
  fs.writeFileSync(path.join(mindDir, 'events', 'private_111', '2026-10.jsonl'),
    JSON.stringify({ id: 'e1', ts: NOW - 3600000, chatKey: 'private:111', actorId: '111', text: '在吗' }) + '\n');
  fs.writeFileSync(path.join(mindDir, 'actions.jsonl'),
    JSON.stringify({ action: 'send_proactive', outcome: 'done', at: NOW - 3600000 }) + '\n'
    + JSON.stringify({ action: 'send_proactive', outcome: 'failed', at: NOW - 7200000 }) + '\n'
    + JSON.stringify({ action: 'remember', outcome: 'done', at: NOW - 1800000 }) + '\n');
  fs.writeFileSync(path.join(mindDir, 'tick.json'), JSON.stringify({ energy: 60 }));
}

makeV0();

// ── 1. 体检 ─────────────────────────────────────────────────────────────
console.log('\n=== 1. 体检 ===');
{
  const info = inspectMind(mindDir);
  check(info.ok && info.version === 0, '没有 .schema.json → 视为 v0');
  check(info.needsMigration === true, '需要迁移');
  check(info.counts.events === 1 && info.counts.relations === 1, '数出事件数与关系数');
  check(info.counts.actions === 3 && info.counts.openLoops === 1, '数出旧行动与未了的事');
  check(inspectMind(path.join(dataDir, 'nope')).ok === false, '目录不存在时明确失败');
}

// ── 2. dry-run 不落盘 ───────────────────────────────────────────────────
console.log('\n=== 2. dry-run ===');
{
  const r = migrateMind({ fromDir: mindDir, dataDir, apply: false, now: NOW });
  check(r.ok === true && r.dryRun === true, 'dry-run 成功');
  check(r.would.intentions === 1, `预览会把 1 条 openLoops 转成意图（${r.would.intentions}）`);
  check(r.would.actionStats === 2, '预览会回填 2 个动作的统计');
  check(!fs.existsSync(path.join(dataDir, 'mind.tmp')), 'dry-run 不留下 mind.tmp');
  check(!fs.existsSync(path.join(mindDir, '.schema.json')), '源目录没有被改');
}

// ── 3. 正式迁移 ─────────────────────────────────────────────────────────
console.log('\n=== 3. 正式迁移 ===');
let applied = null;
{
  applied = migrateMind({ fromDir: mindDir, dataDir, apply: true, now: NOW });
  check(applied.ok === true && applied.applied === true, '迁移成功');
  check(fs.existsSync(applied.backupDir), '备份在 data 根');
  check(fs.existsSync(applied.oldDir), '旧目录保留为 mind.old-*');
  check(applied.derived.intentions === 1, 'openLoops → 1 条意图');
  check(applied.derived.actionStats === 2, 'actions → 2 个动作统计');

  const schema = JSON.parse(fs.readFileSync(path.join(mindDir, '.schema.json'), 'utf8'));
  check(schema.storeVersion === TARGET_STORE_VERSION, '写上新版本号');

  const rel = JSON.parse(fs.readFileSync(path.join(mindDir, 'relations', '111.json'), 'utf8'));
  check(Number(rel.version) === 0, '关系补上 version（不改变原值）');
  check(Array.isArray(rel.changelog) && Array.isArray(rel.selfNotes), '关系补上 changelog/selfNotes');
  check(rel.openLoops.length === 1, '旧字段保留（只加不删）');

  const self = JSON.parse(fs.readFileSync(path.join(mindDir, 'self.json'), 'utf8'));
  check(self.version === 0 && Array.isArray(self.selfNotes), '自我补上 version/selfNotes');
  check(self.narrative === '我是旧的', '内容没被改（不改文本）');

  const intentions = fs.readFileSync(path.join(mindDir, 'intentions.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l));
  check(intentions.length === 1 && intentions[0].text === '问问他搬家的事', '意图文本来自 openLoops');
  check(intentions[0].action === 'send_proactive', '迁移出的意图带默认动作');

  const tick = JSON.parse(fs.readFileSync(path.join(mindDir, 'tick.json'), 'utf8'));
  check(tick.actionStats.send_proactive.ok === 1 && tick.actionStats.send_proactive.fail === 1, '行动统计按结局聚合');
  check(tick.actionStats.remember.ok === 1, '另一个动作也有统计');
  check(tick.energy === 60, 'tick 其它字段原样保留');

  const mig = JSON.parse(fs.readFileSync(path.join(mindDir, 'migration.json'), 'utf8'));
  check(mig.verified === true && mig.backupDir === applied.backupDir, 'migration.json 记下备份与校验结果');

  const again = migrateMind({ fromDir: mindDir, dataDir, apply: true, now: NOW + 1000 });
  check(again.skipped === true, '幂等：已达标就跳过');
}

// ── 4. 回滚 ─────────────────────────────────────────────────────────────
console.log('\n=== 4. 回滚 ===');
{
  const r = rollbackMind({ dataDir, backupDir: applied.backupDir, now: NOW + 5000 });
  check(r.ok === true, '回滚成功');
  check(JSON.parse(fs.readFileSync(path.join(mindDir, 'self.json'), 'utf8')).narrative === '我是旧的', '内容回到迁移前');
  check(!fs.existsSync(path.join(mindDir, '.schema.json')), '版本标记被清掉（下次启动会重迁）');
  check(!fs.existsSync(path.join(mindDir, 'intentions.jsonl')), '迁移生成的新文件被清掉');
  check(!fs.existsSync(path.join(mindDir, 'migration.json')), '迁移记录被清掉');
  check(fs.existsSync(r.movedTo), '回滚保留现场（mind.failed-*）');
}

console.log(`\n迁移：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
