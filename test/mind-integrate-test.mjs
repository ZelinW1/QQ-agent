// 全局整合与强事件自测（B2 后半）。
//
// 守两件事：
//   1. 强事件的判定由系统做（文本规则 + 关系阶段回退），不靠模型自觉；
//   2. 全局整合是唯一能自动改写自我的地方，且只消化本次材料里真实存在的笔记。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-integrate-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { detectStrongText, stageRegressed } = await import(src('src/mind/strong.js'));
const { MindStore } = await import(src('src/mind/store.js'));
const { buildIntegratePrompt, parseIntegrateOutput, applyIntegrate } = await import(src('src/mind/integrate.js'));
const { Orchestrator } = await import(src('src/orchestrator.js'));
const { createRuntimePort } = await import(src('src/contract/mind-port.js'));
const { updateConfig } = await import(src('src/config.js'));

const mkStore = () => new MindStore({
  root: fs.mkdtempSync(path.join(dataDir, 'i-')),
  getOptions: () => ({ seedInvariants: [] })
});

updateConfig({
  api: { model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1' },
  mind: { enabled: true, integrate: { enabled: true, maxPerDay: 2, cooldownMs: 0, minNotes: 2 } }
});

// ── 1. 强事件：文本规则 ─────────────────────────────────────────────────
console.log('\n=== 1. 强事件判定 ===');
{
  check(detectStrongText('我们绝交吧').kind === 'conflict', '冲突被识别');
  check(detectStrongText('以后不来了').kind === 'farewell', '告别被识别');
  check(detectStrongText('我保证下次不会了').kind === 'promise', '承诺被识别');
  check(detectStrongText('今天吃了拉面') === null, '普通闲聊不算强事件');
  check(detectStrongText('一定的，我明天早点睡') === null, '「一定」单独出现不误伤');
  check(detectStrongText('') === null, '空文本不算');

  const LEVEL = { stranger: 0, acquaintance: 1, familiar: 2, close: 3 };
  check(stageRegressed('familiar', 'acquaintance', LEVEL) === true, '阶段下降算回退');
  check(stageRegressed('acquaintance', 'familiar', LEVEL) === false, '阶段上升不算');
  check(stageRegressed('familiar', 'strained', LEVEL) === true, '变成有隔阂算回退');
}

// ── 2. 存储层打标 ───────────────────────────────────────────────────────
console.log('\n=== 2. 强事件落盘 ===');
{
  const store = mkStore();
  const before = Date.now();
  const r = store.appendEvent({ chatKey: 'private:456', actorId: '456', text: '我保证以后每天给你带咖啡' });
  check(r.event.strong === true && r.event.strongKind === 'promise', '事件被标记为强事件');
  const hits = store.listStrongSince(before - 1000);
  check(hits.length === 1 && hits[0].kind === 'promise', 'listStrongSince 能取到');

  store.appendEvent({ chatKey: 'private:456', actorId: '456', text: '今天地铁很挤' });
  check(store.listStrongSince(before - 1000).length === 1, '普通事件不计入强事件');

  // 一次只能升一级：先把阶段推到 familiar，再往回掉一级
  store.patchRelation('456', { stage: 'acquaintance' }, { evidence: ['e1'], by: 'integrate.chat' });
  store.patchRelation('456', { stage: 'familiar' }, { evidence: ['e2'], by: 'integrate.chat' });
  const down = store.patchRelation('456', { stage: 'acquaintance' }, { evidence: ['e3'], by: 'integrate.chat' });
  check(down.stageRegressed === true, 'patchRelation 报告阶段回退');
  const withRel = store.listStrongSince(before - 1000);
  check(withRel.some((x) => x.kind === 'stage-regressed'), '关系回退也进强事件列表');
}

// ── 3. 材料与解析 ───────────────────────────────────────────────────────
console.log('\n=== 3. 整合材料与解析 ===');
{
  const self = { narrative: '我是小鲸鱼。', mood: { label: '有点闷' }, preoccupations: [] };
  const notes = [{ id: 'sn_1', at: Date.now(), text: '我好像没那么怕拒绝了' }];
  const messages = buildIntegratePrompt({ botName: '小鲸鱼', self, notes, reflections: [], relations: [] });
  check(messages.length === 2 && messages[0].role === 'system', 'system + user 两条');
  check(messages[0].content.includes('只改你自己的描述'), '明确禁止评价别人');
  check(messages[1].content.includes('sn_1'), '笔记编号露出来（digest 要用）');
  check(messages[1].content.includes('我是小鲸鱼'), '带上现有的自我');

  const ok = parseIntegrateOutput('{"self":{"narrative":"我想通了一点"},"digest":["sn_1"]}');
  check(ok.ok === true && ok.empty === false, '正常解析');
  const empty = parseIntegrateOutput('{"self":{"narrative":null}}');
  check(empty.ok === true && empty.empty === true, '没有新认识算成功（不重试）');
  check(parseIntegrateOutput('我想了想').ok === false, '非 JSON 解析失败');
}

// ── 4. 应用：改自我 + 标记消化 ──────────────────────────────────────────
console.log('\n=== 4. 应用整合结果 ===');
{
  const store = mkStore();
  const r1 = store.appendSelfNotes(['我好像没那么怕拒绝了', '挂心：他最近很累'], { by: 'integrate.chat' });
  check(r1.added === 2, '先攒两条笔记');
  const notes = store.undigestedSelfNotes();
  check(notes.length === 2, '未消化的笔记可枚举');

  const { applied } = applyIntegrate({
    store,
    noteIds: notes.map((n) => n.id),
    output: {
      self: { narrative: '我是小鲸鱼。我比以前敢说不了。' },
      digest: [notes[0].id, 'sn_编造的']
    }
  });
  check(applied.self === true, '自我被改写');
  check(store.getSelf().version === 1, '版本 +1');
  check(applied.digested === 1, '只消化真实存在的笔记（编造的 id 被忽略）');
  check(store.undigestedSelfNotes().length === 1, '剩下那条仍在待整合队列');
  check(Boolean(store.getSelf().selfNotes.find((n) => n.id === notes[0].id)?.digestedAt), '消化是打标，不是删除');
}

// ── 5. 整条 runIntegrate ────────────────────────────────────────────────
console.log('\n=== 5. runIntegrate 全链路 ===');
{
  const store = mkStore();
  store.appendSelfNotes(['我好像没那么怕拒绝了', '挂心：他最近很累', '我可能有点在意别人怎么看我'], { by: 'integrate.chat' });
  const orch = Object.create(Orchestrator.prototype);
  orch.mind = store;
  orch.mindPort = createRuntimePort(orch.mind, {});
  orch.integrating = false;

  let seen = null;
  const fakeChat = async (messages) => {
    seen = messages;
    return {
      message: {
        content: JSON.stringify({
          self: { narrative: '我是小鲸鱼。我比以前敢说不了。', mood: { label: '松了一点', valence: 0.2 } },
          digest: store.undigestedSelfNotes().map((n) => n.id),
          notes: '想清楚了一件小事'
        })
      },
      usage: { prompt_tokens: 900, completion_tokens: 120 }
    };
  };

  const r = await orch.runIntegrate({ chat: fakeChat });
  check(r.ok === true && r.applied.self === true, '整合成功并改写自我');
  check(seen && seen[1].content.includes('我好像没那么怕拒绝了'), '模型确实看到了笔记');
  check(store.getSelf().narrative.includes('敢说不'), '叙事写入');
  check(store.undigestedSelfNotes().length === 0, '素材被标记消化');

  const tick = store.getTick();
  check(tick.todayIntegrates === 1, '当日整合计数 +1');
  check(tick.lastIntegrateAt > 0, '记录整合时间');

  const logs = store.listReflections({ limit: 5 });
  check(logs.length === 1 && logs[0].scope === 'global', '写入一条全局反思日志');
  check(logs[0].usage?.prompt_tokens === 900, '日志记录用量');

  // 额度：一天两次，第二次还能跑，第三次被拒（材料也要够 minNotes）
  store.appendSelfNotes(['第二次的念头', '还有一条'], { by: 'integrate.chat' });
  const r2 = await orch.runIntegrate({ chat: fakeChat });
  check(r2.ok === true, '第二次仍在额度内');
  store.appendSelfNotes(['第三次的念头', '再来一条'], { by: 'integrate.chat' });
  const r3 = await orch.runIntegrate({ chat: fakeChat });
  check(r3.ok === false && r3.reason === 'quota', '超过每日额度被拒');
}

// ── 6. 冷却 ─────────────────────────────────────────────────────────────
console.log('\n=== 6. 冷却 ===');
{
  updateConfig({ mind: { integrate: { enabled: true, maxPerDay: 5, cooldownMs: 3600000, minNotes: 1 } } });
  const store = mkStore();
  store.appendSelfNotes(['一条念头'], { by: 'integrate.chat' });
  const orch = Object.create(Orchestrator.prototype);
  orch.mind = store;
  orch.mindPort = createRuntimePort(orch.mind, {});
  orch.integrating = false;
  const fakeChat = async () => ({ message: { content: '{"self":{"narrative":"变了"}}' } });

  const a = await orch.runIntegrate({ chat: fakeChat });
  check(a.ok === true, '第一次成功');
  store.appendSelfNotes(['又一条念头'], { by: 'integrate.chat' });
  const b = await orch.runIntegrate({ chat: fakeChat });
  check(b.ok === false && b.reason === 'cooldown', '冷却期内不再跑');
  const c = await orch.runIntegrate({ chat: fakeChat, force: true });
  check(c.ok === true, 'force 可以跳过门槛（手动触发用）');
}

console.log(`\n全局整合：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
