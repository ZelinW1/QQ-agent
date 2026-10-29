// 心智存储层自测（PR1）。
//
// 这一套守的是"数据格式与写操作语义"，不涉及 LLM、不涉及提示词。
// 之所以单独成一套：后面反思、节律、工具全部建立在这些不变量上，
// 这里错一点，后面所有行为都会歪，而且极难定位。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 在 import config 之前把数据目录指到临时目录：config.js 在模块加载时确定 DATA_DIR。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-store-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const {
  MindStore, EVENT_KINDS, STAGES, STAGE_LEVEL, mindChatDirName
} = await import(src('src/mind/store.js'));

const mk = (opts = {}) => new MindStore({
  root: fs.mkdtempSync(path.join(dataDir, 'mind-')),
  getOptions: () => ({ seedInvariants: [], ...opts })
});

const CHAT = 'private:456';

// ── 1. 事件：追加与落盘 ─────────────────────────────────────────────────
console.log('\n=== 1. 事件：追加与落盘 ===');
{
  const store = mk();
  const r = store.appendEvent({
    chatKey: CHAT, actorId: '456', actorName: '小王',
    kind: 'interaction', text: '他说今天被裁员了，语气不太对',
    valence: -0.6, salience: 0.9, tags: ['工作']
  });
  check(r.ok === true, 'appendEvent 成功');
  check(/^e_\d+_[0-9a-f]{6}$/.test(r.event.id), `事件 id 格式正确（${r.event.id}）`);
  check(r.event.compacted === false, '新事件默认未压缩');
  check(r.event.valence === -0.6 && r.event.salience === 0.9, '情绪与显著度原样保留');

  const dir = path.join(store.root, 'events', mindChatDirName(CHAT));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  check(files.length === 1 && /^\d{4}-\d{2}\.jsonl$/.test(files[0]),
    `按月分片落盘（${files.join(',')}）`);

  const back = store.queryEvents({ chatKey: CHAT });
  check(back.length === 1 && back[0].id === r.event.id, '能按会话读回');
}

// ── 2. 事件：幂等与去重 ─────────────────────────────────────────────────
console.log('\n=== 2. 事件：幂等与去重 ===');
{
  const store = mk();
  const a = store.appendEvent({ chatKey: CHAT, actorId: '456', text: '同一件事' });
  const b = store.appendEvent({ chatKey: CHAT, actorId: '456', text: '同一件事' });
  check(b.duplicate === true && b.event.id === a.event.id, '24h 内同主体同文本去重');
  check(store.queryEvents({ chatKey: CHAT }).length === 1, '去重后只有一条');

  const c = store.appendEvent({ chatKey: CHAT, actorId: '789', text: '同一件事' });
  check(c.duplicate !== true, '不同主体不算重复');

  const fixed = store.appendEvent({ chatKey: CHAT, actorId: '456', text: '显式 id', id: 'e_custom' });
  const again = store.appendEvent({ chatKey: CHAT, actorId: '456', text: '显式 id 重放', id: 'e_custom' });
  check(fixed.event.id === 'e_custom' && again.duplicate === true, '显式 id 幂等（重放不新增）');

  check(store.appendEvent({ chatKey: '', text: 'x' }).ok === false, '缺 chatKey 被拒绝');
  check(store.appendEvent({ chatKey: CHAT, text: '   ' }).ok === false, '空文本被拒绝');
}

// ── 3. 事件：查询与计数 ─────────────────────────────────────────────────
console.log('\n=== 3. 事件：查询与计数 ===');
{
  const store = mk();
  const now = Date.now();
  store.appendEvent({ chatKey: CHAT, actorId: '456', text: '早一点的事', ts: now - 3600_000, kind: 'interaction' });
  store.appendEvent({ chatKey: CHAT, actorId: '456', text: '承诺的事', ts: now - 1800_000, kind: 'promise' });
  store.appendEvent({ chatKey: 'private:999', actorId: '999', text: '别的会话', ts: now - 900_000 });
  store.appendEvent({ chatKey: CHAT, actorId: '456', text: '最近的事', ts: now, kind: 'conflict' });

  check(store.queryEvents({ chatKey: CHAT }).length === 3, '按会话过滤');
  check(store.queryEvents({}).length === 4, '不传 chatKey 查全部');
  check(store.queryEvents({ chatKey: CHAT, kinds: ['promise'] }).length === 1, '按类型过滤');
  check(store.queryEvents({ chatKey: CHAT, fromTs: now - 1000 }).length === 1, '按时间下界过滤');

  const limited = store.queryEvents({ chatKey: CHAT, limit: 2 });
  check(limited.length === 2 && limited[1].text === '最近的事', 'limit 取最近 N 条且仍升序');

  // since 是"上次反思时间"，同一瞬间的事件视为已吸收，因此是严格大于
  check(store.countUnreflected(CHAT, now - 1800_000) === 1, '未反思计数按 since 生效（严格大于）');
  check(store.countUnreflected(CHAT, now - 4000_000) === 3, 'since 早于全部事件时统计全部');
  check(store.countUnreflected(CHAT, 0) === 3, 'since=0 统计全部');
}

// ── 4. 事件：压缩 ───────────────────────────────────────────────────────
console.log('\n=== 4. 事件：压缩（不硬删）===');
{
  const store = mk();
  const now = Date.now();
  const a = store.appendEvent({ chatKey: CHAT, actorId: '456', text: '旧事一', ts: now - 7200_000 });
  const b = store.appendEvent({ chatKey: CHAT, actorId: '456', text: '旧事二', ts: now - 7000_000 });
  store.appendEvent({ chatKey: CHAT, actorId: '456', text: '新事', ts: now });

  const r = store.markCompacted([a.event.id, b.event.id], {
    chatKey: CHAT, actorId: '456', text: '他上周连着两件事都不太顺'
  });
  check(r.ok === true && r.compacted === 2, '标记两条为已压缩');
  check(Boolean(r.summary?.id), '自动追加摘要事件');

  const all = store.queryEvents({ chatKey: CHAT, includeCompacted: true });
  const compacted = all.filter((e) => e.compacted);
  check(compacted.length === 2, '原事件仍在（只标记，不删除）');
  // 默认查询应只剩「新事」+ 刚追加的摘要事件（2 条）
  check(store.queryEvents({ chatKey: CHAT }).length === 2,
    `默认查询过滤掉已压缩（剩 ${store.queryEvents({ chatKey: CHAT }).length}）`);
  check(all.some((e) => e.summaryOf?.length === 2), '摘要事件带 summaryOf 溯源');

  check(store.markCompacted([], {}).ok === false, '空 ids 被拒绝');
  check(store.markCompacted(['nonexist'], {}).ok === false, '无匹配时返回失败');
}

// ── 5. 关系：合并与钳制 ─────────────────────────────────────────────────
console.log('\n=== 5. 关系：合并与钳制 ===');
{
  const store = mk();
  const d = store.getRelation('456');
  check(d.stage === 'stranger' && d.trust === 50 && d.warmth === 50, '默认关系：陌生人 / 50');

  const r1 = store.patchRelation('456', { nickname: '王哥', name: '小王', recentSummary: '聊到裁员' });
  check(r1.ok && r1.relation.nickname === '王哥', '昵称与摘要写入');
  check(r1.relation.names.includes('小王'), '名字被累积记录');

  const r2 = store.patchRelation('456', { trust: 95, warmth: 5 });
  check(r2.relation.trust === 60, `trust 单次 +10 钳制（实际 ${r2.relation.trust}）`);
  check(r2.relation.warmth === 40, `warmth 单次 -10 钳制（实际 ${r2.relation.warmth}）`);
  check(r2.clamp.some((s) => s.includes('trust')), '钳制有记录（可解释）');

  const r3 = store.patchRelation('456', { stage: 'familiar' });
  check(r3.relation.stage === 'acquaintance', `stranger → 最多到 acquaintance（实际 ${r3.relation.stage}）`);

  const r4 = store.patchRelation('456', { stage: 'stranger' });
  check(r4.relation.stage === 'stranger', '可以往回退一级');

  store.patchRelation('456', { stage: 'acquaintance' });
  store.patchRelation('456', { stage: 'familiar' });
  const r5 = store.patchRelation('456', { stage: 'strained' });
  check(r5.relation.stage === 'strained', '破裂可以从任何状态突然发生');

  const r6 = store.patchRelation('456', { stage: 'close' });
  check(r6.relation.stage === 'acquaintance', `从破裂恢复最多到 acquaintance（实际 ${r6.relation.stage}）`);

  check(store.patchRelation('abc', { trust: 60 }).ok === false, '非数字 userId 被拒绝');
  check(store.patchRelation('456', { stage: '无效阶段' }).relation.stage === 'acquaintance', '非法阶段被忽略');
}

// ── 6. 关系：未完结事项与证据 ───────────────────────────────────────────
console.log('\n=== 6. 关系：未完结事项与证据 ===');
{
  const store = mk();
  store.patchRelation('456', { openLoop: '问他后来怎么样了' });
  store.patchRelation('456', { openLoop: '问他后来怎么样了' });
  let rel = store.getRelation('456');
  check(rel.openLoops.length === 1, '同一条未完结事项不重复添加');

  store.patchRelation('456', { openLoop: '他答应帮我测试新版本' });
  rel = store.getRelation('456');
  check(rel.openLoops.length === 2, '不同事项分别记录');

  store.patchRelation('456', { closeLoop: '测试' });
  rel = store.getRelation('456');
  check(rel.openLoops.length === 1 && rel.openLoops[0].text.includes('后来'), 'closeLoop 按文本匹配关闭');

  const ids = Array.from({ length: 15 }, (_, i) => `e_${i}`);
  store.patchRelation('456', {}, { evidence: ids });
  rel = store.getRelation('456');
  check(rel.evidence.length === 10, `证据只保留最近 10 条（实际 ${rel.evidence.length}）`);
  check(rel.evidence.at(-1) === 'e_14', '保留的是最近的那批');
  check(rel.confidence > 0.3, '有证据时置信度略微上升');

  const listed = store.listRelations();
  check(listed.length === 1 && listed[0].userId === '456', 'listRelations 可枚举');
}

// ── 6b. 关系：版本与改写记录 ───────────────────────────────────────────
console.log('\n=== 6b. 关系：版本与改写记录 ===');
{
  const store = mk();
  const fresh = store.getRelation('456');
  check(fresh.version === 0 && Array.isArray(fresh.changelog), '新关系的版本是 0');

  const r1 = store.patchRelation('456', { nickname: '小王' }, {
    evidence: ['e_1'], by: 'tool:update_relation', reason: '他让我这么叫'
  });
  check(r1.changed === true, '真的改了 → changed=true');
  check(r1.relation.version === 1, '第一次改写 → 版本 1');
  const log1 = r1.relation.changelog[0];
  check(log1.by === 'tool:update_relation', 'changelog 记下来源');
  check(log1.reason === '他让我这么叫', 'changelog 记下理由');
  check(Array.isArray(log1.evidence) && log1.evidence[0] === 'e_1', 'changelog 记下依据事件');

  const r2 = store.patchRelation('456', { nickname: '小王' }, { evidence: ['e_2'], by: 'tool:update_relation' });
  check(r2.changed === false, '同一个昵称再写一次不算改动');
  check(r2.relation.version === 1, '没改动就不升版本（否则版本号会被刷爆）');
  check(r2.relation.changelog.length === 1, '也没留下空记录');

  const r3 = store.patchRelation('456', { warmth: 60 }, { evidence: ['e_3'], by: 'integrate.chat', reason: '聊得不错' });
  check(r3.relation.version === 2, '第二次真正的改写 → 版本 2');
  check(r3.relation.changelog.at(-1).by === 'integrate.chat', '第二个来源也记得住');
  check(r3.relation.changelog.at(-1).reason === '聊得不错', '第二个理由也记得住');
}
// ── 7. 自我：版本、留痕、底线 ───────────────────────────────────────────
console.log('\n=== 7. 自我：版本、留痕、底线 ===');
{
  const store = mk({ seedInvariants: ['小鲸鱼'] });
  const s0 = store.getSelf();
  check(s0.version === 0 && s0.narrative === '', '初始自我为空');

  const r1 = store.reviseSelf({ narrative: '我是小鲸鱼，最近在学着分辨谁值得认真对待。' }, { reason: '想明白了一点' });
  check(r1.ok && r1.self.version === 1, '改写后版本 +1');
  check(r1.self.changelog.length === 1 && r1.self.changelog[0].reason === '想明白了一点', 'changelog 记录原因');

  const r2 = store.reviseSelf({ mood: { label: '有点烦', valence: -0.4 } }, { reason: '被说了几句' });
  check(r2.self.version === 2 && r2.self.mood.label === '有点烦', '只改心情也递增版本');
  check(r2.self.narrative.includes('小鲸鱼'), '未改动的叙事保留');

  check(store.reviseSelf({ narrative: 'x' }, {}).ok === false, '缺 reason 被拒绝');

  const r3 = store.reviseSelf({ narrative: '我不想再当小鲸鱼了。' }, { reason: '想换个活法' });
  check(r3.ok === false && String(r3.reason).includes('底线'), `否定底线被拒绝（${r3.reason}）`);

  const r4 = store.reviseSelf({ narrative: '我不需要名字，也不需要谁记得我。' }, { reason: '想消失一阵' });
  check(r4.ok === false && String(r4.reason).includes('删掉'), `删掉既定底线被拒绝（${r4.reason}）`);

  // 长度与列表上限用另一份**没有底线约束**的存储验证（否则会被底线规则正确地拦下）
  const plainStore = mk();
  const long = '啊'.repeat(3000);
  const r5 = plainStore.reviseSelf({ narrative: long }, { reason: '测试长度' });
  check(r5.ok && r5.self.narrative.length <= 1200, `叙事长度被截断（${r5.self.narrative?.length}）`);

  const r6 = plainStore.reviseSelf({ preoccupations: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, { reason: '测试挂心' });
  check(r6.self.preoccupations.length === 5, '挂心事项截断到 5 条');
}

// ── 7b. 自我笔记：会话反思的产物，不是改写 ─────────────────────────────
console.log('\n=== 7b. 自我笔记 ===');
{
  const store = mk();
  const r1 = store.appendSelfNotes(['我好像变了', { text: '挂心：他最近不太对' }], { by: 'integrate.chat' });
  check(r1.ok === true && r1.added === 2, '两条笔记写入');
  check(store.getSelf().version === 0, '记笔记不改变自我版本（它不是改写）');
  check(store.getSelf().selfNotes.length === 2, '落在 selfNotes 里');
  check(store.getSelf().selfNotes[0].by === 'integrate.chat', '笔记带来源');

  const r2 = store.appendSelfNotes(['我好像变了'], { by: 'integrate.chat' });
  check(r2.added === 0, '24 小时内同一句话不重复记');

  for (let i = 0; i < 30; i++) store.appendSelfNotes([`笔记 ${i}`]);
  const notes = store.getSelf().selfNotes;
  check(notes.length === 20, `只保留最近 20 条（实际 ${notes.length}）`);
  check(notes.at(-1).text === '笔记 29', '留下的是最新的那批');

  check(store.appendSelfNotes([]).ok === false, '空列表被拒绝');
}
// ── 8. 节律状态与日志 ───────────────────────────────────────────────────
console.log('\n=== 8. 节律状态与日志 ===');
{
  const store = mk();
  const t0 = store.getTick();
  check(t0.energy === 100 && t0.todayProactive === 0, '默认节律状态');

  const t1 = store.updateTick({ energy: 62, todayProactive: 1, today: '2026-10-24' });
  check(t1.energy === 62 && t1.todayProactive === 1, 'updateTick 合并写入');
  check(store.getTick().energy === 62, '可读回');

  const ref = store.appendReflection({ chatKey: CHAT, eventCount: 9, produced: { relations: 2 } });
  check(Boolean(ref.id) && Boolean(ref.at), '反思日志带 id 与时间');
  store.appendAction({ action: 'idle', reason: '无候选' });
  check(store.listReflections({ limit: 5 }).length === 1, 'listReflections 可读');
  check(store.listActions({ limit: 5 }).length === 1, 'listActions 可读');
}

// ── 9. 脏数据容错 ───────────────────────────────────────────────────────
console.log('\n=== 9. 脏数据容错 ===');
{
  const store = mk();
  store.appendEvent({ chatKey: CHAT, actorId: '456', text: '正常一条' });
  const dir = path.join(store.root, 'events', mindChatDirName(CHAT));
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  fs.appendFileSync(file, '{ 这不是合法 JSON\n', 'utf8');

  const events = store.queryEvents({ chatKey: CHAT });
  check(events.length === 1, '坏行被跳过，好行仍可读');

  fs.writeFileSync(path.join(store.root, 'self.json'), 'not json at all', 'utf8');
  check(store.getSelf().version === 0, 'self.json 损坏时回落到默认值而不是抛错');

  const empty = mk();
  check(empty.queryEvents({ chatKey: 'private:777' }).length === 0, '不存在的会话返回空数组');
  check(empty.listRelations().length === 0, '不存在的 relations 目录返回空数组');
  check(EVENT_KINDS.length === 5 && STAGES.includes('strained') && STAGE_LEVEL.close === 3, '常量导出正确');
}

console.log(`\n心智存储：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
