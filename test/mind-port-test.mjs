// 领域端口（MindPort）单测。
//
// 这一套守的是"端口契约"，不涉及 LLM、不涉及提示词：
//   · 空实现（无心智）的形状必须稳定 —— 它是"删掉 src/mind 仍能启动"的基础
//   · 身体补丁必须原子、必须带 rev、必须拒绝未知键
//   · 写入来源由外部绑定，工具自己给不出来
//   · 端口文件不许 import 领域模块（否则删除目录时端口先炸）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-port-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const {
  MIND_PORT_API, WRITERS,
  createRuntimePort, createWriterPort, createAdminPort,
  createNoopRuntimePort, createNoopWriterPort, createNoopAdminPort
} = await import(src('src/contract/mind-port.js'));
const { MindStore } = await import(src('src/mind/store.js'));

const mkStore = () => new MindStore({
  root: fs.mkdtempSync(path.join(dataDir, 'mind-')),
  getOptions: () => ({ seedInvariants: [] })
});

const CHAT = 'private:456';

// ── 1. 形状 ────────────────────────────────────────────────────────────
console.log('\n=== 1. 端口形状 ===');
{
  check(MIND_PORT_API === 1, '端口 API 版本为 1');
  check(typeof createRuntimePort === 'function'
    && typeof createWriterPort === 'function'
    && typeof createAdminPort === 'function', '三个工厂都导出');

  const noMind = createRuntimePort(null);
  check(noMind.enabled === false, '无 mind 时 enabled=false');
  check(noMind.bodyRead().enabled === false, '空实现的 body 带 enabled=false');
  check(noMind.bodyRead().counters.todayDecisions === 0, '空实现的计数为 0');
  check(noMind.scene().entries.length === 0, '空实现的现场为空');
  check(noMind.reflectionDebt({ chatKey: CHAT }) === 0, '空实现的未反思数为 0');
  check(noMind.lastAction() === null, '空实现没有上次行动');
  check(noMind.recall({ chatKey: CHAT }).length === 0, '空实现的回想为空');

  const w = createNoopWriterPort();
  check(w.enabled === false, '空写入端口 enabled=false');
  check(w.canWrite('event') === false, '空写入端口不能写任何目标');
  check(w.appendEvent({}).code === 'no-mind', '空写入端口返回 no-mind');

  const a = createNoopAdminPort();
  check(a.enabled === false && a.getTick() !== null, '空管理端口可读但不崩');
}

// ── 2. 身体：读 ────────────────────────────────────────────────────────
console.log('\n=== 2. 身体：读 ===');
{
  const store = mkStore();
  store.updateTick({
    energy: 63, todayProactive: 2, todayDecisions: 5,
    sleep: { state: 'asleep', since: 111, nightKey: 'n1', stayUps: 1 },
    snoozes: { 'private:456|miss_you': 999 },
    proactiveAt: { 'private:456': 888 }
  });
  const port = createRuntimePort(store);
  const body = port.bodyRead();
  check(port.enabled === true, '有 mind 时 enabled=true');
  check(body.energy === 63, '体力透传');
  check(body.counters.todayProactive === 2 && body.counters.todayDecisions === 5, '计数透传');
  check(body.sleep.state === 'asleep' && body.sleep.stayUps === 1, '睡眠状态透传');
  check(body.snoozes['private:456|miss_you'] === 999, '打盹表透传');
  check(body.proactiveAt['private:456'] === 888, '主动发言记录透传');
  check(body.rev === 0, '初始 rev 为 0');
}

// ── 3. 身体：结算走注入的领域函数 ──────────────────────────────────────
console.log('\n=== 3. 身体：结算 ===');
{
  const store = mkStore();
  let called = 0;
  const port = createRuntimePort(store, {
    settle: (tick, at) => {
      called++;
      return { ...tick, energy: 42, today: '2026-10-29', settledAt: at };
    }
  });
  const r = port.bodySettle({ now: 123456 });
  check(r.ok === true, '结算返回 ok');
  check(called === 1, '注入的结算函数被调用一次');
  check(r.body.energy === 42, '结算结果落到身体快照');
  check(store.getTick().settledAt === 123456, '结算结果落盘');

  // 不注入结算函数时，只读不写，不报错
  const bare = createRuntimePort(store);
  const r2 = bare.bodySettle({ now: 1 });
  check(r2.ok === true && r2.body.energy === 42, '无结算函数时不改数据也不报错');
}

// ── 4. 身体：补丁的前置校验 ────────────────────────────────────────────
console.log('\n=== 4. 身体：补丁校验 ===');
{
  const store = mkStore();
  const port = createRuntimePort(store);
  const rev = port.bodyRead().rev;

  check(port.bodyApply({ spend: 5 }).code === 'invalid_patch', '不带 rev 直接拒绝');
  check(port.bodyApply({ rev, foo: 1 }).code === 'invalid_patch', '未知键被拒绝');
  check(port.bodyApply({ rev, counterDelta: { todayFoo: 1 } }).code === 'invalid_patch',
    '未知计数被拒绝');
  check(port.bodyApply({ rev, sleep: { foo: 1 } }).code === 'invalid_patch', '未知睡眠字段被拒绝');
  check(port.bodyApply({ rev: rev + 99, spend: 5 }).code === 'stale', 'rev 不匹配返回 stale');
  check(store.getTick().energy === 100, '被拒绝的补丁没有写盘');
}

// ── 5. 身体：补丁的原子性与语义 ────────────────────────────────────────
console.log('\n=== 5. 身体：原子补丁 ===');
{
  const store = mkStore();
  const port = createRuntimePort(store);

  let writes = 0;
  const originalUpdate = store.updateTick.bind(store);
  store.updateTick = (patch) => { writes++; return originalUpdate(patch); };

  const rev = port.bodyRead().rev;
  const r = port.bodyApply({
    rev,
    spend: 25,
    counterDelta: { todayProactive: 1 },
    snooze: { 'private:456|miss_you': 5000 }
  });
  check(r.ok === true, '复合补丁成功');
  check(writes === 1, '复合补丁只写盘一次（不是三次）');
  check(r.spent === 25 && r.body.energy === 75, '扣体力 25');
  check(r.body.counters.todayProactive === 1, '主动发言计数 +1');
  check(r.body.snoozes['private:456|miss_you'] === 5000, '打盹表整表替换');
  check(r.body.rev === rev + 1, 'rev 自增');

  const r2 = port.bodyApply({ rev: r.body.rev, spend: 999 });
  check(r2.ok === true && r2.spent === 75 && r2.body.energy === 0, '体力不足时截到 0，spent 为实际扣除');

  const r3 = port.bodyApply({ rev: r2.body.rev, proactiveAt: { chatKey: CHAT, at: 777 } });
  check(r3.body.proactiveAt[CHAT] === 777, '主动发言记录写入');

  const r4 = port.bodyApply({ rev: r3.body.rev, snooze: {} });
  check(Object.keys(r4.body.snoozes).length === 0, '打盹表可整表清空');
}

// ── 5b. 身体：同步读改写（首选写法）────────────────────────────────────
console.log('\n=== 5b. 身体：bodyUpdate ===');
{
  const store = mkStore();
  const port = createRuntimePort(store);
  let writes = 0;
  const originalUpdate = store.updateTick.bind(store);
  store.updateTick = (patch) => { writes++; return originalUpdate(patch); };

  const r = port.bodyUpdate((body) => ({
    spend: 10,
    counterDelta: { todayDecisions: 1 },
    proactiveAt: { chatKey: CHAT, at: body.rev + 100 }
  }));
  check(r.ok === true && r.changed === true, '回调给出补丁即生效');
  check(writes === 1, '一次回调只写盘一次');
  check(r.body.energy === 90 && r.body.counters.todayDecisions === 1, '补丁内容正确');

  const before = writes;
  const none = port.bodyUpdate(() => null);
  check(none.ok === true && none.changed === false, '回调返回 null 表示不改');
  check(writes === before, '不改时不写盘');

  // 回调拿到的是快照副本：改它不会污染真实状态
  port.bodyUpdate((body) => { body.energy = 1; body.counters.todayDecisions = 99; return null; });
  check(port.bodyRead().energy === 90, '回调改快照不影响真实状态');

  const boom = port.bodyUpdate(() => { throw new Error('算不出来'); });
  check(boom.ok === false && boom.code === 'store-error', '回调抛错被兜住');

  const base = port.bodyRead().rev;
  const stale = port.bodyApply({ rev: base - 1, spend: 1 });
  check(stale.code === 'stale', '两步写法仍会做 CAS 检查');
}
// ── 6. 写入端口：来源由外部绑定 ────────────────────────────────────────
console.log('\n=== 6. 写入端口：来源与规程 ===');
{
  const store = mkStore();
  const updater = createWriterPort(store, { by: 'tool:update_relation' });
  check(updater.by === 'tool:update_relation', '句柄记住了来源');
  check(updater.canWrite('relation') === true, '更新关系可以写关系');
  check(updater.canWrite('self.narrative') === false, '更新关系不能写自我');
  check(updater.canWrite('self.narrative', 'tool:update_relation') === false, '别人的来源写不了自我');
  check(updater.canWrite('self.narrative', 'tool:self_revise') === true, '自我改写的来源写得了自我');

  check(updater.patchRelation('456', { nickname: '小王' }).code === 'needs_evidence',
    '改对人的看法必须带依据');
  const r = updater.patchRelation('456', { nickname: '小王' }, { evidence: ['e1'], reason: '他让我这么叫' });
  check(r.ok === true && r.relation.nickname === '小王', '带依据后写入成功');
  check(r.relation.version === 1, '写入后版本 +1');
  check(r.relation.changelog?.at(-1)?.by === 'tool:update_relation', 'changelog 记下注入的来源');
  check(r.relation.changelog?.at(-1)?.reason === '他让我这么叫', 'changelog 记下理由');

  check(updater.reviseSelf({ narrative: '我最近在学着少说两句。' }, { reason: '想了很久' }).code === 'not_a_writer',
    '更新关系不能改写自我');

  const reviser = createWriterPort(store, { by: 'tool:self_revise' });
  check(reviser.reviseSelf({ narrative: 'x' }).code === 'needs_reason', '改写自我必须写理由');
  const sr = reviser.reviseSelf({ narrative: '我最近在学着少说两句。' }, { reason: '想了很久' });
  check(sr.ok === true && sr.self.version === 1, '改写自我成功且版本 +1');
  check(sr.self.changelog[sr.self.changelog.length - 1].by === 'self', 'changelog 记下来源');

  const nobody = createWriterPort(store, { by: 'tool:unknown' });
  check(nobody.appendEvent({ chatKey: CHAT, text: 'x' }).code === 'not_a_writer', '未登记的来源不能写任何东西');
}

// ── 7. 写入端口：事件与反思 ────────────────────────────────────────────
console.log('\n=== 7. 写入端口：事件 ===');
{
  const store = mkStore();
  const writer = createWriterPort(store, { by: 'tool:remember_event' });
  const r = writer.appendEvent({ chatKey: CHAT, actorId: '456', text: '他说今天被裁员了' });
  check(r.ok === true && r.event?.id, '事件写入成功');
  const again = writer.appendEvent({ chatKey: CHAT, actorId: '456', text: '他说今天被裁员了' });
  check(again.ok === true && again.duplicate === true, '24 小时内同文本去重');

  const chatWriter = createWriterPort(store, { by: 'runtime.chat' });
  check(chatWriter.appendEvent({ chatKey: CHAT, text: '跟小王聊了几句' }).ok === true,
    '运行时也能写兜底事件');
}

// ── 8. 记录与管理端口 ──────────────────────────────────────────────────
console.log('\n=== 8. 记录与管理 ===');
{
  const store = mkStore();
  const port = createRuntimePort(store);
  const r = port.recordAction({ chatKey: CHAT, action: 'send_proactive', reason: '想问问' });
  check(r.ok === true && r.id, '行动记录写入并返回 id');
  check(store.listActions({ limit: 1 }).length === 1, '落到了 actions.jsonl');
  check(port.lastAction()?.actionId === 'send_proactive', '上次行动可读回');

  const admin = createAdminPort(store);
  check(admin.getTick().energy === 100, '管理端口直通 getTick');
  check(typeof admin.logSizes().total === 'number', '管理端口直通 logSizes');
  check(createAdminPort(null).enabled === false, '无 mind 时管理端口关闭');
}

// ── 9. 现场与回想 ──────────────────────────────────────────────────────
console.log('\n=== 9. 现场与回想 ===');
{
  const store = mkStore();
  check(createRuntimePort(store).scene().entries.length === 0, '没有会话存档时现场为空');

  store.patchRelation('456', { nickname: '小王' }, { evidence: ['e1'] });
  store.patchRelation('789', { nickname: '小李' }, { evidence: ['e2'] });
  const chatStore = {
    listChats: () => ['private:456', 'private:789', 'group:1'],
    getChatMeta: (key) => (key === 'private:456'
      ? { lastTs: 1000, unread: 2, lastText: '在吗' }
      : { lastTs: Date.now() - 3600000, unread: 0, lastText: '出去了' })
  };
  const port = createRuntimePort(store, { chatStore, now: () => 10000 });
  const scene = port.scene({ now: Date.now(), limit: 1 });
  check(scene.entries.length === 1, 'limit 生效');
  check(scene.restCount === 1, '剩余数正确（群聊不计入）');
  check(scene.entries[0].name === '小王' || scene.entries[0].name === '小李', '现场带上了关系里的称呼');

  store.appendEvent({ chatKey: CHAT, text: '他说今天被裁员了', ts: 1000 });
  store.appendEvent({ chatKey: CHAT, text: '周末去看电影吧', ts: 2000 });
  const hit = port.recall({ chatKey: CHAT, query: '裁员' });
  check(hit.length === 1 && hit[0].text.includes('裁员'), '回想按关键词命中');
  check(port.recall({ chatKey: CHAT, limit: 1 }).length === 1, '不带关键词时按条数截取');
}

// ── 10. 架构约束：端口不依赖领域模块 ──────────────────────────────────
console.log('\n=== 10. 架构约束 ===');
{
  const file = path.join(ROOT, 'src/contract/mind-port.js');
  check(fs.existsSync(file), '端口文件存在');
  const text = fs.readFileSync(file, 'utf8');
  check(!/from\s+['"][^'"]*\/mind\//.test(text), '端口文件不 import src/mind/**');
  check(!/from\s+['"]\.\.\/mind/.test(text), '端口文件不 import ../mind');
  check(text.includes('not-implemented'), 'B 期方法显式声明未实现，而不是静默返回空');

  const writers = Object.keys(WRITERS);
  check(writers.length === 7, '写入规程覆盖 7 个目标');
  check(WRITERS['self.narrative'].includes('integrate.global') === true, '自我只能由全局整合写');
  check(WRITERS['self.narrative'].includes('integrate.chat') === false, '会话反思写不了自我');
}

console.log(`\n领域端口：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
