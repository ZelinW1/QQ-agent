// 旧印象迁移自测（M2-3）。
//
// 背景：memberImpression（按会话存的"对群友的印象"）与心智的关系档案
// 在说同一件事。两套并存时，她会在提示词里看到两份互相矛盾的说法
// （真实样本里出现过："说话很直、不用客套" vs "做后端、爱喝美式"）。
//
// 迁移只做**合并**：旧数据不删（仍可在记忆页查阅），但不再进提示词。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-migrate-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { MindStore } = await import(src('src/mind/store.js'));
const { Orchestrator } = await import(src('src/orchestrator.js'));

function mkOrch({ members = [], chats = ['group:123'] } = {}) {
  const mind = new MindStore({ root: fs.mkdtempSync(path.join(dataDir, 'm-')), getOptions: () => ({}) });
  const store = { listChats: () => chats, unreadCount: () => 0, getChatMeta: () => ({ lastTs: 0 }), recent: () => [] };
  const memory = { members: () => members };
  const orch = new Orchestrator({ store, memory, stickers: {}, sender: {}, sessions: {}, onebot: {}, mind });
  return { orch, mind };
}

// ── 1. 基本迁移 ─────────────────────────────────────────────────────────
console.log('\n=== 1. 迁移 ===');
{
  const { orch, mind } = mkOrch({
    members: [{
      userId: '456', name: '小王',
      impressions: [{ content: '做后端' }, { content: '说话很直' }]
    }]
  });

  const r = orch.migrateImpressionsToRelations();
  check(r.ok === true && r.merged === 2, `两条印象被并入（merged=${r.merged}）`);
  check(r.users === 1, '一个人');

  const rel = mind.getRelation('456');
  check(rel.knownFor.includes('做后端') && rel.knownFor.includes('说话很直'), '内容进了 knownFor');
  check(rel.nickname === '小王', '没有昵称时用印象里的名字补上');
  check(rel.evidence.includes('migrated:memberImpression'), '留下迁移来源标记');
}

// ── 2. 幂等 ─────────────────────────────────────────────────────────────
console.log('\n=== 2. 幂等 ===');
{
  const { orch, mind } = mkOrch({
    members: [{ userId: '456', name: '小王', impressions: [{ content: '做后端' }] }]
  });
  orch.migrateImpressionsToRelations();
  const first = mind.getRelation('456').knownFor.length;
  const r2 = orch.migrateImpressionsToRelations();
  check(r2.skipped === true, '第二次直接跳过');
  check(mind.getRelation('456').knownFor.length === first, '不会重复追加');
  check(mind.getTick().migratedImpressions === true, '标记已迁移（重启后也跳过）');
}

// ── 3. 边界 ─────────────────────────────────────────────────────────────
console.log('\n=== 3. 边界 ===');
{
  const { orch, mind } = mkOrch({
    members: [
      { userId: '456', name: '小王', impressions: [{ content: '做后端' }] },
      { userId: '', name: '没有QQ号的老数据', impressions: [{ content: '不该迁移' }] },
      { userId: '789', name: '小李', impressions: [] }
    ]
  });
  const r = orch.migrateImpressionsToRelations();
  check(r.users === 1 && r.merged === 1, '只迁移有 QQ 号且有内容的');
  check(mind.getRelation('789').knownFor.length === 0, '没有印象的人不建档');

  // 已有的 knownFor 不会被冲掉
  const { orch: o2, mind: m2 } = mkOrch({
    members: [{ userId: '456', name: '小王', impressions: [{ content: '爱喝美式' }] }]
  });
  m2.patchRelation('456', { knownFor: ['做后端'] }, { evidence: ['e1'] });
  o2.migrateImpressionsToRelations();
  const known = m2.getRelation('456').knownFor;
  check(known.includes('做后端') && known.includes('爱喝美式'), '新旧内容合并，不覆盖');
}

console.log(`\n旧印象迁移：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
